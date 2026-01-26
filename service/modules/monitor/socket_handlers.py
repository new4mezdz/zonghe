from .services import init_tcp_service, monitor_service, history_service
import modules.monitor.services as services


def register_socket_handlers(socketio):
    """注册所有Socket.IO事件处理器"""

    # 初始化TCP服务
    tcp_service = init_tcp_service(socketio)
    services.tcp_service = tcp_service

    @socketio.on('tcp_server_start')
    def handle_server_start(data):
        """启动TCP服务器"""
        ip = data.get('ip', '0.0.0.0')
        port = int(data.get('port', 8080))

        result = tcp_service.start_server(ip, port)

        if result['success']:
            socketio.emit('tcp_status', {
                'channel': 'server',
                'status': 'listening',
                'msg': result['msg']
            })
        else:
            socketio.emit('tcp_status', {
                'channel': 'server',
                'status': 'error',
                'msg': result['msg']
            })

    @socketio.on('tcp_server_stop')
    def handle_server_stop():
        """停止TCP服务器"""
        tcp_service.stop_server()
        socketio.emit('tcp_status', {
            'channel': 'server',
            'status': 'disconnected',
            'msg': '服务器已停止'
        })

    @socketio.on('tcp_client_connect')
    def handle_client_connect(data):
        """TCP客户端连接"""
        ip = data.get('ip', '127.0.0.1')
        port = int(data.get('port', 9000))

        result = tcp_service.connect_client(ip, port)

        if result['success']:
            socketio.emit('tcp_status', {
                'channel': 'client',
                'status': 'connected',
                'msg': result['msg']
            })
        else:
            socketio.emit('tcp_status', {
                'channel': 'client',
                'status': 'error',
                'msg': result['msg']
            })

    @socketio.on('tcp_client_disconnect')
    def handle_client_disconnect():
        """TCP客户端断开"""
        tcp_service.disconnect_client()
        socketio.emit('tcp_status', {
            'channel': 'client',
            'status': 'disconnected',
            'msg': '已断开连接'
        })

    @socketio.on('tcp_send')
    def handle_tcp_send(data):
        """发送TCP数据"""
        channel = data.get('channel', 'client')
        content = data.get('content', '')
        is_hex = data.get('hex', False)
        append_newline = data.get('newline', False)

        result = tcp_service.send_data(channel, content, is_hex, append_newline)

        if result['success']:
            # 添加到发送历史
            history_service.add(content.rstrip('\r\n'))

            socketio.emit('tcp_sent', {
                'channel': channel,
                'data': result['data'],
                'hex': result['hex'],
                'length': result['length'],
                'time': result['time']
            })

            # 检查黑名单
            found = monitor_service.check_data_against_blacklist(content)
            if found:
                socketio.emit('blacklist_alert', {
                    'items': found,
                    'data': content
                })
        else:
            socketio.emit('tcp_status', {
                'channel': channel,
                'status': 'error',
                'msg': result['msg']
            })

    @socketio.on('tcp_get_status')
    def handle_tcp_get_status():
        """获取所有TCP连接状态"""
        server_status, client_status = tcp_service.get_status()
        socketio.emit('tcp_status', server_status)
        socketio.emit('tcp_status', client_status)