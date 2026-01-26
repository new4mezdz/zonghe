# -*- coding: utf-8 -*-
"""
主窗口
"""

import os
from datetime import datetime
from PyQt6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QGridLayout,
    QGroupBox, QLabel, QLineEdit, QSpinBox, QPushButton, QTextEdit,
    QPlainTextEdit, QComboBox, QCheckBox, QRadioButton, QButtonGroup,
    QListWidget, QListWidgetItem, QFileDialog, QMessageBox, QStatusBar,
    QSplitter, QFrame, QInputDialog, QSizePolicy
)
from PyQt6.QtCore import Qt, QTimer, pyqtSlot, QEvent
from PyQt6.QtGui import QFont, QTextCursor, QAction, QKeySequence

from services import (
    TcpSignals, TCPService, MonitorService,
    ShortcutService, HistoryService
)


class StatusBadge(QLabel):
    """状态徽章控件"""

    STYLES = {
        'disconnected': 'background:#444; color:#aaa; border-radius:10px; padding:4px 12px;',
        'connecting': 'background:#4a4a00; color:#ffae00; border-radius:10px; padding:4px 12px;',
        'listening': 'background:#4a4a00; color:#ffae00; border-radius:10px; padding:4px 12px;',
        'connected': 'background:#1a3d1a; color:#4CAF50; border-radius:10px; padding:4px 12px;',
        'error': 'background:#3d1a1a; color:#ff4d4d; border-radius:10px; padding:4px 12px;',
    }

    def __init__(self, text='未连接', parent=None):
        super().__init__(text, parent)
        self.setStyleSheet(self.STYLES['disconnected'])

    def set_status(self, status, text=None):
        if text:
            self.setText(text)
        style = self.STYLES.get(status, self.STYLES['disconnected'])
        self.setStyleSheet(style)


class MainWindow(QMainWindow):
    """主窗口"""

    def __init__(self):
        super().__init__()
        self.setWindowTitle("📡 TCP网络调试助手")
        self.setMinimumSize(1200, 700)
        self.resize(1400, 800)

        # 初始化服务
        self.signals = TcpSignals()
        self.tcp_service = TCPService(self.signals)
        self.monitor_service = MonitorService(self.signals)
        self.shortcut_service = ShortcutService()
        self.history_service = HistoryService()

        # 统计数据
        self.stats = {
            'srv_rx': 0, 'srv_rx_bytes': 0,
            'srv_tx': 0, 'srv_tx_bytes': 0,
            'clt_rx': 0, 'clt_rx_bytes': 0,
            'clt_tx': 0, 'clt_tx_bytes': 0,
        }

        # 循环发送定时器
        self.cycle_timer = QTimer()
        self.cycle_timer.timeout.connect(self.send_data)

        # 创建UI
        self._create_ui()
        self._connect_signals()
        self._load_data()

    def _create_ui(self):
        """创建界面"""
        central_widget = QWidget()
        self.setCentralWidget(central_widget)

        main_layout = QVBoxLayout(central_widget)
        main_layout.setContentsMargins(15, 15, 15, 15)
        main_layout.setSpacing(15)

        # === 顶部连接区 ===
        conn_layout = QHBoxLayout()
        conn_layout.addWidget(self._create_server_panel())
        conn_layout.addWidget(self._create_client_panel())
        main_layout.addLayout(conn_layout)

        # === 主内容区 ===
        content_layout = QHBoxLayout()

        # 左侧设置面板
        left_panel = QWidget()
        left_panel.setFixedWidth(260)
        left_layout = QVBoxLayout(left_panel)
        left_layout.setContentsMargins(0, 0, 0, 0)
        left_layout.setSpacing(10)
        left_layout.addWidget(self._create_rx_settings_panel())
        left_layout.addWidget(self._create_tx_settings_panel())
        left_layout.addWidget(self._create_blacklist_panel())
        left_layout.addStretch()
        content_layout.addWidget(left_panel)

        # 中间数据区
        center_panel = QWidget()
        center_layout = QVBoxLayout(center_panel)
        center_layout.setContentsMargins(0, 0, 0, 0)
        center_layout.setSpacing(10)
        center_layout.addWidget(self._create_log_panel(), 1)
        center_layout.addWidget(self._create_alert_panel())
        center_layout.addWidget(self._create_send_panel())
        content_layout.addWidget(center_panel, 1)

        # 右侧快捷面板
        right_panel = QWidget()
        right_panel.setFixedWidth(260)
        right_layout = QVBoxLayout(right_panel)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(10)
        right_layout.addWidget(self._create_shortcuts_panel())
        right_layout.addWidget(self._create_history_panel())
        right_layout.addWidget(self._create_file_panel())
        right_layout.addStretch()
        content_layout.addWidget(right_panel)

        main_layout.addLayout(content_layout, 1)

        # === 状态栏 ===
        self.statusBar().showMessage("就绪")

    def _create_server_panel(self):
        """服务器面板"""
        group = QGroupBox("📥 TCP服务器（接收数据）")
        layout = QHBoxLayout(group)

        layout.addWidget(QLabel("IP:"))
        self.server_ip = QLineEdit("0.0.0.0")
        self.server_ip.setFixedWidth(120)
        layout.addWidget(self.server_ip)

        layout.addWidget(QLabel("端口:"))
        self.server_port = QSpinBox()
        self.server_port.setRange(1, 65535)
        self.server_port.setValue(8080)
        self.server_port.setFixedWidth(80)
        layout.addWidget(self.server_port)

        self.server_btn = QPushButton("启动监听")
        self.server_btn.setProperty("class", "success")
        self.server_btn.clicked.connect(self.toggle_server)
        layout.addWidget(self.server_btn)

        layout.addWidget(QLabel("状态:"))
        self.server_status = StatusBadge("未启动")
        layout.addWidget(self.server_status)

        layout.addStretch()
        return group

    def _create_client_panel(self):
        """客户端面板"""
        group = QGroupBox("📤 TCP客户端（发送数据）")
        layout = QHBoxLayout(group)

        layout.addWidget(QLabel("IP:"))
        self.client_ip = QLineEdit("127.0.0.1")
        self.client_ip.setFixedWidth(120)
        layout.addWidget(self.client_ip)

        layout.addWidget(QLabel("端口:"))
        self.client_port = QSpinBox()
        self.client_port.setRange(1, 65535)
        self.client_port.setValue(9000)
        self.client_port.setFixedWidth(80)
        layout.addWidget(self.client_port)

        self.client_btn = QPushButton("连接")
        self.client_btn.setProperty("class", "success")
        self.client_btn.clicked.connect(self.toggle_client)
        layout.addWidget(self.client_btn)

        layout.addWidget(QLabel("状态:"))
        self.client_status = StatusBadge("未连接")
        layout.addWidget(self.client_status)

        layout.addStretch()
        return group

    def _create_rx_settings_panel(self):
        """接收设置面板"""
        group = QGroupBox("📥 接收设置")
        layout = QVBoxLayout(group)

        format_layout = QHBoxLayout()
        self.rx_format_group = QButtonGroup(self)
        self.rx_ascii = QRadioButton("ASCII")
        self.rx_ascii.setChecked(True)
        self.rx_hex = QRadioButton("HEX")
        self.rx_format_group.addButton(self.rx_ascii)
        self.rx_format_group.addButton(self.rx_hex)
        format_layout.addWidget(self.rx_ascii)
        format_layout.addWidget(self.rx_hex)
        format_layout.addStretch()
        layout.addLayout(format_layout)

        self.rx_show_time = QCheckBox("显示时间戳")
        self.rx_show_time.setChecked(True)
        layout.addWidget(self.rx_show_time)

        self.rx_show_hex = QCheckBox("同时显示HEX")
        layout.addWidget(self.rx_show_hex)

        self.rx_auto_scroll = QCheckBox("自动滚屏")
        self.rx_auto_scroll.setChecked(True)
        layout.addWidget(self.rx_auto_scroll)

        btn_layout = QHBoxLayout()
        clear_btn = QPushButton("清空日志")
        clear_btn.clicked.connect(self.clear_log)
        btn_layout.addWidget(clear_btn)

        export_btn = QPushButton("导出")
        export_btn.clicked.connect(self.export_log)
        btn_layout.addWidget(export_btn)
        layout.addLayout(btn_layout)

        return group

    def _create_tx_settings_panel(self):
        """发送设置面板"""
        group = QGroupBox("📤 发送设置")
        layout = QVBoxLayout(group)

        format_layout = QHBoxLayout()
        self.tx_format_group = QButtonGroup(self)
        self.tx_ascii = QRadioButton("ASCII")
        self.tx_ascii.setChecked(True)
        self.tx_hex = QRadioButton("HEX")
        self.tx_format_group.addButton(self.tx_ascii)
        self.tx_format_group.addButton(self.tx_hex)
        format_layout.addWidget(self.tx_ascii)
        format_layout.addWidget(self.tx_hex)
        format_layout.addStretch()
        layout.addLayout(format_layout)

        self.tx_parse_escape = QCheckBox("转义符解析")
        layout.addWidget(self.tx_parse_escape)

        self.tx_append_newline = QCheckBox("自动加换行")
        self.tx_append_newline.setChecked(True)
        layout.addWidget(self.tx_append_newline)

        cycle_layout = QHBoxLayout()
        self.tx_cycle_enable = QCheckBox("循环发送")
        self.tx_cycle_enable.stateChanged.connect(self.toggle_cycle_send)
        cycle_layout.addWidget(self.tx_cycle_enable)

        self.tx_cycle_ms = QSpinBox()
        self.tx_cycle_ms.setRange(100, 60000)
        self.tx_cycle_ms.setValue(1000)
        self.tx_cycle_ms.setSuffix(" ms")
        self.tx_cycle_ms.setFixedWidth(90)
        cycle_layout.addWidget(self.tx_cycle_ms)
        cycle_layout.addStretch()
        layout.addLayout(cycle_layout)

        return group

    def _create_blacklist_panel(self):
        """黑名单面板"""
        group = QGroupBox("🚫 黑名单检测")
        layout = QVBoxLayout(group)

        import_btn = QPushButton("导入黑名单")
        import_btn.clicked.connect(self.import_blacklist)
        layout.addWidget(import_btn)

        self.blacklist_info = QLabel("未导入")
        self.blacklist_info.setStyleSheet("color: #888;")
        layout.addWidget(self.blacklist_info)

        return group

    def _create_log_panel(self):
        """日志面板"""
        group = QGroupBox("📋 数据日志")
        layout = QVBoxLayout(group)

        self.log_view = QPlainTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setFont(QFont("Consolas", 9))
        self.log_view.setPlaceholderText("等待连接...")
        self.log_view.setStyleSheet("""
            QPlainTextEdit {
                background-color: #1e1e1e;
                border: 1px solid #444;
                border-radius: 4px;
            }
        """)
        layout.addWidget(self.log_view)

        stats_layout = QHBoxLayout()
        stats_layout.setSpacing(20)

        self.stats_labels = {}
        for key, label in [
            ('srv_rx', '服务器 RX:'), ('srv_tx', '服务器 TX:'),
            ('clt_rx', '客户端 RX:'), ('clt_tx', '客户端 TX:')
        ]:
            lbl = QLabel(f"{label} 0条 / 0B")
            lbl.setStyleSheet("color: #888; font-size: 11px;")
            self.stats_labels[key] = lbl
            stats_layout.addWidget(lbl)

        stats_layout.addStretch()
        layout.addLayout(stats_layout)

        return group

    def _create_alert_panel(self):
        """警告面板"""
        self.alert_panel = QGroupBox("⚠️ 黑名单警告")
        self.alert_panel.setStyleSheet("""
            QGroupBox {
                background-color: #3d2020;
                border: 1px solid #ff4d4d;
            }
            QGroupBox::title {
                color: #ff4d4d;
            }
        """)
        self.alert_panel.hide()

        layout = QVBoxLayout(self.alert_panel)
        self.alert_content = QPlainTextEdit()
        self.alert_content.setReadOnly(True)
        self.alert_content.setMaximumHeight(80)
        self.alert_content.setStyleSheet("background:#2d1515; color:#ffaaaa;")
        layout.addWidget(self.alert_content)

        return self.alert_panel

    def _create_send_panel(self):
        """发送面板"""
        group = QGroupBox("✏️ 数据发送")
        layout = QVBoxLayout(group)

        self.send_input = QPlainTextEdit()
        self.send_input.setPlaceholderText("输入要发送的数据...（Ctrl+Enter发送）")
        self.send_input.setMaximumHeight(80)
        self.send_input.setFont(QFont("Consolas", 9))
        layout.addWidget(self.send_input)

        send_layout = QHBoxLayout()

        self.send_channel = QComboBox()
        self.send_channel.addItem("通过服务器发送（回复客户端）", "server")
        self.send_channel.addItem("通过客户端发送（发给目标机器）", "client")
        self.send_channel.setFixedWidth(280)
        send_layout.addWidget(self.send_channel)

        send_btn = QPushButton("发送")
        send_btn.setProperty("class", "primary")
        send_btn.clicked.connect(self.send_data)
        send_layout.addWidget(send_btn)

        clear_btn = QPushButton("清空")
        clear_btn.clicked.connect(lambda: self.send_input.clear())
        send_layout.addWidget(clear_btn)

        send_layout.addStretch()
        layout.addLayout(send_layout)

        self.send_input.installEventFilter(self)

        return group

    def _create_shortcuts_panel(self):
        """快捷指令面板"""
        group = QGroupBox("⚡ 快捷指令")
        layout = QVBoxLayout(group)

        btn_layout = QHBoxLayout()
        add_btn = QPushButton("+ 添加")
        add_btn.clicked.connect(self.add_shortcut)
        btn_layout.addWidget(add_btn)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        self.shortcut_list = QListWidget()
        self.shortcut_list.setMaximumHeight(150)
        self.shortcut_list.itemDoubleClicked.connect(self.use_shortcut)
        layout.addWidget(self.shortcut_list)

        op_layout = QHBoxLayout()
        use_btn = QPushButton("使用")
        use_btn.clicked.connect(lambda: self.use_shortcut(self.shortcut_list.currentItem()))
        op_layout.addWidget(use_btn)

        del_btn = QPushButton("删除")
        del_btn.clicked.connect(self.delete_shortcut)
        op_layout.addWidget(del_btn)
        layout.addLayout(op_layout)

        return group

    def _create_history_panel(self):
        """发送历史面板"""
        group = QGroupBox("📜 发送历史")
        layout = QVBoxLayout(group)

        btn_layout = QHBoxLayout()
        clear_btn = QPushButton("清空")
        clear_btn.clicked.connect(self.clear_history)
        btn_layout.addWidget(clear_btn)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)

        self.history_list = QListWidget()
        self.history_list.setMaximumHeight(150)
        self.history_list.itemDoubleClicked.connect(self.use_history)
        layout.addWidget(self.history_list)

        return group

    def _create_file_panel(self):
        """文件发送面板"""
        group = QGroupBox("📁 文件发送")
        layout = QVBoxLayout(group)

        open_btn = QPushButton("打开文件")
        open_btn.clicked.connect(self.open_file)
        layout.addWidget(open_btn)

        return group

    def _connect_signals(self):
        """连接信号"""
        self.signals.status_changed.connect(self.on_status_changed)
        self.signals.data_received.connect(self.on_data_received)
        self.signals.data_sent.connect(self.on_data_sent)
        self.signals.blacklist_alert.connect(self.on_blacklist_alert)

    def _load_data(self):
        """加载数据"""
        self._refresh_shortcuts()
        self._refresh_history()

        count = self.monitor_service.get_count()
        if count > 0:
            self.blacklist_info.setText(f"已加载 {count} 条")

    def _refresh_shortcuts(self):
        self.shortcut_list.clear()
        for cmd in self.shortcut_service.get_all():
            self.shortcut_list.addItem(cmd)

    def _refresh_history(self):
        self.history_list.clear()
        for cmd in reversed(self.history_service.get_all()[-15:]):
            self.history_list.addItem(cmd)

    def eventFilter(self, obj, event):
        if obj == self.send_input and event.type() == QEvent.Type.KeyPress:
            key_event = event
            if (key_event.key() == Qt.Key.Key_Return and
                    key_event.modifiers() == Qt.KeyboardModifier.ControlModifier):
                self.send_data()
                return True
        return super().eventFilter(obj, event)

    @pyqtSlot()
    def toggle_server(self):
        if self.tcp_service.is_server_running():
            self.tcp_service.stop_server()
            self.server_btn.setText("启动监听")
            self.server_btn.setProperty("class", "success")
            self.server_btn.style().unpolish(self.server_btn)
            self.server_btn.style().polish(self.server_btn)
            self.server_status.set_status('disconnected', '未启动')
            self.add_log_line('SYS', '[服务器] 已停止', 'sys')
        else:
            ip = self.server_ip.text()
            port = self.server_port.value()
            result = self.tcp_service.start_server(ip, port)

            if result['success']:
                self.server_btn.setText("停止")
                self.server_btn.setProperty("class", "danger")
                self.server_btn.style().unpolish(self.server_btn)
                self.server_btn.style().polish(self.server_btn)
                self.server_status.set_status('listening', result['msg'])
                self.add_log_line('SYS', f"[服务器] {result['msg']}", 'sys')
            else:
                self.server_status.set_status('error', result['msg'])
                self.add_log_line('SYS', f"[服务器] {result['msg']}", 'sys')

    @pyqtSlot()
    def toggle_client(self):
        if self.tcp_service.is_client_connected():
            self.tcp_service.disconnect_client()
            self.client_btn.setText("连接")
            self.client_btn.setProperty("class", "success")
            self.client_btn.style().unpolish(self.client_btn)
            self.client_btn.style().polish(self.client_btn)
            self.client_status.set_status('disconnected', '未连接')
            self.add_log_line('SYS', '[客户端] 已断开', 'sys')
        else:
            ip = self.client_ip.text()
            port = self.client_port.value()
            result = self.tcp_service.connect_client(ip, port)

            if result['success']:
                self.client_btn.setText("断开")
                self.client_btn.setProperty("class", "danger")
                self.client_btn.style().unpolish(self.client_btn)
                self.client_btn.style().polish(self.client_btn)
                self.client_status.set_status('connected', result['msg'])
                self.add_log_line('SYS', f"[客户端] {result['msg']}", 'sys')
            else:
                self.client_status.set_status('error', result['msg'])
                self.add_log_line('SYS', f"[客户端] {result['msg']}", 'sys')

    @pyqtSlot(dict)
    def on_status_changed(self, data):
        channel = data['channel']
        status = data['status']
        msg = data['msg']

        if channel == 'server':
            self.server_status.set_status(status, msg)
            if status == 'connected':
                self.server_btn.setText("停止")
                self.server_btn.setProperty("class", "danger")
            elif status in ('disconnected', 'client_disconnected'):
                if not self.tcp_service.is_server_running():
                    self.server_btn.setText("启动监听")
                    self.server_btn.setProperty("class", "success")
            self.server_btn.style().unpolish(self.server_btn)
            self.server_btn.style().polish(self.server_btn)
        else:
            self.client_status.set_status(status, msg)
            if status == 'connected':
                self.client_btn.setText("断开")
                self.client_btn.setProperty("class", "danger")
            else:
                self.client_btn.setText("连接")
                self.client_btn.setProperty("class", "success")
            self.client_btn.style().unpolish(self.client_btn)
            self.client_btn.style().polish(self.client_btn)

        self.add_log_line('SYS', f"[{channel}] {msg}", 'sys')

    @pyqtSlot(dict)
    def on_data_received(self, data):
        channel = data['channel']
        is_hex = self.rx_hex.isChecked()
        show_hex = self.rx_show_hex.isChecked() and not is_hex

        display_data = data['hex'] if is_hex else data['data']
        hex_data = data['hex'] if show_hex else None

        if channel == 'server':
            self.stats['srv_rx'] += 1
            self.stats['srv_rx_bytes'] += data['length']
            self.add_log_line('SRV-RX', display_data, 'server-rx', hex_data)
        else:
            self.stats['clt_rx'] += 1
            self.stats['clt_rx_bytes'] += data['length']
            self.add_log_line('CLT-RX', display_data, 'client-rx', hex_data)

        self._update_stats()

        found = self.monitor_service.check_data(data['data'])
        if found:
            self.on_blacklist_alert({'items': found, 'data': data['data']})

    @pyqtSlot(dict)
    def on_data_sent(self, data):
        channel = data['channel']
        is_hex = self.tx_hex.isChecked()
        display_data = data['hex'] if is_hex else data['data']

        if channel == 'server':
            self.stats['srv_tx'] += 1
            self.stats['srv_tx_bytes'] += data['length']
            self.add_log_line('SRV-TX', display_data, 'server-tx')
        else:
            self.stats['clt_tx'] += 1
            self.stats['clt_tx_bytes'] += data['length']
            self.add_log_line('CLT-TX', display_data, 'client-tx')

        self._update_stats()

    @pyqtSlot(dict)
    def on_blacklist_alert(self, data):
        self.alert_panel.show()
        time_str = datetime.now().strftime('%H:%M:%S')
        for item in data['items']:
            self.alert_content.appendPlainText(f"[{time_str}] {item}")

    def add_log_line(self, direction, data, log_type, hex_data=None):
        colors = {
            'server-rx': '#4CAF50',
            'server-tx': '#8BC34A',
            'client-rx': '#2196F3',
            'client-tx': '#03A9F4',
            'sys': '#ff9800',
        }
        color = colors.get(log_type, '#888')

        time_str = ""
        if self.rx_show_time.isChecked():
            time_str = f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] "

        line = f"{time_str}[{direction}] {data}"
        if hex_data:
            line += f"\n    [HEX] {hex_data}"

        cursor = self.log_view.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)

        self.log_view.appendHtml(
            f'<span style="color:{color}">{line.replace(chr(10), "<br>")}</span>'
        )

        if self.rx_auto_scroll.isChecked():
            self.log_view.verticalScrollBar().setValue(
                self.log_view.verticalScrollBar().maximum()
            )

    def _update_stats(self):
        self.stats_labels['srv_rx'].setText(
            f"服务器 RX: {self.stats['srv_rx']}条 / {self.stats['srv_rx_bytes']}B"
        )
        self.stats_labels['srv_tx'].setText(
            f"服务器 TX: {self.stats['srv_tx']}条 / {self.stats['srv_tx_bytes']}B"
        )
        self.stats_labels['clt_rx'].setText(
            f"客户端 RX: {self.stats['clt_rx']}条 / {self.stats['clt_rx_bytes']}B"
        )
        self.stats_labels['clt_tx'].setText(
            f"客户端 TX: {self.stats['clt_tx']}条 / {self.stats['clt_tx_bytes']}B"
        )

    @pyqtSlot()
    def send_data(self):
        content = self.send_input.toPlainText()
        if not content:
            return

        channel = self.send_channel.currentData()
        is_hex = self.tx_hex.isChecked()
        parse_escape = self.tx_parse_escape.isChecked()
        append_newline = self.tx_append_newline.isChecked()

        if not is_hex and parse_escape:
            content = content.replace('\\r', '\r').replace('\\n', '\n').replace('\\t', '\t')

        result = self.tcp_service.send_data(channel, content, is_hex, append_newline and not is_hex)

        if result['success']:
            if channel == 'server':
                self.stats['srv_tx'] += 1
                self.stats['srv_tx_bytes'] += result['length']
                self.add_log_line('SRV-TX', result['data'], 'server-tx')
            else:
                self.stats['clt_tx'] += 1
                self.stats['clt_tx_bytes'] += result['length']
                self.add_log_line('CLT-TX', result['data'], 'client-tx')

            self._update_stats()

            self.history_service.add(content.rstrip('\r\n'))
            self._refresh_history()

            found = self.monitor_service.check_data(content)
            if found:
                self.on_blacklist_alert({'items': found, 'data': content})
        else:
            QMessageBox.warning(self, "发送失败", result['msg'])

    @pyqtSlot(int)
    def toggle_cycle_send(self, state):
        if state == Qt.CheckState.Checked.value:
            ms = max(self.tx_cycle_ms.value(), 100)
            self.cycle_timer.start(ms)
        else:
            self.cycle_timer.stop()

    @pyqtSlot()
    def clear_log(self):
        self.log_view.clear()
        self.tcp_service.clear_logs()
        self.stats = {k: 0 for k in self.stats}
        self._update_stats()

    @pyqtSlot()
    def export_log(self):
        filepath, _ = QFileDialog.getSaveFileName(
            self, "导出日志", "tcp_log.txt", "文本文件 (*.txt)"
        )
        if filepath:
            content = self.tcp_service.export_logs()
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
            QMessageBox.information(self, "导出成功", f"日志已保存到:\n{filepath}")

    @pyqtSlot()
    def import_blacklist(self):
        filepath, _ = QFileDialog.getOpenFileName(
            self, "导入黑名单", "", "文本文件 (*.txt)"
        )
        if filepath:
            result = self.monitor_service.load_from_file(filepath)
            if result['success']:
                self.blacklist_info.setText(f"已加载 {result['count']} 条")
            else:
                QMessageBox.warning(self, "导入失败", result['msg'])

    @pyqtSlot()
    def add_shortcut(self):
        cmd, ok = QInputDialog.getText(self, "添加快捷指令", "输入指令内容:")
        if ok and cmd:
            self.shortcut_service.add(cmd)
            self._refresh_shortcuts()

    @pyqtSlot(QListWidgetItem)
    def use_shortcut(self, item):
        if item:
            self.send_input.setPlainText(item.text())
            self.send_data()

    @pyqtSlot()
    def delete_shortcut(self):
        row = self.shortcut_list.currentRow()
        if row >= 0:
            self.shortcut_service.delete(row)
            self._refresh_shortcuts()

    @pyqtSlot(QListWidgetItem)
    def use_history(self, item):
        if item:
            self.send_input.setPlainText(item.text())

    @pyqtSlot()
    def clear_history(self):
        reply = QMessageBox.question(
            self, "确认", "确定要清空发送历史吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if reply == QMessageBox.StandardButton.Yes:
            self.history_service.clear()
            self._refresh_history()

    @pyqtSlot()
    def open_file(self):
        filepath, _ = QFileDialog.getOpenFileName(
            self, "打开文件", "", "文本文件 (*.txt *.dat *.hex)"
        )
        if filepath:
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    content = f.read()
                self.send_input.setPlainText(content)
            except Exception as e:
                QMessageBox.warning(self, "打开失败", str(e))

    def closeEvent(self, event):
        self.cycle_timer.stop()
        self.tcp_service.stop_server()
        self.tcp_service.disconnect_client()
        event.accept()


