// UI bindings, panel state, and bootstrap.

canvas.addEventListener('pointerdown', function(e) {
  if (typeof isLightingGridMapModeActive === 'function' && isLightingGridMapModeActive()) return;
  if (e.button !== 0 || layoutMode || walkMode) return;
  screenToRay(e);
  const hits = lamps.map(function(lamp) { return lamp.hit; });
  const inter = raycaster.intersectObjects(hits);
  if (inter.length > 0) {
    const idx = inter[0].object.userData.lightIdx;
    // 操控视图下: 点 3D 灯直接开关; 建模视图下: 仅聚焦/选中
    if (typeof topView !== 'undefined' && topView === 'control') {
      if (typeof toggleLight === 'function') toggleLight(idx);
    } else {
      focusLamp(idx);
    }
  } else if (!labelsPinned && !(typeof topView !== 'undefined' && topView === 'control')) {
    focusLamp(null);
  }
});

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PANEL_SECTION_DEFAULTS = {
  devices: false,
  appliances: true
};
let panelSections = Object.assign({}, PANEL_SECTION_DEFAULTS);
const PANEL_EXPANDED_STORAGE_KEY = 'dengkong.panel.expanded';
let panelExpanded = true;

try {
  panelExpanded = localStorage.getItem(PANEL_EXPANDED_STORAGE_KEY) !== '0';
} catch (error) {}

function refreshMainPanel() {
  const panel = document.getElementById('panel');
  const toggle = document.getElementById('panel-toggle');
  const glyph = document.getElementById('panel-toggle-glyph');
  const mini = document.getElementById('panel-mini');
  const panelButton = document.getElementById('panel-visibility-btn');
  const miniButton = document.getElementById('panel-mini-open-btn');
  const label = panelExpanded ? '收起控制面板' : '展开控制面板';

  if (panel) panel.classList.toggle('panel-collapsed', !panelExpanded);
  if (toggle) {
    toggle.setAttribute('aria-expanded', panelExpanded ? 'true' : 'false');
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
  }
  if (glyph) glyph.textContent = panelExpanded ? '>' : '<';
  if (mini) mini.setAttribute('aria-hidden', panelExpanded ? 'true' : 'false');
  if (panelButton) {
    panelButton.textContent = panelExpanded ? '收起侧栏' : '展开侧栏';
    panelButton.setAttribute('aria-label', label);
    panelButton.setAttribute('title', label);
  }
  if (miniButton) {
    miniButton.textContent = panelExpanded ? '已展开' : '打开';
    miniButton.setAttribute('title', '展开控制面板');
  }

  try {
    localStorage.setItem(PANEL_EXPANDED_STORAGE_KEY, panelExpanded ? '1' : '0');
  } catch (error) {}
}

function toggleMainPanel(forceValue) {
  panelExpanded = typeof forceValue === 'boolean' ? forceValue : !panelExpanded;
  refreshMainPanel();
  scheduleSceneResize();
}

function openPanelSection(key) {
  if (!(key in PANEL_SECTION_DEFAULTS)) return;
  panelExpanded = true;
  panelSections[key] = true;
  refreshMainPanel();
  refreshPanelSections();
  requestAnimationFrame(function() {
    const section = document.getElementById('section-' + key);
    if (section) {
      section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
}

function getConnectedDeviceCount() {
  return (config.devices || []).filter(function(device) {
    return !!(deviceStatus[device.ip] && deviceStatus[device.ip].connected);
  }).length;
}

function getLightOnCount() {
  return (config.lights || []).reduce(function(total, light) {
    const status = deviceStatus[light.device_ip];
    return total + (status && status.connected && status.relay_states && status.relay_states[light.channel] ? 1 : 0);
  }, 0);
}

function refreshPanelSections() {
  const deviceCount = (config.devices || []).length;
  const connectedCount = getConnectedDeviceCount();
  const lightCount = (config.lights || []).length;
  const lightOnCount = getLightOnCount();
  const metaText = {
    devices: deviceCount === 0
      ? '暂无设备'
      : connectedCount + ' / ' + deviceCount + ' 已连接',
    appliances: lightCount === 0
      ? '暂无电器'
      : lightOnCount + ' / ' + lightCount + ' 已开启'
  };

  Object.keys(PANEL_SECTION_DEFAULTS).forEach(function(key) {
    const open = !!panelSections[key];
    const root = document.getElementById('section-' + key);
    const body = document.getElementById('body-' + key);
    const toggle = document.querySelector('[data-section-toggle="' + key + '"]');
    const meta = document.getElementById('meta-' + key);
    if (root) root.classList.toggle('open', open);
    if (body) body.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (meta) meta.textContent = metaText[key];
  });

  const miniDevices = document.getElementById('mini-devices');
  const miniAppliances = document.getElementById('mini-appliances');
  if (miniDevices) miniDevices.textContent = String(deviceCount);
  if (miniAppliances) miniAppliances.textContent = String(lightOnCount);
}

function togglePanelSection(key, forceValue) {
  if (!(key in PANEL_SECTION_DEFAULTS)) return;
  panelSections[key] = typeof forceValue === 'boolean' ? forceValue : !panelSections[key];
  refreshPanelSections();
}

window.connectAll = connectAll;
window.disconnectAll = disconnectAll;
window.showDeviceModal = showDeviceModal;
window.hideDeviceModal = hideDeviceModal;
window.saveDevice = saveDevice;
window.showLightsModal = showLightsModal;
window.hideLightsModal = hideLightsModal;
window.addLight = addLight;
window.addLightRow = addLightRow;
window.bindLightRange = bindLightRange;
window.saveLights = saveLights;
window.testDeviceModal = testDeviceModal;
window.showScenesModal = showScenesModal;
window.hideScenesModal = hideScenesModal;
window.addScene = addScene;
window.saveScenes = saveScenes;
window.openSetupWizard = openSetupWizard;
window.hideSetupWizard = hideSetupWizard;
window.setupWizardBack = setupWizardBack;
window.setupWizardNext = setupWizardNext;
window.setupWizardTestDevice = setupWizardTestDevice;
window.applyScene = applyScene;
window.applyGroupState = applyGroupState;
window.toggleLabelPins = toggleLabelPins;
window.toggleMainPanel = toggleMainPanel;
window.openPanelSection = openPanelSection;
window.togglePanelSection = togglePanelSection;
window.batchAll = batchAll;
window.refreshStatus = refreshStatus;
window.toggleLayoutMode = toggleLayoutMode;
window.setLayoutTool = setLayoutTool;
window.saveLayout = saveLayout;
window.deleteSelectedLayout = deleteSelectedLayout;
window.openProjectImportDialog = openProjectImportDialog;
window.handleProjectFileSelection = handleProjectFileSelection;
window.exportProjectConfig = exportProjectConfig;
window.showUsageModal = showUsageModal;
window.hideUsageModal = hideUsageModal;
window.refreshUsageReport = refreshUsageReport;
window.renderUsageReport = renderUsageReport;
window.exportUsageCsv = exportUsageCsv;

// ========== 顶层视图切换 + 操控页 ==========
let topView = 'modeling';      // 'modeling' | 'control' | 'plan' | 'stats'
let controlMode = 'channel';   // 'channel' | 'appliance'
let controlDeviceDetailsOpen = {};
const CONTROL_RESERVED_MODES = [
  { key: 'work', label: '上班模式', meta: '待配置' },
  { key: 'eco', label: '节能模式', meta: '待配置' },
  { key: 'offwork', label: '下班模式', meta: '待配置' }
];

function switchTopView(view) {
  topView = (view === 'control' || view === 'plan' || view === 'stats') ? view : 'modeling';
  const isStats = topView === 'stats';
  const isPlan = topView === 'plan';
  const app = document.getElementById('app');
  const panel = document.getElementById('panel');
  const ctrl = document.getElementById('control-panel');
  const stats = document.getElementById('view-stats');
  const plan = document.getElementById('view-plan');
  // 统计/平面灯控=整页看板(隐藏 3D); 配置/操控共用 #app(3D 常驻)
  if (app) app.style.display = (isStats || isPlan) ? 'none' : 'flex';
  if (stats) stats.style.display = isStats ? 'block' : 'none';
  if (plan) plan.style.display = isPlan ? 'block' : 'none';
  if (!isStats && !isPlan) {
    if (panel) panel.style.display = (topView === 'control') ? 'none' : '';
    if (ctrl) ctrl.style.display = (topView === 'control') ? 'flex' : 'none';
  }
  document.body.classList.toggle('control-mode', topView === 'control');
  const tabs = document.querySelectorAll('.top-tab');
  for (let i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabs[i].getAttribute('data-view') === topView);
  }
  if (topView === 'control') {
    // 操控视图下关掉编辑/漫游/布局, 保证点 3D 灯就是开关
    if (typeof editMode !== 'undefined' && editMode && typeof toggleEditMode === 'function') toggleEditMode(false);
    if (typeof walkMode !== 'undefined' && walkMode && typeof toggleWalkMode === 'function') toggleWalkMode(false);
    if (typeof layoutMode !== 'undefined' && layoutMode && typeof toggleLayoutMode === 'function') toggleLayoutMode(false);
    renderControlView();
  }
  if (isPlan) renderFlatPlanControl();
  if (isStats) refreshStatsData();
  if (!isStats && !isPlan && typeof scheduleSceneResize === 'function') scheduleSceneResize();
}

function setControlMode(mode) {
  controlMode = (mode === 'appliance') ? 'appliance' : 'channel';
  const btns = document.querySelectorAll('.cv-mode');
  for (let i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('active', btns[i].getAttribute('data-mode') === controlMode);
  }
  renderControlView();
}

const CONTROL_PENDING_MIN_MS = 650;
const CONTROL_PENDING_TIMEOUT_MS = 9000;
const pendingControlOps = {};

function controlPendingKey(ip, channel) {
  return String(ip || '') + '#' + String(channel);
}

function getRelayActualState(ip, channel) {
  const status = deviceStatus[ip];
  if (!status || !status.connected || !status.relay_states) return null;
  if (!Object.prototype.hasOwnProperty.call(status.relay_states, channel)) return null;
  return !!status.relay_states[channel];
}

function getPendingControl(ip, channel) {
  const key = controlPendingKey(ip, channel);
  const pending = pendingControlOps[key];
  if (!pending) return null;
  const now = Date.now();
  const actual = getRelayActualState(ip, channel);
  const minElapsed = now - pending.startedAt >= CONTROL_PENDING_MIN_MS;
  if (actual === pending.target && minElapsed) {
    delete pendingControlOps[key];
    return null;
  }
  if (now > pending.expiresAt) {
    delete pendingControlOps[key];
    showToast('warn', '确认超时', '设备回读暂未确认该通道状态，请稍后刷新查看。');
    return null;
  }
  return pending;
}

function isChannelPending(ip, channel) {
  return !!getPendingControl(ip, channel);
}

function getChannelPendingTarget(ip, channel) {
  const pending = getPendingControl(ip, channel);
  return pending ? pending.target : null;
}

function reconcilePendingControls() {
  Object.keys(pendingControlOps).forEach(function(key) {
    const parts = key.split('#');
    getPendingControl(parts[0], parseInt(parts[1], 10));
  });
}

function markChannelPending(ip, channel, target) {
  pendingControlOps[controlPendingKey(ip, channel)] = {
    ip: ip,
    channel: channel,
    target: !!target,
    startedAt: Date.now(),
    expiresAt: Date.now() + CONTROL_PENDING_TIMEOUT_MS
  };
  setTimeout(function() {
    reconcilePendingControls();
    if (typeof applyStatus === 'function') applyStatus();
  }, CONTROL_PENDING_MIN_MS + 40);
  setTimeout(function() {
    reconcilePendingControls();
    if (typeof applyStatus === 'function') applyStatus();
  }, CONTROL_PENDING_TIMEOUT_MS + 40);
}

function clearChannelPending(ip, channel) {
  delete pendingControlOps[controlPendingKey(ip, channel)];
}

window.isChannelPending = isChannelPending;
window.getChannelPendingTarget = getChannelPendingTarget;
window.reconcilePendingControls = reconcilePendingControls;

async function toggleDeviceChannel(ip, channel) {
  if (typeof rejectControlDuringLightingGridMap === 'function' && rejectControlDuringLightingGridMap()) return;
  const status = deviceStatus[ip];
  if (!status || !status.connected) {
    showToast('warn', '设备离线', '请先连接该继电器再操作。');
    return;
  }
  const current = !!(status.relay_states && status.relay_states[channel]);
  const target = !current;
  if (isChannelPending(ip, channel)) return;
  markChannelPending(ip, channel, target);
  applyStatus();
  try {
    const result = await api('/api/toggle', 'POST', { ip: ip, channel: channel, value: target });
    if (result.ok) {
      refreshStatus({ force: true, silent: true });
      scheduleStatusPoll(200);
    } else {
      clearChannelPending(ip, channel);
      applyStatus();
      showToast('error', '控制失败', getFriendlyMessage(result.error || '未知错误', 'control'));
    }
  } catch (error) {
    clearChannelPending(ip, channel);
    applyStatus();
    showToast('error', '控制失败', getFriendlyMessage(getErrorMessage(error, '未知错误'), 'control'));
  }
}

async function toggleDeviceAll(ip, value) {
  if (typeof rejectControlDuringLightingGridMap === 'function' && rejectControlDuringLightingGridMap()) return;
  const status = deviceStatus[ip];
  if (!status || !status.connected) {
    showToast('warn', '设备未连接', '请先连接该继电器再操作。');
    return;
  }

  const device = (config.devices || []).find(function(item) {
    return item.ip === ip;
  });
  const channelCount = device && typeof getDeviceChannelCount === 'function'
    ? getDeviceChannelCount(device)
    : (parseInt(device && device.channel_count, 10) || 32);

  beginRuntimeOperation();
  try {
    const result = await api('/api/batch', 'POST', {
      ip: ip,
      start: 0,
      end: channelCount,
      value: !!value
    });

    if (result.ok) {
      deviceStatus[ip].relay_states = new Array(channelCount).fill(!!value);
      applyStatus();
      scheduleStatusPoll(200);
      showToast(
        'success',
        value ? '继电器已全开' : '继电器已全关',
        getDeviceDisplayName(device || ip) + ' 已更新 ' + channelCount + ' 路。'
      );
    } else {
      showToast('error', '控制失败', getFriendlyMessage(result.error || '未知错误', 'control'));
    }
  } catch (error) {
    showToast('error', '控制失败', getFriendlyMessage(getErrorMessage(error, '未知错误'), 'control'));
  } finally {
    endRuntimeOperation();
  }
}

function controlBreakerHtml(o) {
  // 胶囊滑动开关: 开=绿光在左+ON, 关=橙光在右+OFF; 只显示灯名(如"灯 4-1")
  const cls = 'lsw' + (o.on ? ' on' : '') + (o.pending ? ' pending' : '') + (o.connected ? '' : ' offline');
  return '<div class="' + cls + '" data-ip="' + escapeHtml(o.ip) + '" data-ch="' + o.channel +
    '" data-light="' + o.lightIdx + '" title="' + escapeHtml(o.label) + '">' +
    '<div class="lsw-pill"><span class="lsw-glow"></span>' +
      '<span class="lsw-text">' + (o.pending ? 'WAIT' : (o.on ? 'ON' : 'OFF')) + '</span></div>' +
    '<div class="lsw-label">' + escapeHtml(o.label) + '</div>' +
  '</div>';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function getDeviceBoardStats(device) {
  const channelCount = typeof getDeviceChannelCount === 'function'
    ? getDeviceChannelCount(device)
    : (parseInt(device && device.channel_count, 10) || 32);
  const status = device ? deviceStatus[device.ip] : null;
  const connected = !!(status && status.connected);
  let onCount = 0;
  for (let ch = 0; ch < channelCount; ch++) {
    if (connected && status.relay_states && status.relay_states[ch]) onCount += 1;
  }
  return {
    channelCount: channelCount,
    connected: connected,
    onCount: onCount,
    anyOn: onCount > 0,
    allOn: connected && onCount === channelCount
  };
}

function getDeviceBoardMeta(stats) {
  if (!stats.connected) return '未连接 · 自动重连中';
  return stats.onCount + '/' + stats.channelCount + ' 已开 · 点击' + (stats.anyOn ? '全关' : '全开');
}

function applyReservedMode(modeKey) {
  const mode = CONTROL_RESERVED_MODES.find(function(item) { return item.key === modeKey; });
  showToast('info', mode ? mode.label : '模式预留', '模式联动规则后续可在这里配置。');
}

function renderPrimaryControlButtons() {
  const root = document.getElementById('cv-main-actions');
  if (!root) return;
  root.innerHTML = '';

  const devices = config.devices || [];
  devices.forEach(function(device) {
    const stats = getDeviceBoardStats(device);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cv-big-btn relay' + (stats.anyOn ? ' on' : '') + (stats.connected ? '' : ' offline');
    btn.innerHTML =
      '<span class="cv-big-kicker">继电器</span>' +
      '<span class="cv-big-title">' + escapeHtml(device.name || device.ip) + '</span>' +
      '<span class="cv-big-meta">' + escapeHtml(getDeviceBoardMeta(stats)) + '</span>';
    btn.onclick = function() {
      const freshStats = getDeviceBoardStats(device);
      toggleDeviceAll(device.ip, !freshStats.anyOn);
    };
    root.appendChild(btn);
  });

  CONTROL_RESERVED_MODES.forEach(function(mode) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cv-big-btn mode';
    btn.innerHTML =
      '<span class="cv-big-kicker">模式</span>' +
      '<span class="cv-big-title">' + escapeHtml(mode.label) + '</span>' +
      '<span class="cv-big-meta">' + escapeHtml(mode.meta) + '</span>';
    btn.onclick = function() { applyReservedMode(mode.key); };
    root.appendChild(btn);
  });
}

function renderRelayQuick() {
  const relaysEl = document.getElementById('cv-relays');
  if (!relaysEl) return;

  const devices = config.devices || [];
  relaysEl.innerHTML = '';
  if (!devices.length) {
    relaysEl.innerHTML = '<span class="cv-empty">暂无设备</span>';
    return;
  }

  devices.forEach(function(device) {
    const status = deviceStatus[device.ip];
    const connected = !!(status && status.connected);
    const channelCount = typeof getDeviceChannelCount === 'function'
      ? getDeviceChannelCount(device)
      : (parseInt(device.channel_count, 10) || 32);
    const row = document.createElement('div');
    row.className = 'cv-group' + (connected ? '' : ' offline');

    const info = document.createElement('div');
    info.className = 'cv-group-info';
    const name = document.createElement('span');
    name.className = 'cv-group-name';
    name.textContent = device.name || device.ip;
    const meta = document.createElement('span');
    meta.className = 'cv-group-meta';
    meta.textContent = channelCount + ' 路 · ' + (connected ? '已连接' : '未连接');
    info.appendChild(name);
    info.appendChild(meta);

    const btns = document.createElement('div');
    btns.className = 'cv-group-btns';
    const onBtn = document.createElement('button');
    onBtn.className = 'cv-mini on';
    onBtn.textContent = '全开';
    onBtn.disabled = !connected;
    onBtn.onclick = function() { toggleDeviceAll(device.ip, true); };
    const offBtn = document.createElement('button');
    offBtn.className = 'cv-mini off';
    offBtn.textContent = '全关';
    offBtn.disabled = !connected;
    offBtn.onclick = function() { toggleDeviceAll(device.ip, false); };
    btns.appendChild(onBtn);
    btns.appendChild(offBtn);

    row.appendChild(info);
    row.appendChild(btns);
    relaysEl.appendChild(row);
  });
}

function renderControlQuickActions() {
  const groupsEl = document.getElementById('cv-groups');
  const scenesEl = document.getElementById('cv-scenes');
  if (groupsEl) {
    const stats = (typeof getGroupStats === 'function') ? getGroupStats() : [];
    groupsEl.innerHTML = stats.length ? '' : '<span class="cv-empty">暂无分组</span>';
    stats.forEach(function(g) {
      const chip = document.createElement('div');
      chip.className = 'cv-group';
      chip.innerHTML = '<div class="cv-group-info"><span class="cv-group-name">' + escapeHtml(g.label) +
        '</span><span class="cv-group-meta">' + g.on + '/' + g.count + ' 开</span></div>' +
        '<div class="cv-group-btns"><button class="cv-mini on">开</button><button class="cv-mini off">关</button></div>';
      chip.querySelector('.on').onclick = function() { applyGroupState(g.key, true); };
      chip.querySelector('.off').onclick = function() { applyGroupState(g.key, false); };
      groupsEl.appendChild(chip);
    });
  }
  if (scenesEl) {
    const scenes = (config.scenes || []);
    scenesEl.innerHTML = scenes.length ? '' : '<span class="cv-empty">暂无场景</span>';
    scenes.forEach(function(scene, i) {
      const btn = document.createElement('button');
      btn.className = 'cv-scene';
      btn.textContent = scene.name || ('场景' + (i + 1));
      btn.onclick = function() { applyScene(i); };
      scenesEl.appendChild(btn);
    });
  }
  renderRelayQuick();
}

function renderControlByChannel(body) {
  const devices = config.devices || [];
  if (!devices.length) { body.innerHTML = '<div class="cv-empty-big">客户现场尚未配置设备，请联系管理员。</div>'; return; }
  const lightByKey = {};
  (config.lights || []).forEach(function(l, i) { lightByKey[l.device_ip + '#' + l.channel] = { idx: i, light: l }; });
  let html = '';
  devices.forEach(function(device) {
    const stats = getDeviceBoardStats(device);
    const expanded = !!controlDeviceDetailsOpen[device.ip];
    const connected = stats.connected;
    const status = deviceStatus[device.ip];
    let maxCh = (typeof getDeviceChannelCount === 'function') ? getDeviceChannelCount(device) : (device.channel_count || 32);
    (config.lights || []).forEach(function(l) { if (l.device_ip === device.ip) maxCh = Math.max(maxCh, l.channel + 1); });
    html += '<div class="cv-card ' + (expanded ? 'expanded' : 'collapsed') + '" data-card-ip="' + escapeHtml(device.ip) + '"><div class="cv-card-head">' +
      '<span class="cv-dot ' + (connected ? 'on' : '') + '"></span>' +
      '<span class="cv-card-name">' + escapeHtml(device.name || device.ip) + '</span>' +
      '<span class="cv-card-sub" data-role="device-meta">' + escapeHtml(getDeviceBoardMeta(stats)) + '</span>' +
      '<button class="cv-mini ' + (stats.anyOn ? 'off' : 'on') + '" data-device-toggle-ip="' + escapeHtml(device.ip) + '"' + (connected ? '' : ' disabled') + '>' +
        (stats.anyOn ? '全关' : '全开') +
      '</button>' +
      '<button class="cv-mini" data-detail-ip="' + escapeHtml(device.ip) + '">' + (expanded ? '收起通道' : '展开通道') + '</button>' +
      '</div>';
    if (expanded) {
      html += '<div class="cv-grid">';
      for (let ch = 0; ch < maxCh; ch++) {
        const bound = lightByKey[device.ip + '#' + ch];
        const on = connected && status && status.relay_states && !!status.relay_states[ch];
        const pending = connected && isChannelPending(device.ip, ch);
        html += controlBreakerHtml({
          ip: device.ip, channel: ch, lightIdx: bound ? bound.idx : -1, on: on, pending: pending, connected: connected,
          label: bound ? (bound.light.name || ('通道' + pad2(ch + 1))) : ('通道' + pad2(ch + 1)),
          sub: bound ? ('通道' + pad2(ch + 1)) : '未绑定'
        });
      }
      html += '</div>';
    }
    html += '</div>';
  });
  body.innerHTML = html;
  const toggleBtns = body.querySelectorAll('.cv-mini[data-device-toggle-ip]');
  for (let i = 0; i < toggleBtns.length; i++) {
    toggleBtns[i].onclick = function() {
      const ip = this.getAttribute('data-device-toggle-ip');
      const device = getDeviceByIp(ip);
      const stats = getDeviceBoardStats(device);
      toggleDeviceAll(ip, !stats.anyOn);
    };
  }
  const detailBtns = body.querySelectorAll('.cv-mini[data-detail-ip]');
  for (let i = 0; i < detailBtns.length; i++) {
    detailBtns[i].onclick = function() {
      const ip = this.getAttribute('data-detail-ip');
      controlDeviceDetailsOpen[ip] = !controlDeviceDetailsOpen[ip];
      renderControlView();
    };
  }
}

function renderControlByAppliance(body) {
  const lights = config.lights || [];
  if (!lights.length) { body.innerHTML = '<div class="cv-empty-big">客户现场尚未配置灯具，请联系管理员。</div>'; return; }
  const stats = (typeof getGroupStats === 'function') ? getGroupStats() : [];
  let html = '';
  stats.forEach(function(g) {
    html += '<div class="cv-card"><div class="cv-card-head">' +
      '<span class="cv-card-name">' + escapeHtml(g.label) + '</span>' +
      '<span class="cv-card-sub">' + g.on + '/' + g.count + ' 开</span>' +
      '<button class="cv-mini on" data-group="' + escapeHtml(g.key) + '" data-val="1">全开</button>' +
      '<button class="cv-mini off" data-group="' + escapeHtml(g.key) + '" data-val="0">全关</button>' +
      '</div><div class="cv-grid">';
    g.indices.forEach(function(idx) {
      const light = lights[idx];
      const status = deviceStatus[light.device_ip];
      const connected = !!(status && status.connected);
      const on = connected && status.relay_states && !!status.relay_states[light.channel];
      const pending = connected && isChannelPending(light.device_ip, light.channel);
      html += controlBreakerHtml({
        ip: light.device_ip, channel: light.channel, lightIdx: idx, on: on, pending: pending, connected: connected,
        label: light.name || ('通道' + pad2(light.channel + 1)),
        sub: getDeviceDisplayName(light.device_ip) + ' · 通道' + pad2(light.channel + 1)
      });
    });
    html += '</div></div>';
  });
  body.innerHTML = html;
  // 分组全开/全关
  const minis = body.querySelectorAll('.cv-mini[data-group]');
  for (let i = 0; i < minis.length; i++) {
    minis[i].onclick = function() {
      applyGroupState(this.getAttribute('data-group'), this.getAttribute('data-val') === '1');
    };
  }
}

function renderControlView() {
  const ctrl = document.getElementById('control-panel');
  const body = document.getElementById('cv-body');
  if (!ctrl || !body || topView !== 'control') return;
  renderPrimaryControlButtons();
  renderControlQuickActions();
  if (controlMode === 'appliance') renderControlByAppliance(body);
  else renderControlByChannel(body);
  body.setAttribute('data-mode', controlMode);
}

// 原地更新各开关状态(保留滑动动画、避免每次轮询整块重绘闪烁)
function updateControlStates() {
  const body = document.getElementById('cv-body');
  if (!body) return;
  renderPrimaryControlButtons();
  const sws = body.querySelectorAll('.lsw');
  for (let i = 0; i < sws.length; i++) {
    const sw = sws[i];
    const ip = sw.getAttribute('data-ip');
    const ch = parseInt(sw.getAttribute('data-ch'), 10);
    const status = deviceStatus[ip];
    const connected = !!(status && status.connected);
    const on = connected && status.relay_states && !!status.relay_states[ch];
    const pending = connected && isChannelPending(ip, ch);
    sw.classList.toggle('on', !!on);
    sw.classList.toggle('pending', !!pending);
    sw.classList.toggle('offline', !connected);
    const txt = sw.querySelector('.lsw-text');
    if (txt) txt.textContent = pending ? 'WAIT' : (on ? 'ON' : 'OFF');
  }
  const cards = body.querySelectorAll('.cv-card[data-card-ip]');
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const ip = card.getAttribute('data-card-ip');
    const device = getDeviceByIp(ip);
    if (!device) continue;
    const stats = getDeviceBoardStats(device);
    const dot = card.querySelector('.cv-dot');
    const meta = card.querySelector('[data-role="device-meta"]');
    const toggle = card.querySelector('.cv-mini[data-device-toggle-ip]');
    if (dot) dot.classList.toggle('on', stats.connected);
    if (meta) meta.textContent = getDeviceBoardMeta(stats);
    if (toggle) {
      toggle.disabled = !stats.connected;
      toggle.textContent = stats.anyOn ? '全关' : '全开';
      toggle.classList.toggle('on', !stats.anyOn);
      toggle.classList.toggle('off', stats.anyOn);
    }
  }
  const deviceBtns = body.querySelectorAll('.cv-mini[data-device-toggle-ip]');
  for (let i = 0; i < deviceBtns.length; i++) {
    const btn = deviceBtns[i];
    const ip = btn.getAttribute('data-device-toggle-ip');
    const status = deviceStatus[ip];
    btn.disabled = !(status && status.connected);
  }
  renderControlQuickActions();
}

// 状态轮询时调用: 结构不变就原地更新, 否则全量重建
function syncControlView() {
  if (typeof syncFlatPlanControl === 'function') syncFlatPlanControl();
  if (topView !== 'control') return;
  const body = document.getElementById('cv-body');
  if (!body) return;
  const canUpdateChannel = controlMode === 'channel' &&
    body.querySelectorAll('.cv-card[data-card-ip]').length === (config.devices || []).length;
  const canUpdateAppliance = controlMode === 'appliance' && body.querySelector('.lsw');
  if (body.getAttribute('data-mode') === controlMode && (canUpdateChannel || canUpdateAppliance)) {
    updateControlStates();
  } else {
    renderControlView();
  }
}

function onControlBodyClick(event) {
  const sw = event.target && event.target.closest ? event.target.closest('.lsw') : null;
  if (!sw) return;
  if (sw.classList.contains('offline')) {
    showToast('warn', '设备离线', '系统将自动重连；若持续离线，请联系管理员检查现场设备。');
    return;
  }
  // 乐观动画: 立即翻转胶囊, 服务器确认后由状态同步校正
  if (sw.classList.contains('pending')) return;
  const lightIdx = parseInt(sw.getAttribute('data-light'), 10);
  if (Number.isFinite(lightIdx) && lightIdx >= 0) {
    toggleLight(lightIdx);
  } else {
    toggleDeviceChannel(sw.getAttribute('data-ip'), parseInt(sw.getAttribute('data-ch'), 10));
  }
}

// ========== 车间二维平面灯控 ==========
const FLAT_PLAN_SVG_NS = 'http://www.w3.org/2000/svg';
let flatPlanRenderKey = '';
let flatPlanSelectedLightIdx = null;
let flatPlanInitialScrollDone = false;
let flatPlanModeEditor = null;
let flatPlanAutomaticToggleBusy = false;
const FLAT_PLAN_MODES = Object.freeze({
  work: { name: '上班模式', description: '在2D平面图中配置的上班照明回路' },
  off: { name: '下班模式', description: '在2D平面图中配置的下班照明回路' },
  energy: { name: '节能模式', description: '按日期自动轮换的均匀节能照明方案', dynamic: true },
  auto: { name: '自动模式', description: '按每日时间段自动控制所选照明回路', automatic: true }
});
const FLAT_PLAN_ENERGY_ANCHOR = Object.freeze({ year: 2026, month: 0, day: 1 });
const FLAT_PLAN_ENERGY_CYCLE_DAYS = 8;
const FLAT_PLAN_ENERGY_SPECIAL_COLUMNS = Object.freeze([1, 6, 12]);
const FLAT_PLAN_ENERGY_COLUMN_OFFSETS = Object.freeze({
  2: 0, 3: 0, 4: 1, 5: 1, 7: 2, 8: 2, 9: 3, 10: 3, 11: 0
});

function flatPlanSvgElement(tagName, attributes, parent) {
  const node = document.createElementNS(FLAT_PLAN_SVG_NS, tagName);
  Object.keys(attributes || {}).forEach(function(key) {
    const value = attributes[key];
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  });
  if (parent) parent.appendChild(node);
  return node;
}

function getFlatPlanData() {
  const grid = getRuntimeLightingGrid();
  const extensionGrid = typeof getRuntimeExtensionLightingGrid === 'function'
    ? getRuntimeExtensionLightingGrid()
    : { enabled: false, columns: 0, lightsPerColumn: 0 };
  const draftLights = typeof getLightingGridMapDraftLights === 'function'
    ? getLightingGridMapDraftLights()
    : null;
  const lights = Array.isArray(draftLights)
    ? draftLights
    : (Array.isArray(config.lights) ? config.lights : []);
  const resolved = resolveLightingGridSegmentsForView(lights, grid);
  const routes = [];
  lights.forEach(function(light, lightIndex) {
    const resolvedLight = resolved[lightIndex] || light;
    const segment = typeof getLightingGridSegmentForArea === 'function'
      ? getLightingGridSegmentForArea(resolvedLight)
      : getLightingGridSegment(resolvedLight, grid);
    if (!segment) return;
    const area = segment.area === 'extension' ? 'extension' : 'main';
    routes.push({ light: light, lightIndex: lightIndex, area: area, segment: segment });
  });
  return {
    grid: grid,
    extensionGrid: extensionGrid,
    routes: routes,
    mainRoutes: routes.filter(function(route) { return route.area === 'main'; }),
    extensionRoutes: routes.filter(function(route) { return route.area === 'extension'; }),
    configuring: typeof isLightingGrid2DMapModeActive === 'function' && isLightingGrid2DMapModeActive()
  };
}

function flatPlanPositiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function getFlatPlanLocalDateKey(date) {
  const source = date instanceof Date ? date : new Date();
  const pad = function(value) { return String(value).padStart(2, '0'); };
  return source.getFullYear() + '-' + pad(source.getMonth() + 1) + '-' + pad(source.getDate());
}

function getFlatPlanEnergyDayIndex(date) {
  const source = date instanceof Date ? date : new Date();
  const currentDay = Date.UTC(source.getFullYear(), source.getMonth(), source.getDate());
  const anchorDay = Date.UTC(
    FLAT_PLAN_ENERGY_ANCHOR.year,
    FLAT_PLAN_ENERGY_ANCHOR.month,
    FLAT_PLAN_ENERGY_ANCHOR.day
  );
  const daysSinceAnchor = Math.floor((currentDay - anchorDay) / 86400000);
  return flatPlanPositiveModulo(daysSinceAnchor, FLAT_PLAN_ENERGY_CYCLE_DAYS);
}

function buildFlatPlanEnergyPlan(date, routeSource) {
  const routes = Array.isArray(routeSource) ? routeSource.slice() : getFlatPlanData().routes.slice();
  const dayIndex = getFlatPlanEnergyDayIndex(date);
  const dayParity = dayIndex % 2;
  const rotationRound = Math.floor(dayIndex / 2);
  const routesByColumn = new Map();
  const offLightIndices = new Set();
  const onLightIndices = new Set();
  const columns = [];
  let offPanels = 0;
  let onPanels = 0;

  routes.forEach(function(route) {
    const column = Number(route.segment && route.segment.column);
    if (!Number.isInteger(column)) return;
    const area = route.area === 'extension' ? 'extension' : 'main';
    const columnKey = area + '#' + column;
    if (!routesByColumn.has(columnKey)) routesByColumn.set(columnKey, []);
    routesByColumn.get(columnKey).push(route);
  });

  Array.from(routesByColumn.keys()).sort(function(a, b) {
    const left = routesByColumn.get(a)[0];
    const right = routesByColumn.get(b)[0];
    if (left.area !== right.area) return left.area === 'main' ? -1 : 1;
    return left.segment.column - right.segment.column;
  }).forEach(function(columnKey) {
    const columnRoutes = routesByColumn.get(columnKey).sort(function(a, b) {
      return b.segment.start - a.segment.start;
    });
    const area = columnRoutes[0].area;
    const column = columnRoutes[0].segment.column;
    const offParity = (dayParity + (column % 2)) % 2;
    let offLanes = columnRoutes.map(function(_, lane) { return lane; }).filter(function(lane) {
      return lane % 2 === offParity;
    });
    const isSpecialColumn = FLAT_PLAN_ENERGY_SPECIAL_COLUMNS.indexOf(column) >= 0;
    if (!isSpecialColumn && offLanes.length > 3) {
      const offset = Number(FLAT_PLAN_ENERGY_COLUMN_OFFSETS[column]) || 0;
      const omittedLane = offLanes[flatPlanPositiveModulo(rotationRound + offset, offLanes.length)];
      offLanes = offLanes.filter(function(lane) { return lane !== omittedLane; });
    }
    const offLaneSet = new Set(offLanes);
    columnRoutes.forEach(function(route, lane) {
      if (offLaneSet.has(lane)) {
        offLightIndices.add(route.lightIndex);
        offPanels += route.segment.count;
      } else {
        onLightIndices.add(route.lightIndex);
        onPanels += route.segment.count;
      }
    });
    columns.push({
      area: area,
      column: column,
      routeCount: columnRoutes.length,
      offParity: offParity,
      offLanes: offLanes.slice(),
      offLightIndices: offLanes.map(function(lane) { return columnRoutes[lane].lightIndex; })
    });
  });

  return {
    dateKey: getFlatPlanLocalDateKey(date),
    dayIndex: dayIndex,
    dayNumber: dayIndex + 1,
    cycleDays: FLAT_PLAN_ENERGY_CYCLE_DAYS,
    offLightIndices: offLightIndices,
    onLightIndices: onLightIndices,
    offPanels: offPanels,
    onPanels: onPanels,
    columns: columns
  };
}

function getFlatPlanAutomaticChannelKey(source) {
  const deviceIp = String(source && (source.device_ip || source.ip) || '').trim();
  const channel = parseInt(source && source.channel, 10);
  return deviceIp && Number.isInteger(channel) ? deviceIp + '#' + channel : '';
}

function flatPlanAutomaticTimeToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function flatPlanAutomaticMinutesToTime(value) {
  const minutes = flatPlanPositiveModulo(Math.round(Number(value) || 0), 1440);
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' +
    String(minutes % 60).padStart(2, '0');
}

function isFlatPlanAutomaticPeriodActive(period, date) {
  const source = date instanceof Date ? date : new Date();
  const start = flatPlanAutomaticTimeToMinutes(period && period.start);
  const end = flatPlanAutomaticTimeToMinutes(period && period.end);
  if (start === null || end === null || start === end) return false;
  const minute = source.getHours() * 60 + source.getMinutes();
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

function getFlatPlanActiveAutomaticPeriod(mode, date) {
  const automaticMode = typeof normalizeAutomaticMode === 'function'
    ? normalizeAutomaticMode(mode)
    : (mode || { enabled: false, periods: [] });
  if (!automaticMode.enabled) return null;
  return automaticMode.periods.find(function(period) {
    return isFlatPlanAutomaticPeriodActive(period, date);
  }) || null;
}

function getFlatPlanAutomaticPeriodRanges(period) {
  const start = flatPlanAutomaticTimeToMinutes(period && period.start);
  const end = flatPlanAutomaticTimeToMinutes(period && period.end);
  if (start === null || end === null || start === end) return [];
  return start < end ? [[start, end]] : [[start, 1440], [0, end]];
}

function flatPlanAutomaticPeriodsOverlap(left, right) {
  return getFlatPlanAutomaticPeriodRanges(left).some(function(leftRange) {
    return getFlatPlanAutomaticPeriodRanges(right).some(function(rightRange) {
      return Math.max(leftRange[0], rightRange[0]) < Math.min(leftRange[1], rightRange[1]);
    });
  });
}

function getFlatPlanAutomaticSelectedSet(period, routes) {
  const selectedKeys = new Set((period && period.onChannels || []).map(getFlatPlanAutomaticChannelKey));
  const selected = new Set();
  (routes || getFlatPlanData().routes).forEach(function(route) {
    if (selectedKeys.has(getFlatPlanAutomaticChannelKey(route.light))) selected.add(route.lightIndex);
  });
  return selected;
}

function buildFlatPlanAutomaticEditorPeriods(mode, routes) {
  const automaticMode = typeof normalizeAutomaticMode === 'function'
    ? normalizeAutomaticMode(mode)
    : { enabled: false, periods: [] };
  const periodSources = automaticMode.periods.length ? automaticMode.periods : [{
    id: 'period-' + Date.now(),
    name: '时段1',
    start: '08:00',
    end: '18:00',
    onChannels: []
  }];
  return periodSources.map(function(period, index) {
    return {
      id: period.id,
      name: period.name || ('时段' + (index + 1)),
      start: period.start,
      end: period.end,
      selected: getFlatPlanAutomaticSelectedSet(period, routes)
    };
  });
}

function validateFlatPlanAutomaticPeriods(periods) {
  for (let index = 0; index < periods.length; index += 1) {
    const period = periods[index];
    const start = flatPlanAutomaticTimeToMinutes(period.start);
    const end = flatPlanAutomaticTimeToMinutes(period.end);
    if (start === null || end === null) {
      return { ok: false, message: '第 ' + (index + 1) + ' 个时间段格式不正确。' };
    }
    if (start === end) {
      return { ok: false, message: '第 ' + (index + 1) + ' 个时间段的开始和结束时间不能相同。' };
    }
    if (!period.selected || period.selected.size === 0) {
      return { ok: false, message: '第 ' + (index + 1) + ' 个时间段还没有选择需要点亮的回路。' };
    }
    for (let otherIndex = index + 1; otherIndex < periods.length; otherIndex += 1) {
      if (flatPlanAutomaticPeriodsOverlap(period, periods[otherIndex])) {
        return {
          ok: false,
          message: '第 ' + (index + 1) + ' 与第 ' + (otherIndex + 1) + ' 个时间段存在重叠。'
        };
      }
    }
  }
  return { ok: true };
}

function renderFlatPlanAutomaticEditorControls() {
  const controls = document.getElementById('plan-auto-period-controls');
  const isAutomaticEditor = !!flatPlanModeEditor && flatPlanModeEditor.automatic === true;
  if (!controls) return;
  controls.hidden = !isAutomaticEditor;
  if (!isAutomaticEditor) return;
  const periods = flatPlanModeEditor.periods;
  const activeIndex = Math.max(0, Math.min(periods.length - 1, flatPlanModeEditor.activePeriodIndex));
  const activePeriod = periods[activeIndex];
  const select = document.getElementById('plan-auto-period-select');
  const startInput = document.getElementById('plan-auto-period-start');
  const endInput = document.getElementById('plan-auto-period-end');
  const deleteButton = document.getElementById('plan-auto-period-delete');
  if (select) {
    select.innerHTML = periods.map(function(period, index) {
      return '<option value="' + index + '">时段' + (index + 1) + ' · ' +
        escapeHtml(period.start + '–' + period.end) + ' · ' + period.selected.size + '路</option>';
    }).join('');
    select.value = String(activeIndex);
  }
  if (startInput) startInput.value = activePeriod.start;
  if (endInput) endInput.value = activePeriod.end;
  if (deleteButton) deleteButton.disabled = periods.length <= 1;
}

function getFlatPlanModeDefinition(modeKey) {
  return FLAT_PLAN_MODES[modeKey] || null;
}

function findFlatPlanModeSceneIndex(modeKey) {
  const definition = getFlatPlanModeDefinition(modeKey);
  if (!definition) return -1;
  return (config.scenes || []).findIndex(function(scene) {
    return scene && scene.name === definition.name;
  });
}

function getFlatPlanModeRouteValue(scene, route) {
  if (!scene || !route) return null;
  const light = route.light;
  const stableKey = typeof getLightStateKey === 'function' ? getLightStateKey(light) : '';
  let value = stableKey ? (scene.lightStates || {})[stableKey] : null;
  if (value !== 'on' && value !== 'off') {
    value = (scene.lightStates || {})[String(route.lightIndex + 1)];
  }
  if (value !== 'on' && value !== 'off') value = (scene.deviceStates || {})[light.device_ip];
  if (value !== 'on' && value !== 'off') value = (scene.states || {})[getLightGroupKey(light)];
  return value === 'on' ? true : (value === 'off' ? false : null);
}

function getFlatPlanModeSelectedSet(modeKey) {
  const sceneIndex = findFlatPlanModeSceneIndex(modeKey);
  const scene = sceneIndex >= 0 ? config.scenes[sceneIndex] : null;
  const selected = new Set();
  if (!scene) return selected;
  getFlatPlanData().routes.forEach(function(route) {
    if (getFlatPlanModeRouteValue(scene, route) === true) selected.add(route.lightIndex);
  });
  return selected;
}

function getFlatPlanModeSelectionSummary(selected) {
  const data = getFlatPlanData();
  let panels = 0;
  data.routes.forEach(function(route) {
    if (selected.has(route.lightIndex)) panels += route.segment.count;
  });
  return { circuits: selected.size, panels: panels };
}

function renderFlatPlanModePanel() {
  Object.keys(FLAT_PLAN_MODES).forEach(function(modeKey) {
    const definition = getFlatPlanModeDefinition(modeKey);
    const sceneIndex = findFlatPlanModeSceneIndex(modeKey);
    const status = document.getElementById('plan-mode-' + modeKey + '-status');
    const applyButton = document.getElementById('plan-mode-' + modeKey + '-apply');
    const card = document.querySelector('[data-plan-mode-card="' + modeKey + '"]');
    if (status) {
      if (definition.automatic) {
        const automaticMode = normalizeAutomaticMode(config.automaticMode);
        const activePeriod = getFlatPlanActiveAutomaticPeriod(automaticMode);
        status.textContent = !automaticMode.periods.length
          ? '未配置'
          : (!automaticMode.enabled
            ? '已停用 · ' + automaticMode.periods.length + '时段'
            : (activePeriod
              ? '运行中 · ' + activePeriod.start + '–' + activePeriod.end
              : '无匹配 · 自动全关'));
      } else if (definition.dynamic) {
        const energyPlan = buildFlatPlanEnergyPlan();
        status.textContent = '今日关' + energyPlan.offLightIndices.size + '段 · ' +
          energyPlan.dayNumber + '/' + energyPlan.cycleDays + '轮';
      } else if (sceneIndex < 0) status.textContent = '未保存';
      else {
        const summary = getFlatPlanModeSelectionSummary(getFlatPlanModeSelectedSet(modeKey));
        status.textContent = summary.circuits + '回路 / ' + summary.panels + '盏';
      }
    }
    if (applyButton) {
      if (definition.automatic) {
        const automaticMode = normalizeAutomaticMode(config.automaticMode);
        applyButton.textContent = flatPlanAutomaticToggleBusy
          ? '处理中'
          : (automaticMode.enabled ? '停用' : '启用');
        applyButton.disabled = flatPlanAutomaticToggleBusy || !!flatPlanModeEditor ||
          (!automaticMode.enabled && automaticMode.periods.length === 0);
      } else {
        applyButton.disabled = !!flatPlanModeEditor || (definition.dynamic
          ? getFlatPlanData().routes.length === 0
          : sceneIndex < 0);
      }
    }
    const previewButton = document.getElementById('plan-mode-' + modeKey + '-preview');
    if (previewButton) previewButton.disabled = !!flatPlanModeEditor || getFlatPlanData().routes.length === 0;
    if (card) {
      card.classList.toggle('editing', !!flatPlanModeEditor && flatPlanModeEditor.modeKey === modeKey);
      if (definition.automatic) {
        card.classList.toggle('active', normalizeAutomaticMode(config.automaticMode).enabled);
      }
    }
  });
  const autoConfigButton = document.getElementById('plan-mode-auto-config');
  if (autoConfigButton) autoConfigButton.disabled = !!flatPlanModeEditor || flatPlanAutomaticToggleBusy;

  const editor = document.getElementById('plan-mode-editor');
  if (!editor) return;
  editor.hidden = !flatPlanModeEditor;
  document.body.classList.toggle('plan-mode-editing', !!flatPlanModeEditor);
  if (!flatPlanModeEditor) return;
  const definition = getFlatPlanModeDefinition(flatPlanModeEditor.modeKey);
  const summary = getFlatPlanModeSelectionSummary(flatPlanModeEditor.selected);
  const readOnly = flatPlanModeEditor.readOnly === true;
  const automatic = flatPlanModeEditor.automatic === true;
  const title = document.getElementById('plan-mode-editor-title');
  const count = document.getElementById('plan-mode-editor-count');
  const kicker = document.getElementById('plan-mode-editor-kicker');
  const help = document.getElementById('plan-mode-editor-help');
  const cancelButton = document.getElementById('plan-mode-cancel');
  const saveButton = document.getElementById('plan-mode-save');
  document.querySelectorAll('[data-plan-mode-selection-action]').forEach(function(button) {
    button.hidden = readOnly;
  });
  if (kicker) kicker.textContent = automatic ? '配置自动时间段' : (readOnly ? '今日轮换预览' : '正在配置');
  if (title) {
    title.textContent = automatic
      ? definition.name + ' · 时段' + (flatPlanModeEditor.activePeriodIndex + 1) + '/' +
        flatPlanModeEditor.periods.length
      : (readOnly && flatPlanModeEditor.energyPlan
      ? definition.name + ' · 第' + flatPlanModeEditor.energyPlan.dayNumber + '/' +
        flatPlanModeEditor.energyPlan.cycleDays + '天'
      : definition.name);
  }
  if (count) {
    count.textContent = automatic
      ? '本时段点亮 ' + summary.circuits + ' 个回路，共 ' + summary.panels + ' 盏灯'
      : (readOnly && flatPlanModeEditor.energyPlan
      ? '关闭 ' + flatPlanModeEditor.energyPlan.offLightIndices.size + ' 段，保留 ' +
        flatPlanModeEditor.energyPlan.onLightIndices.size + ' 段'
      : '已选 ' + summary.circuits + ' 个回路，共 ' + summary.panels + ' 盏灯');
  }
  if (help) {
    help.hidden = automatic;
    help.textContent = readOnly
      ? '深色灯段为今日关闭；亮色灯段为保留点亮。方案每天轮换，相邻列不会关闭同一平行位置。'
      : '点击平面图中的灯带，选择此模式下需要点亮的回路；未选回路会在应用模式时关闭。';
  }
  if (cancelButton) cancelButton.textContent = readOnly ? '关闭预览' : '取消';
  if (saveButton) {
    saveButton.disabled = !!flatPlanModeEditor.saving;
    saveButton.textContent = automatic
      ? (flatPlanModeEditor.saving ? '保存中...' : '保存自动模式')
      : (readOnly
      ? (flatPlanModeEditor.saving ? '应用中...' : '应用今日方案')
      : (flatPlanModeEditor.saving ? '保存中...' : '保存模式'));
  }
  renderFlatPlanAutomaticEditorControls();
}

function beginFlatPlanModeEdit(modeKey) {
  const definition = getFlatPlanModeDefinition(modeKey);
  if (!definition || definition.dynamic || definition.automatic) return;
  if (typeof isLightingGridMapModeActive === 'function' && isLightingGridMapModeActive()) {
    showToast('warn', '正在配置灯板', '请先完成或取消当前灯板与继电器映射。');
    return;
  }
  const existingIndex = findFlatPlanModeSceneIndex(modeKey);
  const selected = getFlatPlanModeSelectedSet(modeKey);
  if (existingIndex < 0 && modeKey === 'work') {
    getFlatPlanData().routes.forEach(function(route) {
      if (getFlatPlanLightState(route.light).on) selected.add(route.lightIndex);
    });
  }
  flatPlanModeEditor = { modeKey: modeKey, selected: selected, saving: false };
  flatPlanRenderKey = '';
  renderFlatPlanControl();
  renderFlatPlanModePanel();
  showToast('info', '配置' + definition.name, '点击2D平面图中的灯带选择需要点亮的回路。');
}

function previewFlatPlanEnergyMode() {
  if (typeof isLightingGridMapModeActive === 'function' && isLightingGridMapModeActive()) {
    showToast('warn', '正在配置灯板', '请先完成或取消当前灯板与继电器映射。');
    return;
  }
  const energyPlan = buildFlatPlanEnergyPlan();
  if (energyPlan.onLightIndices.size + energyPlan.offLightIndices.size === 0) {
    showToast('warn', '暂无可用回路', '请先配置灯板与继电器映射。');
    return;
  }
  flatPlanModeEditor = {
    modeKey: 'energy',
    selected: new Set(energyPlan.onLightIndices),
    saving: false,
    readOnly: true,
    energyPlan: energyPlan
  };
  flatPlanRenderKey = '';
  renderFlatPlanControl();
  renderFlatPlanModePanel();
  showToast('info', '节能模式预览', '今日关闭 ' + energyPlan.offLightIndices.size +
    ' 段，处于第 ' + energyPlan.dayNumber + '/' + energyPlan.cycleDays + ' 轮。');
}

function beginFlatPlanAutomaticModeEdit() {
  if (typeof isLightingGridMapModeActive === 'function' && isLightingGridMapModeActive()) {
    showToast('warn', '正在配置灯板', '请先完成或取消当前灯板与继电器映射。');
    return;
  }
  const data = getFlatPlanData();
  if (!data.routes.length) {
    showToast('warn', '暂无可用回路', '请先配置灯板与继电器映射。');
    return;
  }
  const periods = buildFlatPlanAutomaticEditorPeriods(config.automaticMode, data.routes);
  flatPlanModeEditor = {
    modeKey: 'auto',
    automatic: true,
    periods: periods,
    activePeriodIndex: 0,
    selected: periods[0].selected,
    saving: false
  };
  flatPlanRenderKey = '';
  renderFlatPlanControl();
  renderFlatPlanModePanel();
  showToast('info', '配置自动模式', '设置时间段后，在2D平面图中选择该时段需要点亮的回路。');
}

function selectFlatPlanAutomaticPeriod(value) {
  if (!flatPlanModeEditor || !flatPlanModeEditor.automatic) return;
  const index = parseInt(value, 10);
  if (!Number.isInteger(index) || !flatPlanModeEditor.periods[index]) return;
  flatPlanModeEditor.activePeriodIndex = index;
  flatPlanModeEditor.selected = flatPlanModeEditor.periods[index].selected;
  flatPlanRenderKey = '';
  renderFlatPlanControl();
  renderFlatPlanModePanel();
}

function updateFlatPlanAutomaticPeriodTime(field, value) {
  if (!flatPlanModeEditor || !flatPlanModeEditor.automatic || (field !== 'start' && field !== 'end')) return;
  if (flatPlanAutomaticTimeToMinutes(value) === null) return;
  const period = flatPlanModeEditor.periods[flatPlanModeEditor.activePeriodIndex];
  period[field] = value;
  renderFlatPlanModePanel();
}

function addFlatPlanAutomaticPeriod() {
  if (!flatPlanModeEditor || !flatPlanModeEditor.automatic) return;
  const periods = flatPlanModeEditor.periods;
  const previous = periods[periods.length - 1];
  const start = previous ? previous.end : '08:00';
  const startMinutes = flatPlanAutomaticTimeToMinutes(start);
  const index = periods.length;
  periods.push({
    id: 'period-' + Date.now() + '-' + index,
    name: '时段' + (index + 1),
    start: start,
    end: flatPlanAutomaticMinutesToTime((startMinutes === null ? 480 : startMinutes) + 60),
    selected: new Set()
  });
  selectFlatPlanAutomaticPeriod(index);
}

function deleteFlatPlanAutomaticPeriod() {
  if (!flatPlanModeEditor || !flatPlanModeEditor.automatic || flatPlanModeEditor.periods.length <= 1) return;
  flatPlanModeEditor.periods.splice(flatPlanModeEditor.activePeriodIndex, 1);
  const nextIndex = Math.min(flatPlanModeEditor.activePeriodIndex, flatPlanModeEditor.periods.length - 1);
  selectFlatPlanAutomaticPeriod(nextIndex);
}

async function saveFlatPlanAutomaticMode() {
  if (!flatPlanModeEditor || !flatPlanModeEditor.automatic || flatPlanModeEditor.saving) return;
  const validation = validateFlatPlanAutomaticPeriods(flatPlanModeEditor.periods);
  if (!validation.ok) {
    showToast('warn', '自动模式无法保存', validation.message);
    return;
  }
  const previousMode = normalizeAutomaticMode(config.automaticMode);
  const routesByIndex = new Map(getFlatPlanData().routes.map(function(route) {
    return [route.lightIndex, route];
  }));
  const periods = flatPlanModeEditor.periods.map(function(period, index) {
    const onChannels = [];
    period.selected.forEach(function(lightIndex) {
      const route = routesByIndex.get(lightIndex);
      if (!route) return;
      onChannels.push({
        device_ip: route.light.device_ip,
        channel: route.light.channel
      });
    });
    return {
      id: period.id,
      name: '时段' + (index + 1),
      start: period.start,
      end: period.end,
      onChannels: onChannels
    };
  });
  flatPlanModeEditor.saving = true;
  config.automaticMode = normalizeAutomaticMode({
    enabled: previousMode.enabled,
    periods: periods
  });
  renderFlatPlanModePanel();
  try {
    const result = await saveConfigData();
    if (!result.ok) throw new Error(result.error || '保存失败');
    flatPlanModeEditor = null;
    flatPlanRenderKey = '';
    renderFlatPlanControl();
    renderFlatPlanModePanel();
    showToast(
      'success',
      '自动模式已保存',
      previousMode.enabled
        ? periods.length + ' 个时间段已保存并立即交由后台执行。'
        : periods.length + ' 个时间段已保存，可在模式卡片中启用。'
    );
  } catch (error) {
    config.automaticMode = previousMode;
    if (flatPlanModeEditor) flatPlanModeEditor.saving = false;
    renderFlatPlanModePanel();
    showToast('error', '自动模式保存失败', getErrorMessage(error, '无法保存配置'));
  }
}

async function toggleFlatPlanAutomaticMode() {
  if (flatPlanAutomaticToggleBusy || flatPlanModeEditor) return;
  const previousMode = normalizeAutomaticMode(config.automaticMode);
  if (!previousMode.enabled && !previousMode.periods.length) {
    showToast('warn', '自动模式尚未配置', '请先添加时间段并选择该时段需要点亮的回路。');
    beginFlatPlanAutomaticModeEdit();
    return;
  }
  const nextEnabled = !previousMode.enabled;
  if (nextEnabled && !window.confirm('启用后将立即按当前时间段自动控制灯光；若当前没有匹配时段，自动模式会关闭全部已配置灯光。是否继续？')) {
    return;
  }
  flatPlanAutomaticToggleBusy = true;
  config.automaticMode = normalizeAutomaticMode({
    enabled: nextEnabled,
    periods: previousMode.periods
  });
  renderFlatPlanModePanel();
  try {
    const result = await saveConfigData();
    if (!result.ok) throw new Error(result.error || '保存失败');
    showToast(
      'success',
      nextEnabled ? '自动模式已启用' : '自动模式已停用',
      nextEnabled
        ? '后台会在时间段切换时自动调整灯光；临时手动操作会保持到下一次时段切换。'
        : '已停止自动调度，当前灯光状态保持不变。'
    );
  } catch (error) {
    config.automaticMode = previousMode;
    showToast('error', '自动模式切换失败', getErrorMessage(error, '无法保存配置'));
  } finally {
    flatPlanAutomaticToggleBusy = false;
    renderFlatPlanModePanel();
  }
}

function toggleFlatPlanModeRoute(lightIndex) {
  if (!flatPlanModeEditor || !Number.isInteger(lightIndex)) return;
  if (flatPlanModeEditor.readOnly) return;
  if (flatPlanModeEditor.selected.has(lightIndex)) flatPlanModeEditor.selected.delete(lightIndex);
  else flatPlanModeEditor.selected.add(lightIndex);
  flatPlanSelectedLightIdx = lightIndex;
  flatPlanRenderKey = '';
  renderFlatPlanControl();
  renderFlatPlanModePanel();
}

function setFlatPlanModeSelection(value) {
  if (!flatPlanModeEditor || flatPlanModeEditor.readOnly) return;
  flatPlanModeEditor.selected.clear();
  if (value) {
    getFlatPlanData().routes.forEach(function(route) {
      flatPlanModeEditor.selected.add(route.lightIndex);
    });
  }
  flatPlanRenderKey = '';
  renderFlatPlanControl();
  renderFlatPlanModePanel();
}

function cancelFlatPlanModeEdit() {
  flatPlanModeEditor = null;
  flatPlanRenderKey = '';
  renderFlatPlanControl();
  renderFlatPlanModePanel();
}

async function saveFlatPlanMode() {
  if (!flatPlanModeEditor || flatPlanModeEditor.saving) return;
  const definition = getFlatPlanModeDefinition(flatPlanModeEditor.modeKey);
  if (!definition) return;
  if (flatPlanModeEditor.automatic) return saveFlatPlanAutomaticMode();
  if (flatPlanModeEditor.readOnly && flatPlanModeEditor.modeKey === 'energy') {
    flatPlanModeEditor.saving = true;
    renderFlatPlanModePanel();
    const energyResult = await applyFlatPlanEnergyMode();
    if (energyResult && energyResult.ok) cancelFlatPlanModeEdit();
    else if (flatPlanModeEditor) {
      flatPlanModeEditor.saving = false;
      renderFlatPlanModePanel();
    }
    return;
  }
  flatPlanModeEditor.saving = true;
  const saveButton = document.getElementById('plan-mode-save');
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = '保存中...';
  }

  const previousScenes = (config.scenes || []).map(normalizeScene);
  const lightStates = {};
  getFlatPlanData().routes.forEach(function(route) {
    const stableKey = typeof getLightStateKey === 'function' ? getLightStateKey(route.light) : '';
    if (stableKey) {
      lightStates[stableKey] = flatPlanModeEditor.selected.has(route.lightIndex) ? 'on' : 'off';
    }
  });
  const scene = normalizeScene({
    name: definition.name,
    description: definition.description,
    states: {},
    deviceStates: {},
    lightStates: lightStates
  });
  const sceneIndex = findFlatPlanModeSceneIndex(flatPlanModeEditor.modeKey);
  if (sceneIndex >= 0) config.scenes[sceneIndex] = scene;
  else config.scenes.push(scene);

  try {
    const result = await saveConfigData();
    if (!result.ok) throw new Error(result.error || '保存失败');
    const savedName = definition.name;
    flatPlanModeEditor = null;
    flatPlanRenderKey = '';
    renderFlatPlanControl();
    renderFlatPlanModePanel();
    if (typeof refreshExperiencePanels === 'function') refreshExperiencePanels();
    showToast('success', savedName + '已保存', '以后可在平面灯控页一键应用。');
  } catch (error) {
    config.scenes = previousScenes;
    flatPlanModeEditor.saving = false;
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = '保存模式';
    }
    renderFlatPlanModePanel();
    showToast('error', '模式保存失败', getErrorMessage(error, '无法保存配置'));
  }
}

function applyFlatPlanMode(modeKey) {
  const definition = getFlatPlanModeDefinition(modeKey);
  if (definition && definition.dynamic && modeKey === 'energy') return applyFlatPlanEnergyMode();
  const sceneIndex = findFlatPlanModeSceneIndex(modeKey);
  if (!definition || sceneIndex < 0) {
    showToast('warn', '模式尚未配置', '请联系管理员在客户现场灯控系统中保存该模式。');
    return Promise.resolve({ ok: false });
  }
  return applyScene(sceneIndex);
}

function applyFlatPlanEnergyMode(date) {
  const data = getFlatPlanData();
  const energyPlan = buildFlatPlanEnergyPlan(date, data.routes);
  const assignments = data.routes.map(function(route) {
    return {
      device_ip: route.light.device_ip,
      channel: route.light.channel,
      value: !energyPlan.offLightIndices.has(route.lightIndex)
    };
  });
  return applyLightAssignments(assignments, {
    title: '节能模式',
    successBody: '第 ' + energyPlan.dayNumber + '/' + energyPlan.cycleDays +
      ' 轮方案已应用：关闭 ' + energyPlan.offLightIndices.size + ' 段，保留 ' +
      energyPlan.onLightIndices.size + ' 段。',
    emptyBody: '当前没有可用于节能模式的照明回路。'
  });
}

function getFlatPlanBuilding() {
  const layout = config.layout || {};
  const source = layout.building || {};
  const scale = typeof SCALE === 'number' ? SCALE : 10;
  const width = Number(BUILDING && BUILDING.width) || (Number(source.width) || 120) * scale;
  const depth = Number(BUILDING && BUILDING.depth) || (Number(source.depth) || 64) * scale;
  return {
    width: width,
    depth: depth,
    halfW: width / 2,
    halfD: depth / 2
  };
}

function getFlatPlanGeometry() {
  const building = getFlatPlanBuilding();
  const roomSource = (config.layout && config.layout.extensionRoom) || {};
  const roomEnabled = roomSource.enabled === true;
  const roomLength = roomEnabled ? clamp(Number(roomSource.length) || 240, 60, 360) : 0;
  const extensionRoom = {
    enabled: roomEnabled,
    length: roomLength,
    // Match the 3D rule: the extension is flush with both long factory walls.
    width: building.depth,
    boundaryX: -building.halfW,
    outerX: -building.halfW - roomLength,
    lightColumns: clamp(Math.round(Number(roomSource.lightColumns) || 12), 1, 40),
    lightsPerColumn: clamp(Math.round(Number(roomSource.lightsPerColumn) || 14), 1, 120),
    doorCount: clamp(Math.round(Number(roomSource.doorCount) || 3), 1, 6),
    doorWidth: clamp(Number(roomSource.doorWidth) || 52, 24, 96)
  };
  const margin = 54;
  const minWorldX = extensionRoom.enabled ? extensionRoom.outerX : -building.halfW;
  const maxWorldX = building.halfW;
  return {
    building: building,
    extensionRoom: extensionRoom,
    margin: margin,
    minWorldX: minWorldX,
    maxWorldX: maxWorldX,
    viewWidth: maxWorldX - minWorldX + margin * 2,
    viewHeight: building.depth + margin * 2
  };
}

function flatPlanPoint(geometry, worldX, worldZ) {
  return {
    x: geometry.margin + geometry.maxWorldX - worldX,
    y: geometry.margin + geometry.building.halfD - worldZ
  };
}

function getFixedFlatPlanEquipmentFootprints(data, geometry) {
  const metrics = getFlatGridMetrics(data.grid, geometry.building);
  if (metrics.orientation !== 'x') return [];

  // Fixed 2D placement taken from the annotated floor plan. Visual row numbers
  // count from top to bottom, independently of 3D workstation coordinates.
  const lightNumbers = [66, 54, 43, 32, 21, 10];
  const rowBands = [
    { key: 'upper', visualStart: 2, visualEnd: 6 },
    { key: 'lower', visualStart: 8, visualEnd: 12 }
  ];
  const width = Math.max(metrics.panelDepth * 3.6, metrics.lightPitch * 5.2);
  const footprints = [];

  rowBands.forEach(function(band) {
    const startColumn = clamp(data.grid.columns - band.visualStart + 1, 1, data.grid.columns);
    const endColumn = clamp(data.grid.columns - band.visualEnd + 1, 1, data.grid.columns);
    const startCell = getFlatGridCellGeometry(metrics, geometry, startColumn, 1);
    const endCell = getFlatGridCellGeometry(metrics, geometry, endColumn, 1);
    const centerY = (startCell.cy + endCell.cy) / 2;
    const height = Math.abs(endCell.cy - startCell.cy);

    lightNumbers.forEach(function(lightNumber, index) {
      const fixedLightNumber = clamp(lightNumber, 1, data.grid.lightsPerColumn);
      const centerCell = getFlatGridCellGeometry(metrics, geometry, startColumn, fixedLightNumber);
      footprints.push({
        id: 'fixed-' + band.key + '-' + (index + 1),
        row: band.key,
        lightNumber: fixedLightNumber,
        cx: centerCell.cx,
        cy: centerY,
        width: width,
        height: height
      });
    });
  });
  return footprints;
}

function getFlatGridMetrics(grid, building) {
  const columns = Math.max(1, grid.columns);
  const lightsPerColumn = Math.max(1, grid.lightsPerColumn);
  const orientation = grid.orientation === 'x' ? 'x' : 'z';
  const columnSpan = orientation === 'x' ? building.depth : building.width;
  const lightSpan = orientation === 'x' ? building.width : building.depth;
  const columnEdge = clamp(columnSpan * 0.06, 22, 78);
  const lightEdge = clamp(lightSpan * 0.045, 22, 48);
  const usableColumnSpan = Math.max(1, columnSpan - columnEdge * 2);
  const usableLightSpan = Math.max(1, lightSpan - lightEdge * 2);
  const rawColumnPitch = columns > 1 ? usableColumnSpan / (columns - 1) : 0;
  const lightPitch = lightsPerColumn > 1 ? usableLightSpan / (lightsPerColumn - 1) : 0;
  return {
    columns: columns,
    lightsPerColumn: lightsPerColumn,
    orientation: orientation,
    // Keep the physical grid positions stable. Visible row numbering is handled
    // separately by renderFlatPlanLights so labels can change without moving it.
    column0: columns > 1 ? -usableColumnSpan / 2 : 0,
    light0: lightsPerColumn > 1 ? -usableLightSpan / 2 : 0,
    columnPitch: rawColumnPitch,
    lightPitch: lightPitch,
    panelWidth: columns > 1 ? clamp(rawColumnPitch * 0.24, 12, 24) : clamp(columnSpan * 0.04, 14, 28),
    panelDepth: lightsPerColumn > 1 ? clamp(lightPitch * 0.94, 3.4, 14) : 10
  };
}

function getFlatGridCellGeometry(metrics, geometry, column, lightNumber) {
  const columnPosition = metrics.column0 + (column - 1) * metrics.columnPitch;
  const lightPosition = metrics.light0 + (lightNumber - 1) * metrics.lightPitch;
  const worldX = metrics.orientation === 'x' ? lightPosition : columnPosition;
  const worldZ = metrics.orientation === 'x' ? columnPosition : lightPosition;
  const point = flatPlanPoint(geometry, worldX, worldZ);
  const width = metrics.orientation === 'x' ? metrics.panelDepth : metrics.panelWidth;
  const height = metrics.orientation === 'x' ? metrics.panelWidth : metrics.panelDepth;
  return {
    x: point.x - width / 2,
    y: point.y - height / 2,
    width: width,
    height: height,
    cx: point.x,
    cy: point.y
  };
}

function getFlatPlanRenderKey(data, geometry) {
  const activeCell = data.configuring && typeof getLightingGridMapActiveCell === 'function'
    ? getLightingGridMapActiveCell()
    : null;
  const activeRanges = data.configuring && typeof getLightingGridMapRanges === 'function'
    ? getLightingGridMapRanges()
    : [];
  return JSON.stringify({
    grid: data.grid,
    extensionGrid: data.extensionGrid,
    configuring: data.configuring,
    activeCell: activeCell,
    activeRanges: activeRanges,
    modeEditor: flatPlanModeEditor ? {
      modeKey: flatPlanModeEditor.modeKey,
      selected: Array.from(flatPlanModeEditor.selected).sort(function(a, b) { return a - b; })
    } : null,
    routes: data.routes.map(function(route) {
      return [
        route.lightIndex,
        route.area,
        route.segment.column,
        route.segment.start,
        route.segment.count,
        route.light.device_ip,
        route.light.channel
      ];
    }),
    building: [geometry.building.width, geometry.building.depth],
    extensionRoom: geometry.extensionRoom
  });
}

function renderFlatPlanLayout(svg, geometry) {
  const building = geometry.building;
  const entrance = flatPlanPoint(geometry, building.halfW, 0);
  const farEnd = flatPlanPoint(geometry, -building.halfW, 0);
  const floorLayer = flatPlanSvgElement('g', { class: 'plan-floor-layer' }, svg);
  flatPlanSvgElement('rect', {
    x: entrance.x,
    y: geometry.margin,
    width: farEnd.x - entrance.x,
    height: building.depth,
    rx: 8,
    class: 'plan-floor'
  }, floorLayer);

  const room = geometry.extensionRoom;
  if (room && room.enabled) {
    const outerEnd = flatPlanPoint(geometry, room.outerX, 0);
    flatPlanSvgElement('rect', {
      x: farEnd.x,
      y: geometry.margin,
      width: outerEnd.x - farEnd.x,
      height: room.width,
      rx: 8,
      class: 'plan-extension-floor'
    }, floorLayer);
    flatPlanSvgElement('line', {
      x1: farEnd.x,
      y1: geometry.margin,
      x2: farEnd.x,
      y2: geometry.margin + room.width,
      class: 'plan-extension-divider'
    }, floorLayer);

    for (let doorIndex = 0; doorIndex < room.doorCount; doorIndex += 1) {
      const doorCenterZ = -room.width / 2 + (doorIndex + 0.5) * room.width / room.doorCount;
      const doorPoint = flatPlanPoint(geometry, room.boundaryX, doorCenterZ);
      flatPlanSvgElement('rect', {
        x: doorPoint.x - 5,
        y: doorPoint.y - room.doorWidth / 2,
        width: 10,
        height: room.doorWidth,
        rx: 3,
        class: 'plan-door'
      }, floorLayer);
    }

    const label = flatPlanSvgElement('text', {
      x: (farEnd.x + outerEnd.x) / 2,
      y: geometry.margin + 24,
      class: 'plan-room-label'
    }, floorLayer);
    label.textContent = '封箱机区域';
  }

  flatPlanSvgElement('line', {
    x1: entrance.x,
    y1: entrance.y - 42,
    x2: entrance.x,
    y2: entrance.y + 42,
    class: 'plan-main-gate'
  }, floorLayer);
  const mainLabel = flatPlanSvgElement('text', {
    x: entrance.x - 13,
    y: entrance.y + 5,
    class: 'plan-main-label',
    'text-anchor': 'end'
  }, floorLayer);
  mainLabel.textContent = '主入口 →';
}

function renderFlatPlanEquipment(svg, data, geometry) {
  const equipment = getFixedFlatPlanEquipmentFootprints(data, geometry);
  if (equipment.length === 0) return;

  // Rendered immediately above the floor and before every lamp layer. This is
  // a fixed 2D overlay and deliberately does not follow 3D workstation edits.
  const layer = flatPlanSvgElement('g', {
    class: 'plan-equipment-layer',
    'data-equipment-count': equipment.length,
    'aria-hidden': 'true'
  }, svg);
  equipment.forEach(function(item, index) {
    const group = flatPlanSvgElement('g', {
      class: 'plan-equipment-footprint',
      transform: 'translate(' + item.cx + ' ' + item.cy + ')',
      'data-equipment-id': item.id,
      'data-equipment-index': index + 1,
      'data-equipment-row': item.row,
      'data-equipment-light-number': item.lightNumber
    }, layer);
    flatPlanSvgElement('rect', {
      x: -item.width / 2,
      y: -item.height / 2,
      width: item.width,
      height: item.height,
      rx: 5,
      class: 'plan-equipment-frame'
    }, group);
  });
}

function getFlatPlanExtensionCellGeometry(geometry, column, number) {
  const room = geometry.extensionRoom;
  const factoryGrid = getRuntimeLightingGrid();
  const rowGrid = Object.assign({}, factoryGrid, { columns: room.lightColumns });
  const factoryMetrics = getFlatGridMetrics(rowGrid, geometry.building);
  const sampleCell = getFlatGridCellGeometry(factoryMetrics, geometry, column, 1);
  const cellWidth = sampleCell.width;
  const cellHeight = sampleCell.height;
  const stripWidth = room.lightsPerColumn * cellWidth;
  const firstCenterX = room.boundaryX - (room.length - stripWidth) / 2 - cellWidth / 2;
  const worldX = firstCenterX - (number - 1) * cellWidth;
  const point = flatPlanPoint(geometry, worldX, 0);
  return {
    x: point.x - cellWidth / 2,
    y: sampleCell.cy - cellHeight / 2,
    cx: point.x,
    cy: sampleCell.cy,
    width: cellWidth,
    height: cellHeight
  };
}

function renderFlatPlanExtensionLights(svg, data, geometry) {
  const room = geometry.extensionRoom;
  if (!room || !room.enabled) return;

  const layer = flatPlanSvgElement('g', { class: 'plan-extension-light-layer plan-light-layer' }, svg);
  const segmentColorByLight = new Map();
  const routesByColumn = new Map();
  data.extensionRoutes.forEach(function(route) {
    if (!routesByColumn.has(route.segment.column)) routesByColumn.set(route.segment.column, []);
    routesByColumn.get(route.segment.column).push(route);
  });
  routesByColumn.forEach(function(columnRoutes) {
    columnRoutes.sort(function(a, b) { return a.segment.start - b.segment.start; });
    columnRoutes.forEach(function(route, index) {
      segmentColorByLight.set(route.lightIndex, (index % 3) + 1);
    });
  });

  data.extensionRoutes.forEach(function(route) {
    const segment = route.segment;
    const group = flatPlanSvgElement('g', {
      class: 'plan-light-segment plan-extension-light-segment segment-color-' + segmentColorByLight.get(route.lightIndex) + ' offline',
      'data-light-index': route.lightIndex,
      'data-grid-area': 'extension',
      'data-column': segment.column,
      'data-start': segment.start,
      'data-count': segment.count,
      role: 'button',
      tabindex: '0',
      focusable: 'true',
      'aria-pressed': 'false'
    }, layer);
    const title = flatPlanSvgElement('title', {}, group);
    title.textContent = formatLightingGridSegment(segment);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let number = segment.start; number <= segment.end; number += 1) {
      const cell = getFlatPlanExtensionCellGeometry(geometry, segment.column, number);
      minX = Math.min(minX, cell.x);
      minY = Math.min(minY, cell.y);
      maxX = Math.max(maxX, cell.x + cell.width);
      maxY = Math.max(maxY, cell.y + cell.height);
      flatPlanSvgElement('rect', {
        x: cell.x,
        y: cell.y,
        width: cell.width,
        height: cell.height,
        rx: 1.5,
        class: 'plan-light-cell plan-extension-light-cell',
        'data-extension-column': segment.column,
        'data-extension-number': number
      }, group);
    }
    const touchTargetHeight = Math.min(48, Math.max(44, (maxY - minY) + 36));
    const verticalPadding = Math.max(7, (touchTargetHeight - (maxY - minY)) / 2);
    flatPlanSvgElement('rect', {
      x: minX - 2,
      y: minY - verticalPadding,
      width: maxX - minX + 4,
      height: maxY - minY + verticalPadding * 2,
      rx: 4,
      class: 'plan-segment-hit'
    }, group);
  });

  const outerEnd = flatPlanPoint(geometry, room.outerX, 0);
  const caption = flatPlanSvgElement('text', {
    x: outerEnd.x - 12,
    y: geometry.margin + room.width - 14,
    class: 'plan-extension-caption',
    'text-anchor': 'end'
  }, layer);
  caption.textContent = room.lightColumns + '列 × ' + room.lightsPerColumn + '盏灯板';
}

function renderFlatPlanLights(svg, data, geometry) {
  const metrics = getFlatGridMetrics(data.grid, geometry.building);
  const lightLayer = flatPlanSvgElement('g', { class: 'plan-light-layer' }, svg);
  const segmentColorByLight = new Map();
  const routesByColumn = new Map();
  data.mainRoutes.forEach(function(route) {
    if (!routesByColumn.has(route.segment.column)) routesByColumn.set(route.segment.column, []);
    routesByColumn.get(route.segment.column).push(route);
  });
  routesByColumn.forEach(function(columnRoutes) {
    // The entrance/left side is light number 75, so descending start order is
    // the visible left-to-right order. Reset green -> cyan -> pink per column.
    columnRoutes.sort(function(a, b) { return b.segment.start - a.segment.start; });
    columnRoutes.forEach(function(route, index) {
      segmentColorByLight.set(route.lightIndex, (index % 3) + 1);
    });
  });

  for (let column = 1; column <= data.grid.columns; column += 1) {
    const cell = getFlatGridCellGeometry(metrics, geometry, column, 1);
    const label = flatPlanSvgElement('text', {
      x: flatPlanPoint(geometry, -geometry.building.halfW, 0).x - 13,
      y: cell.cy + 4,
      class: 'plan-column-label',
      'text-anchor': 'end'
    }, lightLayer);
    // Physical column 12 is currently drawn at the top. Only reverse the visible
    // label so the plan reads 1 -> 12 from top to bottom; do not move any cells.
    label.textContent = (data.grid.columns - column + 1) + '列';
  }

  [1, 25, 50, 75].forEach(function(number) {
    if (number > data.grid.lightsPerColumn) return;
    const cell = getFlatGridCellGeometry(metrics, geometry, 1, number);
    const label = flatPlanSvgElement('text', {
      x: cell.cx,
      y: geometry.margin - 13,
      class: 'plan-row-label'
    }, lightLayer);
    label.textContent = String(number);
  });

  data.mainRoutes.forEach(function(route) {
    const segment = route.segment;
    const group = flatPlanSvgElement('g', {
      class: 'plan-light-segment segment-color-' + segmentColorByLight.get(route.lightIndex) + ' offline',
      'data-light-index': route.lightIndex,
      'data-column': segment.column,
      'data-start': segment.start,
      'data-count': segment.count,
      role: 'button',
      tabindex: '0',
      focusable: 'true',
      'aria-pressed': 'false'
    }, lightLayer);
    const title = flatPlanSvgElement('title', {}, group);
    title.textContent = formatLightingGridSegment(segment);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let number = segment.start; number <= segment.end; number += 1) {
      const cell = getFlatGridCellGeometry(metrics, geometry, segment.column, number);
      minX = Math.min(minX, cell.x);
      minY = Math.min(minY, cell.y);
      maxX = Math.max(maxX, cell.x + cell.width);
      maxY = Math.max(maxY, cell.y + cell.height);
      flatPlanSvgElement('rect', {
        x: cell.x,
        y: cell.y,
        width: cell.width,
        height: cell.height,
        rx: 1.5,
        class: 'plan-light-cell',
        'data-light-number': number
      }, group);
    }
    // The horizontal drawing makes each circuit a long strip. Keep the visible
    // cells slim, but widen the transparent target vertically for touch input.
    const touchTargetHeight = Math.min(48, Math.max(44, metrics.columnPitch * 0.82));
    const verticalPadding = Math.max(7, (touchTargetHeight - (maxY - minY)) / 2);
    flatPlanSvgElement('rect', {
      x: minX - 2,
      y: minY - verticalPadding,
      width: maxX - minX + 4,
      height: maxY - minY + verticalPadding * 2,
      rx: 4,
      class: 'plan-segment-hit'
    }, group);
  });
}

function renderFlatPlanConfigurationCells(svg, data, geometry) {
  if (!data.configuring) return;
  const metrics = getFlatGridMetrics(data.grid, geometry.building);
  const currentRanges = typeof getLightingGridMapRanges === 'function' ? getLightingGridMapRanges() : [];
  const activeCell = typeof getLightingGridMapActiveCell === 'function' ? getLightingGridMapActiveCell() : null;
  const occupied = new Set();

  data.routes.forEach(function(route) {
    for (let number = route.segment.start; number <= route.segment.end; number += 1) {
      occupied.add(route.area + '#' + route.segment.column + '#' + number);
    }
  });

  const layer = flatPlanSvgElement('g', { class: 'plan-config-layer' }, svg);
  const renderCell = function(area, column, number, cell) {
    const inCurrentRange = currentRanges.some(function(range) {
      const rangeArea = range.area === 'extension' ? 'extension' : 'main';
      return rangeArea === area && range.column === column && number >= range.start && number <= range.end;
    });
    const activeArea = activeCell && activeCell.area === 'extension' ? 'extension' : 'main';
    const isStart = !!(activeCell && activeArea === area && activeCell.column === column && activeCell.number === number);
    const cellKey = area + '#' + column + '#' + number;
    const classes = ['plan-config-cell', occupied.has(cellKey) ? 'assigned' : 'unassigned'];
    if (inCurrentRange) classes.push('current-range');
    if (isStart) classes.push('start-cell');
    flatPlanSvgElement('rect', {
      x: cell.x - 1.5,
      y: cell.y - 1.5,
      width: cell.width + 3,
      height: cell.height + 3,
      rx: 2,
      class: classes.join(' '),
      'data-grid-area': area,
      'data-grid-column': column,
      'data-grid-number': number,
      role: 'button',
      tabindex: isStart ? '0' : '-1',
      'aria-label': (area === 'extension' ? '封箱机区域' : '主车间') + '第' + column + '列第' + number + '号灯板'
    }, layer);
  };
  for (let column = 1; column <= data.grid.columns; column += 1) {
    for (let number = 1; number <= data.grid.lightsPerColumn; number += 1) {
      renderCell('main', column, number, getFlatGridCellGeometry(metrics, geometry, column, number));
    }
  }
  if (geometry.extensionRoom.enabled && data.extensionGrid.enabled) {
    for (let column = 1; column <= data.extensionGrid.columns; column += 1) {
      for (let number = 1; number <= data.extensionGrid.lightsPerColumn; number += 1) {
        renderCell('extension', column, number, getFlatPlanExtensionCellGeometry(geometry, column, number));
      }
    }
  }
}

function renderFlatPlanUnassignedCells(svg, data, geometry) {
  if (data.configuring) return;
  const metrics = getFlatGridMetrics(data.grid, geometry.building);
  const occupied = new Set();
  data.routes.forEach(function(route) {
    for (let number = route.segment.start; number <= route.segment.end; number += 1) {
      occupied.add(route.area + '#' + route.segment.column + '#' + number);
    }
  });

  const layer = flatPlanSvgElement('g', { class: 'plan-unassigned-layer' }, svg);
  for (let column = 1; column <= data.grid.columns; column += 1) {
    for (let number = 1; number <= data.grid.lightsPerColumn; number += 1) {
      if (occupied.has('main#' + column + '#' + number)) continue;
      const cell = getFlatGridCellGeometry(metrics, geometry, column, number);
      flatPlanSvgElement('rect', {
        x: cell.x,
        y: cell.y,
        width: cell.width,
        height: cell.height,
        rx: 1.5,
        class: 'plan-unassigned-cell'
      }, layer);
    }
  }
  if (geometry.extensionRoom.enabled && data.extensionGrid.enabled) {
    for (let column = 1; column <= data.extensionGrid.columns; column += 1) {
      for (let number = 1; number <= data.extensionGrid.lightsPerColumn; number += 1) {
        if (occupied.has('extension#' + column + '#' + number)) continue;
        const cell = getFlatPlanExtensionCellGeometry(geometry, column, number);
        flatPlanSvgElement('rect', {
          x: cell.x,
          y: cell.y,
          width: cell.width,
          height: cell.height,
          rx: 1.5,
          class: 'plan-unassigned-cell plan-extension-unassigned-cell',
          'data-grid-area': 'extension',
          'data-extension-column': column,
          'data-extension-number': number
        }, layer);
      }
    }
  }
}

function getFlatPlanLightState(light) {
  const status = light ? deviceStatus[light.device_ip] : null;
  const connected = !!(status && status.connected);
  const on = !!(connected && status.relay_states && status.relay_states[light.channel]);
  const pending = !!(connected && typeof isChannelPending === 'function' && isChannelPending(light.device_ip, light.channel));
  return { connected: connected, on: on, pending: pending };
}

function getFlatPlanStateLabel(state) {
  if (!state.connected) return '继电器离线';
  if (state.pending) return '等待设备确认';
  return state.on ? '已打开' : '已关闭';
}

function renderFlatPlanInspector(data) {
  const route = data.routes.find(function(item) {
    return item.lightIndex === flatPlanSelectedLightIdx;
  });
  const title = document.getElementById('plan-selection-title');
  const meta = document.getElementById('plan-selection-meta');
  const stateNode = document.getElementById('plan-selection-state');
  const toggleButton = document.getElementById('plan-selection-toggle');
  const view3dButton = document.getElementById('plan-selection-3d');

  if (!route) {
    if (title) title.textContent = '请选择图中的灯光区段';
    if (meta) meta.textContent = '点击灯格即可查看并操控对应开关。';
    if (stateNode) {
      stateNode.className = 'plan-selection-state offline';
      stateNode.textContent = '未选择';
    }
    if (toggleButton) toggleButton.disabled = true;
    if (view3dButton) view3dButton.disabled = true;
    return;
  }

  const light = route.light;
  const segment = route.segment;
  const state = getFlatPlanLightState(light);
  if (title) title.textContent = (route.area === 'extension' ? '封箱机区域 · ' : '') +
    '第' + segment.column + '列 · ' + segment.start + '–' + segment.end + '号灯';
  if (meta) {
    meta.textContent = (light.name || '未命名回路') + ' · ' + segment.count + '块灯板 · ' +
      getDeviceDisplayName(light.device_ip) + ' / CH' + String(Number(light.channel) + 1).padStart(2, '0');
  }
  if (flatPlanModeEditor) {
    const selectedForMode = flatPlanModeEditor.selected.has(route.lightIndex);
    const readOnlyMode = flatPlanModeEditor.readOnly === true;
    const automaticMode = flatPlanModeEditor.automatic === true;
    if (meta) {
      meta.textContent = (light.name || '未命名回路') + ' · ' + segment.count + '盏灯 · ' +
        (readOnlyMode
          ? '由今日节能轮换方案自动计算'
          : (automaticMode ? '点击图中灯带，设置当前时间段是否点亮' : '点击图中灯带或下方按钮切换模式选择'));
    }
    if (stateNode) {
      stateNode.className = 'plan-selection-state ' + (selectedForMode ? 'on' : 'off');
      stateNode.textContent = readOnlyMode
        ? (selectedForMode ? '今日保留点亮' : '今日关闭节能')
        : (automaticMode
          ? (selectedForMode ? '此时段点亮' : '此时段关闭')
          : (selectedForMode ? '模式中点亮' : '模式中熄灭'));
    }
    if (toggleButton) {
      toggleButton.disabled = readOnlyMode;
      toggleButton.textContent = readOnlyMode
        ? '自动轮换，不可手动修改'
        : (automaticMode
          ? (selectedForMode ? '从此时段移除' : '加入此时间段')
          : (selectedForMode ? '从模式中移除' : '加入点亮模式'));
    }
    if (view3dButton) view3dButton.disabled = true;
    return;
  }
  if (stateNode) {
    const stateClass = !state.connected ? 'offline' : (state.pending ? 'pending' : (state.on ? 'on' : 'off'));
    stateNode.className = 'plan-selection-state ' + stateClass;
    stateNode.textContent = getFlatPlanStateLabel(state);
  }
  if (toggleButton) {
    toggleButton.disabled = state.pending || !state.connected;
    toggleButton.textContent = !state.connected
      ? '继电器离线'
      : (state.pending ? '等待确认' : (state.on ? '关闭此回路' : '打开此回路'));
  }
  if (view3dButton) view3dButton.disabled = false;
}

function updateFlatPlanStates(data) {
  const svg = document.getElementById('flat-plan-svg');
  if (!svg) return;
  let onPanels = 0;
  let offPanels = 0;
  let offlinePanels = 0;
  let assignedPanels = 0;
  data.routes.forEach(function(route) {
    assignedPanels += route.segment.count;
    const state = getFlatPlanLightState(route.light);
    const group = svg.querySelector('.plan-light-segment[data-light-index="' + route.lightIndex + '"]');
    if (!state.connected) offlinePanels += route.segment.count;
    else if (state.on) onPanels += route.segment.count;
    else offPanels += route.segment.count;
    if (!group) return;
    group.classList.remove('on', 'off', 'pending', 'offline', 'selected', 'mode-selected', 'mode-unselected');
    group.classList.add(!state.connected ? 'offline' : (state.pending ? 'pending' : (state.on ? 'on' : 'off')));
    group.classList.toggle('selected', route.lightIndex === flatPlanSelectedLightIdx);
    if (flatPlanModeEditor) {
      const selectedForMode = flatPlanModeEditor.selected.has(route.lightIndex);
      group.classList.add(selectedForMode ? 'mode-selected' : 'mode-unselected');
      group.setAttribute('aria-pressed', selectedForMode ? 'true' : 'false');
      group.setAttribute('aria-disabled', flatPlanModeEditor.readOnly ? 'true' : 'false');
    } else {
      group.setAttribute('aria-pressed', state.on ? 'true' : 'false');
      group.setAttribute('aria-disabled', state.connected ? 'false' : 'true');
    }
    group.setAttribute(
      'aria-label',
      (route.area === 'extension' ? '封箱机区域，' : '主车间，') +
      '第' + route.segment.column + '列，' + route.segment.start + '到' + route.segment.end + '号灯，' +
      route.segment.count + '块灯板，' + getFlatPlanStateLabel(state)
    );
    const title = group.querySelector('title');
    if (title) title.textContent = formatLightingGridSegment(route.segment) + ' · ' + getFlatPlanStateLabel(state);
  });

  const mainPanels = data.grid.columns * data.grid.lightsPerColumn;
  const roomSource = (config.layout && config.layout.extensionRoom) || {};
  const extensionPanels = roomSource.enabled === true
    ? clamp(Math.round(Number(roomSource.lightColumns) || 12), 1, 40) *
      clamp(Math.round(Number(roomSource.lightsPerColumn) || 14), 1, 120)
    : 0;
  const totalPanels = mainPanels + extensionPanels;
  offlinePanels += Math.max(0, totalPanels - assignedPanels);
  const totalNode = document.getElementById('plan-total-panels');
  const totalDetailNode = document.getElementById('plan-total-detail');
  const onNode = document.getElementById('plan-on-panels');
  const onPercentNode = document.getElementById('plan-on-percent');
  const offNode = document.getElementById('plan-off-panels');
  const offlineNode = document.getElementById('plan-offline-panels');
  const circuitsNode = document.getElementById('plan-circuit-count');
  if (totalNode) totalNode.textContent = totalPanels;
  if (totalDetailNode) {
    totalDetailNode.textContent = extensionPanels
      ? ('主车间 ' + data.grid.columns + '×' + data.grid.lightsPerColumn + ' + 封箱机区域 ' + extensionPanels)
      : (data.grid.columns + '列 × ' + data.grid.lightsPerColumn);
  }
  const visibleOnPanels = Math.min(totalPanels, onPanels);
  if (onNode) onNode.textContent = visibleOnPanels;
  if (onPercentNode) {
    onPercentNode.textContent = (totalPanels > 0 ? (visibleOnPanels / totalPanels) * 100 : 0).toFixed(1) + '%';
  }
  if (offNode) offNode.textContent = Math.min(totalPanels, offPanels);
  if (offlineNode) offlineNode.textContent = Math.min(totalPanels, offlinePanels);
  if (circuitsNode) circuitsNode.textContent = data.routes.length;
  renderFlatPlanInspector(data);
  renderFlatPlanModePanel();
}

function syncFlatPlanViewportAspect(svg) {
  if (!svg) return;
  const widePlan = window.matchMedia && window.matchMedia(
    '(min-width: 1200px) and (min-height: 720px), (min-width: 760px) and (min-height: 420px) and (min-aspect-ratio: 139/100)'
  ).matches;
  const mobilePlan = window.matchMedia && window.matchMedia(
    '(max-width: 759px), (min-width: 760px) and (max-width: 820px) and (max-aspect-ratio: 139/100)'
  ).matches;
  const useScrollableMobilePlan = mobilePlan && !widePlan;
  svg.setAttribute('preserveAspectRatio', useScrollableMobilePlan ? 'xMidYMid meet' : 'none');
}

function renderFlatPlanControl() {
  const svg = document.getElementById('flat-plan-svg');
  if (!svg) return;
  syncFlatPlanViewportAspect(svg);
  const data = getFlatPlanData();
  const geometry = getFlatPlanGeometry();
  const nextKey = getFlatPlanRenderKey(data, geometry);
  if (flatPlanRenderKey === nextKey && svg.childNodes.length > 0) {
    updateFlatPlanStates(data);
    return;
  }

  flatPlanRenderKey = nextKey;
  svg.innerHTML = '';
  svg.setAttribute('viewBox', '0 0 ' + geometry.viewWidth + ' ' + geometry.viewHeight);
  svg.setAttribute('data-columns', data.grid.columns);
  svg.setAttribute('data-lights-per-column', data.grid.lightsPerColumn);
  svg.setAttribute('data-circuits', data.routes.length);
  renderFlatPlanLayout(svg, geometry);
  renderFlatPlanEquipment(svg, data, geometry);
  renderFlatPlanExtensionLights(svg, data, geometry);
  renderFlatPlanLights(svg, data, geometry);
  renderFlatPlanUnassignedCells(svg, data, geometry);
  renderFlatPlanConfigurationCells(svg, data, geometry);

  if (!data.routes.some(function(route) { return route.lightIndex === flatPlanSelectedLightIdx; })) {
    flatPlanSelectedLightIdx = data.routes.length ? data.routes[0].lightIndex : null;
  }
  updateFlatPlanStates(data);

  if (!flatPlanInitialScrollDone) {
    flatPlanInitialScrollDone = true;
    requestAnimationFrame(function() {
      const scroll = document.getElementById('plan-map-scroll');
      if (scroll) {
        scroll.scrollLeft = 0;
        scroll.scrollTop = 0;
      }
    });
  }
}

function syncFlatPlanControl() {
  if (topView !== 'plan') return;
  renderFlatPlanControl();
}

function syncFlatPlanMapConfiguration() {
  flatPlanRenderKey = '';
  if (topView === 'plan') renderFlatPlanControl();
}

function focusFlatPlanGridRange(segment) {
  if (!segment) return false;
  syncFlatPlanMapConfiguration();
  const svg = document.getElementById('flat-plan-svg');
  if (!svg) return false;
  const middle = Math.round((Number(segment.start) + Number(segment.end)) / 2);
  const area = segment.area === 'extension' ? 'extension' : 'main';
  const target = svg.querySelector(
    '.plan-config-cell[data-grid-area="' + area + '"][data-grid-column="' + Number(segment.column) + '"][data-grid-number="' + middle + '"]'
  );
  if (!target) return false;
  requestAnimationFrame(function() {
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  });
  return true;
}

function selectFlatPlanSegment(lightIndex) {
  if (!Number.isInteger(lightIndex) || !config.lights[lightIndex]) return;
  flatPlanSelectedLightIdx = lightIndex;
  updateFlatPlanStates(getFlatPlanData());
}

function toggleFlatPlanSelected() {
  if (typeof rejectControlDuringLightingGridMap === 'function' && rejectControlDuringLightingGridMap()) return;
  if (!Number.isInteger(flatPlanSelectedLightIdx)) return;
  if (flatPlanModeEditor) {
    toggleFlatPlanModeRoute(flatPlanSelectedLightIdx);
    return;
  }
  toggleLight(flatPlanSelectedLightIdx);
}

function setFlatPlanAllLights(value) {
  if (typeof rejectControlDuringLightingGridMap === 'function' && rejectControlDuringLightingGridMap()) return;
  const assignments = getFlatPlanData().routes.map(function(route) {
    const light = route.light;
    return {
      device_ip: light.device_ip,
      channel: light.channel,
      value: !!value
    };
  });
  return applyLightAssignments(assignments, {
    title: value ? '平面照明全部打开' : '平面照明全部关闭',
    successBody: '已更新平面图中的 ' + assignments.length + ' 个照明回路。',
    emptyBody: '当前平面图中没有可执行的照明回路。'
  });
}

function showFlatPlanSelectionIn3D() {
  if (!Number.isInteger(flatPlanSelectedLightIdx)) return;
  const lightIndex = flatPlanSelectedLightIdx;
  window.switchTopView('control');
  requestAnimationFrame(function() {
    if (window.BabylonApp && typeof window.BabylonApp.focusLight === 'function') {
      window.BabylonApp.focusLight(lightIndex);
    }
  });
}

function getFlatPlanSegmentFromEvent(event) {
  const target = event.target && event.target.closest ? event.target.closest('.plan-light-segment') : null;
  if (!target) return null;
  const lightIndex = parseInt(target.getAttribute('data-light-index'), 10);
  return Number.isInteger(lightIndex) ? { node: target, lightIndex: lightIndex } : null;
}

function getFlatPlanConfigCellFromEvent(event) {
  const target = event.target && event.target.closest ? event.target.closest('.plan-config-cell') : null;
  if (!target) return null;
  const column = parseInt(target.getAttribute('data-grid-column'), 10);
  const number = parseInt(target.getAttribute('data-grid-number'), 10);
  const area = target.getAttribute('data-grid-area') === 'extension' ? 'extension' : 'main';
  return Number.isInteger(column) && Number.isInteger(number)
    ? { node: target, area: area, column: column, number: number }
    : null;
}

function onFlatPlanClick(event) {
  if (typeof isLightingGrid2DMapModeActive === 'function' && isLightingGrid2DMapModeActive()) {
    const cell = getFlatPlanConfigCellFromEvent(event);
    if (cell && typeof handleLightingGridScenePick === 'function') {
      handleLightingGridScenePick({ area: cell.area, column: cell.column, number: cell.number });
      event.preventDefault();
    }
    return;
  }
  const segment = getFlatPlanSegmentFromEvent(event);
  if (!segment) return;
  selectFlatPlanSegment(segment.lightIndex);
  if (flatPlanModeEditor) {
    toggleFlatPlanModeRoute(segment.lightIndex);
    event.preventDefault();
    return;
  }
  if (!getFlatPlanLightState(config.lights[segment.lightIndex]).connected) return;
  toggleLight(segment.lightIndex);
}

function onFlatPlanKeyDown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (typeof isLightingGrid2DMapModeActive === 'function' && isLightingGrid2DMapModeActive()) {
    const cell = getFlatPlanConfigCellFromEvent(event);
    if (cell && typeof handleLightingGridScenePick === 'function') {
      event.preventDefault();
      handleLightingGridScenePick({ area: cell.area, column: cell.column, number: cell.number });
    }
    return;
  }
  const segment = getFlatPlanSegmentFromEvent(event);
  if (!segment) return;
  event.preventDefault();
  selectFlatPlanSegment(segment.lightIndex);
  if (flatPlanModeEditor) {
    toggleFlatPlanModeRoute(segment.lightIndex);
    return;
  }
  if (!getFlatPlanLightState(config.lights[segment.lightIndex]).connected) return;
  toggleLight(segment.lightIndex);
}

function onFlatPlanFocus(event) {
  if (typeof isLightingGrid2DMapModeActive === 'function' && isLightingGrid2DMapModeActive()) return;
  const segment = getFlatPlanSegmentFromEvent(event);
  if (segment) selectFlatPlanSegment(segment.lightIndex);
}

// ========== 使用统计看板 ==========
let statsRange = 7;       // 1 | 7 | 30 天
let statsDim = 'light';   // 'light' | 'group' | 'device'

function _statsLights() {
  return (config.lights || []).map(function(l, i) {
    const key = l.device_ip + '#' + l.channel;
    const u = (usageData && usageData.usage && usageData.usage[key]) ||
      { total_seconds: 0, today_seconds: 0, switch_count: 0, on: false, daily: {} };
    return { light: l, idx: i, key: key, u: u };
  });
}

function _statsDayList(n) {
  const out = [];
  const today = (usageData && usageData.today) || null;
  let base;
  if (today) { const p = today.split('-'); base = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
  else base = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    out.push({ iso: d.getFullYear() + '-' + mm + '-' + dd, label: mm + '-' + dd });
  }
  return out;
}

function _statsAgg(items, dim) {
  if (dim === 'light') {
    return items.map(function(it) {
      return { label: it.light.name || ('通道' + pad2(it.light.channel + 1)),
        total: it.u.total_seconds || 0, today: it.u.today_seconds || 0,
        count: it.u.switch_count || 0, on: !!it.u.on, daily: it.u.daily || {} };
    });
  }
  const map = {}; const order = [];
  items.forEach(function(it) {
    let k, label;
    if (dim === 'group') {
      k = (typeof getLightGroupKey === 'function') ? getLightGroupKey(it.light) : (it.light.group || '未分组');
      label = (typeof getGroupLabel === 'function') ? getGroupLabel(k) : k;
    } else {
      k = it.light.device_ip;
      label = (typeof getDeviceDisplayName === 'function') ? getDeviceDisplayName(it.light.device_ip) : it.light.device_ip;
    }
    if (!map[k]) { map[k] = { label: label, total: 0, today: 0, count: 0, on: 0, daily: {} }; order.push(k); }
    const m = map[k];
    m.total += it.u.total_seconds || 0; m.today += it.u.today_seconds || 0;
    m.count += it.u.switch_count || 0; if (it.u.on) m.on += 1;
    const d = it.u.daily || {};
    for (const day in d) { if (Object.prototype.hasOwnProperty.call(d, day)) m.daily[day] = (m.daily[day] || 0) + d[day]; }
  });
  return order.map(function(k) { return map[k]; });
}

function _fmtDur(sec) { return (typeof formatUsageDuration === 'function') ? formatUsageDuration(sec) : (Math.round(sec) + ' 秒'); }
function _fmtShort(sec) {
  if (sec >= 3600) return (sec / 3600).toFixed(1) + 'h';
  if (sec >= 60) return Math.round(sec / 60) + 'm';
  return Math.round(sec) + 's';
}

function _statsLightLabel(item) {
  if (!item || !item.light) return '暂无灯具';
  return item.light.name || ('通道' + pad2(item.light.channel + 1));
}

function _statsMaxLight(items, fieldName) {
  let best = null;
  (items || []).forEach(function(item) {
    const value = item && item.u ? (item.u[fieldName] || 0) : 0;
    if (!best || value > best.value) {
      best = { item: item, value: value };
    }
  });
  return best || { item: null, value: 0 };
}

function _statsDailyMaxLight(items, dayIso) {
  let maxValue = 0;
  (items || []).forEach(function(item) {
    const daily = item && item.u && item.u.daily ? item.u.daily : {};
    maxValue = Math.max(maxValue, daily[dayIso] || 0);
  });
  return maxValue;
}

function drawTrendChart(canvas, labels, values) {
  if (!canvas) return;
  const w = Math.max(280, canvas.clientWidth || 600);
  const h = 190;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const padL = 10, padR = 10, padTop = 18, padBot = 22;
  const plotW = w - padL - padR, plotH = h - padTop - padBot;
  const n = values.length || 1;
  let max = 1; for (let i = 0; i < values.length; i++) max = Math.max(max, values[i]);
  const bw = plotW / n;
  ctx.strokeStyle = '#2c313c'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padTop + plotH); ctx.lineTo(padL + plotW, padTop + plotH); ctx.stroke();
  const labelStep = n > 12 ? Math.ceil(n / 8) : 1;
  for (let i = 0; i < n; i++) {
    const v = values[i] || 0;
    const bh = (v / max) * plotH;
    const x = padL + i * bw + bw * 0.18;
    const barW = Math.max(2, bw * 0.64);
    const y = padTop + plotH - bh;
    const g = ctx.createLinearGradient(0, y, 0, padTop + plotH);
    g.addColorStop(0, '#3ee066'); g.addColorStop(1, '#1f7a36');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, barW, bh);
    if (v > 0 && bw > 26) { ctx.fillStyle = '#cfd3da'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(_fmtShort(v), x + barW / 2, y - 4); }
    if (i % labelStep === 0) { ctx.fillStyle = '#8a9099'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(labels[i], padL + i * bw + bw / 2, h - 7); }
  }
}

function _statCard(label, value, sub) {
  return '<div class="stat-card"><div class="stat-card-label">' + escapeHtml(label) +
    '</div><div class="stat-card-val">' + escapeHtml(value) + '</div>' +
    (sub ? '<div class="stat-card-sub">' + escapeHtml(sub) + '</div>' : '') + '</div>';
}

function renderStatsRank(items) {
  const el = document.getElementById('stats-rank');
  if (!el) return;
  if (!items.length) { el.innerHTML = '<div class="cv-empty">暂无数据</div>'; return; }
  let max = 1; for (let i = 0; i < items.length; i++) max = Math.max(max, items[i].total);
  el.innerHTML = items.map(function(it) {
    const pct = (it.total / max * 100).toFixed(1);
    return '<div class="rank-row"><div class="rank-name" title="' + escapeHtml(it.label) + '">' + escapeHtml(it.label) + '</div>' +
      '<div class="rank-track"><div class="rank-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="rank-val">' + escapeHtml(_fmtDur(it.total)) + '</div></div>';
  }).join('');
}

function renderStatsTable(items) {
  const el = document.getElementById('stats-table');
  if (!el) return;
  if (!items.length) { el.innerHTML = '<div class="cv-empty">暂无数据</div>'; return; }
  let html = '<div class="st-row st-head"><span class="st-name">名称</span><span>今日</span><span>累计</span><span>次数</span></div>';
  html += items.map(function(it) {
    return '<div class="st-row"><span class="st-name" title="' + escapeHtml(it.label) + '">' + escapeHtml(it.label) + '</span>' +
      '<span>' + escapeHtml(_fmtDur(it.today)) + '</span>' +
      '<span>' + escapeHtml(_fmtDur(it.total)) + '</span>' +
      '<span>' + (it.count || 0) + '</span></div>';
  }).join('');
  el.innerHTML = html;
}

function renderStatsView() {
  if (topView !== 'stats') return;
  const cardsEl = document.getElementById('stats-cards');
  if (!cardsEl || !usageData || !usageData.usage) return;
  const items = _statsLights();
  let count = 0, on = 0;
  items.forEach(function(it) {
    count += it.u.switch_count || 0; if (it.u.on) on += 1;
  });
  const todayMax = _statsMaxLight(items, 'today_seconds');
  const totalMax = _statsMaxLight(items, 'total_seconds');
  cardsEl.innerHTML =
    _statCard('今日单灯最长', _fmtDur(todayMax.value), _statsLightLabel(todayMax.item)) +
    _statCard('累计单灯最长', _fmtDur(totalMax.value), _statsLightLabel(totalMax.item)) +
    _statCard('当前点亮', on + ' / ' + items.length) +
    _statCard('开关次数合计', String(count));
  const days = _statsDayList(statsRange);
  const series = days.map(function(d) { return _statsDailyMaxLight(items, d.iso); });
  const tt = document.getElementById('stats-trend-title');
  if (tt) tt.textContent = (statsRange === 1 ? '今日单灯最长点亮时长' : '近 ' + statsRange + ' 天每日单灯最长点亮时长趋势');
  drawTrendChart(document.getElementById('stats-trend'), days.map(function(d) { return d.label; }), series);
  const agg = _statsAgg(items, statsDim).slice().sort(function(a, b) { return b.total - a.total; });
  renderStatsRank(agg.slice(0, 10));
  renderStatsTable(agg);
}

async function refreshStatsData() {
  if (topView !== 'stats') return;
  const msg = document.getElementById('stats-msg');
  try {
    const res = await fetch('/api/usage');
    let json = null;
    if (res.ok) json = await res.json();
    if (!json || json.ok !== true) {
      if (msg) { msg.hidden = false; msg.textContent = '用量统计暂不可用：需要重启后端服务后才能统计。'; }
      return;
    }
    if (msg) msg.hidden = true;
    usageData = json;
    renderStatsView();
  } catch (error) {
    if (msg) { msg.hidden = false; msg.textContent = '无法获取统计数据，请检查后端服务。'; }
  }
}

function setStatsRange(n) {
  statsRange = (n === 1 || n === 30) ? n : 7;
  const seg = document.getElementById('stats-range-seg');
  if (seg) {
    const bs = seg.querySelectorAll('.seg-btn');
    for (let i = 0; i < bs.length; i++) bs[i].classList.toggle('active', parseInt(bs[i].getAttribute('data-range'), 10) === statsRange);
  }
  renderStatsView();
}

function setStatsDim(d) {
  statsDim = (d === 'group' || d === 'device') ? d : 'light';
  const seg = document.getElementById('stats-dim-seg');
  if (seg) {
    const bs = seg.querySelectorAll('.seg-btn');
    for (let i = 0; i < bs.length; i++) bs[i].classList.toggle('active', bs[i].getAttribute('data-dim') === statsDim);
  }
  renderStatsView();
}

// 导出统计 CSV: 跟随当前"维度 + 时间范围", 含每日明细
function exportStatsCsv() {
  if (!usageData || !usageData.usage) {
    showToast('warn', '暂无数据', '还没有可导出的统计数据。');
    return;
  }
  const items = _statsLights();
  const agg = _statsAgg(items, statsDim).slice().sort(function(a, b) { return b.total - a.total; });
  const days = _statsDayList(statsRange);
  const dimName = statsDim === 'group' ? '分组' : (statsDim === 'device' ? '继电器' : '灯');
  function field(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const header = ['名称', '今日点亮(分钟)', '累计点亮(分钟)', '开关次数'].concat(days.map(function(d) { return d.label + '(分钟)'; }));
  const rows = [header];
  agg.forEach(function(it) {
    const row = [it.label, (it.today / 60).toFixed(1), (it.total / 60).toFixed(1), String(it.count || 0)];
    days.forEach(function(d) { const s = (it.daily && it.daily[d.iso]) || 0; row.push((s / 60).toFixed(1)); });
    rows.push(row);
  });
  const csv = '﻿' + rows.map(function(r) { return r.map(field).join(','); }).join('\r\n');
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '使用统计_' + dimName + '_' + (statsRange === 1 ? '今日' : '近' + statsRange + '天') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  } catch (error) {
    showToast('error', '导出失败', getErrorMessage(error, '无法生成 CSV'));
  }
}

window.switchTopView = switchTopView;
window.setControlMode = setControlMode;
window.renderControlView = renderControlView;
window.toggleDeviceAll = toggleDeviceAll;
window.renderFlatPlanControl = renderFlatPlanControl;
window.syncFlatPlanControl = syncFlatPlanControl;
window.syncFlatPlanMapConfiguration = syncFlatPlanMapConfiguration;
window.focusFlatPlanGridRange = focusFlatPlanGridRange;
window.toggleFlatPlanSelected = toggleFlatPlanSelected;
window.setFlatPlanAllLights = setFlatPlanAllLights;
window.showFlatPlanSelectionIn3D = showFlatPlanSelectionIn3D;
window.beginFlatPlanModeEdit = beginFlatPlanModeEdit;
window.previewFlatPlanEnergyMode = previewFlatPlanEnergyMode;
window.beginFlatPlanAutomaticModeEdit = beginFlatPlanAutomaticModeEdit;
window.selectFlatPlanAutomaticPeriod = selectFlatPlanAutomaticPeriod;
window.updateFlatPlanAutomaticPeriodTime = updateFlatPlanAutomaticPeriodTime;
window.addFlatPlanAutomaticPeriod = addFlatPlanAutomaticPeriod;
window.deleteFlatPlanAutomaticPeriod = deleteFlatPlanAutomaticPeriod;
window.toggleFlatPlanAutomaticMode = toggleFlatPlanAutomaticMode;
window.setFlatPlanModeSelection = setFlatPlanModeSelection;
window.cancelFlatPlanModeEdit = cancelFlatPlanModeEdit;
window.saveFlatPlanMode = saveFlatPlanMode;
window.applyFlatPlanMode = applyFlatPlanMode;
window.applyFlatPlanEnergyMode = applyFlatPlanEnergyMode;
window.buildFlatPlanEnergyPlan = buildFlatPlanEnergyPlan;
window.isFlatPlanAutomaticPeriodActive = isFlatPlanAutomaticPeriodActive;
window.flatPlanAutomaticPeriodsOverlap = flatPlanAutomaticPeriodsOverlap;
window.validateFlatPlanAutomaticPeriods = validateFlatPlanAutomaticPeriods;
window.refreshStatsData = refreshStatsData;
window.setStatsRange = setStatsRange;
window.setStatsDim = setStatsDim;
window.exportStatsCsv = exportStatsCsv;

(function initControlView() {
  const body = document.getElementById('cv-body');
  if (body) body.addEventListener('click', onControlBodyClick);
  const plan = document.getElementById('flat-plan-svg');
  if (plan) {
    plan.addEventListener('click', onFlatPlanClick);
    plan.addEventListener('keydown', onFlatPlanKeyDown);
    plan.addEventListener('focusin', onFlatPlanFocus);
  }
  window.addEventListener('resize', function() {
    syncFlatPlanViewportAspect(document.getElementById('flat-plan-svg'));
  });
})();

refreshMainPanel();
scheduleSceneResize();
refreshPanelSections();
updateLayoutUI();
window.onDeviceProtocolChange();
window.onSetupDeviceProtocolChange();
loadConfig();
switchTopView('control');   // 默认打开"操控"界面

[
  'setup-appliance-count',
  'setup-appliance-type',
  'setup-appliance-prefix',
  'setup-appliance-group',
  'setup-scenes-enabled',
  'setup-scenes-focus-enabled'
].forEach(function(id) {
  const node = document.getElementById(id);
  if (!node) return;
  node.addEventListener(node.tagName === 'SELECT' ? 'change' : 'input', function() {
    const modal = document.getElementById('setup-modal');
    if (modal && modal.classList.contains('show')) {
      renderSetupWizard();
    }
  });
});

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') {
    refreshStatus({ force: true, silent: true });
  } else {
    clearStatusPoll();
  }
});

window.addEventListener('focus', function() {
  scheduleStatusPoll(0);
  if (typeof runAutoReconnectCheck === 'function') runAutoReconnectCheck();
});

// Tibber 风格 HUD: 时钟 + 室外温度 (真实天气来自 /api/weather)
(function startHudWidgets() {
  function pad(num) { return num < 10 ? '0' + num : '' + num; }
  function tickClock() {
    const el = document.getElementById('hud-clock');
    if (!el) return;
    const now = new Date();
    el.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
  }
  tickClock();
  setInterval(tickClock, 15000);

  function fmtTemp(v) {
    return (v == null || !isFinite(v)) ? '— °C' : (Math.round(v * 10) / 10).toFixed(1) + ' °C';
  }
  async function tickWeather() {
    let next = 600000;
    try {
      const res = await fetch('/api/weather');
      const json = await res.json();
      if (json && json.ok) {
        const m = document.getElementById('hud-temp-main');
        const h = document.getElementById('hud-temp-high');
        const l = document.getElementById('hud-temp-low');
        const t = document.getElementById('hud-weather-text');
        if (m) m.textContent = fmtTemp(json.temperature);
        if (h) h.textContent = fmtTemp(json.high);
        if (l) l.textContent = fmtTemp(json.low);
        if (t) t.textContent = '西昌 · ' + (json.weather_text || '--');
      } else {
        throw new Error('weather not ok');
      }
    } catch (err) {
      // 接口不可用 (如后端未重启返回 404) 时静默重试, 界面保持原值
      next = 120000;
    } finally {
      setTimeout(tickWeather, next);
    }
  }
  tickWeather();
})();
