// Unit test: api/profession/seed-sheet.js
//
// We exercise the handler end-to-end with mocked KV, mocked Sheets API,
// and a real lib/professions.js catalog. Validates:
//   1. Auth — missing/wrong bot secret → 401
//   2. Validation — missing fields → 400
//   3. Tenant isolation — unlinked phone → 404 no_user; no fallback to
//      owner sheet
//   4. Idempotency — re-running for the same profession returns the rows
//      as skippedDuplicates (no double-write)
//   5. Happy path — known profession returns the right rows + writes once
//
// Run: node tests/test_profession_seed.js

import { findProfession } from '../lib/professions.js';
import { getProfessionRows } from '../lib/profession-template.js';

const BOT_SECRET = 'test-secret-' + Date.now();
process.env.KESEFLE_BOT_SECRET = BOT_SECRET;
process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'kv-token';
// Stub the AES key so decryptRefreshToken doesn't throw on import.
process.env.KESEFLE_AES_KEY = '0'.repeat(64);
// exchangeRefreshForAccess needs these to call oauth2.googleapis.com/token.
// Our fetch mock intercepts the URL so the real values don't matter.
process.env.GOOGLE_CLIENT_ID = 'fake-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); }
}

// --- Mock the network layer. ---
// We replace global.fetch with a router that handles:
//   - Upstash KV REST calls (phone:, user:, sheet:)
//   - Sheets API read (values/RANGE)
//   - Sheets API append (values/RANGE:append)
//   - rate-limit KV (uses same KV)
//   - OAuth token refresh (oauth2.googleapis.com/token)
const kvState = new Map();
function setKv(key, value) {
  kvState.set(key, typeof value === 'string' ? value : JSON.stringify(value));
}
function getKv(key) {
  return kvState.get(key) || null;
}

let appendCallCount = 0;
let lastAppendBody = null;
let existingDashboardLabels = ['💰 שכר טרחה חודשי']; // pre-existing row for dup test

const originalFetch = global.fetch;
global.fetch = async function (url, opts) {
  opts = opts || {};
  // Upstash KV REST: GET /get/<key>
  const kvGetMatch = String(url).match(/\/get\/([^?]+)/);
  if (kvGetMatch) {
    const key = decodeURIComponent(kvGetMatch[1]);
    const v = getKv(key);
    return new Response(JSON.stringify({ result: v }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Upstash KV REST: POST /set/<key>  OR  /set/<key>?EX=<sec>
  const kvSetMatch = String(url).match(/\/set\/([^?]+)/);
  if (kvSetMatch && opts.method && opts.method.toUpperCase() === 'POST') {
    const key = decodeURIComponent(kvSetMatch[1]);
    setKv(key, opts.body);
    return new Response('{"result":"OK"}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Upstash KV REST: POST /incr/<key>  (used by rate-limiter)
  const kvIncrMatch = String(url).match(/\/incr\/([^?]+)/);
  if (kvIncrMatch) {
    const key = decodeURIComponent(kvIncrMatch[1]);
    const v = Number(getKv(key) || 0) + 1;
    setKv(key, String(v));
    return new Response(JSON.stringify({ result: v }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Upstash KV REST: POST /expire/<key>/<sec>
  if (/\/expire\//.test(String(url))) {
    return new Response('{"result":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Google OAuth token refresh.
  if (/oauth2\.googleapis\.com\/token/.test(String(url))) {
    return new Response(JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  // Sheets API read (GET values/RANGE).
  if (/sheets\.googleapis\.com.*\/values\//.test(String(url)) && (!opts.method || opts.method.toUpperCase() === 'GET')) {
    return new Response(JSON.stringify({
      values: existingDashboardLabels.map((l) => [l]),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Sheets API append (POST values/RANGE:append).
  if (/sheets\.googleapis\.com.*:append/.test(String(url))) {
    appendCallCount++;
    lastAppendBody = JSON.parse(opts.body);
    // Add the new labels to our "existing" set so subsequent reads see them.
    lastAppendBody.values.forEach((row) => {
      existingDashboardLabels.push(row[0]);
    });
    return new Response(JSON.stringify({
      updates: { updatedRange: `'מאזן אישי'!A20:B${20 + lastAppendBody.values.length - 1}` },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Default: pass through (shouldn't happen).
  console.warn('UNMOCKED fetch:', String(url).slice(0, 100));
  return originalFetch(url, opts);
};

// --- Now import the handler (must happen after env vars + fetch mock). ---
const { default: handler } = await import('../api/profession/seed-sheet.js');

function makeReq(body, headers) {
  return {
    method: 'POST',
    headers: Object.assign({}, headers || {}),
    body,
    reqId: 'test-' + Math.random().toString(36).slice(2, 8),
  };
}
function makeRes() {
  const r = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
  };
  return r;
}

// ─── Auth tests ─────────────────────────────────────────────────────

console.log('=== AUTH ===\n');

{
  const req = makeReq({ phone: '972501234567', profession: 'lawyer' }, {});
  const res = makeRes();
  await handler(req, res);
  check('rejects no bot secret', res.statusCode === 401 && res.body.error === 'unauthorized',
    'got ' + res.statusCode + ' ' + JSON.stringify(res.body));
}

{
  const req = makeReq(
    { phone: '972501234567', profession: 'lawyer' },
    { 'x-kesefle-bot-secret': 'wrong-secret' }
  );
  const res = makeRes();
  await handler(req, res);
  check('rejects wrong bot secret', res.statusCode === 401);
}

// ─── Validation tests ──────────────────────────────────────────────

console.log('\n=== VALIDATION ===\n');

{
  const req = makeReq({ phone: '', profession: 'lawyer' }, { 'x-kesefle-bot-secret': BOT_SECRET });
  const res = makeRes();
  await handler(req, res);
  check('rejects missing phone', res.statusCode === 400 && res.body.error === 'missing_phone');
}

{
  const req = makeReq({ phone: '972501234567', profession: '' }, { 'x-kesefle-bot-secret': BOT_SECRET });
  const res = makeRes();
  await handler(req, res);
  check('rejects missing profession', res.statusCode === 400 && res.body.error === 'missing_profession');
}

{
  const req = makeReq(
    { phone: '972501234567', profession: 'Has Spaces And Caps' },
    { 'x-kesefle-bot-secret': BOT_SECRET }
  );
  const res = makeRes();
  await handler(req, res);
  check('rejects malformed profession id (the regex normalises but spaces still fail)',
    res.statusCode === 400 && /invalid_profession_format|unknown/.test(res.body.error));
}

{
  const req = makeReq(
    { phone: '972501234567', profession: 'definitely_not_a_real_profession_zzz' },
    { 'x-kesefle-bot-secret': BOT_SECRET }
  );
  const res = makeRes();
  await handler(req, res);
  check('rejects unknown profession id', res.statusCode === 400 && res.body.error === 'unknown_profession');
}

// ─── Tenant isolation ──────────────────────────────────────────────

console.log('\n=== TENANT ISOLATION ===\n');

{
  // No phone:... record in KV → 404 no_user. This is the critical
  // invariant: an unknown phone must NEVER write to the owner sheet.
  kvState.clear();
  const req = makeReq(
    { phone: '972501234567', profession: 'lawyer' },
    { 'x-kesefle-bot-secret': BOT_SECRET }
  );
  const res = makeRes();
  await handler(req, res);
  check('unlinked phone → 404 no_user (not a 200 owner-sheet write)',
    res.statusCode === 404 && res.body.error === 'no_user');
}

{
  // phone exists but user has no sheet → 404 no_sheet
  kvState.clear();
  setKv('phone:972501234567', { userSub: 'sub-abc' });
  setKv('user:sub-abc', { refreshToken: 'fake-refresh-token' });
  // NO sheet:sub-abc record
  const req = makeReq(
    { phone: '972501234567', profession: 'lawyer' },
    { 'x-kesefle-bot-secret': BOT_SECRET }
  );
  const res = makeRes();
  await handler(req, res);
  check('user with no sheet → 404 no_sheet',
    res.statusCode === 404 && res.body.error === 'no_sheet');
}

{
  // phone + sheet exist but no refresh token → 409 reauth_required
  kvState.clear();
  setKv('phone:972501234567', { userSub: 'sub-abc' });
  setKv('user:sub-abc', {}); // no token at all
  setKv('sheet:sub-abc', { spreadsheetId: 'sheet-xyz' });
  const req = makeReq(
    { phone: '972501234567', profession: 'lawyer' },
    { 'x-kesefle-bot-secret': BOT_SECRET }
  );
  const res = makeRes();
  await handler(req, res);
  check('no refresh token → 409 reauth_required',
    res.statusCode === 409 && res.body.error === 'reauth_required');
}

// ─── Happy path ────────────────────────────────────────────────────

console.log('\n=== HAPPY PATH ===\n');

{
  // Full setup. Lawyer profession seeds income_subs + expense_subs.
  kvState.clear();
  setKv('phone:972501234567', { userSub: 'sub-abc' });
  setKv('user:sub-abc', { refreshToken: 'fake-refresh-token' });
  setKv('sheet:sub-abc', { spreadsheetId: 'sheet-xyz' });
  existingDashboardLabels = []; // empty dashboard
  appendCallCount = 0;
  lastAppendBody = null;

  const lawyerRows = getProfessionRows('lawyer');
  const expectedTotal = lawyerRows.income.length + lawyerRows.expense.length;

  const req = makeReq(
    { phone: '972501234567', profession: 'lawyer' },
    { 'x-kesefle-bot-secret': BOT_SECRET }
  );
  const res = makeRes();
  await handler(req, res);
  check('happy path returns 200', res.statusCode === 200, 'got ' + res.statusCode + ' ' + JSON.stringify(res.body));
  check('happy path returns ok:true', res.body.ok === true);
  check('addedRows count matches catalog (income + expense)',
    res.body.addedRows && res.body.addedRows.length === expectedTotal,
    'got ' + (res.body.addedRows ? res.body.addedRows.length : 'none') + ' expected ' + expectedTotal);
  check('appendCallCount === 1 (one batch write, not N)',
    appendCallCount === 1, 'got ' + appendCallCount);
  check('Sheets payload sent all rows in one batch',
    lastAppendBody && lastAppendBody.values && lastAppendBody.values.length === expectedTotal);
  check('Each Sheets row is [label, formula]',
    lastAppendBody.values.every((r) => r.length === 2 && typeof r[0] === 'string' && r[1].indexOf('SUMPRODUCT') >= 0));
  check('Income rows prefixed with 💰',
    lastAppendBody.values.some((r) => r[0].indexOf('💰') === 0));
  check('Expense rows prefixed with 💸',
    lastAppendBody.values.some((r) => r[0].indexOf('💸') === 0));
}

// ─── Idempotency ───────────────────────────────────────────────────

console.log('\n=== IDEMPOTENCY ===\n');

{
  // Run the SAME profession again. All rows already exist → 0 added,
  // N skipped. The Sheets append API must NOT be called.
  appendCallCount = 0;
  const req = makeReq(
    { phone: '972501234567', profession: 'lawyer' },
    { 'x-kesefle-bot-secret': BOT_SECRET }
  );
  const res = makeRes();
  await handler(req, res);
  check('idempotent re-run returns 200', res.statusCode === 200);
  check('idempotent re-run: addedRows is empty',
    res.body.addedRows && res.body.addedRows.length === 0);
  check('idempotent re-run: skippedDuplicates is populated',
    res.body.skippedDuplicates && res.body.skippedDuplicates.length > 0);
  check('idempotent re-run: NO Sheets append call',
    appendCallCount === 0, 'got ' + appendCallCount + ' (should be 0)');
}

// ─── Different professions → different rows ────────────────────────

console.log('\n=== DIFFERENT PROFESSION ===\n');

{
  // Switch to general_contractor — should add construction rows even
  // though lawyer rows are already present.
  appendCallCount = 0;
  lastAppendBody = null;
  const contractorRows = getProfessionRows('general_contractor');

  const req = makeReq(
    { phone: '972501234567', profession: 'general_contractor' },
    { 'x-kesefle-bot-secret': BOT_SECRET }
  );
  const res = makeRes();
  await handler(req, res);
  check('different profession returns 200', res.statusCode === 200);
  check('contractor rows added (income + expense)',
    res.body.addedRows && res.body.addedRows.length > 0);
  check('contractor expense row mentions בטון or פועלים or שיפוצ or חומרי',
    res.body.addedRows.some((label) => /בטון|פועלים|שיפוצ|חומרי|גבס/.test(label)),
    'got ' + JSON.stringify(res.body.addedRows));
}

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
