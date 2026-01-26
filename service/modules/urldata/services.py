import os
import glob
from collections import Counter
from config import Config


class UrlDataService:
    """URL数据管理服务"""

    def __init__(self):
        self.config = Config.load_json_config()

    def _reload_config(self):
        """重新加载配置"""
        self.config = Config.load_json_config()

    def _parse_data_line(self, line):
        """解析数据行"""
        line = line.strip()
        if not line:
            return None, None, "空行"

        dot_pos = line.find('. ')
        if dot_pos == -1:
            return None, None, "格式错误"

        numbers_part, content_part = line[:dot_pos], line[dot_pos + 2:]

        try:
            number_strings = numbers_part.split(',')
            if len(number_strings) != 7:
                return None, None, "编号数量错误"
            return [int(num_str.strip()) for num_str in number_strings], content_part, "成功"
        except ValueError:
            return None, None, "编号解析失败"

    def _load_data_file(self, filepath, date_str):
        """加载数据文件"""
        data = []
        try:
            encoding = self.config.get('文件编码', 'utf-8')
            with open(filepath, 'r', encoding=encoding) as f:
                lines = f.readlines()

            for line in lines:
                line = line.strip()
                if not line:
                    continue

                verification_value = 'N/A'
                if '| 校验位:' in line:
                    main_part, verification_part = line.split('| 校验位:', 1)
                    verification_value = verification_part.strip()
                else:
                    main_part = line

                nums, content, res = self._parse_data_line(main_part)
                if nums and content:
                    dtype = "失败" if content.upper() == "FAIL" else \
                        "URL" if content.upper().startswith(("HTTP:", "HTTPS:")) else "其他"
                    data.append({
                        'numbers': nums,
                        'content': content,
                        'verification': verification_value,
                        'type': dtype,
                        'date': date_str
                    })
        except Exception as e:
            print(f"读取文件失败: {e}")

        return data

    def get_file_list(self):
        """获取所有数据文件日期列表"""
        self._reload_config()
        output_dir = self.config.get('输出目录', '输出文件')
        prefix = self.config.get('输出文件前缀', '排序数据_')

        files = []
        if os.path.exists(output_dir):
            pattern = os.path.join(output_dir, f"{prefix}*.txt")
            for filepath in glob.glob(pattern):
                filename = os.path.basename(filepath)
                date_str = filename.replace(prefix, '').replace('.txt', '')
                if len(date_str) == 8:
                    formatted_date = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:]}"
                    files.append(formatted_date)

        files.sort(reverse=True)
        return files

    def query_by_date(self, date):
        """按日期查询"""
        self._reload_config()
        output_dir = self.config.get('输出目录', '输出文件')
        prefix = self.config.get('输出文件前缀', '排序数据_')

        date_str = date.replace('-', '')
        filepath = os.path.join(output_dir, f"{prefix}{date_str}.txt")

        if os.path.exists(filepath):
            return self._load_data_file(filepath, date_str)
        return []

    def query_by_number(self, num_input):
        """按编号查询"""
        self._reload_config()
        output_dir = self.config.get('输出目录', '输出文件')
        prefix = self.config.get('输出文件前缀', '排序数据_')

        # 解析编号输入
        target_nums = set()
        for part in num_input.split(','):
            part = part.strip()
            if '-' in part:
                s, e = map(int, part.split('-'))
                target_nums.update(range(min(s, e), max(s, e) + 1))
            else:
                target_nums.add(int(part))

        results = []
        for filepath in glob.glob(os.path.join(output_dir, f"{prefix}*.txt")):
            filename = os.path.basename(filepath)
            date_str = filename.replace(prefix, '').replace('.txt', '')
            file_data = self._load_data_file(filepath, date_str)
            for item in file_data:
                if any(n in target_nums for n in item['numbers']):
                    results.append(item)

        return results

    def query_by_content(self, content_search):
        """按内容查询"""
        self._reload_config()
        output_dir = self.config.get('输出目录', '输出文件')
        prefix = self.config.get('输出文件前缀', '排序数据_')

        results = []
        for filepath in glob.glob(os.path.join(output_dir, f"{prefix}*.txt")):
            filename = os.path.basename(filepath)
            date_str = filename.replace(prefix, '').replace('.txt', '')
            file_data = self._load_data_file(filepath, date_str)
            for item in file_data:
                if content_search in item['content']:
                    results.append(item)

        return results

    def query_duplicates(self, date):
        """查询重复内容"""
        self._reload_config()
        output_dir = self.config.get('输出目录', '输出文件')
        prefix = self.config.get('输出文件前缀', '排序数据_')

        date_str = date.replace('-', '')
        filepath = os.path.join(output_dir, f"{prefix}{date_str}.txt")

        if not os.path.exists(filepath):
            return []

        file_data = self._load_data_file(filepath, date_str)
        contents = [item['content'] for item in file_data]
        cnt = Counter(contents)
        dup_keys = {c for c, n in cnt.items() if n > 1}

        return [item for item in file_data if item['content'] in dup_keys]

    def query(self, query_type, **kwargs):
        """统一查询接口"""
        if query_type == 'date':
            results = self.query_by_date(kwargs.get('date', ''))
        elif query_type == 'number':
            results = self.query_by_number(kwargs.get('number', ''))
        elif query_type == 'content':
            results = self.query_by_content(kwargs.get('content', ''))
        elif query_type == 'duplicates':
            results = self.query_duplicates(kwargs.get('date', ''))
        else:
            results = []

        # 统计
        total = len(results)
        url_count = sum(1 for r in results if r['type'] == 'URL')
        fail_count = sum(1 for r in results if r['type'] == '失败')

        return {
            'results': results,
            'stats': {
                'total': total,
                'url': url_count,
                'fail': fail_count,
                'other': total - url_count - fail_count
            }
        }


# 创建全局服务实例
urldata_service = UrlDataService()