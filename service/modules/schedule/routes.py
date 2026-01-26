from flask import Blueprint, request, jsonify, render_template, Response
from .services import schedule_service

schedule_bp = Blueprint('schedule', __name__)


@schedule_bp.route('/schedule')
def schedule_page():
    return render_template('schedule.html')


@schedule_bp.route('/api/schedule/get', methods=['GET'])
def get_schedule():
    """获取所有排班数据"""
    return jsonify(schedule_service.get_all())


@schedule_bp.route('/api/schedule/set', methods=['POST'])
def set_schedule():
    """设置排班"""
    data = request.json
    date = data.get('date')
    day_shift = data.get('day_shift', '')
    night_shift = data.get('night_shift', '')

    result = schedule_service.set_schedule(date, day_shift, night_shift)
    return jsonify(result)


@schedule_bp.route('/api/schedule/quick_fill', methods=['POST'])
def quick_fill_schedule():
    """快速填充排班"""
    data = request.json
    start_date = data.get('start_date')
    days = int(data.get('days', 30))
    order = data.get('order', '甲乙丙')

    result = schedule_service.quick_fill(start_date, days, order)
    if not result['success']:
        return jsonify(result), 400
    return jsonify(result)


@schedule_bp.route('/api/schedule/clear', methods=['POST'])
def clear_schedule():
    """清空排班"""
    result = schedule_service.clear()
    return jsonify(result)


@schedule_bp.route('/api/schedule/export', methods=['GET'])
def export_schedule():
    """导出排班数据"""
    content = schedule_service.export_data()
    return Response(
        content,
        mimetype='application/json',
        headers={'Content-Disposition': 'attachment; filename=schedule_export.json'}
    )


@schedule_bp.route('/api/schedule/import', methods=['POST'])
def import_schedule():
    """导入排班数据"""
    if 'file' not in request.files:
        return jsonify({'error': '没有文件'}), 400

    file = request.files['file']
    try:
        content = file.read().decode('utf-8')
        result = schedule_service.import_data(content)
        if not result['success']:
            return jsonify(result), 400
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500