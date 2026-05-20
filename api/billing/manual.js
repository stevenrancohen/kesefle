// /api/billing/manual
// Manual-confirm payments for Bit and bank transfer (no API exists for either).
// Flow:
//   1. POST ?action=request  (auth'd customer) {plan, period, method}
//        → creates a pending record + reference code, alerts the owner on
//          WhatsApp, returns payment instructions (your Bit number / bank
//          details, the amount, and the reference code).
//   2. Customer pays you directly via Bit / bank, quoting the reference code.
//   3. POST ?action=confirm  (ADMIN only) {code}
//        → activates premium for that customer (they get a WhatsApp confirmation).
//   GET  ?action=list        (ADMIN only) → open pending payments.
//   POST ?action=reject      (ADMIN only) {code} → drop a pending request.
//
// Env: BIT_PAYEE_PHONE, BANK_TRANSFER_DETAILS, ADMIN_EMAILS (for confirm/list)

import crypto from 'node:crypto';
import { requireAuth, requireAdmin } from '../../lib/auth.js';
import { withRequestId, log } from '../../lib/log.js';
import { withRateLimit } from '../../lib/ratelimit.js';
import {
  activatePremium, notifyOwner, getUserPhone,
  priceILS, periodMonths, normalizePlan, PLAN_LABELS,
  billingKvGet, billingKvSet,
} from '../../lib/billing.js';

const PENDING_INDEX = 'billing:pending';

// Reference code like KFL-7K3Q9F (CSPRNG, no ambiguous chars).
function makeRef() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[crypto.randomInt(0, alphabet.length)];
  return `KFL-${s}`;
}

async function indexAdd(code) {
  const list = (await billingKvGet(PENDING_INDEX)) || [];
  if (!list.includes(code)) list.push(code);
  await billingKvSet(PENDING_INDEX, list);
}
async function indexRemove(code) {
  const list = (await billingKvGet(PENDING_INDEX)) || [];
  await billingKvSet(PENDING_INDEX, list.filter((c) => c !== code));
}

// ── action=request (customer) ────────────────────────────────────────────────
async function requestImpl(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const plan = normalizePlan(body?.plan);
  const period = String(body?.period || 'month').toLowerCase() === 'year' ? 'year' : 'month';
  const method = String(body?.method || '').toLowerCase();
  if (!['pro', 'family'].includes(plan)) return res.status(400).json({ ok: false, error: 'invalid_plan' });
  if (!['bit', 'bank'].includes(method)) return res.status(400).json({ ok: false, error: 'invalid_method', allowed: ['bit', 'bank'] });

  const bitPhone = process.env.BIT_PAYEE_PHONE;
  const bankDetails = process.env.BANK_TRANSFER_DETAILS;
  if (method === 'bit' && !bitPhone) return res.status(503).json({ ok: false, error: 'bit_not_configured' });
  if (method === 'bank' && !bankDetails) return res.status(503).json({ ok: false, error: 'bank_not_configured' });

  const userSub = req.user.sub;
  const email = req.user.email || '';
  const amountILS = priceILS(plan, period);
  const months = periodMonths(period);
  const phone = await getUserPhone(userSub);
  const code = makeRef();

  const pending = {
    code, userSub, email, phone: phone || null,
    plan, period, months, amountILS, method,
    status: 'pending', createdAt: new Date().toISOString(),
  };
  await billingKvSet(`pendingPayment:${code}`, pending);
  await indexAdd(code);

  // Alert the owner so they know to watch for the incoming Bit/bank payment.
  const label = PLAN_LABELS[plan] || plan;
  await notifyOwner(
    `💰 בקשת תשלום חדשה (${method === 'bit' ? 'ביט' : 'העברה בנקאית'})\n` +
    `תכנית: ${label} ${period === 'year' ? 'שנתי' : 'חודשי'} — ${amountILS}₪\n` +
    `לקוח: ${phone || 'לא ידוע'}${email ? ' (' + email + ')' : ''}\n` +
    `קוד: ${code}\n` +
    `לאישור: ${(process.env.PUBLIC_SITE_URL || 'https://kesefle.com')}/admin`
  ).catch(() => {});

  const instructions = method === 'bit'
    ? `שלח/י ${amountILS}₪ בביט למספר ${bitPhone}\nוכתוב/כתבי בהערה את הקוד: ${code}`
    : `העבר/י ${amountILS}₪ לחשבון:\n${bankDetails}\nוציין/י בהעברה את הקוד: ${code}`;

  log.info('manual.payment_requested', { reqId: req.reqId, userSub, plan, period, method, code });
  return res.status(200).json({
    ok: true,
    code,
    amountILS,
    method,
    instructions,
    note: 'הפרימיום יופעל לאחר אישור התשלום (בדרך כלל תוך כמה שעות).',
  });
}

// ── admin actions ─────────────────────────────────────────────────────────────
async function adminImpl(req, res) {
  const action = String(req.query.action || '').toLowerCase();

  if (action === 'list') {
    const codes = (await billingKvGet(PENDING_INDEX)) || [];
    const items = [];
    for (const code of codes) {
      const p = await billingKvGet(`pendingPayment:${code}`);
      if (p && p.status === 'pending') items.push(p);
    }
    return res.status(200).json({ ok: true, count: items.length, pending: items });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const code = String(body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ ok: false, error: 'missing_code' });

  const pending = await billingKvGet(`pendingPayment:${code}`);
  if (!pending) return res.status(404).json({ ok: false, error: 'code_not_found' });

  if (action === 'reject') {
    pending.status = 'rejected';
    pending.rejectedAt = new Date().toISOString();
    await billingKvSet(`pendingPayment:${code}`, pending);
    await indexRemove(code);
    return res.status(200).json({ ok: true, code, status: 'rejected' });
  }

  if (action === 'confirm') {
    if (pending.status === 'confirmed') {
      return res.status(200).json({ ok: true, code, status: 'already_confirmed' });
    }
    const rec = await activatePremium(pending.userSub, {
      plan: pending.plan, method: pending.method, months: pending.months, externalId: code,
    });
    pending.status = 'confirmed';
    pending.confirmedAt = new Date().toISOString();
    pending.confirmedBy = req.user.email;
    await billingKvSet(`pendingPayment:${code}`, pending);
    await indexRemove(code);
    log.info('manual.payment_confirmed', { reqId: req.reqId, code, userSub: pending.userSub, by: req.user.email });
    return res.status(200).json({ ok: true, code, status: 'confirmed', plan: rec?.plan, accessUntil: rec?.accessUntil });
  }

  return res.status(400).json({ ok: false, error: 'unknown_action' });
}

// ── Router ──────────────────────────────────────────────────────────────────
const requestHandler = withRateLimit({ key: 'billing_manual', limit: 10, windowSec: 3600 })(
  requireAuth(requestImpl)
);
const adminHandler = requireAdmin(adminImpl);

export default withRequestId(async function manualRouter(req, res) {
  const action = String(req.query.action || '').toLowerCase();
  if (action === 'request') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return requestHandler(req, res);
  }
  if (action === 'list') {
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return adminHandler(req, res);
  }
  if (action === 'confirm' || action === 'reject') {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return adminHandler(req, res);
  }
  return res.status(400).json({ ok: false, error: 'unknown_action', allowed: ['request', 'confirm', 'reject', 'list'] });
});
