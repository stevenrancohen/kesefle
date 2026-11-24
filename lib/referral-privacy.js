// Resumable one-time migration for historical referral redeemer lists.
//
// Writer v2 (api/referral.js) never stores a full email. This worker waits for
// pre-v2 serverless invocations to drain, canonicalizes every historical list,
// then performs zero-or-more verification passes. `ready` is durable and is
// only reached after a full verify pass makes no changes.

import { randomUUID } from 'node:crypto';

const STATE_KEY = 'referral:privacy:migration:v2';
const LEASE_KEY = 'referral:privacy:migration:v2:lease';
const LIST_PATTERN = 'referral:redeemers:*';
const DRAIN_MS = 60 * 60 * 1000;
const LEASE_SECONDS = 90;
const MAX_LIST_BYTES = 128 * 1024;
const MAX_LIST_ENTRIES = 200;
// Stable schema fence: bump only if the referral writer's persisted PII shape
// changes. Ordinary deploy SHAs must not restart a potentially long migration.
// Never roll back below writer v2; after an emergency rollback, bump this epoch
// before rolling forward so historical values are drained and verified again.
const WRITER_EPOCH = 'redeemers-email-initial-v2';
const PHASES = new Set(['drain', 'redact', 'verify', 'ready']);

function migrationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function kvConfig() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw migrationError('referral_privacy_kv_unavailable');
  return { url, token };
}

async function kvCommand(command) {
  const { url, token } = kvConfig();
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
  } catch {
    throw migrationError('referral_privacy_kv_unavailable');
  }
  if (!response.ok) throw migrationError('referral_privacy_kv_failed');
  const payload = await response.json().catch(() => null);
  if (!payload || Object.prototype.hasOwnProperty.call(payload, 'error') ||
      !Object.prototype.hasOwnProperty.call(payload, 'result')) {
    throw migrationError('referral_privacy_kv_malformed');
  }
  return payload.result;
}

function validState(value) {
  const validShape = !!value && typeof value === 'object' && !Array.isArray(value) &&
    value.schema === 2 && PHASES.has(value.phase) &&
    typeof value.cursor === 'string' && /^\d+$/.test(value.cursor) &&
    Number.isSafeInteger(value.revision) && value.revision >= 0 &&
    Number.isSafeInteger(value.dirty) && value.dirty >= 0 &&
    Number.isSafeInteger(value.redacted) && value.redacted >= 0 &&
    Number.isSafeInteger(value.quarantined) && value.quarantined >= 0 &&
    Number.isSafeInteger(value.drainUntil) && value.drainUntil >= 0 &&
    typeof value.writerEpoch === 'string' && value.writerEpoch.length > 0 && value.writerEpoch.length <= 128 &&
    typeof value.cutoverSha === 'string' && value.cutoverSha.length > 0 && value.cutoverSha.length <= 128;
  if (!validShape) return false;
  if ((value.phase === 'drain' || value.phase === 'ready') && value.cursor !== '0') return false;
  if ((value.phase === 'drain' || value.phase === 'ready') && value.dirty !== 0) return false;
  return true;
}

async function readState() {
  const raw = await kvCommand(['GET', STATE_KEY]);
  if (raw === null) return { raw: null, state: null };
  if (typeof raw !== 'string') throw migrationError('referral_privacy_state_invalid');
  let state;
  try { state = JSON.parse(raw); } catch { throw migrationError('referral_privacy_state_invalid'); }
  if (!validState(state)) throw migrationError('referral_privacy_state_invalid');
  return { raw, state };
}

async function acquireLease(token) {
  try {
    const result = await kvCommand(['SET', LEASE_KEY, token, 'NX', 'EX', String(LEASE_SECONDS)]);
    return result === 'OK';
  } catch (error) {
    // A lost HTTP response may follow a committed SET NX. Reconcile ownership
    // before giving up; only this exact token may continue.
    try { return (await kvCommand(['GET', LEASE_KEY])) === token; } catch { throw error; }
  }
}

async function releaseLease(token) {
  const script = `#!lua flags=allow-key-locking
-- KESEFLE_REFERRAL_PRIVACY_RELEASE_V2
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`;
  await kvCommand(['EVAL', script, '1', LEASE_KEY, token]);
}

async function writeState(snapshot, nextState, token) {
  const script = `#!lua flags=allow-key-locking
-- KESEFLE_REFERRAL_PRIVACY_FENCE_V2
if redis.call('GET', KEYS[2]) ~= ARGV[1] then
  return cjson.encode({ status = 'lease_lost' })
end
local current = redis.call('GET', KEYS[1])
if ARGV[2] == '1' then
  if current then return cjson.encode({ status = 'conflict' }) end
elseif current ~= ARGV[3] then
  return cjson.encode({ status = 'conflict' })
end
redis.call('SET', KEYS[1], ARGV[4])
return cjson.encode({ status = 'ok' })`;
  const nextRaw = JSON.stringify(nextState);
  const resultRaw = await kvCommand([
    'EVAL', script, '2', STATE_KEY, LEASE_KEY, token,
    snapshot.raw === null ? '1' : '0', snapshot.raw || '', nextRaw,
  ]);
  if (typeof resultRaw !== 'string') throw migrationError('referral_privacy_fence_malformed');
  let result;
  try { result = JSON.parse(resultRaw); } catch { throw migrationError('referral_privacy_fence_malformed'); }
  if (result?.status !== 'ok') throw migrationError(`referral_privacy_${result?.status || 'fence_failed'}`);
  return { raw: nextRaw, state: nextState };
}

async function scanPage(cursor, pageSize) {
  const result = await kvCommand([
    'SCAN', cursor, 'MATCH', LIST_PATTERN, 'COUNT', String(pageSize),
  ]);
  if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
    throw migrationError('referral_privacy_scan_malformed');
  }
  const next = String(result[0] ?? '');
  if (!/^\d+$/.test(next) || !result[1].every((key) => typeof key === 'string')) {
    throw migrationError('referral_privacy_scan_malformed');
  }
  return { next, keys: result[1] };
}

async function scrubList(key, targetEmail) {
  const script = `#!lua flags=allow-key-locking
-- KESEFLE_REFERRAL_PRIVACY_SCRUB_V2
local key_type = redis.call('TYPE', KEYS[1])
if type(key_type) == 'table' then key_type = key_type.ok end
if key_type == 'none' then return cjson.encode({ status = 'missing', changed = false }) end
if key_type ~= 'string' then
  redis.call('DEL', KEYS[1])
  return cjson.encode({ status = 'quarantined', changed = true })
end
local raw = redis.call('GET', KEYS[1])
if string.len(raw) > tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return cjson.encode({ status = 'quarantined', changed = true })
end
local ok, decoded = pcall(cjson.decode, raw)
if not ok or type(decoded) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return cjson.encode({ status = 'quarantined', changed = true })
end
local function strict_iso(value)
  if type(value) ~= 'string' then return false end
  local year, month, day, hour, minute, second = string.match(
    value, '^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)%.%d%d%dZ$'
  )
  year, month, day = tonumber(year), tonumber(month), tonumber(day)
  hour, minute, second = tonumber(hour), tonumber(minute), tonumber(second)
  if not year or year < 1970 or year > 9999 or not month or month < 1 or month > 12 or
      not hour or hour < 0 or hour > 23 or not minute or minute < 0 or minute > 59 or
      not second or second < 0 or second > 59 then return false end
  local month_days = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
  if month == 2 and (year % 400 == 0 or (year % 4 == 0 and year % 100 ~= 0)) then month_days[2] = 29 end
  return day ~= nil and day >= 1 and day <= month_days[month]
end
local entries = 0
for index, value in pairs(decoded) do
  if type(index) ~= 'number' or index < 1 or index % 1 ~= 0 or type(value) ~= 'table' then
    redis.call('DEL', KEYS[1])
    return cjson.encode({ status = 'quarantined', changed = true })
  end
  entries = entries + 1
  if entries > tonumber(ARGV[3]) then
    redis.call('DEL', KEYS[1])
    return cjson.encode({ status = 'quarantined', changed = true })
  end
end
if entries == 0 then
  redis.call('DEL', KEYS[1])
  return cjson.encode({ status = 'redacted', changed = true })
end
local output = {}
local changed = false
for index = 1, entries do
  local value = decoded[index]
  if not value or not strict_iso(value.at) then
    redis.call('DEL', KEYS[1])
    return cjson.encode({ status = 'quarantined', changed = true })
  end
  local canonical = true
  for field, _ in pairs(value) do
    if field ~= 'emailInitial' and field ~= 'at' then canonical = false end
  end
  if type(value.email) == 'string' then
    changed = true
    local normalized = string.lower(string.gsub(value.email, '^%s*(.-)%s*$', '%1'))
    if normalized ~= ARGV[1] then table.insert(output, { emailInitial = '?', at = value.at }) end
  else
    local initial = value.emailInitial
    if type(initial) ~= 'string' or not string.match(initial, '^[A-Za-z0-9?]$') then
      initial = '?'
      canonical = false
    end
    if not canonical then changed = true end
    table.insert(output, { emailInitial = initial, at = value.at })
  end
end
if #output == 0 then
  redis.call('DEL', KEYS[1])
  return cjson.encode({ status = 'redacted', changed = true })
end
if changed or #output ~= entries then redis.call('SET', KEYS[1], cjson.encode(output)) end
return cjson.encode({ status = 'ok', changed = changed or #output ~= entries })`;
  const resultRaw = await kvCommand([
    'EVAL', script, '1', key, targetEmail, String(MAX_LIST_BYTES), String(MAX_LIST_ENTRIES),
  ]);
  if (typeof resultRaw !== 'string') throw migrationError('referral_privacy_scrub_malformed');
  let result;
  try { result = JSON.parse(resultRaw); } catch { throw migrationError('referral_privacy_scrub_malformed'); }
  if (!['missing', 'quarantined', 'redacted', 'ok'].includes(result?.status) ||
      typeof result.changed !== 'boolean') {
    throw migrationError('referral_privacy_scrub_malformed');
  }
  return result;
}

async function scrubPage(keys, targetEmail, concurrency) {
  let changed = 0;
  let quarantined = 0;
  for (let start = 0; start < keys.length; start += concurrency) {
    const results = await Promise.all(
      keys.slice(start, start + concurrency).map((key) => scrubList(key, targetEmail)),
    );
    for (const result of results) {
      if (result.changed) changed += 1;
      if (result.status === 'quarantined') quarantined += 1;
    }
  }
  return { changed, quarantined };
}

function publicResult(state, extra = {}) {
  return {
    complete: state.phase === 'ready',
    phase: state.phase,
    status: state.phase === 'ready' ? 'ready' : (extra.status || 'progressed'),
    processed: extra.processed || 0,
    changed: extra.changed || 0,
    quarantined: extra.quarantined || 0,
    retryAfter: state.phase === 'ready' ? 0 : Math.max(1, extra.retryAfter || 5),
  };
}

function awaitingWorkerResult(state) {
  return {
    complete: false,
    phase: state && state.phase !== 'ready' ? state.phase : 'drain',
    status: 'awaiting_worker',
    processed: 0,
    changed: 0,
    quarantined: 0,
    retryAfter: 300,
  };
}

async function migrateLegacyReferralPii(options = {}) {
  const maxPages = Math.max(1, Math.min(20, Math.trunc(Number(options.maxPages) || 1)));
  const pageSize = Math.max(10, Math.min(500, Math.trunc(Number(options.pageSize) || 100)));
  const concurrency = Math.max(1, Math.min(50, Math.trunc(Number(options.concurrency) || 25)));
  const targetEmail = String(options.targetEmail || '').trim().toLowerCase();
  const nowMs = Number.isSafeInteger(options.nowMs) ? options.nowMs : Date.now();
  const cutoverSha = String(options.cutoverSha || process.env.VERCEL_GIT_COMMIT_SHA || 'local-v2').slice(0, 128);
  // Only the authenticated production cron is allowed to initialize, reset or
  // advance this global migration. Account and preview requests are read-only,
  // limiting their KV cost to one state lookup and protecting production state.
  const productionEnvironment = process.env.VERCEL_ENV === 'production';
  const productionWorker = options.worker === true && productionEnvironment;

  let snapshot = await readState();
  if (!productionEnvironment) return awaitingWorkerResult(snapshot.state);
  if (snapshot.state?.phase === 'ready' && snapshot.state.writerEpoch === WRITER_EPOCH) {
    return publicResult(snapshot.state);
  }
  if (!productionWorker) return awaitingWorkerResult(snapshot.state);
  if (snapshot.state?.phase === 'drain' && snapshot.state.writerEpoch === WRITER_EPOCH &&
      nowMs < snapshot.state.drainUntil) {
    return publicResult(snapshot.state, {
      status: 'draining', retryAfter: Math.ceil((snapshot.state.drainUntil - nowMs) / 1000),
    });
  }

  const leaseToken = randomUUID();
  if (!(await acquireLease(leaseToken))) {
    snapshot = await readState();
    if (snapshot.state?.phase === 'ready' && snapshot.state.writerEpoch === WRITER_EPOCH) {
      return publicResult(snapshot.state);
    }
    const fallback = snapshot.state || {
      phase: 'drain', drainUntil: nowMs + DRAIN_MS,
    };
    return publicResult(fallback, { status: 'busy', retryAfter: 5 });
  }

  let processed = 0;
  let changed = 0;
  let quarantined = 0;
  try {
    snapshot = await readState();
    if (!snapshot.state) {
      snapshot = await writeState(snapshot, {
        schema: 2,
        phase: 'drain',
        cursor: '0',
        revision: 0,
        dirty: 0,
        redacted: 0,
        quarantined: 0,
        drainUntil: nowMs + DRAIN_MS,
        writerEpoch: WRITER_EPOCH,
        cutoverSha,
      }, leaseToken);
    } else if (snapshot.state.writerEpoch !== WRITER_EPOCH) {
      snapshot = await writeState(snapshot, {
        ...snapshot.state,
        phase: 'drain',
        cursor: '0',
        revision: snapshot.state.revision + 1,
        dirty: 0,
        drainUntil: nowMs + DRAIN_MS,
        writerEpoch: WRITER_EPOCH,
        cutoverSha,
      }, leaseToken);
    }

    let state = snapshot.state;
    if (state.phase === 'ready') return publicResult(state);
    if (state.phase === 'drain') {
      if (nowMs < state.drainUntil) {
        return publicResult(state, {
          status: 'draining', retryAfter: Math.ceil((state.drainUntil - nowMs) / 1000),
        });
      }
      snapshot = await writeState(snapshot, {
        ...state,
        phase: 'redact',
        cursor: '0',
        revision: state.revision + 1,
        dirty: 0,
      }, leaseToken);
      state = snapshot.state;
    }

    for (let page = 0; page < maxPages && state.phase !== 'ready'; page += 1) {
      const scanned = await scanPage(state.cursor, pageSize);
      const scrubbed = await scrubPage(scanned.keys, targetEmail, concurrency);
      processed += scanned.keys.length;
      changed += scrubbed.changed;
      quarantined += scrubbed.quarantined;

      const passDirty = state.dirty + scrubbed.changed;
      let nextState = {
        ...state,
        cursor: scanned.next,
        revision: state.revision + 1,
        dirty: passDirty,
        redacted: state.redacted + scrubbed.changed,
        quarantined: state.quarantined + scrubbed.quarantined,
      };
      if (scanned.next === '0' && state.phase === 'redact') {
        nextState = { ...nextState, phase: 'verify', cursor: '0', dirty: 0 };
      } else if (scanned.next === '0' && state.phase === 'verify') {
        nextState = passDirty === 0
          ? { ...nextState, phase: 'ready', cursor: '0', dirty: 0 }
          : { ...nextState, phase: 'verify', cursor: '0', dirty: 0 };
      }
      snapshot = await writeState(snapshot, nextState, leaseToken);
      state = snapshot.state;
    }
    return publicResult(state, { processed, changed, quarantined, retryAfter: 5 });
  } finally {
    await releaseLease(leaseToken).catch(() => {});
  }
}

export {
  migrateLegacyReferralPii,
  STATE_KEY as REFERRAL_PRIVACY_STATE_KEY,
  LEASE_KEY as REFERRAL_PRIVACY_LEASE_KEY,
  DRAIN_MS as REFERRAL_PRIVACY_DRAIN_MS,
  WRITER_EPOCH as REFERRAL_WRITER_EPOCH,
};
