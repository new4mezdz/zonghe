from influxdb_client import InfluxDBClient

client = InfluxDBClient(
    url='http://10.164.62.253:8086/',
    token='u31cmj6sXb8CjYO1r0TcBbSNToKHXVsqbgMn-KBq7zvnmAEemTtYlN8ZwX7wXydgRr6VkdjuwwbiD0YgS6lq0A==',
    org='myorg'
)

query = '''from(bucket: "jbcj03")
  |> range(start: 2026-03-02T05:00:00Z, stop: 2026-03-02T10:00:00Z)
  |> filter(fn: (r) => r["_field"] == "code")
  |> sort(columns: ["_time"])'''

tables = client.query_api().query(query, org='myorg')

with open('influx_jbcj03.txt', 'w', encoding='utf-8') as f:
    idx = 0
    for table in tables:
        for record in table.records:
            idx += 1
            f.write(f"{idx:>5}  值={str(record.get_value()):>6}  时间={record.get_time()}\n")

client.close()
print(f"已输出 {idx} 条到 influx_jbcj03.txt")