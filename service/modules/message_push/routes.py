from flask import Blueprint, jsonify, render_template, request

from .services import message_push_service


message_push_bp = Blueprint("message_push", __name__)


@message_push_bp.after_request
def add_message_push_api_headers(response):
    if request.path.startswith("/api/message_push/"):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization,X-API-Token"
    return response


@message_push_bp.route("/message_push")
def message_push_page():
    return render_template("message_push.html")


@message_push_bp.route("/message_push/docs")
def message_push_docs_page():
    return render_template("message_push_docs.html")


@message_push_bp.route("/api/message_push/submit", methods=["POST"])
def submit_message_push():
    data = request.get_json(silent=True) or {}
    result = message_push_service.create_message(
        push_time=data.get("push_time"),
        machine_no=data.get("machine_no"),
        content=data.get("content"),
    )
    if not result.get("success"):
        return jsonify(result), 400
    return jsonify(result)


@message_push_bp.route("/api/message_push/list", methods=["GET"])
def list_message_push():
    return jsonify(message_push_service.list_messages(request.args.get("limit", 50)))


@message_push_bp.route("/api/message_push/messages", methods=["GET"])
def query_message_push():
    result = message_push_service.query_messages(
        machine_no=request.args.get("machine_no"),
        start_time=request.args.get("start_time"),
        end_time=request.args.get("end_time"),
        keyword=request.args.get("keyword"),
        limit=request.args.get("limit", 50),
        offset=request.args.get("offset", 0),
        order=request.args.get("order", "desc"),
    )
    return jsonify(result)


@message_push_bp.route("/api/message_push/messages/<int:record_id>", methods=["GET"])
def get_message_push(record_id):
    result = message_push_service.get_message(record_id)
    if not result.get("success"):
        return jsonify(result), 404
    return jsonify(result)


@message_push_bp.route("/api/message_push/docs", methods=["GET"])
def message_push_api_docs():
    result = message_push_service.get_api_info()
    result["base_url"] = request.host_url.rstrip("/")
    return jsonify(result)
