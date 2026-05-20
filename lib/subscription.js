// lib/subscription.js
// Single source of truth for a user's entitlement: a paid subscription (PayPal,
// crypto, Bit, or bank) OR an active self-serve trial. PURE functions — no I/O. Callers pass in the
// canonical KV user record (key `user:<sub>`).
//
// Why this exists:
//  - Before this, "premium" meant only `userRec.plan in {pro,family,business}`.
//    A brand-new user (or anyone mid-trial) had plan='free', so the WhatsApp
//    bot's _hasActivePremium_ check treated them as free and withheld AI
//    categorisation / OCR — defeating the whole point of a trial.
//  - Both the website (/account) and the bot (/api/whatsapp/link) now derive
//    entitlement from THIS module, so the trial window is honoured everywhere
//    and the rules live in one place.

const PREMIUM_PLANS = ['pro', 'family', 'business'];

// Stripe subscription statuses that should grant access. `past_due` is included
// deliberately: Stripe keeps retrying a failed payment for days, and we'd rather
// keep a paying customer working during that grace window than lock them out the
// instant a card hiccups. When Stripe finally gives up it fires
// `customer.subscription.deleted`, which flips the user back to `free`.
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

const TRIAL_DAYS = 14;
const DAY_MS = 86400000;

function lc(v) { return String(v == null ? '' : v).toLowerCase(); }

// Is there an active PAID entitlement on this record right now?
//
// Source of truth is `accessUntil` (ISO string) — the moment the paid period
// runs out. EVERY payment extends it: a one-off prepaid purchase (crypto / Bit /
// bank) sets it N months out, and a recurring renewal webhook (PayPal) pushes it
// forward each cycle. That single clock means one rule covers all four methods.
// If `accessUntil` is absent we fall back to subscriptionStatus for backward
// compatibility (e.g. the legacy Stripe path that only ever set a status).
function isPaidActive(userRec, now = Date.now()) {
  if (!userRec) return false;
  if (!PREMIUM_PLANS.includes(lc(userRec.plan))) return false;
  const until = userRec.accessUntil ? Date.parse(userRec.accessUntil) : NaN;
  if (Number.isNaN(until)) {
    return ACTIVE_STATUSES.includes(lc(userRec.subscriptionStatus));
  }
  return until > now;
}

// Extend a paid period. Stacks on top of whatever time is left (so renewing
// early never burns days): new end = max(now, current accessUntil) + months.
function extendAccess(currentAccessUntilIso, months = 1, now = Date.now()) {
  const current = currentAccessUntilIso ? Date.parse(currentAccessUntilIso) : NaN;
  const base = Math.max(now, Number.isNaN(current) ? 0 : current);
  return new Date(base + Math.max(1, months) * 30 * DAY_MS).toISOString();
}

// Trial window info derived purely from `trialEndsAt`.
function trialInfo(userRec, now = Date.now()) {
  const raw = userRec && userRec.trialEndsAt;
  const endsAt = raw ? Date.parse(raw) : NaN;
  if (!raw || Number.isNaN(endsAt)) {
    return { hasTrial: false, active: false, daysLeft: 0, endsAt: null };
  }
  const msLeft = endsAt - now;
  const active = msLeft > 0;
  return {
    hasTrial: true,
    active,
    daysLeft: active ? Math.ceil(msLeft / DAY_MS) : 0,
    endsAt: raw,
  };
}

// The one function everyone calls. Returns the effective entitlement.
//   premium       — boolean: does this user get Pro-level features right now?
//   effectivePlan — 'pro' | 'family' | 'business' | 'free' (what to gate on)
//   rawPlan       — the literal stored plan (for diagnostics/billing UI)
//   status        — 'active' | 'trialing' | 'past_due' | 'trial' | 'trial_expired' | 'free' | 'canceled'
//   paid          — boolean: backed by a real paid subscription/purchase
//   trial         — { hasTrial, active, daysLeft, endsAt }
function computeEntitlement(userRec, now = Date.now()) {
  const paid = isPaidActive(userRec, now);
  const trial = trialInfo(userRec, now);
  const storedPlan = lc((userRec && userRec.plan) || 'free');

  // Referral credit — a free month earned via refer-a-friend. Stored as an ISO
  // date on `referral_credit`; while it's in the future the user gets Pro. THIS
  // is what makes the promo actually unlock features — the bot (via
  // /api/whatsapp/link) and the website both read entitlement through here.
  const referralUntil = userRec && userRec.referral_credit ? Date.parse(userRec.referral_credit) : NaN;
  const referralActive = !Number.isNaN(referralUntil) && referralUntil > now;

  // Days left on the paid clock (for "renews/expires in N days" UI + reminders).
  const accessUntilMs = userRec && userRec.accessUntil ? Date.parse(userRec.accessUntil) : NaN;
  const paidDaysLeft = (paid && !Number.isNaN(accessUntilMs))
    ? Math.max(0, Math.ceil((accessUntilMs - now) / DAY_MS))
    : 0;

  let effectivePlan, status, premium;
  if (paid) {
    effectivePlan = PREMIUM_PLANS.includes(storedPlan) ? storedPlan : 'pro';
    status = lc(userRec.subscriptionStatus) || 'active';
    premium = true;
  } else if (referralActive) {
    effectivePlan = 'pro';
    status = 'referral';
    premium = true;
  } else if (trial.active) {
    effectivePlan = lc((userRec && userRec.trialPlan) || 'pro');
    if (!PREMIUM_PLANS.includes(effectivePlan)) effectivePlan = 'pro';
    status = 'trial';
    premium = true;
  } else {
    effectivePlan = 'free';
    premium = false;
    if (trial.hasTrial) status = 'trial_expired';
    else if (lc(userRec && userRec.subscriptionStatus) === 'canceled') status = 'canceled';
    else status = 'free';
  }

  return {
    premium,
    effectivePlan,
    rawPlan: storedPlan,
    status,
    paid,
    trial,
    paidDaysLeft,
    accessUntil: (userRec && userRec.accessUntil) || null,
    paymentMethod: (userRec && userRec.paymentMethod) || null,
  };
}

// Fields to stamp onto a brand-new user record at first signup so they start a
// 14-day Pro trial. Callers should ONLY apply these when the field is absent
// (never reset a trial that already started, never overwrite a paid plan).
function newUserTrialFields(now = Date.now()) {
  return {
    plan: 'free',
    trialPlan: 'pro',
    trialStartedAt: new Date(now).toISOString(),
    trialEndsAt: new Date(now + TRIAL_DAYS * DAY_MS).toISOString(),
  };
}

export {
  computeEntitlement,
  isPaidActive,
  extendAccess,
  trialInfo,
  newUserTrialFields,
  PREMIUM_PLANS,
  ACTIVE_STATUSES,
  TRIAL_DAYS,
};
