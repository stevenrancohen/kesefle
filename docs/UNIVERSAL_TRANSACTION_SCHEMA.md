# Universal Transaction Schema (UTS) — v1

Design-only spec. No live integrations, no migrations required for Phase 1.
The universal record is the **internal canonical form** every ingestion path
(bot, bank CSV, card, processor, invoice, crypto, manual) normalizes into.
The user-facing ledger remains the existing Google Sheet תנועות tab (A:H/I per
`lib/sheet-writer.js` `buildExpenseRow`); section 5 maps UTS → that row so
Phase 1 ships with **zero sheet-schema migration**.

All identifiers in examples are fake/masked. Never store full PAN, full IBAN,
unmasked wallet addresses, or credentials anywhere in this record (section 8).

---

## 1. Field reference

Types are JSON types. "null" = nullable. All timestamps ISO-8601 with offset
(store UTC; render Asia/Jerusalem).

| # | Field | Type | Null | Description |
|---|-------|------|------|-------------|
| 1 | `transaction_id` | string (UUIDv7) | no | Kesefle-internal id. UUIDv7 so KV scans sort by time. |
| 2 | `user_id` | string | no | Google OAuth `sub` — same tenant key as today's KV user records. |
| 3 | `source_type` | enum `bot\|bank\|card\|processor\|invoice\|crypto\|import\|manual` | no | Ingestion channel. `import` = generic CSV/XLSX; `bank` = a recognized bank parser from `lib/bank-parsers.js`. |
| 4 | `provider_name` | string | yes | e.g. `"hapoalim"`, `"leumi"`, `"isracard"`, `"green_invoice"`, `"whatsapp"`, `"ethereum"`. Lowercase slug, fixed vocabulary per source_type. |
| 5 | `provider_account_id` | string | yes | **Masked** account ref, e.g. `"****4312"` (bank), `"card-****8821"`, `"0xAb3…9F2"` (wallet, masked per §8). |
| 6 | `external_transaction_id` | string | yes | Provider's own id (bank reference no., processor charge id, invoice doc id, crypto tx hash). Null for bot/manual and most CSV rows. |
| 7 | `idempotency_key` | string (hex, 64) | no | Dedup key. Exact recipe in §2. |
| 8 | `original_timestamp` | string (ISO-8601) | yes | The provider's timestamp as given (may be date-only → stored as `T12:00:00Z` UTC-noon, same pinning trick as `buildExpenseRow`). |
| 9 | `normalized_date` | string `YYYY-MM-DD` | no | Calendar day in Asia/Jerusalem. Drives col A. |
| 10 | `month` | string `YYYY-MM` | no | Derived from `normalized_date` **by string slicing, never via `new Date()`** (TZ bug fixed 2026-06-03). Drives col B SUMIFS. |
| 11 | `year` | integer | no | Derived, e.g. `2026`. |
| 12 | `amount` | number | no | Always **positive**; sign lives in `direction`. Original currency units. |
| 13 | `currency` | string ISO-4217 / token symbol | no | `"ILS"`, `"USD"`, `"EUR"`, or crypto token symbol (`"ETH"`, `"USDT"`). |
| 14 | `amount_ils` | number | no | Amount converted to ILS at `fx_rate`. Equals `amount` when currency=ILS (fx_rate=1). |
| 15 | `fx_rate` | object | yes | `{ rate: number, source: string, timestamp: ISO-8601 }`. Null when currency=ILS. `source` e.g. `"_kfl_fxRate"` (bot cache), `"boi_daily"`, `"coingecko"`. Rate captured **at transaction time**, not import time, when the provider supplies it. |
| 16 | `direction` | enum `income\|expense\|transfer` | no | `transfer` = own-account movement; **never** counted in income/expense totals (§7). |
| 17 | `profile_type` | enum `personal\|business\|family\|project\|unknown` | no | Which ledger context. `unknown` allowed only while `needs_review=true`. |
| 18 | `business_id` | string | yes | Required iff `profile_type=business` and the user has >1 business (maps to the "מאזן <name>" per-business dashboard). |
| 19 | `project_id` | string | yes | Optional project tag (`profile_type=project`). |
| 20 | `counterparty` | string | yes | The other party when known and not a merchant: employer name, customer name, "עצמי" for transfers. |
| 21 | `merchant_name_raw` | string | yes | Verbatim merchant/descriptor from the source, bidi marks stripped. |
| 22 | `merchant_name_normalized` | string | yes | Canonical merchant per pipeline in §3. |
| 23 | `category` | string | no | Top-level category (col D vocabulary from `lib/categories.js`, e.g. `"אישי"`, `"עסק"`). |
| 24 | `subcategory` | string | yes | Dashboard row label (col E), **canonicalized** via `normalizeSubcategoryForDashboard` semantics so SUMIFS pick it up. |
| 25 | `category_group` | string | yes | Pa'amonim section: `"הכנסות" \| "קבועות" \| "משתנות" \| "מזון" \| "תחבורה" \| "שונות" \| "עסקי"`. |
| 26 | `payment_method` | enum `cash\|card\|bank_transfer\|bit\|paybox\|check\|paypal\|crypto\|standing_order\|other` | yes | Aligns with `lib/invoice.js` payment-method codes where applicable. |
| 27 | `card_last4` | string `\d{4}` | yes | Only last 4. Never more (§8). |
| 28 | `bank_account_last4` | string `\d{4}` | yes | Last 4 of account number. Never branch+full account, never IBAN. |
| 29 | `crypto_chain` | string | yes | `"ethereum"`, `"bitcoin"`, `"solana"`, `"tron"`… |
| 30 | `crypto_wallet` | string | yes | **Masked**: first 4 + last 4 chars, e.g. `"0xAb…c9F2"` (§8). |
| 31 | `crypto_token` | string | yes | Token symbol (`"ETH"`, `"USDC"`); contract address NOT stored here. |
| 32 | `crypto_tx_hash` | string | yes | Full tx hash is allowed (public-chain data, not a secret), lowercase hex. |
| 33 | `description` | string | no | User-facing narration (col F). Max 500 chars, `sanitizeCell`-style sanitized. |
| 34 | `original_raw_data` | object | yes | Source row/payload snapshot. **Retention-limited: 90 days**, then field is nulled; masking rules of §8 apply BEFORE storing (raw PANs/IBANs are masked at ingestion, never persisted). |
| 35 | `confidence_score` | number 0–1 | no | Classifier confidence for category+direction+profile. Bot exact-keyword hit = 1.0; AI fallback ≤ 0.85; CSV heuristic ≤ 0.7. |
| 36 | `needs_review` | boolean | no | True when `confidence_score < 0.8`, `profile_type=unknown`, or `duplicate_status=probable_dup`. Drives the inbox queue (§6). |
| 37 | `user_confirmed` | boolean | no | User explicitly confirmed (bot reply / web tap). Confirmation sets `confidence_score=1.0`, `needs_review=false`. |
| 38 | `duplicate_status` | enum `unique\|auto_linked\|probable_dup\|user_split` | no | `auto_linked` = idempotency-key hit, silently linked to existing txn; `probable_dup` = fuzzy match (same day ±1, same amount, similar merchant) awaiting user; `user_split` = user said "keep both / it's a split". |
| 39 | `reconciliation_status` | enum `unreconciled\|matched\|partially_matched\|manual` | no | Cross-source matching (e.g. card txn ↔ bank debit ↔ invoice). Default `unreconciled`. |
| 40 | `created_at` | string ISO-8601 | no | Record creation in Kesefle. |
| 41 | `updated_at` | string ISO-8601 | no | Last mutation. |
| 42 | `audit_log_id` | string | yes | Pointer to the audit-log entry that created/last-modified this record. |

### Example A — bot expense (WhatsApp, today's main path)

```json
{
  "transaction_id": "0190a3f2-7c11-7e22-9b01-aa12bc34de56",
  "user_id": "1098...masked...sub",
  "source_type": "bot",
  "provider_name": "whatsapp",
  "provider_account_id": null,
  "external_transaction_id": null,
  "idempotency_key": "8f1c…64-hex…b2a0",
  "original_timestamp": "2026-06-11T09:14:02+03:00",
  "normalized_date": "2026-06-11",
  "month": "2026-06",
  "year": 2026,
  "amount": 84.9,
  "currency": "ILS",
  "amount_ils": 84.9,
  "fx_rate": null,
  "direction": "expense",
  "profile_type": "personal",
  "business_id": null,
  "project_id": null,
  "counterparty": null,
  "merchant_name_raw": "שופרסל דיל חולון 247*",
  "merchant_name_normalized": "שופרסל",
  "category": "אישי",
  "subcategory": "קניות סופר",
  "category_group": "מזון",
  "payment_method": "card",
  "card_last4": "8821",
  "bank_account_last4": null,
  "crypto_chain": null, "crypto_wallet": null, "crypto_token": null, "crypto_tx_hash": null,
  "description": "84.9 שופרסל",
  "original_raw_data": { "message": "84.9 שופרסל", "wa_msg_id": "wamid.****" },
  "confidence_score": 1.0,
  "needs_review": false,
  "user_confirmed": false,
  "duplicate_status": "unique",
  "reconciliation_status": "unreconciled",
  "created_at": "2026-06-11T06:14:03Z",
  "updated_at": "2026-06-11T06:14:03Z",
  "audit_log_id": "alog_0190a3f2"
}
```

### Example B — crypto transfer between own wallets (never income/expense, §7)

```json
{
  "transaction_id": "0190a4c0-1111-7abc-8def-001122334455",
  "user_id": "1098...masked...sub",
  "source_type": "crypto",
  "provider_name": "ethereum",
  "provider_account_id": "0xAb…c9F2",
  "external_transaction_id": "0x9e4f…tx-hash…77aa",
  "idempotency_key": "c41d…64-hex…9e02",
  "original_timestamp": "2026-06-10T21:40:11Z",
  "normalized_date": "2026-06-11",
  "month": "2026-06",
  "year": 2026,
  "amount": 0.5,
  "currency": "ETH",
  "amount_ils": 6120.0,
  "fx_rate": { "rate": 12240.0, "source": "coingecko", "timestamp": "2026-06-10T21:40:11Z" },
  "direction": "transfer",
  "profile_type": "personal",
  "counterparty": "עצמי",
  "merchant_name_raw": null,
  "merchant_name_normalized": null,
  "category": "העברות",
  "subcategory": "העברה בין ארנקים",
  "category_group": null,
  "payment_method": "crypto",
  "card_last4": null, "bank_account_last4": null,
  "crypto_chain": "ethereum",
  "crypto_wallet": "0xAb…c9F2",
  "crypto_token": "ETH",
  "crypto_tx_hash": "0x9e4f…77aa",
  "description": "העברה לארנק קר",
  "original_raw_data": null,
  "confidence_score": 0.95,
  "needs_review": false,
  "user_confirmed": true,
  "duplicate_status": "unique",
  "reconciliation_status": "matched",
  "created_at": "2026-06-11T06:30:00Z",
  "updated_at": "2026-06-11T06:31:10Z",
  "audit_log_id": "alog_0190a4c0",
  "business_id": null, "project_id": null
}
```

---

## 2. Idempotency key — exact recipes

`idempotency_key = sha256(utf8(parts.join("|")))` hex-lowercase. Parts are
NFC-normalized, bidi control chars stripped.

**Primary recipe (provider supplies a stable external id):**

```
sha256( user_id + "|" + provider_name + "|" + external_transaction_id )
```

**Fallback recipe (CSV/import rows with NO external id):**

```
sha256( user_id + "|" + provider_name_or_"import" + "|" + normalized_date
        + "|" + amount.toFixed(2) + "|" + currency
        + "|" + merchant_name_normalized_or_description_lowercased
        + "|" + row_fingerprint )
```

where `row_fingerprint = sha256(raw CSV row text, trimmed, bidi-stripped)`
truncated to 16 hex chars. The fingerprint disambiguates two genuinely
identical purchases on the same day (two ₪6 coffees) **within one file**,
while re-importing the same file still collides → `duplicate_status=auto_linked`.

**Bot/manual recipe:** the WhatsApp message id (or web request id) is the
external id: `sha256(user_id + "|whatsapp|" + wa_msg_id)`. Retry of the same
webhook can never double-write.

Rule: **ingestion MUST check the key before any sheet write.** On collision:
do not write; record `duplicate_status=auto_linked` pointing at the original.
This generalizes the csv-import dedup tuple (date+amount+description) into a
single cross-source mechanism.

---

## 3. Merchant normalization pipeline (Hebrew + English)

Apply in order to `merchant_name_raw` → `merchant_name_normalized`:

1. **Unicode hygiene** — NFC normalize; strip bidi/direction marks (U+200E/F,
   U+202A–E, U+2066–69); collapse whitespace. (Same as `lib/bank-parsers.js`.)
2. **Strip decorators** — asterisks, trailing `*`/`#`, quotes, parenthesized
   trailers like `(הוראת קבע)`.
3. **Strip transaction numbers / branch numbers** — trailing standalone digit
   groups of 2–6 digits (`247`, `0153`), and `סניף \d+` / `BR\d+`.
4. **Strip city/location suffixes** — trailing token matching a known Israeli
   city list (חולון, ת"א, תל אביב, ירושלים, חיפה, ב"ש, ראשל"צ …) including
   common abbreviations.
5. **Strip chain-format noise words** — trailing `בע"מ`, `LTD`, `INC`,
   `אינטרנט`, `ONLINE`, payment-rail prefixes (`PAYPAL *`, `GOOGLE *`,
   `APPLE.COM/BILL`).
6. **Canonical alias table** (per-language, append-only):
   `"שופרסל דיל" → "שופרסל"`, `"AM:PM" → "AM PM"`, `"WOLT TLV" → "Wolt"`.
   Per-user learned aliases (from corrections) take precedence over global.
7. **Casefold English**, keep Hebrew as-is.

Worked example: `"שופרסל דיל חולון 247*"` → strip `*` → strip `247` →
strip `חולון` → alias `שופרסל דיל`→`שופרסל` → **`"שופרסל"`**.
English: `"PAYPAL *NETFLIX 402-93" → "Netflix"`.

Normalization is for **matching and display grouping only**; `merchant_name_raw`
is preserved (subject to §8 masking) so normalization bugs are recoverable.

---

## 4. Derivation + validation rules

- `month`/`year` derive from `normalized_date` by **string slicing** — never a
  `Date` round-trip (the 2026-06-03 TZ lesson in `buildExpenseRow`).
- `amount > 0` always; importers seeing negative/parenthesized amounts set
  `direction` instead (bank parsers already emit `isIncome`).
- `amount_ils = round(amount * fx_rate.rate, 2)`; invariant checked at write.
- `direction=transfer` ⇒ excluded from every income/expense aggregate (§7).
- `profile_type=business` ⇒ `category="עסק"` family; `business_id` resolved
  against the user's business list (multi-business routing).

---

## 5. Phase-1 mapping: universal record → existing 8/9-col תנועות row

Target is exactly `buildExpenseRow` output (`lib/sheet-writer.js`), so Phase 1
needs **no sheet migration** — UTS is a KV-side superset; the sheet stays the
user-facing ledger.

| Sheet col | Header | UTS source | Notes |
|---|---|---|---|
| A | תאריך | `normalized_date` rendered as `T12:00:00.000Z` ISO | UTC-noon pinning, identical to current writer. |
| B | חודש | `month` | String-sliced `YYYY-MM`; the SUMIFS bucket key. |
| C | סכום | `amount_ils` | **Always ILS** — the sheet is an ILS ledger. FX detail stays in KV. Positive number; sign separation is col H. |
| D | קטגוריה | `category` | Existing vocabulary (`lib/categories.js`). |
| E | תת-קטגוריה | `subcategory` | Already canonicalized to a dashboard row label. |
| F | פירוט | `description` (+ ` [<currency> <amount>]` suffix when currency≠ILS, e.g. `"מנוי SaaS [USD 29.00]"`) | Keeps FX visible to the user without new columns. |
| G | מקור | from `source_type`/`provider_name`: bot→`"whatsapp"`, import/bank→`"ייבוא CSV"`, processor→provider slug, crypto→`"קריפטו"`, manual→`"ידני"` | Matches existing values so nothing downstream breaks. |
| H | סטטוס | `direction === "income" ? FALSE : TRUE` — i.e. **col H = !isIncome**, real boolean | Load-bearing for the 2026-06-03 dashboard sign fix. |
| I | ניכוי מע״מ | `vat_deductible` extension flag (default FALSE) | Side-channel for `/api/sheet/tax-report`; optional. |

**Transfers (`direction=transfer`) are NOT written to תנועות at all** in
Phase 1 — they exist only in KV (and a future "העברות" view). Writing them
would corrupt dashboard totals (§7).

---

## 6. KV key design (Upstash, no SQL)

| Key | Type | Value | TTL |
|---|---|---|---|
| `txn:{sub}:{transaction_id}` | string (JSON) | Full UTS record | none (but `original_raw_data` nulled after 90d by cron) |
| `txnidx:{sub}:{yyyy-mm}` | set (or JSON array) | `transaction_id`s for that month — the month index dashboards/exports iterate | none |
| `txnkey:{sub}:{idempotency_key}` | string | `transaction_id` — O(1) dedup lookup before write | none |
| `inbox:{sub}` | list (JSON ids) | `transaction_id`s with `needs_review=true`, FIFO review queue surfaced via bot ("יש 3 תנועות לבדיקה") and web | none; entries removed on confirm/dismiss |

Write order (crash-safe): `txnkey` SETNX → `txn` SET → `txnidx` add →
(if needs_review) `inbox` push → sheet append → audit log. SETNX failing =
duplicate → stop, link. UUIDv7 ids keep per-month listing chronologically
sorted without an extra sort field.

---

## 7. Crypto rules

1. **Own-wallet transfers are NEVER income or expense.** If both sides of a
   tx belong to wallets the user registered, `direction=transfer`,
   `counterparty="עצמי"`, excluded from all P&L; never written to תנועות (§5).
2. **Token amount + ILS valuation at tx time**: store `amount` in token units,
   `currency` = token symbol, and `amount_ils` via `fx_rate` captured with the
   tx's `original_timestamp` (token→USD→ILS allowed; record composed source,
   e.g. `"coingecko+boi_daily"`). Valuation is informational, not tax advice.
3. **Separate profile**: crypto activity defaults to its own profile/view
   (`category="קריפטו"` or the dedicated profile) and never silently mixes
   into personal/business dashboards; only an explicit user action (e.g. "this
   ETH payment was business revenue") reclassifies it with
   `user_confirmed=true`.
4. On-ramp/off-ramp (exchange ⇄ bank) appears twice (bank leg + crypto leg);
   reconciliation links them (`reconciliation_status=matched`) and only the
   fiat leg counts in fiat dashboards.

---

## 8. Masking rules (apply at ingestion, before ANY persistence)

- **Cards**: store `card_last4` only. Full/partial PAN beyond last 4 is never
  persisted, logged, or kept inside `original_raw_data` (masked to `****8821`
  pre-storage).
- **Bank accounts**: `bank_account_last4` only; never full account number,
  branch+account combo, or IBAN. IBANs in raw data → `IL** **** … 4312`.
- **Crypto wallets**: display/store masked `first4…last4` in `crypto_wallet`
  and `provider_account_id`. The full address may exist only in the user's
  own wallet-registration record (needed for §7 own-transfer detection), never
  duplicated per-transaction. `crypto_tx_hash` is public-chain data — allowed.
- **Credentials/tokens**: never in any UTS field; refresh tokens remain
  AES-256-GCM envelopes per `lib/crypto.js` — UTS holds no auth material.
- **Logs**: follow the existing bank-parser stance — log counts/skip-reasons,
  never amounts+descriptions together with identifiers.
- **`original_raw_data`**: masked at ingestion (rules above), retention 90
  days, excluded from analytics, included in GDPR export, purged on deletion.

---

## 9. Versioning

Records carry an implicit `schema_version` via the KV envelope (`"uts": 1`).
Additive changes only within v1; renames/retypes require v2 + a
`migration-pattern` dual-read window.
