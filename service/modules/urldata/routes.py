from flask import Blueprint, request, jsonify, render_template
from .services import urldata_service

urldata_bp = Blueprint('urldata', __name__)


@urldata_bp.route('/urldata')
def urldata_page():
    return render_template('urldata.html')


@urldata_bp.route('/api/urldata/files', methods=['GET'])
def get_data_files():
    """获取数据文件日期列表"""
    files = urldata_service.get_file_list()
    return jsonify(files)


@urldata_bp.route('/api/urldata/query', methods=['POST'])
def query_urldata():
    """查询URL数据"""
    data = request.json
    query_type = data.get('type', 'date')

    result = urldata_service.query(
        query_type,
        date=data.get('date', ''),
        number=data.get('number', ''),
        content=data.get('content', '')
    )

    return jsonify(result)