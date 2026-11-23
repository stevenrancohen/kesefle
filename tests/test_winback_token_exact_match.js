#!/usr/bin/env node
'use strict';

// End-to-end regression contract for the public win-back claim path. Despite
// the historical filename, this now proves the replacement for the predictable
// 24-character identity prefix: encrypted expiry-bound tokens, direct KV
// lookup, atomic one-time claims, retry safety, and fragment-based delivery.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const DAY_MS = 24 * 60 * 60 * 1000;

process.env.KESEFLE_DB_KEY = Buffer.alloc(32, 37).toString('base64');
process.env.KESEFLE_DB_KEY_OLD = Buffer.alloc(32, 19).toString('base64');
process.env.KESEFLE_DB_KEY_ACTIVE_KID = 'old';
process.env.KV_REST_API_URL = 'https://kv.winback.test';
process.env.KV_REST_API_TOKEN = 'test-kv-token';
delete process.env.SLACK_ALERT_WEBHOOK_URL;
delete process.env.RESEND_API_KEY;

function response() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

async function expectTokenError(fn, code) {
  let actual = null;
  try { await fn(); } catch (error) { actual = error.code; }
  assert.strictEqual(actual, code);
}

(async () => {
  const tokenModule = await import(pathToFileURL(path.join(root, 'lib/winback-token.js')).href);
  const { createWinbackToken, verifyWinbackToken, WINBACK_TOKEN_TTL_SEC } = tokenModule;
  const nowMs = Date.parse('2026-11-23T12:00:00.000Z');
  const cancelledAt = new Date(nowMs - 30 * DAY_MS).toISOString();

  for (const userSub of ['x', 'short-google-sub', '9'.repeat(255)]) {
    const token = createWinbackToken({ userSub, cancelledAt, nowMs });
    const decoded = verifyWinbackToken(token, { nowMs: nowMs + DAY_MS });
    assert.strictEqual(decoded.userSub, userSub, 'variable-length Google subjects round-trip');
    assert.strictEqual(decoded.cancelledAt, cancelledAt, 'token binds the exact cancellation');
    assert.strictEqual(
      Date.parse(decoded.expiresAt) - Date.parse(decoded.issuedAt),
      WINBACK_TOKEN_TTL_SEC * 1000,
      'offer expires after exactly 14 days',
    );
  }

  const token = createWinbackToken({ userSub: 'customer-sub-123', cancelledAt, nowMs });
  const tokenAgain = createWinbackToken({ userSub: 'customer-sub-123', cancelledAt, nowMs });
  assert.match(token, /^v1:old:/, 'token remains verifiable through its rotation key id');
  assert(!token.includes('customer-sub-123'), 'opaque token does not expose the Google subject');
  assert.notStrictEqual(token, tokenAgain, 'random IV produces unlinkable tokens for the same offer');
  const parts = token.split(':');
  parts[4] = (parts[4][0] === 'A' ? 'B' : 'A') + parts[4].slice(1);
  await expectTokenError(() => verifyWinbackToken(parts.join(':'), { nowMs }), 'invalid_token');
  const expired = createWinbackToken({ userSub: 'expired-sub', cancelledAt, nowMs: nowMs - 15 * DAY_MS });
  await expectTokenError(() => verifyWinbackToken(expired, { nowMs }), 'expired_token');
  const future = createWinbackToken({ userSub: 'future-sub', cancelledAt, nowMs: nowMs + 10 * 60 * 1000 });
  await expectTokenError(() => verifyWinbackToken(future, { nowMs }), 'invalid_token');
  const withinSkew = createWinbackToken({ userSub: 'skew-sub', cancelledAt, nowMs: nowMs + 4 * 60 * 1000 });
  assert.strictEqual(verifyWinbackToken(withinSkew, { nowMs }).userSub, 'skew-sub', 'five-minute clock skew is tolerated');

  const store = new Map();
  const calls = [];
  let failClaimWrites = false;
  let ambiguousClaimWrites = false;
  global.fetch = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({ url, options });
    const getPrefix = '/get/';
    const setPrefix = '/set/';
    if (url.pathname.startsWith(getPrefix)) {
      const key = decodeURIComponent(url.pathname.slice(getPrefix.length));
      return { ok: true, status: 200, json: async () => ({ result: store.has(key) ? store.get(key) : null }) };
    }
    if (url.pathname.startsWith(setPrefix)) {
      const key = decodeURIComponent(url.pathname.slice(setPrefix.length));
      if (failClaimWrites && key.startsWith('winback:')) {
        return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
      }
      if (ambiguousClaimWrites && key.startsWith('winback:')) {
        return { ok: true, status: 200, json: async () => ({ result: 'QUEUED' }) };
      }
      const nx = String(url.searchParams.get('NX') || url.searchParams.get('nx')).toLowerCase() === 'true';
      if (nx && store.has(key)) {
        return { ok: true, status: 200, json: async () => ({ result: null }) };
      }
      store.set(key, options.body);
      return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const endpoint = await import(pathToFileURL(path.join(root, 'api/billing/winback-claim.js')).href);
  const { handlerImpl } = endpoint;
  let alerts = 0;
  const deps = { nowMs, sendAlertFn: async () => { alerts++; return { ok: true }; } };

  const subject = 'customer-sub-123';
  store.set(`exit_survey:${subject}`, JSON.stringify({ userSub: subject, cancelled_at: cancelledAt }));
  store.set(`user:${subject}`, JSON.stringify({ userSub: subject, email: 'masked@example.test' }));
  calls.length = 0;
  const first = response();
  await handlerImpl({ method: 'POST', body: { token }, reqId: 'first' }, first, deps);
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(first.payload.ok, true);
  assert.strictEqual(alerts, 1, 'only the first atomic writer alerts the operator');
  assert(!calls.some((call) => /\/scan\//.test(call.url.pathname)), 'claim performs no KV SCAN');
  const claimSet = calls.find((call) => decodeURIComponent(call.url.pathname).includes(`winback:${subject}`));
  assert(claimSet, 'claim writes a direct per-user key');
  assert.strictEqual(claimSet.url.searchParams.get('NX'), 'true', 'claim write is atomic SET NX');
  assert(Number(claimSet.url.searchParams.get('EX')) > 0, 'claim write has a TTL');
  const storedBody = JSON.parse(claimSet.options.body);
  assert.strictEqual(typeof storedBody, 'object', 'claim record is serialized exactly once');
  assert.strictEqual(storedBody.userSub, subject);

  calls.length = 0;
  const replay = response();
  await handlerImpl({ method: 'POST', body: { token }, reqId: 'replay' }, replay, deps);
  assert.strictEqual(replay.statusCode, 200);
  assert.strictEqual(replay.payload.already_claimed, true, 'retry after a lost response is replay-safe');
  assert.strictEqual(alerts, 1, 'replay does not send a duplicate operator alert');

  const reusedSub = 'reused-offer-sub';
  const reusedToken = createWinbackToken({ userSub: reusedSub, cancelledAt, nowMs });
  store.set(`exit_survey:${reusedSub}`, JSON.stringify({ userSub: reusedSub, cancelled_at: cancelledAt }));
  store.set(`winback:${reusedSub}`, JSON.stringify({
    userSub: reusedSub,
    claimed_at: new Date(nowMs - 60 * DAY_MS).toISOString(),
    cancelled_at: new Date(nowMs - 90 * DAY_MS).toISOString(),
    discount_pct: 50,
  }));
  const reused = response();
  await handlerImpl({ method: 'POST', body: { token: reusedToken }, reqId: 'reused' }, reused, deps);
  assert.strictEqual(reused.statusCode, 409, 'an older cancellation claim cannot masquerade as this offer');
  assert.strictEqual(reused.payload.ok, false);

  const legacySub = 'legacy-double-json-sub';
  const legacyToken = createWinbackToken({ userSub: legacySub, cancelledAt, nowMs });
  store.set(`exit_survey:${legacySub}`, JSON.stringify({ userSub: legacySub, cancelled_at: cancelledAt }));
  store.set(`winback:${legacySub}`, JSON.stringify(JSON.stringify({
    userSub: legacySub,
    claimed_at: new Date(nowMs - DAY_MS).toISOString(),
    discount_pct: 50,
    status: 'pending_admin_action',
  })));
  const legacy = response();
  await handlerImpl({ method: 'POST', body: { token: legacyToken }, reqId: 'legacy' }, legacy, deps);
  assert.strictEqual(legacy.statusCode, 200, 'strict old double-serialized claim remains replay-safe');
  assert.strictEqual(legacy.payload.already_claimed, true);

  const mismatchSub = 'mismatch-sub';
  const mismatchToken = createWinbackToken({ userSub: mismatchSub, cancelledAt, nowMs });
  store.set(`exit_survey:${mismatchSub}`, JSON.stringify({ cancelled_at: new Date(nowMs - 31 * DAY_MS).toISOString() }));
  calls.length = 0;
  const mismatch = response();
  await handlerImpl({ method: 'POST', body: { token: mismatchToken }, reqId: 'mismatch' }, mismatch, deps);
  assert.strictEqual(mismatch.statusCode, 404, 'token cannot be moved to a different cancellation event');
  assert(!calls.some((call) => call.url.pathname.startsWith('/set/')), 'mismatch performs no claim write');

  const outageSub = 'outage-sub';
  const outageToken = createWinbackToken({ userSub: outageSub, cancelledAt, nowMs });
  store.set(`exit_survey:${outageSub}`, JSON.stringify({ userSub: outageSub, cancelled_at: cancelledAt }));
  failClaimWrites = true;
  const outage = response();
  await handlerImpl({ method: 'POST', body: { token: outageToken }, reqId: 'outage' }, outage, deps);
  assert.strictEqual(outage.statusCode, 503, 'failed persistence never returns success');
  assert.strictEqual(store.has(`winback:${outageSub}`), false);
  failClaimWrites = false;

  const ambiguousSub = 'ambiguous-write-sub';
  const ambiguousToken = createWinbackToken({ userSub: ambiguousSub, cancelledAt, nowMs });
  store.set(`exit_survey:${ambiguousSub}`, JSON.stringify({ userSub: ambiguousSub, cancelled_at: cancelledAt }));
  ambiguousClaimWrites = true;
  const ambiguous = response();
  await handlerImpl({ method: 'POST', body: { token: ambiguousToken }, reqId: 'ambiguous' }, ambiguous, deps);
  assert.strictEqual(ambiguous.statusCode, 503, 'unexpected KV SET result fails closed');
  ambiguousClaimWrites = false;

  const raceSub = 'race-sub';
  const raceToken = createWinbackToken({ userSub: raceSub, cancelledAt, nowMs });
  store.set(`exit_survey:${raceSub}`, JSON.stringify({ userSub: raceSub, cancelled_at: cancelledAt }));
  let raceAlerts = 0;
  const raceDeps = { nowMs, sendAlertFn: async () => { raceAlerts++; return { ok: true }; } };
  const raceA = response();
  const raceB = response();
  await Promise.all([
    handlerImpl({ method: 'POST', body: { token: raceToken }, reqId: 'race-a' }, raceA, raceDeps),
    handlerImpl({ method: 'POST', body: { token: raceToken }, reqId: 'race-b' }, raceB, raceDeps),
  ]);
  assert.deepStrictEqual([raceA.statusCode, raceB.statusCode], [200, 200]);
  assert.strictEqual(raceAlerts, 1, 'concurrent claims produce one operator action');
  assert([raceA.payload, raceB.payload].some((payload) => payload.already_claimed), 'concurrent loser receives replay-safe success');

  calls.length = 0;
  const expiredResponse = response();
  await handlerImpl({ method: 'POST', body: { token: expired }, reqId: 'expired' }, expiredResponse, deps);
  assert.strictEqual(expiredResponse.statusCode, 410, 'advertised 14-day expiry is enforced');
  assert.strictEqual(calls.length, 0, 'expired token is rejected before KV access');

  const claimSource = read('api/billing/winback-claim.js');
  const lifecycle = read('api/cron/lifecycle.js');
  const page = read('win-back.html');
  const email = read('templates/email/winback_30_days.html');
  assert(!/kvScan|\/scan\//.test(claimSource), 'endpoint contains no scan fallback');
  assert(!/slice\(0,\s*24\)/.test(lifecycle), 'lifecycle no longer derives a token from identity');
  assert(/createWinbackToken/.test(lifecycle), 'lifecycle uses the shared encrypted-token helper');
  assert(/win-back#token=/.test(lifecycle) && /win-back#token=/.test(email), 'email and WhatsApp keep tokens out of request URLs');
  assert(/fragment\.get\('token'\)[\s\S]*url\.searchParams\.get\('token'\)/.test(page), 'page prefers fragment tokens with query rollout fallback');
  assert(/history\.replaceState\(null, document\.title, url\.pathname\)/.test(page), 'page strips token-bearing URLs from browser history');
  assert(!/controllerchange|location\.reload\(\)/.test(page), 'bearer-link page cannot auto-reload after stripping its token');
  assert(/הבקשה נרשמה/.test(page) && !/ההנחה הופעלה/.test(page), 'success copy states that the manual request was recorded');

  console.log('Win-back claim hardening: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
