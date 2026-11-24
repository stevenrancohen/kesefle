#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const app = read('app.html');
const expense = read('expense.html');
const sw = read('sw.js');
const css = read('css/app-tailwind.css');
const config = read('tailwind.app.config.cjs');
const packageJson = JSON.parse(read('package.json'));
const digest = crypto.createHash('sha256').update(css).digest('hex');
const versionedCssPath = '/css/app-tailwind.css?v=' + digest.slice(0, 12);

assert.ok(app.includes('<link rel="stylesheet" href="' + versionedCssPath + '" />'),
  'the canonical app loads the content-versioned local stylesheet');
assert.doesNotMatch(app, /cdn\.tailwindcss\.com|tailwind\.config\s*=/,
  'the canonical app has no runtime Tailwind compiler dependency');
assert.ok(expense.includes('<link rel="stylesheet" href="' + versionedCssPath + '" />'),
  'the required quick-entry route loads the same content-versioned stylesheet');
assert.doesNotMatch(expense, /cdn\.tailwindcss\.com|tailwind\.config\s*=/,
  'quick entry has no runtime Tailwind compiler dependency');

assert.ok(sw.includes("'" + versionedCssPath + "'"),
  'the installed PWA requires the compiled stylesheet before activation');
assert.ok(sw.includes("['" + versionedCssPath + "', ['text/css']]"),
  'the service worker rejects an HTML/error response masquerading as app CSS');

assert.ok(Buffer.byteLength(css) > 10_000, 'compiled CSS is non-empty and includes the app utility set');
assert.ok(Buffer.byteLength(css) < 80_000, 'compiled CSS stays small enough for mobile first load');
for (const selector of [
  '.bg-brand-300', '.text-ink-950', '.min-h-\\[48px\\]', '.dark\\:border-ink-700',
  '.grid-cols-4', '.rounded-3xl', '.bg-red-500', '.max-w-md',
]) {
  assert.ok(css.includes(selector), 'compiled CSS contains ' + selector);
}

assert.strictEqual(packageJson.devDependencies.tailwindcss, '3.4.17',
  'the compiler is pinned for deterministic rebuilds');
assert.match(packageJson.scripts['build:app-css'], /tailwindcss[\s\S]*tailwind\.app\.config\.cjs[\s\S]*app-tailwind\.css/,
  'the local CSS has a documented one-command rebuild');
assert.match(config, /content:\s*\[['"]\.\/app\.html['"],\s*['"]\.\/expense\.html['"]\]/,
  'the build scans both required installed PWA surfaces');

assert.match(sw, new RegExp('static-app-css-' + digest.slice(0, 12)),
  'the service-worker cache version is content-bound to the compiled CSS');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kesefle-app-css-'));
const rebuiltPath = path.join(tempDir, 'app-tailwind.css');
const tailwindBin = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tailwindcss.cmd' : 'tailwindcss'
);
assert.ok(fs.existsSync(tailwindBin), 'run npm ci before tests so the pinned compiler is available');
try {
  childProcess.execFileSync(tailwindBin, [
    '-c', 'tailwind.app.config.cjs',
    '-i', 'css/app-tailwind.input.css',
    '-o', rebuiltPath,
    '--minify',
  ], {
    cwd: ROOT,
    env: { ...process.env, BROWSERSLIST_IGNORE_OLD_DATA: 'true' },
    stdio: 'pipe',
  });
  assert.deepStrictEqual(fs.readFileSync(rebuiltPath), fs.readFileSync(path.join(ROOT, 'css/app-tailwind.css')),
    'committed app CSS must match a fresh pinned build byte-for-byte');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('App static Tailwind CSS: PASS (' + Buffer.byteLength(css) + ' bytes, sha256 ' + digest.slice(0, 12) + ')');
