import os
import re
from contextlib import closing
from datetime import datetime
from pathlib import Path


_SERVICE_ROOT = Path(__file__).resolve().parents[2]
_ORACLE_CLIENT_DIR = _SERVICE_ROOT / "instantclient_19_31"
_ORACLE_INIT_ERROR = ""

try:
    import oracledb as _oracle_driver
    _ORACLE_DRIVER_NAME = "oracledb"
    if _ORACLE_CLIENT_DIR.is_dir():
        try:
            _oracle_driver.init_oracle_client(lib_dir=str(_ORACLE_CLIENT_DIR))
        except Exception as exc:
            _ORACLE_INIT_ERROR = f"Oracle Thick mode initialization failed: {exc}"
except Exception:
    _oracle_driver = None
    _ORACLE_DRIVER_NAME = ""
    try:
        import cx_Oracle as _oracle_driver
        _ORACLE_DRIVER_NAME = "cx_Oracle"
    except Exception:
        _oracle_driver = None


def _env_int(name, default):
    value = os.environ.get(name)
    try:
        return int(value) if value is not None else default
    except (TypeError, ValueError):
        return default


class MaterialTransferService:
    def __init__(self):
        self.host = os.environ.get("AUXILIARY_ORACLE_HOST", "10.164.62.71")
        self.port = _env_int("AUXILIARY_ORACLE_PORT", 1521)
        self.service_name = os.environ.get("AUXILIARY_ORACLE_SERVICE", "TIMMS")
        self.connect_mode = os.environ.get("AUXILIARY_ORACLE_CONNECT_MODE", "service").lower()
        self.username = os.environ.get("AUXILIARY_ORACLE_USER", "MES_ST")
        self.password = os.environ.get("AUXILIARY_ORACLE_PASSWORD", "MES_ST")
        self.view_name = self._sanitize_identifier(
            os.environ.get("AUXILIARY_TRANSFERLOGG_VIEW", "V_TRANSFERLOGG")
        )
        self.date_column = self._sanitize_identifier(
            os.environ.get("AUXILIARY_TRANSFERLOGG_DATE_COLUMN", "BGNDATE")
        )
        self.type_column = self._sanitize_identifier(
            os.environ.get("AUXILIARY_TRANSFERLOGG_TYPE_COLUMN", "TYPEDESC")
        )
        self.default_type = os.environ.get("AUXILIARY_TRANSFERLOGG_DEFAULT_TYPE", "辅料出库")
        self.max_rows = _env_int("AUXILIARY_TRANSFERLOGG_MAX_ROWS", 500)
        self.default_order = os.environ.get("AUXILIARY_TRANSFERLOGG_DEFAULT_ORDER", "desc").lower()

    def get_status(self):
        status = {
            "success": True,
            "driver": _ORACLE_DRIVER_NAME or None,
            "driver_ready": _oracle_driver is not None,
            "host": self.host,
            "port": self.port,
            "service_name": self.service_name,
            "connect_mode": self.connect_mode,
            "username": self.username,
            "view": self.view_name,
            "date_column": self.date_column,
            "type_column": self.type_column,
            "default_type": self.default_type,
            "max_rows": self.max_rows,
            "configured": bool(self.username and self.password and self.view_name),
            "connected": False,
            "error": "",
        }

        if not _oracle_driver:
            status["success"] = False
            status["error"] = "未安装Oracle驱动（oracledb/cx_Oracle），本地环境无法连接数据库。"
            return status

        try:
            with self._connect() as conn:
                with closing(conn.cursor()) as cursor:
                    cursor.execute(f"SELECT COUNT(*) AS total FROM {self._quote_identifier(self.view_name)}")
                    total = cursor.fetchone()[0]
            status["connected"] = True
            status["total"] = int(total)
        except Exception as exc:  # pragma: no cover
            status["error"] = str(exc)
            status["success"] = False
        return status

    def get_types(self):
        if not _oracle_driver:
            return {
                "success": False,
                "error": "未安装Oracle驱动（oracledb/cx_Oracle）",
            }

        sql = (
            f"SELECT DISTINCT {self._quote_identifier(self.type_column)} AS type_value "
            f"FROM {self._quote_identifier(self.view_name)} "
            f"WHERE {self._quote_identifier(self.type_column)} IS NOT NULL "
            "ORDER BY type_value"
        )
        rows, _ = self._fetch_all(sql, {})
        types = [row.get("type_value") for row in rows if row.get("type_value")]
        return {"success": True, "types": types}

    def query(self, start_date=None, end_date=None, typedesc=None, all_types=False, keyword=None, limit=None, offset=0, order=""):
        if not _oracle_driver:
            return {
                "success": False,
                "error": "未安装Oracle驱动（oracledb/cx_Oracle）",
                "rows": [],
                "total": 0,
                "returned": 0,
                "truncated": False,
            }

        types = self._normalize_types(typedesc)
        if not all_types and not types:
            types = [self.default_type]

        start_value = self._normalize_date(start_date)
        end_value = self._normalize_date(end_date)
        if start_value and end_value and start_value > end_value:
            return {
                "success": False,
                "error": "开始日期不能晚于结束日期",
                "rows": [],
                "total": 0,
                "returned": 0,
                "truncated": False,
            }

        limit_value = self._normalize_limit(limit)
        offset_value = self._normalize_offset(offset)
        order_value = self._sanitize_order(order or self.default_order)
        max_row = offset_value + limit_value

        where_clauses = ["1=1"]
        params = {}
        if types:
            placeholders = []
            for index, value in enumerate(types):
                key = f"t{index}"
                placeholders.append(f":{key}")
                params[key] = value
            where_clauses.append(
                f"{self._quote_identifier(self.type_column)} IN ({', '.join(placeholders)})"
            )

        if start_value:
            where_clauses.append(
                f"TRUNC({self._quote_identifier(self.date_column)}) >= TO_DATE(:start_date, 'YYYY-MM-DD')"
            )
            params["start_date"] = start_value

        if end_value:
            where_clauses.append(
                f"TRUNC({self._quote_identifier(self.date_column)}) <= TO_DATE(:end_date, 'YYYY-MM-DD')"
            )
            params["end_date"] = end_value

        keyword_value = self._normalize_keyword(keyword)
        if keyword_value:
            where_clauses.append(
                f"UPPER({self._quote_identifier(self.type_column)}) LIKE :keyword"
            )
            params["keyword"] = keyword_value

        where_sql = " WHERE " + " AND ".join(where_clauses)
        order_sql = self._quote_identifier(self.date_column)

        query_sql = f"""
            SELECT * FROM (
                SELECT base_row.*, ROWNUM AS rn
                FROM (
                    SELECT * FROM {self._quote_identifier(self.view_name)}{where_sql}
                    ORDER BY {order_sql} {order_value}
                ) base_row
                WHERE ROWNUM <= :max_row
            )
            WHERE rn > :offset
        """
        params["max_row"] = max_row
        params["offset"] = offset_value

        rows, _ = self._fetch_all(query_sql, params)
        total = self._count_rows(where_sql, params)
        truncated = total is not None and (offset_value + len(rows) < total)

        return {
            "success": True,
            "rows": rows,
            "total": total,
            "limit": limit_value,
            "offset": offset_value,
            "order": order_value,
            "returned": len(rows),
            "truncated": bool(truncated),
            "filters": {
                "start_date": start_value,
                "end_date": end_value,
                "typedesc": types,
                "all_types": all_types,
                "keyword": keyword_value.replace("%", "").strip() if keyword_value else "",
            },
        }

    def _count_rows(self, where_sql, params):
        if not where_sql:
            where_sql = " WHERE 1=1"
        count_sql = (
            f"SELECT COUNT(*) AS total FROM {self._quote_identifier(self.view_name)}"
            f"{where_sql}"
        )
        count_params = dict(params)
        count_params.pop("max_row", None)
        count_params.pop("offset", None)
        rows, _ = self._fetch_all(count_sql, count_params)
        if not rows:
            return 0
        return int(rows[0].get("total", 0) or 0)

    def _fetch_all(self, sql, params):
        rows = []
        description = []
        with self._connect() as conn:
            with closing(conn.cursor()) as cursor:
                cursor.execute(sql, params or {})
                if cursor.description:
                    description = [item[0] for item in cursor.description]
                    raw_rows = cursor.fetchall()
                    rows = [
                        self._zip_row(description, row) for row in raw_rows
                    ]
        return rows, description

    def _connect(self):
        if _ORACLE_INIT_ERROR:
            raise RuntimeError(_ORACLE_INIT_ERROR)

        dsn = os.environ.get("AUXILIARY_ORACLE_DSN", "").strip()
        if not dsn:
            if self.connect_mode == "sid":
                dsn = f"{self.host}:{self.port}:{self.service_name}"
            else:
                dsn = f"{self.host}:{self.port}/{self.service_name}"
        return _oracle_driver.connect(
            user=self.username,
            password=self.password,
            dsn=dsn,
        )

    def _zip_row(self, columns, row):
        result = {}
        for index, column in enumerate(columns):
            normalized = str(column).lower()
            if normalized == "rn":
                continue
            result[normalized] = self._normalize_value(row[index])
        return result

    def _normalize_value(self, value):
        if hasattr(value, "strftime"):
            return value.strftime("%Y-%m-%d %H:%M:%S")
        if isinstance(value, (bytes, bytearray)):
            try:
                return value.decode("utf-8")
            except UnicodeDecodeError:
                return value.hex()
        return value

    def _normalize_types(self, typedesc):
        if typedesc is None:
            return []
        if isinstance(typedesc, str):
            items = [item.strip() for item in typedesc.split(",")]
        elif isinstance(typedesc, (list, tuple, set)):
            items = [str(item).strip() for item in typedesc]
        else:
            return []
        return [item for item in items if item]

    def _normalize_date(self, value):
        text = str(value or "").strip()
        if not text:
            return ""
        text = text.replace("/", "-")
        if len(text) >= 10:
            text = text[:10]
        try:
            return datetime.fromisoformat(text).date().strftime("%Y-%m-%d")
        except ValueError:
            return ""

    def _normalize_keyword(self, value):
        text = str(value or "").strip()
        if not text:
            return ""
        return f"%{text.replace('%', '')}%"

    def _normalize_limit(self, value):
        parsed = self._normalize_int(value)
        if parsed <= 0:
            return self.max_rows
        return min(parsed, self.max_rows)

    def _normalize_offset(self, value):
        parsed = self._normalize_int(value)
        return max(0, parsed)

    def _normalize_int(self, value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return self.max_rows

    def _sanitize_order(self, order):
        return "desc" if str(order).lower() != "asc" else "asc"

    def _sanitize_identifier(self, identifier):
        cleaned = re.sub(r"[^A-Za-z0-9_$#\.\-]+", "", str(identifier or "").strip().upper())
        if not cleaned:
            return "V_TRANSFERLOGG"
        return cleaned

    def _quote_identifier(self, identifier):
        name = str(identifier or "").strip()
        if "." in name:
            parts = [part for part in name.split(".") if part]
            return ".".join(f'"{part}"' for part in parts)
        return f'"{name}"'


material_transfer_service = MaterialTransferService()
