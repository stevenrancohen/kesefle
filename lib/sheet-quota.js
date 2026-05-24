// lib/sheet-quota.js
//
// Per-tenant Sheets API call tracker. Google Sheets has a 100 read/100s and
// 100 write/100s budget PER USER-PROJECT. A runaway bot loop or a misbehaving
// integration could exhaust a single tenant's budget without us knowing --
// they'd just see "all my writes are silently failing" with no signal to us.
//
// Strategy: ZERO KV cost. In-memory sliding-window counter per spreadsheetId.
// Vercel keeps warm instances for ~15 min so this catches any anomaly that
// fires within a warm window. The first call after a cold boot just starts
// fresh -- accepted tradeoff for the cost savings.
//
// When a tenant crosses 80% of the 100-req/100s budget, we fire ONE Slack/
// email alert via lib/alert.js with a 1h dedup window (so a hot loop doesn't
// page Steven hundreds of times).

import { log } from './log.js';

const WINDOW_MS = 100 * 1000; // Google's window: 100 seconds
const READ_LIMIT = 100;        // Google's per-user read budget
const WRITE_LIMIT = 100;       // Google's per-user write budget
const ALERT_THRESHOLD = 80;    // 80% of either budget triggers an alert

// Map<spreadsheetId, { reads: [timestamps], writes: [timestamps] }>
// Bounded to 500 sheets to prevent unbounded growth on a long-lived instance.
const _counters = new Map();
const MAX_COUNTERS = 500;

function trimAndCount(arr, now) {
  const cutoff = now - WINDOW_MS;
  // Modify in place to avoid an extra allocation per call.
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  if (i > 0) arr.splice(0, i);
  return arr.length;
}

// Called by sheet-writer.js around each Sheets API call. `kind` is 'read'
// or 'write'. Returns the post-increment count -- callers can ignore it.
// Returns null if `spreadsheetId` is missing (defensive).
export function recordSheetCall(spreadsheetId, kind) {
  if (!spreadsheetId) return null;
  const now = Date.now();
  let bucket = _counters.get(spreadsheetId);
  if (!bucket) {
    // LRU evict if at capacity.
    if (_counters.size >= MAX_COUNTERS) {
      const oldestKey = _counters.keys().next().value;
      _counters.delete(oldestKey);
    }
    bucket = { reads: [], writes: [], lastAlertAt: 0 };
    _counters.set(spreadsheetId, bucket);
  }
  const arr = kind === 'write' ? bucket.writes : bucket.reads;
  arr.push(now);
  const count = trimAndCount(arr, now);
  const limit = kind === 'write' ? WRITE_LIMIT : READ_LIMIT;
  const pct = Math.round((count / limit) * 100);

  if (pct >= ALERT_THRESHOLD && (now - bucket.lastAlertAt) > 3600 * 1000) {
    bucket.lastAlertAt = now;
    // Fire-and-forget; dynamic import keeps cold-start small.
    import('./alert.js').then(function (m) {
      m.sendAlert({
        severity: pct >= 95 ? 'critical' : 'warning',
        title: `Sheets API budget: ${pct}% for ${spreadsheetId.slice(0, 14)}...`,
        body: `Spreadsheet ${spreadsheetId} hit ${count}/${limit} ${kind}s in the last 100s.\n\n` +
          `Possible causes: a runaway bot loop on this tenant, a misbehaving script, or a real burst of activity. ` +
          `Check append.js logs for the userSub + recent activity in /admin/user-timeline.`,
        tags: ['sheets-quota', kind],
      }).catch(function () {});
    }).catch(function () {});
    log.warn('sheet_quota.threshold_reached', { spreadsheetId: spreadsheetId.slice(0, 14), kind, count, limit, pct });
  }

  return { count, limit, pct };
}

// Read-only snapshot for /admin/user-timeline + monitoring dashboards.
export function getSheetQuotaSnapshot() {
  const now = Date.now();
  const out = [];
  for (const [sid, bucket] of _counters) {
    const reads = trimAndCount(bucket.reads, now);
    const writes = trimAndCount(bucket.writes, now);
    if (reads === 0 && writes === 0) continue; // skip idle
    out.push({
      spreadsheetId: sid,
      reads,
      writes,
      read_pct: Math.round((reads / READ_LIMIT) * 100),
      write_pct: Math.round((writes / WRITE_LIMIT) * 100),
    });
  }
  return out.sort((a, b) => Math.max(b.read_pct, b.write_pct) - Math.max(a.read_pct, a.write_pct));
}

// Test helper -- only used by tests/full_qa.js. Not exported in the public
// runtime surface.
export function _resetQuotaForTest() {
  _counters.clear();
}
