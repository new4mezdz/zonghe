from influxdb_client import InfluxDBClient

url = "http://10.164.62.253:8086/"
token = "u31cmj6sXb8CjYO1r0TcBbSNToKHXVsqbgMn-KBq7zvnmAEemTtYlN8ZwX7wXydgRr6VkdjuwwbiD0YgS6lq0A=="

client = InfluxDBClient(url=url, token=token)
orgs = client.organizations_api().find_organizations()
for o in orgs:
    print(f"Org: {o.name}, ID: {o.id}")
client.close()