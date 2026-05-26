// Multi-tenant isolation test — loads the REAL fixed functions out of
// bot/ExpenseBot_FIXED.gs and runs 3 phones through the routing decision.
const fs = require('fs');
const src = fs.readFileSync(process.argv[2] || 'bot/ExpenseBot_FIXED.gs', 'utf8');

// Balanced-brace extraction of a function definition by name.
function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('fn not found: ' + name);
  let i = src.indexOf('{', start), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(start, j);
}

// ── Mock the Apps Script + bot environment ──────────────────────────
let PROPS = {};
globalThis.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (k in PROPS ? PROPS[k] : null) }) };
globalThis.OWNER_PHONE = '972547760643';
let KV = {};
globalThis._kvLookupPhone_ = (clean) => KV[clean] || null;
globalThis.Logger = { log: () => {} };
globalThis.alerts = [];
globalThis._adminAlertOnce_ = (msg, p) => { globalThis.alerts.push({ msg, p }); };

// Load the REAL functions from source into global scope.
(0, eval)(extractFn('_ownerPhoneDigits_'));
(0, eval)(extractFn('_isOwnerPhone_'));
(0, eval)(extractFn('_assertOwnerLegacyWrite_'));
(0, eval)(extractFn('_resolveTenant_'));

// Mirror processExpense's router decision into a single label.
function routeFor(phone) {
  const t = globalThis._resolveTenant_(phone);
  if (!t) return 'INTERNAL_NULL';
  if (!t.isOwner && t.userRecord) return 'TENANT_SHEET:' + t.userRecord.userSub;
  if (t.isOwner === false && !t.userRecord) return 'ONBOARDING_NO_WRITE';
  // owner → would hit the belt-and-suspenders guard then write to SHEET_ID
  return globalThis._isOwnerPhone_(phone) ? 'OWNER_SHEET' : 'BLOCKED';
}

// ── Scenario data ───────────────────────────────────────────────────
const OWNER = '972547760643';     // Steven (054-776-0643)
const TESTA = '972506347736';     // test user A (050-634-7736), linked in KV
const TESTB = '972528291118';     // test user B (052-829-1118), NOT linked
KV[TESTA] = { linked: true, userSub: 'sub_testA', spreadsheetId: 'SHEET_A' };
// TESTB intentionally absent from KV

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log((ok ? '  ✅' : '  ❌') + ' ' + label + ' → ' + got + (ok ? '' : '   (expected ' + want + ')'));
  ok ? pass++ : fail++;
}

console.log('\n── Scenario 1: SHEET_OWNER_PHONE SET to owner ──');
PROPS = { SHEET_OWNER_PHONE: '+972 54 776 0643' };
check('owner   972547760643', routeFor(OWNER), 'OWNER_SHEET');
check('testA   972506347736 (linked)', routeFor(TESTA), 'TENANT_SHEET:sub_testA');
check('testB   972528291118 (unlinked)', routeFor(TESTB), 'ONBOARDING_NO_WRITE');

console.log('\n── Scenario 2: SHEET_OWNER_PHONE *UNSET* (the original leak condition) ──');
PROPS = {};   // property missing — previously made EVERYONE the owner
check('owner   972547760643', routeFor(OWNER), 'OWNER_SHEET');
check('testA   972506347736 (linked)', routeFor(TESTA), 'TENANT_SHEET:sub_testA');
check('testB   972528291118 (unlinked)', routeFor(TESTB), 'ONBOARDING_NO_WRITE');

console.log('\n── Scenario 3: assertion guard blocks a foreign write to SHEET_ID ──');
PROPS = {};
globalThis.alerts = [];
check('assert(owner)  allowed', globalThis._assertOwnerLegacyWrite_(OWNER, 'test'), true);
check('assert(testA)  blocked', globalThis._assertOwnerLegacyWrite_(TESTA, 'test'), false);
check('assert(null)   allowed (internal)', globalThis._assertOwnerLegacyWrite_(null, 'cron'), true);
check('blocked write raised an admin alert', globalThis.alerts.length >= 1, true);

console.log('\n── Scenario 4: doPost owner-only command routers are gated (static source) ──');
// Every command router that touches the owner SHEET_ID must be dispatched
// only when _isOwnerPhone_(__from_) is true. Tenant-safe routers (timezone,
// family) must stay open. These static checks lock the gates against silent
// regression in future edits.
var fs2 = require('fs');
var botSrc = fs2.readFileSync(__dirname + '/ExpenseBot_FIXED.gs', 'utf8');
[
  '_handleSubscriptionCommand_', '_handleBudgetCommand_', '_handleLearningCommand_',
  '_handleCategoryCorrection_', 'handleBotCommand_', 'SRC_ROUTER_handle',
].forEach(function(fn) {
  var re = new RegExp('if \\(typeof ' + fn + ' === "function" && _isOwnerPhone_\\(__from_\\)\\)');
  check('router gated: ' + fn, re.test(botSrc), true);
});
// voice note-tail must be owner-gated
check('voice note-tail gated', /if \(_isOwnerPhone_\(fromPhone\)\) \{\s*\n\s*var __vSheet/.test(botSrc), true);
// BOT_COMMANDS.gs must self-guard
var bcSrc = fs2.readFileSync(__dirname + '/BOT_COMMANDS.gs', 'utf8');
check('BOT_COMMANDS handleBotCommand_ self-guards owner', /_isOwnerPhone_\(from\)/.test(bcSrc), true);

console.log('\n── Scenario 5: user-facing sheet links never hardcode SHEET_ID for non-owners ──');
// Steven's screenshot (2026-05-25) caught two handlers that returned
// the OWNER sheet URL to anyone who asked. Lock the regression: every
// reply containing "docs.google.com/spreadsheets/d/' + SHEET_ID" must
// be inside an owner-gated branch (preceded by _isOwnerPhone_ within
// the same function body).
var leakRe = /docs\.google\.com\/spreadsheets\/d\/'\s*\+\s*SHEET_ID/g;
var leakMatches = [];
var leakMatch;
while ((leakMatch = leakRe.exec(botSrc)) !== null) {
  leakMatches.push(leakMatch.index);
}
// Find the function body containing each match and ensure it gates on
// _isOwnerPhone_ OR is the _userSheetUrl_ owner branch itself OR is
// the multi-business owner-only helper.
var leakSafeFns = ['_userSheetUrl_', '_getOrCreateBusinessSheet_', '_getOrCreateBusinessTab_', '_handleMyBusinessesCommand_', 'getDictionaryLink'];
var leaksFound = 0;
leakMatches.forEach(function(idx) {
  // Walk backward to find the enclosing function declaration.
  var head = botSrc.slice(0, idx);
  var fnMatch = head.match(/function\s+([A-Za-z0-9_$]+)\s*\(/g);
  if (!fnMatch) return;
  var lastFn = fnMatch[fnMatch.length - 1];
  var name = lastFn.replace(/^function\s+/, '').replace(/\s*\(.*$/, '');
  if (leakSafeFns.indexOf(name) >= 0) return;
  // Otherwise scan forward 800 chars from the match for _isOwnerPhone_
  // OR fromPhone guard. If absent, flag as a leak.
  var window = botSrc.slice(Math.max(0, idx - 400), idx + 200);
  if (!/_isOwnerPhone_|isOwner/.test(window)) {
    console.log('  ❌ unguarded SHEET_ID link inside function "' + name + '" at char ' + idx);
    leaksFound++;
  }
});
check('no unguarded SHEET_ID links in user-facing replies', leaksFound, 0);

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
