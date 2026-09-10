import copy
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

from flask import Flask


SERVICE_DIR = Path(__file__).resolve().parents[1]
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from config import Config

# Importing the module creates its singleton. Keep imports away from user data
# and do not start the production synchronization thread during tests.
with patch.dict(os.environ, {'DISABLE_AUTO_SYNC': '1'}), \
        patch.object(Config, 'load_json_config', return_value=copy.deepcopy(Config.DEFAULT_CONFIG)), \
        patch('sqlite3.connect'):
    from modules.urldata import routes, services


class BoxQueryTests(unittest.TestCase):
    def setUp(self):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        db_patch = patch.object(services, 'DB_FILE', str(Path(temp_dir.name) / 'records.db'))
        db_patch.start()
        self.addCleanup(db_patch.stop)
        config_patch = patch.object(Config, 'load_json_config', return_value=copy.deepcopy(Config.DEFAULT_CONFIG))
        config_patch.start()
        self.addCleanup(config_patch.stop)
        self.service = services.UrlDataService.__new__(services.UrlDataService)
        self.service._init_db()
        self.service._load_data_from_influx = Mock(return_value=[])
        self.service._load_verification_from_influx = Mock(return_value=[])
        service_patch = patch.object(routes, 'urldata_service', self.service)
        service_patch.start()
        self.addCleanup(service_patch.stop)
        app = Flask(__name__, template_folder=str(SERVICE_DIR / 'templates'))
        app.register_blueprint(routes.urldata_bp)
        app.testing = True
        self.client = app.test_client()

    def insert_record(self, content, box_num, time):
        conn = sqlite3.connect(services.DB_FILE)
        try:
            conn.execute(
                'INSERT INTO records (content, num3, record_time, date_str) VALUES (?, ?, ?, ?)',
                (content, box_num, time, time[:10]),
            )
            conn.commit()
        finally:
            conn.close()

    def query(self, **kwargs):
        return self.client.post('/api/urldata/box_query', json={'qrcode': 'sample', **kwargs})

    def test_local_history_is_found_and_latest_record_is_first(self):
        self.insert_record('sample', 3, '2020-01-01 08:00:00.000')
        self.insert_record('sample', 7, '2020-01-01 09:00:00.000')

        result = self.query(qrcode='  sample\r\n').get_json()

        self.assertTrue(result['success'])
        self.assertEqual(result['source'], 'database')
        self.assertEqual([r['box_num'] for r in result['matches']], [7, 3])
        self.service._load_data_from_influx.assert_not_called()

    def test_qrcode_wildcards_are_literal_in_local_search(self):
        self.insert_record('part_50%\\end', 3, '2020-01-01 08:00:00')
        self.insert_record('partX500\\end', 7, '2020-01-01 09:00:00')

        result = self.query(qrcode='part_50%\\end').get_json()

        self.assertEqual([r['box_num'] for r in result['matches']], [3])

    def test_remote_default_finds_data_older_than_two_hours(self):
        record_time = datetime.now(timezone.utc) - timedelta(hours=12)

        def load_window(start, stop):
            if datetime.fromisoformat(start) <= record_time < datetime.fromisoformat(stop):
                return [{'time': record_time, 'value': 'sample'}]
            return []

        self.service._load_data_from_influx.side_effect = load_window
        self.service._load_verification_from_influx.return_value = [
            {'value': '1'}, {'value': '2'}, {'value': '6'},
        ]

        result = self.query().get_json()

        self.assertTrue(result['success'])
        self.assertEqual(result['matches'][0]['box_num'], 6)
        self.assertEqual(result['lookback_hours'], 24)
        self.assertEqual(
            self.service._load_data_from_influx.call_args,
            self.service._load_verification_from_influx.call_args,
        )
        self.assertEqual(self.query(lookback_hours=2).get_json()['matches'], [])

    def test_seven_day_range_can_find_older_remote_data(self):
        self.query(lookback_hours=168)
        start, stop = self.service._load_data_from_influx.call_args.args
        self.assertEqual(datetime.fromisoformat(stop) - datetime.fromisoformat(start), timedelta(days=7))

    def test_remote_matches_are_latest_first_and_keep_verification_offset(self):
        now = datetime.now(timezone.utc)
        self.service._load_data_from_influx.return_value = [
            {'time': now - timedelta(minutes=1), 'value': 'SAMPLE'},
            {'time': now, 'value': 'sample'},
        ]
        self.service._load_verification_from_influx.return_value = [
            {'value': '1'}, {'value': '2'}, {'value': '3'}, {'value': '7'},
        ]

        result = self.query().get_json()

        self.assertEqual([r['box_num'] for r in result['matches']], [7, 3])
        self.assertEqual([r['index'] for r in result['matches']], [1, 0])

    def test_remote_failure_is_not_reported_as_no_matches(self):
        self.service._load_data_from_influx.side_effect = RuntimeError('读取二维码数据库失败')

        result = self.query().get_json()

        self.assertFalse(result['success'])
        self.assertIn('数据库失败', result['error'])
        self.service._load_verification_from_influx.assert_not_called()

    def test_empty_remote_window_is_a_successful_empty_query(self):
        result = self.query().get_json()

        self.assertTrue(result['success'])
        self.assertEqual(result['matches'], [])
        self.assertEqual(result['total_records'], 0)
        self.service._load_verification_from_influx.assert_not_called()

    def test_verification_failure_keeps_the_found_qrcode(self):
        self.service._load_data_from_influx.return_value = [
            {'time': datetime.now(timezone.utc), 'value': 'sample'},
        ]
        self.service._load_verification_from_influx.side_effect = RuntimeError('读取校验数据库失败')

        result = self.query().get_json()

        self.assertTrue(result['success'])
        self.assertEqual(result['matches'][0]['content'], 'sample')
        self.assertIsNone(result['matches'][0]['box_num'])
        self.assertIn('校验数据库失败', result['warning'])

    def test_invalid_verification_does_not_invent_a_box_number(self):
        self.service._load_data_from_influx.return_value = [
            {'time': datetime.now(timezone.utc), 'value': 'sample'},
        ]
        for value in ('N/A', '1.5', 'inf', 'nan', '0', '9'):
            with self.subTest(value=value):
                self.service._load_verification_from_influx.return_value = [
                    {'value': '1'}, {'value': '2'}, {'value': value},
                ]
                result = self.query().get_json()
                self.assertIsNone(result['matches'][0]['box_num'])

    def test_invalid_requests_are_rejected_without_reading_remote_database(self):
        for payload in (None, [], {}, {'qrcode': None}, {'qrcode': 123}, {'qrcode': ' \n'}):
            with self.subTest(payload=payload):
                response = self.client.post('/api/urldata/box_query', json=payload)
                self.assertEqual(response.status_code, 400)
                self.assertFalse(response.get_json()['success'])
        for hours in (None, '24', True, 0, -1, 9999):
            with self.subTest(hours=hours):
                self.assertEqual(self.query(lookback_hours=hours).status_code, 400)
        self.service._load_data_from_influx.assert_not_called()


class InfluxReadFailureTests(unittest.TestCase):
    def test_loaders_report_connection_failure_and_close_client(self):
        service = services.UrlDataService.__new__(services.UrlDataService)
        service.influx_config = {
            'url': 'http://localhost:8086', 'token': 'test-token', 'org': 'test-org',
            'bucket_data': 'test-data', 'bucket_verify': 'test-verify',
        }
        for loader in (service._load_data_from_influx, service._load_verification_from_influx):
            with self.subTest(loader=loader.__name__), \
                    patch('influxdb_client.InfluxDBClient') as client_type:
                client = client_type.return_value
                client.query_api.return_value.query.side_effect = ConnectionError('connection refused')
                with self.assertLogs(level='ERROR'), self.assertRaisesRegex(RuntimeError, '数据库失败'):
                    loader('-24h')
                client.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
