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

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
