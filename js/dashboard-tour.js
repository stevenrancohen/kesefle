// js/dashboard-tour.js
//
// Self-contained 5-step interactive tour of the dashboard. Fires once per
// device (localStorage guard) the first time a user with >=1 expense lands
// on /dashboard. Skip-able from any step. Dismissible permanently.
//
// Pure DOM + a single fixed overlay. No external libs.

(function () {
  if (window.__kflTourLoaded) return;
  window.__kflTourLoaded = true;

  var STORAGE_KEY = 'kfl_dashboard_tour_done';
  var STORAGE_SKIP = 'kfl_dashboard_tour_skipped';

  function alreadyDone() {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1' || localStorage.getItem(STORAGE_SKIP) === '1';
    } catch (_e) { return false; }
  }

  function markDone(key) {
    try { localStorage.setItem(key, '1'); } catch (_e) {}
  }

  // Step definitions. `selector` must resolve to an element on /dashboard;
  // steps with a missing target are skipped at runtime so the tour adapts to
  // empty-state vs filled-state pages.
  var STEPS = [
    {
      selector: '#summary-cards',
      title: 'הסיכום שלך, חודש זה',
      body: 'הוצאות סך-הכל, הוצאות החודש, ההכנסה החודשית והאיזון הנכון לכל רגע. נטען אוטומטית מהגיליון שלך.',
      position: 'bottom',
    },
    {
      selector: '#analytics-block',
      title: 'דשבורד אנליטיקה מלא',
      body: 'גרפים, חלוקת קטגוריות, ציון בריאות פיננסית. כל הנתונים שלך, מסוכמים מהגיליון.',
      position: 'bottom',
    },
    {
      selector: '#recent-list',
      title: 'הוצאות אחרונות',
      body: 'רשימת ההוצאות מהבוט. כל הוצאה חדשה שתשלח בוואטסאפ תופיע כאן אוטומטית תוך שניות.',
      position: 'top',
    },
    {
      selector: '#goals-count',
      title: 'יעדים ותקציבים',
      body: 'הגדר/י תקציבים חודשיים לכל קטגוריה. שלח/י "/תקציב מזון 1500" לבוט בוואטסאפ.',
      position: 'top',
    },
    {
      selector: 'header',
      title: 'מוכן/ה לעבוד!',
      body: 'הבוט מקשיב 24/7 ב-+1 555 640 8123. אם תתקע/י — שלח/י "עזרה" לבוט או לחץ/י על כפתור הדיווח בפינה.',
      position: 'bottom',
    },
  ];

  function makeOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'kfl-tour-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(15,20,34,0.7);pointer-events:none';
    document.body.appendChild(overlay);
    return overlay;
  }

  function makeSpotlight() {
    var spot = document.createElement('div');
    spot.id = 'kfl-tour-spot';
    spot.style.cssText = 'position:fixed;z-index:9999;border:3px solid #22c55e;border-radius:14px;pointer-events:none;transition:all 250ms ease;box-shadow:0 0 0 9999px rgba(15,20,34,0.7),0 8px 32px rgba(34,197,94,0.5)';
    document.body.appendChild(spot);
    return spot;
  }

  function makeTooltip() {
    var tip = document.createElement('div');
    tip.id = 'kfl-tour-tip';
    tip.style.cssText = 'position:fixed;z-index:10000;background:#fff;color:#0f1422;border-radius:14px;padding:18px 22px;max-width:340px;font:600 14px/1.5 Heebo,system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,0.3);transition:all 250ms ease';
    tip.dir = 'rtl';
    document.body.appendChild(tip);
    return tip;
  }

  function positionSpotAndTip(spot, tip, target, position) {
    var r = target.getBoundingClientRect();
    var pad = 8;
    spot.style.left = Math.max(0, r.left - pad) + 'px';
    spot.style.top = Math.max(0, r.top - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';

    // Tooltip placement -- prefer below; if no room, place above; never offscreen.
    var tipR = tip.getBoundingClientRect();
    var top, left;
    if (position === 'top' || r.bottom + 16 + tipR.height > window.innerHeight) {
      top = r.top - tipR.height - 18;
    } else {
      top = r.bottom + 18;
    }
    top = Math.max(12, Math.min(window.innerHeight - tipR.height - 12, top));
    left = r.left + r.width / 2 - tipR.width / 2;
    left = Math.max(12, Math.min(window.innerWidth - tipR.width - 12, left));
    tip.style.top = top + 'px';
    tip.style.left = left + 'px';
  }

  function startTour() {
    var visible = STEPS.filter(function (s) { return document.querySelector(s.selector); });
    if (!visible.length) return; // no targets on this page (e.g. empty state) -- skip
    var idx = 0;
    var overlay = makeOverlay();
    var spot = makeSpotlight();
    var tip = makeTooltip();

    function render() {
      var step = visible[idx];
      var target = document.querySelector(step.selector);
      if (!target) { next(); return; }
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Wait one tick for the scroll to settle before measuring positions.
      setTimeout(function () {
        tip.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px;color:#22c55e;font-size:11px;font-weight:800;letter-spacing:0.5px;text-transform:uppercase">' +
            'שלב ' + (idx + 1) + ' מתוך ' + visible.length +
          '</div>' +
          '<h3 style="margin:6px 0 8px 0;font-size:18px;font-weight:900">' + escapeHtml(step.title) + '</h3>' +
          '<p style="margin:0;color:#5d6b8f;font-size:13px;line-height:1.5">' + escapeHtml(step.body) + '</p>' +
          '<div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-start">' +
            (idx > 0 ? '<button id="kfl-tour-back" style="background:#fff;color:#5d6b8f;border:1px solid #bcc4d6;padding:8px 14px;border-radius:10px;font:inherit;cursor:pointer">חזור</button>' : '') +
            '<button id="kfl-tour-next" style="background:#16a34a;color:#fff;border:none;padding:8px 18px;border-radius:10px;font:inherit;font-weight:800;cursor:pointer">' +
              (idx === visible.length - 1 ? 'סיום' : 'הבא') +
            '</button>' +
            '<button id="kfl-tour-skip" style="background:transparent;color:#bcc4d6;border:none;padding:8px;font:inherit;font-size:11px;cursor:pointer;margin-right:auto">דלג/י על הסיור</button>' +
          '</div>';
        positionSpotAndTip(spot, tip, target, step.position);
        // Wire buttons (do this after innerHTML; preserves event listeners by re-binding each step).
        var nextBtn = document.getElementById('kfl-tour-next');
        var backBtn = document.getElementById('kfl-tour-back');
        var skipBtn = document.getElementById('kfl-tour-skip');
        if (nextBtn) nextBtn.addEventListener('click', next);
        if (backBtn) backBtn.addEventListener('click', back);
        if (skipBtn) skipBtn.addEventListener('click', skip);
      }, 300);
    }

    function teardown(reason) {
      overlay.remove();
      spot.remove();
      tip.remove();
      markDone(reason === 'skipped' ? STORAGE_SKIP : STORAGE_KEY);
      // Fire a funnel event for analytics.
      try {
        fetch('/api/log/funnel-event', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'dashboard_loaded', meta: { source: 'tour_' + reason } }),
          keepalive: true,
        }).catch(function () {});
      } catch (_e) {}
    }

    function next() {
      idx++;
      if (idx >= visible.length) { teardown('completed'); return; }
      render();
    }
    function back() {
      idx = Math.max(0, idx - 1);
      render();
    }
    function skip() {
      teardown('skipped');
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    // Wire Esc to skip.
    function onKey(e) {
      if (e.key === 'Escape') { window.removeEventListener('keydown', onKey); skip(); }
    }
    window.addEventListener('keydown', onKey);

    render();
  }

  // Public hook so /dashboard can also offer a "Replay tour" button.
  window.kflStartTour = function () {
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(STORAGE_SKIP); } catch (_e) {}
    startTour();
  };

  // Auto-start once the page has loaded + we have data (small delay so the
  // analytics block has time to populate). Only run if not previously done.
  function bootstrap() {
    if (alreadyDone()) return;
    if (!document.querySelector('#summary-cards')) return; // empty state page
    // Wait for content to render.
    setTimeout(function () {
      // Skip if the page is still showing only the empty-state card.
      var emptyVisible = document.querySelector('#empty-state') && !document.querySelector('#empty-state').classList.contains('hidden');
      if (emptyVisible) return;
      startTour();
    }, 2500);
  }

  if (document.readyState === 'complete') bootstrap();
  else window.addEventListener('load', bootstrap);
})();
