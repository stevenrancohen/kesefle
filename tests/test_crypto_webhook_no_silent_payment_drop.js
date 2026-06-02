// Unit test: api/billing/crypto-webhook.js
//
// Guards the money-safety contract of the Coinbase Commerce webhook:
//   1. A confirmed charge WITH a userSub activates premium + marks the event
//      seen (idempotent).
//   2. A confirmed charge WITHOUT a resolvable userSub is NEVER dropped
//      silently — it must log.error + fire a critical owner alert, mark the
//      event seen (so retries don't re-page), and still ACK 200.
//   3. A bad HMAC signature is rejected 401.
//   4. A duplicate (already-seen) event is acked 200 without re-activating.
//
// The handler uses `config.api.bodyParser=false` and reads the raw request via
// req.on('data'/'end'), so we hand it a tiny readable-stream stub of the exact
// signed bytes. No mocking framework — real source is imported.
//
// Run: node tests/test_crypto_webhook_no_silent_payment_drop.js

import crypto from 'node:crypto';

const SECRET = 'cb-test-secret-' + Date.now();
process.env.COINBASE_WEBHOOK_SECRET = SECRET;
process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'tok';
process.env.KESEFLE_DB_KEY = Buffer.alloc(32, 7).toString('base64');

// ── Instrumentation: capture activatePremium calls + sendAlert calls ──
const activations = [];
const alerts = [];

// In-memory KV (the billing lib + handler both go through global.fetch).
const kv = new Map();

global.fetch = async (url, opts) => {
  opts = opts || {};
  const u = String(url);
  const m = u.match(/\/(get|set)\/([^?]+)/);
  if (m) {
    const key = decodeURIComponent(m[2]);
    if (m[1] === 'get') {
      return new Response(JSON.stringify({ result: kv.has(key) ? kv.get(key) : null }), { status: 200 });
    }
    kv.set(key, opts.body); // set
    return new Response('{"result":"OK"}', { status: 200 });
  }
  // Anything else (e.g. an unexpected outbound) — fail loud-ish but don't throw.
  return new Response('{}', { status: 404 });
};

// activatePremium is a named export bound at import-time inside the handler, so
// it can't be monkeypatched on the (read-only) ESM namespace after the fact.
// Instead we observe activation through its KV side effect: activatePremium
// writes user:{sub}. We assert on the resulting user record, not the call.
// sendAlert is dynamically imported INSIDE the handler, so we can swap it on the
// namespace before the handler's lazy import resolves.
const alertMod = await import('../lib/alert.js');
try {
  Object.defineProperty(alertMod, 'sendAlert', {
    value: async (a) => { alerts.push(a); return { ok: true, stubbed: true }; },
    writable: true, configurable: true,
  });
} catch (_e) {
  // If the namespace is frozen, fall back to env-gating: with no SLACK/RESEND
  // env set, the real sendAlert no-ops gracefully and still returns. We then
  // assert on the log line instead (captured below).
}

// Capture structured logs so we can assert the "confirmed_but_no_user" event
// fires even if the alert module couldn't be patched. lib/log.js routes
// error/fatal -> console.error (stderr) and info/warn -> console.log/warn
// (stdout), so we have to tap BOTH streams.
const logs = [];
function collect(chunk) {
  try {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    s.split('\n').forEach((line) => {
      if (!line.trim()) return;
      try { const o = JSON.parse(line); if (o && o.event) logs.push(o); } catch (_) {}
    });
  } catch (_) {}
}
const origWrite = process.stdout.write.bind(process.stdout);
const origErrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...rest) => { collect(chunk); return origWrite(chunk, ...rest); };
process.stderr.write = (chunk, ...rest) => { collect(chunk); return origErrWrite(chunk, ...rest); };

const { default: handler } = await import('../api/billing/crypto-webhook.js');

// ── Helpers ──────────────────────────────────────────────────────────────────
function sign(rawBuf) {
  return crypto.createHmac('sha256', SECRET).update(rawBuf).digest('hex');
}

// Minimal readable-stream stub matching what readRawBody() consumes.
function streamReq(rawStr, { signature, badSig } = {}) {
  const raw = Buffer.from(rawStr, 'utf8');
  const handlers = {};
  const sig = badSig ? 'deadbeef' : (signature || sign(raw));
  return {
    method: 'POST',
    reqId: 'test',
    headers: { 'x-cc-webhook-signature': sig },
    query: {},
    on(ev, cb) {
      handlers[ev] = cb;
      // Drive the stream synchronously on the next microtask: data then end.
      if (ev === 'end') {
        queueMicrotask(() => {
          if (handlers.data) handlers.data(raw);
          handlers.end();
        });
      }
      return this;
    },
  };
}

function res() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    send(p) { this.body = p; return this; },
    setHeader() { return this; },
  };
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); }
}

// ── 1. Confirmed charge WITH userSub activates premium ───────────────────────
console.log('\n=== confirmed WITH userSub ===\n');
{
  kv.clear(); activations.length = 0; alerts.length = 0; logs.length = 0;
  const evId = 'evt_with_user_1';
  const payload = JSON.stringify({
    event: {
      id: evId,
      type: 'charge:confirmed',
      data: { id: 'charge_1', metadata: { userSub: 'sub-abc', plan: 'pro', period: 'month' } },
    },
  });
  const r = res();
  await handler(streamReq(payload), r);
  check('acks 200', r.statusCode === 200, 'got ' + r.statusCode);
  const userRec = kv.has('user:sub-abc') ? JSON.parse(kv.get('user:sub-abc')) : null;
  check('activatePremium wrote user:sub-abc with plan=pro', !!userRec && userRec.plan === 'pro', JSON.stringify(userRec));
  check('event marked seen (idempotency key set)', kv.has('crypto_event:' + evId));
  check('logged crypto_webhook.activated', logs.some((l) => l.event === 'crypto_webhook.activated'));
}

// ── 2. Confirmed charge WITHOUT userSub must NOT be dropped silently ─────────
console.log('\n=== confirmed WITHOUT userSub (payment-loss guard) ===\n');
{
  kv.clear(); activations.length = 0; alerts.length = 0; logs.length = 0;
  const evId = 'evt_no_user_1';
  const payload = JSON.stringify({
    event: {
      id: evId,
      type: 'charge:resolved',
      data: { id: 'charge_2', metadata: { plan: 'family' } }, // no userSub / userId
    },
  });
  const r = res();
  await handler(streamReq(payload), r);
  check('acks 200 (does not 500-loop an unmappable charge)', r.statusCode === 200, 'got ' + r.statusCode);
  check('response carries no_user_in_metadata warning', r.body && r.body.warning === 'no_user_in_metadata', JSON.stringify(r.body));
  check('logged crypto_webhook.confirmed_but_no_user (breadcrumb exists)',
    logs.some((l) => l.event === 'crypto_webhook.confirmed_but_no_user'));
  const alertedViaStub = alerts.some((a) => a.severity === 'critical' && /payment/i.test(a.title || ''));
  const alertedViaLog = logs.some((l) => l.event === 'alert.fired' || l.event === 'alert.deduped');
  check('fired a critical owner alert (stub or real channel)', alertedViaStub || alertedViaLog,
    'alerts=' + JSON.stringify(alerts.map((a) => a.title)));
  check('unmappable event marked seen so retries do not re-page', kv.has('crypto_event:' + evId));
  check('NO premium granted (no user record written)',
    ![...kv.keys()].some((k) => k.startsWith('user:')), [...kv.keys()].join(','));
}

// ── 3. Bad signature rejected ────────────────────────────────────────────────
console.log('\n=== bad signature ===\n');
{
  kv.clear();
  const payload = JSON.stringify({ event: { id: 'x', type: 'charge:confirmed', data: { id: 'c', metadata: { userSub: 's' } } } });
  const r = res();
  await handler(streamReq(payload, { badSig: true }), r);
  check('rejects bad HMAC with 401', r.statusCode === 401, 'got ' + r.statusCode);
  check('no activation on bad signature', !kv.has('user:s'));
}

// ── 4. Duplicate event acked without re-activating ───────────────────────────
console.log('\n=== duplicate event ===\n');
{
  kv.clear();
  const evId = 'evt_dupe_1';
  kv.set('crypto_event:' + evId, JSON.stringify({ type: 'charge:confirmed', ts: 'earlier' }));
  const payload = JSON.stringify({
    event: { id: evId, type: 'charge:confirmed', data: { id: 'c', metadata: { userSub: 'sub-dupe', plan: 'pro' } } },
  });
  const r = res();
  await handler(streamReq(payload), r);
  check('acks 200 duplicate', r.statusCode === 200 && r.body && r.body.duplicate === evId, JSON.stringify(r.body));
  check('did NOT re-activate (no user:sub-dupe)', !kv.has('user:sub-dupe'));
}

process.stdout.write = origWrite;
process.stderr.write = origErrWrite;
console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CHECKS PASSED' : '❌ ' + fail + ' FAILED (' + pass + ' passed)'));
process.exit(fail === 0 ? 0 : 1);
