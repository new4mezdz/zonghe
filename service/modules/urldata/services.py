import os
import json
import glob
import logging
import sqlite3
from datetime import datetime, timezone, timedelta
from collections import Counter
from config import Config
import threading
import sys

BOX_COUNT = 9

def _app_dir():
    """返回数据文件存放目录:打包后 = exe 所在目录,开发时 = service 目录"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    # services.py -> urldata -> modules -> service
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DB_FILE = os.path.join(_app_dir(), 'urldata.db')
LAST_SYNC_FILE = os.path.join(_app_dir(), 'last_sync_time.json')
INITIAL_SYNC_STATE_FILE = os.path.join(_app_dir(), 'initial_sync_state.json')


def _runtime_path(path):
    """把配置中的相对数据路径固定到程序目录。"""
    if os.path.isabs(path):
        return path
    return os.path.join(_app_dir(), path)


def _now_text():
    return datetime.now().astimezone().isoformat(timespec='seconds')


class UrlDataService:
    """URL数据管理服务 - SQLite版"""

    def __init__(self):
        self.config = Config.load_json_config()
        self.last_process_logs = []
        self._initial_sync_lock = threading.Lock()
        self.influx_config = {
            'url': 'http://10.164.62.253:8086/',
            'token': 'u31cmj6sXb8CjYO1r0TcBbSNToKHXVsqbgMn-KBq7zvnmAEemTtYlN8ZwX7wXydgRr6VkdjuwwbiD0YgS6lq0A==',
            'org': 'myorg',
            'bucket_data': 'jbcj01',
            'bucket_verify': 'jbcj03'
        }
        self._init_db()

    def _init_db(self):
        """初始化数据库表"""
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute('''CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transport INTEGER,
            num1 INTEGER, num2 INTEGER, num3 INTEGER, num4 INTEGER,
            num5 INTEGER, num6 INTEGER, num7 INTEGER, num8 INTEGER,
            content TEXT,
            verification TEXT,
            record_time TEXT,
            date_str TEXT,
            type TEXT,
            corrected INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')
        c.execute('CREATE INDEX IF NOT EXISTS idx_date ON records(date_str)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_content ON records(content)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_time ON records(record_time)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_num3 ON records(num3)')
        try:
            c.execute('ALTER TABLE records ADD COLUMN transport INTEGER DEFAULT 0')
        except:
            pass
        try:
            c.execute('ALTER TABLE records ADD COLUMN corrected INTEGER DEFAULT 0')
        except:
            pass
        conn.commit()
        conn.close()

    def _get_conn(self):
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        return conn

    def _reload_config(self):
        self.config = Config.load_json_config()

    def _save_config(self, config):
        try:
            self.config = Config.save_json_config(config)
            return True
        except Exception as e:
            logging.error("保存配置失败: %s", e)
            return False

    # ========== 数据处理 ==========

    def process_data(
        self,
        start_time='-1h',
        stop_time=None,
        reset_numbers=False,
        write_output=True,
    ):
        logs = []

        def log(msg, level='info', content=None, time_str=None):
            entry = {'msg': msg, 'level': level}
            if content is not None:
                entry['content'] = content
            if time_str is not None:
                entry['time_str'] = time_str
            logs.append(entry)

        try:
            self._reload_config()
            config = self.config
            output_dir = _runtime_path(config.get('输出目录', '输出文件'))
            min_numbers = config.get('编号下限列表', [1] * BOX_COUNT)
            max_numbers = config.get('编号上限列表', [1000] * BOX_COUNT)
            enable_verification = config.get('错误处理', {}).get('启用校验', True)
            intervention_count = 0

            log("开始处理数据...")
            log("时间范围: {} ~ {}".format(start_time, stop_time or '现在'))

            data_records = self._load_data_from_influx(start_time, stop_time)
            log("从 jbcj01 读取到 {} 条数据".format(len(data_records)))

            if not data_records:
                log("InfluxDB 无数据", "warning")
                return {'success': False, 'message': '指定时间范围内无数据', 'logs': logs}

            verification_records = []
            if enable_verification:
                verification_records = self._load_verification_from_influx(start_time, stop_time)
                log("从 jbcj03 读取到 {} 条校验数据".format(len(verification_records)))

            if write_output and not os.path.exists(output_dir):
                os.makedirs(output_dir)

            if reset_numbers:
                last_numbers = [m - 1 for m in min_numbers]
                cycle_count = 0
            else:
                last_numbers, cycle_count = self._get_last_numbers()
            log("读取的上次最后编号: {}，循环轮数: {}".format(last_numbers, cycle_count))

            numbered_data = [] if write_output else None
            current_numbers = list(last_numbers)
            verification_errors = []
            db_rows = []

            for idx, record in enumerate(data_records):
                was_corrected = 0

                for i in range(BOX_COUNT):
                    current_numbers[i] += 1
                    if current_numbers[i] > max_numbers[i]:
                        current_numbers[i] = min_numbers[i]
                        if i == 3:
                            cycle_count += 1

                if hasattr(record['time'], 'astimezone'):
                    local_time = record['time'].astimezone(timezone(timedelta(hours=8)))
                    time_str = local_time.strftime('%Y-%m-%d %H:%M:%S.') + f'{local_time.microsecond // 1000:03d}'
                else:
                    time_str = str(record['time'])

                content_val = record['value']

                verification_value = verification_records[idx + 2]['value'] if (
                        enable_verification and idx + 2 < len(verification_records)) else "N/A"

                if enable_verification and verification_value != "N/A":
                    try:
                        ver_num = int(float(str(verification_value).strip()))
                        if current_numbers[3] != ver_num:
                            error_msg = "第{}行：三号轮摸盒({})与校验位({})不匹配，按校验位纠正 | 二维码: {} | 时间: {}".format(
                                idx + 1, current_numbers[3], ver_num, content_val, time_str)
                            verification_errors.append(error_msg)
                            log(error_msg, "warning", content=content_val, time_str=time_str)
                            current_numbers[3] = ver_num
                            for i in range(BOX_COUNT):
                                if i != 3:
                                    corrected = (cycle_count * 8 + ver_num) % max_numbers[i]
                                    if corrected == 0:
                                        corrected = max_numbers[i]
                                    current_numbers[i] = corrected
                            intervention_count += 1
                            was_corrected = 1
                    except ValueError:
                        pass

                dtype = "失败" if content_val.upper() == "FAIL" else \
                    "URL" if content_val.upper().startswith(("HTTP:", "HTTPS:")) else "其他"

                if write_output:
                    numbered_data.append("{}. {} | 校验位: {} | 时间: {}".format(
                        ','.join(map(str, current_numbers)), content_val, verification_value, time_str
                    ))

                date_only = time_str[:10] if len(time_str) >= 10 else datetime.now().strftime('%Y-%m-%d')
                db_rows.append((
                    current_numbers[0],
                    current_numbers[1], current_numbers[2], current_numbers[3], current_numbers[4],
                    current_numbers[5], current_numbers[6], current_numbers[7], current_numbers[8],
                    content_val, str(verification_value), time_str, date_only, dtype, was_corrected
                ))

            if verification_errors and enable_verification:
                log("累计触发 {} 次校验纠正".format(intervention_count), "warning")

            self._save_last_numbers_raw(current_numbers, cycle_count)

            conn = self._get_conn()
            c = conn.cursor()
            new_count = 0
            updated_count = 0
            for row in db_rows:
                c.execute('SELECT id FROM records WHERE record_time=? AND content=?', (row[11], row[9]))
                existing = c.fetchone()
                if existing and reset_numbers:
                    c.execute('''UPDATE records SET
                        transport=?,num1=?,num2=?,num3=?,num4=?,num5=?,num6=?,num7=?,num8=?,
                        content=?,verification=?,record_time=?,date_str=?,type=?,corrected=?
                        WHERE id=?''', row + (existing['id'],))
                    updated_count += 1
                elif not existing:
                    c.execute('''INSERT INTO records
                        (transport,num1,num2,num3,num4,num5,num6,num7,num8,content,verification,record_time,date_str,type,corrected)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', row)
                    new_count += 1
            conn.commit()
            conn.close()
            skipped_count = len(db_rows) - new_count - updated_count
            log(
                "写入数据库 {} 条新记录，校正 {} 条已有记录（跳过 {} 条重复）".format(
                    new_count, updated_count, skipped_count
                ),
                "success",
            )

            # 记录本次处理的最新数据时间
            if db_rows:
                self._save_last_sync_time(db_rows[-1][11])  # record_time

            if write_output:
                try:
                    file_date = start_time[:10].replace('-', '')
                except:
                    file_date = datetime.now().strftime('%Y%m%d')
                output_file = os.path.join(output_dir, "{}{}.txt".format(
                    config.get('输出文件前缀', '排序数据_'), file_date
                ))
                with open(output_file, 'w', encoding=config.get('文件编码', 'utf-8')) as f:
                    f.write('\n'.join(numbered_data))

            msg = "处理了 {} 条数据".format(len(data_records))
            log("处理完成！" + msg, "success")
            return {'success': True, 'message': msg, 'logs': logs}

        except Exception as e:
            log("处理出错: {}".format(e), "error")
            return {'success': False, 'message': str(e), 'logs': logs}

    # ========== 查询功能（从数据库） ==========

    def query_by_date(self, date, start_time=None, stop_time=None, sort_order='desc'):
        order = 'DESC' if sort_order == 'desc' else 'ASC'
        conn = self._get_conn()
        c = conn.cursor()
        if start_time and stop_time:
            c.execute(f'''SELECT * FROM records WHERE date_str=?
                AND substr(record_time,12,5) >= ? AND substr(record_time,12,5) <= ?
                ORDER BY record_time {order}''',
                      (date, start_time, stop_time))
        else:
            c.execute(f'SELECT * FROM records WHERE date_str=? ORDER BY record_time {order}', (date,))
        rows = c.fetchall()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def query_by_number(self, num_input, box_indices=None, sort_order='desc'):
        target_nums = set()
        for part in num_input.split(','):
            part = part.strip()
            if '-' in part:
                s, e = map(int, part.split('-'))
                target_nums.update(range(min(s, e), max(s, e) + 1))
            else:
                target_nums.add(int(part))

        conn = self._get_conn()
        c = conn.cursor()
        order = 'DESC' if sort_order == 'desc' else 'ASC'

        if box_indices and len(box_indices) > 0:
            cols = []
            for bi in box_indices:
                if bi == 0:
                    cols.append('transport')
                elif 1 <= bi <= 8:
                    cols.append(f'num{bi}')
            if cols:
                placeholders = ','.join('?' * len(target_nums))
                conditions = ' OR '.join(f'{col} IN ({placeholders})' for col in cols)
                params = list(target_nums) * len(cols)
                c.execute(f'SELECT * FROM records WHERE {conditions} ORDER BY record_time {order}', params)
            else:
                return []
        else:
            cols = ['transport'] + [f'num{i+1}' for i in range(BOX_COUNT - 1)]
            conditions = ' OR '.join(f'{col} IN ({",".join("?" * len(target_nums))})' for col in cols)
            params = list(target_nums) * len(cols)
            c.execute(f'SELECT * FROM records WHERE {conditions} ORDER BY record_time {order}', params)

        rows = c.fetchall()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def query_by_number_multi(self, box_queries, sort_order='desc'):
        order = 'DESC' if sort_order == 'desc' else 'ASC'
        conn = self._get_conn()
        c = conn.cursor()
        conditions = []
        params = []
        for box_idx_str, num_input in box_queries.items():
            bi = int(box_idx_str)
            col = 'transport' if bi == 0 else f'num{bi}'
            target_nums = set()
            for part in num_input.split(','):
                part = part.strip()
                if '-' in part:
                    s, e = map(int, part.split('-'))
                    target_nums.update(range(min(s, e), max(s, e) + 1))
                else:
                    target_nums.add(int(part))
            placeholders = ','.join('?' * len(target_nums))
            conditions.append(f'{col} IN ({placeholders})')
            params.extend(target_nums)
        if not conditions:
            conn.close()
            return []
        sql = f'SELECT * FROM records WHERE {" OR ".join(conditions)} ORDER BY record_time {order}'
        c.execute(sql, params)
        rows = c.fetchall()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def query_by_content(self, content_search, sort_order='desc'):
        order = 'DESC' if sort_order == 'desc' else 'ASC'
        conn = self._get_conn()
        c = conn.cursor()
        c.execute(f'SELECT * FROM records WHERE content LIKE ? ORDER BY record_time {order}',
                  (f'%{content_search}%',))
        rows = c.fetchall()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def query_duplicates(self, date, sort_order='desc'):
        order = 'DESC' if sort_order == 'desc' else 'ASC'
        conn = self._get_conn()
        c = conn.cursor()
        c.execute(f'''SELECT * FROM records WHERE date_str=? AND content IN
            (SELECT content FROM records WHERE date_str=? GROUP BY content HAVING COUNT(*)>1)
            ORDER BY record_time {order}''', (date, date))
        rows = c.fetchall()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def _row_to_dict(self, row):
        return {
            'numbers': [row['transport'] or 0, row['num1'], row['num2'], row['num3'], row['num4'],
                        row['num5'], row['num6'], row['num7'], row['num8']],
            'content': row['content'],
            'verification': row['verification'],
            'type': row['type'],
            'date': row['record_time'],
            'corrected': row['corrected'] if 'corrected' in row.keys() else 0
        }

    def query(self, query_type, **kwargs):
        sort_order = kwargs.get('sort_order', 'desc')
        if query_type == 'date':
            results = self.query_by_date(
                kwargs.get('date', ''),
                kwargs.get('start_time'),
                kwargs.get('stop_time'),
                sort_order=sort_order
            )
        elif query_type == 'number':
            box_queries = kwargs.get('box_queries')
            if box_queries:
                results = self.query_by_number_multi(box_queries, sort_order=sort_order)
            else:
                results = self.query_by_number(kwargs.get('number', ''), kwargs.get('box_indices'), sort_order=sort_order)
        elif query_type == 'content':
            results = self.query_by_content(kwargs.get('content', ''), sort_order=sort_order)
        elif query_type == 'duplicates':
            results = self.query_duplicates(kwargs.get('date', ''), sort_order=sort_order)
        else:
            results = []
        total = len(results)
        url_count = sum(1 for r in results if r['type'] == 'URL')
        fail_count = sum(1 for r in results if r['type'] == '失败')
        return {
            'results': results,
            'stats': {'total': total, 'url': url_count, 'fail': fail_count,
                      'other': total - url_count - fail_count}
        }

    def get_file_list(self):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute('SELECT DISTINCT date_str FROM records ORDER BY date_str DESC')
        dates = [row['date_str'] for row in c.fetchall()]
        conn.close()
        return dates

    # ========== 辅助方法 ==========

    def _get_last_numbers(self):
        number_file = _runtime_path(self.config.get('序号记录文件', 'last_numbers.json'))
        min_numbers = self.config.get('编号下限列表', [1] * BOX_COUNT)
        default = [m - 1 for m in min_numbers]
        if not os.path.exists(number_file):
            return default, 0
        try:
            with open(number_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                nums = data.get('numbers', default)
                cycle = data.get('cycle_count', 0)
                if isinstance(nums, list):
                    if len(nums) == BOX_COUNT:
                        return nums, cycle
                    elif len(nums) == BOX_COUNT - 1:
                        return [min_numbers[0] - 1] + nums, cycle
                return default, cycle
            elif isinstance(data, list):
                if len(data) == BOX_COUNT:
                    return data, 0
                elif len(data) == BOX_COUNT - 1:
                    return [min_numbers[0] - 1] + data, 0
            return default, 0
        except:
            return default, 0

    def _save_last_numbers_raw(self, numbers, cycle_count=0):
        number_file = _runtime_path(self.config.get('序号记录文件', 'last_numbers.json'))
        try:
            with open(number_file, 'w', encoding='utf-8') as f:
                json.dump({'numbers': numbers, 'cycle_count': cycle_count}, f, indent=4)
            return True
        except:
            return False

    def _load_verification_data(self):
        verification_file = _runtime_path(self.config.get('校验文件', '校验文件.txt'))
        if not os.path.exists(verification_file):
            return []
        try:
            with open(verification_file, 'r', encoding=self.config.get('文件编码', 'utf-8')) as f:
                return [line.strip() for line in f.readlines() if line.strip()]
        except:
            return []

    def _get_last_sync_time(self):
        """读取上次同步成功的时间"""
        try:
            if os.path.exists(LAST_SYNC_FILE):
                with open(LAST_SYNC_FILE, 'r') as f:
                    data = json.load(f)
                return data.get('last_sync_time')
        except:
            pass
        return None

    def _save_last_sync_time(self, time_str):
        """保存本次同步成功的时间"""
        try:
            temp_file = LAST_SYNC_FILE + '.tmp'
            with open(temp_file, 'w', encoding='utf-8') as f:
                json.dump({'last_sync_time': time_str}, f)
            os.replace(temp_file, LAST_SYNC_FILE)
        except:
            pass

    def _database_summary(self):
        """返回本地轨迹库是否已有可用数据。"""
        conn = self._get_conn()
        try:
            row = conn.execute(
                'SELECT COUNT(*) AS total, MIN(record_time) AS first_time, '
                'MAX(record_time) AS last_time FROM records'
            ).fetchone()
            return {
                'record_count': int(row['total'] or 0),
                'first_record_time': row['first_time'],
                'last_record_time': row['last_time'],
            }
        finally:
            conn.close()

    def _write_initial_sync_state(self, state):
        payload = {
            **state,
            'schema_version': 2,
            'database_file': DB_FILE,
        }
        temp_file = INITIAL_SYNC_STATE_FILE + '.tmp'
        try:
            with open(temp_file, 'w', encoding='utf-8') as f:
                json.dump(payload, f, ensure_ascii=False, indent=4)
            os.replace(temp_file, INITIAL_SYNC_STATE_FILE)
        except Exception as exc:
            logging.error("写入首次同步状态失败: %s", exc)
        return payload

    def _read_initial_sync_state(self):
        try:
            if os.path.exists(INITIAL_SYNC_STATE_FILE):
                with open(INITIAL_SYNC_STATE_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
        except (OSError, ValueError, TypeError):
            pass
        return None

    def get_initial_sync_status(self):
        current = self._read_initial_sync_state()
        if current:
            return current
        return self._write_initial_sync_state({
            'status': 'pending',
            'checked_at': _now_text(),
            'requires_manual_action': False,
            **self._database_summary(),
        })

    def ensure_initial_sync(self):
        """
        首次启动自检：
        - 本地库已有记录时从最后时间继续增量同步，不再回补历史。
        - 新环境默认只回溯最近 24 小时；可在 config.json 中显式开启全量历史。
        """
        with self._initial_sync_lock:
            summary = self._database_summary()
            previous_state = self._read_initial_sync_state() or {}

            if summary['record_count'] > 0:
                if summary['last_record_time'] and not self._get_last_sync_time():
                    self._save_last_sync_time(summary['last_record_time'])
                state = self._write_initial_sync_state({
                    **previous_state,
                    'status': 'completed',
                    'source': previous_state.get('source', 'existing_database'),
                    'checked_at': _now_text(),
                    'completed_at': previous_state.get('completed_at', _now_text()),
                    'historical_backfill_enabled': False,
                    'requires_manual_action': False,
                    **summary,
                })
                logging.info(
                    "首次同步自检：本地已有 %d 条记录，跳过历史回补",
                    summary['record_count'],
                )
                return {'success': True, 'action': 'existing_database', 'state': state}

            started_at = _now_text()
            self._reload_config()
            initial_config = self.config.get('首次同步', {})
            full_history = initial_config.get('拉取全部历史', False) is True
            try:
                lookback_hours = max(1, int(initial_config.get('回溯小时', 24)))
            except (TypeError, ValueError):
                lookback_hours = 24
            source = 'influxdb_full_sync' if full_history else 'influxdb_recent_sync'
            self._write_initial_sync_state({
                'status': 'running',
                'source': source,
                'checked_at': started_at,
                'started_at': started_at,
                'historical_backfill_enabled': full_history,
                'initial_lookback_hours': None if full_history else lookback_hours,
                'full_history_verified': False,
                'requires_manual_action': False,
                **summary,
            })
            if full_history:
                logging.info("首次同步自检：本地数据库为空，开始自动全量初始化")
            else:
                logging.info(
                    "首次同步自检：本地数据库为空，先同步最近 %d 小时",
                    lookback_hours,
                )

            remote_earliest_time = None
            try:
                if full_history:
                    earliest = self._get_earliest_influx_time()
                    if earliest is None:
                        raise RuntimeError("InfluxDB 主数据桶中没有可读取的数据")
                    if hasattr(earliest, 'astimezone'):
                        remote_earliest_time = (
                            earliest.astimezone(timezone.utc)
                            .isoformat()
                            .replace('+00:00', 'Z')
                        )
                    else:
                        remote_earliest_time = str(earliest)
                    start_time = remote_earliest_time
                else:
                    start_time = '-{}h'.format(lookback_hours)

                result = self.process_data(
                    start_time,
                    reset_numbers=True,
                    write_output=False,
                )
                summary = self._database_summary()
                if result.get('success') and summary['record_count'] > 0:
                    state = self._write_initial_sync_state({
                        'status': 'completed',
                        'source': source,
                        'checked_at': started_at,
                        'started_at': started_at,
                        'completed_at': _now_text(),
                        'remote_earliest_time': remote_earliest_time,
                        'historical_backfill_enabled': full_history,
                        'initial_lookback_hours': None if full_history else lookback_hours,
                        'full_history_verified': full_history,
                        'requires_manual_action': False,
                        **summary,
                    })
                    logging.info(
                        "首次数据初始化完成，共 %d 条记录",
                        summary['record_count'],
                    )
                    return {'success': True, 'action': 'initialized', 'state': state}

                error = result.get('message') or '全量同步结束后本地数据库仍为空'
            except Exception as exc:
                error = str(exc)
                summary = self._database_summary()

            state = self._write_initial_sync_state({
                'status': 'failed',
                'source': source,
                'checked_at': started_at,
                'started_at': started_at,
                'failed_at': _now_text(),
                'remote_earliest_time': remote_earliest_time,
                'historical_backfill_enabled': full_history,
                'initial_lookback_hours': None if full_history else lookback_hours,
                'full_history_verified': False,
                'requires_manual_action': True,
                'last_error': error,
                **summary,
            })
            logging.error("首次全量初始化失败: %s", error)
            return {'success': False, 'action': 'failed', 'error': error, 'state': state}

    # ========== 设置相关 ==========

    def get_settings(self):
        self._reload_config()
        return {
            'mins': self.config.get('编号下限列表', [1] * BOX_COUNT),
            'maxs': self.config.get('编号上限列表', [1000] * BOX_COUNT)
        }

    def save_settings(self, mins, maxs):
        try:
            self._reload_config()
            config = self.config.copy()
            config['编号下限列表'] = mins
            config['编号上限列表'] = maxs
            return {'success': self._save_config(config)}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def get_last_numbers(self):
        self._reload_config()
        nums, cycle = self._get_last_numbers()
        return nums

    def save_last_numbers(self, numbers):
        self._reload_config()
        return {'success': self._save_last_numbers_raw(numbers)}

    def reset_last_numbers(self):
        self._reload_config()
        number_file = _runtime_path(self.config.get('序号记录文件', 'last_numbers.json'))
        try:
            if os.path.exists(number_file):
                os.remove(number_file)
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def get_error_settings(self):
        self._reload_config()
        error_config = self.config.get('错误处理', {})
        verify_file = _runtime_path(self.config.get('校验文件', '校验文件.txt'))
        if os.path.exists(verify_file):
            try:
                with open(verify_file, 'r', encoding=self.config.get('文件编码', 'utf-8')) as f:
                    count = len([l for l in f.readlines() if l.strip()])
                status = '<span style="color:#22c55e;">✅ 校验文件存在，共 {} 行</span>'.format(count)
            except:
                status = '<span style="color:#ef4444;">❌ 校验文件读取失败</span>'
        else:
            status = '<span style="color:#ef4444;">❌ 校验文件不存在: {}</span>'.format(verify_file)
        return {
            'enabled': error_config.get('启用校验', True),
            'error_settings': error_config.get('错误时设置', [1] * BOX_COUNT),
            'verify_file_status': status
        }

    def save_error_settings(self, enabled, error_settings):
        try:
            self._reload_config()
            config = self.config.copy()
            config['错误处理'] = {'启用校验': enabled, '错误时设置': error_settings}
            return {'success': self._save_config(config)}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def get_scheduler_config(self):
        self._reload_config()
        tc = self.config.get('定时处理', {})
        return {
            'enabled': tc.get('启用', False),
            'hours': tc.get('间隔小时', 0),
            'minutes': tc.get('间隔分钟', 30),
            'seconds': tc.get('间隔秒', 0),
            'retry': tc.get('失败重试', True),
            'retry_interval': tc.get('重试间隔', 30)
        }

    def save_scheduler_config(self, data):
        try:
            self._reload_config()
            config = self.config.copy()
            config['定时处理'] = {
                '启用': data.get('enabled', False),
                '间隔小时': data.get('hours', 0),
                '间隔分钟': data.get('minutes', 30),
                '间隔秒': data.get('seconds', 0),
                '失败重试': data.get('retry', True),
                '重试间隔': data.get('retry_interval', 30)
            }
            return {'success': self._save_config(config)}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def get_scheduler_status(self):
        self._reload_config()
        tc = self.config.get('定时处理', {})
        if tc.get('启用', False):
            return {
                'status': "⏰ 定时处理已启用 | 间隔: {}小时 {}分钟 {}秒".format(tc.get('间隔小时', 0),
                                                                               tc.get('间隔分钟', 30),
                                                                               tc.get('间隔秒', 0))}
        return {'status': '⏸️ 定时处理未启用'}

    def get_last_process_logs(self):
        return self.last_process_logs

    # ========== InfluxDB ==========

    def _get_earliest_influx_time(self):
        """查询主数据桶当前可读取到的最早记录时间。"""
        from influxdb_client import InfluxDBClient

        client = InfluxDBClient(
            url=self.influx_config['url'],
            token=self.influx_config['token'],
            org=self.influx_config['org'],
        )
        try:
            bucket = self.influx_config['bucket_data']
            query = f'''from(bucket: "{bucket}")
                |> range(start: 0)
                |> filter(fn: (r) => r["_field"] == "code")
                |> first()
                |> group()
                |> sort(columns: ["_time"])
                |> limit(n: 1)'''
            tables = client.query_api().query(query, org=self.influx_config['org'])
            for table in tables:
                for record in table.records:
                    return record.get_time()
            return None
        finally:
            client.close()

    def get_influx_history_profile(self):
        """列出主数据桶中各 measurement/field 当前可读取到的最早时间。"""
        try:
            from influxdb_client import InfluxDBClient

            client = InfluxDBClient(
                url=self.influx_config['url'],
                token=self.influx_config['token'],
                org=self.influx_config['org'],
            )
            try:
                bucket = self.influx_config['bucket_data']
                query = f'''from(bucket: "{bucket}")
                    |> range(start: 0)
                    |> first()
                    |> group(columns: ["_measurement", "_field"])
                    |> sort(columns: ["_time"])
                    |> limit(n: 1)'''
                tables = client.query_api().query(
                    query,
                    org=self.influx_config['org'],
                )
                fields = []
                for table in tables:
                    for record in table.records:
                        fields.append({
                            'measurement': record.get_measurement(),
                            'field': record.get_field(),
                            'earliest_time': str(record.get_time()),
                        })
                fields.sort(
                    key=lambda item: (
                        item['earliest_time'],
                        item['measurement'] or '',
                        item['field'] or '',
                    )
                )
                return {
                    'success': True,
                    'bucket': bucket,
                    'fields': fields,
                }
            finally:
                client.close()
        except Exception as exc:
            return {'success': False, 'error': str(exc)}

    def _load_data_from_influx(self, start_time, stop_time=None):
        try:
            from influxdb_client import InfluxDBClient
            client = InfluxDBClient(
                url=self.influx_config['url'],
                token=self.influx_config['token'],
                org=self.influx_config['org']
            )
            bucket = self.influx_config['bucket_data']
            stop_clause = f', stop: {stop_time}' if stop_time else ''
            query = f'''from(bucket: "{bucket}")
                |> range(start: {start_time}{stop_clause})
                |> filter(fn: (r) => r["_field"] == "code")
                |> sort(columns: ["_time"])'''
            tables = client.query_api().query(query, org=self.influx_config['org'])
            records = []
            for table in tables:
                for record in table.records:
                    records.append({
                        'time': record.get_time(),
                        'value': str(record.get_value())
                    })
            client.close()
            records.sort(key=lambda r: r['time'])
            return records
        except Exception as e:
            logging.error("读取 jbcj01 失败: %s", e)
            return []

    def _load_verification_from_influx(self, start_time, stop_time=None):
        try:
            from influxdb_client import InfluxDBClient
            client = InfluxDBClient(
                url=self.influx_config['url'],
                token=self.influx_config['token'],
                org=self.influx_config['org']
            )
            bucket = self.influx_config['bucket_verify']
            stop_clause = f', stop: {stop_time}' if stop_time else ''
            query = f'''from(bucket: "{bucket}")
              |> range(start: {start_time}{stop_clause})
              |> filter(fn: (r) => r["_field"] == "code")
              |> sort(columns: ["_time"])'''
            tables = client.query_api().query(query, org=self.influx_config['org'])
            records = []
            for table in tables:
                for record in table.records:
                    records.append({
                        'time': record.get_time(),
                        'value': str(record.get_value())
                    })
            client.close()
            records.sort(key=lambda r: r['time'])
            return records
        except Exception as e:
            logging.error("读取 jbcj03 失败: %s", e)
            return []

    def get_influx_status(self):
        try:
            from influxdb_client import InfluxDBClient
            client = InfluxDBClient(
                url=self.influx_config['url'],
                token=self.influx_config['token'],
                org=self.influx_config['org']
            )
            health = client.health()
            bucket_status = {}
            query_api = client.query_api()
            for key in ['bucket_data', 'bucket_verify']:
                bucket = self.influx_config[key]
                try:
                    query = f'from(bucket: "{bucket}") |> range(start: -1h) |> limit(n: 1)'
                    tables = query_api.query(query, org=self.influx_config['org'])
                    has_data = any(len(t.records) > 0 for t in tables)
                    bucket_status[bucket] = {'connected': True, 'has_recent_data': has_data}
                except Exception as e:
                    bucket_status[bucket] = {'connected': False, 'error': str(e)}
            client.close()
            return {
                'success': True, 'status': health.status, 'message': health.message,
                'buckets': bucket_status,
                'config': {
                    'url': self.influx_config['url'], 'org': self.influx_config['org'],
                    'bucket_data': self.influx_config['bucket_data'],
                    'bucket_verify': self.influx_config['bucket_verify']
                }
            }
        except ImportError:
            return {'success': False, 'error': '未安装 influxdb-client，请执行 pip install influxdb-client'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def query_influx_sample(self, bucket_key='bucket_data', hours=1, limit=10):
        try:
            from influxdb_client import InfluxDBClient
            bucket = self.influx_config[bucket_key]
            client = InfluxDBClient(
                url=self.influx_config['url'],
                token=self.influx_config['token'],
                org=self.influx_config['org']
            )
            query_api = client.query_api()
            query = f'from(bucket: "{bucket}") |> range(start: -{hours}h) |> limit(n: {limit})'
            tables = query_api.query(query, org=self.influx_config['org'])
            records = []
            for table in tables:
                for record in table.records:
                    records.append({
                        'time': str(record.get_time()),
                        'measurement': record.get_measurement(),
                        'field': record.get_field(),
                        'value': str(record.get_value())
                    })
            client.close()
            return {'success': True, 'bucket': bucket, 'count': len(records), 'records': records}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def query_box_by_qrcode(self, qrcode):
        conn = self._get_conn()
        c = conn.cursor()
        c.execute('SELECT * FROM records WHERE content LIKE ? ORDER BY record_time DESC LIMIT 50',
                  (f'%{qrcode}%',))
        rows = c.fetchall()
        conn.close()

        if rows:
            matched = []
            for row in rows:
                matched.append({
                    'index': row['id'],
                    'numbers': [row['num3']],
                    'box_num': row['num3'],
                    'content': row['content'],
                    'time': row['record_time']
                })
            return {'success': True, 'total_records': len(rows), 'matches': matched, 'source': 'database'}

        records = self._load_data_from_influx('-2h')
        if not records:
            return {'success': False, 'error': '最近2小时无数据'}
        verification_records = self._load_verification_from_influx('-2h')
        matched = []
        for idx, record in enumerate(records):
            if qrcode and qrcode in str(record['value']):
                box_num = None
                if idx + 2 < len(verification_records):
                    try:
                        box_num = int(float(str(verification_records[idx + 2]['value']).strip()))
                    except (ValueError, TypeError):
                        box_num = None
                matched.append({
                    'index': idx,
                    'numbers': [box_num] if box_num is not None else [None],
                    'box_num': box_num,
                    'content': record['value'],
                    'time': str(record['time'])
                })
        return {'success': True, 'total_records': len(records), 'matches': matched, 'source': 'influxdb'}

    def start_auto_sync(self):
        def _sync_loop():
            initial_result = None
            while not initial_result or not initial_result.get('success'):
                initial_result = self.ensure_initial_sync()
                if initial_result.get('success'):
                    break
                self._reload_config()
                retry_config = self.config.get('定时处理', {})
                retry_seconds = retry_config.get('重试间隔', 60)
                try:
                    retry_seconds = max(10, int(retry_seconds))
                except (TypeError, ValueError):
                    retry_seconds = 60
                logging.info("首次同步将在 %d 秒后重试", retry_seconds)
                threading.Event().wait(retry_seconds)

            skip_immediate_sync = initial_result.get('action') in {
                'initialized',
                'reconciled',
            }
            while True:
                try:
                    self._reload_config()
                    tc = self.config.get('定时处理', {})
                    if tc.get('启用', False):
                        hours = tc.get('间隔小时', 0)
                        minutes = tc.get('间隔分钟', 30)
                        seconds = tc.get('间隔秒', 0)
                        try:
                            interval = int(
                                float(hours) * 3600
                                + float(minutes) * 60
                                + float(seconds)
                            )
                        except (TypeError, ValueError):
                            interval = 24 * 3600
                        if interval < 10:
                            interval = 10
                        if skip_immediate_sync:
                            skip_immediate_sync = False
                            logging.info("首次全量同步刚完成，%d 秒后开始增量同步", interval)
                        else:
                            logging.info("自动同步：开始处理...")
                            last_sync = self._get_last_sync_time()
                            if last_sync:
                                start_time = last_sync.replace(' ', 'T') + '+08:00'
                            else:
                                start_time = '-{}s'.format(interval + 60)
                            result = self.process_data(start_time)
                            self.last_process_logs = result.get('logs', [])
                            logging.info("自动同步：处理完成，等待 %d 秒", interval)
                        threading.Event().wait(interval)
                    else:
                        threading.Event().wait(30)
                except Exception as e:
                    logging.error("自动同步出错: %s", e)
                    threading.Event().wait(60)

        t = threading.Thread(target=_sync_loop, daemon=True)
        t.start()
        logging.info("后台自动同步线程已启动")

urldata_service = UrlDataService()
if os.environ.get('DISABLE_AUTO_SYNC') != '1':
    urldata_service.start_auto_sync()
