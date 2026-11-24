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
function runtime(fetch) {
  const context = { fetch, URL, JSON, String, Number, Array, Promise, Error, encodeURIComponent,
    process: { env: { KV_REST_API_URL: 'https://kv.test', KV_REST_API_TOKEN: 'token' } } };
  vm.runInNewContext([
    extractFunction('kvScan'),
    extractFunction('kvScrubLegacyReferralList'),
    extractFunction('kvDeleteReferralReverseIfOwned'),
    'globalThis.api={kvScan,kvScrubLegacyReferralList,kvDeleteReferralReverseIfOwned};',
  ].join('\n'), context, { filename: 'referral-gdpr-runtime.js' });
  return context.api;
}

function purgeRuntime(keys, results) {
  const context = {
    String,
    Promise,
    kvScan: async () => keys,
    kvScrubLegacyReferralList: async (key) => results[key] || { status: 'missing', changed: false },
  };
  vm.runInNewContext([
    extractFunction('_purgeLegacyReferralEmail_'),
    'globalThis.purge=_purgeLegacyReferralEmail_;',
  ].join('\n'), context, { filename: 'referral-gdpr-purge-runtime.js' });
  return context.purge;
}

(async function main() {
  console.log('\n=== referral GDPR atomic cleanup ===\n');
  assert.match(extractFunction('kvScrubLegacyReferralList'), /#!lua flags=allow-key-locking/);
  assert.match(extractFunction('kvScrubLegacyReferralList'), /\['EVAL', script, '1', key, targetEmail\]/);
  assert.match(extractFunction('kvScrubLegacyReferralList'), /for key, value in pairs\(decoded\)/);
  assert.match(extractFunction('kvScrubLegacyReferralList'), /for index = 1, entries do/);
  assert.doesNotMatch(extractFunction('kvScrubLegacyReferralList'), /\/get\/|\/set\//);

  const at = '2026-11-24T00:00:00.000Z';
  let list = [{ email: 'delete@example.com', at }, { email: 'other@example.com', at }];
  let commands = 0;
  const api = runtime(async (_url, options = {}) => {
    const command = JSON.parse(options.body);
    commands += 1;
    assert.strictEqual(command[0], 'EVAL');
    assert.strictEqual(command[2], '1');
    assert.strictEqual(command[3], 'referral:redeemers:owner');
    // Simulate an append after a hypothetical old GET. A locked transform sees
    // current state and preserves it; a client GET->SET would lose this row.
    list.push({ emailInitial: 'n', at });
    list = list.flatMap((entry) => {
      if (typeof entry.email === 'string') {
        if (entry.email.toLowerCase() === command[4]) return [];
        return [{ emailInitial: '?', at: entry.at }];
      }
      return [{ emailInitial: entry.emailInitial, at: entry.at }];
    });
    return response(true, { result: JSON.stringify({ status: 'ok', changed: true }) });
  });
  assert.strictEqual((await api.kvScrubLegacyReferralList(
    'referral:redeemers:owner', 'delete@example.com')).status, 'ok');
  assert.strictEqual(commands, 1);
  assert.deepStrictEqual(list, [{ emailInitial: '?', at }, { emailInitial: 'n', at }]);

  await assert.rejects(() => runtime(async () => response(false, {}))
    .kvScan('referral:redeemers:*'), /kv_scan_failed/);
  await assert.rejects(() => runtime(async () => response(true, { result: ['0', null] }))
    .kvScan('referral:redeemers:*'), /kv_scan_malformed/);
  await assert.rejects(() => runtime(async () => response(true, { result: ['7', ['a', 'b', 'c']] }))
    .kvScan('referral:redeemers:*', 2), /kv_scan_limit/);
  let pages = 0;
  const incomplete = runtime(async () => { pages += 1; return response(true, { result: ['7', []] }); });
  await assert.rejects(() => incomplete.kvScan('referral:redeemers:*'), /kv_scan_incomplete/);
  assert.strictEqual(pages, 60);

  for (const status of ['deleted', 'missing', 'foreign']) {
    const reverse = runtime(async (_url, options = {}) => {
      const command = JSON.parse(options.body);
      assert.strictEqual(command[0], 'EVAL');
      assert.match(command[1], /owner ~= ARGV\[1\]/);
      return response(true, { result: JSON.stringify({ status }) });
    });
    assert.strictEqual(await reverse.kvDeleteReferralReverseIfOwned('ABC234', 'owner'), status);
  }
  await assert.rejects(() => runtime(async () => response(false, {}))
    .kvDeleteReferralReverseIfOwned('ABC234', 'owner'), /referral_reverse_delete_unavailable/);

  const deleted = [];
  await purgeRuntime(
    ['referral:redeemers:foreign-sub-a', 'referral:redeemers:foreign-sub-b'],
    {
      'referral:redeemers:foreign-sub-a': { status: 'ok', changed: true },
      'referral:redeemers:foreign-sub-b': { status: 'ok', changed: true },
    },
  )('delete@example.com', deleted);
  assert.deepStrictEqual(deleted, ['referral:legacy-email-redactions:2']);
  assert.ok(!deleted.join(' ').includes('foreign-sub-a'));
  assert.ok(!deleted.join(' ').includes('foreign-sub-b'));

  assert.match(source, /async function deleteAccount[\s\S]*?_purgeLegacyReferralEmail_[\s\S]*?revokeGoogleToken/);
  assert.match(source, /async function deleteByPhone[\s\S]*?_purgeLegacyReferralEmail_[\s\S]*?revokeGoogleToken/);
  assert.match(source, /async function deleteAccount[\s\S]*?kvDeleteReferralReverseIfOwned[\s\S]*?revokeGoogleToken/);
  assert.match(source, /async function deleteByPhone[\s\S]*?kvDeleteReferralReverseIfOwned[\s\S]*?revokeGoogleToken/);
  console.log('Referral GDPR atomic cleanup: PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
