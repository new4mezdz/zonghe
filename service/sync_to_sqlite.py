import sqlite3
import sys
import time
import traceback
from datetime import datetime

import pymysql
from pymysql.cursors import DictCursor, SSDictCursor

# ----- 远端 MySQL 配置 -----
MYSQL_CONFIG = {
    "host": "10.164.62.206",
    "port": 3306,
    "user": "bizreader",
    "password": "XCszcj@2024",
    "database": "biz",
    "charset": "utf8mb4",
    "connect_timeout": 10,
    "read_timeout": 600,
}

# ----- 只同步这些表 -----
SYNC_TABLES = [
    "report_yield_output",
    "datax_pbms_xc_print_barcode_scale",
    "datax_pbms_xc_itg_v_jb_fl",
]
# ----- 本地 SQLite 路径 -----
SQLITE_PATH = "biz_local.db"

# ----- 同步间隔(秒) -----
INTERVAL_SECONDS = 60

# ----- 增量字段候选(小写匹配,按优先级)-----
UPDATE_TIME_CANDIDATES = [
    "update_time", "updatetime", "updated_at",
    "modify_time", "modifytime", "modified_at",
    "gmt_modified", "last_update_time", "lastupdatetime",
]

BATCH_SIZE = 2000


# ============ 连接 ============

def mysql_connect(cursor_class=DictCursor):
    cfg = dict(MYSQL_CONFIG)
    cfg["cursorclass"] = cursor_class
    return pymysql.connect(**cfg)


def sqlite_connect():
    conn = sqlite3.connect(SQLITE_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


# ============ 元数据 ============

def list_tables(meta_conn):
    with meta_conn.cursor() as cur:
        cur.execute("""
            SELECT TABLE_NAME, TABLE_TYPE
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = DATABASE()
            ORDER BY TABLE_NAME
        """)
        return cur.fetchall()


def get_columns(meta_conn, table):
    with meta_conn.cursor() as cur:
        cur.execute(f"DESC `{table}`")
        rows = cur.fetchall()
    return [(r["Field"], r["Type"], r["Key"], (r["Extra"] or "")) for r in rows]


def detect_strategy(columns):
    name_map = {c[0].lower(): c[0] for c in columns}
    for cand in UPDATE_TIME_CANDIDATES:
        if cand in name_map:
            return ("update_time", name_map[cand])
    for col_name, _t, key, extra in columns:
        if key == "PRI" and "auto_increment" in extra.lower():
            return ("pk", col_name)
    return ("full", None)


# ============ 同步状态表 ============

def init_sync_state(sqlite_conn):
    sqlite_conn.execute("""
        CREATE TABLE IF NOT EXISTS _sync_state (
            table_name   TEXT PRIMARY KEY,
            strategy     TEXT,
            cursor_field TEXT,
            last_value   TEXT,
            last_sync_at TEXT,
            row_count    INTEGER
        )
    """)
    sqlite_conn.commit()


def get_state(sqlite_conn, table):
    cur = sqlite_conn.execute(
        "SELECT strategy, cursor_field, last_value FROM _sync_state WHERE table_name=?",
        (table,),
    )
    return cur.fetchone()


def upsert_state(sqlite_conn, table, strategy, cursor_field, last_value, row_count):
    sqlite_conn.execute("""
        INSERT INTO _sync_state(table_name, strategy, cursor_field, last_value, last_sync_at, row_count)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(table_name) DO UPDATE SET
            strategy=excluded.strategy,
            cursor_field=excluded.cursor_field,
            last_value=excluded.last_value,
            last_sync_at=excluded.last_sync_at,
            row_count=excluded.row_count
    """, (table, strategy, cursor_field, last_value,
          datetime.now().isoformat(timespec="seconds"), row_count))
    sqlite_conn.commit()


# ============ 建表 + 同步 ============

def create_sqlite_table(sqlite_conn, table, columns):
    pk_cols = [c[0] for c in columns if c[2] == "PRI"]
    cols_def = ", ".join(f'"{c[0]}" TEXT' for c in columns)
    if pk_cols:
        pk_def = ", ".join(f'"{c}"' for c in pk_cols)
        cols_def += f", PRIMARY KEY ({pk_def})"
    sqlite_conn.execute(f'DROP TABLE IF EXISTS "{table}"')
    sqlite_conn.execute(f'CREATE TABLE "{table}" ({cols_def})')
    sqlite_conn.commit()


def sync_table(meta_conn, sqlite_conn, table, table_type):
    columns = get_columns(meta_conn, table)
    if not columns:
        print(f"  [skip] no columns")
        return

    col_names = [c[0] for c in columns]
    strategy, cursor_field = detect_strategy(columns)
    if table_type == "VIEW":
        strategy, cursor_field = "full", None

    state = get_state(sqlite_conn, table)
    is_first = state is None

    if is_first:
        create_sqlite_table(sqlite_conn, table, columns)

    where_sql = ""
    params = ()
    if not is_first and strategy != "full" and state[2] is not None:
        where_sql = f" WHERE `{cursor_field}` > %s"
        params = (state[2],)

    if strategy == "full" and not is_first:
        sqlite_conn.execute(f'DELETE FROM "{table}"')
        sqlite_conn.commit()

    cols_sql = ", ".join(f"`{c}`" for c in col_names)
    order_sql = f" ORDER BY `{cursor_field}` ASC" if cursor_field else ""
    sql = f"SELECT {cols_sql} FROM `{table}`{where_sql}{order_sql}"

    placeholders = ", ".join(["?"] * len(col_names))
    quoted_cols = ", ".join(f'"{c}"' for c in col_names)
    insert_sql = f'INSERT OR REPLACE INTO "{table}" ({quoted_cols}) VALUES ({placeholders})'

    last_cursor_value = state[2] if state else None
    total = 0

    stream_conn = mysql_connect(SSDictCursor)
    try:
        with stream_conn.cursor() as cur:
            cur.execute(sql, params)
            while True:
                rows = cur.fetchmany(BATCH_SIZE)
                if not rows:
                    break
                batch = []
                for r in rows:
                    batch.append([None if r[c] is None else str(r[c]) for c in col_names])
                    if cursor_field and r[cursor_field] is not None:
                        last_cursor_value = str(r[cursor_field])
                sqlite_conn.executemany(insert_sql, batch)
                sqlite_conn.commit()
                total += len(batch)
                print(f"    ... {total} rows", end="\r")
    finally:
        stream_conn.close()

    cur2 = sqlite_conn.execute(f'SELECT COUNT(*) FROM "{table}"')
    row_count = cur2.fetchone()[0]
    upsert_state(sqlite_conn, table, strategy, cursor_field, last_cursor_value, row_count)

    tag = "FIRST" if is_first else "INCR "
    print(f"  [{tag}] +{total} rows | total={row_count} | strategy={strategy} | cursor={cursor_field}")


# ============ 单次同步 ============

def sync_once():
    print(f"Connecting to MySQL {MYSQL_CONFIG['host']} ...")
    meta_conn = mysql_connect(DictCursor)
    sqlite_conn = sqlite_connect()
    init_sync_state(sqlite_conn)

    tables = SYNC_TABLES
    print(f"Tables to sync: {tables}\n")

    ok, fail = 0, 0
    for i, name in enumerate(tables, 1):
        ttype = "BASE TABLE"
        print(f"[{i}/{len(tables)}] {name} ({ttype})")
        try:
            sync_table(meta_conn, sqlite_conn, name, ttype)
            ok += 1
        except Exception as exc:
            print(f"  [ERROR] {exc}")
            fail += 1

    meta_conn.close()
    sqlite_conn.close()
    print(f"\nDone. ok={ok}, fail={fail}, sqlite={SQLITE_PATH}")


# ============ 守护循环 ============

def main():
    print(f"Daemon started. Interval = {INTERVAL_SECONDS}s. Press Ctrl+C to stop.\n")
    while True:
        start = datetime.now()
        print(f"========== Sync round start: {start:%Y-%m-%d %H:%M:%S} ==========")
        try:
            sync_once()
        except Exception:
            print("Sync round crashed:")
            traceback.print_exc()
        end = datetime.now()
        print(f"========== Sync round end: {end:%Y-%m-%d %H:%M:%S} (took {(end-start).total_seconds():.1f}s) ==========")
        print(f"Sleeping {INTERVAL_SECONDS}s ...")
        try:
            time.sleep(INTERVAL_SECONDS)
        except KeyboardInterrupt:
            print("\nDaemon stopped by user.")
            break


if __name__ == "__main__":
    main()