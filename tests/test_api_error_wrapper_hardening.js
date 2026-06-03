#!/usr/bin/env node
// tests/test_api_error_wrapper_hardening.js
//
// Regression test for the 2026-06 backend deep-hardening pass.
//
// Two findings are locked in here:
//
//   1. api/sheet/getExpenses.js was the ONLY api/sheet/* read endpoint NOT
//      wrapped in withRequestId. Its handler has throw paths that are NOT
//      inside a try-catch (kvGet does an unguarded JSON.parse(j.result); kvSet's
//      fetch can reject), so an unhandled rejection returned Vercel's raw 500
//      with no reqId and an inconsistent body. withRequestId catches that and
//      emits the canonical { ok:false, error:'internal_error', reqId } shape +
//      X-Request-Id header + structured http.error log, exactly like every
//      sibling (stats / bot-query / summary). This test asserts the wrapper is
//      present and, more generally, that EVERY api/sheet/*.js endpoint that
//      uses withRateLimit is also wrapped in withRequestId — so the same gap
//      can't silently reappear on a future sheet endpoint.
//
//   2. api/billing/paypal.js subscribeImpl + webhookImpl previously returned
//      `{ ok:false, error: e.message }` on a getAccessToken() failure — echoing
//      the raw exception message as the error CODE, inconsistent with their own
//      sibling failure responses (paypal_subscribe_failed / paypal_unreachable)
//      which use a STABLE code and keep internal detail out of the body. This
//      test asserts neither user-facing handler returns `error: e.message`, that
//      the token-mint failure now logs server-side, and that the failure status
//      is 502 (so PayPal retries the webhook rather than dropping the event).
//
// Pure source-text assertions: no network, no secrets, no eval.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

// Strip line + block comments so doc text can't satisfy (or trip) an assertion.
function stripComments(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

console.log('\ntests/test_api_error_wrapper_hardening.js\n');

// ── Finding 1: getExpenses + the sheet-endpoint invariant ────────────────────
console.log('Finding 1 — withRequestId on api/sheet/* endpoints:');

const GETEXP = stripComments(fs.readFileSync(path.join(ROOT, 'api/sheet/getExpenses.js'), 'utf8'));
assert(/import\s*\{\s*withRequestId\s*\}\s*from\s*['"]\.\.\/\.\.\/lib\/log\.js['"]/.test(GETEXP),
  'getExpenses.js imports withRequestId from lib/log.js');
assert(/export\s+default\s+withRequestId\s*\(/.test(GETEXP),
  'getExpenses.js default export is wrapped in withRequestId(...)');
// The rate limit must still be present (the wrapper composes around it).
assert(/withRateLimit\(\{\s*key:\s*['"]sheet_get_expenses['"]/.test(GETEXP),
  'getExpenses.js still has its withRateLimit (sheet_get_expenses) inside the wrapper');

// Invariant across every api/sheet/* endpoint: if it rate-limits, it must also
// wrap in withRequestId (so an unhandled rejection becomes a clean 500, never a
// raw Vercel error). Catches the exact regression this PR fixed, on any sheet
// endpoint added later.
const SHEET_DIR = path.join(ROOT, 'api/sheet');
const sheetFiles = fs.readdirSync(SHEET_DIR).filter((n) => n.endsWith('.js'));
const missingWrapper = [];
for (const name of sheetFiles) {
  const src = stripComments(fs.readFileSync(path.join(SHEET_DIR, name), 'utf8'));
  const usesRateLimit = /withRateLimit\s*\(/.test(src);
  const usesRequestId = /withRequestId\s*\(/.test(src);
  if (usesRateLimit && !usesRequestId) missingWrapper.push('api/sheet/' + name);
}
assert(missingWrapper.length === 0,
  'every api/sheet/*.js endpoint that uses withRateLimit also uses withRequestId');
if (missingWrapper.length) missingWrapper.forEach((f) => console.log('    -> missing withRequestId: ' + f));

// ── Finding 2: paypal subscribe/webhook stable error code ────────────────────
console.log('\nFinding 2 — paypal getAccessToken failure returns a stable code:');

const PAYPAL = fs.readFileSync(path.join(ROOT, 'api/billing/paypal.js'), 'utf8');
const PAYPAL_NC = stripComments(PAYPAL);

// Isolate the two user/PayPal-facing handlers (subscribe + webhook). setupPlans
// is admin-only and intentionally keeps a debug hint, so it's excluded.
function sliceFn(src, name) {
  const start = src.indexOf('async function ' + name + '(');
  if (start < 0) return '';
  // Find the function body's matching closing brace.
  let i = src.indexOf('{', start), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) { j++; break; } }
  }
  return src.slice(start, j);
}

const subscribeFn = sliceFn(PAYPAL_NC, 'subscribeImpl');
const webhookFn = sliceFn(PAYPAL_NC, 'webhookImpl');
assert(subscribeFn.length > 0, 'subscribeImpl found in paypal.js');
assert(webhookFn.length > 0, 'webhookImpl found in paypal.js');

// Neither user/PayPal-facing handler may return the raw exception message as the
// error value in a RESPONSE body (the leak we removed). We must NOT flag the
// `log.error(..., { error: e.message })` server-side calls — those are exactly
// what we want — so the guard targets only `res...json({ ... error: e.message })`
// response shapes. A simple, robust proxy: no `.json(` call in the function may
// have `error: e.message` between the `.json(` and its line end.
function hasEMessageInJsonResponse(fnSrc) {
  // Match a res.status(...).json({ ... error: e.message ... }) on one logical
  // chunk. We scan each `.json(` occurrence and look at the ~160 chars after it.
  const re = /\.json\(\s*\{[^}]{0,200}\}/g;
  let m;
  while ((m = re.exec(fnSrc)) !== null) {
    if (/error:\s*e\.message/.test(m[0])) return true;
  }
  return false;
}
assert(!hasEMessageInJsonResponse(subscribeFn),
  'subscribeImpl does NOT return { error: e.message } in a json() response (stable code instead)');
assert(!hasEMessageInJsonResponse(webhookFn),
  'webhookImpl does NOT return { error: e.message } in a json() response (stable code instead)');

// The getAccessToken failure in both must now log server-side (so the detail is
// not lost) and answer 502 (so PayPal retries the webhook on a transient mint
// failure rather than dropping the lifecycle event).
assert(/paypal_get_token_failed/.test(subscribeFn) && /res\.status\(502\)/.test(subscribeFn),
  'subscribeImpl logs paypal_get_token_failed + returns 502 on token-mint failure');
assert(/paypal_get_token_failed/.test(webhookFn) && /res\.status\(502\)/.test(webhookFn),
  'webhookImpl logs paypal_get_token_failed + returns 502 on token-mint failure');

// getAccessToken itself only ever throws fixed string codes (no user data), and
// the stable response codes used must be ones the frontend already understands.
assert(/error:\s*'paypal_unreachable'/.test(subscribeFn),
  'subscribeImpl uses the stable paypal_unreachable code');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
