// tests/test_oauth_rotation_capture.js
//
// Audit H1 (docs/AUDIT_OAUTH_DRIVE_2026_05_31.md): Google rotates the
// refresh_token for grants older than ~6 months and revokes the old one within
// hours. lib/oauth.js exchangeRefreshForAccess must CAPTURE that rotated token
// (re-encrypt + persist to BOTH user:{sub} and token:{sub}) instead of
// discarding it. This test exercises the REAL lib/oauth.js with fetch + KV
// mocked (no network, no real Upstash, no secrets).
//
// Asserts:
//   (a) when the token response includes a refresh_token, the helper persists a
//       NEW envelope to user:{sub} AND token:{sub} (and it decrypts back to the
//       rotated token under the sub's AAD).
//   (b) when the response has NO refresh_token, NOTHING is persisted.
//   (c) the access token is returned either way.
//   + the SETNX rotate_lock guards a concurrent double-persist (loser skips).
//   + the persist MERGES (does not clobber sibling fields like spreadsheetId).
//   + token:{sub} is only updated when it already exists.
//
// Run: node tests/test_oauth_rotation_capture.js

// A real 32-byte KEK so encryptRefreshToken/decryptRefreshToken actually run.
process.env.KESEFLE_DB_KEY = '0XnRIQyXIZTw65abOSqPY5ssFPiLijwPtfY+O5UDMK8=';
process.env.GOOGLE_CLIENT_ID = 'fake-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret';
process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'kv-tok';

import { decryptRefreshToken } from '../lib/crypto.js';

// ── Mock KV (Upstash REST) + Google token endpoint ──────────────────────────
const kv = new Map();
const setKv = (k, v) => kv.set(k, typeof v === 'string' ? v : JSON.stringify(v));
const getKvObj = (k) => { const v = kv.get(k); return v == null ? null : JSON.parse(v); };

// The next token-endpoint response body. Tests mutate this between calls.
let nextTokenResponse = { access_token: 'access-1', expires_in: 3599 };
// Counters so we can assert how many writes / SETNX attempts actually happened.
const counters = { setnx: 0, set: 0, get: 0, tokenExchange: 0 };
// Optional hook to simulate a concurrent winner already holding the lock.
let setnxAlwaysBusy = false;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();

  // Google token exchange
  if (/oauth2\.googleapis\.com\/token/.test(u)) {
    counters.tokenExchange++;
    return new Response(JSON.stringify(nextTokenResponse), { status: 200 });
  }

  // KV SETNX lock: /set/{key}?nx=true&ex=...
  const setNxM = u.match(/\/set\/([^?]+)\?.*nx=true/i);
  if (setNxM && method === 'POST') {
    counters.setnx++;
    const key = decodeURIComponent(setNxM[1]);
    if (setnxAlwaysBusy || kv.has(key)) {
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    kv.set(key, opts.body || '"1"');
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  }

  // KV plain SET: /set/{key}
  const setM = u.match(/\/set\/([^?]+)/);
  if (setM && method === 'POST') {
    counters.set++;
    kv.set(decodeURIComponent(setM[1]), opts.body);
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  }

  // KV GET: /get/{key}
  const getM = u.match(/\/get\/([^?]+)/);
  if (getM) {
    counters.get++;
    const key = decodeURIComponent(getM[1]);
    return new Response(JSON.stringify({ result: kv.get(key) ?? null }), { status: 200 });
  }

  return new Response('{}', { status: 404 });
};

// Import the REAL module under test (after fetch is mocked + env set).
const { exchangeRefreshForAccess, persistRotatedRefreshToken } = await import('../lib/oauth.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
}
function resetCounters() { counters.setnx = 0; counters.set = 0; counters.get = 0; counters.tokenExchange = 0; }

const SUB = 'google-sub-12345';
const OLD_REFRESH = '1//0-old-refresh-token';

console.log('=== (a) rotation present → new envelope persisted to BOTH records ===\n');
{
  kv.clear(); resetCounters(); setnxAlwaysBusy = false;
  // Pre-seed both records with the OLD envelope + sibling fields we must keep.
  setKv('user:' + SUB, { spreadsheetId: 'sheet-XYZ', plan: 'pro', refreshTokenEnvelope: 'v1:cur:OLD:OLD:OLD' });
  setKv('token:' + SUB, { sheetId: 'sheet-XYZ', accessToken: 'stale', expiry: 1, refreshTokenEnvelope: 'v1:cur:OLD:OLD:OLD' });

  const ROTATED = '1//0-ROTATED-new-token';
  nextTokenResponse = { access_token: 'access-rotated', expires_in: 3599, refresh_token: ROTATED };

  const out = await exchangeRefreshForAccess({ refreshToken: OLD_REFRESH, userSub: SUB });

  check('(c) returns the access token', out.accessToken === 'access-rotated', JSON.stringify(out));
  check('reports rotated:true', out.rotated === true);
  check('acquired the SETNX rotate_lock', counters.setnx === 1 && kv.has('rotate_lock:' + SUB));

  const userRec = getKvObj('user:' + SUB);
  const tokenRec = getKvObj('token:' + SUB);
  check('user:{sub} envelope CHANGED from the old one',
    userRec.refreshTokenEnvelope && userRec.refreshTokenEnvelope !== 'v1:cur:OLD:OLD:OLD');
  check('token:{sub} envelope CHANGED from the old one',
    tokenRec.refreshTokenEnvelope && tokenRec.refreshTokenEnvelope !== 'v1:cur:OLD:OLD:OLD');

  // The persisted envelope must decrypt back to the rotated token under SUB's AAD.
  let decUser = null, decToken = null;
  try { decUser = decryptRefreshToken(userRec.refreshTokenEnvelope, SUB); } catch {}
  try { decToken = decryptRefreshToken(tokenRec.refreshTokenEnvelope, SUB); } catch {}
  check('user:{sub} envelope decrypts to the ROTATED token', decUser === ROTATED, 'got ' + decUser);
  check('token:{sub} envelope decrypts to the ROTATED token', decToken === ROTATED, 'got ' + decToken);

  // Merge, not clobber.
  check('user:{sub} kept sibling fields (spreadsheetId/plan)',
    userRec.spreadsheetId === 'sheet-XYZ' && userRec.plan === 'pro');
  check('token:{sub} kept sibling fields (sheetId)', tokenRec.sheetId === 'sheet-XYZ');

  // AAD binding: decrypting under a DIFFERENT sub must fail (cross-tenant safety).
  let crossOk = false;
  try { decryptRefreshToken(userRec.refreshTokenEnvelope, 'some-other-sub'); } catch { crossOk = true; }
  check('rotated envelope is AAD-bound (wrong sub cannot decrypt)', crossOk);
}

console.log('\n=== (b) no rotation → NOTHING persisted ===\n');
{
  kv.clear(); resetCounters(); setnxAlwaysBusy = false;
  setKv('user:' + SUB, { spreadsheetId: 'sheet-XYZ', refreshTokenEnvelope: 'v1:cur:OLD:OLD:OLD' });
  setKv('token:' + SUB, { sheetId: 'sheet-XYZ', refreshTokenEnvelope: 'v1:cur:OLD:OLD:OLD' });

  // Normal refresh: Google omits refresh_token.
  nextTokenResponse = { access_token: 'access-2', expires_in: 3599 };

  const out = await exchangeRefreshForAccess({ refreshToken: OLD_REFRESH, userSub: SUB });

  check('(c) returns the access token', out.accessToken === 'access-2');
  check('reports rotated:false', out.rotated === false);
  check('NO SETNX lock attempted (no rotation path)', counters.setnx === 0);
  check('NO KV SET writes happened', counters.set === 0);
  check('user:{sub} envelope UNCHANGED', getKvObj('user:' + SUB).refreshTokenEnvelope === 'v1:cur:OLD:OLD:OLD');
  check('token:{sub} envelope UNCHANGED', getKvObj('token:' + SUB).refreshTokenEnvelope === 'v1:cur:OLD:OLD:OLD');
  check('rotate_lock key NOT present', !kv.has('rotate_lock:' + SUB));
}

console.log('\n=== edge: refresh_token echoes the SAME token → not treated as rotation ===\n');
{
  kv.clear(); resetCounters(); setnxAlwaysBusy = false;
  setKv('user:' + SUB, { refreshTokenEnvelope: 'v1:cur:OLD:OLD:OLD' });
  // Some providers echo the same token; that's not a real rotation.
  nextTokenResponse = { access_token: 'access-3', expires_in: 3599, refresh_token: OLD_REFRESH };

  const out = await exchangeRefreshForAccess({ refreshToken: OLD_REFRESH, userSub: SUB });
  check('(c) returns the access token', out.accessToken === 'access-3');
  check('echoed-same-token NOT persisted (rotated:false)', out.rotated === false);
  check('no SETNX / no SET on echoed token', counters.setnx === 0 && counters.set === 0);
}

console.log('\n=== concurrency: SETNX lock busy → persist skipped (no double-write) ===\n');
{
  kv.clear(); resetCounters(); setnxAlwaysBusy = true; // simulate a concurrent winner
  setKv('user:' + SUB, { refreshTokenEnvelope: 'v1:cur:OLD:OLD:OLD' });
  setKv('token:' + SUB, { refreshTokenEnvelope: 'v1:cur:OLD:OLD:OLD' });
  nextTokenResponse = { access_token: 'access-4', expires_in: 3599, refresh_token: '1//0-ROTATED-2' };

  const out = await exchangeRefreshForAccess({ refreshToken: OLD_REFRESH, userSub: SUB });
  check('(c) returns the access token even when lock is busy', out.accessToken === 'access-4');
  check('reports rotated:false when it lost the lock', out.rotated === false);
  check('SETNX was attempted exactly once', counters.setnx === 1);
  check('did NOT write records (loser skips)', counters.set === 0);
  check('user:{sub} envelope left for the lock winner to write', getKvObj('user:' + SUB).refreshTokenEnvelope === 'v1:cur:OLD:OLD:OLD');
  setnxAlwaysBusy = false;
}

console.log('\n=== token:{sub} only updated if it already exists ===\n');
{
  kv.clear(); resetCounters(); setnxAlwaysBusy = false;
  // user record exists, token record does NOT.
  setKv('user:' + SUB, { spreadsheetId: 'sheet-XYZ', refreshTokenEnvelope: 'v1:cur:OLD:OLD:OLD' });
  nextTokenResponse = { access_token: 'access-5', expires_in: 3599, refresh_token: '1//0-ROTATED-3' };

  const out = await exchangeRefreshForAccess({ refreshToken: OLD_REFRESH, userSub: SUB });
  check('rotation captured for the user record', out.rotated === true);
  check('user:{sub} got a fresh (changed) envelope',
    getKvObj('user:' + SUB).refreshTokenEnvelope !== 'v1:cur:OLD:OLD:OLD');
  check('token:{sub} was NOT conjured into existence', !kv.has('token:' + SUB));
}

console.log('\n=== fail-soft: KV unavailable must NOT break the access-token return ===\n');
{
  kv.clear(); resetCounters();
  // Genuinely remove KV the way production would (env unset + no creds passed),
  // so the persist path degrades to a no-op. The access token must still return.
  const savedUrl = process.env.KV_REST_API_URL;
  const savedTok = process.env.KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  try {
    nextTokenResponse = { access_token: 'access-6', expires_in: 3599, refresh_token: '1//0-ROTATED-4' };
    const out = await exchangeRefreshForAccess({ refreshToken: OLD_REFRESH, userSub: SUB });
    check('(c) access token still returned with no KV', out.accessToken === 'access-6');
    check('rotated:false when KV unavailable (no persist)', out.rotated === false);
    check('no KV writes attempted when KV is unconfigured', counters.set === 0 && counters.setnx === 0);
  } finally {
    process.env.KV_REST_API_URL = savedUrl;
    process.env.KV_REST_API_TOKEN = savedTok;
  }
}

console.log('\n=== direct persistRotatedRefreshToken status shape (telemetry) ===\n');
{
  kv.clear(); resetCounters(); setnxAlwaysBusy = false;
  setKv('user:' + SUB, { refreshTokenEnvelope: 'v1:cur:OLD:OLD:OLD' });
  const res = await persistRotatedRefreshToken({
    newRefreshToken: '1//0-direct', userSub: SUB,
    kvUrl: process.env.KV_REST_API_URL, kvToken: process.env.KV_REST_API_TOKEN,
  });
  check('persist reports persisted:true + lock acquired', res.persisted === true && res.lock === 'acquired');
  check('persist reports the user record was written', res.records.includes('user:' + SUB));
}

console.log('\n' + (fail === 0
  ? 'OK: all ' + pass + ' assertions passed'
  : 'FAILED: ' + fail + ' assertion(s) failed, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
