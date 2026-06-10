# Payments Rail Memo — Kesefle (₪19/₪39 per month, Israeli WhatsApp SaaS)

**Date:** 2026-06-10 · **Status:** DRAFT, design-only (no code) · **Scope:** pick the card rail; harden the path from manual to webhooks.

## Where we actually are (from the repo, not theory)

Billing is not greenfield. Live today: **PayPal subscriptions** (recurring, webhook signature-verified via `PAYPAL_WEBHOOK_ID`), **crypto** (Coinbase Commerce), and a **fully built manual Bit/bank flow** (`api/billing/manual.js`: customer requests → gets a `KFL-XXXXXX` reference code + Bit/bank details → pays → owner gets a WhatsApp alert → admin confirms → premium activates). **Stripe was removed 2026-05** (`api/billing/checkout.js` is kept as dead code). All paths converge on one activation chokepoint, `activatePremium()` in `lib/billing.js`, which already stores `externalId` for audit/idempotency. The gap is an **Israeli card rail**: most Israeli consumers won't pay ₪19 via PayPal, and Bit is manual.

## Rail comparison

Naming note, verified carefully: **Meshulam rebranded to Grow (~2022) — they are one company, not two options.** Legacy API docs/endpoints still live under meshulam.co.il domains. Compared as a single entry below. All fees are **estimates from general knowledge — confirm with each provider before deciding; do not treat as quotes.**

| Rail | Recurring | Fees (≈, **estimates**) | KYC / setup | API quality |
|---|---|---|---|---|
| **Grow (formerly Meshulam)** | Yes — tokenized standing-order card charges; Bit inside checkout | ~1.4–2.8% + small fixed (agorot–₪1); low/no monthly. **Verify.** | Payfac model: no own acquiring contract needed; typically days | Hebrew docs, hosted payment pages, server callbacks/webhooks; adequate, not Stripe-grade |
| **Tranzila** | Yes — veteran tokenization / standing-order terminal | Monthly terminal fee (~₪50–150 est.) + acquirer merchant fee (~0.9–2.5% est.) + per-tx agorot | Usually needs your own merchant number with an Israeli acquirer — days–weeks | Dated: form-posts/iframe, Hebrew docs, notify-URL callbacks; reliable but clunky |
| **PayPal** (live now) | Yes — Subscriptions (already integrated) | ~3.4–4.4% + fixed (~₪1+) **est.** → ~10%+ effective at ₪19 | Already done | Decent REST + verified webhooks; conversion drag for Israeli SMB buyers |
| **Paddle** (MoR) | Yes — built-in subscriptions | Public list ~5% + $0.50 **(verify current)** → ~14–15% effective at ₪19 | Accepts foreign sellers incl. Israel (**verify at signup**); payouts not in ILS | Modern API/webhooks, excellent; but MoR tax posture for IL-company→IL-consumer sales is awkward (18% VAT) — needs accountant sign-off |
| **Stripe** | Yes (best-in-class) | ~2.9% + fixed in supported countries | **Honestly: not available to Israel-domiciled businesses** (not on supported-countries list as of mid-2026; perennial "coming soon"). Requires a foreign entity (Atlas/UK Ltd) — disproportionate at this ARPU | The benchmark; unusable from Israel without restructuring |

(Other Israeli rails exist — Cardcom, Pelecard, Sumit — not evaluated in depth here.)

## Interim manual flow (exists — extend, don't rebuild)

Keep the Bit/bank reference-code flow as the bridge. Design gaps to close: (1) surface the Bit option visibly on `upgrade.html`/account (pricing copy already promises it); (2) renewal reminders ~3 days before `accessUntil` lapses, since manual payments set `recurring=false`; (3) weekly sweep of the `billing:pending` index for stale requests; (4) use **Bit for Business / PayBox business** rather than personal P2P links (ToS + bookkeeping). Honest ceiling: manual confirm scales to ~dozens of active subs, not hundreds.

## Phased rollout

- **Phase 0 — now:** manual Bit/bank + PayPal + crypto as-is; add the reminders/reconciliation above. No new rail until real paying demand exists.
- **Phase 1 — one rail (Grow):** hosted payment page only (zero PCI scope), tokenized recurring charge. Success-redirect marks the sub *provisional*; activation still flows only through `activatePremium(externalId)`. Admin can manually verify against the Grow dashboard while webhooks mature.
- **Phase 2 — webhooks hardened:** treat callbacks as **at-least-once and out-of-order**. *Idempotency:* dedupe on provider event ID via a set-if-absent KV key (`billing:event:<id>`, ~90-day TTL) before any state change; `externalId` already makes activation re-entrant. *Retry:* verify event authenticity, re-fetch charge state from the provider API before transitioning; return 5xx only on transient internal failure so the provider retries; alert owner after repeated failures. *Reconciliation:* daily cron diffing provider charges vs KV subscription states (cron infra already exists in `vercel.json`). *Refunds/cancellation:* terms promise 14-day refunds — refund event → revoke or downgrade-at-period-end, set `subscriptionStatus`, write `auditLog`, never touch the user's Sheet (their data stays theirs).

## Recommendation

Keep PayPal + the manual Bit flow running, and add **Grow (formerly Meshulam)** as the single Israeli card rail: payfac onboarding in days with no acquiring contract, real recurring support, Bit embedded in checkout (which absorbs most of the manual flow), Hebrew-native UX, and the lowest fixed-fee drag at a ₪19 price point — exactly where PayPal's and Paddle's fixed fees hurt most. Hold **Tranzila** as the fallback if Grow's KYC declines or its recurring terms disappoint after a real quote. Skip **Paddle** at this ARPU and geography, and revisit **Stripe** only if Kesefle later incorporates abroad to sell globally. Before signing anything: get written fee quotes (the numbers above are estimates), confirm recurring/token terms, and confirm webhook + refund API capabilities against the Phase 2 design.
