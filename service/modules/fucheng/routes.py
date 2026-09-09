import sqlite3

from flask import Blueprint, jsonify, render_template, request

from .services import fucheng_service


fucheng_bp = Blueprint("fucheng", __name__)


@fucheng_bp.route("/fucheng")
def fucheng_page():
    return render_template("fucheng.html")


@fucheng_bp.route("/api/fucheng/status", methods=["GET"])
def fucheng_status():
    return jsonify(fucheng_service.get_status())


@fucheng_bp.route("/api/fucheng/filters", methods=["GET"])
def fucheng_filters():
    try:
        return jsonify(fucheng_service.get_filter_options())
    except FileNotFoundError as exc:
        return jsonify({"success": False, "error": str(exc)}), 404
    except sqlite3.Error as exc:
        return jsonify({"success": False, "error": f"复称数据库读取失败: {exc}"}), 400


@fucheng_bp.route("/api/fucheng/query", methods=["POST"])
def fucheng_query():
    data = request.get_json(silent=True) or {}
    try:
        result = fucheng_service.query(
            start_date=data.get("start_date"),
            end_date=data.get("end_date"),
            record_type=data.get("record_type"),
            record_types=data.get("record_types"),
            brand=data.get("brand"),
            keyword=data.get("keyword"),
            threshold=data.get("threshold"),
            limit=data.get("limit"),
            order=data.get("order", "asc"),
        )
        return jsonify(result)
    except FileNotFoundError as exc:
        return jsonify({"success": False, "error": str(exc)}), 404
    except sqlite3.Error as exc:
        return jsonify({"success": False, "error": f"复称数据库读取失败: {exc}"}), 400
