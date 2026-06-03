// tests/test_onboarding_e2e.js
//
// END-TO-END offline test of the NEW-USER onboarding path, exercised against
// the REAL handler source (no live network, no secrets, no ESM import of the
// api/* files). It locks the full happy path AND the key failure paths AND --
// critically -- tenant isolation, so a future edit that crosses tenants or
// breaks a step is caught by `npm run gauntlet`.
//
// The path under test:
//   Google sign-in
//     -> POST /api/whatsapp/link                 (mint a 6-digit code)
//     -> POST /api/whatsapp/link?action=confirm  (bot: code -> userSub,
//                                                 writes phone:E164 -> userSub)
//     -> POST /api/sheet/append                  (bot: tenant row write)
//     -> GET  /api/sheet/getExpenses             (dashboard read for that user)
//
// HOUSE PATTERN (matches tests/test_weekly_question_cron.js +
// tests/test_morning_nudge_cron.js + bot/test_isolation.js): we read the REAL
// source files as text, balanced-brace-extract the handler + its file-local
// helpers, and materialise them with `new Function`, injecting their free
// identifiers as mocks. The REAL `kvGet/kvSet/kvSetNX/kvDel` helpers run
// UNMODIFIED against a shared in-memory KV via a mocked global.fetch (exactly
// how the cron suites emulate Upstash) -- so the atomic-claim (SETNX), TTL, and
// delete semantics are the production ones, not re-implementations. The only
// things stubbed are the genuine EXTERNAL boundaries that a unit test cannot
// reach: the session-cookie verifier (getUserId/requireUser), the rate-limit
// wrappers (always-allow), the Sheets writer, token decrypt/refresh, and the
// three `await import(...)` sites (redirected to in-test stubs).
//
// Run: node tests/test_onboarding_e2e.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LINK_SRC = fs.readFileSync(path.join(ROOT, 'api/whatsapp/link.js'), 'utf8');
const APPEND_SRC = fs.readFileSync(path.join(ROOT, 'api/sheet/append.js'), 'utf8');
const GETEXP_SRC = fs.readFileSync(path.join(ROOT, 'api/sheet/getExpenses.js'), 'utf8');

let PASS = 0, FAIL = 0;
const FAILED = [];
function ok(label, cond, detail) {
  if (cond) { PASS++; console.log('  PASS ' + label); }
  else { FAIL++; FAILED.push(label); console.log('  FAIL ' + label + (detail !== undefined ? '  --- ' + detail : '')); }
}

// ── balanced-brace extractor for hoisted `function name(...) { ... }` decls ──
// Same walker as tests/test_weekly_question_cron.js (and bot/test_isolation.js):
// match the declaration, balance the param parens, then balance the body braces.
// EXTENSION: these handlers + their kv* helpers are `async function`, so we
// include a leading `async ` keyword when present (the cron helpers were plain
// sync `function` decls, so the upstream copy never had to). Dropping `async`
// would leave `await` at sync-function scope and fail to parse.
function extractFn(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  // Absorb a directly-preceding `async ` (and only that) so async fns keep it.
  const ASYNC = 'async ';
  if (src.slice(start - ASYNC.length, start) === ASYNC) start -= ASYNC.length;
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}

// ────────────────────────────────────────────────────────────────────────────
// Shared in-memory KV + mocked global.fetch emulating Upstash REST + the three
// external HTTP boundaries the handlers may touch (Google tokeninfo, Meta send,
// Google Sheets read). One world per scenario => zero cross-test contamination.
// ────────────────────────────────────────────────────────────────────────────
function makeWorld() {
  const store = new Map();           // KV: key -> raw JSON string (as Upstash stores it)
  const sheetWrites = [];            // every appendRowToUserSheet call (sheet writer stub)
  const sheetRows = new Map();       // spreadsheetId -> array-of-rows the Sheets read returns
  const sentWhatsApp = [];           // Meta graph sends
  const tokeninfo = new Map();       // access token -> { sub } (Google tokeninfo stub)

  // Upstash REST shape: /get/<key>, /set/<key>[?EX=..|?NX=true], /del/<key>.
  // Mirrors makeWorld() in tests/test_morning_nudge_cron.js.
  global.fetch = async (url, opts = {}) => {
    url = String(url);

    // --- Google tokeninfo (verifyAccessToken in link.js) ---
    if (url.includes('oauth2.googleapis.com/tokeninfo')) {
      const m = url.match(/access_token=([^&]+)/);
      const tok = m ? decodeURIComponent(m[1]) : '';
      const info = tokeninfo.get(tok);
      if (!info) return { ok: false, status: 401, json: async () => ({ error: 'invalid_token' }) };
      return { ok: true, status: 200, json: async () => info };
    }

    // --- Meta WhatsApp send (sendWelcomeWhatsApp in link.js) ---
    if (url.includes('graph.facebook.com')) {
      const b = opts.body ? JSON.parse(opts.body) : {};
      sentWhatsApp.push({ to: b.to, body: b.text && b.text.body });
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.welcome' }] }), text: async () => '' };
    }

    // --- Google Sheets values read (fetchSheetRange in getExpenses.js) ---
    if (url.includes('sheets.googleapis.com')) {
      // .../spreadsheets/<id>/values/<range>
      const m = url.match(/spreadsheets\/([^/]+)\/values\//);
      const sid = m ? decodeURIComponent(m[1]) : '';
      const values = sheetRows.get(sid) || null;
      if (values === null) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ values }) };
    }

    // --- Upstash KV ---
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const op = parts[0];
    const key = decodeURIComponent(parts.slice(1).join('/'));
    if (op === 'get') {
      const v = store.has(key) ? store.get(key) : null;
      return { ok: true, status: 200, json: async () => ({ result: v }) };
    }
    if (op === 'set') {
      const nx = u.searchParams.get('NX') === 'true' || u.searchParams.get('nx') === 'true';
      if (nx && store.has(key)) {
        // Upstash returns { result: null } when NX set is a no-op (key exists).
        return { ok: true, status: 200, json: async () => ({ result: null }) };
      }
      store.set(key, opts.body); // body is already a JSON string from the helper
      return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
    }
    if (op === 'del') { store.delete(key); return { ok: true, status: 200, json: async () => ({ result: 1 }) }; }
    throw new Error('unmocked fetch: ' + url);
  };

  return { store, sheetWrites, sheetRows, sentWhatsApp, tokeninfo,
    kvObj(key) { return store.has(key) ? JSON.parse(store.get(key)) : null; },
    kvKeys() { return [...store.keys()]; } };
}

// A res() double that records the last status + json body.
function mkRes() {
  return {
    _status: 0, _json: undefined, _headers: {},
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
    send(p) { this._json = p; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
    getHeader(k) { return this._headers[k]; },
  };
}

// ── Collaborator stubs shared by all three handlers ──────────────────────────
// `log` is a no-op sink. rateLimit/rateLimitId always allow (the dedicated
// rate-limit suites already cover those paths). constantTimeEqual is a faithful
// constant-shape equality. computeEntitlement is irrelevant to routing here.
function makeStubs(world, { sessionSub = null } = {}) {
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const rateLimit = async () => ({ ok: true });
  const rateLimitId = async () => ({ ok: true, count: 1 });
  const constantTimeEqual = (a, b) => String(a).length === String(b).length && String(a) === String(b);
  const computeEntitlement = (rec) => ({
    effectivePlan: (rec && rec.plan) || 'free', rawPlan: (rec && rec.plan) || 'free',
    premium: false, status: 'none', trial: { daysLeft: 0 },
  });
  // Session: getUserId/requireUser read a verified cookie in prod; here the
  // scenario decides who (if anyone) is signed in.
  const getUserId = () => sessionSub;
  const requireUser = (req, res) => {
    if (!sessionSub) { res.status(401).json({ error: 'unauthorized' }); return null; }
    return sessionSub;
  };
  // Sheet writer: records the write target so isolation can be asserted, and
  // returns a deterministic rowIndex. NEVER touches a network.
  const appendRowToUserSheet = async ({ userRecord, row }) => {
    world.sheetWrites.push({ userSub: userRecord.userSub, spreadsheetId: userRecord.spreadsheetId, row });
    return { ok: true, rowIndex: "'תנועות'!A" + (world.sheetWrites.length + 1) };
  };
  const buildExpenseRow = (e) => [e.date || '', e.amount, e.category || '', e.subcategory || '', e.rawText || ''];
  const recordExpenseActivity = async () => {};
  const decryptRefreshToken = () => 'decrypted-refresh-token';
  const exchangeRefreshForAccess = async () => ({ accessToken: 'fresh-access', expiresIn: 3600 });
  // Redirect target for the handlers' three `await import(...)` sites.
  const __mi = async (which) => {
    if (which === 'crypto') return { constantTimeEqual };
    if (which === 'error-alert') return { alertOwnerOfClientError() {} };
    if (which === 'alert') return { sendAlert: async () => ({ ok: true }) };
    if (which === 'sheet-quota') return { recordSheetCall() {} };
    return {};
  };
  return { log, rateLimit, rateLimitId, constantTimeEqual, computeEntitlement,
    getUserId, requireUser, appendRowToUserSheet, buildExpenseRow,
    recordExpenseActivity, decryptRefreshToken, exchangeRefreshForAccess, __mi };
}

// Rewrite the literal `await import('.../<lib>.js')` calls to `await __mi('<lib>')`
// so the handler's control flow is preserved without ESM-importing any api file.
function redirectDynamicImports(src) {
  return src
    .replace(/await import\(\s*['"][^'"]*\/crypto\.js['"]\s*\)/g, "await __mi('crypto')")
    .replace(/await import\(\s*['"][^'"]*\/error-alert\.js['"]\s*\)/g, "await __mi('error-alert')")
    .replace(/await import\(\s*['"][^'"]*\/alert\.js['"]\s*\)/g, "await __mi('alert')")
    .replace(/await import\(\s*['"][^'"]*\/sheet-quota\.js['"]\s*\)/g, "await __mi('sheet-quota')");
}

// ── Build each REAL handler from source, with collaborators injected ─────────
// We assemble: file-local helpers (extracted verbatim) + handlerImpl, then
// `return handlerImpl`. The REAL kv* helpers go through the injected mocked
// fetch + the KV env, so they exercise production NX/TTL/del behaviour.
const KV_ENV = "process.env.KV_REST_API_URL='http://kv.local';process.env.KV_REST_API_TOKEN='kvtok';\n";

function buildLinkHandler(stubs) {
  const src = redirectDynamicImports(LINK_SRC);
  const body =
    KV_ENV +
    extractFn(src, 'sendWelcomeWhatsApp') + '\n' +
    extractFn(src, 'verifyAccessToken') + '\n' +
    extractFn(src, 'kvGet') + '\n' +
    extractFn(src, 'kvSet') + '\n' +
    extractFn(src, 'kvSetNX') + '\n' +
    extractFn(src, 'kvDel') + '\n' +
    extractFn(src, 'normalizeE164') + '\n' +
    extractFn(src, 'gen6DigitCode') + '\n' +
    extractFn(src, 'handlerImpl') + '\n' +
    'return handlerImpl;';
  return new Function(
    'log', 'rateLimit', 'computeEntitlement', 'getUserId', 'constantTimeEqual', '__mi', 'crypto',
    body
  )(stubs.log, stubs.rateLimit, stubs.computeEntitlement, stubs.getUserId, stubs.constantTimeEqual, stubs.__mi, globalThis.crypto);
}

function buildAppendHandler(stubs) {
  const src = redirectDynamicImports(APPEND_SRC);
  const body =
    KV_ENV +
    extractFn(src, 'kvGet') + '\n' +
    extractFn(src, 'kvSet') + '\n' +
    extractFn(src, 'normalizeE164') + '\n' +
    // The module-scope sheetwriters cache lives outside handlerImpl; provide a
    // fresh Map per build so the anomaly detector starts cold each scenario.
    'const _swCache = new Map();\n' +
    extractFn(src, 'handlerImpl') + '\n' +
    'return handlerImpl;';
  return new Function(
    'log', 'rateLimitId', 'appendRowToUserSheet', 'buildExpenseRow', 'recordExpenseActivity', '__mi',
    body
  )(stubs.log, stubs.rateLimitId, stubs.appendRowToUserSheet, stubs.buildExpenseRow, stubs.recordExpenseActivity, stubs.__mi);
}

function buildGetExpensesHandler(stubs) {
  const src = redirectDynamicImports(GETEXP_SRC);
  const body =
    KV_ENV +
    "const TX_TAB = 'תנועות';\n" +
    extractFn(src, 'kvGet') + '\n' +
    extractFn(src, 'kvSet') + '\n' +
    extractFn(src, 'refreshAccessToken') + '\n' +
    extractFn(src, 'fetchSheetRange') + '\n' +
    extractFn(src, 'parseDateCell') + '\n' +
    extractFn(src, 'isInCurrentMonth') + '\n' +
    extractFn(src, 'handlerImpl') + '\n' +
    'return handlerImpl;';
  return new Function(
    'requireUser', 'decryptRefreshToken', 'exchangeRefreshForAccess', '__mi',
    body
  )(stubs.requireUser, stubs.decryptRefreshToken, stubs.exchangeRefreshForAccess, stubs.__mi);
}

// ── Convenience request builders ─────────────────────────────────────────────
function reqMintPOST(body) {
  return { method: 'POST', query: {}, headers: {}, body, reqId: 't', socket: {} };
}
function reqConfirmPOST(body, botSecret) {
  const headers = {};
  if (botSecret !== undefined) headers['x-kesefle-bot-secret'] = botSecret;
  return { method: 'POST', query: { action: 'confirm' }, headers, body, reqId: 't', socket: {} };
}
function reqAppendPOST(body, botSecret) {
  const headers = {};
  if (botSecret !== undefined) headers['x-kesefle-bot-secret'] = botSecret;
  return { method: 'POST', query: {}, headers, body, reqId: 't', socket: {} };
}
function reqGetExpenses() {
  return { method: 'GET', query: {}, headers: {}, reqId: 't', socket: {} };
}

const BOT_SECRET = 'unit-bot-secret';

// A canonical onboarded-user seed: account record + provisioned sheet. The bot
// later attaches phone:E164 -> userSub during confirm.
function seedUser(world, sub, { email, sheetId } = {}) {
  world.store.set('user:' + sub, JSON.stringify({
    userSub: sub, email: email || (sub + '@example.com'), plan: 'free',
    spreadsheetId: sheetId, spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + sheetId + '/edit',
    refreshTokenEnvelope: 'env(' + sub + ')',
  }));
  world.store.set('sheet:' + sub, JSON.stringify({
    spreadsheetId: sheetId, spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/' + sheetId + '/edit',
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// 1. HAPPY PATH — full new-user chain, end to end.
// ════════════════════════════════════════════════════════════════════════════
async function happyPath() {
  console.log('\n=== 1. HAPPY PATH (sign-in -> mint -> confirm -> append -> getExpenses) ===\n');
  process.env.KESEFLE_BOT_SECRET = BOT_SECRET;
  // The welcome-WhatsApp send (sendWelcomeWhatsApp) requires Meta creds AND is
  // fire-and-forget; set the creds so it reaches our mocked graph endpoint, and
  // we drain the event loop after confirm so the un-awaited promise resolves.
  process.env.META_ACCESS_TOKEN = 'meta-tok';
  process.env.META_PHONE_NUMBER_ID = '100';
  const world = makeWorld();
  const SUB = 'google:newuser-1';
  const PHONE = '972501112222';
  const SHEET = 'SHEET_NEWUSER_1';
  seedUser(world, SUB, { email: 'newuser@example.com', sheetId: SHEET });

  // (a) Mint a code. User is signed in (session cookie -> SUB), submits phone.
  const mintHandler = buildLinkHandler(makeStubs(world, { sessionSub: SUB }));
  const mintRes = mkRes();
  await mintHandler(reqMintPOST({ phone: PHONE }), mintRes);
  ok('mint: 200', mintRes._status === 200, mintRes._status);
  ok('mint: returns a 6-digit code', /^\d{6}$/.test(String(mintRes._json && mintRes._json.code)), mintRes._json && mintRes._json.code);
  const code = mintRes._json.code;
  ok('mint: linkCode:<code> stored with userSub binding', (world.kvObj('linkCode:' + code) || {}).userSub === SUB);
  ok('mint: code bound to the entered phone', (world.kvObj('linkCode:' + code) || {}).phone === PHONE);
  ok('mint: phone NOT yet linked (no phone:<E164> until confirm)', world.kvObj('phone:' + PHONE) === null);

  // (b) Bot confirms with the code (bot-secret authed).
  const confirmHandler = buildLinkHandler(makeStubs(world, { sessionSub: null }));
  const confRes = mkRes();
  await confirmHandler(reqConfirmPOST({ code, phone: PHONE }, BOT_SECRET), confRes);
  ok('confirm: 200', confRes._status === 200, confRes._status);
  ok('confirm: resolves to the right userSub', confRes._json && confRes._json.userSub === SUB, confRes._json && confRes._json.userSub);
  ok('confirm: writes phone:<E164> -> userSub permanently', (world.kvObj('phone:' + PHONE) || {}).userSub === SUB);
  ok('confirm: phone record carries the canonical sheet id', (world.kvObj('phone:' + PHONE) || {}).spreadsheetId === SHEET);
  ok('confirm: reverse userPhone:<sub> mapping written', (world.kvObj('userPhone:' + SUB) || {}).phone === PHONE);
  ok('confirm: linkCode consumed (single-use)', world.kvObj('linkCode:' + code) === null);
  // Drain microtasks/timers so the un-awaited welcome send completes.
  await new Promise(r => setImmediate(r));
  ok('confirm: welcome WhatsApp sent to the new phone', world.sentWhatsApp.some(m => m.to === PHONE), JSON.stringify(world.sentWhatsApp));

  // (c) Bot appends a tenant expense row.
  const appendHandler = buildAppendHandler(makeStubs(world));
  const appRes = mkRes();
  await appendHandler(reqAppendPOST({ phone: PHONE, amount: 245, category: 'מזון', subcategory: 'סופר', rawText: '245 סופר רמי לוי' }, BOT_SECRET), appRes);
  ok('append: 200', appRes._status === 200, appRes._status);
  ok('append: rowIndex returned', !!(appRes._json && appRes._json.rowIndex), appRes._json && appRes._json.rowIndex);
  ok('append: wrote to THIS user only', world.sheetWrites.length === 1 && world.sheetWrites[0].userSub === SUB);
  ok('append: wrote to the user-owned sheet', world.sheetWrites[0].spreadsheetId === SHEET);

  // (d) Dashboard read for the same signed-in user. Sheet returns one row.
  world.sheetRows.set(SHEET, [
    ['תאריך', 'סכום', 'מטבע', 'הערות', 'קטגוריה', 'פירוט', 'תת', 'מי'],
    [new Date().toISOString().slice(0, 10), '245', 'ILS', '', 'מזון', '245 סופר רמי לוי', 'סופר', ''],
  ]);
  world.store.set('token:' + SUB, JSON.stringify({ sheetId: SHEET, accessToken: 'live', expiry: Date.now() + 3600 * 1000, refreshTokenEnvelope: 'env' }));
  const getExpHandler = buildGetExpensesHandler(makeStubs(world, { sessionSub: SUB }));
  const geRes = mkRes();
  await getExpHandler(reqGetExpenses(), geRes);
  ok('getExpenses: 200', geRes._status === 200, geRes._status);
  ok('getExpenses: returns the appended expense', geRes._json && geRes._json.count === 1 && geRes._json.rows[0].amount === 245, JSON.stringify(geRes._json));
  ok('getExpenses: total-this-month reflects the row', geRes._json && geRes._json.totalThisMonth === 245, geRes._json && geRes._json.totalThisMonth);
}

// ════════════════════════════════════════════════════════════════════════════
// 2. FAILURE PATHS
// ════════════════════════════════════════════════════════════════════════════
async function failurePaths() {
  console.log('\n=== 2. FAILURE PATHS (401 not-signed-in / 404 bad code / 409 phone taken) ===\n');
  process.env.KESEFLE_BOT_SECRET = BOT_SECRET;

  // 2a. NOT SIGNED IN -> mint refuses with 401 (no session cookie, no token).
  {
    const world = makeWorld();
    const handler = buildLinkHandler(makeStubs(world, { sessionSub: null }));
    const res = mkRes();
    await handler(reqMintPOST({ phone: '972500000000' }), res);
    ok('mint: not-signed-in -> 401', res._status === 401, res._status);
    ok('mint: 401 carries not_signed_in error', res._json && res._json.error === 'not_signed_in', res._json && res._json.error);
    ok('mint: no code minted when unauthenticated', !res._json || !res._json.code);
  }

  // 2b. EXPIRED / INVALID CODE -> confirm 404. (TTL expiry == key absent in KV.)
  {
    const world = makeWorld();
    const handler = buildLinkHandler(makeStubs(world, { sessionSub: null }));
    const res = mkRes();
    await handler(reqConfirmPOST({ code: '123456', phone: '972500000001' }, BOT_SECRET), res);
    ok('confirm: unknown/expired code -> 404', res._status === 404, res._status);
    ok('confirm: 404 carries code_expired_or_invalid', res._json && res._json.error === 'code_expired_or_invalid', res._json && res._json.error);
    ok('confirm: no phone mapping written for a bad code', world.kvObj('phone:972500000001') === null);
  }

  // 2c. PHONE ALREADY LINKED TO A DIFFERENT ACCOUNT -> confirm 409 (atomic claim lost).
  {
    const world = makeWorld();
    const PHONE = '972502223333';
    const OWNER_SUB = 'google:owns-phone';
    const ATTACKER_SUB = 'google:wants-phone';
    seedUser(world, OWNER_SUB, { sheetId: 'SHEET_OWNER' });
    seedUser(world, ATTACKER_SUB, { sheetId: 'SHEET_ATTACKER' });
    // Phone already owned by OWNER_SUB.
    world.store.set('phone:' + PHONE, JSON.stringify({ userSub: OWNER_SUB, spreadsheetId: 'SHEET_OWNER' }));
    // Attacker mints a code for the SAME phone... mint itself should pre-reject 409.
    const mintRes = mkRes();
    await buildLinkHandler(makeStubs(world, { sessionSub: ATTACKER_SUB }))(reqMintPOST({ phone: PHONE }), mintRes);
    ok('mint: phone owned by another account -> pre-rejected 409', mintRes._status === 409, mintRes._status);
    ok('mint: 409 carries phone_already_linked_to_another_account', mintRes._json && mintRes._json.error === 'phone_already_linked_to_another_account', mintRes._json && mintRes._json.error);

    // Even if a stale code for the attacker existed, confirm must 409 (claim lost).
    world.store.set('linkCode:654321', JSON.stringify({ userSub: ATTACKER_SUB, phone: PHONE }));
    const confRes = mkRes();
    await buildLinkHandler(makeStubs(world))(reqConfirmPOST({ code: '654321', phone: PHONE }, BOT_SECRET), confRes);
    ok('confirm: phone already linked elsewhere -> 409', confRes._status === 409, confRes._status);
    ok('confirm: 409 carries phone_already_linked_to_another_account', confRes._json && confRes._json.error === 'phone_already_linked_to_another_account', confRes._json && confRes._json.error);
    ok('confirm: original owner mapping is UNCHANGED', (world.kvObj('phone:' + PHONE) || {}).userSub === OWNER_SUB);
  }

  // 2d. CONFIRM without the bot secret -> 401 (only the bot may write mappings).
  {
    const world = makeWorld();
    world.store.set('linkCode:777888', JSON.stringify({ userSub: 'google:x', phone: '972503334444' }));
    const res = mkRes();
    await buildLinkHandler(makeStubs(world))(reqConfirmPOST({ code: '777888', phone: '972503334444' }, undefined), res);
    ok('confirm: missing bot secret -> 401', res._status === 401, res._status);
    ok('confirm: 401 carries unauthorized', res._json && res._json.error === 'unauthorized', res._json && res._json.error);
    ok('confirm: no mapping written without the secret', world.kvObj('phone:972503334444') === null);
  }

  // 2e. CODE BOUND TO A DIFFERENT PHONE than the one confirming -> 409.
  // (Shoulder-surfed code: a different handset must not hijack the account.)
  {
    const world = makeWorld();
    seedUser(world, 'google:victim', { sheetId: 'SHEET_VICTIM' });
    world.store.set('linkCode:246810', JSON.stringify({ userSub: 'google:victim', phone: '972504445555' }));
    const res = mkRes();
    await buildLinkHandler(makeStubs(world))(reqConfirmPOST({ code: '246810', phone: '972509998888' }, BOT_SECRET), res);
    ok('confirm: code presented from a different phone -> 409', res._status === 409, res._status);
    ok('confirm: 409 carries code_bound_to_different_phone', res._json && res._json.error === 'code_bound_to_different_phone', res._json && res._json.error);
    ok('confirm: no phone mapping for the wrong handset', world.kvObj('phone:972509998888') === null);
  }

  // 2f. APPEND for a phone that was never linked -> 404 no_user_for_phone.
  {
    const world = makeWorld();
    const res = mkRes();
    await buildAppendHandler(makeStubs(world))(reqAppendPOST({ phone: '972505556666', amount: 50, category: 'קפה' }, BOT_SECRET), res);
    ok('append: unlinked phone -> 404 no_user_for_phone', res._status === 404 && res._json.error === 'no_user_for_phone', res._status + '/' + (res._json && res._json.error));
    ok('append: nothing written to any sheet for an unlinked phone', world.sheetWrites.length === 0);
  }

  // 2g. getExpenses while NOT signed in -> 401 (requireUser).
  {
    const world = makeWorld();
    const res = mkRes();
    await buildGetExpensesHandler(makeStubs(world, { sessionSub: null }))(reqGetExpenses(), res);
    ok('getExpenses: not-signed-in -> 401', res._status === 401, res._status);
    ok('getExpenses: 401 carries unauthorized', res._json && res._json.error === 'unauthorized', res._json && res._json.error);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 3. TENANT ISOLATION — a phone resolves ONLY to its own user:{sub} sheet, and
//    an append NEVER crosses tenants, even under a poisoned phone-record pointer.
// ════════════════════════════════════════════════════════════════════════════
async function tenantIsolation() {
  console.log('\n=== 3. TENANT ISOLATION (per-tenant routing; no cross-tenant write/read) ===\n');
  process.env.KESEFLE_BOT_SECRET = BOT_SECRET;

  // Two fully-distinct onboarded tenants.
  const world = makeWorld();
  const A = { sub: 'google:tenantA', phone: '972511111111', sheet: 'SHEET_A' };
  const B = { sub: 'google:tenantB', phone: '972522222222', sheet: 'SHEET_B' };
  seedUser(world, A.sub, { email: 'a@ex.com', sheetId: A.sheet });
  seedUser(world, B.sub, { email: 'b@ex.com', sheetId: B.sheet });

  // Each onboards independently (mint + confirm), establishing phone -> sub.
  for (const T of [A, B]) {
    const mintRes = mkRes();
    await buildLinkHandler(makeStubs(world, { sessionSub: T.sub }))(reqMintPOST({ phone: T.phone }), mintRes);
    const code = mintRes._json.code;
    const confRes = mkRes();
    await buildLinkHandler(makeStubs(world))(reqConfirmPOST({ code, phone: T.phone }, BOT_SECRET), confRes);
    ok('isolation: ' + T.sub + ' linked to its own sheet', (world.kvObj('phone:' + T.phone) || {}).spreadsheetId === T.sheet);
  }

  // A's phone resolves ONLY to A; B's phone resolves ONLY to B (no bleed).
  ok('isolation: phoneA -> subA only', world.kvObj('phone:' + A.phone).userSub === A.sub && world.kvObj('phone:' + A.phone).userSub !== B.sub);
  ok('isolation: phoneB -> subB only', world.kvObj('phone:' + B.phone).userSub === B.sub && world.kvObj('phone:' + B.phone).userSub !== A.sub);

  // Interleaved appends: each phone writes ONLY to its own sheet/sub.
  const appendA = buildAppendHandler(makeStubs(world));
  const appendB = buildAppendHandler(makeStubs(world));
  await appendA(reqAppendPOST({ phone: A.phone, amount: 100, category: 'מזון' }, BOT_SECRET), mkRes());
  await appendB(reqAppendPOST({ phone: B.phone, amount: 200, category: 'תחבורה' }, BOT_SECRET), mkRes());
  await appendA(reqAppendPOST({ phone: A.phone, amount: 300, category: 'בילויים' }, BOT_SECRET), mkRes());
  const writesA = world.sheetWrites.filter(w => w.userSub === A.sub);
  const writesB = world.sheetWrites.filter(w => w.userSub === B.sub);
  ok('isolation: A wrote 2 rows, all to SHEET_A', writesA.length === 2 && writesA.every(w => w.spreadsheetId === A.sheet));
  ok('isolation: B wrote 1 row, to SHEET_B', writesB.length === 1 && writesB.every(w => w.spreadsheetId === B.sheet));
  ok('isolation: NO write landed on the other tenant sheet',
    !world.sheetWrites.some(w => (w.userSub === A.sub && w.spreadsheetId === B.sheet) || (w.userSub === B.sub && w.spreadsheetId === A.sheet)));

  // POISONED phone-record pointer: phoneA's cached sheet is tampered to point at
  // B's sheet, while the canonical sheet:{subA} still says SHEET_A. append.js
  // MUST abort with 409 sheet_ownership_mismatch rather than write into B.
  {
    const poisoned = world.kvObj('phone:' + A.phone);
    poisoned.spreadsheetId = B.sheet; // attacker/corruption flips the cached pointer
    world.store.set('phone:' + A.phone, JSON.stringify(poisoned));
    const before = world.sheetWrites.length;
    const res = mkRes();
    await buildAppendHandler(makeStubs(world))(reqAppendPOST({ phone: A.phone, amount: 999, category: 'מזון' }, BOT_SECRET), res);
    ok('isolation: poisoned phone pointer -> 409 sheet_ownership_mismatch',
      res._status === 409 && res._json.error === 'sheet_ownership_mismatch', res._status + '/' + (res._json && res._json.error));
    ok('isolation: the cross-tenant write was BLOCKED (no new sheet write)', world.sheetWrites.length === before);
    ok('isolation: nothing was written into tenant B sheet by tenant A',
      !world.sheetWrites.some(w => w.userSub === A.sub && w.spreadsheetId === B.sheet));
  }

  // Dashboard read is scoped by SESSION, not by phone: signed-in A reads A's
  // sheet rows; it can never read B's rows even though both exist in the world.
  world.sheetRows.set(A.sheet, [
    ['תאריך', 'סכום', 'מטבע', 'הערות', 'קטגוריה', 'פירוט'],
    [new Date().toISOString().slice(0, 10), '100', 'ILS', '', 'מזון', 'A-only row'],
  ]);
  world.sheetRows.set(B.sheet, [
    ['תאריך', 'סכום', 'מטבע', 'הערות', 'קטגוריה', 'פירוט'],
    [new Date().toISOString().slice(0, 10), '200', 'ILS', '', 'תחבורה', 'B-only row'],
  ]);
  world.store.set('token:' + A.sub, JSON.stringify({ sheetId: A.sheet, accessToken: 'liveA', expiry: Date.now() + 3600e3, refreshTokenEnvelope: 'env' }));
  world.store.set('token:' + B.sub, JSON.stringify({ sheetId: B.sheet, accessToken: 'liveB', expiry: Date.now() + 3600e3, refreshTokenEnvelope: 'env' }));

  const geA = mkRes();
  await buildGetExpensesHandler(makeStubs(world, { sessionSub: A.sub }))(reqGetExpenses(), geA);
  ok('isolation: signed-in A reads ONLY A rows', geA._json && geA._json.count === 1 && /A-only/.test(geA._json.rows[0].description), JSON.stringify(geA._json && geA._json.rows));
  ok('isolation: A read does not surface B data', !(geA._json && geA._json.rows.some(r => /B-only/.test(r.description))));

  const geB = mkRes();
  await buildGetExpensesHandler(makeStubs(world, { sessionSub: B.sub }))(reqGetExpenses(), geB);
  ok('isolation: signed-in B reads ONLY B rows', geB._json && geB._json.count === 1 && /B-only/.test(geB._json.rows[0].description), JSON.stringify(geB._json && geB._json.rows));
  ok('isolation: B read does not surface A data', !(geB._json && geB._json.rows.some(r => /A-only/.test(r.description))));
}

// ── runner ───────────────────────────────────────────────────────────────────
(async function main() {
  console.log('\ntests/test_onboarding_e2e.js — new-user onboarding end-to-end (offline)\n');
  // Snapshot/restore the bits we mutate so the suite is side-effect-free for
  // any harness that loads multiple suites in one process.
  const savedFetch = global.fetch;
  const savedEnv = {
    KESEFLE_BOT_SECRET: process.env.KESEFLE_BOT_SECRET,
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN,
    META_PHONE_NUMBER_ID: process.env.META_PHONE_NUMBER_ID,
  };
  try {
    await happyPath();
    await failurePaths();
    await tenantIsolation();
  } catch (e) {
    console.error('\nUNCAUGHT: ' + (e && e.stack ? e.stack : e));
    FAIL++; FAILED.push('uncaught: ' + (e && e.message));
  } finally {
    global.fetch = savedFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  console.log('\n' + (FAIL === 0
    ? 'PASS  all ' + PASS + ' checks passed'
    : 'FAIL  ' + FAIL + ' failed (' + FAILED.join('; ') + '), ' + PASS + ' passed'));
  process.exit(FAIL === 0 ? 0 : 1);
})();
