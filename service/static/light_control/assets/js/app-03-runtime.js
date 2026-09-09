// Config sync helpers and the first-pass device/light runtime helpers.

function animate() {
  requestAnimationFrame(animate);
  const time = performance.now() * 0.001;
  const delta = animate._lastTime == null ? 0.016 : Math.min(0.05, time - animate._lastTime);
  animate._lastTime = time;
  lamps.forEach(lamp => {
    if (lamp.tick) lamp.tick(time);
  });
  if (walkMode) updateWalkMovement(delta);
  else controls.update();
  renderer.render(scene, camera);
}
animate();

// ========== 状态管理 ==========
let config = { devices: [], lights: [], layout: normalizeLayoutData(DEFAULT_LAYOUT) };
let deviceStatus = {};

async function api(path, method, body) {
  method = method || 'GET';
  const opts = { method: method };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  return await res.json();
}

async function saveConfigData() {
  const r = await api('/api/config', 'POST', config);
  if (r.ok) setLayoutDirty(false);
  return r;
}

async function loadConfig() {
  const data = await api('/api/config');
  config.devices = data.devices || [];
  config.lights = (data.lights || []).map(normalizeLight);
  config.layout = normalizeLayoutData(data.layout);
  selectedLayout = null;
  renderDeviceList();
  renderLightRows();
  rebuildLayoutScene();
  rebuildLamps();
  updateCounts();
  setLayoutDirty(false);
  updateLayoutUI();
}

// ========== 设备列表 ==========
function renderDeviceList() {
  const el = document.getElementById('dev-list');
  el.innerHTML = '';
  if (config.devices.length === 0) {
    el.innerHTML = '<div class="empty-tip">暂无设备,点击下方添加</div>';
    return;
  }
  config.devices.forEach(function(d) {
    const st = deviceStatus[d.ip];
    const on = st && st.connected;
    const row = document.createElement('div');
    row.className = 'dev-item';
    row.innerHTML =
      '<div class="dev-dot ' + (on ? 'on' : '') + '"></div>' +
      '<div class="dev-info">' +
        '<div class="dev-name">' + escapeHtml(d.name || '未命名') + '</div>' +
        '<div class="dev-ip">' + escapeHtml(d.ip) + ':' + d.port + '  ·  Unit ' + d.unit_id + '</div>' +
      '</div>' +
      '<div class="dev-actions">' +
        (on
          ? '<button class="dev-btn d" data-act="disc">断开</button>'
          : '<button class="dev-btn c" data-act="conn">连接</button>') +
        '<button class="dev-btn x" data-act="del" title="删除">×</button>' +
      '</div>';
    row.querySelector('[data-act="conn"]')?.addEventListener('click', () => connectDevice(d));
    row.querySelector('[data-act="disc"]')?.addEventListener('click', () => disconnectDevice(d.ip));
    row.querySelector('[data-act="del"]').addEventListener('click', () => delDevice(d.ip));
    el.appendChild(row);
  });
}

async function connectDevice(d) {
  const r = await api('/api/connect', 'POST', d);
  if (r.ok) {
    deviceStatus[d.ip] = {
      connected: true,
      name: d.name,
      relay_states: r.relay_states
    };
    applyStatus();
  } else {
    alert('连接 ' + d.name + ' 失败: ' + (r.error || '未知错误'));
  }
}

async function disconnectDevice(ip) {
  await api('/api/disconnect', 'POST', { ip: ip });
  if (deviceStatus[ip]) deviceStatus[ip].connected = false;
  applyStatus();
}

async function connectAll() {
  for (const d of config.devices) {
    if (!(deviceStatus[d.ip] && deviceStatus[d.ip].connected)) {
      try { await connectDevice(d); } catch (e) {}
    }
  }
}

async function disconnectAll() {
  await api('/api/disconnect', 'POST', {});
  Object.keys(deviceStatus).forEach(ip => { deviceStatus[ip].connected = false; });
  applyStatus();
}

// ========== 添加/删除设备 ==========
function showDeviceModal() { document.getElementById('dev-modal').classList.add('show'); }
function hideDeviceModal() { document.getElementById('dev-modal').classList.remove('show'); }

async function saveDevice() {
  const d = {
    name: document.getElementById('in-name').value || '未命名',
    ip: document.getElementById('in-ip').value.trim(),
    port: parseInt(document.getElementById('in-port').value),
    unit_id: parseInt(document.getElementById('in-unit').value)
  };
  if (!d.ip) { alert('IP 不能为空'); return; }
  if (isNaN(d.port) || isNaN(d.unit_id)) { alert('端口和设备地址必须是数字'); return; }
  if (config.devices.some(x => x.ip === d.ip)) { alert('该 IP 已存在'); return; }
  config.devices.push(d);
  const r = await saveConfigData();
  if (r.ok) {
    renderDeviceList();
    hideDeviceModal();
  } else {
    alert('保存失败: ' + r.error);
  }
}

async function delDevice(ip) {
  const d = config.devices.find(x => x.ip === ip);
  if (!d) return;
  const relatedLights = config.lights.filter(lt => lt.device_ip === ip);
  let msg = '删除设备 "' + d.name + '" (' + ip + ')?';
  if (relatedLights.length > 0) {
    msg += '\n\n该设备下有 ' + relatedLights.length + ' 个电器配置,会一并删除。';
  }
  if (!confirm(msg)) return;

  if (deviceStatus[ip] && deviceStatus[ip].connected) {
    await disconnectDevice(ip);
  }
  config.devices = config.devices.filter(x => x.ip !== ip);
  config.lights = config.lights.filter(lt => lt.device_ip !== ip);
  delete deviceStatus[ip];
  const r = await saveConfigData();
  if (r.ok) {
    renderDeviceList();
    renderLightRows();
    rebuildLamps();
    updateCounts();
  } else {
    alert('保存失败: ' + r.error);
  }
}

// ========== 电器列表 ==========
function renderLightRows() {
  const el = document.getElementById('light-rows');
  el.innerHTML = '';
  if (config.lights.length === 0) {
    el.innerHTML = '<div class="empty-tip">暂无电器,点击右上角「电器管理」添加</div>';
    return;
  }
  config.lights.forEach(function(lt, i) {
    const meta = getItemMeta(lt.type);
    const st = deviceStatus[lt.device_ip];
    const connected = !!(st && st.connected);
    const on = connected && st.relay_states && st.relay_states[lt.channel];
    const row = document.createElement('div');
    row.className = 'light-row' + (connected ? '' : ' disabled');
    row.id = 'lrow-' + i;
    const devName = (config.devices.find(d => d.ip === lt.device_ip) || {}).name || lt.device_ip;
    row.innerHTML =
      '<div class="l-dot' + (on ? ' on' : '') + '"></div>' +
      '<div class="l-icon' + (on ? ' on' : '') + '" style="--icon-accent:' + meta.accent + ';">' + escapeHtml(meta.icon) + '</div>' +
      '<div class="l-info">' +
        '<div class="l-name' + (on ? ' on' : '') + '">' + escapeHtml(lt.name || '未命名') + '</div>' +
        '<div class="l-sub">' + escapeHtml(meta.label) + ' · ' + escapeHtml(devName) + ' · CH' + String(lt.channel + 1).padStart(2, '0') + '</div>' +
      '</div>' +
      '<div class="l-state' + (on ? ' on' : '') + '">' + (connected ? (on ? 'ON' : 'OFF') : '—') + '</div>' +
      '<div class="toggle' + (on ? ' on' : '') + '"><div class="toggle-knob"></div></div>';
    row.onclick = (function(idx) {
      return function() { toggleLight(idx); };
    })(i);
    el.appendChild(row);
  });
}

function setLightRowUI(i, on, connected) {
  const row = document.getElementById('lrow-' + i);
  if (!row) return;
  const dot = row.querySelector('.l-dot');
  const icon = row.querySelector('.l-icon');
  const name = row.querySelector('.l-name');
  const state = row.querySelector('.l-state');
  const tg = row.querySelector('.toggle');
  if (on) {
    dot.classList.add('on'); name.classList.add('on');
    icon.classList.add('on');
    state.classList.add('on'); state.textContent = 'ON';
    tg.classList.add('on');
  } else {
    dot.classList.remove('on'); name.classList.remove('on');
    icon.classList.remove('on');
    state.classList.remove('on');
    state.textContent = connected ? 'OFF' : '—';
    tg.classList.remove('on');
  }
  if (connected) row.classList.remove('disabled');
  else row.classList.add('disabled');
}

async function toggleLight(lightIdx) {
  const lt = config.lights[lightIdx];
  if (!lt) return;
  const st = deviceStatus[lt.device_ip];
  if (!st || !st.connected) { alert('设备未连接,请先连接对应设备'); return; }
  const cur = !!(lamps[lightIdx] && lamps[lightIdx].state);
  const r = await api('/api/toggle', 'POST', {
    ip: lt.device_ip, channel: lt.channel, value: !cur
  });
  if (r.ok) {
    st.relay_states[lt.channel] = !cur;
    setLampState(lightIdx, !cur);
    setLightRowUI(lightIdx, !cur, true);
    updateCounts();
  } else {
    alert('控制失败: ' + r.error);
  }
}

async function batchAll(value) {
  const tasks = [];
  for (const ip in deviceStatus) {
    if (deviceStatus[ip].connected) {
      tasks.push(api('/api/batch', 'POST', { ip: ip, start: 0, end: 16, value: value }));
    }
  }
  if (tasks.length === 0) { alert('当前没有已连接的设备'); return; }
  await Promise.all(tasks);
  for (const ip in deviceStatus) {
    if (deviceStatus[ip].connected) {
      deviceStatus[ip].relay_states = new Array(16).fill(value);
    }
  }
  applyStatus();
}

// ========== 状态刷新 ==========
async function refreshStatus() {
  const r = await api('/api/status');
  deviceStatus = r.devices || {};
  applyStatus();
}

function applyStatus() {
  renderDeviceList();
  config.lights.forEach(function(lt, i) {
    const st = deviceStatus[lt.device_ip];
    const connected = !!(st && st.connected);
    const on = connected && st.relay_states && st.relay_states[lt.channel];
    setLampState(i, !!on);
    setLightRowUI(i, !!on, connected);
  });
  updateCounts();
}

function updateCounts() {
  let on = 0, total = config.lights.length;
  config.lights.forEach((lt) => {
    const st = deviceStatus[lt.device_ip];
    if (st && st.connected && st.relay_states && st.relay_states[lt.channel]) on++;
  });
  document.getElementById('stat-on').textContent = on;
  document.getElementById('stat-off').textContent = total - on;
}

// ========== 电器管理弹窗 ==========
let editingLights = [];

function getTypeOptionsHtml(selectedType) {
  return ITEM_TYPE_KEYS.map(function(type) {
    const meta = getItemMeta(type);
    return '<option value="' + type + '"' +
      (selectedType === type ? ' selected' : '') + '>' +
      escapeHtml(meta.icon + ' ' + meta.label) + '</option>';
  }).join('');
}

function showLightsModal() {
  if (config.devices.length === 0) {
    alert('请先添加至少一个设备');
    return;
  }
  editingLights = config.lights.map(normalizeLight);
  renderLightsConfig();
  document.getElementById('lights-modal').classList.add('show');
}
function hideLightsModal() {
  document.getElementById('lights-modal').classList.remove('show');
}

function renderLightsConfig() {
  const el = document.getElementById('lc-list');
  el.innerHTML = '';
  if (editingLights.length === 0) {
    el.innerHTML = '<div class="empty-tip">点击下方「添加一个电器」开始配置</div>';
    return;
  }
  editingLights.forEach(function(lt, i) {
    const row = document.createElement('div');
    row.className = 'lc-row';
    row.id = 'light-config-row-' + i;
    let devOptions = '';
    config.devices.forEach(d => {
      devOptions += '<option value="' + escapeHtml(d.ip) + '"' +
        (lt.device_ip === d.ip ? ' selected' : '') + '>' +
        escapeHtml(d.name) + '</option>';
    });
    let chOptions = '';
    for (let c = 0; c < 16; c++) {
      chOptions += '<option value="' + c + '"' +
        (lt.channel === c ? ' selected' : '') +
        '>CH' + String(c + 1).padStart(2, '0') + '</option>';
    }
    const typeOptions = getTypeOptionsHtml(lt.type);
    row.innerHTML =
      '<input class="lc-name" type="text" placeholder="电器名称" value="' + escapeHtml(lt.name || '') + '">' +
      '<select class="lc-type">' + typeOptions + '</select>' +
      '<select class="lc-dev">' + devOptions + '</select>' +
      '<select class="lc-ch">' + chOptions + '</select>' +
      '<button class="lc-del" title="删除">×</button>';
    const inName = row.querySelector('.lc-name');
    const selType = row.querySelector('.lc-type');
    const selDev = row.querySelector('.lc-dev');
    const selCh = row.querySelector('.lc-ch');
    inName.oninput = function() { editingLights[i].name = inName.value; };
    selType.onchange = function() {
      const hadAutoName = isAutoName(editingLights[i].name);
      editingLights[i].type = selType.value;
      if (hadAutoName) {
        editingLights[i].name = getSuggestedLightName(selType.value);
        inName.value = editingLights[i].name;
      }
    };
    selDev.onchange = function() { editingLights[i].device_ip = selDev.value; };
    selCh.onchange = function() { editingLights[i].channel = parseInt(selCh.value); };
    row.querySelector('.lc-del').onclick = function() {
      editingLights.splice(i, 1);
      renderLightsConfig();
    };
    el.appendChild(row);
  });
}

function addLight() {
  if (config.devices.length === 0) { alert('请先添加设备'); return; }
  const defaultIp = config.devices[0].ip;
  const used = new Set(editingLights.filter(lt => lt.device_ip === defaultIp).map(lt => lt.channel));
  let ch = 0;
  for (let c = 0; c < 16; c++) { if (!used.has(c)) { ch = c; break; } }
  editingLights.push({
    name: getSuggestedLightName(DEFAULT_ITEM_TYPE),
    type: DEFAULT_ITEM_TYPE,
    device_ip: defaultIp,
    channel: ch
  });
  renderLightsConfig();
}

async function saveLights() {
  const seen = {};
  for (const lt of editingLights) {
    const key = lt.device_ip + '#' + lt.channel;
    if (seen[key]) {
      alert('设备 ' + lt.device_ip + ' 的通道 CH' + String(lt.channel + 1).padStart(2, '0') + ' 被多个电器绑定,请修改');
      return;
    }
    seen[key] = true;
  }
  config.lights = editingLights.map(lt => {
    const o = {
      name: lt.name || getSuggestedLightName(lt.type),
      type: ITEM_TYPES[lt.type] ? lt.type : DEFAULT_ITEM_TYPE,
      device_ip: lt.device_ip,
      channel: parseInt(lt.channel)
    };
    if (typeof lt.scale === 'number') o.scale = clamp(Number(lt.scale) || 1, 0.4, 3);
    if (typeof lt.mount === 'string') o.mount = lt.mount;
    if (typeof lt.x === 'number') o.x = lt.x;
    if (typeof lt.z === 'number') o.z = lt.z;
    return o;
  });
  const r = await saveConfigData();
  if (r.ok) {
    hideLightsModal();
    renderLightRows();
    rebuildLamps();
    applyStatus();
  } else {
    alert('保存失败: ' + r.error);
  }
}

// ========== 工具 ==========
function refreshLayoutChrome() {
  const toggleBtn = document.getElementById('layout-toggle-btn');
  if (toggleBtn) {
    toggleBtn.textContent = layoutMode ? '退出编辑' : '布局编辑';
    toggleBtn.className = 'btn ' + (layoutMode ? 'btn-primary' : 'btn-ghost');
  }

  ['select', 'wall', 'zone'].forEach(function(tool) {
    const btn = document.getElementById('tool-' + tool);
    if (!btn) return;
    btn.disabled = !layoutMode;
    btn.classList.toggle('active', layoutTool === tool);
  });

  const saveBtn = document.getElementById('layout-save-btn');
  if (saveBtn) saveBtn.textContent = layoutDirty ? '保存布局' : '布局已保存';

  const delBtn = document.getElementById('layout-del-btn');
  if (delBtn) delBtn.disabled = !selectedLayout;

  const statusEl = document.getElementById('layout-status');
  if (statusEl) {
    ensureLayoutConfig();
    const building = config.layout.building;
    statusEl.textContent = '墙体 ' + config.layout.walls.length +
      ' · 区域 ' + config.layout.zones.length +
      ' · 车间 ' + building.width + 'x' + building.depth +
      ' · ' + (layoutDirty ? '未保存' : '已保存') +
      ' · ' + (layoutMode ? '编辑中' : '浏览中');
  }

  const helpEl = document.getElementById('layout-help');
  if (helpEl) {
    if (!layoutMode) {
      helpEl.textContent = '开启布局编辑后，可以在场景里直接画墙体、画区域，也可以在下方修改车间外形。';
    } else if (layoutTool === 'select') {
      helpEl.textContent = '当前是选择工具。点击墙体或区域可选中，再在下方修改尺寸和名称。';
    } else if (layoutTool === 'wall') {
      helpEl.textContent = '当前是画墙工具。按住地面拖出一段距离，松开后即可生成墙体。';
    } else {
      helpEl.textContent = '当前是画区域工具。拖出矩形范围后，就可以给区域命名。';
    }
  }

  refreshLabelToggleUI();
  refreshPanelSections();
  updateSceneHint();
  updateCanvasCursor();
}

function isLampLabelVisible(index) {
  return labelsPinned || focusedLampIdx === index;
}

function refreshLabelToggleUI() {
  const btn = document.getElementById('label-toggle-btn');
  if (!btn) return;
  btn.classList.toggle('on', !!labelsPinned);
  btn.setAttribute('aria-pressed', labelsPinned ? 'true' : 'false');
  btn.title = labelsPinned ? '标签当前为常显模式' : '标签当前为点击显示模式';
}

function drawLabel(lamp, on) {
  const ctx = lamp.labelCanvas.getContext('2d');
  const meta = lamp.meta;
  const width = lamp.labelCanvas.width;
  const height = lamp.labelCanvas.height;
  const deviceLine = (lamp.deviceName || lamp.deviceIp || meta.label || '').slice(0, 18);
  const channelLine = 'CH' + String((lamp.channel || 0) + 1).padStart(2, '0');

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
  const labelSprite = createCanvasSprite(256, 96, 7.8, 2.8, labelY);
  group.add(labelSprite.sprite);

  scene.add(group);

  const lamp = {
    group,
    hit,
    labelCanvas: labelSprite.canvas,
    labelTex: labelSprite.tex,
    label: labelSprite.sprite,
    state: false,
    name: item.name || '',
    meta,
    channel: item.channel,
    deviceIp: item.device_ip,
    deviceName: ((config.devices || []).find(function(device) { return device.ip === item.device_ip; }) || {}).name || item.device_ip || '',
    scale,
    applyState: built.applyState,
    tick: built.tick || null
  };
  if (lamp.applyState) lamp.applyState(false);
  lamp.label.visible = false;
  drawLabel(lamp, false);
  return lamp;
}

function disposeLamp(lamp) {
  if (!lamp) return;
  disposeObjectGraph(lamp.group);
  if (lamp.labelTex) lamp.labelTex.dispose();
}

function computeLayout(lights) {
  const positions = new Array(lights.length);
  const needAutoIdxs = [];
  lights.forEach(function(lt, i) {
    if (typeof lt.x === 'number' && typeof lt.z === 'number') {
      const point = clampFloorPoint({ x: lt.x, z: lt.z });
      positions[i] = { x: point.x, z: point.z };
    } else {
      needAutoIdxs.push(i);
    }
  });
  if (needAutoIdxs.length === 0) return positions;

  const groups = {};
  const order = [];
  needAutoIdxs.forEach(function(i) {
    const ip = lights[i].device_ip;
    if (!groups[ip]) {
      groups[ip] = [];
      order.push(ip);
    }
    groups[ip].push(i);
  });

  const groupCount = order.length || 1;
  const zSpan = Math.max(12 * SCALE, BUILDING.depth - 8 * SCALE);
  const xSpan = Math.max(18 * SCALE, BUILDING.width - 12 * SCALE);
  const bandH = zSpan / groupCount;

  order.forEach(function(ip, gi) {
    const idxs = groups[ip];
    const n = idxs.length;
    const perRow = Math.min(8, Math.max(1, n));
    const rows = Math.ceil(n / perRow);
    const bandCenter = -zSpan / 2 + bandH * (gi + 0.5);

    idxs.forEach(function(idx, i) {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      const xSpacing = Math.min(6 * SCALE, xSpan / Math.max(perRow, 1));
      const x = (c - (perRow - 1) / 2) * xSpacing;
      const rowOffset = (r - (rows - 1) / 2) * Math.min(4 * SCALE, bandH / Math.max(rows, 1));
      positions[idx] = clampFloorPoint({ x, z: bandCenter + rowOffset });
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
  lights.forEach(function(lt, i) {
    const p = positions[i] || { x: 0, z: 0 };
    lamps.push(createLamp(i, p.x, p.z, lt));
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
  lamp.label.visible = isLampLabelVisible(index);
}
