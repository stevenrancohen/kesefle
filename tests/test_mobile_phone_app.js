#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

const app = read('app.html');
const account = read('account.html');
const link = read('api/whatsapp/link.js');
const appManifest = read('app.webmanifest');
const mainManifest = read('manifest.webmanifest');
const sw = read('sw.js');
const welcome = read('welcome.html');
const expense = read('expense.html');
let failed = 0;

function assert(condition, label) {
  if (condition) console.log('✅ ' + label);
  else { failed++; console.error('❌ ' + label); }
}

function extractFn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unterminated function: ' + name);
}

const mobileSurfaces = app + appManifest + mainManifest;
assert(!mobileSurfaces.includes('972547766361'), 'stale/pending WhatsApp number removed from mobile surfaces');
assert(/api\/config/.test(app) && /BOT_NUMBER/.test(app), 'app reads the canonical bot number from /api/config');
assert(/href="\/expense\?from=app"/.test(app), 'app has an always-available direct expense entry');
assert(/\/expense\?from=pwa-shortcut/.test(appManifest) && /\/expense\?from=pwa-shortcut/.test(mainManifest), 'PWA shortcuts work without WhatsApp');
assert(/payload\.error==='offline'/.test(app) && /e&&e\.isOffline/.test(app), 'app recognizes the service worker offline response');
assert(/אין חיבור לאינטרנט/.test(app) && /נתונים פיננסיים לא נשמרים במטמון/.test(app), 'app shows a truthful privacy-safe offline state');
assert(/kflLinkFirstExpense[\s\S]*onFirstClick\(\)/.test(welcome), 'real first-message CTA triggers the install milestone');
assert(/beforeinstallprompt[\s\S]*kfl_first_msg_clicked[\s\S]*maybeShowPwaInstall/.test(welcome), 'late install events re-check the completed milestone');
assert(/id="pwa-ios-install-link" href="\/install"/.test(welcome), 'iOS gets a manual install-guide fallback');
assert(/__kflExpenseDirty/.test(expense) && /__kflExpenseUpdatePending/.test(expense), 'service-worker updates defer reload while the expense form is dirty');
assert(/יתרענן אחרי שמירת התנועה/.test(expense), 'dirty-form update deferral is explained to the user');

let pendingTimer = null;
let pendingDelay = null;
let reloads = 0;
const pendingContext = {
  window: { __kflExpenseUpdatePending: true, __kflExpenseDirty: false },
  location: { reload: () => { reloads++; } },
  setTimeout: (fn, delay) => { pendingTimer = fn; pendingDelay = delay; },
};
vm.createContext(pendingContext);
vm.runInContext(extractFn(expense, 'kflApplyPendingUpdateAfterSave'), pendingContext);
pendingContext.kflApplyPendingUpdateAfterSave();
assert(pendingDelay === 700 && typeof pendingTimer === 'function', 'saved form schedules the pending update once');
pendingContext.window.__kflExpenseDirty = true;
pendingTimer();
assert(reloads === 0, 'typing a new movement during the update grace period prevents data-loss reload');
pendingContext.window.__kflExpenseDirty = false;
pendingContext.kflApplyPendingUpdateAfterSave();
pendingTimer();
assert(reloads === 1, 'pending update reloads only when the form is still clean');

assert(/userPhone:\$\{userSub\}/.test(link), 'phone status reads the canonical reverse userPhone index');
assert(/phone:\$\{candidate\}/.test(link) && /forward\.userSub !== userSub/.test(link), 'phone status verifies the forward mapping belongs to the same user');
assert(/req\.query\.check === '1'/.test(link) && /getVerifiedPhoneForUser\(sessSub\)/.test(link), 'session status uses two-way verification');
assert(/!sessSub \|\| rec\.userSub !== sessSub/.test(link)
  && /normalizeE164\(reverse\?\.phone\) === phone/.test(link),
  'browser polling requires the same session and matching reverse mapping');

assert(/9720/.test(account) && /s\.slice\(4\)/.test(account), 'frontend normalizes +972 followed by a trunk zero');
assert(/whatsapp\/link\?check=1/.test(account), 'account UI polls authenticated session status');
assert(/loadKesefleBotConfig/.test(account) && /api\/config/.test(account), 'account deep links follow runtime bot configuration');
assert(/_kflPostLinkCodeRequest\(phone\)/.test(account), 'account requests a phone-link code with the secure session');
assert(!/_kflGetFreshAccessToken/.test(account) && /body:\s*JSON\.stringify\(\{ phone: phone \}\)/.test(account), 'phone linking stays session-only and sends no Google token');
assert(/isSameOriginRequest\(req\)/.test(link) && /origin_not_allowed/.test(link), 'session-authenticated link mutation is same-origin protected');
assert(/process\.env\.WABA_APPROVED !== '1'/.test(link) && /whatsapp_linking_unavailable/.test(link), 'phone-link mint fails closed while WhatsApp rollout is frozen');
assert(/sheet_not_ready/.test(link) && /ownedSheetId/.test(link), 'link-code mint requires canonical server-side sheet ownership');
assert(!/cache\.put\(request, resp\.clone\(\)\)/.test(sw.slice(sw.indexOf("if (url.origin === self.location.origin && isApi(url))"), sw.indexOf('// Same-origin navigation requests'))), 'service worker does not cache personalized API responses');

if (failed) process.exit(1);
console.log('All mobile/phone integration assertions passed.');
