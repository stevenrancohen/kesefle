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
import { auditLog } from '../../lib/secure-kv.js';
import {
  activatePremium, notifyOwner, getUserPhone,
  priceILS, periodMonths, normalizePlan, PLAN_LABELS,
  billingKvGet, billingKvSet,
} from '../../lib/billing.js';

const PENDING_INDEX = 'billing:pending';

// Keep only the last 4 phone digits in audit metadata so the append-only
// trail does not store full numbers. (auditLog already one-way-hashes the
// userSub; this avoids parking a second raw identifier next to it.)
function phoneTail(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? '...' + digits.slice(-4) : null;
}

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
  // Audit trail: a customer opened a manual (Bit/bank) payment request. Same
  // append-only audit:* keyspace the admin dashboard reads, so manual billing
  // is traceable like the other billing endpoints. Non-fatal on KV outage.
  await auditLog('manual_payment_requested', userSub, {
    code, plan, period, months, amountILS, method, phoneTail: phoneTail(phone),
  }, { reqId: req.reqId }).catch(() => {});
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
    log.info('manual.payment_rejected', { reqId: req.reqId, code, userSub: pending.userSub, by: req.user.email });
    // Audit: admin dropped a pending manual payment. Hash the affected
    // customer's sub (not the admin's) so the trail joins to the user; record
    // the acting admin's email as the actor.
    await auditLog('manual_payment_rejected', pending.userSub, {
      code, plan: pending.plan, period: pending.period, method: pending.method,
      amountILS: pending.amountILS, by: req.user.email,
    }, { reqId: req.reqId }).catch(() => {});
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
    // Audit: admin confirmed a manual payment -> premium activated. This is the
    // money-moving event, so it MUST leave a forensic row in audit:* (the
    // dashboard's audit view + Amendment-13 trail) like every other billing
    // path. Hash the customer's sub; record the acting admin as `by`.
    await auditLog('manual_payment_confirmed', pending.userSub, {
      code, plan: pending.plan, period: pending.period, months: pending.months,
      amountILS: pending.amountILS, method: pending.method,
      by: req.user.email, accessUntil: rec?.accessUntil || null,
    }, { reqId: req.reqId }).catch(() => {});
    return res.status(200).json({ ok: true, code, status: 'confirmed', plan: rec?.plan, accessUntil: rec?.accessUntil });
  }

  return res.status(400).json({ ok: false, error: 'unknown_action' });
}

// ── Router ──────────────────────────────────────────────────────────────────
const requestHandler = withRateLimit({ key: 'billing_manual', limit: 10, windowSec: 3600 })(
  requireAuth(requestImpl)
);
// Defense-in-depth (audit M1, docs/AUDIT_API_ENDPOINT_SECURITY_2026_05_31.md):
// requireAdmin already gates list/confirm/reject, but a rate limit caps brute
// force if the admin token/cookie ever leaks. Matches the user-flow wrap above.
const adminHandler = withRateLimit({ key: 'billing_manual_admin', limit: 60, windowSec: 60 })(
  requireAdmin(adminImpl)
);

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
