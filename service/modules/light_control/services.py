import os
import threading
import time
from urllib.parse import urljoin

import requests


class LightControlUpstreamError(RuntimeError):
    def __init__(self, message, status_code=502, payload=None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload if isinstance(payload, dict) else None


class LightControlService:
    """只代理客户灯控服务中展示和控制所需的白名单接口。"""

    DEFAULT_BASE_URL = "http://192.168.30.151:8888"
    CONFIG_CACHE_SECONDS = 30

    def __init__(self):
        self._config_cache = None
        self._config_cache_at = 0.0
        self._config_lock = threading.Lock()

    @property
    def base_url(self):
        return os.getenv("LIGHT_CONTROL_BASE_URL", self.DEFAULT_BASE_URL).rstrip("/")

    @property
    def timeout(self):
        raw_value = os.getenv("LIGHT_CONTROL_TIMEOUT_SECONDS", "8")
        try:
            return max(1.0, min(float(raw_value), 30.0))
        except (TypeError, ValueError):
            return 8.0

    def request_json(self, endpoint, method="GET", payload=None):
        url = urljoin(self.base_url + "/", endpoint.lstrip("/"))
        try:
            # 客户现场地址是局域网 IP，不应被系统 HTTP 代理转发到外网。
            with requests.Session() as http:
                http.trust_env = False
                response = http.request(
                    method,
                    url,
                    json=payload if payload is not None else None,
                    timeout=(3.0, self.timeout),
                    headers={"Accept": "application/json"},
                )
        except requests.RequestException as exc:
            raise LightControlUpstreamError(
                "无法连接客户灯控服务，请确认综合系统已部署在客户现场网络中"
            ) from exc

        try:
            data = response.json()
        except ValueError:
            data = None

        if not response.ok:
            message = (
                data.get("error")
                if isinstance(data, dict) and data.get("error")
                else "客户灯控服务返回错误（HTTP {}）".format(response.status_code)
            )
            raise LightControlUpstreamError(message, response.status_code, data)

        if not isinstance(data, dict):
            raise LightControlUpstreamError("客户灯控服务返回了无法识别的数据")
        return data

    def get_config(self, force=False):
        now = time.monotonic()
        with self._config_lock:
            if (
                not force
                and self._config_cache is not None
                and now - self._config_cache_at < self.CONFIG_CACHE_SECONDS
            ):
                return self._config_cache

            config = self.request_json("/api/config")
            self._config_cache = config
            self._config_cache_at = now
            return config

    def get_configured_device(self, ip):
        device_ip = str(ip or "").strip()
        if not device_ip:
            raise ValueError("缺少设备 IP")

        for device in self.get_config().get("devices", []):
            if isinstance(device, dict) and str(device.get("ip", "")).strip() == device_ip:
                return device
        raise ValueError("目标设备不在客户灯控配置中")

    def connect_configured_device(self, ip):
        device = self.get_configured_device(ip)
        return self.request_json("/api/connect", method="POST", payload=device)

    def toggle(self, payload):
        device = self.get_configured_device(payload.get("ip"))
        channel = self._integer(payload.get("channel"), "通道")
        channel_count = self._integer(device.get("channel_count", 32), "通道数量")
        if channel < 0 or channel >= channel_count:
            raise ValueError("目标通道超出设备配置范围")
        value = self._boolean(payload.get("value"), "开关状态")
        return self.request_json(
            "/api/toggle",
            method="POST",
            payload={"ip": device["ip"], "channel": channel, "value": value},
        )

    def batch(self, payload):
        device = self.get_configured_device(payload.get("ip"))
        start = self._integer(payload.get("start"), "起始通道")
        end = self._integer(payload.get("end"), "结束通道")
        channel_count = self._integer(device.get("channel_count", 32), "通道数量")
        if start < 0 or end <= start or end > channel_count:
            raise ValueError("批量控制范围超出设备配置")
        value = self._boolean(payload.get("value"), "开关状态")
        return self.request_json(
            "/api/batch",
            method="POST",
            payload={"ip": device["ip"], "start": start, "end": end, "value": value},
        )

    @staticmethod
    def _integer(value, label):
        if isinstance(value, bool):
            raise ValueError("{}格式不正确".format(label))
        try:
            return int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError("{}格式不正确".format(label)) from exc

    @staticmethod
    def _boolean(value, label):
        if not isinstance(value, bool):
            raise ValueError("{}格式不正确".format(label))
        return value


light_control_service = LightControlService()
