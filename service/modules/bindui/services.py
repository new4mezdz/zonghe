import os
import re
from config import Config


class BinduiService:
    """机台离岗统计服务"""

    def __init__(self):
        self.current_file = None
        self.df = None

    def upload_file(self, file):
        """上传CSV文件"""
        import pandas as pd

        filepath = os.path.join(Config.UPLOAD_FOLDER, 'bindui_' + file.filename)
        file.save(filepath)
        self.current_file = filepath

        # 尝试读取CSV
        try:
            self.df = pd.read_csv(filepath, encoding='utf-8')
        except:
            self.df = pd.read_csv(filepath, encoding='gbk')

        return {
            'success': True,
            'filename': file.filename,
            'rows': len(self.df),
            'columns': self.df.columns.tolist()
        }

    def _find_latest_file(self):
        """查找最新的上传文件"""
        import pandas as pd

        for f in os.listdir(Config.UPLOAD_FOLDER):
            if f.startswith('bindui_'):
                filepath = os.path.join(Config.UPLOAD_FOLDER, f)
                try:
                    self.df = pd.read_csv(filepath, encoding='utf-8')
                except:
                    self.df = pd.read_csv(filepath, encoding='gbk')
                self.current_file = filepath
                return True
        return False

    def _extract_machine(self, text):
        """提取机器编号"""
        import pandas as pd

        if pd.isna(text):
            return '未知'
        match = re.search(r'(\d+)号包装机', str(text))
        return f'{match.group(1)}号包装机' if match else '其他'

    def get_bindui(self, start_date=None, end_date=None, shift='全天'):
        """获取统计数据"""
        import pandas as pd

        # 如果没有数据，尝试加载
        if self.df is None:
            if not self._find_latest_file():
                return {'success': False, 'error': '请先上传文件'}

        df = self.df.copy()

        # 提取机器编号
        if '事件源' in df.columns:
            df['机器'] = df['事件源'].apply(self._extract_machine)
        else:
            df['机器'] = '未知'

        # 日期筛选（如果有日期列）
        if start_date and end_date and '日期' in df.columns:
            try:
                df['日期'] = pd.to_datetime(df['日期'])
                start = pd.to_datetime(start_date)
                end = pd.to_datetime(end_date)
                df = df[(df['日期'] >= start) & (df['日期'] <= end)]
            except:
                pass

        # 班次筛选（如果有班次列）
        if shift != '全天' and '班次' in df.columns:
            df = df[df['班次'] == shift]

        # 按机器统计
        stats = df['机器'].value_counts().to_dict()

        # 排序输出（1-12号包装机）
        all_machines = [f'{i}号包装机' for i in range(1, 13)]
        result = []
        for m in all_machines:
            result.append({'machine': m, 'count': stats.get(m, 0)})

        # 添加其他和未知
        if stats.get('其他', 0) > 0:
            result.append({'machine': '其他', 'count': stats.get('其他', 0)})
        if stats.get('未知', 0) > 0:
            result.append({'machine': '未知', 'count': stats.get('未知', 0)})

        return {'success': True, 'data': result}


# 创建全局服务实例
bindui_service = BinduiService()