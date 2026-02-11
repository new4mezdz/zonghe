from flask import Blueprint, request, jsonify, render_template
from .services import urldata_service

urldata_bp = Blueprint('urldata', __name__)


@urldata_bp.route('/urldata')
def urldata_page():
    return render_template('urldata.html')


@urldata_bp.route('/api/urldata/files', methods=['GET'])
def get_data_files():
    return jsonify(urldata_service.get_file_list())


@urldata_bp.route('/api/urldata/query', methods=['POST'])
def query_urldata():
    data = request.json
    query_type = data.get('type', 'date')
    result = urldata_service.query(
        query_type,
        date=data.get('date', ''),
        number=data.get('number', ''),
        content=data.get('content', ''),
        box_index=data.get('box_index')
    )
    return jsonify(result)


@urldata_bp.route('/api/urldata/process', methods=['POST'])
def process_data():
    data = request.json or {}
    start_time = data.get('start_time', '-1h')
    stop_time = data.get('stop_time', None)
    result = urldata_service.process_data(start_time, stop_time)
    return jsonify(result)

@urldata_bp.route('/api/urldata/settings', methods=['GET'])
def get_settings():
    return jsonify(urldata_service.get_settings())


@urldata_bp.route('/api/urldata/settings', methods=['POST'])
def save_settings():
    data = request.json
    result = urldata_service.save_settings(data.get('mins'), data.get('maxs'))
    return jsonify(result)


@urldata_bp.route('/api/urldata/last_numbers', methods=['GET'])
def get_last_numbers():
    numbers = urldata_service.get_last_numbers()
    return jsonify({'numbers': numbers})


@urldata_bp.route('/api/urldata/last_numbers', methods=['POST'])
def save_last_numbers():
    data = request.json
    result = urldata_service.save_last_numbers(data.get('numbers'))
    return jsonify(result)


@urldata_bp.route('/api/urldata/last_numbers', methods=['DELETE'])
def reset_last_numbers():
    result = urldata_service.reset_last_numbers()
    return jsonify(result)


@urldata_bp.route('/api/urldata/error_settings', methods=['GET'])
def get_error_settings():
    return jsonify(urldata_service.get_error_settings())


@urldata_bp.route('/api/urldata/error_settings', methods=['POST'])
def save_error_settings():
    data = request.json
    result = urldata_service.save_error_settings(
        data.get('enabled', True),
        data.get('error_settings', [1] * 7)
    )
    return jsonify(result)


@urldata_bp.route('/api/urldata/scheduler_config', methods=['GET'])
def get_scheduler_config():
    return jsonify(urldata_service.get_scheduler_config())


@urldata_bp.route('/api/urldata/scheduler_config', methods=['POST'])
def save_scheduler_config():
    data = request.json
    result = urldata_service.save_scheduler_config(data)
    return jsonify(result)


@urldata_bp.route('/api/urldata/scheduler_status', methods=['GET'])
def get_scheduler_status():
    return jsonify(urldata_service.get_scheduler_status())

@urldata_bp.route('/api/urldata/influx_status', methods=['GET'])
def get_influx_status():
    return jsonify(urldata_service.get_influx_status())


@urldata_bp.route('/api/urldata/influx_sample', methods=['GET'])
def get_influx_sample():
    bucket_key = request.args.get('bucket', 'bucket_data')
    hours = int(request.args.get('hours', 1))
    limit = int(request.args.get('limit', 10))
    return jsonify(urldata_service.query_influx_sample(bucket_key, hours, limit))