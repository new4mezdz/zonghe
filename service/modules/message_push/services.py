import os
import re
from datetime import datetime

import pymysql
from pymysql.cursors import DictCursor


MYSQL_HOST = os.environ.get("MESSAGE_PUSH_MYSQL_HOST", "127.0.0.1")
MYSQL_PORT = int(os.environ.get("MESSAGE_PUSH_MYSQL_PORT", "3306"))
MYSQL_USER = os.environ.get("MESSAGE_PUSH_MYSQL_USER", "th")
MYSQL_PASSWORD = os.environ.get("MESSAGE_PUSH_MYSQL_PASSWORD", "123456")
MYSQL_DATABASE = os.environ.get("MESSAGE_PUSH_MYSQL_DATABASE", "zonghe_service")


def _duplicate_column(exc):
    return getattr(exc, "args", [None])[0] == 1060


def _duplicate_key(exc):
    return getattr(exc, "args", [None])[0] == 1061


class MessagePushService:
    def __init__(self):
        self.db_name = self._normalize_identifier(MYSQL_DATABASE)
        self._db_ready = True
        self._db_error = ""
        try:
            self._init_db()
        except Exception as exc:
            self._db_ready = False
            self._db_error = str(exc)

    def _get_server_conn(self):
        return pymysql.connect(
            host=MYSQL_HOST,
            port=MYSQL_PORT,
            user=MYSQL_USER,
            password=MYSQL_PASSWORD,
            charset="utf8mb4",
            autocommit=True,
            cursorclass=DictCursor,
            connect_timeout=5,
            read_timeout=10,
            write_timeout=10,
        )

    def _get_conn(self):
        return pymysql.connect(
            host=MYSQL_HOST,
            port=MYSQL_PORT,
            user=MYSQL_USER,
            password=MYSQL_PASSWORD,
            database=self.db_name,
            charset="utf8mb4",
            autocommit=True,
            cursorclass=DictCursor,
            connect_timeout=5,
            read_timeout=10,
            write_timeout=10,
        )

    def _init_db(self):
        with self._get_server_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"CREATE DATABASE IF NOT EXISTS `{self.db_name}` "
                    "DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                )

        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    CREATE TABLE IF NOT EXISTS push_messages (
                        id BIGINT PRIMARY KEY AUTO_INCREMENT,
                        push_time DATETIME NOT NULL,
                        machine_no INT NOT NULL,
                        machine_code VARCHAR(8) NOT NULL,
                        content TEXT NOT NULL,
                        created_at DATETIME NOT NULL
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                    """
                )
                try:
                    cursor.execute("ALTER TABLE push_messages ADD COLUMN machine_code VARCHAR(8) NULL")
                except pymysql.err.OperationalError as exc:
                    if not _duplicate_column(exc):
                        raise

                cursor.execute(
                    """
                    UPDATE push_messages
                    SET machine_code = CONCAT('jy', LPAD(machine_no, 2, '0'))
                    WHERE machine_code IS NULL OR machine_code = ''
                    """
                )
                cursor.execute("ALTER TABLE push_messages MODIFY machine_code VARCHAR(8) NOT NULL")
                self._ensure_index(cursor, "idx_push_messages_time", "push_time")
                self._ensure_index(cursor, "idx_push_messages_machine", "machine_no")
                self._ensure_index(cursor, "idx_push_messages_machine_code", "machine_code")

    def _ensure_index(self, cursor, index_name, column_name):
        try:
            cursor.execute(
                f"ALTER TABLE push_messages ADD INDEX `{index_name}` (`{column_name}`)"
            )
        except pymysql.err.OperationalError as exc:
            if not _duplicate_key(exc):
                raise

    def create_message(self, push_time, machine_no, content):
        if not self._db_ready:
            return {
                "success": False,
                "error": f"消息推送服务未就绪：{self._db_error or 'MySQL 连接失败'}",
            }
        normalized_time = self._normalize_time(push_time)
        machine_no = self._normalize_machine_no(machine_no)
        content = str(content or "").strip()

        if not normalized_time:
            return {"success": False, "error": "请选择推送时间"}
        if machine_no is None:
            return {"success": False, "error": "机台号必须在 1 到 12 之间"}
        if not content:
            return {"success": False, "error": "请输入推送内容"}

        machine_code = self._machine_code(machine_no)
        created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO push_messages (push_time, machine_no, machine_code, content, created_at)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (normalized_time, machine_no, machine_code, content, created_at),
                )
                record_id = cursor.lastrowid

        return {
            "success": True,
            "message": "提交成功",
            "record": {
                "id": record_id,
                "push_time": normalized_time,
                "machine_no": machine_no,
                "machine_code": machine_code,
                "content": content,
                "created_at": created_at,
            },
        }

    def list_messages(self, limit=50):
        if not self._db_ready:
            return {
                "success": False,
                "error": f"消息推送服务未就绪：{self._db_error or 'MySQL 连接失败'}",
            }
        return self.query_messages(limit=limit)

    def query_messages(
        self,
        machine_no=None,
        machine_code=None,
        start_time=None,
        end_time=None,
        keyword=None,
        limit=50,
        offset=0,
        order="desc",
    ):
        if not self._db_ready:
            return {
                "success": False,
                "error": f"消息推送服务未就绪：{self._db_error or 'MySQL 连接失败'}",
                "total": 0,
                "limit": 0,
                "offset": 0,
                "records": [],
            }
        limit = self._sanitize_limit(limit)
        offset = self._sanitize_offset(offset)
        direction = "ASC" if str(order).lower() == "asc" else "DESC"

        conditions = []
        params = []

        machine_no = self._normalize_machine_no(machine_no)
        if machine_no is not None:
            conditions.append("machine_no = %s")
            params.append(machine_no)

        machine_code = self._normalize_machine_code(machine_code)
        if machine_code:
            conditions.append("machine_code = %s")
            params.append(machine_code)

        start_time = self._normalize_query_time(start_time, "start")
        if start_time:
            conditions.append("push_time >= %s")
            params.append(start_time)

        end_time = self._normalize_query_time(end_time, "end")
        if end_time:
            conditions.append("push_time <= %s")
            params.append(end_time)

        keyword = str(keyword or "").strip()
        if keyword:
            conditions.append("content LIKE %s")
            params.append(f"%{keyword}%")

        where_sql = " WHERE " + " AND ".join(conditions) if conditions else ""

        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    f"SELECT COUNT(*) AS total FROM push_messages{where_sql}",
                    params,
                )
                total = cursor.fetchone()["total"]
                cursor.execute(
                    f"""
                    SELECT id, push_time, machine_no, machine_code, content, created_at
                    FROM push_messages{where_sql}
                    ORDER BY push_time {direction}, id {direction}
                    LIMIT %s OFFSET %s
                    """,
                    params + [limit, offset],
                )
                rows = cursor.fetchall()

        return {
            "success": True,
            "total": total,
            "limit": limit,
            "offset": offset,
            "records": [self._row_to_dict(row) for row in rows],
        }

    def get_message(self, record_id):
        if not self._db_ready:
            return {
                "success": False,
                "error": f"消息推送服务未就绪：{self._db_error or 'MySQL 连接失败'}",
            }
        try:
            record_id = int(record_id)
        except (TypeError, ValueError):
            return {"success": False, "error": "记录ID无效"}

        with self._get_conn() as conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT id, push_time, machine_no, machine_code, content, created_at
                    FROM push_messages
                    WHERE id = %s
                    """,
                    (record_id,),
                )
                row = cursor.fetchone()

        if row is None:
            return {"success": False, "error": "记录不存在"}
        return {"success": True, "record": self._row_to_dict(row)}

    def get_api_info(self):
        if not self._db_ready:
            return {
                "success": False,
                "enabled": False,
                "error": self._db_error or "MySQL 连接失败",
                "service": "消息推送",
            }
        return {
            "success": True,
            "name": "消息推送接口",
            "description": "供内网系统查询和写入消息推送数据的 HTTP JSON 接口。",
            "database": self.db_name,
            "table": "push_messages",
            "engine": "mysql",
            "mysql": {
                "host": MYSQL_HOST,
                "port": MYSQL_PORT,
                "user": MYSQL_USER,
                "database": self.db_name,
            },
            "fields": {
                "id": "整数，自增主键",
                "push_time": "推送时间，格式 YYYY-MM-DD HH:MM:SS",
                "machine_no": "机台号，整数 1-12",
                "machine_code": "机台编码，按机台号自动生成，1号机为 jy01，2号机为 jy02，以此类推到 jy12",
                "content": "推送文本内容",
                "created_at": "记录提交到数据库的时间，格式 YYYY-MM-DD HH:MM:SS",
            },
            "endpoints": {
                "query": {
                    "method": "GET",
                    "path": "/api/message_push/messages",
                    "params": {
                        "machine_no": "可选，机台号 1-12",
                        "machine_code": "可选，机台编码 jy01-jy12",
                        "start_time": "可选，YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS",
                        "end_time": "可选，YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS",
                        "keyword": "可选，内容关键词",
                        "limit": "可选，默认 50，最大 500",
                        "offset": "可选，默认 0",
                        "order": "可选，desc 或 asc",
                    },
                },
                "detail": {
                    "method": "GET",
                    "path": "/api/message_push/messages/<id>",
                },
                "submit": {
                    "method": "POST",
                    "path": "/api/message_push/submit",
                    "body": {
                        "push_time": "2026-05-06T14:05",
                        "machine_no": 1,
                        "content": "文本内容",
                    },
                },
            },
            "examples": {
                "query_all": "/api/message_push/messages?limit=50",
                "query_machine": "/api/message_push/messages?machine_no=5&limit=20",
                "query_machine_code": "/api/message_push/messages?machine_code=jy05&limit=20",
                "detail": "/api/message_push/messages/1",
            },
            "notes": [
                "消息推送模块当前使用 MySQL 保存数据，不再写入 message_push.db。",
                "程序启动时会尝试自动创建 zonghe_service 数据库和 push_messages 表。",
                "machine_code 由后端根据 machine_no 自动生成，调用方不需要提交该字段。",
                "接口只返回业务字段，不开放 MySQL 直连和任意 SQL 执行。",
            ],
        }

    def _row_to_dict(self, row):
        return {
            "id": row["id"],
            "push_time": self._format_datetime(row["push_time"]),
            "machine_no": row["machine_no"],
            "machine_code": row["machine_code"],
            "content": row["content"],
            "created_at": self._format_datetime(row["created_at"]),
        }

    def _format_datetime(self, value):
        if hasattr(value, "strftime"):
            return value.strftime("%Y-%m-%d %H:%M:%S")
        return str(value)

    def _sanitize_limit(self, value):
        try:
            limit = int(value)
        except (TypeError, ValueError):
            limit = 50
        return max(1, min(limit, 500))

    def _sanitize_offset(self, value):
        try:
            offset = int(value)
        except (TypeError, ValueError):
            offset = 0
        return max(0, offset)

    def _normalize_time(self, value):
        value = str(value or "").strip()
        if not value:
            return ""

        normalized = value.replace("T", " ")
        if normalized.endswith("Z"):
            normalized = normalized[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(normalized)
            return parsed.strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            return ""

    def _normalize_query_time(self, value, boundary):
        value = str(value or "").strip()
        if not value:
            return ""
        if len(value) == 10:
            value = value + (" 23:59:59" if boundary == "end" else " 00:00:00")
        return self._normalize_time(value)

    def _normalize_machine_no(self, value):
        try:
            machine_no = int(value)
        except (TypeError, ValueError):
            return None
        if 1 <= machine_no <= 12:
            return machine_no
        return None

    def _machine_code(self, machine_no):
        return f"jy{machine_no:02d}"

    def _normalize_machine_code(self, value):
        value = str(value or "").strip().lower()
        if not value:
            return ""
        if value.isdigit():
            machine_no = self._normalize_machine_no(value)
            return self._machine_code(machine_no) if machine_no is not None else ""
        if len(value) == 4 and value.startswith("jy") and value[2:].isdigit():
            machine_no = self._normalize_machine_no(value[2:])
            return self._machine_code(machine_no) if machine_no is not None else ""
        return ""

    def _normalize_identifier(self, value):
        value = str(value or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_]+", value):
            raise ValueError("MySQL database name can only contain letters, numbers, and underscores.")
        return value


message_push_service = MessagePushService()
