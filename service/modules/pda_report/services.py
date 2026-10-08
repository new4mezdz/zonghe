"""Validated, idempotent scan events and reports for the shared scan service."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from flask import current_app


REPORT_ZONE = timezone(timedelta(hours=8), "Asia/Shanghai")
TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"
)
EVENT_FIELDS = {
    "event_id", "barcode", "source", "operation", "scanned_at", "device_id",
    "reader_host", "reader_port",
}


class EventConflict(ValueError):
    """The sender reused an event ID for a different scan."""


def _text(value, label, maximum, *, empty=False):
    if not isinstance(value, str):
        raise ValueError(f"{label}必须是文本")
    if (not value.strip() and not empty) or len(value) > maximum:
        raise ValueError(f"{label}不能为空且不能超过 {maximum} 个字符")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError(f"{label}不能包含换行或控制字符")
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise ValueError(f"{label}包含无效的 Unicode 字符")
    return value


def validate_event(payload):
    if not isinstance(payload, dict):
        raise ValueError("请求正文必须是 JSON 对象")
    unknown = payload.keys() - EVENT_FIELDS
    if unknown:
        raise ValueError("请求包含不支持的字段")
    event_id = _text(payload.get("event_id"), "event_id", 36)
    try:
        if str(uuid.UUID(event_id)) != event_id:
            raise ValueError()
    except (ValueError, AttributeError) as exc:
        raise ValueError("event_id 必须是标准小写 UUID") from exc
    barcode = payload.get("barcode")
    if not isinstance(barcode, str) or not barcode.strip() or "\0" in barcode:
        raise ValueError("条码不能为空且不能包含 NUL 字符")
    try:
        barcode_size = len(barcode.encode("utf-8"))
    except UnicodeError as exc:
        raise ValueError("条码包含无效的 Unicode 字符") from exc
    if barcode_size > 196608:
        raise ValueError("条码不能超过 196608 个 UTF-8 字节")
    device_id = _text(payload.get("device_id"), "设备编号", 128)
    source, operation = payload.get("source"), payload.get("operation")
    if source not in ("reader", "pda"):
        raise ValueError("source 必须是 reader 或 pda")
    if operation not in ("inbound", "return"):
        raise ValueError("operation 必须是 inbound 或 return")
    scanned_at = payload.get("scanned_at")
    if not isinstance(scanned_at, str) or not TIMESTAMP_PATTERN.fullmatch(scanned_at):
        raise ValueError("scanned_at 必须是带时区的 ISO8601 时间")
    try:
        timestamp = datetime.fromisoformat(scanned_at.replace("Z", "+00:00"))
        if timestamp.utcoffset() is None:
            raise ValueError()
        utc_timestamp = timestamp.astimezone(timezone.utc)
        local_timestamp = timestamp.astimezone(REPORT_ZONE)
    except (ValueError, OverflowError) as exc:
        raise ValueError("scanned_at 时间无效") from exc
    host = payload.get("reader_host")
    port = payload.get("reader_port")
    if host is not None:
        host = _text(host, "读码器地址", 255)
    if port is not None and (type(port) is not int or not 1 <= port <= 65535):
        raise ValueError("reader_port 必须是 1 至 65535 的整数")
    normalized = {
        "event_id": event_id, "barcode": barcode, "source": source,
        "operation": operation, "scanned_at": utc_timestamp.isoformat(timespec="microseconds"),
        "device_id": device_id, "reader_host": host, "reader_port": port,
    }
    return normalized, local_timestamp.isoformat(timespec="microseconds")


def validate_filters(values):
    """Only a fixed set of query parameters can contribute to SQL."""
    result = {}
    for key in ("keyword", "start_date", "end_date", "source", "operation"):
        value = values.get(key, "")
        if not isinstance(value, str):
            raise ValueError("筛选参数必须是文本")
        result[key] = value
    _text(result["keyword"], "搜索内容", 4096, empty=True)
    if result["source"] not in ("", "reader", "pda"):
        raise ValueError("来源筛选无效")
    if result["operation"] not in ("", "inbound", "return"):
        raise ValueError("操作筛选无效")
    for key in ("start_date", "end_date"):
        if result[key]:
            try:
                if date.fromisoformat(result[key]).isoformat() != result[key]:
                    raise ValueError()
            except ValueError as exc:
                raise ValueError("日期必须为 YYYY-MM-DD") from exc
    if result["start_date"] and result["end_date"] and result["start_date"] > result["end_date"]:
        raise ValueError("开始日期不能晚于结束日期")
    return result


def _where(filters):
    clauses, args = [], []
    if filters["keyword"]:
        escaped = filters["keyword"].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        clauses.append("barcode LIKE ? ESCAPE '\\'")
        args.append("%" + escaped + "%")
    if filters["start_date"]:
        clauses.append("report_date >= ?")
        args.append(filters["start_date"])
    if filters["end_date"]:
        clauses.append("report_date <= ?")
        args.append(filters["end_date"])
    for key in ("source", "operation"):
        if filters[key]:
            clauses.append(key + " = ?")
            args.append(filters[key])
    return (" WHERE " + " AND ".join(clauses) if clauses else ""), args


class ServiceStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS scan_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL UNIQUE,
                    barcode TEXT NOT NULL,
                    source TEXT NOT NULL CHECK(source IN ('reader','pda')),
                    operation TEXT NOT NULL CHECK(operation IN ('inbound','return')),
                    scanned_at TEXT NOT NULL,
                    local_scanned_at TEXT NOT NULL,
                    report_date TEXT NOT NULL,
                    received_at TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    reader_host TEXT,
                    reader_port INTEGER,
                    canonical_payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS scan_events_report ON scan_events(report_date, scanned_at DESC);
                CREATE INDEX IF NOT EXISTS scan_events_source ON scan_events(source, operation);
                CREATE INDEX IF NOT EXISTS scan_events_time ON scan_events(scanned_at DESC, id DESC);
            """)

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(str(self.path), timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def ingest(self, payload):
        event, local_scanned_at = validate_event(payload)
        canonical = json.dumps(event, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT id, canonical_payload FROM scan_events WHERE event_id = ?", (event["event_id"],)
            ).fetchone()
            if existing:
                if existing["canonical_payload"] != canonical:
                    raise EventConflict("该 event_id 已用于另一条扫码记录，请勿更改已提交的记录")
                return {"ok": True, "event_id": event["event_id"], "id": existing["id"], "duplicate": True}
            received_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
            cursor = connection.execute("""
                INSERT INTO scan_events (event_id, barcode, source, operation, scanned_at,
                    local_scanned_at, report_date, received_at, device_id, reader_host,
                    reader_port, canonical_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (event["event_id"], event["barcode"], event["source"], event["operation"],
                  event["scanned_at"], local_scanned_at, local_scanned_at[:10], received_at,
                  event["device_id"], event["reader_host"], event["reader_port"], canonical))
            return {"ok": True, "event_id": event["event_id"], "id": cursor.lastrowid, "duplicate": False}

    @staticmethod
    def _columns():
        return ("id, event_id, barcode, source, operation, scanned_at, local_scanned_at, "
                "received_at, device_id, reader_host, reader_port")

    def report(self, filters, page=1, page_size=50):
        filters = validate_filters(filters)
        where, args = _where(filters)
        with self.connect() as connection:
            connection.execute("BEGIN")
            stats = dict(connection.execute("""
                SELECT COUNT(*) AS total, COALESCE(SUM(operation = 'inbound'), 0) AS inbound,
                    COALESCE(SUM(operation = 'return'), 0) AS returned,
                    COALESCE(SUM(source = 'pda'), 0) AS pda,
                    COALESCE(SUM(source = 'reader'), 0) AS reader,
                    COUNT(DISTINCT barcode) AS unique_barcodes,
                    COUNT(DISTINCT device_id) AS devices FROM scan_events
            """ + where, args).fetchone())
            pages = max(1, (stats["total"] + page_size - 1) // page_size)
            page = min(page, pages)
            rows = connection.execute("SELECT " + self._columns() + " FROM scan_events" + where
                + " ORDER BY scanned_at DESC, id DESC LIMIT ? OFFSET ?",
                args + [page_size, (page - 1) * page_size]).fetchall()
            # Return the most recent 31 report days, even for an unbounded filter.
            daily = connection.execute("""
                SELECT report_date AS date, COUNT(*) AS total,
                    COALESCE(SUM(operation = 'inbound'), 0) AS inbound,
                    COALESCE(SUM(operation = 'return'), 0) AS returned FROM scan_events
            """ + where + " GROUP BY report_date ORDER BY report_date DESC LIMIT 31", args).fetchall()
        return {"ok": True, "timezone": "Asia/Shanghai", "filters": filters,
                "stats": stats, "daily": [dict(row) for row in reversed(daily)],
                "items": [dict(row) for row in rows], "page": page,
                "page_size": page_size, "total": stats["total"], "pages": pages}

    def export_rows(self, filters, maximum=100000):
        filters = validate_filters(filters)
        where, args = _where(filters)
        with self.connect() as connection:
            connection.execute("BEGIN")
            total = connection.execute("SELECT COUNT(*) FROM scan_events" + where, args).fetchone()[0]
            if total > maximum:
                raise ValueError(f"导出超过 {maximum} 条，请缩小日期范围后再试")
            text_bytes = connection.execute(
                "SELECT COALESCE(SUM(LENGTH(CAST(barcode AS BLOB))), 0) FROM scan_events" + where,
                args).fetchone()[0]
            if text_bytes > 32 * 1024 * 1024:
                raise ValueError("导出条码内容超过 32 MiB，请缩小日期范围后再试")
            return [dict(row) for row in connection.execute(
                "SELECT " + self._columns() + " FROM scan_events" + where
                + " ORDER BY scanned_at DESC, id DESC", args)]


class ServiceConfigurationError(RuntimeError):
    """The application has invalid or unreadable scan service settings."""


def init_app(app):
    """Allocate only in-memory state; registration must never create a database."""
    app.extensions.setdefault("pda_report", {"lock": threading.Lock(), "store": None})


def _file_settings():
    env_file = Path(__file__).resolve().parents[2] / ".env"
    try:
        lines = env_file.read_text(encoding="utf-8-sig").splitlines()
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeError) as exc:
        raise ServiceConfigurationError("无法读取扫码服务配置") from exc
    values = {}
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        if name not in ("WAREHOUSE_API_KEY", "WAREHOUSE_SCAN_DATA_DIR"):
            continue
        values[name] = value.strip().strip('"').strip("'")
    return values


def _setting(name, default=""):
    if name in current_app.config:
        return current_app.config[name]
    if name in os.environ:
        return os.environ[name]
    return _file_settings().get(name, default)


def configured_api_key():
    value = _setting("WAREHOUSE_API_KEY")
    if not isinstance(value, str) or len(value) > 256 or any(
        ord(char) < 33 or ord(char) > 126 for char in value
    ):
        raise ServiceConfigurationError("扫码服务密钥配置无效")
    return value


def default_data_dir():
    root = os.environ.get("LOCALAPPDATA")
    if root:
        return Path(root) / "WarehouseScanService"
    return Path.home() / ".local" / "share" / "warehouse-scan-service"


def database_path():
    directory = _setting("WAREHOUSE_SCAN_DATA_DIR")
    if directory is None or not isinstance(directory, (str, os.PathLike)):
        raise ServiceConfigurationError("扫码数据目录配置无效")
    if isinstance(directory, str):
        directory = directory.strip()
    try:
        return (Path(directory).expanduser() if directory else default_data_dir()) / "scan-events.sqlite3"
    except (TypeError, ValueError, OSError) as exc:
        raise ServiceConfigurationError("扫码数据目录配置无效") from exc


def get_store():
    """Create one store per Flask application, guarded against first-request races."""
    state = current_app.extensions["pda_report"]
    path = database_path()
    with state["lock"]:
        if state["store"] is None or state["store"].path != path:
            state["store"] = ServiceStore(path)
        return state["store"]
