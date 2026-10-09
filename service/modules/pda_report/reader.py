"""Receive-only TCP reader capture owned by one integrated service process."""

from __future__ import annotations

import atexit
import codecs
import hashlib
import ipaddress
import json
import math
import os
import socket
import sqlite3
import tempfile
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

from flask import current_app

from .services import ServiceConfigurationError, database_path, get_store, validate_event


DEFAULT_CONFIG = {
    "host": "192.168.30.180",
    "port": 51236,
    "enabled": False,
    "framing": "auto",
    "encoding": "utf-8",
    "idle_ms": 300,
    "fixed_length": 0,
    "reconnect_seconds": 3,
    "dedupe_seconds": 0,
}
MAX_FRAME_BYTES = 65536
_READERS_LOCK = threading.Lock()


class ReaderBusyError(RuntimeError):
    """A reader worker or another service process owns capture management."""


class ReaderStorageError(RuntimeError):
    """Reader configuration or capture state cannot be persisted."""


def _integer(value, label, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{label}必须是 {minimum} 至 {maximum} 的整数")
    return value


def _number(value, label, minimum, maximum):
    if type(value) not in (int, float) or not minimum <= value <= maximum or not math.isfinite(value):
        raise ValueError(f"{label}必须是 {minimum} 至 {maximum} 的数字")
    return value


def normalize_config(config):
    if not isinstance(config, dict) or config.keys() - DEFAULT_CONFIG.keys():
        raise ValueError("读码器配置必须是对象，且不能包含未知字段")
    result = {**DEFAULT_CONFIG, **config}
    if not isinstance(result["host"], str) or "%" in result["host"]:
        raise ValueError("读码器地址必须是有效的 IPv4 或 IPv6 地址")
    try:
        result["host"] = str(ipaddress.ip_address(result["host"].strip()))
    except ValueError as exc:
        raise ValueError("读码器地址必须是有效的 IPv4 或 IPv6 地址") from exc
    result["port"] = _integer(result["port"], "端口", 1, 65535)
    if type(result["enabled"]) is not bool:
        raise ValueError("启用状态必须为布尔值")
    if not isinstance(result["framing"], str) or result["framing"] not in {"auto", "line", "stx_etx", "fixed"}:
        raise ValueError("分帧方式必须为 auto、line、stx_etx 或 fixed")
    if not isinstance(result["encoding"], str):
        raise ValueError("字符编码必须是文本")
    try:
        encoding = codecs.lookup(result["encoding"].strip()).name
        sample = "A\r\n\x02\x03".encode(encoding, errors="strict")
        if sample.decode(encoding, errors="strict") != "A\r\n\x02\x03":
            raise ValueError()
    except (LookupError, TypeError, UnicodeError, ValueError) as exc:
        raise ValueError("字符编码无效，请使用 utf-8、gb18030 等文本编码") from exc
    if result["framing"] != "fixed" and sample != b"A\r\n\x02\x03":
        raise ValueError("当前分帧方式要求兼容 ASCII 的编码；UTF-16 等请使用定长分帧")
    result["encoding"] = encoding
    result["idle_ms"] = _integer(result["idle_ms"], "空闲分帧间隔", 50, 10000)
    result["fixed_length"] = _integer(result["fixed_length"], "固定字节长度", 0, MAX_FRAME_BYTES)
    if result["framing"] == "fixed" and result["fixed_length"] == 0:
        raise ValueError("定长分帧必须设置大于 0 的固定字节长度")
    result["reconnect_seconds"] = _number(result["reconnect_seconds"], "重连间隔", 0.2, 300)
    result["dedupe_seconds"] = _number(result["dedupe_seconds"], "重复码过滤秒数", 0, 3600)
    return result


class FrameParser:
    """Frame bounded bytes before decoding, never promote EOF fragments to scans."""

    def __init__(self, config):
        self.mode = config["framing"]
        self.idle_seconds = config["idle_ms"] / 1000
        self.fixed_length = config["fixed_length"]
        self.buffer = bytearray()
        self.in_stx = False
        self.dropping = False
        self.last_received = 0.0

    def feed(self, data, now=None):
        self.last_received = time.monotonic() if now is None else now
        frames, warnings = [], []
        if self.mode == "fixed":
            self.buffer.extend(data)
            while len(self.buffer) >= self.fixed_length:
                frames.append(bytes(self.buffer[:self.fixed_length]))
                del self.buffer[:self.fixed_length]
            return frames, warnings
        noise_count = 0
        for value in data:
            if self.mode in {"auto", "stx_etx"}:
                if value == 2:
                    if self.buffer or self.in_stx:
                        warnings.append("收到新的 STX，前一段未闭合数据已拒绝，请检查分帧配置")
                    self.buffer.clear()
                    self.in_stx, self.dropping = True, False
                    continue
                if value == 3:
                    if self.in_stx:
                        if self.buffer and not self.dropping:
                            frames.append(bytes(self.buffer))
                    else:
                        warnings.append("收到未配对的 ETX，相关未闭合数据已拒绝")
                    self.buffer.clear()
                    self.in_stx, self.dropping = False, False
                    continue
                if self.mode == "stx_etx" and not self.in_stx:
                    if value not in (10, 13):
                        noise_count += 1
                    continue
            if not self.in_stx and value in (10, 13):
                if self.buffer and not self.dropping:
                    frames.append(bytes(self.buffer))
                self.buffer.clear()
                self.dropping = False
                continue
            if self.dropping:
                continue
            self.buffer.append(value)
            if len(self.buffer) > MAX_FRAME_BYTES:
                self.buffer.clear()
                self.dropping = True
                warnings.append(f"单帧超过 {MAX_FRAME_BYTES} 字节，已拒绝并等待下一个边界")
        if noise_count:
            warnings.append(f"已拒绝 STX/ETX 帧外的 {noise_count} 字节，请检查输出格式")
        return frames, warnings

    def idle(self, now=None):
        now = time.monotonic() if now is None else now
        if self.mode != "auto" or self.in_stx or now - self.last_received < self.idle_seconds:
            return []
        if self.dropping:
            self.dropping = False
            return []
        if not self.buffer:
            return []
        frame = bytes(self.buffer)
        self.buffer.clear()
        return [frame]

    def finish(self):
        warning = None
        if self.buffer or self.in_stx or self.dropping:
            warning = f"连接结束时有未完成帧（{len(self.buffer)} 字节），未计为入库，请检查分帧方式"
        self.buffer.clear()
        self.in_stx, self.dropping = False, False
        return warning


class _DirectoryLease:
    """Nonblocking process lock; the OS releases it even after abrupt exit."""

    def __init__(self, directory):
        self.handle = None
        try:
            directory.mkdir(parents=True, exist_ok=True)
            handle = (directory / ".reader-capture.lock").open("a+b")
            if handle.seek(0, os.SEEK_END) == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
        except OSError as exc:
            if "handle" in locals():
                handle.close()
            raise ReaderStorageError("无法创建读码器运行锁，请检查数据目录权限") from exc
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            handle.close()
            raise ReaderBusyError("同一数据目录已有其他服务进程正在采集，请先停止该进程") from exc
        self.handle = handle

    def close(self):
        handle, self.handle = self.handle, None
        if handle is None:
            return
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


def _atomic_settings(path, settings):
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=str(path.parent),
            prefix="reader-settings.", suffix=".tmp", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            json.dump(settings, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except (OSError, ValueError) as exc:
        raise ReaderStorageError("无法保存读码器配置，请检查数据目录权限和磁盘空间") from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def _unique_settings(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("配置字段重复")
        result[key] = value
    return result


def _read_settings(path):
    try:
        with path.open("rb") as handle:
            raw = handle.read(65537)
        if len(raw) > 65536:
            raise ValueError()
        return normalize_config(json.loads(raw.decode("utf-8-sig"), object_pairs_hook=_unique_settings))
    except FileNotFoundError:
        return dict(DEFAULT_CONFIG)
    except (OSError, UnicodeError, ValueError, RecursionError, OverflowError) as exc:
        raise ReaderStorageError("读码器配置无法读取或内容无效，请检查数据目录并重新保存配置") from exc


def _initial_status():
    return {
        "state": "stopped", "running": False, "connected": False,
        "message": "自动采集未启动", "received_count": 0, "saved_count": 0,
        "filtered_count": 0, "rejected_count": 0, "pending_count": 0,
        "unsaved_count": 0, "last_scan_at": "", "last_barcode": "", "last_error": "",
    }


class ReaderController:
    def __init__(self, app):
        self.app = app
        self._lock = threading.RLock()
        self._management_lock = threading.Lock()
        self._socket_lock = threading.Lock()
        self._thread = None
        self._socket = None
        self._stop_requested = threading.Event()
        self._config = dict(DEFAULT_CONFIG)
        self._status = _initial_status()
        self._directory = None
        self._load_error = ""
        self._halt_error = ""
        try:
            with app.app_context():
                self._directory = database_path().resolve().parent
            self._config = _read_settings(self._directory / "reader-settings.json")
        except (OSError, UnicodeError, ValueError, ReaderStorageError, ServiceConfigurationError):
            self._load_error = "读码器配置无法读取或内容无效，请检查数据目录并重新保存配置"
            self._set_status(state="error", message=self._load_error, last_error=self._load_error)

    def _set_status(self, **values):
        with self._lock:
            self._status.update(values)

    def snapshot(self):
        with self._lock:
            status = dict(self._status)
            status["running"] = bool(self._thread and self._thread.is_alive())
            return {"ok": True, "config": dict(self._config), "status": status}

    def _busy(self):
        if not self._management_lock.acquire(blocking=False):
            raise ReaderBusyError("读码器正在处理另一项启停或配置操作，请稍后再试")

    def _settings_path(self):
        if self._directory is None:
            raise ReaderStorageError("读码器数据目录无效，请先修正服务配置")
        return self._directory / "reader-settings.json"

    def configure(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("读码器配置必须为 JSON 对象")
        if "enabled" in payload:
            raise ValueError("请通过启动或停止操作变更启用状态")
        if payload.keys() - (DEFAULT_CONFIG.keys() - {"enabled"}):
            raise ValueError("读码器配置包含未知字段")
        self._busy()
        try:
            if self._thread and self._thread.is_alive():
                raise ReaderBusyError("采集运行中不能修改配置，请先停止采集")
            path = self._settings_path()
            lease = _DirectoryLease(path.parent)
            try:
                try:
                    latest = _read_settings(path)
                except ReaderStorageError:
                    # An explicit save can repair a damaged settings file.
                    with self._lock:
                        latest = dict(self._config)
                updated = normalize_config({**latest, **payload})
                _atomic_settings(path, updated)
            finally:
                lease.close()
            with self._lock:
                self._config = updated
                self._load_error = ""
                self._status["message"] = "配置已保存，可启动自动采集"
                if not self._status["unsaved_count"]:
                    self._status.update(state="stopped", last_error="")
            return self.snapshot()
        finally:
            self._management_lock.release()

    def start(self):
        self._busy()
        lease = None
        try:
            if self._thread and self._thread.is_alive():
                if self._stop_requested.is_set():
                    raise ReaderBusyError("上一次采集正在停止，请等待收尾完成后再启动")
                return self.snapshot()
            path = self._settings_path()
            lease = _DirectoryLease(path.parent)
            config = {**_read_settings(path), "enabled": True}
            _atomic_settings(path, config)
            self._stop_requested = threading.Event()
            with self._lock:
                self._config = config
                self._load_error = ""
                self._halt_error = ""
                self._status = _initial_status()
                self._status.update(state="connecting", message="正在启动自动采集")
                worker = threading.Thread(
                    target=self._run, args=(config, self._stop_requested, lease),
                    name="IntegratedWarehouseReader", daemon=True,
                )
                self._thread = worker
            worker.start()
            lease = None  # The worker owns the process lock through its final cleanup.
            return self.snapshot()
        except (ReaderBusyError, ReaderStorageError) as exc:
            self._set_status(state="error", message=str(exc), last_error=str(exc))
            raise
        except RuntimeError as exc:
            self._set_status(state="error", message="无法启动读码器采集线程", last_error="无法启动读码器采集线程")
            raise ReaderStorageError("无法启动读码器采集线程") from exc
        finally:
            if lease is not None:
                lease.close()
            self._management_lock.release()

    def _close_socket(self):
        with self._socket_lock:
            current = self._socket
            if current is not None:
                try:
                    current.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                try:
                    current.close()
                except OSError:
                    pass

    def _halt(self, wait_seconds=0.25):
        # Publish the transition before waking the worker. Its final unsaved
        # warning must win over this temporary message, never the reverse.
        with self._lock:
            self._status["connected"] = False
            if self._thread and self._thread.is_alive() and not self._status["unsaved_count"]:
                self._status["state"] = "stopped"
                self._status["message"] = "正在停止，等待已接收扫码的保存结果"
        self._stop_requested.set()
        self._close_socket()
        thread = self._thread
        if thread and thread is not threading.current_thread() and thread.is_alive():
            thread.join(timeout=wait_seconds)

    def stop(self):
        self._busy()
        try:
            # Stop the socket even if the settings disk is unavailable.
            save_error = None
            try:
                path = self._settings_path()
                lease = None
                if not self._thread or not self._thread.is_alive():
                    lease = _DirectoryLease(path.parent)
                try:
                    updated = {**_read_settings(path), "enabled": False}
                    _atomic_settings(path, updated)
                finally:
                    if lease is not None:
                        lease.close()
                with self._lock:
                    self._config = updated
            except (ReaderBusyError, ReaderStorageError) as exc:
                save_error = exc
            self._halt()
            if save_error:
                message = (
                    "其他服务进程正在采集，当前进程无法停止，请使用单进程部署"
                    if isinstance(save_error, ReaderBusyError)
                    else "已请求停止，但未能保存停用状态；下次重启可能仍自动采集"
                )
                self._halt_error = message
                self._set_status(state="error", message=message, last_error=message)
                raise save_error
            if not self._thread or not self._thread.is_alive():
                with self._lock:
                    if not self._status["unsaved_count"] and self._status["state"] != "error":
                        self._status.update(state="stopped", message="自动采集已停止", connected=False)
            return self.snapshot()
        finally:
            self._management_lock.release()

    def shutdown(self):
        """Process exit preserves enabled so the next service start can resume."""
        self._halt(wait_seconds=0.25)

    def _warning(self, message, rejected=1):
        with self._lock:
            self._status["rejected_count"] += rejected
            self._status["last_error"] = message

    def _persist(self, frame, config, store, stop_event, recent):
        scanned_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
        try:
            barcode = frame.decode(config["encoding"], errors="strict")
            payload = {
                "event_id": str(uuid.uuid4()), "barcode": barcode, "source": "reader",
                "operation": "inbound", "scanned_at": scanned_at,
                "device_id": f"reader-{config['host']}:{config['port']}",
                "reader_host": config["host"], "reader_port": config["port"],
            }
            validate_event(payload)
        except (UnicodeError, LookupError, ValueError):
            self._warning("收到的扫码无法解码或内容无效，已拒绝入库，请检查编码和分帧配置")
            return True
        with self._lock:
            self._status.update(last_scan_at=scanned_at, last_barcode=barcode[:512])
        now = time.monotonic()
        window = config["dedupe_seconds"]
        digest = None
        if window:
            digest = hashlib.sha256(barcode.encode("utf-8")).digest()
            while recent and next(iter(recent.values())) <= now - window:
                recent.popitem(last=False)
            if digest in recent:
                with self._lock:
                    self._status["filtered_count"] += 1
                return True
        self._set_status(pending_count=1)
        while True:
            try:
                result = store.ingest(payload)
                if not isinstance(result, dict) or not result.get("ok"):
                    raise ReaderStorageError("扫码存储没有返回成功确认")
                with self._lock:
                    self._status["saved_count"] += 1
                    self._status["pending_count"] = 0
                    if not stop_event.is_set():
                        self._status.update(state="connected", message="已连接读码器，自动采集运行中")
                if window:
                    recent[digest] = time.monotonic()
                    if len(recent) > 10000:
                        recent.popitem(last=False)
                        self._warning("重复码过滤缓存已达 10000 项，最早记录已移出过滤范围", rejected=0)
                return True
            except (sqlite3.Error, OSError, ReaderStorageError):
                self._set_status(
                    state="error", message="扫码入库失败，已暂停接收并重试当前事件",
                    last_error="扫码入库尚未成功，当前事件保留相同编号重试，请检查数据库和磁盘",
                )
                if stop_event.wait(0.5):
                    return False
            except Exception:
                self._set_status(state="error", last_error="扫码保存发生不可恢复错误，已停止自动采集")
                return False

    def _run(self, config, stop_event, lease):
        recent = OrderedDict()
        fatal = False
        try:
            with self.app.app_context():
                try:
                    if database_path().resolve().parent != self._directory:
                        raise ValueError("运行数据目录已变更")
                    store = get_store()
                except (sqlite3.Error, OSError, ValueError, ServiceConfigurationError):
                    fatal = True
                    self._set_status(state="error", message="扫码数据库无法打开，自动采集未开始", last_error="扫码数据库无法打开，请检查数据目录和磁盘")
                    return
                while not stop_event.is_set():
                    parser = FrameParser(config)
                    current = None
                    try:
                        self._set_status(state="connecting", connected=False, message=f"正在连接读码器 {config['host']}:{config['port']}")
                        family = socket.AF_INET6 if ipaddress.ip_address(config["host"]).version == 6 else socket.AF_INET
                        current = socket.socket(family, socket.SOCK_STREAM)
                        with self._socket_lock:
                            self._socket = current
                        current.settimeout(1.0)
                        if stop_event.is_set():
                            break
                        current.connect((config["host"], config["port"]))
                        current.settimeout(min(0.1, config["idle_ms"] / 1000))
                        current.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
                        try:
                            if hasattr(socket, "SIO_KEEPALIVE_VALS"):
                                current.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 10000, 3000))
                            elif hasattr(socket, "TCP_KEEPIDLE"):
                                current.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 10)
                                current.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 3)
                                current.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
                        except OSError:
                            pass  # Keep OS defaults on platforms without tunable keepalive.
                        if stop_event.is_set():
                            break
                        self._set_status(state="connected", connected=True, message="已连接读码器，等待扫码")
                        while not stop_event.is_set():
                            try:
                                data = current.recv(8192)
                            except socket.timeout:
                                frames = parser.idle()
                            else:
                                if not data:
                                    break
                                frames, warnings = parser.feed(data)
                                for warning in warnings:
                                    self._warning(warning)
                            with self._lock:
                                self._status["received_count"] += len(frames)
                            for index, frame in enumerate(frames):
                                if not self._persist(frame, config, store, stop_event, recent):
                                    unsaved = len(frames) - index
                                    with self._lock:
                                        self._status["pending_count"] = 0
                                        self._status["unsaved_count"] += unsaved
                                        self._status["rejected_count"] += unsaved
                                        message = f"采集已停止，有 {unsaved} 条已接收完整扫码未确认入库，请人工核对"
                                        self._status.update(state="error", message=message, last_error=message)
                                    fatal = True
                                    stop_event.set()
                                    break
                    except OSError:
                        if not stop_event.is_set():
                            self._set_status(last_error="读码器连接失败或中断，正在等待自动重连")
                    finally:
                        warning = parser.finish()
                        if warning:
                            self._warning(warning)
                        with self._socket_lock:
                            self._socket = None
                        if current is not None:
                            try:
                                current.close()
                            except OSError:
                                pass
                        self._set_status(connected=False)
                    if stop_event.is_set():
                        break
                    delay = config["reconnect_seconds"]
                    self._set_status(state="retrying", message=f"连接中断，{delay:g} 秒后自动重连")
                    stop_event.wait(delay)
        except Exception:
            fatal = True
            self._set_status(state="error", message="自动采集发生异常并已停止，请检查服务运行环境", last_error="自动采集发生异常并已停止")
        finally:
            self._close_socket()
            # Management must finish its settings write before releasing ownership.
            # stop() uses a bounded join, so waiting here cannot block its request.
            with self._management_lock:
                try:
                    lease.close()
                except OSError:
                    pass
                with self._lock:
                    self._status.update(connected=False, running=False)
                    if not fatal:
                        if self._halt_error:
                            self._status.update(state="error", message=self._halt_error, last_error=self._halt_error)
                        else:
                            self._status.update(state="stopped", message="自动采集已停止")


def get_reader(app=None):
    if app is None:
        app = current_app._get_current_object()
    with _READERS_LOCK:
        controller = app.extensions.get("pda_reader")
        if controller is None:
            controller = ReaderController(app)
            app.extensions["pda_reader"] = controller
            atexit.register(controller.shutdown)
        return controller


def start_reader_service(app):
    """Called once at service startup; failures must not stop unrelated modules."""
    controller = None
    try:
        controller = get_reader(app)
        if controller.snapshot()["config"]["enabled"]:
            return controller.start()
    except Exception:
        app.logger.error("Reader automatic startup failed; inspect reader status")
        if controller is None:
            status = _initial_status()
            status.update(state="error", message="自动采集初始化失败，请检查服务配置", last_error="自动采集初始化失败")
            return {"ok": True, "config": dict(DEFAULT_CONFIG), "status": status}
    return controller.snapshot()
