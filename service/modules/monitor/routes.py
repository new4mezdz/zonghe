from flask import Blueprint, request, jsonify, render_template
from .services import monitor_service, shortcut_service, history_service, tcp_service

monitor_bp = Blueprint('monitor', __name__)


@monitor_bp.route('/monitor')
def monitor_page():
    return render_template('monitor.html')


# ========== 文件监控相关 ==========
@monitor_bp.route('/api/monitor/upload', methods=['POST'])
def upload_monitor_file():
    if 'file' not in request.files:
        return jsonify({'error': '没有文件'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': '没有选择文件'}), 400

    result = monitor_service.upload_file(file)
    return jsonify(result)


@monitor_bp.route('/api/monitor/blacklist', methods=['GET'])
def get_blacklist():
    """获取黑名单列表"""
    return jsonify({
        'success': True,
        'blacklist': monitor_service.get_blacklist(),
        'count': len(monitor_service.blacklist)
    })


@monitor_bp.route('/api/monitor/blacklist', methods=['POST'])
def upload_blacklist():
    """上传黑名单文件"""
    if 'file' not in request.files:
        return jsonify({'error': '没有文件'}), 400
    file = request.files['file']
    result = monitor_service.upload_blacklist(file)
    return jsonify(result)


@monitor_bp.route('/api/monitor/check', methods=['POST'])
def check_content():
    """检查文件内容"""
    result, error = monitor_service.check_content()
    if error:
        return jsonify({'error': error}), 400
    return jsonify(result)


# ========== 快捷指令相关 ==========
@monitor_bp.route('/api/monitor/shortcuts', methods=['GET'])
def get_shortcuts():
    """获取所有快捷指令"""
    return jsonify({
        'success': True,
        'shortcuts': shortcut_service.get_all()
    })


@monitor_bp.route('/api/monitor/shortcuts', methods=['POST'])
def add_shortcut():
    """添加快捷指令"""
    data = request.json
    cmd = data.get('cmd', '')
    if shortcut_service.add(cmd):
        return jsonify({'success': True, 'shortcuts': shortcut_service.get_all()})
    return jsonify({'error': '添加失败'}), 400


@monitor_bp.route('/api/monitor/shortcuts/<int:index>', methods=['DELETE'])
def delete_shortcut(index):
    """删除快捷指令"""
    if shortcut_service.delete(index):
        return jsonify({'success': True, 'shortcuts': shortcut_service.get_all()})
    return jsonify({'error': '删除失败'}), 400


@monitor_bp.route('/api/monitor/shortcuts/clear', methods=['POST'])
def clear_shortcuts():
    """清空所有快捷指令"""
    shortcut_service.clear()
    return jsonify({'success': True})


# ========== 发送历史相关 ==========
@monitor_bp.route('/api/monitor/history', methods=['GET'])
def get_history():
    """获取发送历史"""
    return jsonify({
        'success': True,
        'history': history_service.get_all()
    })


@monitor_bp.route('/api/monitor/history', methods=['POST'])
def add_history():
    """添加发送历史"""
    data = request.json
    cmd = data.get('cmd', '')
    history_service.add(cmd)
    return jsonify({'success': True})


@monitor_bp.route('/api/monitor/history', methods=['DELETE'])
def clear_history():
    """清空发送历史"""
    history_service.clear()
    return jsonify({'success': True})


# ========== TCP日志相关 ==========
@monitor_bp.route('/api/monitor/logs', methods=['GET'])
def get_logs():
    """获取TCP日志"""
    if tcp_service:
        return jsonify({
            'success': True,
            'logs': tcp_service.get_logs()
        })
    return jsonify({'error': 'TCP服务未初始化'}), 500


@monitor_bp.route('/api/monitor/logs', methods=['DELETE'])
def clear_logs():
    """清空TCP日志"""
    if tcp_service:
        tcp_service.clear_logs()
        return jsonify({'success': True})
    return jsonify({'error': 'TCP服务未初始化'}), 500


@monitor_bp.route('/api/monitor/logs/export', methods=['GET'])
def export_logs():
    """导出TCP日志"""
    if tcp_service:
        content = tcp_service.export_logs()
        return content, 200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'attachment; filename=tcp_log.txt'
        }
    return jsonify({'error': 'TCP服务未初始化'}), 500