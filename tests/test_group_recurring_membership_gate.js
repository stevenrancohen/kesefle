#!/usr/bin/env node
// tests/test_group_recurring_membership_gate.js
//
// Regression test for the backend-hardening-v2 fix: the group "recurring"
// actions must honour the SAME membership gate as every other group
// read/mutate action (info / balances / recent / addexpense / addmember).
//
// Before this fix:
//   - action=addrecurring had NO membership check, so a bare KESEFLE_BOT_SECRET
//     + a valid group code let an attacker plant a recurring expense template
//     (with an attacker-chosen payerPhone) into a STRANGER's ledger -- the
//     exact cross-group injection the addexpense gate's own comment says it
//     closed.
//   - action=listrecurring returned the whole recurring list (each item
//     carries a member payerPhone == PII) to any code-holder.
//
// The fix mirrors the canonical isMemberOrCreator() gate:
//   - addrecurring: reqPhone = requesterPhone || payerPhone must be a member.
//     The live bot already sends payerPhone = the sender (resolved from the
//     sender's OWN active group), so the legit path keeps working WITHOUT a
//     bot change, while a non-member payer is rejected 403.
//   - listrecurring: backward-compatible -- enforces membership only when the
//     caller supplies requesterPhone (the live bot doesn't yet, so it must not
//     be hard-required), so a future bot update engages the gate automatically.
//
// Two layers:
//   1. BEHAVIORAL -- import the REAL api/group.js default export and drive it
//      end-to-end (through withRequestId + withRateLimit) against a mocked
//      Upstash KV over global.fetch. Asserts the actual 403/200 status codes.
//   2. STATIC -- assert the gate literals exist so a future refactor can't
//      silently drop them (matches the house tests/test_*.js convention).
//
// Run: node tests/test_group_recurring_membership_gate.js
// (auto-discovered by scripts/gauntlet.sh -- not wired into full_qa.js)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

// ── Env MUST be set before importing api/group.js ───────────────────────────
// group.js captures KV_REST_API_URL / KV_REST_API_TOKEN in module-scope const
// at load time, and reads KESEFLE_BOT_SECRET per request. The rate-limit
// wrapper also needs KV configured (it fails open otherwise, which is fine,
// but we provide it so the pipeline path is exercised too).
const BOT_SECRET = 'test-bot-secret-aaaaaaaaaaaaaaaaaaaa';
process.env.KV_REST_API_URL = 'http://kv.local';
process.env.KV_REST_API_TOKEN = 'kvtok';
process.env.KESEFLE_BOT_SECRET = BOT_SECRET;

const MEMBER_PHONE = '972500000001';   // creator + member
const OTHER_MEMBER = '972500000002';   // a second member
const ATTACKER_PHONE = '972599999999'; // NOT in the group
const CODE = 'ABCD2345';

// ── Mocked Upstash KV over global.fetch ─────────────────────────────────────
// Supports the REST verbs group.js uses: GET, SET, DEL, and the /pipeline
// (INCR + EXPIRE ... NX) the rate limiter issues. Pre-seeds a group record
// whose members are MEMBER_PHONE + OTHER_MEMBER (attacker is absent).
function installKvMock() {
  const store = new Map();
  const groupRec = {
    code: CODE,
    name: 'test',
    createdBy: MEMBER_PHONE,
    createdAt: new Date().toISOString(),
    members: [
      { phone: MEMBER_PHONE, name: 'Creator', joinedAt: new Date().toISOString() },
      { phone: OTHER_MEMBER, name: 'Member2', joinedAt: new Date().toISOString() },
    ],
    expenses: [],
    recurring: [
      { id: 'r1', payerPhone: MEMBER_PHONE, amount: 3000, description: 'rent', intervalDays: 30, intervalLabel: 'monthly', active: true },
    ],
    sheetId: null,
    sheetUrl: null,
  };
  store.set('group:' + CODE, JSON.stringify(groupRec));

  global.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const parts = u.pathname.split('/').filter(Boolean);
    const op = parts[0];

    if (op === 'pipeline') {
      // Rate limiter: [["INCR", key], ["EXPIRE", key, sec, "NX"]] -> count 1.
      return { ok: true, status: 200, json: async () => ([{ result: 1 }, { result: 1 }]) };
    }
    const key = decodeURIComponent(parts.slice(1).join('/'));
    if (op === 'get') {
      const has = store.has(key);
      return { ok: true, status: 200, json: async () => ({ result: has ? store.get(key) : null }) };
    }
    if (op === 'set') {
      // group.js set path: /set/<key> with JSON body.
      store.set(key, typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
      return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
    }
    if (op === 'del') {
      store.delete(key);
      return { ok: true, status: 200, json: async () => ({ result: 1 }) };
    }
    if (op === 'incr' || op === 'expire') {
      return { ok: true, status: 200, json: async () => ({ result: 1 }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { store, groupRec };
}

// Minimal Vercel-style res double that captures status + json body.
function makeRes() {
  const res = {
    statusCode: 200,
    _json: undefined,
    headers: {},
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    getHeader(k) { return this.headers[String(k).toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this._json = o; return this; },
    end() { return this; },
    send(o) { this._json = o; return this; },
  };
  return res;
}

function makeReq(body) {
  return {
    method: 'POST',
    url: '/api/group',
    headers: {
      'x-kesefle-bot-secret': BOT_SECRET,
      'x-forwarded-for': '203.0.113.7',
    },
    query: {},
    body,
  };
}

async function call(handler, body) {
  const req = makeReq(body);
  const res = makeRes();
  await handler(req, res);
  return res;
}

async function main() {
  console.log('\ntests/test_group_recurring_membership_gate.js\n');

  const { store } = installKvMock();
  const groupHandler = (await import('../api/group.js')).default;

  // ── 1. BEHAVIORAL ─────────────────────────────────────────────────────────
  console.log('Behavioral: addrecurring membership gate');

  // 1a. Attacker (not a member) tries to plant a recurring template -> 403.
  {
    const res = await call(groupHandler, {
      action: 'addrecurring',
      code: CODE,
      payerPhone: ATTACKER_PHONE, // attacker-chosen, NOT a member
      amount: 9999,
      description: 'attacker-injected',
      interval: 'monthly',
    });
    assert(res.statusCode === 403, 'non-member payer is rejected 403 (got ' + res.statusCode + ')');
    assert(res._json && res._json.error === 'not_a_member',
      'rejection error is "not_a_member" (got ' + JSON.stringify(res._json) + ')');
    // And it must NOT have been written to the ledger.
    const after = JSON.parse(store.get('group:' + CODE));
    const injected = (after.recurring || []).some(r => r.description === 'attacker-injected');
    assert(!injected, 'attacker recurring template was NOT persisted to the group');
  }

  // 1b. A real member (the live-bot path sends payerPhone = the sender) -> 200.
  {
    const before = JSON.parse(store.get('group:' + CODE)).recurring.length;
    const res = await call(groupHandler, {
      action: 'addrecurring',
      code: CODE,
      payerPhone: MEMBER_PHONE, // sender is a member of their own active group
      amount: 1200,
      description: 'legit-member',
      interval: 'monthly',
    });
    assert(res.statusCode === 200, 'member payer is accepted 200 (got ' + res.statusCode + ')');
    const after = JSON.parse(store.get('group:' + CODE)).recurring.length;
    assert(after === before + 1, 'member recurring template WAS persisted (len ' + before + ' -> ' + after + ')');
  }

  // 1c. requesterPhone overrides payerPhone for the gate: a member requester
  // adding on behalf is fine; an attacker requester is blocked even if
  // payerPhone names a member.
  {
    const res = await call(groupHandler, {
      action: 'addrecurring',
      code: CODE,
      requesterPhone: ATTACKER_PHONE, // the ACTUAL caller is not a member
      payerPhone: MEMBER_PHONE,       // spoofed to a member
      amount: 500,
      description: 'spoofed-payer',
      interval: 'monthly',
    });
    assert(res.statusCode === 403,
      'attacker requesterPhone is blocked even with a spoofed member payerPhone (got ' + res.statusCode + ')');
  }

  console.log('\nBehavioral: listrecurring membership gate (backward-compatible)');

  // 1d. listrecurring WITHOUT requesterPhone -> 200 (live bot does not send it).
  {
    const res = await call(groupHandler, { action: 'listrecurring', code: CODE });
    assert(res.statusCode === 200, 'listrecurring without requesterPhone stays 200 (live-bot compat)');
    assert(res._json && Array.isArray(res._json.recurring),
      'listrecurring returns the recurring array on the compat path');
  }

  // 1e. listrecurring WITH a non-member requesterPhone -> 403 (gate engages).
  {
    const res = await call(groupHandler, {
      action: 'listrecurring', code: CODE, requesterPhone: ATTACKER_PHONE,
    });
    assert(res.statusCode === 403,
      'listrecurring with a non-member requesterPhone is rejected 403 (got ' + res.statusCode + ')');
  }

  // 1f. listrecurring WITH a member requesterPhone -> 200.
  {
    const res = await call(groupHandler, {
      action: 'listrecurring', code: CODE, requesterPhone: OTHER_MEMBER,
    });
    assert(res.statusCode === 200,
      'listrecurring with a member requesterPhone is accepted 200 (got ' + res.statusCode + ')');
  }

  // Sanity: an unauthorized bot secret is still rejected (we didn't weaken auth).
  {
    const req = makeReq({ action: 'listrecurring', code: CODE });
    req.headers['x-kesefle-bot-secret'] = 'wrong-secret';
    const res = makeRes();
    await groupHandler(req, res);
    assert(res.statusCode === 401, 'wrong bot secret is still 401 (auth unchanged)');
  }

  // ── 2. STATIC ────────────────────────────────────────────────────────────
  console.log('\nStatic: gate literals present in api/group.js');
  const SRC = fs.readFileSync(path.join(ROOT, 'api/group.js'), 'utf8');

  // addrecurring uses the requesterPhone || payerPhone fallback then gates.
  assert(/group\.addrecurring\.not_member/.test(SRC),
    'addrecurring emits log.warn("group.addrecurring.not_member", ...)');
  assert(/listrecurring/.test(SRC) && /group\.listrecurring\.not_member/.test(SRC),
    'listrecurring emits log.warn("group.listrecurring.not_member", ...)');

  // The addrecurring gate must reference isMemberOrCreator with a payerPhone
  // fallback (so it can never become a hard requesterPhone-only requirement
  // that would 403 the live bot).
  const addrecBlock = SRC.slice(SRC.indexOf("case 'addrecurring'"), SRC.indexOf("case 'listrecurring'"));
  assert(/isMemberOrCreator\(\s*group\s*,\s*recReqPhone\s*\)/.test(addrecBlock),
    'addrecurring calls isMemberOrCreator(group, recReqPhone)');
  assert(/normalizeE164\(body\.requesterPhone\)\s*\|\|\s*payerPhone/.test(addrecBlock),
    'addrecurring reqPhone falls back to payerPhone (keeps live bot working)');

  // listrecurring gate must be conditional on requesterPhone being present
  // (backward-compatible -- never hard-required).
  const listrecBlock = SRC.slice(SRC.indexOf("case 'listrecurring'"), SRC.indexOf("case 'markrecurringfired'"));
  assert(/if\s*\(\s*reqPhone\s*&&\s*!isMemberOrCreator\(\s*group\s*,\s*reqPhone\s*\)\s*\)/.test(listrecBlock),
    'listrecurring only enforces membership when requesterPhone is supplied');

  console.log('');
  if (failures.length) {
    console.error('FAIL: ' + failures.length + ' assertion(s) failed');
    process.exit(1);
  }
  console.log('OK: all assertions passed');
}

main().catch((e) => {
  console.error('THREW:', e && e.stack ? e.stack : e);
  process.exit(1);
});
