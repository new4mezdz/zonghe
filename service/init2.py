"""
一次性脚本：从 InfluxDB 最早数据开始，全部导入 SQLite
用法：python init2.py
"""
import os
import json
import sqlite3
import logging
from datetime import datetime, timezone, timedelta
from collections import Counter

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')

# ========== 配置 ==========
DB_FILE = 'urldata.db'
CONFIG_FILE = 'config.json'
BOX_COUNT = 9

INFLUX_CONFIG = {
    'url': 'http://10.164.62.253:8086/',
    'token': 'u31cmj6sXb8CjYO1r0TcBbSNToKHXVsqbgMn-KBq7zvnmAEemTtYlN8ZwX7wXydgRr6VkdjuwwbiD0YgS6lq0A==',
    'org': 'myorg',
    'bucket_data': 'jbcj01',
    'bucket_verify': 'jbcj03'
}


def load_config():
    with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('PRAGMA journal_mode=WAL')
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
    conn.commit()
    return conn


def get_earliest_time():
    """查询 InfluxDB 中最早一条数据的时间"""
    from influxdb_client import InfluxDBClient
    client = InfluxDBClient(
        url=INFLUX_CONFIG['url'],
        token=INFLUX_CONFIG['token'],
        org=INFLUX_CONFIG['org']
    )
    query = f'''from(bucket: "{INFLUX_CONFIG['bucket_data']}")
      |> range(start: 0)
      |> filter(fn: (r) => r["_field"] == "code")
      |> sort(columns: ["_time"])
      |> limit(n: 1)'''
    tables = client.query_api().query(query, org=INFLUX_CONFIG['org'])
    earliest = None
    for table in tables:
        for record in table.records:
            earliest = record.get_time()
    client.close()
    return earliest


def load_influx_data(start_time_str, stop_time_str=None):
    from influxdb_client import InfluxDBClient
    client = InfluxDBClient(
        url=INFLUX_CONFIG['url'],
        token=INFLUX_CONFIG['token'],
        org=INFLUX_CONFIG['org']
    )
    stop_clause = f', stop: {stop_time_str}' if stop_time_str else ''

    # 数据源
    query_data = f'''from(bucket: "{INFLUX_CONFIG['bucket_data']}")
      |> range(start: {start_time_str}{stop_clause})
      |> filter(fn: (r) => r["_field"] == "code")
      |> sort(columns: ["_time"])'''
    tables = client.query_api().query(query_data, org=INFLUX_CONFIG['org'])
    data_records = []
    for table in tables:
        for record in table.records:
            data_records.append({
                'time': record.get_time(),
                'value': str(record.get_value())
            })
    data_records.sort(key=lambda r: r['time'])

    # 校验源
    query_verify = f'''from(bucket: "{INFLUX_CONFIG['bucket_verify']}")
      |> range(start: {start_time_str}{stop_clause})
      |> filter(fn: (r) => r["_field"] == "code")
      |> sort(columns: ["_time"])'''
    tables = client.query_api().query(query_verify, org=INFLUX_CONFIG['org'])
    verify_records = []
    for table in tables:
        for record in table.records:
            verify_records.append({
                'time': record.get_time(),
                'value': str(record.get_value())
            })
    verify_records.sort(key=lambda r: r['time'])

    client.close()
    return data_records, verify_records


def main():
    logging.info("=" * 50)
    logging.info("开始初始化数据库")

    # 加载配置
    config = load_config()
    min_numbers = config.get('编号下限列表', [1] * BOX_COUNT)
    max_numbers = config.get('编号上限列表', [1000] * BOX_COUNT)
    enable_verification = config.get('错误处理', {}).get('启用校验', True)

    # 初始化数据库
    conn = init_db()
    c = conn.cursor()

    # 查最早时间
    logging.info("正在查询 InfluxDB 最早数据时间...")
    earliest = get_earliest_time()
    if not earliest:
        logging.error("InfluxDB 中无数据，退出")
        return
    logging.info("最早数据时间: %s", earliest)

    # 用 ISO 格式作为起始时间
    start_str = earliest.strftime('%Y-%m-%dT%H:%M:%SZ')
    logging.info("从 %s 开始拉取全部数据...", start_str)

    data_records, verify_records = load_influx_data(start_str)
    logging.info("数据源 jbcj01: %d 条", len(data_records))
    logging.info("校验源 jbcj03: %d 条", len(verify_records))

    if not data_records:
        logging.error("无数据，退出")
        return

    # 读取编号起点
    number_file = config.get('序号记录文件', 'last_numbers.json')
    current_numbers = [m - 1 for m in min_numbers]
    cycle_count = 0

    # 如果有 last_numbers.json 先备份再重置（因为要从头处理）
    if os.path.exists(number_file):
        backup = number_file + '.bak'
        os.rename(number_file, backup)
        logging.info("已备份 %s -> %s", number_file, backup)

    logging.info("编号从下限-1开始: %s", current_numbers)
    logging.info("开始处理...")

    intervention_count = 0
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

        verification_value = verify_records[idx + 2]['value'] if (
                enable_verification and idx + 2 < len(verify_records)) else "N/A"

        if enable_verification and verification_value != "N/A":
            try:
                ver_num = int(float(str(verification_value).strip()))
                if current_numbers[3] != ver_num:
                    logging.info("第%d行：三号轮(%d)与校验位(%d)不匹配，纠正", idx + 1, current_numbers[3], ver_num)
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

        content_val = record['value']
        dtype = "失败" if content_val.upper() == "FAIL" else \
            "URL" if content_val.upper().startswith(("HTTP:", "HTTPS:")) else "其他"
        date_only = time_str[:10]

        db_rows.append((
            current_numbers[0],
            current_numbers[1], current_numbers[2], current_numbers[3], current_numbers[4],
            current_numbers[5], current_numbers[6], current_numbers[7], current_numbers[8],
            content_val, str(verification_value), time_str, date_only, dtype, was_corrected
        ))

        if (idx + 1) % 10000 == 0:
            logging.info("已处理 %d / %d 条...", idx + 1, len(data_records))

    # 批量写入数据库
    logging.info("开始写入数据库，共 %d 条...", len(db_rows))
    c.execute('PRAGMA synchronous=OFF')
    c.execute('PRAGMA temp_store=MEMORY')
    c.execute('PRAGMA cache_size=-200000')  # 200MB缓存

    BATCH = 50000
    for i in range(0, len(db_rows), BATCH):
        c.executemany('''INSERT INTO records
            (transport,num1,num2,num3,num4,num5,num6,num7,num8,content,verification,record_time,date_str,type,corrected)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', db_rows[i:i+BATCH])
        conn.commit()
        logging.info("已写入 %d / %d 条", min(i+BATCH, len(db_rows)), len(db_rows))

    # 写完后再建索引
    logging.info("开始创建索引...")
    c.execute('CREATE INDEX IF NOT EXISTS idx_date ON records(date_str)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_content ON records(content)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_time ON records(record_time)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_num3 ON records(num3)')
    conn.commit()
    logging.info("索引创建完成")
    conn.close()

    # 保存最后编号
    with open(number_file, 'w', encoding='utf-8') as f:
        json.dump({'numbers': current_numbers, 'cycle_count': cycle_count}, f, indent=4)

    logging.info("=" * 50)
    logging.info("完成！")
    logging.info("总处理: %d 条", len(data_records))
    logging.info("校验纠正: %d 次", intervention_count)
    logging.info("最终编号: %s", current_numbers)
    logging.info("循环轮数: %d", cycle_count)
    logging.info("数据库文件: %s", os.path.abspath(DB_FILE))


if __name__ == '__main__':
    main()