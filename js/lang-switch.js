/* js/lang-switch.js — shared language switcher for the Kesefle multilingual site.
 *
 * Israel-anchored locales: he (default, root, no prefix), and ar/ru/fr/it/en under
 * /<lang>/ path prefixes. The switcher keeps the user on the SAME page in the new
 * language: it strips any leading /(ar|ru|fr|it|en)/ segment from the current path,
 * re-prefixes with the chosen language (he = no prefix), and navigates there — but
 * only if that {lang,page} is actually published (window.KESEFLE_PUBLISHED is a map
 * lang -> [slugs]); otherwise it falls back to that language's home so we never link
 * to a 404 during a phased rollout.
 *
 * NO Accept-Language auto-redirect (it hurts SEO and traps users). Choice persists
 * in localStorage + a 1-year cookie so a returning visitor can be offered (never
 * forced) their language.
 */
(function () {
  'use strict';
  var PREFIXES = ['ar', 'ru', 'fr', 'it', 'en']; // he has no prefix (it is x-default/root)

  // Current path's {lang, slug}. slug '' = home. Hebrew root has lang 'he'.
  function parsePath() {
    var p = location.pathname.replace(/\/+$/, ''); // drop trailing slash
    var segs = p.split('/').filter(Boolean);       // ['ar','pricing'] | ['pricing'] | []
    var lang = 'he', slug = '';
    if (segs.length && PREFIXES.indexOf(segs[0]) >= 0) { lang = segs[0]; slug = segs.slice(1).join('/'); }
    else { slug = segs.join('/'); }
    return { lang: lang, slug: slug };
  }

  function published(lang, slug) {
    var map = window.KESEFLE_PUBLISHED || {};
    // Hebrew originals are always considered published (the canonical site).
    if (lang === 'he') return true;
    var list = map[lang];
    if (!list) return false;
    return list.indexOf(slug) >= 0;
  }

  function targetHref(lang) {
    var cur = parsePath();
    var slug = cur.slug;
    if (!published(lang, slug)) slug = ''; // fall back to that language's home
    var base = (lang === 'he') ? '' : '/' + lang;
    var path = base + '/' + slug;
    path = path.replace(/\/+$/, '');       // tidy trailing slash
    return (path || '/');
  }

  function persist(lang) {
    try { localStorage.setItem('kesefle_lang', lang); } catch (e) {}
    try { document.cookie = 'kesefle_lang=' + lang + ';path=/;max-age=31536000;samesite=lax'; } catch (e) {}
  }

  function wire(root) {
    var trigger = root.querySelector('.lang-trigger');
    var menu = root.querySelector('.lang-menu');
    if (!trigger || !menu) return;

    function close() { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
    function open() { menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menu.hidden) open(); else close();
    });
    document.addEventListener('click', function (e) { if (!root.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    menu.querySelectorAll('[data-lang]').forEach(function (li) {
      li.addEventListener('click', function () {
        var lang = li.getAttribute('data-lang');
        persist(lang);
        location.href = targetHref(lang);
      });
      // keyboard: Enter/Space selects
      li.setAttribute('tabindex', '0');
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.click(); }
      });
    });
  }

  function init() {
    document.querySelectorAll('.lang-switch').forEach(wire);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
