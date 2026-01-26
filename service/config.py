import os


class Config:
    SECRET_KEY = 'your-secret-key-here'
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    UPLOAD_FOLDER = os.path.join(BASE_DIR, 'uploads')
    OUTPUT_FOLDER = os.path.join(BASE_DIR, '输出文件')
    DATA_FOLDER = os.path.join(BASE_DIR, 'data')

    # 默认数据配置
    DEFAULT_CONFIG = {
        "输入文件": "数据文件.txt",
        "校验文件": "校验文件.txt",
        "输出目录": "输出文件",
        "文件编码": "utf-8",
        "输出文件前缀": "排序数据_",
        "编号下限列表": [1, 1, 1, 1, 1, 1, 1],
        "编号上限列表": [1000, 1000, 1000, 1000, 1000, 1000, 1000],
    }

    @staticmethod
    def init_folders():
        """初始化必要的文件夹"""
        folders = [Config.UPLOAD_FOLDER, Config.OUTPUT_FOLDER, Config.DATA_FOLDER]
        for folder in folders:
            os.makedirs(folder, exist_ok=True)

    @staticmethod
    def load_json_config():
        """加载JSON配置文件"""
        import json
        config_file = os.path.join(Config.BASE_DIR, "config.json")
        try:
            if os.path.exists(config_file):
                with open(config_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            return Config.DEFAULT_CONFIG
        except:
            return Config.DEFAULT_CONFIG