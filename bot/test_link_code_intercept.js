#!/usr/bin/env node
// Regression guard for the highest-priority WhatsApp account-link intercept.
// A link code must never be parsed as an expense, and its API outcome must not
// falsely tell a customer that their number belongs to someone else.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FIXED = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
const DEPLOY = fs.readFileSync(path.join(__dirname, 'ExpenseBot_DEPLOY.gs'), 'utf8');
let pass = 0;
let fail = 0;
const ok = (label, condition) => {
  if (condition) pass++;
  else { fail++; console.log('  FAIL ' + label); }
};

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    const next = src[j + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; j++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; j++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; j++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unterminated function: ' + name);
}

const interceptStart = FIXED.indexOf('var __linkCodeM =');
const expenseStart = FIXED.indexOf('var __looksLikeExpense = /^\\s*\\d/');
const generalDedupe = FIXED.indexOf("var __seenKey = 'seenmsg:' + __msgId_");
ok('link-code intercept exists', interceptStart >= 0);
ok('link-code intercept runs before expense fast-path', interceptStart < expenseStart);
ok('link-code intercept runs before general message dedupe', interceptStart < generalDedupe);
ok('intercept uses detailed outcome + delivery helper',
  /handleLinkCodeDetailed_\(__linkCodeM\[1\], __from_\)[\s\S]{0,180}_deliverLinkCodeOutcome_\(__msgId_, __from_, __lcResult, _gotLock\)/.test(FIXED));
ok('confirm is the only link API request (no GET precheck)',
  !/__statusUrl|method:\s*'get'/.test(extractFn(FIXED, 'handleLinkCodeDetailed_')));
ok('legacy wrapper still returns a string reply',
  /return handleLinkCodeDetailed_\(code, fromPhone\)\.reply/.test(extractFn(FIXED, 'handleLinkCode_')));
ok('provider result controls durable finalization',
  /if \(sendResult\.ok\)[\s\S]*_kvCompareSet_/.test(extractFn(FIXED, '_deliverLinkCodeOutcome_')));
ok('explicit send failure releases only the owned lease',
  /_kvCompareDelete_\(key, token\)/.test(extractFn(FIXED, '_deliverLinkCodeOutcome_')));
ok('atomic claim is SET NX EX',
  /\['SET', key, value, 'NX', 'EX'/.test(extractFn(FIXED, '_kvSetNx_')));
ok('compare mutations enable Upstash key locking',
  /#!lua flags=allow-key-locking/.test(extractFn(FIXED, '_kvCompareSet_')) &&
  /#!lua flags=allow-key-locking/.test(extractFn(FIXED, '_kvCompareDelete_')));
ok('DEPLOY is preserved preamble plus byte-identical FIXED source', DEPLOY.endsWith(FIXED));

const re = /(?:קוד|code|link)\s*[:\-]?\s*(\d{6})\b/i;
ok('Hebrew link code extracts six digits', (('קוד 870549'.match(re) || [])[1]) === '870549');
ok('English code/link variants match', re.test('code: 123456') && re.test('link 555000'));
ok('real expenses do not match', !re.test('850 שיווק') && !re.test('45 קפה'));
ok('five-digit code does not match', !re.test('קוד 12345'));

function response(status, body) {
  return { getResponseCode: () => status, getContentText: () => JSON.stringify(body) };
}
function runOutcome(status, body, thrown) {
  const requests = [];
  const context = {
    KESEFLE_API_BASE: 'https://example.test',
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'bot-secret-test' }) },
    UrlFetchApp: { fetch: (url, options) => {
      requests.push({ url, options });
      if (thrown) throw new Error('network down');
      return response(status, body);
    } },
    Logger: { log: () => {} }
  };
  vm.createContext(context);
  vm.runInContext(extractFn(FIXED, 'handleLinkCodeDetailed_'), context);
  vm.runInContext(extractFn(FIXED, 'handleLinkCode_'), context);
  return { outcome: context.handleLinkCodeDetailed_('123456', '972501234567'), requests, legacy: context.handleLinkCode_ };
}

let runtime = runOutcome(200, { ok: true, linked: true });
ok('success is classified for durable delivery', runtime.outcome.kind === 'success' && !runtime.outcome.retryable);
ok('single POST sends bot secret and no GET', runtime.requests.length === 1 &&
  runtime.requests[0].options.method === 'post' &&
  runtime.requests[0].options.headers['x-kesefle-bot-secret'] === 'bot-secret-test');
ok('legacy wrapper remains string-returning', typeof runtime.legacy('123456', '972501234567') === 'string');

runtime = runOutcome(409, { error: 'phone_unavailable' });
ok('exact phone_unavailable gets ownership copy', runtime.outcome.reason === 'phone_unavailable' && /חשבון אחר/.test(runtime.outcome.reply));
runtime = runOutcome(409, { error: 'verification_state_changed' });
ok('state change never claims another owner', runtime.outcome.reason === 'verification_state_changed' && !/חשבון אחר/.test(runtime.outcome.reply));
runtime = runOutcome(409, { error: 'some_future_conflict' });
ok('unknown conflict uses neutral copy', runtime.outcome.reason === 'verification_conflict' && !/חשבון אחר/.test(runtime.outcome.reply));
runtime = runOutcome(503, { error: 'verification_storage_unavailable' });
ok('storage outage is retryable with same code', runtime.outcome.retryable && /אותו קוד/.test(runtime.outcome.reply));
runtime = runOutcome(503, { error: 'bot_secret_not_configured' });
ok('missing bot secret is a terminal configuration error',
  !runtime.outcome.retryable && runtime.outcome.reason === 'bot_not_configured' && !/אותו קוד/.test(runtime.outcome.reply));
runtime = runOutcome(429, { error: 'rate_limit_exceeded' });
ok('rate limit remains retryable', runtime.outcome.retryable && runtime.outcome.reason === 'rate_limited');
runtime = runOutcome(404, { error: 'code_expired_or_invalid' });
ok('expired code is terminal', !runtime.outcome.retryable && runtime.outcome.reason === 'invalid_code');
runtime = runOutcome(500, {}, true);
ok('network error is retryable', runtime.outcome.retryable && runtime.outcome.reason === 'network_error');

function runSetNx(status, bodyText) {
  const context = {
    _kvCreds_: () => ({ url: 'https://redis.example', tok: 'secret' }),
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => status, getContentText: () => bodyText }) },
    Logger: { log: () => {} }
  };
  vm.createContext(context);
  vm.runInContext(extractFn(FIXED, '_kvCommand_'), context);
  vm.runInContext(extractFn(FIXED, '_kvSetNx_'), context);
  return context._kvSetNx_('linkReply:test', 'sending:test', 420);
}

let claim = runSetNx(200, JSON.stringify({ result: 'OK' }));
ok('real SET NX helper recognizes an acquired lease', claim.available && claim.acquired);
claim = runSetNx(200, JSON.stringify({ result: null }));
ok('real SET NX helper recognizes an existing lease', claim.available && !claim.acquired);
claim = runSetNx(200, JSON.stringify({ error: 'ERR unknown command' }));
ok('HTTP-200 Redis error degrades instead of suppressing a reply', !claim.available && !claim.acquired);
claim = runSetNx(200, JSON.stringify({ result: true }));
ok('unexpected SET NX result degrades instead of suppressing a reply', !claim.available && !claim.acquired);
claim = runSetNx(200, '{}');
ok('missing Redis result degrades instead of suppressing a reply', !claim.available && !claim.acquired);

console.log('test_link_code_intercept: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
