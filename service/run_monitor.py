#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys, os, threading

def resource_path(rel):
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)

if hasattr(sys, '_MEIPASS'):
    sys.path.insert(0, sys._MEIPASS)

from flask import Flask, redirect
from flask_socketio import SocketIO
from config import Config

app = Flask(__name__, template_folder=resource_path('templates'))
app.config.from_object(Config)
Config.init_folders()

socketio = SocketIO(app, cors_allowed_origins="*")

from modules.monitor.routes import monitor_bp
app.register_blueprint(monitor_bp)

from modules.monitor.socket_handlers import register_socket_handlers
register_socket_handlers(socketio)

@app.route('/')
def index():
    return redirect('/monitor')

PORT = 5001

def start_flask():
    socketio.run(app, host='127.0.0.1', port=PORT, debug=False,
                 allow_unsafe_werkzeug=True, use_reloader=False)

if __name__ == '__main__':
    t = threading.Thread(target=start_flask, daemon=True)
    t.start()

    import time
    time.sleep(1.2)  # 等 Flask 起来

    import webview
    webview.create_window('文本实时监控', f'http://127.0.0.1:{PORT}',
                          width=1400, height=900)
    webview.start()