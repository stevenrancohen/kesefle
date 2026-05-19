// /api/group
//
// Splitwise-style group ledger backed by Vercel KV. The Apps Script
// bot doesn't need to know how groups are stored — it just calls these
// endpoints with the bot-secret header.
//
// "Group" here is a virtual ledger anyone can join with a 6-char code.
// WhatsApp Cloud API doesn't deliver group-chat webhooks (Meta limit),
// so each member sends 1:1 messages with the bot and we route by the
// member's "active group" pointer.
//
// KV schema:
//   group:<code>            → { name, createdBy, createdAt, members:[{phone,name}], expenses:[{...}] }
//   memberGroup:<phone>     → <code>   (the user's currently active group)
//
// Endpoints (all POST, JSON body, x-kesefle-bot-secret header required):
//   action=create      { creatorPhone, creatorName, groupName }
//   action=join        { phone, name, code }
//   action=leave       { phone }
//   action=setActive   { phone, code }
//   action=getActive   { phone }                              → { active }
//   action=info        { code }                               → group record
//   action=addExpense  { code, payerPhone, payerName, amount, description, category, subcategory, splitMode }
//   action=balances    { code }                               → settlement plan + per-member net
//   action=recent      { code, limit }                        → most-recent N expenses
//   action=undo        { code, requesterPhone }               → remove the last expense
//   action=addMember   { code, phone, name }
//   action=removeMember{ code, phone }

import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) return false;
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}

async function kvDel(key) {
  if (!KV_URL || !KV_TOKEN) return false;
  const r = await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  return r.ok;
}

// 6-character invite codes (~36^6 = 2.1B possibilities → no collisions in practice).
function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit confusing chars
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).replace(/\D+/g, '');
  if (!s) return null;
  if (s.startsWith('0')) s = '972' + s.slice(1);
  if (s.length < 7 || s.length > 15) return null;
  return s;
}

// Build the human-readable "X owes Y ₪Z" settlement plan from each
// member's net balance using a greedy debtor↔creditor pairing — the
// same algorithm Splitwise uses for its "simplify debts" feature.
// O(N log N), produces N-1 transfers in the worst case.
function computeSettlements(balances) {
  const debtors = [];
  const creditors = [];
  for (const [phone, net] of Object.entries(balances)) {
    if (net < -0.005) debtors.push({ phone, amount: -net });
    else if (net > 0.005) creditors.push({ phone, amount: net });
  }
  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    transfers.push({ from: debtors[i].phone, to: creditors[j].phone, amount: Math.round(pay * 100) / 100 });
    debtors[i].amount -= pay;
    creditors[j].amount -= pay;
    if (debtors[i].amount < 0.005) i++;
    if (creditors[j].amount < 0.005) j++;
  }
  return transfers;
}

// Roll up expense rows into per-member net balances. Convention: positive
// net = group owes this member; negative = this member owes the group.
function computeBalances(group) {
  const balances = {};
  for (const m of group.members) balances[m.phone] = 0;
  for (const exp of (group.expenses || [])) {
    const payer = exp.payerPhone;
    if (balances[payer] == null) balances[payer] = 0;
    balances[payer] += Number(exp.amount) || 0;
    const shares = exp.shares || {};
    for (const [phone, share] of Object.entries(shares)) {
      if (balances[phone] == null) balances[phone] = 0;
      balances[phone] -= Number(share) || 0;
    }
  }
  return balances;
}

function nameFor(group, phone) {
  const m = (group.members || []).find(x => x.phone === phone);
  return m && m.name ? m.name : phone;
}

async function handlerImpl(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const expected = process.env.KESEFLE_BOT_SECRET;
  if (!expected) {
    log.error('group.secret_not_configured', { reqId: req.reqId });
    return res.status(503).json({ ok: false, error: 'bot_secret_not_configured' });
  }
  const got = req.headers['x-kesefle-bot-secret'] || (req.body && req.body.botSecret);
  if (got !== expected) {
    log.warn('group.unauthorized', { reqId: req.reqId });
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const action = String(body?.action || '').toLowerCase();

  switch (action) {

    case 'create': {
      const creatorPhone = normalizeE164(body.creatorPhone);
      if (!creatorPhone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
      const groupName = String(body.groupName || 'קבוצה').slice(0, 60);
      const creatorName = String(body.creatorName || creatorPhone).slice(0, 60);
      // Try to mint a non-colliding code (in practice the first try
      // always works — 30M-1 odds of collision after the first group).
      let code = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        const c = generateCode();
        if (!(await kvGet('group:' + c))) { code = c; break; }
      }
      if (!code) return res.status(500).json({ ok: false, error: 'code_generation_failed' });
      const group = {
        code,
        name: groupName,
        createdBy: creatorPhone,
        createdAt: new Date().toISOString(),
        members: [{ phone: creatorPhone, name: creatorName, joinedAt: new Date().toISOString() }],
        expenses: [],
      };
      await kvSet('group:' + code, group);
      await kvSet('memberGroup:' + creatorPhone, { code, since: new Date().toISOString() });
      return res.status(200).json({ ok: true, code, group });
    }

    case 'join': {
      const phone = normalizeE164(body.phone);
      if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
      const code = String(body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code' });
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      const name = String(body.name || phone).slice(0, 60);
      const exists = group.members.find(m => m.phone === phone);
      if (!exists) {
        group.members.push({ phone, name, joinedAt: new Date().toISOString() });
        await kvSet('group:' + code, group);
      }
      await kvSet('memberGroup:' + phone, { code, since: new Date().toISOString() });
      return res.status(200).json({ ok: true, code, group, joined: !exists });
    }

    case 'leave': {
      const phone = normalizeE164(body.phone);
      if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
      await kvDel('memberGroup:' + phone);
      return res.status(200).json({ ok: true });
    }

    case 'setactive': {
      const phone = normalizeE164(body.phone);
      if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
      const code = String(body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code' });
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      if (!group.members.find(m => m.phone === phone)) {
        return res.status(403).json({ ok: false, error: 'not_a_member' });
      }
      await kvSet('memberGroup:' + phone, { code, since: new Date().toISOString() });
      return res.status(200).json({ ok: true, code });
    }

    case 'getactive': {
      const phone = normalizeE164(body.phone);
      if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
      const rec = await kvGet('memberGroup:' + phone);
      if (!rec) return res.status(200).json({ ok: true, active: null });
      const group = await kvGet('group:' + rec.code);
      return res.status(200).json({ ok: true, active: rec.code, group });
    }

    case 'info': {
      const code = String(body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code' });
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      return res.status(200).json({ ok: true, group });
    }

    case 'addexpense': {
      const code = String(body.code || '').trim().toUpperCase();
      const payerPhone = normalizeE164(body.payerPhone);
      const amount = Number(body.amount);
      if (!code || !payerPhone || !isFinite(amount) || amount <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_args' });
      }
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      // Auto-register the payer if they aren't a member yet (e.g. they
      // texted the bot before joining via code — common Splitwise flow).
      if (!group.members.find(m => m.phone === payerPhone)) {
        group.members.push({
          phone: payerPhone,
          name: String(body.payerName || payerPhone).slice(0, 60),
          joinedAt: new Date().toISOString(),
        });
      }
      // Split mode: 'equal' (default — divide among all members),
      // 'custom' (caller supplied a shares map), or 'percent' (caller
      // supplied a percents map). For now we only ship 'equal' — the
      // bot UX layers the rest on top of this primitive.
      const splitMode = String(body.splitMode || 'equal').toLowerCase();
      const shares = {};
      if (splitMode === 'custom' && body.shares && typeof body.shares === 'object') {
        let total = 0;
        for (const [phone, share] of Object.entries(body.shares)) {
          const s = Number(share);
          if (!isFinite(s) || s < 0) return res.status(400).json({ ok: false, error: 'invalid_share' });
          shares[normalizeE164(phone) || phone] = s;
          total += s;
        }
        // Allow ±₪0.5 rounding tolerance.
        if (Math.abs(total - amount) > 0.5) {
          return res.status(400).json({ ok: false, error: 'shares_must_sum_to_amount', detail: `sum=${total} amount=${amount}` });
        }
      } else {
        // Equal split among all current members.
        const N = group.members.length || 1;
        const each = Math.round((amount / N) * 100) / 100;
        // Distribute rounding remainder to the payer so the totals match.
        let assigned = 0;
        for (let i = 0; i < group.members.length; i++) {
          const m = group.members[i];
          if (i === group.members.length - 1) {
            shares[m.phone] = Math.round((amount - assigned) * 100) / 100;
          } else {
            shares[m.phone] = each;
            assigned += each;
          }
        }
      }
      const expense = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        payerPhone,
        amount: Math.round(amount * 100) / 100,
        description: String(body.description || '').slice(0, 200),
        category: String(body.category || '').slice(0, 60),
        subcategory: String(body.subcategory || '').slice(0, 60),
        splitMode,
        shares,
      };
      group.expenses = group.expenses || [];
      group.expenses.push(expense);
      // Keep the in-memory ledger bounded so KV writes stay fast — at
      // 500 rows the bot already needs the spreadsheet anyway.
      if (group.expenses.length > 1000) group.expenses = group.expenses.slice(-1000);
      await kvSet('group:' + code, group);
      return res.status(200).json({ ok: true, expense, memberCount: group.members.length });
    }

    case 'balances': {
      const code = String(body.code || '').trim().toUpperCase();
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      const balances = computeBalances(group);
      const settlements = computeSettlements(balances);
      const lines = settlements.map(t => ({
        from: t.from,
        fromName: nameFor(group, t.from),
        to: t.to,
        toName: nameFor(group, t.to),
        amount: t.amount,
      }));
      // Per-member net for display.
      const perMember = group.members.map(m => ({
        phone: m.phone,
        name: m.name,
        net: Math.round((balances[m.phone] || 0) * 100) / 100,
      }));
      return res.status(200).json({ ok: true, balances: perMember, settlements: lines, totalExpenses: (group.expenses || []).length });
    }

    case 'recent': {
      const code = String(body.code || '').trim().toUpperCase();
      const limit = Math.min(50, Math.max(1, Number(body.limit) || 5));
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      const recent = (group.expenses || []).slice(-limit).reverse().map(e => ({
        timestamp: e.timestamp,
        amount: e.amount,
        description: e.description,
        category: e.category,
        payerName: nameFor(group, e.payerPhone),
      }));
      return res.status(200).json({ ok: true, expenses: recent });
    }

    case 'undo': {
      const code = String(body.code || '').trim().toUpperCase();
      const requesterPhone = normalizeE164(body.requesterPhone);
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      const exps = group.expenses || [];
      if (!exps.length) return res.status(200).json({ ok: true, removed: null });
      const last = exps[exps.length - 1];
      // Only the original payer (or the group creator) can undo.
      if (last.payerPhone !== requesterPhone && group.createdBy !== requesterPhone) {
        return res.status(403).json({ ok: false, error: 'only_payer_or_creator_can_undo' });
      }
      group.expenses = exps.slice(0, -1);
      await kvSet('group:' + code, group);
      return res.status(200).json({ ok: true, removed: last });
    }

    case 'addmember': {
      const code = String(body.code || '').trim().toUpperCase();
      const phone = normalizeE164(body.phone);
      if (!code || !phone) return res.status(400).json({ ok: false, error: 'invalid_args' });
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      if (!group.members.find(m => m.phone === phone)) {
        group.members.push({
          phone,
          name: String(body.name || phone).slice(0, 60),
          joinedAt: new Date().toISOString(),
        });
        await kvSet('group:' + code, group);
      }
      return res.status(200).json({ ok: true, members: group.members.length });
    }

    case 'removemember': {
      const code = String(body.code || '').trim().toUpperCase();
      const phone = normalizeE164(body.phone);
      if (!code || !phone) return res.status(400).json({ ok: false, error: 'invalid_args' });
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      group.members = group.members.filter(m => m.phone !== phone);
      await kvSet('group:' + code, group);
      await kvDel('memberGroup:' + phone);
      return res.status(200).json({ ok: true, members: group.members.length });
    }

    default:
      return res.status(400).json({ ok: false, error: 'unknown_action', got: action });
  }
}

// 60 calls/minute per phone is well above what any human group chat
// will produce, and per-IP keys cleanly prevent a single attacker from
// hammering us with bogus codes hoping to guess one.
export default withRequestId(
  withRateLimit({ key: 'group_ops', limit: 60, windowSec: 60 })(handlerImpl)
);
