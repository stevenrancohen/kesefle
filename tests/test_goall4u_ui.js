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
assert.match(app, /class="quick-rail"/, 'home exposes a horizontal mobile quick-action rail');
assert.match(app, /function quickActions\(\)/, 'quick actions adapt to the active money space');
assert.match(app, /href:'\/dashboard#\/budgets'/, 'budget shortcut points to the existing dashboard route');
assert.match(app, /grid-cols-5/, 'bottom navigation includes a dedicated centre add action');
assert.match(app, /id="expenseFab" href="\/expense\?from=app"/, 'direct add remains always available without covering content');
assert.match(app, /function lineIcon\(name\)/, 'navigation uses a consistent line-icon system');
assert.match(app, /aria-pressed/, 'space switcher exposes selected state to assistive technology');

assert.match(expense, /class="form-card/);
assert.match(expense, /kfl_app_theme'\) !== 'light'/);
assert.match(expense, /bg-emerald-500/, 'income state keeps positive financial semantics');
assert.match(expense, /data-amount="20"[\s\S]*data-amount="200"/, 'quick amount presets reduce mobile typing');
assert.match(expense, /data-category="אוכל לבית"[\s\S]*data-category="שיווק ופרסום"/, 'common personal and business categories are one tap away');
assert.match(expense, /params\.get\('type'\) === 'income'/, 'home income shortcut opens the correct entry state');
assert.match(expense, /incomeItems[\s\S]*\['משכורת','💳 משכורת'\][\s\S]*\['הכנסה מעסק','💼 לקוח'\]/, 'income entry shows income-specific quick categories');
assert.match(expense, /role="status" aria-live="polite"/, 'save feedback is announced accessibly');

for (const file of installPages) {
  const html = read(file);
  assert.doesNotMatch(html, /kesefle\.vercel\.app/, `${file} must not send users to the obsolete host`);
  assert.match(html, /kesefle\.com\/app/, `${file} must point to the installable app`);
}
assert.match(read('install.html'), /רענון נתונים והוספת תנועה דורשים חיבור לאינטרנט/);
assert.match(read('sw.js'), /v18-2026-11-14-mobile-ux/);

console.log('GOALL4U-inspired UI system: PASS');
