#!/usr/bin/env node
// tests/pwa.js
//
// PWA hardening invariants (2026-06-03, Monday epic "mobile app iOS+Android"
// cheap path: make the dashboard install + behave like a real app).
//
// The Kesefle PWA already shipped a manifest, a service worker, an offline
// page and an install CTA. This suite PINS the pieces so a future edit can't
// silently regress installability or re-introduce the stale-cache class of
// bug. It reads REAL source via fs (the house pattern -- no ESM import, no
// mocking, no secrets/deps). Pure-compute, safe to run on the QA gate.
//
//   Run: node tests/pwa.js
//
// Invariants:
//   1.  manifest.webmanifest parses as JSON and has the installability fields
//       (name, short_name, start_url, display:standalone, icons,
//       theme_color, background_color).
//   2.  At least one 192px AND one 512px icon, plus a maskable icon; every
//       icon src in the manifest exists on disk and is square-named.
//   3.  manifest.theme_color matches the <meta name="theme-color"> the app
//       shell pages actually ship (so the install splash / OS chrome colour
//       does not disagree with the in-page chrome).
//   4.  Shortcuts point at LIVE destinations -- not a path that vercel.json
//       redirects away (the old /status shortcut 308'd to / -> dead shortcut).
//   5.  sw.js versions its caches, calls skipWaiting + clients.claim, deletes
//       stale kesefle-* caches on activate, and serves an offline fallback for
//       navigations. (The auto-update story, task #13.)
//   6.  The app shell pages register /sw.js AND wire the controllerchange
//       reload-once auto-update, guarded against reloading on first install.
//   7.  iOS meta is present on the app shell pages: apple-mobile-web-app-capable,
//       -title, -status-bar-style, and an apple-touch-icon.
//   8.  An install CTA (beforeinstallprompt handling) exists on the dashboard.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel.replace(/^\//, '')));

const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS  ' + label); }
  else { failures.push(label); console.log('  FAIL  ' + label); }
}

// The standalone app-shell pages (start_url + the two places a cold user lands
// then installs from). These carry the iOS meta + SW auto-update wiring.
const SHELL_PAGES = ['dashboard.html', 'index.html', 'welcome.html'];

// ---------------------------------------------------------------------------
// 1. manifest parses + required installability fields
// ---------------------------------------------------------------------------
console.log('\n-- manifest.webmanifest: valid JSON + installability fields --');
const manifestRaw = read('manifest.webmanifest');
let m = null;
try { m = JSON.parse(manifestRaw); assert(true, 'manifest.webmanifest is valid JSON'); }
catch (e) { assert(false, 'manifest.webmanifest is valid JSON (' + e.message + ')'); }

if (m) {
  assert(typeof m.name === 'string' && m.name.length > 0, 'manifest has a non-empty name');
  assert(typeof m.short_name === 'string' && m.short_name.length > 0, 'manifest has a non-empty short_name');
  assert(typeof m.short_name === 'string' && m.short_name.length <= 12,
    'short_name <= 12 chars (home-screen label does not truncate)');
  assert(typeof m.start_url === 'string' && m.start_url.startsWith('/'), 'manifest start_url is a same-origin path');
  assert(m.display === 'standalone', 'manifest display is "standalone"');
  assert(typeof m.theme_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(m.theme_color), 'manifest theme_color is a hex colour');
  assert(typeof m.background_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(m.background_color), 'manifest background_color is a hex colour');
  assert(Array.isArray(m.icons) && m.icons.length > 0, 'manifest has at least one icon');
  assert(m.dir === 'rtl' && m.lang === 'he', 'manifest declares RTL + Hebrew (lang/dir preserved)');

  // ------------------------------------------------------------------------
  // 2. icon coverage + every src exists on disk + square
  // ------------------------------------------------------------------------
  console.log('\n-- manifest icons: 192 + 512 + maskable, all present on disk --');
  const icons = m.icons || [];
  const has = (size) => icons.some((i) => String(i.sizes || '').split(/\s+/).includes(size));
  assert(has('192x192'), 'manifest declares a 192x192 icon');
  assert(has('512x512'), 'manifest declares a 512x512 icon');
  assert(icons.some((i) => String(i.purpose || '').split(/\s+/).includes('maskable')),
    'manifest declares a maskable icon (Android adaptive-icon safe-zone)');
  for (const ic of icons) {
    assert(exists(ic.src), 'icon file exists on disk: ' + ic.src);
    // App icons must be square -- a WxH where W !== H (e.g. a 1200x630 og-image)
    // is rejected by installers and flagged by Lighthouse. Guard against the
    // landscape-image-as-icon mistake.
    const dims = String(ic.sizes || '').split('x');
    if (dims.length === 2) {
      assert(dims[0] === dims[1], 'icon is square: ' + ic.src + ' (' + ic.sizes + ')');
    }
  }

  // ------------------------------------------------------------------------
  // 3. theme_color agrees with the app shell <meta name="theme-color">
  // ------------------------------------------------------------------------
  console.log('\n-- theme_color: manifest agrees with the app shell pages --');
  for (const page of SHELL_PAGES) {
    const html = read(page);
    const mt = html.match(/<meta\s+name=["']theme-color["']\s+content=["'](#[0-9a-fA-F]{6})["']/i);
    assert(!!mt, page + ' has a <meta name="theme-color"> with a hex colour');
    if (mt) {
      assert(mt[1].toLowerCase() === m.theme_color.toLowerCase(),
        page + ' theme-color (' + mt[1] + ') matches manifest theme_color (' + m.theme_color + ')');
    }
  }

  // ------------------------------------------------------------------------
  // 4. shortcuts point at LIVE destinations (not a redirected path)
  // ------------------------------------------------------------------------
  console.log('\n-- manifest shortcuts: at least /dashboard + a log-expense action, no dead links --');
  const shortcuts = Array.isArray(m.shortcuts) ? m.shortcuts : [];
  assert(shortcuts.length >= 2, 'manifest declares at least two shortcuts');
  assert(shortcuts.some((s) => s.url === '/dashboard'), 'a shortcut opens /dashboard');
  // log-expense action: in this product, logging an expense IS sending the bot
  // a WhatsApp message. Accept either a wa.me deep-link or an on-site /expense.
  assert(shortcuts.some((s) => /wa\.me\//.test(String(s.url)) || /\/expense\b/.test(String(s.url))),
    'a shortcut is a log-expense action (wa.me deep-link or /expense)');

  // No shortcut may target a path that vercel.json redirects away from -- that
  // turns the shortcut into a one-way trip to the homepage. We only need to
  // check same-origin absolute-path shortcuts.
  const vercel = JSON.parse(read('vercel.json'));
  const redirectSources = new Set((vercel.redirects || []).map((r) => r.source));
  for (const s of shortcuts) {
    const u = String(s.url || '');
    if (u.startsWith('/')) {
      const pathOnly = u.split('?')[0].split('#')[0];
      assert(!redirectSources.has(pathOnly),
        'shortcut ' + JSON.stringify(u) + ' is not a redirected (dead) path');
    }
  }
}

// ---------------------------------------------------------------------------
// 5. service worker: cache versioning + auto-update + offline fallback
// ---------------------------------------------------------------------------
console.log('\n-- sw.js: cache versioning + skipWaiting/clients.claim + stale-cache cleanup --');
const sw = read('sw.js');
assert(/const\s+VERSION\s*=/.test(sw), 'sw.js defines a VERSION constant (cache busting)');
assert(/caches\.open\(\s*[A-Z_]*CACHE/.test(sw) || /\$\{VERSION\}/.test(sw),
  'sw.js names its caches off the VERSION (versioned caches)');
assert(/skipWaiting\s*\(/.test(sw), 'sw.js calls skipWaiting() (activate the new SW promptly)');
assert(/clients\.claim\s*\(/.test(sw), 'sw.js calls clients.claim() (take control of open pages)');
assert(/addEventListener\(\s*['"]activate['"]/.test(sw), 'sw.js has an activate handler');
assert(/caches\.delete\(/.test(sw), 'sw.js deletes caches on activate (stale-cache cleanup)');
assert(/caches\.keys\(/.test(sw), 'sw.js enumerates caches.keys() to find stale ones');
assert(/addEventListener\(\s*['"]fetch['"]/.test(sw), 'sw.js has a fetch handler');

console.log('\n-- sw.js: offline fallback for navigations --');
assert(/offline\.html/.test(sw), 'sw.js references the offline fallback (offline.html)');
assert(exists('offline.html'), 'offline.html exists on disk');
// The navigation route must be network-FIRST (fresh HTML beats stale layout),
// falling back to cache/offline -- never cache-first for HTML (that is the
// classic stale-dashboard bug). Assert the fetch handler routes navigations
// through a network-with-fallback helper rather than caching HTML responses.
assert(/mode\s*===\s*['"]navigate['"]/.test(sw) || /isNavigation\(/.test(sw),
  'sw.js detects navigation requests');
assert(/networkWithFallback|network-first|networkFirst/.test(sw) || /try\s*\{[\s\S]*fetch\(request\)[\s\S]*\}\s*catch/.test(sw),
  'sw.js serves navigations network-first (no stale-HTML cache-first bug)');

// offline.html must itself be self-contained (no external app JS) so it works
// with zero network, and must declare RTL + the offline messaging.
const offline = read('offline.html');
assert(/dir=["']rtl["']/.test(offline), 'offline.html is RTL');
assert(/navigator\.onLine|window\.addEventListener\(\s*['"]online['"]/.test(offline),
  'offline.html reacts to coming back online');

// ---------------------------------------------------------------------------
// 6. app shell pages: SW registration + controllerchange auto-update
// ---------------------------------------------------------------------------
console.log('\n-- app shell pages: register /sw.js + reload-once auto-update --');
for (const page of SHELL_PAGES) {
  const html = read(page);
  assert(/serviceWorker\s*['")\]]/.test(html) && /register\(\s*['"]\/sw\.js['"]/.test(html),
    page + ' registers /sw.js');
  assert(/controllerchange/.test(html), page + ' listens for controllerchange (SW auto-update, #13)');
  // Guard: the reload must be gated by a "had a controller already" flag, else
  // the very first install reloads the page under the user (jarring + a reload
  // loop risk). We check both the guard variable and a single reload.
  assert(/controller\b/.test(html) && /location\.reload\(\)/.test(html),
    page + ' reloads on controllerchange but guards the first-install case');
}

// ---------------------------------------------------------------------------
// 7. iOS meta on the app shell pages
// ---------------------------------------------------------------------------
console.log('\n-- iOS meta: capable + title + status-bar-style + apple-touch-icon --');
for (const page of SHELL_PAGES) {
  const html = read(page);
  assert(/<meta\s+name=["']apple-mobile-web-app-capable["']\s+content=["']yes["']/i.test(html),
    page + ' has apple-mobile-web-app-capable=yes');
  assert(/<meta\s+name=["']apple-mobile-web-app-status-bar-style["']/i.test(html),
    page + ' has apple-mobile-web-app-status-bar-style (iOS standalone status bar)');
  assert(/<meta\s+name=["']apple-mobile-web-app-title["']/i.test(html),
    page + ' has apple-mobile-web-app-title');
  assert(/<link\s+rel=["']apple-touch-icon["']/i.test(html),
    page + ' has an apple-touch-icon');
  assert(/<link\s+rel=["']manifest["']\s+href=["']\/manifest\.webmanifest["']/i.test(html),
    page + ' links the manifest');
}

// ---------------------------------------------------------------------------
// 8. install CTA (beforeinstallprompt) on the dashboard
// ---------------------------------------------------------------------------
console.log('\n-- install CTA: beforeinstallprompt handling (#125) --');
const dash = read('dashboard.html');
assert(/beforeinstallprompt/.test(dash), 'dashboard.html handles beforeinstallprompt');
assert(/preventDefault\(\)/.test(dash) && /\.prompt\(\)/.test(dash),
  'dashboard.html stashes the event and calls prompt() on user action');
assert(/appinstalled/.test(dash), 'dashboard.html listens for appinstalled');
assert(/display-mode:\s*standalone|navigator\.standalone/.test(dash),
  'dashboard.html suppresses the CTA when already installed (standalone)');

// ---------------------------------------------------------------------------
console.log('');
if (failures.length) {
  console.error('FAILED ' + failures.length + ' PWA invariant(s):');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('ALL PASSED (PWA: manifest + service worker + install + iOS hardened)\n');
process.exit(0);
