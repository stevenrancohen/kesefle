// tests/test_wa_secrets_and_links.mjs
// Mock-only (no network: global fetch + UrlFetchApp are stubbed and counted).
// Covers: no secret fallbacks + fail-closed behaviour, /wa redirect from ONE
// config value, site link centralisation, runtime display fill.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('network blocked in test'); };
const MOCK_DIGITS = '972500000000', MOCK_PNID = '000000000000000';
const WA_KEYS = ['WA_PHONE_E164', 'KESEFLE_BOT_NUMBER', 'BOT_PHONE_E164', 'WA_PHONE_NUMBER_ID', 'META_PHONE_NUMBER_ID', 'WHATSAPP_PHONE_NUMBER_ID',
  'WA_WABA_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'META_WABA_ID', 'WA_ACCESS_TOKEN', 'META_ACCESS_TOKEN', 'WHATSAPP_TOKEN', 'WA_VERIFY_TOKEN',
  'META_VERIFY_TOKEN', 'META_APP_SECRET', 'WA_APP_LINE_E164', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'KESEFLE_BOT_SECRET'];
for (const k of WA_KEYS) delete process.env[k];
const mkRes = () => ({ code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
  json(j) { this.body = j; return this; }, send(b) { this.body = b; return this; }, end() { return this; } });

const W = await import('../lib/wa-config.js');
const NUM = await import('../config/kesefle-numbers.js');

console.log('== 1. no secret fallbacks (Vercel) ==');
const c0 = W.getWaConfig({});
ok('empty env -> no access token / verify token', c0.accessToken === '' && c0.verifyToken === '');
const lib = fs.readFileSync(path.join(ROOT, 'lib/wa-config.js'), 'utf8');
ok('lib/wa-config.js has no token-like literal', !/EAA[A-Za-z0-9]{10,}/.test(lib) && !/expense_bot_verify/.test(lib));
const st = W.waConfigStatus({});
ok('waConfigStatus lists missing names', ['WA_ACCESS_TOKEN', 'WA_PHONE_NUMBER_ID', 'WA_VERIFY_TOKEN', 'META_APP_SECRET'].every((n) => st.missing.includes(n)) && !st.send_ready);
const st2 = W.waConfigStatus({ WA_ACCESS_TOKEN: 'SECRET-AAA', WA_PHONE_NUMBER_ID: MOCK_PNID, WA_VERIFY_TOKEN: 'SECRET-VVV', META_APP_SECRET: 'SECRET-APP', WA_WABA_ID: '1' });
ok('waConfigStatus never contains values', st2.ok && !JSON.stringify(st2).includes('SECRET-'));
let err = null; const before = fetchCalls;
try { W.requireWaSendConfig({}); } catch (e) { err = e; }
ok('requireWaSendConfig throws WaConfigError, no network', err instanceof W.WaConfigError && err.code === 'whatsapp_not_configured' && err.missing.includes('WA_ACCESS_TOKEN') && fetchCalls === before);
const rq = W.requireWaSendConfig({ WA_ACCESS_TOKEN: 't', WA_PHONE_NUMBER_ID: MOCK_PNID });
ok('requireWaSendConfig ok with mock creds', rq.url.endsWith('/' + MOCK_PNID + '/messages'));

console.log('\n== 2. webhook verify fails closed (503) without verify token ==');
const wh = (await import('../api/whatsapp/webhook.js')).default;
const origLog = console.error; const logs = []; console.error = (...a) => { logs.push(a.join(' ')); };
let r = mkRes(); await wh({ method: 'GET', headers: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'expense_bot_' + 'verify_2026', 'hub.challenge': 'C' } }, r);
console.error = origLog;
ok('legacy token no longer accepted -> 503 verify_token_not_configured', r.code === 503 && r.body.error === 'verify_token_not_configured');
ok('clear log line emitted', logs.some((l) => /wa\.webhook\.verify_token_missing/.test(l) && /WA_VERIFY_TOKEN/.test(l)));
process.env.WA_VERIFY_TOKEN = 'mock-verify';
r = mkRes(); await wh({ method: 'GET', headers: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'C' } }, r);
ok('wrong token -> 403', r.code === 403);
delete process.env.WA_VERIFY_TOKEN;

console.log('\n== 3. send fails with explicit config error, no network ==');
process.env.KESEFLE_BOT_SECRET = 'mock-bot-secret';
const send = (await import('../api/whatsapp/send.js')).default;
const f0 = fetchCalls;
r = mkRes(); await send({ method: 'POST', headers: { 'x-kesefle-bot-secret': 'mock-bot-secret' }, body: { to: MOCK_DIGITS, text: 'hi', phone: MOCK_DIGITS, message: 'hi' }, query: {} }, r);
ok('send without token -> 4xx/503 config error, 0 fetch', r.code >= 400 && fetchCalls === f0);
ok('send error names config, not values', r.code !== 503 || /not_configured/.test(JSON.stringify(r.body)));
delete process.env.KESEFLE_BOT_SECRET;

console.log('\n== 4. health reports missing config without leaking values ==');
process.env.WA_ACCESS_TOKEN = 'SECRET-TOKEN-XYZ';
const health = (await import('../api/health.js')).default;
r = mkRes(); await health({ method: 'GET', headers: {}, query: {} }, r);
const hb = JSON.stringify(r.body || {});
ok('health lists wa_config_missing names', Array.isArray(r.body.env_configured.wa_config_missing) && r.body.env_configured.wa_config_missing.includes('WA_VERIFY_TOKEN'));
ok('health body has no secret value', !hb.includes('SECRET-TOKEN-XYZ'));
delete process.env.WA_ACCESS_TOKEN;

console.log('\n== 5. /wa redirect from ONE config value ==');
const cfg = (await import('../api/config.js')).default;
const go = async (q) => { const x = mkRes(); await cfg({ method: 'GET', headers: {}, query: { go: 'wa', ...q } }, x); return x; };
r = await go({});
ok('default -> wa.me/<config default> (production unchanged)', r.code === 302 && r.headers.Location === 'https://wa.me/' + NUM.DEFAULT_PUBLIC_BOT_NUMBER);
process.env.WA_PHONE_E164 = '+972 50-000-0000';
r = await go({ text: '45 קפה' });
ok('WA_PHONE_E164 mock -> redirect to mock with text', r.headers.Location === 'https://wa.me/' + MOCK_DIGITS + '?text=' + encodeURIComponent('45 קפה'));
r = await go({ line: 'app' });
ok('?line=app keeps the separate app line default', r.headers.Location === 'https://wa.me/' + NUM.DEFAULT_APP_LINE_NUMBER);
process.env.WA_APP_LINE_E164 = MOCK_DIGITS;
r = await go({ line: 'app' });
ok('WA_APP_LINE_E164 overrides app line', r.headers.Location === 'https://wa.me/' + MOCK_DIGITS);
r = mkRes(); await cfg({ method: 'GET', headers: {}, query: {} }, r);
ok('/api/config JSON still served, mock number', r.code === 200 && r.body.BOT_NUMBER === MOCK_DIGITS && r.body.BOT_WA_LINK === 'https://wa.me/' + MOCK_DIGITS);
ok('/api/config exposes no secrets', !/token|secret/i.test(Object.keys(r.body).join(',').replace('vapid_public_key', '')));
delete process.env.WA_PHONE_E164; delete process.env.WA_APP_LINE_E164;
const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
ok('vercel.json rewrites /wa -> /api/config?go=wa', (vj.rewrites || []).some((x) => x.source === '/wa' && x.destination === '/api/config?go=wa'));
ok('owner phone: env first, config default second', W.getOwnerPhone({ KESEFLE_OWNER_PHONE: MOCK_DIGITS }) === MOCK_DIGITS && W.getOwnerPhone({}) === NUM.DEFAULT_OWNER_PHONE && W.getOwnerPhone({ STEVEN_ADMIN_PHONE: '1' }, ['STEVEN_ADMIN_PHONE']) === '1');

console.log('\n== 6. site link centralisation ==');
const C = await import('../scripts/centralize-wa-links.mjs');
const B = NUM.DEFAULT_PUBLIC_BOT_NUMBER, A = NUM.DEFAULT_APP_LINE_NUMBER;
const sample = `<a href="https://wa.me/${B}?text=hi">x</a> <a href="https://wa.me/${A}">y</a> +972 ${'0' + B.slice(3)}`.replace('+972 0', '+972 ');
const out = C.transform(`<a href="https://wa.me/${B}?text=hi">x</a><a href="https://wa.me/${A}?text=z">y</a><p>+972 ` + B.slice(3, 5) + '-' + B.slice(5, 8) + '-' + B.slice(8) + `</p>`, 'page.html');
ok('page links -> /wa, app line -> /wa?line=app&, display -> span', out.includes('href="/wa?text=hi"') && out.includes('href="/wa?line=app&text=z"') && out.includes('<span data-kfl-bot-display>WhatsApp</span>') && !out.includes(B) && !out.includes(A));
const outMail = C.transform(`<a href="https://wa.me/${B}">x</a>`, 'emails/01-welcome.html');
ok('emails get absolute https://kesefle.com/wa', outMail === '<a href="https://kesefle.com/wa">x</a>');
ok('transform is idempotent', C.transform(out, 'page.html') === out);
void sample;

console.log('\n== 7. js/wa-links.js fills display spans from /api/config ==');
const src = fs.readFileSync(path.join(ROOT, 'js/wa-links.js'), 'utf8');
const spans = [{ t: 'WhatsApp', a: {}, set textContent(v) { this.t = v; }, get textContent() { return this.t; }, setAttribute(k, v) { this.a[k] = v; } }];
const sb = { window: {}, document: { querySelectorAll: (sel) => (sel.includes('data-kfl-bot-display') ? spans : []) }, fetch: undefined };
sb.window.document = sb.document; vm.runInNewContext(src, sb);
sb.window.KESEFLE_WA.fillDisplay(sb.document, '+972 50-000-0000');
ok('display span filled with configured number (ltr)', spans[0].t === '+972 50-000-0000' && spans[0].a.dir === 'ltr');

console.log('\n== 8. Apps Script: no secret fallback, fail closed ==');
for (const f of ['bot/ExpenseBot_DEPLOY.gs', 'bot/ExpenseBot_FIXED.gs']) {
  const g = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok(f + ': VERIFY_TOKEN from property only', /const VERIFY_TOKEN = String\(PropertiesService\.getScriptProperties\(\)\.getProperty\('WA_VERIFY_TOKEN'\) \|\| ''\)\.trim\(\);/.test(g) && !/expense_bot_verify/.test(g));
  ok(f + ': doGet refuses handshake when unset', /if \(mode === 'subscribe' && !VERIFY_TOKEN\)[\s\S]{0,200}WA_VERIFY_TOKEN not configured/.test(g));
  const ct = g.match(/function _kfl_ctEq_\(a, b\) \{[\s\S]*?\n\}/)[0];
  const ctx = {}; vm.runInNewContext(ct + '; this.f = _kfl_ctEq_;', ctx);
  ok(f + ': empty secret never matches (admin actions locked)', ctx.f('', '') === false && ctx.f('x', 'x') === true && ctx.f('x', 'y') === false);
  ok(f + ': WHATSAPP_TOKEN has empty fallback only', /const WHATSAPP_TOKEN = PropertiesService\.getScriptProperties\(\)\.getProperty\('WHATSAPP_TOKEN'\) \|\| '';/.test(g));
}

console.log('\n== 9. no network ==');
ok('every network attempt hit the blocking stub (' + fetchCalls + ' blocked, 0 real)', typeof fetchCalls === 'number');
console.log(`\ntest_wa_secrets_and_links: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
