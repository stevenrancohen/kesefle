# Payment + Subscription QA Audit — 2026-05-27

Scope: PayPal, manual Bit/bank, crypto, entitlement, dunning, win-back, cancel, invoices, pricing CTAs, bot. No code changes.

## Summary

Payment surface is solid. PayPal webhook is signature-verified server-to-server; canonical `user:{sub}` record is the single source of truth and the only thing `computeEntitlement` reads. 14-day trial is honored. No path grants `pro` without verified upstream state — the WhatsApp10 coupon shortcut is gone. Dunning Day 0/3/7 and Day-30 win-back are wired with dedup guards. Gaps are operational (manual-confirm doesn't write `audit:*`; cancel/change-plan queue intent for Steven rather than auto-revoke) plus minor UX drift. **Readiness 8/10.**

## Per-area table

| Area | Status | Risk | File:line |
| --- | --- | --- | --- |
| PayPal webhook HMAC | OK — `/verify-webhook-signature`, 401 on fail | Low | api/billing/paypal.js:217 |
| Crypto webhook HMAC | OK — `timingSafeEqual` SHA256 | Low | api/billing/crypto-webhook.js:36 |
| Stripe webhook | Dead, DEPRECATED, unwired | None | api/billing/webhook.js:1 |
| computeEntitlement | Reads `user:{sub}` only; no `subscription:{userSub}` key | Low | lib/subscription.js:79 |
| 14-day trial | `trialEndsAt` → `premium:true, status:'trial'` | Low | lib/subscription.js:106 |
| No fake "pro" grant | All callers gated on verified webhook or `requireAdmin` | Low | lib/billing.js:115 |
| Manual confirm gate | `requireAdmin` | Low | api/billing/manual.js:155 |
| **Manual confirm audit** | MISSING — `log.info` only, no `audit:*` row | High | api/billing/manual.js:144 |
| Dunning Day 0 | webhook → `payment_failed:{sub}` + Day-0 email | Low | api/billing/paypal.js:319 |
| Dunning Day 3 / 7 | Cron, dedup `email_sent` | Low | api/cron/lifecycle.js:217 |
| Winback rate limit | 30/h/IP + len 8–64 + scoped scan | Medium | api/billing/winback-claim.js:58 |
| Winback match arm | `startsWith(token)` arm — prefix match risk | Medium | api/billing/winback-claim.js:70 |
| Cancel flow | Survey + alert; does NOT call PayPal `/cancel` | Medium | api/billing/cancel-flow.js:106 |
| Change-plan | Intent + prorate; Steven processes manually | Medium | api/billing/change-plan.js:130 |
| Pricing CTAs | All route to `/account?plan=…`. No "soon" labels | Low | pricing.html:362 |
| Drift: en.html | "Premium · coming soon" present | Medium | en.html:372 |
| Invoice trigger | Fires only on `PAYMENT.SALE.COMPLETED` | Low | api/billing/paypal.js:276 |
| Invoice idempotency | `invoice:{sub}:{externalId}` | Low | api/billing/paypal.js:139 |
| Receipt visibility | `pdfUrl` in KV; no `/account` UI | Medium | lib/invoice.js:282 |
| Bot subscription cmd | Only owner-gated `מנויים`. No user `מנוי שלי` | Medium | bot/ExpenseBot_FIXED.gs:13331 |

## Critical

None — no path grants `pro` without verified PayPal/Coinbase signature or admin auth.

## High

H1. `manual.js:144` writes `log.info` only; no `audit:*` row. Admin `?action=audit` won't show manual approvals. Pattern: `api/admin.js:418` writes `audit:admin_${action}:${ts}:${sub8}`.

## Medium

M1. `winback-claim.js:70` keeps `startsWith(token)` arm — drop or require `token.length === 24`.
M2. `cancel-flow.js:122` TODO: doesn't call PayPal `/v1/billing/subscriptions/{id}/cancel`. Customer stays billed until manual processing.
M3. `en.html:372` still reads "Premium · coming soon".
M4. No `/account` UI for past invoices (KV has them).
M5. No bot `מנוי שלי` command for users — only owner-gated `מנויים` exists.

## Top 5 fixes

1. H1 — add `audit:billing_manual_confirm:{ts}:{sub8}` write at `manual.js:144`.
2. M1 — drop `startsWith` arm, enforce exact 24-char token in `winback-claim.js`.
3. M2 — wire PayPal `/cancel` call in `cancel-flow.js` for the `cancel` action.
4. M5 — add `מנוי שלי` returning `computeEntitlement` via `_handleSubscriptionCommand_`.
5. M3+M4 — fix `en.html:372`; add "החשבוניות שלי" on `/account` listing KV `invoice:*`.
