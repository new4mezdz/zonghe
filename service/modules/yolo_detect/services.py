import os
import json
import uuid
from datetime import datetime
from threading import Lock
import logging

logger = logging.getLogger(__name__)

DATA_DIR = r'E:\9#\zonghe\service'
lock = Lock()


def _ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)


def _brand_dir(date_str, machine, brand):
    path = os.path.join(DATA_DIR, date_str, machine, brand)
    os.makedirs(path, exist_ok=True)
    return path


def _records_file(date_str, machine, brand):
    return os.path.join(_brand_dir(date_str, machine, brand), 'records.json')


def _load_records(date_str, machine, brand):
    path = _records_file(date_str, machine, brand)
    if not os.path.exists(path):
        return []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except:
        return []


def _save_records(date_str, machine, brand, records):
    path = _records_file(date_str, machine, brand)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False, indent=2)


def save_detection(image_file, metadata):
    try:
        detect_time = metadata.get('detect_time', datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
        date_str = detect_time[:10]
        machine = metadata.get('machine', '未知')
        brand = metadata.get('brand', '未知')
        filename = metadata.get('filename', image_file.filename or 'unknown.jpg')

        brand_path = _brand_dir(date_str, machine, brand)
        img_path = os.path.join(brand_path, filename)

        if os.path.exists(img_path):
            name, ext = os.path.splitext(filename)
            img_path = os.path.join(brand_path, f"{name}_{uuid.uuid4().hex[:4]}{ext}")
            filename = os.path.basename(img_path)

        image_file.save(img_path)

        # 保存原图（如果有）
        from flask import request as flask_request
        original_file = flask_request.files.get('original')
        if original_file:
            orig_dir = os.path.join(brand_path, 'originals')
            os.makedirs(orig_dir, exist_ok=True)
            original_file.save(os.path.join(orig_dir, filename))

        record = {
            'filename': filename,
            'fbox_positions': metadata.get('fbox_positions', []),
            'detect_time': detect_time,
            'is_alert': metadata.get('is_alert', False),
            'mode': metadata.get('mode', 'manual'),
        }

        with lock:
            records = _load_records(date_str, machine, brand)
            records.append(record)
            _save_records(date_str, machine, brand, records)

        logger.info(f"保存检测记录: {machine}/{brand}/{filename}")
        return {'success': True, 'filename': filename}

    except Exception as e:
        logger.error(f"保存检测记录失败: {e}")
        return {'success': False, 'error': str(e)}

def save_summary(data):
    try:
        detect_time = data.get('detect_time', datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
        date_str = detect_time[:10]
        machine = data.get('machine', '未知')
        brand = data.get('brand', '未知')

        summary = {
            'type': 'summary',
            'total_images': data.get('total_images', 0),
            'fbox_count': data.get('fbox_count', 0),
            'detect_time': detect_time,
        }

        with lock:
            records = _load_records(date_str, machine, brand)
            records.append(summary)
            _save_records(date_str, machine, brand, records)

        logger.info(f"保存汇总: {machine}/{brand} 总计{summary['total_images']}张, 异常{summary['fbox_count']}张")
        return {'success': True}

    except Exception as e:
        logger.error(f"保存汇总失败: {e}")
        return {'success': False, 'error': str(e)}


def query_records(date_str, machine=None, brand=None):
    _ensure_dirs()
    date_path = os.path.join(DATA_DIR, date_str)
    if not os.path.exists(date_path):
        return {'success': True, 'date': date_str, 'detections': [], 'summaries': [],
                'total_detections': 0, 'total_summaries': 0}

    detections = []
    summaries = []

    for m_name in os.listdir(date_path):
        m_path = os.path.join(date_path, m_name)
        if not os.path.isdir(m_path):
            continue
        if machine and m_name != machine:
            continue

        for b_name in os.listdir(m_path):
            b_path = os.path.join(m_path, b_name)
            if not os.path.isdir(b_path):
                continue
            if brand and b_name != brand:
                continue

            records = _load_records(date_str, m_name, b_name)
            for r in records:
                r['machine'] = m_name
                r['brand'] = b_name
                if r.get('type') != 'summary':
                    r['image'] = f"{date_str}/{m_name}/{b_name}/{r['filename']}"
                    if 'mode' not in r:
                        r['mode'] = 'manual'
                    detections.append(r)
                else:
                    summaries.append(r)

    return {
        'success': True,
        'date': date_str,
        'detections': detections,
        'summaries': summaries,
        'total_detections': len(detections),
        'total_summaries': len(summaries),
    }


def get_available_dates():
    _ensure_dirs()
    dates = []
    for fn in os.listdir(DATA_DIR):
        full = os.path.join(DATA_DIR, fn)
        if os.path.isdir(full) and len(fn) == 10 and fn[4] == '-':
            dates.append(fn)
    return sorted(dates, reverse=True)


def get_filters(date_str):
    _ensure_dirs()
    machines = []
    brands = []
    date_path = os.path.join(DATA_DIR, date_str)
    if not os.path.exists(date_path):
        return {'machines': [], 'brands': []}

    for m_name in os.listdir(date_path):
        m_path = os.path.join(date_path, m_name)
        if not os.path.isdir(m_path):
            continue
        machines.append(m_name)
        for b_name in os.listdir(m_path):
            if os.path.isdir(os.path.join(m_path, b_name)):
                brands.append(b_name)

    return {'machines': sorted(set(machines)), 'brands': sorted(set(brands))}

def export_alert_images(date_str, machine=None, brand=None):
    """导出缺陷原图"""
    _ensure_dirs()
    date_path = os.path.join(DATA_DIR, date_str)
    if not os.path.exists(date_path):
        return []

    alert_files = []
    for m_name in os.listdir(date_path):
        m_path = os.path.join(date_path, m_name)
        if not os.path.isdir(m_path):
            continue
        if machine and m_name != machine:
            continue

        for b_name in os.listdir(m_path):
            b_path = os.path.join(m_path, b_name)
            if not os.path.isdir(b_path):
                continue
            if brand and b_name != brand:
                continue

            records = _load_records(date_str, m_name, b_name)
            for r in records:
                if r.get('type') == 'summary':
                    continue
                if r.get('is_alert', False):
                    orig_path = os.path.join(b_path, 'originals', r['filename'])
                    if os.path.exists(orig_path):
                        alert_files.append({
                            'path': orig_path,
                            'arcname': f"{m_name}/{b_name}/{r['filename']}"
                        })
                    else:
                        img_path = os.path.join(b_path, r['filename'])
                        if os.path.exists(img_path):
                            alert_files.append({
                                'path': img_path,
                                'arcname': f"{m_name}/{b_name}/{r['filename']}"
                            })
    return alert_files