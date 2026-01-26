import os
import json
import socket
import threading
from datetime import datetime
from config import Config


class MonitorService:
    """文本监控服务"""

    def __init__(self):
        self.file_path = ''
        self.blacklist = set()
        self.monitoring = False
        self.last_content = ''
        self.alerted_items = set()
        self.alerts = []

    def upload_file(self, file):
        """上传监控文件"""
        filepath = os.path.join(Config.UPLOAD_FOLDER, 'monitor_' + file.filename)
        file.save(filepath)
        self.file_path = filepath
        self.alerted_items.clear()

        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        lines = [l for l in content.split('\n') if l.strip()]

        return {
            'success': True,
            'filename': file.filename,
            'line_count': len(lines),
            'content': content
        }

    def upload_blacklist(self, file):
        """上传黑名单文件"""
        filepath = os.path.join(Config.UPLOAD_FOLDER, 'blacklist_' + file.filename)
        file.save(filepath)

        with open(filepath, 'r', encoding='utf-8') as f:
            self.blacklist = set(line.strip() for line in f if line.strip())

        # 保存到data目录
        self._save_blacklist()

        return {'success': True, 'count': len(self.blacklist)}

    def _save_blacklist(self):
        """保存黑名单到文件"""
        filepath = os.path.join(Config.DATA_FOLDER, 'blacklist.json')
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(list(self.blacklist), f, ensure_ascii=False)

    def _load_blacklist(self):
        """从文件加载黑名单"""
        filepath = os.path.join(Config.DATA_FOLDER, 'blacklist.json')
        if os.path.exists(filepath):
            with open(filepath, 'r', encoding='utf-8') as f:
                self.blacklist = set(json.load(f))

    def get_blacklist(self):
        """获取黑名单"""
        return list(self.blacklist)

    def check_content(self):
        """检查文件内容"""
        if not self.file_path:
            return None, '未选择监控文件'

        try:
            with open(self.file_path, 'r', encoding='utf-8') as f:
                content = f.read()

            lines = [l.strip() for l in content.split('\n') if l.strip()]
            found = []

            if self.blacklist:
                for line in lines:
                    if line in self.blacklist and line not in self.alerted_items:
                        found.append(line)
                        self.alerted_items.add(line)

            if found:
                self.alerts.extend(found)

            return {
                'content': content,
                'line_count': len(lines),
                'alerts': found,
                'total_alerts': len(self.alerts)
            }, None
        except Exception as e:
            return None, str(e)

    def check_data_against_blacklist(self, data):
        """检查数据是否匹配黑名单"""
        if not self.blacklist:
            return []
        found = []
        for item in self.blacklist:
            if item in data:
                found.append(item)
        return found


class TCPService:
    """TCP网络调试服务"""

    def __init__(self, socketio):
        self.socketio = socketio
        self.connections = {
            'server': {
                'socket': None,
                'client_socket': None,
                'connected': False,
                'running': False,
                'client_addr': None
            },
            'client': {
                'socket': None,
                'connected': False,
                'running': False
            }
        }
        self.logs = []
        self.max_logs = 1000

    def add_log(self, channel, direction, data, hex_data, length):
        """添加日志记录"""
        log_entry = {
            'time': datetime.now().strftime('%H:%M:%S.%f')[:-3],
            'channel': channel,
            'direction': direction,
            'data': data,
            'hex': hex_data,
            'length': length
        }
        self.logs.append(log_entry)
        if len(self.logs) > self.max_logs:
            self.logs = self.logs[-self.max_logs:]
        return log_entry

    def get_logs(self):
        """获取所有日志"""
        return self.logs

    def clear_logs(self):
        """清空日志"""
        self.logs = []

    def export_logs(self):
        """导出日志"""
        content = '\n'.join(
            f"[{log['time']}][{log['channel']}-{log['direction']}] {log['data']}"
            for log in self.logs
        )
        return content

    # === 服务器相关 ===
    def start_server(self, ip, port):
        """启动TCP服务器"""
        self.stop_server()
        conn = self.connections['server']

        try:
            conn['socket'] = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            conn['socket'].setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            conn['socket'].bind((ip, port))
            conn['socket'].listen(5)
            conn['running'] = True

            threading.Thread(target=self._server_accept_thread, daemon=True).start()

            return {'success': True, 'msg': f'服务器监听中 {ip}:{port}'}
        except Exception as e:
            return {'success': False, 'msg': f'启动失败: {e}'}

    def stop_server(self):
        """停止TCP服务器"""
        conn = self.connections['server']
        conn['running'] = False
        conn['connected'] = False

        try:
            if conn['client_socket']:
                conn['client_socket'].close()
        except:
            pass

        try:
            if conn['socket']:
                conn['socket'].close()
        except:
            pass

        conn['socket'] = None
        conn['client_socket'] = None
        conn['client_addr'] = None

    def _server_accept_thread(self):
        """服务器等待客户端连接线程"""
        conn = self.connections['server']
        while conn['running']:
            try:
                conn['client_socket'], addr = conn['socket'].accept()
                conn['connected'] = True
                conn['client_addr'] = addr

                self.socketio.emit('tcp_status', {
                    'channel': 'server',
                    'status': 'connected',
                    'msg': f'客户端已连接: {addr[0]}:{addr[1]}'
                })

                self._server_receive_thread()

                if conn['running']:
                    self.socketio.emit('tcp_status', {
                        'channel': 'server',
                        'status': 'listening',
                        'msg': '等待新的客户端连接...'
                    })
            except Exception as e:
                if conn['running']:
                    print(f"服务器接受连接错误: {e}")
                break

    def _server_receive_thread(self):
        """服务器端接收数据线程"""
        conn = self.connections['server']
        while conn['connected'] and conn['client_socket']:
            try:
                data = conn['client_socket'].recv(4096)
                if data:
                    log = self.add_log('server', 'rx',
                                       data.decode('utf-8', errors='replace'),
                                       ' '.join(f'{b:02X}' for b in data),
                                       len(data)
                                       )
                    self.socketio.emit('tcp_receive', {
                        'channel': 'server',
                        'data': log['data'],
                        'hex': log['hex'],
                        'length': log['length'],
                        'time': log['time']
                    })
                else:
                    break
            except Exception as e:
                print(f"服务器接收数据错误: {e}")
                break

        conn['connected'] = False
        conn['client_socket'] = None
        conn['client_addr'] = None
        self.socketio.emit('tcp_status', {
            'channel': 'server',
            'status': 'disconnected',
            'msg': '客户端已断开'
        })

    # === 客户端相关 ===
    def connect_client(self, ip, port):
        """连接到远程服务器"""
        self.disconnect_client()
        conn = self.connections['client']

        try:
            conn['socket'] = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            conn['socket'].settimeout(5)
            conn['socket'].connect((ip, port))
            conn['socket'].settimeout(None)
            conn['connected'] = True
            conn['running'] = True

            threading.Thread(target=self._client_receive_thread, daemon=True).start()

            return {'success': True, 'msg': f'已连接到 {ip}:{port}'}
        except Exception as e:
            return {'success': False, 'msg': f'连接失败: {e}'}

    def disconnect_client(self):
        """断开客户端连接"""
        conn = self.connections['client']
        conn['connected'] = False
        conn['running'] = False

        try:
            if conn['socket']:
                conn['socket'].close()
        except:
            pass

        conn['socket'] = None

    def _client_receive_thread(self):
        """客户端接收数据线程"""
        conn = self.connections['client']
        while conn['connected'] and conn['socket']:
            try:
                data = conn['socket'].recv(4096)
                if data:
                    log = self.add_log('client', 'rx',
                                       data.decode('utf-8', errors='replace'),
                                       ' '.join(f'{b:02X}' for b in data),
                                       len(data)
                                       )
                    self.socketio.emit('tcp_receive', {
                        'channel': 'client',
                        'data': log['data'],
                        'hex': log['hex'],
                        'length': log['length'],
                        'time': log['time']
                    })
                else:
                    break
            except Exception as e:
                print(f"客户端接收数据错误: {e}")
                break

        conn['connected'] = False
        self.socketio.emit('tcp_status', {
            'channel': 'client',
            'status': 'disconnected',
            'msg': '连接已断开'
        })

    # === 发送数据 ===
    def send_data(self, channel, content, is_hex, append_newline):
        """发送TCP数据"""
        if channel == 'server':
            conn = self.connections['server']
            sock = conn.get('client_socket')
            if not conn['connected'] or not sock:
                return {'success': False, 'msg': '没有客户端连接'}
        else:
            conn = self.connections['client']
            sock = conn.get('socket')
            if not conn['connected'] or not sock:
                return {'success': False, 'msg': '未连接'}

        try:
            if is_hex:
                hex_str = content.replace(' ', '').replace('\n', '')
                send_data = bytes.fromhex(hex_str)
            else:
                if append_newline:
                    content += '\r\n'
                send_data = content.encode('utf-8')

            sock.send(send_data)

            log = self.add_log(channel, 'tx', content,
                               ' '.join(f'{b:02X}' for b in send_data),
                               len(send_data)
                               )

            return {
                'success': True,
                'data': content,
                'hex': log['hex'],
                'length': log['length'],
                'time': log['time']
            }
        except Exception as e:
            return {'success': False, 'msg': f'发送失败: {e}'}

    def get_status(self):
        """获取所有连接状态"""
        server_conn = self.connections['server']
        client_conn = self.connections['client']

        server_status = {
            'channel': 'server',
            'status': 'disconnected',
            'msg': '未启动'
        }
        if server_conn['connected']:
            addr = server_conn.get('client_addr', ('?', '?'))
            server_status = {
                'channel': 'server',
                'status': 'connected',
                'msg': f'客户端已连接: {addr[0]}:{addr[1]}'
            }
        elif server_conn['running']:
            server_status = {
                'channel': 'server',
                'status': 'listening',
                'msg': '服务器监听中...'
            }

        client_status = {
            'channel': 'client',
            'status': 'connected' if client_conn['connected'] else 'disconnected',
            'msg': '已连接' if client_conn['connected'] else '未连接'
        }

        return server_status, client_status


class ShortcutService:
    """快捷指令服务"""

    def __init__(self):
        self.filepath = os.path.join(Config.DATA_FOLDER, 'shortcuts.json')
        self.shortcuts = self._load()

    def _load(self):
        """加载快捷指令"""
        if os.path.exists(self.filepath):
            try:
                with open(self.filepath, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                pass
        return []

    def _save(self):
        """保存快捷指令"""
        with open(self.filepath, 'w', encoding='utf-8') as f:
            json.dump(self.shortcuts, f, ensure_ascii=False, indent=2)

    def get_all(self):
        """获取所有快捷指令"""
        return self.shortcuts

    def add(self, cmd):
        """添加快捷指令"""
        if cmd and cmd.strip():
            self.shortcuts.append(cmd.strip())
            self._save()
            return True
        return False

    def delete(self, index):
        """删除快捷指令"""
        if 0 <= index < len(self.shortcuts):
            self.shortcuts.pop(index)
            self._save()
            return True
        return False

    def clear(self):
        """清空所有快捷指令"""
        self.shortcuts = []
        self._save()


class HistoryService:
    """发送历史服务"""

    def __init__(self):
        self.filepath = os.path.join(Config.DATA_FOLDER, 'history.json')
        self.history = self._load()
        self.max_history = 50

    def _load(self):
        """加载历史记录"""
        if os.path.exists(self.filepath):
            try:
                with open(self.filepath, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                pass
        return []

    def _save(self):
        """保存历史记录"""
        with open(self.filepath, 'w', encoding='utf-8') as f:
            json.dump(self.history, f, ensure_ascii=False, indent=2)

    def get_all(self):
        """获取所有历史记录"""
        return self.history

    def add(self, cmd):
        """添加历史记录"""
        if not cmd or not cmd.strip():
            return
        cmd = cmd.strip()
        # 去重
        self.history = [h for h in self.history if h != cmd]
        self.history.append(cmd)
        # 限制数量
        if len(self.history) > self.max_history:
            self.history = self.history[-self.max_history:]
        self._save()

    def clear(self):
        """清空历史记录"""
        self.history = []
        self._save()


# 创建全局服务实例
monitor_service = MonitorService()
shortcut_service = ShortcutService()
history_service = HistoryService()
tcp_service = None  # 需要在socket_handlers中初始化


def init_tcp_service(socketio):
    """初始化TCP服务"""
    global tcp_service
    tcp_service = TCPService(socketio)
    return tcp_service