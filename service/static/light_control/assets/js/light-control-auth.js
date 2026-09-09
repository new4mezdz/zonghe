(function () {
  'use strict';

  var nativeFetch = window.fetch.bind(window);
  var unlocked = false;
  var controlEndpoints = ['/api/light_control/toggle', '/api/light_control/batch'];

  function apiUrl(url) {
    if (typeof url === 'string' && url.indexOf('/api/') === 0 && url.indexOf('/api/light_control/') !== 0) {
      return '/api/light_control/' + url.slice('/api/'.length);
    }
    return url;
  }

  function isControlRequest(url, method) {
    if (String(method || 'GET').toUpperCase() === 'GET') return false;
    var pathname;
    try {
      pathname = new URL(String(url), window.location.href).pathname;
    } catch (error) {
      pathname = String(url).split('?')[0];
    }
    return controlEndpoints.indexOf(pathname) !== -1;
  }

  function lockedResponse() {
    return new Response(
      JSON.stringify({ ok: false, error: '控制权限已锁定，请先输入密码解锁' }),
      { status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  window.fetch = async function (input, options) {
    var rewritten = input;
    if (typeof input === 'string') rewritten = apiUrl(input);
    else if (input instanceof URL) rewritten = new URL(apiUrl(input.toString()));

    var method = (options && options.method) || (input && input.method) || 'GET';
    if (isControlRequest(rewritten, method) && !unlocked) {
      window.showLightControlUnlock();
      return lockedResponse();
    }

    var response = await nativeFetch(rewritten, options);
    if (isControlRequest(rewritten, method) && response.status === 401) {
      setUnlocked(false);
      window.showLightControlUnlock();
    }
    return response;
  };

  function setNotice(message, kind) {
    var notice = document.getElementById('light-control-unlock-notice');
    if (!notice) return;
    notice.className = 'modal-notice ' + (kind || 'error');
    notice.textContent = message || '';
    notice.hidden = !message;
  }

  function updateUnlockButton() {
    var button = document.getElementById('light-control-unlock-button');
    if (button) button.textContent = unlocked ? '🔓 控制已解锁' : '🔒 解锁控制';

    var hint = document.getElementById('scene-hint');
    if (hint) {
      if (!hint.dataset.lightControlBaseText) hint.dataset.lightControlBaseText = hint.textContent;
      hint.textContent = hint.dataset.lightControlBaseText + (unlocked ? '' : ' · 开关灯需密码解锁');
    }
  }

  function setUnlocked(value) {
    unlocked = !!value;
    updateUnlockButton();
  }

  window.showLightControlUnlock = function () {
    if (unlocked) return;
    var modal = document.getElementById('light-control-unlock-modal');
    var input = document.getElementById('light-control-password');
    setNotice('', 'error');
    if (modal) modal.classList.add('show');
    if (input) {
      input.value = '';
      window.setTimeout(function () { input.focus(); }, 0);
    }
  };

  window.hideLightControlUnlock = function () {
    var modal = document.getElementById('light-control-unlock-modal');
    if (modal) modal.classList.remove('show');
  };

  window.toggleLightControlLock = async function () {
    if (!unlocked) {
      window.showLightControlUnlock();
      return;
    }
    try {
      await nativeFetch('/api/light_control/lock', { method: 'POST' });
    } finally {
      setUnlocked(false);
    }
  };

  window.submitLightControlUnlock = async function () {
    var input = document.getElementById('light-control-password');
    var submit = document.getElementById('light-control-unlock-submit');
    var password = input ? input.value : '';
    if (!password) {
      setNotice('请输入密码', 'warn');
      return;
    }

    if (submit) submit.disabled = true;
    try {
      var response = await nativeFetch('/api/light_control/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password })
      });
      var result = await response.json().catch(function () { return {}; });
      if (!response.ok || !result.unlocked) {
        setNotice(result.error || '解锁失败', 'error');
        return;
      }
      setUnlocked(true);
      window.hideLightControlUnlock();
    } catch (error) {
      setNotice('无法完成密码验证，请检查综合服务', 'error');
    } finally {
      if (submit) submit.disabled = false;
    }
  };

  async function loadAuthStatus() {
    try {
      var response = await nativeFetch('/api/light_control/auth', { cache: 'no-store' });
      var result = await response.json();
      setUnlocked(!!result.unlocked);
    } catch (error) {
      setUnlocked(false);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var input = document.getElementById('light-control-password');
    if (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') window.submitLightControlUnlock();
      });
    }
    updateUnlockButton();
  });

  loadAuthStatus();
}());
