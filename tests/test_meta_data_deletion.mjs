// tests/test_meta_data_deletion.mjs — Meta data-deletion callback, mock secret, no network, no deletion.
import crypto from 'node:crypto';
import fs from 'node:fs';
let pass = 0, fail = 0; const ok = (l, c) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };
let net = 0;
const kv = new Map();
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.origin !== 'https://kv.test') { net++; throw new Error('network blocked'); }
  const set = u.pathname.match(/^\/set\/([^/]+)$/);
  if (set) {
    const key = decodeURIComponent(set[1]);
    if (u.searchParams.has('NX') && kv.has(key)) {
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    kv.set(key, JSON.parse(opts.body));
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  }
  const get = u.pathname.match(/^\/get\/([^/]+)$/);
  if (get) {
    const value = kv.get(decodeURIComponent(get[1]));
    return new Response(JSON.stringify({ result: value == null ? null : JSON.stringify(value) }), { status: 200 });
  }
  net++; throw new Error('unexpected KV route');
};
const SECRET = 'mock-app-secret';
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sign = (payload, secret = SECRET) => { const p = b64u(JSON.stringify(payload)); return b64u(crypto.createHmac('sha256', secret).update(p).digest()) + '.' + p; };
const mod = await import('../api/meta/data-deletion.js'); const h = mod.default;
const mkRes = () => ({ code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; } });
const post = async (body) => { const r = mkRes(); await h({ method: 'POST', body, query: {} }, r); return r; };
const logs = []; const origLog = console.log; 
process.env.META_APP_SECRET = SECRET; delete process.env.PUBLIC_BASE_URL;
process.env.KV_REST_API_URL = 'https://kv.test'; process.env.KV_REST_API_TOKEN = 'mock-kv-token';
const good = { algorithm: 'HMAC-SHA256', user_id: '1234567890', issued_at: 1700000000 };
console.log = (...a) => { logs.push(a.join(' ')); }; let r = await post('signed_request=' + encodeURIComponent(sign(good))); console.log = origLog;
ok('valid signed_request -> 200 {url, confirmation_code}', r.code === 200 && /^KDEL[0-9A-F]{16}$/.test(r.body.confirmation_code) && r.body.url === 'https://kesefle.com/data-deletion/status?id=' + r.body.confirmation_code);
ok('callback response is never cached', r.headers['Cache-Control'] === 'no-store');
ok('response does not leak Meta user_id', !JSON.stringify(r.body).includes('1234567890'));
ok('logged as persisted with deleted:false', logs.some((l) => l.includes('meta.data_deletion.received') && l.includes('"persisted":true') && l.includes('"deleted":false')));
ok('ledger does not store raw Meta user_id', !JSON.stringify([...kv.entries()]).includes('1234567890'));
ok('code is deterministic', mod.confirmationCode('1234567890', 1700000000, SECRET) === r.body.confirmation_code);
r = await post('signed_request=' + encodeURIComponent(sign(good, 'wrong-secret')));
ok('wrong secret -> 403 bad_signature', r.code === 403 && r.body.error === 'bad_signature');
r = await post('signed_request=garbage');
ok('malformed -> 400', r.code === 400);
r = await post('signed_request=' + encodeURIComponent(sign({ ...good, algorithm: 'none' })));
ok('bad algorithm -> 400', r.code === 400 && r.body.error === 'bad_algorithm');
r = await post(JSON.stringify({ signed_request: sign(good) }));
ok('JSON body also accepted', r.code === 200);
delete process.env.META_APP_SECRET; r = await post('signed_request=' + encodeURIComponent(sign(good)));
ok('no META_APP_SECRET -> 503 fail-closed', r.code === 503);
process.env.META_APP_SECRET = SECRET; delete process.env.KV_REST_API_URL; r = await post('signed_request=' + encodeURIComponent(sign(good)));
ok('no durable ledger -> 503 fail-closed', r.code === 503 && r.body.error === 'deletion_request_storage_unavailable'); process.env.KV_REST_API_URL = 'https://kv.test';
process.env.META_APP_SECRET = SECRET;
const g = async (q) => { const x = mkRes(); await h({ method: 'GET', query: q }, x); return x; };
const savedCode = mod.confirmationCode('1234567890', 1700000000, SECRET);
r = await g({ id: savedCode }); ok('status GET returns durable pending state', r.code === 200 && r.body.status === 'received_pending_identity_verification' && r.body.received_at);
ok('status response is never cached', r.headers['Cache-Control'] === 'no-store');
const savedKey = 'meta_delete:' + savedCode; kv.set(savedKey, { ...kv.get(savedKey), status: 'completed', updatedAt: new Date().toISOString() });
r = await post('signed_request=' + encodeURIComponent(sign(good))); r = await g({ id: savedCode });
ok('duplicate callback cannot reset completed state', r.code === 200 && r.body.status === 'completed');
r = await g({ id: 'KDEL0123456789ABCDEF' }); ok('unknown valid id -> 404', r.code === 404 && r.body.error === 'deletion_request_not_found');
r = await g({ id: '../etc' }); ok('status GET bad id -> 400', r.code === 400);
delete process.env.KV_REST_API_URL; r = await g({ id: savedCode }); ok('status GET without ledger -> 503, never fake pending', r.code === 503 && r.body.error === 'deletion_status_unavailable'); process.env.KV_REST_API_URL = 'https://kv.test';
const r2 = mkRes(); await h({ method: 'PUT', query: {} }, r2); ok('PUT -> 405', r2.code === 405);
const src = fs.readFileSync(new URL('../api/meta/data-deletion.js', import.meta.url), 'utf8');
ok('endpoint never calls account deletion without identity binding', !/deleteAccount|deleteByPhone|api\/account/.test(src));
ok('endpoint uses durable deletion ledger', /recordMetaDeletionRequest/.test(src) && /getMetaDeletionRequest/.test(src));
ok('pages exist', fs.existsSync(new URL('../data-deletion.html', import.meta.url)) && fs.existsSync(new URL('../data-deletion/status.html', import.meta.url)));
ok('no network', net === 0);
console.log(`\ntest_meta_data_deletion: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
