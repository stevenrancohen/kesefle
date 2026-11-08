/*! kfx-motion.js · Kesefle cinematic motion layer · 2026-11-08
 *
 * One engine for every public page. Needs (all self-hosted, loaded with defer
 * in this order): /js/vendor/gsap.min.js, ScrollTrigger.min.js,
 * SplitText.min.js, lenis.min.js, then optionally /js/kfx-home.js, then this.
 *
 * What it does
 *   - Lenis smooth scroll synced to GSAP ScrollTrigger
 *   - preloader lift (the overlay itself is pure CSS, see kfx-motion.css)
 *   - split-text reveals for headings (words, masked, accessible)
 *   - staggered block reveals, clip-path image reveals, parallax layers
 *   - number counters + text scramble
 *   - magnetic buttons, custom cursor, hover-reveal cards, floating images
 *   - smooth <details> accordions, footer wordmark that fills on arrival
 *   - hands over to KFX.homeInit (pinned scroll-scrubbed story, before/after,
 *     3D viewer) when the homepage module is present
 *
 * Safety
 *   - prefers-reduced-motion: no smooth scroll, no motion, everything shown
 *   - libraries missing or any init error: everything shown, nothing hidden
 *   - the head boot snippet adds .kfx-fail after 3.5s if this never ran
 *   - legacy page motion (kfl-reveal / kfl-parallax) is taken over, not doubled
 */
(function () {
  'use strict';
  var w = window, d = document, h = d.documentElement;
  var KFX = w.KFX = w.KFX || {};
  var mq = function (q) { try { return w.matchMedia(q).matches; } catch (e) { return false; } };
  var reduced = mq('(prefers-reduced-motion: reduce)');
  var fine = mq('(hover: hover) and (pointer: fine)');
  var meta = d.querySelector('meta[name="kfx-profile"]');
  var profile = (meta && meta.getAttribute('content')) || 'page';
  var qsa = function (sel, root) { return Array.prototype.slice.call((root || d).querySelectorAll(sel)); };
  var EXCLUDE = 'nav, header, footer, form, dialog, [role="dialog"], [aria-modal="true"], .no-kfx, .kfx-story, .kfx-compare, .kfx-3d, .kfx-hover-layer, #kfl-hero, [data-kfx-skip]';
  KFX.profile = profile;
  KFX.reduced = reduced;

  function run(fn, name) {
    try { fn(); } catch (err) { if (w.console) console.warn('[kfx] ' + name + ' failed', err); }
  }
  function isExcluded(el) { return !!(el.closest && el.closest(EXCLUDE)); }
  function hasClipText(el) {
    try {
      var cs = w.getComputedStyle(el);
      return cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text';
    } catch (e) { return false; }
  }
  function inFirstView(el) {
    var r = el.getBoundingClientRect();
    return r.top < (w.innerHeight || h.clientHeight) * 0.92 && r.bottom > 0;
  }
  function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }

  /* ------------------------------------------------------------ static mode */
  function showEverything() {
    qsa('.kfl-reveal').forEach(function (el) { el.classList.add('kfl-in'); });
    if (d.body) d.body.classList.add('kfl-loaded');
  }
  function liftPreloader(then) {
    if (!h.classList.contains('kfx-preload')) { if (then) then(false); return; }
    var t0 = w.__kfxT0 || 0;
    var now = (w.performance && performance.now) ? performance.now() : 0;
    var minWait = Math.max(0, 1050 - (now - t0));
    var fonts = (d.fonts && d.fonts.ready) ? d.fonts.ready : Promise.resolve();
    var cap = new Promise(function (res) { setTimeout(res, 1500); });
    Promise.race([fonts, cap]).then(function () {
      setTimeout(function () {
        h.classList.add('kfx-preload-out');
        if (then) then(true);
        setTimeout(function () { h.classList.remove('kfx-preload', 'kfx-preload-out'); }, 1150);
      }, minWait);
    });
  }

  /* ------------------------------------------------------------ smooth scroll */
  function initLenis() {
    if (!w.Lenis || profile === 'lite') return;
    var lenis = new w.Lenis({
      lerp: 0.09,
      smoothWheel: true,
      syncTouch: false,
      wheelMultiplier: 1,
      anchors: { offset: -88 },
      autoRaf: false,
      prevent: function (node) {
        return !!(node && node.closest && node.closest('[data-lenis-prevent], [role="dialog"], [aria-modal="true"], dialog, .overflow-y-auto, .overflow-auto, .overflow-y-scroll, .overflow-x-auto, textarea, select, iframe'));
      }
    });
    KFX.lenis = lenis;
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
    gsap.ticker.lagSmoothing(0);
    // pause while a modal locks the page (the site sets overflow:hidden on body/html)
    var sync = function () {
      var bs = d.body.style.overflow + ' ' + h.style.overflow;
      var locked = /hidden|clip/.test(bs) || d.body.classList.contains('overflow-hidden');
      if (locked) lenis.stop(); else lenis.start();
    };
    var mo = new MutationObserver(sync);
    mo.observe(d.body, { attributes: true, attributeFilter: ['style', 'class'] });
    mo.observe(h, { attributes: true, attributeFilter: ['style'] });
  }

  /* ------------------------------------------------------------ cursor */
  function initCursor() {
    if (!fine || profile === 'lite') return;
    var dot = d.createElement('div'); dot.className = 'kfx-cursor'; dot.setAttribute('aria-hidden', 'true');
    var ring = d.createElement('div'); ring.className = 'kfx-cursor-ring'; ring.setAttribute('aria-hidden', 'true');
    var label = d.createElement('span'); ring.appendChild(label);
    d.body.appendChild(ring); d.body.appendChild(dot);
    var xd = gsap.quickTo(dot, 'x', { duration: 0.12, ease: 'power3' });
    var yd = gsap.quickTo(dot, 'y', { duration: 0.12, ease: 'power3' });
    var xr = gsap.quickTo(ring, 'x', { duration: 0.5, ease: 'power3' });
    var yr = gsap.quickTo(ring, 'y', { duration: 0.5, ease: 'power3' });
    w.addEventListener('pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      h.classList.add('kfx-cursor-on');
      xd(e.clientX); yd(e.clientY); xr(e.clientX); yr(e.clientY);
    }, { passive: true });
    w.addEventListener('mouseout', function (e) { if (!e.relatedTarget) h.classList.remove('kfx-cursor-on'); }, { passive: true });
    d.addEventListener('pointerover', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var lab = t.closest('[data-kfx-cursor]');
      var txt = t.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]');
      var link = t.closest('a, button, [role="button"], label, summary, .kfx-mag');
      label.textContent = lab ? lab.getAttribute('data-kfx-cursor') : '';
      ring.classList.toggle('is-label', !!lab);
      ring.classList.toggle('is-link', !lab && !!link);
      ring.classList.toggle('is-text', !!txt);
      dot.classList.toggle('is-text', !!txt || !!lab);
    }, { passive: true });
    d.addEventListener('pointerdown', function () { gsap.to(ring, { scale: 0.82, duration: 0.15 }); }, { passive: true });
    d.addEventListener('pointerup', function () { gsap.to(ring, { scale: 1, duration: 0.4, ease: 'elastic.out(1,.5)' }); }, { passive: true });
  }

  /* ------------------------------------------------------------ magnetic */
  function initMagnetic() {
    if (!fine) return;
    qsa('a.magnetic-cta, button.magnetic-cta, .kfl-magnetic, .kfx-mag, .kfx-btn, a[href="#signup"]').forEach(function (btn) {
      if (btn.closest('nav, footer, [role="dialog"], .kfx-hover-layer')) return;
      var r0 = btn.getBoundingClientRect();
      if (!r0.width || r0.width > 460 || r0.height > 120) return;
      btn.classList.add('kfx-mag');
      btn.style.transitionProperty = 'color, background-color, border-color, box-shadow, opacity, filter';
      var xTo = gsap.quickTo(btn, 'x', { duration: 0.7, ease: 'elastic.out(1, .45)' });
      var yTo = gsap.quickTo(btn, 'y', { duration: 0.7, ease: 'elastic.out(1, .45)' });
      btn.addEventListener('pointermove', function (e) {
        if (e.pointerType && e.pointerType !== 'mouse') return;
        var r = btn.getBoundingClientRect();
        xTo((e.clientX - r.left - r.width / 2) * 0.32);
        yTo((e.clientY - r.top - r.height / 2) * 0.42);
      });
      btn.addEventListener('pointerleave', function () { xTo(0); yTo(0); });
    });
  }

  /* ------------------------------------------------------------ parallax */
  function initParallax() {
    qsa('.kfl-parallax[data-speed], [data-kfx-speed]').forEach(function (el) {
      var s = parseFloat(el.getAttribute('data-kfx-speed') || el.getAttribute('data-speed'));
      if (isNaN(s)) s = 0.15;
      var trg = el.closest('section') || el.parentElement || el;
      // the CSS `translate` property composes with any running CSS animation on `transform`
      gsap.fromTo(el, { '--kfx-py': function () { return (-s * 320) + 'px'; } }, {
        '--kfx-py': function () { return (s * 320) + 'px'; },
        ease: 'none',
        scrollTrigger: { trigger: trg, start: 'top bottom', end: 'bottom top', scrub: true, invalidateOnRefresh: true }
      });
      el.style.translate = '0 var(--kfx-py, 0px)';
    });
  }

  /* ------------------------------------------------------------ headings */
  // gradient text (background-clip: text) cannot be split: the clip would lose
  // the word boxes, so those parts are kept whole and rise as one piece
  var NO_SPLIT = '.holo-text, [class*="bg-clip-text"], svg, img, .kfx-noSplit';
  function splitReveal(el, opts) {
    opts = opts || {};
    if (!w.SplitText || hasClipText(el)) return null;
    var keep = qsa(NO_SPLIT, el);
    qsa('*', el).forEach(function (k) { if (keep.indexOf(k) === -1 && hasClipText(k)) keep.push(k); });
    keep = keep.filter(function (k) { return !keep.some(function (o) { return o !== k && o.contains(k); }); });
    return w.SplitText.create(el, {
      type: 'words',
      mask: 'words',
      wordsClass: 'kfx-w',
      aria: 'auto',
      autoSplit: true,
      ignore: keep.length ? keep : NO_SPLIT,
      onSplit: function (self) {
        var tl = gsap.timeline(opts.immediate ? { delay: opts.delay || 0 } : { scrollTrigger: { trigger: el, start: 'top 88%', once: true } });
        tl.from(self.words, { yPercent: 118, rotate: 3, duration: opts.duration || 1.15, ease: 'expo.out', stagger: opts.stagger || 0.055 }, 0);
        if (keep.length) tl.from(keep, { yPercent: 45, opacity: 0, duration: 1.25, ease: 'expo.out', stagger: 0.08 }, 0.12);
        return tl;
      }
    });
  }
  KFX.splitReveal = splitReveal;
  function initHeadings() {
    var heads = qsa('main h1, main h2, article h1, article h2, section h2, .kfx-split').filter(function (el, i, arr) {
      return arr.indexOf(el) === i && !isExcluded(el) && visible(el) && el.textContent.trim().length > 1;
    });
    heads.slice(0, 80).forEach(function (el) {
      if (el.tagName === 'H1' && inFirstView(el)) return; // first-view H1 is handled by the intro
      if (hasClipText(el)) { KFX._blocks.push(el); return; }
      splitReveal(el);
    });
  }

  /* ------------------------------------------------------------ blocks */
  function initBlocks() {
    var sel = [
      'main p', 'main ul > li', 'main ol > li', 'main blockquote', 'main figure', 'main table', 'main pre', 'main h3',
      'main .grid > *', 'main [class*="rounded-3xl"]', 'main [class*="rounded-2xl"][class*="border"]', '.kfl-reveal',
      'article p', 'article li', 'article h3', 'article blockquote', 'article figure', 'article table'
    ].join(', ');
    var pool = qsa(sel).filter(function (el) {
      if (isExcluded(el) || !visible(el)) return false;
      var pos = w.getComputedStyle(el).position;
      return pos !== 'fixed' && pos !== 'sticky';
    }).concat(KFX._blocks);
    var set = new Set(pool);
    // keep the outermost element only, so a card and its own paragraph never both move
    var blocks = pool.filter(function (el) {
      var p = el.parentElement;
      while (p) { if (set.has(p)) return false; p = p.parentElement; }
      return true;
    });
    var legacy = [], fresh = [];
    blocks.forEach(function (el) {
      if (el.classList.contains('kfl-reveal')) {
        if (inFirstView(el)) el.classList.add('kfl-in'); else legacy.push(el);
      } else if (!inFirstView(el)) { fresh.push(el); }
    });
    // anything legacy-tagged that we did not keep (nested) must not stay invisible
    qsa('.kfl-reveal').forEach(function (el) { if (legacy.indexOf(el) === -1) el.classList.add('kfl-in'); });
    if (legacy.length) {
      ScrollTrigger.batch(legacy, {
        start: 'top 90%', once: true,
        onEnter: function (batch) { batch.forEach(function (el, i) { el.style.transitionDelay = (i * 0.07) + 's'; el.classList.add('kfl-in'); }); }
      });
    }
    if (fresh.length) {
      fresh.forEach(function (el) { el.setAttribute('data-kfx-r', ''); });
      gsap.set(fresh, { opacity: 0, y: 34 });
      ScrollTrigger.batch(fresh, {
        start: 'top 90%', once: true,
        onEnter: function (batch) { gsap.to(batch, { opacity: 1, y: 0, duration: 1.05, ease: 'expo.out', stagger: 0.08, overwrite: true, clearProps: 'transform' }); }
      });
    }
  }

  /* ------------------------------------------------------------ images */
  function initImages() {
    qsa('main img, article img').forEach(function (img) {
      if (isExcluded(img) || inFirstView(img)) return;
      var r = img.getBoundingClientRect();
      if (r.width < 220 || r.height < 120) return;
      img.setAttribute('data-kfx-r', '');
      gsap.fromTo(img, { clipPath: 'inset(16% 8% 16% 8%)', scale: 1.08 }, {
        clipPath: 'inset(0% 0% 0% 0%)', scale: 1, duration: 1.4, ease: 'expo.out', clearProps: 'clipPath,transform',
        scrollTrigger: { trigger: img, start: 'top 88%', once: true }
      });
    });
  }

  /* ------------------------------------------------------------ counters + scramble */
  var GLYPHS = '0123456789₪#%אבגדהזחטכלמנסעפצקרשת';
  function scramble(el, finalText, dur) {
    var len = finalText.length, start = 0;
    function frame(now) {
      if (!start) start = now;
      var p = Math.min(1, (now - start) / dur);
      var reveal = Math.floor(p * len), out = '';
      for (var i = 0; i < len; i++) {
        var c = finalText.charAt(i);
        out += (i < reveal || c === ' ' || c === ',' || c === '.') ? c : GLYPHS.charAt((Math.random() * GLYPHS.length) | 0);
      }
      el.textContent = out;
      if (p < 1) w.requestAnimationFrame(frame); else el.textContent = finalText;
    }
    w.requestAnimationFrame(frame);
  }
  KFX.scramble = scramble;
  function initCounters() {
    qsa('[data-kfx-count]').forEach(function (el) {
      if (isExcluded(el) && !el.closest('.kfx-3d')) return;
      var to = parseFloat(el.getAttribute('data-kfx-count')) || 0;
      var from = parseFloat(el.getAttribute('data-kfx-from')) || 0;
      var o = { v: from };
      el.textContent = Math.round(from).toLocaleString('he-IL');
      gsap.to(o, {
        v: to, duration: 1.8, ease: 'power3.out',
        onUpdate: function () { el.textContent = Math.round(o.v).toLocaleString('he-IL'); },
        scrollTrigger: { trigger: el, start: 'top 90%', once: true }
      });
    });
    // big price digits and hand-marked labels scramble into place
    var scr = qsa('[data-kfx-scramble], .text-5xl > .num, .text-6xl > .num, .text-7xl > .num').filter(function (el) {
      return el.children.length === 0 && el.textContent.trim().length > 0 && !el.classList.contains('kfl-count');
    });
    scr.forEach(function (el) {
      var txt = el.textContent;
      ScrollTrigger.create({
        trigger: el, start: 'top 92%', once: true,
        onEnter: function () { scramble(el, txt, Math.min(1400, 380 + txt.length * 45)); }
      });
    });
  }

  /* ------------------------------------------------------------ hover reveal */
  function initHoverReveal() {
    if (!fine) return;
    qsa('.kfx-hover-card').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--hx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
        card.style.setProperty('--hy', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
      }, { passive: true });
    });
    var items = qsa('[data-kfx-img]');
    if (!items.length) return;
    var box = d.createElement('div'); box.className = 'kfx-float-img'; box.setAttribute('aria-hidden', 'true');
    var img = d.createElement('img'); img.alt = ''; img.decoding = 'async'; box.appendChild(img);
    d.body.appendChild(box);
    var xTo = gsap.quickTo(box, 'x', { duration: 0.55, ease: 'power3' });
    var yTo = gsap.quickTo(box, 'y', { duration: 0.55, ease: 'power3' });
    var rTo = gsap.quickTo(box, 'rotation', { duration: 0.8, ease: 'power3' });
    var lastX = 0;
    items.forEach(function (it) {
      it.addEventListener('pointerenter', function () {
        var src = it.getAttribute('data-kfx-img');
        if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
        gsap.to(box, { opacity: 1, scale: 1, duration: 0.45, ease: 'power3.out' });
      });
      it.addEventListener('pointerleave', function () { gsap.to(box, { opacity: 0, scale: 0.85, duration: 0.35 }); });
      it.addEventListener('pointermove', function (e) {
        xTo(e.clientX + 24); yTo(e.clientY - 90);
        rTo(Math.max(-12, Math.min(12, (e.clientX - lastX) * 0.6))); lastX = e.clientX;
      }, { passive: true });
    });
  }

  /* ------------------------------------------------------------ tilt cards */
  // pricing / feature cards lean toward the pointer, with a soft light under it
  function initTilt() {
    if (!fine) return;
    qsa('[data-kfx-tilt], .kfl-lift.rounded-3xl').forEach(function (card) {
      if (card.closest('nav, footer, [role="dialog"], .kfx-story, .kfx-compare, .kfx-3d')) return;
      var r0 = card.getBoundingClientRect();
      if (!r0.width || r0.width > 720) return;
      card.classList.add('kfx-tilt');
      card.style.transitionProperty = 'box-shadow, background-color, border-color, color';
      // perspective is (re)applied on enter: a finished reveal clears the transform cache
      card.addEventListener('pointerenter', function () { gsap.set(card, { transformPerspective: 900 }); }, { passive: true });
      var rx = gsap.quickTo(card, 'rotationX', { duration: 0.6, ease: 'power3' });
      var ry = gsap.quickTo(card, 'rotationY', { duration: 0.6, ease: 'power3' });
      var lift = gsap.quickTo(card, 'y', { duration: 0.6, ease: 'power3' });
      card.addEventListener('pointermove', function (e) {
        if (e.pointerType && e.pointerType !== 'mouse') return;
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        ry((px - 0.5) * 9); rx((0.5 - py) * 7); lift(-4);
        card.style.setProperty('--gx', (px * 100).toFixed(1) + '%');
        card.style.setProperty('--gy', (py * 100).toFixed(1) + '%');
      }, { passive: true });
      card.addEventListener('pointerleave', function () { rx(0); ry(0); lift(0); });
    });
  }

  /* ------------------------------------------------------------ scroll highlight */
  // [data-kfx-highlight]: the words go from faint to full ink while the
  // paragraph crosses the screen (scrubbed, so it follows the reader)
  function initHighlight() {
    if (!w.SplitText) return;
    qsa('[data-kfx-highlight]').forEach(function (el) {
      var to = w.getComputedStyle(el).color;
      w.SplitText.create(el, {
        type: 'words', wordsClass: 'kfx-hl-w', aria: 'auto', autoSplit: true,
        onSplit: function (self) {
          return gsap.fromTo(self.words, { color: '#c3cad8' }, {
            color: to, ease: 'none', stagger: 0.12,
            scrollTrigger: { trigger: el, start: 'top 82%', end: 'bottom 48%', scrub: 0.5 }
          });
        }
      });
    });
  }

  /* ------------------------------------------------------------ accordions */
  // every <details> on the page (FAQ, guides) opens and closes with a smooth
  // height animation instead of a jump; keyboard and screen readers keep the
  // native summary behaviour
  function initAccordions() {
    var refreshSoon = (function () {
      var t = 0;
      return function () { w.clearTimeout(t); t = w.setTimeout(function () { ScrollTrigger.refresh(); }, 60); };
    })();
    qsa('details').forEach(function (det) {
      if (det.closest('header, nav, #kfl-mnav, [role="dialog"], [aria-modal="true"], .no-kfx') || det.hasAttribute('data-kfx-acc')) return;
      var sum = det.firstElementChild;
      if (!sum || sum.tagName !== 'SUMMARY' || !sum.nextSibling) return;
      det.setAttribute('data-kfx-acc', '');
      var body = d.createElement('div');
      body.className = 'kfx-acc';
      while (sum.nextSibling) body.appendChild(sum.nextSibling);
      det.appendChild(body);
      var tw = null;
      sum.addEventListener('click', function (e) {
        e.preventDefault();
        if (tw) { tw.kill(); tw = null; }
        var closing = det.hasAttribute('open') && !det.classList.contains('kfx-acc-closing');
        if (closing) {
          det.classList.add('kfx-acc-closing');
          tw = gsap.fromTo(body, { height: body.offsetHeight, opacity: 1 }, {
            height: 0, opacity: 0, duration: 0.34, ease: 'power2.inOut',
            onComplete: function () {
              det.removeAttribute('open'); det.classList.remove('kfx-acc-closing');
              gsap.set(body, { clearProps: 'height,opacity' }); tw = null; refreshSoon();
            }
          });
        } else {
          var from = det.classList.contains('kfx-acc-closing') ? body.offsetHeight : 0;
          det.classList.remove('kfx-acc-closing');
          det.setAttribute('open', '');
          tw = gsap.fromTo(body, { height: from, opacity: from ? 1 : 0 }, {
            height: 'auto', opacity: 1, duration: 0.46, ease: 'power3.out',
            onComplete: function () { gsap.set(body, { clearProps: 'height,opacity' }); tw = null; refreshSoon(); }
          });
        }
      });
    });
  }

  /* ------------------------------------------------------------ footer wordmark */
  // pages with a full footer end on a big outlined wordmark that rises and
  // fills with blue as the reader reaches the bottom (decorative)
  function initWordmark() {
    var foot = qsa('footer').filter(function (f) { return qsa('ul', f).length >= 2 && !f.closest('main, article'); }).pop();
    if (!foot || foot.querySelector('.kfx-wordmark')) return;
    var logo = d.querySelector('.kfl-logo-text');
    var name = ((logo && logo.textContent) || '').trim() || 'כספ\'לה';
    var wm = d.createElement('div');
    wm.className = 'kfx-wordmark';
    wm.setAttribute('aria-hidden', 'true');
    var inner = d.createElement('div');
    inner.className = 'kfx-wordmark__in';
    var o = d.createElement('span'); o.className = 'kfx-wordmark__o'; o.textContent = name;
    var f = d.createElement('span'); f.className = 'kfx-wordmark__f'; f.textContent = name;
    inner.appendChild(o); inner.appendChild(f); wm.appendChild(inner); foot.appendChild(wm);
    var st = { trigger: wm, start: 'top bottom', end: 'max', scrub: 0.6 };
    gsap.fromTo(inner, { yPercent: 38 }, { yPercent: 0, ease: 'none', scrollTrigger: st });
    gsap.fromTo(f, { clipPath: 'inset(100% 0% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', ease: 'none', scrollTrigger: Object.assign({}, st, { start: 'top 92%' }) });
  }

  /* ------------------------------------------------------------ intro */
  function heroIntro(withPreloader) {
    if (d.body) d.body.classList.add('kfl-loaded');
    var h1 = qsa('h1').filter(function (el) { return !el.closest('nav, footer') && visible(el); })[0];
    if (!h1 || !inFirstView(h1)) return;
    if (!withPreloader) return; // repeat visits: the headline is already painted, keep it calm
    splitReveal(h1, { immediate: true, duration: 1.35, stagger: 0.07, delay: 0.08 });
  }

  /* ------------------------------------------------------------ theme icons */
  // pages with a light/dark toggle only sync their icons when dark was saved;
  // the site is dark by default now, so show the icon that matches the page
  function syncThemeIcons() {
    var dark = h.classList.contains('dark');
    var moon = d.getElementById('icon-moon'), sun = d.getElementById('icon-sun');
    if (moon) moon.classList.toggle('hidden', dark);
    if (sun) sun.classList.toggle('hidden', !dark);
  }

  /* ------------------------------------------------------------ boot */
  function boot() {
    if (KFX._booted) return;
    KFX._booted = true;
    w.__kfxReady = true;
    if (w.__kfxOff) return; // ?kfx=off: the legacy page scripts stay in charge
    h.classList.remove('kfx-fail');
    run(syncThemeIcons, 'theme');
    if (!w.gsap || !w.ScrollTrigger || reduced) {
      if (reduced) h.classList.add('kfx-reduced');
      showEverything();
      liftPreloader();
      if (typeof KFX.homeStatic === 'function') run(KFX.homeStatic, 'homeStatic');
      return;
    }
    h.classList.add('kfx-anim');
    gsap.registerPlugin(ScrollTrigger);
    if (w.SplitText) gsap.registerPlugin(w.SplitText);
    ScrollTrigger.config({ ignoreMobileResize: true });
    KFX._blocks = [];
    run(initLenis, 'lenis');
    run(initCursor, 'cursor');
    run(initParallax, 'parallax');
    if (typeof KFX.homeInit === 'function') run(KFX.homeInit, 'home');
    run(initHeadings, 'headings');
    run(initBlocks, 'blocks');
    run(initImages, 'images');
    run(initCounters, 'counters');
    run(initHoverReveal, 'hover');
    run(initHighlight, 'highlight');
    run(initTilt, 'tilt');
    run(initAccordions, 'accordions');
    run(initWordmark, 'wordmark');
    run(initMagnetic, 'magnetic');
    liftPreloader(function (had) { run(function () { heroIntro(had); }, 'intro'); });
    var refresh = function () { ScrollTrigger.refresh(); };
    if (d.fonts && d.fonts.ready) d.fonts.ready.then(refresh);
    w.addEventListener('load', refresh, { once: true });
  }
  if (d.readyState === 'complete' || w.__kfxDCL) boot();
  else d.addEventListener('DOMContentLoaded', boot, { once: true });
})();
