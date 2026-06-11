# Financial Integration Architecture

**Status:** Design (no live integrations, no keys, no production payment-flow changes)
**Date:** 2026-06-11
**Owner:** Financial Integration Architect
**Scope:** How external financial data (banks, cards, processors, files) flows into Kesefle, how it
reconciles with the existing WhatsApp-first pipeline, and how the Google Sheet's role evolves from
canonical ledger to projection — without breaking the ~10 live users we have today.

All identifiers in examples are masked (`972*****090`, `sub_a1b2…`, sheet `1UKr…W-Qo`).

---

## 1. Pipeline overview

```
┌──────────────────┐   ┌─────────────────────┐   ┌──────────────────────────┐
│ Financial Sources │──▶│ Provider Connectors │──▶│ Raw Transaction Inbox(KV)│
│ banks / cards /  │   │ (open-banking agg., │   │ inbox:{userSub}:{batch}  │
│ CSV / Excel / PDF│   │ file importers,     │   │ immutable raw payloads   │
│ / receipts / WA  │   │ WhatsApp = trivial  │   └────────────┬─────────────┘
└──────────────────┘   │ connector)          │                │
                       └─────────────────────┘                ▼
                                              ┌──────────────────────────┐
                                              │ Normalization Engine      │
                                              │ (lib/bank-parsers.js +    │
                                              │  normalizeTransaction)    │
                                              └────────────┬─────────────┘
                                                           ▼
                                              ┌──────────────────────────┐
                                              │ Duplicate Detection       │
                                              │ idempotency key + fuzzy   │
                                              │ (extends import:hashes:*) │
                                              └────────────┬─────────────┘
                                                           ▼
                                              ┌──────────────────────────┐
                                              │ Categorization Engine     │
                                              │ lib/categories.js + bot   │
                                              │ keyword map + AI fallback │
                                              └──────┬─────────┬─────────┘
                                            confident│         │low confidence
                                                     ▼         ▼
                                        ┌──────────────┐  ┌─────────────────┐
                                        │ Canonical    │◀─│ needs_review /  │
                                        │ Store        │  │ User Confirmation│
                                        │ txn:{sub}:{id}│  │ (bot prompt, web)│
                                        └──────┬───────┘  └─────────────────┘
                                               ▼
                                        ┌──────────────┐
                                        │ Sheet Sync    │ one-way projection
                                        │ (sheet-writer)│ to תנועות A:I
                                        └──────┬───────┘
                          ┌────────────────────┼────────────────────┐
                          ▼                    ▼                    ▼
                   Dashboards (sheet)    Admin (api/admin)    Bot replies
                   SUMIFS over A:I       funnel/health        bot-query layer
```

Every stage is append-only relative to the previous one: a stage never mutates upstream records,
it only emits its own. That is what makes replay, audit, and recovery possible on a KV-only stack.

---

## 2. THE key architectural decision: sheet-as-ledger → sheet-as-projection

### 2.1 Where we are (ground truth)

Today the per-user Google Sheet **is** the canonical ledger:

- `lib/sheet-writer.js` writes 8+1 columns (A:תאריך … H:סטטוס, I:ניכוי מע״מ) to the תנועות tab.
- `api/sheet/csv-import.js` dedups **by reading the sheet** (date+amount+description tuple).
- `api/sheet/bot-query.js` answers bot questions **by reading the sheet**.
- Dashboards are SUMIFS over the sheet. Users hand-edit the sheet, and that is a feature.
- KV holds identity (`user:{sub}`, `phone:{phone}`, `sheet:{sub}`), rate limits (`rl:*`), and the
  90-day import dedup set (`import:hashes:{userSub}` from `api/import/bank-csv.js`). KV holds
  **no transactions**.

This is correct for the activation phase: zero sync bugs possible (there is one store), users trust
what they can see and edit, and Sheets gives us versioned backup for free.

### 2.2 Why it cannot stay canonical once connectors exist

1. **Concurrent writers.** A bank connector syncing 200 rows while the bot appends a WhatsApp
   expense is a race on the same A:I range. Sheets API has no transactions.
2. **Dedup by reading the sheet is O(rows) per import** and already fragile (case-insensitive tuple
   match). Connector re-syncs need exact idempotency, not heuristics.
3. **User edits are indistinguishable from data.** If a user fixes a category in the sheet and the
   connector re-syncs the same transaction, who wins? With sheet-as-canonical there is no record of
   "what the provider said" vs "what the user decided".
4. **Query cost.** `bot-query` reads the whole tab per question. Fine at 10 users; not at 1,000.
5. **No lifecycle states.** `needs_review`, `pending`, `reconciled` don't fit an 8-column flat tab.

### 2.3 Migration path

**Phase 1 — sheet stays canonical, imports get idempotency keys (now, low risk).**

- All imports (CSV, Excel, bank files, future connectors) flow through the existing
  `csv-import` / `bank-csv` append path. No behavioral change for users.
- Every imported row gets a deterministic **idempotency key**:
  `idem = sha256(provider | external_id)` when the source has a stable id, else
  `sha256(provider | date | amount | normalized_description | running_index_within_day)`.
- Keys live in KV: `SADD import:idem:{userSub}` (generalizes the existing
  `import:hashes:{userSub}` from `api/import/bank-csv.js`; same 90-day TTL initially, extended to
  13 months once connectors do historical pulls).
- The sheet row's G column (מקור) carries a structured source tag (`"ייבוא CSV"`, `"בנק:הפועלים"`)
  so Phase 2 backfill can attribute provenance.
- **Exit criterion:** zero duplicate rows across re-imports in 30 days of use.

**Phase 2 — canonical KV records, sheet becomes a one-way projection.**

- New KV records, one per transaction:

  ```
  key:   txn:{userSub}:{txnId}            txnId = idem key (Phase 1) → continuity for free
  value: {
    v: 1,
    date, monthKey,                        // A, B
    amount, currency, fxRate,              // C (ILS-normalized; bot _kfl_fxRate as source)
    category, subcategory,                 // D, E
    description,                           // F
    source: { provider, providerType, accountRef, externalId, batchId },  // G provenance
    isExpense, vatDeductible,              // H, I
    status: 'confirmed' | 'needs_review' | 'pending',
    userOverrides: { category?, subcategory?, description? },  // user edits, never clobbered
    sheetRow: { tab, rowIdx, syncedAt } | null,
    createdAt, updatedAt, audit: [...]
  }
  index: txnidx:{userSub}:{YYYY-MM} → set of txnIds   // month index for query layer
  ```

- **Write order:** canonical record first, sheet projection second, `sheetRow` recorded third. A
  sync cursor (`sheetsync:{userSub}` with last-applied txn watermark) makes projection resumable;
  a cron (same pattern as `api/cron/kv-backup.js`) re-drives failed projections.
- **User sheet edits are absorbed, not fought:** a reconciliation pass (cron, daily) diffs the
  sheet against `sheetRow` snapshots; user-changed cells are written back into `userOverrides`
  on the canonical record. This preserves the existing "the sheet is yours, edit it" promise —
  exactly the safeSetValue/never-overwrite principle already enforced elsewhere in Kesefle.
- **Backfill:** one-shot, per-user, gated script (DRY_RUN → APPLY, per the repo's migration
  standard) reads תנועות A:I and mints `txn:*` records with `source.provider='sheet-backfill'`.
- **Cutover, per user, behind a flag** (`user:{sub}.txnCanonical=true`): bot reads/writes switch
  from sheet-first to canonical-first. Rollback = flip the flag; the sheet was never broken.

**Phase 3 (later) — KV → real DB.** When volume or query complexity outgrows Upstash (relational
queries, recurring detection at scale), `txn:*` records migrate to Postgres. Because Phase 2
already defines the record shape and the projection contract, this is a storage swap, not an
architecture change. Do **not** start here; KV is sufficient for thousands of users at this schema.

**Non-negotiable invariant across all phases:** the sheet a user opens always shows every
confirmed transaction. The sheet may *lag* the canonical store by seconds; it never *disagrees*
with it except where the user edited (and then the user wins — see §6).

---

## 3. ProviderConnector interface

One interface, every source. WhatsApp manual entry is the degenerate connector (auth = none,
fetch = push-only); file importers are connectors with `connect()` = file upload.

```js
// lib/connectors/types.js (design)
const ProviderConnector = {
  // ---- identity ----
  provider_name: 'isracard',                 // stable slug, used in txn source + audit
  provider_type: 'card' | 'bank' | 'psp' | 'file' | 'manual',
  auth_method:  'oauth2' | 'api_key' | 'screen_consent' | 'file' | 'none',

  // ---- lifecycle ----
  async connect(userSub, opts),              // begin consent; returns { consentUrl | uploadSpec }
  async refreshToken(userSub),               // rotate creds; stored via lib/crypto.js envelopes
  async disconnect(userSub),                 // revoke remote consent + purge conn:{sub}:{provider}
  async testConnection(userSub),             // cheap auth probe, no data pull
  async healthCheck(),                       // provider-level: API up? sandbox reachable?

  // ---- data ----
  async fetchAccounts(userSub),              // [{ accountRef (masked!), type, currency, nickname }]
  async fetchTransactions(userSub, from, to),// raw provider payloads → Raw Inbox, NOT normalized
  async receiveWebhook(req),                 // verify signature, enqueue to Raw Inbox, 200 fast

  // ---- normalization ----
  normalizeTransaction(raw),                 // pure function, no I/O →
                                             // { date, amount, currency, description,
                                             //   isIncome, externalId, accountRef, raw }
};
```

`normalizeTransaction` is pure and synchronous by contract so it is testable with the repo's
existing no-mock test pattern (`tests/`, balanced-brace extraction) and so connector bugs are
reproducible from stored raw payloads alone.

### Required behaviors (every connector, enforced by a shared wrapper, not by convention)

| Behavior | Rule |
|---|---|
| **Sandbox mode** | `KFL_CONNECTOR_SANDBOX=1` ⇒ all connectors hit provider sandboxes / fixture files. CI runs sandbox-only. No design work proceeds against live endpoints. |
| **Consent** | Explicit per-provider user consent recorded at `consent:{sub}:{provider}` (scope, timestamp, version of consent text). No fetch without a live consent record. Hebrew consent copy, plain language. |
| **Read-only default** | Connectors get read scopes only. There is no code path that initiates payments/transfers. (Mirrors the existing OAuth posture: minimal Sheets/Drive scopes.) |
| **Retries** | Shared wrapper: 3 attempts, exponential backoff + jitter, retry only on 429/5xx/network — same policy `lib/invoice.js` already implements for Green Invoice. 4xx (except 429) fails fast to `needs_review` for the batch. |
| **Rate limits** | Per-provider budget in KV via `lib/ratelimit.js` (`rl:conn:{provider}:{sub}`); scheduled syncs are staggered per user (hash of userSub → minute offset) to avoid thundering herd on cron. |
| **Audit log** | Every connect / sync / webhook / disconnect appends `audit:{sub}` (action, provider, counts only — **never descriptions or amounts**, matching the bank-csv privacy stance). Surfaced in admin. |
| **Credential storage** | Provider tokens use the existing AES-256-GCM envelope (`v1:<kid>:…`) from `lib/crypto.js` with AAD = userSub, key rotation via `KESEFLE_DB_KEY_<KID>`. No new crypto. |
| **Masked identifiers** | `accountRef` is always last-4 + type (`"חשבון •••0901"`). Full account numbers never leave `normalizeTransaction.raw`, which is encrypted at rest in the inbox. |

Provider candidates for Israel (design note only, no commitments): open-banking aggregators under
the Israeli open-banking framework for bank/card data; PSPs (e.g., payment processors a business
user already has) via their official APIs. **No screen-scraping of services whose ToS forbid it.**

---

## 4. Import-first fallback ladder

Connectors are the destination; files are the bridge. Build down the ladder in this order — each
rung ships value alone and feeds the same Raw Inbox → Normalization path:

1. **CSV** — exists (`api/sheet/csv-import.js`, generic header detection). Migrate its dedup from
   sheet-tuple-scan to the Phase-1 idempotency set; otherwise unchanged.
2. **Excel (.xlsx)** — same column-detection logic over a sheet-to-CSV conversion layer. Israeli
   banks export xlsx more often than CSV; this is the cheapest high-impact rung.
3. **Bank statement formats** — exists and growing (`lib/bank-parsers.js`: Hapoalim, Leumi,
   Discount, Mizrahi; Windows-1255, bidi stripping, two-column debit/credit). Wire the remaining
   two parsers into `api/import/bank-csv.js` (today it accepts hapoalim|leumi only).
4. **Card statements** — Isracard / Max / Cal export formats; same parser pattern (header aliases,
   billing-date vs transaction-date distinction matters here — normalize to transaction date,
   keep billing date in `raw`).
5. **PDF extraction (later)** — banks that only give PDFs. Text-layer extraction first; OCR only
   if needed. Always lands in `needs_review` (never auto-confirm PDF-derived rows).
6. **Receipt OCR (later)** — the bot's photo flow (`_handleReceiptImage_`) already exists for
   single receipts; this rung is batch receipt → line items, also always `needs_review`.
7. **Manual WhatsApp (exists)** — the floor and the daily driver; never deprecated.

Rule: a rung never gets its own write path. Every rung emits normalized rows into the same
dedup → categorize → confirm → store pipeline. The ladder differs only in *parsing*.

---

## 5. Bot behavior over connected data: ONE query layer

**Hard rule: the bot never contains per-provider logic.** The bot (Apps Script) calls one
endpoint family — today `api/sheet/bot-query.js`, in Phase 2 a canonical-store query layer with
the same contract (`queryType`, `period`, `category`, plus new `status` and `source` filters).
Providers, file formats, and sync mechanics are invisible above the canonical store.

The five canonical Hebrew queries and how they resolve:

| User says (Hebrew) | Query-layer call | Notes |
|---|---|---|
| ״כמה הוצאתי על אוכל החודש?״ | `{ queryType:'category', category:'מזון', period:'month' }` | Sums across **all** sources — WhatsApp rows, CSV imports, bank-sync rows — because they are all `txn:*` records (or sheet rows in Phase 1). The bot does not know or care which provider contributed. |
| ״מה מחכה לאישור שלי?״ | `{ queryType:'needs_review' }` | Returns pending `status:'needs_review'` items as a numbered list; user replies ״אשר 2״ / ״2 זה דלק״ to confirm/reclassify. Confirmation writes status + category to the canonical record, projection updates the sheet. |
| ״שופרסל זה לא קניות, זה אוכל בית״ | `{ queryType:'reclassify', match:'שופרסל', to:{category:'מזון', subcategory:'קניות סופר'} }` | Two effects: (a) bulk-update matching txn records (`userOverrides.category`), (b) emit a **rule** `rule:{sub}` ("שופרסל → מזון/קניות סופר") consumed by the Categorization Engine for future rows. Rules are per-user, additive, and exportable to the golden set for regression coverage. |
| ״מה ההוצאות הקבועות החודש?״ | `{ queryType:'recurring', period:'month' }` | Recurrence detection runs in the pipeline (same merchant ±3 days monthly cadence), tags `txn.recurring=true`; the existing `api/cron/recurring.js` engine is the natural owner. The query layer just filters the tag. |
| ״כמה הכנסות היו לעסק החודש?״ | `{ queryType:'income', period:'month', business:'תמונות' }` | Income = `isExpense:false` (col H discipline, the 2026-06-03 sign fix). Business scoping uses the existing multi-business column-H/criteria conventions; in Phase 2, a `businessRef` field on the record. |

Reply formatting stays in the bot (Hebrew tone rules per `bot-reply-style`); **numbers come only
from the query layer.** The Gemini money-coach fallback keeps its current position: invoked only
after the structured query layer has answered or declined, and it receives aggregates, never raw
transaction descriptions beyond what the user themselves asked about.

---

## 6. Source of truth + conflict rules

1. **Canonical store wins for existence and provider facts.** A transaction exists iff a
   `txn:{sub}:{id}` record exists (Phase 2). Date, amount, provider description are provider
   facts; user cannot edit amount via the sheet without it being flagged (mismatch → audit entry
   + bot nudge, never silent acceptance — amounts are load-bearing for dashboards).
2. **User wins for meaning.** Category, subcategory, description text, VAT-deductible flag:
   `userOverrides` always beats both the categorizer and any provider re-sync. Re-syncs may
   update provider facts; they may never clear a user override.
3. **Most-specific source wins for duplicates across sources.** A WhatsApp entry "150 סופר" and a
   bank row "שופרסל דיל בע״מ 150.00" on the same day are matched by the fuzzy stage (amount exact,
   date ±2 days, merchant similarity). The bank row becomes the record's provider fact; the
   WhatsApp entry's category/description become `userOverrides` (the user typed it — it's intent).
   One record, not two; the match is logged and reversible (״זה לא אותו דבר״ splits them).
4. **Sheet is a projection, never a source** (Phase 2) — except the daily reconciliation pass that
   harvests user edits into `userOverrides` (§2.3). That pass is the only sheet→KV flow.
5. **Idempotency keys are immutable.** Reclassification, edits, and dedup-merges never change a
   txn id; corrections are new fields on the same record plus an audit entry. Deletes are
   tombstones (`status:'deleted'`), projected as row removal, recoverable.
6. **FX:** amounts normalize to ILS at ingest using the bot's `_kfl_fxRate` source; original
   currency + rate are preserved on the record so historical totals never shift retroactively.

---

## 7. Top risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Split-brain during Phase 2 rollout** — sheet and KV disagree, user trust evaporates (worse than any missing feature at activation stage). | Per-user flag cutover; nightly reconciliation diff with alert on any mismatch >0; sheet remains complete at all times; rollback = flip flag. |
| 2 | **KV is not a database** — no secondary indexes, no transactions; month indexes (`txnidx:*`) can drift from records under partial failures. | Append canonical record before index; index repair cron; keep record self-describing so indexes are always rebuildable by scan. Cap design at "thousands of users" and pre-commit to the Phase-3 Postgres exit before pain. |
| 3 | **Connector compliance/ToS** — Israeli bank data access outside the regulated open-banking framework (scraping) creates legal exposure. | Hard rule: licensed aggregators or official APIs only; consent records with text versioning; read-only scopes; this doc forbids scraping outright. |
| 4 | **Credential blast radius** — provider tokens are higher-value than Sheets refresh tokens (they read full bank history). | Existing AES-GCM envelope + AAD per user, key rotation already built (`lib/crypto.js`); per-provider revoke on disconnect; tokens never logged (extend `lib/log.js` redaction list before any connector ships). |
| 5 | **Dedup false merges** — fuzzy matching merges two genuinely distinct same-day, same-amount expenses. | Fuzzy merges always notify via bot with one-tap undo; exact idempotency only for auto-silent dedup; merge decisions audited and reversible (§6.3). |
| 6 | **Categorizer flooding needs_review** — a first bank sync imports 300 rows, 200 land in review, user churns. | Confidence ladder: per-user rules → keyword map → golden-set-validated defaults → only then needs_review; first-sync UX reviews by *merchant group* ("12 רכישות בשופרסל — הכל מזון?") not row-by-row; cap review prompts per day. |
| 7 | **Apps Script bot as a long-term query client** — quota limits and paste-deploys make the bot the weakest link as query richness grows. | Keep the bot thin (rule §5: one query layer, formatting only); all new logic lands in `api/*` where it is tested and deployed by git, not by paste. |
| 8 | **Privacy regression in new pipelines** — inbox/raw payloads contain full descriptions and account numbers. | Raw inbox encrypted at rest, TTL'd (30 days post-processing); logs carry counts and ids only (the `bank-csv.js` standard becomes a lint rule for all connector code); GDPR delete (`gdpr-data-delete`) extended to `inbox:*`, `txn:*`, `conn:*`, `consent:*`, `audit:*` keys. |

---

## Appendix A — KV key map (new keys introduced by this design)

```
inbox:{sub}:{batchId}        raw provider payloads, encrypted, TTL 30d after processing
import:idem:{sub}            idempotency key set (generalizes import:hashes:{sub})
txn:{sub}:{txnId}            canonical transaction record (Phase 2)
txnidx:{sub}:{YYYY-MM}       month index of txnIds
rule:{sub}                   per-user categorization rules (list)
conn:{sub}:{provider}        connection record (status, scopes, encrypted creds)
consent:{sub}:{provider}     consent record (scope, ts, consent-text version)
sheetsync:{sub}              projection watermark/cursor
audit:{sub}                  append-only audit trail (counts + actions, no PII)
```

Existing keys (`user:{sub}`, `phone:{phone}`, `sheet:{sub}`, `rl:*`) are unchanged.

## Appendix B — Build order (smallest shippable steps)

1. Phase-1 idempotency keys in `csv-import.js` + `bank-csv.js` (shared helper, golden tests).
2. Wire Discount + Mizrahi parsers into `api/import/bank-csv.js`; add xlsx rung.
3. `needs_review` over the *sheet* (status value in a sheet column or a review tab) so the bot UX
   exists before the canonical store does.
4. Canonical `txn:*` records + projection, behind per-user flag (Phase 2).
5. Query layer v2 (`status`/`source`/`recurring` filters) reading canonical store.
6. First connector, sandbox-only, behind `KFL_CONNECTOR_SANDBOX`.
