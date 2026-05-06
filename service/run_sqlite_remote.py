#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os
import sys

from flask import Flask, jsonify


def resource_path(rel):
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)


if hasattr(sys, "_MEIPASS"):
    sys.path.insert(0, sys._MEIPASS)

from config import Config


app = Flask(__name__, template_folder=resource_path("templates"))
app.config.from_object(Config)
Config.init_folders()

from modules.sqlite_remote.routes import sqlite_remote_bp

app.register_blueprint(sqlite_remote_bp)


@app.route("/")
def index():
    return jsonify(
        {
            "success": True,
            "message": "SQLite 远程访问服务已启动。",
            "docs": "/sqlite-remote",
        }
    )


def _env_int(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


if __name__ == "__main__":
    host = os.environ.get("SQLITE_REMOTE_HOST", "0.0.0.0")
    port = _env_int("SQLITE_REMOTE_PORT", 5004)
    debug = os.environ.get("SQLITE_REMOTE_DEBUG", "").strip().lower() in {"1", "true", "yes", "on"}
    app.run(host=host, port=port, debug=debug, use_reloader=False)
