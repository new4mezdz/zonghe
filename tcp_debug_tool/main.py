#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TCP网络调试助手 - PyQt6 独立版
"""

import sys
import os


# 确保数据目录存在
def get_data_dir():
    """获取数据目录（支持打包后运行）"""
    if getattr(sys, 'frozen', False):
        # PyInstaller 打包后
        base_dir = os.path.dirname(sys.executable)
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))

    data_dir = os.path.join(base_dir, 'data')
    os.makedirs(data_dir, exist_ok=True)
    return data_dir


# 设置数据目录
DATA_DIR = get_data_dir()

from PyQt6.QtWidgets import QApplication
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont

from ui.main_window import MainWindow


def main():
    # 高DPI支持
    if hasattr(Qt.ApplicationAttribute, 'AA_EnableHighDpiScaling'):
        QApplication.setAttribute(Qt.ApplicationAttribute.AA_EnableHighDpiScaling, True)
    if hasattr(Qt.ApplicationAttribute, 'AA_UseHighDpiPixmaps'):
        QApplication.setAttribute(Qt.ApplicationAttribute.AA_UseHighDpiPixmaps, True)

    app = QApplication(sys.argv)
    app.setApplicationName("TCP网络调试助手")
    app.setApplicationVersion("1.0.0")

    # 设置默认字体
    font = QFont("Microsoft YaHei", 9)
    app.setFont(font)

    # 设置样式
    app.setStyleSheet(get_stylesheet())

    window = MainWindow()
    window.show()

    sys.exit(app.exec())


def get_stylesheet():
    """返回应用程序样式表"""
    return """
    QMainWindow, QWidget {
        background-color: #2b2b2b;
        color: #ffffff;
    }

    QGroupBox {
        background-color: #383838;
        border: 1px solid #555;
        border-radius: 6px;
        margin-top: 12px;
        padding: 10px;
        font-weight: bold;
    }

    QGroupBox::title {
        subcontrol-origin: margin;
        subcontrol-position: top left;
        left: 10px;
        padding: 0 5px;
        color: #ffae00;
    }

    QLabel {
        color: #cccccc;
    }

    QLineEdit, QSpinBox, QTextEdit, QPlainTextEdit {
        background-color: #1e1e1e;
        border: 1px solid #555;
        border-radius: 4px;
        padding: 6px;
        color: #ffffff;
        selection-background-color: #ffae00;
    }

    QLineEdit:focus, QSpinBox:focus, QTextEdit:focus, QPlainTextEdit:focus {
        border-color: #ffae00;
    }

    QPushButton {
        background-color: #555;
        border: none;
        border-radius: 4px;
        padding: 8px 16px;
        color: #ffffff;
        font-weight: bold;
    }

    QPushButton:hover {
        background-color: #666;
    }

    QPushButton:pressed {
        background-color: #444;
    }

    QPushButton:disabled {
        background-color: #3a3a3a;
        color: #666;
    }

    QPushButton[class="primary"] {
        background-color: #ffae00;
        color: #000000;
    }

    QPushButton[class="primary"]:hover {
        background-color: #ffc040;
    }

    QPushButton[class="success"] {
        background-color: #4CAF50;
        color: #ffffff;
    }

    QPushButton[class="success"]:hover {
        background-color: #5CBF60;
    }

    QPushButton[class="danger"] {
        background-color: #f44336;
        color: #ffffff;
    }

    QPushButton[class="danger"]:hover {
        background-color: #ff5346;
    }

    QComboBox {
        background-color: #1e1e1e;
        border: 1px solid #555;
        border-radius: 4px;
        padding: 6px;
        color: #ffffff;
    }

    QComboBox:focus {
        border-color: #ffae00;
    }

    QComboBox::drop-down {
        border: none;
        width: 20px;
    }

    QComboBox::down-arrow {
        image: none;
        border-left: 5px solid transparent;
        border-right: 5px solid transparent;
        border-top: 5px solid #888;
        margin-right: 5px;
    }

    QComboBox QAbstractItemView {
        background-color: #1e1e1e;
        border: 1px solid #555;
        selection-background-color: #ffae00;
        selection-color: #000;
    }

    QCheckBox, QRadioButton {
        color: #aaaaaa;
        spacing: 6px;
    }

    QCheckBox::indicator, QRadioButton::indicator {
        width: 16px;
        height: 16px;
    }

    QCheckBox::indicator:unchecked, QRadioButton::indicator:unchecked {
        border: 2px solid #555;
        background-color: #1e1e1e;
    }

    QCheckBox::indicator:checked {
        border: 2px solid #ffae00;
        background-color: #ffae00;
    }

    QRadioButton::indicator {
        border-radius: 8px;
    }

    QRadioButton::indicator:checked {
        border: 2px solid #ffae00;
        background-color: #ffae00;
    }

    QListWidget {
        background-color: #1e1e1e;
        border: 1px solid #444;
        border-radius: 4px;
        color: #cccccc;
    }

    QListWidget::item {
        padding: 5px;
        border-bottom: 1px solid #333;
    }

    QListWidget::item:selected {
        background-color: #3a3a3a;
        color: #ffae00;
    }

    QListWidget::item:hover {
        background-color: #333;
    }

    QScrollBar:vertical {
        background-color: #2b2b2b;
        width: 10px;
        border-radius: 5px;
    }

    QScrollBar::handle:vertical {
        background-color: #555;
        border-radius: 5px;
        min-height: 20px;
    }

    QScrollBar::handle:vertical:hover {
        background-color: #666;
    }

    QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
        height: 0;
    }

    QScrollBar:horizontal {
        background-color: #2b2b2b;
        height: 10px;
        border-radius: 5px;
    }

    QScrollBar::handle:horizontal {
        background-color: #555;
        border-radius: 5px;
        min-width: 20px;
    }

    QStatusBar {
        background-color: #383838;
        color: #888;
    }

    QMenuBar {
        background-color: #383838;
        color: #ffffff;
    }

    QMenuBar::item:selected {
        background-color: #ffae00;
        color: #000;
    }

    QMenu {
        background-color: #383838;
        color: #ffffff;
        border: 1px solid #555;
    }

    QMenu::item:selected {
        background-color: #ffae00;
        color: #000;
    }
    """


if __name__ == '__main__':
    main()