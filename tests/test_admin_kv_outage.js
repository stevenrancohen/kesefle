#!/usr/bin/env node
// tests/test_admin_kv_outage.js
//
// Regression test for the admin-dashboard KV-outage masking bug.
//
// THE BUG (api/admin.js): every list/metrics/audit/analytics/flags handler did
//
//     const keys = await kvScan('user:*');
//     if (keys === null) return kvOutage(res);
//
// but kvScan() could NEVER return null. On a KV outage kvFetch returns
// { ok:false, kvOutage:true }, so the scan loop hit `if (!r.ok) break;` on its
// first iteration and kvScan returned [] (an EMPTY array). `keys === null` was
// therefore always false, and on a real KV outage these admin endpoints
// silently answered 200 with empty data (e.g. { ok:true, users:[], total:0 })
// instead of 503 kv_outage — masking the outage as "no data" in the dashboard.
//
// THE FIX makes the outage detectable: kvScan returns null when the VERY FIRST
// cursor fetch is not ok (we never reached a healthy KV), while still returning
// [] for a genuine empty-but-healthy scan. The existing `if (keys === null)`
// guards then fire correctly.
//
// This test exercises the REAL handler source (extracted via balanced-brace
// slicing — the repo's house pattern, see test_api_error_wrapper_hardening.js)
// against a mocked KV (an in-memory fetch, see
// test_crypto_webhook_no_silent_payment_drop.js). It asserts, for EVERY
// affected handler:
//   * a KV outage (mocked fetch -> non-2xx) yields 503 { error:'kv_outage' },
//     NOT a 200 empty payload;
//   * a healthy-but-empty KV (scan returns []) still yields 200 with empty data.
//
// No network, no secrets, no mocking framework, no eval of untrusted input
// (only our own repo source is loaded).
//
// Run: node tests/test_admin_kv_outage.js

import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../api/admin.js', import.meta.url), 'utf8');

// ── House-pattern source extraction ──────────────────────────────────────────
// Slice a top-level `[async ]function NAME(` ... matching-brace block out of the
// real source so we can run the handler in isolation (bypassing requireAdmin /
// withRateLimit / withRequestId, which need OAuth + KV we don't have offline).
function sliceFn(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('function not found in api/admin.js: ' + name);
  const start = m.index;
  // Skip past the parameter list (balanced parens) so a default value like
  // `opts = {}` doesn't fool the body-brace scanner. Then match the body braces.
  const paren = src.indexOf('(', start);
  let p = paren, pd = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') pd++;
    else if (src[p] === ')') { pd--; if (!pd) { p++; break; } }
  }
  let j = src.indexOf('{', p), depth = 0;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { j++; break; } }
  }
  return src.slice(start, j);
}

// Slice a top-level `const NAME = [ ... ];` (balanced brackets) out of the source.
function sliceArrayConst(src, name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*\\[');
  const m = re.exec(src);
  if (!m) throw new Error('const array not found in api/admin.js: ' + name);
  const start = m.index;
  let i = src.indexOf('[', start), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '[') depth++;
    else if (src[j] === ']') { depth--; if (!depth) { j++; break; } }
  }
  // include the trailing ';' if present
  let end = j;
  while (end < src.length && src[end] !== ';' && /\s/.test(src[end])) end++;
  if (src[end] === ';') end++;
  return src.slice(start, end);
}

const PARTS = [
  // helpers the handlers depend on
  sliceFn(SRC, 'kvFetch'),
  sliceFn(SRC, 'kvScan'),
  sliceFn(SRC, 'kvMget'),
  sliceFn(SRC, 'kvScard'),
  sliceFn(SRC, 'sanitizeUser'),
  sliceFn(SRC, 'kvOutage'),
  sliceFn(SRC, 'lastNDates'),
  sliceArrayConst(SRC, 'ANALYTICS_EVENTS'),
  // the affected handlers under test
  sliceFn(SRC, 'listUsers'),
  sliceFn(SRC, 'getUser'),
  sliceFn(SRC, 'listQuestionnaires'),
  sliceFn(SRC, 'registrationHealth'),
  sliceFn(SRC, 'listJobs'),
  sliceFn(SRC, 'getMetrics'),
  sliceFn(SRC, 'listAudit'),
  sliceFn(SRC, 'getAnalytics'),
  sliceFn(SRC, 'getFeatureFlags'),
];

// Expose the handlers + kvScan on a module-like object so the harness can call
// them. Everything runs inside a vm context whose `fetch` we control per-case.
const bootstrap = PARTS.join('\n\n') + `\n;__exports__ = {
  kvScan, listUsers, getUser, listQuestionnaires, registrationHealth,
  listJobs, getMetrics, listAudit, getAnalytics, getFeatureFlags,
};`;

// `fetchImpl` is swapped per scenario; `process.env` is set so kvFetch proceeds
// to the (mocked) network instead of short-circuiting on missing env vars —
// that way we test the SCAN-loop outage path, not just the unconfigured path.
const sandbox = {
  process: { env: { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 'tok' } },
  fetch: (...a) => sandbox.__fetchImpl(...a),
  Response, JSON, Date, Math, encodeURIComponent, decodeURIComponent,
  parseInt, parseFloat, String, Number, Boolean, Array, Object, Set, Promise,
  console,
  __fetchImpl: null,
  __exports__: null,
};
vm.createContext(sandbox);
vm.runInContext(bootstrap, sandbox, { filename: 'admin-extracted.js' });
const H = sandbox.__exports__;

// ── Test plumbing ────────────────────────────────────────────────────────────
function makeRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    send(p) { this.body = p; return this; },
    setHeader() { return this; },
  };
}
function req(query = {}) { return { method: 'GET', query, reqId: 'test', headers: {}, user: { email: 'admin@test' } }; }

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' -- ' + detail : '')); }
}

// ── Mock fetch flavours ──────────────────────────────────────────────────────
// OUTAGE: every KV call answers a non-2xx (Upstash down / 500). kvFetch turns
// this into { ok:false, ... }, which is exactly the runtime-outage signal.
function outageFetch() {
  return async () => new Response('{"error":"upstash down"}', { status: 500 });
}
// HEALTHY-EMPTY: SCAN returns ["0", []] (cursor done, zero keys); SCARD returns
// 0; MGET returns []. i.e. KV is reachable but has no matching keys.
function healthyEmptyFetch() {
  return async (url) => {
    const u = String(url);
    if (/\/scan\//.test(u)) return new Response(JSON.stringify({ result: ['0', []] }), { status: 200 });
    if (/\/scard\//.test(u)) return new Response(JSON.stringify({ result: 0 }), { status: 200 });
    if (/\/mget\//.test(u)) return new Response(JSON.stringify({ result: [] }), { status: 200 });
    if (/\/get\//.test(u)) return new Response(JSON.stringify({ result: null }), { status: 200 });
    return new Response('{"result":null}', { status: 200 });
  };
}

// Handlers that scan KV and must fail-closed (503) on an outage. getUser is
// included: it uses a direct kvFetch + r.kvOutage check (not kvScan) and must
// stay consistent. getAnalytics gets a ?sub for getUser only; ignored elsewhere.
const SCAN_HANDLERS = [
  'listUsers', 'listQuestionnaires', 'registrationHealth',
  'listJobs', 'getMetrics', 'listAudit', 'getAnalytics', 'getFeatureFlags',
];

// ── 0. Sanity: the fix is actually present — kvScan returns null on a first-
//     cursor outage, and [] on a healthy-empty scan. ───────────────────────────
console.log('\n=== kvScan outage signal (the core fix) ===\n');
{
  sandbox.__fetchImpl = outageFetch();
  const r = await H.kvScan('user:*');
  check('kvScan returns null on a first-cursor KV outage (not [])', r === null, 'got ' + JSON.stringify(r));
}
{
  sandbox.__fetchImpl = healthyEmptyFetch();
  const r = await H.kvScan('user:*');
  check('kvScan returns [] on a healthy-but-empty scan (not null)', Array.isArray(r) && r.length === 0, 'got ' + JSON.stringify(r));
}

// ── 1. OUTAGE: every scan handler must answer 503 kv_outage, NEVER 200-empty ──
console.log('\n=== KV outage -> 503 kv_outage (no silent empty 200) ===\n');
sandbox.__fetchImpl = outageFetch();
for (const name of SCAN_HANDLERS) {
  const r = makeRes();
  await H[name](req({ days: '7' }), r);
  check(name + ' answers 503 on KV outage', r.statusCode === 503, 'got ' + r.statusCode + ' ' + JSON.stringify(r.body));
  check(name + ' body error == kv_outage', r.body && r.body.error === 'kv_outage', JSON.stringify(r.body));
  check(name + ' did NOT return ok:true empty payload', !(r.body && r.body.ok === true), JSON.stringify(r.body));
}
// getUser uses a direct kvFetch (r.kvOutage) — assert it stays consistent.
{
  const r = makeRes();
  await H.getUser(req({ sub: 'abc123' }), r);
  check('getUser answers 503 on KV outage', r.statusCode === 503, 'got ' + r.statusCode + ' ' + JSON.stringify(r.body));
  check('getUser body error == kv_outage', r.body && r.body.error === 'kv_outage', JSON.stringify(r.body));
}

// ── 2. HEALTHY-EMPTY: every scan handler must answer 200 with empty data ──────
console.log('\n=== healthy-but-empty KV -> 200 empty (no false outage) ===\n');
sandbox.__fetchImpl = healthyEmptyFetch();
for (const name of SCAN_HANDLERS) {
  const r = makeRes();
  await H[name](req({ days: '7' }), r);
  check(name + ' answers 200 on a healthy-empty scan', r.statusCode === 200, 'got ' + r.statusCode + ' ' + JSON.stringify(r.body));
  check(name + ' body ok:true on a healthy-empty scan', r.body && r.body.ok === true, JSON.stringify(r.body));
  check(name + ' did NOT mislabel empty as kv_outage', !(r.body && r.body.error === 'kv_outage'), JSON.stringify(r.body));
}
// Spot-check a couple of empty payload shapes are sane (empty, not undefined).
{
  const r = makeRes(); await H.listUsers(req(), r);
  check('listUsers empty payload: users:[] total:0', Array.isArray(r.body.users) && r.body.users.length === 0 && r.body.total === 0, JSON.stringify(r.body));
}
{
  const r = makeRes(); await H.registrationHealth(req(), r);
  check('registrationHealth empty payload: totalUsers:0', r.body.totalUsers === 0 && Array.isArray(r.body.orphans), JSON.stringify(r.body));
}

console.log('');
if (fail > 0) {
  console.error('FAIL: ' + fail + ' assertion(s) failed (' + pass + ' passed)');
  process.exit(1);
}
console.log('OK: all ' + pass + ' admin KV-outage assertions passed');
