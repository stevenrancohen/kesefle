// tests/test_wa_config_mock.mjs
// WhatsApp number-swap readiness. MOCK number only: +972 50-000-0000 /
// phone_number_id 000000000000000. fetch is replaced with a spy that throws,
// so ANY network attempt fails the suite.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

let fetchCalls = 0;
globalThis.fetch = async (...a) => { fetchCalls++; throw new Error('NETWORK BLOCKED in test: ' + a[0]); };

const MOCK_E164 = '+972 50-000-0000', MOCK_DIGITS = '972500000000', MOCK_PNID = '000000000000000', MOCK_WABA = '111111111111111';
const NEW_ENV = { WA_PHONE_E164: MOCK_E164, WA_PHONE_NUMBER_ID: MOCK_PNID, WA_WABA_ID: MOCK_WABA,
  WA_ACCESS_TOKEN: 'mock-token', WA_VERIFY_TOKEN: 'mock-verify', WA_GRAPH_VERSION: '22' };

const W = await import('../lib/wa-config.js');

console.log('\n== 1. config resolution ==');
const c0 = W.getWaConfig({});
ok('empty env -> default public number, v21.0, no id/token', c0.phoneDigits === W.DEFAULT_PUBLIC_BOT_NUMBER && c0.graphVersion === 'v21.0' && !c0.phoneNumberId && !c0.accessToken && c0.phoneIsDefault);
const cl = W.getWaConfig({ META_PHONE_NUMBER_ID: 'legacyid', WHATSAPP_TOKEN: 'legtok', META_VERIFY_TOKEN: 'legv', KESEFLE_BOT_NUMBER: '972500000000' });
ok('legacy env names still honoured', cl.phoneNumberId === 'legacyid' && cl.accessToken === 'legtok' && cl.verifyToken === 'legv' && cl.phoneDigits === MOCK_DIGITS);
const cn = W.getWaConfig({ ...NEW_ENV, META_PHONE_NUMBER_ID: 'OLD', META_ACCESS_TOKEN: 'OLD', META_VERIFY_TOKEN: 'OLD', KESEFLE_BOT_NUMBER: '15556408123' });
ok('WA_* wins over legacy names', cn.phoneNumberId === MOCK_PNID && cn.accessToken === 'mock-token' && cn.verifyToken === 'mock-verify' && cn.phoneDigits === MOCK_DIGITS && cn.wabaId === MOCK_WABA);
ok('graph version normalised (22 -> v22.0, junk -> v21.0)', cn.graphVersion === 'v22.0' && W.normalizeGraphVersion('latest') === 'v21.0' && W.normalizeGraphVersion('v19.0') === 'v19.0');
ok('messagesUrl uses env id + version', W.messagesUrl(NEW_ENV) === 'https://graph.facebook.com/v22.0/000000000000000/messages');
ok('messagesUrl override = inbound phone_number_id', W.messagesUrl(NEW_ENV, '999') === 'https://graph.facebook.com/v22.0/999/messages');
const pub = W.publicWaConfig(NEW_ENV);
ok('public config has display + link and NO secrets', pub.BOT_NUMBER_DISPLAY === '+972 50-000-0000' && !JSON.stringify(pub).includes('mock-token') && !JSON.stringify(pub).includes('mock-verify'));

console.log('\n== 2. /api/config serves env number ==');
const saved = { ...process.env };
Object.assign(process.env, NEW_ENV);
const cfgMod = (await import('../api/config.js')).default;
const mkRes = () => ({ code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; }, send(b) { this.body = b; return this; } });
const r1 = mkRes(); await cfgMod({ method: 'GET', headers: {}, query: {} }, r1);
ok('/api/config returns mock number + wa.me link', r1.code === 200 && r1.body.BOT_NUMBER === MOCK_DIGITS && r1.body.BOT_WA_LINK === 'https://wa.me/972500000000' && r1.body.bot_number_is_default === false);
ok('/api/config leaks no token', !JSON.stringify(r1.body).includes('mock-token') && !JSON.stringify(r1.body).includes('mock-verify'));

console.log('\n== 3. wa.me link generation ==');
ok('waMeLink digits only', W.waMeLink(MOCK_E164) === 'https://wa.me/972500000000');
ok('waMeLink encodes Hebrew text', W.waMeLink(MOCK_DIGITS, 'קוד 123456') === 'https://wa.me/972500000000?text=' + encodeURIComponent('קוד 123456'));
// browser rewriter
const src = fs.readFileSync(path.join(ROOT, 'js/wa-links.js'), 'utf8');
const anchors = ['https://wa.me/972599999999?text=%D7%94%D7%99%D7%99', 'https://wa.me/?text=share', 'https://wa.me/972599999999'].map((h) => ({ h, keep: false, getAttribute() { return this.h; }, setAttribute(_k, v) { this.h = v; }, hasAttribute(k) { return k === 'data-wa-keep' && this.keep; } }));
anchors.push({ h: 'https://wa.me/972541111111', keep: true, getAttribute() { return this.h; }, setAttribute(_k, v) { this.h = v; }, hasAttribute() { return this.keep; } });
const sandbox = { window: {}, document: { querySelectorAll: () => anchors }, fetch: undefined };
vm.runInNewContext(src, sandbox);
const n = sandbox.window.KESEFLE_WA.rewrite(sandbox.document, MOCK_DIGITS);
ok('rewriter swaps bot links, keeps ?text=', anchors[0].h === 'https://wa.me/972500000000?text=%D7%94%D7%99%D7%99' && anchors[2].h === 'https://wa.me/972500000000');
ok('rewriter leaves number-less share links + data-wa-keep alone', anchors[1].h === 'https://wa.me/?text=share' && anchors[3].h === 'https://wa.me/972541111111' && n === 2);

console.log('\n== 4. webhook verify handshake (api/whatsapp/webhook.js) ==');
const wh = (await import('../api/whatsapp/webhook.js')).default;
const get = async (q) => { const r = mkRes(); await wh({ method: 'GET', headers: {}, query: q }, r); return r; };
let r = await get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'mock-verify', 'hub.challenge': 'CH123' });
ok('correct WA_VERIFY_TOKEN -> 200 + challenge', r.code === 200 && r.body === 'CH123');
r = await get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'x' });
ok('wrong token -> 403', r.code === 403);
r = await get({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 'mock-verify' });
ok('wrong mode -> 403', r.code === 403);
delete process.env.WA_VERIFY_TOKEN; delete process.env.META_VERIFY_TOKEN;
r = await get({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'x' });
ok('no verify token configured -> 503 fail-closed', r.code === 503);
process.env.META_VERIFY_TOKEN = 'legacy-verify';
r = await get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'legacy-verify', 'hub.challenge': 'L' });
ok('legacy META_VERIFY_TOKEN still works', r.code === 200 && r.body === 'L');

console.log('\n== 5. inbound routing by phone_number_id ==');
const payload = (pnid, waba = MOCK_WABA, text = '45 קפה') => ({ object: 'whatsapp_business_account', entry: [{ id: waba, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: MOCK_DIGITS, phone_number_id: pnid }, messages: [{ from: '972500000001', type: 'text', text: { body: text } }] } }] }] });
ok('inbound to mock id -> routed ok', W.routeInbound(payload(MOCK_PNID), NEW_ENV).ok === true);
ok('inbound to other id -> phone_number_id_mismatch', W.routeInbound(payload('1086749664527399'), NEW_ENV).reason === 'phone_number_id_mismatch');
ok('inbound from other WABA -> waba_mismatch', W.routeInbound(payload(MOCK_PNID, '2099640690612821'), NEW_ENV).reason === 'waba_mismatch');
ok('no metadata -> no_metadata', W.routeInbound({ entry: [{ changes: [{ value: {} }] }] }, NEW_ENV).reason === 'no_metadata');
ok('reply URL targets the inbound number', W.messagesUrl(NEW_ENV, W.inboundPhoneNumberId(payload(MOCK_PNID))).includes('/' + MOCK_PNID + '/messages'));

console.log('\n== 6. Apps Script ZZ_KFL_WA_CONFIG.gs (mock PropertiesService) ==');
const gs = fs.readFileSync(path.join(ROOT, 'bot/wa_config/ZZ_KFL_WA_CONFIG.gs'), 'utf8');
const runGs = (props) => {
  const ctx = { PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    Utilities: { base64Encode: (s) => Buffer.from(s).toString('base64') }, Logger: { log() {} },
    UrlFetchApp: { fetch() { fetchCalls++; throw new Error('UrlFetchApp blocked'); } }, _ACTIVE_PHONE_NUMBER_ID_: '' };
  vm.runInNewContext(gs, ctx); return ctx;
};
let g = runGs({});
ok('no properties -> non-secret defaults kept', g._kflWaPhoneNumberId_() === '1086749664527399' && g._kflWaGraphVersion_() === 'v21.0' && /^\+972\d{9}$/.test(g._kflWaPhoneE164_()));
let thrownV = ''; try { g._kflWaVerifyToken_(); } catch (e) { thrownV = e.message; }
ok('no WA_VERIFY_TOKEN -> strict getter throws clear error', /KFL_WA_CONFIG_MISSING: Script Property WA_VERIFY_TOKEN/.test(thrownV));
let thrownT = ''; try { g._kflWaToken_(); } catch (e) { thrownT = e.message; }
ok('no WHATSAPP_TOKEN -> strict getter throws clear error', /KFL_WA_CONFIG_MISSING: Script Property WHATSAPP_TOKEN/.test(thrownT));
ok('report says MISSING, no fallback secret', /verify_token\s+= MISSING/.test(g.kflWaConfigReport().join('\n')));
ok('no token -> _waSendConfig_ refuses (no_token)', g._waSendConfig_().reason === 'no_token');
g = runGs({ WHATSAPP_PHONE_NUMBER_ID: MOCK_PNID, WHATSAPP_TOKEN: 'mock-token', WA_VERIFY_TOKEN: 'mock-verify', WA_GRAPH_VERSION: 'v22.0', BOT_PHONE_E164: MOCK_E164 });
const sc = g._waSendConfig_();
ok('properties -> mock number everywhere', g._kflWaPhoneE164_() === '+972500000000' && g._kflWaMeLink_() === 'https://wa.me/972500000000' && sc.url === 'https://graph.facebook.com/v22.0/000000000000000/messages' && sc.headers.Authorization === 'Bearer mock-token');
g._ACTIVE_PHONE_NUMBER_ID_ = '222';
ok('send targets inbound _ACTIVE_PHONE_NUMBER_ID_ first', g._waSendConfig_().url.includes('/222/messages'));
ok('report masks token (no tail chars either)', g.kflWaConfigReport().join('\n').indexOf('mock-token') === -1 && g.kflWaConfigReport().join('\n').indexOf('...') === -1);

console.log('\n== 7. link-code flow ==');
const BOT = fs.readFileSync(path.join(ROOT, 'bot/ExpenseBot_DEPLOY.gs'), 'utf8');
const re = /(?:קוד|code|link)\s*[:\-]?\s*(\d{6})\b/i;
const linkText = payload(MOCK_PNID, MOCK_WABA, 'קוד 123456').entry[0].changes[0].value.messages[0].text.body;
ok('mock inbound "קוד 123456" extracts code', (linkText.match(re) || [])[1] === '123456');
ok('expense "45 קפה" is not a link code', !re.test('45 קפה'));
ok('deploy bot has link-code intercept + handleLinkCode_', /handleLinkCode_\(/.test(BOT));
ok('wa.me deep link for link code is built from config number', W.waMeLink(W.getWaConfig(NEW_ENV).phoneDigits, 'קוד 123456').startsWith('https://wa.me/972500000000?text='));
ok('deploy bot: VERIFY_TOKEN / BOT_PHONE_E164 / graph version read Script Properties', /getProperty\('WA_VERIFY_TOKEN'\)/.test(BOT) && /getProperty\('BOT_PHONE_E164'\)/.test(BOT) && /getProperty\('WA_GRAPH_VERSION'\)/.test(BOT));

console.log('\n== 8. no hardcoded graph URLs left in api/ lib/ ==');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const offenders = [...walk(path.join(ROOT, 'api')), ...walk(path.join(ROOT, 'lib'))].filter((f) => f.endsWith('.js') && /graph\.facebook\.com\/v\d/.test(fs.readFileSync(f, 'utf8')));
ok('no graph.facebook.com/vNN literal in api/ or lib/ (' + offenders.map((f) => path.relative(ROOT, f)).join(',') + ')', offenders.length === 0);

console.log('\n== 9. no network ==');
ok('fetch / UrlFetchApp were never called', fetchCalls === 0);

process.env = saved;
console.log(`\ntest_wa_config_mock: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
