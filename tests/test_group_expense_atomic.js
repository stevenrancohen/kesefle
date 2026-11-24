#!/usr/bin/env node
// Regression: group expense appends must be atomic and idempotent.
//
// The former GET -> push -> SET path let two successful concurrent requests
// overwrite each other. This drives the real /api/group handler against an
// in-memory Upstash REST double and verifies the endpoint now uses one EVAL,
// retains both concurrent writes, and safely replays a stable request token.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
function assert(condition, label) {
  if (condition) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

const BOT_SECRET = 'test-bot-secret-atomic-group';
const CODE = 'ABCD2345';
const CREATOR = '972500000001';
const MEMBER = '972500000002';
const THIRD_MEMBER = '972500000003';
const ATTACKER = '972599999999';
process.env.KV_REST_API_URL = 'http://kv.local';
process.env.KV_REST_API_TOKEN = 'kv-test-token';
process.env.KESEFLE_BOT_SECRET = BOT_SECRET;

function seedGroup() {
  return {
    code: CODE,
    name: 'Atomic household',
    createdBy: CREATOR,
    createdAt: '2026-01-01T00:00:00.000Z',
    members: [
      { phone: CREATOR, name: 'Creator' },
      { phone: MEMBER, name: 'Member' },
    ],
    expenses: [],
    sheetId: null,
    sheetUrl: null,
  };
}

function installKvMock() {
  const store = new Map([['group:' + CODE, JSON.stringify(seedGroup())]]);
  const stats = { evalCalls: 0, mutationCalls: 0, groupGets: 0, failAfterCommitOnce: false };

  global.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'pipeline') {
      return { ok: true, status: 200, json: async () => [{ result: 1 }, { result: 1 }] };
    }
    if (parts[0] === 'get') {
      const key = decodeURIComponent(parts.slice(1).join('/'));
      if (key === 'group:' + CODE) stats.groupGets += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: store.has(key) ? store.get(key) : null }),
      };
    }
    if (parts[0] === 'del') {
      const key = decodeURIComponent(parts.slice(1).join('/'));
      const existed = store.delete(key);
      return { ok: true, status: 200, json: async () => ({ result: existed ? 1 : 0 }) };
    }
    if (u.pathname === '/' || u.pathname === '') {
      const command = JSON.parse(String(opts.body || '[]'));
      assert(command[0] === 'EVAL', 'group mutation uses Redis EVAL');
      assert(command[2] === '1' && command[3] === 'group:' + CODE,
        'EVAL declares exactly the group key');
      assert(String(command[1]).startsWith('#!lua flags=allow-key-locking'),
        'Lua opts into per-key locking');
      stats.evalCalls += 1;

      const key = command[3];
      const raw = store.get(key);
      let result;
      if (!raw) {
        result = { status: 'group_missing' };
      } else if (['addmember', 'undo', 'addrecurring', 'resyncmeta', 'resynccomplete', 'resyncrelease'].includes(command[4])) {
        stats.mutationCalls += 1;
        const operation = command[4];
        const payload = JSON.parse(command[5]);
        const group = JSON.parse(raw);
        group.mutationReceipts = group.mutationReceipts || [];
        const receipt = payload.mutationId && group.mutationReceipts.find(item =>
          item.id === payload.mutationId && item.operation === operation);
        if (receipt && operation === 'undo') {
          result = receipt.outcome === 'noop'
            ? { status: 'noop', replayed: true }
            : { status: 'committed', removed: receipt.removed, replayed: true };
        } else if (receipt && operation === 'addrecurring') {
          result = { status: 'committed', recurring: group.recurring || [], replayed: true };
        } else if (operation === 'addmember') {
          const isMember = group.createdBy === payload.requesterPhone
            || group.members.some(member => member.phone === payload.requesterPhone);
          if (!isMember) {
            result = { status: 'not_member' };
          } else {
            const exists = group.members.some(member => member.phone === payload.member.phone);
            if (!exists) group.members.push(payload.member);
            store.set(key, JSON.stringify(group));
            result = { status: 'committed', members: group.members.length, added: !exists };
          }
        } else if (operation === 'undo') {
          const removed = group.expenses[group.expenses.length - 1];
          if (!removed) {
            if (payload.mutationId) {
              group.mutationReceipts.push({ id: payload.mutationId, operation, outcome: 'noop' });
            }
            store.set(key, JSON.stringify(group));
            result = { status: 'noop' };
          } else if (removed.payerPhone !== payload.requesterPhone && group.createdBy !== payload.requesterPhone) {
            result = { status: 'forbidden_undo' };
          } else {
            group.expenses.pop();
            if (payload.mutationId) {
              group.mutationReceipts.push({
                id: payload.mutationId, operation, removed,
              });
            }
            store.set(key, JSON.stringify(group));
            result = { status: 'committed', removed };
          }
        } else if (operation === 'addrecurring') {
          const isMember = group.createdBy === payload.requesterPhone
            || group.members.some(member => member.phone === payload.requesterPhone);
          if (!isMember) {
            result = { status: 'not_member' };
          } else {
            group.recurring = group.recurring || [];
            group.recurring.push(payload.recurring);
            if (payload.mutationId) {
              group.mutationReceipts.push({
                id: payload.mutationId, operation, recurringId: payload.recurring.id,
              });
            }
            store.set(key, JSON.stringify(group));
            result = { status: 'committed', recurring: group.recurring };
          }
        } else if (operation === 'resyncmeta') {
          if (group.sheetId && group.sheetBackfillPending) {
            const lease = group.sheetBackfillLease;
            if (lease && lease.owner !== payload.workerId && lease.expiresAt > payload.nowMs) {
              result = { status: 'busy', leaseExpiresAt: lease.expiresAt, sheetUrl: group.sheetUrl };
            } else {
              group.sheetBackfillLease = { owner: payload.workerId, expiresAt: payload.leaseUntil };
              const wanted = new Set(group.sheetBackfillPending);
              store.set(key, JSON.stringify(group));
              result = {
                status: 'resume', sheetUrl: group.sheetUrl, sheetId: group.sheetId,
                code: group.code, createdBy: group.createdBy,
                expenses: group.expenses.filter(expense => wanted.has(expense.id)),
              };
            }
          } else if (group.sheetId) {
            result = { status: 'already', sheetUrl: group.sheetUrl };
          } else {
            group.sheetId = payload.sheetId;
            group.sheetUrl = payload.sheetUrl;
            group.sheetBackfillPending = group.expenses.map(expense => expense.id);
            group.sheetBackfillLease = { owner: payload.workerId, expiresAt: payload.leaseUntil };
            store.set(key, JSON.stringify(group));
            result = {
              status: 'committed', sheetUrl: group.sheetUrl, sheetId: group.sheetId,
              code: group.code, createdBy: group.createdBy, expenses: group.expenses,
            };
          }
        } else if (operation === 'resynccomplete') {
          if (group.sheetId !== payload.sheetId) {
            result = { status: 'sheet_changed' };
          } else if (group.sheetBackfillLease?.owner !== payload.workerId) {
            result = { status: 'lease_mismatch' };
          } else {
            delete group.sheetBackfillPending;
            delete group.sheetBackfillLease;
            store.set(key, JSON.stringify(group));
            result = { status: 'committed' };
          }
        } else if (operation === 'resyncrelease') {
          if (!group.sheetBackfillPending) {
            result = { status: 'no_pending' };
          } else if (group.sheetBackfillLease?.owner !== payload.workerId) {
            result = { status: 'lease_mismatch' };
          } else {
            delete group.sheetBackfillLease;
            store.set(key, JSON.stringify(group));
            result = { status: 'committed' };
          }
        }
      } else {
        const requester = command[4];
        const incoming = JSON.parse(command[5]);
        const group = JSON.parse(raw);
        const isMember = group.createdBy === requester || group.members.some(m => m.phone === requester);
        if (!isMember) {
          result = { status: 'not_member' };
        } else {
          const existing = group.expenses.find(expense => expense.id === incoming.id);
          if (existing) {
            result = {
              status: 'replayed', expense: existing, memberCount: group.members.length,
              mirror: { code: CODE, createdBy: group.createdBy },
            };
          } else {
            if (!incoming._customSplit) {
              const each = Math.round((incoming.amount / group.members.length) * 100) / 100;
              let assigned = 0;
              incoming.shares = {};
              group.members.forEach((member, index) => {
                if (index === group.members.length - 1) {
                  incoming.shares[member.phone] = Math.round((incoming.amount - assigned) * 100) / 100;
                } else {
                  incoming.shares[member.phone] = each;
                  assigned += each;
                }
              });
            }
            delete incoming._customSplit;
            group.expenses.push(incoming);
            group.expenses = group.expenses.slice(-1000);
            store.set(key, JSON.stringify(group));
            result = {
              status: 'committed', expense: incoming, memberCount: group.members.length,
              mirror: { code: CODE, createdBy: group.createdBy },
            };
          }
        }
      }

      // Model a network response disappearing after Redis already committed.
      if (stats.failAfterCommitOnce && (result.status === 'committed' || result.status === 'noop')) {
        stats.failAfterCommitOnce = false;
        throw new Error('simulated response loss after commit');
      }
      return { ok: true, status: 200, json: async () => ({ result: JSON.stringify(result) }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'unexpected_fetch' }) };
  };
  return { store, stats };
}

function makeReq(body) {
  return {
    method: 'POST',
    url: '/api/group',
    headers: {
      'x-kesefle-bot-secret': BOT_SECRET,
      'x-forwarded-for': '203.0.113.11',
    },
    query: {},
    body,
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function call(handler, body) {
  const res = makeRes();
  await handler(makeReq(body), res);
  return res;
}

function expenseBody(expenseId, description, requesterPhone = CREATOR) {
  return {
    action: 'addexpense', code: CODE, payerPhone: requesterPhone,
    requesterPhone, amount: 100, description, splitMode: 'equal', expenseId,
  };
}

async function main() {
  console.log('\ntests/test_group_expense_atomic.js\n');
  const { store, stats } = installKvMock();
  const groupModule = await import('../api/group.js');
  const handler = groupModule.default;
  const mutateGroup = groupModule.__testMutateGroupAtomic;

  console.log('Concurrent writers');
  const [first, second] = await Promise.all([
    call(handler, expenseBody('wa:message-a', 'first concurrent expense')),
    call(handler, expenseBody('wa:message-b', 'second concurrent expense', MEMBER)),
  ]);
  assert(first.statusCode === 200 && second.statusCode === 200,
    'both concurrent requests return 200');
  const afterConcurrent = JSON.parse(store.get('group:' + CODE));
  assert(afterConcurrent.expenses.length === 2,
    'both concurrent expenses survive in the authoritative ledger');
  assert(new Set(afterConcurrent.expenses.map(expense => expense.id)).size === 2,
    'concurrent requests persist two distinct expense ids');
  assert(stats.groupGets === 0,
    'addexpense performs no stale group GET before its atomic append');
  assert(afterConcurrent.expenses.every(expense =>
    expense.shares[CREATOR] === 50 && expense.shares[MEMBER] === 50),
  'equal shares are calculated from the current member list');

  console.log('\nIdempotent replay');
  const replay = await call(handler, expenseBody('wa:message-a', 'ignored retry payload'));
  assert(replay.statusCode === 200 && replay.body?.replayed === true,
    'same stable token is returned as a successful replay');
  assert(JSON.parse(store.get('group:' + CODE)).expenses.length === 2,
    'replay does not append a duplicate expense');
  assert(replay.body?.sheetWriteOk === null,
    'replay does not duplicate the Google Sheet mirror row');
  assert(!store.get('group:' + CODE).includes('wa:message-a'),
    'raw external message id is not persisted');

  console.log('\nLost response after commit');
  stats.failAfterCommitOnce = true;
  const lost = await call(handler, expenseBody('wa:message-lost-response', 'network ambiguity'));
  assert(lost.statusCode === 503 && lost.body?.error === 'group_persist_unavailable',
    'ambiguous transport failure fails closed with 503');
  const recovered = await call(handler, expenseBody('wa:message-lost-response', 'network ambiguity'));
  assert(recovered.statusCode === 200 && recovered.body?.replayed === true,
    'retry after lost response resolves as replay');
  const afterRecovery = JSON.parse(store.get('group:' + CODE));
  assert(afterRecovery.expenses.filter(e => e.description === 'network ambiguity').length === 1,
    'lost-response retry leaves exactly one committed expense');

  console.log('\nCross-action concurrency');
  const [memberWrite, expenseWrite] = await Promise.all([
    call(handler, {
      action: 'addmember', code: CODE, requesterPhone: CREATOR,
      phone: THIRD_MEMBER, name: 'Third member',
    }),
    call(handler, expenseBody('wa:cross-action', 'concurrent with member update', MEMBER)),
  ]);
  assert(memberWrite.statusCode === 200 && expenseWrite.statusCode === 200,
    'addmember and addexpense both succeed concurrently');
  const afterCrossAction = JSON.parse(store.get('group:' + CODE));
  assert(afterCrossAction.members.some(member => member.phone === THIRD_MEMBER),
    'concurrent member update survives');
  assert(afterCrossAction.expenses.some(expense => expense.description === 'concurrent with member update'),
    'concurrent expense survives the member update');
  assert(stats.groupGets === 0,
    'cross-action mutations do not use a stale group GET');

  console.log('\nReplay-safe destructive mutations');
  const beforeUndo = afterCrossAction.expenses.length;
  stats.failAfterCommitOnce = true;
  const lostUndo = await call(handler, {
    action: 'undo', code: CODE, requesterPhone: CREATOR, mutationId: 'wa:undo-lost-response',
  });
  assert(lostUndo.statusCode === 503,
    'undo reports an ambiguous post-commit response as unavailable');
  const replayedUndo = await call(handler, {
    action: 'undo', code: CODE, requesterPhone: CREATOR, mutationId: 'wa:undo-lost-response',
  });
  assert(replayedUndo.statusCode === 200 && replayedUndo.body?.replayed === true,
    'same undo token replays the original removal');
  assert(JSON.parse(store.get('group:' + CODE)).expenses.length === beforeUndo - 1,
    'lost-response retry removes exactly one expense, not two');

  stats.failAfterCommitOnce = true;
  const recurringBody = {
    action: 'addrecurring', code: CODE, payerPhone: CREATOR, requesterPhone: CREATOR,
    amount: 3000, description: 'rent', interval: 'monthly', mutationId: 'wa:recurring-lost-response',
  };
  const lostRecurring = await call(handler, recurringBody);
  assert(lostRecurring.statusCode === 503,
    'recurring template reports an ambiguous post-commit response as unavailable');
  const replayedRecurring = await call(handler, recurringBody);
  assert(replayedRecurring.statusCode === 200 && replayedRecurring.body?.replayed === true,
    'same recurring token replays the original template');
  assert(JSON.parse(store.get('group:' + CODE)).recurring.length === 1,
    'lost-response retry creates exactly one recurring template');
  assert(!store.get('group:' + CODE).includes('wa:undo-lost-response')
    && !store.get('group:' + CODE).includes('wa:recurring-lost-response'),
  'raw destructive-mutation tokens are not persisted');

  console.log('\nReplay-safe empty undo');
  const emptied = JSON.parse(store.get('group:' + CODE));
  emptied.expenses = [];
  store.set('group:' + CODE, JSON.stringify(emptied));
  stats.failAfterCommitOnce = true;
  const lostNoop = await call(handler, {
    action: 'undo', code: CODE, requesterPhone: CREATOR, mutationId: 'wa:empty-undo-lost',
  });
  assert(lostNoop.statusCode === 503,
    'empty undo can lose its response after persisting the no-op receipt');
  const expenseAfterNoop = await call(handler,
    expenseBody('wa:after-empty-undo', 'must survive noop retry'));
  assert(expenseAfterNoop.statusCode === 200, 'a later expense is committed after the empty undo');
  const replayedNoop = await call(handler, {
    action: 'undo', code: CODE, requesterPhone: CREATOR, mutationId: 'wa:empty-undo-lost',
  });
  assert(replayedNoop.statusCode === 200 && replayedNoop.body?.replayed === true
    && replayedNoop.body?.removed === null,
  'retry replays the original empty outcome');
  assert(JSON.parse(store.get('group:' + CODE)).expenses.some(expense => expense.description === 'must survive noop retry'),
    'empty-undo retry cannot remove a newly added expense');

  console.log('\nMembership gate inside atomic transition');
  const beforeAttack = JSON.parse(store.get('group:' + CODE)).expenses.length;
  const attack = await call(handler, expenseBody('wa:attacker', 'injected', ATTACKER));
  assert(attack.statusCode === 403 && attack.body?.error === 'not_a_member',
    'non-member is rejected by the atomic append');
  assert(JSON.parse(store.get('group:' + CODE)).expenses.length === beforeAttack,
    'non-member rejection cannot mutate the ledger');

  console.log('\nConcurrent resync lease');
  const leaseGroup = JSON.parse(store.get('group:' + CODE));
  const pendingExpense = leaseGroup.expenses[0];
  leaseGroup.sheetId = 'sheet-test-1';
  leaseGroup.sheetUrl = 'https://docs.google.com/spreadsheets/d/sheet-test-1';
  leaseGroup.sheetBackfillPending = [pendingExpense.id];
  delete leaseGroup.sheetBackfillLease;
  store.set('group:' + CODE, JSON.stringify(leaseGroup));
  const leaseNow = Date.now();
  const workers = ['worker-a', 'worker-b'];
  const leaseResults = await Promise.all(workers.map(workerId =>
    mutateGroup(CODE, 'resyncmeta', {
      sheetId: leaseGroup.sheetId,
      sheetUrl: leaseGroup.sheetUrl,
      workerId,
      nowMs: leaseNow,
      leaseUntil: leaseNow + 300000,
    })));
  assert(leaseResults.filter(result => result.status === 'resume').length === 1
    && leaseResults.filter(result => result.status === 'busy').length === 1,
  'two concurrent resync workers yield exactly one lease holder');
  const sheetRows = new Set();
  leaseResults.filter(result => result.status === 'resume').forEach(result => {
    result.expenses.forEach(expense => sheetRows.add(expense.id));
  });
  assert(sheetRows.size === 1 && sheetRows.has(pendingExpense.id),
    'only the lease holder can append the pending expense once');
  const winnerIndex = leaseResults.findIndex(result => result.status === 'resume');
  const completedLease = await mutateGroup(CODE, 'resynccomplete', {
    sheetId: leaseGroup.sheetId,
    workerId: workers[winnerIndex],
  });
  assert(completedLease.status === 'committed',
    'lease holder can finalize the backfill');
  const afterLease = JSON.parse(store.get('group:' + CODE));
  assert(!afterLease.sheetBackfillPending && !afterLease.sheetBackfillLease,
    'finalization clears both pending snapshot and lease');

  console.log('\nStale active pointer fails closed');
  const withoutMember = JSON.parse(store.get('group:' + CODE));
  withoutMember.members = withoutMember.members.filter(member => member.phone !== MEMBER);
  store.set('group:' + CODE, JSON.stringify(withoutMember));
  store.set('memberGroup:' + MEMBER, JSON.stringify({ code: CODE }));
  const staleActive = await call(handler, { action: 'getactive', phone: MEMBER });
  assert(staleActive.statusCode === 200 && staleActive.body?.active === null,
    'getactive does not disclose a group after membership was removed');
  assert(!store.has('memberGroup:' + MEMBER),
    'getactive clears the stale membership pointer');

  console.log('\nStatic wiring');
  const groupSource = fs.readFileSync(path.join(ROOT, 'api/group.js'), 'utf8');
  const botSource = fs.readFileSync(path.join(ROOT, 'bot/ExpenseBot_DEPLOY.gs'), 'utf8');
  assert(/APPEND_GROUP_EXPENSE_LUA/.test(groupSource) && /redis\.call\('GET', KEYS\[1\]\)/.test(groupSource)
    && /redis\.call\('SET', KEYS\[1\]/.test(groupSource),
  'one declared Redis key contains the read and write');
  assert(/MUTATE_GROUP_LUA/.test(groupSource) && /operation == 'addmember'/.test(groupSource)
    && /operation == 'markrecurringfired'/.test(groupSource),
  'all group-record mutation types share the key-locked dispatcher');
  assert((groupSource.match(/kvSet\('group:' \+ code/g) || []).length === 1,
    'only new-group creation retains a whole-record group SET');
  assert(/processExpense\(text, from, message\.id \|\| ''\)/.test(botSource)
    && /expenseId: messageId \? 'wa:'/.test(botSource),
  'WhatsApp message id reaches the addexpense idempotency token');
  assert(/expenseId: 'recurring:' \+ g\.code \+ ':' \+ rec\.id/.test(botSource),
    'recurring expenses use a deterministic retry token');
  assert(/_groupMutationTicket_/.test(botSource)
    && /_groupMutationDone_\(ticket\)/.test(botSource),
  'bot retains an undo/recurring token across ambiguous failures and clears it on success');
  const resyncBlock = groupSource.slice(groupSource.indexOf("case 'resync'"), groupSource.indexOf("case 'mygroups'"));
  assert(resyncBlock.indexOf("mutateGroupAtomic(code, 'resyncmeta'") < resyncBlock.indexOf('for (const exp of'),
    'resync atomically attaches the sheet and snapshots expenses before backfill');
  assert(/operation == 'resyncmeta'[\s\S]*?expenses = group\.expenses or \{\}/.test(groupSource),
    'resync snapshot comes from inside the same group-key lock');
  assert(/sheetBackfillPending/.test(groupSource)
    && /readGroupExpenseIds/.test(groupSource)
    && /mutateGroupAtomic\(code, 'resynccomplete'/.test(resyncBlock),
  'resync persists resumable backfill state, dedupes by sheet expense id, then finalizes');
  assert(/sheetBackfillLease/.test(groupSource)
    && /operation == 'resyncrelease'/.test(groupSource)
    && /lease_mismatch/.test(groupSource),
  'resync lease serializes workers, expires for crash recovery, and guards finalization');

  console.log('\nEVAL calls observed: ' + stats.evalCalls + ' (cross-action mutations: ' + stats.mutationCalls + ')');
  if (failures.length) {
    console.error('\nFAILURES: ' + failures.length);
    process.exit(1);
  }
  console.log('\nAll group atomic-append tests passed.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
