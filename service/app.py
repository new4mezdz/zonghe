#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from flask import Flask, render_template
from flask_socketio import SocketIO
from config import Config

# 创建应用实例
app = Flask(__name__)
app.config.from_object(Config)

# 初始化文件夹
Config.init_folders()

# 初始化SocketIO
socketio = SocketIO(app, cors_allowed_origins="*")

# 注册蓝图
from modules.monitor.routes import monitor_bp
from modules.schedule.routes import schedule_bp
from modules.urldata.routes import urldata_bp
from modules.bindui.routes import bindui_bp

app.register_blueprint(monitor_bp)
app.register_blueprint(schedule_bp)
app.register_blueprint(urldata_bp)
app.register_blueprint(bindui_bp)

# 注册Socket.IO事件处理
from modules.monitor.socket_handlers import register_socket_handlers
register_socket_handlers(socketio)

# 首页路由
@app.route('/')
def index():
    return render_template('index.html')

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=True, allow_unsafe_werkzeug=True)