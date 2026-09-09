import copy
import json
import os
import secrets
import sys


class Config:
    # 未显式配置时每次启动生成随机密钥，避免控制权限会话被固定默认值伪造。
    SECRET_KEY = os.getenv('FLASK_SECRET_KEY') or secrets.token_hex(32)
    BASE_DIR = (
        os.path.dirname(sys.executable)
        if getattr(sys, 'frozen', False)
        else os.path.dirname(os.path.abspath(__file__))
    )
    CONFIG_FILE = os.path.join(BASE_DIR, 'config.json')
    UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')
    OUTPUT_FOLDER = os.path.join(BASE_DIR, '输出文件')
    DATA_FOLDER = os.path.join(BASE_DIR, 'data')

    # 默认数据配置
    DEFAULT_CONFIG = {
        "配置版本": 2,
        "输入文件": "数据文件.txt",
        "校验文件": "校验文件.txt",
        "输出目录": "输出文件",
        "文件编码": "utf-8",
        "输出文件前缀": "排序数据_",
        "序号记录文件": "last_numbers.json",
        "编号下限列表": [1, 1, 1, 1, 1, 1, 1, 1, 1],
        "编号上限列表": [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
        "错误处理": {
            "启用校验": True,
            "错误时设置": [1, 1, 1, 1, 1, 1, 1, 1, 1],
        },
        "首次同步": {
            "拉取全部历史": False,
            "回溯小时": 24,
        },
        "定时处理": {
            "启用": True,
            "间隔小时": 0,
            "间隔分钟": 30,
            "间隔秒": 0,
            "失败重试": True,
            "重试间隔": 60,
        },
    }

    @staticmethod
    def init_folders():
        """初始化必要的文件夹"""
        folders = [Config.UPLOAD_FOLDER, Config.OUTPUT_FOLDER, Config.DATA_FOLDER]
        for folder in folders:
            os.makedirs(folder, exist_ok=True)

    @classmethod
    def _merge_defaults(cls, config):
        """补齐旧配置中缺少的字段，同时保留用户已经设置的值。"""
        merged = copy.deepcopy(cls.DEFAULT_CONFIG)
        if not isinstance(config, dict):
            return merged

        for key, value in config.items():
            if isinstance(value, dict) and isinstance(merged.get(key), dict):
                merged[key].update(value)
            else:
                merged[key] = value

        for key in ('编号下限列表', '编号上限列表'):
            defaults = cls.DEFAULT_CONFIG[key]
            values = merged.get(key)
            if not isinstance(values, list):
                merged[key] = copy.deepcopy(defaults)
                continue
            merged[key] = (values + defaults[len(values):])[:len(defaults)]

        if not isinstance(merged.get('错误处理'), dict):
            merged['错误处理'] = copy.deepcopy(cls.DEFAULT_CONFIG['错误处理'])
        if not isinstance(merged.get('定时处理'), dict):
            merged['定时处理'] = copy.deepcopy(cls.DEFAULT_CONFIG['定时处理'])
        if not isinstance(merged.get('首次同步'), dict):
            merged['首次同步'] = copy.deepcopy(cls.DEFAULT_CONFIG['首次同步'])

        error_settings = merged['错误处理'].get('错误时设置')
        error_defaults = cls.DEFAULT_CONFIG['错误处理']['错误时设置']
        if not isinstance(error_settings, list):
            merged['错误处理']['错误时设置'] = copy.deepcopy(error_defaults)
        else:
            merged['错误处理']['错误时设置'] = (
                error_settings + error_defaults[len(error_settings):]
            )[:len(error_defaults)]
        return merged

    @classmethod
    def save_json_config(cls, config):
        """将配置稳定地保存到程序目录，避免受启动工作目录影响。"""
        normalized = cls._merge_defaults(config)
        os.makedirs(cls.BASE_DIR, exist_ok=True)
        temp_file = cls.CONFIG_FILE + '.tmp'
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(normalized, f, ensure_ascii=False, indent=4)
        os.replace(temp_file, cls.CONFIG_FILE)
        return normalized

    @classmethod
    def ensure_json_config(cls):
        """首次运行时生成 config.json，并自动升级旧配置的缺失字段。"""
        if not os.path.exists(cls.CONFIG_FILE):
            return cls.save_json_config(cls.DEFAULT_CONFIG)

        try:
            with open(cls.CONFIG_FILE, 'r', encoding='utf-8') as f:
                current = json.load(f)
            if int(current.get('配置版本', 1) or 1) < 2:
                timer = current.get('定时处理')
                if (
                    isinstance(timer, dict)
                    and timer.get('启用') is True
                    and timer.get('间隔小时') == 24
                    and timer.get('间隔分钟') == 0
                    and timer.get('间隔秒') == 0
                ):
                    timer['间隔小时'] = 0
                    timer['间隔分钟'] = 30
                current['配置版本'] = 2
            normalized = cls._merge_defaults(current)
            if normalized != current:
                cls.save_json_config(normalized)
            return normalized
        except (OSError, ValueError, TypeError):
            return cls._merge_defaults(cls.DEFAULT_CONFIG)

    @classmethod
    def load_json_config(cls):
        """加载 JSON 配置；新环境会自动创建默认配置文件。"""
        return cls.ensure_json_config()
