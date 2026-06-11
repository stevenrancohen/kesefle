# Open-Source Financial Integration Research — Kesefle

Date: 2026-06-11 | Author: research agent | Status: design input (no code adopted yet)
Scope: OSS relevant to Kesefle's next integration phases (CSV/statement import, dedup,
categorization, crypto, open banking). All star counts are **approximate** (web-verified
June 2026, not API-exact). Kesefle ground truth: Vercel serverless + Upstash KV +
per-user Google Sheets (8-col A:H), WhatsApp bot input, existing `lib/bank-parsers.js`
(4 Israeli banks) and `api/sheet/csv-import.js` (RFC4180-lite, dedup by date+amount+desc tuple).

Legend: **Reuse** = can we copy code into Kesefle's closed-source SaaS? (MIT/BSD/Apache = yes
with attribution; AGPL/GPL = NO, learn-only.)

---

## 1. Personal finance / expense tracking apps

### Firefly III
- URL: https://github.com/firefly-iii/firefly-iii | PHP (Laravel) | **AGPL-3.0** | Very active, ~tens of k stars (approx)
- What: self-hosted personal finance manager; double-entry ledger, full REST JSON API, rule-based transaction engine, recurring transactions, piggy banks.
- Learn: the **rules engine model** (trigger → condition → action on description/amount/source) maps cleanly onto a future Kesefle "auto-categorize rules" KV record; its transaction model (withdrawal/deposit/transfer as first-class types) is a good reference for handling transfers (currently a Kesefle blind spot — a bank transfer imports as both an expense and an income).
- Reuse code: **NO** (AGPL). Risks: PHP stack irrelevant to us anyway.
- Recommendation: mine concepts (rule schema, transfer detection), never code.

### Actual Budget
- URL: https://github.com/actualbudget/actual | TypeScript | **MIT** | Very active, ~27k stars (approx, June 2026)
- What: local-first envelope-budgeting app (ex-commercial, open-sourced 2022); CSV/OFX/QIF import, bank sync via GoCardless + SimpleFIN, powerful rules engine, sync/CRDT core.
- Learn: **best-in-class import dedup**: transactions carry an `imported_id`; when absent it fuzzy-matches by amount + date window against existing rows before inserting — directly upgradeable onto our exact-tuple dedup in `api/sheet/csv-import.js`. Also: import preview UI (show parsed rows + let user fix column mapping before commit) and rules engine schema.
- Reuse code: **YES** (MIT, license-compatible; it's TS/JS like our stack — fragments of loot-core import/dedup logic are portable).
- Risks: code assumes a local SQLite store; we'd port logic, not modules.
- Recommendation: **top mining target** for Phase 1 dedup + import-preview patterns.

### Maybe (Maybe Finance)
- URL: https://github.com/maybe-finance/maybe | Ruby on Rails | **AGPL-3.0** | **ARCHIVED 2025-07-27** (company pivoted to B2B); read-only
- What: full personal-finance app (accounts, budgets, investments), Plaid sync.
- Learn: account/holding data model, AI-assistant-over-finances UX ideas. Nothing operational.
- Reuse code: **NO** (AGPL + dead project). Recommendation: skim for UX only; lowest priority.

### Ghostfolio
- URL: https://github.com/ghostfolio/ghostfolio | TypeScript (Angular+NestJS+Prisma) | **AGPL-3.0** | Active
- What: wealth/portfolio tracker for stocks, ETFs, crypto; activity-based import (CSV/JSON of buy/sell/dividend).
- Learn: portfolio "activities" import format and FX/valuation handling — relevant only when Kesefle adds asset tracking to מאזן אישי.
- Reuse code: **NO** (AGPL). Recommendation: reference for a future investments tab; not Phase 1.

---

## 2. Bank import (statements, formats, Israeli specifics)

### israeli-bank-scrapers ⭐ (Israeli — most relevant domain knowledge)
- URL: https://github.com/eshaham/israeli-bank-scrapers | TypeScript | **MIT** | Active (Node >= 22.12, recent releases)
- What: Puppeteer **credential scrapers** for ~14 Israeli institutions: Hapoalim(Beyahad/Behatsdaa), Leumi, Discount, Mercantile, Mizrahi, Otsar Hahayal, Massad, Yahav, Pagi, OneZero + cards Isracard, Visa Cal, Max.
- Learn (NOT the scraping): the **normalized Israeli transaction schema** in `src/definitions.ts`/transactions types — `date` vs `processedDate` (חיוב vs ערך), `chargedAmount` vs `originalAmount` + `originalCurrency` (FX!), `status` (pending/completed), `installments {number, total}` (תשלומים — Kesefle has nothing for this), `identifier` (bank txn id — the ideal dedup key), memo/description quirks per institution. This is years of accumulated Israeli-bank format knowledge our `lib/bank-parsers.js` can be validated against.
- Reuse code: **YES license-wise (MIT)** — but **HARD RULE: do NOT adopt hosted credential scraping** (users' bank passwords on our servers = unacceptable risk + likely bank-ToS violation). Port only type definitions, per-bank field semantics, and date/amount normalization helpers.
- Recommendation: **top mining target** — treat as the Israeli-format encyclopedia.

### moneyman
- URL: https://github.com/daniel-hauser/moneyman | TypeScript | **MIT** | Active, small (~86 stars approx)
- What: runs israeli-bank-scrapers on a schedule (GitHub Actions / Docker, user's own infra) and **exports to Google Sheets** among other targets.
- Learn: its Israeli-transaction → Google Sheets column mapping + dedup-on-append logic is literally Kesefle's pipeline shape (scraper-sourced rows → sheet rows). Also a model for "self-hosted by the user, not by us" credential handling — a possible future answer for power users.
- Reuse code: YES (MIT). Recommendation: read its sheet-export + hash/dedup code before extending csv-import.

### caspion
- URL: https://github.com/brafdlog/caspion | TypeScript (Electron) | MIT (verify in repo before any copy) | Active-ish
- What: desktop one-click fetch from Israeli banks → Google Sheets / YNAB / CSV / JSON; built on israeli-bank-scrapers.
- Learn: end-user UX for Israeli bank import + Sheets exporter mapping. Reuse: likely yes (verify license file). Recommendation: secondary reference to moneyman.

### Firefly III Data Importer
- URL: https://github.com/firefly-iii/data-importer | PHP | **AGPL-3.0** | Active
- What: standalone importer: CSV + camt.053 (ISO 20022 XML), column-mapping config files, duplicate detection, connects to GoCardless/Spectre as data providers.
- Learn: **the mapping-config concept** — a saved, reusable JSON "import configuration" per bank (column roles, date format, sign convention) that users create once. Kesefle equivalent: a per-bank mapping profile stored in KV so a returning user's Leumi CSV imports with zero questions. Also its duplicate-detection options (by hash vs by external id).
- Reuse code: **NO** (AGPL). Recommendation: learn-only; the config-file design is the takeaway.

### OFX / QIF tooling
- ofxparse — https://github.com/jseutter/ofxparse | Python | **MIT** | mature/slow-moving. Reference OFX/QFX parser (SGML-ish format, `<FITID>` unique txn id — the formal solution to dedup).
- node-ofx — https://github.com/chilts/node-ofx | JS | **MIT** | minimal Node OFX parser; closest to our stack if we ever accept OFX.
- csv2ofx — https://github.com/reubano/csv2ofx | Python | MIT (verify) | CSV→OFX/QIF converter with **per-institution mapping modules** (`csv2ofx/mappings/*.py`) — same "mapping profile" pattern as Firefly's importer, in permissive code.
- Learn: FITID-style stable transaction IDs; Israeli banks rarely export OFX, so OFX support is low priority — but the **FITID dedup concept** should shape our row-hash design.
- Reuse: YES (MIT ones). Recommendation: concepts now, parsers later if OFX demand appears.

---

## 3. Categorization / merchant normalization

### Plaid Personal Finance Category (PFC) taxonomy — data, not code
- URL: https://plaid.com/documents/transactions-personal-finance-category-taxonomy.csv (+ pfc-taxonomy-all.csv); docs: https://plaid.com/docs/transactions/
- What: the de-facto industry taxonomy — 16 primary × ~100+ detailed categories with descriptions; PFCv2 released Dec 2025.
- Learn: use as a **crosswalk target**: map Kesefle's Pa'amonim-based Hebrew categories (lib/categories.js) ↔ PFC detailed categories. That gives us a stable interchange layer for any future import source and a sanity check for taxonomy gaps.
- Reuse: it's a published doc, not OSS — **do not redistribute the CSV**; keep an internal mapping table that references it. Risks: ToS on redistribution.

### ntropy (ntropy-sdk / enrichment_models)
- URL: https://github.com/ntropy-network/ntropy-sdk (Python SDK, commercial API); https://github.com/ntropy-network/enrichment_models | mixed licenses (MCP server is MIT; SDK license verify) | Active
- What: commercial transaction-enrichment API; `enrichment_models` benchmarks LLMs (GPT, fine-tuned Llama adapters on HuggingFace) against their API for merchant cleaning + categorization.
- Learn: **their LLM-prompting patterns for transaction enrichment** (merchant normalization prompt structure, eval harness) — directly applicable to Kesefle's AI-fallback pipeline in the bot-intelligence epic. The hosted API itself is not Hebrew/Israel-focused and costs money — skip.
- Reuse code: only from permissively-licensed repos after checking each LICENSE. Recommendation: read `enrichment_models` for eval-set design (mirrors our golden_set.js approach).

### smart_importer (beancount ecosystem)
- URL: https://github.com/beancount/smart_importer | Python | **MIT** | maintained
- What: ML hook that predicts payee + category for new imports, trained **on-the-fly from the user's own existing ledger** (scikit-learn SVC).
- Learn: this is exactly Kesefle's situation — every user has a personal labeled dataset (their תנועות tab). Pattern: train/match per-user from their own history before falling back to global keywords or LLM. Even a non-ML version (nearest-neighbor on normalized description) would lift accuracy.
- Reuse code: **YES** (MIT), though Python; we'd port the approach to JS. Recommendation: **top mining target** for the categorization ladder: user-history match → keyword taxonomy → LLM fallback.

---

## 4. Crypto portfolio

### Rotki
- URL: https://github.com/rotki/rotki | Python + TypeScript | **AGPL-3.0** | Very active
- What: local-first crypto portfolio tracker/accountant; exchange + on-chain balance tracking, transaction decoding, tax/accounting events.
- Learn: asset-identifier normalization (same coin, many tickers), FX/price-at-time-of-tx handling — relevant to the bot's `_kfl_fxRate` and any future "crypto holdings" row in מאזן אישי.
- Reuse code: **NO** (AGPL). Recommendation: learn-only; crypto is not an activation-phase priority — defer entirely.
- (OSS CoinTracker-style alternatives are mostly small/stale or AGPL; nothing worth adopting now.)

---

## 5. Reconciliation / dedup in plaintext accounting

### beancount
- URL: https://github.com/beancount/beancount | Python | **GPL-2.0 only** | Active (v3)
- Learn: importer protocol + dedup philosophy: extract → **identify duplicates against existing ledger** → let the human confirm. Its "mark, don't silently drop" stance is the right UX for Kesefle imports (flag suspected dupes in the preview instead of skipping silently as csv-import.js does today).
- Reuse code: **NO** (GPLv2-only — strongest caution on the list).

### hledger
- URL: https://github.com/simonmichael/hledger | Haskell | **GPL-3.0+** | Active
- Learn: the **`.latest` file scheme**: store, per import source, the latest seen date + how many transactions occurred on that date; on re-import, skip everything at or before that watermark. Trivially portable as a concept to a KV key per (user, bank, account): `lastImport:{date, countOnDate, rowHashesOnDate}`. Known limitation (banks back-inserting old rows) matches what we already see — so combine watermark + tuple-hash.
- Reuse code: **NO** (GPL; Haskell anyway). Concept reuse is free.

---

## 6. Open-banking clients (EU — context only)

- **GoCardless Bank Account Data (ex-Nordigen)** — https://github.com/nordigen/nordigen-python, nordigen-php | free PSD2 aggregation, 30+ EU countries, real bank APIs (no scraping). **Critical caveat: stopped accepting NEW Bank Account Data accounts from July 2025** (per Actual Budget docs) — and **Israel is not PSD2**, so no Israeli bank coverage. Learn: their normalized account/transaction JSON shape as a target schema. Reuse: client libs irrelevant to Israel.
- **TrueLayer SDKs** — https://github.com/TrueLayer (Java/.NET/Rust/PHP official; JS client MIT but deprecated) | UK/EU only; commercial API. Learn: SDK ergonomics + webhook patterns. Not applicable to Israeli banks.
- **Salt Edge** — commercial aggregator with SDKs; claims broad country coverage — if Kesefle ever wants hosted bank connectivity in Israel, evaluate Salt Edge / local players (Open Finance Israel framework) as a paid vendor decision, not OSS. Design rule for now: **statement/CSV upload only — no hosted credentials.**

---

## Top 3 repos to mine for Phase 1 (CSV/statement parsing + dedup)

1. **israeli-bank-scrapers (MIT)** — adopt its Israeli transaction schema vocabulary (`identifier`, `processedDate`, `originalCurrency`, `installments`, `status`) into `lib/bank-parsers.js` output, and validate our 4 bank parsers against its per-institution knowledge. No credential scraping — formats and types only.
2. **Actual Budget (MIT)** — port the dedup ladder (stable imported-id → fuzzy amount+date-window match → user-confirmed) and the import-preview/column-mapping UX into `api/sheet/csv-import.js`, replacing the current exact (date+amount+desc) tuple which misses near-dupes and bank re-exports.
3. **smart_importer (MIT)** — port the "train on the user's own ledger" idea: match new descriptions against the user's historical תנועות rows before the keyword taxonomy and LLM fallback. Cheapest accuracy win available, zero new infra.

Honorable mention: **moneyman (MIT)** — its scrapers→Google Sheets export + dedup is the closest existing pipeline to Kesefle's architecture; read before writing any new sheet-append import code.

## License cautions (explicit)

- **AGPL-3.0 = learn-only. Never copy code into Kesefle's closed SaaS**: Firefly III, Firefly Data Importer, Maybe, Ghostfolio, Rotki. Even server-side use of AGPL code triggers source-disclosure obligations.
- **GPL-2.0-only (beancount) / GPL-3.0+ (hledger) = learn-only**; concepts and file-format knowledge are not copyrightable, code is.
- **MIT = reusable** with copyright-notice attribution: israeli-bank-scrapers, Actual Budget, smart_importer, moneyman, ofxparse, node-ofx, TrueLayer JS client. Verify the LICENSE file at the pinned commit before any copy (csv2ofx, caspion, ntropy-sdk not individually confirmed).
- **Plaid taxonomy CSV** = published reference data, not OSS — map to it internally, do not redistribute.
- Keep a `THIRD_PARTY_NOTICES` file from the first copied MIT snippet onward.
