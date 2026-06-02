// bot/test_isolation_edge_cases.js
//
// EDGE-CASE coverage for multi-tenant isolation. bot/test_isolation.js already
// covers the main routing decision (owner / linked tenant / onboarding) and the
// static owner-gating of command routers. THIS suite drills the isolation
// PRIMITIVES that those decisions rest on, with the adversarial inputs that
// would silently break tenant separation if the normalization ever regressed:
//
//   * _ownerPhoneDigits_  — owner identity is the SHEET_OWNER_PHONE property
//     reduced to digits, falling back to the hardcoded OWNER_PHONE. Must be
//     format-agnostic AND must fall back (never return '') so an unset/garbage
//     property can't make "" the owner key.
//   * _isOwnerPhone_      — TRUE iff the inbound digits EQUAL the owner digits.
//     Equality, not substring: a tenant whose number merely CONTAINS the owner
//     digits, or shares a suffix, must NOT be treated as the owner. An empty /
//     null / non-numeric sender must NEVER be the owner (the original leak).
//   * _assertOwnerLegacyWrite_ — the belt-and-suspenders guard on the legacy
//     SHEET_ID writes: allow owner + internal(null), BLOCK any foreign sender,
//     and raise exactly one admin alert when it blocks.
//   * _resolveTenant_     — end-to-end: format-variant owner still resolves to
//     the owner path; a one-digit-off linked tenant gets THEIR OWN sheet; an
//     unlinked / partially-linked record falls to onboarding (no write).
//   * cross-runtime identity — the bot's digit-strip and the Vercel API's
//     normalizeE164 (api/sheet/append.js) must agree on the owner's canonical
//     E.164, so the same human resolves to the same tenant in both runtimes.
//
// House pattern: balanced-brace extraction of the REAL source + a minimal mock
// of the Apps Script globals (PropertiesService / Logger / KV / alerts). No
// mocking framework, no network/secrets. Hebrew alert text is irrelevant here
// (we only assert an alert FIRED), so the file stays ASCII.
//   Run: node bot/test_isolation_edge_cases.js

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const botSrc = fs.readFileSync(path.join(ROOT, 'bot/ExpenseBot_FIXED.gs'), 'utf8');
const appendSrc = fs.readFileSync(path.join(ROOT, 'api/sheet/append.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('fn not found: ' + name);
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}

// ── Mock the Apps Script + bot environment (mirrors bot/test_isolation.js) ──
let PROPS = {};
globalThis.PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (k in PROPS ? PROPS[k] : null) }) };
globalThis.OWNER_PHONE = '972547760643';
let KV = {};
globalThis._kvLookupPhone_ = (clean) => KV[clean] || null;
globalThis.Logger = { log: () => {} };
globalThis.alerts = [];
globalThis._adminAlertOnce_ = (msg, p) => { globalThis.alerts.push({ msg, p }); };

// ── load the REAL isolation primitives from the bot ──
(0, eval)(extractFn(botSrc, '_ownerPhoneDigits_'));
(0, eval)(extractFn(botSrc, '_isOwnerPhone_'));
(0, eval)(extractFn(botSrc, '_assertOwnerLegacyWrite_'));
(0, eval)(extractFn(botSrc, '_resolveTenant_'));
// ── load the API-side normalizer (separate runtime, must stay consistent) ──
// Eval the real function as a declaration, then capture the reference. (A bare
// `(0, eval)('function f(){}')` does not leak into this module scope, so we
// return it explicitly.)
const normalizeE164 = (0, eval)('(' + extractFn(appendSrc, 'normalizeE164').replace(/^function normalizeE164/, 'function') + ')');

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; fails.push(label); console.log('  ❌ ' + label); }
}
function eq(label, got, want) { ok(label + ' (got ' + JSON.stringify(got) + ')', got === want); }

const OWNER_DIGITS = '972547760643';   // Steven, 054-776-0643

// Helper: mirror processExpense's router decision into a single label
// (same as bot/test_isolation.js routeFor, kept local so the two suites stay
// independent).
function routeFor(phone) {
  const t = globalThis._resolveTenant_(phone);
  if (!t) return 'INTERNAL_NULL';
  if (!t.isOwner && t.userRecord) return 'TENANT_SHEET:' + t.userRecord.userSub;
  if (t.isOwner === false && !t.userRecord) return 'ONBOARDING_NO_WRITE';
  return globalThis._isOwnerPhone_(phone) ? 'OWNER_SHEET' : 'BLOCKED';
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 1. _ownerPhoneDigits_ : identity normalization + safe fallback ==');
PROPS = { SHEET_OWNER_PHONE: '+972 54-776-0643' };
eq('formatted property reduces to bare digits', _ownerPhoneDigits_(), OWNER_DIGITS);
PROPS = { SHEET_OWNER_PHONE: '972547760643' };
eq('already-bare property is unchanged', _ownerPhoneDigits_(), OWNER_DIGITS);
PROPS = {};
eq('UNSET property falls back to OWNER_PHONE constant', _ownerPhoneDigits_(), OWNER_PHONE);
PROPS = { SHEET_OWNER_PHONE: '' };
eq('EMPTY property falls back to OWNER_PHONE (never returns "")', _ownerPhoneDigits_(), OWNER_PHONE);
PROPS = { SHEET_OWNER_PHONE: 'not-a-phone' };
eq('non-numeric property (no digits) falls back to OWNER_PHONE', _ownerPhoneDigits_(), OWNER_PHONE);
ok('owner digits are never the empty string under any property value',
   ['', null, 'abc', '+972 54-776-0643', undefined].every(function (v) {
     PROPS = (v === undefined) ? {} : { SHEET_OWNER_PHONE: v };
     return _ownerPhoneDigits_() !== '';
   }));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 2. _isOwnerPhone_ : exact-equality, format-agnostic, leak-proof ==');
PROPS = { SHEET_OWNER_PHONE: OWNER_DIGITS };
ok('owner in bare E.164 matches', _isOwnerPhone_(OWNER_DIGITS) === true);
ok('owner with "+" and spaces matches (format-agnostic)', _isOwnerPhone_('+972 54 776 0643') === true);
ok('owner with dashes matches', _isOwnerPhone_('972-54-776-0643') === true);
ok('owner wrapped in whatsapp jid noise matches (digits only count)', _isOwnerPhone_('whatsapp:+972547760643@c.us') === true);
// The leak conditions: a non-owner must NOT be the owner.
ok('a different tenant number is NOT the owner', _isOwnerPhone_('972506347736') === false);
ok('owner digits as a STRICT SUBSTRING of a longer number is NOT the owner',
   _isOwnerPhone_('1' + OWNER_DIGITS + '1') === false);   // equality, not indexOf
ok('a number sharing the owner SUFFIX is NOT the owner',
   _isOwnerPhone_('999547760643') === false);
ok('empty sender is NEVER the owner', _isOwnerPhone_('') === false);
ok('null sender is NEVER the owner', _isOwnerPhone_(null) === false);
ok('undefined sender is NEVER the owner', _isOwnerPhone_(undefined) === false);
ok('a non-numeric sender is NEVER the owner', _isOwnerPhone_('hello') === false);
// CRITICAL regression guard: even with the property UNSET, an empty/garbage
// sender must NOT match the OWNER_PHONE fallback (it has digits; "" does not).
PROPS = {};
ok('property unset + empty sender -> still NOT owner (original leak stays closed)', _isOwnerPhone_('') === false);
ok('property unset + the real owner -> IS owner (fallback identity works)', _isOwnerPhone_(OWNER_DIGITS) === true);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 3. _assertOwnerLegacyWrite_ : block foreign, allow internal, alert once ==');
PROPS = {};
globalThis.alerts = [];
ok('owner write is allowed', _assertOwnerLegacyWrite_(OWNER_DIGITS, 'test') === true);
ok('null sender (internal/cron) is allowed', _assertOwnerLegacyWrite_(null, 'cron') === true);
ok('empty sender (internal) is allowed', _assertOwnerLegacyWrite_('', 'cron') === true);
ok('no alert fired for allowed writes so far', globalThis.alerts.length === 0);
ok('a FOREIGN sender write is BLOCKED', _assertOwnerLegacyWrite_('972506347736', 'receipt') === false);
ok('blocking a foreign write raised exactly one admin alert', globalThis.alerts.length === 1);
ok('the alert payload carries the offending (cleaned) phone', globalThis.alerts[0].p === '972506347736');
// A foreign sender in a messy format is still blocked (normalized first).
ok('foreign sender with "+"/spaces is also blocked', _assertOwnerLegacyWrite_('+972 50 634 7736', 'x') === false);

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 4. _resolveTenant_ : owner variants, near-miss tenant, partial links ==');
PROPS = { SHEET_OWNER_PHONE: OWNER_DIGITS };
KV = {};
// Owner in several formats all land on the owner path.
['972547760643', '+972-54-776-0643', '972 54 776 0643'].forEach(function (v) {
  ok('owner format "' + v + '" -> OWNER_SHEET', routeFor(v) === 'OWNER_SHEET');
});
// A linked tenant whose number is ONE DIGIT off the owner must get THEIR OWN
// sheet, never the owner's (proves it is not a fuzzy / prefix match).
const NEAR = '972547760644';   // owner is ...643, this tenant is ...644
KV[NEAR] = { linked: true, userSub: 'sub_near', spreadsheetId: 'SHEET_NEAR' };
eq('one-digit-off linked tenant routes to THEIR sheet (not the owner)', routeFor(NEAR), 'TENANT_SHEET:sub_near');
// A KV record that is present but NOT fully linked must fall to onboarding
// (no write) — never silently inherit the owner or a stale sheet.
KV['972500000001'] = { linked: false, userSub: 'sub_unconfirmed', spreadsheetId: 'SHEET_X' };
eq('present-but-unlinked record -> onboarding (no write)', routeFor('972500000001'), 'ONBOARDING_NO_WRITE');
KV['972500000002'] = { linked: true, spreadsheetId: 'SHEET_Y' };   // linked but NO userSub
eq('linked record missing userSub -> onboarding (no write, no token to resolve)', routeFor('972500000002'), 'ONBOARDING_NO_WRITE');
// A completely unknown number -> onboarding.
eq('unknown number -> onboarding (no write)', routeFor('972999999999'), 'ONBOARDING_NO_WRITE');
// Null / empty inbound -> the internal-null branch (no resolution, no write).
eq('null inbound -> INTERNAL_NULL (no tenant resolved)', routeFor(null), 'INTERNAL_NULL');
eq('empty inbound -> INTERNAL_NULL', routeFor(''), 'INTERNAL_NULL');
// Cross-tenant non-leak: two DIFFERENT linked phones never collide on a sheet.
KV['972501111111'] = { linked: true, userSub: 'sub_alice', spreadsheetId: 'SHEET_ALICE' };
KV['972502222222'] = { linked: true, userSub: 'sub_bob',   spreadsheetId: 'SHEET_BOB' };
ok('two distinct tenants resolve to two distinct sheets (no cross-leak)',
   routeFor('972501111111') === 'TENANT_SHEET:sub_alice' &&
   routeFor('972502222222') === 'TENANT_SHEET:sub_bob' &&
   routeFor('972501111111') !== routeFor('972502222222'));

// ════════════════════════════════════════════════════════════════════════════
console.log('\n== 5. Cross-runtime identity: bot digit-strip vs API normalizeE164 ==');
// Both runtimes must reduce the SAME human to the SAME canonical E.164, or a
// phone linked via the API would not match the owner/tenant in the bot.
function botDigits(s) { return String(s || '').replace(/[^0-9]/g, ''); }
['+972 54-776-0643', '0547760643', '972547760643'].forEach(function (v) {
  const apiVal = normalizeE164(v);
  ok('API normalizeE164("' + v + '") yields the owner E.164', apiVal === OWNER_DIGITS);
});
// The bot strips to digits; for an already-E.164 (or "+"-prefixed) value the two
// agree. (The API additionally maps a leading 0 -> 972; the bot relies on the
// inbound WhatsApp number already being E.164, so we assert agreement on the
// E.164 / +E.164 forms the bot actually receives.)
['+972547760643', '972547760643'].forEach(function (v) {
  ok('bot digit-strip == API normalizeE164 for "' + v + '"', botDigits(v) === normalizeE164(v));
});
// Garbage in -> API returns null (no accidental tenant); bot returns '' (which
// _isOwnerPhone_ already rejects). Neither yields a usable owner identity.
ok('API normalizeE164 rejects non-numeric junk (null)', normalizeE164('abc') === null);
ok('API normalizeE164 rejects too-short digits (null)', normalizeE164('12345') === null);
ok('bot digit-strip of junk is "" (rejected by _isOwnerPhone_)', botDigits('abc') === '' && _isOwnerPhone_(botDigits('abc')) === false);

console.log('\n' + (fail === 0
  ? '✅ tenant isolation edge cases: ALL ' + pass + ' CHECKS PASSED'
  : '❌ ' + fail + ' FAILED (' + fails.join('; ') + '), ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
