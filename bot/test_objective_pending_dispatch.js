#!/usr/bin/env node
// Behavioral test for the 2026-06-01 objective pending-state FIX (ITEM 1).
//
// THE BUG: after the bot shows the "יעד חדש" 1/2/3/4 prompt it used to set NO
// pending state. The user's bare reply "1" then hit the doPost expense
// FAST-PATH (any text starting with a digit) and was written as a 1-shekel
// expense. The fix stamps a short-lived pending-objective state and routes an
// END-ANCHORED 1-4 reply (+ the follow-up goal text) to objective-creation.
//
// This test loads the REAL helpers from bot/ExpenseBot_FIXED.gs and exercises
// _handleObjectivePendingReply_ against a mocked CacheService / PropertiesService
// / UrlFetchApp — so it verifies actual routing behavior, not just source text.
//
//   Run: node bot/test_objective_pending_dispatch.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

// Balanced-brace extractor for `function NAME(...) { ... }` (same approach as
// bot/test_classify.js).
function fn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}

// ── Mocked Apps Script globals ──────────────────────────────────────────────
const _cache = {};
let _lastFetch = null;
let _fetchResponse = { code: 200, body: JSON.stringify({ ok: true, objective: { horizon: 'month', description: 'לחסוך 1000 לטיול ביוני' } }) };
globalThis.CacheService = {
  getScriptCache() {
    return {
      get(k) { return Object.prototype.hasOwnProperty.call(_cache, k) ? _cache[k] : null; },
      put(k, v) { _cache[k] = String(v); },
      remove(k) { delete _cache[k]; },
    };
  },
};
globalThis.PropertiesService = {
  getScriptProperties() {
    return { getProperty(k) { return k === 'KESEFLE_BOT_SECRET' ? 'test-secret' : null; } };
  },
};
globalThis.UrlFetchApp = {
  fetch(url, opts) {
    _lastFetch = { url, opts, payload: JSON.parse((opts && opts.payload) || '{}') };
    return {
      getResponseCode() { return _fetchResponse.code; },
      getContentText() { return _fetchResponse.body; },
    };
  },
};
globalThis.KESEFLE_API_BASE = 'https://example.test';

// ── Load the real helpers ───────────────────────────────────────────────────
// Indirect eval runs in global scope; assign each function to globalThis so we
// can call it by name below. (Function declarations via direct eval would be
// block-scoped to this module; the explicit assignment is unambiguous.)
const _eval = eval;
// _objPendSet_ references the module-level TTL constant; define it globally
// (read from source so the test tracks the real value).
const _ttl = (src.match(/var _OBJ_PEND_TTL_SEC_\s*=\s*(\d+)/) || [])[1] || '900';
_eval('globalThis._OBJ_PEND_TTL_SEC_ = ' + _ttl + ';');
_eval(fn('_objPendKey_') + '\nglobalThis._objPendKey_ = _objPendKey_;');
_eval(fn('_objPendGet_') + '\nglobalThis._objPendGet_ = _objPendGet_;');
_eval(fn('_objPendSet_') + '\nglobalThis._objPendSet_ = _objPendSet_;');
_eval(fn('_objPendClear_') + '\nglobalThis._objPendClear_ = _objPendClear_;');
_eval(fn('_handleObjectivePendingReply_') + '\nglobalThis._handleObjectivePendingReply_ = _handleObjectivePendingReply_;');
const _objPendSet_ = globalThis._objPendSet_;
const _objPendGet_ = globalThis._objPendGet_;
const _objPendClear_ = globalThis._objPendClear_;
const _handleObjectivePendingReply_ = globalThis._handleObjectivePendingReply_;

const PHONE = '972500000001';
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}
function reset() { for (const k of Object.keys(_cache)) delete _cache[k]; _lastFetch = null; }

console.log('\nbot/test_objective_pending_dispatch.js\n');

// ── 1) No pending state → never consumes the message ────────────────────────
reset();
let r = _handleObjectivePendingReply_(PHONE, '1');
assert(r && r.handled === false, 'no pending state: "1" is NOT consumed (would book expense)');

// ── 2) THE BUG FIX: prompt shown ("horizon"), reply "1" → picks horizon,
//        asks for goal text, NEVER books an expense ──────────────────────────
reset();
_objPendSet_(PHONE, 'horizon');
r = _handleObjectivePendingReply_(PHONE, '1');
assert(r && r.handled === true, 'state=horizon, reply "1": handled=true (NOT routed to expense)');
assert(r && /יעד|מה היעד/.test(r.replyText || ''), 'reply "1": bot asks for the goal description');
assert(_objPendGet_(PHONE) === 'desc:month', 'reply "1": state advances to desc:month');
assert(_lastFetch === null, 'reply "1": no objective API call yet (no description) and NO expense write');

// ── 3) "1 קפה" is NOT end-anchored → falls through to expense ────────────────
reset();
_objPendSet_(PHONE, 'horizon');
r = _handleObjectivePendingReply_(PHONE, '1 קפה');
assert(r && r.handled === false, 'state=horizon, "1 קפה": handled=false (books an expense, as before)');
assert(_objPendGet_(PHONE) === 'horizon', '"1 קפה": pending state preserved (clean "1" still works after)');

// ── 4) reply "2" → six_months, "3" → year ───────────────────────────────────
reset();
_objPendSet_(PHONE, 'horizon');
_handleObjectivePendingReply_(PHONE, '2');
assert(_objPendGet_(PHONE) === 'desc:six_months', 'reply "2" -> desc:six_months');
reset();
_objPendSet_(PHONE, 'horizon');
_handleObjectivePendingReply_(PHONE, '3');
assert(_objPendGet_(PHONE) === 'desc:year', 'reply "3" -> desc:year');

// ── 5) reply "4" (אין לי יעד) → decline, clears state, no objective ──────────
reset();
_objPendSet_(PHONE, 'horizon');
r = _handleObjectivePendingReply_(PHONE, '4');
assert(r && r.handled === true, 'reply "4": handled=true');
assert(_objPendGet_(PHONE) === null, 'reply "4": pending state cleared (declined)');
assert(_lastFetch === null, 'reply "4": no objective created');

// ── 6) out-of-range digit "5" → falls through (NOT an objective pick) ────────
reset();
_objPendSet_(PHONE, 'horizon');
r = _handleObjectivePendingReply_(PHONE, '5');
assert(r && r.handled === false, 'reply "5": handled=false (out of 1-4, books expense)');

// ── 7) description stage: goal text → creates the objective via the API ──────
reset();
_objPendSet_(PHONE, 'desc:month');
_fetchResponse = { code: 200, body: JSON.stringify({ ok: true, objective: { horizon: 'month', description: 'לחסוך 1000 לטיול ביוני' } }) };
r = _handleObjectivePendingReply_(PHONE, 'לחסוך 1000 לטיול ביוני');
assert(r && r.handled === true, 'desc stage: goal text handled=true');
assert(_lastFetch && _lastFetch.payload.action === 'set', 'desc stage: calls /api/objectives/action with action=set');
assert(_lastFetch && _lastFetch.payload.horizon === 'month', 'desc stage: sends horizon=month');
assert(_lastFetch && _lastFetch.payload.description === 'לחסוך 1000 לטיול ביוני', 'desc stage: sends the goal text as description');
assert(_lastFetch && _lastFetch.payload.phone === PHONE, 'desc stage: sends the resolved phone (tenant isolation)');
assert(/✅/.test(r.replyText || ''), 'desc stage: confirms the objective was set');
assert(_objPendGet_(PHONE) === null, 'desc stage: pending state cleared after success');

// ── 8) description stage with a leading-digit expense → drops pending, falls
//        through so the user is not trapped mid-flow ──────────────────────────
reset();
_objPendSet_(PHONE, 'desc:month');
_lastFetch = null;
r = _handleObjectivePendingReply_(PHONE, '200 בנזין');
assert(r && r.handled === false, 'desc stage: "200 בנזין" handled=false (books an expense)');
assert(_objPendGet_(PHONE) === null, 'desc stage: leading-digit expense drops the pending objective');
assert(_lastFetch === null, 'desc stage: no objective created from an expense message');

// ── 9) cancel words clear the flow from any stage ───────────────────────────
for (const word of ['ביטול', 'בטל', 'לא']) {
  reset();
  _objPendSet_(PHONE, 'horizon');
  r = _handleObjectivePendingReply_(PHONE, word);
  assert(r && r.handled === true && _objPendGet_(PHONE) === null, 'cancel word "' + word + '" clears pending objective');
}

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
