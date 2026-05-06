import sqlite3
from functools import wraps

from flask import Blueprint, jsonify, request

from .services import sqlite_remote_service


sqlite_remote_bp = Blueprint("sqlite_remote", __name__)


def require_sqlite_token(view_func):
    @wraps(view_func)
    def wrapper(*args, **kwargs):
        auth_error = sqlite_remote_service.authorize_request(request)
        if auth_error:
            message, status_code = auth_error
            return jsonify({"success": False, "error": message}), status_code
        return view_func(*args, **kwargs)

    return wrapper


@sqlite_remote_bp.route("/sqlite-remote", methods=["GET"])
def sqlite_remote_info():
    return jsonify(
        {
            "success": True,
            "message": "SQLite 远程访问服务已启动。",
            "auth": {
                "required": not sqlite_remote_service.allow_anonymous,
                "header": "X-API-Token or Authorization: Bearer <token>",
            },
            "endpoints": {
                "health": "/api/sqlite/health",
                "tables": "/api/sqlite/tables",
                "schema": "/api/sqlite/schema/<table_name>",
                "rows": "/api/sqlite/table/<table_name>/rows",
                "query": "/api/sqlite/query",
                "execute": "/api/sqlite/execute",
            },
        }
    )


@sqlite_remote_bp.route("/api/sqlite/health", methods=["GET"])
@require_sqlite_token
def sqlite_health():
    info = sqlite_remote_service.get_service_info()
    info["tables"] = len(sqlite_remote_service.list_objects()) if info["db_exists"] else 0
    return jsonify({"success": True, "service": info})


@sqlite_remote_bp.route("/api/sqlite/tables", methods=["GET"])
@require_sqlite_token
def sqlite_tables():
    return jsonify({"success": True, "tables": sqlite_remote_service.list_objects()})


@sqlite_remote_bp.route("/api/sqlite/schema/<string:table_name>", methods=["GET"])
@require_sqlite_token
def sqlite_schema(table_name):
    try:
        schema = sqlite_remote_service.get_schema(table_name)
        return jsonify({"success": True, "schema": schema})
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 404
    except FileNotFoundError as exc:
        return jsonify({"success": False, "error": str(exc)}), 404


@sqlite_remote_bp.route("/api/sqlite/table/<string:table_name>/rows", methods=["GET"])
@require_sqlite_token
def sqlite_rows(table_name):
    try:
        data = sqlite_remote_service.fetch_rows(
            table_name,
            limit=request.args.get("limit"),
            offset=request.args.get("offset", 0),
            order_by=request.args.get("order_by"),
            order=request.args.get("order", "desc"),
        )
        return jsonify({"success": True, **data})
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except FileNotFoundError as exc:
        return jsonify({"success": False, "error": str(exc)}), 404


@sqlite_remote_bp.route("/api/sqlite/query", methods=["POST"])
@require_sqlite_token
def sqlite_query():
    payload = request.get_json(silent=True) or {}
    try:
        result = sqlite_remote_service.run_query(
            sql=payload.get("sql", ""),
            params=payload.get("params"),
            limit=payload.get("limit"),
        )
        return jsonify({"success": True, **result})
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except PermissionError as exc:
        return jsonify({"success": False, "error": str(exc)}), 403
    except FileNotFoundError as exc:
        return jsonify({"success": False, "error": str(exc)}), 404
    except sqlite3.Error as exc:
        return jsonify({"success": False, "error": f"SQL 执行失败: {exc}"}), 400


@sqlite_remote_bp.route("/api/sqlite/execute", methods=["POST"])
@require_sqlite_token
def sqlite_execute():
    payload = request.get_json(silent=True) or {}
    try:
        result = sqlite_remote_service.execute(
            sql=payload.get("sql", ""),
            params=payload.get("params"),
        )
        return jsonify({"success": True, **result})
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except PermissionError as exc:
        return jsonify({"success": False, "error": str(exc)}), 403
    except FileNotFoundError as exc:
        return jsonify({"success": False, "error": str(exc)}), 404
    except sqlite3.Error as exc:
        return jsonify({"success": False, "error": f"SQL 执行失败: {exc}"}), 400
