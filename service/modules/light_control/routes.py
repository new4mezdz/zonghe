import hmac
import os
import time
from pathlib import Path

from flask import Blueprint, jsonify, redirect, render_template, request, send_from_directory, session, url_for

from .services import LightControlUpstreamError, light_control_service


light_control_bp = Blueprint("light_control", __name__)
_STATIC_ROOT = Path(__file__).resolve().parents[2] / "static" / "light_control"
_DEFAULT_CONTROL_PASSWORD = "7887"


def _unlock_ttl():
    try:
        return max(60, min(int(os.getenv("LIGHT_CONTROL_UNLOCK_TTL_SECONDS", "1800")), 86400))
    except (TypeError, ValueError):
        return 1800


def _unlock_expires_at():
    try:
        return float(session.get("light_control_unlocked_until", 0))
    except (TypeError, ValueError):
        return 0


def _is_unlocked():
    expires_at = _unlock_expires_at()
    if expires_at > time.time():
        return True
    session.pop("light_control_unlocked_until", None)
    return False


def _require_unlock():
    if not _is_unlocked():
        return jsonify({"ok": False, "error": "控制权限已锁定，请先输入密码解锁"}), 401
    return None


def _json_error(message, status_code):
    return jsonify({"ok": False, "error": str(message)}), status_code


def _upstream_call(action):
    try:
        return jsonify(action())
    except ValueError as exc:
        return _json_error(exc, 400)
    except LightControlUpstreamError as exc:
        payload = dict(exc.payload or {})
        payload.setdefault("ok", False)
        payload["error"] = str(exc)
        status_code = exc.status_code if 400 <= exc.status_code < 600 else 502
        return jsonify(payload), status_code


@light_control_bp.after_request
def disable_light_control_api_cache(response):
    if request.path.startswith("/api/light_control/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response


@light_control_bp.route("/light_control")
def light_control_redirect():
    return redirect(url_for("light_control.light_control_page"))


@light_control_bp.route("/light_control/")
def light_control_page():
    return render_template("light_control.html")


@light_control_bp.route("/light_control/assets/<path:filename>")
def light_control_assets(filename):
    return send_from_directory(_STATIC_ROOT / "assets", filename)


@light_control_bp.route("/light_control/libs/<path:filename>")
def light_control_libs(filename):
    return send_from_directory(_STATIC_ROOT / "libs", filename)


@light_control_bp.route("/api/light_control/auth", methods=["GET"])
def light_control_auth_status():
    expires_at = _unlock_expires_at() if _is_unlocked() else 0
    return jsonify(
        {
            "ok": True,
            "unlocked": bool(expires_at),
            "expires_in": max(0, int(expires_at - time.time())),
            "password_configured": True,
        }
    )


@light_control_bp.route("/api/light_control/unlock", methods=["POST"])
def light_control_unlock():
    expected = os.getenv("LIGHT_CONTROL_PASSWORD", _DEFAULT_CONTROL_PASSWORD)

    data = request.get_json(silent=True) or {}
    supplied = str(data.get("password", ""))
    if not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8")):
        return _json_error("密码不正确", 401)

    expires_at = time.time() + _unlock_ttl()
    session["light_control_unlocked_until"] = expires_at
    return jsonify({"ok": True, "unlocked": True, "expires_in": _unlock_ttl()})


@light_control_bp.route("/api/light_control/lock", methods=["POST"])
def light_control_lock():
    session.pop("light_control_unlocked_until", None)
    return jsonify({"ok": True, "unlocked": False})


@light_control_bp.route("/api/light_control/config", methods=["GET"])
def light_control_config():
    return _upstream_call(lambda: light_control_service.get_config(force=True))


@light_control_bp.route("/api/light_control/<endpoint>", methods=["GET"])
def light_control_read_proxy(endpoint):
    allowed = {"build-info", "status", "usage", "weather"}
    if endpoint not in allowed:
        return _json_error("接口不可用", 404)
    return _upstream_call(lambda: light_control_service.request_json("/api/" + endpoint))


@light_control_bp.route("/api/light_control/connect", methods=["POST"])
def light_control_connect():
    data = request.get_json(silent=True) or {}
    return _upstream_call(lambda: light_control_service.connect_configured_device(data.get("ip")))


@light_control_bp.route("/api/light_control/toggle", methods=["POST"])
def light_control_toggle():
    locked = _require_unlock()
    if locked:
        return locked
    data = request.get_json(silent=True) or {}
    return _upstream_call(lambda: light_control_service.toggle(data))


@light_control_bp.route("/api/light_control/batch", methods=["POST"])
def light_control_batch():
    locked = _require_unlock()
    if locked:
        return locked
    data = request.get_json(silent=True) or {}
    return _upstream_call(lambda: light_control_service.batch(data))
