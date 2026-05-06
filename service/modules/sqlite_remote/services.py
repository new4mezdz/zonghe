import os
import re
import sqlite3
import sys
from pathlib import Path


def _app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class SQLiteRemoteService:
    READ_ONLY_PREFIXES = {"select", "with", "pragma", "explain"}

    def __init__(self):
        default_db = Path(_app_dir()) / "urldata.db"
        db_path = os.environ.get("SQLITE_REMOTE_DB_PATH", str(default_db))

        self.db_path = Path(db_path).expanduser().resolve()
        self.api_token = os.environ.get("SQLITE_REMOTE_API_TOKEN", "").strip()
        self.allow_anonymous = _env_bool("SQLITE_REMOTE_ALLOW_ANONYMOUS", False)
        self.read_only = _env_bool("SQLITE_REMOTE_READ_ONLY", True)
        self.enable_write = _env_bool("SQLITE_REMOTE_ENABLE_WRITE", False)
        self.max_rows = max(1, min(_env_int("SQLITE_REMOTE_MAX_ROWS", 500), 5000))

    def authorize_request(self, request):
        if self.allow_anonymous:
            return None

        configured_token = self.api_token
        if not configured_token:
            return "服务未配置 SQLITE_REMOTE_API_TOKEN，已拒绝远程访问。", 503

        header_token = request.headers.get("X-API-Token", "").strip()
        auth_header = request.headers.get("Authorization", "").strip()
        bearer_token = ""
        if auth_header.lower().startswith("bearer "):
            bearer_token = auth_header[7:].strip()

        token = header_token or bearer_token
        if not token:
            return "缺少访问令牌，请在请求头中携带 X-API-Token 或 Authorization: Bearer <token>。", 401
        if token != configured_token:
            return "访问令牌无效。", 403
        return None

    def get_service_info(self):
        return {
            "service": "sqlite-remote",
            "db_path": str(self.db_path),
            "db_exists": self.db_path.exists(),
            "read_only": self.read_only,
            "write_enabled": self.enable_write and not self.read_only,
            "max_rows": self.max_rows,
            "allow_anonymous": self.allow_anonymous,
        }

    def _ensure_db_exists(self):
        if not self.db_path.exists():
            raise FileNotFoundError(f"SQLite 数据库文件不存在: {self.db_path}")

    def _connect(self, force_read_only=None):
        self._ensure_db_exists()
        readonly = self.read_only if force_read_only is None else force_read_only
        conn = sqlite3.connect(str(self.db_path), timeout=5, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        if readonly:
            conn.execute("PRAGMA query_only=ON")
        return conn

    def _get_object(self, object_name):
        if not object_name:
            raise ValueError("对象名不能为空。")
        with self._connect(force_read_only=True) as conn:
            row = conn.execute(
                """
                SELECT name, type, sql
                FROM sqlite_master
                WHERE name = ? AND type IN ('table', 'view')
                """,
                (object_name,),
            ).fetchone()
        if row is None:
            raise ValueError(f"未找到表或视图: {object_name}")
        return dict(row)

    def _quote_identifier(self, name):
        return '"' + name.replace('"', '""') + '"'

    def _sanitize_limit(self, limit):
        try:
            parsed = int(limit)
        except (TypeError, ValueError):
            parsed = self.max_rows
        return max(1, min(parsed, self.max_rows))

    def _sanitize_offset(self, offset):
        try:
            parsed = int(offset)
        except (TypeError, ValueError):
            parsed = 0
        return max(0, parsed)

    def _strip_leading_comments(self, sql):
        cleaned = sql.strip()
        while True:
            if cleaned.startswith("--"):
                parts = cleaned.split("\n", 1)
                cleaned = parts[1].strip() if len(parts) == 2 else ""
                continue
            if cleaned.startswith("/*"):
                end_index = cleaned.find("*/")
                if end_index == -1:
                    return ""
                cleaned = cleaned[end_index + 2 :].strip()
                continue
            return cleaned

    def _is_read_only_sql(self, sql):
        cleaned = self._strip_leading_comments(sql)
        if not cleaned:
            return False
        first_word = re.split(r"\s+", cleaned, maxsplit=1)[0].lower()
        return first_word in self.READ_ONLY_PREFIXES

    def list_objects(self):
        with self._connect(force_read_only=True) as conn:
            rows = conn.execute(
                """
                SELECT name, type
                FROM sqlite_master
                WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                ORDER BY type, name
                """
            ).fetchall()

        objects = []
        for row in rows:
            info = {"name": row["name"], "type": row["type"]}
            try:
                with self._connect(force_read_only=True) as conn:
                    count_sql = f"SELECT COUNT(*) AS total FROM {self._quote_identifier(row['name'])}"
                    total = conn.execute(count_sql).fetchone()["total"]
                info["row_count"] = total
            except sqlite3.Error:
                info["row_count"] = None
            objects.append(info)
        return objects

    def get_schema(self, object_name):
        obj = self._get_object(object_name)
        quoted_name = self._quote_identifier(obj["name"])

        with self._connect(force_read_only=True) as conn:
            columns = [
                dict(row)
                for row in conn.execute(f"PRAGMA table_info({quoted_name})").fetchall()
            ]
            indexes = []
            for index_row in conn.execute(f"PRAGMA index_list({quoted_name})").fetchall():
                index_info = dict(index_row)
                quoted_index = self._quote_identifier(index_row["name"])
                index_columns = [
                    detail["name"]
                    for detail in conn.execute(f"PRAGMA index_info({quoted_index})").fetchall()
                ]
                index_info["columns"] = index_columns
                indexes.append(index_info)

        return {
            "name": obj["name"],
            "type": obj["type"],
            "create_sql": obj["sql"],
            "columns": columns,
            "indexes": indexes,
        }

    def fetch_rows(self, object_name, limit=None, offset=0, order_by=None, order="desc"):
        schema = self.get_schema(object_name)
        limit = self._sanitize_limit(limit)
        offset = self._sanitize_offset(offset)
        direction = "ASC" if str(order).lower() == "asc" else "DESC"

        quoted_name = self._quote_identifier(schema["name"])
        valid_columns = {column["name"] for column in schema["columns"]}
        order_sql = ""
        if order_by:
            if order_by not in valid_columns:
                raise ValueError(f"排序字段不存在: {order_by}")
            order_sql = f" ORDER BY {self._quote_identifier(order_by)} {direction}"

        with self._connect(force_read_only=True) as conn:
            total_row = conn.execute(
                f"SELECT COUNT(*) AS total FROM {quoted_name}"
            ).fetchone()
            sql = f"SELECT * FROM {quoted_name}{order_sql} LIMIT ? OFFSET ?"
            rows = conn.execute(sql, (limit, offset)).fetchall()

        return {
            "table": schema["name"],
            "total": total_row["total"],
            "limit": limit,
            "offset": offset,
            "rows": [dict(row) for row in rows],
        }

    def run_query(self, sql, params=None, limit=None):
        if not isinstance(sql, str) or not sql.strip():
            raise ValueError("sql 不能为空。")
        if self.read_only and not self._is_read_only_sql(sql):
            raise PermissionError("当前服务为只读模式，只允许 SELECT / WITH / PRAGMA / EXPLAIN 查询。")

        params = params if isinstance(params, (list, tuple)) else []
        limit = self._sanitize_limit(limit)

        with self._connect(force_read_only=self.read_only) as conn:
            cursor = conn.execute(sql, params)

            if cursor.description:
                columns = [item[0] for item in cursor.description]
                rows = cursor.fetchmany(limit + 1)
                truncated = len(rows) > limit
                if truncated:
                    rows = rows[:limit]

                return {
                    "columns": columns,
                    "rows": [dict(row) for row in rows],
                    "row_count": len(rows),
                    "truncated": truncated,
                    "limit": limit,
                }

            conn.commit()
            return {
                "columns": [],
                "rows": [],
                "row_count": 0,
                "truncated": False,
                "rows_affected": cursor.rowcount,
            }

    def execute(self, sql, params=None):
        if self.read_only:
            raise PermissionError("当前服务为只读模式，不能执行写入语句。")
        if not self.enable_write:
            raise PermissionError("当前服务未开启写入能力，请设置 SQLITE_REMOTE_ENABLE_WRITE=1。")
        if not isinstance(sql, str) or not sql.strip():
            raise ValueError("sql 不能为空。")

        params = params if isinstance(params, (list, tuple)) else []

        with self._connect(force_read_only=False) as conn:
            cursor = conn.execute(sql, params)
            conn.commit()
            response = {
                "rows_affected": cursor.rowcount,
                "last_row_id": cursor.lastrowid,
            }
            if cursor.description:
                response["rows"] = [dict(row) for row in cursor.fetchall()]
            return response


sqlite_remote_service = SQLiteRemoteService()
