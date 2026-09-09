// Runtime state, device actions, and enhanced lamp rendering.

function animate() {
  requestAnimationFrame(animate);
  const time = performance.now() * 0.001;
  const delta = animate._lastTime == null ? 0.016 : Math.min(0.05, time - animate._lastTime);
  animate._lastTime = time;
  lamps.forEach(function(lamp) {
    if (lamp.tick) lamp.tick(time);
  });
  if (walkMode) updateWalkMovement(delta);
  else controls.update();
  if (typeof updateRoofFade === 'function') updateRoofFade();
  if (typeof updateWalkInteractionState === 'function') updateWalkInteractionState();
  if (typeof updateDeviceInspectorPosition === 'function') updateDeviceInspectorPosition();
  if (!(window.__techRenderFrame && window.__techRenderFrame())) renderer.render(scene, camera);
}

const DEFAULT_DEVICE_PROTOCOL = 'modbus_tcp';
const DEFAULT_DEVICE_CHANNEL_COUNT = 32;
const STATUS_POLL_INTERVAL_MS = 1500;
const AUTO_RECONNECT_INTERVAL_MS = 2 * 60 * 1000;
const POWER_ICON_SRC = './assets/img/power-icon.png';
const powerIconImage = new Image();
powerIconImage.onload = function() {
  if (!Array.isArray(lamps)) return;
  lamps.forEach(function(lamp) {
    if (lamp && lamp.iconUsesPowerGlyph) drawDeviceButton(lamp, lamp.state);
  });
};
powerIconImage.src = POWER_ICON_SRC;
const DEVICE_PROTOCOLS = Object.freeze({
  modbus_tcp: {
    key: 'modbus_tcp',
    label: 'Modbus TCP',
    defaultPort: 502
  },
  siemens_s7: {
    key: 'siemens_s7',
    label: 'Siemens S7-1200',
    defaultPort: 102
  }
});

const UNGROUPED_GROUP_KEY = '__ungrouped__';
const SETUP_WIZARD_STEPS = ['device', 'appliances'];

let config = {
  devices: [],
  lights: [],
  scenes: [],
  automaticMode: { enabled: false, periods: [] },
  layout: normalizeLayoutData(DEFAULT_LAYOUT)
};
let deviceStatus = {};
let editingLights = [];
let lightingGridDetailsOpen = false;
let lightingGridMapState = null;
let editingScenes = [];
let editingDeviceIp = null;
let statusPollTimer = null;
let autoReconnectTimer = null;
let autoReconnectInFlight = false;
let statusRefreshInFlight = false;
let statusRefreshQueued = false;
let runtimeOpsInFlight = 0;
let batchAllInFlight = false;
let toastSequence = 0;
let setupWizardState = {
  step: 0,
  deviceTargetIp: null,
  deviceConnected: false,
  lastGroupName: ''
};
const deviceActionLocks = new Set();
const lightToggleLocks = new Set();

function parseIntOr(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value, fallback, min, max) {
  const parsed = parseIntOr(value, fallback);
  return clamp(parsed, min, max);
}

function getDeviceProtocolMeta(deviceOrProtocol) {
  const protocol = typeof deviceOrProtocol === 'string'
    ? deviceOrProtocol
    : (deviceOrProtocol && deviceOrProtocol.protocol);
  return DEVICE_PROTOCOLS[protocol] || DEVICE_PROTOCOLS[DEFAULT_DEVICE_PROTOCOL];
}

function getDeviceChannelCount(device) {
  return clampInteger(device && device.channel_count, DEFAULT_DEVICE_CHANNEL_COUNT, 1, 128);
}

function normalizeDevice(device) {
  const source = Object.assign({}, device || {});
  const protocol = getDeviceProtocolMeta(source).key;
  const meta = getDeviceProtocolMeta(protocol);
  const next = {
    name: String(source.name || '未命名设备'),
    ip: String(source.ip || '').trim(),
    protocol: protocol,
    channel_count: getDeviceChannelCount(source)
  };

  if (protocol === 'siemens_s7') {
    next.port = clampInteger(source.port, meta.defaultPort, 1, 65535);
    next.rack = clampInteger(source.rack, 0, 0, 7);
    next.slot = clampInteger(source.slot, 1, 1, 32);
    next.db_number = clampInteger(source.db_number, 1, 1, 65535);
    next.start_byte = clampInteger(source.start_byte, 0, 0, 65535);
  } else {
    next.port = clampInteger(source.port, meta.defaultPort, 1, 65535);
    next.unit_id = clampInteger(source.unit_id, 254, 0, 255);
  }

  return next;
}

function normalizeDevices(devices) {
  return (devices || [])
    .map(normalizeDevice)
    .filter(function(device) { return !!device.ip; });
}

function getDeviceByIp(ip) {
  return (config.devices || []).find(function(device) {
    return device.ip === ip;
  }) || null;
}

function getLightDevice(light) {
  return light ? getDeviceByIp(light.device_ip) : null;
}

function getRuntimeLightingGrid() {
  const layout = (config && config.layout) || {};
  const source = layout.lightingGrid || {};
  if (typeof normalizeLightingGridConfig === 'function') {
    return normalizeLightingGridConfig(source);
  }
  return {
    enabled: source.enabled === true,
    columns: Math.max(1, parseIntOr(source.columns, 12)),
    lightsPerColumn: Math.max(1, parseIntOr(source.lightsPerColumn, 75)),
    orientation: source.orientation === 'x' ? 'x' : 'z'
  };
}

const LIGHTING_GRID_AREA_MAIN = 'main';
const LIGHTING_GRID_AREA_EXTENSION = 'extension';

function getLightGridArea(light) {
  return light && light.grid_area === LIGHTING_GRID_AREA_EXTENSION
    ? LIGHTING_GRID_AREA_EXTENSION
    : LIGHTING_GRID_AREA_MAIN;
}

// Scene presets must follow the physical relay, not the current position of an
// item in config.lights.  Numeric keys are still read as a legacy fallback.
function getLightStateKey(light) {
  const deviceIp = String(light && light.device_ip || '').trim();
  const channel = Number(light && light.channel);
  return deviceIp && Number.isInteger(channel) && channel >= 0
    ? deviceIp + '#' + channel
    : '';
}

function getRuntimeExtensionLightingGrid() {
  const layout = (config && config.layout) || {};
  const source = layout.extensionRoom || {};
  return {
    enabled: source.enabled === true,
    columns: clampInteger(source.lightColumns, 12, 1, 40),
    lightsPerColumn: clampInteger(source.lightsPerColumn, 14, 1, 120),
    orientation: 'x',
    area: LIGHTING_GRID_AREA_EXTENSION
  };
}

function getLightingGridForArea(area) {
  return area === LIGHTING_GRID_AREA_EXTENSION
    ? getRuntimeExtensionLightingGrid()
    : getRuntimeLightingGrid();
}

function resolveLightingGridSegmentsForView(lights, grid) {
  const source = Array.isArray(lights) ? lights : [];
  if (!grid || !grid.enabled || typeof assignLightingGridSegments !== 'function') return source;
  const assigned = assignLightingGridSegments(source, grid);
  return Array.isArray(assigned) ? assigned : source;
}

function getLightingGridSegment(light, grid) {
  if (!light || light.type !== 'lamp' || getLightGridArea(light) !== LIGHTING_GRID_AREA_MAIN || !grid || !grid.enabled) return null;
  const column = Number(light.grid_column);
  const start = Number(light.grid_start);
  const count = Number(light.grid_count);
  if (!Number.isInteger(column) || !Number.isInteger(start) || !Number.isInteger(count)) return null;
  if (column < 1 || column > grid.columns || start < 1 || count < 1) return null;
  const end = start + count - 1;
  if (end > grid.lightsPerColumn) return null;
  return { column: column, start: start, count: count, end: end };
}

function getLightingGridSegmentForArea(light) {
  if (!light || light.type !== 'lamp') return null;
  const area = getLightGridArea(light);
  const grid = getLightingGridForArea(area);
  if (!grid || !grid.enabled) return null;
  const column = Number(light.grid_column);
  const start = Number(light.grid_start);
  const count = Number(light.grid_count);
  if (!Number.isInteger(column) || !Number.isInteger(start) || !Number.isInteger(count)) return null;
  if (column < 1 || column > grid.columns || start < 1 || count < 1) return null;
  const end = start + count - 1;
  if (end > grid.lightsPerColumn) return null;
  return { area: area, column: column, start: start, count: count, end: end };
}

function formatLightingGridSegment(segment) {
  if (!segment) return '灯板区段未绑定';
  const areaLabel = segment.area === LIGHTING_GRID_AREA_EXTENSION ? '封箱机区域 · ' : '';
  return areaLabel + '第' + segment.column + '列 · ' + segment.start + '–' + segment.end + '号 · ' + segment.count + '盏';
}

function getDeviceDisplayName(deviceOrIp) {
  if (!deviceOrIp) return '未命名设备';
  if (typeof deviceOrIp === 'string') {
    const found = getDeviceByIp(deviceOrIp);
    return found ? (found.name || found.ip) : deviceOrIp;
  }
  return deviceOrIp.name || deviceOrIp.ip || '未命名设备';
}

function getDeviceSummary(device) {
  const meta = getDeviceProtocolMeta(device);
  const channelText = getDeviceChannelCount(device) + ' 路';
  if (meta.key === 'siemens_s7') {
    return [
      meta.label,
      device.ip + ':' + device.port,
      '机架 ' + device.rack + ' / 槽号 ' + device.slot,
      '数据块 ' + device.db_number + ' / 字节 ' + device.start_byte,
      channelText
    ].join(' / ');
  }
  return [
    meta.label,
    device.ip + ':' + device.port,
    '站号 ' + device.unit_id,
    channelText
  ].join(' / ');
}

function getErrorMessage(error, fallback) {
  if (error && error.message) return error.message;
  return fallback || '未知错误';
}

function normalizeGroupName(value) {
  return String(value || '').trim();
}

function getLightGroupKey(light) {
  const groupName = normalizeGroupName(light && light.group);
  return groupName || UNGROUPED_GROUP_KEY;
}

function getGroupLabel(groupKey) {
  return groupKey === UNGROUPED_GROUP_KEY ? '未分组' : groupKey;
}

function normalizeScene(scene) {
  const source = Object.assign({}, scene || {});
  const states = {};
  Object.keys(source.states || {}).forEach(function(key) {
    const normalizedKey = normalizeGroupName(key) || UNGROUPED_GROUP_KEY;
    const value = source.states[key];
    if (value === 'on' || value === 'off') {
      states[normalizedKey] = value;
    }
  });
  // 按继电器(设备)整体控制
  const deviceStates = {};
  Object.keys(source.deviceStates || {}).forEach(function(ip) {
    const key = String(ip || '').trim();
    const value = source.deviceStates[ip];
    if (key && (value === 'on' || value === 'off')) deviceStates[key] = value;
  });
  // 单独选中的灯泡, 以 "设备IP#通道" 为键 (= 实际控制的继电器输出)
  const lightStates = {};
  Object.keys(source.lightStates || {}).forEach(function(k) {
    const key = String(k || '').trim();
    const value = source.lightStates[k];
    if (key && (value === 'on' || value === 'off')) lightStates[key] = value;
  });
  return {
    name: String(source.name || '新场景').trim() || '新场景',
    description: String(source.description || '').trim(),
    states: states,
    deviceStates: deviceStates,
    lightStates: lightStates
  };
}

function normalizeScenes(scenes) {
  return (scenes || [])
    .map(normalizeScene)
    .filter(function(scene) {
      return !!scene.name;
    });
}

function normalizeAutomaticClockTime(value, fallback) {
  const text = String(value || '').trim();
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : fallback;
}

function normalizeAutomaticMode(mode) {
  const source = mode && typeof mode === 'object' ? mode : {};
  const usedIds = new Set();
  const periods = (Array.isArray(source.periods) ? source.periods : []).map(function(period, index) {
    const item = period && typeof period === 'object' ? period : {};
    let id = String(item.id || ('period-' + (index + 1))).trim() || ('period-' + (index + 1));
    while (usedIds.has(id)) id += '-' + (index + 1);
    usedIds.add(id);
    const seenChannels = new Set();
    const onChannels = (Array.isArray(item.onChannels) ? item.onChannels : []).reduce(function(result, channel) {
      const deviceIp = String(channel && channel.device_ip || '').trim();
      const channelNumber = parseInt(channel && channel.channel, 10);
      const key = deviceIp + '#' + channelNumber;
      if (!deviceIp || !Number.isInteger(channelNumber) || channelNumber < 0 || channelNumber > 127 || seenChannels.has(key)) {
        return result;
      }
      seenChannels.add(key);
      result.push({ device_ip: deviceIp, channel: channelNumber });
      return result;
    }, []);
    return {
      id: id,
      name: String(item.name || ('时段' + (index + 1))).trim() || ('时段' + (index + 1)),
      start: normalizeAutomaticClockTime(item.start, '08:00'),
      end: normalizeAutomaticClockTime(item.end, '18:00'),
      onChannels: onChannels
    };
  }).filter(function(period) {
    return period.start !== period.end;
  });
  return {
    enabled: source.enabled === true && periods.length > 0,
    periods: periods
  };
}

function getKnownGroupKeys(includeSceneOnlyGroups) {
  const keys = [];
  const used = new Set();

  (config.lights || []).forEach(function(light) {
    const key = getLightGroupKey(light);
    if (!used.has(key)) {
      used.add(key);
      keys.push(key);
    }
  });

  if (includeSceneOnlyGroups) {
    (config.scenes || []).forEach(function(scene) {
      Object.keys((scene && scene.states) || {}).forEach(function(key) {
        if (!used.has(key)) {
          used.add(key);
          keys.push(key);
        }
      });
    });
  }

  return keys;
}

function getFriendlyMessage(message, context) {
  const raw = String(message || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) return '未知错误';
  if (lower.indexOf('s7 driver is not wired in yet') >= 0) {
    return '当前已展示 Siemens S7-1200 参数，但 S7 驱动尚未接通。请先使用 Modbus TCP，或将该协议标记为测试版。';
  }
  if (lower.indexOf('connection failed') >= 0) {
    return '连接失败，请检查 IP、端口、协议，以及当前网络下设备是否可达。';
  }
  if (lower.indexOf('device is not connected') >= 0) {
    return '目标设备当前离线，请先连接设备再执行该操作。';
  }
  if (lower.indexOf('channel range exceeds') >= 0) {
    return '所选通道超出了该设备当前配置的通道数量。';
  }
  if (context === 'save') {
    return '保存失败。' + raw;
  }
  return raw;
}

function showToast(tone, title, body, options) {
  const root = document.getElementById('toast-stack');
  if (!root) return;

  const toast = document.createElement('div');
  const duration = options && typeof options.duration === 'number' ? options.duration : 3800;
  toastSequence += 1;
  toast.className = 'toast ' + (tone || 'info');
  toast.dataset.toastId = String(toastSequence);
  toast.innerHTML =
    '<div class="toast-title">' + escapeHtml(title || '提示') + '</div>' +
    '<div class="toast-body">' + escapeHtml(body || '') + '</div>';
  root.appendChild(toast);

  setTimeout(function() {
    toast.remove();
  }, duration);
}

function setNotice(id, tone, title, body) {
  const notice = document.getElementById(id);
  if (!notice) return;
  notice.hidden = false;
  notice.className = 'modal-notice ' + (tone || 'info');
  notice.innerHTML =
    '<div class="notice-title">' + escapeHtml(title || 'Notice') + '</div>' +
    '<div>' + escapeHtml(body || '') + '</div>';
}

function clearNotice(id) {
  const notice = document.getElementById(id);
  if (!notice) return;
  notice.hidden = true;
  notice.className = 'modal-notice';
  notice.innerHTML = '';
}

function getDeviceFieldId(prefix, field) {
  return prefix + '-' + field;
}

function getDeviceField(prefix, field) {
  return document.getElementById(getDeviceFieldId(prefix, field));
}

function fillDeviceForm(prefix, device) {
  const next = normalizeDevice(device || {});
  const defaults = {
    name: prefix === 'setup-device' ? '主控器' : '新设备',
    ip: '192.168.1.100',
    protocol: DEFAULT_DEVICE_PROTOCOL,
    port: getDeviceProtocolMeta(DEFAULT_DEVICE_PROTOCOL).defaultPort,
    channel_count: DEFAULT_DEVICE_CHANNEL_COUNT,
    unit_id: 254,
    rack: 0,
    slot: 1,
    db_number: 1,
    start_byte: 0
  };
  const merged = Object.assign({}, defaults, next);

  const nameInput = getDeviceField(prefix, 'name');
  const ipInput = getDeviceField(prefix, 'ip');
  const protocolInput = getDeviceField(prefix, 'protocol');
  const portInput = getDeviceField(prefix, 'port');
  const channelCountInput = getDeviceField(prefix, 'channel-count');
  const unitInput = getDeviceField(prefix, 'unit');
  const rackInput = getDeviceField(prefix, 'rack');
  const slotInput = getDeviceField(prefix, 'slot');
  const dbInput = getDeviceField(prefix, 'db-number');
  const startByteInput = getDeviceField(prefix, 'start-byte');

  if (nameInput) nameInput.value = merged.name;
  if (ipInput) ipInput.value = merged.ip;
  if (protocolInput) protocolInput.value = merged.protocol;
  if (portInput) portInput.value = String(merged.port);
  if (channelCountInput) channelCountInput.value = String(merged.channel_count);
  if (unitInput) unitInput.value = String(merged.unit_id);
  if (rackInput) rackInput.value = String(merged.rack);
  if (slotInput) slotInput.value = String(merged.slot);
  if (dbInput) dbInput.value = String(merged.db_number);
  if (startByteInput) startByteInput.value = String(merged.start_byte);
  syncProtocolForm(prefix);
}

function buildDeviceFromForm(prefix) {
  const protocol = getDeviceProtocolMeta(getDeviceField(prefix, 'protocol') ? getDeviceField(prefix, 'protocol').value : DEFAULT_DEVICE_PROTOCOL).key;
  const meta = getDeviceProtocolMeta(protocol);
  const device = {
    name: getDeviceField(prefix, 'name') ? getDeviceField(prefix, 'name').value : '未命名设备',
    ip: getDeviceField(prefix, 'ip') ? getDeviceField(prefix, 'ip').value.trim() : '',
    protocol: protocol,
    channel_count: clampInteger(
      getDeviceField(prefix, 'channel-count') ? getDeviceField(prefix, 'channel-count').value : DEFAULT_DEVICE_CHANNEL_COUNT,
      DEFAULT_DEVICE_CHANNEL_COUNT,
      1,
      128
    )
  };

  if (protocol === 'siemens_s7') {
    device.port = parseIntOr(getDeviceField(prefix, 'port') ? getDeviceField(prefix, 'port').value : '', meta.defaultPort);
    device.rack = parseIntOr(getDeviceField(prefix, 'rack') ? getDeviceField(prefix, 'rack').value : '', 0);
    device.slot = parseIntOr(getDeviceField(prefix, 'slot') ? getDeviceField(prefix, 'slot').value : '', 1);
    device.db_number = parseIntOr(getDeviceField(prefix, 'db-number') ? getDeviceField(prefix, 'db-number').value : '', 1);
    device.start_byte = parseIntOr(getDeviceField(prefix, 'start-byte') ? getDeviceField(prefix, 'start-byte').value : '', 0);
  } else {
    device.port = parseIntOr(getDeviceField(prefix, 'port') ? getDeviceField(prefix, 'port').value : '', meta.defaultPort);
    device.unit_id = parseIntOr(getDeviceField(prefix, 'unit') ? getDeviceField(prefix, 'unit').value : '', 254);
  }

  return normalizeDevice(device);
}

function syncProtocolForm(prefix) {
  const protocolInput = getDeviceField(prefix, 'protocol');
  const ipInput = getDeviceField(prefix, 'ip');
  const portInput = getDeviceField(prefix, 'port');
  const unitInput = getDeviceField(prefix, 'unit');
  const selectedProtocol = getDeviceProtocolMeta(protocolInput ? protocolInput.value : DEFAULT_DEVICE_PROTOCOL);
  const prefixMarker = prefix === 'setup-device' ? 'setup-device:' : '';
  const endpointLabel = document.getElementById(getDeviceFieldId(prefix, 'endpoint-label'));

  if (endpointLabel) {
    endpointLabel.textContent = prefix === 'setup-device' ? '设备 IP 地址' : '设备 IP 地址(用作唯一标识)';
  }

  if (ipInput) {
    const value = String(ipInput.value || '').trim();
    if (!value || /^COM\d+$/i.test(value)) {
      ipInput.value = '192.168.1.100';
    }
  }

  if (portInput && selectedProtocol.defaultPort) {
    const currentPort = parseIntOr(portInput.value, selectedProtocol.defaultPort);
    const knownDefaultPorts = Object.keys(DEVICE_PROTOCOLS).map(function(key) {
      return DEVICE_PROTOCOLS[key].defaultPort;
    }).filter(function(value) { return Number.isFinite(value); });
    if (!portInput.value || knownDefaultPorts.indexOf(currentPort) >= 0) {
      portInput.value = String(selectedProtocol.defaultPort);
    }
  }

  document.querySelectorAll('[data-device-protocol]').forEach(function(node) {
    const marker = node.getAttribute('data-device-protocol') || '';
    if (!prefixMarker && marker.indexOf(':') >= 0) return;
    if (prefixMarker && marker.indexOf(prefixMarker) !== 0) return;
    node.hidden = marker !== prefixMarker + selectedProtocol.key;
  });

  if (unitInput && unitInput.closest('.form-item')) {
    unitInput.closest('.form-item').hidden = selectedProtocol.key !== 'modbus_tcp';
  }
}

function resetDeviceForm() {
  editingDeviceIp = null;
  clearNotice('dev-modal-notice');
  fillDeviceForm('in', null);
}

function resetSetupWizardDeviceForm(device) {
  clearNotice('setup-device-notice');
  fillDeviceForm('setup-device', device || null);
}

window.onDeviceProtocolChange = function() {
  syncProtocolForm('in');
};

window.onSetupDeviceProtocolChange = function() {
  syncProtocolForm('setup-device');
};

async function api(path, method, body) {
  const opts = { method: method || 'GET' };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, opts);
  } catch (error) {
    throw new Error(getErrorMessage(error, '请求失败'));
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch (error) {}

  if (!response.ok) {
    throw new Error((payload && payload.error) || ('请求失败（' + response.status + '）'));
  }
  return payload;
}

function hasConnectedDevices() {
  return Object.keys(deviceStatus).some(function(ip) {
    return !!(deviceStatus[ip] && deviceStatus[ip].connected);
  });
}

function clearStatusPoll() {
  if (statusPollTimer) {
    clearTimeout(statusPollTimer);
    statusPollTimer = null;
  }
}

function scheduleStatusPoll(delayMs) {
  clearStatusPoll();
  if (statusRefreshInFlight || runtimeOpsInFlight > 0 || batchAllInFlight) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (!hasConnectedDevices()) return;
  const delay = typeof delayMs === 'number' ? delayMs : STATUS_POLL_INTERVAL_MS;
  statusPollTimer = setTimeout(function() {
    refreshStatus({ silent: true, force: false, reason: 'poll' });
  }, Math.max(0, delay));
}

function beginRuntimeOperation() {
  runtimeOpsInFlight += 1;
  clearStatusPoll();
}

function endRuntimeOperation() {
  runtimeOpsInFlight = Math.max(0, runtimeOpsInFlight - 1);
  if (runtimeOpsInFlight === 0 && !batchAllInFlight) {
    scheduleStatusPoll();
  }
}

async function runAutoReconnectCheck() {
  if (autoReconnectInFlight || statusRefreshInFlight || runtimeOpsInFlight > 0 || batchAllInFlight) return;
  const offlineDevices = (config.devices || []).filter(function(device) {
    return !(deviceStatus[device.ip] && deviceStatus[device.ip].connected);
  });
  if (offlineDevices.length === 0) return;

  autoReconnectInFlight = true;
  try {
    for (const device of offlineDevices) {
      if (deviceStatus[device.ip] && deviceStatus[device.ip].connected) continue;
      await connectDevice(device, { silent: true });
    }
  } finally {
    autoReconnectInFlight = false;
  }
}

function startAutoReconnectCheck() {
  if (autoReconnectTimer) clearInterval(autoReconnectTimer);
  autoReconnectTimer = setInterval(runAutoReconnectCheck, AUTO_RECONNECT_INTERVAL_MS);
  setTimeout(runAutoReconnectCheck, 0);
}

async function saveConfigData() {
  config.devices = normalizeDevices(config.devices);
  config.lights = (config.lights || []).map(normalizeLight);
  config.scenes = normalizeScenes(config.scenes);
  config.automaticMode = normalizeAutomaticMode(config.automaticMode);
  const result = await api('/api/config', 'POST', config);
  if (result.ok) setLayoutDirty(false);
  return result;
}

async function loadConfig() {
  try {
    const data = await api('/api/config');
    config.devices = normalizeDevices(data.devices || []);
    config.lights = (data.lights || []).map(normalizeLight);
    config.scenes = normalizeScenes(data.scenes || []);
    config.automaticMode = normalizeAutomaticMode(data.automaticMode);
    config.layout = normalizeLayoutData(data.layout);
    const lightingGrid = getRuntimeLightingGrid();
    if (lightingGrid.enabled && typeof assignLightingGridSegments === 'function') {
      const assignedLights = assignLightingGridSegments(config.lights, lightingGrid);
      if (Array.isArray(assignedLights)) config.lights = assignedLights.map(normalizeLight);
    }
    clampLightPositionsToBuilding();
    rebuildFactoryScene();
    selectedLayout = null;
    focusedLampIdx = null;
    labelsPinned = false;
    renderDeviceList();
    renderLightRows();
    rebuildLayoutScene();
    rebuildLamps();
    applyStatus();
    setLayoutDirty(false);
    updateLayoutUI();
    refreshLabelToggleUI();
    refreshPanelSections();
    syncProtocolForm('in');
    syncProtocolForm('setup-device');
    scheduleStatusPoll(0);
    startAutoReconnectCheck();
    return true;
  } catch (error) {
    showToast('error', '加载失败', getFriendlyMessage(getErrorMessage(error, '未知错误')));
    return false;
  }
}

function buildProjectConfigSnapshot() {
  const layoutSnapshot = typeof normalizeLayoutData === 'function'
    ? normalizeLayoutData(config.layout)
    : (config.layout || {});
  return {
    devices: normalizeDevices(config.devices),
    lights: (config.lights || []).map(normalizeLight),
    scenes: normalizeScenes(config.scenes),
    automaticMode: normalizeAutomaticMode(config.automaticMode),
    layout: JSON.parse(JSON.stringify(layoutSnapshot))
  };
}

function buildProjectExportBundle() {
  return {
    format: 'dengkong-project',
    version: 1,
    exportedAt: new Date().toISOString(),
    config: buildProjectConfigSnapshot()
  };
}

function makeProjectExportFileName() {
  const now = new Date();
  const pad = function(value) {
    return String(value).padStart(2, '0');
  };
  return 'dengkong-project-' +
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) + '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds()) + '.json';
}

function exportProjectConfig() {
  try {
    const bundle = buildProjectExportBundle();
    const fileName = makeProjectExportFileName();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function() {
      URL.revokeObjectURL(url);
    }, 0);
    showToast('success', '工程已导出', '当前车间、设备、灯具和场景已导出到 ' + fileName);
  } catch (error) {
    showToast('error', '导出失败', getFriendlyMessage(getErrorMessage(error, '无法生成工程文件')));
  }
}

function unwrapImportedProjectData(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('工程文件内容无效');
  }
  const source = payload.config && typeof payload.config === 'object'
    ? payload.config
    : payload;
  return {
    devices: Array.isArray(source.devices) ? source.devices : [],
    lights: Array.isArray(source.lights) ? source.lights : [],
    scenes: Array.isArray(source.scenes) ? source.scenes : [],
    automaticMode: normalizeAutomaticMode(source.automaticMode),
    layout: source.layout && typeof source.layout === 'object' ? source.layout : {}
  };
}

function openProjectImportDialog() {
  const input = document.getElementById('project-import-input');
  if (!input) return;
  input.value = '';
  input.click();
}

async function handleProjectFileSelection(event) {
  const input = event && event.target ? event.target : document.getElementById('project-import-input');
  const file = input && input.files ? input.files[0] : null;
  if (!file) return;

  const shouldImport = window.confirm('导入工程文件会覆盖当前设备、灯具、场景和车间布局，是否继续？');
  if (!shouldImport) {
    input.value = '';
    return;
  }

  beginRuntimeOperation();
  try {
    const text = await file.text();
    const imported = unwrapImportedProjectData(JSON.parse(text));
    const result = await api('/api/config', 'POST', imported);
    if (!result.ok) {
      throw new Error(result.error || '保存导入工程时失败');
    }
    const loaded = await loadConfig();
    if (!loaded) {
      throw new Error('导入成功，但重新加载当前工程失败');
    }
    showToast('success', '工程已导入', '已从 ' + file.name + ' 恢复当前车间方案');
  } catch (error) {
    showToast('error', '导入失败', getFriendlyMessage(getErrorMessage(error, '无法读取工程文件')));
  } finally {
    if (input) input.value = '';
    endRuntimeOperation();
  }
}

function buildSceneStateSummary(scene) {
  const parts = [];
  const states = (scene && scene.states) || {};
  Object.keys(states).forEach(function(key) {
    parts.push(getGroupLabel(key) + ' ' + (states[key] === 'on' ? '开启' : '关闭'));
  });
  const deviceStates = (scene && scene.deviceStates) || {};
  Object.keys(deviceStates).forEach(function(ip) {
    parts.push(getDeviceDisplayName(ip) + ' ' + (deviceStates[ip] === 'on' ? '开启' : '关闭'));
  });
  const lightStates = (scene && scene.lightStates) || {};
  const lightKeys = Object.keys(lightStates);
  if (lightKeys.length > 0) {
    const onCount = lightKeys.filter(function(k) { return lightStates[k] === 'on'; }).length;
    const segs = [];
    if (onCount) segs.push('开 ' + onCount);
    if (lightKeys.length - onCount) segs.push('关 ' + (lightKeys.length - onCount));
    parts.push('单独选灯 ' + segs.join('/'));
  }
  if (parts.length === 0) return '暂未配置控制目标';
  return parts.join(' · ');
}

function getGroupStats() {
  const buckets = {};
  const order = [];

  (config.lights || []).forEach(function(light, index) {
    const key = getLightGroupKey(light);
    if (!buckets[key]) {
      buckets[key] = {
        key: key,
        label: getGroupLabel(key),
        count: 0,
        on: 0,
        connected: 0,
        indices: []
      };
      order.push(key);
    }
    const bucket = buckets[key];
    const status = deviceStatus[light.device_ip];
    bucket.count += 1;
    bucket.indices.push(index);
    if (status && status.connected) {
      bucket.connected += 1;
      if (status.relay_states && status.relay_states[light.channel]) {
        bucket.on += 1;
      }
    }
  });

  return order.map(function(key) { return buckets[key]; });
}

function renderRuntimeSummary() {
  const el = document.getElementById('runtime-summary');
  if (!el) return;

  const offlineErrors = config.devices.filter(function(device) {
    return !!(deviceStatus[device.ip] && deviceStatus[device.ip].error);
  });
  if (offlineErrors.length > 0) {
    const names = offlineErrors.slice(0, 2).map(function(device) {
      return getDeviceDisplayName(device);
    }).join(', ');
    el.innerHTML =
      '<div class="inline-summary">' +
        '<div class="summary-title">需要处理</div>' +
        '<div>' + escapeHtml(names + (offlineErrors.length > 2 ? ' +' + (offlineErrors.length - 2) + ' 台' : '')) + ' 需要检查连接。</div>' +
      '</div>';
    return;
  }

  const groupCount = getGroupStats().length;
  el.innerHTML =
    '<div class="inline-summary">' +
      '<div class="summary-title">客户可直接使用</div>' +
      '<div>' + escapeHtml(groupCount + ' 个分组 · ' + getConnectedDeviceCount() + ' 台设备在线') + '</div>' +
    '</div>';
}

function renderSetupCard() {
  const card = document.getElementById('setup-card');
  const list = document.getElementById('setup-checklist');
  if (!card || !list) return;

  const steps = [
    {
      done: (config.devices || []).length > 0,
      title: '设备已保存',
      meta: (config.devices || []).length > 0
        ? getConnectedDeviceCount() + ' / ' + config.devices.length + ' 已连接'
        : '请至少添加一台控制设备'
    },
    {
      done: (config.lights || []).length > 0,
      title: '电器已绑定',
      meta: (config.lights || []).length > 0
        ? config.lights.length + ' 个电器已映射到通道'
        : '请先创建电器绑定供客户使用'
    }
  ];

  card.hidden = steps.every(function(step) { return step.done; });
  list.innerHTML = '';
  steps.forEach(function(step) {
    const item = document.createElement('div');
    item.className = 'setup-check-item' + (step.done ? ' done' : '');
    item.innerHTML =
      '<div class="setup-check-dot"></div>' +
      '<div class="setup-check-copy">' +
        '<div class="setup-check-title">' + escapeHtml(step.title) + '</div>' +
        '<div class="setup-check-meta">' + escapeHtml(step.meta) + '</div>' +
      '</div>';
    list.appendChild(item);
  });
}

function renderStatusStrip() {
  const el = document.getElementById('status-strip');
  if (!el) return;
  el.innerHTML = '';

  const disconnected = config.devices.filter(function(device) {
    return deviceStatus[device.ip] && deviceStatus[device.ip].error;
  });
  if (disconnected.length > 0) {
    const item = document.createElement('div');
    item.className = 'status-callout warn';
    item.innerHTML =
      '<div class="callout-title">检测到连接异常</div>' +
      '<div>' + escapeHtml(disconnected.map(function(device) {
        return getDeviceDisplayName(device);
      }).join(', ')) + '</div>';
    el.appendChild(item);
  }

}

function renderGroupSummary() {
  const el = document.getElementById('group-list');
  if (!el) return;
  el.innerHTML = '';

  const groups = getGroupStats();
  if (groups.length === 0) {
    el.innerHTML = '<div class="empty-tip">请先创建电器绑定，再使用分组控制。</div>';
    return;
  }

  groups.forEach(function(group) {
    const card = document.createElement('div');
    card.className = 'group-card';
    card.innerHTML =
      '<div class="group-card-head">' +
        '<div class="group-card-title">' + escapeHtml(group.label) + '</div>' +
        '<div class="group-card-title">' + group.on + '/' + group.count + '</div>' +
      '</div>' +
      '<div class="group-card-meta">' + escapeHtml(group.connected + ' 台已连接 · ' + group.count + ' 个已绑定') + '</div>';

    const actions = document.createElement('div');
    actions.className = 'group-card-actions';
    const onBtn = document.createElement('button');
    onBtn.className = 'mini-btn primary';
    onBtn.textContent = '开启';
    onBtn.addEventListener('click', function() {
      applyGroupState(group.key, true);
    });
    const offBtn = document.createElement('button');
    offBtn.className = 'mini-btn danger';
    offBtn.textContent = '关闭';
    offBtn.addEventListener('click', function() {
      applyGroupState(group.key, false);
    });
    actions.appendChild(onBtn);
    actions.appendChild(offBtn);
    card.appendChild(actions);
    el.appendChild(card);
  });
}

function refreshExperiencePanels() {
  renderRuntimeSummary();
  renderSetupCard();
  renderStatusStrip();
  renderGroupSummary();
}

function renderDeviceList() {
  const el = document.getElementById('dev-list');
  el.innerHTML = '';
  if (config.devices.length === 0) {
    el.innerHTML = '<div class="empty-tip">还没有设备</div>';
    refreshPanelSections();
    return;
  }

  config.devices.forEach(function(device) {
    const status = deviceStatus[device.ip];
    const connected = !!(status && status.connected);
    const errorText = status && status.error ? getFriendlyMessage(status.error, 'connect') : '';
    const row = document.createElement('div');
    row.className = 'dev-item';
    row.innerHTML =
      '<div class="dev-dot ' + (connected ? 'on' : '') + '"></div>' +
      '<div class="dev-info">' +
        '<div class="dev-name">' + escapeHtml(device.name || '未命名设备') + '</div>' +
        '<div class="dev-ip">' + escapeHtml(getDeviceSummary(device)) + '</div>' +
        (errorText ? '<div class="dev-hint error">' + escapeHtml(errorText) + '</div>' : '') +
      '</div>' +
      '<div class="dev-actions">' +
        '<button class="dev-btn e" data-act="edit">编辑</button>' +
        (connected
          ? '<button class="dev-btn d" data-act="disc">断开</button>'
          : '<button class="dev-btn c" data-act="conn">连接</button>') +
        '<button class="dev-btn x" data-act="del" title="删除">x</button>' +
      '</div>';
    row.querySelector('[data-act="edit"]').addEventListener('click', function() { showDeviceModal(device.ip); });
    row.querySelector('[data-act="conn"]')?.addEventListener('click', function() { connectDevice(device); });
    row.querySelector('[data-act="disc"]')?.addEventListener('click', function() { disconnectDevice(device.ip); });
    row.querySelector('[data-act="del"]').addEventListener('click', function() { delDevice(device.ip); });
    el.appendChild(row);
  });

  refreshPanelSections();
}

async function connectDevice(device, options) {
  const normalized = normalizeDevice(device);
  const actionKey = 'connect:' + normalized.ip;
  if (!normalized.ip || deviceActionLocks.has(actionKey)) return { ok: false };

  deviceActionLocks.add(actionKey);
  beginRuntimeOperation();
  try {
    const result = await api('/api/connect', 'POST', normalized);
    if (result.ok) {
      deviceStatus[normalized.ip] = {
        connected: true,
        name: normalized.name,
        protocol: normalized.protocol,
        relay_states: Array.isArray(result.relay_states) ? result.relay_states.slice() : []
      };
      applyStatus();
      return result;
    }
    if (!options || !options.silent) {
      showToast('error', '连接失败', getDeviceDisplayName(normalized) + '：' + getFriendlyMessage(result.error || '未知错误', 'connect'));
    }
    return result;
  } catch (error) {
    const message = getErrorMessage(error, '未知错误');
    if (!options || !options.silent) {
      showToast('error', '连接失败', getDeviceDisplayName(normalized) + '：' + getFriendlyMessage(message, 'connect'));
    }
    return { ok: false, error: message };
  } finally {
    deviceActionLocks.delete(actionKey);
    endRuntimeOperation();
  }
}

async function disconnectDevice(ip, options) {
  const actionKey = 'disconnect:' + ip;
  if (!ip || deviceActionLocks.has(actionKey)) return { ok: false };

  deviceActionLocks.add(actionKey);
  beginRuntimeOperation();
  try {
    const result = await api('/api/disconnect', 'POST', { ip: ip });
    if (deviceStatus[ip]) {
      deviceStatus[ip].connected = false;
      delete deviceStatus[ip].error;
    }
    applyStatus();
    return result;
  } catch (error) {
    const message = getErrorMessage(error, '未知错误');
    if (!options || !options.silent) {
      showToast('error', '断开失败', getDeviceDisplayName(ip) + '：' + getFriendlyMessage(message, 'connect'));
    }
    return { ok: false, error: message };
  } finally {
    deviceActionLocks.delete(actionKey);
    endRuntimeOperation();
  }
}

async function connectAll() {
  const failures = [];
  for (const device of config.devices) {
    if (deviceStatus[device.ip] && deviceStatus[device.ip].connected) continue;
    const result = await connectDevice(device, { silent: true });
    if (!result || !result.ok) {
      failures.push(getDeviceDisplayName(device));
    }
  }
  if (failures.length > 0) {
    showToast('warn', '仍有设备离线', failures.join('，'));
  } else if (config.devices.length > 0) {
    showToast('success', '设备已全部连接', '所有已保存设备均已在线。');
  }
}

async function disconnectAll() {
  beginRuntimeOperation();
  try {
    const result = await api('/api/disconnect', 'POST', {});
    Object.keys(deviceStatus).forEach(function(ip) {
      if (deviceStatus[ip]) {
        deviceStatus[ip].connected = false;
        delete deviceStatus[ip].error;
      }
    });
    applyStatus();
    return result;
  } catch (error) {
    showToast('error', '全部断开失败', getFriendlyMessage(getErrorMessage(error, '未知错误'), 'connect'));
    return { ok: false, error: getErrorMessage(error, '未知错误') };
  } finally {
    endRuntimeOperation();
  }
}

function showDeviceModal() {
  const modal = document.getElementById('dev-modal');
  const device = arguments.length > 0 ? getDeviceByIp(arguments[0]) : null;
  const title = modal ? modal.querySelector('h3') : null;
  const sub = modal ? modal.querySelector('.sub') : null;
  const submit = modal ? modal.querySelector('.btn.btn-primary') : null;

  editingDeviceIp = device ? device.ip : null;
  clearNotice('dev-modal-notice');
  fillDeviceForm('in', device || null);
  if (title) title.textContent = device ? '编辑设备' : '添加新设备';
  if (sub) {
    sub.textContent = device
      ? '修改设备参数后，客户后续会沿用这里的连接配置。'
      : '填写设备信息后，就可以继续做电器绑定。';
  }
  if (submit) submit.textContent = device ? '保存修改' : '确认添加';
  if (modal) modal.classList.add('show');
}

function hideDeviceModal() {
  const modal = document.getElementById('dev-modal');
  clearNotice('dev-modal-notice');
  if (modal) modal.classList.remove('show');
}

function validateDeviceInput(device, existingIp) {
  if (!device.ip) return '请输入设备 IP。';
  if (config.devices.some(function(item) { return item.ip === device.ip && item.ip !== existingIp; })) {
    return '当前项目中已存在这个 IP。';
  }
  return '';
}

async function testDeviceModal() {
  const device = buildDeviceFromForm('in');
  const validation = validateDeviceInput(device, editingDeviceIp);
  if (validation) {
    setNotice('dev-modal-notice', 'warn', '请检查设备参数', validation);
    return { ok: false, error: validation };
  }

  const result = await connectDevice(device, { silent: true });
  if (result && result.ok) {
    setNotice('dev-modal-notice', 'success', '连接成功', '控制设备可达，现在可以保存。');
    showToast('success', '设备可达', getDeviceDisplayName(device) + ' 连接成功。');
  } else {
    const message = getFriendlyMessage((result && result.error) || '未知错误', 'connect');
    setNotice('dev-modal-notice', 'error', '连接失败', message);
    showToast('error', '连接失败', message);
  }
  return result;
}

async function upsertDeviceConfig(device, options) {
  const opts = Object.assign({ existingIp: null }, options || {});
  const existingIp = opts.existingIp;
  const validation = validateDeviceInput(device, existingIp);
  if (validation) {
    return { ok: false, error: validation };
  }

  if (existingIp && existingIp !== device.ip && deviceStatus[existingIp] && deviceStatus[existingIp].connected) {
    await disconnectDevice(existingIp, { silent: true });
  }

  config.devices = config.devices.filter(function(item) {
    return item.ip !== existingIp;
  });
  config.devices.push(device);

  if (existingIp && existingIp !== device.ip) {
    config.lights = config.lights.map(function(light) {
      if (light.device_ip !== existingIp) return light;
      return Object.assign({}, light, { device_ip: device.ip });
    });
    if (deviceStatus[existingIp]) {
      deviceStatus[device.ip] = Object.assign({}, deviceStatus[existingIp], {
        name: device.name,
        protocol: device.protocol
      });
      delete deviceStatus[existingIp];
    }
  } else if (deviceStatus[device.ip]) {
    deviceStatus[device.ip].name = device.name;
    deviceStatus[device.ip].protocol = device.protocol;
  }

  const result = await saveConfigData();
  if (!result.ok) return result;

  renderDeviceList();
  renderLightRows();
  rebuildLamps();
  applyStatus();
  return { ok: true };
}

async function saveDevice() {
  const device = buildDeviceFromForm('in');
  clearNotice('dev-modal-notice');
  try {
    const result = await upsertDeviceConfig(device, { existingIp: editingDeviceIp });
    if (result.ok) {
      showToast('success', editingDeviceIp ? '设备已更新' : '设备已保存', getDeviceDisplayName(device) + ' 已可使用。');
      renderDeviceList();
      hideDeviceModal();
    } else {
      const message = getFriendlyMessage(result.error || '未知错误', 'save');
      setNotice('dev-modal-notice', 'error', '保存失败', message);
    }
  } catch (error) {
    const message = getFriendlyMessage(getErrorMessage(error, '未知错误'), 'save');
    setNotice('dev-modal-notice', 'error', '保存失败', message);
  }
}

async function delDevice(ip) {
  const device = config.devices.find(function(item) { return item.ip === ip; });
  if (!device) return;

  const relatedLights = config.lights.filter(function(light) {
    return light.device_ip === ip;
  });
  let message = '确认删除设备“' + getDeviceDisplayName(device) + '”(' + ip + ') 吗？';
  if (relatedLights.length > 0) {
    message += '\n\n同时会删除 ' + relatedLights.length + ' 个关联电器。';
  }
  if (!confirm(message)) return;

  if (deviceStatus[ip] && deviceStatus[ip].connected) {
    await disconnectDevice(ip, { silent: true });
  }
  config.devices = config.devices.filter(function(item) { return item.ip !== ip; });
  config.lights = config.lights.filter(function(light) { return light.device_ip !== ip; });
  delete deviceStatus[ip];

  try {
    const result = await saveConfigData();
    if (result.ok) {
      renderDeviceList();
      renderLightRows();
      rebuildLamps();
      updateCounts();
      showToast('success', '设备已删除', getDeviceDisplayName(device) + ' 及其关联电器已删除。');
    } else {
      showToast('error', '删除失败', getFriendlyMessage(result.error || '未知错误', 'save'));
    }
  } catch (error) {
    showToast('error', '删除失败', getFriendlyMessage(getErrorMessage(error, '未知错误'), 'save'));
  }
}

function renderLightRows() {
  const el = document.getElementById('light-rows');
  el.innerHTML = '';
  if (config.lights.length === 0) {
    el.innerHTML = '<div class="empty-tip">还没有电器</div>';
    refreshPanelSections();
    return;
  }

  const lightingGrid = getRuntimeLightingGrid();
  const gridResolvedLights = resolveLightingGridSegmentsForView(config.lights, lightingGrid);
  config.lights.forEach(function(light, index) {
    const meta = getItemMeta(light.type);
    const status = deviceStatus[light.device_ip];
    const connected = !!(status && status.connected);
    const on = connected && status.relay_states && status.relay_states[light.channel];
    const pending = connected && typeof isChannelPending === 'function' && isChannelPending(light.device_ip, light.channel);
    const row = document.createElement('div');
    row.className = 'light-row' + (connected ? '' : ' disabled') + (pending ? ' pending' : '');
    row.id = 'lrow-' + index;
    const deviceName = getDeviceDisplayName(light.device_ip);
    const groupLabel = getGroupLabel(getLightGroupKey(light));
    const gridSegment = getLightingGridSegmentForArea(gridResolvedLights[index] || light);
    const gridSegmentHtml = lightingGrid.enabled && light.type === 'lamp'
      ? '<span class="l-grid-segment">' + escapeHtml(formatLightingGridSegment(gridSegment)) + '</span>'
      : '';
    row.innerHTML =
      '<div class="l-dot' + (on ? ' on' : '') + (pending ? ' pending' : '') + '"></div>' +
      '<div class="l-icon' + (on ? ' on' : '') + (pending ? ' pending' : '') + '" style="--icon-accent:' + meta.accent + ';">' + escapeHtml(meta.icon) + '</div>' +
      '<div class="l-info">' +
        '<div class="l-name' + (on ? ' on' : '') + (pending ? ' pending' : '') + '">' + escapeHtml(light.name || '未命名电器') + '</div>' +
        '<div class="l-sub">' + escapeHtml(meta.label) + ' / ' + escapeHtml(deviceName) + ' / 通道' + String(light.channel + 1).padStart(2, '0') + '</div>' +
        '<div class="l-meta-row"><span class="l-group">' + escapeHtml(groupLabel) + '</span>' + gridSegmentHtml + '</div>' +
      '</div>' +
      '<div class="l-state' + (on ? ' on' : '') + (pending ? ' pending' : '') + '">' + (pending ? '\u786e\u8ba4\u4e2d' : (connected ? (on ? '开' : '关') : '--')) + '</div>' +
      '<div class="toggle' + (on ? ' on' : '') + (pending ? ' pending' : '') + '"><div class="toggle-knob"></div></div>';
    row.onclick = function() { toggleLight(index); };
    el.appendChild(row);
  });

  refreshPanelSections();
}

function setLightRowUI(index, on, connected, pending) {
  pending = !!pending;
  const row = document.getElementById('lrow-' + index);
  if (!row) return;
  const dot = row.querySelector('.l-dot');
  const icon = row.querySelector('.l-icon');
  const name = row.querySelector('.l-name');
  const state = row.querySelector('.l-state');
  const toggle = row.querySelector('.toggle');

  if (on) {
    dot.classList.add('on');
    icon.classList.add('on');
    name.classList.add('on');
    state.classList.add('on');
    state.textContent = '开';
    toggle.classList.add('on');
  } else {
    dot.classList.remove('on');
    icon.classList.remove('on');
    name.classList.remove('on');
    state.classList.remove('on');
    state.textContent = connected ? '关' : '--';
    toggle.classList.remove('on');
  }

  row.classList.toggle('pending', pending);
  dot.classList.toggle('pending', pending);
  icon.classList.toggle('pending', pending);
  name.classList.toggle('pending', pending);
  state.classList.toggle('pending', pending);
  toggle.classList.toggle('pending', pending);
  if (pending) state.textContent = '\u786e\u8ba4\u4e2d';
  row.classList.toggle('disabled', !connected);
}

async function toggleLight(lightIdx) {
  if (rejectControlDuringLightingGridMap()) return;
  if (lightToggleLocks.has(lightIdx)) return;
  const light = config.lights[lightIdx];
  if (!light) return;

  const status = deviceStatus[light.device_ip];
  if (!status || !status.connected) {
    showToast('warn', '设备离线', '请先连接目标控制设备，再切换该电器。');
    return;
  }

  if (typeof toggleDeviceChannel === 'function') {
    lightToggleLocks.add(lightIdx);
    try {
      await toggleDeviceChannel(light.device_ip, light.channel);
    } finally {
      lightToggleLocks.delete(lightIdx);
    }
    return;
  }

  lightToggleLocks.add(lightIdx);
  beginRuntimeOperation();
  try {
    const current = !!(lamps[lightIdx] && lamps[lightIdx].state);
    const result = await api('/api/toggle', 'POST', {
      ip: light.device_ip,
      channel: light.channel,
      value: !current
    });

    if (result.ok) {
      status.relay_states[light.channel] = !current;
      setLampState(lightIdx, !current);
      setLightRowUI(lightIdx, !current, true);
      updateCounts();
      scheduleStatusPoll(200);
    } else {
      showToast('error', '控制失败', getFriendlyMessage(result.error || '未知错误', 'control'));
    }
  } catch (error) {
    showToast('error', '控制失败', getFriendlyMessage(getErrorMessage(error, '未知错误'), 'control'));
  } finally {
    lightToggleLocks.delete(lightIdx);
    endRuntimeOperation();
  }
}

async function batchAll(value) {
  if (rejectControlDuringLightingGridMap()) return;
  if (batchAllInFlight) return;
  const connectedDevices = config.devices.filter(function(device) {
    return !!(deviceStatus[device.ip] && deviceStatus[device.ip].connected);
  });

  if (connectedDevices.length === 0) {
    showToast('warn', '没有已连接设备', '执行批量操作前，请先连接至少一台控制设备。');
    return;
  }

  batchAllInFlight = true;
  beginRuntimeOperation();
  try {
    const results = await Promise.all(connectedDevices.map(async function(device) {
      try {
        const response = await api('/api/batch', 'POST', {
          ip: device.ip,
          start: 0,
          end: getDeviceChannelCount(device),
          value: value
        });
        return {
          device: device,
          ok: !!response.ok,
          error: response.error || ''
        };
      } catch (error) {
        return {
          device: device,
          ok: false,
          error: getErrorMessage(error, '未知错误')
        };
      }
    }));

    await refreshStatus({ force: true, silent: true });

    const failures = results.filter(function(item) { return !item.ok; });
    if (failures.length > 0) {
      const failedNames = failures.map(function(item) {
        return getDeviceDisplayName(item.device);
      }).join(', ');
      showToast('warn', '批量操作部分成功', failedNames);
    } else {
      showToast('success', value ? '全部开启' : '全部关闭', '已连接设备已完成批量操作。');
    }
  } finally {
    batchAllInFlight = false;
    endRuntimeOperation();
  }
}

async function refreshStatus(options) {
  const opts = Object.assign(
    {
      force: arguments.length === 0,
      silent: false
    },
    options || {}
  );

  if (statusRefreshInFlight) {
    statusRefreshQueued = true;
    return { ok: false, skipped: true };
  }

  if (!opts.force) {
    if (runtimeOpsInFlight > 0 || batchAllInFlight) {
      scheduleStatusPoll();
      return { ok: false, skipped: true };
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      clearStatusPoll();
      return { ok: false, skipped: true };
    }
    if (!hasConnectedDevices()) {
      clearStatusPoll();
      return { ok: true, skipped: true };
    }
  }

  clearStatusPoll();
  statusRefreshInFlight = true;
  try {
    const result = await api('/api/status');
    deviceStatus = result.devices || {};
    applyStatus();
    return result;
  } catch (error) {
    const message = getErrorMessage(error, '未知错误');
    if (!opts.silent) {
      showToast('error', '刷新失败', getFriendlyMessage(message, 'refresh'));
    }
    return { ok: false, error: message };
  } finally {
    statusRefreshInFlight = false;
    if (statusRefreshQueued) {
      statusRefreshQueued = false;
      refreshStatus({ force: true, silent: true });
      return;
    }
    scheduleStatusPoll();
  }
}

function applyStatus() {
  if (typeof reconcilePendingControls === 'function') reconcilePendingControls();
  renderDeviceList();
  config.lights.forEach(function(light, index) {
    const status = deviceStatus[light.device_ip];
    const connected = !!(status && status.connected);
    const on = connected && status.relay_states && status.relay_states[light.channel];
    const pending = connected && typeof isChannelPending === 'function' && isChannelPending(light.device_ip, light.channel);
    setLampState(index, !!on);
    setLightRowUI(index, !!on, connected, pending);
  });
  updateCounts();
  refreshExperiencePanels();
  if (typeof refreshDeviceInspectorState === 'function') refreshDeviceInspectorState();
  if (typeof syncControlView === 'function') syncControlView();
}

function updateCounts() {
  const lightingGrid = getRuntimeLightingGrid();
  if (lightingGrid.enabled) {
    const litPanels = new Set();
    const gridResolvedLights = resolveLightingGridSegmentsForView(config.lights, lightingGrid);
    config.lights.forEach(function(light, index) {
      const segment = getLightingGridSegmentForArea(gridResolvedLights[index] || light);
      if (!segment) return;
      const status = deviceStatus[light.device_ip];
      const isOn = !!(status && status.connected && status.relay_states && status.relay_states[light.channel]);
      if (!isOn) return;
      for (let number = segment.start; number <= segment.end; number++) {
        litPanels.add(segment.area + '#' + segment.column + '#' + number);
      }
    });
    const extensionGrid = getRuntimeExtensionLightingGrid();
    const physicalTotal = lightingGrid.columns * lightingGrid.lightsPerColumn +
      (extensionGrid.enabled ? extensionGrid.columns * extensionGrid.lightsPerColumn : 0);
    const onPanels = Math.min(physicalTotal, litPanels.size);
    document.getElementById('stat-on').textContent = onPanels;
    document.getElementById('stat-off').textContent = physicalTotal - onPanels;
    refreshPanelSections();
    return;
  }

  let on = 0;
  const total = config.lights.length;
  config.lights.forEach(function(light) {
    const status = deviceStatus[light.device_ip];
    if (status && status.connected && status.relay_states && status.relay_states[light.channel]) {
      on += 1;
    }
  });
  document.getElementById('stat-on').textContent = on;
  document.getElementById('stat-off').textContent = total - on;
  refreshPanelSections();
}

function getTypeOptionsHtml(selectedType) {
  return ITEM_TYPE_KEYS.map(function(type) {
    const meta = getItemMeta(type);
    return '<option value="' + type + '"' +
      (selectedType === type ? ' selected' : '') + '>' +
      escapeHtml(meta.icon + ' ' + meta.label) + '</option>';
  }).join('');
}

function syncLightingGridModalUI(lightingGrid) {
  const enabled = !!(lightingGrid && lightingGrid.enabled);
  const modal = document.querySelector('#lights-modal .modal');
  const title = document.getElementById('lights-modal-title');
  const sub = document.getElementById('lights-modal-sub');
  const explainer = document.getElementById('lc-grid-explainer');
  const mapTool = document.getElementById('lc-map-tool');
  const batchTool = document.getElementById('lc-batch-layout-tool');
  const bindTool = document.getElementById('lc-bind-tool');
  const bindTitle = document.getElementById('lc-bind-title');
  const bindHint = document.getElementById('lc-bind-hint');
  const detailsToggle = document.getElementById('lc-grid-details-toggle');
  const details = document.getElementById('lc-grid-details');
  const addButton = document.getElementById('lc-add-light');
  const mapTitle = document.getElementById('lc-map-title');
  const mapStart2d = document.getElementById('lc-map-start-2d');
  const mapStart3d = document.getElementById('lc-map-start-3d');

  if (modal) modal.classList.toggle('lighting-grid-modal', enabled);
  if (title) title.textContent = enabled ? '灯板开关配置' : '电器管理';
  if (sub) {
    sub.textContent = enabled
      ? '选择一个继电器通道，然后在 2D 平面图或 3D 场景中点灯板的起点和终点。一个开关即可控制整段灯板。'
      : '每个电器绑定到一个设备通道，JV-DAM3200 支持 32 路，可选择图标类型、自定义名称，并单独设置模型大小';
  }
  if (explainer) {
    explainer.hidden = !enabled;
    if (enabled) {
      const total = lightingGrid.columns * lightingGrid.lightsPerColumn;
      explainer.innerHTML = '<strong>客户只需在图上点两下。</strong> 车间共有 ' +
        lightingGrid.columns + ' 列 × 每列 ' + lightingGrid.lightsPerColumn + ' 块 = ' + total +
        ' 块物理灯板；第一次点击确定起点，第二次点击同一列的终点，中间灯板自动绑定到当前开关。';
    }
  }
  if (mapTool) mapTool.hidden = !enabled;
  if (batchTool) batchTool.hidden = enabled;
  if (bindTool) bindTool.hidden = enabled;
  if (detailsToggle) {
    detailsToggle.hidden = !enabled;
    const circuitCount = editingLights.filter(function(light) { return light.type === 'lamp'; }).length;
    detailsToggle.textContent = (lightingGridDetailsOpen ? '收起' : '查看 / 微调') +
      '详细回路（' + circuitCount + ' 路）' + (lightingGridDetailsOpen ? '  ↑' : '  ↓');
  }
  if (details) details.hidden = enabled && !lightingGridDetailsOpen;
  if (bindTitle) bindTitle.textContent = enabled ? '按回路顺序绑定继电器' : '按编号顺序绑定继电器';
  if (bindHint) {
    bindHint.textContent = enabled
      ? '把“起始–结束编号”的控制回路按顺序绑定到所选继电器，从“起始通道”开始依次 +1。编号见下方每行左侧；灯板范围由各回路自己的列号、起始号和连续数量决定。'
      : '把“起始–结束编号”的电器按顺序绑定到所选继电器，从“起始通道”开始依次 +1；超出该板通道数的部分会提示，改绑到下一块板即可。编号见下方每行左侧的 # 号。';
  }
  if (addButton) addButton.textContent = enabled ? '+ 添加一个控制回路' : '+ 添加一个电器';
  if (mapTitle) mapTitle.textContent = '直接在 2D / 3D 图上划分开关回路';
  if (mapStart2d) mapStart2d.classList.toggle('recommended', typeof topView !== 'undefined' && topView === 'plan');
  if (mapStart3d) mapStart3d.classList.toggle('recommended', typeof topView === 'undefined' || topView !== 'plan');
  if (enabled) refreshLightingGridMapTool();
}

function openFlatPlanConfiguration() {
  showLightsModal();
}

function showLightsModal() {
  if (config.devices.length === 0) {
    showToast('warn', '请先添加设备', '绑定电器前，请先创建或保存至少一台控制设备。');
    return;
  }
  clearNotice('lights-modal-notice');
  editingLights = config.lights.map(normalizeLight);
  const lightingGrid = getRuntimeLightingGrid();
  let autoAssignedCount = 0;
  if (lightingGrid.enabled) {
    autoAssignedCount = editingLights.filter(function(light) {
      return light.type === 'lamp' && getLightGridArea(light) === LIGHTING_GRID_AREA_MAIN &&
        !getLightingGridSegment(light, lightingGrid);
    }).length;
    if (typeof assignLightingGridSegments === 'function') {
      const assigned = assignLightingGridSegments(editingLights, lightingGrid);
      if (Array.isArray(assigned)) editingLights = assigned.map(normalizeLight);
    }
  }
  lightingGridDetailsOpen = !lightingGrid.enabled;
  syncLightingGridModalUI(lightingGrid);
  const batchType = document.getElementById('lc-batch-type');
  if (batchType) batchType.innerHTML = getTypeOptionsHtml(DEFAULT_ITEM_TYPE);
  refreshBindToolUI();
  renderLightsConfig();
  document.getElementById('lights-modal').classList.add('show');
  if (autoAssignedCount > 0) {
    setNotice('lights-modal-notice', 'success', '已自动补全灯板区段',
      '已为 ' + autoAssignedCount + ' 个缺少有效范围的灯回路自动分段。请检查列号和号码范围，确认后保存。');
  }
}

function getLightingGridMapDeviceOptions(selectedIp) {
  return config.devices.map(function(device) {
    return '<option value="' + escapeHtml(device.ip) + '"' +
      (device.ip === selectedIp ? ' selected' : '') + '>' +
      escapeHtml((device.name || device.ip) + ' · ' + getDeviceChannelCount(device) + '路') + '</option>';
  }).join('');
}

function getSuggestedLightingGridGroup() {
  const counts = {};
  let best = '';
  let bestCount = 0;
  editingLights.forEach(function(light) {
    if (!light || light.type !== 'lamp') return;
    const group = normalizeGroupName(light.group);
    if (!group) return;
    counts[group] = (counts[group] || 0) + 1;
    if (counts[group] > bestCount) {
      best = group;
      bestCount = counts[group];
    }
  });
  return best;
}

function refreshLightingGridMapTool() {
  const grid = getRuntimeLightingGrid();
  if (!grid.enabled) return;
  const deviceSelect = document.getElementById('lc-map-device');
  const channelInput = document.getElementById('lc-map-channel');
  const groupInput = document.getElementById('lc-map-group');
  const summary = document.getElementById('lc-map-summary');
  if (!deviceSelect || !channelInput) return;

  const previousIp = deviceSelect.value;
  const selectedIp = config.devices.some(function(device) { return device.ip === previousIp; })
    ? previousIp
    : (config.devices[0] && config.devices[0].ip);
  deviceSelect.innerHTML = getLightingGridMapDeviceOptions(selectedIp);
  if (selectedIp) deviceSelect.value = selectedIp;

  const device = getDeviceByIp(deviceSelect.value) || config.devices[0] || null;
  const channelCount = getDeviceChannelCount(device);
  channelInput.max = String(channelCount);
  const channel = clamp(parseIntOr(channelInput.value, 1), 1, channelCount);
  channelInput.value = String(channel);
  if (groupInput && !groupInput.value) groupInput.value = getSuggestedLightingGridGroup() || '车间顶灯';

  if (summary) {
    const circuitCount = editingLights.filter(function(light) { return light.type === 'lamp'; }).length;
    const deviceName = device ? getDeviceDisplayName(device) : '未选择继电器';
    summary.textContent = '当前已有 ' + circuitCount + ' 个灯板回路；将从「' + deviceName + '」通道 ' +
      channel + ' 开始，完成一段后自动进入下一可用通道。';
  }
}

function toggleLightingGridDetails(forceValue) {
  lightingGridDetailsOpen = typeof forceValue === 'boolean' ? forceValue : !lightingGridDetailsOpen;
  syncLightingGridModalUI(getRuntimeLightingGrid());
}

function isLightingGridMapModeActive() {
  return !!(lightingGridMapState && lightingGridMapState.active);
}

function rejectControlDuringLightingGridMap() {
  if (!isLightingGridMapModeActive()) return false;
  showToast('warn', '正在配置灯板回路', '请先完成或取消图上配置，再操作真实继电器。');
  return true;
}

function isLightingGrid2DMapModeActive() {
  return !!(lightingGridMapState && lightingGridMapState.active && lightingGridMapState.surface === '2d');
}

function getLightingGridMapDraftLights() {
  return isLightingGrid2DMapModeActive() ? editingLights : null;
}

function getLightingGridMapActiveCell() {
  return isLightingGrid2DMapModeActive() && lightingGridMapState.startCell
    ? Object.assign({}, lightingGridMapState.startCell)
    : null;
}

function getLightingGridMapSlotKey(slot) {
  return slot ? String(slot.deviceIp) + '#' + String(slot.channel) : '';
}

function getLightingGridMapSlots() {
  const slots = [];
  config.devices.forEach(function(device) {
    const channelCount = getDeviceChannelCount(device);
    for (let channel = 0; channel < channelCount; channel++) {
      slots.push({ deviceIp: device.ip, channel: channel });
    }
  });
  return slots;
}

function findNextLightingGridMapSlot(currentSlot) {
  const slots = getLightingGridMapSlots();
  if (!slots.length) return null;
  const currentKey = getLightingGridMapSlotKey(currentSlot);
  const currentIndex = Math.max(0, slots.findIndex(function(slot) {
    return getLightingGridMapSlotKey(slot) === currentKey;
  }));
  const blocked = new Set(editingLights.filter(function(light) {
    return light.type !== 'lamp';
  }).map(function(light) {
    return String(light.device_ip) + '#' + String(light.channel);
  }));
  for (let offset = 1; offset <= slots.length; offset++) {
    const slot = slots[(currentIndex + offset) % slots.length];
    if (!blocked.has(getLightingGridMapSlotKey(slot))) return slot;
  }
  return null;
}

function findLightingGridMapRouteIndex(slot) {
  if (!slot) return -1;
  return editingLights.findIndex(function(light) {
    return light && light.type === 'lamp' &&
      String(light.device_ip) === String(slot.deviceIp) &&
      Number(light.channel) === Number(slot.channel);
  });
}

function getLightingGridMapRouteSegment(slot) {
  const index = findLightingGridMapRouteIndex(slot);
  if (index < 0) return null;
  const segment = getLightingGridSegmentForArea(editingLights[index]);
  return segment ? {
    index: index,
    area: segment.area,
    column: segment.column,
    start: segment.start,
    end: segment.end,
    count: segment.count
  } : null;
}

function getLightingGridMapCircuitCount() {
  return editingLights.filter(function(light) { return light && light.type === 'lamp'; }).length;
}

function getLightingGridMapNonLampConflict(slot) {
  if (!slot) return null;
  return editingLights.find(function(light) {
    return light && light.type !== 'lamp' &&
      String(light.device_ip) === String(slot.deviceIp) &&
      Number(light.channel) === Number(slot.channel);
  }) || null;
}

function refreshLightingGridMapTargetSelectors() {
  const state = lightingGridMapState;
  const deviceSelect = document.getElementById('grid-map-device-select');
  const channelSelect = document.getElementById('grid-map-channel-select');
  if (!deviceSelect || !channelSelect) return;

  deviceSelect.innerHTML = '';
  (config.devices || []).forEach(function(device) {
    const option = document.createElement('option');
    option.value = device.ip;
    option.textContent = getDeviceDisplayName(device) + ' · ' + getDeviceChannelCount(device) + '路';
    deviceSelect.appendChild(option);
  });

  if (!state || !state.currentSlot) {
    deviceSelect.disabled = true;
    channelSelect.disabled = true;
    channelSelect.innerHTML = '<option>无可用通道</option>';
    return;
  }

  const device = getDeviceByIp(state.currentSlot.deviceIp);
  if (!device) {
    deviceSelect.disabled = true;
    channelSelect.disabled = true;
    channelSelect.innerHTML = '<option>设备不存在</option>';
    return;
  }

  deviceSelect.disabled = false;
  deviceSelect.value = device.ip;
  channelSelect.innerHTML = '';
  const channelCount = getDeviceChannelCount(device);
  for (let channel = 0; channel < channelCount; channel++) {
    const slot = { deviceIp: device.ip, channel: channel };
    const segment = getLightingGridMapRouteSegment(slot);
    const conflict = getLightingGridMapNonLampConflict(slot);
    const option = document.createElement('option');
    option.value = String(channel);
    option.disabled = !!conflict;
    option.textContent = String(channel + 1).padStart(2, '0') + (segment
      ? ' · ' + (segment.area === LIGHTING_GRID_AREA_EXTENSION ? '封箱机区域 ' : '') +
        '第' + segment.column + '列 ' + segment.start + '–' + segment.end + '号'
      : (conflict ? ' · 已被其他电器占用' : ' · 未配置'));
    channelSelect.appendChild(option);
  }
  channelSelect.disabled = false;
  channelSelect.value = String(state.currentSlot.channel);
  if (state.mode === 'single') {
    deviceSelect.disabled = true;
    channelSelect.disabled = true;
  }
}

function focusLightingGridMapCurrentSlot() {
  if (!lightingGridMapState || !lightingGridMapState.currentSlot) return false;
  const segment = getLightingGridMapRouteSegment(lightingGridMapState.currentSlot);
  if (!segment) return false;
  if (lightingGridMapState.surface === '2d') {
    return typeof window.focusFlatPlanGridRange === 'function'
      ? window.focusFlatPlanGridRange(segment)
      : false;
  }
  return window.BabylonApp && typeof window.BabylonApp.focusGridRange === 'function'
    ? window.BabylonApp.focusGridRange(segment)
    : false;
}

function selectLightingGridMapTarget(deviceIp, channel) {
  const state = lightingGridMapState;
  const device = getDeviceByIp(deviceIp);
  const channelNumber = Number(channel);
  if (!state || !device || !Number.isInteger(channelNumber) ||
      channelNumber < 0 || channelNumber >= getDeviceChannelCount(device)) return false;

  const slot = { deviceIp: device.ip, channel: channelNumber };
  if (state.mode === 'single' && Number.isInteger(state.editingIndex)) {
    const lockedLight = editingLights[state.editingIndex];
    const locked = lockedLight && String(lockedLight.device_ip) === String(slot.deviceIp) &&
      Number(lockedLight.channel) === Number(slot.channel);
    if (!locked) {
      updateLightingGridMapBar('单回路重选只修改灯板范围；如需改绑继电器，请返回列表修改设备和通道。', true);
      return false;
    }
  }
  if (getLightingGridMapNonLampConflict(slot)) {
    updateLightingGridMapBar('该通道已被其他电器占用，请选择其他通道。', true);
    return false;
  }

  state.currentSlot = slot;
  state.startCell = null;
  updateLightingGridMapBar();
  syncLightingGridMapOverlay();
  focusLightingGridMapCurrentSlot();
  return true;
}

function onLightingGridMapDeviceChange() {
  const state = lightingGridMapState;
  const deviceSelect = document.getElementById('grid-map-device-select');
  const device = getDeviceByIp(deviceSelect && deviceSelect.value);
  if (!state || !device) return;

  const channelCount = getDeviceChannelCount(device);
  const preferredChannel = Math.min(Math.max(Number(state.currentSlot && state.currentSlot.channel) || 0, 0), channelCount - 1);
  let selectedChannel = -1;
  for (let offset = 0; offset < channelCount; offset++) {
    const channel = (preferredChannel + offset) % channelCount;
    if (!getLightingGridMapNonLampConflict({ deviceIp: device.ip, channel: channel })) {
      selectedChannel = channel;
      break;
    }
  }
  if (selectedChannel < 0) {
    refreshLightingGridMapTargetSelectors();
    updateLightingGridMapBar('该继电器没有可用于灯板的通道。', true);
    return;
  }
  selectLightingGridMapTarget(device.ip, selectedChannel);
}

function onLightingGridMapChannelChange() {
  const deviceSelect = document.getElementById('grid-map-device-select');
  const channelSelect = document.getElementById('grid-map-channel-select');
  if (!deviceSelect || !channelSelect) return;
  selectLightingGridMapTarget(deviceSelect.value, Number(channelSelect.value));
}

function getLightingGridMapRanges() {
  if (!lightingGridMapState || !lightingGridMapState.currentSlot || lightingGridMapState.startCell) return [];
  const segment = getLightingGridMapRouteSegment(lightingGridMapState.currentSlot);
  return segment ? [{ area: segment.area, column: segment.column, start: segment.start, end: segment.end }] : [];
}

function syncLightingGridMapOverlay() {
  if (isLightingGrid2DMapModeActive()) {
    if (typeof window.syncFlatPlanMapConfiguration === 'function') {
      window.syncFlatPlanMapConfiguration();
    }
    return;
  }
  if (!window.BabylonApp || typeof window.BabylonApp.setGridSelectionOverlay !== 'function') return;
  const activeCell = lightingGridMapState && lightingGridMapState.startCell
    ? lightingGridMapState.startCell
    : null;
  window.BabylonApp.setGridSelectionOverlay(getLightingGridMapRanges(), activeCell);
}

function updateLightingGridMapBar(message, isError) {
  const state = lightingGridMapState;
  const bar = document.getElementById('grid-map-bar');
  const instruction = document.getElementById('grid-map-instruction');
  const progress = document.getElementById('grid-map-progress');
  const undo = document.getElementById('grid-map-undo');
  const kicker = document.getElementById('grid-map-kicker');
  if (bar) bar.hidden = !state;
  if (!state) return;

  refreshLightingGridMapTargetSelectors();
  if (kicker) kicker.textContent = state.surface === '2d' ? '2D 平面图配置' : '3D 场景配置';
  const segment = getLightingGridMapRouteSegment(state.currentSlot);
  if (instruction) {
    instruction.classList.toggle('error', !!isError);
    instruction.textContent = message || (state.currentSlot
      ? (state.startCell
        ? '已选第 ' + state.startCell.column + ' 列 ' + state.startCell.number + ' 号；请再点同一列的终点'
        : (segment
          ? '已定位：第 ' + segment.column + ' 列 ' + segment.start + '–' + segment.end + ' 号，共 ' + segment.count + ' 盏；点击新起点可重新划分'
          : '该通道还未配置，请点击控制范围的第一盏灯板'))
      : '没有更多可用通道，请完成并返回');
  }
  if (progress) {
    progress.textContent = '当前共 ' + getLightingGridMapCircuitCount() + ' 个回路 · 本次已调整 ' + state.history.length + ' 次' +
      (state.mode === 'rebuild' ? ' · 完成返回后请保存' : ' · 正在重选当前回路');
  }
  if (undo) undo.disabled = state.history.length === 0 && !state.startCell;
}

function activateLightingGridMapMode(state) {
  lightingGridMapState = state;
  const modal = document.getElementById('lights-modal');
  if (modal) modal.classList.remove('show');
  document.body.classList.add('grid-map-active');
  document.body.classList.toggle('grid-map-surface-2d', state.surface === '2d');
  document.body.classList.toggle('grid-map-surface-3d', state.surface !== '2d');
  if (state.surface === '2d' && typeof window.switchTopView === 'function') {
    window.switchTopView('plan');
  } else if (state.surface !== '2d' && typeof topView !== 'undefined' && topView === 'plan' &&
      typeof window.switchTopView === 'function') {
    window.switchTopView('modeling');
  }
  if (typeof scheduleSceneResize === 'function') scheduleSceneResize();
  const pop = document.getElementById('device-pop');
  if (pop) pop.hidden = true;
  if (state.surface !== '2d' && window.BabylonApp && typeof window.BabylonApp.focusLight === 'function') {
    window.BabylonApp.focusLight(null);
  }
  if (state.surface !== '2d' && window.BabylonApp && typeof window.BabylonApp.fitCamera === 'function') {
    requestAnimationFrame(function() {
      window.BabylonApp.fitCamera();
      focusLightingGridMapCurrentSlot();
    });
  }
  updateLightingGridMapBar();
  syncLightingGridMapOverlay();
}

function beginLightingGridMapMode(surface) {
  const grid = getRuntimeLightingGrid();
  if (!grid.enabled) return;
  const targetSurface = surface === '2d' ? '2d' : '3d';
  if (targetSurface === '3d' && (!window.BabylonApp || typeof window.BabylonApp.setGridSelectionOverlay !== 'function')) {
    setNotice('lights-modal-notice', 'warn', '3D 图尚未就绪', '请稍等片刻后再进入图上配置。');
    return;
  }
  refreshLightingGridMapTool();
  const deviceSelect = document.getElementById('lc-map-device');
  const channelInput = document.getElementById('lc-map-channel');
  const groupInput = document.getElementById('lc-map-group');
  const device = getDeviceByIp(deviceSelect && deviceSelect.value);
  if (!device) {
    setNotice('lights-modal-notice', 'warn', '请选择继电器', '需要先选择一个起始继电器设备。');
    return;
  }
  const channel = clamp(parseIntOr(channelInput && channelInput.value, 1), 1, getDeviceChannelCount(device)) - 1;
  const originalLights = editingLights.map(function(light) { return Object.assign({}, light); });
  const sourceLamp = originalLights.find(function(light) { return light.type === 'lamp'; });
  const startSlot = { deviceIp: device.ip, channel: channel };
  if (getLightingGridMapNonLampConflict(startSlot)) {
    setNotice('lights-modal-notice', 'warn', '起始通道已被其他电器占用', '请选择另一个通道后再开始图上配置。');
    return;
  }

  activateLightingGridMapMode({
    active: true,
    surface: targetSurface,
    returnView: typeof topView === 'string' ? topView : 'modeling',
    mode: 'rebuild',
    originalLights: originalLights,
    currentSlot: startSlot,
    startCell: null,
    history: [],
    group: normalizeGroupName(groupInput && groupInput.value) || '车间顶灯',
    scale: clamp(Number(sourceLamp && sourceLamp.scale) || 3, 0.4, 3)
  });
}

function beginLightingGridRoutePick(index, surface) {
  const light = editingLights[index];
  const grid = getRuntimeLightingGrid();
  if (!grid.enabled || !light || light.type !== 'lamp') return;
  const targetSurface = getLightGridArea(light) === LIGHTING_GRID_AREA_EXTENSION || surface === '2d' ||
    (surface !== '3d' && typeof topView !== 'undefined' && topView === 'plan')
    ? '2d'
    : '3d';
  if (targetSurface === '3d' && (!window.BabylonApp || typeof window.BabylonApp.setGridSelectionOverlay !== 'function')) {
    setNotice('lights-modal-notice', 'warn', '3D 图尚未就绪', '请稍等片刻后再在图上重选。');
    return;
  }
  activateLightingGridMapMode({
    active: true,
    surface: targetSurface,
    returnView: typeof topView === 'string' ? topView : 'modeling',
    mode: 'single',
    originalLights: editingLights.map(function(item) { return Object.assign({}, item); }),
    currentSlot: { deviceIp: light.device_ip, channel: Number(light.channel) },
    startCell: null,
    history: [],
    editingIndex: index,
    group: normalizeGroupName(light.group) || '车间顶灯',
    scale: clamp(Number(light.scale) || 3, 0.4, 3)
  });
}

function findLightingGridRangeConflict(area, column, start, end, ignoredIndex) {
  for (let index = 0; index < editingLights.length; index++) {
    if (index === ignoredIndex) continue;
    const segment = getLightingGridSegmentForArea(editingLights[index]);
    if (!segment || segment.area !== area || segment.column !== column) continue;
    if (start <= segment.end && end >= segment.start) {
      return { index: index, segment: segment, light: editingLights[index] };
    }
  }
  return null;
}

function handleLightingGridScenePick(cell) {
  const state = lightingGridMapState;
  if (!state || !state.active || !state.currentSlot || !cell) return false;
  const area = cell.area === LIGHTING_GRID_AREA_EXTENSION
    ? LIGHTING_GRID_AREA_EXTENSION
    : LIGHTING_GRID_AREA_MAIN;
  const grid = getLightingGridForArea(area);
  const column = Number(cell.column);
  const number = Number(cell.number);
  if (!grid || !grid.enabled || !Number.isInteger(column) || !Number.isInteger(number) ||
      column < 1 || column > grid.columns || number < 1 || number > grid.lightsPerColumn) {
    updateLightingGridMapBar('没有点到有效灯板，请重新点击。', true);
    return true;
  }

  if (!state.startCell) {
    state.startCell = { area: area, column: column, number: number };
    updateLightingGridMapBar();
    syncLightingGridMapOverlay();
    return true;
  }

  if (state.startCell.area !== area || state.startCell.column !== column) {
    const startAreaName = state.startCell.area === LIGHTING_GRID_AREA_EXTENSION ? '封箱机区域' : '主车间';
    updateLightingGridMapBar('终点必须与起点在同一区域、同一列；请点击' + startAreaName + '第 ' + state.startCell.column + ' 列的灯板。', true);
    return true;
  }

  const start = Math.min(state.startCell.number, number);
  const end = Math.max(state.startCell.number, number);
  const currentRouteIndex = state.mode === 'single' && Number.isInteger(state.editingIndex)
    ? state.editingIndex
    : findLightingGridMapRouteIndex(state.currentSlot);
  const conflict = findLightingGridRangeConflict(area, column, start, end, currentRouteIndex);
  if (conflict) {
    state.startCell = null;
    updateLightingGridMapBar('该范围与已有第 ' + (conflict.index + 1) + ' 路重叠，请重新选择起点。', true);
    syncLightingGridMapOverlay();
    return true;
  }

  const route = {
    name: (area === LIGHTING_GRID_AREA_EXTENSION ? '封箱机区域' : '') + '第' + column + '列 ' + start + '–' + end + '号',
    type: 'lamp',
    scale: state.scale,
    group: state.group,
    device_ip: state.currentSlot.deviceIp,
    channel: state.currentSlot.channel,
    grid_area: area,
    grid_column: column,
    grid_start: start,
    grid_count: end - start + 1
  };

  let routeIndex = currentRouteIndex;
  const previousRoute = routeIndex >= 0 ? Object.assign({}, editingLights[routeIndex]) : null;
  if (routeIndex >= 0) {
    editingLights[routeIndex] = Object.assign({}, editingLights[routeIndex], route);
  } else {
    routeIndex = editingLights.length;
    editingLights.push(route);
  }
  state.history.push({
    routeIndex: routeIndex,
    slot: Object.assign({}, state.currentSlot),
    before: previousRoute,
    created: !previousRoute
  });
  state.startCell = null;

  if (state.mode === 'single') {
    syncLightingGridMapOverlay();
    finishLightingGridMapMode();
    return true;
  }

  state.currentSlot = findNextLightingGridMapSlot(state.currentSlot);
  updateLightingGridMapBar();
  syncLightingGridMapOverlay();
  focusLightingGridMapCurrentSlot();
  return true;
}

function undoLightingGridMapStep() {
  const state = lightingGridMapState;
  if (!state) return;
  if (state.startCell) {
    state.startCell = null;
    updateLightingGridMapBar('已取消当前起点，请重新选择。');
    syncLightingGridMapOverlay();
    return;
  }
  if (state.mode !== 'rebuild' || !state.history.length) return;
  const last = state.history.pop();
  if (last.created && last.routeIndex >= 0 && last.routeIndex < editingLights.length) {
    editingLights.splice(last.routeIndex, 1);
  } else if (last.before && last.routeIndex >= 0 && last.routeIndex < editingLights.length) {
    editingLights[last.routeIndex] = last.before;
  }
  state.currentSlot = last.slot;
  state.startCell = null;
  updateLightingGridMapBar('已撤销上一段，请重新点击起点。');
  syncLightingGridMapOverlay();
  focusLightingGridMapCurrentSlot();
}

function leaveLightingGridMapMode(restoreOriginal) {
  const state = lightingGridMapState;
  if (!state) return null;
  if (restoreOriginal) {
    editingLights = state.originalLights.map(function(light) { return Object.assign({}, light); });
  }
  lightingGridMapState = null;
  document.body.classList.remove('grid-map-active');
  document.body.classList.remove('grid-map-surface-2d', 'grid-map-surface-3d');
  if (typeof scheduleSceneResize === 'function') scheduleSceneResize();
  const bar = document.getElementById('grid-map-bar');
  if (bar) bar.hidden = true;
  if (window.BabylonApp && typeof window.BabylonApp.clearGridSelectionOverlay === 'function') {
    window.BabylonApp.clearGridSelectionOverlay();
  }
  if (state.returnView && typeof window.switchTopView === 'function') {
    window.switchTopView(state.returnView);
  }
  if (typeof window.syncFlatPlanMapConfiguration === 'function') {
    window.syncFlatPlanMapConfiguration();
  }
  const modal = document.getElementById('lights-modal');
  if (modal) modal.classList.add('show');
  renderLightsConfig();
  syncLightingGridModalUI(getRuntimeLightingGrid());
  return state;
}

function finishLightingGridMapMode() {
  if (lightingGridMapState && lightingGridMapState.startCell) {
    updateLightingGridMapBar('当前只选了起点，请再点同一列的终点，或撤销当前起点。', true);
    return;
  }
  if (lightingGridMapState && lightingGridMapState.mode === 'single' && !lightingGridMapState.history.length) {
    updateLightingGridMapBar('还没有重选范围，请先在灯板图上点选起点和终点。', true);
    return;
  }
  const state = leaveLightingGridMapMode(false);
  if (!state) return;
  lightingGridDetailsOpen = false;
  syncLightingGridModalUI(getRuntimeLightingGrid());
  if (state.mode === 'rebuild' && !state.history.length) {
    setNotice('lights-modal-notice', 'warn', '未修改回路配置', '已返回配置页，现有灯板回路保持不变。');
    return;
  }
  setNotice('lights-modal-notice', 'success', state.mode === 'single' ? '回路范围已更新' : '图上划分已完成',
    (state.mode === 'single' ? '已按图上选择更新该开关范围。' : '本次已完成 ' + state.history.length + ' 次范围调整。') +
    ' 当前仍是草稿，请点击“保存”后生效。');
}

function cancelLightingGridMapMode() {
  const state = leaveLightingGridMapMode(true);
  if (!state) return;
  setNotice('lights-modal-notice', 'warn', '已取消图上配置', '未保存本次图上选择，原有回路配置已恢复。');
}

document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape' && isLightingGridMapModeActive()) {
    event.preventDefault();
    cancelLightingGridMapMode();
  }
});

// 刷新"顺序绑定继电器"工具的设备下拉与默认编号范围
function refreshBindToolUI() {
  const deviceSelect = document.getElementById('lc-bind-device');
  if (deviceSelect) {
    const prev = deviceSelect.value;
    deviceSelect.innerHTML = config.devices.map(function(device) {
      return '<option value="' + escapeHtml(device.ip) + '">' +
        escapeHtml((device.name || device.ip) + ' · ' + getDeviceChannelCount(device) + '路') + '</option>';
    }).join('');
    if (prev && config.devices.some(function(d) { return d.ip === prev; })) deviceSelect.value = prev;
  }
  const total = editingLights.length;
  const fromInput = document.getElementById('lc-bind-from');
  const toInput = document.getElementById('lc-bind-to');
  if (fromInput && !fromInput.value) fromInput.value = total ? 1 : '';
  if (toInput && !toInput.value) toInput.value = total || '';
}

function hideLightsModal() {
  clearNotice('lights-modal-notice');
  document.getElementById('lights-modal').classList.remove('show');
}

function renderLightGroupSuggestions() {
  const datalist = document.getElementById('light-group-options');
  if (!datalist) return;
  datalist.innerHTML = '';

  const keys = [];
  const used = new Set();
  editingLights.forEach(function(light) {
    const key = normalizeGroupName(light.group);
    if (key && !used.has(key)) {
      used.add(key);
      keys.push(key);
    }
  });
  getKnownGroupKeys(true).forEach(function(key) {
    if (key === UNGROUPED_GROUP_KEY || used.has(key)) return;
    used.add(key);
    keys.push(key);
  });

  keys.forEach(function(groupName) {
    const option = document.createElement('option');
    option.value = groupName;
    datalist.appendChild(option);
  });
}

function renderLightsConfig() {
  const el = document.getElementById('lc-list');
  const lightingGrid = getRuntimeLightingGrid();
  el.innerHTML = '';
  renderLightGroupSuggestions();
  if (editingLights.length === 0) {
    el.innerHTML = '<div class="empty-tip">点击下方按钮，开始配置电器。</div>';
    syncLightingGridModalUI(lightingGrid);
    return;
  }

  editingLights.forEach(function(light, index) {
    const row = document.createElement('div');
    row.className = 'lc-row';
    row.id = 'light-config-row-' + index;
    let deviceOptions = '';
    config.devices.forEach(function(device) {
      deviceOptions += '<option value="' + escapeHtml(device.ip) + '"' +
        (light.device_ip === device.ip ? ' selected' : '') + '>' +
        escapeHtml(device.name) + '</option>';
    });

    const selectedDevice = getDeviceByIp(light.device_ip) || config.devices[0] || null;
    const channelCount = Math.max(getDeviceChannelCount(selectedDevice), parseIntOr(light.channel, 0) + 1);
    let channelOptions = '';
    for (let channel = 0; channel < channelCount; channel++) {
      channelOptions += '<option value="' + channel + '"' +
        (light.channel === channel ? ' selected' : '') +
        '>通道' + String(channel + 1).padStart(2, '0') + '</option>';
    }

    const hasScenePos = Number.isFinite(light.x) && Number.isFinite(light.z);
    const posText = hasScenePos
      ? '场景位置：X ' + formatNum(light.x) + ' / Z ' + formatNum(light.z)
      : '场景位置：按设备分组自动排布';
    const extensionGrid = getRuntimeExtensionLightingGrid();
    const gridArea = getLightGridArea(light);
    const activeGrid = getLightingGridForArea(gridArea);
    const showGridSegment = light.type === 'lamp' && (lightingGrid.enabled || extensionGrid.enabled);
    const gridSegment = getLightingGridSegmentForArea(light);
    const gridColumnValue = Number.isInteger(Number(light.grid_column)) ? Number(light.grid_column) : '';
    const gridStartValue = Number.isInteger(Number(light.grid_start)) ? Number(light.grid_start) : '';
    const gridCountValue = Number.isInteger(Number(light.grid_count)) ? Number(light.grid_count) : '';
    const gridEndValue = Number.isInteger(gridStartValue) && Number.isInteger(gridCountValue)
      ? gridStartValue + gridCountValue - 1
      : '';
    row.innerHTML =
      '<span class="lc-idx" title="电器编号">' + (index + 1) + '</span>' +
      '<input class="lc-name" type="text" placeholder="电器名称" value="' + escapeHtml(light.name || '') + '">' +
      '<select class="lc-type">' + getTypeOptionsHtml(light.type) + '</select>' +
      '<input class="lc-size" type="number" min="0.4" max="3" step="0.1" value="' + light.scale + '" title="模型缩放">' +
      '<input class="lc-group" type="text" list="light-group-options" placeholder="分组名称" value="' + escapeHtml(normalizeGroupName(light.group)) + '">' +
      '<select class="lc-dev">' + deviceOptions + '</select>' +
      '<select class="lc-ch">' + channelOptions + '</select>' +
      '<button class="lc-del" title="删除">x</button>';

    const nameInput = row.querySelector('.lc-name');
    const typeInput = row.querySelector('.lc-type');
    const sizeInput = row.querySelector('.lc-size');
    const groupInput = row.querySelector('.lc-group');
    const deviceInput = row.querySelector('.lc-dev');
    const channelInput = row.querySelector('.lc-ch');
    const extra = document.createElement('div');
    extra.className = 'lc-row-extra' + (showGridSegment ? ' has-grid-segment' : '');
    extra.innerHTML =
      (showGridSegment
        ? '<div class="lc-grid-segment-editor">' +
            '<div class="lc-grid-segment-title">' + escapeHtml(formatLightingGridSegment(gridSegment)) + '</div>' +
            '<label class="lc-grid-segment-field">区域' +
              '<select class="lc-grid-area" aria-label="灯板区域">' +
                '<option value="main"' + (gridArea === LIGHTING_GRID_AREA_MAIN ? ' selected' : '') + '>主车间</option>' +
                (extensionGrid.enabled
                  ? '<option value="extension"' + (gridArea === LIGHTING_GRID_AREA_EXTENSION ? ' selected' : '') + '>封箱机区域</option>'
                  : '') +
              '</select></label>' +
            '<label class="lc-grid-segment-field">列号' +
              '<input class="lc-grid-column" type="number" min="1" max="' + activeGrid.columns + '" step="1" value="' + gridColumnValue + '" aria-label="灯板列号"></label>' +
            '<label class="lc-grid-segment-field">起始号' +
              '<input class="lc-grid-start" type="number" min="1" max="' + activeGrid.lightsPerColumn + '" step="1" value="' + gridStartValue + '" aria-label="灯板起始号"></label>' +
            '<label class="lc-grid-segment-field">结束号' +
              '<input class="lc-grid-end" type="number" min="' + (gridStartValue || 1) + '" max="' + activeGrid.lightsPerColumn + '" step="1" value="' + gridEndValue + '" aria-label="灯板结束号"></label>' +
            '<span class="lc-grid-count-summary">共 ' + (gridCountValue || '—') + ' 盏</span>' +
            '<button type="button" class="lc-place lc-grid-pick">在图上重选</button>' +
          '</div>'
        : '') +
      (showGridSegment
        ? ''
        : '<div class="lc-pos">' + escapeHtml(posText) + '</div>' +
          '<button type="button" class="lc-place pick">场景取点</button>' +
          (hasScenePos ? '<button type="button" class="lc-place reset">恢复自动排布</button>' : ''));
    row.appendChild(extra);

    nameInput.oninput = function() { editingLights[index].name = nameInput.value; };
    typeInput.onchange = function() {
      const hadAutoName = isAutoName(editingLights[index].name);
      editingLights[index].type = typeInput.value;
      if (hadAutoName) {
        editingLights[index].name = getSuggestedLightName(typeInput.value);
        nameInput.value = editingLights[index].name;
      }
      if (lightingGrid.enabled) {
        if (typeof assignLightingGridSegments === 'function') {
          const assigned = assignLightingGridSegments(editingLights, lightingGrid);
          if (Array.isArray(assigned)) editingLights = assigned.map(normalizeLight);
        }
        renderLightsConfig();
      }
    };
    sizeInput.oninput = function() {
      editingLights[index].scale = clamp(Number(sizeInput.value) || editingLights[index].scale || 1, 0.4, 3);
    };
    groupInput.oninput = function() {
      editingLights[index].group = normalizeGroupName(groupInput.value);
      renderLightGroupSuggestions();
    };
    deviceInput.onchange = function() {
      editingLights[index].device_ip = deviceInput.value;
      const nextDevice = getDeviceByIp(deviceInput.value);
      const nextChannelCount = getDeviceChannelCount(nextDevice);
      if (editingLights[index].channel >= nextChannelCount) {
        editingLights[index].channel = Math.max(0, nextChannelCount - 1);
      }
      renderLightsConfig();
    };
    channelInput.onchange = function() {
      editingLights[index].channel = parseInt(channelInput.value, 10);
    };
    const gridAreaInput = extra.querySelector('.lc-grid-area');
    const gridColumnInput = extra.querySelector('.lc-grid-column');
    const gridStartInput = extra.querySelector('.lc-grid-start');
    const gridEndInput = extra.querySelector('.lc-grid-end');
    const gridCountSummary = extra.querySelector('.lc-grid-count-summary');
    const gridSegmentTitle = extra.querySelector('.lc-grid-segment-title');
    if (gridAreaInput) {
      gridAreaInput.onchange = function() {
        const nextArea = gridAreaInput.value === LIGHTING_GRID_AREA_EXTENSION
          ? LIGHTING_GRID_AREA_EXTENSION
          : LIGHTING_GRID_AREA_MAIN;
        const nextGrid = getLightingGridForArea(nextArea);
        editingLights[index].grid_area = nextArea;
        editingLights[index].grid_column = clampInteger(editingLights[index].grid_column, 1, 1, nextGrid.columns);
        editingLights[index].grid_start = 1;
        editingLights[index].grid_count = Math.min(
          Math.max(1, clampInteger(editingLights[index].grid_count, nextGrid.lightsPerColumn, 1, nextGrid.lightsPerColumn)),
          nextGrid.lightsPerColumn
        );
        renderLightsConfig();
      };
    }
    if (gridColumnInput && gridStartInput && gridEndInput) {
      const refreshGridSegmentEditor = function() {
        const nextColumn = parseInt(gridColumnInput.value, 10);
        const nextStart = parseInt(gridStartInput.value, 10);
        const nextEnd = parseInt(gridEndInput.value, 10);
        const nextCount = Number.isFinite(nextStart) && Number.isFinite(nextEnd) && nextEnd >= nextStart
          ? nextEnd - nextStart + 1
          : NaN;
        editingLights[index].grid_column = Number.isFinite(nextColumn) ? nextColumn : NaN;
        editingLights[index].grid_start = Number.isFinite(nextStart) ? nextStart : NaN;
        editingLights[index].grid_count = Number.isFinite(nextCount) ? nextCount : NaN;
        gridEndInput.min = String(Number.isFinite(nextStart) ? Math.max(1, nextStart) : 1);
        if (gridCountSummary) gridCountSummary.textContent = '共 ' + (Number.isFinite(nextCount) ? nextCount : '—') + ' 盏';
        if (gridSegmentTitle) {
          gridSegmentTitle.textContent = formatLightingGridSegment(getLightingGridSegmentForArea(editingLights[index]));
        }
        row.classList.remove('grid-invalid');
      };
      gridColumnInput.oninput = refreshGridSegmentEditor;
      gridStartInput.oninput = refreshGridSegmentEditor;
      gridEndInput.oninput = refreshGridSegmentEditor;
    }
    const gridPickBtn = extra.querySelector('.lc-grid-pick');
    if (gridPickBtn) gridPickBtn.onclick = function() { beginLightingGridRoutePick(index); };
    const pickBtn = extra.querySelector('.lc-place.pick');
    if (pickBtn) {
      pickBtn.onclick = function() {
        startLightPlacement(index);
      };
    }
    const resetBtn = extra.querySelector('.lc-place.reset');
    if (resetBtn) {
      resetBtn.onclick = function() {
        delete editingLights[index].x;
        delete editingLights[index].z;
        renderLightsConfig();
      };
    }
    row.querySelector('.lc-del').onclick = function() {
      editingLights.splice(index, 1);
      renderLightsConfig();
    };
    el.appendChild(row);
  });
  syncLightingGridModalUI(lightingGrid);
}

function addLight() {
  if (config.devices.length === 0) {
    showToast('warn', '还没有设备', '创建电器前，请先添加一台控制设备。');
    return;
  }

  const defaultDevice = config.devices[0];
  const usedChannels = new Set(editingLights
    .filter(function(light) { return light.device_ip === defaultDevice.ip; })
    .map(function(light) { return light.channel; }));
  let channel = 0;
  const channelCount = getDeviceChannelCount(defaultDevice);
  for (let index = 0; index < channelCount; index++) {
    if (!usedChannels.has(index)) {
      channel = index;
      break;
    }
  }

  editingLights.push({
    name: getSuggestedLightName(DEFAULT_ITEM_TYPE),
    type: DEFAULT_ITEM_TYPE,
    scale: 1,
    group: normalizeGroupName(editingLights[editingLights.length - 1] && editingLights[editingLights.length - 1].group),
    device_ip: defaultDevice.ip,
    channel: channel
  });
  const lightingGrid = getRuntimeLightingGrid();
  if (lightingGrid.enabled && typeof assignLightingGridSegments === 'function') {
    const assigned = assignLightingGridSegments(editingLights, lightingGrid);
    if (Array.isArray(assigned)) editingLights = assigned.map(normalizeLight);
  }
  renderLightsConfig();
}

// 收集所有设备上仍空闲的通道 (按设备顺序), 最多 limit 个
function collectFreeChannelSlots(limit) {
  const used = {};
  editingLights.forEach(function(light) {
    if (!used[light.device_ip]) used[light.device_ip] = {};
    used[light.device_ip][light.channel] = true;
  });
  const slots = [];
  for (let di = 0; di < config.devices.length; di++) {
    const device = config.devices[di];
    const channelCount = getDeviceChannelCount(device);
    const usedSet = used[device.ip] || {};
    for (let ch = 0; ch < channelCount; ch++) {
      if (!usedSet[ch]) {
        slots.push({ device_ip: device.ip, channel: ch });
        if (slots.length >= limit) return slots;
      }
    }
  }
  return slots;
}

function readBatchInt(id, fallback, min, max) {
  const node = document.getElementById(id);
  let value = node ? parseInt(node.value, 10) : NaN;
  if (!Number.isFinite(value)) value = fallback;
  return clamp(Math.round(value), min, max);
}

// 读取可空的整数输入: 留空或非正数返回 0 (表示"自动")
function readBatchOptionalInt(id, min, max) {
  const node = document.getElementById(id);
  const raw = node ? String(node.value).trim() : '';
  if (!raw) return 0;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return clamp(value, min, max);
}

// 批量排布电器: 按"总数"在车间可用区域内生成对齐、均匀的网格。
// 每排数量可手动指定; 留空则按车间宽深比自动取近似方格, 保证几百个也均匀不挤成一团。
function addLightRow() {
  const lightingGrid = getRuntimeLightingGrid();
  if (lightingGrid.enabled) {
    setNotice('lights-modal-notice', 'warn', '网格模式按控制回路配置',
      lightingGrid.columns + ' × ' + lightingGrid.lightsPerColumn + ' 是物理灯板数量，不应生成 ' +
      (lightingGrid.columns * lightingGrid.lightsPerColumn) + ' 个继电器回路。请使用“添加一个控制回路”，并在回路行内填写连续灯板范围。');
    return;
  }
  if (config.devices.length === 0) {
    showToast('warn', '还没有设备', '批量摆放电器前, 请先添加一台控制设备。');
    return;
  }

  const requested = readBatchInt('lc-batch-count', 8, 1, 1000);
  const colsOverride = readBatchOptionalInt('lc-batch-percol', 1, 200);
  const typeSelect = document.getElementById('lc-batch-type');
  const type = typeSelect && ITEM_TYPES[typeSelect.value] ? typeSelect.value : DEFAULT_ITEM_TYPE;
  const groupInput = document.getElementById('lc-batch-group');
  const group = normalizeGroupName(groupInput ? groupInput.value : '');

  const slots = collectFreeChannelSlots(requested);
  if (slots.length === 0) {
    setNotice('lights-modal-notice', 'warn', '通道已用尽', '所有设备的通道都已被占用, 无法再批量添加电器。');
    return;
  }
  const makeCount = Math.min(requested, slots.length);

  // 车间内可用区域 (四周留边距, 不贴墙)
  const edgeX = clamp(BUILDING.width * 0.06, 3 * SCALE, 9 * SCALE);
  const edgeZ = clamp(BUILDING.depth * 0.08, 2.5 * SCALE, 7 * SCALE);
  const usableW = Math.max(2, BUILDING.width - edgeX * 2);
  const usableD = Math.max(2, BUILDING.depth - edgeZ * 2);

  // 列数: 优先用户指定; 否则按可用区域的宽深比自动取近似方格, 让横向/纵向间隔都尽量均匀
  let cols = colsOverride > 0
    ? colsOverride
    : Math.round(Math.sqrt(makeCount * (usableW / usableD)));
  cols = clamp(cols || 1, 1, makeCount);
  const rows = Math.ceil(makeCount / cols);

  // 等距网格: 所有灯都落在同样的列/排坐标上; 最后一排不满时仍对齐到相同的列, 保持整齐
  const xPitch = cols > 1 ? usableW / (cols - 1) : 0;
  const zPitch = rows > 1 ? usableD / (rows - 1) : 0;
  const x0 = cols > 1 ? -usableW / 2 : 0;
  const z0 = rows > 1 ? -usableD / 2 : 0;

  const baseLabel = group || getItemMeta(type).label;
  const startNo = editingLights.length + 1;

  for (let made = 0; made < makeCount; made++) {
    const r = Math.floor(made / cols);
    const c = made % cols;
    const slot = slots[made];
    const point = clampFloorPoint({ x: x0 + c * xPitch, z: z0 + r * zPitch });
    const light = {
      name: baseLabel + ' ' + (startNo + made),
      type: type,
      scale: 1,
      device_ip: slot.device_ip,
      channel: slot.channel,
      x: Math.round(point.x * 100) / 100,
      z: Math.round(point.z * 100) / 100
    };
    if (group) light.group = group;
    editingLights.push(light);
  }

  renderLightsConfig();

  const gridText = cols + ' 列 × ' + rows + ' 排';
  const minPitch = Math.min(xPitch || Infinity, zPitch || Infinity);
  const denseHint = (minPitch !== Infinity && minPitch < 12)
    ? ' 数量较多、间隔已偏密, 如仍觉拥挤可调大车间尺寸或分批放置。'
    : '';
  if (makeCount < requested) {
    setNotice('lights-modal-notice', 'warn', '已部分生成',
      '可用通道只够添加 ' + makeCount + ' / ' + requested + ' 个, 已按 ' + gridText + ' 均匀对齐排布, 保存后生效。' + denseHint);
  } else {
    clearNotice('lights-modal-notice');
    showToast('success', '已批量排布',
      '新增 ' + makeCount + ' 个' + getItemMeta(type).label + ' (' + gridText + '), 已自动对齐、均匀间隔, 保存后生效。' + denseHint);
  }
}

// 按编号范围把电器顺序绑定到某个继电器: 编号 from..to 依次占用该设备 startChannel 起的通道
function bindLightRange() {
  if (!editingLights.length) {
    setNotice('lights-modal-notice', 'warn', '没有可绑定的电器', '请先添加或批量生成电器, 再做顺序绑定。');
    return;
  }
  if (config.devices.length === 0) {
    showToast('warn', '还没有设备', '请先添加一台继电器设备。');
    return;
  }

  const total = editingLights.length;
  let from = readBatchInt('lc-bind-from', 1, 1, total);
  let to = readBatchInt('lc-bind-to', total, 1, total);
  if (from > to) { const tmp = from; from = to; to = tmp; }

  const deviceSelect = document.getElementById('lc-bind-device');
  const deviceIp = deviceSelect && deviceSelect.value ? deviceSelect.value : (config.devices[0] && config.devices[0].ip);
  const device = getDeviceByIp(deviceIp);
  if (!device) {
    setNotice('lights-modal-notice', 'warn', '请选择目标继电器', '请先在下拉里选择要绑定的继电器设备。');
    return;
  }
  const channelCount = getDeviceChannelCount(device);
  // 输入框是 1 基(与界面"通道01"一致), 内部通道是 0 基
  const startChannel = readBatchInt('lc-bind-start', 1, 1, channelCount) - 1;

  let bound = 0;
  let overflow = 0;
  for (let n = 0; n < (to - from + 1); n++) {
    const channel = startChannel + n;
    if (channel >= channelCount) { overflow += 1; continue; }
    const light = editingLights[(from - 1) + n];
    light.device_ip = deviceIp;
    light.channel = channel;
    bound += 1;
  }

  renderLightsConfig();
  refreshBindToolUI();

  // 绑定后检测整组是否出现"同设备同通道"冲突 (比如和范围外已有的电器撞了)
  const seen = {};
  let conflicts = 0;
  editingLights.forEach(function(light) {
    const key = light.device_ip + '#' + light.channel;
    if (seen[key]) conflicts += 1;
    seen[key] = true;
  });
  const conflictHint = conflicts > 0
    ? ' 注意: 当前有 ' + conflicts + ' 处"同设备同通道"冲突, 保存前请调整(换通道或换设备)。'
    : '';

  const deviceLabel = device.name || deviceIp;
  if (overflow > 0) {
    setNotice('lights-modal-notice', 'warn', '已绑定(部分超出容量)',
      '已把编号 ' + from + '–' + (from + bound - 1) + ' 顺序绑定到「' + deviceLabel + '」通道 ' + (startChannel + 1) +
      ' 起; 还有 ' + overflow + ' 个超出该设备的 ' + channelCount + ' 路, 请改绑到下一块继电器。' + conflictHint);
  } else if (conflicts > 0) {
    setNotice('lights-modal-notice', 'warn', '已绑定(有通道冲突)',
      '编号 ' + from + '–' + to + ' 已绑定到「' + deviceLabel + '」通道 ' + (startChannel + 1) + '–' + (startChannel + bound) + '。' + conflictHint);
  } else {
    clearNotice('lights-modal-notice');
    showToast('success', '已顺序绑定',
      '编号 ' + from + '–' + to + ' 已按顺序绑定到「' + deviceLabel + '」, 通道 ' + (startChannel + 1) + '–' + (startChannel + bound) + '。保存后生效。');
  }
}

function focusLightingGridValidationError(error) {
  if (!error || !Number.isInteger(error.index)) return;
  if (getRuntimeLightingGrid().enabled) toggleLightingGridDetails(true);
  const row = document.getElementById('light-config-row-' + error.index);
  if (!row) return;
  row.classList.add('grid-invalid');
  if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const input = error.selector ? row.querySelector(error.selector) : null;
  if (input && typeof input.focus === 'function') input.focus();
}

function validateLightingGridAssignments(lights, lightingGrid) {
  if (!lightingGrid.enabled) return null;
  const byColumn = new Map();

  for (let index = 0; index < lights.length; index++) {
    const light = lights[index];
    if (!light || light.type !== 'lamp') continue;
    const area = getLightGridArea(light);
    const targetGrid = area === LIGHTING_GRID_AREA_EXTENSION
      ? getRuntimeExtensionLightingGrid()
      : lightingGrid;
    const areaLabel = area === LIGHTING_GRID_AREA_EXTENSION ? '封箱机区域' : '主车间';
    if (!targetGrid.enabled) {
      return {
        index: index,
        selector: '.lc-grid-area',
        title: '灯板区域未启用',
        body: '第 ' + (index + 1) + ' 个灯回路属于' + areaLabel + '，但该区域当前未启用。'
      };
    }
    const column = Number(light.grid_column);
    const start = Number(light.grid_start);
    const count = Number(light.grid_count);

    if (!Number.isInteger(column) || column < 1 || column > targetGrid.columns) {
      return {
        index: index,
        selector: '.lc-grid-column',
        title: '灯板列号超出范围',
        body: '第 ' + (index + 1) + ' 个灯回路（' + areaLabel + '）的列号必须是 1–' + targetGrid.columns + ' 之间的整数。'
      };
    }
    if (!Number.isInteger(start) || start < 1 || start > targetGrid.lightsPerColumn) {
      return {
        index: index,
        selector: '.lc-grid-start',
        title: '灯板起始号超出范围',
        body: '第 ' + (index + 1) + ' 个灯回路（' + areaLabel + '）的起始号必须是 1–' + targetGrid.lightsPerColumn + ' 之间的整数。'
      };
    }
    if (!Number.isInteger(count) || count < 1) {
      return {
        index: index,
        selector: '.lc-grid-end',
        title: '结束号无效',
        body: '第 ' + (index + 1) + ' 个灯回路的结束号不能早于起始号。'
      };
    }

    const end = start + count - 1;
    if (end > targetGrid.lightsPerColumn) {
      return {
        index: index,
        selector: '.lc-grid-end',
        title: '灯板号码超出本列',
        body: '第 ' + (index + 1) + ' 个灯回路会覆盖第 ' + column + ' 列 ' + start + '–' + end +
          ' 号，但' + areaLabel + '每列只有 ' + targetGrid.lightsPerColumn + ' 块灯板。请调整结束号或起始号。'
      };
    }

    light.grid_column = column;
    light.grid_start = start;
    light.grid_count = count;
    light.grid_area = area;
    const columnKey = area + '#' + column;
    if (!byColumn.has(columnKey)) byColumn.set(columnKey, []);
    byColumn.get(columnKey).push({ index: index, area: area, column: column, start: start, end: end });
  }

  for (const intervals of byColumn.values()) {
    intervals.sort(function(a, b) { return a.start - b.start || a.end - b.end; });
    let occupied = intervals[0] || null;
    const areaLabel = occupied && occupied.area === LIGHTING_GRID_AREA_EXTENSION ? '封箱机区域' : '主车间';
    const column = occupied ? occupied.column : 0;
    for (let position = 1; position < intervals.length; position++) {
      const current = intervals[position];
      if (occupied && current.start <= occupied.end) {
        return {
          index: current.index,
          selector: '.lc-grid-start',
          title: '同列灯板范围重叠',
          body: '第 ' + (current.index + 1) + ' 个灯回路（' + areaLabel + '第' + column + '列 ' + current.start + '–' + current.end +
            '号）与第 ' + (occupied.index + 1) + ' 个回路重叠。同一列可以留空，但同一块灯板不能属于两个回路。'
        };
      }
      if (!occupied || current.end > occupied.end) occupied = current;
    }
  }
  return null;
}

async function saveLights() {
  clearNotice('lights-modal-notice');
  const seen = {};
  for (const light of editingLights) {
    const key = light.device_ip + '#' + light.channel;
    if (seen[key]) {
      setNotice('lights-modal-notice', 'warn', '通道冲突', '同一台设备的同一个通道不能同时绑定多个电器。');
      return;
    }
    seen[key] = true;
  }

  const lightingGrid = getRuntimeLightingGrid();
  document.querySelectorAll('#lc-list .lc-row.grid-invalid').forEach(function(row) {
    row.classList.remove('grid-invalid');
  });
  const gridError = validateLightingGridAssignments(editingLights, lightingGrid);
  if (gridError) {
    setNotice('lights-modal-notice', 'warn', gridError.title, gridError.body);
    focusLightingGridValidationError(gridError);
    return;
  }

  const previousLights = config.lights;
  config.lights = editingLights.map(function(light) {
    const next = {
      name: light.name || getSuggestedLightName(light.type),
      type: ITEM_TYPES[light.type] ? light.type : DEFAULT_ITEM_TYPE,
      scale: clamp(Number(light.scale) || 1, 0.4, 3),
      device_ip: light.device_ip,
      channel: parseInt(light.channel, 10)
    };
    if (normalizeGroupName(light.group)) next.group = normalizeGroupName(light.group);
    if (typeof light.x === 'number') next.x = light.x;
    if (typeof light.z === 'number') next.z = light.z;
    if (next.type === 'lamp') {
      if (getLightGridArea(light) === LIGHTING_GRID_AREA_EXTENSION) next.grid_area = LIGHTING_GRID_AREA_EXTENSION;
      ['grid_column', 'grid_start', 'grid_count'].forEach(function(field) {
        const value = Number(light[field]);
        if (Number.isInteger(value)) next[field] = value;
      });
    }
    return next;
  });

  clampLightPositionsToBuilding();
  let result;
  try {
    result = await saveConfigData();
  } catch (error) {
    config.lights = previousLights;
    setNotice('lights-modal-notice', 'error', '保存失败', getFriendlyMessage(getErrorMessage(error, '未知错误'), 'save'));
    return;
  }
  if (!result || !result.ok) {
    config.lights = previousLights;
    setNotice('lights-modal-notice', 'error', '保存失败', getFriendlyMessage((result && result.error) || '未知错误', 'save'));
    return;
  }
  hideLightsModal();
  renderLightRows();
  rebuildLamps();
  applyStatus();
  showToast('success', lightingGrid.enabled ? '灯板回路已保存' : '电器已保存',
    lightingGrid.enabled ? '灯板区段、继电器绑定和分组更新已生效。' : '绑定、分组和摆放更新已生效。');
}

async function applyLightAssignments(assignments, options) {
  if (rejectControlDuringLightingGridMap()) return { ok: false, blocked: true };
  const opts = Object.assign({
    title: '操作已完成',
    successBody: '目标通道已更新。',
    emptyBody: '这次操作没有找到可执行的通道。'
  }, options || {});

  const deduped = new Map();
  (assignments || []).forEach(function(item) {
    if (!item || !item.device_ip || !Number.isFinite(item.channel)) return;
    deduped.set(item.device_ip + '#' + item.channel, item);
  });

  const targets = Array.from(deduped.values());
  if (targets.length === 0) {
    showToast('warn', opts.title, opts.emptyBody);
    return { ok: false, skipped: true };
  }

  const failures = [];
  let applied = 0;
  let skippedOffline = 0;
  const executionTargets = targets.map(function(target) {
    const status = deviceStatus[target.device_ip];
    return {
      target: target,
      status: status,
      connected: !!(status && status.connected),
      current: !!(status && status.relay_states && status.relay_states[target.channel])
    };
  });

  beginRuntimeOperation();
  try {
    for (const executionTarget of executionTargets) {
      const target = executionTarget.target;
      const status = executionTarget.status;
      if (!executionTarget.connected) {
        skippedOffline += 1;
        continue;
      }

      if (executionTarget.current === target.value) continue;

      try {
        const result = await api('/api/toggle', 'POST', {
          ip: target.device_ip,
          channel: target.channel,
          value: target.value
        });
        if (!result.ok) {
          throw new Error(result.error || '未知错误');
        }
        if (!Array.isArray(status.relay_states)) status.relay_states = [];
        status.relay_states[target.channel] = target.value;
        applied += 1;
      } catch (error) {
        failures.push({
          target: target,
          error: getFriendlyMessage(getErrorMessage(error, '未知错误'), 'control')
        });
      }
    }
  } finally {
    endRuntimeOperation();
  }

  applyStatus();
  scheduleStatusPoll(200);

  if (failures.length > 0) {
    showToast(
      'error',
      opts.title,
      '已更新 ' + applied + ' 个通道，但有 ' + failures.length + ' 个失败，另有 ' + skippedOffline + ' 个离线通道被跳过。'
    );
    return { ok: false, applied: applied, failures: failures, skippedOffline: skippedOffline };
  }

  showToast(
    skippedOffline > 0 ? 'warn' : 'success',
    opts.title,
    opts.successBody + (skippedOffline > 0 ? ' 已跳过 ' + skippedOffline + ' 个离线通道。' : '')
  );
  return { ok: true, applied: applied, skippedOffline: skippedOffline };
}

function applyGroupState(groupKey, value) {
  const assignments = (config.lights || [])
    .filter(function(light) {
      return getLightGroupKey(light) === groupKey;
    })
    .map(function(light) {
      return {
        device_ip: light.device_ip,
        channel: light.channel,
        value: value
      };
    });

  return applyLightAssignments(assignments, {
    title: getGroupLabel(groupKey),
    successBody: '分组操作已执行。'
  });
}

function applyScene(sceneIndex) {
  const scene = config.scenes && config.scenes[sceneIndex];
  if (!scene) return Promise.resolve({ ok: false });

  const states = scene.states || {};
  const deviceStates = scene.deviceStates || {};
  const lightStates = scene.lightStates || {};
  const assignments = [];
  (config.lights || []).forEach(function(light, idx) {
    // 优先级: 单独选灯(稳定设备+通道；兼容旧编号) > 按继电器 > 按分组
    const stableKey = getLightStateKey(light);
    let state = stableKey ? lightStates[stableKey] : null;
    if (state !== 'on' && state !== 'off') state = lightStates[String(idx + 1)];
    if (state !== 'on' && state !== 'off') state = deviceStates[light.device_ip];
    if (state !== 'on' && state !== 'off') state = states[getLightGroupKey(light)];
    if (state !== 'on' && state !== 'off') return;
    assignments.push({
      device_ip: light.device_ip,
      channel: light.channel,
      value: state === 'on'
    });
  });

  return applyLightAssignments(assignments, {
    title: scene.name,
    successBody: '场景预设已应用。',
    emptyBody: '当前场景没有命中任何电器。'
  });
}

function showScenesModal() {
  if ((config.lights || []).length === 0 && (!config.scenes || config.scenes.length === 0)) {
    showToast('warn', '还没有电器', '创建场景预设前，请先绑定电器。');
    return;
  }
  clearNotice('scenes-modal-notice');
  editingScenes = (config.scenes || []).map(normalizeScene);
  renderScenesConfig();
  document.getElementById('scenes-modal').classList.add('show');
}

function hideScenesModal() {
  clearNotice('scenes-modal-notice');
  document.getElementById('scenes-modal').classList.remove('show');
}

// 解析编号范围字符串, 如 "1-10, 15, 20-25" -> [1..10,15,20..25] (1 基, 去重, 限定 1..max)
function parseSceneNumberRanges(str, max) {
  const out = new Set();
  String(str || '').split(/[,，;；\s]+/).forEach(function(part) {
    if (!part) return;
    const seg = part.split(/[-–~～]/);
    if (seg.length === 2) {
      let a = parseInt(seg[0], 10);
      let b = parseInt(seg[1], 10);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        if (a > b) { const t = a; a = b; b = t; }
        for (let i = a; i <= b; i++) if (i >= 1 && i <= max) out.add(i);
      }
    } else {
      const n = parseInt(part, 10);
      if (Number.isFinite(n) && n >= 1 && n <= max) out.add(n);
    }
  });
  return Array.from(out).sort(function(a, b) { return a - b; });
}

// 渲染某个场景"单独选灯"的已选标签
function renderSceneLightChips(sceneIndex, container) {
  const scene = editingScenes[sceneIndex];
  if (!scene || !container) return;
  const lightStates = scene.lightStates || {};
  container.innerHTML = '';
  const keys = Object.keys(lightStates);
  if (keys.length === 0) {
    container.innerHTML = '<span class="scene-ind-empty">未单独指定灯泡</span>';
    return;
  }
  const lights = config.lights || [];
  const resolveLight = function(key) {
    if (/^\d+$/.test(key)) {
      const legacyNumber = parseInt(key, 10);
      return { light: lights[legacyNumber - 1] || null, number: legacyNumber };
    }
    const index = lights.findIndex(function(light) { return getLightStateKey(light) === key; });
    return { light: index >= 0 ? lights[index] : null, number: index >= 0 ? index + 1 : null };
  };
  keys.sort(function(a, b) {
    const left = resolveLight(a).number;
    const right = resolveLight(b).number;
    if (left == null && right == null) return a.localeCompare(b);
    if (left == null) return 1;
    if (right == null) return -1;
    return left - right;
  });
  keys.forEach(function(key) {
    const stateVal = lightStates[key];
    const resolved = resolveLight(key);
    const light = resolved.light;
    const label = light
      ? ('#' + resolved.number + ' ' + (light.name || '') + ' · ' + light.device_ip + '/CH' + (Number(light.channel) + 1))
      : key;
    const chip = document.createElement('span');
    chip.className = 'scene-ind-chip ' + (stateVal === 'on' ? 'on' : 'off');
    chip.innerHTML = '<span class="scene-ind-chip-txt">' + escapeHtml(label) + ' · ' + (stateVal === 'on' ? '开' : '关') + '</span>' +
      '<button type="button" title="移除">×</button>';
    chip.querySelector('button').addEventListener('click', function() {
      delete editingScenes[sceneIndex].lightStates[key];
      renderSceneLightChips(sceneIndex, container);
    });
    container.appendChild(chip);
  });
}

function renderScenesConfig() {
  const el = document.getElementById('scene-config-list');
  if (!el) return;
  el.innerHTML = '';

  const groupKeys = getKnownGroupKeys(true);
  if (editingScenes.length === 0) {
    el.innerHTML = '<div class="empty-tip">在下方添加预设，保存分组级控制组合。</div>';
    return;
  }

  editingScenes.forEach(function(scene, index) {
    const row = document.createElement('div');
    row.className = 'scene-row';

    const head = document.createElement('div');
    head.className = 'scene-row-head';
    head.innerHTML =
      '<div class="scene-name-wrap"><input type="text" class="scene-name-input" placeholder="场景名称" value="' + escapeHtml(scene.name || '') + '"></div>' +
      '<div class="scene-actions-inline">' +
        '<button type="button" class="mini-btn primary">应用</button>' +
        '<button type="button" class="mini-btn danger">删除</button>' +
      '</div>';
    row.appendChild(head);

    const meta = document.createElement('textarea');
    meta.placeholder = '给客户看的简短说明';
    meta.value = scene.description || '';
    row.appendChild(meta);

    editingScenes[index].states = editingScenes[index].states || {};
    editingScenes[index].deviceStates = editingScenes[index].deviceStates || {};
    editingScenes[index].lightStates = editingScenes[index].lightStates || {};

    // ---- 按分组 ----
    const groupLabel = document.createElement('div');
    groupLabel.className = 'scene-sub-label';
    groupLabel.textContent = '按分组';
    row.appendChild(groupLabel);

    const grid = document.createElement('div');
    grid.className = 'scene-grid';
    if (groupKeys.length === 0) {
      grid.innerHTML = '<div class="scene-ind-empty">还没有分组</div>';
    }
    groupKeys.forEach(function(groupKey) {
      const item = document.createElement('div');
      item.className = 'scene-grid-item';
      item.innerHTML =
        '<label>' + escapeHtml(getGroupLabel(groupKey)) + '</label>' +
        '<select>' +
          '<option value="keep">保持不变</option>' +
          '<option value="on">开启</option>' +
          '<option value="off">关闭</option>' +
        '</select>';
      const select = item.querySelector('select');
      select.value = scene.states[groupKey] || 'keep';
      select.addEventListener('change', function() {
        if (select.value === 'keep') delete editingScenes[index].states[groupKey];
        else editingScenes[index].states[groupKey] = select.value;
      });
      grid.appendChild(item);
    });
    row.appendChild(grid);

    // ---- 按继电器: 整块板管理的灯一起控制 ----
    const devLabel = document.createElement('div');
    devLabel.className = 'scene-sub-label';
    devLabel.textContent = '按继电器（整块板的灯一起控制）';
    row.appendChild(devLabel);

    const devGrid = document.createElement('div');
    devGrid.className = 'scene-grid';
    const deviceList = config.devices || [];
    if (deviceList.length === 0) {
      devGrid.innerHTML = '<div class="scene-ind-empty">还没有继电器设备</div>';
    }
    deviceList.forEach(function(device) {
      const item = document.createElement('div');
      item.className = 'scene-grid-item';
      item.innerHTML =
        '<label>' + escapeHtml(getDeviceDisplayName(device)) + '</label>' +
        '<select>' +
          '<option value="keep">保持不变</option>' +
          '<option value="on">开启</option>' +
          '<option value="off">关闭</option>' +
        '</select>';
      const select = item.querySelector('select');
      select.value = editingScenes[index].deviceStates[device.ip] || 'keep';
      select.addEventListener('change', function() {
        if (select.value === 'keep') delete editingScenes[index].deviceStates[device.ip];
        else editingScenes[index].deviceStates[device.ip] = select.value;
      });
      devGrid.appendChild(item);
    });
    row.appendChild(devGrid);

    // ---- 单独选灯: 按编号挑选灯泡, 优先级最高 ----
    const indLabel = document.createElement('div');
    indLabel.className = 'scene-sub-label';
    indLabel.textContent = '单独选灯（按编号，优先级最高）';
    row.appendChild(indLabel);

    const indRow = document.createElement('div');
    indRow.className = 'scene-ind-row';
    indRow.innerHTML =
      '<input type="text" class="scene-ind-range" placeholder="编号, 如 1-10, 15, 20-25">' +
      '<select class="scene-ind-state"><option value="on">开启</option><option value="off">关闭</option></select>' +
      '<button type="button" class="mini-btn add">加入</button>' +
      '<button type="button" class="mini-btn ghost">清空单选</button>';
    row.appendChild(indRow);

    const chips = document.createElement('div');
    chips.className = 'scene-ind-chips';
    row.appendChild(chips);
    renderSceneLightChips(index, chips);

    indRow.querySelector('.mini-btn.add').addEventListener('click', function() {
      const rangeStr = indRow.querySelector('.scene-ind-range').value;
      const stateVal = indRow.querySelector('.scene-ind-state').value;
      const lights = config.lights || [];
      const nums = parseSceneNumberRanges(rangeStr, lights.length);
      if (nums.length === 0) {
        setNotice('scenes-modal-notice', 'warn', '没有识别到编号', '请输入电器编号, 如 1-10, 15, 20-25。');
        return;
      }
      nums.forEach(function(num) {
        const light = lights[num - 1];
        if (!light) return;
        const stableKey = getLightStateKey(light);
        if (stableKey) editingScenes[index].lightStates[stableKey] = stateVal;
        // If this scene came from an older build, remove the positional copy so
        // a later light-list reorder cannot leave two conflicting targets.
        delete editingScenes[index].lightStates[String(num)];
      });
      clearNotice('scenes-modal-notice');
      indRow.querySelector('.scene-ind-range').value = '';
      renderSceneLightChips(index, chips);
    });
    indRow.querySelector('.mini-btn.ghost').addEventListener('click', function() {
      editingScenes[index].lightStates = {};
      renderSceneLightChips(index, chips);
    });

    head.querySelector('.scene-name-input').addEventListener('input', function(event) {
      editingScenes[index].name = event.target.value;
    });
    meta.addEventListener('input', function() {
      editingScenes[index].description = meta.value;
    });
    head.querySelector('.mini-btn.primary').addEventListener('click', function() {
      config.scenes = editingScenes.map(normalizeScene);
      applyScene(index);
    });
    head.querySelector('.mini-btn.danger').addEventListener('click', function() {
      editingScenes.splice(index, 1);
      renderScenesConfig();
    });
    el.appendChild(row);
  });
}

function addScene() {
  const groupKeys = getKnownGroupKeys(true);
  const states = {};
  if (groupKeys.length > 0) {
    states[groupKeys[0]] = 'on';
  }
  editingScenes.push({
    name: '新场景',
    description: '',
    states: states,
    deviceStates: {},
    lightStates: {}
  });
  renderScenesConfig();
}

async function saveScenes() {
  clearNotice('scenes-modal-notice');
  const normalized = editingScenes.map(normalizeScene).filter(function(scene) {
    return !!scene.name;
  });
  const invalid = normalized.some(function(scene) {
    return Object.keys(scene.states || {}).length === 0
      && Object.keys(scene.deviceStates || {}).length === 0
      && Object.keys(scene.lightStates || {}).length === 0;
  });
  if (invalid) {
    setNotice('scenes-modal-notice', 'warn', '场景缺少目标', '每个场景至少要让一个分组、继电器或单独选中的灯泡开启或关闭。');
    return;
  }

  config.scenes = normalized;
  try {
    const result = await saveConfigData();
    if (result.ok) {
      hideScenesModal();
      refreshExperiencePanels();
      if (typeof syncControlView === 'function') syncControlView();
      showToast('success', '场景已保存', '当前共有 ' + config.scenes.length + ' 个预设可用。');
    } else {
      setNotice('scenes-modal-notice', 'error', '保存失败', getFriendlyMessage(result.error || '未知错误', 'save'));
    }
  } catch (error) {
    setNotice('scenes-modal-notice', 'error', '保存失败', getFriendlyMessage(getErrorMessage(error, '未知错误'), 'save'));
  }
}

function hideSetupWizard() {
  ['setup-device-notice', 'setup-appliance-notice'].forEach(clearNotice);
  const modal = document.getElementById('setup-modal');
  if (modal) modal.classList.remove('show');
}

function openSetupWizard() {
  const primaryDevice = (config.devices || [])[0] || null;
  setupWizardState = {
    step: 0,
    deviceTargetIp: primaryDevice ? primaryDevice.ip : null,
    deviceConnected: !!(primaryDevice && deviceStatus[primaryDevice.ip] && deviceStatus[primaryDevice.ip].connected),
    lastGroupName: normalizeGroupName((config.lights[config.lights.length - 1] || {}).group)
  };

  resetSetupWizardDeviceForm(primaryDevice || null);
  document.getElementById('setup-appliance-count').value = String(
    Math.min(4, getDeviceChannelCount(primaryDevice))
  );
  document.getElementById('setup-appliance-type').value = DEFAULT_ITEM_TYPE;
  document.getElementById('setup-appliance-prefix').value = '区域';
  document.getElementById('setup-appliance-group').value = setupWizardState.lastGroupName || '主区域';
  renderSetupWizard();
  document.getElementById('setup-modal').classList.add('show');
}

function renderSetupWizard() {
  const stepper = document.getElementById('setup-stepper');
  if (stepper) {
    stepper.innerHTML = '';
    SETUP_WIZARD_STEPS.forEach(function(stepKey, index) {
      const node = document.createElement('div');
      node.className = 'setup-step' + (setupWizardState.step === index ? ' active' : '');
      node.innerHTML =
        '<div class="setup-step-kicker">步骤 ' + (index + 1) + '</div>' +
        '<div class="setup-step-title">' + escapeHtml(stepKey === 'device' ? '设备' : '电器') + '</div>' +
        '<div class="setup-step-meta">' + escapeHtml(stepKey === 'device' ? '连接参数' : '通道绑定和分组') + '</div>';
      stepper.appendChild(node);
    });
  }

  SETUP_WIZARD_STEPS.forEach(function(stepKey, index) {
    const pane = document.getElementById('setup-pane-' + stepKey);
    if (pane) pane.hidden = setupWizardState.step !== index;
  });

  const backBtn = document.getElementById('setup-back-btn');
  const testBtn = document.getElementById('setup-test-btn');
  const nextBtn = document.getElementById('setup-next-btn');
  if (backBtn) backBtn.textContent = setupWizardState.step === 0 ? '取消' : '上一步';
  if (testBtn) testBtn.style.display = setupWizardState.step === 0 ? '' : 'none';
  if (nextBtn) {
    nextBtn.textContent = setupWizardState.step === 0
      ? '保存并继续'
      : '生成并完成';
  }

  const targetDevice = getDeviceByIp(setupWizardState.deviceTargetIp) || (config.devices || [])[0] || null;
  const deviceSummary = document.getElementById('setup-device-summary');
  if (deviceSummary) {
    deviceSummary.textContent = targetDevice
      ? getDeviceDisplayName(targetDevice) + ' · ' + getDeviceSummary(targetDevice)
      : '还没有保存设备';
  }

  const preview = document.getElementById('setup-appliance-preview');
  if (preview) {
    const count = clampInteger(document.getElementById('setup-appliance-count').value, 4, 1, 128);
    const prefix = String(document.getElementById('setup-appliance-prefix').value || '区域').trim() || '区域';
    const groupName = normalizeGroupName(document.getElementById('setup-appliance-group').value) || '未分组';
    preview.textContent = '将创建 ' + count + ' 个电器，名称前缀为“' + prefix + '”，分组为“' + groupName + '”。';
  }

}

function setupWizardBack() {
  if (setupWizardState.step === 0) {
    hideSetupWizard();
    return;
  }
  setupWizardState.step = Math.max(0, setupWizardState.step - 1);
  renderSetupWizard();
}

async function setupWizardTestDevice() {
  const device = buildDeviceFromForm('setup-device');
  const validation = validateDeviceInput(device, setupWizardState.deviceTargetIp);
  if (validation) {
    setNotice('setup-device-notice', 'warn', '检查设备参数', validation);
    return { ok: false, error: validation };
  }
  const result = await connectDevice(device, { silent: true });
  if (result && result.ok) {
    setupWizardState.deviceConnected = true;
    setNotice('setup-device-notice', 'success', '连接成功', '设备可达，可以继续保存并进入下一步。');
  } else {
    setNotice('setup-device-notice', 'error', '连接失败', getFriendlyMessage((result && result.error) || '未知错误', 'connect'));
  }
  return result;
}

async function createWizardAppliances() {
  const device = getDeviceByIp(setupWizardState.deviceTargetIp) || (config.devices || [])[0];
  if (!device) {
    return { ok: false, error: '请先保存设备。' };
  }

  const count = clampInteger(document.getElementById('setup-appliance-count').value, 4, 1, getDeviceChannelCount(device));
  const type = document.getElementById('setup-appliance-type').value;
  const prefix = String(document.getElementById('setup-appliance-prefix').value || '区域').trim() || '区域';
  const groupName = normalizeGroupName(document.getElementById('setup-appliance-group').value);
  const usedChannels = new Set((config.lights || []).filter(function(light) {
    return light.device_ip === device.ip;
  }).map(function(light) {
    return light.channel;
  }));

  const availableChannels = [];
  for (let channel = 0; channel < getDeviceChannelCount(device); channel++) {
    if (!usedChannels.has(channel)) availableChannels.push(channel);
  }

  if (availableChannels.length === 0) {
    return { ok: false, error: '当前设备没有剩余可绑定的空闲通道。' };
  }

  const actualCount = Math.min(count, availableChannels.length);
  for (let index = 0; index < actualCount; index++) {
    const nextLight = {
      name: prefix + ' ' + String(index + 1).padStart(2, '0'),
      type: ITEM_TYPES[type] ? type : DEFAULT_ITEM_TYPE,
      scale: 1,
      device_ip: device.ip,
      channel: availableChannels[index]
    };
    if (groupName) nextLight.group = groupName;
    config.lights.push(nextLight);
  }

  const result = await saveConfigData();
  if (!result.ok) return result;
  setupWizardState.lastGroupName = groupName;
  renderLightRows();
  rebuildLamps();
  applyStatus();
  return { ok: true, count: actualCount };
}

async function setupWizardNext() {
  if (setupWizardState.step === 0) {
    clearNotice('setup-device-notice');
    try {
      const device = buildDeviceFromForm('setup-device');
      const result = await upsertDeviceConfig(device, { existingIp: setupWizardState.deviceTargetIp });
      if (!result.ok) {
        setNotice('setup-device-notice', 'error', '保存失败', getFriendlyMessage(result.error || '未知错误', 'save'));
        return;
      }
      setupWizardState.deviceTargetIp = device.ip;
      setupWizardState.step = 1;
      renderSetupWizard();
      showToast('success', '设备已保存', getDeviceDisplayName(device) + ' 已进入项目配置。');
      return;
    } catch (error) {
      setNotice('setup-device-notice', 'error', '保存失败', getFriendlyMessage(getErrorMessage(error, '未知错误'), 'save'));
      return;
    }
  }

  if (setupWizardState.step === 1) {
    clearNotice('setup-appliance-notice');
    try {
      const result = await createWizardAppliances();
      if (!result.ok) {
        setNotice('setup-appliance-notice', 'error', '生成失败', getFriendlyMessage(result.error || '未知错误', 'save'));
        return;
      }
      hideSetupWizard();
      refreshExperiencePanels();
      showToast('success', '接入完成', '已生成 ' + result.count + ' 个默认电器绑定，设备和分组已准备完成。');
      return;
    } catch (error) {
      setNotice('setup-appliance-notice', 'error', '生成失败', getFriendlyMessage(getErrorMessage(error, '未知错误'), 'save'));
      return;
    }
  }

}

function isLampLabelVisible(index) {
  return labelsPinned || focusedLampIdx === index;
}

function refreshLabelToggleUI() {
  const btn = document.getElementById('label-toggle-btn');
  if (!btn) return;
  btn.classList.toggle('on', !!labelsPinned);
  btn.setAttribute('aria-pressed', labelsPinned ? 'true' : 'false');
  btn.title = labelsPinned ? '标签已常显' : '点击后显示标签';
}

function updateIconHoverScale() {
  if (!Array.isArray(lamps) || !lamps.length) return;
  for (let i = 0; i < lamps.length; i++) {
    const lamp = lamps[i];
    const sprite = lamp && lamp.iconSprite;
    const baseX = lamp.iconBaseScaleX || lamp.iconBaseScale;
    const baseY = lamp.iconBaseScaleY || lamp.iconBaseScale;
    if (!sprite || !baseX || !baseY) continue;
    lamp.iconCurrentScaleX = baseX;
    lamp.iconCurrentScaleY = baseY;
    lamp.iconCurrentScale = Math.max(baseX, baseY);
    sprite.scale.set(baseX, baseY, 1);
  }
}

function hexToRgba(hex, alpha) {
  if (typeof hex !== 'string') return 'rgba(255,255,255,' + alpha + ')';
  const h = hex.replace('#', '');
  if (h.length < 6) return 'rgba(255,255,255,' + alpha + ')';
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

function drawPowerGlyph(ctx, cx, cy, boxW, boxH, on) {
  const size = Math.min(boxW * 0.42, boxH * 0.86);
  const radius = size * 0.34;
  const lineWidth = Math.max(4, size * 0.16);
  const alpha = on ? 0.95 : 0.72;

  ctx.save();
  ctx.translate(cx, cy + size * 0.02);
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,' + alpha + ')';
  ctx.shadowColor = 'rgba(255,255,255,' + (on ? 0.46 : 0.22) + ')';
  ctx.shadowBlur = size * 0.08;

  ctx.beginPath();
  ctx.arc(0, size * 0.08, radius, Math.PI * 0.72, Math.PI * 2.28);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, -radius * 1.18);
  ctx.lineTo(0, -radius * 0.12);
  ctx.stroke();
  ctx.restore();
}

function drawPowerIconImage(ctx, cx, cy, boxW, boxH, on) {
  if (!powerIconImage.complete || !powerIconImage.naturalWidth) return false;
  const size = Math.min(boxH * 0.9, boxW * 0.32);
  ctx.save();
  ctx.globalAlpha = on ? 0.92 : 0.72;
  ctx.drawImage(powerIconImage, cx - size / 2, cy - size / 2, size, size);
  ctx.restore();
  return true;
}

function drawDeviceButton(lamp, on) {
  if (!lamp.iconCanvas) return;
  const ctx = lamp.iconCanvas.getContext('2d');
  const meta = lamp.meta;
  const W = lamp.iconCanvas.width;
  const H = lamp.iconCanvas.height;
  const cx = W / 2;
  const cy = H / 2;
  ctx.clearRect(0, 0, W, H);

  // 灯泡按钮保持屏幕横向, 不随场景旋转。
  const powerButton = !!lamp.iconUsesPowerGlyph;
  const portrait = !!lamp.iconPortrait;
  const RATIO = 4;
  const margin = 12;
  let bw;
  let bh;
  if (portrait) {
    bh = H - margin * 2;
    bw = bh / RATIO;
    if (bw > W - margin * 2) {
      bw = W - margin * 2;
      bh = bw * RATIO;
    }
  } else {
    bw = W - margin * 2;
    bh = bw / RATIO;
    if (bh > H - margin * 2) {
      bh = H - margin * 2;
      bw = bh * RATIO;
    }
  }
  const bx = cx - bw / 2;
  const by = cy - bh / 2;
  const bRadius = Math.min(22, bh / 2);

  if (on) {
    const grad = ctx.createRadialGradient(cx, cy, bh * 0.3, cx, cy, bw * 0.62);
    grad.addColorStop(0, powerButton ? 'rgba(15,82,186,0.20)' : hexToRgba(meta.accent, 0.28));
    grad.addColorStop(1, hexToRgba(meta.accent, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, bRadius);
  ctx.fillStyle = powerButton
    ? (on ? 'rgba(15,82,186,0.44)' : 'rgba(15,82,186,0.30)')
    : (on ? 'rgba(126,130,138,0.58)' : 'rgba(110,114,122,0.44)');
  ctx.fill();

  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, bRadius);
  ctx.lineWidth = on ? 7 : 4;
  ctx.strokeStyle = powerButton
    ? (on ? 'rgba(15,82,186,0.78)' : 'rgba(15,82,186,0.46)')
    : (on ? hexToRgba(meta.accent, 0.62) : 'rgba(255,255,255,0.22)');
  ctx.stroke();

  if (powerButton) {
    if (!drawPowerIconImage(ctx, cx, cy, bw, bh, on)) {
      drawPowerGlyph(ctx, cx, cy, bw, bh, on);
    }
  } else {
    const glyph = Math.floor(Math.min(bw, bh) * 0.72);
    ctx.font = 'bold ' + glyph + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = on ? 'rgba(255,255,255,0.76)' : 'rgba(235,235,240,0.62)';
    ctx.fillText(meta.icon || '·', cx, cy + 2);
  }

  lamp.iconTex.needsUpdate = true;
}

function createCanvasPlane(width, height, scaleX, scaleY, y) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(scaleX, scaleY), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  return { canvas, tex, sprite: mesh };
}

function drawLabel(lamp, on) {
  const ctx = lamp.labelCanvas.getContext('2d');
  const meta = lamp.meta;
  const width = lamp.labelCanvas.width;
  const height = lamp.labelCanvas.height;
  const deviceLine = (lamp.deviceName || lamp.deviceIp || meta.label || '').slice(0, 18);
  const channelLine = '路' + String((lamp.channel || 0) + 1).padStart(2, '0');

  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(8, 8, width - 16, height - 16, 14);
  ctx.fillStyle = on ? 'rgba(12,12,16,0.94)' : 'rgba(28,28,30,0.92)';
  ctx.strokeStyle = on ? meta.accent : '#48484a';
  ctx.fill();
  ctx.stroke();

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = on ? meta.accent : '#8e8e93';
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText(meta.short, 22, 28);

  ctx.textAlign = 'right';
  ctx.fillStyle = on ? '#dfe7f0' : '#7c828b';
  ctx.font = '600 12px sans-serif';
  ctx.fillText(channelLine, width - 22, 28);

  ctx.textAlign = 'left';
  ctx.fillStyle = on ? '#ffffff' : '#d0d0d6';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText((lamp.name || meta.label).slice(0, 12), 22, 54);

  ctx.fillStyle = on ? '#c5d0db' : '#7c828b';
  ctx.font = '12px sans-serif';
  ctx.fillText(deviceLine, 22, 78);
  lamp.labelTex.needsUpdate = true;
}

function refreshLampLabels() {
  lamps.forEach(function(lamp, index) {
    drawLabel(lamp, lamp.state);
    lamp.label.visible = isLampLabelVisible(index);
  });
  refreshLabelToggleUI();
}

function focusLamp(index) {
  if (typeof index === 'number' && index >= 0 && index < lamps.length) {
    focusedLampIdx = index;
  } else if (!labelsPinned) {
    focusedLampIdx = null;
  }
  refreshLampLabels();
}

function toggleLabelPins(forceValue) {
  labelsPinned = typeof forceValue === 'boolean' ? forceValue : !labelsPinned;
  if (!labelsPinned && (focusedLampIdx == null || focusedLampIdx >= lamps.length)) {
    focusedLampIdx = null;
  }
  refreshLampLabels();
}

// ====== 操控模式: 点击设备 → 旁边浮窗 (查看 / 修改 名称·继电器·接口) ======
let inspectorLightIdx = null;
const _inspectorProbe = new THREE.Vector3();

function getDevicePopEl() {
  return document.getElementById('device-pop');
}

function openDeviceInspector(lightIdx) {
  if (typeof lightIdx !== 'number' || lightIdx < 0 || lightIdx >= config.lights.length) return;
  inspectorLightIdx = lightIdx;
  focusLamp(lightIdx);
  renderDeviceInspector();
  const pop = getDevicePopEl();
  if (pop) pop.hidden = false;
  updateDeviceInspectorPosition();
}
window.openDeviceInspector = openDeviceInspector;

function closeDeviceInspector() {
  if (inspectorLightIdx == null) return;
  inspectorLightIdx = null;
  const pop = getDevicePopEl();
  if (pop) {
    pop.hidden = true;
    pop.innerHTML = '';
  }
}
window.closeDeviceInspector = closeDeviceInspector;

// 构造接口(通道)下拉的 options, 保留当前选中通道(超出新板路数则回到 0)
function buildInspectorChannelOptions(device, currentChannel) {
  const count = getDeviceChannelCount(device);
  const keep = currentChannel < count ? currentChannel : 0;
  const max = Math.max(count, currentChannel + 1);
  let html = '';
  for (let ch = 0; ch < max; ch++) {
    html += '<option value="' + ch + '"' + (ch === keep ? ' selected' : '') +
      '>接口 ' + String(ch + 1).padStart(2, '0') + '</option>';
  }
  return html;
}

function renderDeviceInspector() {
  const pop = getDevicePopEl();
  if (!pop || inspectorLightIdx == null) return;
  const idx = inspectorLightIdx;
  const light = config.lights[idx];
  if (!light) { closeDeviceInspector(); return; }
  const meta = getItemMeta(light.type);

  let deviceOptions = '';
  config.devices.forEach(function(device) {
    deviceOptions += '<option value="' + escapeHtml(device.ip) + '"' +
      (light.device_ip === device.ip ? ' selected' : '') + '>' +
      escapeHtml(device.name || device.ip) + '</option>';
  });

  const selectedDevice = getDeviceByIp(light.device_ip) || config.devices[0] || null;
  const channelOptions = buildInspectorChannelOptions(selectedDevice, parseInt(light.channel, 10) || 0);

  const status = deviceStatus[light.device_ip];
  const connected = !!(status && status.connected);
  const on = connected && status.relay_states && status.relay_states[light.channel];

  pop.innerHTML =
    '<div class="device-pop-head">' +
      '<div class="device-pop-icon" style="color:' + meta.accent + '">' + escapeHtml(meta.icon || '·') + '</div>' +
      '<div class="device-pop-titles">' +
        '<div class="device-pop-kicker">操控 · ' + escapeHtml(meta.label) + '</div>' +
        '<div class="device-pop-title" data-pop="heading">' + escapeHtml(light.name || ('未命名' + meta.label)) + '</div>' +
      '</div>' +
      '<button type="button" class="device-pop-close" data-pop="close" title="关闭">×</button>' +
    '</div>' +
    '<div class="device-pop-state">' +
      '<span class="device-pop-state-label">当前状态</span>' +
      '<span class="device-pop-state-val" data-pop="state"></span>' +
      '<button type="button" class="device-pop-toggle" data-pop="toggle"></button>' +
    '</div>' +
    '<div class="device-pop-field">' +
      '<label>名称</label>' +
      '<input type="text" data-pop="name" placeholder="设备名称" value="' + escapeHtml(light.name || '') + '">' +
    '</div>' +
    '<div class="device-pop-field">' +
      '<label>所连继电器</label>' +
      '<select data-pop="device">' + deviceOptions + '</select>' +
    '</div>' +
    '<div class="device-pop-field">' +
      '<label>接口 (通道)</label>' +
      '<select data-pop="channel">' + channelOptions + '</select>' +
    '</div>' +
    '<div class="device-pop-actions">' +
      '<button type="button" class="btn btn-ghost" data-pop="cancel">取消</button>' +
      '<button type="button" class="btn btn-primary" data-pop="save">保存修改</button>' +
    '</div>';

  pop.querySelector('[data-pop="close"]').onclick = closeDeviceInspector;
  pop.querySelector('[data-pop="cancel"]').onclick = closeDeviceInspector;
  pop.querySelector('[data-pop="save"]').onclick = saveDeviceInspector;
  pop.querySelector('[data-pop="toggle"]').onclick = inspectorToggleLight;

  const nameInput = pop.querySelector('[data-pop="name"]');
  nameInput.oninput = function() {
    const heading = pop.querySelector('[data-pop="heading"]');
    if (heading) heading.textContent = nameInput.value || ('未命名' + meta.label);
  };

  const deviceSelect = pop.querySelector('[data-pop="device"]');
  deviceSelect.onchange = function() {
    const chSelect = pop.querySelector('[data-pop="channel"]');
    const curCh = parseInt(chSelect.value, 10) || 0;
    chSelect.innerHTML = buildInspectorChannelOptions(getDeviceByIp(deviceSelect.value), curCh);
  };

  refreshDeviceInspectorState();
}

// 仅刷新状态行 (开/关/离线), 不影响正在编辑的名称与下拉
function refreshDeviceInspectorState() {
  const pop = getDevicePopEl();
  if (!pop || pop.hidden || inspectorLightIdx == null) return;
  const light = config.lights[inspectorLightIdx];
  if (!light) return;
  const status = deviceStatus[light.device_ip];
  const connected = !!(status && status.connected);
  const on = connected && status.relay_states && status.relay_states[light.channel];
  const valEl = pop.querySelector('[data-pop="state"]');
  const toggleBtn = pop.querySelector('[data-pop="toggle"]');
  if (valEl) {
    valEl.textContent = connected ? (on ? '已开启' : '已关闭') : '设备离线';
    valEl.classList.toggle('on', !!on);
    valEl.classList.toggle('off', connected && !on);
  }
  if (toggleBtn) {
    toggleBtn.textContent = on ? '关闭' : '开启';
    toggleBtn.disabled = !connected;
  }
}

async function inspectorToggleLight() {
  if (inspectorLightIdx == null) return;
  await toggleLight(inspectorLightIdx);
  refreshDeviceInspectorState();
}

async function saveDeviceInspector() {
  const pop = getDevicePopEl();
  if (!pop || inspectorLightIdx == null) return;
  const idx = inspectorLightIdx;
  const light = config.lights[idx];
  if (!light) { closeDeviceInspector(); return; }

  const name = pop.querySelector('[data-pop="name"]').value.trim();
  const deviceIp = pop.querySelector('[data-pop="device"]').value;
  const channel = parseInt(pop.querySelector('[data-pop="channel"]').value, 10) || 0;

  if (!getDeviceByIp(deviceIp)) {
    showToast('warn', '请选择继电器', '该设备指向的继电器不存在，请重新选择。');
    return;
  }

  const clash = config.lights.some(function(other, i) {
    return i !== idx && other.device_ip === deviceIp && other.channel === channel;
  });
  if (clash) {
    showToast('warn', '接口被占用', '该继电器的这个接口已绑定其它设备，请换一个接口。');
    return;
  }

  light.name = name || getSuggestedLightName(light.type);
  light.device_ip = deviceIp;
  light.channel = channel;

  try {
    const result = await saveConfigData();
    if (result.ok) {
      renderLightRows();
      rebuildLamps();
      applyStatus();
      renderDeviceInspector();
      showToast('success', '已保存', '设备信息已更新。');
    } else {
      showToast('error', '保存失败', getFriendlyMessage(result.error || '未知错误', 'save'));
    }
  } catch (error) {
    showToast('error', '保存失败', getFriendlyMessage(getErrorMessage(error, '未知错误'), 'save'));
  }
}

// 浮窗跟随设备图标的屏幕位置; 操控模式关闭 / 进入漫游或布局时自动收起
function updateDeviceInspectorPosition() {
  if (inspectorLightIdx == null) return;
  if (typeof editMode !== 'undefined' && !editMode) { closeDeviceInspector(); return; }
  if ((typeof walkMode !== 'undefined' && walkMode) || (typeof layoutMode !== 'undefined' && layoutMode)) {
    closeDeviceInspector();
    return;
  }
  const pop = getDevicePopEl();
  if (!pop || pop.hidden) return;
  if (inspectorLightIdx >= lamps.length) { closeDeviceInspector(); return; }
  const lamp = lamps[inspectorLightIdx];
  const canvasEl = renderer && renderer.domElement;
  if (!lamp || !canvasEl) return;

  const anchor = lamp.iconSprite || lamp.hit || lamp.group;
  anchor.getWorldPosition(_inspectorProbe);
  _inspectorProbe.project(camera);
  const behind = _inspectorProbe.z > 1;

  const rect = canvasEl.getBoundingClientRect();
  const sx = (_inspectorProbe.x * 0.5 + 0.5) * rect.width;
  const sy = (-_inspectorProbe.y * 0.5 + 0.5) * rect.height;
  const popW = pop.offsetWidth || 250;
  const popH = pop.offsetHeight || 230;
  const margin = 14;
  const gap = 30;

  let left = sx + gap;
  if (left + popW > rect.width - margin) left = sx - gap - popW; // 右侧放不下 → 放到左侧
  left = clamp(left, margin, Math.max(margin, rect.width - popW - margin));
  let top = sy - popH / 2;
  top = clamp(top, margin, Math.max(margin, rect.height - popH - margin));

  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  pop.style.opacity = behind ? '0' : '1';
  pop.style.pointerEvents = behind ? 'none' : 'auto';
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && inspectorLightIdx != null) closeDeviceInspector();
});

function getItemMountedY(item, built, scale) {
  const mount = typeof item.mount === 'string' ? item.mount : (getItemMeta(item.type).mount || 'free');
  switch (mount) {
    case 'ceiling': {
      if (!Number.isFinite(built.mountY)) return 0;
      const ceilingY = clamp(BUILDING.wallH - 0.6, 10, BUILDING.ridgeH - 1.6);
      return ceilingY - built.mountY * scale;
    }
    case 'wall_high': {
      if (!Number.isFinite(built.mountY)) return 0;
      const wallY = clamp(BUILDING.wallH * 0.76, 12, BUILDING.wallH - 2.2);
      return wallY - built.mountY * scale;
    }
    case 'wall_mid': {
      if (!Number.isFinite(built.mountY)) return 0;
      const wallY = clamp(BUILDING.wallH * 0.42, 6.2, BUILDING.wallH - 6);
      return wallY - built.mountY * scale;
    }
    case 'floor':
      return -((Number.isFinite(built.floorY) ? built.floorY : 0) * scale);
    default:
      return 0;
  }
}

function createLamp(lightIdx, x, z, item) {
  const meta = getItemMeta(item.type);
  const scale = clamp(Number(item.scale) || 1, 0.4, 3);
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  const modelRoot = new THREE.Group();
  group.add(modelRoot);
  const built = buildItemModel(item.type, modelRoot, meta);
  group.position.y = getItemMountedY(item, built, scale);
  modelRoot.scale.setScalar(scale);

  const hitW = Math.max(built.hit.w * scale, 2.4);
  const hitH = Math.max(built.hit.h * scale, 1.4);
  const hitD = Math.max(built.hit.d * scale, 2.4);
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(hitW, hitH, hitD),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.position.y = built.hit.y * scale;
  hit.userData.lightIdx = lightIdx;
  group.add(hit);

  const labelY = Math.max(built.labelY * scale, built.labelY * 0.84) + 0.18;
  const labelSprite = createCanvasSprite(256, 96, 7.8, 2.8, labelY + 2.4);
  group.add(labelSprite.sprite);

  const iconY = Math.max(built.hit.y * scale, 1.2);
  const isLampIcon = item.type === 'lamp';
  const iconBaseW = isLampIcon ? 71 : 2.8;
  const iconBaseH = isLampIcon ? 17.8 : 2.8;
  const iconMinW = isLampIcon ? 60 : 2.4;
  const iconMinH = isLampIcon ? 15 : 2.4;
  const iconMaxW = isLampIcon ? 118 : 4.6;
  const iconMaxH = isLampIcon ? 29.5 : 4.6;
  const scaleFactor = Math.sqrt(scale);
  const iconW = clamp(iconBaseW * scaleFactor, iconMinW, iconMaxW);
  const iconH = clamp(iconBaseH * scaleFactor, iconMinH, iconMaxH);
  const iconSprite = isLampIcon
    ? createCanvasPlane(512, 128, iconW, iconH, iconY)
    : createCanvasSprite(256, 256, iconW, iconH, iconY);
  iconSprite.sprite.userData.lightIdx = lightIdx;
  iconSprite.sprite.renderOrder = 50;
  iconSprite.sprite.material.depthTest = false;
  iconSprite.sprite.material.depthWrite = false;
  iconSprite.sprite.material.rotation = 0;
  iconSprite.sprite.material.opacity = isLampIcon ? 0.82 : 1;
  group.add(iconSprite.sprite);

  scene.add(group);

  const lamp = {
    group: group,
    hit: hit,
    labelCanvas: labelSprite.canvas,
    labelTex: labelSprite.tex,
    label: labelSprite.sprite,
    iconCanvas: iconSprite.canvas,
    iconTex: iconSprite.tex,
    iconSprite: iconSprite.sprite,
    iconPortrait: false,
    iconUsesPowerGlyph: isLampIcon,
    iconBaseScale: Math.max(iconW, iconH),
    iconBaseScaleX: iconW,
    iconBaseScaleY: iconH,
    iconCurrentScale: Math.max(iconW, iconH),
    iconCurrentScaleX: iconW,
    iconCurrentScaleY: iconH,
    state: false,
    name: item.name || '',
    meta: meta,
    channel: item.channel,
    deviceIp: item.device_ip,
    deviceName: getDeviceDisplayName(item.device_ip),
    scale: scale,
    applyState: built.applyState,
    tick: built.tick || null
  };
  if (lamp.applyState) lamp.applyState(false);
  lamp.label.visible = false;
  drawLabel(lamp, false);
  drawDeviceButton(lamp, false);
  return lamp;
}

function disposeLamp(lamp) {
  if (!lamp) return;
  disposeObjectGraph(lamp.group);
  if (lamp.labelTex) lamp.labelTex.dispose();
  if (lamp.iconTex) lamp.iconTex.dispose();
}

function computeLayout(lights) {
  const positions = new Array(lights.length);
  const needAutoIdxs = [];
  lights.forEach(function(light, index) {
    if (typeof light.x === 'number' && typeof light.z === 'number') {
      const point = clampFloorPoint({ x: light.x, z: light.z });
      positions[index] = { x: point.x, z: point.z };
    } else {
      needAutoIdxs.push(index);
    }
  });
  if (needAutoIdxs.length === 0) return positions;

  const groups = {};
  const order = [];
  needAutoIdxs.forEach(function(index) {
    const ip = lights[index].device_ip;
    if (!groups[ip]) {
      groups[ip] = [];
      order.push(ip);
    }
    groups[ip].push(index);
  });

  const groupCount = order.length || 1;
  const zSpan = Math.max(12 * SCALE, BUILDING.depth - 8 * SCALE);
  const xSpan = Math.max(18 * SCALE, BUILDING.width - 12 * SCALE);
  const bandH = zSpan / groupCount;

  order.forEach(function(ip, groupIndex) {
    const indices = groups[ip];
    const count = indices.length;
    const perRow = Math.min(8, Math.max(1, count));
    const rows = Math.ceil(count / perRow);
    const bandCenter = -zSpan / 2 + bandH * (groupIndex + 0.5);

    indices.forEach(function(lightIndex, orderIndex) {
      const row = Math.floor(orderIndex / perRow);
      const column = orderIndex % perRow;
      const xSpacing = Math.min(6 * SCALE, xSpan / Math.max(perRow, 1));
      const x = (column - (perRow - 1) / 2) * xSpacing;
      const rowOffset = (row - (rows - 1) / 2) * Math.min(4 * SCALE, bandH / Math.max(rows, 1));
      positions[lightIndex] = clampFloorPoint({ x: x, z: bandCenter + rowOffset });
    });
  });
  return positions;
}

function rebuildLamps() {
  lamps.forEach(disposeLamp);
  lamps = [];
  config.lights = (config.lights || []).map(normalizeLight);
  clampLightPositionsToBuilding();

  const lights = config.lights || [];
  const positions = computeLayout(lights);
  if (typeof setLampLightBudget === 'function') {
    setLampLightBudget(lights.filter(function(l) { return l.type === 'lamp'; }).length);
  }
  lights.forEach(function(light, index) {
    const point = positions[index] || { x: 0, z: 0 };
    lamps.push(createLamp(index, point.x, point.z, light));
  });

  if (focusedLampIdx != null && focusedLampIdx >= lamps.length) {
    focusedLampIdx = null;
  }
  refreshLampLabels();
}

function setLampState(index, state) {
  const lamp = lamps[index];
  if (!lamp) return;
  const changed = lamp.state !== state;
  lamp.state = state;
  if (changed && lamp.applyState) lamp.applyState(state);
  drawLabel(lamp, state);
  drawDeviceButton(lamp, state);
  lamp.label.visible = isLampLabelVisible(index);
}

// 渲染循环必须在所有 let/const（config、inspectorLightIdx 等）初始化之后再启动，
// 否则 animate() 会在变量声明前访问它们，触发 TDZ 报错并中断本脚本。
animate();

// ========== 灯具用量报表 ==========
let usageData = null;
let usageTimer = null;
let usageWarned = false;  // 同一次打开弹窗只提示一次失败, 避免 15 秒轮询反复弹 toast

// 把秒数格式化成人类可读的时长文案
function formatUsageDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return s + ' 秒';
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest > 0 ? m + ' 分 ' + rest + ' 秒' : m + ' 分';
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h + ' 小时 ' + m + ' 分';
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d + ' 天 ' + h + ' 小时';
}

async function refreshUsageReport() {
  try {
    const res = await fetch('/api/usage');
    let json = null;
    if (res.ok) {
      json = await res.json();
    }
    if (!json || json.ok !== true) {
      if (!usageWarned) {
        usageWarned = true;
        showToast('warn', '用量统计不可用', '需要重启后端服务后才能统计用量。');
      }
      return;
    }
    usageWarned = false;
    usageData = json;
    renderUsageReport();
  } catch (err) {
    if (!usageWarned) {
      usageWarned = true;
      showToast('error', '加载失败', '无法获取用量数据, 请检查后端服务。');
    }
  }
}

function renderUsageReport() {
  const modal = document.getElementById('usage-modal');
  const summaryEl = document.getElementById('usage-summary');
  const listEl = document.getElementById('usage-list');
  if (!modal || !modal.classList.contains('show') || !summaryEl || !listEl) return;

  const rows = (config.lights || []).map(function(light, i) {
    const key = light.device_ip + '#' + light.channel;
    const stat = (usageData && usageData.usage && usageData.usage[key]) ||
      { total_seconds: 0, today_seconds: 0, switch_count: 0, on: false };
    return { num: i + 1, light: light, stat: stat };
  });

  const sortEl = document.getElementById('usage-sort');
  const sortKey = sortEl ? sortEl.value : 'num';
  if (sortKey === 'today') {
    rows.sort(function(a, b) { return (b.stat.today_seconds || 0) - (a.stat.today_seconds || 0); });
  } else if (sortKey === 'total') {
    rows.sort(function(a, b) { return (b.stat.total_seconds || 0) - (a.stat.total_seconds || 0); });
  } else if (sortKey === 'count') {
    rows.sort(function(a, b) { return (b.stat.switch_count || 0) - (a.stat.switch_count || 0); });
  } else {
    rows.sort(function(a, b) { return a.num - b.num; });
  }

  let onCount = 0;
  let todayMax = 0;
  let totalMax = 0;
  let maxTotal = 0;
  rows.forEach(function(row) {
    if (row.stat.on) onCount++;
    todayMax = Math.max(todayMax, row.stat.today_seconds || 0);
    totalMax = Math.max(totalMax, row.stat.total_seconds || 0);
    if ((row.stat.total_seconds || 0) > maxTotal) maxTotal = row.stat.total_seconds;
  });

  summaryEl.innerHTML = [
    '<div class="usage-chip">灯具总数<b>' + rows.length + '</b></div>',
    '<div class="usage-chip">当前点亮<b>' + onCount + '</b></div>',
    '<div class="usage-chip">今日单灯最长<b>' + formatUsageDuration(todayMax) + '</b></div>',
    '<div class="usage-chip">累计单灯最长<b>' + formatUsageDuration(totalMax) + '</b></div>'
  ].join('');

  if (rows.length === 0) {
    listEl.innerHTML = '<div class="usage-empty">还没有电器, 请先在"设备管理"里添加。</div>';
    return;
  }

  const denom = Math.max(maxTotal, 1);
  const html = rows.map(function(row) {
    const light = row.light;
    const stat = row.stat;
    const pct = ((stat.total_seconds || 0) / denom * 100).toFixed(1);
    const groupHtml = light.group
      ? '<span class="usage-group">' + escapeHtml(light.group) + '</span>'
      : '';
    return '<div class="usage-row">' +
      '<span class="usage-dot' + (stat.on ? ' on' : '') + '"></span>' +
      '<div class="usage-main">' +
        '<div class="usage-name">#' + row.num + ' ' + escapeHtml(light.name || '') + groupHtml + '</div>' +
        '<div class="usage-meta">' + escapeHtml(getDeviceDisplayName(light.device_ip)) +
          ' · 通道' + String((parseInt(light.channel, 10) || 0) + 1).padStart(2, '0') + '</div>' +
        '<div class="usage-bar-track"><div class="usage-bar-fill" style="width: ' + pct + '%"></div></div>' +
      '</div>' +
      '<div class="usage-nums">' +
        '<div class="usage-num"><label>今日</label><b>' + formatUsageDuration(stat.today_seconds) + '</b></div>' +
        '<div class="usage-num"><label>累计</label><b>' + formatUsageDuration(stat.total_seconds) + '</b></div>' +
        '<div class="usage-num"><label>次数</label><b>' + (stat.switch_count || 0) + '</b></div>' +
      '</div>' +
    '</div>';
  });
  listEl.innerHTML = html.join('');
}

function showUsageModal() {
  const modal = document.getElementById('usage-modal');
  if (!modal) return;
  usageWarned = false;
  modal.classList.add('show');
  refreshUsageReport();
  if (usageTimer) clearInterval(usageTimer);
  usageTimer = setInterval(refreshUsageReport, 15000);
}

function hideUsageModal() {
  const modal = document.getElementById('usage-modal');
  if (modal) modal.classList.remove('show');
  if (usageTimer) clearInterval(usageTimer);
  usageTimer = null;
}

// CSV 字段转义: 含逗号/引号/换行时加双引号
function csvUsageField(value) {
  const str = String(value === undefined || value === null ? '' : value);
  if (/[",\r\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function exportUsageCsv() {
  const lights = config.lights || [];
  if (!usageData || lights.length === 0) {
    showToast('warn', '暂无数据', '还没有可导出的用量数据, 请先打开报表并等待加载完成。');
    return;
  }
  const lines = ['编号,名称,分组,设备,通道,当前状态,今日点亮(分钟),累计点亮(分钟),开关次数'];
  lights.forEach(function(light, i) {
    const key = light.device_ip + '#' + light.channel;
    const stat = (usageData.usage && usageData.usage[key]) ||
      { total_seconds: 0, today_seconds: 0, switch_count: 0, on: false };
    lines.push([
      i + 1,
      csvUsageField(light.name || ''),
      csvUsageField(light.group || ''),
      csvUsageField(getDeviceDisplayName(light.device_ip)),
      (parseInt(light.channel, 10) || 0) + 1,
      stat.on ? '点亮' : '熄灭',
      ((stat.today_seconds || 0) / 60).toFixed(1),
      ((stat.total_seconds || 0) / 60).toFixed(1),
      stat.switch_count || 0
    ].join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '灯具用量报表.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
