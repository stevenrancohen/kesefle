// tests/test_ratelimit_ipv6_ttl.js
//
// Regression guard for two rate-limit security fixes (security audit, 2026-06):
//
//   1. IPv6 /64 bypass — api/_lib/rateLimit.js keyed the bucket on the FULL
//      IPv6 address. An IPv6 host owns an entire /64 (2^64 addresses), so an
//      attacker rotating source addresses inside their own /64 got a fresh
//      bucket every request = effectively unlimited. Fix: key IPv6 callers on
//      the /64 prefix (first four hextets), correctly EXPANDING "::" first so
//      host bits never leak into the key. IPv4 is keyed on the full address.
//
//   2. TTL/expiry race (permanent lockout) — the old limiter did INCR, then a
//      SEPARATE fire-and-forget EXPIRE only when count===1. If that EXPIRE ever
//      failed (network blip, or process torn down between the two calls) the
//      key kept NO TTL forever: later hits see count>=2 and never re-set it, so
//      once count crossed the limit the IP/user was locked out permanently.
//      Fix: ONE pipelined round trip that ALWAYS re-asserts the TTL via
//      EXPIRE ... NX, so a bucket can never get stuck without an expiry. NX
//      never extends a live window, so it cannot be abused to lengthen a
//      throttle — it only self-heals a missing TTL.
//
// Real source, fetch mocked, no network, no secrets. Run:
//   node tests/test_ratelimit_ipv6_ttl.js

process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'kv-tok';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — IPv6 /64 grouping closes the rotate-within-your-/64 bypass
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== IPv6 /64 grouping (api/_lib/rateLimit.js ipBucketKey) ===\n');
{
  const { ipBucketKey } = await import('../api/_lib/rateLimit.js');
  const keyFor = (xff) => ipBucketKey({ headers: { 'x-forwarded-for': xff } });

  // IPv4 is untouched — the full address is the key.
  check('IPv4 keyed on full address (unchanged)', keyFor('203.0.113.7') === '203.0.113.7', keyFor('203.0.113.7'));

  // THE BYPASS: many distinct hosts inside ONE /64 must collapse to ONE key.
  // Full (uncompressed) form.
  const a = keyFor('2001:0db8:0000:0000:0000:0000:0000:0001');
  const b = keyFor('2001:0db8:0000:0000:ffff:ffff:ffff:fffe');
  check('full-form: two hosts in same /64 share one key', a === b, a + ' vs ' + b);
  check('full-form /64 key is the prefix', a === '2001:db8:0:0::/64', a);

  // Compressed form — the case the naive split(':').slice(0,4) got WRONG by
  // leaking the host bits ("1","2","abcd") into the key.
  const c1 = keyFor('2001:db8::1');
  const c2 = keyFor('2001:db8::2');
  const c3 = keyFor('2001:db8::abcd:1234');
  check('compressed: ::1 and ::2 share one key (was a bypass)', c1 === c2, c1 + ' vs ' + c2);
  check('compressed: ::abcd:1234 also same /64', c1 === c3, c1 + ' vs ' + c3);
  check('compressed and full forms of the SAME /64 agree', c1 === a, c1 + ' vs ' + a);

  // Short link-local / loopback compressed forms (< 4 leading tokens) — these
  // fell through the old `groups.length >= 4` guard to the full address.
  const ll1 = keyFor('fe80::1');
  const ll2 = keyFor('fe80::dead:beef');
  check('link-local fe80::1 / fe80::dead:beef share one key', ll1 === ll2, ll1 + ' vs ' + ll2);
  check('link-local /64 key has zero-filled prefix', ll1 === 'fe80:0:0:0::/64', ll1);

  // Hosts in a DIFFERENT /64 must NOT collide (limit still partitions networks).
  const d1 = keyFor('2001:db8:0:1::5');
  const d2 = keyFor('2001:db8:0:2::5');
  check('different /64s get different keys (no over-grouping)', d1 !== d2, d1 + ' vs ' + d2);

  // Zone id and brackets are stripped before grouping.
  check('zone id stripped (fe80::1%eth0 == fe80::1)', keyFor('fe80::1%eth0') === ll1, keyFor('fe80::1%eth0'));
  check('brackets stripped ([2001:db8::1] == 2001:db8::1)', keyFor('[2001:db8::1]') === c1, keyFor('[2001:db8::1]'));

  // Case-insensitive + leading-zero normalization → one canonical key.
  check('uppercase + leading zeros normalize to one key',
    keyFor('2001:0DB8:0000:0000:0000:0000:0000:0001') === a,
    keyFor('2001:0DB8:0000:0000:0000:0000:0000:0001'));
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1b — lib/ratelimit.js callerKey (middleware path) groups IPv6 by /64 too
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== IPv6 /64 grouping (lib/ratelimit.js callerKey, via bucket key) ===\n');
{
  // Capture the bucket key the limiter sends to KV by sniffing the pipeline body.
  const counts = new Map();
  let lastKey = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (/\/pipeline$/.test(u)) {
      const cmds = JSON.parse(opts.body);
      lastKey = cmds[0][1]; // INCR <key>
      const n = (counts.get(lastKey) || 0) + 1; counts.set(lastKey, n);
      return new Response(JSON.stringify([{ result: n }, { result: 1 }]), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  const { rateLimit } = await import('../lib/ratelimit.js');
  const run = async (xff) => {
    await rateLimit({ headers: { 'x-forwarded-for': xff }, reqId: 'q' }, { key: 'k6', limit: 100, windowSec: 60 });
    return lastKey;
  };
  const k1 = await run('2001:db8::1');
  const k2 = await run('2001:db8::feed');
  const k3 = await run('2001:0db8:0000:0000:0000:0000:0000:0099');
  check('callerKey buckets compressed + full same-/64 hosts together',
    k1 === k2 && k2 === k3, [k1, k2, k3].join(' | '));
  check('callerKey IPv6 key carries the /64 prefix form',
    /^rl:k6:ip:2001:db8:0:0::\/64$/.test(k1), k1);
  const k4 = await run('203.0.113.50');
  check('callerKey IPv4 stays full-address', /^rl:k6:ip:203\.0\.113\.50$/.test(k4), k4);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — atomic, self-healing TTL (no permanent lockout)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== atomic INCR + EXPIRE NX every hit (lockout-race fix) ===\n');
{
  // Fake KV that tracks both the counter AND whether a TTL is currently set, so
  // we can prove the limiter always re-asserts a TTL (EXPIRE NX) — including on
  // a key that already exists with count>1 but lost its TTL.
  const counts = new Map();
  const hasTtl = new Map();
  const calls = []; // { kind, cmds? }
  let expireNxSupported = true;

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (/\/pipeline$/.test(u)) {
      const cmds = JSON.parse(opts.body);
      calls.push({ kind: 'pipeline', cmds });
      const out = [];
      for (const c of cmds) {
        const name = String(c[0]).toUpperCase();
        const k = c[1];
        if (name === 'INCR') {
          const n = (counts.get(k) || 0) + 1; counts.set(k, n);
          out.push({ result: n });
        } else if (name === 'EXPIRE') {
          if (!expireNxSupported) { out.push({ error: 'ERR Unsupported option NX' }); continue; }
          // EXPIRE ... NX: only sets a TTL when none exists; reports 1/0.
          if (!hasTtl.get(k)) { hasTtl.set(k, true); out.push({ result: 1 }); }
          else out.push({ result: 0 });
        } else out.push({ result: null });
      }
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (/\/expire\//.test(u)) {
      const k = decodeURIComponent(u.split('/expire/')[1].split('/')[0]);
      hasTtl.set(k, true);
      calls.push({ kind: 'expire' });
      return new Response(JSON.stringify({ result: 1 }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const { rateLimit } = await import('../api/_lib/rateLimit.js');
  const res = () => {
    const r = { code: 200, headers: {}, body: null };
    return { setHeader: (k, v) => { r.headers[k] = v; }, status: (c) => { r.code = c; return { json: (b) => { r.body = b; return r; } }; }, _r: r };
  };
  const reqFrom = (ip) => ({ headers: { 'x-forwarded-for': ip }, url: '/api/auth/google' });

  // Happy path: every hit is exactly ONE pipeline carrying INCR + EXPIRE NX.
  calls.length = 0;
  const stop1 = await rateLimit(reqFrom('198.51.100.5'), res(), { limit: 3, windowSec: 60 });
  check('1st hit not blocked', stop1 === false);
  check('1st hit = exactly one /pipeline call', calls.length === 1 && calls[0].kind === 'pipeline', JSON.stringify(calls.map(c => c.kind)));
  const cmds = calls[0].cmds;
  check('pipeline carried INCR then EXPIRE ... NX',
    String(cmds[0][0]).toUpperCase() === 'INCR' &&
    String(cmds[1][0]).toUpperCase() === 'EXPIRE' &&
    String(cmds[1][3]).toUpperCase() === 'NX', JSON.stringify(cmds));
  check('NO separate /expire call in happy path', !calls.some(c => c.kind === 'expire'));

  // Second hit also re-asserts EXPIRE NX (the OLD code skipped EXPIRE when count!==1).
  calls.length = 0;
  await rateLimit(reqFrom('198.51.100.5'), res(), { limit: 3, windowSec: 60 });
  check('2nd hit STILL sends EXPIRE NX (self-heal, not just count===1)',
    calls.length === 1 && String(calls[0].cmds[1][0]).toUpperCase() === 'EXPIRE' &&
    String(calls[0].cmds[1][3]).toUpperCase() === 'NX', JSON.stringify(calls[0] && calls[0].cmds));

  // THE LOCKOUT SCENARIO: a key already at count=2 but with NO TTL (a prior
  // EXPIRE was lost). The fixed limiter must HEAL it (set a TTL) on the next
  // hit — the old code never would, so it stayed un-expiring and locked the
  // user out once count passed the limit.
  counts.set('rate:203.0.113.200', 2);
  hasTtl.set('rate:203.0.113.200', false); // TTL went missing
  calls.length = 0;
  await rateLimit(reqFrom('203.0.113.200'), res(), { limit: 5, windowSec: 60 });
  check('a TTL-less existing key gets its TTL re-asserted (no permanent lockout)',
    hasTtl.get('rate:203.0.113.200') === true, 'hasTtl=' + hasTtl.get('rate:203.0.113.200'));

  // Limit is still enforced (sends 429 + Retry-After) once count exceeds it.
  counts.set('rate:192.0.2.42', 5);
  hasTtl.set('rate:192.0.2.42', true);
  const r6 = res();
  const stop = await rateLimit(reqFrom('192.0.2.42'), r6, { limit: 5, windowSec: 60 });
  check('over-limit hit blocks (returns true, 429, Retry-After set)',
    stop === true && r6._r.code === 429 && r6._r.headers['Retry-After'] === '60' &&
    r6._r.body && r6._r.body.ok === false && r6._r.body.error === 'rate_limited', JSON.stringify(r6._r));

  // Degraded server: EXPIRE ... NX rejected → fall back to a plain /expire on
  // the SAME hit so the TTL is still set (still no lockout).
  expireNxSupported = false;
  counts.clear(); hasTtl.clear();
  calls.length = 0;
  await rateLimit(reqFrom('198.51.100.9'), res(), { limit: 3, windowSec: 60 });
  check('degraded (no NX): pipeline + a plain /expire fallback on the same hit',
    calls.filter(c => c.kind === 'pipeline').length === 1 &&
    calls.filter(c => c.kind === 'expire').length === 1, JSON.stringify(calls.map(c => c.kind)));
  check('degraded fallback actually set the TTL', hasTtl.get('rate:198.51.100.9') === true);

  // KV outage → fail OPEN (never block a legit user on a KV error).
  global.fetch = async () => { throw new Error('kv down'); };
  const failOpen = await rateLimit(reqFrom('198.51.100.77'), res(), { limit: 1, windowSec: 60 });
  check('KV outage fails OPEN (does not block)', failOpen === false);
}

console.log('\n' + (fail === 0
  ? 'OK: all ' + pass + ' assertions passed'
  : 'FAILED: ' + fail + ' assertion(s) failed, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
