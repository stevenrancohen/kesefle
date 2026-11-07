#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.html');
const expense = read('expense.html');
const installPages = ['install.html', 'fr/install.html', 'it/install.html', 'ar/install.html', 'ru/install.html'];

assert.match(app, /name="theme-color" content="#090a0d"/);
assert.match(app, /class="promo-strip/);
assert.match(app, /class="spectrum"/);
assert.match(app, /#ff4a43[\s\S]*#3f6ff5[\s\S]*#fddd48[\s\S]*#4fd88a/);
assert.match(app, /localStorage\.getItem\('kfl_app_theme'\) \|\| 'dark'/);
assert.match(app, /text-5xl[\s\S]*sm:text-7xl/);
assert.match(app, /min-height:44px/);

assert.match(expense, /class="form-card/);
assert.match(expense, /kfl_app_theme'\) !== 'light'/);
assert.match(expense, /bg-emerald-500/, 'income state keeps positive financial semantics');

for (const file of installPages) {
  const html = read(file);
  assert.doesNotMatch(html, /kesefle\.vercel\.app/, `${file} must not send users to the obsolete host`);
  assert.match(html, /kesefle\.com\/app/, `${file} must point to the installable app`);
}
assert.match(read('install.html'), /רענון נתונים והוספת תנועה דורשים חיבור לאינטרנט/);
assert.match(read('sw.js'), /v17-2026-11-07-goall4u-ui/);

console.log('GOALL4U-inspired UI system: PASS');
