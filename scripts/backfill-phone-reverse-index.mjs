#!/usr/bin/env node
'use strict';

// One-time, pre-rollout migration for the historical phone-link partial-write
// window. Older code wrote phone:<E164> first and userPhone:<sub> second. If
// the second write failed, the old phone kept routing to the account but a new
// link request could not discover it. This script rebuilds the missing reverse
// index before the atomic v2 linker is deployed.
//
// Safe defaults:
//   node scripts/backfill-phone-reverse-index.mjs              # dry-run
//   node scripts/backfill-phone-reverse-index.mjs --apply \
//     --confirm=kesefle-phone-reverse-backfill                 # write
//
// Conflicts (multiple forwards for one user, reverse mismatch, missing account)
// are reported and NEVER mutated. No phone number or raw Google sub is printed.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const APPLY_CONFIRMATION = 'kesefle-phone-reverse-backfill';

export function normalizePhone(input) {
  let value = String(input || '').replace(/\D+/g, '');
  while (value.startsWith('972972')) value = value.slice(3);
  if (value.startsWith('9720')) value = '972' + value.slice(4);
  if (value.startsWith('0')) value = '972' + value.slice(1);
  if (/^5\d{8}$/.test(value)) value = '972' + value;
  return value.length >= 7 && value.length <= 15 ? value : null;
}

export function parseStored(raw) {
  let value = raw;
  for (let depth = 0; depth < 2 && typeof value === 'string'; depth++) {
    try { value = JSON.parse(value); } catch (_error) { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function hashId(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 10);
}

export function buildBackfillPlan({ forwards, reverseByUser, accountStateByUser }) {
  const valid = [];
  const grouped = new Map();
  const skipped = [];
  for (const entry of forwards || []) {
    const phone = normalizePhone(String(entry?.key || '').replace(/^phone:/, ''));
    const userSub = typeof entry?.record?.userSub === 'string' ? entry.record.userSub.trim() : '';
    if (!phone || !userSub || userSub.length > 256) {
      skipped.push({ reason: 'invalid_forward_record' });
      continue;
    }
    valid.push({ phone, userSub, key: entry.key });
  }

  const phoneOwners = new Map();
  for (const entry of valid) {
    if (!phoneOwners.has(entry.phone)) phoneOwners.set(entry.phone, new Set());
    phoneOwners.get(entry.phone).add(entry.userSub);
  }
  const conflicts = [];
  const ambiguousPhones = new Set();
  const ambiguousUsers = new Set();
  for (const [phone, owners] of phoneOwners) {
    if (owners.size <= 1) continue;
    ambiguousPhones.add(phone);
    owners.forEach((userSub) => ambiguousUsers.add(userSub));
    conflicts.push({ routeHash: hashId(phone), reason: 'normalized_phone_multiple_users', ownerCount: owners.size });
  }

  for (const entry of valid) {
    if (ambiguousPhones.has(entry.phone) || ambiguousUsers.has(entry.userSub)) continue;
    const { phone, userSub } = entry;
    if (!grouped.has(userSub)) grouped.set(userSub, new Map());
    const routes = grouped.get(userSub);
    if (!routes.has(phone)) routes.set(phone, new Set());
    routes.get(phone).add(entry.key);
  }

  const writes = [];
  const consistent = [];
  for (const [userSub, routes] of grouped) {
    const phones = [...routes.keys()];
    const account = accountStateByUser?.get(userSub);
    if (!account?.hasUser || !account?.hasSheet) {
      skipped.push({ userHash: hashId(userSub), reason: 'canonical_account_missing' });
      continue;
    }
    if (phones.length !== 1) {
      conflicts.push({ userHash: hashId(userSub), reason: 'multiple_forward_routes', routeCount: phones.length });
      continue;
    }
    const phone = phones[0];
    const rawKeys = routes.get(phone);
    const forwardKey = rawKeys.has(`phone:${phone}`) ? `phone:${phone}` : [...rawKeys][0];
    const legacyPhones = [
      account.userRecord?.phoneE164,
      account.userRecord?.linkedPhone,
      account.userRecord?.phone,
    ].map(normalizePhone).filter(Boolean);
    if (legacyPhones.some((legacyPhone) => legacyPhone !== phone)) {
      conflicts.push({ userHash: hashId(userSub), reason: 'legacy_user_phone_mismatch', routeCount: 1 });
      continue;
    }
    const reverse = normalizePhone(reverseByUser?.get(userSub)?.phone);
    if (reverse && reverse !== phone) {
      conflicts.push({ userHash: hashId(userSub), reason: 'reverse_mismatch', routeCount: 1 });
      continue;
    }
    if (reverse === phone) {
      consistent.push({ userHash: hashId(userSub) });
      continue;
    }
    writes.push({ userSub, phone, forwardKey });
  }
  return { writes, conflicts, skipped, consistent };
}

function chunks(values, size) {
  const result = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

async function makeUpstashClient() {
  const url = String(process.env.KV_REST_API_URL || '').replace(/\/$/, '');
  const token = String(process.env.KV_REST_API_TOKEN || '');
  if (!url || !token) throw new Error('KV_REST_API_URL and KV_REST_API_TOKEN are required');
  return async function command(parts) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parts),
    });
    if (!response.ok) throw new Error(`Upstash HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || payload.error) throw new Error('Upstash command failed');
    return payload.result;
  };
}

async function scanPhoneKeys(command) {
  const keys = [];
  let cursor = '0';
  do {
    const result = await command(['SCAN', cursor, 'MATCH', 'phone:*', 'COUNT', '200']);
    if (!Array.isArray(result) || !Array.isArray(result[1])) throw new Error('Unexpected SCAN result');
    cursor = String(result[0]);
    keys.push(...result[1].filter((key) => typeof key === 'string'));
  } while (cursor !== '0');
  return [...new Set(keys)];
}

async function mgetMap(command, keys) {
  const values = new Map();
  for (const batch of chunks(keys, 100)) {
    if (!batch.length) continue;
    const result = await command(['MGET', ...batch]);
    if (!Array.isArray(result) || result.length !== batch.length) throw new Error('Unexpected MGET result');
    batch.forEach((key, index) => values.set(key, parseStored(result[index])));
  }
  return values;
}

async function applyBackfill(command, item) {
  const record = JSON.stringify({
    schemaVersion: 2,
    phone: item.phone,
    linkedAt: new Date().toISOString(),
    verificationMethod: 'legacy_forward_backfill',
  });
  const script = `#!lua flags=allow-key-locking
-- KESEFLE_BACKFILL_PHONE_REVERSE_V1
local function decode(raw)
  if not raw then return nil end
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= 'table' then return nil end
  return value
end
if redis.call('EXISTS', KEYS[1]) == 1 then return 'reverse_exists' end
local forward = decode(redis.call('GET', KEYS[2]))
if not forward or forward.userSub ~= ARGV[1] then return 'forward_changed' end
if redis.call('EXISTS', KEYS[3]) == 0 or redis.call('EXISTS', KEYS[4]) == 0 then return 'account_missing' end
redis.call('SET', KEYS[1], ARGV[2])
return 'written'`;
  return command([
    'EVAL', script, '4',
    `userPhone:${item.userSub}`,
    item.forwardKey,
    `user:${item.userSub}`,
    `sheet:${item.userSub}`,
    item.userSub,
    record,
  ]);
}

async function auditBackfill(command) {
  const scannedKeys = await scanPhoneKeys(command);
  const phoneKeys = scannedKeys.filter((key) => /^phone:\+?\d{7,15}$/.test(key));
  const forwardValues = await mgetMap(command, phoneKeys);
  const forwards = phoneKeys.map((key) => ({ key, record: forwardValues.get(key) }));
  const userSubs = [...new Set(forwards.map((entry) => entry.record?.userSub).filter((value) => typeof value === 'string' && value))];
  const relatedKeys = userSubs.flatMap((sub) => [`userPhone:${sub}`, `user:${sub}`, `sheet:${sub}`]);
  const related = await mgetMap(command, relatedKeys);
  const reverseByUser = new Map();
  const accountStateByUser = new Map();
  for (const sub of userSubs) {
    reverseByUser.set(sub, related.get(`userPhone:${sub}`));
    accountStateByUser.set(sub, {
      hasUser: !!related.get(`user:${sub}`),
      hasSheet: !!related.get(`sheet:${sub}`),
      userRecord: related.get(`user:${sub}`),
    });
  }
  return {
    plan: buildBackfillPlan({ forwards, reverseByUser, accountStateByUser }),
    scannedForwardRoutes: forwards.length,
    ignoredNamespaceCount: scannedKeys.length - phoneKeys.length,
  };
}

export async function runBackfill({ apply = false, command } = {}) {
  const kv = command || await makeUpstashClient();
  const initial = await auditBackfill(kv);
  const results = [];
  if (apply) {
    for (const item of initial.plan.writes) {
      results.push({ userHash: hashId(item.userSub), result: await applyBackfill(kv, item) });
    }
  }
  // A typed Lua result is not proof of readiness: another writer may have
  // changed the forward/reverse state after the first scan. Re-scan after every
  // apply and trust only a clean, freshly observed index.
  const finalAudit = apply ? await auditBackfill(kv) : initial;
  const finalPlan = finalAudit.plan;
  const readyForRollout = finalPlan.writes.length === 0
    && finalPlan.conflicts.length === 0
    && finalPlan.skipped.length === 0;
  return {
    mode: apply ? 'apply' : 'dry-run',
    readyForRollout,
    requiresLinkMintFreeze: true,
    scannedForwardRoutes: finalAudit.scannedForwardRoutes,
    ignoredNamespaceCount: finalAudit.ignoredNamespaceCount,
    plannedWrites: initial.plan.writes.length,
    remainingWrites: finalPlan.writes.length,
    conflictCount: finalPlan.conflicts.length,
    skippedCount: finalPlan.skipped.length,
    consistentCount: finalPlan.consistent.length,
    conflicts: finalPlan.conflicts,
    skipped: finalPlan.skipped,
    results,
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const confirmation = process.argv.find((arg) => arg.startsWith('--confirm='))?.slice('--confirm='.length);
  if (apply && confirmation !== APPLY_CONFIRMATION) {
    throw new Error(`Apply requires --confirm=${APPLY_CONFIRMATION}`);
  }
  const summary = await runBackfill({ apply });
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.readyForRollout) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}
