"""
DAM1600D 16路继电器调试软件 v5.0 - 厂房可视化
依赖: pip install customtkinter
打包: pyinstaller --onefile --windowed dam1600d_debug.py
"""

import ctypes
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except:
    try: ctypes.windll.user32.SetProcessDPIAware()
    except: pass

import customtkinter as ctk
import tkinter as tk
from tkinter import messagebox
import socket, struct, threading, time, json, os


# ========== Modbus TCP ==========
class ModbusTCP:
    def __init__(self):
        self.sock = None
        self.transaction_id = 0
        self.lock = threading.Lock()

    def connect(self, ip, port, timeout=3):
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.settimeout(timeout)
            self.sock.connect((ip, port))
            return True
        except:
            self.sock = None
            return False

    def close(self):
        if self.sock:
            try: self.sock.close()
            except: pass
            self.sock = None

    def _send_receive(self, unit_id, pdu):
        with self.lock:
            self.transaction_id = (self.transaction_id + 1) % 65536
            mbap = struct.pack('>HHHB', self.transaction_id, 0, len(pdu) + 1, unit_id)
            self.sock.sendall(mbap + pdu)
            header = self._recv_exact(7)
            resp_len = struct.unpack('>H', header[4:6])[0]
            return self._recv_exact(resp_len - 1)

    def _recv_exact(self, n):
        buf = b''
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk: raise ConnectionError("连接断开")
            buf += chunk
        return buf

    def read_coils(self, unit_id, address, count):
        pdu = struct.pack('>BHH', 0x01, address, count)
        data = self._send_receive(unit_id, pdu)
        if data[0] == 0x81: raise Exception(f"错误码 {data[1]}")
        bits = []
        for byte_val in data[2:2 + data[1]]:
            for bit in range(8):
                bits.append(bool(byte_val & (1 << bit)))
        return bits[:count]

    def write_single_coil(self, unit_id, address, value):
        pdu = struct.pack('>BHH', 0x05, address, 0xFF00 if value else 0x0000)
        data = self._send_receive(unit_id, pdu)
        if data[0] == 0x85: raise Exception(f"错误码 {data[1]}")

    def write_multiple_coils(self, unit_id, address, values):
        count = len(values)
        byte_count = (count + 7) // 8
        coil_bytes = [0] * byte_count
        for i, val in enumerate(values):
            if val: coil_bytes[i // 8] |= (1 << (i % 8))
        pdu = struct.pack('>BHHB', 0x0F, address, count, byte_count) + bytes(coil_bytes)
        data = self._send_receive(unit_id, pdu)
        if data[0] == 0x8F: raise Exception(f"错误码 {data[1]}")


# ========== 厂房可视化 ==========
class FactoryView(tk.Canvas):
    """等距视角厂房 + 16盏工业吊灯"""
    W = 860
    H = 760

    def __init__(self, parent, callback=None):
        super().__init__(parent, bg="#050506", highlightthickness=0,
                         width=self.W, height=self.H, bd=0)
        self.callback = callback
        self.states = [False] * 16
        self.lamps = []
        self._draw_scene()

    def _iso(self, x, y, z=0):
        ox = self.W // 2
        oy = self.H // 2 + 60
        sx = (x - y) * 0.866 + ox
        sy = (x + y) * 0.5 - z + oy
        return sx, sy

    def _poly(self, coords, **kw):
        pts = [c for point in coords for c in self._iso(*point)]
        return self.create_polygon(*pts, **kw)

    def _line(self, p1, p2, **kw):
        a = self._iso(*p1)
        b = self._iso(*p2)
        return self.create_line(*a, *b, **kw)

    def _draw_scene(self):
        # 渐变天空背景
        for i in range(26):
            shade = 6 + i // 3
            color = f"#{shade:02x}{shade:02x}{shade + 3:02x}"
            self.create_rectangle(0, i * 30, self.W, (i + 1) * 30,
                                  fill=color, outline="")

        # 地面阴影
        self._poly([(-310, -160, 0), (310, -160, 0), (310, 160, 0), (-310, 160, 0)],
                   fill="#0c0c0e", outline="")

        # 地面主体
        self._poly([(-300, -150, 0), (300, -150, 0), (300, 150, 0), (-300, 150, 0)],
                   fill="#1a1a1e", outline="#2c2c2e", width=2)

        # 地面网格
        for i in range(-250, 251, 50):
            self._line((i, -150, 0), (i, 150, 0), fill="#222228", width=1)
        for j in range(-100, 101, 50):
            self._line((-300, j, 0), (300, j, 0), fill="#222228", width=1)

        # 后墙
        self._poly([(-300, 150, 0), (300, 150, 0), (300, 150, 150), (-300, 150, 150)],
                   fill="#101012", outline="#2c2c2e", width=1)
        # 左墙
        self._poly([(-300, -150, 0), (-300, 150, 0), (-300, 150, 150), (-300, -150, 150)],
                   fill="#0a0a0c", outline="#2c2c2e", width=1)

        # 后墙装饰线
        for z in range(20, 140, 20):
            self._line((-300, 150, z), (300, 150, z), fill="#18181c", width=1)
        # 左墙装饰线
        for z in range(20, 140, 20):
            self._line((-300, -150, z), (-300, 150, z), fill="#141416", width=1)

        # 屋顶桁架（横向钢梁）
        for x in range(-250, 251, 100):
            self._line((x, -150, 150), (x, 150, 150), fill="#3a3a3c", width=2)

        # 立柱（四角）
        for corner in [(-300, -150), (300, -150), (300, 150), (-300, 150)]:
            self._line((*corner, 0), (*corner, 150), fill="#48484a", width=2)

        # 屋顶边缘
        top_corners = [(-300, -150, 150), (300, -150, 150),
                       (300, 150, 150), (-300, 150, 150)]
        for i in range(4):
            self._line(top_corners[i], top_corners[(i + 1) % 4],
                       fill="#5c5c5e", width=2)

        # 16 盏工业吊灯 (2行 × 8列)
        for i in range(16):
            row = i // 8
            col = i % 8
            x = -245 + col * 70
            y = -60 + row * 120
            z = 130
            self._draw_lamp(i, x, y, z)

        # 左上角标题
        self.create_text(28, 30, anchor="w", text="FACTORY LIVE VIEW",
                         fill="#48484a", font=("SF Pro Display", 9, "bold"))
        self.create_text(28, 52, anchor="w", text="厂房实时状态",
                         fill="#ffffff", font=("SF Pro Display", 18, "bold"))

        # 图例
        self.create_text(28, self.H - 36, anchor="w",
                         text="点击厂房内任意灯具可直接切换状态",
                         fill="#48484a", font=("SF Pro Display", 10))

    def _draw_lamp(self, index, x, y, z):
        top = self._iso(x, y, 150)
        bot = self._iso(x, y, z)
        cx, cy = bot

        # 悬挂线
        wire = self.create_line(*top, *bot, fill="#48484a", width=1)

        # 多层光晕（关闭时隐藏）
        glows = []
        for r, stip in [(65, "gray12"), (45, "gray25"), (30, "gray50")]:
            g = self.create_oval(cx - r, cy - r + 5, cx + r, cy + r + 5,
                                 fill="", outline="", width=0)
            glows.append((g, stip))

        # 灯罩（梯形）
        shade = self.create_polygon(
            cx - 10, cy, cx + 10, cy, cx + 16, cy + 10, cx - 16, cy + 10,
            fill="#2c2c2e", outline="#5c5c5e", width=1, smooth=False
        )

        # 灯泡
        bulb = self.create_oval(cx - 11, cy + 8, cx + 11, cy + 28,
                                fill="#3a3a3c", outline="#5c5c5e", width=1)

        # 编号
        label_bg = self.create_rectangle(cx - 18, cy + 36, cx + 18, cy + 50,
                                         fill="#1c1c1e", outline="#2c2c2e", width=1)
        label = self.create_text(cx, cy + 43, text=f"CH{index + 1:02d}",
                                 fill="#8e8e93",
                                 font=("SF Pro Display", 9, "bold"))

        # 地面光斑（灯亮时投影）
        floor_x, floor_y = self._iso(x, y, 0)
        floor_spot = self.create_oval(floor_x - 30, floor_y - 15,
                                       floor_x + 30, floor_y + 15,
                                       fill="", outline="", width=0)

        # 点击区域
        hit = self.create_rectangle(cx - 22, cy - 8, cx + 22, cy + 54,
                                    fill="", outline="")
        self.tag_bind(hit, "<Button-1>",
                      lambda e, idx=index: self._on_click(idx))
        self.tag_bind(hit, "<Enter>",
                      lambda e, idx=index: self._on_hover(idx, True))
        self.tag_bind(hit, "<Leave>",
                      lambda e, idx=index: self._on_hover(idx, False))

        self.lamps.append({
            'wire': wire, 'glows': glows, 'shade': shade,
            'bulb': bulb, 'label': label, 'label_bg': label_bg,
            'floor_spot': floor_spot, 'hit': hit,
            'cx': cx, 'cy': cy
        })

    def _on_click(self, index):
        if self.callback:
            self.callback(index, not self.states[index])

    def _on_hover(self, index, entering):
        self.config(cursor="hand2" if entering else "")
        lamp = self.lamps[index]
        if not self.states[index]:
            if entering:
                self.itemconfig(lamp['bulb'], fill="#5c5c5e")
                self.itemconfig(lamp['label'], fill="#ffffff")
                self.itemconfig(lamp['label_bg'], outline="#48484a")
            else:
                self.itemconfig(lamp['bulb'], fill="#3a3a3c")
                self.itemconfig(lamp['label'], fill="#8e8e93")
                self.itemconfig(lamp['label_bg'], outline="#2c2c2e")

    def set_state(self, index, state):
        if self.states[index] == state:
            return
        self.states[index] = state
        lamp = self.lamps[index]

        if state:
            # 灯亮 - 温暖的黄色
            self.itemconfig(lamp['bulb'], fill="#ffd93d", outline="#ffe680")
            self.itemconfig(lamp['shade'], fill="#4c3a1e", outline="#ffd93d")
            self.itemconfig(lamp['label'], fill="#ffd93d")
            self.itemconfig(lamp['label_bg'], outline="#ffd93d")
            # 光晕
            for g, stip in lamp['glows']:
                self.itemconfig(g, fill="#ffd93d", stipple=stip)
            # 地面光斑
            self.itemconfig(lamp['floor_spot'], fill="#ffd93d", stipple="gray12")
            # 把光晕放到底部，防止遮挡其他
            for g, _ in lamp['glows']:
                self.tag_raise(g)
            self.tag_raise(lamp['shade'])
            self.tag_raise(lamp['bulb'])
            self.tag_raise(lamp['label_bg'])
            self.tag_raise(lamp['label'])
            self.tag_raise(lamp['hit'])
        else:
            self.itemconfig(lamp['bulb'], fill="#3a3a3c", outline="#5c5c5e")
            self.itemconfig(lamp['shade'], fill="#2c2c2e", outline="#5c5c5e")
            self.itemconfig(lamp['label'], fill="#8e8e93")
            self.itemconfig(lamp['label_bg'], outline="#2c2c2e")
            for g, _ in lamp['glows']:
                self.itemconfig(g, fill="", stipple="")
            self.itemconfig(lamp['floor_spot'], fill="", stipple="")


# ========== 控制行（紧凑型） ==========
class RelayRow(ctk.CTkFrame):
    def __init__(self, parent, index, callback=None):
        super().__init__(parent, fg_color="transparent", height=40)
        self.pack_propagate(False)

        self.index = index
        self.callback = callback
        self.state = False

        # 指示灯圆点
        self.dot = tk.Canvas(self, width=14, height=14, bg="#111113",
                             highlightthickness=0, bd=0)
        self.dot.pack(side="left", padx=(12, 10), pady=12)
        self._draw_dot()

        # 通道号
        self.label = ctk.CTkLabel(self, text=f"CH {index + 1:02d}",
                                  font=("SF Pro Display", 13, "bold"),
                                  text_color="#8e8e93", width=60, anchor="w")
        self.label.pack(side="left")

        # 状态文字
        self.state_txt = ctk.CTkLabel(self, text="OFF",
                                      font=("SF Pro Display", 10, "bold"),
                                      text_color="#48484a", width=35, anchor="w")
        self.state_txt.pack(side="left")

        # iOS 风格开关
        self.switch = ctk.CTkSwitch(self, text="", variable=None, width=44,
                                    button_color="#ffffff",
                                    button_hover_color="#ffffff",
                                    progress_color="#30d158",
                                    fg_color="#3a3a3c",
                                    command=self._on_click)
        self.switch.pack(side="right", padx=14)

        # 悬停高亮
        self.bind("<Enter>", lambda e: self.configure(fg_color="#1a1a1c"))
        self.bind("<Leave>", lambda e: self.configure(fg_color="transparent"))

    def _draw_dot(self):
        self.dot.delete("all")
        if self.state:
            self.dot.create_oval(1, 1, 13, 13, fill="#30d158", outline="")
            self.dot.create_oval(3, 2, 9, 6, fill="#a8f5ba", outline="")
        else:
            self.dot.create_oval(1, 1, 13, 13, fill="#2c2c2e", outline="#48484a")

    def _on_click(self):
        target = bool(self.switch.get())
        if self.callback:
            self.callback(self.index, target)

    def set_state(self, state):
        if self.state == state:
            return
        self.state = state
        self._draw_dot()
        if state:
            self.switch.select()
            self.label.configure(text_color="#ffffff")
            self.state_txt.configure(text="ON", text_color="#30d158")
        else:
            self.switch.deselect()
            self.label.configure(text_color="#8e8e93")
            self.state_txt.configure(text="OFF", text_color="#48484a")


# ========== 主应用 ==========
class DAM1600DApp:
    CONFIG_FILE = "dam1600d_devices.json"

    def __init__(self):
        ctk.set_appearance_mode("dark")
        self.root = ctk.CTk()
        self.root.title("DAM1600D Control Center")
        self.root.geometry("1440x840")
        self.root.minsize(1440, 840)
        self.root.configure(fg_color="#000000")

        self.client = ModbusTCP()
        self.connected = False
        self.unit_id = 254
        self.relay_states = [False] * 16
        self.polling = False
        self.rows = []

        self.devices = []
        self.current_device_idx = -1
        self._load_devices()
        self._build_ui()

    def _load_devices(self):
        if os.path.exists(self.CONFIG_FILE):
            try:
                with open(self.CONFIG_FILE, 'r', encoding='utf-8') as f:
                    self.devices = json.load(f)
            except: pass
        if not self.devices:
            self.devices = [{"name": "默认设备", "ip": "192.168.1.100",
                             "port": 502, "unit_id": 254}]

    def _save_devices(self):
        try:
            with open(self.CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.devices, f, ensure_ascii=False, indent=2)
        except: pass

    def _card(self, parent, **kw):
        return ctk.CTkFrame(parent, fg_color="#111113", corner_radius=20,
                            border_width=1, border_color="#1f1f22", **kw)

    def _build_ui(self):
        # 主容器：左右布局
        main = ctk.CTkFrame(self.root, fg_color="transparent")
        main.pack(fill="both", expand=True, padx=20, pady=20)

        # ========== 左侧：厂房可视化 ==========
        left_card = self._card(main)
        left_card.pack(side="left", fill="both", expand=True, padx=(0, 10))

        self.factory = FactoryView(left_card, callback=self._toggle_relay)
        self.factory.pack(fill="both", expand=True, padx=2, pady=2)

        # ========== 右侧：控制面板 ==========
        right = ctk.CTkFrame(main, fg_color="transparent", width=500)
        right.pack(side="right", fill="y", padx=(10, 0))
        right.pack_propagate(False)

        # 顶部状态卡片
        top_card = self._card(right)
        top_card.pack(fill="x", pady=(0, 10))

        tp = ctk.CTkFrame(top_card, fg_color="transparent")
        tp.pack(fill="x", padx=18, pady=16)

        ctk.CTkLabel(tp, text="DAM1600D",
                     font=("SF Pro Display", 20, "bold"),
                     text_color="#ffffff").pack(anchor="w")
        ctk.CTkLabel(tp, text="16-CHANNEL RELAY CONTROL",
                     font=("SF Pro Display", 9, "bold"),
                     text_color="#48484a").pack(anchor="w", pady=(2, 0))

        st_row = ctk.CTkFrame(tp, fg_color="transparent")
        st_row.pack(fill="x", pady=(14, 0))

        self.status_dot = ctk.CTkLabel(st_row, text="●", font=("Arial", 14),
                                        text_color="#ff453a")
        self.status_dot.pack(side="left")
        self.status_text = ctk.CTkLabel(st_row, text="未连接",
                                         font=("SF Pro Display", 12),
                                         text_color="#98989d")
        self.status_text.pack(side="left", padx=(4, 0))

        self.conn_btn = ctk.CTkButton(st_row, text="连 接", width=84, height=34,
                                       corner_radius=17,
                                       font=("SF Pro Display", 13, "bold"),
                                       fg_color="#30d158", hover_color="#28b94c",
                                       command=self._toggle_connect)
        self.conn_btn.pack(side="right")

        # 设备选择
        dev_card = self._card(right)
        dev_card.pack(fill="x", pady=(0, 10))
        dv = ctk.CTkFrame(dev_card, fg_color="transparent")
        dv.pack(fill="x", padx=18, pady=14)

        ctk.CTkLabel(dv, text="DEVICES",
                     font=("SF Pro Display", 9, "bold"),
                     text_color="#48484a").pack(anchor="w", pady=(0, 8))

        row1 = ctk.CTkFrame(dv, fg_color="transparent")
        row1.pack(fill="x")
        self.device_var = ctk.StringVar()
        self.device_menu = ctk.CTkOptionMenu(
            row1, variable=self.device_var, height=36,
            corner_radius=10, font=("SF Pro Display", 12),
            fg_color="#1c1c1e", button_color="#2c2c2e",
            button_hover_color="#3a3a3c", dropdown_fg_color="#1c1c1e",
            text_color="#ffffff", command=self._on_device_select)
        self.device_menu.pack(side="left", fill="x", expand=True)
        self._refresh_device_list()

        ctk.CTkButton(row1, text="+", width=36, height=36, corner_radius=10,
                      font=("Arial", 16, "bold"),
                      fg_color="#1c1c1e", hover_color="#2c2c2e",
                      text_color="#30d158", border_width=1, border_color="#2c2c2e",
                      command=self._add_device).pack(side="left", padx=(6, 0))
        ctk.CTkButton(row1, text="−", width=36, height=36, corner_radius=10,
                      font=("Arial", 16, "bold"),
                      fg_color="#1c1c1e", hover_color="#2c2c2e",
                      text_color="#ff453a", border_width=1, border_color="#2c2c2e",
                      command=self._del_device).pack(side="left", padx=(4, 0))

        # 通道列表
        list_card = self._card(right)
        list_card.pack(fill="both", expand=True, pady=(0, 10))

        lh = ctk.CTkFrame(list_card, fg_color="transparent")
        lh.pack(fill="x", padx=18, pady=(14, 4))
        ctk.CTkLabel(lh, text="CHANNELS",
                     font=("SF Pro Display", 9, "bold"),
                     text_color="#48484a").pack(side="left")

        # 分组全开全关
        ctk.CTkButton(lh, text="全关", width=44, height=22, corner_radius=11,
                      font=("SF Pro Display", 10, "bold"),
                      fg_color="transparent", hover_color="#2c2c2e",
                      text_color="#ff453a",
                      command=lambda: self._batch(0, 16, False)).pack(side="right", padx=(4, 0))
        ctk.CTkButton(lh, text="全开", width=44, height=22, corner_radius=11,
                      font=("SF Pro Display", 10, "bold"),
                      fg_color="transparent", hover_color="#2c2c2e",
                      text_color="#30d158",
                      command=lambda: self._batch(0, 16, True)).pack(side="right")

        # 两列布局（CH1-8 左列，CH9-16 右列）
        cols = ctk.CTkFrame(list_card, fg_color="transparent")
        cols.pack(fill="both", expand=True, padx=10, pady=(4, 10))

        col_a = ctk.CTkFrame(cols, fg_color="transparent")
        col_a.pack(side="left", fill="both", expand=True, padx=(4, 2))
        col_b = ctk.CTkFrame(cols, fg_color="transparent")
        col_b.pack(side="right", fill="both", expand=True, padx=(2, 4))

        # 组标题 A
        header_a = ctk.CTkFrame(col_a, fg_color="transparent", height=24)
        header_a.pack(fill="x")
        ctk.CTkLabel(header_a, text="GROUP A · 1-8",
                     font=("SF Pro Display", 9, "bold"),
                     text_color="#636366").pack(side="left", padx=6)
        ctk.CTkButton(header_a, text="开", width=28, height=18, corner_radius=9,
                      font=("SF Pro Display", 9),
                      fg_color="transparent", hover_color="#2c2c2e",
                      text_color="#30d158",
                      command=lambda: self._batch(0, 8, True)).pack(side="right", padx=1)
        ctk.CTkButton(header_a, text="关", width=28, height=18, corner_radius=9,
                      font=("SF Pro Display", 9),
                      fg_color="transparent", hover_color="#2c2c2e",
                      text_color="#ff453a",
                      command=lambda: self._batch(0, 8, False)).pack(side="right", padx=1)

        for i in range(8):
            row = RelayRow(col_a, i, callback=self._toggle_relay)
            row.pack(fill="x", pady=1)
            self.rows.append(row)

        # 组标题 B
        header_b = ctk.CTkFrame(col_b, fg_color="transparent", height=24)
        header_b.pack(fill="x")
        ctk.CTkLabel(header_b, text="GROUP B · 9-16",
                     font=("SF Pro Display", 9, "bold"),
                     text_color="#636366").pack(side="left", padx=6)
        ctk.CTkButton(header_b, text="开", width=28, height=18, corner_radius=9,
                      font=("SF Pro Display", 9),
                      fg_color="transparent", hover_color="#2c2c2e",
                      text_color="#30d158",
                      command=lambda: self._batch(8, 16, True)).pack(side="right", padx=1)
        ctk.CTkButton(header_b, text="关", width=28, height=18, corner_radius=9,
                      font=("SF Pro Display", 9),
                      fg_color="transparent", hover_color="#2c2c2e",
                      text_color="#ff453a",
                      command=lambda: self._batch(8, 16, False)).pack(side="right", padx=1)

        for i in range(8, 16):
            row = RelayRow(col_b, i, callback=self._toggle_relay)
            row.pack(fill="x", pady=1)
            self.rows.append(row)

        # 底部操作栏
        bot_card = self._card(right)
        bot_card.pack(fill="x")
        bi = ctk.CTkFrame(bot_card, fg_color="transparent")
        bi.pack(fill="x", padx=14, pady=10)

        ctk.CTkButton(bi, text="刷新", width=64, height=32, corner_radius=10,
                      font=("SF Pro Display", 11),
                      fg_color="#1c1c1e", hover_color="#2c2c2e",
                      text_color="#ffffff", border_width=1, border_color="#2c2c2e",
                      command=self._read_status).pack(side="left", padx=3)

        self.auto_var = ctk.BooleanVar(value=True)
        ctk.CTkSwitch(bi, text="自动刷新", variable=self.auto_var,
                      font=("SF Pro Display", 11),
                      text_color="#98989d",
                      button_color="#ffffff",
                      progress_color="#30d158", fg_color="#3a3a3c",
                      command=self._toggle_polling).pack(side="right", padx=4)

    # ---------- 设备管理 ----------
    def _refresh_device_list(self):
        names = [f"{d['name']}  {d['ip']}:{d['port']}" for d in self.devices]
        self.device_menu.configure(values=names)
        if names:
            self.device_var.set(names[0])
            self.current_device_idx = 0

    def _on_device_select(self, choice):
        for i, d in enumerate(self.devices):
            tag = f"{d['name']}  {d['ip']}:{d['port']}"
            if tag == choice:
                if self.connected: self._disconnect()
                self.current_device_idx = i
                break

    def _add_device(self):
        win = ctk.CTkToplevel(self.root)
        win.title("添加设备")
        win.geometry("460x520")
        win.resizable(False, False)
        win.configure(fg_color="#000000")
        win.transient(self.root)
        win.grab_set()

        ctk.CTkLabel(win, text="添加新设备",
                     font=("SF Pro Display", 20, "bold"),
                     text_color="#ffffff").pack(pady=(28, 4))
        ctk.CTkLabel(win, text="填写设备信息以开始远程控制",
                     font=("SF Pro Display", 11),
                     text_color="#636366").pack(pady=(0, 16))

        form = ctk.CTkFrame(win, fg_color="#111113", corner_radius=16,
                            border_width=1, border_color="#1f1f22")
        form.pack(padx=28, fill="x")

        fields = [("设备名称", "新设备"), ("设备 IP 地址", "192.168.1.100"),
                  ("端口", "502"), ("设备地址", "254")]
        entries = []

        for i, (lb, df) in enumerate(fields):
            ctk.CTkLabel(form, text=lb.upper(),
                         font=("SF Pro Display", 9, "bold"),
                         text_color="#48484a").pack(anchor="w", padx=18,
                                                    pady=(14 if i == 0 else 10, 3))
            e = ctk.CTkEntry(form, height=38, corner_radius=10,
                             font=("SF Pro Display", 13),
                             fg_color="#1c1c1e", border_color="#2c2c2e",
                             border_width=1, text_color="#ffffff")
            e.insert(0, df)
            e.pack(fill="x", padx=18)
            entries.append(e)

        ctk.CTkFrame(form, fg_color="transparent", height=14).pack()

        def save():
            try:
                self.devices.append({
                    "name": entries[0].get().strip() or "未命名",
                    "ip": entries[1].get().strip(),
                    "port": int(entries[2].get().strip()),
                    "unit_id": int(entries[3].get().strip())
                })
                self._save_devices()
                self._refresh_device_list()
                d = self.devices[-1]
                self.device_var.set(f"{d['name']}  {d['ip']}:{d['port']}")
                self.current_device_idx = len(self.devices) - 1
                win.destroy()
            except ValueError:
                messagebox.showerror("错误", "端口和设备地址必须是数字", parent=win)

        btns = ctk.CTkFrame(win, fg_color="transparent")
        btns.pack(fill="x", padx=28, pady=18)

        ctk.CTkButton(btns, text="取消", height=42, corner_radius=12,
                      font=("SF Pro Display", 13, "bold"),
                      fg_color="#1c1c1e", hover_color="#2c2c2e",
                      text_color="#ffffff", border_width=1, border_color="#2c2c2e",
                      command=win.destroy).pack(side="left", fill="x", expand=True, padx=(0, 6))

        ctk.CTkButton(btns, text="确认添加", height=42, corner_radius=12,
                      font=("SF Pro Display", 13, "bold"),
                      fg_color="#30d158", hover_color="#28b94c", text_color="#ffffff",
                      command=save).pack(side="left", fill="x", expand=True, padx=(6, 0))

    def _del_device(self):
        if len(self.devices) <= 1:
            messagebox.showwarning("提示", "至少保留一个设备")
            return
        idx = self.current_device_idx
        if idx < 0: return
        if self.connected: self._disconnect()
        name = self.devices[idx]['name']
        if messagebox.askyesno("确认删除", f"确定删除设备 \"{name}\"?"):
            self.devices.pop(idx)
            self._save_devices()
            self._refresh_device_list()

    # ---------- 连接 ----------
    def _toggle_connect(self):
        if self.connected: self._disconnect()
        else: self._connect()

    def _connect(self):
        idx = self.current_device_idx
        if idx < 0: return
        dev = self.devices[idx]
        self.unit_id = dev['unit_id']
        try:
            if self.client.connect(dev['ip'], dev['port']):
                self.connected = True
                self.conn_btn.configure(text="断 开", fg_color="#ff453a",
                                         hover_color="#d93025")
                self.status_dot.configure(text_color="#30d158")
                self.status_text.configure(text=f"{dev['name']}",
                                            text_color="#30d158")
                self._read_status()
                if self.auto_var.get(): self._start_polling()
            else:
                messagebox.showerror("错误", "连接失败，请检查IP和端口")
        except Exception as e:
            messagebox.showerror("错误", f"异常: {e}")

    def _disconnect(self):
        self.polling = False
        self.client.close()
        self.connected = False
        self.conn_btn.configure(text="连 接", fg_color="#30d158",
                                 hover_color="#28b94c")
        self.status_dot.configure(text_color="#ff453a")
        self.status_text.configure(text="未连接", text_color="#98989d")

    # ---------- 控制 ----------
    def _toggle_relay(self, index, state):
        if not self.connected:
            messagebox.showwarning("提示", "请先连接设备")
            self.rows[index].set_state(not state)
            return

        def do():
            try:
                self.client.write_single_coil(self.unit_id, index, state)
                self.relay_states[index] = state
                self.root.after(0, lambda: self.rows[index].set_state(state))
                self.root.after(0, lambda: self.factory.set_state(index, state))
            except Exception as e:
                self.root.after(0, lambda: self.rows[index].set_state(not state))
                self.root.after(0, lambda: messagebox.showerror("错误", str(e)))

        threading.Thread(target=do, daemon=True).start()

    def _batch(self, start, end, state):
        if not self.connected:
            messagebox.showwarning("提示", "请先连接设备")
            return

        def do():
            try:
                self.client.write_multiple_coils(self.unit_id, start, [state] * (end - start))
                for i in range(start, end):
                    self.relay_states[i] = state
                self.root.after(0, self._update_all)
            except Exception as e:
                self.root.after(0, lambda: messagebox.showerror("错误", str(e)))

        threading.Thread(target=do, daemon=True).start()

    def _read_status(self):
        if not self.connected: return

        def do():
            try:
                self.relay_states = self.client.read_coils(self.unit_id, 0, 16)
                self.root.after(0, self._update_all)
            except: pass

        threading.Thread(target=do, daemon=True).start()

    def _update_all(self):
        for i in range(16):
            self.rows[i].set_state(self.relay_states[i])
            self.factory.set_state(i, self.relay_states[i])

    def _toggle_polling(self):
        if self.auto_var.get() and self.connected: self._start_polling()
        else: self.polling = False

    def _start_polling(self):
        self.polling = True
        threading.Thread(target=self._poll_loop, daemon=True).start()

    def _poll_loop(self):
        while self.polling and self.connected:
            try:
                self.relay_states = self.client.read_coils(self.unit_id, 0, 16)
                self.root.after(0, self._update_all)
            except: pass
            time.sleep(1)

    def run(self):
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.mainloop()

    def _on_close(self):
        self.polling = False
        self.client.close()
        self.root.destroy()


if __name__ == "__main__":
    DAM1600DApp().run()