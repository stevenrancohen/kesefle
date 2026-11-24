// Executable interleaving coverage for WhatsApp confirmation vs account delete.
// Both sides run their production helper source against one in-memory Redis
// transaction model, proving that every serialization order is safe.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const { createHmac } = require('crypto');

const ROOT = path.join(__dirname, '..');
const ACCOUNT = fs.readFileSync(path.join(ROOT, 'api/account.js'), 'utf8');
const LINK = fs.readFileSync(path.join(ROOT, 'api/whatsapp/link.js'), 'utf8');

function extractFunction(source, name) {
  let start = source.indexOf(`async function ${name}(`);
  if (start < 0) start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
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
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

function redisWorld() {
  const store = new Map();
  const json = (key) => store.has(key) ? JSON.parse(store.get(key)) : null;
  const del = (key) => store.delete(key) ? 1 : 0;
  const result = (value) => ({ response: { ok: true }, payload: { result: JSON.stringify(value) } });

  function evalCommand(command) {
    assert.equal(command[0], 'EVAL');
    const script = command[1];
    const keyCount = Number(command[2]);
    const keys = command.slice(3, 3 + keyCount);
    const args = command.slice(3 + keyCount);

    if (script.includes("status = 'marked'")) {
      const user = json(keys[0]);
      if (!user) return result({ status: 'user_missing' });
      if (typeof user !== 'object' || Array.isArray(user)) return result({ status: 'user_malformed' });
      store.set(keys[1], args[0]);
      return result({ status: 'marked' });
    }

    if (script.includes('KESEFLE_PHONE_LINK_CONFIRM_V2')) {
      const [userKey, sheetKey, phoneKey, reverseKey, codeKey, guardKey] = keys;
      const [userSub, phone, linkedAt] = args;
      let pending;
      try { pending = json(codeKey); } catch { return result({ status: 'code_invalid' }); }
      if (!pending) return result({ status: 'code_missing' });
      if (pending.userSub !== userSub || (pending.phone != null && String(pending.phone) !== phone)) {
        return result({ status: 'code_invalid' });
      }
      if (store.has(guardKey)) {
        del(codeKey);
        return result({ status: 'account_deleting' });
      }
      const user = json(userKey);
      if (!user) { del(codeKey); return result({ status: 'user_missing' }); }
      const existing = json(phoneKey);
      if (existing && existing.userSub !== userSub) { del(codeKey); return result({ status: 'foreign_phone' }); }
      const existingReverse = json(reverseKey);
      if (existingReverse && existingReverse.phone !== phone) {
        return result({ status: 'different_phone_linked' });
      }
      if (pending.status === 'confirmed') {
        if (!existing || !existingReverse) return result({ status: 'replay_incomplete' });
        return result({ status: 'linked', record: existing, replayed: true });
      }
      if (pending.status != null) return result({ status: 'code_invalid' });
      const sheet = json(sheetKey) || {};
      const record = {
        userSub,
        email: user.email || '',
        plan: user.plan || 'free',
        spreadsheetId: sheet.spreadsheetId || user.spreadsheetId || null,
        spreadsheetUrl: sheet.spreadsheetUrl || user.spreadsheetUrl || null,
        linkedAt,
      };
      store.set(phoneKey, JSON.stringify(record));
      store.set(reverseKey, JSON.stringify({ phone, linkedAt }));
      store.set(codeKey, JSON.stringify({ status: 'confirmed', userSub, phone, linkedAt }));
      return result({ status: 'linked', record });
    }

    if (script.includes('foreign_phone_anchor')) {
      const [identityKey, phoneKey, reverseKey, guardKey, userReceiptKey, phoneReceiptKey] = keys;
      const [userSub, receipt, receiptTtl, completedGuard, guardTtl] = args;
      const phone = json(phoneKey);
      if (phone && phone.userSub !== userSub) return result({ status: 'foreign_phone_anchor' });
      assert.equal(receiptTtl, String(7 * 86400));
      assert.equal(guardTtl, String(10 * 60));
      store.set(userReceiptKey, receipt);
      store.set(phoneReceiptKey, receipt);
      store.set(guardKey, completedGuard);
      return result({
        status: 'complete',
        phoneDeleted: del(phoneKey),
        reverseDeleted: del(reverseKey),
        userDeleted: del(identityKey),
      });
    }

    throw new Error('unknown EVAL script');
  }

  return { store, json, evalCommand };
}

function runtimes(world) {
  const env = { KV_REST_API_URL: 'https://kv.invalid', KV_REST_API_TOKEN: 'race-secret' };
  const accountContext = {
    process: { env }, createHmac,
    DELETION_RECEIPT_TTL_SEC: 7 * 86400,
    DELETION_GUARD_COOLDOWN_SEC: 10 * 60,
    _fetchJsonWithDeadline_: async (_url, init) => world.evalCommand(JSON.parse(init.body)),
  };
  vm.runInNewContext([
    extractFunction(ACCOUNT, '_deletionReceiptKey_'),
    extractFunction(ACCOUNT, '_deletionGuardKey_'),
    extractFunction(ACCOUNT, '_beginDeletion_'),
    extractFunction(ACCOUNT, '_finalizeUserAnchors_'),
    'globalThis.begin = _beginDeletion_;',
    'globalThis.finalize = _finalizeUserAnchors_;',
    'globalThis.guardKey = _deletionGuardKey_;',
  ].join('\n'), accountContext);

  let loseNextResponse = false;
  const linkContext = {
    process: { env }, createHmac, AbortController, setTimeout, clearTimeout,
    fetch: async (_url, init) => {
      const transport = world.evalCommand(JSON.parse(init.body));
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new Error('response_lost_after_commit');
      }
      return { ok: transport.response.ok, json: async () => transport.payload };
    },
  };
  vm.runInNewContext([
    extractFunction(LINK, '_linkJsonWithDeadline_'),
    extractFunction(LINK, '_deletionGuardKey_'),
    extractFunction(LINK, '_confirmPhoneLinkAtomically_'),
    'globalThis.confirm = _confirmPhoneLinkAtomically_;',
  ].join('\n'), linkContext);
  return {
    account: accountContext,
    link: linkContext,
    loseNextLinkResponse() { loseNextResponse = true; },
  };
}

function seed(world, sub, phone, code) {
  world.store.set('user:' + sub, JSON.stringify({ email: sub + '@example.com', plan: 'free', spreadsheetId: 'SHEET' }));
  world.store.set('sheet:' + sub, JSON.stringify({ spreadsheetId: 'SHEET' }));
  world.store.set('linkCode:' + code, JSON.stringify({ userSub: sub, phone }));
}

async function main() {

// Confirmation serializes first: deletion sees both mappings and removes both.
{
  const world = redisWorld();
  const runtime = runtimes(world);
  const sub = 'google:confirm-first';
  const phone = '972500000101';
  seed(world, sub, phone, '111111');
  assert.equal((await runtime.link.confirm('111111', phone, sub, '2026-11-24T00:00:00.000Z')).status, 'linked');
  assert.equal((await runtime.account.begin(sub)).status, 'marked');
  assert.equal((await runtime.account.finalize(sub, phone)).complete, true);
  assert.equal(world.json('phone:' + phone), null);
  assert.equal(world.json('userPhone:' + sub), null);
  assert.equal(world.json('user:' + sub), null);
}

// Deletion serializes first, then confirmation lands between secondary purge
// and finalization: the durable guard blocks both mapping writes.
{
  const world = redisWorld();
  const runtime = runtimes(world);
  const sub = 'google:delete-first';
  const phone = '972500000102';
  seed(world, sub, phone, '222222');
  assert.equal((await runtime.account.begin(sub)).status, 'marked');
  assert.equal((await runtime.link.confirm('222222', phone, sub, '2026-11-24T00:00:00.000Z')).status, 'account_deleting');
  assert.equal(world.json('phone:' + phone), null);
  assert.equal(world.json('userPhone:' + sub), null);
  assert.equal((await runtime.account.finalize(sub, phone)).complete, true);
}

// Finalization serializes before an old pending confirmation. During the
// cooldown the guard rejects it; after cooldown, the missing canonical user
// still prevents resurrection.
{
  const world = redisWorld();
  const runtime = runtimes(world);
  const sub = 'google:finalize-first';
  const phone = '972500000103';
  seed(world, sub, phone, '333333');
  assert.equal((await runtime.account.begin(sub)).status, 'marked');
  assert.equal((await runtime.account.finalize(sub, phone)).complete, true);
  assert.equal((await runtime.link.confirm('333333', phone, sub, '2026-11-24T00:00:00.000Z')).status, 'account_deleting');
  world.store.delete(runtime.account.guardKey(sub));
  world.store.set('linkCode:444444', JSON.stringify({ userSub: sub, phone }));
  assert.equal((await runtime.link.confirm('444444', phone, sub, '2026-11-24T00:01:00.000Z')).status, 'user_missing');
  assert.equal(world.json('phone:' + phone), null);
  assert.equal(world.json('userPhone:' + sub), null);
}

// The mapping commit is replay-safe when the first HTTP response disappears.
// A retry observes the confirmed tombstone and returns the committed record
// without rewriting either mapping or sending a second welcome message.
{
  const world = redisWorld();
  const runtime = runtimes(world);
  const sub = 'google:lost-confirm-response';
  const phone = '972500000104';
  seed(world, sub, phone, '555555');
  runtime.loseNextLinkResponse();
  assert.equal((await runtime.link.confirm('555555', phone, sub, '2026-11-24T00:00:00.000Z')).status, 'unavailable');
  assert.equal(world.json('phone:' + phone).userSub, sub, 'first atomic commit created the forward mapping');
  assert.equal(world.json('userPhone:' + sub).phone, phone, 'first atomic commit created the reverse mapping');
  const replay = await runtime.link.confirm('555555', phone, sub, '2026-11-24T00:00:01.000Z');
  assert.equal(replay.status, 'linked');
  assert.equal(replay.replayed, true, 'retry truthfully reconciles the lost response');
  assert.equal(world.json('linkCode:555555').linkedAt, '2026-11-24T00:00:00.000Z', 'retry does not replace the original commit');
}

// If deletion starts after the commit but before its response-lost retry, the
// guard takes precedence over the confirmed tombstone.
{
  const world = redisWorld();
  const runtime = runtimes(world);
  const sub = 'google:delete-before-confirm-retry';
  const phone = '972500000105';
  seed(world, sub, phone, '666666');
  runtime.loseNextLinkResponse();
  assert.equal((await runtime.link.confirm('666666', phone, sub, '2026-11-24T00:00:00.000Z')).status, 'unavailable');
  assert.equal((await runtime.account.begin(sub)).status, 'marked');
  assert.equal((await runtime.account.finalize(sub, phone)).complete, true);
  assert.equal((await runtime.link.confirm('666666', phone, sub, '2026-11-24T00:00:01.000Z')).status, 'account_deleting');
  assert.equal(world.json('phone:' + phone), null);
  assert.equal(world.json('userPhone:' + sub), null);
}

console.log('phone-link/account-deletion interleavings: all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
