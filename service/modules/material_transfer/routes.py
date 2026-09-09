from flask import Blueprint, jsonify, render_template, request

from .services import material_transfer_service


material_transfer_bp = Blueprint("material_transfer", __name__)


@material_transfer_bp.route("/material_transfer")
def material_transfer_page():
    return render_template("material_transfer.html")


@material_transfer_bp.route("/api/material_transfer/status", methods=["GET"])
def material_transfer_status():
    return jsonify(material_transfer_service.get_status())


@material_transfer_bp.route("/api/material_transfer/types", methods=["GET"])
def material_transfer_types():
    try:
        return jsonify(material_transfer_service.get_types())
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@material_transfer_bp.route("/api/material_transfer/query", methods=["POST"])
def material_transfer_query():
    payload = request.get_json(silent=True) or {}
    try:
        result = material_transfer_service.query(
            start_date=payload.get("start_date"),
            end_date=payload.get("end_date"),
            typedesc=payload.get("types"),
            all_types=bool(payload.get("all_types", False)),
            keyword=payload.get("keyword"),
            limit=payload.get("limit"),
            offset=payload.get("offset", 0),
            order=payload.get("order", "desc"),
        )
        return jsonify(result)
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500
