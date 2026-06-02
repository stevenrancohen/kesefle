// tests/test_perf_kv_reductions.js
//
// Guards two runtime-cost reductions made in lib/ (PR: agent/perf):
//
//   1. lib/ratelimit.js — the token-bucket increment now does INCR + EXPIRE in a
//      SINGLE Upstash /pipeline HTTP round trip (was INCR, then a SECOND /expire
//      call on the first hit of every window). EXPIRE ... NX leaves an existing
//      TTL untouched, exactly reproducing the old "set TTL only on first hit"
//      semantics. A degraded server that rejects EXPIRE ... NX falls back to the
//      legacy /expire — but only on the first hit, so cost is never worse.
//
//   2. lib/oauth.js — exchangeRefreshForAccess now caches the minted access token
//      per (userSub + refresh-token fingerprint) on the warm instance, so repeat
//      expense writes reuse it instead of re-hitting Google (each avoided
//      exchange also avoids the rotation-capture KV traffic). The cache: respects
//      noCache, reports a truthful remaining lifetime, and invalidates the old
//      entry on refresh-token rotation.
//
// Real source, fetch mocked, no network, no secrets. Run:
//   node tests/test_perf_kv_reductions.js

process.env.KESEFLE_DB_KEY = '0XnRIQyXIZTw65abOSqPY5ssFPiLijwPtfY+O5UDMK8=';
process.env.GOOGLE_CLIENT_ID = 'fake-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret';
process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'kv-tok';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — rate limiter pipelines INCR + EXPIRE NX into one HTTP call
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== rate limiter: single /pipeline round trip (INCR + EXPIRE NX) ===\n');
{
  // Per-key INCR counter + a record of every HTTP call the limiter makes.
  const counts = new Map();
  const calls = []; // { kind: 'pipeline'|'incr'|'expire', body? }
  let expireNxSupported = true;

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (/\/pipeline$/.test(u)) {
      const cmds = JSON.parse(opts.body); // [["INCR",k],["EXPIRE",k,ttl,"NX"]]
      calls.push({ kind: 'pipeline', cmds });
      const out = [];
      for (const c of cmds) {
        const name = String(c[0]).toUpperCase();
        if (name === 'INCR') {
          const k = c[1];
          const n = (counts.get(k) || 0) + 1;
          counts.set(k, n);
          out.push({ result: n });
        } else if (name === 'EXPIRE') {
          if (expireNxSupported) out.push({ result: 1 });
          else out.push({ error: "ERR Unsupported option NX" });
        } else {
          out.push({ result: null });
        }
      }
      return new Response(JSON.stringify(out), { status: 200 });
    }
    // Legacy fallbacks (must NOT be hit in the happy path)
    if (/\/incr\//.test(u)) { calls.push({ kind: 'incr' }); return new Response(JSON.stringify({ result: 1 }), { status: 200 }); }
    if (/\/expire\//.test(u)) { calls.push({ kind: 'expire' }); return new Response(JSON.stringify({ result: 1 }), { status: 200 }); }
    return new Response('{}', { status: 404 });
  };

  const { rateLimit, rateLimitId } = await import('../lib/ratelimit.js');
  const req = { headers: { 'x-forwarded-for': '203.0.113.7' }, reqId: 't1' };

  // First hit of a fresh window.
  calls.length = 0;
  const r1 = await rateLimit(req, { key: 'unit_test_rl', limit: 3, windowSec: 60 });
  check('first hit allowed (count=1)', r1.ok === true && r1.count === 1, JSON.stringify(r1));
  check('first hit used exactly ONE pipeline call', calls.length === 1 && calls[0].kind === 'pipeline', JSON.stringify(calls.map(c => c.kind)));
  check('NO separate /expire call on first hit', !calls.some(c => c.kind === 'expire'));
  const cmds = calls[0].cmds;
  check('pipeline carried INCR then EXPIRE ... NX',
    String(cmds[0][0]).toUpperCase() === 'INCR' &&
    String(cmds[1][0]).toUpperCase() === 'EXPIRE' &&
    String(cmds[1][3]).toUpperCase() === 'NX',
    JSON.stringify(cmds));

  // Second hit — still ONE pipeline call, no extra round trip.
  calls.length = 0;
  const r2 = await rateLimit(req, { key: 'unit_test_rl', limit: 3, windowSec: 60 });
  check('second hit allowed (count=2)', r2.ok === true && r2.count === 2);
  check('second hit also ONE pipeline call (no extra /expire)', calls.length === 1 && calls[0].kind === 'pipeline');

  // Exceed the limit.
  await rateLimit(req, { key: 'unit_test_rl', limit: 3, windowSec: 60 }); // count 3
  const r4 = await rateLimit(req, { key: 'unit_test_rl', limit: 3, windowSec: 60 }); // count 4 > 3
  check('limit enforced when count exceeds limit', r4.ok === false && r4.retryAfter === 60, JSON.stringify(r4));

  // rateLimitId path uses the same single-call pipeline.
  calls.length = 0;
  const rid = await rateLimitId('+972500000000', { key: 'unit_test_rl_id', limit: 5, windowSec: 60 });
  check('rateLimitId first hit allowed', rid.ok === true && rid.count === 1);
  check('rateLimitId used ONE pipeline call', calls.length === 1 && calls[0].kind === 'pipeline');

  // Degraded server: EXPIRE ... NX rejected → fall back to legacy /expire, but
  // ONLY on the first hit; behaviour stays correct and cost is never worse.
  expireNxSupported = false;
  counts.clear();
  calls.length = 0;
  const d1 = await rateLimit(req, { key: 'degraded_rl', limit: 3, windowSec: 60 });
  check('degraded first hit still allowed', d1.ok === true && d1.count === 1);
  check('degraded first hit: pipeline + ONE legacy /expire fallback',
    calls.filter(c => c.kind === 'pipeline').length === 1 &&
    calls.filter(c => c.kind === 'expire').length === 1,
    JSON.stringify(calls.map(c => c.kind)));
  calls.length = 0;
  const d2 = await rateLimit(req, { key: 'degraded_rl', limit: 3, windowSec: 60 });
  check('degraded LATER hit: no /expire fallback (count!=1)',
    calls.filter(c => c.kind === 'expire').length === 0 && d2.count === 2,
    JSON.stringify(calls.map(c => c.kind)));
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — oauth access-token cache
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== oauth: access-token cache (skips repeat Google exchanges) ===\n');
{
  const kv = new Map();
  let tokenExchanges = 0;
  let nextToken = { access_token: 'at-1', expires_in: 3600 };

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (/oauth2\.googleapis\.com\/token/.test(u)) {
      tokenExchanges++;
      return new Response(JSON.stringify(nextToken), { status: 200 });
    }
    // KV (used only by the rotation-persist branch)
    const setNx = u.match(/\/set\/([^?]+)\?.*nx=true/i);
    if (setNx && (opts.method || '').toUpperCase() === 'POST') {
      const key = decodeURIComponent(setNx[1]);
      if (kv.has(key)) return new Response(JSON.stringify({ result: null }), { status: 200 });
      kv.set(key, '1'); return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    const set = u.match(/\/set\/([^?]+)/);
    if (set && (opts.method || '').toUpperCase() === 'POST') { kv.set(decodeURIComponent(set[1]), opts.body); return new Response(JSON.stringify({ result: 'OK' }), { status: 200 }); }
    const get = u.match(/\/get\/([^?]+)/);
    if (get) return new Response(JSON.stringify({ result: kv.get(decodeURIComponent(get[1])) ?? null }), { status: 200 });
    return new Response('{}', { status: 404 });
  };

  const { exchangeRefreshForAccess, __clearAccessTokenCache } = await import('../lib/oauth.js');
  __clearAccessTokenCache();

  const SUB = 'sub-cache-1';
  const RT = '1//refresh-A';

  tokenExchanges = 0;
  const a = await exchangeRefreshForAccess({ refreshToken: RT, userSub: SUB });
  check('1st call mints from Google', a.accessToken === 'at-1' && a.cached !== true && tokenExchanges === 1, JSON.stringify(a));

  const b = await exchangeRefreshForAccess({ refreshToken: RT, userSub: SUB });
  check('2nd call served from cache (no extra Google exchange)', b.accessToken === 'at-1' && b.cached === true && tokenExchanges === 1, JSON.stringify(b) + ' exchanges=' + tokenExchanges);
  check('cache hit reports truthful remaining lifetime (>0, <= ttl)', b.expiresIn > 0 && b.expiresIn <= 3600, 'expiresIn=' + b.expiresIn);

  // noCache forces a fresh mint even on a warm cache.
  nextToken = { access_token: 'at-2', expires_in: 3600 };
  const c = await exchangeRefreshForAccess({ refreshToken: RT, userSub: SUB, noCache: true });
  check('noCache bypasses cache → fresh Google mint', c.accessToken === 'at-2' && tokenExchanges === 2, JSON.stringify(c) + ' exchanges=' + tokenExchanges);

  // A DIFFERENT refresh token must not collide with the cached one.
  __clearAccessTokenCache();
  tokenExchanges = 0;
  nextToken = { access_token: 'at-X', expires_in: 3600 };
  await exchangeRefreshForAccess({ refreshToken: '1//refresh-A', userSub: SUB });
  nextToken = { access_token: 'at-Y', expires_in: 3600 };
  const diff = await exchangeRefreshForAccess({ refreshToken: '1//refresh-B', userSub: SUB });
  check('different refresh token does NOT hit the cache', diff.accessToken === 'at-Y' && diff.cached !== true && tokenExchanges === 2, JSON.stringify(diff));

  // A too-short-lived token is not cached (safety margin > lifetime).
  __clearAccessTokenCache();
  tokenExchanges = 0;
  nextToken = { access_token: 'short', expires_in: 60 }; // < 5 min safety margin
  const s1 = await exchangeRefreshForAccess({ refreshToken: '1//short', userSub: SUB });
  const s2 = await exchangeRefreshForAccess({ refreshToken: '1//short', userSub: SUB });
  check('too-short-lived token is not cached (re-mints each time)', s1.accessToken === 'short' && s2.cached !== true && tokenExchanges === 2, 'exchanges=' + tokenExchanges);

  // Rotation invalidates the OLD entry so a stale token is never re-served.
  __clearAccessTokenCache();
  kv.clear();
  tokenExchanges = 0;
  const OLD = '1//rotate-old';
  // Seed user record so the rotation-persist branch has something to merge.
  kv.set('user:' + SUB, JSON.stringify({ refreshTokenEnvelope: 'v1:cur:OLD:OLD:OLD' }));
  nextToken = { access_token: 'at-rot', expires_in: 3600, refresh_token: '1//rotate-NEW' };
  const rot = await exchangeRefreshForAccess({ refreshToken: OLD, userSub: SUB });
  check('rotation exchange returns the access token + rotated:true', rot.accessToken === 'at-rot' && rot.rotated === true, JSON.stringify({ a: rot.accessToken, r: rot.rotated }));
  // The OLD fingerprint entry must be gone: a fresh call with OLD re-mints.
  nextToken = { access_token: 'at-after-rot', expires_in: 3600 };
  const afterRot = await exchangeRefreshForAccess({ refreshToken: OLD, userSub: SUB });
  check('post-rotation: old refresh token entry was invalidated (re-mints, not stale cache)', afterRot.accessToken === 'at-after-rot' && afterRot.cached !== true, JSON.stringify(afterRot));
}

console.log('\n' + (fail === 0
  ? 'OK: all ' + pass + ' assertions passed'
  : 'FAILED: ' + fail + ' assertion(s) failed, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
