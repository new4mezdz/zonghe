// Core scene setup, shared state, and layout foundations.

// roundRect 兼容性 polyfill
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
    if (typeof r === 'number') r = [r, r, r, r];
    this.beginPath();
    this.moveTo(x + r[0], y);
    this.lineTo(x + w - r[1], y);
    this.quadraticCurveTo(x + w, y, x + w, y + r[1]);
    this.lineTo(x + w, y + h - r[2]);
    this.quadraticCurveTo(x + w, y + h, x + w - r[2], y + h);
    this.lineTo(x + r[3], y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - r[3]);
    this.lineTo(x, y + r[0]);
    this.quadraticCurveTo(x, y, x + r[0], y);
    this.closePath();
    return this;
  };
}

// ========== 3D 场景 ==========
// 车间水平尺寸放大倍数。
const SCALE = 10;
const DEFAULT_BUILDING = Object.freeze({
  width: 120,
  depth: 40,
  wallH: 28,
  ridgeH: 50
});
const BUILDING = {};

function normalizeBuildingConfig(building) {
  const src = building || DEFAULT_BUILDING;
  const width = clamp(Number(src.width) || DEFAULT_BUILDING.width, 24, 140);
  const depth = clamp(Number(src.depth) || DEFAULT_BUILDING.depth, 18, 110);
  const wallH = clamp(Number(src.wallH) || DEFAULT_BUILDING.wallH, 12, 56);
  const ridgeH = clamp(Number(src.ridgeH) || DEFAULT_BUILDING.ridgeH, wallH + 6, 84);
  return { width, depth, wallH, ridgeH };
}

function applyBuildingConfig(building) {
  const normalized = normalizeBuildingConfig(building);
  BUILDING.configWidth = normalized.width;
  BUILDING.configDepth = normalized.depth;
  BUILDING.width = normalized.width * SCALE;
  BUILDING.depth = normalized.depth * SCALE;
  BUILDING.halfW = BUILDING.width / 2;
  BUILDING.halfD = BUILDING.depth / 2;
  BUILDING.wallH = normalized.wallH;
  BUILDING.ridgeH = normalized.ridgeH;
  BUILDING.roofOverhang = clamp(BUILDING.width * 0.03, 1.2 * SCALE, 2.4 * SCALE);
  BUILDING.trussStep = clamp(BUILDING.depth / 4, 7 * SCALE, 11 * SCALE);
  BUILDING.roofRise = BUILDING.ridgeH - BUILDING.wallH;
  BUILDING.roofHalfSpan = BUILDING.halfW + BUILDING.roofOverhang;
  BUILDING.roofSlopeLen = Math.sqrt(BUILDING.roofHalfSpan ** 2 + BUILDING.roofRise ** 2);
  BUILDING.roofAngle = Math.atan2(BUILDING.roofRise, BUILDING.roofHalfSpan);
  BUILDING.roofCenterY = BUILDING.wallH + BUILDING.roofRise / 2;
  BUILDING.roofDepth = BUILDING.depth + BUILDING.roofOverhang * 2;
  return normalized;
}

applyBuildingConfig(DEFAULT_BUILDING);

const canvas = document.getElementById('scene');
const sceneWrap = document.getElementById('scene-wrap');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2c30);
scene.fog = new THREE.Fog(0x2a2c30, 80 * SCALE, 220 * SCALE);

// 暗色环境穹顶 (上深下浅, 营造室内剖切场景的氛围)
function buildSkyDome() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.00, '#1a1c20');
  g.addColorStop(0.45, '#26282d');
  g.addColorStop(0.80, '#34363b');
  g.addColorStop(1.00, '#3c3e44');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  const skyMat = new THREE.MeshBasicMaterial({
    map: tex, side: THREE.BackSide, depthWrite: false, fog: false
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), skyMat);
  sky.renderOrder = -1;
  scene.add(sky);
}
buildSkyDome();

const camera = new THREE.PerspectiveCamera(50, 1, 1.2, 2200);
// Tibber 风格的高位俯视, 让剖切式无顶视角成为默认
const initialCameraFit = Math.max(BUILDING.width, BUILDING.depth);
camera.position.set(0, initialCameraFit * 0.85, BUILDING.depth * 1.05);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const FLOOR_LAYER = Object.freeze({
  outdoor: -0.1,
  ground: 0.025,
  glow: 0.09,
  zone: 0.14,
  path: 0.18,
  workstation: 0.22,
  rack: 0.26,
  preview: 0.34,
  marker: 0.42,
  border: 0.48
});
const FLOOR_RENDER_ORDER = Object.freeze({
  glow: 20,
  zone: 30,
  path: 32,
  workstation: 34,
  rack: 36,
  preview: 48,
  marker: 56
});

const controls = new THREE.OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 15 * SCALE;
controls.maxDistance = 75 * SCALE;
controls.maxPolarAngle = Math.PI / 2.1;
controls.target.set(0, 0, 0);

const KEYBOARD_PAN_UP = new THREE.Vector3(0, 1, 0);
const keyboardPanForward = new THREE.Vector3();
const keyboardPanRight = new THREE.Vector3();
const keyboardPanOffset = new THREE.Vector3();
const WALK_POINTER_SENSITIVITY = 0.0022;
const WALK_MAX_PITCH = Math.PI / 2 - 0.08;
const WALK_MARGIN = SCALE * 0.9;
const walkMoveForward = new THREE.Vector3();
const walkMoveRight = new THREE.Vector3();
const walkMoveOffset = new THREE.Vector3();
const walkLookDirection = new THREE.Vector3();
const walkLookTarget = new THREE.Vector3();
const walkLookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const walkInteractCenter = new THREE.Vector2(0, 0);
const walkInteractRaycaster = new THREE.Raycaster();
const walkKeys = {
  forward: false,
  back: false,
  left: false,
  right: false,
  sprint: false
};
let walkMode = false;
let walkPointerLocked = false;
let walkInteractTargetIdx = null;
let walkInteractPending = false;

function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function getKeyboardPanDirection(event) {
  switch (event.code) {
    case 'KeyW':
    case 'Numpad8':
      return { x: 0, z: 1 };
    case 'KeyS':
    case 'Numpad2':
      return { x: 0, z: -1 };
    case 'KeyA':
    case 'Numpad4':
      return { x: -1, z: 0 };
    case 'KeyD':
    case 'Numpad6':
      return { x: 1, z: 0 };
  }
  switch (event.key) {
    case 'ArrowUp':
      return { x: 0, z: 1 };
    case 'ArrowDown':
      return { x: 0, z: -1 };
    case 'ArrowLeft':
      return { x: -1, z: 0 };
    case 'ArrowRight':
      return { x: 1, z: 0 };
  }
  return null;
}

function getWalkKeyName(event) {
  switch (event.code) {
    case 'KeyW':
    case 'ArrowUp':
    case 'Numpad8':
      return 'forward';
    case 'KeyS':
    case 'ArrowDown':
    case 'Numpad2':
      return 'back';
    case 'KeyA':
    case 'ArrowLeft':
    case 'Numpad4':
      return 'left';
    case 'KeyD':
    case 'ArrowRight':
    case 'Numpad6':
      return 'right';
    case 'ShiftLeft':
    case 'ShiftRight':
      return 'sprint';
    default:
      return '';
  }
}

function panSceneByKeyboard(dirX, dirZ) {
  keyboardPanForward.subVectors(controls.target, camera.position);
  keyboardPanForward.y = 0;
  if (keyboardPanForward.lengthSq() < 0.0001) {
    keyboardPanForward.set(0, 0, -1);
  } else {
    keyboardPanForward.normalize();
  }
  keyboardPanRight.crossVectors(keyboardPanForward, KEYBOARD_PAN_UP).normalize();
  const distance = camera.position.distanceTo(controls.target);
  const step = clamp(distance * 0.06, 1.2 * SCALE, 4.4 * SCALE);
  keyboardPanOffset.copy(keyboardPanRight).multiplyScalar(dirX * step);
  keyboardPanOffset.addScaledVector(keyboardPanForward, dirZ * step);
  camera.position.add(keyboardPanOffset);
  controls.target.add(keyboardPanOffset);
  controls.update();
}

function getWalkEyeHeight() {
  return clamp(BUILDING.wallH * 0.58, 14.5, 18.5);
}

function resetWalkKeys() {
  Object.keys(walkKeys).forEach(function(key) {
    walkKeys[key] = false;
  });
}

function clampWalkPosition(x, z) {
  return {
    x: clamp(x, -BUILDING.halfW + WALK_MARGIN, BUILDING.halfW - WALK_MARGIN),
    z: clamp(z, -BUILDING.halfD + WALK_MARGIN, BUILDING.halfD - WALK_MARGIN)
  };
}

function syncOrbitTargetFromCamera() {
  camera.getWorldDirection(walkLookDirection);
  controls.target.copy(camera.position).addScaledVector(walkLookDirection, Math.max(controls.minDistance + 12, 18 * SCALE));
}

function updateWalkModeUI() {
  const root = document.getElementById('hud-walk');
  const label = document.getElementById('walk-label');
  if (!root || !label) return;
  root.classList.toggle('active', walkMode);
  label.textContent = walkMode ? '第一人称:开' : '第一人称:关';
}

function requestWalkPointerLock() {
  if (!walkMode || walkPointerLocked) return;
  if (document.querySelector('.modal-bg.show')) return;
  if (typeof canvas.requestPointerLock === 'function') {
    canvas.requestPointerLock();
  }
}

function updateWalkLookTarget() {
  syncOrbitTargetFromCamera();
}

function getWalkInteractLamp() {
  if (walkInteractTargetIdx == null || walkInteractTargetIdx < 0 || walkInteractTargetIdx >= lamps.length) return null;
  return lamps[walkInteractTargetIdx];
}

function setWalkInteractTarget(index) {
  const next = typeof index === 'number' && index >= 0 && index < lamps.length ? index : null;
  if (walkInteractTargetIdx === next) return;
  walkInteractTargetIdx = next;
  if (typeof focusLamp === 'function') {
    focusLamp(next);
  }
}

function updateWalkInteractUI() {
  const reticle = document.getElementById('walk-reticle');
  const panel = document.getElementById('walk-interact');
  const title = document.getElementById('walk-interact-title');
  const meta = document.getElementById('walk-interact-meta');
  const button = document.getElementById('walk-interact-btn');
  const hint = document.getElementById('scene-hint');
  if (reticle) {
    reticle.classList.toggle('show', !!walkMode);
    reticle.classList.toggle('active', walkInteractTargetIdx != null);
  }

  if (!walkMode) {
    if (panel) panel.hidden = true;
    return;
  }

  if (hint) {
    hint.textContent = walkPointerLocked
      ? '\u7b2c\u4e00\u4eba\u79f0\u6f2b\u6e38 \u00b7 WASD/\u65b9\u5411\u952e\u884c\u8d70 \u00b7 Shift \u52a0\u901f \u00b7 E/Enter \u4ea4\u4e92\u5f53\u524d\u8bbe\u5907 \u00b7 Esc \u9000\u51fa'
      : '\u7b2c\u4e00\u4eba\u79f0\u6f2b\u6e38 \u00b7 \u70b9\u51fb\u573a\u666f\u9501\u5b9a\u9f20\u6807 \u00b7 WASD/\u65b9\u5411\u952e\u884c\u8d70 \u00b7 E/Enter \u4ea4\u4e92\u5f53\u524d\u8bbe\u5907 \u00b7 Esc \u9000\u51fa';
  }

  if (!panel || !title || !meta || !button) return;  // 交互提示框已删除, 跳过其余面板 UI
  panel.hidden = false;
  const lamp = getWalkInteractLamp();
  if (!lamp) {
    title.textContent = '\u5bf9\u51c6\u8bbe\u5907\u53ef\u4ea4\u4e92';
    meta.textContent = walkPointerLocked
      ? '\u6309 E \u6216 Enter \u5207\u6362\u5f53\u524d\u8bbe\u5907\uff0cEsc \u9000\u51fa\u7b2c\u4e00\u4eba\u79f0'
      : '\u70b9\u51fb\u573a\u666f\u8fdb\u5165\u7b2c\u4e00\u4eba\u79f0\uff0c\u968f\u540e\u7528 E \u6216 Enter \u4e0e\u8bbe\u5907\u4ea4\u4e92';
    button.disabled = walkPointerLocked;
    button.textContent = walkPointerLocked ? 'E \u5207\u6362' : '\u8fdb\u5165\u6f2b\u6e38';
    return;
  }

  const deviceInfo = typeof deviceStatus !== 'undefined' && lamp.deviceIp ? deviceStatus[lamp.deviceIp] : null;
  const connected = !!(deviceInfo && deviceInfo.connected);
  const stateText = connected ? (lamp.state ? '\u5f53\u524d\u5df2\u5f00' : '\u5f53\u524d\u5df2\u5173') : '\u8bbe\u5907\u79bb\u7ebf';
  title.textContent = lamp.name || lamp.meta.label || '\u8bbe\u5907';
  meta.textContent = (lamp.meta.label || '\u8bbe\u5907') + ' · ' + stateText + ' · ' + (lamp.deviceName || lamp.deviceIp || '');
  button.disabled = walkInteractPending || !connected;
  button.textContent = walkInteractPending ? '\u6267\u884c\u4e2d...' : (lamp.state ? 'E \u5173\u95ed' : 'E \u5f00\u542f');
}

function updateWalkInteractionState() {
  if (!walkMode || !lamps.length) {
    setWalkInteractTarget(null);
    updateWalkInteractUI();
    return;
  }
  walkInteractRaycaster.setFromCamera(walkInteractCenter, camera);
  const walkHitTargets = [];
  lamps.forEach(function(lamp) {
    if (lamp.iconSprite) walkHitTargets.push(lamp.iconSprite);
    if (lamp.hit) walkHitTargets.push(lamp.hit);
  });
  const hits = walkInteractRaycaster.intersectObjects(walkHitTargets);
  setWalkInteractTarget(hits.length ? hits[0].object.userData.lightIdx : null);
  updateWalkInteractUI();
}

async function triggerWalkInteraction() {
  if (!walkMode || walkInteractPending) return;
  if (!walkPointerLocked) {
    requestWalkPointerLock();
    return;
  }
  if (walkInteractTargetIdx == null) return;
  const lamp = getWalkInteractLamp();
  if (!lamp || typeof toggleLight !== 'function') return;
  const deviceInfo = typeof deviceStatus !== 'undefined' && lamp.deviceIp ? deviceStatus[lamp.deviceIp] : null;
  if (!deviceInfo || !deviceInfo.connected) {
    updateWalkInteractUI();
    return;
  }
  walkInteractPending = true;
  updateWalkInteractUI();
  try {
    await toggleLight(walkInteractTargetIdx);
  } finally {
    walkInteractPending = false;
    updateWalkInteractionState();
  }
}
window.triggerWalkInteraction = triggerWalkInteraction;

function applyWalkModeStartPose() {
  const next = clampWalkPosition(camera.position.x, camera.position.z);
  const eyeY = getWalkEyeHeight();

  // Only inherit the previous horizontal heading. Keeping the old orbit
  // pitch makes the first-person camera look up at the roof or feel reversed.
  walkLookDirection.subVectors(controls.target, camera.position);
  walkLookDirection.y = 0;
  if (walkLookDirection.lengthSq() < 0.001) {
    walkLookDirection.set(-next.x, 0, -next.z);
  }
  if (walkLookDirection.lengthSq() < 0.001) {
    walkLookDirection.set(0, 0, -1);
  }
  walkLookDirection.normalize();
  camera.position.set(next.x, eyeY, next.z);
  walkLookTarget.copy(camera.position).addScaledVector(walkLookDirection, Math.max(BUILDING.width, BUILDING.depth));
  walkLookTarget.y = eyeY - 0.9;
  camera.lookAt(walkLookTarget);
  walkLookEuler.setFromQuaternion(camera.quaternion);
  camera.quaternion.setFromEuler(walkLookEuler);
  updateWalkLookTarget();
}

function updateWalkMovement(deltaSeconds) {
  if (!walkMode) return;
  const moveX = (walkKeys.right ? 1 : 0) - (walkKeys.left ? 1 : 0);
  const moveZ = (walkKeys.forward ? 1 : 0) - (walkKeys.back ? 1 : 0);
  if (!moveX && !moveZ) {
    camera.position.y = getWalkEyeHeight();
    updateWalkLookTarget();
    return;
  }

  camera.getWorldDirection(walkMoveForward);
  walkMoveForward.y = 0;
  if (walkMoveForward.lengthSq() < 0.0001) {
    walkMoveForward.set(0, 0, -1);
  } else {
    walkMoveForward.normalize();
  }
  walkMoveRight.crossVectors(walkMoveForward, KEYBOARD_PAN_UP).normalize();
  walkMoveOffset.copy(walkMoveRight).multiplyScalar(moveX);
  walkMoveOffset.addScaledVector(walkMoveForward, moveZ);
  if (walkMoveOffset.lengthSq() > 1) walkMoveOffset.normalize();

  const speed = (walkKeys.sprint ? 58 : 34) * deltaSeconds;
  walkMoveOffset.multiplyScalar(speed);
  const next = clampWalkPosition(camera.position.x + walkMoveOffset.x, camera.position.z + walkMoveOffset.z);
  camera.position.set(next.x, getWalkEyeHeight(), next.z);
  updateWalkLookTarget();
}

function setWalkMode(forceValue, options) {
  const next = typeof forceValue === 'boolean' ? forceValue : !walkMode;
  if (next === walkMode) return;
  const opts = options || {};

  if (next) {
    if (lightPlacementIndex != null) cancelLightPlacement(false);
    if (layoutMode) toggleLayoutMode(false);
    if (typeof editMode !== 'undefined' && editMode) toggleEditMode(false);
    walkMode = true;
    walkPointerLocked = false;
    controls.enabled = false;
    resetWalkKeys();
    applyWalkModeStartPose();
    updateWalkModeUI();
    updateSceneHint();
    updateCanvasCursor();
    updateWalkInteractionState();
    requestWalkPointerLock();
    return;
  }

  walkMode = false;
  walkPointerLocked = false;
  resetWalkKeys();
  if (!opts.skipPointerUnlock && document.pointerLockElement === canvas && typeof document.exitPointerLock === 'function') {
    document.exitPointerLock();
  }
  camera.position.y = getWalkEyeHeight();
  syncOrbitTargetFromCamera();
  controls.enabled = !(layoutMode && layoutTool !== 'select');
  updateWalkModeUI();
  updateSceneHint();
  updateCanvasCursor();
  updateWalkInteractionState();
}

function toggleWalkMode(forceValue) {
  setWalkMode(forceValue);
}
window.toggleWalkMode = toggleWalkMode;

function resize() {
  const w = sceneWrap.clientWidth;
  const h = sceneWrap.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
function scheduleSceneResize() {
  requestAnimationFrame(resize);
  setTimeout(resize, 280);
}
window.addEventListener('resize', resize);
resize();

document.addEventListener('pointerlockchange', function() {
  const locked = document.pointerLockElement === canvas;
  if (walkMode && !locked) {
    setWalkMode(false, { skipPointerUnlock: true });
    return;
  }
  walkPointerLocked = locked;
  updateSceneHint();
  updateCanvasCursor();
});

document.addEventListener('mousemove', function(e) {
  if (!walkMode || !walkPointerLocked) return;
  walkLookEuler.setFromQuaternion(camera.quaternion);
  walkLookEuler.y -= e.movementX * WALK_POINTER_SENSITIVITY;
  walkLookEuler.x -= e.movementY * WALK_POINTER_SENSITIVITY;
  walkLookEuler.x = clamp(walkLookEuler.x, -WALK_MAX_PITCH, WALK_MAX_PITCH);
  camera.quaternion.setFromEuler(walkLookEuler);
  updateWalkLookTarget();
});

// 光照 (整体压暗环境光, 让灯具自身的打光成为主光源, 突出灯光对地面/环境的影响)
scene.add(new THREE.AmbientLight(0xeef0e6, 0.16));
const hemi = new THREE.HemisphereLight(0x7c8694, 0x2f3a2c, 0.26);
hemi.position.set(0, 60 * SCALE, 0);
scene.add(hemi);
const moon = new THREE.DirectionalLight(0xffe7c2, 0.34);
moon.position.set(20 * SCALE, 40 * SCALE, 25 * SCALE);
moon.castShadow = true;
moon.shadow.mapSize.set(4096, 4096);
moon.shadow.camera.left = -30 * SCALE;
moon.shadow.camera.right = 30 * SCALE;
moon.shadow.camera.top = 30 * SCALE;
moon.shadow.camera.bottom = -30 * SCALE;
moon.shadow.camera.far = 500;
moon.shadow.bias = -0.00015;
moon.shadow.normalBias = 0.12;
scene.add(moon);
const fill = new THREE.DirectionalLight(0x4a5566, 0.09);
fill.position.set(-20 * SCALE, 20 * SCALE, -10 * SCALE);
scene.add(fill);

// 地面
const factoryGroup = new THREE.Group();
scene.add(factoryGroup);

// 网格:格数保持 30/格,每格随 SCALE 变大

// 车间围护结构和高位轮廓

// 立柱与门式桁架

// ========== 动态电器标记 ==========
const DEFAULT_ITEM_TYPE = 'lamp';
const ITEM_TYPES = {
  lamp: { label: '灯', icon: '⏻', short: '灯', accent: '#0F52BA', accentHex: 0x0f52ba, mode: 'lamp' },
  printer: { label: '打印机', icon: '🖨', short: '打', accent: '#5ac8fa', accentHex: 0x5ac8fa, mode: 'icon' },
  smoke_machine: { label: '产烟机', icon: '💨', short: '烟', accent: '#8ef0ff', accentHex: 0x8ef0ff, mode: 'icon' },
  fan: { label: '风扇', icon: '🌀', short: '扇', accent: '#64d2ff', accentHex: 0x64d2ff, mode: 'icon' },
  socket: { label: '插座', icon: '🔌', short: '座', accent: '#ff9f0a', accentHex: 0xff9f0a, mode: 'icon' },
  camera: { label: '摄像头', icon: '📷', short: '摄', accent: '#bf5af2', accentHex: 0xbf5af2, mode: 'icon' },
  alarm: { label: '报警器', icon: '🔔', short: '警', accent: '#ff453a', accentHex: 0xff453a, mode: 'icon' }
};
const ITEM_TYPE_KEYS = Object.keys(ITEM_TYPES);
Object.assign(ITEM_TYPES.lamp, { mount: 'ceiling' });
Object.assign(ITEM_TYPES.smoke_machine, { mount: 'floor' });
Object.assign(ITEM_TYPES.fan, { mount: 'ceiling' });
Object.assign(ITEM_TYPES.socket, { mount: 'wall_mid' });
Object.assign(ITEM_TYPES.camera, { mount: 'wall_high' });
Object.assign(ITEM_TYPES.alarm, { mount: 'wall_high' });
const ITEM_MOUNT_TYPES = new Set(['free', 'floor', 'ceiling', 'wall_mid', 'wall_high']);

function getItemMeta(type) {
  return ITEM_TYPES[type] || ITEM_TYPES[DEFAULT_ITEM_TYPE];
}

function normalizeLight(lt) {
  const next = Object.assign({}, lt);
  next.type = ITEM_TYPES[next.type] ? next.type : DEFAULT_ITEM_TYPE;
  next.scale = clamp(Number(next.scale) || 1, 0.4, 3);
  next.group = typeof next.group === 'string' ? next.group.trim() : '';
  next.mount = ITEM_MOUNT_TYPES.has(next.mount) ? next.mount : (getItemMeta(next.type).mount || 'free');
  return next;
}

function getSuggestedLightName(type) {
  return '新' + getItemMeta(type).label;
}

function isAutoName(name) {
  if (!name) return true;
  return ITEM_TYPE_KEYS.some(key => name === getSuggestedLightName(key));
}

let lamps = [];
let labelsPinned = false;
let focusedLampIdx = null;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let lightPlacementIndex = null;
let lightPlacementMarker = null;

function setMeshShadow(mesh, receiveShadow = true) {
  mesh.castShadow = true;
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

function addMesh(parent, geometry, material, position, rotation, receiveShadow) {
  const mesh = new THREE.Mesh(geometry, material);
  if (position) mesh.position.set(position[0], position[1], position[2]);
  if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  setMeshShadow(mesh, receiveShadow !== false);
  parent.add(mesh);
  trackRoofFadeMesh(mesh);
  return mesh;
}

function createGlowSprite(colorHex, sizeX, sizeY, opacity) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    color: colorHex,
    transparent: true,
    opacity: opacity == null ? 0 : opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  }));
  sprite.scale.set(sizeX, sizeY, 1);
  return sprite;
}

function createFloorOverlayMaterial(options, orderKey) {
  const material = new THREE.MeshBasicMaterial(Object.assign({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2
  }, options || {}));
  material.userData.renderOrder = FLOOR_RENDER_ORDER[orderKey] || 30;
  return material;
}

function applyFloorOverlayProfile(mesh, layerY, orderKey) {
  if (!mesh) return mesh;
  mesh.position.y = layerY;
  mesh.renderOrder = FLOOR_RENDER_ORDER[orderKey] || 30;
  return mesh;
}

function createCanvasSprite(width, height, scaleX, scaleY, y) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    transparent: true
  }));
  sprite.scale.set(scaleX, scaleY, 1);
  sprite.position.y = y;
  return { canvas, tex, sprite };
}

function disposeObjectGraph(root) {
  if (!root) return;
  root.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
  if (root.parent) root.parent.remove(root);
}

function getSpanPositions(halfSpan, approxStep) {
  const span = Math.max(approxStep, halfSpan * 2);
  const segments = Math.max(1, Math.round(span / approxStep));
  const step = span / segments;
  const positions = [];
  for (let i = 0; i <= segments; i++) positions.push(-halfSpan + step * i);
  return positions;
}

function addFactoryEdges(parent, mesh, color) {
  const line = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: color == null ? 0xa0a4a8 : color })
  );
  line.position.copy(mesh.position);
  line.rotation.copy(mesh.rotation);
  parent.add(line);
  return line;
}

// ============ 屋顶俯视自动淡化 ============
let roofFadeMaterials = [];
let roofFadeMeshes = [];

function isFadeableMaterial(material) {
  if (!material) return false;
  if (Array.isArray(material)) return material.some(isFadeableMaterial);
  return !!(material.userData && material.userData.roofFadeTracked);
}

function trackRoofFadeMesh(mesh) {
  if (!mesh || mesh.userData.roofFadeMeshTracked || !isFadeableMaterial(mesh.material)) return mesh;
  mesh.userData.roofFadeMeshTracked = true;
  mesh.renderOrder = 20;
  roofFadeMeshes.push(mesh);
  return mesh;
}

function markFadeable(material) {
  if (!material) return material;
  if (Array.isArray(material)) {
    material.forEach(markFadeable);
    return material;
  }
  material.transparent = true;
  material.depthWrite = false;
  material.userData = material.userData || {};
  if (material.userData.baseOpacity == null) {
    material.userData.baseOpacity = material.opacity != null ? material.opacity : 1;
  }
  if (!material.userData.roofFadeTracked) {
    material.userData.roofFadeTracked = true;
    roofFadeMaterials.push(material);
  }
  return material;
}

function updateRoofFade() {
  if (typeof controls === 'undefined' || !roofFadeMaterials.length) return;
  let factor;
  if (typeof walkMode !== 'undefined' && walkMode) {
    factor = 1;
  } else {
    const polar = controls.getPolarAngle();
    // polar: 0 = 正上方俯视, π/2 = 水平视角
    // 0.5 以下接近完全透明, 1.1 以上完全实心, 中间线性
    const raw = (polar - 0.5) / 0.6;
    factor = Math.max(0.04, Math.min(1, raw));
  }
  const opaque = factor >= 0.99;
  const hidden = factor <= 0.12;
  roofFadeMeshes.forEach(mesh => {
    mesh.visible = !hidden;
  });
  roofFadeMaterials.forEach(m => {
    const base = m.userData && m.userData.baseOpacity != null ? m.userData.baseOpacity : 1;
    m.opacity = hidden ? 0 : base * factor;
    m.depthWrite = !hidden && opaque && base >= 0.99;
  });
}
window.updateRoofFade = updateRoofFade;

// ============ 程序化纹理工厂 ============
function makeMetalPanelTexture(opts) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, opts.top);
  grad.addColorStop(0.5, opts.base);
  grad.addColorStop(1, opts.bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 12) {
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(0, y, 256, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, y + 6, 256, 1);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  for (let x = 0; x < 256; x += 64) {
    ctx.fillRect(x, 0, 1, 256);
  }
  for (let i = 0; i < 600; i++) {
    ctx.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.04) + ')';
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(opts.repeatX || 1, opts.repeatY || 1);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeConcreteTexture(repeat) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#cfd2d6';
  ctx.fillRect(0, 0, 512, 512);
  const img = ctx.getImageData(0, 0, 512, 512);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(0,0,0,0.16)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 512; i += 128) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
  }
  for (let i = 0; i < 18; i++) {
    ctx.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.05 + 0.02) + ')';
    ctx.beginPath();
    ctx.arc(Math.random() * 512, Math.random() * 512, Math.random() * 30 + 10, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeFloorGridTexture(repeatX, repeatY) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 512, 512);

  for (let i = 0; i <= 512; i += 64) {
    const isMajor = i % 256 === 0;
    ctx.strokeStyle = isMajor ? 'rgba(102,112,124,0.42)' : 'rgba(126,136,148,0.2)';
    ctx.lineWidth = isMajor ? 2 : 1;

    ctx.beginPath();
    ctx.moveTo(i + 0.5, 0);
    ctx.lineTo(i + 0.5, 512);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, i + 0.5);
    ctx.lineTo(512, i + 0.5);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  if (renderer && renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === 'function') {
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy() || 1);
  }
  return tex;
}

function makeAsphaltTexture(repeat) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3b4046';
  ctx.fillRect(0, 0, 512, 512);
  const img = ctx.getImageData(0, 0, 512, 512);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 40;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(20,20,22,0.55)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    let x = Math.random() * 512, y = Math.random() * 512;
    ctx.moveTo(x, y);
    for (let k = 0; k < 8; k++) {
      x += (Math.random() - 0.5) * 80;
      y += (Math.random() - 0.5) * 80;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeShutterTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 128, 0);
  grad.addColorStop(0, '#4a5158');
  grad.addColorStop(0.5, '#7c828a');
  grad.addColorStop(1, '#4a5158');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 256);
  for (let y = 0; y < 256; y += 8) {
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.fillRect(0, y, 128, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(0, y + 1, 128, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 4);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 木地板 (智能家居风格的暖色橡木)
function makeWoodPlankTexture(repeatX, repeatY) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const ctx = c.getContext('2d');
  // 底色
  ctx.fillStyle = '#6e4d33';
  ctx.fillRect(0, 0, 512, 512);
  // 整体噪点加底色变化
  const img = ctx.getImageData(0, 0, 512, 512);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 22;
    d[i] = Math.max(0, Math.min(255, d[i] + n + 4));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n - 4));
  }
  ctx.putImageData(img, 0, 0);
  // 木板宽度: 4 列, 每列 128
  const plankW = 128;
  for (let col = 0; col < 4; col++) {
    const baseHue = 22 + (Math.random() - 0.5) * 6;
    const baseLight = 26 + (Math.random() - 0.5) * 6;
    ctx.fillStyle = 'hsl(' + baseHue + ', 38%, ' + baseLight + '%)';
    ctx.globalAlpha = 0.32;
    ctx.fillRect(col * plankW, 0, plankW, 512);
    ctx.globalAlpha = 1;
    // 板间缝
    ctx.fillStyle = 'rgba(20,12,6,0.85)';
    ctx.fillRect(col * plankW + plankW - 2, 0, 2, 512);
    // 错缝 (每列在不同高度断开)
    const breakY = (col % 2 === 0 ? 192 : 320);
    ctx.fillStyle = 'rgba(20,12,6,0.85)';
    ctx.fillRect(col * plankW, breakY, plankW, 2);
    // 木纹
    for (let g = 0; g < 6; g++) {
      ctx.strokeStyle = 'rgba(0,0,0,' + (0.04 + Math.random() * 0.06) + ')';
      ctx.lineWidth = 0.6 + Math.random() * 0.6;
      ctx.beginPath();
      const yStart = Math.random() * 512;
      ctx.moveTo(col * plankW, yStart);
      let y = yStart;
      for (let x = 0; x < plankW; x += 8) {
        y += (Math.random() - 0.5) * 1.2;
        ctx.lineTo(col * plankW + x, y);
      }
      ctx.stroke();
    }
    // 节疤
    if (Math.random() < 0.7) {
      const nx = col * plankW + 18 + Math.random() * (plankW - 36);
      const ny = Math.random() * 512;
      const r = 4 + Math.random() * 6;
      ctx.fillStyle = 'rgba(28,16,6,0.55)';
      ctx.beginPath();
      ctx.arc(nx, ny, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(60,32,12,0.42)';
      ctx.beginPath();
      ctx.arc(nx, ny, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 上下边界
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(0, 0, 512, 1.5);
  ctx.fillRect(0, 510.5, 512, 1.5);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 浅绿高光环氧自流平地坪, 整体近乎无缝
function makeEpoxyFloorTexture(repeatX, repeatY) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#E7FFC2';
  ctx.fillRect(0, 0, 512, 512);
  // 细腻噪点, 制造涂层的微观不均。
  const img = ctx.getImageData(0, 0, 512, 512);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 8;
    d[i] = Math.max(0, Math.min(255, d[i] + n - 2));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n - 5));
  }
  ctx.putImageData(img, 0, 0);
  // 柔和的大块明暗斑驳, 让平整地坪不至于死板。
  for (let k = 0; k < 18; k++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const r = 60 + Math.random() * 90;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const lighten = Math.random() < 0.5;
    g.addColorStop(0, lighten ? 'rgba(255,255,240,0.07)' : 'rgba(126,150,96,0.05)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 极淡的分格缝 (现场是整体浇筑, 仅留一点点分块痕迹)
  ctx.strokeStyle = 'rgba(126,150,96,0.05)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(1, 1, 510, 510);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 室内涂料墙 (微噪点的暖白)
function makeInteriorWallTexture(repeatX, repeatY) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#C8B89B';
  ctx.fillRect(0, 0, 256, 256);
  const img = ctx.getImageData(0, 0, 256, 256);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  // 极淡的水平条纹 (模拟刷涂痕迹)
  for (let y = 0; y < 256; y += 4) {
    ctx.fillStyle = 'rgba(0,0,0,' + (Math.random() * 0.025) + ')';
    ctx.fillRect(0, y, 256, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRoofTexture(repeatX, repeatY) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#5a6f86');
  grad.addColorStop(0.5, '#4d6377');
  grad.addColorStop(1, '#3e5266');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  for (let x = 0; x < 256; x += 32) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x, 0, 2, 256);
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.fillRect(x + 2, 0, 1, 256);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  for (let y = 0; y < 256; y += 64) {
    ctx.fillRect(0, y, 256, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ H 型钢柱辅助 ============
function addHColumn(parent, cx, cz, h, mat) {
  const flangeW = 0.95;
  const flangeT = 0.18;
  const webT = 0.18;
  const webD = 0.7;
  addMesh(parent, new THREE.BoxGeometry(flangeW, h, flangeT), mat,
    [cx, h / 2, cz + (webD - flangeT) / 2]);
  addMesh(parent, new THREE.BoxGeometry(flangeW, h, flangeT), mat,
    [cx, h / 2, cz - (webD - flangeT) / 2]);
  addMesh(parent, new THREE.BoxGeometry(webT, h, webD - flangeT * 2 + 0.04), mat,
    [cx, h / 2, cz]);
  addMesh(parent, new THREE.BoxGeometry(flangeW + 0.18, 0.18, webD + 0.18), mat,
    [cx, h - 0.09, cz]);
  addMesh(parent, new THREE.BoxGeometry(flangeW + 0.4, 0.22, webD + 0.4), mat,
    [cx, 0.11, cz]);
}

function rebuildFactoryScene() {
  roofFadeMaterials = [];
  roofFadeMeshes = [];
  while (factoryGroup.children.length) disposeObjectGraph(factoryGroup.children[0]);

  // 智能家居风格的内饰材质
  const floorTex = makeEpoxyFloorTexture(
    Math.max(6, BUILDING.configWidth / 10),
    Math.max(4, BUILDING.configDepth / 10)
  );
  const wallTex = makeInteriorWallTexture(
    Math.max(6, BUILDING.configWidth / 8), 1
  );
  const skirtingTex = makeInteriorWallTexture(
    Math.max(6, BUILDING.configWidth / 6), 1
  );

  const groundMat = new THREE.MeshStandardMaterial({
    map: floorTex, color: 0xffffff, roughness: 0.36, metalness: 0.1
  });
  // 室外平台 (一圈柔和暗色, 避免完全空旷)
  const outdoorMat = new THREE.MeshStandardMaterial({
    color: 0x2c2e33, roughness: 0.92, metalness: 0.0
  });
  // 室内墙: 暖白涂料 (BoxGeometry 已含内/外两面, 不开 DoubleSide 避免半透明排序闪烁)
  const wallMat = new THREE.MeshStandardMaterial({
    map: wallTex, color: 0xffffff, roughness: 0.86, metalness: 0.02
  });
  // 墙顶收口, 让车间呈现参考图那种厚实的剖面边缘。
  const wallCapMat = new THREE.MeshStandardMaterial({
    color: 0xaa9a80, roughness: 0.66, metalness: 0.06
  });
  // 踢脚线/门套 (深木色)
  const skirtingMat = new THREE.MeshStandardMaterial({
    color: 0x3a2a1c, roughness: 0.55, metalness: 0.08
  });
  // 简洁门 (镶嵌在前墙)
  const doorMat = new THREE.MeshStandardMaterial({
    color: 0x4a3624, roughness: 0.55, metalness: 0.1
  });

  // ---- 室外大地坪 (低调暗色, 仅留少许景深) ----
  const outerSize = Math.max(BUILDING.width, BUILDING.depth) * 3;
  const outdoor = new THREE.Mesh(new THREE.PlaneGeometry(outerSize, outerSize), outdoorMat);
  outdoor.userData.techTag = 'outdoor';
  outdoor.rotation.x = -Math.PI / 2;
  outdoor.position.y = FLOOR_LAYER.outdoor;
  outdoor.receiveShadow = true;
  factoryGroup.add(outdoor);

  // ---- 室内木地板 ----
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(BUILDING.width, BUILDING.depth), groundMat);
  ground.userData.techTag = 'ground';
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = FLOOR_LAYER.ground;
  ground.receiveShadow = true;
  factoryGroup.add(ground);

  const shell = new THREE.Group();
  factoryGroup.add(shell);

  // 内饰墙: 按车间尺寸自适应加厚, 从俯视角看不会再像薄片。
  const wallT = clamp(Math.min(BUILDING.width, BUILDING.depth) * 0.012, 3.8, 6.2);
  const wallH = BUILDING.wallH;
  const capH = clamp(wallT * 0.28, 1.1, 1.8);  // 墙顶压顶高
  const capExt = clamp(wallT * 0.16, 0.45, 0.85);  // 压顶比墙体外探出的厚度

  // ---- 后 / 左 / 右 三面墙 ----
  addMesh(shell, new THREE.BoxGeometry(BUILDING.width + wallT * 2, wallH, wallT), wallMat,
    [0, wallH / 2, -BUILDING.halfD - wallT / 2]).userData.techTag = 'shellWall';
  addMesh(shell, new THREE.BoxGeometry(wallT, wallH, BUILDING.depth), wallMat,
    [-BUILDING.halfW - wallT / 2, wallH / 2, 0]).userData.techTag = 'shellWall';
  addMesh(shell, new THREE.BoxGeometry(wallT, wallH, BUILDING.depth), wallMat,
    [BUILDING.halfW + wallT / 2, wallH / 2, 0]).userData.techTag = 'shellWall';

  // ---- 正面墙 + 简洁双开门 ----
  const doorW = Math.min(BUILDING.width * 0.18, 12 * SCALE);
  const doorH = Math.min(wallH * 0.6, wallH - 4);
  const sideW = (BUILDING.width - doorW) / 2;
  addMesh(shell, new THREE.BoxGeometry(sideW + wallT, wallH, wallT), wallMat,
    [-(doorW / 2 + sideW / 2 + wallT / 2), wallH / 2, BUILDING.halfD + wallT / 2]).userData.techTag = 'shellWall';
  addMesh(shell, new THREE.BoxGeometry(sideW + wallT, wallH, wallT), wallMat,
    [(doorW / 2 + sideW / 2 + wallT / 2), wallH / 2, BUILDING.halfD + wallT / 2]).userData.techTag = 'shellWall';
  addMesh(shell, new THREE.BoxGeometry(doorW, wallH - doorH, wallT), wallMat,
    [0, doorH + (wallH - doorH) / 2, BUILDING.halfD + wallT / 2]).userData.techTag = 'shellWall';
  // 双开木门 (放在墙厚内, 避免 z-fighting)
  addMesh(shell, new THREE.BoxGeometry(doorW / 2 - 0.06, doorH, 0.16), doorMat,
    [-(doorW / 4 + 0.04), doorH / 2, BUILDING.halfD + wallT - 0.12]);
  addMesh(shell, new THREE.BoxGeometry(doorW / 2 - 0.06, doorH, 0.16), doorMat,
    [(doorW / 4 + 0.04), doorH / 2, BUILDING.halfD + wallT - 0.12]);

  // ---- 墙顶压顶 (一圈深色收边, 让墙顶不再是裸切口) ----
  const capW = BUILDING.width + wallT * 2 + capExt * 2;
  const capD = BUILDING.depth + wallT * 2 + capExt * 2;
  // 后
  addMesh(shell, new THREE.BoxGeometry(capW, capH, wallT + capExt * 2), wallCapMat,
    [0, wallH + capH / 2, -BUILDING.halfD - wallT / 2]);
  // 前 (含门洞上方)
  addMesh(shell, new THREE.BoxGeometry(capW, capH, wallT + capExt * 2), wallCapMat,
    [0, wallH + capH / 2, BUILDING.halfD + wallT / 2]);
  // 左
  addMesh(shell, new THREE.BoxGeometry(wallT + capExt * 2, capH, capD - (wallT + capExt * 2) * 2), wallCapMat,
    [-BUILDING.halfW - wallT / 2, wallH + capH / 2, 0]);
  // 右
  addMesh(shell, new THREE.BoxGeometry(wallT + capExt * 2, capH, capD - (wallT + capExt * 2) * 2), wallCapMat,
    [BUILDING.halfW + wallT / 2, wallH + capH / 2, 0]);

  // ---- 踢脚线 (墙脚一圈) ----
  const skH = clamp(wallT * 0.24, 0.85, 1.35);
  const skT = clamp(wallT * 0.055, 0.16, 0.34);
  addMesh(shell, new THREE.BoxGeometry(BUILDING.width, skH, skT), skirtingMat,
    [0, skH / 2, -BUILDING.halfD + skT / 2 + 0.001]);
  addMesh(shell, new THREE.BoxGeometry(BUILDING.width, skH, skT), skirtingMat,
    [0, skH / 2, BUILDING.halfD - skT / 2 - 0.001]);
  addMesh(shell, new THREE.BoxGeometry(skT, skH, BUILDING.depth - skT * 2), skirtingMat,
    [-BUILDING.halfW + skT / 2 + 0.001, skH / 2, 0]);
  addMesh(shell, new THREE.BoxGeometry(skT, skH, BUILDING.depth - skT * 2), skirtingMat,
    [BUILDING.halfW - skT / 2 - 0.001, skH / 2, 0]);

  const shadowExtent = Math.max(BUILDING.width, BUILDING.depth) * 0.7;
  moon.shadow.camera.left = -shadowExtent;
  moon.shadow.camera.right = shadowExtent;
  moon.shadow.camera.top = shadowExtent;
  moon.shadow.camera.bottom = -shadowExtent;
  moon.shadow.camera.far = Math.max(500, BUILDING.wallH * 16);
  moon.shadow.camera.updateProjectionMatrix();

  controls.target.set(0, Math.max(14, BUILDING.wallH * 0.56), 0);
  controls.minDistance = Math.max(15 * SCALE, Math.min(BUILDING.width, BUILDING.depth) * 0.3);
  controls.maxDistance = Math.max(55 * SCALE, Math.max(BUILDING.width, BUILDING.depth) * 1.08);
  updateRoofFade();
}

rebuildFactoryScene();

const DEFAULT_LAYOUT = Object.freeze({
  building: Object.assign({}, DEFAULT_BUILDING),
  walls: [],
  zones: [],
  pillars: [],
  doors: [],
  paths: [],
  workstations: [],
  racks: [],
  safetyStations: []
});
const LAYOUT_ZONE_COLOR = '#5ac8fa';

let layoutObjects = [];
let layoutHitObjects = [];
let layoutPreview = null;
let layoutMode = false;
let layoutTool = 'select';
let layoutDirty = false;
let selectedLayout = null;
let layoutDrawState = null;

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function formatNum(num) {
  return (Math.round(num * 10) / 10).toFixed(1);
}

function makeLayoutId(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 10);
}

function clampFloorPoint(point) {
  const margin = 1.2;
  return {
    x: clamp(point.x, -BUILDING.halfW + margin, BUILDING.halfW - margin),
    z: clamp(point.z, -BUILDING.halfD + margin, BUILDING.halfD - margin)
  };
}

function getGroundPoint() {
  if (!raycaster.ray.intersectPlane(dragPlane, dragPoint)) return null;
  return clampFloorPoint(dragPoint);
}

function getLayoutWallThicknessBounds() {
  const base = Math.min(BUILDING.width, BUILDING.depth);
  return {
    min: clamp(base * 0.007, 2.4, 3.4),
    value: clamp(base * 0.011, 4.0, 5.4),
    max: clamp(base * 0.02, 7.0, 10.0)
  };
}

function drawTextSprite(canvas, tex, opts) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(8, 8, canvas.width - 16, canvas.height - 16, 12);
  ctx.fillStyle = opts.bg;
  ctx.strokeStyle = opts.stroke;
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = opts.color;
  ctx.font = opts.font || 'bold 22px sans-serif';
  ctx.fillText(opts.text, canvas.width / 2, canvas.height / 2);
  tex.needsUpdate = true;
}

function normalizeWall(wall, idx) {
  if (!wall) return null;
  const x1 = Number(wall.x1);
  const z1 = Number(wall.z1);
  const x2 = Number(wall.x2);
  const z2 = Number(wall.z2);
  if (![x1, z1, x2, z2].every(Number.isFinite)) return null;
  const p1 = clampFloorPoint({ x: x1, z: z1 });
  const p2 = clampFloorPoint({ x: x2, z: z2 });
  const maxWallHeight = Math.max(8, BUILDING.ridgeH - 4);
  const thicknessBounds = getLayoutWallThicknessBounds();
  return {
    id: wall.id || makeLayoutId('wall'),
    name: String(wall.name || ('墙体' + (idx + 1))),
    x1: p1.x, z1: p1.z, x2: p2.x, z2: p2.z,
    height: clamp(Number(wall.height) || Math.min(12, maxWallHeight), 4, maxWallHeight),
    thickness: clamp(Number(wall.thickness) || thicknessBounds.value, thicknessBounds.min, thicknessBounds.max)
  };
}

function normalizeZone(zone, idx) {
  if (!zone) return null;
  const x = Number(zone.x);
  const z = Number(zone.z);
  const width = Number(zone.width);
  const depth = Number(zone.depth);
  if (![x, z, width, depth].every(Number.isFinite)) return null;
  const margin = 1.2;
  const nextWidth = clamp(Math.abs(width) || 8, 2, Math.max(2, BUILDING.width - margin * 2));
  const nextDepth = clamp(Math.abs(depth) || 8, 2, Math.max(2, BUILDING.depth - margin * 2));
  const halfZoneW = nextWidth / 2;
  const halfZoneD = nextDepth / 2;
  return {
    id: zone.id || makeLayoutId('zone'),
    name: String(zone.name || ('区域' + (idx + 1))),
    x: clamp(x, -BUILDING.halfW + halfZoneW + margin, BUILDING.halfW - halfZoneW - margin),
    z: clamp(z, -BUILDING.halfD + halfZoneD + margin, BUILDING.halfD - halfZoneD - margin),
    width: nextWidth,
    depth: nextDepth,
    color: zone.color || LAYOUT_ZONE_COLOR
  };
}

function normalizeLayoutData(layout) {
  const src = layout || DEFAULT_LAYOUT;
  const building = applyBuildingConfig(src.building || DEFAULT_BUILDING);
  return {
    building,
    walls: (Array.isArray(src.walls) ? src.walls : []).map(normalizeWall).filter(Boolean),
    zones: (Array.isArray(src.zones) ? src.zones : []).map(normalizeZone).filter(Boolean)
  };
}

function ensureLayoutConfig() {
  config.layout = normalizeLayoutData(config.layout);
}

function clampLightPositionsToBuilding() {
  config.lights = (config.lights || []).map(function(light) {
    const next = normalizeLight(light);
    if (!Number.isFinite(next.x) || !Number.isFinite(next.z)) return next;
    const point = clampFloorPoint({ x: Number(next.x), z: Number(next.z) });
    next.x = Math.round(point.x * 100) / 100;
    next.z = Math.round(point.z * 100) / 100;
    return next;
  });
}

function ensureLightPlacementMarker() {
  if (lightPlacementMarker) return lightPlacementMarker;
  const group = new THREE.Group();

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.7, 1.08, 40),
    new THREE.MeshBasicMaterial({
      color: 0x30d158,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4
    })
  );
  ring.rotation.x = -Math.PI / 2;
  applyFloorOverlayProfile(ring, FLOOR_LAYER.marker, 'marker');
  group.add(ring);

  const core = new THREE.Mesh(
    new THREE.CircleGeometry(0.16, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4
    })
  );
  core.rotation.x = -Math.PI / 2;
  applyFloorOverlayProfile(core, FLOOR_LAYER.marker + 0.01, 'marker');
  group.add(core);

  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 1.4, 12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42 })
  );
  stem.position.y = 0.72;
  group.add(stem);

  group.visible = false;
  scene.add(group);
  lightPlacementMarker = { group, ring, core, stem };
  return lightPlacementMarker;
}

function updateLightPlacementMarker(point) {
  const marker = ensureLightPlacementMarker();
  const light = editingLights[lightPlacementIndex];
  const accent = light ? getItemMeta(light.type).accentHex : 0x30d158;
  marker.ring.material.color.setHex(accent);
  marker.group.position.set(point.x, 0, point.z);
  marker.group.visible = true;
}

function openLightsModalFromEditingState(scrollToIndex) {
  const modal = document.getElementById('lights-modal');
  if (!modal) return;
  renderLightsConfig();
  modal.classList.add('show');
  if (typeof scrollToIndex === 'number') {
    requestAnimationFrame(function() {
      const row = document.getElementById('light-config-row-' + scrollToIndex);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
}

function cancelLightPlacement(reopenModal) {
  lightPlacementIndex = null;
  if (lightPlacementMarker) lightPlacementMarker.group.visible = false;
  updateSceneHint();
  updateCanvasCursor();
  if (reopenModal) openLightsModalFromEditingState();
}

function startLightPlacement(index) {
  if (!editingLights[index]) return;
  if (layoutMode) toggleLayoutMode(false);
  lightPlacementIndex = index;
  document.getElementById('lights-modal').classList.remove('show');
  const current = editingLights[index];
  const point = Number.isFinite(current.x) && Number.isFinite(current.z)
    ? clampFloorPoint({ x: current.x, z: current.z })
    : { x: 0, z: 0 };
  updateLightPlacementMarker(point);
  updateSceneHint();
  updateCanvasCursor();
}

function finishLightPlacement(point) {
  if (lightPlacementIndex == null || !editingLights[lightPlacementIndex]) return;
  editingLights[lightPlacementIndex].x = Math.round(point.x * 100) / 100;
  editingLights[lightPlacementIndex].z = Math.round(point.z * 100) / 100;
  const placedIndex = lightPlacementIndex;
  lightPlacementIndex = null;
  if (lightPlacementMarker) lightPlacementMarker.group.visible = false;
  updateSceneHint();
  updateCanvasCursor();
  openLightsModalFromEditingState(placedIndex);
}

window.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && lightPlacementIndex != null) {
    cancelLightPlacement(true);
    return;
  }
  if (e.key === 'Escape' && walkMode) {
    toggleWalkMode(false);
    return;
  }
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  if (document.querySelector('.modal-bg.show')) return;
  if (walkMode && (e.code === 'KeyE' || e.key === 'Enter')) {
    e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    triggerWalkInteraction();
    return;
  }
  const walkKey = getWalkKeyName(e);
  if (walkMode && walkKey) {
    walkKeys[walkKey] = true;
    e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    return;
  }
  const panDirection = getKeyboardPanDirection(e);
  if (!panDirection) return;
  panSceneByKeyboard(panDirection.x, panDirection.z);
  e.preventDefault();
  if (typeof e.stopPropagation === 'function') {
    e.stopPropagation();
  }
});

window.addEventListener('keyup', function(e) {
  const walkKey = getWalkKeyName(e);
  if (!walkKey) return;
  walkKeys[walkKey] = false;
});

window.addEventListener('blur', function() {
  resetWalkKeys();
});

function applyLayoutBuildingChange(partial) {
  ensureLayoutConfig();
  config.layout = normalizeLayoutData({
    building: Object.assign({}, config.layout.building, partial || {}),
    walls: config.layout.walls,
    zones: config.layout.zones
  });
  clampLightPositionsToBuilding();
  rebuildFactoryScene();
  rebuildLayoutScene();
  rebuildLamps();
  applyStatus();
  setLayoutDirty(true, false);
  updateLayoutUI();
}

function getLayoutCollection(kind) {
  ensureLayoutConfig();
  return kind === 'wall' ? config.layout.walls : config.layout.zones;
}

function findLayoutItem(kind, id) {
  return getLayoutCollection(kind).find(item => item.id === id) || null;
}

function getNextLayoutName(kind) {
  const base = kind === 'wall' ? '墙体' : '区域';
  const used = new Set(getLayoutCollection(kind).map(item => item.name));
  let i = 1;
  while (used.has(base + i)) i++;
  return base + i;
}

function isLayoutSelected(kind, id) {
  return !!selectedLayout && selectedLayout.kind === kind && selectedLayout.id === id;
}

function disposeSceneNode(root, textures) {
  if (!root) return;
  disposeObjectGraph(root);
  (textures || []).forEach(tex => tex && tex.dispose());
}

function clearLayoutPreview() {
  if (!layoutPreview) return;
  disposeSceneNode(layoutPreview.group, layoutPreview.textures);
  layoutPreview = null;
}

function clearLayoutScene() {
  layoutObjects.forEach(item => disposeSceneNode(item.group, item.textures));
  layoutObjects = [];
  layoutHitObjects = [];
}

function selectLayout(kind, id) {
  if (!kind || !id) selectedLayout = null;
  else selectedLayout = { kind, id };
  rebuildLayoutScene();
  updateLayoutUI();
}

function setLayoutDirty(value, shouldRefresh) {
  layoutDirty = !!value;
  if (shouldRefresh !== false) updateLayoutUI();
}

function getWallLength(wall) {
  return Math.hypot(wall.x2 - wall.x1, wall.z2 - wall.z1);
}

function createWallObject(wall, selected) {
  const dx = wall.x2 - wall.x1;
  const dz = wall.z2 - wall.z1;
  const len = Math.max(0.1, Math.hypot(dx, dz));
  const angle = Math.atan2(dx, dz);
  const cx = (wall.x1 + wall.x2) / 2;
  const cz = (wall.z1 + wall.z2) / 2;
  const group = new THREE.Group();
  group.position.set(cx, 0, cz);
  group.rotation.y = angle;

  const wallMat = new THREE.MeshStandardMaterial({
    color: selected ? 0xffc47a : 0xc8b89b,
    roughness: 0.74, metalness: 0.04,
    emissive: selected ? 0x55310a : 0x000000,
    emissiveIntensity: selected ? 0.18 : 0
  });
  const capMat = new THREE.MeshStandardMaterial({
    color: selected ? 0xe6a653 : 0xaa9a80,
    roughness: 0.52, metalness: 0.18,
    emissive: selected ? 0x55310a : 0x000000,
    emissiveIntensity: selected ? 0.16 : 0
  });
  addMesh(group, new THREE.BoxGeometry(wall.thickness, wall.height, len), wallMat, [0, wall.height / 2, 0]);
  addMesh(group, new THREE.BoxGeometry(wall.thickness + 0.42, 0.55, len + 0.2), capMat, [0, wall.height + 0.275, 0]);
  addMesh(group, new THREE.BoxGeometry(wall.thickness + 0.5, wall.height + 0.35, 0.34), capMat, [0, wall.height / 2, len / 2]);
  addMesh(group, new THREE.BoxGeometry(wall.thickness + 0.5, wall.height + 0.35, 0.34), capMat, [0, wall.height / 2, -len / 2]);
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(Math.max(wall.thickness + 0.45, 0.65), wall.height + 0.8, len + 0.4),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.position.y = wall.height / 2;
  hit.userData = { kind: 'wall', id: wall.id };
  group.add(hit);
  scene.add(group);
  layoutHitObjects.push(hit);
  layoutObjects.push({ group, textures: [] });
}

function createZoneObject(zone, selected) {
  const group = new THREE.Group();
  const color = new THREE.Color(zone.color || LAYOUT_ZONE_COLOR);
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(zone.width, zone.depth),
    createFloorOverlayMaterial({
      color,
      transparent: true,
      opacity: selected ? 0.26 : 0.16
    }, 'zone')
  );
  fill.rotation.x = -Math.PI / 2;
  applyFloorOverlayProfile(fill, FLOOR_LAYER.zone, 'zone');
  group.add(fill);

  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-zone.width / 2, FLOOR_LAYER.border, -zone.depth / 2),
      new THREE.Vector3(zone.width / 2, FLOOR_LAYER.border, -zone.depth / 2),
      new THREE.Vector3(zone.width / 2, FLOOR_LAYER.border, zone.depth / 2),
      new THREE.Vector3(-zone.width / 2, FLOOR_LAYER.border, zone.depth / 2)
    ]),
    new THREE.LineBasicMaterial({
      color: selected ? 0xffffff : color,
      transparent: true,
      opacity: 0.95
    })
  );
  border.renderOrder = FLOOR_RENDER_ORDER.zone + 1;
  group.add(border);

  const tag = createCanvasSprite(240, 72, 8.4, 2.3, 0.45);
  tag.sprite.position.set(zone.x, 0.45, zone.z);
  drawTextSprite(tag.canvas, tag.tex, {
    text: (zone.name || '区域').slice(0, 14),
    bg: selected ? 'rgba(0,0,0,0.86)' : 'rgba(18,22,28,0.82)',
    stroke: selected ? '#ffffff' : (zone.color || LAYOUT_ZONE_COLOR),
    color: '#ffffff'
  });
  scene.add(tag.sprite);

  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(zone.width, 0.45, zone.depth),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.position.set(zone.x, FLOOR_LAYER.border + 0.24, zone.z);
  hit.userData = { kind: 'zone', id: zone.id };
  scene.add(hit);

  group.position.set(zone.x, 0, zone.z);
  scene.add(group);
  layoutHitObjects.push(hit);
  layoutObjects.push({ group, textures: [] });
  layoutObjects.push({ group: tag.sprite, textures: [tag.tex] });
  layoutObjects.push({ group: hit, textures: [] });
}

function rebuildLayoutScene() {
  ensureLayoutConfig();
  clearLayoutScene();
  config.layout.zones.forEach(zone => createZoneObject(zone, isLayoutSelected('zone', zone.id)));
  config.layout.walls.forEach(wall => createWallObject(wall, isLayoutSelected('wall', wall.id)));
}

function updateCanvasCursor() {
  if (!dragState && !layoutDrawState) {
    controls.enabled = !walkMode && !(layoutMode && layoutTool !== 'select');
  }
  if (walkMode) {
    canvas.style.cursor = walkPointerLocked ? 'none' : 'crosshair';
  } else if (lightPlacementIndex != null) {
    canvas.style.cursor = 'crosshair';
  } else if (layoutMode) {
    canvas.style.cursor = layoutTool === 'select' ? 'pointer' : 'crosshair';
  } else if (editMode) {
    canvas.style.cursor = 'grab';
  } else {
    canvas.style.cursor = '';
  }
}

function updateSceneHint() {
  const el = document.getElementById('scene-hint');
  if (!el) return;
  if (walkMode) {
    el.textContent = walkPointerLocked
      ? '第一人称漫游 · WASD/方向键行走 · Shift 加速 · 移动鼠标观察 · Esc 退出'
      : '第一人称漫游 · 点击场景锁定鼠标 · WASD/方向键行走 · Esc 退出';
    return;
  }
  if (lightPlacementIndex != null && editingLights[lightPlacementIndex]) {
    const meta = getItemMeta(editingLights[lightPlacementIndex].type);
    el.textContent = '场景选点中 · 在左侧地面点击放置「' + meta.label + '」· WASD/方向键/小键盘平移 · 按 Esc 取消并返回配置';
    return;
  }
  if (layoutMode) {
    if (layoutTool === 'select') {
      el.textContent = '布局编辑中 · 点击墙体或区域可选中，右侧面板可修改名称和尺寸 · WASD/方向键/小键盘平移';
    } else if (layoutTool === 'wall') {
      el.textContent = '布局编辑中 · 在地面拖拽绘制墙体，松开即可生成新的隔断 · WASD/方向键/小键盘平移';
    } else {
      el.textContent = '布局编辑中 · 在地面拖拽框选区域，随后可在右侧为区域命名 · WASD/方向键/小键盘平移';
    }
    return;
  }
  if (editMode) {
    el.textContent = '🖱 拖动旋转 · 滚轮缩放 · 按住电器拖动位置 · WASD/方向键/小键盘平移';
    return;
  }
  el.textContent = '🖱 拖动旋转 · 滚轮缩放 · 点击图标切换 · 按住图标拖动位置 · WASD/方向键/小键盘平移';
}

function renderLayoutList() {
  const el = document.getElementById('layout-list');
  if (!el) return;
  ensureLayoutConfig();
  el.innerHTML = '';
  const items = [
    ...config.layout.walls.map(item => ({ kind: 'wall', item })),
    ...config.layout.zones.map(item => ({ kind: 'zone', item }))
  ];
  if (items.length === 0) {
    el.innerHTML = '<div class="empty-tip">还没有布局对象，开启布局编辑后就能直接在场景里绘制。</div>';
    return;
  }
  items.forEach(({ kind, item }) => {
    const row = document.createElement('div');
    row.className = 'layout-entry' + (isLayoutSelected(kind, item.id) ? ' sel' : '');
    row.innerHTML =
      '<div class="layout-entry-icon">' + (kind === 'wall' ? '墙' : '区') + '</div>' +
      '<div class="layout-entry-info">' +
        '<div class="layout-entry-name">' + escapeHtml(item.name || (kind === 'wall' ? '墙体' : '区域')) + '</div>' +
        '<div class="layout-entry-meta">' +
          (kind === 'wall'
            ? ('长度 ' + formatNum(getWallLength(item)) + ' · 高 ' + formatNum(item.height))
            : ('尺寸 ' + formatNum(item.width) + ' × ' + formatNum(item.depth))) +
        '</div>' +
      '</div>';
    row.addEventListener('click', function() {
      selectLayout(kind, item.id);
    });
    el.appendChild(row);
  });
}

function renderLayoutInspector() {
  const el = document.getElementById('layout-inspector');
  if (!el) return;
  el.innerHTML = '';
  if (!selectedLayout) {
    el.innerHTML =
      '<div class="layout-inspector-title">未选中对象</div>' +
      '<div class="layout-meta">选择工具后，点击场景中的墙体或区域即可在这里修改名称、尺寸和厚度。</div>';
    return;
  }

  const item = findLayoutItem(selectedLayout.kind, selectedLayout.id);
  if (!item) {
    selectedLayout = null;
    renderLayoutInspector();
    return;
  }

  const title = document.createElement('div');
  title.className = 'layout-inspector-title';
  title.textContent = selectedLayout.kind === 'wall' ? '墙体属性' : '区域属性';
  el.appendChild(title);

  const nameField = document.createElement('div');
  nameField.className = 'layout-field';
  nameField.innerHTML = '<label>名称</label><input type="text" value="' + escapeHtml(item.name || '') + '">';
  const nameInput = nameField.querySelector('input');
  nameInput.addEventListener('input', function() {
    item.name = nameInput.value || (selectedLayout.kind === 'wall' ? getNextLayoutName('wall') : getNextLayoutName('zone'));
    setLayoutDirty(true, false);
    rebuildLayoutScene();
    renderLayoutList();
    refreshLayoutChrome();
  });
  el.appendChild(nameField);

  const grid = document.createElement('div');
  grid.className = 'layout-grid';
  if (selectedLayout.kind === 'wall') {
    const thicknessBounds = getLayoutWallThicknessBounds();
    grid.innerHTML =
      '<div class="layout-field"><label>高度</label><input type="number" min="4" max="26" step="0.5" value="' + item.height + '"></div>' +
      '<div class="layout-field"><label>厚度</label><input type="number" min="' + thicknessBounds.min + '" max="' + thicknessBounds.max + '" step="0.1" value="' + item.thickness + '"></div>';
    const [heightInput, thickInput] = grid.querySelectorAll('input');
    heightInput.addEventListener('input', function() {
      item.height = clamp(Number(heightInput.value) || item.height, 4, 26);
      setLayoutDirty(true, false);
      rebuildLayoutScene();
      renderLayoutList();
      refreshLayoutChrome();
    });
    thickInput.addEventListener('input', function() {
      item.thickness = clamp(Number(thickInput.value) || item.thickness, thicknessBounds.min, thicknessBounds.max);
      setLayoutDirty(true, false);
      rebuildLayoutScene();
      renderLayoutList();
      refreshLayoutChrome();
    });
  } else {
    grid.innerHTML =
      '<div class="layout-field"><label>宽度</label><input type="number" min="2" max="' + BUILDING.width + '" step="0.5" value="' + item.width + '"></div>' +
      '<div class="layout-field"><label>深度</label><input type="number" min="2" max="' + BUILDING.depth + '" step="0.5" value="' + item.depth + '"></div>';
    const [widthInput, depthInput] = grid.querySelectorAll('input');
    widthInput.addEventListener('input', function() {
      item.width = clamp(Math.abs(Number(widthInput.value) || item.width), 2, BUILDING.width);
      setLayoutDirty(true, false);
      rebuildLayoutScene();
      renderLayoutList();
      refreshLayoutChrome();
    });
    depthInput.addEventListener('input', function() {
      item.depth = clamp(Math.abs(Number(depthInput.value) || item.depth), 2, BUILDING.depth);
      setLayoutDirty(true, false);
      rebuildLayoutScene();
      renderLayoutList();
      refreshLayoutChrome();
    });
  }
  el.appendChild(grid);

  const meta = document.createElement('div');
  meta.className = 'layout-meta';
  meta.textContent = selectedLayout.kind === 'wall'
    ? ('墙体长度 ' + formatNum(getWallLength(item)) + '，端点可通过重新绘制调整。')
    : ('区域中心位于 (' + formatNum(item.x) + ', ' + formatNum(item.z) + ')。');
  el.appendChild(meta);
}

function renderLayoutInspector() {
  const el = document.getElementById('layout-inspector');
  if (!el) return;
  ensureLayoutConfig();
  el.innerHTML = '';

  const building = config.layout.building;
  const shellTitle = document.createElement('div');
  shellTitle.className = 'layout-inspector-title';
  shellTitle.textContent = '车间外形';
  el.appendChild(shellTitle);

  const shellGrid = document.createElement('div');
  shellGrid.className = 'layout-grid';
  shellGrid.innerHTML =
    '<div class="layout-field"><label>宽度</label><input type="number" min="24" max="140" step="1" value="' + building.width + '"></div>' +
    '<div class="layout-field"><label>进深</label><input type="number" min="18" max="110" step="1" value="' + building.depth + '"></div>' +
    '<div class="layout-field"><label>檐高</label><input type="number" min="12" max="56" step="0.5" value="' + building.wallH + '"></div>' +
    '<div class="layout-field"><label>脊高</label><input type="number" min="' + (building.wallH + 6) + '" max="84" step="0.5" value="' + building.ridgeH + '"></div>';
  const shellInputs = shellGrid.querySelectorAll('input');
  const [widthInput, depthInput, wallHInput, ridgeHInput] = shellInputs;
  widthInput.addEventListener('change', function() {
    applyLayoutBuildingChange({ width: Number(widthInput.value) || building.width });
  });
  depthInput.addEventListener('change', function() {
    applyLayoutBuildingChange({ depth: Number(depthInput.value) || building.depth });
  });
  wallHInput.addEventListener('change', function() {
    applyLayoutBuildingChange({ wallH: Number(wallHInput.value) || building.wallH });
  });
  ridgeHInput.addEventListener('change', function() {
    applyLayoutBuildingChange({ ridgeH: Number(ridgeHInput.value) || building.ridgeH });
  });
  el.appendChild(shellGrid);

  const shellMeta = document.createElement('div');
  shellMeta.className = 'layout-meta';
  shellMeta.textContent = '修改车间尺寸后会立即重建骨架，并把超出边界的墙体、区域和设备压回到车间内部。';
  el.appendChild(shellMeta);

  if (!selectedLayout) {
    const divider = document.createElement('div');
    divider.className = 'layout-divider';
    el.appendChild(divider);

    const emptyTitle = document.createElement('div');
    emptyTitle.className = 'layout-inspector-title';
    emptyTitle.textContent = '未选中对象';
    el.appendChild(emptyTitle);

    const emptyMeta = document.createElement('div');
    emptyMeta.className = 'layout-meta';
    emptyMeta.textContent = '选中墙体或区域后，可以在这里继续修改名称、尺寸和厚度。';
    el.appendChild(emptyMeta);
    return;
  }

  const item = findLayoutItem(selectedLayout.kind, selectedLayout.id);
  if (!item) {
    selectedLayout = null;
    renderLayoutInspector();
    return;
  }

  const divider = document.createElement('div');
  divider.className = 'layout-divider';
  el.appendChild(divider);

  const title = document.createElement('div');
  title.className = 'layout-inspector-title';
  title.textContent = selectedLayout.kind === 'wall' ? '墙体属性' : '区域属性';
  el.appendChild(title);

  const nameField = document.createElement('div');
  nameField.className = 'layout-field';
  nameField.innerHTML = '<label>名称</label><input type="text" value="' + escapeHtml(item.name || '') + '">';
  const nameInput = nameField.querySelector('input');
  nameInput.addEventListener('input', function() {
    item.name = nameInput.value || (selectedLayout.kind === 'wall' ? getNextLayoutName('wall') : getNextLayoutName('zone'));
    setLayoutDirty(true, false);
    rebuildLayoutScene();
    renderLayoutList();
    refreshLayoutChrome();
  });
  el.appendChild(nameField);

  const grid = document.createElement('div');
  grid.className = 'layout-grid';
  if (selectedLayout.kind === 'wall') {
    const maxWallHeight = Math.max(8, BUILDING.ridgeH - 4);
    const thicknessBounds = getLayoutWallThicknessBounds();
    grid.innerHTML =
      '<div class="layout-field"><label>高度</label><input type="number" min="4" max="' + maxWallHeight + '" step="0.5" value="' + item.height + '"></div>' +
      '<div class="layout-field"><label>厚度</label><input type="number" min="' + thicknessBounds.min + '" max="' + thicknessBounds.max + '" step="0.1" value="' + item.thickness + '"></div>';
    const [heightInput, thickInput] = grid.querySelectorAll('input');
    heightInput.addEventListener('input', function() {
      item.height = clamp(Number(heightInput.value) || item.height, 4, maxWallHeight);
      setLayoutDirty(true, false);
      rebuildLayoutScene();
      renderLayoutList();
      refreshLayoutChrome();
    });
    thickInput.addEventListener('input', function() {
      item.thickness = clamp(Number(thickInput.value) || item.thickness, thicknessBounds.min, thicknessBounds.max);
      setLayoutDirty(true, false);
      rebuildLayoutScene();
      renderLayoutList();
      refreshLayoutChrome();
    });
  } else {
    const maxZoneWidth = Math.max(2, BUILDING.width - 2.4);
    const maxZoneDepth = Math.max(2, BUILDING.depth - 2.4);
    grid.innerHTML =
      '<div class="layout-field"><label>宽度</label><input type="number" min="2" max="' + maxZoneWidth + '" step="0.5" value="' + item.width + '"></div>' +
      '<div class="layout-field"><label>深度</label><input type="number" min="2" max="' + maxZoneDepth + '" step="0.5" value="' + item.depth + '"></div>';
    const [zoneWidthInput, zoneDepthInput] = grid.querySelectorAll('input');
    zoneWidthInput.addEventListener('input', function() {
      item.width = clamp(Math.abs(Number(zoneWidthInput.value) || item.width), 2, maxZoneWidth);
      item.x = clamp(item.x, -BUILDING.halfW + item.width / 2 + 1.2, BUILDING.halfW - item.width / 2 - 1.2);
      setLayoutDirty(true, false);
      rebuildLayoutScene();
      renderLayoutList();
      refreshLayoutChrome();
    });
    zoneDepthInput.addEventListener('input', function() {
      item.depth = clamp(Math.abs(Number(zoneDepthInput.value) || item.depth), 2, maxZoneDepth);
      item.z = clamp(item.z, -BUILDING.halfD + item.depth / 2 + 1.2, BUILDING.halfD - item.depth / 2 - 1.2);
      setLayoutDirty(true, false);
      rebuildLayoutScene();
      renderLayoutList();
      refreshLayoutChrome();
    });
  }
  el.appendChild(grid);

  const meta = document.createElement('div');
  meta.className = 'layout-meta';
  meta.textContent = selectedLayout.kind === 'wall'
    ? ('墙体长度 ' + formatNum(getWallLength(item)) + '，端点位置可通过重新绘制调整。')
    : ('区域中心位于 (' + formatNum(item.x) + ', ' + formatNum(item.z) + ')。');
  el.appendChild(meta);
}
