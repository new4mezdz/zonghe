import os
import json
import glob
import logging
import sqlite3
from datetime import datetime, timezone, timedelta
from collections import Counter
from config import Config
import threading
BOX_COUNT = 9
DB_FILE = r'E:\9#\zonghe\service\urldata.db'


class UrlDataService:
    """URL数据管理服务 - SQLite版"""

    def __init__(self):
        self.config = Config.load_json_config()
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
            with open('config.json', 'w', encoding='utf-8') as f:
                json.dump(config, f, ensure_ascii=False, indent=4)
            self._reload_config()
            return True
        except Exception as e:
            logging.error("保存配置失败: %s", e)
            return False

    # ========== 数据处理 ==========

    def process_data(self, start_time='-1h', stop_time=None):
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
            output_dir = config.get('输出目录', '输出文件')
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

            if not os.path.exists(output_dir):
                os.makedirs(output_dir)

            last_numbers, cycle_count = self._get_last_numbers()
            log("读取的上次最后编号: {}，循环轮数: {}".format(last_numbers, cycle_count))

            numbered_data, current_numbers = [], list(last_numbers)
            verification_errors = []
            db_rows = []

            for idx, record in enumerate(data_records):
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
                    except ValueError:
                        pass

                dtype = "失败" if content_val.upper() == "FAIL" else \
                    "URL" if content_val.upper().startswith(("HTTP:", "HTTPS:")) else "其他"

                numbered_data.append("{}. {} | 校验位: {} | 时间: {}".format(
                    ','.join(map(str, current_numbers)), content_val, verification_value, time_str
                ))

                date_only = time_str[:10] if len(time_str) >= 10 else datetime.now().strftime('%Y-%m-%d')
                db_rows.append((
                    current_numbers[0],
                    current_numbers[1], current_numbers[2], current_numbers[3], current_numbers[4],
                    current_numbers[5], current_numbers[6], current_numbers[7], current_numbers[8],
                    content_val, str(verification_value), time_str, date_only, dtype
                ))

            if verification_errors and enable_verification:
                log("累计触发 {} 次校验纠正".format(intervention_count), "warning")

            self._save_last_numbers_raw(current_numbers, cycle_count)

            conn = self._get_conn()
            c = conn.cursor()
            new_count = 0
            for row in db_rows:
                c.execute('SELECT id FROM records WHERE record_time=? AND content=?', (row[11], row[9]))
                if not c.fetchone():
                    c.execute('''INSERT INTO records
                        (transport,num1,num2,num3,num4,num5,num6,num7,num8,content,verification,record_time,date_str,type)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', row)
                    new_count += 1
            conn.commit()
            conn.close()
            log("写入数据库 {} 条新记录（跳过 {} 条重复）".format(new_count, len(db_rows) - new_count), "success")

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
            'date': row['record_time']
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
        number_file = self.config.get('序号记录文件', 'last_numbers.json')
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
        number_file = self.config.get('序号记录文件', 'last_numbers.json')
        try:
            with open(number_file, 'w', encoding='utf-8') as f:
                json.dump({'numbers': numbers, 'cycle_count': cycle_count}, f, indent=4)
            return True
        except:
            return False

    def _load_verification_data(self):
        verification_file = self.config.get('校验文件', '校验文件.txt')
        if not os.path.exists(verification_file):
            return []
        try:
            with open(verification_file, 'r', encoding=self.config.get('文件编码', 'utf-8')) as f:
                return [line.strip() for line in f.readlines() if line.strip()]
        except:
            return []

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
        number_file = self.config.get('序号记录文件', 'last_numbers.json')
        try:
            if os.path.exists(number_file):
                os.remove(number_file)
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def get_error_settings(self):
        self._reload_config()
        error_config = self.config.get('错误处理', {})
        verify_file = self.config.get('校验文件', '校验文件.txt')
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
            'hours': tc.get('间隔小时', 1),
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
                '间隔小时': data.get('hours', 1),
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
                'status': "⏰ 定时处理已启用 | 间隔: {}小时 {}分钟 {}秒".format(tc.get('间隔小时', 1),
                                                                               tc.get('间隔分钟', 30),
                                                                               tc.get('间隔秒', 0))}
        return {'status': '⏸️ 定时处理未启用'}

    # ========== InfluxDB ==========

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
            while True:
                try:
                    self._reload_config()
                    tc = self.config.get('定时处理', {})
                    if tc.get('启用', False):
                        hours = tc.get('间隔小时', 0)
                        minutes = tc.get('间隔分钟', 30)
                        seconds = tc.get('间隔秒', 0)
                        interval = hours * 3600 + minutes * 60 + seconds
                        if interval < 10:
                            interval = 10
                        logging.info("自动同步：开始处理...")
                        self.process_data('-{}s'.format(interval + 60))
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

# 创建全局服务实例
urldata_service = UrlDataService()
urldata_service.start_auto_sync()