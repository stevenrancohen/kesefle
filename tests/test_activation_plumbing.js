// tests/test_activation_plumbing.js
//
// Guards the "dead activation plumbing" fix (backend activation audit):
//
//   (a) The welcome email fires on signup. api/auth/google-exchange.js must
//       send the `welcome` template via lib/email.js for a NEW user, guarded so
//       it never double-sends and never blocks signup.
//
//   (b) expensesCount + lastActive get written to user:{userSub} on each
//       expense, so the lifecycle cron's day-1 / day-7 / weekly-digest /
//       inactivity gates (which READ those fields) actually fire.
//
// Two layers:
//   1. BEHAVIORAL — run the real lib/user-activity.js recordExpenseActivity()
//      against a mocked Upstash KV (global.fetch) and assert the increment,
//      timestamp, no-clobber, single-SET cost, and env-fail-soft semantics.
//   2. WIRING — string-assert the four expense handlers import + call
//      recordExpenseActivity, and that google-exchange.js sends the welcome.
//
// Run: node tests/test_activation_plumbing.js   (hooked into tests/full_qa.js)

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

// ── Mocked Upstash KV over global.fetch ─────────────────────────────────────
// Minimal GET/SET emulator + a per-op counter so we can assert KV-call cost.
function installKvMock() {
  const store = new Map();
  const ops = { get: 0, set: 0 };
  process.env.KV_REST_API_URL = 'http://kv.local';
  process.env.KV_REST_API_TOKEN = 'kvtok';
  global.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const parts = u.pathname.split('/').filter(Boolean);
    const op = parts[0];
    const key = decodeURIComponent(parts.slice(1).join('/'));
    if (op === 'get') {
      ops.get++;
      const has = store.has(key);
      return { ok: true, status: 200, json: async () => ({ result: has ? store.get(key) : null }) };
    }
    if (op === 'set') {
      ops.set++;
      store.set(key, typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
      return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { store, ops };
}

async function main() {
  console.log('\ntests/test_activation_plumbing.js\n');

  // Fresh module each scenario isn't needed — recordExpenseActivity reads
  // KV_* lazily? It captures them at import. So set env BEFORE the import.
  installKvMock();
  const { recordExpenseActivity } = await import('../lib/user-activity.js');

  // ── 1. BEHAVIORAL ─────────────────────────────────────────────────────────
  console.log('Behavioral: recordExpenseActivity()');

  // First expense: increments from absent (treated as 0) -> 1, stamps lastActive
  // + firstExpenseAt, and preserves all pre-existing fields (no clobber).
  {
    const before = {
      userSub: 'sub_alice', email: 'a@x.com', plan: 'pro',
      refreshTokenEnvelope: 'ENVELOPE', trialEndsAt: '2099-01-01',
    };
    const { store, ops } = installKvMock();
    const mod = await import('../lib/user-activity.js?one'); // fresh import: re-bind KV env
    ops.get = 0; ops.set = 0;
    const r = await mod.recordExpenseActivity({ userSub: 'sub_alice', currentRecord: before });
    assert(r.ok === true, 'returns ok:true on success');
    assert(r.expensesCount === 1, 'first expense -> expensesCount = 1');
    assert(ops.get === 0, 'does NOT issue its own GET (uses in-hand record)');
    assert(ops.set === 1, 'issues exactly ONE KV SET (no KV balloon)');
    const saved = JSON.parse(store.get('user:sub_alice'));
    assert(saved.expensesCount === 1, 'persisted expensesCount = 1');
    assert(typeof saved.lastActive === 'string' && saved.lastActive.includes('T'),
      'persisted lastActive ISO timestamp');
    assert(typeof saved.firstExpenseAt === 'string', 'persisted firstExpenseAt on first write');
    assert(saved.email === 'a@x.com' && saved.plan === 'pro', 'no-clobber: email + plan preserved');
    assert(saved.refreshTokenEnvelope === 'ENVELOPE', 'no-clobber: refresh envelope preserved');
    assert(saved.trialEndsAt === '2099-01-01', 'no-clobber: trial field preserved');
  }

  // Subsequent expense: increments existing count, keeps the ORIGINAL
  // firstExpenseAt, advances lastActive.
  {
    const before = { userSub: 'sub_bob', expensesCount: 6, firstExpenseAt: '2020-01-01T00:00:00.000Z' };
    const { store } = installKvMock();
    const mod = await import('../lib/user-activity.js?two');
    const r = await mod.recordExpenseActivity({ userSub: 'sub_bob', currentRecord: before, at: new Date('2026-06-03T10:00:00Z') });
    assert(r.expensesCount === 7, 'existing count 6 -> 7');
    const saved = JSON.parse(store.get('user:sub_bob'));
    assert(saved.firstExpenseAt === '2020-01-01T00:00:00.000Z', 'firstExpenseAt is NOT overwritten on later writes');
    assert(saved.lastActive === '2026-06-03T10:00:00.000Z', 'lastActive advances to the supplied time');
  }

  // env-fail-soft: no KV configured -> returns ok:false, never throws, no write.
  {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    const mod = await import('../lib/user-activity.js?three');
    let threw = false, res;
    try { res = await mod.recordExpenseActivity({ userSub: 'sub_c', currentRecord: {} }); }
    catch { threw = true; }
    assert(!threw, 'never throws when KV is unconfigured');
    assert(res && res.ok === false && res.reason === 'kv_unconfigured', 'reports kv_unconfigured cleanly');
  }

  // Guard: missing userSub is a clean no-op (not a crash).
  {
    installKvMock();
    const mod = await import('../lib/user-activity.js?four');
    const res = await mod.recordExpenseActivity({ currentRecord: {} });
    assert(res.ok === false && res.reason === 'no_user_sub', 'missing userSub -> ok:false no_user_sub');
  }

  // Clobber guard: a degenerate empty record (e.g. a failed upstream GET) must
  // NOT be written back — that would wipe email / plan / refresh envelope.
  {
    const { store, ops } = installKvMock();
    const mod = await import('../lib/user-activity.js?five');
    ops.set = 0;
    const res = await mod.recordExpenseActivity({ userSub: 'sub_empty', currentRecord: {} });
    assert(res.ok === false && res.reason === 'empty_record_skipped', 'empty record -> ok:false empty_record_skipped');
    assert(ops.set === 0, 'empty record -> NO KV write (no clobber)');
    assert(!store.has('user:sub_empty'), 'empty record -> nothing persisted');
  }

  // ── 2. WIRING ───────────────────────────────────────────────────────────
  console.log('\nWiring: handlers call recordExpenseActivity');
  const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  for (const f of ['api/sheet/append.js', 'api/sheet/web-append.js', 'api/whatsapp/webhook.js']) {
    const src = readSrc(f);
    assert(/import\s*\{[^}]*recordExpenseActivity[^}]*\}\s*from\s*['"][^'"]*user-activity\.js['"]/.test(src),
      f + ' imports recordExpenseActivity');
    assert(/recordExpenseActivity\(\s*\{/.test(src), f + ' calls recordExpenseActivity(...)');
    // Must reuse the already-fetched record (currentRecord), not add a fresh GET.
    assert(/currentRecord\s*:\s*userRec\b/.test(src),
      f + ' passes the already-fetched userRec (no extra KV GET)');
  }

  console.log('\nWiring: welcome email on signup');
  const EX = readSrc('api/auth/google-exchange.js');
  assert(/template\s*:\s*['"]welcome['"]/.test(EX), 'google-exchange sends the "welcome" template');
  assert(/sendTemplate/.test(EX), 'google-exchange uses sendTemplate (lib/email.js, env-fail-soft)');
  assert(/isNewUser\s*&&/.test(EX), 'welcome send is gated on isNewUser (no resend on re-login)');
  assert(/welcome_email_sent:/.test(EX), 'welcome send is KV-guarded against double-send');
  // The welcome template's three merge fields must be supplied.
  assert(/firstName/.test(EX) && /userEmail/.test(EX) && /unsubscribeUrl/.test(EX),
    'welcome vars firstName + userEmail + unsubscribeUrl are supplied');

  console.log('\nWiring: lifecycle cron still READS the now-populated fields');
  const LC = readSrc('api/cron/lifecycle.js');
  assert(/u\.expensesCount/.test(LC), 'lifecycle cron reads u.expensesCount (day-1/day-7/digest gates)');
  assert(/u\.lastActive/.test(LC), 'lifecycle cron reads u.lastActive (inactivity gate)');

  console.log('');
  if (failures.length) {
    console.error('FAIL: ' + failures.length + ' assertion(s) failed');
    process.exit(1);
  }
  console.log('OK: all assertions passed');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
