from flask import Blueprint, request, jsonify, render_template, send_from_directory
from . import services
import requests
import os

yolo_bp = Blueprint('yolo_detect', __name__)

# 检测机器地址
DETECT_SERVER = "http://10.164.61.100:5001"


@yolo_bp.route('/yolo_detect')
def yolo_page():
    return render_template('yolo_detect.html')


# === 转发给检测机器的 API ===

@yolo_bp.route('/api/yolo/browse', methods=['GET'])
def browse_remote():
    path = request.args.get('path', '')
    try:
        resp = requests.get(f"{DETECT_SERVER}/api/browse", params={'path': path}, timeout=10)
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({'success': False, 'error': f'无法连接检测机器: {e}'})


@yolo_bp.route('/api/yolo/brands', methods=['GET'])
def get_brands():
    try:
        resp = requests.get(f"{DETECT_SERVER}/api/brands", timeout=5)
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({'brands': [], 'error': str(e)})


@yolo_bp.route('/api/yolo/start_detect', methods=['POST'])
def start_detect():
    data = request.json or {}
    try:
        resp = requests.post(f"{DETECT_SERVER}/api/detect", json=data, timeout=10)
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({'success': False, 'error': f'无法连接检测机器: {e}'})


@yolo_bp.route('/api/yolo/detect_status', methods=['GET'])
def detect_status():
    try:
        resp = requests.get(f"{DETECT_SERVER}/api/status", timeout=5)
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({'running': False, 'progress': f'无法连接: {e}'})


@yolo_bp.route('/api/yolo/ping_detect', methods=['GET'])
def ping_detect():
    try:
        resp = requests.get(f"{DETECT_SERVER}/api/ping", timeout=5)
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@yolo_bp.route('/api/yolo/preview')
def preview_remote():
    path = request.args.get('path', '')
    try:
        resp = requests.get(f"{DETECT_SERVER}/api/preview", params={'path': path}, timeout=10, stream=True)
        if resp.status_code == 200:
            from flask import Response
            return Response(resp.content, mimetype='image/jpeg')
        return jsonify({'success': False, 'error': '获取预览失败'}), resp.status_code
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# === 接收检测结果的 API ===

@yolo_bp.route('/api/yolo/upload', methods=['POST'])
def upload_detection():
    image = request.files.get('image')
    if not image:
        return jsonify({'success': False, 'error': '缺少图片'}), 400

    import json as _json
    metadata = {
        'machine': request.form.get('machine', '未知'),
        'brand': request.form.get('brand', '未知'),
        'filename': request.form.get('filename', ''),
        'fbox_positions': request.form.get('fbox_positions', '[]'),
        'detect_time': request.form.get('detect_time', ''),
        'is_alert': request.form.get('is_alert', '0') == '1',
        'mode': request.form.get('mode', 'manual'),
    }
    try:
        metadata['fbox_positions'] = _json.loads(metadata['fbox_positions'])
    except:
        metadata['fbox_positions'] = []

    result = services.save_detection(image, metadata)

    try:
        from flask import current_app
        socketio = current_app.extensions.get('socketio')
        if socketio:
            socketio.emit('yolo_new_detection', {
                'machine': metadata['machine'],
                'brand': metadata['brand'],
                'filename': metadata['filename'],
                'fbox_positions': metadata['fbox_positions'],
                'detect_time': metadata['detect_time'],
                'is_alert': metadata['is_alert'],
            })
    except:
        pass

    return jsonify(result)


@yolo_bp.route('/api/yolo/summary', methods=['POST'])
def upload_summary():
    data = request.json or {}
    result = services.save_summary(data)

    try:
        from flask import current_app
        socketio = current_app.extensions.get('socketio')
        if socketio:
            socketio.emit('yolo_summary', data)
    except:
        pass

    return jsonify(result)


# === 查询端 API ===

@yolo_bp.route('/api/yolo/query', methods=['GET'])
def query_detections():
    date_str = request.args.get('date', '')
    machine = request.args.get('machine', '')
    brand = request.args.get('brand', '')
    if not date_str:
        return jsonify({'success': False, 'error': '请选择日期'})
    return jsonify(services.query_records(date_str, machine or None, brand or None))


@yolo_bp.route('/api/yolo/dates', methods=['GET'])
def get_dates():
    return jsonify({'dates': services.get_available_dates()})


@yolo_bp.route('/api/yolo/filters', methods=['GET'])
def get_filters():
    date_str = request.args.get('date', '')
    if not date_str:
        return jsonify({'machines': [], 'brands': []})
    return jsonify(services.get_filters(date_str))


@yolo_bp.route('/api/yolo/image/<path:img_path>')
def get_image(img_path):
    return send_from_directory(services.DATA_DIR, img_path)


# === 自动模式 API ===

@yolo_bp.route('/api/yolo/auto/start', methods=['POST'])
def auto_start():
    data = request.json or {}
    try:
        resp = requests.post(f"{DETECT_SERVER}/api/auto/start", json=data, timeout=10)
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({'success': False, 'error': f'无法连接检测机器: {e}'})


@yolo_bp.route('/api/yolo/auto/stop', methods=['POST'])
def auto_stop():
    try:
        resp = requests.post(f"{DETECT_SERVER}/api/auto/stop", timeout=10)
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({'success': False, 'error': f'无法连接检测机器: {e}'})


@yolo_bp.route('/api/yolo/auto/status', methods=['GET'])
def auto_status():
    try:
        resp = requests.get(f"{DETECT_SERVER}/api/auto/status", timeout=5)
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({'running': False, 'error': str(e)})




@yolo_bp.route('/api/yolo/export', methods=['GET'])
def export_alerts():
    import zipfile
    import io
    from flask import Response

    date_str = request.args.get('date', '')
    machine = request.args.get('machine', '') or None
    brand = request.args.get('brand', '') or None

    if not date_str:
        return jsonify({'success': False, 'error': '请选择日期'}), 400

    alert_files = services.export_alert_images(date_str, machine, brand)
    if not alert_files:
        return jsonify({'success': False, 'error': '没有缺陷图片'}), 404

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for f in alert_files:
            zf.write(f['path'], f['arcname'])
    buf.seek(0)

    filename = f"defects_{date_str}.zip"
    return Response(
        buf.getvalue(),
        mimetype='application/zip',
        headers={'Content-Disposition': f'attachment; filename={filename}'}
    )