"""Data access and validation for pending product records."""

from __future__ import annotations

import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from config import Config


PRODUCTS: Tuple[str, ...] = (
    "娇子（清甜香）",
    "娇子（时代阳光）",
    "娇子（蓝时代）",
    "娇子（红格调）",
    "黄鹤楼（硬金砂）",
    "黄鹤楼（硬银紫）",
    "黄鹤楼（硬红）",
)

MACHINES: Tuple[str, ...] = tuple(f"{number}#" for number in range(1, 13))

SHIFTS: Tuple[str, ...] = ("甲班", "乙班", "丙班")

REASON_TYPES: Tuple[str, ...] = (
    "待关联",
    "关联异常",
    "待检",
    "缺陷",
    "其他",
)

RECORD_NUMBER_PATTERN = re.compile(r"^(\d{6})-(\d{3,})$")


class ValidationError(ValueError):
    """A validation error suitable for showing directly in the UI."""

    def __init__(self, message: str, fields: Optional[Dict[str, str]] = None):
        super().__init__(message)
        self.message = message
        self.fields = fields or {}


def _clean_text(value: Any, maximum: int, field_name: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValidationError(f"{field_name}格式不正确")
    value = value.strip()
    if len(value) > maximum:
        raise ValidationError(f"{field_name}不能超过{maximum}个字")
    return value


def _positive_or_zero_integer(value: Any, field_name: str) -> int:
    if value in (None, ""):
        return 0
    if isinstance(value, bool):
        raise ValidationError(f"{field_name}必须是整数")
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{field_name}必须是整数")
    if number < 0:
        raise ValidationError(f"{field_name}不能小于0")
    if number > 999999:
        raise ValidationError(f"{field_name}数值过大")
    return number


def _normalise_reasons(raw_reasons: Any) -> List[Dict[str, str]]:
    if not isinstance(raw_reasons, list):
        raise ValidationError("请至少选择一项待处理原因")

    reasons: List[Dict[str, str]] = []
    seen = set()
    for item in raw_reasons:
        if not isinstance(item, dict):
            raise ValidationError("待处理原因格式不正确")
        reason_type = _clean_text(item.get("type"), 10, "待处理原因")
        detail = _clean_text(item.get("detail"), 100, "原因说明")
        if reason_type not in REASON_TYPES:
            raise ValidationError("包含不支持的待处理原因")
        if reason_type in seen:
            continue
        if reason_type in ("待检", "缺陷", "其他") and not detail:
            raise ValidationError(f"请填写“{reason_type}”的具体说明")
        seen.add(reason_type)
        reasons.append({"type": reason_type, "detail": detail})

    if not reasons:
        raise ValidationError("请至少选择一项待处理原因")
    return reasons


def validate_record_payload(payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValidationError("提交内容格式不正确")

    raw_date = _clean_text(payload.get("record_date"), 10, "日期")
    try:
        parsed_date = date.fromisoformat(raw_date)
    except ValueError:
        raise ValidationError("请选择正确的日期")

    shift = _clean_text(payload.get("shift"), 2, "班组")
    if shift not in SHIFTS:
        raise ValidationError("请选择班组")

    product = _clean_text(payload.get("product"), 30, "牌号")
    if product not in PRODUCTS:
        raise ValidationError("请选择牌号")

    raw_machines = payload.get("machines")
    if not isinstance(raw_machines, list):
        raise ValidationError("请选择机台号")
    machines = []
    seen_machines = set()
    for machine in raw_machines:
        machine = _clean_text(machine, 3, "机台号")
        if machine not in MACHINES:
            raise ValidationError("包含不支持的机台号")
        if machine not in seen_machines:
            seen_machines.add(machine)
            machines.append(machine)
    machines.sort(key=lambda item: int(item.rstrip("#")))
    if not machines:
        raise ValidationError("请至少选择一个机台号")

    case_count = _positive_or_zero_integer(payload.get("case_count"), "件数")
    strip_count = _positive_or_zero_integer(payload.get("strip_count"), "条数")
    if case_count == 0 and strip_count == 0:
        raise ValidationError("件数和条数不能同时为0")

    custodian = _clean_text(payload.get("custodian"), 30, "存放人")
    if not custodian:
        raise ValidationError("请填写存放人")

    return {
        "record_date": parsed_date.isoformat(),
        "shift": shift,
        "product": product,
        "machines": machines,
        "case_count": case_count,
        "strip_count": strip_count,
        "custodian": custodian,
        "reasons": _normalise_reasons(payload.get("reasons")),
    }


def validate_quantity_addition_payload(payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValidationError("提交内容格式不正确")
    case_count = _positive_or_zero_integer(payload.get("case_count"), "补充件数")
    strip_count = _positive_or_zero_integer(payload.get("strip_count"), "补充条数")
    if case_count == 0 and strip_count == 0:
        raise ValidationError("补充件数和条数不能同时为0")
    return {
        "case_count": case_count,
        "strip_count": strip_count,
        "note": _clean_text(payload.get("note"), 100, "补充说明"),
    }


def validate_disposition_entry_payload(payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValidationError("提交内容格式不正确")
    case_count = _positive_or_zero_integer(payload.get("case_count"), "处理件数")
    strip_count = _positive_or_zero_integer(payload.get("strip_count"), "处理条数")
    if case_count == 0 and strip_count == 0:
        raise ValidationError("处理件数和条数不能同时为0")
    disposition = _clean_text(payload.get("disposition"), 300, "处置情况")
    disposer = _clean_text(payload.get("disposer"), 30, "处置人")
    if not disposition:
        raise ValidationError("请填写处置情况")
    if not disposer:
        raise ValidationError("请填写处置人")
    return {
        "case_count": case_count,
        "strip_count": strip_count,
        "disposition": disposition,
        "disposer": disposer,
    }


class RecordStore:
    def __init__(self, database_path: Path):
        self.database_path = Path(database_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialise()

    @contextmanager
    def _connection(self) -> Iterable[sqlite3.Connection]:
        connection = sqlite3.connect(str(self.database_path), timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 15000")
        try:
            yield connection
        finally:
            connection.close()

    def _initialise(self) -> None:
        with self._connection() as connection:
            connection.executescript(
                """
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    record_no TEXT NOT NULL UNIQUE,
                    record_month TEXT NOT NULL,
                    monthly_sequence INTEGER NOT NULL,
                    record_date TEXT NOT NULL,
                    shift TEXT NOT NULL DEFAULT '',
                    product TEXT NOT NULL,
                    machines_json TEXT NOT NULL,
                    case_count INTEGER NOT NULL DEFAULT 0,
                    strip_count INTEGER NOT NULL DEFAULT 0,
                    custodian TEXT NOT NULL,
                    reasons_json TEXT NOT NULL,
                    disposition TEXT NOT NULL DEFAULT '',
                    disposer TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(record_month, monthly_sequence)
                );
                CREATE TABLE IF NOT EXISTS record_sequences (
                    record_month TEXT PRIMARY KEY,
                    last_sequence INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS quantity_additions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    record_id INTEGER NOT NULL,
                    case_count INTEGER NOT NULL DEFAULT 0,
                    strip_count INTEGER NOT NULL DEFAULT 0,
                    note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS disposition_entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    record_id INTEGER NOT NULL,
                    case_count INTEGER NOT NULL DEFAULT 0,
                    strip_count INTEGER NOT NULL DEFAULT 0,
                    disposition TEXT NOT NULL,
                    disposer TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    source_legacy INTEGER NOT NULL DEFAULT 0,
                    FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
                );
                INSERT INTO record_sequences (record_month, last_sequence)
                SELECT record_month, MAX(monthly_sequence)
                FROM records
                GROUP BY record_month
                ON CONFLICT(record_month) DO UPDATE SET
                    last_sequence = MAX(
                        record_sequences.last_sequence,
                        excluded.last_sequence
                    );
                CREATE INDEX IF NOT EXISTS idx_records_date
                    ON records(record_date DESC, id DESC);
                CREATE INDEX IF NOT EXISTS idx_records_month
                    ON records(record_month, monthly_sequence DESC);
                CREATE INDEX IF NOT EXISTS idx_quantity_additions_record
                    ON quantity_additions(record_id, id);
                CREATE INDEX IF NOT EXISTS idx_disposition_entries_record
                    ON disposition_entries(record_id, id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_disposition_legacy_once
                    ON disposition_entries(record_id) WHERE source_legacy = 1;
                """
            )
            columns = {
                str(row["name"])
                for row in connection.execute("PRAGMA table_info(records)").fetchall()
            }
            if "shift" not in columns:
                connection.execute(
                    "ALTER TABLE records ADD COLUMN shift TEXT NOT NULL DEFAULT ''"
                )
            connection.execute(
                """
                INSERT OR IGNORE INTO disposition_entries (
                    record_id, case_count, strip_count, disposition, disposer,
                    created_at, source_legacy
                )
                SELECT id, 0, 0, disposition, disposer, updated_at, 1
                FROM records
                WHERE disposition <> ''
                """
            )
            connection.commit()

    @staticmethod
    def _month_for(record_date: str) -> str:
        return record_date[:7].replace("-", "")

    @staticmethod
    def _record_number(month: str, sequence: int) -> str:
        return f"{month}-{sequence:03d}"

    def next_number(self, record_date: str) -> str:
        try:
            parsed = date.fromisoformat(record_date)
        except (TypeError, ValueError):
            raise ValidationError("请选择正确的日期")
        month = parsed.strftime("%Y%m")
        with self._connection() as connection:
            row = connection.execute(
                "SELECT COALESCE(last_sequence, 0) + 1 AS next_sequence "
                "FROM (SELECT ? AS record_month) AS requested "
                "LEFT JOIN record_sequences USING (record_month)",
                (month,),
            ).fetchone()
        return self._record_number(month, int(row["next_sequence"]))

    def create(self, payload: Any) -> Dict[str, Any]:
        record = validate_record_payload(payload)
        record_month = self._month_for(record["record_date"])
        now = datetime.now().astimezone().isoformat(timespec="seconds")

        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT OR IGNORE INTO record_sequences "
                "(record_month, last_sequence) VALUES (?, 0)",
                (record_month,),
            )
            connection.execute(
                "UPDATE record_sequences SET last_sequence = last_sequence + 1 "
                "WHERE record_month = ?",
                (record_month,),
            )
            row = connection.execute(
                "SELECT last_sequence AS next_sequence "
                "FROM record_sequences WHERE record_month = ?",
                (record_month,),
            ).fetchone()
            sequence = int(row["next_sequence"])
            record_no = self._record_number(record_month, sequence)
            cursor = connection.execute(
                """
                INSERT INTO records (
                    record_no, record_month, monthly_sequence, record_date,
                    shift, product, machines_json, case_count, strip_count,
                    custodian, reasons_json, disposition, disposer, created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record_no,
                    record_month,
                    sequence,
                    record["record_date"],
                    record["shift"],
                    record["product"],
                    json.dumps(record["machines"], ensure_ascii=False),
                    record["case_count"],
                    record["strip_count"],
                    record["custodian"],
                    json.dumps(record["reasons"], ensure_ascii=False),
                    "",
                    "",
                    now,
                    now,
                ),
            )
            record_id = int(cursor.lastrowid)
            connection.commit()
        return self.get(record_id)

    def update(self, record_id: int, payload: Any) -> Dict[str, Any]:
        record = validate_record_payload(payload)
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        with self._connection() as connection:
            existing = connection.execute(
                "SELECT id, record_month FROM records WHERE id = ?", (record_id,)
            ).fetchone()
            if not existing:
                raise KeyError(record_id)

            new_month = self._month_for(record["record_date"])
            old_month = str(existing["record_month"])
            if new_month != old_month:
                raise ValidationError("保存后不能跨月份修改日期；请新建一条记录")

            connection.execute(
                """
                UPDATE records SET
                    record_date = ?, shift = ?, product = ?, machines_json = ?,
                    case_count = ?, strip_count = ?, custodian = ?,
                    reasons_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    record["record_date"],
                    record["shift"],
                    record["product"],
                    json.dumps(record["machines"], ensure_ascii=False),
                    record["case_count"],
                    record["strip_count"],
                    record["custodian"],
                    json.dumps(record["reasons"], ensure_ascii=False),
                    now,
                    record_id,
                ),
            )
            connection.commit()
        return self.get(record_id)

    def delete(self, record_id: int) -> Dict[str, Any]:
        with self._connection() as connection:
            existing = connection.execute(
                "SELECT * FROM records WHERE id = ?", (record_id,)
            ).fetchone()
            if not existing:
                raise KeyError(record_id)
            record = self._serialise(connection, existing)
            connection.execute("DELETE FROM records WHERE id = ?", (record_id,))
            connection.commit()
        return record

    def get(self, record_id: int) -> Dict[str, Any]:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM records WHERE id = ?", (record_id,)
            ).fetchone()
            if not row:
                raise KeyError(record_id)
            return self._serialise(connection, row)

    def add_quantity(self, record_id: int, payload: Any) -> Dict[str, Any]:
        addition = validate_quantity_addition_payload(payload)
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            exists = connection.execute(
                "SELECT id FROM records WHERE id = ?", (record_id,)
            ).fetchone()
            if not exists:
                raise KeyError(record_id)
            connection.execute(
                """
                INSERT INTO quantity_additions (
                    record_id, case_count, strip_count, note, created_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    record_id,
                    addition["case_count"],
                    addition["strip_count"],
                    addition["note"],
                    now,
                ),
            )
            connection.execute(
                "UPDATE records SET updated_at = ? WHERE id = ?", (now, record_id)
            )
            connection.commit()
        return self.get(record_id)

    def add_disposition(self, record_id: int, payload: Any) -> Dict[str, Any]:
        entry = validate_disposition_entry_payload(payload)
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM records WHERE id = ?", (record_id,)
            ).fetchone()
            if not row:
                raise KeyError(record_id)
            current = self._serialise(connection, row)
            remaining = current["remaining_quantity"]
            if entry["case_count"] > remaining["case_count"]:
                raise ValidationError(
                    f"处理件数不能超过剩余件数（{remaining['case_count']}件）"
                )
            if entry["strip_count"] > remaining["strip_count"]:
                raise ValidationError(
                    f"处理条数不能超过剩余条数（{remaining['strip_count']}条）"
                )
            connection.execute(
                """
                INSERT INTO disposition_entries (
                    record_id, case_count, strip_count, disposition, disposer,
                    created_at, source_legacy
                ) VALUES (?, ?, ?, ?, ?, ?, 0)
                """,
                (
                    record_id,
                    entry["case_count"],
                    entry["strip_count"],
                    entry["disposition"],
                    entry["disposer"],
                    now,
                ),
            )
            connection.execute(
                """
                UPDATE records
                SET disposition = ?, disposer = ?, updated_at = ?
                WHERE id = ?
                """,
                (entry["disposition"], entry["disposer"], now, record_id),
            )
            connection.commit()
        return self.get(record_id)

    def list(
        self,
        query: str = "",
        date_from: str = "",
        date_to: str = "",
        status: str = "",
        shift: str = "",
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        conditions: List[str] = []
        parameters: List[Any] = []

        query = query.strip()
        if query:
            like = f"%{query}%"
            conditions.append(
                "(record_no LIKE ? OR product LIKE ? OR custodian LIKE ? "
                "OR disposer LIKE ? OR shift LIKE ? OR machines_json LIKE ? "
                "OR reasons_json LIKE ?)"
            )
            parameters.extend([like] * 7)
        if date_from:
            try:
                date.fromisoformat(date_from)
            except ValueError:
                raise ValidationError("开始日期不正确")
            conditions.append("record_date >= ?")
            parameters.append(date_from)
        if date_to:
            try:
                date.fromisoformat(date_to)
            except ValueError:
                raise ValidationError("结束日期不正确")
            conditions.append("record_date <= ?")
            parameters.append(date_to)
        if status not in ("", "pending", "completed"):
            raise ValidationError("状态筛选不正确")
        if shift:
            if shift not in SHIFTS:
                raise ValidationError("班组筛选不正确")
            conditions.append("shift = ?")
            parameters.append(shift)

        safe_limit = max(1, min(int(limit), 500))
        where_clause = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        sql = (
            "SELECT * FROM records"
            + where_clause
            + " ORDER BY record_date DESC, id DESC LIMIT ?"
        )
        parameters.append(500)
        with self._connection() as connection:
            rows = connection.execute(sql, parameters).fetchall()
            records = [self._serialise(connection, row) for row in rows]
        if status:
            records = [item for item in records if item["status"] == status]
        return records[:safe_limit]

    def pending_summary(self) -> List[Dict[str, Any]]:
        placeholders = ", ".join("?" for _ in SHIFTS)
        with self._connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM records WHERE shift IN ({placeholders})",
                SHIFTS,
            ).fetchall()
            records = [self._serialise(connection, row) for row in rows]

        grouped: Dict[Tuple[str, str], Dict[str, int]] = {}
        for record in records:
            if record["status"] != "pending":
                continue
            key = (record["shift"], record["product"])
            counts = grouped.setdefault(
                key, {"record_count": 0, "case_count": 0, "strip_count": 0}
            )
            counts["record_count"] += 1
            counts["case_count"] += record["remaining_quantity"]["case_count"]
            counts["strip_count"] += record["remaining_quantity"]["strip_count"]
        summary: List[Dict[str, Any]] = []
        for shift_name in SHIFTS:
            product_rows = []
            totals = {"record_count": 0, "case_count": 0, "strip_count": 0}
            for product in PRODUCTS:
                counts = grouped.get((shift_name, product))
                if not counts:
                    continue
                item = {"product": product, **counts}
                product_rows.append(item)
                for key in totals:
                    totals[key] += counts[key]
            summary.append(
                {"shift": shift_name, "products": product_rows, **totals}
            )
        return summary

    def _serialise(
        self, connection: sqlite3.Connection, row: sqlite3.Row
    ) -> Dict[str, Any]:
        item = dict(row)
        item["machines"] = json.loads(item.pop("machines_json"))
        item["reasons"] = json.loads(item.pop("reasons_json"))
        addition_rows = connection.execute(
            """
            SELECT id, case_count, strip_count, note, created_at
            FROM quantity_additions
            WHERE record_id = ? ORDER BY id
            """,
            (item["id"],),
        ).fetchall()
        disposition_rows = connection.execute(
            """
            SELECT id, case_count, strip_count, disposition, disposer,
                   created_at, source_legacy
            FROM disposition_entries
            WHERE record_id = ? ORDER BY id
            """,
            (item["id"],),
        ).fetchall()
        additions = [dict(addition) for addition in addition_rows]
        dispositions = [dict(entry) for entry in disposition_rows]

        added_case_count = sum(int(entry["case_count"]) for entry in additions)
        added_strip_count = sum(int(entry["strip_count"]) for entry in additions)
        processed_case_count = sum(
            int(entry["case_count"]) for entry in dispositions
        )
        processed_strip_count = sum(
            int(entry["strip_count"]) for entry in dispositions
        )
        total_case_count = int(item["case_count"]) + added_case_count
        total_strip_count = int(item["strip_count"]) + added_strip_count
        remaining_case_count = max(0, total_case_count - processed_case_count)
        remaining_strip_count = max(0, total_strip_count - processed_strip_count)

        item["quantity_additions"] = additions
        item["disposition_entries"] = dispositions
        item["initial_quantity"] = {
            "case_count": int(item["case_count"]),
            "strip_count": int(item["strip_count"]),
        }
        item["added_quantity"] = {
            "case_count": added_case_count,
            "strip_count": added_strip_count,
        }
        item["total_quantity"] = {
            "case_count": total_case_count,
            "strip_count": total_strip_count,
        }
        item["processed_quantity"] = {
            "case_count": processed_case_count,
            "strip_count": processed_strip_count,
        }
        item["remaining_quantity"] = {
            "case_count": remaining_case_count,
            "strip_count": remaining_strip_count,
        }
        if dispositions:
            item["disposition"] = dispositions[-1]["disposition"]
            item["disposer"] = dispositions[-1]["disposer"]
        item["status"] = (
            "completed"
            if remaining_case_count == 0 and remaining_strip_count == 0
            else "pending"
        )
        return item


def default_database_path() -> Path:
    configured = os.getenv("PENDING_RECORD_DB_PATH", "").strip()
    return Path(configured) if configured else Path(Config.DATA_FOLDER) / "pending_records.db"


record_store = RecordStore(default_database_path())
