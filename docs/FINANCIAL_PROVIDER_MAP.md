# FINANCIAL_PROVIDER_MAP — Integration Options for Kesefle (Israeli Hebrew-first Expense Tracker)

> **Status:** DESIGN DOCUMENT ONLY. No integrations are to be built from this file without a separate
> security + legal review. No credentials, no live calls, no production changes.
> **Date:** 2026-06-11. Facts verified by web search where noted; anything not confirmed is tagged
> **UNVERIFIED** or **ESTIMATE**. Pricing is deliberately omitted unless verified — none was verified, so
> NO pricing claims appear here.
> **Ground truth stack this maps onto:** Vercel serverless (api/*), Upstash KV, per-user Google Sheets
> ledger (תנועות A:H via lib/sheet-writer.js), WhatsApp bot input, existing api/sheet/csv-import.js,
> lib/bank-parsers.js (Hapoalim/Leumi/Discount/Mizrahi), lib/invoice.js (Green Invoice), lib/crypto.js.

---

## A. Israeli Open Banking (bank account data)

**Legal framework (VERIFIED):**
- Base: 2017 "Law for Increasing Competition and Reducing Centralization in the Banking Market"; Bank of
  Israel published implementation guidelines (2021) with APIs based on **Berlin Group NextGenPSD2**.
- **Financial Information Services Law, 2021** (חוק שירות מידע פיננסי) — published Nov 2021, in force
  June 2022. Extends open banking beyond banks; **licensing is by the Israel Securities Authority (ISA)**,
  not the Bank of Israel.
- ISA granted the **first FISP licenses on 2022-09-28** to: **RiseUp, Finanda, FamilyBiz, Green Invoice**
  (VERIFIED — Open Future World / ISA announcements). A later round added **Amir Cash Flow, Meteor Plus,
  Fizback Technologies, Finance FollowUp Services** (VERIFIED — law.co.il, Feb 2023). More licenses
  expected over time; the authoritative current list lives on isa.gov.il (not re-pulled this session).

**Licensed Israeli aggregators relevant to us:**
- **Finanda** — self-described "Israel's most experienced financial aggregator", ISA-licensed, sells
  aggregation-as-a-service to other businesses (VERIFIED existence + license; commercial terms UNVERIFIED).
- **RiseUp** — ISA-licensed; primarily a consumer PFM that now sells B2B "engine" services; partnered with
  **Salt Edge** for open-banking + payments (VERIFIED partnership). Not obviously a raw-data vendor to
  small third parties (ESTIMATE).
- **Green Invoice (Morning)** — holds a FISP license (VERIFIED) — interesting because we already integrate
  them for invoicing; whether they resell aggregation to partners is UNVERIFIED.
- **Personetics** — bank-side personalization/insights vendor, NOT a licensed consumer-facing aggregator
  play for us (ESTIMATE based on its known B2B2C model; UNVERIFIED in detail).
- **"brillianse" / "Open Finance Israel"** — could not verify these as licensed aggregators (UNVERIFIED;
  treat as non-existent until shown otherwise).

**Global aggregators vs Israel:**
- **Plaid, TrueLayer, Tink, Yapily, Finicity, MX** — coverage is US/UK/EU; **no Israeli bank coverage
  found** in any 2025-2026 comparison material (VERIFIED-NEGATIVE to the extent searchable; none lists IL).
- **Salt Edge** — the exception: operates a dedicated Israeli presence (saltedge.co.il), claims compliance
  with Israeli open-banking regulation, and demonstrably powers Israeli fintechs (**Vyzer**, **RiseUp**)
  for Israeli bank connections (VERIFIED). Its public IL coverage page exists but does not enumerate banks
  or connection types without login (checked directly — list UNVERIFIED). Whether Salt Edge serves a
  10-user startup directly, and under whose license our use would fall, is UNVERIFIED — **legal review
  required: consuming bank data for users likely requires Kesefle itself to be ISA-licensed or to operate
  under a licensed partner's umbrella.**

**Key design implication:** real bank-feed aggregation in Israel is a *licensed activity*. For a ~10-user
activation-phase product, the realistic path is **CSV/XLS import now**, aggregator partnership later
(Phase 3), Kesefle's own ISA license only at real scale.

---

## B. Israeli credit cards (Isracard, Max, CAL)

- **Public APIs: none.** No developer program found for any of the three (VERIFIED-NEGATIVE by absence;
  treat as "no public API" — UNVERIFIED only in the sense that private/partner APIs may exist).
- **Statement exports:** all three portals/apps let cardholders download transaction detail
  (פירוט עסקאות) as Excel/CSV — this is common knowledge among Israeli users but specific per-issuer
  export formats were NOT verified this session (UNVERIFIED — needs a sample-file collection exercise
  with masked data before writing parsers).
- **israeli-bank-scrapers (OSS, github.com/eshaham/israeli-bank-scrapers)** — VERIFIED: actively
  maintained Puppeteer-based scrapers covering all major Israeli banks + card companies (Isracard, Max,
  Visa CAL, Amex, etc.). **NOT recommended for hosted Kesefle use:**
  1. requires users' real banking credentials server-side — directly violates our crypto/tenant-isolation
     security model (we never hold bank credentials);
  2. credential-sharing scraping conflicts with issuer ToS and with the spirit of the 2021 law (licensed
     API access is the legal channel);
  3. headless-Chromium scraping is operationally hostile to Vercel serverless.
  Acceptable only as a *format reference* for our own parsers, or for power users running it locally and
  importing the CSV themselves.
- **Conclusion: import-first.** Extend lib/bank-parsers.js with Isracard/Max/CAL export profiles feeding
  the existing api/sheet/csv-import.js path (A:H + col H expense flag + dedup tuple already exist).

---

## C. Payment processors — BUSINESS-user revenue import

- **Stripe** — **NOT available to Israel-domiciled merchants** (VERIFIED: Israel absent from Stripe's
  ~46 supported-country list as of late 2025; Stripe's own "payments in Israel" page is educational, not
  onboarding). Workaround (US entity via Atlas) is out of scope. Relevant only for users who already have
  a foreign entity → their Stripe CSV export / API is standard (ESTIMATE on user demand: near zero).
- **PayPal** — available to Israeli sellers; activity export (CSV) and Transaction Search/Reporting APIs
  exist (common knowledge; specific API tiers UNVERIFIED this session). Import-first; API later.
- **Grow (formerly Meshulam)** — VERIFIED: real developer docs (grow-il.readme.io + doc.meshulam.co.il),
  payment-creation API **and webhooks for real-time transaction updates**; API access requires contacting
  Grow for credentials. Strongest webhook candidate for Israeli small-business revenue.
- **Tranzila** — VERIFIED: docs.tranzila.com; iframe / hosted fields / API V2 (server-to-server),
  notify_url (webhook-style callback), token billing, Bit support. Good candidate.
- **Cardcom** — VERIFIED existence as Israeli gateway with merchant API used by e-commerce plugins;
  full webhook/report API surface UNVERIFIED this session.
- **Hyp (Hypay)** — VERIFIED: developers.hyp.co.il; XML API (doDeal core endpoint), payment pages,
  Apple/Google Pay + Bit. Transaction-report pull API UNVERIFIED.
- **Pelecard** — VERIFIED as one of the major Israeli gateways; API docs exist for integrators; report
  API details UNVERIFIED.
- **PayMe** — VERIFIED: docs.payme.io + Apiary marketplace API. Details UNVERIFIED.
- **Morning / Green Invoice ecosystem** — see D; for many Israeli micro-businesses the *invoicing* system,
  not the gateway, is the cleanest single source of revenue truth.

**Design implication:** for business users, revenue import should be (1) CSV from gateway back-office —
works for all of the above today; (2) webhooks from Grow/Tranzila for the engaged users — Phase 2;
(3) never store gateway credentials, only per-user webhook secrets/API keys encrypted via lib/crypto.js
envelope pattern.

---

## D. Invoicing / accounting

- **Green Invoice (Morning)** — **public API VERIFIED** (greeninvoice.co.il/api-docs + Apiary). We already
  integrate it in lib/invoice.js (token exchange, doc type 400, VAT 18%). Natural extension: *read* a
  business user's own Green Invoice documents as revenue feed (their own API key, stored encrypted).
- **iCount** — **API VERIFIED** (icount.net/features/api, API-V3 at apiv3.icount.co.il/docs; free with
  basic membership; ~30 req/min rate limit). JSON, API-key auth. Good second invoicing source.
- **Morning** — same company/platform as Green Invoice (VERIFIED branding merge).
- **QuickBooks / Xero** — mature APIs (well known), but **low Israel relevance** (Hebrew/VAT/מס הכנסה
  workflows live in Green Invoice/iCount/Hashavshevet) — Phase: only-on-demand.
- **Hashavshevet (חשבשבת)** — legacy desktop/enterprise accounting; integration reality is file exports
  (UNVERIFIED format specifics; treat as import-only, accountant-driven, low priority).

---

## E. Wallets (Bit / PayBox / Pepper Pay) + Apple/Google Pay

- **Bit (Bank Hapoalim)** — dominant Israeli P2P app (~90% of app transfers, 3.5M+ users — VERIFIED press).
  A **Bit Developer Portal exists** (developer.bitpay.co.il, Bank Hapoalim-branded, Live/Sandbox envs —
  VERIFIED it exists; scope/access requirements UNVERIFIED, presumably bit-עסקים merchants only).
  **Consumer-side API: effectively none.** Bit business has settlement/transaction reports
  (ESTIMATE/UNVERIFIED detail) → position as **import/manual**, plus the existing WhatsApp-bot quick-log
  ("קיבלתי ביט 200") as the practical capture path.
- **PayBox** — consumer P2P (now fee-charging per Globes); no public API found (UNVERIFIED-negative) →
  manual/bot entry only.
- **Pepper Pay** — folded into Leumi's ecosystem; no public API found (UNVERIFIED-negative) → manual.
- **Apple Pay / Google Pay** — **zero direct visibility by design**: tokenized card transactions surface
  in the underlying card statement (Isracard/Max/CAL export). No integration to build; document this in
  user-facing help so users know where the data lands.

---

## F. Crypto (read-only)

All items below are stable, well-known public offerings; marked VERIFIED-by-public-docs unless noted.
- **Exchange read-only API keys:** Binance, Coinbase, Kraken, OKX, Bybit all support API keys scoped to
  read-only (balances + trade/funding history). Kesefle must require read-only scope, store keys with the
  lib/crypto.js AES-GCM envelope + AAD userSub binding, and never accept withdrawal-enabled keys.
- **Block explorers (watch-only by address, no credentials at all — preferred):**
  - BTC: Blockstream Esplora API, mempool.space API (free, no key).
  - ETH/EVM: Etherscan API (free tier, key required).
  - SOL: Solscan API / Helius (free tiers; current tier limits UNVERIFIED).
- **Prices/FX:** CoinGecko public API (free demo tier, key required since 2024) for ILS conversion;
  complements existing `_kfl_fxRate` in the bot. Rate-limit specifics UNVERIFIED.
- Watch-only address tracking is the lowest-risk crypto feature: no secrets, read-only, cacheable in KV.

---

## MASTER TABLE

| Provider type | Examples | Integration method | Israel availability | Difficulty | Risk | Phase | Priority |
|---|---|---|---|---|---|---|---|
| Open banking (licensed IL aggregator) | Finanda, Salt Edge(IL), RiseUp-as-engine | Partner API + OAuth-style consent | YES — licensed activity (ISA) | L | High (legal: FISP licensing; vendor lock) | 3 | Medium (the endgame, not now) |
| Open banking (global aggregators) | Plaid, TrueLayer, Tink, Yapily, Finicity, MX | API/OAuth | **NO IL coverage** (verified-negative) | — | — | Never | None |
| Own ISA FISP license | Kesefle itself | Direct Berlin-Group bank APIs | Possible at scale | XL | Very high (regulatory) | 4+ | Low |
| IL bank statements | Hapoalim, Leumi, Discount, Mizrahi | CSV/XLS import (lib/bank-parsers.js exists) | YES | S (done, extend) | Low | 0 (live) | **High** |
| IL card statements | Isracard, Max, CAL | CSV/XLS import (new parser profiles); **no public API** | YES (portal export) | M (need sample files) | Low | 1 | **High** |
| Credential scraping | israeli-bank-scrapers (OSS) | Headless scraping w/ user credentials | Exists, works | M | **Unacceptable** (ToS, credential custody, serverless-hostile) | NOT RECOMMENDED (hosted) | None |
| IL processor webhooks | Grow/Meshulam, Tranzila | Webhook + API key (verified docs) | YES | M | Medium (per-user secrets) | 2 | High (business users) |
| IL processor reports | Cardcom, Hyp, Pelecard, PayMe | CSV import now; API pull later (UNVERIFIED report APIs) | YES | S import / M API | Low-Med | 1 import / 2 API | Medium |
| Global processors | Stripe (NOT for IL merchants — verified), PayPal | CSV import; PayPal reporting API later | Stripe NO / PayPal YES | S | Low | 1 (PayPal CSV) | Low-Med |
| Invoicing APIs | Green Invoice/Morning (verified API), iCount (verified API-V3) | REST + per-user API key (encrypted) | YES — IL-native | M | Medium (key custody) | 2 | **High** (revenue truth for micro-biz) |
| Foreign accounting | QuickBooks, Xero | OAuth API | YES but low IL relevance | M | Low | On-demand | Low |
| Legacy accounting | Hashavshevet | File export import (UNVERIFIED formats) | YES | M | Low | On-demand | Low |
| IL wallets | Bit (dev portal exists, biz-only ESTIMATE), PayBox, Pepper Pay | Manual/bot quick-log + settlement-report import | Consumer APIs: effectively none | S | Low | 0-1 | Medium |
| Tokenized wallets | Apple Pay, Google Pay | None — visible via card statement | n/a | — | — | Docs only | n/a |
| Crypto exchanges | Binance, Coinbase, Kraken, OKX, Bybit | Read-only API keys (encrypted, scope-enforced) | YES | M | Medium (key custody, scope mistakes) | 3 | Low-Med |
| Crypto watch-only | Etherscan, Blockstream/mempool, Solscan/Helius | Public explorer APIs by address | YES | S-M | Low (no secrets) | 2-3 | Medium |
| Crypto prices | CoinGecko | Public API + key | YES | S | Low | 2 | Medium |

**Legend:** Difficulty S/M/L/XL = engineering size. Phase 0 = exists today; 1 = next (import-first);
2 = engaged-user APIs/webhooks; 3 = aggregation partnership; 4+ = own license.

---

## Phasing summary (decision)

1. **Phase 0-1 — Import-first doubles down (now):** card-statement parser profiles (Isracard/Max/CAL) +
   processor/PayPal CSV onto the existing csv-import pipeline (A:H, dedup, rate-limit). Zero new
   credential custody. Collect masked sample files first.
2. **Phase 2 — Per-user keys for revenue truth:** Green Invoice + iCount read APIs and Grow/Tranzila
   webhooks for business users; secrets in KV via lib/crypto.js envelopes; crypto watch-only addresses.
3. **Phase 3 — Real bank feeds via a licensed partner** (Finanda or Salt Edge IL): only when user count
   justifies the legal work. Global aggregators are a dead end for IL; scraping is rejected outright.
4. **Standing rule:** anything that touches user credentials of a bank/card issuer is out of bounds in
   the hosted product, full stop.

## Sources (key verifications)
- ISA first FISP licenses (RiseUp, Finanda, FamilyBiz, Green Invoice): openfuture.world; later round
  (Amir Cash Flow, Meteor Plus, Fizback, Finance FollowUp): law.co.il (2023-02-12).
- Law + BoI framework: boi.org.il press releases; openbankingtracker.com/regulation/israel-open-banking;
  Gornitzky/Barnea 2025 outlook (Lexology).
- Salt Edge IL: saltedge.co.il; Vyzer case (thefintechtimes.com, openbankingexpo.com); RiseUp+Salt Edge
  (thefintechtimes.com). Coverage page checked directly — bank list not public.
- Stripe IL unsupported: stripe.com/global + 2025/2026 supported-country roundups.
- israeli-bank-scrapers: github.com/eshaham/israeli-bank-scrapers.
- Grow/Meshulam docs: grow-il.readme.io, doc.meshulam.co.il. Tranzila: docs.tranzila.com.
  Hyp: developers.hyp.co.il. PayMe: docs.payme.io.
- Green Invoice API: greeninvoice.co.il/api-docs, greeninvoice.docs.apiary.io.
  iCount API: icount.net/features/api, sl.icount.co.il/developers.
- Bit: developer.bitpay.co.il (portal exists, Hapoalim-branded); Globes/Wikipedia for market share.
