#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async function main() {
  const migration = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'backfill-phone-reverse-index.mjs')).href);
  const account = (hasUser = true, hasSheet = true) => ({ hasUser, hasSheet });

  const markerless = migration.buildBackfillPlan({
    forwards: [{ key: 'phone:972501111111', record: { userSub: 'google:markerless' } }],
    reverseByUser: new Map(),
    accountStateByUser: new Map([['google:markerless', account()]]),
  });
  assert.strictEqual(markerless.writes.length, 1, 'markerless historical forward route is scheduled for reverse backfill');
  assert.strictEqual(markerless.writes[0].phone, '972501111111');
  assert.strictEqual(markerless.writes[0].userSub, 'google:markerless');
  assert.strictEqual(markerless.writes[0].forwardKey, 'phone:972501111111');

  const multiple = migration.buildBackfillPlan({
    forwards: [
      { key: 'phone:972502222221', record: { userSub: 'google:conflict' } },
      { key: 'phone:972502222222', record: { userSub: 'google:conflict' } },
    ],
    reverseByUser: new Map(),
    accountStateByUser: new Map([['google:conflict', account()]]),
  });
  assert.strictEqual(multiple.writes.length, 0, 'multiple forward routes are never auto-repaired');
  assert.strictEqual(multiple.conflicts[0].reason, 'multiple_forward_routes');

  const ambiguousOwner = migration.buildBackfillPlan({
    forwards: [
      { key: 'phone:+972501234567', record: { userSub: 'google:owner-a' } },
      { key: 'phone:972501234567', record: { userSub: 'google:owner-b' } },
      { key: 'phone:972509999999', record: { userSub: 'google:owner-a' } },
    ],
    reverseByUser: new Map(),
    accountStateByUser: new Map([
      ['google:owner-a', account()],
      ['google:owner-b', account()],
    ]),
  });
  assert.strictEqual(ambiguousOwner.writes.length, 0, 'one normalized phone can never be backfilled to two users');
  assert.strictEqual(ambiguousOwner.conflicts[0].reason, 'normalized_phone_multiple_users');

  const poisonedUser = migration.buildBackfillPlan({
    forwards: [{ key: 'phone:972507777777', record: { userSub: 'google:poisoned' } }],
    reverseByUser: new Map(),
    accountStateByUser: new Map([['google:poisoned', {
      ...account(),
      userRecord: { phoneE164: '972507777778' },
    }]]),
  });
  assert.strictEqual(poisonedUser.writes.length, 0, 'a differing canonical user phone marker blocks backfill');
  assert.strictEqual(poisonedUser.conflicts[0].reason, 'legacy_user_phone_mismatch');

  const mismatch = migration.buildBackfillPlan({
    forwards: [{ key: 'phone:972503333333', record: { userSub: 'google:mismatch' } }],
    reverseByUser: new Map([['google:mismatch', { phone: '972503333334' }]]),
    accountStateByUser: new Map([['google:mismatch', account()]]),
  });
  assert.strictEqual(mismatch.writes.length, 0, 'reverse mismatch is never overwritten');
  assert.strictEqual(mismatch.conflicts[0].reason, 'reverse_mismatch');

  const consistent = migration.buildBackfillPlan({
    forwards: [{ key: 'phone:+972 50-444-4444', record: { userSub: 'google:consistent' } }],
    reverseByUser: new Map([['google:consistent', { phone: '0504444444' }]]),
    accountStateByUser: new Map([['google:consistent', account()]]),
  });
  assert.strictEqual(consistent.consistent.length, 1, 'equivalent E.164 formats are recognized as already consistent');
  assert.strictEqual(consistent.writes.length, 0);

  const missing = migration.buildBackfillPlan({
    forwards: [{ key: 'phone:972505555555', record: { userSub: 'google:deleted' } }],
    reverseByUser: new Map(),
    accountStateByUser: new Map([['google:deleted', account(false, false)]]),
  });
  assert.strictEqual(missing.writes.length, 0, 'deleted/incomplete accounts are never resurrected');
  assert.strictEqual(missing.skipped[0].reason, 'canonical_account_missing');

  assert.deepStrictEqual(migration.parseStored(JSON.stringify(JSON.stringify({ userSub: 'google:double' }))), { userSub: 'google:double' });
  assert.strictEqual(migration.normalizePhone('+972 054-123-4567'), '972541234567');

  const records = new Map([
    ['phone:972506666666', JSON.stringify({ userSub: 'google:run' })],
    ['user:google:run', JSON.stringify({ userSub: 'google:run' })],
    ['sheet:google:run', JSON.stringify({ spreadsheetId: 'SHEET_RUN' })],
  ]);
  const evals = [];
  const command = async (parts) => {
    if (parts[0] === 'SCAN') return ['0', ['phone:972506666666', 'phone:of:metadata']];
    if (parts[0] === 'MGET') return parts.slice(1).map((key) => records.get(key) || null);
    if (parts[0] === 'EVAL') {
      evals.push(parts);
      records.set(parts[3], parts[8]);
      return 'written';
    }
    throw new Error('unexpected command ' + parts[0]);
  };
  const dryRun = await migration.runBackfill({ apply: false, command });
  assert.strictEqual(dryRun.mode, 'dry-run');
  assert.strictEqual(dryRun.plannedWrites, 1, 'dry-run discovers the exact markerless partial write');
  assert.strictEqual(dryRun.readyForRollout, false, 'dry-run with pending writes is a failing rollout gate');
  assert.strictEqual(dryRun.ignoredNamespaceCount, 1, 'non-routing phone namespaces are ignored separately');
  assert.strictEqual(evals.length, 0, 'dry-run never evaluates a write script');
  const applied = await migration.runBackfill({ apply: true, command });
  assert.strictEqual(applied.results[0].result, 'written');
  assert.strictEqual(applied.remainingWrites, 0);
  assert.strictEqual(applied.readyForRollout, true, 'only the clean post-apply scan opens the rollout gate');
  assert.strictEqual(evals.length, 1, 'apply performs one guarded atomic backfill');
  assert.ok(String(evals[0][1]).includes('KESEFLE_BACKFILL_PHONE_REVERSE_V1'));
  assert.strictEqual(evals[0][2], '4');

  for (const typedResult of ['forward_changed', 'reverse_exists']) {
    const staleRecords = new Map(records);
    staleRecords.delete('userPhone:google:run');
    const staleCommand = async (parts) => {
      if (parts[0] === 'SCAN') return ['0', ['phone:972506666666']];
      if (parts[0] === 'MGET') return parts.slice(1).map((key) => staleRecords.get(key) || null);
      if (parts[0] === 'EVAL') return typedResult;
      throw new Error('unexpected command ' + parts[0]);
    };
    const stale = await migration.runBackfill({ apply: true, command: staleCommand });
    assert.strictEqual(stale.results[0].result, typedResult);
    assert.strictEqual(stale.readyForRollout, false, typedResult + ' cannot bypass the post-apply rollout gate');
    assert.strictEqual(stale.remainingWrites, 1);
  }

  let ambiguousEvals = 0;
  const ambiguousRecords = new Map([
    ['phone:+972508888888', JSON.stringify({ userSub: 'google:ambiguous-a' })],
    ['phone:972508888888', JSON.stringify({ userSub: 'google:ambiguous-b' })],
    ['phone:972509999998', JSON.stringify({ userSub: 'google:ambiguous-a' })],
    ['user:google:ambiguous-a', JSON.stringify({ userSub: 'google:ambiguous-a' })],
    ['sheet:google:ambiguous-a', JSON.stringify({ spreadsheetId: 'A' })],
    ['user:google:ambiguous-b', JSON.stringify({ userSub: 'google:ambiguous-b' })],
    ['sheet:google:ambiguous-b', JSON.stringify({ spreadsheetId: 'B' })],
  ]);
  const ambiguousCommand = async (parts) => {
    if (parts[0] === 'SCAN') return ['0', ['phone:+972508888888', 'phone:972508888888', 'phone:972509999998']];
    if (parts[0] === 'MGET') return parts.slice(1).map((key) => ambiguousRecords.get(key) || null);
    if (parts[0] === 'EVAL') { ambiguousEvals += 1; return 'written'; }
    throw new Error('unexpected command ' + parts[0]);
  };
  const ambiguousApply = await migration.runBackfill({ apply: true, command: ambiguousCommand });
  assert.strictEqual(ambiguousApply.readyForRollout, false);
  assert.strictEqual(ambiguousApply.conflicts[0].reason, 'normalized_phone_multiple_users');
  assert.strictEqual(ambiguousEvals, 0, 'ambiguous normalized ownership never reaches Lua');

  console.log('Phone reverse-index backfill planner: PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
