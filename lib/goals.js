// lib/goals.js
//
// PR-1 of the Smart Budget Goals feature (see docs/SMART_BUDGET_GOALS_DESIGN.md).
// Pure logic + KV CRUD. No alerts (that's PR-2), no dashboard wiring (PR-3),
// no pre-write block (PR-3).
//
// Data shape: see docs/SMART_BUDGET_GOALS_DESIGN.md §Data model.
//
// KV layout:
//   goal:{userSub}:{goalId}  -> JSON record
//   goals:{userSub}          -> JSON array of goalIds (index, for listGoals)
//
// All identifiers are owned by userSub (the Google `sub` claim). Tenant
// isolation: every helper takes userSub as the first arg and never
// reads/writes outside its key prefix.

import { randomBytes } from 'crypto';

const KV_URL = () => process.env.KV_REST_API_URL;
const KV_TOK = () => process.env.KV_REST_API_TOKEN;

// ── KV primitives (same shape as lib/billing.js to keep one mental model) ──

async function kvGet(key) {
  const url = KV_URL(); const token = KV_TOK();
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.result) return null;
  try { return JSON.parse(j.result); } catch { return j.result; }
}

async function kvSet(key, value) {
  const url = KV_URL(); const token = KV_TOK();
  if (!url || !token) return false;
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}

async function kvDel(key) {
  const url = KV_URL(); const token = KV_TOK();
  if (!url || !token) return false;
  const r = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return r.ok;
}

// ── helpers ────────────────────────────────────────────────────────────────

function newGoalId() {
  return 'g_' + randomBytes(8).toString('hex');
}

function _goalKey(userSub, goalId) {
  return 'goal:' + userSub + ':' + goalId;
}

function _indexKey(userSub) {
  return 'goals:' + userSub;
}

// ── command parser ─────────────────────────────────────────────────────────
//
// Hebrew-first. Recognized forms:
//   "קבע יעד <category> <amount>"   -> {type:'spend_cap', category, amount}
//   "קבע יעד <amount>"               -> {type:'savings', amount}
//   "יעדים"                          -> {action:'list'}
//   "מחק יעד <category>"             -> {action:'delete', category}
//   "יעדים כבוי"                     -> {action:'mute_month'} (placeholder for PR-2)
//
// All amounts in NIS (whole or with comma). Category is everything between
// "יעד" and the final number. Returns {action:'none'} if no match.

export function parseGoalCommand(text) {
  if (!text || typeof text !== 'string') return { action: 'none' };
  const t = text.trim();

  if (/^יעדים\s*כבוי$/i.test(t)) return { action: 'mute_month' };
  if (/^יעדים$/i.test(t)) return { action: 'list' };

  const delMatch = t.match(/^מחק\s+יעד\s+(.+)$/i);
  if (delMatch) return { action: 'delete', category: delMatch[1].trim() };

  // "קבע יעד" or "קבע יעדי" (typo-tolerant)
  const setMatch = t.match(/^(?:קבע|הגדר)\s+יעד\s+(.+)$/i);
  if (!setMatch) return { action: 'none' };

  const tail = setMatch[1].trim();
  // Pull the LAST number off the tail. Anything before it is the category.
  const amtMatch = tail.match(/^(.*?)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*₪?\s*$/);
  if (!amtMatch) return { action: 'none' };

  const amountILS = Number(String(amtMatch[2]).replace(/,/g, ''));
  if (!isFinite(amountILS) || amountILS < 1 || amountILS > 10_000_000) {
    return { action: 'none' };
  }

  const category = (amtMatch[1] || '').trim();
  if (!category) {
    return { action: 'set', type: 'savings', category: null, amountILS };
  }
  return { action: 'set', type: 'spend_cap', category, amountILS };
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function listGoals(userSub) {
  if (!userSub) return [];
  const idx = (await kvGet(_indexKey(userSub))) || [];
  if (!Array.isArray(idx) || !idx.length) return [];
  // Resolve each id; drop any whose record is gone (KV TTL'd or deleted).
  const out = [];
  for (const id of idx) {
    const g = await kvGet(_goalKey(userSub, id));
    if (g && g.active !== false) out.push(g);
  }
  return out;
}

// Create or REPLACE a goal. If a goal with the same (type, category) exists,
// update it in place instead of creating a duplicate. This is the "replace by
// re-issuing the command" UX promised in the design doc.
export async function upsertGoal(userSub, { type, category, amountILS, block }) {
  if (!userSub) throw new Error('userSub required');
  if (type !== 'spend_cap' && type !== 'savings') {
    throw new Error('type must be spend_cap or savings');
  }
  if (type === 'spend_cap' && !category) {
    throw new Error('category required for spend_cap');
  }
  if (!isFinite(amountILS) || amountILS < 1) {
    throw new Error('amountILS must be a positive number');
  }

  const existing = await listGoals(userSub);
  const dupe = existing.find(
    (g) => g.type === type && (g.category || null) === (category || null)
  );
  const now = Date.now();
  let goal;
  if (dupe) {
    goal = {
      ...dupe,
      amountILS,
      block: block === true,
      updatedAt: now,
      active: true,
    };
  } else {
    goal = {
      id: newGoalId(),
      userSub,
      type,
      category: category || null,
      amountILS,
      period: 'monthly',
      createdAt: now,
      updatedAt: now,
      thresholds: [0.5, 0.8, 1.0],
      alertedAt: {},
      active: true,
      block: block === true,
    };
  }

  // Write the goal record first…
  const ok = await kvSet(_goalKey(userSub, goal.id), goal);
  if (!ok) throw new Error('kv_write_failed');

  // …then update the index (idempotent — only adds if missing).
  if (!dupe) {
    const idx = (await kvGet(_indexKey(userSub))) || [];
    if (!idx.includes(goal.id)) {
      idx.push(goal.id);
      await kvSet(_indexKey(userSub), idx);
    }
  }

  return { created: !dupe, goal };
}

// Soft delete: set active: false. Keeps the record for audit + so PR-2 alerts
// don't fire for stale categories the user removed.
export async function deleteGoalByCategory(userSub, category) {
  const goals = await listGoals(userSub);
  const target = goals.find(
    (g) => g.type === 'spend_cap' && (g.category || '').trim() === String(category || '').trim()
  );
  if (!target) return { deleted: false, reason: 'not_found' };
  target.active = false;
  target.updatedAt = Date.now();
  const ok = await kvSet(_goalKey(userSub, target.id), target);
  return { deleted: ok, goalId: target.id };
}

// Hard delete (admin tool / GDPR). NOT exposed via bot in PR-1.
export async function purgeGoals(userSub) {
  const idx = (await kvGet(_indexKey(userSub))) || [];
  for (const id of idx) {
    await kvDel(_goalKey(userSub, id));
  }
  await kvDel(_indexKey(userSub));
  return { purged: idx.length };
}

// ── formatters (Hebrew, for bot replies) ───────────────────────────────────

export function formatGoalsList(goals) {
  if (!goals || !goals.length) {
    return '🎯 אין יעדים פעילים.\n\nלהוסיף יעד:\n• "קבע יעד <קטגוריה> <סכום>" — למשל "קבע יעד אוכל 3000"\n• "קבע יעד <סכום>" — יעד חיסכון חודשי';
  }
  const lines = ['🎯 *היעדים שלך:*', ''];
  for (const g of goals) {
    const amt = '₪' + Number(g.amountILS).toLocaleString('he-IL');
    if (g.type === 'savings') {
      lines.push('💰 חיסכון חודשי — ' + amt);
    } else {
      lines.push('📊 ' + g.category + ' — ' + amt + '/חודש');
    }
  }
  lines.push('');
  lines.push('💡 למחוק: "מחק יעד <קטגוריה>"');
  return lines.join('\n');
}

export function formatGoalCreated(goal) {
  const amt = '₪' + Number(goal.amountILS).toLocaleString('he-IL');
  if (goal.type === 'savings') {
    return '✅ יעד חיסכון חודשי נקבע: ' + amt +
      '\n💡 שלח "סיכום" כדי לראות את ההתקדמות.';
  }
  return '✅ יעד נקבע: ' + goal.category + ' — ' + amt + '/חודש' +
    '\n💡 התראות יישלחו אוטומטית ב-50%, 80% ו-100% (נדלק ב-PR-2).';
}
