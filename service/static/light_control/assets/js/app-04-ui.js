// Final UI bindings, panel rendering, and bootstrap sequence.

function loadConfig() {
  return (async function() {
    const data = await api('/api/config');
    config.devices = data.devices || [];
    config.lights = (data.lights || []).map(normalizeLight);
    config.layout = normalizeLayoutData(data.layout);
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
  })();
}

function renderLightsConfig() {
  const el = document.getElementById('lc-list');
  el.innerHTML = '';
  if (editingLights.length === 0) {
    el.innerHTML = '<div class="empty-tip">点击下方“添加一个电器”开始配置</div>';
    return;
  }

  editingLights.forEach(function(lt, i) {
    const row = document.createElement('div');
    row.className = 'lc-row';
    row.id = 'light-config-row-' + i;
    let devOptions = '';
    config.devices.forEach(function(d) {
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
    const hasScenePos = Number.isFinite(lt.x) && Number.isFinite(lt.z);
    const posText = hasScenePos
      ? '场景位置: X ' + formatNum(lt.x) + ' · Z ' + formatNum(lt.z)
      : '场景位置: 未设置，将按设备分组自动排布';
    row.innerHTML =
      '<input class="lc-name" type="text" placeholder="电器名称" value="' + escapeHtml(lt.name || '') + '">' +
      '<select class="lc-type">' + getTypeOptionsHtml(lt.type) + '</select>' +
      '<input class="lc-size" type="number" min="0.4" max="3" step="0.1" value="' + lt.scale + '" title="模型大小">' +
      '<select class="lc-dev">' + devOptions + '</select>' +
      '<select class="lc-ch">' + chOptions + '</select>' +
      '<button class="lc-del" title="删除">×</button>';

    const inName = row.querySelector('.lc-name');
    const selType = row.querySelector('.lc-type');
    const inSize = row.querySelector('.lc-size');
    const selDev = row.querySelector('.lc-dev');
    const selCh = row.querySelector('.lc-ch');
    const extra = document.createElement('div');
    extra.className = 'lc-row-extra';
    extra.innerHTML =
      '<div class="lc-pos">' + escapeHtml(posText) + '</div>' +
      '<button type="button" class="lc-place pick">场景选点</button>' +
      (hasScenePos ? '<button type="button" class="lc-place reset">自动排布</button>' : '');
    row.appendChild(extra);
    inName.oninput = function() { editingLights[i].name = inName.value; };
    selType.onchange = function() {
      const hadAutoName = isAutoName(editingLights[i].name);
      editingLights[i].type = selType.value;
      if (hadAutoName) {
        editingLights[i].name = getSuggestedLightName(selType.value);
        inName.value = editingLights[i].name;
      }
    };
    inSize.oninput = function() {
      editingLights[i].scale = clamp(Number(inSize.value) || editingLights[i].scale || 1, 0.4, 3);
    };
    selDev.onchange = function() { editingLights[i].device_ip = selDev.value; };
    selCh.onchange = function() { editingLights[i].channel = parseInt(selCh.value, 10); };
    extra.querySelector('.lc-place.pick').onclick = function() {
      startLightPlacement(i);
    };
    const resetBtn = extra.querySelector('.lc-place.reset');
    if (resetBtn) {
      resetBtn.onclick = function() {
        delete editingLights[i].x;
        delete editingLights[i].z;
        renderLightsConfig();
      };
    }
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
  const used = new Set(editingLights.filter(function(lt) { return lt.device_ip === defaultIp; }).map(function(lt) { return lt.channel; }));
  let ch = 0;
  for (let c = 0; c < 16; c++) {
    if (!used.has(c)) { ch = c; break; }
  }
  editingLights.push({
    name: getSuggestedLightName(DEFAULT_ITEM_TYPE),
    type: DEFAULT_ITEM_TYPE,
    scale: 1,
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
      alert('同一个设备通道不能绑定多个电器，请调整后再保存。');
      return;
    }
    seen[key] = true;
  }

  config.lights = editingLights.map(function(lt) {
    const next = {
      name: lt.name || getSuggestedLightName(lt.type),
      type: ITEM_TYPES[lt.type] ? lt.type : DEFAULT_ITEM_TYPE,
      scale: clamp(Number(lt.scale) || 1, 0.4, 3),
      device_ip: lt.device_ip,
      channel: parseInt(lt.channel, 10)
    };
    if (typeof lt.x === 'number') next.x = lt.x;
    if (typeof lt.z === 'number') next.z = lt.z;
    return next;
  });

  clampLightPositionsToBuilding();
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

canvas.addEventListener('pointerdown', function(e) {
  if (e.button !== 0 || layoutMode || walkMode) return;
  screenToRay(e);
  const hits = lamps.map(function(lamp) { return lamp.hit; });
  const inter = raycaster.intersectObjects(hits);
  if (inter.length > 0) {
    focusLamp(inter[0].object.userData.lightIdx);
  } else if (!labelsPinned) {
    focusLamp(null);
  }
});

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 暴露给 onclick
const PANEL_SECTION_DEFAULTS = {
  devices: false,
  appliances: true,
  layout: false
};
let panelSections = Object.assign({}, PANEL_SECTION_DEFAULTS);
const PANEL_EXPANDED_STORAGE_KEY = 'dengkong.panel.expanded';
let panelExpanded = true;

try {
  panelExpanded = localStorage.getItem(PANEL_EXPANDED_STORAGE_KEY) !== '0';
} catch (err) {}

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
    miniButton.textContent = panelExpanded ? '已展开' : '展开';
    miniButton.setAttribute('title', '展开控制面板');
  }

  try {
    localStorage.setItem(PANEL_EXPANDED_STORAGE_KEY, panelExpanded ? '1' : '0');
  } catch (err) {}
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
    const st = deviceStatus[light.device_ip];
    return total + (st && st.connected && st.relay_states && st.relay_states[light.channel] ? 1 : 0);
  }, 0);
}

function refreshPanelSections() {
  const layout = config.layout || DEFAULT_LAYOUT;
  const wallCount = Array.isArray(layout.walls) ? layout.walls.length : 0;
  const zoneCount = Array.isArray(layout.zones) ? layout.zones.length : 0;
  const deviceCount = (config.devices || []).length;
  const connectedCount = getConnectedDeviceCount();
  const lightCount = (config.lights || []).length;
  const lightOnCount = getLightOnCount();
  const metaText = {
    devices: deviceCount === 0
      ? 'No devices'
      : connectedCount + ' / ' + deviceCount + ' connected',
    appliances: lightCount === 0
      ? 'No items'
      : lightOnCount + ' / ' + lightCount + ' on',
    layout: wallCount + ' walls / ' + zoneCount + ' zones'
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
  const miniLayout = document.getElementById('mini-layout');
  if (miniDevices) miniDevices.textContent = String(deviceCount);
  if (miniAppliances) miniAppliances.textContent = String(lightOnCount);
  if (miniLayout) miniLayout.textContent = String(wallCount + zoneCount);
}

function togglePanelSection(key, forceValue) {
  if (!(key in PANEL_SECTION_DEFAULTS)) return;
  panelSections[key] = typeof forceValue === 'boolean' ? forceValue : !panelSections[key];
  refreshPanelSections();
}

function renderDeviceList() {
  const el = document.getElementById('dev-list');
  el.innerHTML = '';
  if (config.devices.length === 0) {
    el.innerHTML = '<div class="empty-tip">No devices yet</div>';
    refreshPanelSections();
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
        '<div class="dev-name">' + escapeHtml(d.name || 'Unnamed') + '</div>' +
        '<div class="dev-ip">' + escapeHtml(d.ip) + ':' + d.port + ' / Unit ' + d.unit_id + '</div>' +
      '</div>' +
      '<div class="dev-actions">' +
        (on
          ? '<button class="dev-btn d" data-act="disc">Disconnect</button>'
          : '<button class="dev-btn c" data-act="conn">Connect</button>') +
        '<button class="dev-btn x" data-act="del" title="Delete">x</button>' +
      '</div>';
    row.querySelector('[data-act="conn"]')?.addEventListener('click', function() { connectDevice(d); });
    row.querySelector('[data-act="disc"]')?.addEventListener('click', function() { disconnectDevice(d.ip); });
    row.querySelector('[data-act="del"]').addEventListener('click', function() { delDevice(d.ip); });
    el.appendChild(row);
  });
  refreshPanelSections();
}

function renderLightRows() {
  const el = document.getElementById('light-rows');
  el.innerHTML = '';
  if (config.lights.length === 0) {
    el.innerHTML = '<div class="empty-tip">No appliances yet</div>';
    refreshPanelSections();
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
    const devName = (config.devices.find(function(d) { return d.ip === lt.device_ip; }) || {}).name || lt.device_ip;
    row.innerHTML =
      '<div class="l-dot' + (on ? ' on' : '') + '"></div>' +
      '<div class="l-icon' + (on ? ' on' : '') + '" style="--icon-accent:' + meta.accent + ';">' + escapeHtml(meta.icon) + '</div>' +
      '<div class="l-info">' +
        '<div class="l-name' + (on ? ' on' : '') + '">' + escapeHtml(lt.name || 'Unnamed') + '</div>' +
        '<div class="l-sub">' + escapeHtml(meta.label) + ' / ' + escapeHtml(devName) + ' / CH' + String(lt.channel + 1).padStart(2, '0') + '</div>' +
      '</div>' +
      '<div class="l-state' + (on ? ' on' : '') + '">' + (connected ? (on ? 'ON' : 'OFF') : '--') + '</div>' +
      '<div class="toggle' + (on ? ' on' : '') + '"><div class="toggle-knob"></div></div>';
    row.onclick = function() { toggleLight(i); };
    el.appendChild(row);
  });
  refreshPanelSections();
}

function updateCounts() {
  let on = 0;
  const total = config.lights.length;
  config.lights.forEach(function(lt) {
    const st = deviceStatus[lt.device_ip];
    if (st && st.connected && st.relay_states && st.relay_states[lt.channel]) on++;
  });
  document.getElementById('stat-on').textContent = on;
  document.getElementById('stat-off').textContent = total - on;
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
window.saveLights = saveLights;
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

// 启动
refreshMainPanel();
scheduleSceneResize();
refreshPanelSections();
updateLayoutUI();
loadConfig();
setInterval(function() {
  for (const ip in deviceStatus) {
    if (deviceStatus[ip] && deviceStatus[ip].connected) {
      refreshStatus();
      return;
    }
  }
}, 1500);
