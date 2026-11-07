/*! kfx-home.js · Kesefle homepage cinematic sections · 2026-11-08
 *
 * Registers two hooks that /js/kfx-motion.js calls once the libraries are in:
 *   KFX.homeInit    full motion (GSAP + ScrollTrigger + Lenis available)
 *   KFX.homeStatic  reduced motion or libraries missing: final states, no pin
 *
 * Sections (markup lives in index.html, styles in /css/kfx-motion.css):
 *   #kfx-story    pinned and scroll scrubbed: "245 סופר" is typed in WhatsApp,
 *                 the bot answers, the entry flies into the sheet as a new row
 *                 and the monthly balance updates
 *   #kfx-compare  before / after clip-path wipe (mouse, touch, keyboard)
 *   #kfx-3d       Three.js phone, lazy loaded near the viewport; the CSS phone
 *                 stays as the fallback when WebGL or the module is missing
 */
(function () {
  'use strict';
  var w = window, d = document;
  var KFX = w.KFX = w.KFX || {};
  var qs = function (sel, root) { return (root || d).querySelector(sel); };
  var qsa = function (sel, root) { return Array.prototype.slice.call((root || d).querySelectorAll(sel)); };
  var clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  var fmt = function (n) { return Math.round(n).toLocaleString('he-IL') + ' ₪'; };
  var warn = function (what, err) { if (w.console) console.warn('[kfx] ' + what, err); };

  /* ================================================================ STORY */
  var S = {
    msg: '245 סופר',
    spent: [3180, 3425], left: [1820, 1575], bar: [63.6, 68.5],
    // timeline is measured in "beats"; the pin length maps the whole thing
    T: { type0: 0.3, type1: 2.3, send: 2.5, typing: 3.0, reply: 3.9, fly0: 4.6, fly1: 5.9, land: 5.9, bal0: 6.6, bal1: 8.0, fin: 8.6, end: 10 },
    steps: [0, 2.5, 4.6, 6.6]
  };

  function storyNodes() {
    var root = d.getElementById('kfx-story');
    if (!root) return null;
    var n = {
      root: root,
      pin: qs('.kfx-story__pin', root), stage: qs('.kfx-story__stage', root),
      phone: qs('.kfx-phone', root), sheet: qs('.kfx-sheet', root), chat: qs('.kfx-phone__chat', root),
      list: qs('.kfx-chat-list', root), sent: qs('[data-kfx-sent]', root), slot: qs('.kfx-chat-slot', root),
      typing: qs('[data-kfx-typing]', root), reply: qs('[data-kfx-reply]', root),
      field: qs('[data-kfx-typed]', root), row: qs('.kfx-row-new', root),
      spent: qs('[data-kfx-spent]', root), left: qs('[data-kfx-left]', root), bar: qs('.kfx-bar i', root),
      stepsBox: qs('.kfx-story__steps', root), steps: qsa('.kfx-story__steps li', root),
      fin: qs('.kfx-story__final', root), token: qs('.kfx-token', root)
    };
    n.cells = n.row ? qsa('.kfx-cell', n.row) : [];
    n.tds = n.row ? qsa('td', n.row) : [];
    var need = ['pin', 'stage', 'phone', 'sheet', 'chat', 'list', 'sent', 'slot', 'reply', 'field', 'row'];
    for (var i = 0; i < need.length; i++) if (!n[need[i]]) return null;
    return n;
  }

  // the readable end state: what no JS, reduced motion and print all show
  function storyFinal(n) {
    n.field.textContent = '';
    n.steps.forEach(function (li) { li.classList.add('is-on'); });
    n.row.classList.add('is-lit');
    if (n.spent) n.spent.textContent = fmt(S.spent[1]);
    if (n.left) n.left.textContent = fmt(S.left[1]);
    if (n.bar) n.bar.style.width = '';
    if (n.token) n.token.style.opacity = '0';
  }

  function buildStory() {
    var n = storyNodes();
    if (!n) return;
    var T = S.T, GAP = 8;
    if (KFX.splitReveal) qsa('h2', n.root).forEach(function (h2) { KFX.splitReveal(h2); });

    var mm = gsap.matchMedia();
    mm.add({ desk: '(min-width: 861px)', mob: '(max-width: 860px)' }, function (ctx) {
      var desk = !!ctx.conditions.desk;
      var lastStep = -1, lastField = null, tokenOn = false;

      function setStep(i) {
        if (i === lastStep) return;
        lastStep = i;
        n.steps.forEach(function (li, k) { li.classList.toggle('is-on', desk ? k <= i : k === i); });
      }
      function rel(el) {
        var s = n.stage.getBoundingClientRect(), r = el.getBoundingClientRect();
        return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
      }
      // the entry leaves the bot reply and lands in the new row on a curve
      function placeToken(p) {
        if (!n.token) return;
        if (!desk || p <= 0 || p >= 1) {
          if (tokenOn) { gsap.set(n.token, { opacity: 0 }); tokenOn = false; }
          return;
        }
        var c = rel(n.chat), r = rel(n.row);
        var sx = c.x + c.w * 0.3, sy = c.y + c.h - 46;
        var ex = r.x + r.w * 0.5, ey = r.y + r.h * 0.5;
        var cx = (sx + ex) / 2, cy = Math.min(sy, ey) - 120, q = 1 - p;
        gsap.set(n.token, {
          x: q * q * sx + 2 * q * p * cx + p * p * ex,
          y: q * q * sy + 2 * q * p * cy + p * p * ey,
          xPercent: -50, yPercent: -50,
          scale: 0.72 + 0.28 * Math.sin(Math.PI * p),
          rotation: (0.5 - p) * 10,
          opacity: p < 0.12 ? p / 0.12 : p > 0.88 ? (1 - p) / 0.12 : 1
        });
        tokenOn = true;
      }
      // everything that is not a plain tween is derived from the playhead,
      // so scrubbing backwards is always exact
      function render(t) {
        var typed = Math.round(clamp01((t - T.type0) / (T.type1 - T.type0)) * S.msg.length);
        var txt = t >= T.send ? '' : S.msg.slice(0, typed);
        if (txt !== lastField) { n.field.textContent = txt; lastField = txt; }
        var i = 0;
        for (var k = 0; k < S.steps.length; k++) if (t >= S.steps[k]) i = k;
        setStep(i);
        placeToken((t - T.fly0) / (T.fly1 - T.fly0));
        var p = clamp01((t - T.bal0) / (T.bal1 - T.bal0));
        p = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        if (n.spent) n.spent.textContent = fmt(S.spent[0] + (S.spent[1] - S.spent[0]) * p);
        if (n.left) n.left.textContent = fmt(S.left[0] + (S.left[1] - S.left[0]) * p);
        if (n.bar) n.bar.style.width = (S.bar[0] + (S.bar[1] - S.bar[0]) * p).toFixed(2) + '%';
      }

      // chat geometry: the list slides up as each bubble arrives
      var hSent = function () { return n.sent.offsetHeight; };
      var hSlot = function () { return n.slot.offsetHeight; };
      var hTyping = function () { return n.typing ? n.typing.offsetHeight : 0; };
      var y0 = function () { return GAP + hSent() + GAP + hSlot(); };
      var y1 = function () { return GAP + hSlot(); };
      var y2 = function () { return Math.max(0, hSlot() - hTyping()); };

      n.row.classList.remove('is-lit');
      n.root.classList.add('is-live');
      var tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: n.pin, pin: true, start: 'top top',
          end: function () { return '+=' + Math.round(w.innerHeight * (desk ? 3.2 : 2.6)); },
          scrub: 0.6, invalidateOnRefresh: true, anticipatePin: 1
        },
        onUpdate: function () { render(tl.time()); }
      });
      tl.set({}, {}, T.end);

      // 1. send
      tl.fromTo(n.list, { y: y0 }, { y: y1, duration: 0.4, ease: 'power3.out' }, T.send);
      tl.fromTo(n.sent, { opacity: 0, scale: 0.9, transformOrigin: '100% 100%' }, { opacity: 1, scale: 1, duration: 0.35, ease: 'back.out(1.6)' }, T.send);
      // 2. bot is typing, then answers
      if (n.typing) {
        tl.fromTo(n.typing, { opacity: 0 }, { opacity: 1, duration: 0.25 }, T.typing);
        tl.to(n.list, { y: y2, duration: 0.3, ease: 'power2.out' }, T.typing);
        tl.to(n.typing, { opacity: 0, duration: 0.2 }, T.reply);
      }
      tl.to(n.list, { y: 0, duration: 0.4, ease: 'power3.out' }, T.reply);
      tl.fromTo(n.reply, { opacity: 0, scale: 0.9, transformOrigin: '0% 100%' }, { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(1.6)' }, T.reply + 0.05);
      // 3. into the sheet (desktop: the token flies; mobile: the phone hands over)
      if (!desk) {
        tl.to(n.phone, { opacity: 0, scale: 0.9, y: -24, duration: 0.6, ease: 'power2.in' }, T.fly0);
        tl.fromTo(n.sheet, { opacity: 0, y: 40, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: 'power2.out' }, T.fly0 + 0.35);
      } else {
        tl.fromTo(n.sheet, { scale: 1 }, { scale: 1.015, duration: 0.2, ease: 'power2.out', yoyo: true, repeat: 1 }, T.land - 0.05);
      }
      tl.fromTo(n.row, { '--kfx-skel': 1 }, { '--kfx-skel': 0, duration: 0.3 }, T.land);
      tl.fromTo(n.cells, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.35, stagger: 0.06, ease: 'power2.out' }, T.land);
      tl.fromTo(n.tds, { backgroundColor: 'rgba(37, 99, 235, 0)' }, { backgroundColor: 'rgba(37, 99, 235, 0.18)', duration: 0.25 }, T.land);
      tl.to(n.tds, { backgroundColor: 'rgba(37, 99, 235, 0.09)', duration: 0.7 }, T.land + 0.35);
      // 4. the balance moves (numbers come from render), 5. closing line
      if (n.fin) {
        if (n.stepsBox) tl.to(n.stepsBox, { opacity: 0, y: -10, duration: 0.45 }, T.fin);
        tl.fromTo(n.fin, { opacity: 0, yPercent: 50 }, { opacity: 1, yPercent: 0, duration: 0.6, ease: 'power3.out' }, T.fin + 0.15);
      }
      render(0);

      return function () { n.root.classList.remove('is-live'); storyFinal(n); };
    });
  }

  /* ================================================================ COMPARE */
  function buildCompare(animated) {
    var root = d.getElementById('kfx-compare');
    if (!root) return;
    var frame = qs('.kfx-compare__frame', root), range = qs('.kfx-compare__range', root);
    if (!frame || !range) return;
    var state = { v: 50 }, intro = null, drag = null;

    function set(v) {
      state.v = Math.max(0, Math.min(100, v));
      frame.style.setProperty('--kfx-split', state.v.toFixed(2) + '%');
      var r = String(Math.round(state.v));
      if (range.value !== r) range.value = r;
    }
    function stopIntro() { if (intro) { intro.kill(); intro = null; } }
    function fromPoint(e) {
      var r = frame.getBoundingClientRect();
      if (r.width) set((e.clientX - r.left) / r.width * 100);
    }
    range.addEventListener('input', function () { stopIntro(); set(parseFloat(range.value)); });
    frame.addEventListener('pointerdown', function (e) {
      if (e.target === range) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, on: e.pointerType === 'mouse' };
      if (drag.on) {
        stopIntro(); fromPoint(e);
        try { frame.setPointerCapture(e.pointerId); } catch (err) { /* old browsers */ }
      }
    });
    frame.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.on) {
        // touch: only take over a clearly sideways drag, vertical stays page scroll
        var dx = Math.abs(e.clientX - drag.x), dy = Math.abs(e.clientY - drag.y);
        if (dy > 10 && dy > dx) { drag = null; return; }
        if (dx < 6 || dx < dy) return;
        drag.on = true; stopIntro();
        try { frame.setPointerCapture(e.pointerId); } catch (err) { /* old browsers */ }
      }
      fromPoint(e);
    });
    var end = function (e) { if (drag && e.pointerId === drag.id) drag = null; };
    frame.addEventListener('pointerup', end);
    frame.addEventListener('pointercancel', end);

    if (animated && w.gsap && w.ScrollTrigger) {
      if (KFX.splitReveal) qsa('h2', root).forEach(function (h2) { KFX.splitReveal(h2); });
      fadeUp(qsa('.kfx-lead', root).concat([frame]));
      set(7);
      ScrollTrigger.create({
        trigger: frame, start: 'top 70%', once: true,
        onEnter: function () {
          intro = gsap.to(state, { v: 58, duration: 1.9, ease: 'expo.inOut', onUpdate: function () { set(state.v); }, onComplete: function () { intro = null; } });
        }
      });
    } else {
      set(50);
    }
  }

  /* ================================================================ 3D */
  function hasWebGL() {
    try {
      var c = d.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return false;
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return true;
    } catch (e) { return false; }
  }
  function build3D(animated) {
    var root = d.getElementById('kfx-3d');
    if (!root) return;
    if (animated && w.gsap) {
      if (KFX.splitReveal) qsa('h2', root).forEach(function (h2) { KFX.splitReveal(h2); });
      fadeUp(qsa('.kfx-lead, .kfx-3d__stats, .kfx-btn, .kfx-3d__viewer', root));
    }
    var viewer = qs('[data-kfx-3d]', root);
    var canvas = viewer && qs('canvas', viewer);
    if (!viewer || !canvas || !('IntersectionObserver' in w) || !hasWebGL()) return;
    var src = viewer.getAttribute('data-kfx-3d') || '/js/kfx-phone3d.mjs';
    var io = new IntersectionObserver(function (entries) {
      if (!entries.some(function (e) { return e.isIntersecting; })) return;
      io.disconnect();
      import(src).then(function (mod) {
        var api = mod && mod.mount && mod.mount(viewer, canvas, { motion: !!animated });
        if (!api) return;
        viewer.classList.add('is-live');
        KFX.phone3d = api;
        if (animated && w.ScrollTrigger) {
          ScrollTrigger.create({
            trigger: viewer, start: 'top bottom', end: 'bottom top',
            onUpdate: function (self) { api.setScroll(self.progress); }
          });
        }
      }).catch(function (err) { warn('3d viewer stays on the CSS phone', err); });
    }, { rootMargin: '500px 0px' });
    io.observe(viewer);
  }

  /* ================================================================ shared */
  function fadeUp(els) {
    els = els.filter(Boolean);
    if (!els.length) return;
    els.forEach(function (el) { el.setAttribute('data-kfx-r', ''); });
    gsap.set(els, { opacity: 0, y: 36 });
    ScrollTrigger.batch(els, {
      start: 'top 88%', once: true,
      onEnter: function (batch) { gsap.to(batch, { opacity: 1, y: 0, duration: 1.1, ease: 'expo.out', stagger: 0.09, overwrite: true, clearProps: 'transform' }); }
    });
  }

  KFX.homeInit = function () {
    try { buildStory(); } catch (e) { warn('story', e); var n = storyNodes(); if (n) storyFinal(n); }
    try { buildCompare(true); } catch (e) { warn('compare', e); }
    try { build3D(true); } catch (e) { warn('3d', e); }
  };
  KFX.homeStatic = function () {
    var n = storyNodes();
    if (n) storyFinal(n);
    try { buildCompare(false); } catch (e) { warn('compare', e); }
    try { build3D(false); } catch (e) { warn('3d', e); }
  };
})();
