from influxdb_client import InfluxDBClient

url = "http://10.164.62.253:8086/"
token = "u31cmj6sXb8CjYO1r0TcBbSNToKHXVsqbgMn-KBq7zvnmAEemTtYlN8ZwX7wXydgRr6VkdjuwwbiD0YgS6lq0A=="
org = "myorg"

buckets = ["jbcj01", "jbcj03"]

client = InfluxDBClient(url=url, token=token, org=org)

try:
    health = client.health()
    print(f"数据库状态: {health.status}\n")

    query_api = client.query_api()
    for bucket in buckets:
        try:
            query = f'from(bucket: "{bucket}") |> range(start: -1h) |> limit(n: 1)'
            tables = query_api.query(query, org=org)
            if tables:
                print(f"✅ Bucket '{bucket}' 连接成功，有数据")
                for table in tables:
                    for record in table.records:
                        print(f"   示例: {record.values}")
            else:
                print(f"✅ Bucket '{bucket}' 连接成功，最近1小时无数据")
        except Exception as e:
            print(f"❌ Bucket '{bucket}' 失败: {e}")

except Exception as e:
    print(f"连接失败: {e}")
finally:
    client.close()