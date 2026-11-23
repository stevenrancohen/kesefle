#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const swSource = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.webmanifest'), 'utf8'));
const screenshotFixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests/fixtures/pwa-screenshot-preview.json'),
  'utf8'
));
const screenshotServer = fs.readFileSync(
  path.join(ROOT, 'scripts/pwa-screenshot-preview-server.js'),
  'utf8'
);

function pngDimensions(file) {
  const buffer = fs.readFileSync(file);
  assert.deepStrictEqual(
    Array.from(buffer.subarray(0, 8)),
    [137, 80, 78, 71, 13, 10, 26, 10],
    path.basename(file) + ' must be a real PNG'
  );
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

assert.ok(Array.isArray(manifest.screenshots) && manifest.screenshots.length >= 2,
  'app manifest should show at least two product screenshots during install');
assert.ok(manifest.screenshots.some((shot) => shot.form_factor === 'narrow'),
  'app manifest should include a phone-sized screenshot');
assert.ok(manifest.screenshots.some((shot) => shot.form_factor === 'wide'),
  'app manifest should include a desktop-sized screenshot');
assert.strictEqual(screenshotFixture.synthetic, true,
  'public screenshot source is explicitly synthetic');
assert.strictEqual(screenshotFixture.notice, 'נתוני הדגמה',
  'synthetic screenshot identity is visibly labelled in the app header');
assert.match(screenshotServer, /pwa-screenshot-preview\.json/,
  'the reproducible preview server reads the checked-in synthetic fixture');
assert.doesNotMatch(screenshotServer, /oauth|googleapis|KV_REST|accessToken|refreshToken/i,
  'the screenshot server cannot read a real account, sheet or credential');

for (const shot of manifest.screenshots) {
  assert.match(shot.src, /^\/pwa-screenshots\/[a-z0-9-]+\.png$/,
    'screenshot uses a stable same-origin PNG path');
  assert.match(shot.sizes, /^\d+x\d+$/, 'screenshot declares pixel dimensions');
  assert.strictEqual(shot.type, 'image/png', 'screenshot declares its PNG MIME type');
  assert.ok(typeof shot.label === 'string' && shot.label.trim().length >= 8,
    'screenshot has a useful accessible label');
  assert.match(shot.label, /^נתוני הדגמה:/,
    'screenshot label explicitly says the financial values are demo data');
  const file = path.join(ROOT, shot.src.slice(1));
  assert.ok(fs.existsSync(file), shot.src + ' exists on disk');
  const actual = pngDimensions(file);
  assert.strictEqual(shot.sizes, actual.width + 'x' + actual.height,
    shot.src + ' manifest dimensions match the real image');
  if (shot.form_factor === 'narrow') assert.ok(actual.height > actual.width,
    shot.src + ' is genuinely portrait');
  if (shot.form_factor === 'wide') assert.ok(actual.width > actual.height,
    shot.src + ' is genuinely landscape');
}

function contentTypeFor(url) {
  if (url === '/app' || url === '/expense' || /\.html$/.test(url) || url === '/') return 'text/html; charset=utf-8';
  if (/\.webmanifest$/.test(url)) return 'application/manifest+json; charset=utf-8';
  if (/\.js$/.test(url)) return 'application/javascript; charset=utf-8';
  if (/\.css$/.test(url)) return 'text/css; charset=utf-8';
  if (/\.png$/.test(url)) return 'image/png';
  return 'application/octet-stream';
}

function makeResponse(url, ok = true) {
  return {
    ok,
    headers: { get(name) { return name.toLowerCase() === 'content-type' ? contentTypeFor(url) : null; } },
    clone() { return makeResponse(url, ok); },
  };
}

async function runInstall({ failedFetch, failedPut, failedStatus, invalidContentType } = {}) {
  const listeners = {};
  const writes = [];
  const deletions = [];
  let skipped = 0;
  const context = {
    console,
    URL,
    Response,
    fetch: async (url, options) => {
      assert.strictEqual(options.cache, 'reload', 'precache bypasses a stale HTTP cache');
      if (url === failedFetch) throw new Error('simulated fetch failure');
      const response = makeResponse(url, url !== failedStatus);
      if (url === invalidContentType) {
        response.headers.get = (name) => name.toLowerCase() === 'content-type'
          ? 'text/html; profile="javascript"'
          : null;
      }
      return response;
    },
    caches: {
      open: async () => ({
        put: async (url) => {
          if (url === failedPut) throw new Error('simulated cache failure');
          writes.push(url);
        },
        match: async () => null,
      }),
      delete: async (name) => { deletions.push(name); return true; },
      keys: async () => [],
      match: async () => null,
    },
    self: {
      location: { origin: 'https://kesefle.com' },
      clients: { claim: async () => {}, matchAll: async () => [] },
      registration: { showNotification: async () => {} },
      skipWaiting: async () => { skipped++; },
      addEventListener: (type, handler) => { listeners[type] = handler; },
    },
  };
  vm.runInNewContext(swSource, context, { filename: 'sw.js' });
  let pending;
  listeners.install({ waitUntil(promise) { pending = promise; } });
  assert.ok(pending && typeof pending.then === 'function', 'install handler supplies a promise');
  let error = null;
  try { await pending; } catch (caught) { error = caught; }
  return { error, writes, deletions, skipped };
}

async function runOfflineFetch({ pathname, destination, mode, staticPaths = [], runtimePaths = [] }) {
  const listeners = {};
  const staticHit = { source: 'current-static' };
  const runtimeHit = { source: 'current-runtime' };
  const context = {
    console,
    URL,
    Response,
    fetch: async () => { throw new Error('offline'); },
    caches: {
      // A global lookup is forbidden because it can see a staging worker's cache.
      match: async () => { throw new Error('global cache lookup used'); },
      keys: async () => [],
      delete: async () => true,
      open: async (name) => ({
        match: async (request) => {
          const value = typeof request === 'string' ? request : new URL(request.url).pathname;
          if (/kesefle-static-v23/.test(name) && staticPaths.includes(value)) return staticHit;
          if (/kesefle-runtime-v23/.test(name) && runtimePaths.includes(value)) return runtimeHit;
          return null;
        },
        put: async () => {},
      }),
    },
    self: {
      location: { origin: 'https://kesefle.com' },
      clients: { claim: async () => {}, matchAll: async () => [] },
      registration: { showNotification: async () => {} },
      skipWaiting: async () => {},
      addEventListener: (type, handler) => { listeners[type] = handler; },
    },
  };
  vm.runInNewContext(swSource, context, { filename: 'sw.js' });
  let pending;
  const request = {
    method: 'GET',
    url: 'https://kesefle.com' + pathname,
    destination,
    mode,
    headers: { get(name) { return name.toLowerCase() === 'accept' && mode === 'navigate' ? 'text/html' : ''; } },
  };
  listeners.fetch({ request, respondWith(promise) { pending = promise; } });
  assert.ok(pending, pathname + ' is handled by the service worker');
  return pending;
}

(async () => {
  const missingRequired = await runInstall({ failedFetch: '/offline.html' });
  assert.ok(missingRequired.error, 'missing required offline shell rejects installation');
  assert.strictEqual(missingRequired.skipped, 0, 'failed required shell never calls skipWaiting');
  assert.ok(missingRequired.deletions.some((name) => /kesefle-static-v23/.test(name)),
    'failed required shell removes the incomplete versioned cache');

  const failedRequiredWrite = await runInstall({ failedPut: '/app.webmanifest' });
  assert.ok(failedRequiredWrite.error, 'failed required cache write rejects installation');
  assert.strictEqual(failedRequiredWrite.skipped, 0, 'failed required cache write never activates');
  assert.ok(failedRequiredWrite.deletions.some((name) => /kesefle-static-v23/.test(name)),
    'failed required cache write cleans up the incomplete cache');

  const badRequiredStatus = await runInstall({ failedStatus: '/offline.html' });
  assert.ok(badRequiredStatus.error, 'non-ok required response rejects installation');
  assert.strictEqual(badRequiredStatus.skipped, 0, 'non-ok required response never activates');

  const disguisedScript = await runInstall({ invalidContentType: '/lib/browser-session.js' });
  assert.ok(disguisedScript.error, 'HTML disguised with a javascript profile is rejected');
  assert.strictEqual(disguisedScript.skipped, 0, 'disguised required script never activates');

  const missingOptional = await runInstall({ failedFetch: '/og-image.png' });
  assert.ifError(missingOptional.error);
  assert.strictEqual(missingOptional.skipped, 1, 'an optional marketing miss still activates the complete app shell');
  for (const required of [
    '/app', '/app.html', '/app.webmanifest', '/lib/browser-session.js',
    '/css/brand.css', '/expense', '/expense.html', '/offline.html',
    '/icon-192.png', '/icon-512.png', '/icon-512-maskable.png',
  ]) {
    assert.ok(missingOptional.writes.includes(required), required + ' is cached before activation');
  }
  assert.ok(!missingOptional.writes.includes('/og-image.png'), 'failed optional asset is not cached');

  const sessionScript = await runOfflineFetch({
    pathname: '/lib/browser-session.js', destination: 'script', mode: 'same-origin',
    staticPaths: ['/lib/browser-session.js'],
  });
  assert.strictEqual(sessionScript.source, 'current-static',
    'offline browser-session.js resolves from the active worker static cache');

  const navigationFallback = await runOfflineFetch({
    pathname: '/uncached-route', destination: 'document', mode: 'navigate',
    staticPaths: ['/offline.html'],
  });
  assert.strictEqual(navigationFallback.source, 'current-static',
    'offline navigation fallback is restricted to the active worker cache');
  console.log('PWA install quality: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
