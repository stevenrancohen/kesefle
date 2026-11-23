#!/usr/bin/env node
// Trust contract for the install journey: every localized guide installs the
// actual /app PWA from the canonical domain and describes offline behavior
// honestly. Financial APIs are network-only; only the shell/offline page cache.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const failures = [];
function assert(condition, label) {
  if (condition) console.log('  PASS ' + label);
  else { failures.push(label); console.error('  FAIL ' + label); }
}

console.log('\ntests/test_install_domain_trust.js\n');

const pages = [
  { file: 'install.html', lang: 'he', dir: 'rtl', privacy: /נתונים פיננסיים אינם נשמרים/ },
  { file: 'ar/install.html', lang: 'ar', dir: 'rtl', privacy: /البيانات المالية/ },
  { file: 'ru/install.html', lang: 'ru', dir: 'ltr', privacy: /финансовые данные/ },
  { file: 'fr/install.html', lang: 'fr', dir: 'ltr', privacy: /données financières/ },
  { file: 'it/install.html', lang: 'it', dir: 'ltr', privacy: /dati finanziari/ },
];

const staleOfflineClaims = [
  /הדשבורד נשמר בקאש המקומי/,
  /يعرض لوحة المعلومات من الذاكرة المؤقتة/,
  /дашборд из кэша/,
  /tableau de bord depuis le cache/,
  /dashboard dalla cache/,
];
const staleInstructionClaims = [
  /באנר בתחתית/,
  /شريطًا في الأسفل/,
  /баннер внизу/,
  /bannière en bas/,
  /banner in basso/,
];

for (const spec of pages) {
  const html = read(spec.file);
  assert(new RegExp('<html lang="' + spec.lang + '" dir="' + spec.dir + '">').test(html),
    spec.file + ' preserves the expected language direction');
  assert(/name="viewport"[^>]*width=device-width/.test(html),
    spec.file + ' has a mobile viewport');
  assert(/<link rel="manifest" href="\/app\.webmanifest"\s*\/>/.test(html) &&
    !/<link rel="manifest" href="\/manifest\.webmanifest"/.test(html),
    spec.file + ' installs the /app manifest, not the legacy dashboard manifest');
  assert(/href="https:\/\/kesefle\.com\/app"/.test(html),
    spec.file + ' exposes a tappable canonical app link');
  assert(/src="\/js\/install-pwa\.js" defer/.test(html) &&
    /data-install-shell/.test(html) && /data-install-button/.test(html) &&
    /data-install-status role="status" aria-live="polite"/.test(html),
    spec.file + ' exposes an accessible browser-native install action');
  assert(!/kesefle\.vercel\.app/i.test(html),
    spec.file + ' contains no obsolete Vercel hostname');
  assert(/id="device-ios"/.test(html) && /id="device-android"/.test(html) &&
    /data-device="ios"/.test(html) && /data-device="android"/.test(html),
    spec.file + ' includes separate iPhone and Android instructions');
  assert(/Open as Web App/.test(html),
    spec.file + ' preserves the iPhone web-app mode during Add to Home Screen');
  assert(/\.device-tab\s*\{[^}]*min-height:\s*44px/.test(html) && /min-h-\[48px\]/.test(html),
    spec.file + ' keeps mobile tabs and install actions at accessible touch sizes');
  assert(spec.privacy.test(html),
    spec.file + ' explains that financial data is not stored in a shared cache');
  assert(!staleOfflineClaims.some((pattern) => pattern.test(html)),
    spec.file + ' does not promise a cached financial dashboard');
  assert(!staleInstructionClaims.some((pattern) => pattern.test(html)),
    spec.file + ' does not depend on an obsolete bottom install banner');
}

const appManifest = JSON.parse(read('app.webmanifest'));
assert(appManifest.start_url === '/app' && appManifest.id === '/app' && appManifest.scope === '/',
  'app manifest identity and start URL are canonical /app paths');
assert(appManifest.display === 'standalone' && appManifest.lang === 'he' && appManifest.dir === 'rtl',
  'app manifest is standalone Hebrew RTL');
assert(Array.isArray(appManifest.icons) && appManifest.icons.some((icon) => icon.sizes === '192x192') &&
  appManifest.icons.some((icon) => icon.sizes === '512x512') &&
  appManifest.icons.some((icon) => /maskable/.test(String(icon.purpose || ''))),
  'app manifest has 192, 512 and maskable icons');

const sw = read('sw.js');
for (const pathName of ['/app', '/app.html', '/app.webmanifest', '/offline.html']) {
  assert(sw.includes("'" + pathName + "'"), 'service worker precaches ' + pathName);
}
assert(/isApi\(url\)[\s\S]{0,500}event\.respondWith\(fetch\(request\)/.test(sw),
  'same-origin financial and identity APIs stay network-only');
assert(/networkWithFallback\(request, OFFLINE_URL\)/.test(sw),
  'offline navigation falls back to the offline shell');

const offline = read('offline.html');
assert(/<link rel="manifest" href="\/app\.webmanifest"/.test(offline) &&
  /href="\/app"/.test(offline),
  'offline fallback keeps the canonical app identity and return path');
assert(!/\/dashboard/.test(offline) && !/kesefle_last_summary/.test(offline) &&
  !/summary-body/.test(offline),
  'offline fallback has no legacy dashboard redirect or dead summary store');
assert(/נתונים פיננסיים עדכניים אינם נשמרים/.test(offline) &&
  /WhatsApp דורשת חיבור/.test(offline),
  'offline fallback states privacy and connectivity limits honestly');
assert(/fetch\('\/api\/health'/.test(offline) && /cache:\s*'no-store'/.test(offline) &&
  /content-type/.test(offline) && /health\.ok !== true/.test(offline),
  'offline retry verifies Kesefle availability before returning to the app');
assert(!/setOnline\(navigator\.onLine\)/.test(offline),
  'offline fallback does not trust the unreliable navigator online hint');

const app = read('app.html');
assert(/ב-Safari: תפריט העמוד ← שיתוף/.test(app) && /Open as Web App/.test(app) &&
  !/כפתור השיתוף בתחתית הדפדפן/.test(app),
  'in-app iPhone prompt follows the current page-menu/share/web-app path without assuming toolbar position');

const installScript = read('js/install-pwa.js');
assert(/beforeinstallprompt/.test(installScript) && /event\.preventDefault\(\)/.test(installScript) &&
  /await prompt\.prompt\(\)/.test(installScript) && /await prompt\.userChoice/.test(installScript),
  'install helper captures and completes the native browser install prompt');
assert(/window\.navigator\.standalone === true/.test(installScript) &&
  /display-mode: standalone/.test(installScript) && /appinstalled/.test(installScript),
  'install helper detects iOS and standards-based installed states');

if (failures.length) {
  console.error('\nFAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('\nOK: all assertions passed');
