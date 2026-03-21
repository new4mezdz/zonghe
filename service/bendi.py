import sqlite3

conn = sqlite3.connect(r'E:\9#\zonghe\service\urldata.db')
conn.row_factory = sqlite3.Row
c = conn.cursor()

# 看看数据库里有哪些日期
c.execute('SELECT DISTINCT date_str FROM records ORDER BY date_str DESC LIMIT 10')
print("数据库中的日期：")
for row in c.fetchall():
    print(f"  {row['date_str']}")

# 看看总共多少条
c.execute('SELECT COUNT(*) as cnt FROM records')
print(f"\n总记录数: {c.fetchone()['cnt']}")

# 看最新5条
c.execute('SELECT id, record_time, date_str FROM records ORDER BY id DESC LIMIT 5')
print("\n最新5条：")
for row in c.fetchall():
    print(f"  id={row['id']}  时间={row['record_time']}  日期={row['date_str']}")

conn.close()