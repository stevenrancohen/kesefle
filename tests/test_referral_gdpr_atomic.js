#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'account.js'), 'utf8');

function extractFunction(name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  assert.ok(match, name + ' exists');
  const start = match.index;
  let paren = source.indexOf('(', start), params = 0, after = paren;
  for (; after < source.length; after += 1) {
    if (source[after] === '(') params += 1;
    else if (source[after] === ')' && --params === 0) { after += 1; break; }
  }
  const body = source.indexOf('{', after);
  let depth = 0, quote = '', escaped = false, line = false, block = false;
  for (let index = body; index < source.length; index += 1) {
    const char = source[index], next = source[index + 1];
    if (line) { if (char === '\n') line = false; continue; }
    if (block) { if (char === '*' && next === '/') { block = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { line = true; index += 1; continue; }
    if (char === '/' && next === '*') { block = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error('unterminated ' + name);
}

function response(ok, body) { return { ok, async json() { return body; } }; }
function reverseRuntime(fetch) {
  const context = {
    fetch, JSON, Error,
    process: { env: { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 'token' } },
  };
  vm.runInNewContext([
    extractFunction('kvDeleteReferralReverseIfOwned'),
    'globalThis.reverse=kvDeleteReferralReverseIfOwned;',
  ].join('\n'), context, { filename: 'referral-reverse-runtime.js' });
  return context.reverse;
}

(async function main() {
  console.log('\n=== referral GDPR deletion gate + reverse ownership ===\n');

  for (const status of ['deleted', 'missing', 'foreign']) {
    const reverse = reverseRuntime(async (_url, options = {}) => {
      const command = JSON.parse(options.body);
      assert.strictEqual(command[0], 'EVAL');
      assert.match(command[1], /owner ~= ARGV\[1\]/);
      return response(true, { result: JSON.stringify({ status }) });
    });
    assert.strictEqual(await reverse('ABC234', 'owner'), status);
  }
  await assert.rejects(
    () => reverseRuntime(async () => response(false, {}))('ABC234', 'owner'),
    /referral_reverse_delete_unavailable/,
  );

  const webDelete = extractFunction('deleteAccount');
  const botDelete = extractFunction('deleteByPhone');
  for (const body of [webDelete, botDelete]) {
    assert.match(body, /_ensureLegacyReferralPrivacy_\(deleted\)/);
    assert.match(body, /return _privacyCleanupPendingResponse_\(res, error\)/);
    assert.ok(body.indexOf('_ensureLegacyReferralPrivacy_') < body.indexOf('revokeGoogleToken'));
    assert.ok(body.indexOf('_ensureLegacyReferralPrivacy_') < body.indexOf('kvDeleteReferralReverseIfOwned'));
  }
  assert.ok(webDelete.indexOf('_ensureLegacyReferralPrivacy_') < webDelete.indexOf("kvGet('user:' + userSub)"));
  assert.ok(botDelete.indexOf('_ensureLegacyReferralPrivacy_') < botDelete.indexOf("kvGet('phone:' + phone)"));
  assert.match(source, /function _privacyCleanupPendingResponse_[\s\S]*?status\(503\)[\s\S]*?privacy_cleanup_pending/);
  assert.match(source, /async function _ensureLegacyReferralPrivacy_[\s\S]*?migrateLegacyReferralPii\(\)/);
  assert.doesNotMatch(extractFunction('_ensureLegacyReferralPrivacy_'), /maxPages|pageSize|worker:\s*true/);
  assert.doesNotMatch(source, /_purgeLegacyReferralEmail_|function kvScan|function kvScrubLegacyReferralList/);

  console.log('Referral GDPR deletion gate + reverse ownership: PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
