// Regression coverage for account-deletion audit receipts.
// The receipt must prove the operation without recreating the PII just erased.

import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHmac } from 'node:crypto';

const account = fs.readFileSync(new URL('../api/account.js', import.meta.url), 'utf8');
const secureKv = fs.readFileSync(new URL('../lib/secure-kv.js', import.meta.url), 'utf8');
const goals = fs.readFileSync(new URL('../lib/goals.js', import.meta.url), 'utf8');

function functionSourceFrom(source, name) {
  let start = source.indexOf(`async function ${name}(`);
  if (start === -1) start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let afterParams = paramsStart;
  for (; afterParams < source.length; afterParams += 1) {
    if (source[afterParams] === '(') paramsDepth += 1;
    else if (source[afterParams] === ')' && --paramsDepth === 0) {
      afterParams += 1;
      break;
    }
  }
  const open = source.indexOf('{', afterParams);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

function functionSource(name) {
  return functionSourceFrom(account, name);
}

const writer = functionSource('_writeDeletionAudit_');
const purge = functionSource('_purgeUserRecords_');
const webDelete = functionSource('deleteAccount');
const botDelete = functionSource('deleteByPhone');

assert.match(account, /import \{ auditLog \} from ['"]\.\.\/lib\/secure-kv\.js['"]/,
  'account deletion reuses the TTL-bound audit primitive');
assert.match(writer, /auditLog\(\s*['"]account_deletion['"],\s*subject \|\| null/,
  'receipt uses the common pseudonymous audit writer');
assert.match(writer, /channel[\s\S]*outcome[\s\S]*deletedKeyCount/,
  'receipt schema is aggregate-only');
assert.doesNotMatch(writer, /email|phone|\bip\b|forwarded|deletedKeys|reqId/i,
  'receipt writer cannot accept direct identifiers, headers, key names, or request IDs');

assert.match(webDelete, /_writeDeletionAudit_\(userSub, ['"]web['"], ['"]deleted['"], deleted\.length\)/,
  'authenticated deletion writes a minimized receipt');
assert.match(webDelete, /const purge = await _purgeUserRecords_[\s\S]*?if \(!purge\.complete\)[\s\S]*?retry_required[\s\S]*?return _deletionRetryRequiredResponse_[\s\S]*?_writeDeletionAudit_\(userSub, ['"]web['"], ['"]deleted['"]/,
  'authenticated deletion writes deleted only after a confirmed complete purge');
assert.match(webDelete, /revokeGoogleToken\(refreshToken\)[\s\S]*?retry_required[\s\S]*?return _deletionRetryRequiredResponse_/,
  'authenticated deletion retries instead of deleting after failed OAuth revocation');

assert.match(botDelete, /if \(phoneRec === null\)[\s\S]*?_writeDeletionAudit_\(null, ['"]whatsapp['"], ['"]no_linked_user['"], deleted\.length\)/,
  'only an explicit missing phone mapping stores an anonymous no-link receipt');
assert.doesNotMatch(botDelete, /if \(phoneRec === null\)[\s\S]{0,400}?kvDel\(['"]phone:/,
  'no-link path cannot race-delete a concurrently created phone mapping');
assert.match(botDelete, /_writeDeletionAudit_\(userSub, ['"]whatsapp['"], ['"]deleted['"], deleted\.length\)/,
  'linked WhatsApp deletion writes the same minimized receipt');
assert.match(botDelete, /const purge = await _purgeUserRecords_[\s\S]*?if \(!purge\.complete\)[\s\S]*?retry_required[\s\S]*?return _deletionRetryRequiredResponse_[\s\S]*?_writeDeletionAudit_\(userSub, ['"]whatsapp['"], ['"]deleted['"]/,
  'linked WhatsApp deletion writes deleted only after a confirmed complete purge');
assert.match(webDelete, /userRec === null[\s\S]*?_hasDeletionReceipt_\(['"]user['"], userSub\)[\s\S]*?_webDeletionSuccessResponse_\(res, deleted, true\)/,
  'web retries replay success from the durable completion receipt');
assert.match(botDelete, /phoneRec === null[\s\S]*?_hasDeletionReceipt_\(['"]phone['"], phone\)[\s\S]*?replayed: true/,
  'WhatsApp retries replay success from the durable completion receipt');
assert.match(webDelete, /prepared\.status === ['"]foreign['"][\s\S]*?phone = null[\s\S]*?_purgeUserRecords_\(userSub, phone, userRec\.subscriptionId, deleted\)/,
  'stale userPhone pointers detach instead of deleting a foreign tenant phone namespace');

assert.match(purge, /filter\(\(key\) => key !== identityKey && key !== phoneKey && key !== reversePhoneKey\)/,
  'canonical user, phone, and reverse records are excluded from the secondary deletion pass');
assert.match(purge, /if \(failed === 0\)[\s\S]*?_finalizeUserAnchors_\(userSub, phone\)/,
  'both retry anchors stay intact until every secondary delete succeeds');
assert.match(purge, /return \{ complete: failed === 0, failed \}/,
  'purge reports a strict completion result to both routes');
assert.match(account, /async function _finalizeUserAnchors_[\s\S]*?#!lua flags=allow-key-locking[\s\S]*?foreign_phone_anchor[\s\S]*?redis\.call\(['"]DEL['"], KEYS\[2\]\)[\s\S]*?redis\.call\(['"]DEL['"], KEYS\[3\]\)[\s\S]*?redis\.call\(['"]DEL['"], KEYS\[1\]\)/,
  'user, owned phone, and reverse anchors are finalized atomically after an ownership check');
assert.match(account, /_deletionReceiptKey_[\s\S]*?createHmac\(['"]sha256['"][\s\S]*?deletion:complete:/,
  'replay receipt keys are opaque HMACs rather than enumerable phone hashes');
assert.match(account, /_finalizeUserAnchors_[\s\S]*?redis\.call\(['"]SET['"], KEYS\[5\], ARGV\[2\], ['"]EX['"], ARGV\[3\]\)[\s\S]*?redis\.call\(['"]SET['"], KEYS\[6\], ARGV\[2\], ['"]EX['"], ARGV\[3\]\)[\s\S]*?redis\.call\(['"]DEL['"], KEYS\[2\]\)/,
  'phone and user completion receipts commit in the same transaction as anchor deletion');
assert.match(account, /async function _beginDeletion_[\s\S]*?redis\.call\(['"]SET['"], KEYS\[2\], ARGV\[1\]\)/,
  'deletion publishes a key-locked guard before destructive work');
assert.match(webDelete, /_beginDeletion_\(userSub\)[\s\S]*?kvGet\(['"]userPhone:/,
  'web deletion marks the guard before resolving phone-scoped state');
assert.match(botDelete, /_beginDeletion_\(userSub\)[\s\S]*?_preparePhoneAnchor_/,
  'WhatsApp deletion marks the guard before reserving the phone namespace');
assert.match(account, /function _deletionRetryRequiredResponse_[\s\S]*?Retry-After[\s\S]*?status\(503\)/,
  'partial deletion returns an explicit retryable non-2xx response');

assert.doesNotMatch(webDelete, /email:\s*userRec\.email|deletedKeys:\s*deleted|x-forwarded-for|audit:delete:/,
  'legacy PII-rich, non-expiring deletion audit is gone from account deletion');
assert.doesNotMatch(account, /deletedKeys:\s*deleted|x-forwarded-for|audit:delete:/,
  'legacy deletion receipt fields and key format are absent project-wide');
assert.match(secureKv, /rawSet\(key, entry, \{ ttlSec: 730 \* 86400, signal \}\)/,
  'common audit writer enforces the documented 730-day TTL');
assert.match(secureKv, /auditLog\([\s\S]*?timeoutMs = 1500[\s\S]*?withDeadline/,
  'audit writes have a bounded default deadline');
assert.match(goals, /fetchJsonWithDeadline[\s\S]*?await response\.json\(\)/,
  'goal index response bodies are parsed inside the deadline');
assert.match(goals, /purgeGoals[\s\S]*?Array\.isArray\(idx\)[\s\S]*?goals_index_malformed/,
  'goal purge rejects malformed indexes instead of orphaning goal records');

// Execute the strict purge coordinator with controlled failures. A failed
// secondary delete must preserve user:{sub}; a complete pass deletes it last.
async function runPurge({ failKey = null, phone = '972500000000' } = {}) {
  const calls = [];
  const context = {
    _keysForUser_: async (_subject, phoneValue) => [
      'user:subject',
      'userPhone:subject',
      ...(phoneValue ? ['phone:' + phoneValue, 'profile:' + phoneValue] : []),
      'sheet:subject',
      'token:subject',
    ],
    kvDel: async (key) => { calls.push('del:' + key); return key !== failKey; },
    _purgeManualPaymentsStrict_: async () => ({ failed: 0 }),
    _purgeMultiKeyUserRecords_: async () => ({ failed: 0 }),
    kvSetRemove: async () => { calls.push('srem:users_all'); return true; },
    _finalizeUserAnchors_: async () => {
      calls.push('finalize:user+phone');
      return { complete: true, deletedKeys: phone ? ['phone:' + phone, 'user:subject'] : ['user:subject'] };
    },
  };
  vm.runInNewContext(`${purge}\nglobalThis.run = _purgeUserRecords_;`, context);
  const deleted = [];
  const result = await context.run('subject', phone, null, deleted);
  return { calls, deleted, result };
}

const partial = await runPurge({ failKey: 'token:subject' });
assert.equal(partial.result.complete, false, 'secondary failure marks the purge incomplete');
assert.equal(partial.calls.includes('del:user:subject'), false,
  'secondary failure preserves the canonical user retry anchor');
assert.equal(partial.calls.includes('del:phone:972500000000'), false,
  'secondary failure preserves the WhatsApp-resolvable phone retry anchor');
assert.equal(partial.calls.includes('del:userPhone:subject'), false,
  'secondary failure preserves the reverse mapping race anchor');
assert.equal(partial.calls.includes('finalize:user+phone'), false,
  'secondary failure never enters atomic anchor finalization');

const complete = await runPurge();
assert.equal(complete.result.complete, true, 'all acknowledged operations mark the purge complete');
assert.equal(complete.calls.at(-1), 'finalize:user+phone',
  'atomic user+phone finalization is the final destructive operation');

const foreignSafe = await runPurge({ phone: null });
assert.equal(foreignSafe.calls.some((call) => call.includes('phone:') || call.includes('profile:')), false,
  'foreign phone ownership path performs zero phone-scoped deletes');

// Pending manual payments must remain discoverable until every child delete is
// acknowledged. Exercise malformed inventory and mid-purge response loss.
async function runManualPurge({ index, records = {}, failKey = null, throwKey = null }) {
  const calls = [];
  const indexKey = 'manual:index';
  const context = {
    MANUAL_PAYMENT_CODE_RE: /^KFL-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/,
    MANUAL_PAYMENT_INDEX_MAX: 1000,
    manualPaymentIndexKey: () => indexKey,
    kvGet: async (key) => key === indexKey ? index : (records[key] ?? null),
    kvDel: async (key) => {
      calls.push(key);
      if (key === throwKey) throw new Error('lost_response');
      return key !== failKey;
    },
    log: { warn() {} }, Set, String, Array,
  };
  vm.runInNewContext([
    functionSource('_manualPaymentsForUserStrict_'),
    functionSource('_purgeManualPaymentsStrict_'),
    'globalThis.run = _purgeManualPaymentsStrict_;',
  ].join('\n'), context);
  const deleted = [];
  const result = await context.run('subject', deleted);
  return { calls, deleted, result };
}

const malformedManual = await runManualPurge({ index: ['BAD-CODE'] });
assert.equal(malformedManual.result.failed, 1, 'malformed manual-payment index fails closed');
assert.deepEqual(malformedManual.calls, [], 'malformed index deletes nothing');

const manualRecords = {
  'pendingPayment:KFL-ABC234': { code: 'KFL-ABC234', status: 'pending', userSub: 'subject' },
  'pendingPayment:KFL-DEF234': { code: 'KFL-DEF234', status: 'pending', userSub: 'subject' },
};
const partialManual = await runManualPurge({
  index: ['KFL-ABC234', 'KFL-DEF234'], records: manualRecords,
  throwKey: 'pendingPayment:KFL-DEF234',
});
assert.equal(partialManual.result.failed, 1, 'lost child DEL response makes deletion retryable');
assert.equal(partialManual.calls.includes('manual:index'), false,
  'manual-payment index survives every child failure as the retry inventory');

const completeManual = await runManualPurge({
  index: ['KFL-ABC234', 'KFL-DEF234'], records: manualRecords,
});
assert.equal(completeManual.result.failed, 0, 'all acknowledged child deletes complete');
assert.equal(completeManual.calls.at(-1), 'manual:index', 'manual-payment index is deleted last');

const prepareContext = {
  process: { env: { KV_REST_API_URL: 'https://kv.invalid', KV_REST_API_TOKEN: 'test' } },
  _fetchJsonWithDeadline_: async () => ({
    response: { ok: true },
    payload: { result: JSON.stringify({ status: 'foreign' }) },
  }),
};
vm.runInNewContext(`${functionSource('_preparePhoneAnchor_')}\nglobalThis.run = _preparePhoneAnchor_;`, prepareContext);
assert.equal((await prepareContext.run('subject-a', '972500000000')).status, 'foreign',
  'stale A pointer to B-owned phone is detected before any phone-scoped purge');

// Simulate an atomic finalizer commit whose HTTP response is lost. The EVAL
// writes opaque replay receipts before deleting both anchors; the next web or
// bot attempt can therefore recover a truthful success.
const committedReceipts = new Map();
let finalizerCommand;
const receiptContext = {
  process: { env: { KV_REST_API_URL: 'https://kv.invalid', KV_REST_API_TOKEN: 'hmac-secret' } },
  createHmac,
  userDeletionKey: (subject) => `deleted:${createHmac('sha256', 'test').update(subject).digest('hex')}`,
  DELETION_RECEIPT_TTL_SEC: 7 * 86400,
  DELETION_GUARD_COOLDOWN_SEC: 10 * 60,
  DELETION_TOMBSTONE_TTL_SEC: 400 * 86400,
  _fetchJsonWithDeadline_: async (_url, init) => {
    finalizerCommand = JSON.parse(init.body);
    const keyCount = Number(finalizerCommand[2]);
    const keys = finalizerCommand.slice(3, 3 + keyCount);
    const args = finalizerCommand.slice(3 + keyCount);
    const receipt = JSON.parse(args[1]);
    committedReceipts.set(keys[4], receipt);
    committedReceipts.set(keys[5], receipt);
    throw new Error('response_lost_after_commit');
  },
  kvGet: async (key) => committedReceipts.get(key) || null,
};
vm.runInNewContext([
  functionSource('_deletionReceiptKey_'),
  functionSource('_deletionGuardKey_'),
  functionSource('_hasDeletionReceipt_'),
  functionSource('_finalizeUserAnchors_'),
  'globalThis.finalize = _finalizeUserAnchors_;',
  'globalThis.hasReceipt = _hasDeletionReceipt_;',
].join('\n'), receiptContext);
const ambiguousFinal = await receiptContext.finalize('google-subject-a', '972500000000');
assert.equal(ambiguousFinal.complete, false, 'lost finalizer response remains retryable in the first request');
assert.equal(finalizerCommand[2], '7', 'atomic finalizer declares user, phone, reverse, guard, both receipts, and billing tombstone as keys');
assert.doesNotMatch(finalizerCommand[6], /google-subject-a|972500000000/,
  'deletion guard key does not expose the Google subject');
assert.doesNotMatch(finalizerCommand[7], /google-subject-a|972500000000/,
  'user replay key does not expose its source identifier');
assert.doesNotMatch(finalizerCommand[8], /google-subject-a|972500000000/,
  'phone replay key does not expose its source identifier');
assert.equal(await receiptContext.hasReceipt('user', 'google-subject-a'), true,
  'web retry recovers success from the committed receipt');
assert.equal(await receiptContext.hasReceipt('phone', '972500000000'), true,
  'WhatsApp retry recovers success from the committed receipt');

// The account-specific network wrapper is bounded too, so a hung revoke/KV
// call cannot leave a request suspended after earlier destructive operations.
const deadlineContext = {
  fetch: async () => new Promise(() => {}),
  AbortController,
  setTimeout,
  clearTimeout,
};
vm.runInNewContext(`const ACCOUNT_IO_TIMEOUT_MS = 3000;\n${functionSource('_withDeadline_')}\n${functionSource('_fetchWithDeadline_')}\n${functionSource('_fetchJsonWithDeadline_')}\nglobalThis.fetchOnly = _fetchWithDeadline_;\nglobalThis.fetchJson = _fetchJsonWithDeadline_;`, deadlineContext);
const deadlineStartedAt = Date.now();
await assert.rejects(() => deadlineContext.fetchOnly('https://example.invalid', {}, 25), /account_io_timeout/);
assert.ok(Date.now() - deadlineStartedAt < 250, 'account network deadline rejects a hung transport promptly');

deadlineContext.fetch = async () => ({ ok: true, json: async () => new Promise(() => {}) });
const bodyStartedAt = Date.now();
await assert.rejects(() => deadlineContext.fetchJson('https://example.invalid', {}, 25), /account_io_timeout/);
assert.ok(Date.now() - bodyStartedAt < 250, 'deadline remains active while a response body is parsed');

// Strict KV reads distinguish explicit missing from HTTP/malformed/outage.
function kvGetRuntime(fetchImpl) {
  const context = {
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    process: { env: { KV_REST_API_URL: 'https://kv.invalid', KV_REST_API_TOKEN: 'test' } },
  };
  vm.runInNewContext(`const ACCOUNT_IO_TIMEOUT_MS = 25;\n${functionSource('_withDeadline_')}\n${functionSource('_fetchJsonWithDeadline_')}\n${functionSource('kvGet')}\nglobalThis.run = kvGet;`, context);
  return context.run;
}

assert.equal(await kvGetRuntime(async () => ({ ok: true, json: async () => ({ result: null }) }))('phone:x'), null,
  'only explicit result:null is treated as missing');
await assert.rejects(
  () => kvGetRuntime(async () => ({ ok: false, json: async () => ({ error: 'outage' }) }))('phone:x'),
  /kv_read_failed/,
  'HTTP failure is not treated as missing',
);
await assert.rejects(
  () => kvGetRuntime(async () => ({ ok: true, json: async () => ({}) }))('phone:x'),
  /kv_read_malformed/,
  'missing result field is not treated as missing',
);
await assert.rejects(
  () => kvGetRuntime(async () => ({ ok: true, json: async () => new Promise(() => {}) }))('phone:x'),
  /account_io_timeout/,
  'never-resolving KV bodies fail closed',
);
await assert.rejects(
  () => kvGetRuntime(async () => ({ ok: true, json: async () => ({ result: 'ABC234' }) }))('referral:code:x'),
  /kv_read_malformed/,
  'raw strings remain rejected by default',
);
assert.equal(
  await kvGetRuntime(async () => ({ ok: true, json: async () => ({ result: 'ABC234' }) }))(
    'referral:code:x', { allowRawString: true },
  ),
  'ABC234',
  'typed scalar reads accept the legitimate raw referral-code format',
);

function purgeGoalsRuntime(fetchImpl) {
  const context = {
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    process: { env: { KV_REST_API_URL: 'https://kv.invalid', KV_REST_API_TOKEN: 'test' } },
  };
  vm.runInNewContext([
    'const KV_IO_TIMEOUT_MS = 25;',
    'const KV_URL = () => process.env.KV_REST_API_URL;',
    'const KV_TOK = () => process.env.KV_REST_API_TOKEN;',
    functionSourceFrom(goals, 'withDeadline'),
    functionSourceFrom(goals, 'fetchWithDeadline'),
    functionSourceFrom(goals, 'fetchJsonWithDeadline'),
    functionSourceFrom(goals, 'kvGet'),
    functionSourceFrom(goals, 'kvDel'),
    functionSourceFrom(goals, '_goalKey'),
    functionSourceFrom(goals, '_indexKey'),
    functionSourceFrom(goals, 'purgeGoals'),
    'globalThis.run = purgeGoals;',
  ].join('\n'), context);
  return context.run;
}

await assert.rejects(
  () => purgeGoalsRuntime(async () => ({ ok: false, json: async () => ({ error: 'outage' }) }))('subject'),
  /goals_kv_read_failed/,
  'goal purge fails closed on an index read outage',
);
await assert.rejects(
  () => purgeGoalsRuntime(async () => ({ ok: true, json: async () => ({ result: JSON.stringify('not-an-array') }) }))('subject'),
  /goals_index_malformed/,
  'goal purge rejects a malformed index instead of orphaning records',
);
await assert.rejects(
  () => purgeGoalsRuntime(async () => ({ ok: true, json: async () => new Promise(() => {}) }))('subject'),
  /goals_kv_timeout/,
  'goal index body parsing is covered by the deadline',
);
const failedGoalCalls = [];
const failedGoalResult = await purgeGoalsRuntime(async (url) => {
  failedGoalCalls.push(String(url));
  if (String(url).includes('/get/')) {
    return { ok: true, json: async () => ({ result: JSON.stringify(['g_0123456789abcdef']) }) };
  }
  if (String(url).includes('goal%3Asubject%3Ag_0123456789abcdef')) return { ok: false };
  return { ok: true };
})('subject');
assert.equal(failedGoalResult.ok, false, 'failed child goal deletion keeps the purge incomplete');
assert.equal(failedGoalCalls.some((url) => url.includes('del/goals%3Asubject')), false,
  'failed child goal deletion preserves the index as the retry manifest');
const goalCalls = [];
const goalResult = await purgeGoalsRuntime(async (url) => {
  goalCalls.push(String(url));
  if (String(url).includes('/get/')) {
    return { ok: true, json: async () => ({ result: JSON.stringify(['g_0123456789abcdef']) }) };
  }
  return { ok: true };
})('subject');
assert.equal(goalResult.ok, true, 'validated goal index purge reports complete');
assert.equal(goalResult.purged, 1, 'validated goal index deletes every indexed goal');
assert.ok(goalCalls.some((url) => url.includes('goal%3Asubject%3Ag_0123456789abcdef')),
  'validated goal record is deleted before the index');

// Exercise the real audit transport as well as the wiring contract above.
// This proves that the raw subject appears in neither URL nor body and that
// the TTL reaches Upstash as an EX parameter.
const previousEnv = {
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
};
const previousFetch = globalThis.fetch;
const calls = [];
process.env.KV_REST_API_URL = 'https://example-kv.invalid';
process.env.KV_REST_API_TOKEN = 'test-token';
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
};
try {
  const { auditLog } = await import('../lib/secure-kv.js?account-delete-audit-privacy');
  const rawSubject = 'google-subject-never-persist-me';
  const stored = await auditLog('account_deletion', rawSubject, {
    channel: 'web',
    outcome: 'deleted',
    deletedKeyCount: 12,
  });
  assert.equal(stored, true, 'real audit writer reports a successful receipt');
  assert.equal(calls.length, 1, 'real audit writer performs one bounded KV write');
  assert.match(calls[0].url, /\/set\/audit%3Aaccount_deletion%3A/,
    'receipt uses the outcome-neutral account_deletion audit namespace');
  assert.match(calls[0].url, /[?&]EX=63072000(?:&|$)/,
    'receipt transport sends the 730-day TTL');
  assert.doesNotMatch(calls[0].url, /google-subject-never-persist-me/,
    'raw subject is absent from the KV key');
  assert.doesNotMatch(String(calls[0].init.body), /google-subject-never-persist-me/,
    'raw subject is absent from the receipt value');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.metadata, { channel: 'web', outcome: 'deleted', deletedKeyCount: 12 },
    'stored metadata is the intended aggregate-only schema');
  assert.match(body.subHash, /^[a-f0-9]{16}$/,
    'stored subject correlation is a one-way hash only');

  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Promise(() => {});
  };
  const startedAt = Date.now();
  const timedOut = await auditLog('account_deletion', rawSubject, {
    channel: 'web', outcome: 'deleted', deletedKeyCount: 12,
  }, { timeoutMs: 25 });
  const elapsed = Date.now() - startedAt;
  assert.equal(timedOut, false, 'never-resolving audit transport fails soft');
  assert.ok(elapsed < 250, `never-resolving audit transport is bounded (${elapsed} ms)`);
  assert.equal(calls.length, 1, 'timeout path still attempts exactly one audit write');
  assert.equal(calls[0].init.signal.aborted, true, 'timeout aborts the underlying audit request');
} finally {
  globalThis.fetch = previousFetch;
  if (previousEnv.url === undefined) delete process.env.KV_REST_API_URL;
  else process.env.KV_REST_API_URL = previousEnv.url;
  if (previousEnv.token === undefined) delete process.env.KV_REST_API_TOKEN;
  else process.env.KV_REST_API_TOKEN = previousEnv.token;
}

console.log('account deletion audit privacy: all checks passed');
