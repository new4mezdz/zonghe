import json
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock


os.environ['DISABLE_AUTO_SYNC'] = '1'
SERVICE_DIR = Path(__file__).resolve().parents[1]
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from config import Config


IMPORT_CONFIG_DIR = tempfile.TemporaryDirectory()
Config.BASE_DIR = IMPORT_CONFIG_DIR.name
Config.CONFIG_FILE = os.path.join(Config.BASE_DIR, 'config.json')

from modules.urldata import services


class InitialSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        temp_path = self.temp_dir.name

        Config.BASE_DIR = temp_path
        Config.CONFIG_FILE = os.path.join(temp_path, 'config.json')
        services.DB_FILE = os.path.join(temp_path, 'urldata.db')
        services.LAST_SYNC_FILE = os.path.join(temp_path, 'last_sync_time.json')
        services.INITIAL_SYNC_STATE_FILE = os.path.join(
            temp_path, 'initial_sync_state.json'
        )
        self.service = services.UrlDataService()
        self.service.config['序号记录文件'] = os.path.join(
            temp_path, 'last_numbers.json'
        )
        self.service.config['输出目录'] = os.path.join(temp_path, 'output')
        Config.save_json_config(self.service.config)

    def tearDown(self):
        self.temp_dir.cleanup()

    def _insert_record(self, record_time='2026-07-24 08:00:00.000'):
        conn = sqlite3.connect(services.DB_FILE)
        try:
            conn.execute(
                'INSERT INTO records (content, record_time, date_str, type) '
                'VALUES (?, ?, ?, ?)',
                ('test-code', record_time, record_time[:10], '其他'),
            )
            conn.commit()
        finally:
            conn.close()

    def test_config_is_generated_with_daily_sync_defaults(self):
        config = Config.load_json_config()

        self.assertTrue(os.path.exists(Config.CONFIG_FILE))
        self.assertEqual(len(config['编号下限列表']), 9)
        self.assertEqual(len(config['编号上限列表']), 9)
        self.assertTrue(config['定时处理']['启用'])
        self.assertEqual(config['定时处理']['间隔小时'], 0)
        self.assertEqual(config['定时处理']['间隔分钟'], 30)
        self.assertFalse(config['首次同步']['拉取全部历史'])
        self.assertEqual(config['首次同步']['回溯小时'], 24)

    def test_legacy_config_is_upgraded_without_losing_values(self):
        legacy = {
            '编号下限列表': [2] * 7,
            '编号上限列表': [500] * 7,
            '输出文件前缀': '旧配置_',
        }
        with open(Config.CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(legacy, f, ensure_ascii=False)

        config = Config.load_json_config()

        self.assertEqual(config['输出文件前缀'], '旧配置_')
        self.assertEqual(config['编号下限列表'][:7], [2] * 7)
        self.assertEqual(config['编号下限列表'][7:], [1, 1])
        self.assertEqual(len(config['编号上限列表']), 9)
        self.assertTrue(config['定时处理']['启用'])

    def test_generated_24_hour_config_is_migrated_to_30_minutes(self):
        previous_generated_config = {
            '定时处理': {
                '启用': True,
                '间隔小时': 24,
                '间隔分钟': 0,
                '间隔秒': 0,
                '失败重试': True,
                '重试间隔': 60,
            },
        }
        with open(Config.CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(previous_generated_config, f, ensure_ascii=False)

        config = Config.load_json_config()

        self.assertEqual(config['配置版本'], 2)
        self.assertEqual(config['定时处理']['间隔小时'], 0)
        self.assertEqual(config['定时处理']['间隔分钟'], 30)

    def test_existing_database_skips_historical_backfill(self):
        self._insert_record()
        self.service._write_initial_sync_state({
            'status': 'completed',
            'source': 'influxdb_full_sync',
            'full_history_verified': True,
            'completed_at': '2026-07-24T08:00:00+09:00',
        })
        self.service.process_data = Mock()

        result = self.service.ensure_initial_sync()

        self.assertTrue(result['success'])
        self.assertEqual(result['action'], 'existing_database')
        self.service.process_data.assert_not_called()
        self.assertEqual(result['state']['record_count'], 1)
        self.assertEqual(result['state']['status'], 'completed')
        self.assertTrue(os.path.exists(services.INITIAL_SYNC_STATE_FILE))
        self.assertTrue(os.path.exists(services.LAST_SYNC_FILE))

    def test_empty_database_only_loads_recent_window_once(self):
        calls = []

        def fake_process(
            start_time,
            stop_time=None,
            reset_numbers=False,
            write_output=True,
        ):
            calls.append((start_time, stop_time, reset_numbers, write_output))
            self._insert_record()
            self.service._save_last_sync_time('2026-07-24 08:00:00.000')
            return {'success': True, 'message': 'ok', 'logs': []}

        self.service.process_data = fake_process

        first_result = self.service.ensure_initial_sync()
        second_result = self.service.ensure_initial_sync()

        self.assertEqual(calls, [('-24h', None, True, False)])
        self.assertEqual(first_result['action'], 'initialized')
        self.assertEqual(second_result['action'], 'existing_database')
        self.assertEqual(second_result['state']['source'], 'influxdb_recent_sync')
        with open(services.INITIAL_SYNC_STATE_FILE, 'r', encoding='utf-8') as f:
            state = json.load(f)
        self.assertEqual(state['status'], 'completed')
        self.assertFalse(state['requires_manual_action'])
        self.assertFalse(state['full_history_verified'])
        self.assertFalse(state['historical_backfill_enabled'])

    def test_schema_one_database_is_not_reconciled(self):
        self._insert_record()
        with open(services.INITIAL_SYNC_STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump({
                'status': 'completed',
                'source': 'influxdb_full_sync',
                'schema_version': 1,
                'record_count': 1,
            }, f)
        self.service.process_data = Mock()

        result = self.service.ensure_initial_sync()

        self.assertTrue(result['success'])
        self.assertEqual(result['action'], 'existing_database')
        self.service.process_data.assert_not_called()
        self.assertFalse(result['state']['historical_backfill_enabled'])

    def test_full_history_can_still_be_enabled_explicitly(self):
        config = Config.load_json_config()
        config['首次同步']['拉取全部历史'] = True
        Config.save_json_config(config)
        self.service._get_earliest_influx_time = Mock(
            return_value=datetime(2026, 1, 1, tzinfo=timezone.utc)
        )
        calls = []

        def fake_process(start_time, **kwargs):
            calls.append((start_time, kwargs))
            self._insert_record()
            return {
                'success': True,
                'message': 'ok',
                'logs': [],
            }

        self.service.process_data = fake_process

        result = self.service.ensure_initial_sync()

        self.assertTrue(result['success'])
        self.assertEqual(result['action'], 'initialized')
        self.assertEqual(calls[0][0], '2026-01-01T00:00:00Z')
        self.assertTrue(result['state']['historical_backfill_enabled'])
        self.assertTrue(result['state']['full_history_verified'])

    def test_reset_numbers_updates_existing_record_numbers(self):
        record_time = '2026-07-24 08:00:00.000'
        self._insert_record(record_time)
        self.service._load_data_from_influx = Mock(return_value=[{
            'time': datetime(2026, 7, 24, tzinfo=timezone.utc),
            'value': 'test-code',
        }])
        self.service._load_verification_from_influx = Mock(return_value=[])

        result = self.service.process_data(
            '2026-07-24T00:00:00Z',
            reset_numbers=True,
            write_output=False,
        )

        self.assertTrue(result['success'])
        conn = sqlite3.connect(services.DB_FILE)
        try:
            row = conn.execute(
                'SELECT transport, num1, num8 FROM records WHERE content=?',
                ('test-code',),
            ).fetchone()
        finally:
            conn.close()
        self.assertEqual(row, (1, 1, 1))

    def test_failed_initialization_is_recorded_for_retry(self):
        self.service.process_data = Mock(return_value={
            'success': False,
            'message': '内网数据库不可达',
            'logs': [],
        })

        with self.assertLogs(level='ERROR'):
            result = self.service.ensure_initial_sync()

        self.assertFalse(result['success'])
        self.assertEqual(result['action'], 'failed')
        self.assertEqual(result['state']['status'], 'failed')
        self.assertTrue(result['state']['requires_manual_action'])
        self.assertEqual(result['state']['last_error'], '内网数据库不可达')


if __name__ == '__main__':
    unittest.main()
