import os
import cv2
import numpy as np
from copy import deepcopy
from typing import List, Dict, Optional
from ultralytics import YOLO
from flask import Flask, request, jsonify
from datetime import datetime
import logging
import requests
import json
import threading

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

# ========================================
# ★★★ 配置 ★★★
# ========================================
WEB_SERVER_URL = "http://10.164.62.212:5000"
BASE_DIR = r'F:\Users\Administrator\Desktop\蓝时代'

NUM_ROWS = 5
NUM_COLUMNS = 5
CONF_THRESH = 0.40
IOU_THRESH = 0.80

# --- 与 check.py 一致的额外常量 ---
MIN_CONF_BOX12 = 0.40
EBOX_DEDUP = True
EBOX_MERGE_IOU = 0.55
EBOX_CENTER_DIST_FRAC = 0.50
FBOX_ID_FALLBACK = 2
EBOX_ID_FALLBACK = 3
CONFLICT_IOU = 0.55
ROW_CAPACITY = 5
ROW_KEEP_TOPK_OCCUPIED = True

class_map = {0: '1box', 1: '2box', 2: 'fbox'}

# 模型缓存
loaded_models = {}

# 当前任务状态
task_status = {
    'running': False,
    'progress': '',
    'total': 0,
    'current': 0,
    'fbox_count': 0,
}


def get_model_for_brand(brand_name):
    model_map = {
        '蓝时代': r'E:\BOXX\runs\detect\train_optimized41蓝时代\weights\best.pt',
    }
    return model_map.get(brand_name, None)


def load_model(brand_name):
    """加载模型，带缓存"""
    if brand_name in loaded_models:
        return loaded_models[brand_name]
    model_path = get_model_for_brand(brand_name)
    if not model_path or not os.path.exists(model_path):
        logger.error(f"模型不存在: {brand_name} -> {model_path}")
        return None
    try:
        model = YOLO(model_path)
        loaded_models[brand_name] = model
        logger.info(f"模型加载成功: {brand_name}")
        return model
    except Exception as e:
        logger.error(f"模型加载失败: {e}")
        return None


# ========================================
# ★★★ 与 check.py 一致的核心检测逻辑 ★★★
# ========================================

def _pair_iou(box_a: np.ndarray, box_b: np.ndarray) -> float:
    x1 = max(box_a[0], box_b[0])
    y1 = max(box_a[1], box_b[1])
    x2 = min(box_a[2], box_b[2])
    y2 = min(box_a[3], box_b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area_a = max(0.0, (box_a[2] - box_a[0])) * max(0.0, (box_a[3] - box_a[1]))
    area_b = max(0.0, (box_b[2] - box_b[0])) * max(0.0, (box_b[3] - box_b[1]))
    union = max(1e-6, area_a + area_b - inter)
    return float(inter / union)


def _ebox_dedup(xyxy: np.ndarray, cls: np.ndarray, conf: np.ndarray, ebox_id: int) -> np.ndarray:
    n = cls.shape[0]
    keep = np.ones(n, dtype=bool)
    idx_ebox = np.where(cls == ebox_id)[0]
    if idx_ebox.size <= 1:
        return keep
    order = idx_ebox[np.argsort(-conf[idx_ebox])]
    kept = []
    for i in order:
        if not keep[i]:
            continue
        dup = False
        for k in kept:
            iou = _pair_iou(xyxy[i], xyxy[k])
            cx_i = 0.5 * (xyxy[i][0] + xyxy[i][2])
            cy_i = 0.5 * (xyxy[i][1] + xyxy[i][3])
            cx_k = 0.5 * (xyxy[k][0] + xyxy[k][2])
            cy_k = 0.5 * (xyxy[k][1] + xyxy[k][3])
            dx, dy = abs(cx_i - cx_k), abs(cy_i - cy_k)
            wi = xyxy[i][2] - xyxy[i][0]
            hi = xyxy[i][3] - xyxy[i][1]
            wk = xyxy[k][2] - xyxy[k][0]
            hk = xyxy[k][3] - xyxy[k][1]
            scale = max(1.0, min(wi, hi, wk, hk))
            near_centers = (np.hypot(dx, dy) <= EBOX_CENTER_DIST_FRAC * scale)
            if (iou >= EBOX_MERGE_IOU) or near_centers:
                keep[i] = False
                dup = True
                break
        if not dup:
            kept.append(i)
    return keep


def class_id_by_name(model_names: Dict[int, str], target: str) -> Optional[int]:
    for k, v in model_names.items():
        if str(v).lower() == target.lower():
            return k
    return None


def _extract_boxes_arrays(res):
    try:
        boxes = res.boxes
        xyxy = boxes.xyxy.cpu().numpy() if hasattr(boxes, "xyxy") else np.zeros((0, 4), dtype=np.float32)
        cls = boxes.cls.cpu().numpy().astype(int) if hasattr(boxes, "cls") else np.zeros((0,), dtype=int)
        conf = boxes.conf.cpu().numpy() if hasattr(boxes, "conf") else np.zeros((0,), dtype=float)
        return xyxy, cls, conf
    except Exception:
        return np.zeros((0, 4), dtype=np.float32), np.zeros((0,), dtype=int), np.zeros((0,), dtype=float)


def _iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    if a.size == 0 or b.size == 0:
        return np.zeros((a.shape[0], b.shape[0]), dtype=np.float32)
    ax1, ay1, ax2, ay2 = a[:, 0:1], a[:, 1:2], a[:, 2:3], a[:, 3:4]
    bx1, by1, bx2, by2 = b[:, 0], b[:, 1], b[:, 2], b[:, 3]
    inter_x1 = np.maximum(ax1, bx1)
    inter_y1 = np.maximum(ay1, by1)
    inter_x2 = np.minimum(ax2, bx2)
    inter_y2 = np.minimum(ay2, by2)
    inter_w = np.clip(inter_x2 - inter_x1, a_min=0, a_max=None)
    inter_h = np.clip(inter_y2 - inter_y1, a_min=0, a_max=None)
    inter = inter_w * inter_h
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    union = area_a + area_b - inter
    return (inter / np.clip(union, 1e-6, None)).astype(np.float32)


def _suppress_conflicts_ebox_vs_normal(xyxy: np.ndarray, cls: np.ndarray, conf: np.ndarray,
                                       fbox_id: int, ebox_id: int, iou_thr: float = CONFLICT_IOU) -> np.ndarray:
    n = cls.shape[0]
    if n == 0:
        return np.zeros((0,), dtype=bool)
    keep = np.ones(n, dtype=bool)
    idx_ebox = np.where(cls == ebox_id)[0]
    idx_norm = np.where((cls != ebox_id) & (cls != fbox_id))[0]
    if idx_ebox.size == 0 or idx_norm.size == 0:
        return keep
    iou = _iou_matrix(xyxy[idx_ebox], xyxy[idx_norm])
    edges = []
    for ie, e_idx in enumerate(idx_ebox):
        overlap_norm = idx_norm[np.where(iou[ie] >= iou_thr)[0]]
        for n_idx in overlap_norm:
            edges.append((e_idx, n_idx))
    if not edges:
        return keep
    parent = np.arange(n, dtype=int)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[ry] = rx

    for a, b in edges:
        union(a, b)
    comp = {}
    for i in set([p for e in edges for p in e]):
        r = find(i)
        comp.setdefault(r, []).append(i)
    for root, members in comp.items():
        ms = np.array(members, dtype=int)
        has_e = np.any(cls[ms] == ebox_id)
        has_n = np.any((cls[ms] != ebox_id) & (cls[ms] != fbox_id))
        if not (has_e and has_n):
            continue
        best = ms[np.argmax(conf[ms])]
        losers = ms[ms != best]
        keep[losers] = False
    return keep


def _group_rows_by_y(xyxy: np.ndarray) -> List[int]:
    n = xyxy.shape[0]
    if n == 0:
        return []
    y_centers = (xyxy[:, 1] + xyxy[:, 3]) / 2.0
    heights = (xyxy[:, 3] - xyxy[:, 1])
    order = np.argsort(y_centers)
    tol = max(0.25 * float(np.median(heights) if heights.size > 0 else 40.0), 20.0)
    row_ids = np.zeros(n, dtype=int)
    current_row = 0
    last_y = None
    for idx in order:
        yc = y_centers[idx]
        if last_y is None or abs(yc - last_y) > tol:
            current_row += 1 if last_y is not None else 0
            last_y = yc
        else:
            last_y = (last_y * 0.8 + yc * 0.2)
        row_ids[idx] = current_row
    return row_ids.tolist()


def _suppress_fbox_on_full_rows(xyxy: np.ndarray, cls: np.ndarray, conf: np.ndarray,
                                fbox_id: int, ebox_id: int) -> np.ndarray:
    n = cls.shape[0]
    if n == 0:
        return np.zeros((0,), dtype=bool)
    row_ids = np.array(_group_rows_by_y(xyxy), dtype=int)
    keep = np.ones(n, dtype=bool)
    for r in np.unique(row_ids):
        idxs = np.where(row_ids == r)[0]
        is_fbox = (cls[idxs] == fbox_id)
        is_ebox = (cls[idxs] == ebox_id)
        occ_idxs = idxs[~(is_fbox | is_ebox)]
        if occ_idxs.size >= ROW_CAPACITY:
            keep[idxs[is_fbox]] = False
        if ROW_KEEP_TOPK_OCCUPIED and occ_idxs.size > ROW_CAPACITY:
            topk = min(ROW_CAPACITY, occ_idxs.size)
            order = np.argsort(-conf[occ_idxs])
            keep_occ = np.zeros(occ_idxs.size, dtype=bool)
            keep_occ[order[:topk]] = True
            keep[occ_idxs[~keep_occ]] = False
    return keep


# ========================================
# ★★★ 图片验证与检测 ★★★
# ========================================

def validate_image(image_path):
    """验证图像，支持中文路径"""
    try:
        if not os.path.exists(image_path):
            return False
        if os.path.getsize(image_path) == 0:
            return False
        img = cv2.imdecode(np.fromfile(image_path, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            img = cv2.imread(image_path)
        if img is None:
            return False
        if img.shape[0] == 0 or img.shape[1] == 0:
            return False
        return True
    except:
        return False


def detect_single(model, image_path):
    """检测单张图片，使用与 check.py 一致的完整后处理逻辑"""
    try:
        if not validate_image(image_path):
            return None

        from ultralytics.engine.results import Results, Boxes

        res = model(os.path.abspath(image_path), conf=CONF_THRESH, iou=IOU_THRESH)[0]
        xyxy, cls, conf = _extract_boxes_arrays(res)
        names_map = getattr(res, 'names', {})

        fbox_id = class_id_by_name(names_map, 'fbox') or FBOX_ID_FALLBACK
        ebox_id = class_id_by_name(names_map, 'ebox') or EBOX_ID_FALLBACK
        box1_id = class_id_by_name(names_map, '1box')
        box2_id = class_id_by_name(names_map, '2box') or class_id_by_name(names_map, '2boxs')

        n = cls.shape[0]
        if n == 0:
            return None

        # --- 与 check.py 一致的多轮过滤 ---

        # 第1轮：过滤低置信度的 1box/2box
        keep0 = np.ones(n, dtype=bool)
        if box1_id is not None:
            keep0 &= ~((cls == box1_id) & (conf < MIN_CONF_BOX12))
        if box2_id is not None:
            keep0 &= ~((cls == box2_id) & (conf < MIN_CONF_BOX12))

        if keep0.sum() == 0:
            return None

        base_idx = np.where(keep0)[0]
        xyxy0, cls0, conf0 = xyxy[keep0], cls[keep0], conf[keep0]

        # 第2轮：ebox 与普通框的冲突抑制
        keep1_sub = _suppress_conflicts_ebox_vs_normal(xyxy0, cls0, conf0, fbox_id, ebox_id)
        if keep1_sub.sum() == 0:
            return None

        idx1 = base_idx[np.where(keep1_sub)[0]]
        xyxy1, cls1, conf1 = xyxy[idx1], cls[idx1], conf[idx1]

        # 第3轮：ebox 去重
        keep_ebox = _ebox_dedup(xyxy1, cls1, conf1, ebox_id) if EBOX_DEDUP else np.ones_like(cls1, dtype=bool)
        if keep_ebox.sum() == 0:
            return None

        idx2 = idx1[np.where(keep_ebox)[0]]
        xyxy2, cls2, conf2 = xyxy[idx2], cls[idx2], conf[idx2]

        # 第4轮：行容量规则 — 满行抑制 fbox
        keep2_sub = _suppress_fbox_on_full_rows(xyxy2, cls2, conf2, fbox_id, ebox_id)
        kept_idx = idx2[np.where(keep2_sub)[0]]

        if kept_idx.size == 0:
            return None

        # 构建过滤后的结果用于绘图
        filtered = deepcopy(res)
        try:
            filtered.boxes = res.boxes[kept_idx]
        except:
            filtered.boxes = Boxes(res.boxes.data[kept_idx], res.orig_shape)

        kept_cls = filtered.boxes.cls.cpu().numpy().astype(int)
        has_fbox = (fbox_id in kept_cls)
        has_ebox = (ebox_id in kept_cls)

        # 只有存在异常框才算检出
        if not has_fbox and not has_ebox:
            return None

        # 计算 fbox 位置
        fbox_positions = []
        if has_fbox:
            kept_xyxy = filtered.boxes.xyxy.cpu().numpy()
            img_h, img_w = res.orig_shape
            for i in range(len(kept_cls)):
                if kept_cls[i] == fbox_id:
                    cx = (kept_xyxy[i][0] + kept_xyxy[i][2]) / 2.0
                    cy = (kept_xyxy[i][1] + kept_xyxy[i][3]) / 2.0
                    col = max(1, min(int(cx / img_w * NUM_COLUMNS) + 1, NUM_COLUMNS))
                    row = max(1, min(int(cy / img_h * NUM_ROWS) + 1, NUM_ROWS))
                    fbox_positions.append([row, col])

        annotated = filtered.plot()
        annotated_bgr = cv2.cvtColor(annotated, cv2.COLOR_RGB2BGR)

        return {
            'fbox_positions': fbox_positions,
            'has_fbox': has_fbox,
            'has_ebox': has_ebox,
            'image_bgr': annotated_bgr,
        }

    except Exception as e:
        logger.error(f"检测失败 {image_path}: {e}")
        return None


# ========================================
# ★★★ 后台检测任务 ★★★
# ========================================

def run_detection_task(folder_path, brand_name, machine_name):
    """在后台线程运行检测任务"""
    global task_status
    task_status = {'running': True, 'progress': '正在初始化...', 'total': 0, 'current': 0, 'fbox_count': 0}

    try:
        model = load_model(brand_name)
        if model is None:
            task_status['progress'] = f'模型加载失败: {brand_name}'
            task_status['running'] = False
            return

        # 获取图片列表
        all_files = [f for f in os.listdir(folder_path)
                     if f.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp'))]
        total = len(all_files)
        task_status['total'] = total

        if total == 0:
            task_status['progress'] = '文件夹中没有图片'
            task_status['running'] = False
            return

        fbox_count = 0
        detect_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

        for idx, file in enumerate(all_files, 1):
            task_status['current'] = idx
            task_status['progress'] = f'检测中: {idx}/{total} - {file}'

            img_path = os.path.join(folder_path, file)
            result = detect_single(model, img_path)
            is_alert = result is not None

            if is_alert:
                fbox_count += 1
                task_status['fbox_count'] = fbox_count

            # 所有图片都推送（异常用标注图，正常用原图）
            try:
                if is_alert:
                    _, img_bytes = cv2.imencode('.jpg', result['image_bgr'])
                else:
                    orig = cv2.imdecode(np.fromfile(img_path, dtype=np.uint8), cv2.IMREAD_COLOR)
                    if orig is None:
                        continue
                    _, img_bytes = cv2.imencode('.jpg', orig)

                files = {'image': (file, img_bytes.tobytes(), 'image/jpeg')}
                data = {
                    'machine': machine_name,
                    'brand': brand_name,
                    'filename': file,
                    'fbox_positions': json.dumps(result['fbox_positions'] if is_alert else []),
                    'detect_time': detect_time,
                    'is_alert': '1' if is_alert else '0',
                }
                requests.post(f"{WEB_SERVER_URL}/api/yolo/upload", files=files, data=data, timeout=30)
            except Exception as e:
                logger.error(f"推送失败 {file}: {e}")

        # 推送汇总
        try:
            summary = {
                'machine': machine_name,
                'brand': brand_name,
                'total_images': total,
                'fbox_count': fbox_count,
                'detect_time': detect_time,
            }
            requests.post(f"{WEB_SERVER_URL}/api/yolo/summary", json=summary, timeout=15)
        except Exception as e:
            logger.error(f"汇总推送失败: {e}")

        task_status['progress'] = f'完成! 共{total}张, 异常{fbox_count}张'
        logger.info(f"检测完成: {folder_path} - {total}张, 异常{fbox_count}张")

    except Exception as e:
        task_status['progress'] = f'任务出错: {e}'
        logger.error(f"检测任务异常: {e}")
    finally:
        task_status['running'] = False


# ========================================
# ★★★ API 路由 ★★★
# ========================================

@app.route('/api/browse', methods=['GET'])
def browse_folder():
    """浏览文件夹列表"""
    path = request.args.get('path', '') or BASE_DIR

    if not os.path.exists(path):
        return jsonify({'success': False, 'error': f'路径不存在: {path}'})

    try:
        items = []
        for name in sorted(os.listdir(path)):
            full = os.path.join(path, name)
            if os.path.isdir(full):
                items.append({'name': name, 'type': 'folder', 'path': full})
            elif name.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp')):
                items.append({'name': name, 'type': 'image', 'path': full})

        image_count = sum(1 for i in items if i['type'] == 'image')
        folder_count = sum(1 for i in items if i['type'] == 'folder')

        return jsonify({
            'success': True,
            'path': path,
            'parent': os.path.dirname(path) if path != BASE_DIR else None,
            'items': items,
            'image_count': image_count,
            'folder_count': folder_count,
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/brands', methods=['GET'])
def get_brands():
    """获取已配置的品牌列表"""
    brands = list({
        '蓝时代': r'E:\BOXX\runs\detect\train_optimized41蓝时代\weights\best.pt',
    }.keys())
    return jsonify({'brands': brands})


@app.route('/api/detect', methods=['POST'])
def start_detect():
    """启动检测任务"""
    global task_status
    if task_status['running']:
        return jsonify({'success': False, 'error': '已有任务在运行中'})

    data = request.json or {}
    folder_path = data.get('folder', '')
    brand_name = data.get('brand', '')
    machine_name = data.get('machine', '未知')

    if not folder_path or not os.path.exists(folder_path):
        return jsonify({'success': False, 'error': f'文件夹不存在: {folder_path}'})
    if not brand_name:
        return jsonify({'success': False, 'error': '请选择品牌'})

    t = threading.Thread(target=run_detection_task, args=(folder_path, brand_name, machine_name))
    t.daemon = True
    t.start()

    return jsonify({'success': True, 'message': '任务已启动'})


@app.route('/api/status', methods=['GET'])
def get_status():
    """查询当前任务状态"""
    return jsonify(task_status)


@app.route('/api/preview', methods=['GET'])
def preview_image():
    """返回指定路径的图片（缩略图）"""
    from flask import send_file
    import io
    path = request.args.get('path', '')
    if not path or not os.path.exists(path):
        return jsonify({'success': False, 'error': '文件不存在'}), 404
    try:
        img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            img = cv2.imread(path)
        if img is None:
            return jsonify({'success': False, 'error': '无法读取图片'}), 400
        h, w = img.shape[:2]
        max_size = 300
        scale = min(max_size / w, max_size / h, 1.0)
        if scale < 1.0:
            img = cv2.resize(img, (int(w * scale), int(h * scale)))
        _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 70])
        return send_file(io.BytesIO(buf.tobytes()), mimetype='image/jpeg')
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/ping', methods=['GET'])
def ping():
    return jsonify({'success': True, 'message': '检测服务在线'})


if __name__ == '__main__':
    logger.info("检测服务启动中...")
    logger.info(f"目标网页服务器: {WEB_SERVER_URL}")
    app.run(host='0.0.0.0', port=5001, debug=False)