#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys, os, threading

def resource_path(rel):
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)

if hasattr(sys, '_MEIPASS'):
    sys.path.insert(0, sys._MEIPASS)

from flask import Flask, redirect
from config import Config

app = Flask(__name__, template_folder=resource_path('templates'))
app.config.from_object(Config)
Config.init_folders()

from modules.urldata.routes import urldata_bp
app.register_blueprint(urldata_bp)

@app.route('/')
def index():
    return redirect('/urldata')

PORT = 5003

def start_flask():
    app.run(host='127.0.0.1', port=PORT, debug=False, use_reloader=False)

if __name__ == '__main__':
    t = threading.Thread(target=start_flask, daemon=True)
    t.start()

    import time
    time.sleep(1.0)

    import webview
    webview.create_window('盒膜轨迹跟踪', f'http://127.0.0.1:{PORT}',
                          width=1400, height=900)
    webview.start()