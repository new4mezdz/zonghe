import math
import os
import re
import sqlite3
from contextlib import closing
from pathlib import Path


DEFAULT_DB_PATH = r"E:\shenchan\复称_EXE免Python最终版_20260720\复称_EXE版\fucheng_data.db"
TABLE_NAME = "fucheng_detail"
DEFAULT_DIFF_THRESHOLD = 0.1


def _env_int(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class FuchengService:
    """复称数据查询服务。"""

    DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")

    def __init__(self):
        db_path = os.environ.get("FUCHENG_DB_PATH", DEFAULT_DB_PATH)
        self.db_path = Path(db_path).expanduser()
        self.max_rows = max(1, min(_env_int("FUCHENG_MAX_ROWS", 1000), 10000))

    def _connect(self):
        if not self.db_path.exists():
            raise FileNotFoundError(f"复称数据库文件不存在: {self.db_path}")
        conn = sqlite3.connect(str(self.db_path), timeout=5, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA query_only=ON")
        return conn

    def _table_exists(self):
        if not self.db_path.exists():
            return False
        with closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                (TABLE_NAME,),
            ).fetchone()
        return row is not None

    def _fetch_raw_rows(self):
        with closing(self._connect()) as conn:
            rows = conn.execute(
                f"SELECT * FROM {TABLE_NAME} ORDER BY id ASC"
            ).fetchall()
        return [dict(row) for row in rows]

    def _to_float(self, value):
        if value is None or value == "":
            return None
        try:
            return float(str(value).strip())
        except (TypeError, ValueError):
            return None

    def _is_datetime(self, value):
        return bool(value and self.DATETIME_RE.match(str(value).strip()))

    def _clean_text(self, value):
        if value is None:
            return ""
        return str(value).strip()

    def _clean_values(self, values):
        if values is None:
            return []
        if isinstance(values, str):
            values = [values]
        if not isinstance(values, (list, tuple, set)):
            return []
        cleaned = []
        for value in values:
            text = self._clean_text(value)
            if text:
                cleaned.append(text)
        return cleaned

    def _normalize_rows(self, raw_rows):
        rows = []
        current_type = ""
        current_brand = ""
        current_rescale_date = ""

        for raw in raw_rows:
            record_type = self._clean_text(raw.get("record_type"))
            brand = self._clean_text(raw.get("brand"))
            pack_code_weight = raw.get("pack_code_weight")
            pack_code_time = self._clean_text(raw.get("pack_code_time"))
            rescale_weight = raw.get("rescale_weight")
            rescale_time = self._clean_text(raw.get("rescale_time"))
            weight_diff = raw.get("weight_diff")

            shifted_row = (
                pack_code_weight is None
                and rescale_weight is None
                and not self._is_datetime(pack_code_time)
                and not self._is_datetime(rescale_time)
            )

            if shifted_row:
                # 来源表的“类型”列是合并单元格时，后续行会整体左移一列。
                display_type = current_type
                display_brand = record_type or current_brand
                display_pack_weight = self._to_float(brand)
                display_pack_time = ""
                display_rescale_weight = self._to_float(pack_code_time)
                display_rescale_time = ""
                display_diff = self._to_float(rescale_time)
                display_rescale_date = current_rescale_date
            else:
                display_type = record_type or current_type
                display_brand = brand or current_brand
                display_pack_weight = self._to_float(pack_code_weight)
                display_pack_time = pack_code_time
                display_rescale_weight = self._to_float(rescale_weight)
                display_rescale_time = rescale_time
                display_diff = self._to_float(weight_diff)
                display_rescale_date = (
                    display_rescale_time[:10]
                    if self._is_datetime(display_rescale_time)
                    else ""
                )
                current_rescale_date = display_rescale_date
                if display_type:
                    current_type = display_type
                if display_brand:
                    current_brand = display_brand

            if display_type:
                current_type = display_type
            if display_brand:
                current_brand = display_brand

            rows.append(
                {
                    "id": raw.get("id"),
                    "record_type": display_type,
                    "brand": display_brand,
                    "pack_code_weight": display_pack_weight,
                    "pack_code_time": display_pack_time,
                    "rescale_weight": display_rescale_weight,
                    "rescale_time": display_rescale_time,
                    "rescale_query_date": display_rescale_date,
                    "weight_diff": display_diff,
                    "source_start_date": self._clean_text(raw.get("source_start_date")),
                    "source_end_date": self._clean_text(raw.get("source_end_date")),
                    "created_at": self._clean_text(raw.get("created_at")),
                    "updated_at": self._clean_text(raw.get("updated_at")),
                    "is_shifted": shifted_row,
                }
            )

        return rows

    def _matches_date(self, row, start_date, end_date):
        if not start_date and not end_date:
            return True
        date_value = self._clean_text(row.get("rescale_query_date"))
        if not date_value or not self.DATETIME_RE.match(date_value):
            return False
        if start_date and date_value < start_date:
            return False
        if end_date and date_value > end_date:
            return False
        return True

    def _matches_keyword(self, row, keyword):
        if not keyword:
            return True
        keyword = keyword.lower()
        fields = (
            row.get("record_type"),
            row.get("brand"),
            row.get("pack_code_time"),
            row.get("rescale_time"),
            row.get("source_start_date"),
            row.get("source_end_date"),
        )
        return any(keyword in str(value or "").lower() for value in fields)

    def _sanitize_threshold(self, value):
        if value is None or value == "":
            return DEFAULT_DIFF_THRESHOLD
        try:
            parsed = abs(float(value))
        except (TypeError, ValueError):
            return DEFAULT_DIFF_THRESHOLD
        if not math.isfinite(parsed):
            return DEFAULT_DIFF_THRESHOLD
        return min(parsed, 1000000.0)

    def _is_over_threshold(self, value, threshold):
        return value is not None and abs(value) - threshold > 1e-9

    def _build_stats(self, rows, threshold):
        diffs = [row["weight_diff"] for row in rows if row.get("weight_diff") is not None]
        pack_code_weight_total = math.fsum(
            row["pack_code_weight"]
            for row in rows
            if row.get("pack_code_weight") is not None
        )
        rescale_weight_total = math.fsum(
            row["rescale_weight"]
            for row in rows
            if row.get("rescale_weight") is not None
        )
        positive = sum(1 for value in diffs if value > 0)
        negative = sum(1 for value in diffs if value < 0)
        zero = sum(1 for value in diffs if value == 0)
        over_threshold = sum(
            1
            for row in rows
            if self._is_over_threshold(row.get("weight_diff"), threshold)
        )
        in_threshold = len(rows) - over_threshold
        over_threshold_rate = (over_threshold / len(rows) * 100) if rows else 0
        max_abs_diff = max((abs(value) for value in diffs), default=0)
        return {
            "total": len(rows),
            "positive": positive,
            "negative": negative,
            "zero": zero,
            "pack_code_weight_total": pack_code_weight_total,
            "rescale_weight_total": rescale_weight_total,
            "threshold": threshold,
            "over_threshold": over_threshold,
            "in_threshold": in_threshold,
            "over_threshold_rate": over_threshold_rate,
            "max_abs_diff": max_abs_diff,
        }

    def _sanitize_limit(self, value):
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = self.max_rows
        return max(1, min(parsed, self.max_rows))

    def _group_and_sort_rows(self, rows, order):
        grouped = {}
        type_order = []
        for row in rows:
            record_type = row.get("record_type") or ""
            if record_type not in grouped:
                grouped[record_type] = []
                type_order.append(record_type)
            grouped[record_type].append(row)

        descending = str(order).lower() == "desc"
        result = []
        for record_type in type_order:
            type_rows = grouped[record_type]
            type_rows.sort(
                key=lambda row: (
                    row.get("rescale_query_date") or "",
                    row.get("id") or 0,
                ),
                reverse=descending,
            )
            result.extend(type_rows)
        return result

    def query(
        self,
        start_date=None,
        end_date=None,
        record_type=None,
        record_types=None,
        brand=None,
        keyword=None,
        threshold=None,
        limit=None,
        order="asc",
    ):
        raw_rows = self._fetch_raw_rows()
        rows = self._normalize_rows(raw_rows)

        start_date = self._clean_text(start_date)
        end_date = self._clean_text(end_date)
        record_type_values = self._clean_values(record_types)
        if not record_type_values:
            record_type_values = self._clean_values(record_type)
        record_type_set = set(record_type_values)
        brand = self._clean_text(brand)
        keyword = self._clean_text(keyword)
        threshold = self._sanitize_threshold(threshold)

        filtered = []
        for row in rows:
            if record_type_set and row.get("record_type") not in record_type_set:
                continue
            if brand and row.get("brand") != brand:
                continue
            if not self._matches_date(row, start_date, end_date):
                continue
            if not self._matches_keyword(row, keyword):
                continue
            filtered.append(row)

        filtered = self._group_and_sort_rows(filtered, order)
        limited_rows = filtered[: self._sanitize_limit(limit)]
        return {
            "success": True,
            "rows": limited_rows,
            "stats": self._build_stats(filtered, threshold),
            "returned": len(limited_rows),
            "truncated": len(limited_rows) < len(filtered),
            "db_path": str(self.db_path),
        }

    def get_filter_options(self):
        rows = self._normalize_rows(self._fetch_raw_rows())
        types = sorted({row["record_type"] for row in rows if row.get("record_type")})
        brands = sorted({row["brand"] for row in rows if row.get("brand")})
        return {"success": True, "types": types, "brands": brands}

    def get_status(self):
        info = {
            "success": True,
            "db_path": str(self.db_path),
            "db_exists": self.db_path.exists(),
            "table": TABLE_NAME,
            "table_exists": False,
            "total": 0,
            "modified_at": "",
        }
        if not self.db_path.exists():
            return info
        stat = self.db_path.stat()
        info["modified_at"] = stat.st_mtime
        try:
            info["table_exists"] = self._table_exists()
            if info["table_exists"]:
                with closing(self._connect()) as conn:
                    info["total"] = conn.execute(f"SELECT COUNT(*) FROM {TABLE_NAME}").fetchone()[0]
        except sqlite3.Error as exc:
            info["success"] = False
            info["error"] = str(exc)
        return info


fucheng_service = FuchengService()
