#!/usr/bin/env node
// Executable contract tests for the Meta -> Vercel -> Apps Script trust boundary.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const API = fs.readFileSync(path.join(ROOT, 'api/whatsapp/webhook.js'), 'utf8');
const FIXED = fs.readFileSync(path.join(ROOT, 'bot/ExpenseBot_FIXED.gs'), 'utf8');
const DEPLOY = fs.readFileSync(path.join(ROOT, 'bot/ExpenseBot_DEPLOY.gs'), 'utf8');

let pass = 0;
let fail = 0;
function ok(label, condition) {
  if (condition) pass++;
  else { fail++; console.log('  FAIL ' + label); }
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unterminated function: ' + name);
}

const secret = 'relay-test-secret-32-characters-minimum';
const now = 1795449600000;
const rawBody = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba-1', changes: [{ value: { messages: [{ id: 'wamid.123', from: '972501234567', type: 'text', text: { body: 'קוד 123456' } }] } }] }],
});

function envelope(body, ts = now, override = {}) {
  const bodyB64 = Buffer.from(body, 'utf8').toString('base64');
  const canonical = `kesefle-whatsapp-relay-v1\n${ts}\n${bodyB64}`;
  const mac = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  return { kind: 'kesefle.whatsapp.relay', v: 1, ts, bodyB64, mac, ...override };
}

function appsScriptHarness(properties = {}) {
  const props = { WHATSAPP_RELAY_SECRET: secret, WHATSAPP_PROVIDER: 'meta', ...properties };
  const removedCacheKeys = [];
  const context = {
    Date: class extends Date { static now() { return now; } },
    JSON,
    Math,
    Number,
    String,
    isFinite,
    Logger: { log: () => {} },
    CacheService: { getScriptCache: () => ({ remove: (key) => removedCacheKeys.push(key) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => props[key] || '' }) },
    Utilities: {
      computeHmacSha256Signature: (value, key) => Array.from(crypto.createHmac('sha256', key).update(value, 'utf8').digest()),
      base64Decode: (value) => Array.from(Buffer.from(value, 'base64')),
      base64Encode: (bytes) => Buffer.from(bytes.map((value) => value & 0xff)).toString('base64'),
      newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes.map((value) => value & 0xff)).toString('utf8') }),
    },
  };
  vm.createContext(context);
  vm.runInContext(extractFn(FIXED, '_kfl_ctEq_'), context);
  vm.runInContext(extractFn(FIXED, '_unwrapVerifiedRelay_'), context);
  vm.runInContext(extractFn(FIXED, '_verifyMetaWebhook_'), context);
  vm.runInContext(extractFn(FIXED, '_clearInboundSeenForRetry_'), context);
  vm.runInContext(extractFn(FIXED, '_linkCodeNeedsRelayRetry_'), context);
  context.removedCacheKeys = removedCacheKeys;
  return context;
}

function vercelHelperHarness() {
  const context = { Buffer, crypto, URL, RELAY_DOMAIN: 'kesefle-whatsapp-relay-v1', RELAY_KIND: 'kesefle.whatsapp.relay', RELAY_VERSION: 1 };
  vm.createContext(context);
  vm.runInContext(extractFn(API, 'verifyMetaSignature'), context);
  vm.runInContext(extractFn(API, 'createRelayEnvelope'), context);
  vm.runInContext(extractFn(API, 'isAllowedRelayUrl'), context);
  return context;
}

console.log('\n── Vercel ingress and relay contract ──');
const signatureGate = API.indexOf('verifyMetaSignature(rawBody, sig, appSecret)');
const relayGate = API.indexOf("process.env.WHATSAPP_RELAY_ENABLED === '1'");
ok('Meta HMAC runs before relay selection', signatureGate >= 0 && relayGate > signatureGate);
ok('relay signs the original bytes as base64', /Buffer\.from\(rawBody\)\.toString\('base64'\)/.test(API));
ok('relay uses a domain-separated canonical MAC',
  /RELAY_DOMAIN = 'kesefle-whatsapp-relay-v1'/.test(API) &&
  /`\$\{RELAY_DOMAIN\}\\n\$\{ts\}\\n\$\{bodyB64\}`/.test(API));
ok('relay secret is independent and minimum 32 characters', /WHATSAPP_RELAY_SECRET/.test(API) && /secret\.length < 32/.test(API));
ok('relay target is HTTPS and restricted to Apps Script hosts', /url\.protocol === 'https:'/.test(API) && /script\.google\.com/.test(API));
ok('relay is time bounded', /AbortSignal\.timeout\(RELAY_TIMEOUT_MS\)/.test(API));
ok('final redirect URL is revalidated before reading the acknowledgement',
  /if \(!isAllowedRelayUrl\(response\.url\)\)/.test(API));
ok('only explicit RELAY_OK is accepted', /acknowledgement\.trim\(\) !== 'RELAY_OK'/.test(API));
ok('relay failure is retryable to Meta', /if \(!relay\.ok\)[\s\S]{0,180}status\(503\)/.test(API));
ok('relay success exits before local Vercel processing', /relayed: true/.test(API) && relayGate < API.indexOf('// 3. Parse the message'));

const apiContext = vercelHelperHarness();
ok('Apps Script request and exact ContentService redirect hosts are allowed',
  apiContext.isAllowedRelayUrl('https://script.google.com/macros/s/test/exec') &&
  apiContext.isAllowedRelayUrl('https://script.googleusercontent.com/macros/echo?user_content_key=test'));
ok('lookalike, insecure, and unrelated relay hosts are rejected',
  !apiContext.isAllowedRelayUrl('https://script.google.com.evil.example/exec') &&
  !apiContext.isAllowedRelayUrl('http://script.googleusercontent.com/macros/echo') &&
  !apiContext.isAllowedRelayUrl('https://example.com/exec'));
const metaMac = crypto.createHmac('sha256', 'meta-secret').update(Buffer.from(rawBody)).digest('hex');
ok('real Vercel verifier accepts the correct Meta signature',
  apiContext.verifyMetaSignature(Buffer.from(rawBody), 'sha256=' + metaMac, 'meta-secret'));
ok('real Vercel verifier rejects bad and malformed signatures without throwing',
  !apiContext.verifyMetaSignature(Buffer.from(rawBody), 'sha256=' + '0'.repeat(64), 'meta-secret') &&
  !apiContext.verifyMetaSignature(Buffer.from(rawBody), 'sha256=' + 'z'.repeat(64), 'meta-secret'));

console.log('\n── Apps Script envelope validation ──');
let context = appsScriptHarness();
const producedEnvelope = apiContext.createRelayEnvelope(Buffer.from(rawBody), secret, now);
let result = context._unwrapVerifiedRelay_({ postData: { contents: JSON.stringify(producedEnvelope) } });
ok('valid envelope preserves exact raw body and message id', result.valid && result.body === rawBody && /wamid\.123/.test(result.body));

result = context._unwrapVerifiedRelay_({ postData: { contents: JSON.stringify(envelope(rawBody, now, { mac: '0'.repeat(64) })) } });
ok('bad MAC is rejected before the router', result.relayed && !result.valid && result.reason === 'relay_mac_mismatch');

result = context._unwrapVerifiedRelay_({ postData: { contents: JSON.stringify(envelope(rawBody, now - 300001)) } });
ok('expired timestamp is rejected', !result.valid && result.reason === 'relay_timestamp_expired');
result = context._unwrapVerifiedRelay_({ postData: { contents: JSON.stringify(envelope(rawBody, now + 300001)) } });
ok('future timestamp outside the skew is rejected', !result.valid && result.reason === 'relay_timestamp_expired');

result = context._unwrapVerifiedRelay_({ postData: { contents: JSON.stringify(envelope(rawBody, now, { bodyB64: '%%%=' })) } });
ok('malformed base64 is rejected', !result.valid && result.reason === 'relay_body_invalid');

context = appsScriptHarness({ WHATSAPP_RELAY_SECRET: '' });
result = context._unwrapVerifiedRelay_({ postData: { contents: JSON.stringify(envelope(rawBody)) } });
ok('missing relay secret fails closed', !result.valid && result.reason === 'relay_secret_missing');

const spoofedBody = JSON.stringify({ __kflVerifiedRelay: true, entry: [] });
context = appsScriptHarness({ KFL_REQUIRE_VERIFIED_RELAY: '1' });
result = context._unwrapVerifiedRelay_({ postData: { contents: spoofedBody } });
ok('body field cannot spoof the execution-only trust marker', !result.relayed && !result.valid);

console.log('\n── Strict cutover and provider compatibility ──');
result = context._verifyMetaWebhook_({ postData: { contents: spoofedBody } }, spoofedBody);
ok('strict mode rejects direct raw Meta payloads', !result.valid && result.reason === 'verified_relay_required');
result = context._verifyMetaWebhook_({ __kflVerifiedRelay: true }, rawBody);
ok('validated event marker passes strict mode', result.valid && result.reason === 'verified_relay');

context = appsScriptHarness({ WHATSAPP_PROVIDER: 'twilio' });
result = context._verifyMetaWebhook_({}, '');
ok('Twilio compatibility remains available when strict relay is off', result.valid && result.reason === 'twilio_secret_url');
context = appsScriptHarness({ WHATSAPP_PROVIDER: '360dialog' });
result = context._verifyMetaWebhook_({}, '');
ok('360dialog compatibility remains available when strict relay is off', result.valid && result.reason === '360dialog_secret_url');
context = appsScriptHarness({ WHATSAPP_PROVIDER: 'twilio', KFL_REQUIRE_VERIFIED_RELAY: '1' });
result = context._verifyMetaWebhook_({}, '');
ok('strict relay blocks unverifiable direct Twilio ingress', !result.valid && result.reason === 'verified_relay_required');
context = appsScriptHarness({ WHATSAPP_PROVIDER: '360dialog', KFL_REQUIRE_VERIFIED_RELAY: '1' });
result = context._verifyMetaWebhook_({}, '');
ok('strict relay blocks unverifiable direct 360dialog ingress', !result.valid && result.reason === 'verified_relay_required');

console.log('\n── Retry and acknowledgement transitions ──');
context = appsScriptHarness();
context._clearInboundSeenForRetry_({ postData: { contents: rawBody } });
ok('failed WAMID processing marker is removed before retry',
  context.removedCacheKeys.length === 1 && context.removedCacheKeys[0] === 'seenmsg:wamid.123');
ok('retryable link confirmation always requests a relay retry',
  context._linkCodeNeedsRelayRetry_({ retryable: true }, { ok: true }));
ok('provider send failure requests a relay retry',
  context._linkCodeNeedsRelayRetry_({ retryable: false }, { ok: false }));
ok('concurrent in-flight reply requests a safe later retry',
  context._linkCodeNeedsRelayRetry_({ retryable: false }, { ok: true, skipped: true, reason: 'reply_in_flight' }));
ok('confirmed sent/deduped reply can be acknowledged',
  !context._linkCodeNeedsRelayRetry_({ retryable: false }, { ok: true, skipped: true, reason: 'local_sent_marker' }));

function runDoPost(routerText) {
  let cleared = 0;
  function output(content) {
    return { getContent: () => content, setMimeType() { return this; } };
  }
  const doPostContext = {
    Date,
    JSON,
    String,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (key) => key === 'WHATSAPP_PROVIDER' ? 'meta' : '' }) },
    ContentService: { MimeType: { TEXT: 'text', XML: 'xml' }, createTextOutput: output },
    _unwrapVerifiedRelay_: () => ({ relayed: true, valid: true, body: rawBody }),
    _doPostRouter_: () => output(routerText),
    _clearInboundSeenForRetry_: () => { cleared++; },
  };
  vm.createContext(doPostContext);
  vm.runInContext(extractFn(FIXED, 'doPost'), doPostContext);
  const response = doPostContext.doPost({ postData: { contents: 'signed-envelope' }, parameter: {} });
  return { content: response.getContent(), cleared };
}

let wrapper = runDoPost('err');
ok('router exception sentinel becomes a retryable relay error and clears WAMID claim',
  wrapper.content === 'RELAY_ERROR' && wrapper.cleared === 1);
wrapper = runDoPost('RELAY_RETRY');
ok('link-code retry sentinel becomes a retryable relay error and clears any claim',
  wrapper.content === 'RELAY_ERROR' && wrapper.cleared === 1);
wrapper = runDoPost('OK');
ok('successful processing alone receives explicit relay acknowledgement',
  wrapper.content === 'RELAY_OK' && wrapper.cleared === 0);

ok('doPost validates relay before provider routing', FIXED.indexOf('var __relay = _unwrapVerifiedRelay_(e)') < FIXED.indexOf('var __twFrom ='));
ok('invalid relay cannot reach the router', /__relay\.relayed && !__relay\.valid[\s\S]{0,220}RELAY_REJECTED/.test(FIXED));
ok('only local validation sets the trust marker', (FIXED.match(/__kflVerifiedRelay\s*=\s*true/g) || []).length === 1);
ok('strict mode rejects direct Meta at the authenticity gate', /KFL_REQUIRE_VERIFIED_RELAY[\s\S]{0,180}verified_relay_required/.test(FIXED));
ok('link-code failures propagate a router retry sentinel',
  /_linkCodeNeedsRelayRetry_\(__lcResult, __lcDelivery\)[\s\S]{0,180}RELAY_RETRY/.test(FIXED));
ok('authenticator exceptions fail closed', /verify_error_fail_closed/.test(FIXED) && !/verify_error_fail_open/.test(FIXED));
ok('DEPLOY remains preamble plus byte-identical FIXED source', DEPLOY.endsWith(FIXED));

console.log('test_whatsapp_verified_relay: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
