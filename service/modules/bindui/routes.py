from flask import Blueprint, request, jsonify, render_template
from .services import bindui_service

bindui_bp = Blueprint('bindui', __name__)


@bindui_bp.route('/bindui')
def bindui_page():
    return render_template('bindui.html')


@bindui_bp.route('/api/bindui/upload', methods=['POST'])
def upload_bindui_file():
    """上传CSV文件"""
    if 'file' not in request.files:
        return jsonify({'error': '没有文件'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': '没有选择文件'}), 400

    result = bindui_service.upload_file(file)
    return jsonify(result)


@bindui_bp.route('/api/bindui/bindui', methods=['POST'])
def get_bindui():
    """获取统计数据"""
    data = request.json
    start_date = data.get('start_date', '')
    end_date = data.get('end_date', '')
    shift = data.get('shift', '全天')

    result = bindui_service.get_bindui(start_date, end_date, shift)

    if not result['success']:
        return jsonify(result), 400

    return jsonify(result)