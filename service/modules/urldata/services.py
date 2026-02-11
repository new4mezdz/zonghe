import os
import json
import glob
import logging
from datetime import datetime
from collections import Counter
from config import Config
from datetime import datetime, timezone, timedelta
BOX_COUNT = 8

class UrlDataService:
    """URL数据管理服务 - 完整版"""

    def __init__(self):
        self.config = Config.load_json_config()
        self.influx_config = {
            'url': 'http://10.164.62.253:8086/',
            'token': 'u31cmj6sXb8CjYO1r0TcBbSNToKHXVsqbgMn-KBq7zvnmAEemTtYlN8ZwX7wXydgRr6VkdjuwwbiD0YgS6lq0A==',
            'org': 'myorg',
            'bucket_data': 'jbcj01',
            'bucket_verify': 'jbcj03'
        }

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

        def log(msg, level='info'):
            logs.append({'msg': msg, 'level': level})

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
            log("配置的下限: {}".format(min_numbers))
            log("配置的上限: {}".format(max_numbers))

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

            for idx, record in enumerate(data_records):
                for i in range(BOX_COUNT):
                    current_numbers[i] += 1
                    if current_numbers[i] > max_numbers[i]:
                        current_numbers[i] = min_numbers[i]
                        if i == 2:
                            cycle_count += 1

                # 转换为北京时间显示
                if hasattr(record['time'], 'astimezone'):
                    local_time = record['time'].astimezone(timezone(timedelta(hours=8)))
                    time_str = local_time.strftime('%Y-%m-%d %H:%M:%S')
                else:
                    time_str = str(record['time'])

                # 取校验值
                verification_value = verification_records[idx]['value'] if (
                        enable_verification and idx < len(verification_records)) else "N/A"

                # 校验逻辑：校验位与三号轮摸盒对比
                if enable_verification and verification_value != "N/A":
                    try:
                        ver_num = int(float(str(verification_value).strip()))
                        if current_numbers[2] != ver_num:
                            error_msg = "第{}行：三号轮摸盒({})与校验位({})不匹配，按校验位纠正，当前第{}轮循环".format(
                                idx + 1, current_numbers[2], ver_num, cycle_count)
                            verification_errors.append(error_msg)
                            log(error_msg, "warning")
                            current_numbers[2] = ver_num
                            for i in range(BOX_COUNT):
                                if i != 2:
                                    corrected = (cycle_count * 8 + ver_num) % max_numbers[i]
                                    if corrected == 0:
                                        corrected = max_numbers[i]
                                    current_numbers[i] = corrected
                            intervention_count += 1
                    except ValueError:
                        pass

                numbered_data.append("{}. {} | 校验位: {} | 时间: {}".format(
                    ','.join(map(str, current_numbers)), record['value'], verification_value, time_str
                ))

            if verification_errors and enable_verification:
                log("累计触发 {} 次校验纠正".format(intervention_count), "warning")

            self._save_last_numbers_raw(current_numbers, cycle_count)
            log("保存当前最后编号: {}，循环轮数: {}".format(current_numbers, cycle_count))

            try:
                file_date = start_time[:10].replace('-', '')
            except:
                file_date = datetime.now().strftime('%Y%m%d')
            output_file = os.path.join(output_dir, "{}{}.txt".format(
                config.get('输出文件前缀', '排序数据_'),
                file_date
            ))

            cnt = Counter([r['value'] for r in data_records])
            dups = [(c, n) for c, n in cnt.items() if n > 1]
            if dups:
                log("查重提示：发现 {} 个重复内容项".format(len(dups)), "warning")

            with open(output_file, 'w', encoding=config.get('文件编码', 'utf-8')) as f:
                f.write('\n'.join(numbered_data))

            msg = "处理了 {} 条数据".format(len(data_records))
            log("处理完成！" + msg, "success")
            log("输出文件: {}".format(output_file), "success")
            return {'success': True, 'message': msg, 'logs': logs}

        except Exception as e:
            log("处理出错: {}".format(e), "error")
            return {'success': False, 'message': str(e), 'logs': logs}

    def _load_verification_data(self):
        verification_file = self.config.get('校验文件', '校验文件.txt')
        if not os.path.exists(verification_file):
            return []
        try:
            with open(verification_file, 'r', encoding=self.config.get('文件编码', 'utf-8')) as f:
                return [line.strip() for line in f.readlines() if line.strip()]
        except:
            return []

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
                return (nums if isinstance(nums, list) and len(nums) == BOX_COUNT else default), cycle
            elif isinstance(data, list) and len(data) == BOX_COUNT:
                return data, 0
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

    # ========== 查询功能 ==========

    def _parse_data_line(self, line):
        line = line.strip()
        if not line:
            return None, None, "空行"
        dot_pos = line.find('. ')
        if dot_pos == -1:
            return None, None, "格式错误"
        numbers_part, content_part = line[:dot_pos], line[dot_pos + 2:]
        try:
            number_strings = numbers_part.split(',')
            if len(number_strings) != BOX_COUNT:
                return None, None, "编号数量错误"
            return [int(n.strip()) for n in number_strings], content_part, "成功"
        except ValueError:
            return None, None, "编号解析失败"

    def _load_data_file(self, filepath, date_str):
        data = []
        try:
            with open(filepath, 'r', encoding=self.config.get('文件编码', 'utf-8')) as f:
                lines = f.readlines()

            merged_lines = []
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                if line.startswith('| ') and merged_lines:
                    merged_lines[-1] += ' ' + line
                else:
                    merged_lines.append(line)

            for line in merged_lines:
                verification_value = 'N/A'
                time_value = date_str

                if '| 时间:' in line:
                    line, time_part = line.rsplit('| 时间:', 1)
                    time_value = time_part.strip()

                if '| 校验位:' in line:
                    main_part, vp = line.split('| 校验位:', 1)
                    verification_value = vp.strip()
                else:
                    main_part = line

                nums, content, res = self._parse_data_line(main_part)
                if nums and content:
                    dtype = "失败" if content.upper() == "FAIL" else \
                        "URL" if content.upper().startswith(("HTTP:", "HTTPS:")) else "其他"
                    data.append({
                        'numbers': nums, 'content': content,
                        'verification': verification_value,
                        'type': dtype, 'date': time_value
                    })
        except Exception as e:
            print(f"读取文件失败: {e}")
        return data

    def get_file_list(self):
        self._reload_config()
        output_dir = self.config.get('输出目录', '输出文件')
        prefix = self.config.get('输出文件前缀', '排序数据_')
        files = []
        if os.path.exists(output_dir):
            for filepath in glob.glob(os.path.join(output_dir, f"{prefix}*.txt")):
                filename = os.path.basename(filepath)
                date_str = filename.replace(prefix, '').replace('.txt', '')
                if len(date_str) == 8:
                    files.append(f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:]}")
        files.sort(reverse=True)
        return files

    def query_by_date(self, date):
        self._reload_config()
        output_dir = self.config.get('输出目录', '输出文件')
        prefix = self.config.get('输出文件前缀', '排序数据_')
        date_str = date.replace('-', '')
        filepath = os.path.join(output_dir, f"{prefix}{date_str}.txt")
        return self._load_data_file(filepath, date_str) if os.path.exists(filepath) else []

    def query_by_number(self, num_input, box_index=None):
        self._reload_config()
        output_dir = self.config.get('输出目录', '输出文件')
        prefix = self.config.get('输出文件前缀', '排序数据_')
        target_nums = set()
        for part in num_input.split(','):
            part = part.strip()
            if '-' in part:
                s, e = map(int, part.split('-'))
                target_nums.update(range(min(s, e), max(s, e) + 1))
            else:
                target_nums.add(int(part))
        results = []
        for filepath in glob.glob(os.path.join(output_dir, f"{prefix}*.txt")):
            date_str = os.path.basename(filepath).replace(prefix, '').replace('.txt', '')
            for item in self._load_data_file(filepath, date_str):
                if box_index is not None and 0 <= box_index < BOX_COUNT:
                    if item['numbers'][box_index] in target_nums:
                        results.append(item)
                else:
                    if any(n in target_nums for n in item['numbers']):
                        results.append(item)
        return results

    def query_by_content(self, content_search):
        self._reload_config()
        output_dir = self.config.get('输出目录', '输出文件')
        prefix = self.config.get('输出文件前缀', '排序数据_')
        results = []
        for filepath in glob.glob(os.path.join(output_dir, f"{prefix}*.txt")):
            date_str = os.path.basename(filepath).replace(prefix, '').replace('.txt', '')
            for item in self._load_data_file(filepath, date_str):
                if content_search in item['content']:
                    results.append(item)
        return results

    def query_duplicates(self, date):
        self._reload_config()
        output_dir = self.config.get('输出目录', '输出文件')
        prefix = self.config.get('输出文件前缀', '排序数据_')
        date_str = date.replace('-', '')
        filepath = os.path.join(output_dir, f"{prefix}{date_str}.txt")
        if not os.path.exists(filepath):
            return []
        file_data = self._load_data_file(filepath, date_str)
        cnt = Counter(item['content'] for item in file_data)
        dup_keys = {c for c, n in cnt.items() if n > 1}
        return [item for item in file_data if item['content'] in dup_keys]

    def query(self, query_type, **kwargs):
        if query_type == 'date':
            results = self.query_by_date(kwargs.get('date', ''))
        elif query_type == 'number':
            results = self.query_by_number(kwargs.get('number', ''), kwargs.get('box_index'))
        elif query_type == 'content':
            results = self.query_by_content(kwargs.get('content', ''))
        elif query_type == 'duplicates':
            results = self.query_duplicates(kwargs.get('date', ''))
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
                'status': "⏰ 定时处理已启用 | 间隔: {}小时 {}分钟".format(tc.get('间隔小时', 1), tc.get('间隔分钟', 30))}
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
                    bucket_status[bucket] = {
                        'connected': True,
                        'has_recent_data': has_data
                    }
                except Exception as e:
                    bucket_status[bucket] = {
                        'connected': False,
                        'error': str(e)
                    }
            client.close()
            return {
                'success': True,
                'status': health.status,
                'message': health.message,
                'buckets': bucket_status,
                'config': {
                    'url': self.influx_config['url'],
                    'org': self.influx_config['org'],
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

# 创建全局服务实例
urldata_service = UrlDataService()