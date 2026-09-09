"""Flask routes for pending product records."""

from __future__ import annotations

import hmac
import os
from pathlib import Path

from flask import Blueprint, jsonify, render_template, request

from .services import (
    MACHINES,
    PRODUCTS,
    REASON_TYPES,
    SHIFTS,
    ValidationError,
    record_store,
)


pending_records_bp = Blueprint(
    "pending_records",
    __name__,
    url_prefix="/pending_records",
    static_folder="static",
    static_url_path="/static",
)

_DEFAULT_DELETE_PASSWORD = "7887"


def _delete_password():
    configured = os.getenv("PENDING_RECORD_DELETE_PASSWORD")
    if configured is not None:
        return configured

    env_file = Path(__file__).resolve().parents[2] / ".env"
    try:
        lines = env_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        return _DEFAULT_DELETE_PASSWORD
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == "PENDING_RECORD_DELETE_PASSWORD":
            return value.strip().strip('"').strip("'")
    return _DEFAULT_DELETE_PASSWORD


def _error(message, status_code):
    return jsonify({"success": False, "message": str(message)}), status_code


def _payload():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValidationError("请求必须使用 JSON 格式")
    return data


@pending_records_bp.after_request
def disable_pending_records_api_cache(response):
    if request.path.startswith("/pending_records/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response


@pending_records_bp.route("")
@pending_records_bp.route("/")
def pending_records_page():
    return render_template("pending_records.html")


@pending_records_bp.route("/print")
def pending_records_print_page():
    return render_template("pending_records_print.html")


@pending_records_bp.route("/api/config")
def pending_records_config():
    return jsonify(
        {
            "success": True,
            "products": PRODUCTS,
            "machines": MACHINES,
            "reason_types": REASON_TYPES,
            "shifts": SHIFTS,
        }
    )


@pending_records_bp.route("/api/next-number")
def pending_records_next_number():
    try:
        record_no = record_store.next_number(request.args.get("date", ""))
        return jsonify({"success": True, "record_no": record_no})
    except ValidationError as exc:
        return _error(exc.message, 400)


@pending_records_bp.route("/api/records", methods=["GET"])
def pending_records_list():
    try:
        records = record_store.list(
            query=request.args.get("q", ""),
            date_from=request.args.get("date_from", ""),
            date_to=request.args.get("date_to", ""),
            status=request.args.get("status", ""),
            shift=request.args.get("shift", ""),
            limit=request.args.get("limit", 200),
        )
        return jsonify({"success": True, "records": records})
    except (ValidationError, TypeError, ValueError) as exc:
        message = exc.message if isinstance(exc, ValidationError) else "请求参数不正确"
        return _error(message, 400)


@pending_records_bp.route("/api/pending-summary", methods=["GET"])
def pending_records_summary():
    return jsonify({"success": True, "summary": record_store.pending_summary()})


@pending_records_bp.route("/api/records/<int:record_id>", methods=["GET"])
def pending_records_get(record_id):
    try:
        return jsonify({"success": True, "record": record_store.get(record_id)})
    except KeyError:
        return _error("记录不存在", 404)


@pending_records_bp.route("/api/records", methods=["POST"])
def pending_records_create():
    try:
        record = record_store.create(_payload())
        return jsonify({"success": True, "record": record}), 201
    except ValidationError as exc:
        return _error(exc.message, 400)


@pending_records_bp.route("/api/records/<int:record_id>", methods=["PUT"])
def pending_records_update(record_id):
    try:
        record = record_store.update(record_id, _payload())
        return jsonify({"success": True, "record": record})
    except ValidationError as exc:
        return _error(exc.message, 400)
    except KeyError:
        return _error("记录不存在", 404)


@pending_records_bp.route(
    "/api/records/<int:record_id>/quantity-additions", methods=["POST"]
)
def pending_records_add_quantity(record_id):
    try:
        record = record_store.add_quantity(record_id, _payload())
        return jsonify({"success": True, "record": record}), 201
    except ValidationError as exc:
        return _error(exc.message, 400)
    except KeyError:
        return _error("记录不存在", 404)


@pending_records_bp.route(
    "/api/records/<int:record_id>/dispositions", methods=["POST"]
)
def pending_records_add_disposition(record_id):
    try:
        record = record_store.add_disposition(record_id, _payload())
        return jsonify({"success": True, "record": record}), 201
    except ValidationError as exc:
        return _error(exc.message, 400)
    except KeyError:
        return _error("记录不存在", 404)


@pending_records_bp.route("/api/records/<int:record_id>", methods=["DELETE"])
def pending_records_delete(record_id):
    try:
        data = _payload()
    except ValidationError as exc:
        return _error(exc.message, 400)

    supplied = str(data.get("password", ""))
    if not supplied:
        return _error("请输入删除密码", 400)
    expected = _delete_password()
    if not hmac.compare_digest(
        supplied.encode("utf-8"), expected.encode("utf-8")
    ):
        return _error("删除密码不正确", 401)

    try:
        record = record_store.delete(record_id)
        return jsonify(
            {
                "success": True,
                "message": f"记录 {record['record_no']} 已删除",
                "record": record,
            }
        )
    except KeyError:
        return _error("记录不存在", 404)
