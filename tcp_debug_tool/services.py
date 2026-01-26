# -*- coding: utf-8 -*-
"""
TCP网络调试服务层
"""

import os
import json
import socket
import threading
from datetime import datetime
from PyQt6.QtCore import QObject, pyqtSignal


def get_data_dir():
    """获取数据目录"""
    import sys
    if getattr(sys, 'frozen', False):
        base_dir = os.path.dirname(sys.executable)
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))

    data_dir = os.path.join(base_dir, 'data')
    os.makedirs(data_dir, exist_ok=True)
    return data_dir


class TcpSignals(QObject):
    """TCP 服务信号"""
    status_changed = pyqtSignal(dict)
    data_received = pyqtSignal(dict)
    data_sent = pyqtSignal(dict)
    blacklist_alert = pyqtSignal(dict)
    log_added = pyqtSignal(dict)


class TCPService:
    """TCP网络调试服务"""

    def __init__(self, signals: TcpSignals = None):
        self.signals = signals or TcpSignals()
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

        self.signals.log_added.emit(log_entry)
        return log_entry

    def get_logs(self):
        return self.logs

    def clear_logs(self):
        self.logs = []

    def export_logs(self):
        content = '\n'.join(
            f"[{log['time']}][{log['channel']}-{log['direction']}] {log['data']}"
            for log in self.logs
        )
        return content

    def start_server(self, ip, port):
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
        conn = self.connections['server']
        while conn['running']:
            try:
                conn['client_socket'], addr = conn['socket'].accept()
                conn['connected'] = True
                conn['client_addr'] = addr

                self.signals.status_changed.emit({
                    'channel': 'server',
                    'status': 'connected',
                    'msg': f'客户端已连接: {addr[0]}:{addr[1]}'
                })

                self._server_receive_thread()

                if conn['running']:
                    self.signals.status_changed.emit({
                        'channel': 'server',
                        'status': 'listening',
                        'msg': '等待新的客户端连接...'
                    })
            except Exception as e:
                if conn['running']:
                    print(f"服务器接受连接错误: {e}")
                break

    def _server_receive_thread(self):
        conn = self.connections['server']
        while conn['connected'] and conn['client_socket']:
            try:
                data = conn['client_socket'].recv(4096)
                if data:
                    log = self.add_log('server', 'rx',
                                       data.decode('utf-8', errors='replace'),
                                       ' '.join(f'{b:02X}' for b in data),
                                       len(data))
                    self.signals.data_received.emit({
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
        self.signals.status_changed.emit({
            'channel': 'server',
            'status': 'client_disconnected',
            'msg': '客户端已断开'
        })

    def connect_client(self, ip, port):
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
        conn = self.connections['client']
        while conn['connected'] and conn['socket']:
            try:
                data = conn['socket'].recv(4096)
                if data:
                    log = self.add_log('client', 'rx',
                                       data.decode('utf-8', errors='replace'),
                                       ' '.join(f'{b:02X}' for b in data),
                                       len(data))
                    self.signals.data_received.emit({
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
        self.signals.status_changed.emit({
            'channel': 'client',
            'status': 'disconnected',
            'msg': '连接已断开'
        })

    def send_data(self, channel, content, is_hex, append_newline):
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
                               len(send_data))

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
        server_conn = self.connections['server']
        client_conn = self.connections['client']

        server_status = {'channel': 'server', 'status': 'disconnected', 'msg': '未启动'}
        if server_conn['connected']:
            addr = server_conn.get('client_addr', ('?', '?'))
            server_status = {
                'channel': 'server',
                'status': 'connected',
                'msg': f'客户端已连接: {addr[0]}:{addr[1]}'
            }
        elif server_conn['running']:
            server_status = {'channel': 'server', 'status': 'listening', 'msg': '服务器监听中...'}

        client_status = {
            'channel': 'client',
            'status': 'connected' if client_conn['connected'] else 'disconnected',
            'msg': '已连接' if client_conn['connected'] else '未连接'
        }

        return server_status, client_status

    def is_server_connected(self):
        return self.connections['server']['connected']

    def is_server_running(self):
        return self.connections['server']['running']

    def is_client_connected(self):
        return self.connections['client']['connected']


class MonitorService:
    """黑名单检测服务"""

    def __init__(self, signals: TcpSignals = None):
        self.signals = signals
        self.blacklist = set()
        self._load_blacklist()

    def _get_blacklist_path(self):
        return os.path.join(get_data_dir(), 'blacklist.json')

    def _save_blacklist(self):
        try:
            with open(self._get_blacklist_path(), 'w', encoding='utf-8') as f:
                json.dump(list(self.blacklist), f, ensure_ascii=False)
        except Exception as e:
            print(f"保存黑名单失败: {e}")

    def _load_blacklist(self):
        filepath = self._get_blacklist_path()
        if os.path.exists(filepath):
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    self.blacklist = set(json.load(f))
            except Exception as e:
                print(f"加载黑名单失败: {e}")

    def load_from_file(self, filepath):
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                self.blacklist = set(line.strip() for line in f if line.strip())
            self._save_blacklist()
            return {'success': True, 'count': len(self.blacklist)}
        except Exception as e:
            return {'success': False, 'msg': str(e)}

    def get_blacklist(self):
        return list(self.blacklist)

    def get_count(self):
        return len(self.blacklist)

    def check_data(self, data):
        if not self.blacklist:
            return []
        found = []
        for item in self.blacklist:
            if item in data:
                found.append(item)
        return found

    def clear(self):
        self.blacklist.clear()
        self._save_blacklist()


class ShortcutService:
    """快捷指令服务"""

    def __init__(self):
        self.filepath = os.path.join(get_data_dir(), 'shortcuts.json')
        self.shortcuts = self._load()

    def _load(self):
        if os.path.exists(self.filepath):
            try:
                with open(self.filepath, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                pass
        return []

    def _save(self):
        try:
            with open(self.filepath, 'w', encoding='utf-8') as f:
                json.dump(self.shortcuts, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"保存快捷指令失败: {e}")

    def get_all(self):
        return self.shortcuts

    def add(self, cmd):
        if cmd and cmd.strip():
            self.shortcuts.append(cmd.strip())
            self._save()
            return True
        return False

    def delete(self, index):
        if 0 <= index < len(self.shortcuts):
            self.shortcuts.pop(index)
            self._save()
            return True
        return False

    def clear(self):
        self.shortcuts = []
        self._save()


class HistoryService:
    """发送历史服务"""

    def __init__(self):
        self.filepath = os.path.join(get_data_dir(), 'history.json')
        self.history = self._load()
        self.max_history = 50

    def _load(self):
        if os.path.exists(self.filepath):
            try:
                with open(self.filepath, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                pass
        return []

    def _save(self):
        try:
            with open(self.filepath, 'w', encoding='utf-8') as f:
                json.dump(self.history, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"保存历史记录失败: {e}")

    def get_all(self):
        return self.history

    def add(self, cmd):
        if not cmd or not cmd.strip():
            return
        cmd = cmd.strip()
        self.history = [h for h in self.history if h != cmd]
        self.history.append(cmd)
        if len(self.history) > self.max_history:
            self.history = self.history[-self.max_history:]
        self._save()

    def clear(self):
        self.history = []
        self._save()