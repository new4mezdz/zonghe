import argparse
import getpass
import os
import sys
from pathlib import Path

try:
    import pymysql
except ImportError:
    pymysql = None


DEFAULT_HOST = "10.164.62.206"
DEFAULT_PORT = 3306
DEFAULT_DATABASE = "biz"
DEFAULT_USER = "bizreader"


def load_dotenv(path):
    """Load KEY=VALUE lines from a local .env file without adding a dependency."""
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def get_db_config():
    script_dir = Path(__file__).resolve().parent
    load_dotenv(script_dir / ".env")

    password = os.getenv("XC_DB_PASSWORD") or "XCszcj@2024"

    return {
        "host": os.getenv("XC_DB_HOST", DEFAULT_HOST),
        "port": int(os.getenv("XC_DB_PORT", str(DEFAULT_PORT))),
        "user": os.getenv("XC_DB_USER", DEFAULT_USER),
        "password": password,
        "database": os.getenv("XC_DB_DATABASE", DEFAULT_DATABASE),
        "charset": "utf8mb4",
        "connect_timeout": int(os.getenv("XC_DB_CONNECT_TIMEOUT", "8")),
        "read_timeout": int(os.getenv("XC_DB_READ_TIMEOUT", "20")),
        "write_timeout": int(os.getenv("XC_DB_WRITE_TIMEOUT", "20")),
        "cursorclass": pymysql.cursors.DictCursor,
    }


def connect():
    if pymysql is None:
        raise RuntimeError("Missing dependency PyMySQL. Run: python -m pip install pymysql")

    return pymysql.connect(**get_db_config())


def run_query(sql, limit):
    with connect() as conn:
        with conn.cursor() as cursor:
            cursor.execute(sql)
            rows = cursor.fetchmany(limit)
            return rows


def print_rows(rows):
    if not rows:
        print("Query succeeded, but no rows were returned.")
        return

    for index, row in enumerate(rows, start=1):
        print(f"[{index}]")
        for key, value in row.items():
            print(f"  {key}: {value}")


def export_txt(rows, out_path):
    if not rows:
        print("No rows to export.")
        return
    with open(out_path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write("\t".join(str(v) for v in row.values()) + "\n")
    print(f"Exported {len(rows)} rows to {out_path}")


def main():
    parser = argparse.ArgumentParser(description="Connect to the Xichang MySQL database and run a query.")
    parser.add_argument(
        "--sql",
        default="SELECT DATABASE() AS database_name, CURRENT_USER() AS user_name, NOW() AS server_time",
        help="SQL to execute. Defaults to a connection-check query.",
    )
    parser.add_argument("--limit", type=int, default=20, help="Maximum rows to print. Default: 20.")
    parser.add_argument("--out", help="Export results to this txt file path.")
    args = parser.parse_args()

    try:
        rows = run_query(args.sql, args.limit)
    except Exception as exc:
        print("Database connection or query failed:", exc, file=sys.stderr)
        return 1

    if args.out:
        export_txt(rows, args.out)
    else:
        print_rows(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
