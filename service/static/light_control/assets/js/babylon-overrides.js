// Babylon overrides loaded after app-runtime-main.js and app-ui-main.js.
// 覆盖清单：
// - applyStatus | app-runtime-main.js | 原函数调用 setLampState 操作 THREE 灯具
// - rebuildLamps | app-runtime-main.js | 原函数创建/销毁 THREE 灯具
// - focusLamp | app-runtime-main.js | 原函数刷新 THREE 标签
// - switchTopView | app-ui-main.js | 原函数写 inline display，Babylon 页改由 body class 控制

(function() {
  function getLights() {
    return (typeof config !== 'undefined' && Array.isArray(config.lights)) ? config.lights : [];
  }

  function getDeviceStates() {
    return (typeof deviceStatus !== 'undefined' && deviceStatus) ? deviceStatus : {};
  }

  function isRelayOn(light) {
    const states = getDeviceStates();
    const status = states[light.device_ip];
    return !!(status && status.connected && status.relay_states && status.relay_states[light.channel]);
  }

  window.rebuildLamps = function rebuildLamps() {
    if (typeof __babylonScheduleRebuild === 'function') __babylonScheduleRebuild();
  };

  window.focusLamp = function focusLamp(index) {
    focusedLampIdx = typeof index === 'number' ? index : null;
    if (window.BabylonApp && typeof window.BabylonApp.focusLight === 'function') {
      window.BabylonApp.focusLight(focusedLampIdx);
      return;
    }
    if (focusedLampIdx == null) {
      const pop = document.getElementById('device-pop');
      if (pop) pop.hidden = true;
    }
  };

  window.applyStatus = function applyStatus() {
    if (typeof reconcilePendingControls === 'function') reconcilePendingControls();
    if (typeof renderDeviceList === 'function') renderDeviceList();
    getLights().forEach(function(light, index) {
      const states = getDeviceStates();
      const status = states[light.device_ip];
      const connected = !!(status && status.connected);
      const on = isRelayOn(light);
      const pending = connected && typeof isChannelPending === 'function' && isChannelPending(light.device_ip, light.channel);
      if (window.BabylonApp && typeof window.BabylonApp.updateLightVisual === 'function') {
        window.BabylonApp.updateLightVisual(index);
      }
      if (typeof setLightRowUI === 'function') setLightRowUI(index, on, connected, pending);
    });
    if (typeof updateCounts === 'function') updateCounts();
    if (typeof refreshExperiencePanels === 'function') refreshExperiencePanels();
    if (typeof refreshDeviceInspectorState === 'function') refreshDeviceInspectorState();
    if (typeof syncControlView === 'function') syncControlView();
  };

  window.switchTopView = function switchTopView(view) {
    topView = (view === 'control' || view === 'plan' || view === 'stats') ? view : 'modeling';

    document.body.classList.remove('view-modeling', 'view-control', 'view-plan', 'view-stats');
    document.body.classList.add('view-' + topView);
    document.body.classList.toggle('control-mode', topView === 'control');

    ['app', 'panel', 'control-panel', 'view-plan', 'view-stats'].forEach(function(id) {
      const el = document.getElementById(id);
      if (el && el.style) el.style.removeProperty('display');
    });

    const tabs = document.querySelectorAll('.top-tab');
    for (let i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-view') === topView);
    }

    if (topView === 'control') {
      if (typeof walkMode !== 'undefined' && walkMode && typeof toggleWalkMode === 'function') {
        toggleWalkMode(false);
      }
      if (typeof renderControlView === 'function') renderControlView();
    } else if (topView === 'plan') {
      if (typeof renderFlatPlanControl === 'function') renderFlatPlanControl();
      const pop = document.getElementById('device-pop');
      if (pop) pop.hidden = true;
    } else {
      const pop = document.getElementById('device-pop');
      if (pop) pop.hidden = true;
    }

    if (topView === 'stats' && typeof refreshStatsData === 'function') refreshStatsData();
    if (topView !== 'stats' && topView !== 'plan' && typeof scheduleSceneResize === 'function') scheduleSceneResize();
  };

  function bindClick(id, handler) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', handler);
  }

  document.querySelectorAll('.top-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      window.switchTopView(btn.getAttribute('data-view'));
    });
  });

  bindClick('reload-config', function() {
    if (typeof loadConfig === 'function') loadConfig();
  });

  bindClick('fit-camera', function() {
    if (window.BabylonApp && typeof window.BabylonApp.fitCamera === 'function') {
      window.BabylonApp.fitCamera();
    }
  });

  bindClick('panel-toggle', function() {
    if (typeof toggleMainPanel === 'function') toggleMainPanel();
  });
  bindClick('panel-visibility-btn', function() {
    if (typeof toggleMainPanel === 'function') toggleMainPanel();
  });
  bindClick('panel-mini-open-btn', function() {
    if (typeof toggleMainPanel === 'function') toggleMainPanel(true);
  });

  document.querySelectorAll('[data-section-toggle]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (typeof togglePanelSection === 'function') {
        togglePanelSection(btn.getAttribute('data-section-toggle'));
      }
    });
  });

  window.switchTopView('control');
})();
