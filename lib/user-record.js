// Atomic partial updates for the canonical user:<sub> document.
//
// Callers must never GET a user record, mutate that snapshot, and SET the whole
// object later: a concurrent billing/login/activity write would be erased. This
// helper applies only the requested fields while Upstash holds the user key.

import crypto from 'node:crypto';

const DELETION_TOMBSTONE_TTL_SEC = 400 * 24 * 3600;

function userDeletionKey(userSub) {
  const digest = crypto.createHash('sha256').update(String(userSub || '')).digest('hex');
  return `deletedUser:${digest}`;
}

function manualPaymentIndexKey(userSub) {
  const digest = crypto.createHash('sha256').update(String(userSub || '')).digest('hex');
  return `manualPayments:${digest}`;
}

async function runUserRecordEval(script, keys, args = []) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('user_record_kv_unavailable');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['EVAL', script, String(keys.length), ...keys, ...args]),
  });
  if (!response.ok) throw new Error(`user_record_kv_status_${response.status}`);
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload.result !== 'string') throw new Error('user_record_kv_response_malformed');
  try { return JSON.parse(payload.result); }
  catch { throw new Error('user_record_kv_response_malformed'); }
}

const MARK_USER_DELETED_LUA = `#!lua flags=allow-key-locking
-- KESEFLE_USER_DELETION_MARK_V1
local state = redis.call('GET', KEYS[2])
if state == 'deleted' then return cjson.encode({ status = 'deleted' }) end
if redis.call('EXISTS', KEYS[1]) == 0 and not state and ARGV[2] ~= '1' then
  return cjson.encode({ status = 'missing' })
end
redis.call('SET', KEYS[2], 'deleting', 'EX', tonumber(ARGV[1]))
return cjson.encode({ status = 'deleting' })`;

const FINALIZE_USER_DELETION_LUA = `#!lua flags=allow-key-locking
-- KESEFLE_USER_DELETION_FINALIZE_V1
if redis.call('EXISTS', KEYS[1]) == 1 then
  return cjson.encode({ status = 'user_present' })
end
local state = redis.call('GET', KEYS[2])
if state ~= 'deleting' and state ~= 'deleted' then
  return cjson.encode({ status = 'missing_marker' })
end
redis.call('SET', KEYS[2], 'deleted', 'EX', tonumber(ARGV[1]))
return cjson.encode({ status = 'deleted' })`;

async function markUserDeleted(userSub, options = {}) {
  const normalizedSub = String(userSub || '').trim();
  if (!normalizedSub) throw new Error('user_record_sub_required');
  const result = await runUserRecordEval(MARK_USER_DELETED_LUA, [
    `user:${normalizedSub}`, userDeletionKey(normalizedSub),
  ], [String(DELETION_TOMBSTONE_TTL_SEC), options.allowMissing ? '1' : '0']);
  if (!['deleting', 'deleted'].includes(result?.status)) throw new Error('user_deletion_mark_failed');
  return result.status;
}

async function finalizeUserDeletion(userSub) {
  const normalizedSub = String(userSub || '').trim();
  if (!normalizedSub) throw new Error('user_record_sub_required');
  const result = await runUserRecordEval(FINALIZE_USER_DELETION_LUA, [
    `user:${normalizedSub}`, userDeletionKey(normalizedSub),
  ], [String(DELETION_TOMBSTONE_TTL_SEC)]);
  if (result?.status !== 'deleted') throw new Error(`user_deletion_finalize_${result?.status || 'failed'}`);
  return true;
}

async function getUserDeletionState(userSub) {
  const normalizedSub = String(userSub || '').trim();
  if (!normalizedSub) throw new Error('user_record_sub_required');
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('user_record_kv_unavailable');
  const response = await fetch(`${url}/get/${encodeURIComponent(userDeletionKey(normalizedSub))}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`user_record_kv_status_${response.status}`);
  const payload = await response.json().catch(() => null);
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'result')) {
    throw new Error('user_record_kv_response_malformed');
  }
  if (payload.result === null) return null;
  if (!['deleting', 'deleted'].includes(payload.result)) throw new Error('user_deletion_marker_malformed');
  return payload.result;
}

const USER_RECORD_MERGE_LUA = `#!lua flags=allow-key-locking
-- KESEFLE_USER_RECORD_MERGE_V1
local raw = redis.call('GET', KEYS[1])
local created = raw == false
local deletion_state = redis.call('GET', KEYS[2])
if deletion_state then
  if ARGV[4] ~= '1' then
    return cjson.encode({ status = 'account_deleted' })
  end
  if deletion_state ~= 'deleted' then
    return cjson.encode({ status = 'deletion_in_progress' })
  end
  if not created then
    return cjson.encode({ status = 'deletion_in_progress' })
  end
end
if created and ARGV[3] == '1' then
  return cjson.encode({ status = 'missing' })
end

local record = { userSub = ARGV[1] }
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' then
    return cjson.encode({ status = 'malformed_user_record' })
  end
  record = decoded
end
if record['userSub'] and tostring(record['userSub']) ~= ARGV[1] then
  return cjson.encode({ status = 'user_identity_mismatch' })
end

local ops_ok, ops = pcall(cjson.decode, ARGV[2])
if not ops_ok or type(ops) ~= 'table' then
  return cjson.encode({ status = 'malformed_operations' })
end

if created and type(ops['setOnCreate']) == 'table' then
  for field, value in pairs(ops['setOnCreate']) do record[field] = value end
end
if type(ops['setIfMissing']) == 'table' then
  for field, value in pairs(ops['setIfMissing']) do
    if record[field] == nil or record[field] == cjson.null then record[field] = value end
  end
end
if type(ops['set']) == 'table' then
  for field, value in pairs(ops['set']) do record[field] = value end
end
if type(ops['increments']) == 'table' then
  for field, amount in pairs(ops['increments']) do
    record[field] = (tonumber(record[field]) or 0) + (tonumber(amount) or 0)
  end
end
if type(ops['deleteFields']) == 'table' then
  for _, field in ipairs(ops['deleteFields']) do record[tostring(field)] = nil end
end

record['userSub'] = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(record))
if deletion_state and created and ARGV[4] == '1' then redis.call('DEL', KEYS[2]) end
return cjson.encode({ status = 'merged', created = created, record = record })`;

async function atomicMergeUserRecord(userSub, operations = {}, options = {}) {
  const normalizedSub = String(userSub || '').trim();
  if (!normalizedSub) throw new Error('user_record_sub_required');
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('user_record_kv_unavailable');

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      'EVAL', USER_RECORD_MERGE_LUA, '2', `user:${normalizedSub}`, userDeletionKey(normalizedSub),
      normalizedSub,
      JSON.stringify({
        set: operations.set || {},
        setIfMissing: operations.setIfMissing || {},
        setOnCreate: operations.setOnCreate || {},
        increments: operations.increments || {},
        deleteFields: operations.deleteFields || [],
      }),
      options.requireExisting ? '1' : '0',
      options.allowDeletedRecreate ? '1' : '0',
    ]),
  });
  if (!response.ok) throw new Error(`user_record_kv_status_${response.status}`);
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload.result !== 'string') {
    throw new Error('user_record_kv_response_malformed');
  }
  let result;
  try { result = JSON.parse(payload.result); }
  catch { throw new Error('user_record_kv_response_malformed'); }
  if (result?.status === 'missing') return { ok: false, reason: 'missing' };
  if (result?.status === 'account_deleted') return { ok: false, reason: 'account_deleted' };
  if (result?.status === 'deletion_in_progress') return { ok: false, reason: 'deletion_in_progress' };
  if (result?.status === 'malformed_user_record') throw new Error('user_record_malformed');
  if (result?.status === 'user_identity_mismatch') throw new Error('user_record_identity_mismatch');
  if (result?.status !== 'merged' || !result.record) throw new Error('user_record_merge_failed');
  return { ok: true, created: !!result.created, record: result.record };
}

export {
  atomicMergeUserRecord,
  markUserDeleted,
  finalizeUserDeletion,
  getUserDeletionState,
  userDeletionKey,
  manualPaymentIndexKey,
  USER_RECORD_MERGE_LUA,
  DELETION_TOMBSTONE_TTL_SEC,
  MARK_USER_DELETED_LUA,
  FINALIZE_USER_DELETION_LUA,
};
