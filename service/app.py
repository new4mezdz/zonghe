#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from flask import Flask, render_template, request, jsonify, send_file
import os
import json
import glob
from datetime import datetime, timedelta
from collections import Counter

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-here'
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['OUTPUT_FOLDER'] = '输出文件'

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
os.makedirs(app.config['OUTPUT_FOLDER'], exist_ok=True)

# 全局状态
monitor_state = {
    'file_path': '',
    'blacklist': set(),
    'monitoring': False,
    'last_content': '',
    'alerted_items': set(),
    'alerts': []
}

schedule_data = {}
url_data_cache = {}


def load_config():
    config_file = "config.json"
    default_config = {
        "输入文件": "数据文件.txt",
        "校验文件": "校验文件.txt",
        "输出目录": "输出文件",
        "文件编码": "utf-8",
        "输出文件前缀": "排序数据_",
        "编号下限列表": [1, 1, 1, 1, 1, 1, 1],
        "编号上限列表": [1000, 1000, 1000, 1000, 1000, 1000, 1000],
    }
    try:
        if os.path.exists(config_file):
            with open(config_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        return default_config
    except:
        return default_config


@app.route('/')
def index():
    return render_template('index.html')


# ========== 文本监控 ==========
@app.route('/monitor')
def monitor_page():
    return render_template('monitor.html')


@app.route('/api/monitor/upload', methods=['POST'])
def upload_monitor_file():
    if 'file' not in request.files:
        return jsonify({'error': '没有文件'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': '没有选择文件'}), 400

    filepath = os.path.join(app.config['UPLOAD_FOLDER'], 'monitor_' + file.filename)
    file.save(filepath)
    monitor_state['file_path'] = filepath
    monitor_state['alerted_items'].clear()

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    lines = [l for l in content.split('\n') if l.strip()]

    return jsonify({'success': True, 'filename': file.filename, 'line_count': len(lines), 'content': content})


@app.route('/api/monitor/blacklist', methods=['POST'])
def upload_blacklist():
    if 'file' not in request.files:
        return jsonify({'error': '没有文件'}), 400
    file = request.files['file']

    filepath = os.path.join(app.config['UPLOAD_FOLDER'], 'blacklist_' + file.filename)
    file.save(filepath)

    with open(filepath, 'r', encoding='utf-8') as f:
        monitor_state['blacklist'] = set(line.strip() for line in f if line.strip())

    return jsonify({'success': True, 'count': len(monitor_state['blacklist'])})


@app.route('/api/monitor/check', methods=['POST'])
def check_content():
    if not monitor_state['file_path']:
        return jsonify({'error': '未选择监控文件'}), 400

    try:
        with open(monitor_state['file_path'], 'r', encoding='utf-8') as f:
            content = f.read()

        lines = [l.strip() for l in content.split('\n') if l.strip()]
        found = []

        if monitor_state['blacklist']:
            for line in lines:
                if line in monitor_state['blacklist'] and line not in monitor_state['alerted_items']:
                    found.append(line)
                    monitor_state['alerted_items'].add(line)

        if found:
            monitor_state['alerts'].extend(found)

        return jsonify({'content': content, 'line_count': len(lines), 'alerts': found,
                        'total_alerts': len(monitor_state['alerts'])})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ========== 排班管理 ==========
@app.route('/schedule')
def schedule_page():
    return render_template('schedule.html')


@app.route('/api/schedule/get', methods=['GET'])
def get_schedule():
    return jsonify(schedule_data)


@app.route('/api/schedule/set', methods=['POST'])
def set_schedule():
    data = request.json
    date = data.get('date')
    day_shift = data.get('day_shift', '')
    night_shift = data.get('night_shift', '')

    if day_shift or night_shift:
        schedule_data[date] = {'白班': day_shift, '晚班': night_shift}
    elif date in schedule_data:
        del schedule_data[date]

    with open('schedule_data.json', 'w', encoding='utf-8') as f:
        json.dump(schedule_data, f, ensure_ascii=False, indent=2)

    return jsonify({'success': True})


@app.route('/api/schedule/quick_fill', methods=['POST'])
def quick_fill_schedule():
    data = request.json
    start_date = data.get('start_date')
    days = int(data.get('days', 30))
    order = data.get('order', '甲乙丙')

    teams = [char for char in order if char in ['甲', '乙', '丙']]
    if len(teams) < 2:
        return jsonify({'error': '循环顺序至少需要2个队伍'}), 400

    start = datetime.strptime(start_date, '%Y-%m-%d')

    for i in range(days):
        current_date = start + timedelta(days=i)
        date_str = current_date.strftime('%Y-%m-%d')
        shift_index = i * 2
        day_team = teams[shift_index % len(teams)]
        night_team = teams[(shift_index + 1) % len(teams)]
        schedule_data[date_str] = {'白班': day_team, '晚班': night_team}

    with open('schedule_data.json', 'w', encoding='utf-8') as f:
        json.dump(schedule_data, f, ensure_ascii=False, indent=2)

    return jsonify({'success': True, 'filled': days})


@app.route('/api/schedule/clear', methods=['POST'])
def clear_schedule():
    global schedule_data
    schedule_data = {}
    if os.path.exists('schedule_data.json'):
        os.remove('schedule_data.json')
    return jsonify({'success': True})


@app.route('/api/schedule/export', methods=['GET'])
def export_schedule():
    filepath = 'schedule_export.json'
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(schedule_data, f, ensure_ascii=False, indent=2)
    return send_file(filepath, as_attachment=True)


@app.route('/api/schedule/import', methods=['POST'])
def import_schedule():
    if 'file' not in request.files:
        return jsonify({'error': '没有文件'}), 400
    file = request.files['file']

    try:
        content = file.read().decode('utf-8')
        imported = json.loads(content)
        schedule_data.update(imported)

        with open('schedule_data.json', 'w', encoding='utf-8') as f:
            json.dump(schedule_data, f, ensure_ascii=False, indent=2)

        return jsonify({'success': True, 'count': len(imported)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ========== URL数据管理 ==========
@app.route('/urldata')
def urldata_page():
    return render_template('urldata.html')


def parse_data_line(line):
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
            return None, None, f"编号数量错误"
        return [int(num_str.strip()) for num_str in number_strings], content_part, "成功"
    except ValueError as e:
        return None, None, f"编号解析失败"


@app.route('/api/urldata/files', methods=['GET'])
def get_data_files():
    config = load_config()
    output_dir = config.get('输出目录', '输出文件')
    prefix = config.get('输出文件前缀', '排序数据_')

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
    return jsonify(files)


@app.route('/api/urldata/query', methods=['POST'])
def query_urldata():
    data = request.json
    query_type = data.get('type', 'date')

    config = load_config()
    output_dir = config.get('输出目录', '输出文件')
    prefix = config.get('输出文件前缀', '排序数据_')

    results = []

    if query_type == 'date':
        date_str = data.get('date', '').replace('-', '')
        filepath = os.path.join(output_dir, f"{prefix}{date_str}.txt")
        if os.path.exists(filepath):
            results = load_data_file(filepath, date_str, config)

    elif query_type == 'number':
        target_nums = set()
        num_input = data.get('number', '')
        for part in num_input.split(','):
            part = part.strip()
            if '-' in part:
                s, e = map(int, part.split('-'))
                target_nums.update(range(min(s, e), max(s, e) + 1))
            else:
                target_nums.add(int(part))

        for filepath in glob.glob(os.path.join(output_dir, f"{prefix}*.txt")):
            filename = os.path.basename(filepath)
            date_str = filename.replace(prefix, '').replace('.txt', '')
            file_data = load_data_file(filepath, date_str, config)
            for item in file_data:
                if any(n in target_nums for n in item['numbers']):
                    results.append(item)

    elif query_type == 'content':
        content_search = data.get('content', '')
        for filepath in glob.glob(os.path.join(output_dir, f"{prefix}*.txt")):
            filename = os.path.basename(filepath)
            date_str = filename.replace(prefix, '').replace('.txt', '')
            file_data = load_data_file(filepath, date_str, config)
            for item in file_data:
                if content_search in item['content']:
                    results.append(item)

    elif query_type == 'duplicates':
        date_str = data.get('date', '').replace('-', '')
        filepath = os.path.join(output_dir, f"{prefix}{date_str}.txt")
        if os.path.exists(filepath):
            file_data = load_data_file(filepath, date_str, config)
            contents = [item['content'] for item in file_data]
            cnt = Counter(contents)
            dup_keys = {c for c, n in cnt.items() if n > 1}
            results = [item for item in file_data if item['content'] in dup_keys]

    total = len(results)
    url_count = sum(1 for r in results if r['type'] == 'URL')
    fail_count = sum(1 for r in results if r['type'] == '失败')

    return jsonify({
        'results': results,
        'stats': {'total': total, 'url': url_count, 'fail': fail_count, 'other': total - url_count - fail_count}
    })


def load_data_file(filepath, date_str, config):
    data = []
    try:
        with open(filepath, 'r', encoding=config.get('文件编码', 'utf-8')) as f:
            lines = f.readlines()

        for i, line in enumerate(lines, 1):
            line = line.strip()
            if not line:
                continue

            verification_value = 'N/A'
            if '| 校验位:' in line:
                main_part, verification_part = line.split('| 校验位:', 1)
                verification_value = verification_part.strip()
            else:
                main_part = line

            nums, content, res = parse_data_line(main_part)
            if nums and content:
                dtype = "失败" if content.upper() == "FAIL" else \
                    "URL" if content.upper().startswith(("HTTP:", "HTTPS:")) else "其他"
                data.append({
                    'numbers': nums, 'content': content, 'verification': verification_value,
                    'type': dtype, 'date': date_str
                })
    except Exception as e:
        print(f"读取文件失败: {e}")
    return data


# ========== 图表统计模块 ==========
@app.route('/bindui')
def bindui_page():
    return render_template('bindui.html')


@app.route('/api/bindui/upload', methods=['POST'])
def upload_bindui_file():
    if 'file' not in request.files:
        return jsonify({'error': '没有文件'}), 400
    file = request.files['file']

    filepath = os.path.join(app.config['UPLOAD_FOLDER'], 'bindui_' + file.filename)
    file.save(filepath)

    import pandas as pd
    try:
        df = pd.read_csv(filepath, encoding='utf-8')
    except:
        df = pd.read_csv(filepath, encoding='gbk')

    return jsonify({
        'success': True,
        'filename': file.filename,
        'rows': len(df),
        'columns': df.columns.tolist()
    })


@app.route('/api/bindui/bindui', methods=['POST'])
def bindui_bindui():
    data = request.json
    filename = data.get('filename', '')
    start_date = data.get('start_date', '')
    end_date = data.get('end_date', '')
    shift = data.get('shift', '全天')

    import pandas as pd
    import re

    filepath = None
    for f in os.listdir(app.config['UPLOAD_FOLDER']):
        if f.startswith('bindui_'):
            filepath = os.path.join(app.config['UPLOAD_FOLDER'], f)
            break

    if not filepath:
        return jsonify({'error': '请先上传文件'}), 400

    try:
        df = pd.read_csv(filepath, encoding='utf-8')
    except:
        df = pd.read_csv(filepath, encoding='gbk')

    # 提取机器编号
    def extract_machine(text):
        if pd.isna(text):
            return '未知'
        match = re.search(r'(\d+)号包装机', str(text))
        return f'{match.group(1)}号包装机' if match else '其他'

    if '事件源' in df.columns:
        df['机器'] = df['事件源'].apply(extract_machine)
    else:
        df['机器'] = '未知'

    # 按机器统计
    stats = df['机器'].value_counts().to_dict()

    # 排序
    all_machines = [f'{i}号包装机' for i in range(1, 13)]
    result = []
    for m in all_machines:
        result.append({'machine': m, 'count': stats.get(m, 0)})

    return jsonify({'success': True, 'data': result})
def init_data():
    global schedule_data
    if os.path.exists('schedule_data.json'):
        try:
            with open('schedule_data.json', 'r', encoding='utf-8') as f:
                schedule_data = json.load(f)
        except:
            pass


init_data()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)