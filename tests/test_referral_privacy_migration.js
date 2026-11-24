#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, '..', 'lib', 'referral-privacy.js');
const moduleSource = fs.readFileSync(modulePath, 'utf8');
const cronSource = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron', 'kv-monitor.js'), 'utf8');
const ISO = '2026-11-24T00:00:00.000Z';

function httpResult(result) {
  return { ok: true, async json() { return { result }; } };
}

function isStrictIso(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(value).toISOString() === value;
}

class FakeUpstash {
  constructor(entries = {}) {
    this.store = new Map(Object.entries(entries));
    this.types = new Map();
    this.commands = [];
    this.scanCalls = 0;
    this.loseSetResponseOnce = false;
    this.loseScrubResponseOnce = false;
    this.loseFenceWhen = null;
    this.beforeFence = null;
    this.beforeScrub = null;
    this.scanPages = null;
  }

  state(key) {
    const raw = this.store.get(key);
    return raw == null ? null : JSON.parse(raw);
  }

  async fetch(_url, options = {}) {
    const command = JSON.parse(options.body);
    this.commands.push(command);
    const op = command[0];
    if (op === 'GET') return httpResult(this.store.has(command[1]) ? this.store.get(command[1]) : null);
    if (op === 'SET') {
      const [, key, value] = command;
      if (command.includes('NX') && this.store.has(key)) return httpResult(null);
      this.store.set(key, value);
      if (this.loseSetResponseOnce) {
        this.loseSetResponseOnce = false;
        throw new Error('lost SET response');
      }
      return httpResult('OK');
    }
    if (op === 'SCAN') return this.scan(command);
    if (op === 'EVAL') return this.eval(command);
    throw new Error('unsupported fake command: ' + op);
  }

  scan(command) {
    this.scanCalls += 1;
    const cursor = String(command[1]);
    if (this.scanPages && this.scanPages.has(cursor)) return httpResult(this.scanPages.get(cursor));
    const countIndex = command.indexOf('COUNT');
    const count = Number(command[countIndex + 1]);
    const keys = [...this.store.keys()].filter((key) => key.startsWith('referral:redeemers:')).sort();
    const start = Number(cursor);
    const batch = keys.slice(start, start + count);
    const next = start + count >= keys.length ? '0' : String(start + count);
    return httpResult([next, batch]);
  }

  eval(command) {
    const script = command[1];
    if (script.includes('KESEFLE_REFERRAL_PRIVACY_RELEASE_V2')) {
      const key = command[3], token = command[4];
      if (this.store.get(key) !== token) return httpResult(0);
      this.store.delete(key);
      return httpResult(1);
    }
    if (script.includes('KESEFLE_REFERRAL_PRIVACY_FENCE_V2')) return this.fence(command);
    if (script.includes('KESEFLE_REFERRAL_PRIVACY_SCRUB_V2')) return this.scrub(command);
    throw new Error('unknown fake EVAL');
  }

  fence(command) {
    const stateKey = command[3], leaseKey = command[4], token = command[5];
    const expectsMissing = command[6] === '1', oldRaw = command[7], nextRaw = command[8];
    const next = JSON.parse(nextRaw);
    if (this.beforeFence) {
      const hook = this.beforeFence;
      this.beforeFence = null;
      hook(this, next, leaseKey);
    }
    if (this.store.get(leaseKey) !== token) {
      return httpResult(JSON.stringify({ status: 'lease_lost' }));
    }
    const current = this.store.has(stateKey) ? this.store.get(stateKey) : null;
    if ((expectsMissing && current !== null) || (!expectsMissing && current !== oldRaw)) {
      return httpResult(JSON.stringify({ status: 'conflict' }));
    }
    this.store.set(stateKey, nextRaw);
    if (this.loseFenceWhen && this.loseFenceWhen(next)) {
      this.loseFenceWhen = null;
      throw new Error('lost checkpoint response');
    }
    return httpResult(JSON.stringify({ status: 'ok' }));
  }

  scrub(command) {
    const key = command[3], targetEmail = command[4];
    const maxBytes = Number(command[5]), maxEntries = Number(command[6]);
    if (this.beforeScrub) {
      const hook = this.beforeScrub;
      this.beforeScrub = null;
      hook(this, key);
    }
    let result;
    if (!this.store.has(key)) {
      result = { status: 'missing', changed: false };
    } else if ((this.types.get(key) || 'string') !== 'string') {
      this.store.delete(key);
      this.types.delete(key);
      result = { status: 'quarantined', changed: true };
    } else if (Buffer.byteLength(this.store.get(key)) > maxBytes) {
      this.store.delete(key);
      result = { status: 'quarantined', changed: true };
    } else {
      let decoded;
      try { decoded = JSON.parse(this.store.get(key)); } catch { decoded = null; }
      if (!Array.isArray(decoded) || decoded.length === 0) {
        this.store.delete(key);
        result = { status: Array.isArray(decoded) ? 'redacted' : 'quarantined', changed: true };
      } else if (decoded.length > maxEntries) {
        this.store.delete(key);
        result = { status: 'quarantined', changed: true };
      } else if (decoded.some((value) => !value || typeof value !== 'object' ||
          Array.isArray(value) || !isStrictIso(value.at))) {
        this.store.delete(key);
        result = { status: 'quarantined', changed: true };
      } else {
        let changed = false;
        const output = [];
        for (const value of decoded) {
          const fields = Object.keys(value).sort().join(',');
          if (typeof value.email === 'string') {
            changed = true;
            if (value.email.trim().toLowerCase() !== targetEmail) {
              output.push({ emailInitial: '?', at: value.at });
            }
          } else {
            const initial = typeof value.emailInitial === 'string' && /^[A-Za-z0-9?]$/.test(value.emailInitial)
              ? value.emailInitial : '?';
            if (initial !== value.emailInitial || fields !== 'at,emailInitial') changed = true;
            output.push({ emailInitial: initial, at: value.at });
          }
        }
        if (output.length === 0) {
          this.store.delete(key);
          result = { status: 'redacted', changed: true };
        } else {
          if (changed || output.length !== decoded.length) this.store.set(key, JSON.stringify(output));
          result = { status: 'ok', changed: changed || output.length !== decoded.length };
        }
      }
    }
    if (this.loseScrubResponseOnce) {
      this.loseScrubResponseOnce = false;
      throw new Error('lost transform response');
    }
    return httpResult(JSON.stringify(result));
  }
}

(async function main() {
  console.log('\n=== resumable referral privacy migration ===\n');

  process.env.KV_REST_API_URL = 'https://kv.test';
  process.env.KV_REST_API_TOKEN = 'token';
  process.env.VERCEL_ENV = 'production';
  const migration = await import(pathToFileURL(modulePath).href + '?test=' + Date.now());
  const {
    migrateLegacyReferralPii,
    REFERRAL_PRIVACY_STATE_KEY: STATE,
    REFERRAL_PRIVACY_LEASE_KEY: LEASE,
    REFERRAL_PRIVACY_DRAIN_MS: DRAIN,
    REFERRAL_WRITER_EPOCH: WRITER_EPOCH,
  } = migration;

  assert.match(moduleSource, /#!lua flags=allow-key-locking/);
  assert.match(moduleSource, /KESEFLE_REFERRAL_PRIVACY_FENCE_V2/);
  assert.match(moduleSource, /redis\.call\('GET', KEYS\[2\]\) ~= ARGV\[1\]/);
  assert.match(moduleSource, /KESEFLE_REFERRAL_PRIVACY_SCRUB_V2/);
  assert.match(moduleSource, /string\.len\(raw\) > tonumber\(ARGV\[2\]\)/);
  assert.match(moduleSource, /entries > tonumber\(ARGV\[3\]\)/);
  assert.match(moduleSource, /'EVAL', script, '1', key, targetEmail, String\(MAX_LIST_BYTES\)/);
  assert.match(cronSource, /import \{ migrateLegacyReferralPii \}/);
  assert.match(cronSource, /usage\.pct != null && usage\.pct >= 80[\s\S]*?migrateLegacyReferralPii/);
  assert.match(cronSource, /migrateLegacyReferralPii\(\{[\s\S]*?worker: true,[\s\S]*?maxPages: 1,[\s\S]*?pageSize: 25/);

  async function run(fake, options) {
    global.fetch = fake.fetch.bind(fake);
    return migrateLegacyReferralPii({ worker: true, ...options });
  }

  // Preview/local requests sharing production KV cannot initialize or advance
  // the migration, even if they explicitly ask to act as a worker.
  const preview = new FakeUpstash();
  process.env.VERCEL_ENV = 'preview';
  let result = await run(preview, { nowMs: 500, cutoverSha: 'sha-preview' });
  assert.strictEqual(result.status, 'awaiting_worker');
  assert.strictEqual(result.complete, false);
  assert.ok(!preview.store.has(STATE));
  assert.strictEqual(preview.scanCalls, 0);
  process.env.VERCEL_ENV = 'production';

  const drain = new FakeUpstash();
  drain.loseSetResponseOnce = true;
  const draining = await run(drain, { nowMs: 1_000, cutoverSha: 'sha-drain' });
  assert.strictEqual(draining.status, 'draining');
  assert.strictEqual(drain.scanCalls, 0);
  assert.strictEqual(drain.state(STATE).drainUntil, 1_000 + DRAIN);
  assert.ok(!drain.store.has(LEASE));

  const largeEntries = {};
  for (let index = 0; index < 5_001; index += 1) {
    largeEntries[`referral:redeemers:owner-${String(index).padStart(4, '0')}`] = JSON.stringify([
      index === 0 || index === 5_000
        ? { email: `legacy-${index}@example.com`, at: ISO }
        : { emailInitial: 'a', at: ISO },
    ]);
  }
  const large = new FakeUpstash(largeEntries);
  await run(large, { nowMs: 2_000, cutoverSha: 'sha-large' });
  let largeResult;
  for (let invocation = 0; invocation < 20; invocation += 1) {
    largeResult = await run(large, {
      nowMs: 2_000 + DRAIN + 1,
      cutoverSha: 'sha-large',
      maxPages: 20,
      pageSize: 50,
      concurrency: 50,
    });
    if (largeResult.complete) break;
  }
  assert.strictEqual(largeResult.complete, true);
  assert.ok(large.scanCalls > 120, 'migration must resume beyond 60 pages');
  assert.deepStrictEqual(JSON.parse(large.store.get('referral:redeemers:owner-0000')),
    [{ emailInitial: '?', at: ISO }]);
  assert.deepStrictEqual(JSON.parse(large.store.get('referral:redeemers:owner-5000')),
    [{ emailInitial: '?', at: ISO }]);

  const late = new FakeUpstash({
    'referral:redeemers:late': JSON.stringify([{ emailInitial: 'l', at: ISO }]),
  });
  await run(late, { nowMs: 3_000, cutoverSha: 'sha-late' });
  result = await run(late, { nowMs: 3_000 + DRAIN + 1, cutoverSha: 'sha-late' });
  assert.strictEqual(result.phase, 'verify');
  late.store.set('referral:redeemers:late', JSON.stringify([{ email: 'late@example.com', at: ISO }]));
  result = await run(late, { nowMs: 3_000 + DRAIN + 2, cutoverSha: 'sha-late' });
  assert.strictEqual(result.complete, false);
  assert.strictEqual(result.phase, 'verify');
  assert.strictEqual(result.changed, 1);
  result = await run(late, { nowMs: 3_000 + DRAIN + 3, cutoverSha: 'sha-late' });
  assert.strictEqual(result.complete, true);

  // Ordinary deploy SHAs do not invalidate a completed stable writer epoch.
  // Preview callers still cannot trust or mutate production state, while an
  // explicit writer-epoch bump starts a fresh drain.
  const cutover = new FakeUpstash();
  await run(cutover, { nowMs: 3_250, cutoverSha: 'sha-old' });
  await run(cutover, {
    nowMs: 3_250 + DRAIN + 1,
    cutoverSha: 'sha-old',
    maxPages: 2,
  });
  assert.strictEqual(cutover.state(STATE).phase, 'ready');
  const scansBeforeReadOnly = cutover.scanCalls;
  process.env.VERCEL_ENV = 'preview';
  result = await run(cutover, {
    worker: false,
    nowMs: 3_250 + DRAIN + 2,
    cutoverSha: 'sha-old',
  });
  assert.strictEqual(result.status, 'awaiting_worker');
  assert.strictEqual(result.complete, false);
  process.env.VERCEL_ENV = 'production';
  result = await run(cutover, {
    worker: false,
    nowMs: 3_250 + DRAIN + 2,
    cutoverSha: 'sha-new',
  });
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.complete, true);
  assert.strictEqual(cutover.state(STATE).cutoverSha, 'sha-old');
  assert.strictEqual(cutover.scanCalls, scansBeforeReadOnly);
  result = await run(cutover, { nowMs: 3_250 + DRAIN + 3, cutoverSha: 'sha-new' });
  assert.strictEqual(result.complete, true);
  assert.strictEqual(cutover.state(STATE).cutoverSha, 'sha-old');
  const oldEpochState = { ...cutover.state(STATE), writerEpoch: 'legacy-writer-v1' };
  cutover.store.set(STATE, JSON.stringify(oldEpochState));
  result = await run(cutover, { nowMs: 3_250 + DRAIN + 4, cutoverSha: 'sha-new' });
  assert.strictEqual(result.phase, 'drain');
  assert.strictEqual(cutover.state(STATE).writerEpoch, WRITER_EPOCH);
  assert.strictEqual(cutover.state(STATE).cutoverSha, 'sha-new');

  const concurrent = new FakeUpstash({
    'referral:redeemers:concurrent': JSON.stringify([{ email: 'old@example.com', at: ISO }]),
  });
  await run(concurrent, { nowMs: 3_500, cutoverSha: 'sha-concurrent' });
  concurrent.beforeScrub = (fake, key) => {
    const current = JSON.parse(fake.store.get(key));
    current.push({ emailInitial: 'n', at: ISO });
    fake.store.set(key, JSON.stringify(current));
  };
  result = await run(concurrent, {
    nowMs: 3_500 + DRAIN + 1,
    cutoverSha: 'sha-concurrent',
  });
  assert.strictEqual(result.phase, 'verify');
  assert.deepStrictEqual(JSON.parse(concurrent.store.get('referral:redeemers:concurrent')), [
    { emailInitial: '?', at: ISO },
    { emailInitial: 'n', at: ISO },
  ]);

  const busy = new FakeUpstash();
  busy.store.set(LEASE, 'other-worker');
  result = await run(busy, { nowMs: 4_000, cutoverSha: 'sha-busy' });
  assert.strictEqual(result.status, 'busy');
  assert.strictEqual(busy.scanCalls, 0);
  assert.ok(!JSON.stringify(result).includes('referral:'));

  const stale = new FakeUpstash();
  await run(stale, { nowMs: 5_000, cutoverSha: 'sha-stale' });
  stale.beforeFence = (fake, next, leaseKey) => {
    if (next.phase === 'redact') fake.store.set(leaseKey, 'successor-token');
  };
  await assert.rejects(
    () => run(stale, { nowMs: 5_000 + DRAIN + 1, cutoverSha: 'sha-stale' }),
    /referral_privacy_lease_lost/,
  );
  assert.strictEqual(stale.state(STATE).phase, 'drain');
  assert.strictEqual(stale.store.get(LEASE), 'successor-token');

  const lostTransform = new FakeUpstash({
    'referral:redeemers:lost-transform': JSON.stringify([{ email: 'old@example.com', at: ISO }]),
  });
  await run(lostTransform, { nowMs: 6_000, cutoverSha: 'sha-transform' });
  lostTransform.loseScrubResponseOnce = true;
  await assert.rejects(
    () => run(lostTransform, { nowMs: 6_000 + DRAIN + 1, cutoverSha: 'sha-transform' }),
    /referral_privacy_kv_unavailable/,
  );
  assert.strictEqual(lostTransform.state(STATE).cursor, '0');
  assert.doesNotMatch(lostTransform.store.get('referral:redeemers:lost-transform'), /@example\.com/);
  result = await run(lostTransform, { nowMs: 6_000 + DRAIN + 2, cutoverSha: 'sha-transform' });
  assert.strictEqual(result.phase, 'verify');

  const lostCheckpoint = new FakeUpstash({
    'referral:redeemers:lost-checkpoint': JSON.stringify([{ emailInitial: 'c', at: ISO }]),
  });
  await run(lostCheckpoint, { nowMs: 7_000, cutoverSha: 'sha-checkpoint' });
  lostCheckpoint.loseFenceWhen = (next) => next.phase === 'verify';
  await assert.rejects(
    () => run(lostCheckpoint, { nowMs: 7_000 + DRAIN + 1, cutoverSha: 'sha-checkpoint' }),
    /referral_privacy_kv_unavailable/,
  );
  assert.strictEqual(lostCheckpoint.state(STATE).phase, 'verify');
  result = await run(lostCheckpoint, { nowMs: 7_000 + DRAIN + 2, cutoverSha: 'sha-checkpoint' });
  assert.strictEqual(result.complete, true);

  const malformed = new FakeUpstash({
    'referral:redeemers:bad-json': '{',
    'referral:redeemers:wrong-type': JSON.stringify([{ emailInitial: 'x', at: ISO }]),
    'referral:redeemers:sparse': JSON.stringify([{ emailInitial: 's', at: ISO }, null]),
    'referral:redeemers:extra': JSON.stringify([{ emailInitial: 'e', at: ISO, note: 'PII' }]),
    'referral:redeemers:empty': '[]',
    'referral:redeemers:v2': JSON.stringify([{ emailInitial: 'v', at: ISO }]),
    'referral:redeemers:oversized': 'x'.repeat((128 * 1024) + 1),
    'referral:redeemers:too-many': JSON.stringify(Array.from(
      { length: 201 },
      () => ({ emailInitial: 'm', at: ISO }),
    )),
  });
  malformed.types.set('referral:redeemers:wrong-type', 'list');
  const v2Raw = malformed.store.get('referral:redeemers:v2');
  await run(malformed, { nowMs: 8_000, cutoverSha: 'sha-malformed' });
  result = await run(malformed, {
    nowMs: 8_000 + DRAIN + 1,
    cutoverSha: 'sha-malformed',
    maxPages: 5,
  });
  assert.strictEqual(result.complete, true);
  for (const suffix of ['bad-json', 'wrong-type', 'sparse', 'empty', 'oversized', 'too-many']) {
    assert.ok(!malformed.store.has('referral:redeemers:' + suffix));
  }
  assert.deepStrictEqual(JSON.parse(malformed.store.get('referral:redeemers:extra')),
    [{ emailInitial: 'e', at: ISO }]);
  assert.strictEqual(malformed.store.get('referral:redeemers:v2'), v2Raw);

  const duplicate = new FakeUpstash({
    'referral:redeemers:duplicate': JSON.stringify([{ email: 'dup@example.com', at: ISO }]),
  });
  await run(duplicate, { nowMs: 9_000, cutoverSha: 'sha-duplicate' });
  duplicate.scanPages = new Map([
    ['0', ['7', []]],
    ['7', ['0', ['referral:redeemers:duplicate', 'referral:redeemers:duplicate']]],
  ]);
  result = await run(duplicate, {
    nowMs: 9_000 + DRAIN + 1,
    cutoverSha: 'sha-duplicate',
    maxPages: 2,
  });
  assert.strictEqual(result.phase, 'verify');
  assert.strictEqual(result.processed, 2);
  assert.doesNotMatch(duplicate.store.get('referral:redeemers:duplicate'), /dup@example\.com/);

  console.log('Resumable referral privacy migration: PASS');
})().catch((error) => { console.error(error); process.exitCode = 1; });
