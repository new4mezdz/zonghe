// Standalone entry policy: expose only flat-plan control and configuration.
(function() {
  'use strict';

  const sharedSwitchTopView = window.switchTopView;
  if (typeof sharedSwitchTopView !== 'function') return;

  function normalizeView(view) {
    return view === 'modeling' ? 'modeling' : 'plan';
  }

  function syncTabAccessibility(view) {
    const tabs = document.querySelectorAll('.flat-config-tabs .top-tab');
    for (let i = 0; i < tabs.length; i += 1) {
      const selected = tabs[i].getAttribute('data-view') === view;
      tabs[i].setAttribute('aria-selected', selected ? 'true' : 'false');
      tabs[i].setAttribute('tabindex', selected ? '0' : '-1');
    }
  }

  window.switchTopView = function(view) {
    const nextView = normalizeView(view);
    sharedSwitchTopView(nextView);
    syncTabAccessibility(nextView);

    const hash = nextView === 'modeling' ? '#config' : '#plan';
    if (window.location.hash !== hash && window.history && window.history.replaceState) {
      window.history.replaceState(null, '', hash);
    }
  };

  const tabs = document.querySelector('.flat-config-tabs');
  if (tabs) {
    tabs.addEventListener('keydown', function(event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const nextView = topView === 'modeling' ? 'plan' : 'modeling';
      window.switchTopView(nextView);
      const active = tabs.querySelector('.top-tab[aria-selected="true"]');
      if (active) active.focus();
      event.preventDefault();
    });
  }

  window.addEventListener('hashchange', function() {
    window.switchTopView(window.location.hash === '#config' ? 'modeling' : 'plan');
  });

  window.switchTopView(window.location.hash === '#config' ? 'modeling' : 'plan');
})();
