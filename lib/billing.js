// lib/billing.js
// The ONE place premium gets switched on/off, no matter how the user paid
// (PayPal subscription, crypto, Bit, or bank transfer). Everything writes the
// canonical `user:<sub>` record so computeEntitlement / /api/whatsapp/link / the
// bot all see the same truth. Pricing + plan helpers live here too.

import { extendAccess, PREMIUM_PLANS } from './subscription.js';

// ── Pricing ────────────────────────────────────────────────────────────────
// Monthly / yearly price in ILS. Yearly ≈ 10 months (2 free) to nudge annual.
const PRICES = {
  pro:    { month: 19, year: 190 },
  family: { month: 39, year: 390 },
};
const PLAN_LABELS = { pro: 'Pro', family: 'Family' };
// Rough ILS→USD for crypto charges (crypto amounts are inherently approximate).
const ILS_PER_USD = 3.7;

function normalizePlan(plan) {
  const p = String(plan || '').toLowerCase();
  if (p === 'premium' || p === 'premium-monthly' || p === 'pro') return 'pro';
  if (p === 'family') return 'family';
  return PREMIUM_PLANS.includes(p) ? p : 'pro';
}

function periodMonths(period) {
  return String(period || '').toLowerCase() === 'year' ? 12 : 1;
}

function priceILS(plan, period) {
  const p = normalizePlan(plan);
  const tier = PRICES[p] || PRICES.pro;
  return period === 'year' ? tier.year : tier.month;
}

function priceUSD(plan, period) {
  return Math.max(1, Math.round((priceILS(plan, period) / ILS_PER_USD) * 100) / 100);
}

// ── KV (plain JSON; user:<sub> wraps an already-encrypted token envelope) ────
async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.result) return null;
  try { return JSON.parse(j.result); } catch { return j.result; }
}

async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return r.ok;
}

// ── WhatsApp helpers ─────────────────────────────────────────────────────────
function metaCreds() {
  return {
    token: process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_TOKEN,
    phoneId: process.env.META_PHONE_NUMBER_ID || process.env.WHATSAPP_PHONE_NUMBER_ID,
  };
}

// Fire-and-forget WhatsApp text. Never throws — billing must not fail because a
// notification couldn't be delivered.
async function sendWhatsApp(toPhone, body) {
  try {
    const { token, phoneId } = metaCreds();
    if (!token || !phoneId || !toPhone) return false;
    const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(toPhone).replace(/[^0-9]/g, ''),
        type: 'text',
        text: { body },
      }),
    });
    return r.ok;
  } catch (_e) {
    return false;
  }
}

async function getUserPhone(userSub) {
  const rec = await kvGet(`userPhone:${userSub}`);
  if (!rec) return null;
  return typeof rec === 'string' ? rec : rec.phone || null;
}

// Alert the business owner (Steven) about something needing attention.
async function notifyOwner(body) {
  const owner = String(process.env.KESEFLE_OWNER_PHONE || '972547760643').replace(/[^0-9]/g, '');
  return sendWhatsApp(owner, body);
}

// ── Activation / deactivation ────────────────────────────────────────────────
// Turn premium ON. Used by every payment path.
//   plan       — 'pro' | 'family'
//   method     — 'paypal' | 'crypto' | 'bit' | 'bank'
//   months     — prepaid length (ignored when `accessUntil` is given)
//   accessUntil— explicit ISO end (recurring webhooks pass next_billing_time+grace)
//   externalId — provider charge/subscription id (for audit + idempotency)
//   recurring  — true for PayPal subscriptions (auto-renews)
async function activatePremium(userSub, opts = {}) {
  if (!userSub) return null;
  const { plan = 'pro', method = 'manual', months = 1, accessUntil = null, externalId = null, recurring = false } = opts;

  const rec = (await kvGet(`user:${userSub}`)) || { userSub };
  rec.plan = normalizePlan(plan);
  rec.subscriptionStatus = 'active';
  rec.paymentMethod = method;
  rec.recurring = !!recurring;
  rec.accessUntil = accessUntil || extendAccess(rec.accessUntil, months);
  rec.lastPaymentAt = new Date().toISOString();
  if (externalId) rec.lastPaymentRef = String(externalId);
  if (recurring && externalId) rec.subscriptionId = String(externalId);
  await kvSet(`user:${userSub}`, rec);

  // Tell the customer on WhatsApp (best-effort).
  const phone = await getUserPhone(userSub);
  if (phone) {
    const label = PLAN_LABELS[rec.plan] || 'Premium';
    const until = new Date(rec.accessUntil);
    const untilStr = `${until.getDate()}/${until.getMonth() + 1}/${until.getFullYear()}`;
    const line = recurring
      ? `המנוי יתחדש אוטומטית. החיוב הבא בערך ב-${untilStr}.`
      : `בתוקף עד ${untilStr}.`;
    await sendWhatsApp(phone, `✅ הפרימיום שלך (${label}) פעיל! 🎉\n${line}\n\nתודה שבחרת בכספ'לה 💚`);
  }
  return rec;
}

// Turn premium OFF (cancellation / expiry / refund). We keep accessUntil so the
// customer rides out a period they already paid for; computeEntitlement lapses
// them automatically once it passes.
async function deactivatePremium(userSub, status = 'canceled') {
  if (!userSub) return null;
  const rec = await kvGet(`user:${userSub}`);
  if (!rec) return null;
  rec.subscriptionStatus = status;
  rec.recurring = false;
  rec.canceledAt = new Date().toISOString();
  // Only drop to free immediately if there's no paid time left.
  if (!rec.accessUntil || Date.parse(rec.accessUntil) <= Date.now()) {
    rec.plan = 'free';
  }
  await kvSet(`user:${userSub}`, rec);
  return rec;
}

export {
  PRICES,
  PLAN_LABELS,
  normalizePlan,
  periodMonths,
  priceILS,
  priceUSD,
  activatePremium,
  deactivatePremium,
  sendWhatsApp,
  notifyOwner,
  getUserPhone,
  kvGet as billingKvGet,
  kvSet as billingKvSet,
};
