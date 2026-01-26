import os
import json
from datetime import datetime, timedelta
from config import Config


class ScheduleService:
    """排班管理服务"""

    def __init__(self):
        self.filepath = os.path.join(Config.DATA_FOLDER, 'schedule_data.json')
        self.data = self._load()

    def _load(self):
        """加载排班数据"""
        if os.path.exists(self.filepath):
            try:
                with open(self.filepath, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                pass
        return {}

    def _save(self):
        """保存排班数据"""
        with open(self.filepath, 'w', encoding='utf-8') as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)

    def get_all(self):
        """获取所有排班数据"""
        return self.data

    def set_schedule(self, date, day_shift, night_shift):
        """设置某天的排班"""
        if day_shift or night_shift:
            self.data[date] = {'白班': day_shift, '晚班': night_shift}
        elif date in self.data:
            del self.data[date]

        self._save()
        return {'success': True}

    def quick_fill(self, start_date, days, order):
        """快速填充排班"""
        teams = [char for char in order if char in ['甲', '乙', '丙']]
        if len(teams) < 2:
            return {'success': False, 'error': '循环顺序至少需要2个队伍'}

        start = datetime.strptime(start_date, '%Y-%m-%d')

        for i in range(days):
            current_date = start + timedelta(days=i)
            date_str = current_date.strftime('%Y-%m-%d')
            shift_index = i * 2
            day_team = teams[shift_index % len(teams)]
            night_team = teams[(shift_index + 1) % len(teams)]
            self.data[date_str] = {'白班': day_team, '晚班': night_team}

        self._save()
        return {'success': True, 'filled': days}

    def clear(self):
        """清空所有排班"""
        self.data = {}
        if os.path.exists(self.filepath):
            os.remove(self.filepath)
        return {'success': True}

    def export_data(self):
        """导出排班数据"""
        return json.dumps(self.data, ensure_ascii=False, indent=2)

    def import_data(self, content):
        """导入排班数据"""
        try:
            imported = json.loads(content)
            self.data.update(imported)
            self._save()
            return {'success': True, 'count': len(imported)}
        except Exception as e:
            return {'success': False, 'error': str(e)}


# 创建全局服务实例
schedule_service = ScheduleService()