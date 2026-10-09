"""Flask adapter for the existing PDA HTTP protocol."""

from __future__ import annotations

import csv
import hmac
import io
import json
import sqlite3
from urllib.parse import parse_qs

from flask import Blueprint, Response, current_app, jsonify, render_template, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from .reader import ReaderBusyError, ReaderStorageError, get_reader

from .services import (
    EventConflict,
    ServiceConfigurationError,
    configured_api_key,
    get_store,
    init_app,
    validate_filters,
)


MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_READER_CONFIG_BYTES = 16 * 1024
pda_report_bp = Blueprint(
    "pda_report", __name__, static_folder="static", static_url_path="/pda_report/static"
)


@pda_report_bp.record_once
def register_service(state):
    init_app(state.app)


@pda_report_bp.after_request
def add_response_headers(response):
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; "
        "img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    )
    return response


def _error(message, status):
    return jsonify({"ok": False, "error": str(message)}), status


@pda_report_bp.errorhandler(ServiceConfigurationError)
def configuration_error(error):
    return _error(error, 503)


@pda_report_bp.errorhandler(RequestEntityTooLarge)
def request_too_large(_error_value):
    return _error("扫码请求正文过大或为空", 413)


@pda_report_bp.errorhandler(BadRequest)
def invalid_request(_error_value):
    return _error("请求正文不完整或请求格式无效", 400)


@pda_report_bp.errorhandler(ReaderBusyError)
def reader_busy(error):
    return _error(error, 409)


@pda_report_bp.errorhandler(ReaderStorageError)
def reader_storage_error(error):
    return _error(error, 503)


def _require_api_key():
    expected = configured_api_key()
    if not expected:
        return None
    provided = request.headers.getlist("X-API-Key")
    if len(provided) != 1 or not hmac.compare_digest(
        provided[0].encode("utf-8"), expected.encode("utf-8")
    ):
        return _error("服务需要正确的 API 密钥", 401)
    return None


def _unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON 字段不能重复")
        result[key] = value
    return result


def _query():
    try:
        query = parse_qs(
            request.query_string.decode("utf-8"), keep_blank_values=True, max_num_fields=16
        )
    except UnicodeError as exc:
        raise ValueError("查询参数必须使用 UTF-8 编码") from exc
    if any(len(values) != 1 for values in query.values()):
        raise ValueError("查询参数不能重复")
    allowed = {"keyword", "start_date", "end_date", "source", "operation", "page", "page_size"}
    if query.keys() - allowed:
        raise ValueError("包含不支持的查询参数")
    return {key: values[0] for key, values in query.items()}


@pda_report_bp.route("/pda_report")
@pda_report_bp.route("/pda_report/")
def report_page():
    return render_template("pda_report.html")


@pda_report_bp.route("/api/health")
def health():
    return jsonify({
        "ok": True, "service": "warehouse-scan", "api_version": 1,
        "auth_required": bool(configured_api_key()), "report_timezone": "Asia/Shanghai",
    })


@pda_report_bp.route("/api/reader/status")
def reader_status():
    auth_error = _require_api_key()
    if auth_error is not None:
        return auth_error
    return jsonify(get_reader().snapshot())


def _reader_command(action):
    auth_error = _require_api_key()
    if auth_error is not None:
        return auth_error
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        return _error("请在综合服务页面操作读码器", 403)
    if request.mimetype != "application/json":
        return _error("请使用 application/json", 415)
    if request.headers.get("Content-Encoding", "identity").lower() != "identity":
        return _error("不支持压缩请求正文", 415)
    if request.content_length is not None and request.content_length > MAX_READER_CONFIG_BYTES:
        return _error("读码器设置正文超过 16 KiB", 413)
    try:
        raw = request.stream.read(MAX_READER_CONFIG_BYTES + 1)
        if len(raw) > MAX_READER_CONFIG_BYTES:
            return _error("读码器设置正文超过 16 KiB", 413)
        try:
            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_json)
        except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
            raise ValueError("请求正文不是有效的 UTF-8 JSON") from exc
        if not isinstance(payload, dict):
            raise ValueError("请求正文必须是 JSON 对象")
        if action == "configure":
            if "enabled" in payload:
                raise ValueError("请使用连接采集或停止采集按钮修改启停状态")
        elif payload:
            raise ValueError("启停请求正文应为一个空 JSON 对象")
        return jsonify(getattr(get_reader(), action)(payload) if action == "configure"
                       else getattr(get_reader(), action)())
    except ValueError as exc:
        return _error(exc, 400)


@pda_report_bp.route("/api/reader/config", methods=["POST"])
def reader_config():
    return _reader_command("configure")


@pda_report_bp.route("/api/reader/start", methods=["POST"])
def reader_start():
    return _reader_command("start")


@pda_report_bp.route("/api/reader/stop", methods=["POST"])
def reader_stop():
    return _reader_command("stop")


@pda_report_bp.route("/api/scans", methods=["POST"])
def ingest_scan():
    if request.query_string:
        return _error("接口不存在", 404)
    auth_error = _require_api_key()
    if auth_error is not None:
        return auth_error
    if request.headers.get("Transfer-Encoding"):
        return _error("不支持分块上传，请提供 Content-Length", 400)
    lengths = request.headers.getlist("Content-Length")
    if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
        return _error("请提供有效的 Content-Length", 411)
    significant_length = lengths[0].lstrip("0") or "0"
    if len(significant_length) > len(str(MAX_BODY_BYTES)):
        return _error("扫码请求正文过大或为空", 413)
    size = int(significant_length)
    if size < 1 or size > MAX_BODY_BYTES:
        return _error("扫码请求正文过大或为空", 413)
    if request.mimetype != "application/json":
        return _error("请使用 application/json", 415)
    if request.headers.get("Content-Encoding", "identity").lower() != "identity":
        return _error("不支持压缩请求正文", 415)
    try:
        # Read only the declared, bounded body; never change the host app's limit.
        raw = request.stream.read(size)
        if len(raw) != size:
            return _error("请求正文不完整", 400)
        try:
            payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_json)
        except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
            raise ValueError("请求正文不是有效的 UTF-8 JSON") from exc
        result = get_store().ingest(payload)
        return jsonify(result), 200 if result["duplicate"] else 201
    except EventConflict as exc:
        return _error(exc, 409)
    except ValueError as exc:
        return _error(exc, 400)
    except TimeoutError:
        return _error("上传超时，请使用相同 event_id 重试", 408)
    except (sqlite3.Error, OSError):
        current_app.logger.error("PDA scan persistence failed")
        return _error("扫码记录暂时无法保存，请使用相同 event_id 重试", 503)


@pda_report_bp.route("/api/report")
def report():
    auth_error = _require_api_key()
    if auth_error is not None:
        return auth_error
    try:
        query = _query()
        filters = validate_filters(query)
        try:
            page = int(query.get("page", "1"))
            page_size = int(query.get("page_size", "50"))
        except ValueError as exc:
            raise ValueError("页码和每页数量必须是整数") from exc
        if not 1 <= page <= 10000000 or not 1 <= page_size <= 200:
            raise ValueError("页码无效或每页数量超过 200")
        return jsonify(get_store().report(filters, page, page_size))
    except ValueError as exc:
        return _error(exc, 400)
    except (sqlite3.Error, OSError):
        current_app.logger.error("PDA scan report read failed")
        return _error("服务暂时无法读取数据，请稍后再试", 503)


def _csv_text(value):
    if value.lstrip().startswith(("=", "+", "-", "@")) or value.startswith(("\t", "\r", "\n")):
        return "'" + value
    return value


@pda_report_bp.route("/api/export.csv")
def export_csv():
    auth_error = _require_api_key()
    if auth_error is not None:
        return auth_error
    try:
        filters = validate_filters(_query())
        rows = get_store().export_rows(filters)
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow([
            "记录ID", "事件ID", "条码", "来源", "操作", "扫码时间（北京时间）",
            "设备编号", "读码器地址", "读码器端口", "服务接收时间（UTC）",
        ])
        for row in rows:
            writer.writerow([
                row["id"], row["event_id"], _csv_text(row["barcode"]),
                "PDA" if row["source"] == "pda" else "读码器",
                "入库" if row["operation"] == "inbound" else "返回",
                row["local_scanned_at"], _csv_text(row["device_id"]),
                _csv_text(row["reader_host"] or ""), row["reader_port"] or "", row["received_at"],
            ])
        return Response(
            output.getvalue().encode("utf-8-sig"), content_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="warehouse-scan-events.csv"'},
        )
    except ValueError as exc:
        return _error(exc, 400)
    except (sqlite3.Error, OSError):
        current_app.logger.error("PDA scan export read failed")
        return _error("服务暂时无法读取数据，请稍后再试", 503)
