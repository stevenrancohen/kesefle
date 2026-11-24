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
import { exchangeRefreshForAccess, appendRowToUserSheet, sanitizeCell, createUserSheetWithRefresh, appendRowToTab, GROUP_LEDGER_TAB } from '../lib/sheet-writer.js';

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
  //           J payer-phone | K group-code | L stable expense id
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
    sanitizeCell(expense.id || ''),
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

// Reconciliation helper used only by resync. Every mirrored row carries its
// stable expense id in column L, so a retry after a serverless crash can read
// the ids already present and append only the missing snapshot rows.
async function readGroupExpenseIds(group) {
  if (!group?.sheetId || !group?.createdBy) return { ok: false, error: 'no_sheet' };
  const creator = await findUserByPhone(group.createdBy);
  if (!creator) return { ok: false, error: 'creator_not_oauth' };
  let refresh = creator.refreshToken;
  if (!refresh && creator.refreshTokenEnvelope) {
    try { refresh = decryptRefreshToken(creator.refreshTokenEnvelope, creator.userSub); }
    catch { return { ok: false, error: 'refresh_decrypt_failed' }; }
  }
  if (!refresh) return { ok: false, error: 'no_refresh' };
  let accessToken;
  try { accessToken = await exchangeRefreshForAccess(refresh, creator.userSub); }
  catch { return { ok: false, error: 'token_refresh_failed' }; }
  const range = encodeURIComponent(`'${GROUP_LEDGER_TAB}'!L:L`);
  let response;
  try {
    response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(group.sheetId)}/values/${range}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
  } catch {
    return { ok: false, error: 'sheets_unreachable' };
  }
  if (response.status === 400) {
    const text = await response.text().catch(() => '');
    if (/Unable to parse range|not found/i.test(text)) return { ok: true, ids: new Set() };
  }
  if (!response.ok) return { ok: false, error: 'sheets_read_status_' + response.status };
  const body = await response.json().catch(() => ({}));
  const ids = new Set();
  for (const row of (Array.isArray(body.values) ? body.values : [])) {
    const id = String(Array.isArray(row) ? (row[0] || '') : '').trim();
    if (id) ids.add(id);
  }
  return { ok: true, ids };
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
  const value = j?.result ? JSON.parse(j.result) : null;
  return String(key).startsWith('group:') ? normalizeGroupArrays(value) : value;
}

// Lua cjson can serialize an empty numeric table as `{}` after removing the
// final array item. Normalize those known array fields at the API boundary so
// readers and clients always keep the group schema (`[]`) intact.
function normalizeGroupArrays(group) {
  if (!group || typeof group !== 'object') return group;
  for (const field of ['members', 'expenses', 'recurring']) {
    const value = group[field];
    if (value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length === 0) {
      group[field] = [];
    }
  }
  return group;
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

// A group is stored as one JSON document. Appending an expense with a
// GET -> mutate -> SET sequence loses data when two members write at the same
// time: both requests read the same document and the last SET overwrites the
// other expense. Keep the read, membership check, split calculation,
// idempotency check and write inside one Redis script so Upstash serializes
// concurrent writers on this group key.
const APPEND_GROUP_EXPENSE_LUA = `#!lua flags=allow-key-locking
local raw = redis.call('GET', KEYS[1])
if not raw then
  return cjson.encode({ status = 'group_missing' })
end

local decoded, group = pcall(cjson.decode, raw)
if not decoded or type(group) ~= 'table' or type(group.members) ~= 'table' then
  return cjson.encode({ status = 'invalid_group' })
end

local requester = ARGV[1]
local authorized = tostring(group.createdBy or '') == requester
if not authorized then
  for _, member in ipairs(group.members) do
    if tostring(member.phone or '') == requester then
      authorized = true
      break
    end
  end
end
if not authorized then
  return cjson.encode({ status = 'not_member' })
end

local expenseOk, expense = pcall(cjson.decode, ARGV[2])
if not expenseOk or type(expense) ~= 'table' then
  return cjson.encode({ status = 'invalid_expense' })
end

if type(group.expenses) ~= 'table' then group.expenses = {} end
for _, existing in ipairs(group.expenses) do
  if tostring(existing.id or '') == tostring(expense.id or '') then
    return cjson.encode({
      status = 'replayed',
      expense = existing,
      memberCount = #group.members,
      mirror = { code = ARGV[3], sheetId = group.sheetId, createdBy = group.createdBy }
    })
  end
end

if expense._customSplit ~= true then
  local count = #group.members
  if count < 1 then
    return cjson.encode({ status = 'invalid_group' })
  end
  local amount = tonumber(expense.amount)
  if not amount or amount <= 0 then
    return cjson.encode({ status = 'invalid_expense' })
  end
  local each = math.floor(((amount / count) * 100) + 0.5) / 100
  local assigned = 0
  local shares = {}
  for index, member in ipairs(group.members) do
    if index == count then
      shares[tostring(member.phone)] = math.floor(((amount - assigned) * 100) + 0.5) / 100
    else
      shares[tostring(member.phone)] = each
      assigned = assigned + each
    end
  end
  expense.shares = shares
end
expense._customSplit = nil

table.insert(group.expenses, expense)
while #group.expenses > 1000 do table.remove(group.expenses, 1) end
redis.call('SET', KEYS[1], cjson.encode(group))

return cjson.encode({
  status = 'committed',
  expense = expense,
  memberCount = #group.members,
  mirror = { code = ARGV[3], sheetId = group.sheetId, createdBy = group.createdBy }
})`;

// Every other writer of group:<code> must share the same Redis key lock as
// addexpense. Otherwise an addmember/undo/recurring request can still read an
// old document and overwrite an expense that the atomic append just committed.
// The operation dispatcher keeps each transition small while guaranteeing that
// authorization checks and writes observe the latest group document.
const MUTATE_GROUP_LUA = `#!lua flags=allow-key-locking
local raw = redis.call('GET', KEYS[1])
if not raw then return cjson.encode({ status = 'group_missing' }) end

local decoded, group = pcall(cjson.decode, raw)
if not decoded or type(group) ~= 'table' or type(group.members) ~= 'table' then
  return cjson.encode({ status = 'invalid_group' })
end
local payloadOk, payload = pcall(cjson.decode, ARGV[2])
if not payloadOk or type(payload) ~= 'table' then
  return cjson.encode({ status = 'invalid_payload' })
end
local operation = ARGV[1]
local mutationId = tostring(payload.mutationId or '')
if type(group.mutationReceipts) ~= 'table' then group.mutationReceipts = {} end

if mutationId ~= '' then
  for _, receipt in ipairs(group.mutationReceipts) do
    if tostring(receipt.id or '') == mutationId and tostring(receipt.operation or '') == operation then
      if operation == 'undo' then
        if receipt.outcome == 'noop' then
          return cjson.encode({ status = 'noop', replayed = true })
        end
        return cjson.encode({ status = 'committed', removed = receipt.removed, replayed = true })
      end
      if operation == 'addrecurring' then
        return cjson.encode({ status = 'committed', recurring = group.recurring or {}, replayed = true })
      end
    end
  end
end

local function remember(receipt)
  if mutationId == '' then return end
  receipt.id = mutationId
  receipt.operation = operation
  table.insert(group.mutationReceipts, receipt)
  while #group.mutationReceipts > 100 do table.remove(group.mutationReceipts, 1) end
end

local function isMemberOrCreator(phone)
  if not phone or phone == '' then return false end
  if tostring(group.createdBy or '') == tostring(phone) then return true end
  for _, member in ipairs(group.members) do
    if tostring(member.phone or '') == tostring(phone) then return true end
  end
  return false
end

if operation == 'join' then
  local exists = false
  for _, member in ipairs(group.members) do
    if tostring(member.phone or '') == tostring(payload.member.phone or '') then
      exists = true
      break
    end
  end
  if not exists then table.insert(group.members, payload.member) end
  redis.call('SET', KEYS[1], cjson.encode(group))
  return cjson.encode({ status = 'committed', joined = not exists, group = group })
end

if operation == 'undo' then
  if type(group.expenses) ~= 'table' or #group.expenses == 0 then
    remember({ outcome = 'noop' })
    redis.call('SET', KEYS[1], cjson.encode(group))
    return cjson.encode({ status = 'noop' })
  end
  local last = group.expenses[#group.expenses]
  if tostring(last.payerPhone or '') ~= tostring(payload.requesterPhone or '')
      and tostring(group.createdBy or '') ~= tostring(payload.requesterPhone or '') then
    return cjson.encode({ status = 'forbidden_undo' })
  end
  table.remove(group.expenses, #group.expenses)
  remember({ removed = last })
  redis.call('SET', KEYS[1], cjson.encode(group))
  return cjson.encode({ status = 'committed', removed = last })
end

if operation == 'addmember' then
  if not isMemberOrCreator(payload.requesterPhone) then
    return cjson.encode({ status = 'not_member' })
  end
  local exists = false
  for _, member in ipairs(group.members) do
    if tostring(member.phone or '') == tostring(payload.member.phone or '') then
      exists = true
      break
    end
  end
  if not exists then table.insert(group.members, payload.member) end
  redis.call('SET', KEYS[1], cjson.encode(group))
  return cjson.encode({ status = 'committed', members = #group.members, added = not exists })
end

if operation == 'removemember' then
  local requester = tostring(payload.requesterPhone or '')
  local target = tostring(payload.phone or '')
  if requester == '' or (tostring(group.createdBy or '') ~= requester and requester ~= target) then
    return cjson.encode({ status = 'forbidden_remove' })
  end
  local kept = {}
  for _, member in ipairs(group.members) do
    if tostring(member.phone or '') ~= target then table.insert(kept, member) end
  end
  group.members = kept
  redis.call('SET', KEYS[1], cjson.encode(group))
  return cjson.encode({ status = 'committed', members = #group.members })
end

if operation == 'addrecurring' then
  if not isMemberOrCreator(payload.requesterPhone) then
    return cjson.encode({ status = 'not_member' })
  end
  if type(group.recurring) ~= 'table' then group.recurring = {} end
  table.insert(group.recurring, payload.recurring)
  remember({ recurringId = payload.recurring.id })
  redis.call('SET', KEYS[1], cjson.encode(group))
  return cjson.encode({ status = 'committed', recurring = group.recurring })
end

if operation == 'markrecurringfired' then
  if type(group.recurring) ~= 'table' then
    return cjson.encode({ status = 'group_or_recurring_missing' })
  end
  for _, recurring in ipairs(group.recurring) do
    if tostring(recurring.id or '') == tostring(payload.recurringId or '') then
      recurring.lastFiredAt = payload.lastFiredAt
      redis.call('SET', KEYS[1], cjson.encode(group))
      return cjson.encode({ status = 'committed', lastFiredAt = recurring.lastFiredAt })
    end
  end
  return cjson.encode({ status = 'recurring_missing' })
end

if operation == 'resyncmeta' then
  if group.sheetId then
    if type(group.sheetBackfillPending) == 'table' then
      local nowMs = tonumber(payload.nowMs) or 0
      local leaseUntil = tonumber(payload.leaseUntil) or 0
      if type(group.sheetBackfillLease) == 'table'
          and tostring(group.sheetBackfillLease.owner or '') ~= tostring(payload.workerId or '')
          and (tonumber(group.sheetBackfillLease.expiresAt) or 0) > nowMs then
        return cjson.encode({
          status = 'busy',
          leaseExpiresAt = group.sheetBackfillLease.expiresAt,
          sheetUrl = group.sheetUrl
        })
      end
      group.sheetBackfillLease = { owner = payload.workerId, expiresAt = leaseUntil }
      local wanted = {}
      for _, id in ipairs(group.sheetBackfillPending) do wanted[tostring(id)] = true end
      local pendingExpenses = {}
      if type(group.expenses) == 'table' then
        for _, expense in ipairs(group.expenses) do
          if wanted[tostring(expense.id or '')] then table.insert(pendingExpenses, expense) end
        end
      end
      redis.call('SET', KEYS[1], cjson.encode(group))
      return cjson.encode({
        status = 'resume',
        sheetUrl = group.sheetUrl,
        sheetId = group.sheetId,
        code = group.code,
        createdBy = group.createdBy,
        expenses = pendingExpenses
      })
    end
    return cjson.encode({ status = 'already', sheetUrl = group.sheetUrl })
  end
  group.sheetId = payload.sheetId
  group.sheetUrl = payload.sheetUrl
  local pending = {}
  if type(group.expenses) == 'table' then
    for _, expense in ipairs(group.expenses) do
      if expense.id then table.insert(pending, expense.id) end
    end
  end
  group.sheetBackfillPending = pending
  group.sheetBackfillLease = { owner = payload.workerId, expiresAt = payload.leaseUntil }
  redis.call('SET', KEYS[1], cjson.encode(group))
  return cjson.encode({
    status = 'committed',
    sheetUrl = group.sheetUrl,
    sheetId = group.sheetId,
    code = group.code,
    createdBy = group.createdBy,
    expenses = group.expenses or {}
  })
end

if operation == 'resynccomplete' then
  if tostring(group.sheetId or '') ~= tostring(payload.sheetId or '') then
    return cjson.encode({ status = 'sheet_changed' })
  end
  if type(group.sheetBackfillLease) ~= 'table'
      or tostring(group.sheetBackfillLease.owner or '') ~= tostring(payload.workerId or '') then
    return cjson.encode({ status = 'lease_mismatch' })
  end
  group.sheetBackfillPending = nil
  group.sheetBackfillLease = nil
  redis.call('SET', KEYS[1], cjson.encode(group))
  return cjson.encode({ status = 'committed' })
end

if operation == 'resyncrelease' then
  if type(group.sheetBackfillPending) ~= 'table' then
    return cjson.encode({ status = 'no_pending' })
  end
  if type(group.sheetBackfillLease) ~= 'table'
      or tostring(group.sheetBackfillLease.owner or '') ~= tostring(payload.workerId or '') then
    return cjson.encode({ status = 'lease_mismatch' })
  end
  group.sheetBackfillLease = nil
  redis.call('SET', KEYS[1], cjson.encode(group))
  return cjson.encode({ status = 'committed' })
end

return cjson.encode({ status = 'unknown_operation' })`;

function groupExpenseId(rawToken) {
  const token = String(rawToken || '').trim().slice(0, 300);
  if (token) {
    return 'gx_' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
  }
  return 'gx_' + crypto.randomBytes(16).toString('hex');
}

function groupMutationId(operation, rawToken) {
  const token = String(rawToken || '').trim().slice(0, 300);
  if (!token) return '';
  return 'gm_' + crypto.createHash('sha256')
    .update(String(operation) + '\0' + token)
    .digest('hex')
    .slice(0, 32);
}

async function evalGroupScript(code, script, args) {
  if (!KV_URL || !KV_TOKEN) return { status: 'unavailable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        'EVAL', script, '1', 'group:' + code, ...args,
      ]),
      signal: controller.signal,
    });
    if (!r.ok) return { status: 'unavailable' };
    const payload = await r.json();
    if (payload?.error || typeof payload?.result !== 'string') {
      return { status: 'unavailable' };
    }
    const result = JSON.parse(payload.result);
    if (result?.group) result.group = normalizeGroupArrays(result.group);
    return result && typeof result.status === 'string' ? result : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

async function appendGroupExpenseAtomic({ code, requesterPhone, expense }) {
  return evalGroupScript(code, APPEND_GROUP_EXPENSE_LUA, [
    requesterPhone, JSON.stringify(expense), code,
  ]);
}

async function mutateGroupAtomic(code, operation, payload) {
  return evalGroupScript(code, MUTATE_GROUP_LUA, [operation, JSON.stringify(payload)]);
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
  const { constantTimeEqual } = await import('../lib/crypto.js');
  if (!got || !constantTimeEqual(String(got), expected)) {
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
      {
        try {
          const creator = await findUserByPhone(creatorPhone);
          if (creator && (creator.refreshToken || creator.refreshTokenEnvelope)) {
            const result = await createUserSheetWithRefresh({
              refreshTokenEnvelope: creator.refreshTokenEnvelope,
              refreshToken: creator.refreshToken,
              userSub: creator.userSub,
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
      const _created = await kvSet('group:' + code, group);
      if (!_created) return res.status(502).json({ ok: false, error: 'group_persist_failed' });
      await kvSet('memberGroup:' + creatorPhone, { code, since: new Date().toISOString() });
      await addToPhoneGroups(creatorPhone, code);
      return res.status(200).json({ ok: true, code, group });
    }

    case 'join': {
      const phone = normalizeE164(body.phone);
      if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
      const code = String(body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6,8}$/.test(code)) return res.status(400).json({ ok: false, error: 'invalid_code' });
      const name = String(body.name || phone).slice(0, 60);
      const joinedAt = new Date().toISOString();
      const mutation = await mutateGroupAtomic(code, 'join', {
        member: { phone, name, joinedAt },
      });
      if (mutation.status === 'group_missing') {
        return res.status(404).json({ ok: false, error: 'group_not_found' });
      }
      if (mutation.status !== 'committed') {
        return res.status(503).json({ ok: false, error: 'group_persist_unavailable' });
      }
      await kvSet('memberGroup:' + phone, { code, since: new Date().toISOString() });
      await addToPhoneGroups(phone, code);
      return res.status(200).json({ ok: true, code, group: mutation.group, joined: mutation.joined });
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
      const _setActive = await kvSet('memberGroup:' + phone, { code, since: new Date().toISOString() });
      if (!_setActive) return res.status(502).json({ ok: false, error: 'active_persist_failed' });
      return res.status(200).json({ ok: true, code });
    }

    case 'getactive': {
      const phone = normalizeE164(body.phone);
      if (!phone) return res.status(400).json({ ok: false, error: 'invalid_phone' });
      const rec = await kvGet('memberGroup:' + phone);
      if (!rec) return res.status(200).json({ ok: true, active: null });
      const group = await kvGet('group:' + rec.code);
      // The pointer is only an index; membership in the authoritative group
      // record decides access. This fails closed after a lost-response member
      // removal or a remove-vs-setactive race instead of returning group PII.
      if (!group || !isMemberOrCreator(group, phone)) {
        await kvDel('memberGroup:' + phone);
        return res.status(200).json({ ok: true, active: null });
      }
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
      if (!/^[A-Z0-9]{6,8}$/.test(code) || !payerPhone || !isFinite(amount) || amount <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_args' });
      }
      const reqPhone = normalizeE164(body.requesterPhone) || payerPhone;
      // Split mode: 'equal' (default — divide among all members),
      // 'custom' (caller supplied a shares map), or 'percent' (caller
      // supplied a percents map). For now we only ship 'equal' — the
      // bot UX layers the rest on top of this primitive. Equal shares are
      // deliberately calculated inside the atomic script from the latest
      // member list, not from a stale pre-write read.
      const splitMode = String(body.splitMode || 'equal').toLowerCase();
      const useCustomSplit = splitMode === 'custom' && body.shares && typeof body.shares === 'object';
      const shares = {};
      if (useCustomSplit) {
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
      }
      const expense = {
        // Stable when the caller supplies a WhatsApp/cron request token. The
        // raw external id is hashed so it is never persisted in the ledger.
        id: groupExpenseId(body.expenseId),
        timestamp: new Date().toISOString(),
        payerPhone,
        amount: Math.round(amount * 100) / 100,
        description: String(body.description || '').slice(0, 200),
        category: String(body.category || '').slice(0, 60),
        subcategory: String(body.subcategory || '').slice(0, 60),
        splitMode,
        shares,
        _customSplit: useCustomSplit,
      };
      const appended = await appendGroupExpenseAtomic({ code, requesterPhone: reqPhone, expense });
      if (appended.status === 'group_missing') {
        return res.status(404).json({ ok: false, error: 'group_not_found' });
      }
      if (appended.status === 'not_member') {
        log.warn('group.addexpense.not_member', { reqId: req.reqId, code });
        return res.status(403).json({ ok: false, error: 'not_a_member' });
      }
      if (appended.status !== 'committed' && appended.status !== 'replayed') {
        log.error('group.addexpense.atomic_failed', { reqId: req.reqId, code, status: appended.status });
        return res.status(503).json({ ok: false, error: 'group_persist_unavailable' });
      }

      const committedExpense = appended.expense;
      const replayed = appended.status === 'replayed';
      // Mirror to the creator's Google Sheet for data-ownership. KV
      // remains authoritative for fast reads; the sheet is the audit
      // log members can verify against. Best-effort — never blocks the
      // bot reply, just logs on failure. Never mirror a replay: a lost HTTP
      // response followed by retry must not duplicate the sheet row.
      let sheetWriteOk = null;
      if (!replayed) {
        sheetWriteOk = false;
        try {
          const w = await writeGroupExpenseToSheet(appended.mirror, committedExpense, String(body.payerName || ''));
          sheetWriteOk = !!(w && w.ok);
          if (!sheetWriteOk) {
            log.warn('group.sheet_mirror_failed', { reqId: req.reqId, code, error: w?.error });
          }
        } catch (e) {
          log.warn('group.sheet_mirror_threw', { reqId: req.reqId, code, error: e.message });
        }
      }
      return res.status(200).json({
        ok: true,
        expense: committedExpense,
        memberCount: appended.memberCount,
        sheetWriteOk,
        replayed,
      });
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
      const mutation = await mutateGroupAtomic(code, 'undo', {
        requesterPhone,
        mutationId: groupMutationId('undo', body.mutationId),
      });
      if (mutation.status === 'group_missing') {
        return res.status(404).json({ ok: false, error: 'group_not_found' });
      }
      if (mutation.status === 'noop') {
        return res.status(200).json({ ok: true, removed: null, replayed: !!mutation.replayed });
      }
      if (mutation.status === 'forbidden_undo') {
        return res.status(403).json({ ok: false, error: 'only_payer_or_creator_can_undo' });
      }
      if (mutation.status !== 'committed') {
        return res.status(503).json({ ok: false, error: 'group_persist_unavailable' });
      }
      return res.status(200).json({ ok: true, removed: mutation.removed, replayed: !!mutation.replayed });
    }

    case 'addmember': {
      const code = String(body.code || '').trim().toUpperCase();
      const phone = normalizeE164(body.phone);
      if (!code || !phone) return res.status(400).json({ ok: false, error: 'invalid_args' });
      // Only an existing member/creator may add others — otherwise any
      // code-holder could stuff arbitrary phones into the group.
      const addReqPhone = normalizeE164(body.requesterPhone);
      if (!addReqPhone) {
        return res.status(403).json({ ok: false, error: 'not_a_member' });
      }
      const mutation = await mutateGroupAtomic(code, 'addmember', {
        requesterPhone: addReqPhone,
        member: {
          phone,
          name: String(body.name || phone).slice(0, 60),
          joinedAt: new Date().toISOString(),
        },
      });
      if (mutation.status === 'group_missing') {
        return res.status(404).json({ ok: false, error: 'group_not_found' });
      }
      if (mutation.status === 'not_member') {
        return res.status(403).json({ ok: false, error: 'not_a_member' });
      }
      if (mutation.status !== 'committed') {
        return res.status(503).json({ ok: false, error: 'group_persist_unavailable' });
      }
      return res.status(200).json({ ok: true, members: mutation.members });
    }

    case 'removemember': {
      const code = String(body.code || '').trim().toUpperCase();
      const phone = normalizeE164(body.phone);
      if (!code || !phone) return res.status(400).json({ ok: false, error: 'invalid_args' });
      // Only the creator can remove others; anyone can remove themselves.
      const rmReqPhone = normalizeE164(body.requesterPhone);
      if (!rmReqPhone) {
        return res.status(403).json({ ok: false, error: 'only_creator_or_self' });
      }
      const mutation = await mutateGroupAtomic(code, 'removemember', {
        requesterPhone: rmReqPhone,
        phone,
      });
      if (mutation.status === 'group_missing') {
        return res.status(404).json({ ok: false, error: 'group_not_found' });
      }
      if (mutation.status === 'forbidden_remove') {
        return res.status(403).json({ ok: false, error: 'only_creator_or_self' });
      }
      if (mutation.status !== 'committed') {
        return res.status(503).json({ ok: false, error: 'group_persist_unavailable' });
      }
      await kvDel('memberGroup:' + phone);
      return res.status(200).json({ ok: true, members: mutation.members });
    }

    case 'resync': {
      // Force a sheet provision for a group that was created before its
      // creator OAuth'd, or whose template wasn't configured at the time.
      const code = String(body.code || '').trim().toUpperCase();
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      const workerId = 'rs_' + crypto.randomBytes(12).toString('hex');
      const leasePayload = () => {
        const nowMs = Date.now();
        return { workerId, nowMs, leaseUntil: nowMs + 5 * 60 * 1000 };
      };
      const releaseLease = () => mutateGroupAtomic(code, 'resyncrelease', { workerId });
      try {
        let mutation;
        if (group.sheetId) {
          // A prior invocation may have attached the sheet and then lost its
          // response/crashed. The atomic transition returns the durable pending
          // snapshot so this invocation can resume instead of saying "already".
          mutation = await mutateGroupAtomic(code, 'resyncmeta', {
            sheetId: group.sheetId,
            sheetUrl: group.sheetUrl,
            ...leasePayload(),
          });
        } else {
          const creator = await findUserByPhone(group.createdBy);
          if (!creator || (!creator.refreshToken && !creator.refreshTokenEnvelope)) {
            return res.status(412).json({ ok: false, error: 'creator_not_oauth' });
          }
          const created = await createUserSheetWithRefresh({
            refreshTokenEnvelope: creator.refreshTokenEnvelope,
            refreshToken: creator.refreshToken,
            userSub: creator.userSub,
            name: `כספ'לה — ${group.name} (${group.code})`,
          });
          // Attach the sheet first and atomically persist the exact expense ids
          // covered by the cutover. Later expenses see sheetId and mirror live.
          mutation = await mutateGroupAtomic(code, 'resyncmeta', {
            sheetId: created.spreadsheetId,
            sheetUrl: created.spreadsheetUrl,
            ...leasePayload(),
          });
        }
        if (mutation.status === 'busy') {
          const waitMs = Math.max(1000, Number(mutation.leaseExpiresAt || 0) - Date.now());
          return res.status(409).json({
            ok: false,
            error: 'resync_in_progress',
            retry_after: Math.ceil(waitMs / 1000),
          });
        }
        if (!['committed', 'resume', 'already'].includes(mutation.status)) {
          await releaseLease();
          return res.status(503).json({ ok: false, error: 'group_persist_unavailable' });
        }
        if (mutation.status === 'already') {
          return res.status(200).json({ ok: true, sheetUrl: mutation.sheetUrl, already: true });
        }
        const syncGroup = {
          code: mutation.code,
          createdBy: mutation.createdBy,
          sheetId: mutation.sheetId,
          sheetUrl: mutation.sheetUrl,
        };
        const reconciled = await readGroupExpenseIds(syncGroup);
        if (!reconciled.ok) {
          await releaseLease();
          return res.status(502).json({ ok: false, error: 'resync_reconcile_failed' });
        }
        // Sequential backfill preserves ledger order. Column L makes the loop
        // replay-safe if a function dies after a row append but before finish.
        let mirrored = 0;
        let alreadyPresent = 0;
        for (const exp of (Array.isArray(mutation.expenses) ? mutation.expenses : [])) {
          if (reconciled.ids.has(String(exp.id || ''))) {
            alreadyPresent++;
            continue;
          }
          const w = await writeGroupExpenseToSheet(syncGroup, exp, '');
          if (!w?.ok) {
            await releaseLease();
            return res.status(502).json({ ok: false, error: 'resync_backfill_incomplete' });
          }
          reconciled.ids.add(String(exp.id || ''));
          mirrored++;
        }
        const completed = await mutateGroupAtomic(code, 'resynccomplete', {
          sheetId: mutation.sheetId,
          workerId,
        });
        if (completed.status !== 'committed') {
          await releaseLease();
          return res.status(503).json({ ok: false, error: 'resync_finalize_unavailable' });
        }
        return res.status(200).json({
          ok: true,
          sheetUrl: mutation.sheetUrl,
          mirrored,
          alreadyPresent,
          resumed: mutation.status === 'resume',
        });
      } catch (e) {
        await releaseLease();
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
      // MEMBERSHIP GATE — same defense-in-depth as addexpense above: a
      // recurring template injects an expense into the group's ledger every
      // cycle (and carries an attacker-chosen payerPhone), so a bare
      // bot-secret + code must NOT be enough to plant one in a stranger's
      // group. The bot sends payerPhone = the sender (resolved from the
      // sender's OWN active group), so reqPhone falls back to payerPhone and
      // the legit path keeps working without a bot change.
      const recReqPhone = normalizeE164(body.requesterPhone) || payerPhone;
      const recurringRecord = {
        id: Date.now() + '-' + crypto.randomBytes(6).toString('hex'),
        payerPhone,
        amount: Math.round(amount * 100) / 100,
        description: String(body.description || '').slice(0, 200),
        intervalDays,
        intervalLabel: intervalRaw,
        createdAt: new Date().toISOString(),
        lastFiredAt: null,
        active: true,
      };
      const mutation = await mutateGroupAtomic(code, 'addrecurring', {
        requesterPhone: recReqPhone,
        recurring: recurringRecord,
        mutationId: groupMutationId('addrecurring', body.mutationId),
      });
      if (mutation.status === 'group_missing') {
        return res.status(404).json({ ok: false, error: 'group_not_found' });
      }
      if (mutation.status === 'not_member') {
        log.warn('group.addrecurring.not_member', { reqId: req.reqId, code });
        return res.status(403).json({ ok: false, error: 'not_a_member' });
      }
      if (mutation.status !== 'committed') {
        return res.status(503).json({ ok: false, error: 'group_persist_unavailable' });
      }
      return res.status(200).json({ ok: true, recurring: mutation.recurring, replayed: !!mutation.replayed });
    }

    case 'listrecurring': {
      const code = String(body.code || '').trim().toUpperCase();
      const group = await kvGet('group:' + code);
      if (!group) return res.status(404).json({ ok: false, error: 'group_not_found' });
      // MEMBERSHIP GATE (backward-compatible): the recurring list carries each
      // template's payerPhone (member PII), so when the caller supplies a
      // requesterPhone we enforce membership exactly like the info/balances/
      // recent actions. The live bot does not yet send requesterPhone here, so
      // we MUST NOT hard-require it (that would 403 every legit list) — once the
      // bot is updated to pass it, this gate engages automatically. The residual
      // unauthenticated-read path is tracked for a coordinated bot change.
      const reqPhone = normalizeE164(body.requesterPhone);
      if (reqPhone && !isMemberOrCreator(group, reqPhone)) {
        log.warn('group.listrecurring.not_member', { reqId: req.reqId, code });
        return res.status(403).json({ ok: false, error: 'not_a_member' });
      }
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
      const { constantTimeEqual: ctEq3 } = await import('../lib/crypto.js');
      if (!gotCron || !ctEq3(String(gotCron), cronSecret)) return res.status(401).json({ ok: false, error: 'cron_unauthorized' });
      const code = String(body.code || '').trim().toUpperCase();
      const recurringId = String(body.recurringId || '');
      const mutation = await mutateGroupAtomic(code, 'markrecurringfired', {
        recurringId,
        lastFiredAt: new Date().toISOString(),
      });
      if (mutation.status === 'group_missing' || mutation.status === 'group_or_recurring_missing') {
        return res.status(404).json({ ok: false, error: 'group_or_recurring_not_found' });
      }
      if (mutation.status === 'recurring_missing') {
        return res.status(404).json({ ok: false, error: 'recurring_not_found' });
      }
      if (mutation.status !== 'committed') {
        return res.status(503).json({ ok: false, error: 'group_persist_unavailable' });
      }
      return res.status(200).json({ ok: true, lastFiredAt: mutation.lastFiredAt });
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

// Narrow test hook for executable concurrency regressions. This is a module
// export only (not an HTTP action) and still talks exclusively through the
// same authenticated Upstash script path used by the handler.
export { mutateGroupAtomic as __testMutateGroupAtomic };

// 60 calls/minute per phone is well above what any human group chat
// will produce, and per-IP keys cleanly prevent a single attacker from
// hammering us with bogus codes hoping to guess one.
export default withRequestId(
  withRateLimit({ key: 'group_ops', limit: 60, windowSec: 60 })(handlerImpl)
);
