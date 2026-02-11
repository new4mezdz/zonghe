from influxdb_client import InfluxDBClient

url = "http://10.164.62.253:8086/"
token = "u31cmj6sXb8CjYO1r0TcBbSNToKHXVsqbgMn-KBq7zvnmAEemTtYlN8ZwX7wXydgRr6VkdjuwwbiD0YgS6lq0A=="
org = "myorg"

client = InfluxDBClient(url=url, token=token, org=org)
buckets = client.buckets_api().find_buckets()
for b in buckets.buckets:
    print(f"Bucket: '{b.name}', ID: {b.id}")
client.close()