// tests/test_morning_nudge_cron.js
//
// Behavioral test for api/cron/morning-nudge.js. Mocks global.fetch to
// emulate Upstash KV (get/smembers/set?nx/del) + the Meta Graph send, then
// drives the real exported handler. Each scenario gets a FRESH KV store so
// there is no cross-scenario state contamination.
//
// Run: node tests/test_morning_nudge_cron.js
//
// Asserts:
//   * auth: wrong CRON_SECRET -> 401
//   * kill switch KESEFLE_DISABLE_NUDGE=1 -> no send
//   * opt-out user is skipped (optout:{phone})
//   * first send in a calendar month is the FULL guide
//   * a later send (after the 3-day gap clears) is a SHORT tip
//   * idempotency: a same-window re-run sends nothing (3-day SETNX gate)
//   * env-fail-soft: Meta send failure is counted, gate keys rolled back
//   * dry-run sends nothing and claims no gate keys

import process from 'node:process';

const HANDLER_PATH = new URL('../api/cron/morning-nudge.js', import.meta.url);

function installEnv() {
  process.env.KV_REST_API_URL = 'http://kv.local';
  process.env.KV_REST_API_TOKEN = 'kvtok';
  process.env.CRON_SECRET = 'cronsecret';
  process.env.META_ACCESS_TOKEN = 'metatok';
  process.env.META_PHONE_NUMBER_ID = '123';
  delete process.env.KESEFLE_DISABLE_NUDGE;
}

// Build a fresh mock world (KV store + Meta capture) and install global.fetch.
function makeWorld({ metaUp = true } = {}) {
  const store = new Map();
  const sent = [];
  const world = { store, sent, set metaUp(v) { metaUp = v; }, get metaUp() { return metaUp; } };
  global.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes('graph.facebook.com')) {
      if (!metaUp) return { ok: false, status: 500, text: async () => 'down', json: async () => ({}) };
      const b = JSON.parse(opts.body);
      sent.push({ to: b.to, body: b.text.body });
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'mid_' + sent.length }] }) };
    }
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const op = parts[0];
    const key = decodeURIComponent(parts.slice(1).join('/'));
    if (op === 'get') {
      const v = store.has(key) ? store.get(key) : null;
      return { ok: true, json: async () => ({ result: v }) };
    }
    if (op === 'smembers') {
      return { ok: true, json: async () => ({ result: store.get(key) || [] }) };
    }
    if (op === 'set') {
      const nx = u.searchParams.get('nx') === 'true';
      if (nx && store.has(key)) return { ok: true, json: async () => ({ result: null }) };
      store.set(key, JSON.parse(opts.body));
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (op === 'del') { store.delete(key); return { ok: true, json: async () => ({ result: 1 }) }; }
    throw new Error('unmocked KV op: ' + op);
  };
  return world;
}

function seedUsers(store) {
  store.set('users_all', ['google:subA', 'google:subB']);
  store.set('user:google:subA', JSON.stringify({ name: 'דני כהן', phoneE164: '+972500000001' }));
  store.set('user:google:subB', JSON.stringify({ name: 'רותי', phoneE164: '+972500000002' }));
}

function mkReq(query = {}) {
  return { headers: { authorization: 'Bearer cronsecret' }, query, url: '/api/cron/morning-nudge', reqId: 't' };
}
function mkRes() {
  return {
    _s: 200, _j: null,
    setHeader() {},
    status(s) { this._s = s; return this; },
    json(j) { this._j = j; return j; },
  };
}

let PASS = 0, FAIL = 0;
function ok(name, cond) {
  if (cond) { PASS++; console.log('  ✅ ' + name); }
  else { FAIL++; console.log('  ❌ ' + name); }
}

async function load() {
  // Fresh import each scenario so module-level env reads (none here, but safe)
  // and any caching can't bleed across scenarios.
  const mod = await import(HANDLER_PATH.href + '?t=' + Date.now());
  return mod.default;
}

async function main() {
  installEnv();
  console.log('══ morning-nudge cron ══');

  // 1. First run in the month -> subA FULL, subB opt-out skipped.
  {
    const w = makeWorld(); seedUsers(w.store);
    w.store.set('optout:+972500000002', JSON.stringify({ at: 'x' }));
    const handler = await load();
    const res = mkRes(); await handler(mkReq(), res); const r = res._j;
    ok('run1: one send total', w.sent.length === 1);
    ok('run1: it is FULL (sentFull=1)', r.sentFull === 1 && r.sentShort === 0);
    ok('run1: opt-out user skipped', r.skipped >= 1);
    ok('run1: FULL body lists fixed-expense + summary', /קבוע/.test(w.sent[0].body) && /סיכום/.test(w.sent[0].body));
    ok('run1: FULL body lists income + receipt', /הכנסה/.test(w.sent[0].body) && /קבלה/.test(w.sent[0].body));
    ok('run1: personalized first name', /דני/.test(w.sent[0].body));
    ok('run1: opt-out user got NOTHING', !w.sent.some((m) => m.to === '+972500000002'));
  }

  // 2. Idempotency: immediate re-run in same 3-day window -> no send.
  {
    const w = makeWorld(); seedUsers(w.store);
    const handler = await load();
    await handler(mkReq(), mkRes());           // first send claims nudge_last
    const before = w.sent.length;
    const res2 = mkRes(); await handler(mkReq(), res2);
    ok('run2: same-window re-run sends nothing (3-day gate)', w.sent.length === before);
    ok('run2: both users skipped', res2._j.skipped === 2 && (res2._j.sentShort + res2._j.sentFull) === 0);
  }

  // 3. After the 3-day gap clears, next send is a SHORT tip (monthly FULL used).
  {
    const w = makeWorld(); seedUsers(w.store);
    const handler = await load();
    await handler(mkReq(), mkRes());           // FULL this month
    w.store.delete('nudge_last:+972500000001');  // simulate 3+ days later
    w.store.delete('nudge_last:+972500000002');
    const res3 = mkRes(); await handler(mkReq(), res3);
    // Fresh world, no opt-out here: first run sends 2 (both FULL), then after
    // clearing the gap keys this run sends 2 more (both SHORT) -> 4 total.
    ok('run3: sends again after gap', w.sent.length === 4);
    ok('run3: those are SHORT (sentShort=2, sentFull=0)', res3._j.sentShort === 2 && res3._j.sentFull === 0);
    const last = w.sent[w.sent.length - 1];
    ok('run3: SHORT body is not the full guide', !/• הכנסה:/.test(last.body));
  }

  // 4. Env-fail-soft: Meta down -> error counted, gate keys rolled back.
  {
    const w = makeWorld({ metaUp: false }); seedUsers(w.store);
    const handler = await load();
    const res4 = mkRes(); await handler(mkReq(), res4);
    ok('run4: meta-down -> errors counted', res4._j.errors >= 1);
    ok('run4: no successful send', w.sent.length === 0);
    ok('run4: gap key rolled back (retriable later)', !w.store.has('nudge_last:+972500000001'));
    ok('run4: monthly key rolled back too', !w.store.has('nudge_full_last:+972500000001'));
  }

  // 5. Dry-run: sends nothing, claims no gate keys, still reports would-sends.
  {
    const w = makeWorld(); seedUsers(w.store);
    const handler = await load();
    const res5 = mkRes(); await handler(mkReq({ dryRun: '1' }), res5);
    ok('run5: dry-run sends nothing', w.sent.length === 0);
    ok('run5: dry-run claims no gap key', !w.store.has('nudge_last:+972500000001'));
    ok('run5: dry-run reports 2 would-send users', (res5._j.sentShort + res5._j.sentFull) === 2);
    ok('run5: dry-run would-be FULL for both (first of month)', res5._j.sentFull === 2);
  }

  // 6. Auth + kill switch.
  {
    const w = makeWorld(); seedUsers(w.store);
    const handler = await load();
    const resU = mkRes();
    await handler({ headers: { authorization: 'Bearer WRONG' }, query: {}, url: '/x' }, resU);
    ok('auth: wrong secret -> 401', resU._s === 401);

    process.env.KESEFLE_DISABLE_NUDGE = '1';
    const resK = mkRes(); await handler(mkReq(), resK);
    ok('kill switch: reason kill_switch, no send', resK._j.reason === 'kill_switch' && w.sent.length === 0);
    delete process.env.KESEFLE_DISABLE_NUDGE;
  }

  console.log('\n' + (FAIL === 0 ? '✅' : '❌') + ' morning-nudge: ' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
