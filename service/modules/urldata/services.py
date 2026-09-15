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
import time
import hashlib
import re
from concurrent.futures import ThreadPoolExecutor

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
        self._process_lock = threading.RLock()
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
        c.execute('CREATE INDEX IF NOT EXISTS idx_content_nocase ON records(content COLLATE NOCASE)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_content_time_nocase '
                  'ON records(content COLLATE NOCASE, record_time DESC)')
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

    @staticmethod
    def _today_window(now=None):
        """业务日期固定为北京时间，不随部署电脑的系统时区变化。"""
        now = now or datetime.now(timezone.utc)
        local = now.astimezone(timezone(timedelta(hours=8)))
        return (local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc),
                now.astimezone(timezone.utc))

    @classmethod
    def _limit_today_window(cls, start_time=None, stop_time=None, now=None):
        day_start, current = cls._today_window(now)

        def parse(value, default):
            if value is None or value == '':
                return default
            if value == 0 or value == '0':
                return datetime(1970, 1, 1, tzinfo=timezone.utc)
            if isinstance(value, datetime):
                date = value
            else:
                duration = re.fullmatch(r'-(\d+)([smhdw])', str(value))
                if duration:
                    units = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400, 'w': 604800}
                    return current - timedelta(seconds=int(duration[1]) * units[duration[2]])
                date = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone(timedelta(hours=8)))
            return date.astimezone(timezone.utc)

        return max(day_start, parse(start_time, day_start)), min(current, parse(stop_time, current))

    @classmethod
    def _today_text_window(cls):
        return tuple(cls._record_time_text(value) for value in cls._today_window())

    @staticmethod
    def _date_time_value(date, value):
        return datetime.strptime(f'{date} {value}', '%Y-%m-%d %H:%M:%S' if len(value) == 8
                                 else '%Y-%m-%d %H:%M').replace(tzinfo=timezone(timedelta(hours=8)))

    def process_data(
        self,
        start_time='-1h',
        stop_time=None,
        reset_numbers=False,
        write_output=True,
    ):
        # 网页主动更新和后台同步共用编号状态，必须串行处理。
        with self._process_lock:
            result = self._process_data(start_time, stop_time, reset_numbers, write_output)
            self.last_process_logs = result.get('logs', [])
            return result

    @staticmethod
    def _record_time_text(value):
        if hasattr(value, 'astimezone'):
            local_time = value.astimezone(timezone(timedelta(hours=8)))
            return local_time.strftime('%Y-%m-%d %H:%M:%S.') + f'{local_time.microsecond // 1000:03d}'
        return str(value)

    def _process_data(self, start_time, stop_time, reset_numbers, write_output):
        logs = []

        def log(msg, level='info', content=None, time_str=None):
            entry = {'msg': msg, 'level': level}
            if content is not None:
                entry['content'] = content
            if time_str is not None:
                entry['time_str'] = time_str
            logs.append(entry)

        try:
            # 一次处理固定同一个起止时间，两路读取跨零点时也不会错开窗口。
            start, stop = self._limit_today_window(start_time, stop_time)
            if start >= stop:
                message = '当前仅处理北京时间今天零点至当前时间的数据，所选时段没有交集。'
                log(message, 'warning')
                return {'success': False, 'code': 'outside_today', 'message': message, 'logs': logs}
            start_time, stop_time = start.isoformat(), stop.isoformat()
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
                message = '同步时段内 jbcj01 没有二维码数据；jbcj03 的校验编号不能单独生成轨迹。'
                log(message, "warning")
                return {'success': False, 'code': 'no_data', 'message': message, 'logs': logs}

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
            # 配置读取恢复后，旧状态中可能还存着越界编号（如一号轮为 5）。
            # 先按完整周期还原相位，再推进；不能直接重置为下限而错开 1、2。
            for i, value in enumerate(current_numbers):
                number = self._box_number(value)
                minimum, maximum = min_numbers[i], max_numbers[i]
                current_numbers[i] = minimum - 1 if number is None else (
                    number if minimum - 1 <= number <= maximum
                    else minimum + (number - minimum) % (maximum - minimum + 1)
                )
            verification_errors = []
            db_rows = []

            # 在推进编号之前去重，同时保留原始 idx，避免改变校验记录的 +2 偏移。
            record_times = [self._record_time_text(record['time']) for record in data_records]
            seen = set()
            if not reset_numbers:
                conn = self._get_conn()
                try:
                    seen = {
                        (row['record_time'], row['content'])
                        for row in conn.execute(
                            'SELECT record_time, content FROM records WHERE record_time BETWEEN ? AND ?',
                            (min(record_times), max(record_times)),
                        )
                    }
                finally:
                    conn.close()

            for idx, record in enumerate(data_records):
                time_str = record_times[idx]
                content_val = record['value']
                record_key = (time_str, content_val)
                if record_key in seen:
                    continue
                seen.add(record_key)
                was_corrected = 0

                for i in range(BOX_COUNT):
                    current_numbers[i] += 1
                    if current_numbers[i] > max_numbers[i]:
                        current_numbers[i] = min_numbers[i]
                        if i == 3:
                            cycle_count += 1

                verification_value = verification_records[idx + 2]['value'] if (
                        enable_verification and idx + 2 < len(verification_records)) else "N/A"

                if enable_verification and verification_value != "N/A":
                    ver_num = self._box_number(verification_value)
                    if (ver_num is None or not 1 <= ver_num <= 8
                            or not min_numbers[3] <= ver_num <= max_numbers[3]):
                        log("第{}行：无效三号轮校验值 {}，保留按配置循环的编号 {}".format(
                            idx + 1, verification_value, current_numbers[3]),
                            "warning", content=content_val, time_str=time_str)
                    elif current_numbers[3] != ver_num:
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
            skipped_count = len(data_records) - new_count - updated_count
            log(
                "写入数据库 {} 条新记录，校正 {} 条已有记录（跳过 {} 条重复）".format(
                    new_count, updated_count, skipped_count
                ),
                "success",
            )

            # 记录本次处理的最新数据时间
            if db_rows:
                self._save_last_numbers_raw(current_numbers, cycle_count)
                latest_time = max(row[11] for row in db_rows)
                previous_sync = self._get_last_sync_time()
                if not previous_sync or latest_time > previous_sync:
                    self._save_last_sync_time(latest_time)

            if write_output and db_rows:
                file_date = self._record_time_text(start)[:10].replace('-', '')
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

    def refresh_for_query(self, date, start_time=None, stop_time=None):
        """查询最新时段前补同步；历史查询不重置编号或重放已入库的数据。"""
        try:
            local_tz = timezone(timedelta(hours=8))
            day = datetime.strptime(date, '%Y-%m-%d').replace(tzinfo=local_tz)
            today, now = self._today_window()
            if day.date() != today.astimezone(local_tz).date():
                raise ValueError('仅支持查询和同步北京时间今天的数据')
            if bool(start_time) != bool(stop_time):
                raise ValueError('请同时填写开始和结束时间')
            if start_time and stop_time:
                start = self._date_time_value(date, start_time)
                end = self._date_time_value(date, stop_time)
                if start > end:
                    raise ValueError('开始时间不能晚于结束时间')
                # 与本地查询一致：结束时间包含输入精度对应的整秒或整分钟。
                end += timedelta(seconds=1) if len(stop_time) == 8 else timedelta(minutes=1)
            else:
                start, end = day, day + timedelta(days=1)
            if start > now:
                raise ValueError('查询时间尚未到达')
            end = min(end, now)

            with self._process_lock:
                summary = self._database_summary()
                if not summary['record_count']:
                    # 复用首次同步策略，防止一次短时段查询截断整个初始化范围。
                    initial = self.ensure_initial_sync()
                    return {
                        'success': initial['success'],
                        'message': '首次同步完成' if initial['success'] else initial.get('error', '首次同步失败'),
                        'logs': self.last_process_logs,
                    }
                last_time = datetime.fromisoformat(summary['last_record_time'])
                if last_time.tzinfo is None:
                    last_time = last_time.replace(tzinfo=local_tz)
                if last_time >= end:
                    return {'success': True, 'message': '已查询本地记录', 'logs': []}

                # 从本地最后一条开始延续编号，涵盖上次同步到查询起点之间的记录。
                return self.process_data(max(last_time, today).isoformat(), end.isoformat(), write_output=False)
        except Exception as exc:
            message = str(exc)
            self.last_process_logs = [{'msg': message, 'level': 'error'}]
            return {'success': False, 'message': message, 'logs': self.last_process_logs}

    def query_by_date(self, date, start_time=None, stop_time=None, sort_order='desc'):
        start, stop = self._today_window()
        if date != self._record_time_text(start)[:10]:
            return []
        if bool(start_time) != bool(stop_time):
            raise ValueError('请同时填写开始和结束时间')
        if start_time:
            start = max(start, self._date_time_value(date, start_time))
            selected_stop = self._date_time_value(date, stop_time)
            selected_stop += timedelta(seconds=1) if len(stop_time) == 8 else timedelta(minutes=1)
            stop = min(stop, selected_stop)
        if start >= stop:
            return []
        lower, upper = self._record_time_text(start), self._record_time_text(stop)
        order = 'DESC' if sort_order == 'desc' else 'ASC'
        conn = self._get_conn()
        c = conn.cursor()
        c.execute(f'SELECT * FROM records WHERE record_time >= ? '
                  f'AND record_time < ? ORDER BY record_time {order}', (lower, upper))
        rows = c.fetchall()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def query_by_number(self, num_input, box_indices=None, sort_order='desc'):
        lower, upper = self._today_text_window()
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
                c.execute(f'SELECT * FROM records WHERE record_time >= ? AND record_time <= ? '
                          f'AND ({conditions}) ORDER BY record_time {order}', [lower, upper] + params)
            else:
                conn.close()
                return []
        else:
            cols = ['transport'] + [f'num{i+1}' for i in range(BOX_COUNT - 1)]
            conditions = ' OR '.join(f'{col} IN ({",".join("?" * len(target_nums))})' for col in cols)
            params = list(target_nums) * len(cols)
            c.execute(f'SELECT * FROM records WHERE record_time >= ? AND record_time <= ? '
                      f'AND ({conditions}) ORDER BY record_time {order}', [lower, upper] + params)

        rows = c.fetchall()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def query_by_number_multi(self, box_queries, sort_order='desc'):
        lower, upper = self._today_text_window()
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
        sql = (f'SELECT * FROM records WHERE record_time >= ? AND record_time <= ? '
               f'AND ({" OR ".join(conditions)}) ORDER BY record_time {order}')
        c.execute(sql, [lower, upper] + params)
        rows = c.fetchall()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def query_by_content(self, content_search, sort_order='desc'):
        lower, upper = self._today_text_window()
        order = 'DESC' if sort_order == 'desc' else 'ASC'
        conn = self._get_conn()
        c = conn.cursor()
        c.execute(f'SELECT * FROM records WHERE record_time >= ? AND record_time <= ? '
                  f'AND content LIKE ? ORDER BY record_time {order}',
                  (lower, upper, f'%{content_search}%'))
        rows = c.fetchall()
        conn.close()
        return [self._row_to_dict(r) for r in rows]

    def query_duplicates(self, date, sort_order='desc'):
        lower, upper = self._today_text_window()
        if date != lower[:10]:
            return []
        order = 'DESC' if sort_order == 'desc' else 'ASC'
        conn = self._get_conn()
        c = conn.cursor()
        c.execute(f'''SELECT * FROM records WHERE record_time >= ? AND record_time <= ? AND content IN
            (SELECT content FROM records WHERE record_time >= ? AND record_time <= ?
             GROUP BY content HAVING COUNT(*)>1)
            ORDER BY record_time {order}''', (lower, upper, lower, upper))
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
        sync_result = None
        if query_type == 'date' and kwargs.get('refresh') is True:
            sync_result = self.refresh_for_query(
                kwargs.get('date', ''), kwargs.get('start_time'), kwargs.get('stop_time')
            )
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
        response = {
            'results': results,
            'query_scope': 'today', 'scope_label': '今天',
            'stats': {'total': total, 'url': url_count, 'fail': fail_count,
                      'other': total - url_count - fail_count}
        }
        if sync_result is not None:
            response['sync'] = sync_result
            response['latest_record_time'] = self._database_summary()['last_record_time']
        return response

    def get_file_list(self):
        # 即使今天还没有落库记录，也保留今日入口供手动刷新。
        return [self._today_text_window()[0][:10]]

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
        """保留历史库和已有编号状态；空库初始化也只读取北京时间今天。"""
        with self._process_lock, self._initial_sync_lock:
            summary = self._database_summary()
            previous_state = self._read_initial_sync_state() or {}
            if summary['record_count'] > 0:
                if summary['last_record_time'] and not self._get_last_sync_time():
                    self._save_last_sync_time(summary['last_record_time'])
                state = self._write_initial_sync_state({
                    **previous_state, 'status': 'completed', 'query_scope': 'today',
                    'source': 'existing_database', 'checked_at': _now_text(),
                    'completed_at': previous_state.get('completed_at', _now_text()),
                    'historical_backfill_enabled': False, 'full_history_verified': False,
                    'requires_manual_action': False, **summary,
                })
                logging.info("本地已有记录，保留历史及编号状态，仅继续同步今天的数据")
                return {'success': True, 'action': 'existing_database', 'state': state}

            start, stop = self._today_window()
            started_at = _now_text()
            base = {
                'source': 'influxdb_today_sync', 'query_scope': 'today',
                'checked_at': started_at, 'started_at': started_at,
                'query_start': self._record_time_text(start),
                'query_stop': self._record_time_text(stop),
                'historical_backfill_enabled': False, 'full_history_verified': False,
                'requires_manual_action': False,
            }
            self._write_initial_sync_state({**base, 'status': 'running', **summary})
            logging.info("首次同步只读取北京时间今天零点至当前时间的数据")
            try:
                # 新库也可能保留着客户设定的编号文件，不能因日期范围改变而重置。
                result = self.process_data(start.isoformat(), stop.isoformat(),
                                           reset_numbers=False, write_output=False)
                summary = self._database_summary()
                if result.get('success') and summary['record_count'] > 0:
                    state = self._write_initial_sync_state({
                        **base, 'status': 'completed', 'completed_at': _now_text(), **summary,
                    })
                    return {'success': True, 'action': 'initialized', 'state': state}
                if result.get('code') in {'no_data', 'outside_today'}:
                    state = self._write_initial_sync_state({
                        **base, 'status': 'waiting', 'message': '今天暂时没有可同步记录，等待下次同步',
                        **summary,
                    })
                    return {'success': True, 'action': 'waiting_today', 'state': state}
                error = result.get('message') or '今天的数据同步失败'
            except Exception as exc:
                error = str(exc)
                summary = self._database_summary()
            state = self._write_initial_sync_state({
                **base, 'status': 'failed', 'failed_at': _now_text(),
                'requires_manual_action': True, 'last_error': error, **summary,
            })
            logging.error("今天的数据初始化失败: %s", error)
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
        """只检查主数据桶今天可读取到的最早记录时间。"""
        from influxdb_client import InfluxDBClient

        client = InfluxDBClient(
            url=self.influx_config['url'],
            token=self.influx_config['token'],
            org=self.influx_config['org'],
        )
        try:
            start, stop = self._today_window()
            bucket = self.influx_config['bucket_data']
            query = f'''from(bucket: "{bucket}")
                |> range(start: {start.isoformat()}, stop: {stop.isoformat()})
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
        """列出主数据桶中各 measurement/field 今天可读取到的最早时间。"""
        try:
            from influxdb_client import InfluxDBClient

            client = InfluxDBClient(
                url=self.influx_config['url'],
                token=self.influx_config['token'],
                org=self.influx_config['org'],
            )
            try:
                start, stop = self._today_window()
                bucket = self.influx_config['bucket_data']
                query = f'''from(bucket: "{bucket}")
                    |> range(start: {start.isoformat()}, stop: {stop.isoformat()})
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
                    'query_scope': 'today',
                }
            finally:
                client.close()
        except Exception as exc:
            return {'success': False, 'error': str(exc)}

    def _load_data_from_influx(self, start_time, stop_time=None):
        return self._load_influx_records('bucket_data', start_time, stop_time)

    def _load_verification_from_influx(self, start_time, stop_time=None):
        return self._load_influx_records('bucket_verify', start_time, stop_time)

    def _load_influx_records(self, bucket_key, start_time, stop_time=None, qrcode=None, limit=None):
        bucket = self.influx_config[bucket_key]
        client = None
        try:
            from influxdb_client import InfluxDBClient
            client = InfluxDBClient(
                url=self.influx_config['url'],
                token=self.influx_config['token'],
                org=self.influx_config['org'],
                timeout=30000,
            )
            stop_clause = f', stop: {stop_time}' if stop_time else ''
            query = f'''from(bucket: "{bucket}")
              |> range(start: {start_time}{stop_clause})
              |> filter(fn: (r) => r["_field"] == "code")'''
            if qrcode is not None:
                # 这里只定位二维码时间，编号仍由随后同一完整窗口的两路原始序列配对。
                # Flux 字符串支持插值，用 UTF-8 字节转义同时保护引号、控制字符和 ${}。
                literal = '"' + ''.join('\\x{:02x}'.format(byte)
                                        for byte in qrcode.lower().encode('utf-8')) + '"'
                query = 'import "strings"\n' + query + f'''
                  |> filter(fn: (r) => strings.containsStr(
                    v: strings.toLower(v: string(v: r["_value"])), substr: {literal}))'''
            if limit is not None:
                query += f'''
                  |> group(columns: [])
                  |> sort(columns: ["_time"], desc: true)
                  |> limit(n: {int(limit)})'''
            else:
                query += '\n  |> sort(columns: ["_time"])'
            tables = client.query_api().query(query, org=self.influx_config['org'])
            records = []
            for table in tables:
                for record in table.records:
                    records.append({
                        'time': record.get_time(),
                        'value': str(record.get_value())
                    })
            records.sort(key=lambda r: r['time'])
            return records
        except Exception as e:
            logging.error("读取 %s 失败: %s", bucket, e)
            message = ('读取二维码数据库失败，请检查数据库连接和访问权限'
                       if bucket_key == 'bucket_data'
                       else '读取校验数据库失败，暂时无法确定轮模盒编号')
            raise RuntimeError(message) from e
        finally:
            if client is not None:
                client.close()

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
            start, stop = self._limit_today_window('-1h')
            for key in ['bucket_data', 'bucket_verify']:
                bucket = self.influx_config[key]
                try:
                    query = (f'from(bucket: "{bucket}") '
                             f'|> range(start: {start.isoformat()}, stop: {stop.isoformat()}) |> limit(n: 1)')
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
            start, stop = self._limit_today_window('-{}h'.format(max(1, int(hours))))
            from influxdb_client import InfluxDBClient
            bucket = self.influx_config[bucket_key]
            client = InfluxDBClient(
                url=self.influx_config['url'],
                token=self.influx_config['token'],
                org=self.influx_config['org']
            )
            query_api = client.query_api()
            query = (f'from(bucket: "{bucket}") '
                     f'|> range(start: {start.isoformat()}, stop: {stop.isoformat()}) |> limit(n: {int(limit)})')
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

    @staticmethod
    def _box_number(value):
        if value is None or isinstance(value, bool):
            return None
        try:
            number = float(value)
            return int(number) if number.is_integer() else None
        except (TypeError, ValueError, OverflowError):
            return None

    def get_box_layout(self):
        """使用现有编号配置定位各轮，七号轮不参与轨迹展示。"""
        self._reload_config()
        mins = self.config.get('编号下限列表', [])
        maxs = self.config.get('编号上限列表', [])
        names = {0: '输送盒模', 1: '一号轮', 2: '二号轮', 3: '三号轮', 4: '四号轮',
                 5: '五号轮', 6: '六号轮', 8: '八号轮'}
        wheels = []
        for wheel_id, name in names.items():
            minimum = self._box_number(mins[wheel_id]) if len(mins) > wheel_id else None
            maximum = self._box_number(maxs[wheel_id]) if len(maxs) > wheel_id else None
            valid = minimum is not None and maximum is not None and minimum <= maximum
            wheels.append({
                'id': wheel_id, 'name': name,
                'min': minimum if valid else None,
                'max': maximum if valid else None,
            })
        return {'wheels': wheels}

    @staticmethod
    def _box_pending_times(pending_times):
        if pending_times is None:
            return []
        if not isinstance(pending_times, list) or len(pending_times) > 3:
            raise ValueError('待确认时间最多为3条')
        parsed = []
        for value in pending_times:
            if not isinstance(value, str) or len(value) > 64:
                raise ValueError('待确认时间格式不正确')
            date = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone(timedelta(hours=8)))
            parsed.append(date.astimezone(timezone.utc))
        return sorted(set(parsed))

    def query_box_by_qrcode(self, qrcode, lookback_hours=24, refresh=False, pending_times=None):
        if not isinstance(qrcode, str) or not qrcode.strip():
            return {'success': False, 'error': '请输入二维码'}
        qrcode = qrcode.strip()
        if type(lookback_hours) is not int or lookback_hours not in (2, 24, 168):
            return {'success': False, 'error': '请选择有效的远程查询时间范围'}
        if type(refresh) is not bool:
            return {'success': False, 'error': '刷新参数格式不正确'}
        try:
            pending = self._box_pending_times(pending_times)
        except (ValueError, OverflowError):
            return {'success': False, 'error': '待确认时间格式不正确，最多提供3条'}
        return self._query_box_records(qrcode=qrcode, lookback_hours=lookback_hours,
                                       refresh=refresh, pending_times=pending)

    def query_recent_boxes(self, lookback_minutes):
        if type(lookback_minutes) is not int or lookback_minutes not in (5, 30):
            return {'success': False, 'error': '请选择最近5分钟或最近30分钟'}
        return self._query_box_records(lookback_minutes=lookback_minutes)

    @staticmethod
    def _remote_wheel_numbers(wheels, box_num):
        numbers = {str(wheel['id']): None for wheel in wheels}
        inferred = []
        if box_num is None:
            return numbers, inferred
        numbers['3'] = box_num
        reference = next((wheel for wheel in wheels if wheel['id'] == 3), None)
        if not reference or reference['min'] != 1 or reference['max'] != 8:
            return numbers, inferred
        for wheel in wheels:
            if wheel['id'] == 3:
                continue
            maximum = wheel['max']
            # 与同步时的 (cycle_count * 8 + ver_num) % max 校验规则一致。
            # 只有下限为 1 且上限整除 8 时，未知的 cycle_count 才不影响结果。
            # 40、42 或 6 等范围必须保留未知，不能从短查询窗口猜测起始相位。
            if wheel['min'] == 1 and maximum and 8 % maximum == 0:
                numbers[str(wheel['id'])] = (box_num - 1) % maximum + 1
                inferred.append(wheel['id'])
        return numbers, inferred

    def _resolve_remote_box_numbers(self, records, verification_records, wheels):
        """用两端直接校验核对短缺口，不从查询窗口起点重排编号。"""
        numbers = []
        for idx in range(len(records)):
            value = (self._box_number(verification_records[idx + 2]['value'])
                     if idx + 2 < len(verification_records) else None)
            numbers.append(value if value is not None and 1 <= value <= 8 else None)
        inferred = set()
        reference = next((wheel for wheel in wheels if wheel['id'] == 3), None)
        if not reference or reference['min'] != 1 or reference['max'] != 8:
            return numbers, inferred

        # 锚点必须来自直接校验，不能把推算结果继续当作锚点向外扩展。
        anchors = [idx for idx, value in enumerate(numbers) if value is not None]
        for left, right in zip(anchors, anchors[1:]):
            gap = right - left - 1
            # 两端跨越整圈、缺少任一端校验，或两端步进不一致时无法核实中间相位。
            if not 1 <= gap <= 6 or (numbers[left] + right - left - 1) % 8 + 1 != numbers[right]:
                continue
            try:
                if not all(records[idx]['time'] < records[idx + 1]['time']
                           for idx in range(left, right)):
                    continue
            except (KeyError, TypeError):
                continue
            for idx in range(left + 1, right):
                numbers[idx] = (numbers[left] + idx - left - 1) % 8 + 1
                inferred.add(idx)
        return numbers, inferred

    def _local_box_record(self, row, wheels):
        numbers = {str(wheel['id']): self._box_number(row['transport' if wheel['id'] == 0 else f"num{wheel['id']}"])
                   for wheel in wheels}
        original = {}
        reference = next((wheel for wheel in wheels if wheel['id'] == 3), None)
        if reference and reference['min'] == 1 and reference['max'] == 8:
            for wheel in wheels:
                key, maximum = str(wheel['id']), wheel['max']
                value = numbers[key]
                # 兼容默认上限 1000 时生成的旧数据，仅换算已知的 1/2/4/8 周期。
                # 不改库，不改有效编号；保留原值，让页面明确区分历史换算结果。
                if (wheel['min'] == 1 and maximum and 8 % maximum == 0
                        and value is not None and value > maximum):
                    original[key] = value
                    numbers[key] = (value - 1) % maximum + 1
        for wheel in wheels:
            key = str(wheel['id'])
            value = numbers[key]
            if (value is not None and (wheel['min'] is None or wheel['max'] is None
                                      or not wheel['min'] <= value <= wheel['max'])):
                numbers[key] = None
        result = {
            'index': row['id'], 'numbers': [numbers['3']], 'box_num': numbers['3'],
            'wheel_numbers': numbers, 'content': row['content'], 'time': row['record_time'],
            'verification_value': row['verification'],
        }
        if original:
            result.update(normalized_wheels=[int(key) for key in original],
                          original_wheel_numbers=original)
        return result

    def _load_box_window(self, start, stop):
        """两路并行读取同一个固定窗口，配对前保留完整原始序列。"""
        with ThreadPoolExecutor(max_workers=2) as pool:
            raw = pool.submit(self._load_data_from_influx, start.isoformat(), stop.isoformat())
            verification = pool.submit(self._load_verification_from_influx,
                                       start.isoformat(), stop.isoformat())
            records = raw.result()
            try:
                return records, verification.result(), None
            except RuntimeError as exc:
                return records, [], str(exc)

    @staticmethod
    def _box_context_windows(times, start, stop, include_live=None):
        windows = [(max(start, date - timedelta(minutes=2)), min(stop, date + timedelta(minutes=2)))
                   for date in times if start <= date <= stop]
        if include_live is not None:
            windows.append((max(start, include_live), stop))
        merged = []
        for left, right in sorted(windows):
            if left >= right:
                continue
            if merged and left <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(right, merged[-1][1]))
            else:
                merged.append((left, right))
        return merged

    def _load_box_windows(self, windows):
        # 刷新最多三个旧窗口与一个实时窗口，彼此独立，避免逐个等待。
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(self._load_box_window, left, right) for left, right in windows]
            for future in futures:
                yield future.result()

    @staticmethod
    def _box_record_key(record):
        return record['time'], str(record['content'])

    def _box_transport_numbers(self, records, box_numbers, adjacent_inferred, wheels):
        """输送相位只来自同一条已落库记录；三号轮本身无法确定 40 格相位。"""
        numbers, inferred = {}, set()
        transport = next((wheel for wheel in wheels if wheel['id'] == 0), None)
        reference = next((wheel for wheel in wheels if wheel['id'] == 3), None)
        if (not records or not transport or transport['min'] != 1 or transport['max'] != 40
                or not reference or reference['min'] != 1 or reference['max'] != 8):
            return numbers, inferred
        conn = self._get_conn()
        try:
            rows = conn.execute(
                'SELECT * FROM records WHERE record_time >= ? AND record_time <= ?',
                (self._record_time_text(records[0]['time']),
                 self._record_time_text(records[-1]['time'])),
            ).fetchall()
        finally:
            conn.close()
        local = {(row['record_time'], str(row['content'])): row for row in rows}
        # 时间不递增或直接校验的步进变化时分段，禁止跨断点传递输送相位。
        segments, segment, phase = [], [], None
        for idx, record in enumerate(records):
            number = box_numbers[idx]
            current_phase = ((number - 1 - idx) % 8
                             if number is not None and idx not in adjacent_inferred else None)
            if segment and (record['time'] <= records[idx - 1]['time']
                            or (phase is not None and current_phase is not None and phase != current_phase)):
                segments.append(segment)
                segment, phase = [], None
            segment.append(idx)
            if current_phase is not None:
                phase = current_phase
        if segment:
            segments.append(segment)
        for segment in segments:
            anchors = {}
            for idx in segment:
                record = records[idx]
                row = local.get((self._record_time_text(record['time']), str(record['value'])))
                if row is None or idx in adjacent_inferred or box_numbers[idx] is None:
                    continue
                value = self._box_number(row['transport'])
                if (value is not None and 1 <= value <= 40
                        and self._box_number(row['num3']) == box_numbers[idx]
                        and self._box_number(row['verification']) == box_numbers[idx]):
                    anchors[idx] = value
            phases = {(value - 1 - idx) % 40 for idx, value in anchors.items()}
            # 多个已知输送位置必须一致；冲突时保留数据库值，不外推。
            if len(anchors) < 2 or len(phases) != 1:
                continue
            left, right = min(anchors), max(anchors)
            intervals = [(records[idx + 1]['time'] - records[idx]['time']).total_seconds()
                         for idx in range(left, right)]
            # 两侧相位一致仍不足以排除中途整圈漏采；样本少或明显停顿时不补号。
            if len(intervals) < 3:
                continue
            typical = sorted(intervals)[(len(intervals) - 1) // 2]
            if typical <= 0 or any(gap > min(2.0, typical * 3) for gap in intervals):
                continue
            transport_phase = phases.pop()
            for idx in range(left, right + 1):
                if box_numbers[idx] is not None:
                    numbers[idx] = (transport_phase + idx) % 40 + 1
                    if idx not in anchors:
                        inferred.add(idx)
        return numbers, inferred

    def _format_remote_boxes(self, records, verification, wheels, qrcode=None):
        box_numbers, adjacent = self._resolve_remote_box_numbers(records, verification, wheels)
        transport, transport_inferred = self._box_transport_numbers(records, box_numbers, adjacent, wheels)
        matched = []
        for idx, record in enumerate(records):
            if qrcode is not None and qrcode.casefold() not in str(record['value']).casefold():
                continue
            box_num = box_numbers[idx]
            value = verification[idx + 2]['value'] if idx + 2 < len(verification) else None
            numbers, inferred = self._remote_wheel_numbers(wheels, box_num)
            source = 'verification' if box_num is not None else 'unavailable'
            if idx in adjacent:
                source = 'adjacent_verification'
                inferred = [wheel['id'] for wheel in wheels if numbers[str(wheel['id'])] is not None]
            if idx in transport:
                numbers['0'] = transport[idx]
                if idx in transport_inferred:
                    inferred.append(0)
            matched.append({
                'index': idx, 'numbers': [box_num], 'box_num': box_num,
                'wheel_numbers': numbers, 'inferred_wheels': inferred,
                'box_number_source': source,
                'verification_value': str(value) if value is not None else None,
                'verification_issue': (None if self._box_number(value) in range(1, 9)
                                       else 'invalid_value' if idx + 2 < len(verification) else 'missing_record'),
                'content': record['value'], 'time': self._record_time_text(record['time']),
            })
        return matched

    def _merge_box_record(self, local, remote):
        """查询只补全展示，不写回同步计数器或覆盖已知输送相位。"""
        merged = dict(local)
        numbers = dict(local['wheel_numbers'])
        inferred = set(local.get('inferred_wheels', []))
        repair = (self._box_number(local.get('verification_value')) not in range(1, 9)
                  and remote.get('box_number_source') == 'verification')
        for key, value in remote['wheel_numbers'].items():
            if value is not None and (numbers.get(key) is None or (repair and key != '0')):
                numbers[key] = value
                if int(key) in remote.get('inferred_wheels', []):
                    inferred.add(int(key))
        merged.update(wheel_numbers=numbers, box_num=numbers['3'], numbers=[numbers['3']],
                      inferred_wheels=sorted(inferred))
        if repair or local.get('box_num') is None:
            for key in ('verification_value', 'verification_issue', 'box_number_source'):
                merged[key] = remote.get(key)
        return merged

    def _box_record_complete(self, record, wheels):
        for wheel in wheels:
            value = self._box_number(record['wheel_numbers'].get(str(wheel['id'])))
            if (value is None or wheel['min'] is None or wheel['max'] is None
                    or not wheel['min'] <= value <= wheel['max']):
                return False
        return self._box_number(record.get('verification_value')) in range(1, 9)

    def _query_box_records(self, qrcode=None, lookback_hours=24, lookback_minutes=None,
                           refresh=False, pending_times=None):
        began = time.monotonic()
        wheels = self.get_box_layout()['wheels']
        recent = lookback_minutes is not None
        day_start, stop = self._today_window()
        start = max(day_start, stop - (timedelta(minutes=lookback_minutes) if recent
                                      else timedelta(hours=lookback_hours)))
        live_start = max(start, stop - timedelta(minutes=lookback_minutes if recent else 5))
        local_start, local_stop = self._record_time_text(start), self._record_time_text(stop)
        limit = 500 if recent else 50
        observed = {'remote_checked': False, 'latest_qr_event_time': None,
                    'latest_verification_event_time': None}

        def observe(raw, verification):
            for name, records in (('latest_qr_event_time', raw),
                                  ('latest_verification_event_time', verification)):
                if records:
                    latest = max(self._record_time_text(record['time']) for record in records)
                    observed[name] = max(observed[name] or latest, latest)

        def finish(result):
            result.update(query_scope='today', scope_label='今天',
                          query_start=local_start, query_stop=local_stop)
            matches = result.get('matches', [])
            if not result['success']:
                state = 'query_error'
            elif not matches:
                state = 'no_recent_records' if recent else 'qrcode_not_found'
            elif any(record['box_num'] is None
                     or self._box_number(record.get('verification_value')) not in range(1, 9)
                     for record in matches):
                state = 'verification_pending'
            elif any(record['wheel_numbers'].get('0') is None for record in matches):
                state = 'transport_pending'
            elif any(not self._box_record_complete(record, wheels) for record in matches):
                state = 'wheel_numbers_pending'
            else:
                state = 'complete'
            # 源 _time 是事件时间，不是入库到达时间。保留实际查询窗口以便核对校时问题。
            diagnostics = {
                **observed, 'state': state,
                'query_started_at': self._record_time_text(stop),
                'query_finished_at': self._record_time_text(datetime.now(timezone.utc)),
                'query_duration_ms': round((time.monotonic() - began) * 1000),
                'live_window_start': self._record_time_text(live_start),
                'live_window_stop': self._record_time_text(stop),
                'query_scope': 'today', 'query_start': local_start,
                'latest_match_event_time': max((record['time'] for record in matches), default=None),
            }
            result['diagnostics'] = diagnostics
            # 日志不写二维码原文；同码的短摘要便于关联“未找到→记录到达→校验到齐”。
            code_key = hashlib.sha256(qrcode.encode('utf-8')).hexdigest()[:12] if qrcode else 'recent'
            logging.info('盒模查询 code_key=%s source=%s diagnostics=%s', code_key,
                         result.get('source', 'unavailable'), json.dumps(diagnostics, ensure_ascii=False))
            return result

        conn = self._get_conn()
        try:
            if recent:
                # 保留范围内的键用于合并去重和准确总数，最后统一取最新 500 条。
                rows = conn.execute('SELECT * FROM records WHERE record_time >= ? AND record_time <= ?',
                                    (self._record_time_text(start), self._record_time_text(stop))).fetchall()
            else:
                # 扫码原始记录可能保留 CR/LF，页面输入会 strip()；同时查常见行尾格式。
                # 仍走 content 索引，不能为了兼容行尾重新扫描全部历史记录。
                variants = tuple(qrcode + ending for ending in ('', '\r\n', '\n', '\r'))
                conditions = ' OR '.join('content = ? COLLATE NOCASE' for _ in variants)
                rows = conn.execute('SELECT * FROM records WHERE record_time >= ? AND record_time <= ? '
                                    'AND (' + conditions + ') ORDER BY record_time DESC, id DESC LIMIT ?',
                                    (local_start, local_stop) + variants + (limit,)).fetchall()
                if not rows and not qrcode.lower().startswith(('http://', 'https://')):
                    escaped = qrcode.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
                    rows = conn.execute("SELECT * FROM records WHERE record_time >= ? AND record_time <= ? "
                                        "AND content LIKE ? ESCAPE '\\' "
                                        'ORDER BY record_time DESC, id DESC LIMIT ?',
                                        (local_start, local_stop, f'%{escaped}%', limit)).fetchall()
        finally:
            conn.close()
        local_matches = [self._local_box_record(row, wheels) for row in rows]
        merged = {self._box_record_key(record): record for record in local_matches}
        remote_matches, warnings, raw_count = [], [], 0
        live_only = True
        # 本地单码已完整时直接返回；范围查询仍读最新远程数据，避免被旧本地数据挡住。
        complete_local = local_matches and all(self._box_record_complete(record, wheels) for record in local_matches)
        if recent or not complete_local:
            observed['remote_checked'] = True
            try:
                times = pending_times if refresh else []
                windows = self._box_context_windows(times or [], start, stop, include_live=live_start)
                live_only = len(windows) == 1 and windows[0][0] == live_start
                for raw, verification, warning in self._load_box_windows(windows):
                    observe(raw, verification)
                    raw_count += len(raw)
                    remote_matches.extend(self._format_remote_boxes(raw, verification, wheels, qrcode))
                    if warning:
                        warnings.append(warning)
                if not recent and not remote_matches and not refresh and start < live_start:
                    # 先在服务器筛出匹配时间，再读取周围完整序列，避免传回整天的所有码。
                    located = self._load_influx_records('bucket_data', start.isoformat(), live_start.isoformat(),
                                                       qrcode=qrcode, limit=limit)
                    windows = self._box_context_windows([record['time'] for record in located], start, stop)
                    for raw, verification, warning in self._load_box_windows(windows):
                        observe(raw, verification)
                        raw_count += len(raw)
                        remote_matches.extend(self._format_remote_boxes(raw, verification, wheels, qrcode))
                        if warning:
                            warnings.append(warning)
                    live_only = False
            except RuntimeError as exc:
                if not local_matches and not remote_matches:
                    return finish({'success': False, 'error': str(exc), 'refresh_pending': not recent,
                                   'retry_after_ms': 3000})
                warnings.append(str(exc))
        for record in remote_matches:
            key = self._box_record_key(record)
            merged[key] = self._merge_box_record(merged[key], record) if key in merged else record
        matched = sorted(merged.values(), key=lambda item: item['time'], reverse=True)[:limit]
        source = 'mixed' if local_matches and remote_matches else 'database' if local_matches else 'influxdb'
        pending = not matched or any(not self._box_record_complete(record, wheels) for record in matched)
        result = {'success': True, 'total_records': len(merged) if recent else max(len(merged), raw_count),
                  'matches': matched, 'source': source, 'wheels': wheels,
                  'refresh_pending': bool(pending and not recent), 'retry_after_ms': 3000}
        if not warnings and any(record['box_num'] is None for record in matched):
            warnings.append('部分记录的校验数据尚未齐全，编号暂待确认。')
        if warnings:
            result['warning'] = '；'.join(dict.fromkeys(warnings))
        if recent:
            result.update(lookback_minutes=lookback_minutes, has_more=len(merged) > len(matched))
        else:
            result['lookback_hours'] = lookback_hours
            if live_only and source != 'database':
                result['recent_window_minutes'] = 5
        return finish(result)

    def start_auto_sync(self):
        def _sync_loop():
            initial_result = None
            while True:
                initial_result = self.ensure_initial_sync()
                if initial_result.get('success') and initial_result.get('action') != 'waiting_today':
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
                            logging.info("首次今日同步刚完成，%d 秒后开始增量同步", interval)
                        else:
                            logging.info("自动同步：开始处理...")
                            last_sync = self._get_last_sync_time()
                            # 上次同步可能在昨天或更早；每天从今日零点开始限制增量窗口。
                            start, stop = self._limit_today_window(last_sync)
                            result = self.process_data(start.isoformat(), stop.isoformat())
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
