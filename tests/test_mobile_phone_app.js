#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

const app = read('app.html');
const account = read('account.html');
const link = read('api/whatsapp/link.js');
const appManifest = read('app.webmanifest');
const mainManifest = read('manifest.webmanifest');
const sw = read('sw.js');
let failed = 0;

function assert(condition, label) {
  if (condition) console.log('✅ ' + label);
  else { failed++; console.error('❌ ' + label); }
}

const mobileSurfaces = app + appManifest + mainManifest;
assert(!mobileSurfaces.includes('972547766361'), 'stale/pending WhatsApp number removed from mobile surfaces');
assert(/api\/config/.test(app) && /BOT_NUMBER/.test(app), 'app reads the canonical bot number from /api/config');
assert(/href="\/expense\?from=app"/.test(app), 'app has an always-available direct expense entry');
assert(/\/expense\?from=pwa-shortcut/.test(appManifest) && /\/expense\?from=pwa-shortcut/.test(mainManifest), 'PWA shortcuts work without WhatsApp');

assert(/userPhone:\$\{userSub\}/.test(link), 'phone status reads the canonical reverse userPhone index');
assert(/phone:\$\{candidate\}/.test(link) && /forward\.userSub !== userSub/.test(link), 'phone status verifies the forward mapping belongs to the same user');
assert(/req\.query\.check === '1'/.test(link) && /getVerifiedPhoneForUser\(sessSub\)/.test(link), 'session status uses two-way verification');
assert(/linked: !!sessSub && rec\.userSub === sessSub/.test(link), 'browser polling cannot succeed for another customer phone');

assert(/9720/.test(account) && /s\.slice\(4\)/.test(account), 'frontend normalizes +972 followed by a trunk zero');
assert(/whatsapp\/link\?check=1/.test(account), 'account UI polls authenticated session status');
assert(/loadKesefleBotConfig/.test(account) && /api\/config/.test(account), 'account deep links follow runtime bot configuration');
assert(!/cache\.put\(request, resp\.clone\(\)\)/.test(sw.slice(sw.indexOf("if (url.origin === self.location.origin && isApi(url))"), sw.indexOf('// Same-origin navigation requests'))), 'service worker does not cache personalized API responses');

if (failed) process.exit(1);
console.log('All mobile/phone integration assertions passed.');
