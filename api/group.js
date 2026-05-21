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

import crypto from 'node:crypto';
import { withRequestId, log } from '../lib/log.js';
import { withRateLimit } from '../lib/ratelimit.js';
import { decryptRefreshToken } from '../lib/crypto.js';
import { exchangeRefreshForAccess, appendRowToUserSheet, sanitizeCell, copyTemplateToUserDrive, appendRowToTab, GROUP_LEDGER_TAB } from '../lib/sheet-writer.js';

// Look up a user record by phone (resolved via the existing phone:E164
// → user mapping that the OAuth signup + WhatsApp link flow populates).
// Returns null if no user owns this phone.
async function findUserByPhone(phone) {
  const phoneRec = await kvGet('phone:' + phone);
  if (!phoneRec || !phoneRec.userSub) return null;
  const userRec = await kvGet('user:' + phoneRec.userSub);
  if (!userRec) return null;
  // Merge in sheet info if the caller hasn't already.
  if (!userRec.spreadsheetId && phoneRec.spreadsheetId) {
    userRec.spreadsheetId = phoneRec.spreadsheetId;
  }
  if (!userRec.userSub) userRec.userSub = phoneRec.userSub;
  return userRec;
}

// Best-effort write a group expense into the creator's Google Sheet.
// Non-fatal: if the creator hasn't signed up via OAuth (no refresh
// token) or the sheet write fails, the KV ledger is still authoritative
// and the bot keeps working.
async function writeGroupExpenseToSheet(group, expense, loggerName) {
  if (!group || !group.sheetId || !group.createdBy) return { ok: false, error: 'no_sheet' };
  const creator = await findUserByPhone(group.createdBy);
  if (!creator) return { ok: false, error: 'creator_not_oauth' };
  const refresh = creator.refreshTokenEnvelope ? null : creator.refreshToken;
  const envelope = creator.refreshTokenEnvelope;
  if (!refresh && !envelope) return { ok: false, error: 'no_refresh' };

  const shares = expense.shares || {};
  const participants = Object.keys(shares).join(', ');
  const sharesCsv = Object.entries(shares).map(([p, s]) => `${p}:${s}`).join(', ');
  // Columns: A timestamp | B amount | C category | D description |
  //           E paid-by name | F participants | G split type |
  //           H individual shares (CSV) | I logged-by name |
  //           J payer-phone | K group-code
  const row = [
    expense.timestamp || new Date().toISOString(),
    Number(expense.amount) || 0,
    sanitizeCell(expense.category || ''),
    sanitizeCell(expense.description || ''),
    sanitizeCell(loggerName || expense.payerPhone),
    sanitizeCell(participants),
    sanitizeCell(expense.splitMode || 'equal'),
    sanitizeCell(sharesCsv),
    sanitizeCell(loggerName || ''),
    sanitizeCell(expense.payerPhone || ''),
    sanitizeCell(group.code || ''),
  ];
  return appendRowToTab({
    refreshTokenEnvelope: envelope,
    refreshToken: refresh,
    userSub: creator.userSub,
    spreadsheetId: group.sheetId,
    tabName: GROUP_LEDGER_TAB,
    row,
  });
}

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
// Optional but recommended: the master template the bot copies on
// "כספלה צור". If unset, we skip sheet creation and the group lives
// in KV only (still functional, just no per-sheet audit trail).
const GROUP_SHEET_TEMPLATE_ID = process.env.GROUP_SHEET_TEMPLATE_ID;

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

// 8-character invite codes drawn from a CSPRNG. 31-char alphabet ^ 8 =
// ~8.5e11 — and crypto.randomInt means codes aren't predictable from
// Math.random's internal state. Reject-sampling avoids modulo bias.
const _CODE_ALPHABET_ = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 31 chars, no 0/O/1/I
function generateCode() {
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += _CODE_ALPHABET_[crypto.randomInt(_CODE_ALPHABET_.length)];
  }
  return s;
}

// Membership gate. Reads + writes on a group must prove the requester
// phone is a member (or the creator). The bot always knows the sender's
// phone, so it passes requesterPhone on every call. Returns the group
// if authorized, or null (caller responds 403). This is what turns a
// bot-secret leak from "impersonation" into "can't dump arbitrary
// groups" — the secret alone is no longer enough, you also need to be
// in the group you're asking about.
function isMemberOrCreator(group, requesterPhone) {
  if (!group || !requesterPhone) return false;
  if (group.createdBy === requesterPhone) return true;
  return (group.members || []).some(m => m.phone === requesterPhone);
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
        sheetId: null,
        sheetUrl: null,
      };
      // Best-effort provision a shared Google Sheet in the creator's
      // Drive — the principle of "user owns their data". Falls back
      // gracefully if the creator hasn't OAuth'd or the template ID
      // isn't configured; KV is still the source of truth for fast
      // reads, the sheet is the audit trail.
      if (GROUP_SHEET_TEMPLATE_ID) {
        try {
          const creator = await findUserByPhone(creatorPhone);
          if (creator && (creator.refreshToken || creator.refreshTokenEnvelope)) {
            const result = await copyTemplateToUserDrive({
              refreshTokenEnvelope: creator.refreshTokenEnvelope,
              refreshToken: creator.refreshToken,
              userSub: creator.userSub,
              templateId: GROUP_SHEET_TEMPLATE_ID,
              name: `כספ'לה — ${groupName} (${code})`,
            });
            group.sheetId = result.spreadsheetId;
            group.sheetUrl = result.spreadsheetUrl;
            log.info('group.sheet_created', { reqId: req.reqId, code, sheetId: result.spreadsheetId });
          } else {
            log.info('group.sheet_skipped_no_oauth', { reqId: req.reqId, code });
          }
        } catch (e) {
          // Don't fail the group creation just because the sheet copy
          // hit a quota or API hiccup — the KV ledger still works.
          log.warn('group.sheet_create_failed', { reqId: req.reqId, code, error: e.message });
        }
      }
      await kvSet('group:' + code, group);
      await kvSet('memberGroup:' + creatorPhone, { code, since: new Date().toISOString() });
      await addToPhoneGroups(creatorPhone, code);
      return res.status(200).json({ ok: true, code, group });
    }

    case 'join': {
      const phone = normalizeE164(body.phone);
      if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
      const code = String(body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6,8}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code' });
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      const name = String(body.name || phone).slice(0, 60);
      const exists = group.members.find(m => m.phone === phone);
      if (!exists) {
        group.members.push({ phone, name, joinedAt: new Date().toISOString() });
        await kvSet('group:' + code, group);
      }
      await kvSet('memberGroup:' + phone, { code, since: new Date().toISOString() });
      await addToPhoneGroups(phone, code);
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
      if (!/^[A-Z0-9]{6,8}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code' });
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
      if (!/^[A-Z0-9]{6,8}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code' });
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      // MEMBERSHIP GATE — only members/creator may read the full record
      // (which contains every member's phone number). Without this, any
      // code-holder could enumerate codes and harvest PII.
      const requesterPhone = normalizeE164(body.requesterPhone);
      if (!requesterPhone || !isMemberOrCreator(group, requesterPhone)) {
        log.warn('group.info.not_member', { reqId: req.reqId, code });
        return res.status(403).json({ ok: false, error: 'not_a_member' });
      }
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
      // MEMBERSHIP GATE — the requester (the person who sent the bot
      // command, == payer in the normal flow) must already be a member.
      // Removed the old "auto-add the payer" behaviour: it let any
      // code-holder inject expenses into a stranger's ledger AND write
      // attacker-controlled rows into the creator's Google Sheet. To log
      // an expense you must join first via "כספלה הצטרף <code>".
      const reqPhone = normalizeE164(body.requesterPhone) || payerPhone;
      if (!isMemberOrCreator(group, reqPhone)) {
        log.warn('group.addexpense.not_member', { reqId: req.reqId, code });
        return res.status(403).json({ ok: false, error: 'not_a_member' });
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
      if (group.expenses.length > 1000) group.expenses = group.expenses.slice(-1000);
      await kvSet('group:' + code, group);
      // Mirror to the creator's Google Sheet for data-ownership. KV
      // remains authoritative for fast reads; the sheet is the audit
      // log members can verify against. Best-effort — never blocks the
      // bot reply, just logs on failure.
      let sheetWriteOk = false;
      try {
        const w = await writeGroupExpenseToSheet(group, expense, String(body.payerName || ''));
        sheetWriteOk = !!(w && w.ok);
        if (!sheetWriteOk) {
          log.warn('group.sheet_mirror_failed', { reqId: req.reqId, code, error: w?.error });
        }
      } catch (e) {
        log.warn('group.sheet_mirror_threw', { reqId: req.reqId, code, error: e.message });
      }
      return res.status(200).json({ ok: true, expense, memberCount: group.members.length, sheetWriteOk });
    }

    case 'balances': {
      const code = String(body.code || '').trim().toUpperCase();
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      const balReqPhone = normalizeE164(body.requesterPhone);
      if (!balReqPhone || !isMemberOrCreator(group, balReqPhone)) {
        return res.status(403).json({ ok: false, error: 'not_a_member' });
      }
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
      const recReqPhone = normalizeE164(body.requesterPhone);
      if (!recReqPhone || !isMemberOrCreator(group, recReqPhone)) {
        return res.status(403).json({ ok: false, error: 'not_a_member' });
      }
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
      // Only an existing member/creator may add others — otherwise any
      // code-holder could stuff arbitrary phones into the group.
      const addReqPhone = normalizeE164(body.requesterPhone);
      if (!addReqPhone || !isMemberOrCreator(group, addReqPhone)) {
        return res.status(403).json({ ok: false, error: 'not_a_member' });
      }
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
      // Only the creator can remove others; anyone can remove themselves.
      const rmReqPhone = normalizeE164(body.requesterPhone);
      if (!rmReqPhone || (group.createdBy !== rmReqPhone && rmReqPhone !== phone)) {
        return res.status(403).json({ ok: false, error: 'only_creator_or_self' });
      }
      group.members = group.members.filter(m => m.phone !== phone);
      await kvSet('group:' + code, group);
      await kvDel('memberGroup:' + phone);
      return res.status(200).json({ ok: true, members: group.members.length });
    }

    case 'resync': {
      // Force a sheet provision for a group that was created before its
      // creator OAuth'd, or whose template wasn't configured at the time.
      const code = String(body.code || '').trim().toUpperCase();
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      if (group.sheetId) {
        return res.status(200).json({ ok: true, sheetUrl: group.sheetUrl, already: true });
      }
      if (!GROUP_SHEET_TEMPLATE_ID) return res.status(503).json({ ok: false, error: 'template_not_configured' });
      const creator = await findUserByPhone(group.createdBy);
      if (!creator || (!creator.refreshToken && !creator.refreshTokenEnvelope)) {
        return res.status(412).json({ ok: false, error: 'creator_not_oauth' });
      }
      try {
        const r = await copyTemplateToUserDrive({
          refreshTokenEnvelope: creator.refreshTokenEnvelope,
          refreshToken: creator.refreshToken,
          userSub: creator.userSub,
          templateId: GROUP_SHEET_TEMPLATE_ID,
          name: `כספ'לה — ${group.name} (${group.code})`,
        });
        group.sheetId = r.spreadsheetId;
        group.sheetUrl = r.spreadsheetUrl;
        // Backfill: replay every expense into the brand-new sheet so the
        // sheet matches the KV ledger exactly. Sequential to keep order.
        let mirrored = 0;
        for (const exp of (group.expenses || [])) {
          const w = await writeGroupExpenseToSheet(group, exp, '');
          if (w && w.ok) mirrored++;
        }
        await kvSet('group:' + code, group);
        return res.status(200).json({ ok: true, sheetUrl: group.sheetUrl, mirrored });
      } catch (e) {
        log.error('group.resync_failed', { reqId: req.reqId, code, error: e.message });
        return res.status(502).json({ ok: false, error: 'resync_failed', detail: e.message });
      }
    }

    case 'mygroups': {
      // List all groups a user is a member of. Used by "כספלה הקשר"
      // to show "you're in group X (active) and groups Y, Z."
      const phone = normalizeE164(body.phone);
      if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
      // Linear scan over all `group:*` keys is fine at our scale. If
      // groups grow into the thousands, add a `phoneGroups:<phone>` index.
      const idxKey = 'phoneGroups:' + phone;
      const idx = await kvGet(idxKey);
      const codes = Array.isArray(idx) ? idx : [];
      const groups = [];
      for (const c of codes) {
        const g = await kvGet('group:' + c);
        if (g) groups.push({ code: g.code, name: g.name, memberCount: g.members.length, expenseCount: (g.expenses || []).length });
      }
      const active = await kvGet('memberGroup:' + phone);
      return res.status(200).json({ ok: true, active: active?.code || null, groups });
    }

    case 'addrecurring': {
      // Recurring expense templates (rent, utilities). Stored on the
      // group record; a cron in Apps Script triggers them.
      const code = String(body.code || '').trim().toUpperCase();
      const payerPhone = normalizeE164(body.payerPhone);
      const amount = Number(body.amount);
      const intervalRaw = String(body.interval || 'monthly').toLowerCase();
      const allowed = { monthly: 30, weekly: 7, biweekly: 14, daily: 1 };
      const intervalDays = allowed[intervalRaw];
      if (!code || !payerPhone || !isFinite(amount) || amount <= 0 || !intervalDays) {
        return res.status(400).json({ ok: false, error: 'invalid_args' });
      }
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      group.recurring = group.recurring || [];
      group.recurring.push({
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        payerPhone,
        amount: Math.round(amount * 100) / 100,
        description: String(body.description || '').slice(0, 200),
        intervalDays,
        intervalLabel: intervalRaw,
        createdAt: new Date().toISOString(),
        lastFiredAt: null,
        active: true,
      });
      await kvSet('group:' + code, group);
      return res.status(200).json({ ok: true, recurring: group.recurring });
    }

    case 'listrecurring': {
      const code = String(body.code || '').trim().toUpperCase();
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      return res.status(200).json({ ok: true, recurring: group.recurring || [] });
    }

    case 'markrecurringfired': {
      // Persist lastFiredAt after the cron fires a recurring expense.
      // Without this, the bot's cron re-fired the same recurring item
      // every single day (the lastFiredAt write was a local-only no-op).
      // Cron-secret gated since it's a cron-only mutation.
      const cronSecret = process.env.KESEFLE_CRON_SECRET;
      if (!cronSecret) return res.status(503).json({ ok: false, error: 'cron_secret_not_configured' });
      const gotCron = req.headers['x-kesefle-cron-secret'] || body?.cronSecret;
      if (gotCron !== cronSecret) return res.status(401).json({ ok: false, error: 'cron_unauthorized' });
      const code = String(body.code || '').trim().toUpperCase();
      const recurringId = String(body.recurringId || '');
      const group = await kvGet('group:' + code);
      if (!group || !group.recurring) return res.status(404).json({ ok: false, error: 'group_or_recurring_not_found' });
      const rec = group.recurring.find(r => r.id === recurringId);
      if (!rec) return res.status(404).json({ ok: false, error: 'recurring_not_found' });
      rec.lastFiredAt = new Date().toISOString();
      await kvSet('group:' + code, group);
      return res.status(200).json({ ok: true, lastFiredAt: rec.lastFiredAt });
    }

    default:
      return res.status(400).json({ ok: false, error: 'unknown_action', got: action });
  }
}

// When a user joins a group we ALSO keep a phoneGroups:<phone> index of
// every group they're in. The mygroups action above relies on it. Done
// here as a separate helper so the existing join/create paths can call
// it without growing too much.
async function addToPhoneGroups(phone, code) {
  try {
    const existing = await kvGet('phoneGroups:' + phone);
    const list = Array.isArray(existing) ? existing : [];
    if (!list.includes(code)) {
      list.push(code);
      await kvSet('phoneGroups:' + phone, list);
    }
  } catch (e) {
    log.warn('phoneGroups.write_failed', { phone, code, error: e.message });
  }
}

// 60 calls/minute per phone is well above what any human group chat
// will produce, and per-IP keys cleanly prevent a single attacker from
// hammering us with bogus codes hoping to guess one.
export default withRequestId(
  withRateLimit({ key: 'group_ops', limit: 60, windowSec: 60 })(handlerImpl)
);
