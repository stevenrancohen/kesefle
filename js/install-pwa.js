(function installKeseflePwa() {
  'use strict';

  var deferredPrompt = null;
  var shell = null;
  var installButton = null;
  var status = null;

  function isStandalone() {
    return Boolean(
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true
    );
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(window.navigator.userAgent || '') && !window.MSStream;
  }

  function setStatus(label) {
    if (!status || !shell) return;
    status.textContent = shell.dataset[label] || '';
  }

  function render() {
    if (!shell || !installButton) return;
    if (isStandalone()) {
      deferredPrompt = null;
      installButton.hidden = true;
      setStatus('installedLabel');
      return;
    }
    if (deferredPrompt) {
      installButton.hidden = false;
      installButton.disabled = false;
      setStatus('readyLabel');
      return;
    }
    installButton.hidden = true;
    setStatus(isIos() ? 'iosLabel' : 'manualLabel');
  }

  window.addEventListener('beforeinstallprompt', function onBeforeInstallPrompt(event) {
    event.preventDefault();
    deferredPrompt = event;
    render();
  });

  window.addEventListener('appinstalled', function onAppInstalled() {
    deferredPrompt = null;
    if (installButton) installButton.hidden = true;
    setStatus('installedLabel');
  });

  function init() {
    shell = document.querySelector('[data-install-shell]');
    if (!shell) return;
    installButton = shell.querySelector('[data-install-button]');
    status = shell.querySelector('[data-install-status]');
    if (!installButton || !status) return;

    installButton.addEventListener('click', async function requestInstall() {
      if (!deferredPrompt) {
        render();
        return;
      }
      var prompt = deferredPrompt;
      deferredPrompt = null;
      installButton.disabled = true;
      try {
        await prompt.prompt();
        var choice = await prompt.userChoice;
        if (choice && choice.outcome === 'accepted') setStatus('acceptedLabel');
        else setStatus('declinedLabel');
      } catch (_) {
        setStatus('manualLabel');
      } finally {
        installButton.hidden = true;
        installButton.disabled = false;
      }
    });

    var displayMode = window.matchMedia && window.matchMedia('(display-mode: standalone)');
    if (displayMode && typeof displayMode.addEventListener === 'function') {
      displayMode.addEventListener('change', render);
    }
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
