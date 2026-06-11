# Kesefle — Financial Integration Roadmap + Monday Tasks
Status: DESIGN ONLY (no live integrations, no keys, no production payment changes)
Date: 2026-06-11 | Owner: Steven | Board: 5097200701 (status col "priority")
Ground truth: Vercel serverless (api/*), Upstash KV, per-user Google Sheets ledger (תנועות A:H via lib/sheet-writer.js), WhatsApp bot (Apps Script), existing api/sheet/csv-import.js, lib/bank-parsers.js, lib/crypto.js, lib/invoice.js.

---

## PART 1 — 5-PHASE ROADMAP

### Phase 1 — Manual + Import (NOW)
Scope: harden the EXISTING api/sheet/csv-import.js path. Idempotency keys per imported row, duplicate detection beyond the current (date+amount+description) tuple, a needs_review queue (KV-backed, surfaced via bot + admin), and Hebrew bank/card statement formats via lib/bank-parsers.js (Hapoalim/Leumi/Discount/Mizrahi already parsed; add card issuers: Isracard, Max, Cal — file formats only, no scraping).
- Entry: today's state. CSV import live with 3/day rate limit and tuple dedup.
- Exit: (a) import of the 4 bank formats + 3 card formats passes a golden fixture suite; (b) re-importing the same file twice produces 0 new rows (idempotency proven); (c) ambiguous rows land in needs_review, not in תנועות; (d) at least 2 real users complete an import end-to-end.

### Phase 2 — Business processors + invoices
Scope: file/API IMPORT (read-only) from Green Invoice (lib/invoice.js already speaks its API), iCount, PayPal activity export, Grow (Meshulam) settlement reports. Income side of the ledger for עוסק מורשה users.
- Entry: DECISION GATE passed (below) AND Phase 1 exit met.
- Exit: a business user can reconcile a month of processor income against תנועות with <5 min manual work; invoice-import never double-books rows already written by the bot.

### Phase 3 — Open Banking (Israel) via a LICENSED provider
Scope: research + sandbox FIRST. Israeli Open Banking (חוק שירות מידע פיננסי) requires a licensed AISP — candidates to evaluate: open-finance providers operating in IL (e.g. Finport-style aggregators, bank-direct APIs). No screen-scraping, ever.
- Entry: Phase 2 exit + provider shortlist signed off + cost model fits unit economics (~10 users → pricing must scale down).
- Exit: sandbox connection pulls 90 days of transactions into the normalized schema; consent, token storage (lib/crypto.js envelopes), and revocation flows designed and reviewed; legal review done.

### Phase 4 — Crypto
Scope: watch-only wallets (public address → on-chain reads) + read-only exchange API keys (no withdrawal scope, ever). FX/ILS valuation reuses the bot's _kfl_fxRate pattern.
- Entry: Phase 3 in sandbox or consciously skipped by decision; ≥3 users explicitly asking.
- Exit: a watch-only address and one read-only exchange account sync into needs_review → תנועות with correct ILS valuation and cost-basis note.

### Phase 5 — Full automation
Scope: recurring-transaction detection, anomaly alerts (bot pushes "הוצאה חריגה"), accountant export pack (monthly CSV/PDF per Israeli accountant norms), reconciliation assistant (suggested matches between imported rows and bot-entered rows).
- Entry: ≥2 source types live per active user; reconciliation model (Task 8) proven on real data.
- Exit: monthly close for a business user takes <15 minutes; accountant export accepted by a real accountant without rework.

### DECISION GATE (hard rule)
Phases 2+ DO NOT START until the activation metric shows real users returning: the admin הפעלה card (healthy-segment activation, task #295) must show returning weekly-active users over a sustained window, per the kill-criterion playbook (docs/activation-playbook.md). Until then, only Phase 1 + research tasks run. Building connectors for users who don't return is the failure mode the council already flagged: talk to users, don't stack features.

---

## PART 2 — MONDAY TASKS (paste-ready)

Format per task: Title | Goal | Priority | Acceptance criteria | Risk | Dependencies | Phase

### 1. Universal Financial Integration Architecture
- Goal: one design doc defining how ANY source (file, API, chain) flows: source → parser → normalized txn → dedup/idempotency → needs_review → sheet-writer A:H(+I).
- Priority: P0
- Acceptance: doc reviewed; every later task references its interfaces; explicitly maps onto existing csv-import.js + sheet-writer.js (no parallel write path).
- Risk: over-engineering for 10 users; mitigate by requiring each layer to already exist or be <1 file.
- Dependencies: none. | Phase: 1

### 2. Universal Transaction Schema
- Goal: define the normalized transaction record (superset of bank-parsers output): id (idempotency key), source, sourceRef, date, amount, currency, fxRate, description, category, subcategory, isIncome/colH, vatFlag(colI), status(pending/review/posted), hash.
- Priority: P0
- Acceptance: schema doc + JSON example; lossless mapping to תנועות A:H+I demonstrated; idempotency key formula specified (e.g. SHA-256 of source|sourceRef|date|amount|desc).
- Risk: schema churn breaking KV records later; version field from day 1 (migration-pattern skill).
- Dependencies: Task 1. | Phase: 1

### 3. Provider Research — Banks / Open Banking (IL)
- Goal: map the licensed Israeli AISP landscape: who is licensed, API coverage per bank, sandbox availability, pricing, consent UX, data fields returned.
- Priority: P1
- Acceptance: comparison table of ≥3 providers + bank-direct option; recommendation memo with cost-at-10-users and cost-at-1000-users; explicit "no scraping" confirmation per option.
- Risk: pricing kills unit economics; research-only so risk is wasted hours, capped at 2 days.
- Dependencies: Task 1. | Phase: 3 (research now, build later)

### 4. Provider Research — Cards (Isracard / Max / Cal / Amex IL)
- Goal: document downloadable statement formats (XLS/XLSX/CSV), header layouts, encodings, foreign-currency rows; whether card data also arrives via Open Banking providers.
- Priority: P1
- Acceptance: ≥3 issuer formats documented with anonymized sample fixtures (masked card numbers, fake amounts); parser feasibility note per format against lib/bank-parsers.js patterns.
- Risk: formats change without notice; mitigate with header-driven detection (already the bank-parsers approach).
- Dependencies: Task 1. | Phase: 1 (file import), 3 (API)

### 5. Provider Research — Israeli Processors (Green Invoice / iCount / PayPal / Grow)
- Goal: document read/export options per processor: Green Invoice API (already integrated for WRITE in lib/invoice.js — research READ endpoints), iCount API, PayPal activity CSV, Grow settlement files.
- Priority: P1
- Acceptance: per-provider: auth model, export fields, rate limits, sandbox; mapping draft to the universal schema; income vs fee separation noted.
- Risk: API ToS limits on data pulls; verify ToS per provider in the memo.
- Dependencies: Tasks 1, 2. | Phase: 2

### 6. Provider Research — Crypto
- Goal: watch-only address tracking (which chains, which free/cheap APIs) + read-only exchange keys (Binance/Kraken/Bit2C scopes); ILS valuation approach.
- Priority: P2
- Acceptance: memo covering ≥2 chains + ≥2 exchanges; explicit scope list proving read-only (no trade/withdraw); cost-basis/tax note for IL.
- Risk: tiny user demand; timebox to 1 day, park if no users ask.
- Dependencies: Task 2. | Phase: 4

### 7. CSV/Excel Import MVP (hardening) — BUILD
- Goal: harden api/sheet/csv-import.js: idempotency keys (Task 2 hash stored in KV per tenant), smarter dup detection (fuzzy date±1d/amount-exact), needs_review queue, route bank files through lib/bank-parsers.js automatically, XLSX support.
- Priority: P0
- Acceptance: golden fixture suite (4 banks + generic CSV + 1 XLSX) passes; double-import = 0 new rows; review-queue rows visible in admin and resolvable via bot reply; rate limit + tenant-isolation guard preserved; tests in tests/ added.
- Risk: dup logic too aggressive → silently dropped real rows; needs_review (never silent drop) is the mitigation.
- Dependencies: Tasks 1, 2. | Phase: 1

### 8. Reconciliation Model
- Goal: design how imported rows reconcile with bot-entered rows (same expense typed in WhatsApp AND in the bank file): match candidates by amount/date-window/description-similarity; user confirms merge in bot.
- Priority: P1
- Acceptance: design doc + decision table (auto-merge / suggest / keep-both); zero auto-deletes — merges only mark, never remove (financial-data-integrity-guard rules).
- Risk: false merges corrupting the ledger; default to "suggest", never auto-merge in v1.
- Dependencies: Tasks 2, 7. | Phase: 1 design, 5 build

### 9. Connector Interface
- Goal: define the code contract every connector implements: fetch/parse → normalized txns + cursor; metadata (id, name, type, authKind); KV state layout per tenant-connector; error and retry semantics.
- Priority: P1
- Acceptance: interface doc + one reference implementation note (csv-import refactored as the first "connector"); no connector can write to Sheets directly — only via the Task 1 pipeline.
- Risk: abstraction before second consumer; keep it a doc + thin wrapper until Phase 2 starts.
- Dependencies: Tasks 1, 2. | Phase: 1-2

### 10. Security / Compliance Model
- Goal: design credential handling for future connectors: lib/crypto.js v1 envelopes + AAD per tenant, scoped read-only keys, consent records, revocation, audit log entries, GDPR/Israeli Privacy (Amendment 13) data-map update; threat model for token theft and cross-tenant leakage.
- Priority: P0
- Acceptance: written model reviewed against TENANT_ISOLATION_MODEL.md; checklist gate that every connector task must pass; masked-identifier rule in all logs/examples.
- Risk: paper compliance vs reality; tie each control to an existing lib function or a named new one.
- Dependencies: Task 1. | Phase: 1 (doc), enforced 2+

### 11. Open-Source Research
- Goal: survey reusable OSS: Firefly III / Actual Budget importers, ofxparser, israeli-bank-scrapers (STUDY FORMATS ONLY — its scraping approach violates bank ToS and is explicitly out), ccxt (read-only), plaid-like schema conventions.
- Priority: P2
- Acceptance: memo: what to copy (schemas, parsers, test fixtures), what to avoid, license check per candidate.
- Risk: license contamination; note license per repo before reading code.
- Dependencies: none. | Phase: 1

### 12. Bot Integration with Connected Accounts
- Goal: design bot UX for imports/connectors: "יבאתי 42 תנועות, 3 ממתינות לאישור", review-queue resolution by reply (1=אשר 2=ערוך 3=מחק), source shown per txn, Hebrew-first copy per bot-reply-style.
- Priority: P1
- Acceptance: message-flow spec with exact Hebrew strings; no new write path (reuses bot command framework); loop-defense reviewed (_BOT_ECHO_REGEXES_) so import notifications can't echo back as expenses.
- Risk: notification spam → mute; batch digests, never per-row pings.
- Dependencies: Tasks 7, 8. | Phase: 1-2

### 13. Dashboard / Admin Connected Accounts View
- Goal: design the admin + user view: per-tenant list of sources (CSV imports, future connectors), last sync, rows imported, review-queue depth; ties into the הפעלה activation card.
- Priority: P2
- Acceptance: wireframe + data contract from KV; admin card shows per-user source counts; user view in /account shows their own sources only (tenant isolation).
- Risk: admin clutter; one card, drill-down on click.
- Dependencies: Tasks 2, 7. | Phase: 1-2

### 14. Payment COLLECTION (charging users) — SEPARATE TRACK, PARKED
- Goal: charging users for Kesefle subscriptions is NOT part of this integration roadmap. It stays a separate track, currently parked per the payments pause.
- Priority: P2 (parked)
- Acceptance: n/a — tracked in docs/drafts/payments-rail-memo.md; revisit only after activation gate passes.
- Risk: scope bleed into this epic; any payment-rail work item must reference the memo, not these tasks.
- Dependencies: DECISION GATE. | Phase: outside this roadmap

---

## PART 3 — SEQUENCING SNAPSHOT
- Now (this sprint): Tasks 1, 2, 10 (docs) → Task 7 (only build). Tasks 3, 4, 5, 11 as timeboxed research in parallel.
- Blocked on DECISION GATE: Tasks 5-build, 9-build, anything Phase 2+.
- Parked: Task 6 (until demand), Task 14 (payments memo).
- Monday hygiene: each task gets label בוצע on completion + this doc linked in the item; never >1 day stale.
