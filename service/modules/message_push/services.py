import os
import sqlite3
import sys
from datetime import datetime


def _app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


DB_FILE = os.path.join(_app_dir(), "message_push.db")


class MessagePushService:
    def __init__(self):
        self.db_file = DB_FILE
        self._init_db()

    def _get_conn(self):
        conn = sqlite3.connect(self.db_file, timeout=5, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _init_db(self):
        with self._get_conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS push_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    push_time TEXT NOT NULL,
                    machine_no INTEGER NOT NULL CHECK(machine_no BETWEEN 1 AND 12),
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_push_messages_time ON push_messages(push_time)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_push_messages_machine ON push_messages(machine_no)"
            )

    def create_message(self, push_time, machine_no, content):
        normalized_time = self._normalize_time(push_time)
        machine_no = self._normalize_machine_no(machine_no)
        content = str(content or "").strip()

        if not normalized_time:
            return {"success": False, "error": "请选择推送时间"}
        if machine_no is None:
            return {"success": False, "error": "机台号必须在 1 到 12 之间"}
        if not content:
            return {"success": False, "error": "请输入推送内容"}

        created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self._get_conn() as conn:
            cursor = conn.execute(
                """
                INSERT INTO push_messages (push_time, machine_no, content, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (normalized_time, machine_no, content, created_at),
            )

        return {
            "success": True,
            "message": "提交成功",
            "record": {
                "id": cursor.lastrowid,
                "push_time": normalized_time,
                "machine_no": machine_no,
                "content": content,
                "created_at": created_at,
            },
        }

    def list_messages(self, limit=50):
        return self.query_messages(limit=limit)

    def query_messages(
        self,
        machine_no=None,
        start_time=None,
        end_time=None,
        keyword=None,
        limit=50,
        offset=0,
        order="desc",
    ):
        limit = self._sanitize_limit(limit)
        offset = self._sanitize_offset(offset)
        direction = "ASC" if str(order).lower() == "asc" else "DESC"

        conditions = []
        params = []

        machine_no = self._normalize_machine_no(machine_no)
        if machine_no is not None:
            conditions.append("machine_no = ?")
            params.append(machine_no)

        start_time = self._normalize_query_time(start_time, "start")
        if start_time:
            conditions.append("push_time >= ?")
            params.append(start_time)

        end_time = self._normalize_query_time(end_time, "end")
        if end_time:
            conditions.append("push_time <= ?")
            params.append(end_time)

        keyword = str(keyword or "").strip()
        if keyword:
            conditions.append("content LIKE ?")
            params.append(f"%{keyword}%")

        where_sql = " WHERE " + " AND ".join(conditions) if conditions else ""

        with self._get_conn() as conn:
            total = conn.execute(
                f"SELECT COUNT(*) AS total FROM push_messages{where_sql}",
                params,
            ).fetchone()["total"]
            rows = conn.execute(
                f"""
                SELECT id, push_time, machine_no, content, created_at
                FROM push_messages{where_sql}
                ORDER BY push_time {direction}, id {direction}
                LIMIT ?
                OFFSET ?
                """,
                params + [limit, offset],
            ).fetchall()

        return {
            "success": True,
            "total": total,
            "limit": limit,
            "offset": offset,
            "records": [dict(row) for row in rows],
        }

    def get_message(self, record_id):
        try:
            record_id = int(record_id)
        except (TypeError, ValueError):
            return {"success": False, "error": "记录ID无效"}

        with self._get_conn() as conn:
            row = conn.execute(
                """
                SELECT id, push_time, machine_no, content, created_at
                FROM push_messages
                WHERE id = ?
                """,
                (record_id,),
            ).fetchone()

        if row is None:
            return {"success": False, "error": "记录不存在"}
        return {"success": True, "record": dict(row)}

    def get_api_info(self):
        return {
            "success": True,
            "name": "消息推送接口",
            "description": "供内网系统查询和写入消息推送数据的 HTTP JSON 接口。",
            "database": os.path.basename(self.db_file),
            "table": "push_messages",
            "cors": {
                "enabled": True,
                "allow_origin": "*",
                "allow_methods": ["GET", "POST", "OPTIONS"],
                "allow_headers": ["Content-Type", "Authorization", "X-API-Token"],
            },
            "fields": {
                "id": "整数，自增主键",
                "push_time": "推送时间，格式 YYYY-MM-DD HH:MM:SS",
                "machine_no": "机台号，整数 1-12",
                "content": "推送文本内容",
                "created_at": "记录提交到数据库的时间，格式 YYYY-MM-DD HH:MM:SS",
            },
            "endpoints": {
                "query": {
                    "method": "GET",
                    "path": "/api/message_push/messages",
                    "description": "分页查询消息推送记录。所有查询参数都是可选的。",
                    "params": {
                        "machine_no": {
                            "required": False,
                            "type": "integer",
                            "range": "1-12",
                            "description": "按机台号过滤。",
                            "example": "5",
                        },
                        "start_time": {
                            "required": False,
                            "type": "string",
                            "format": "YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS",
                            "description": "查询起始推送时间；只传日期时自动补 00:00:00。",
                            "example": "2026-05-06 00:00:00",
                        },
                        "end_time": {
                            "required": False,
                            "type": "string",
                            "format": "YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS",
                            "description": "查询结束推送时间；只传日期时自动补 23:59:59。",
                            "example": "2026-05-06 23:59:59",
                        },
                        "keyword": {
                            "required": False,
                            "type": "string",
                            "description": "按内容模糊搜索。",
                            "example": "停机",
                        },
                        "limit": {
                            "required": False,
                            "type": "integer",
                            "default": 50,
                            "range": "1-500",
                            "description": "每页返回条数，超过 500 会按 500 处理。",
                            "example": "50",
                        },
                        "offset": {
                            "required": False,
                            "type": "integer",
                            "default": 0,
                            "description": "分页偏移量，第 1 页为 0，第 2 页通常为 limit。",
                            "example": "0",
                        },
                        "order": {
                            "required": False,
                            "type": "string",
                            "default": "desc",
                            "enum": ["desc", "asc"],
                            "description": "按推送时间排序，desc 为新到旧，asc 为旧到新。",
                            "example": "desc",
                        },
                    },
                    "success_response": {
                        "success": True,
                        "total": 1,
                        "limit": 50,
                        "offset": 0,
                        "records": [
                            {
                                "id": 1,
                                "push_time": "2026-05-06 14:05:00",
                                "machine_no": 5,
                                "content": "示例文本",
                                "created_at": "2026-05-06 14:01:23",
                            }
                        ],
                    },
                },
                "detail": {
                    "method": "GET",
                    "path": "/api/message_push/messages/<id>",
                    "description": "按 ID 查询单条消息推送记录。",
                    "success_response": {
                        "success": True,
                        "record": {
                            "id": 1,
                            "push_time": "2026-05-06 14:05:00",
                            "machine_no": 5,
                            "content": "示例文本",
                            "created_at": "2026-05-06 14:01:23",
                        },
                    },
                    "error_response": {
                        "success": False,
                        "error": "记录不存在",
                    },
                },
                "submit": {
                    "method": "POST",
                    "path": "/api/message_push/submit",
                    "description": "新增一条消息推送记录。Content-Type 必须为 application/json。",
                    "body": {
                        "push_time": "2026-05-06T14:05",
                        "machine_no": 1,
                        "content": "文本内容",
                    },
                    "body_fields": {
                        "push_time": "必填，推送时间，支持 YYYY-MM-DDTHH:MM 或 YYYY-MM-DD HH:MM:SS。",
                        "machine_no": "必填，机台号，整数 1-12。",
                        "content": "必填，自定义文本内容，前后空格会自动去掉。",
                    },
                    "success_response": {
                        "success": True,
                        "message": "提交成功",
                        "record": {
                            "id": 1,
                            "push_time": "2026-05-06 14:05:00",
                            "machine_no": 1,
                            "content": "文本内容",
                            "created_at": "2026-05-06 14:01:23",
                        },
                    },
                    "error_response": {
                        "success": False,
                        "error": "机台号必须在 1 到 12 之间",
                    },
                },
                "docs_json": {
                    "method": "GET",
                    "path": "/api/message_push/docs",
                    "description": "返回本接口的机器可读 JSON 说明。",
                },
                "docs_page": {
                    "method": "GET",
                    "path": "/message_push/docs",
                    "description": "返回适合人工阅读的接口说明页面。",
                },
            },
            "examples": {
                "query_all": "/api/message_push/messages?limit=50",
                "query_machine": "/api/message_push/messages?machine_no=5&limit=20",
                "query_time_range": "/api/message_push/messages?start_time=2026-05-06&end_time=2026-05-06",
                "query_keyword": "/api/message_push/messages?keyword=%E5%81%9C%E6%9C%BA",
                "detail": "/api/message_push/messages/1",
            },
            "notes": [
                "所有接口均返回 JSON。",
                "查询接口不会暴露 SQLite 直连权限，只返回 push_messages 表中的业务字段。",
                "内网其他电脑调用时，请把 base_url 中的 127.0.0.1 换成服务器的内网 IP。",
                "当前接口未启用鉴权，请只在可信内网环境开放。",
            ],
        }

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


message_push_service = MessagePushService()
