# Transaction Reconciliation Model — Manual Entries vs Bank/Card Imports

Status: DESIGN ONLY (no implementation, no live integrations).
Date: 2026-06-11
Builds on: `lib/sheet-writer.js` (A:H ledger + col I VAT), `api/sheet/csv-import.js`,
`lib/bank-parsers.js`, `lib/categories.js`, Upstash KV, WhatsApp bot (Apps Script, `_kfl_fxRate`).

---

## 1. Core scenario

A user texts the bot: **"35 קפה"**. The bot writes a תנועות row immediately:
`A=2026-06-08, B=2026-06, C=35.00, D=אוכל בחוץ, E=בתי קפה, F=קפה, G=WhatsApp, H=TRUE`.

Four days later the user uploads their Isracard CSV. The import contains:
`08/06/2026, ₪34.90, קפה גרג בע"מ ת"א`.

Today `csv-import.js` dedups only on the exact tuple (date + amount + description), so
`35 ≠ 34.90` and `"קפה" ≠ "קפה גרג בע"מ"` → **both rows land in the ledger and every
dashboard SUMIFS double-counts the coffee.** This document defines how the system catches
that pair, links it, keeps ONE ledger row, and asks the user only when genuinely unsure.

Why this matters now: manual WhatsApp entry is the activation hook; CSV import is the
catch-up tool. Users who use both (the users we want most) currently get inflated expense
totals, which destroys trust in the dashboard — the one thing Kesefle sells.

### 1.1 Identity prerequisite: row UID (col J)

The sheet has no row identity, so reconciliation needs one:

- New column **J: מזהה** — opaque UID `kfl_<10-char base32>`, written by the bot and by
  csv-import on every new row. Hidden column; users never touch it.
- A KV reconciliation index per user-month:
  `recon:idx:{userSub}:{YYYY-MM}` → list of `{uid, dateISO, amount, source, catKey, descHash}`.
  Amounts/descriptions live ONLY as values + SHA-256 hash of normalized description
  (privacy: same rule as bank-parsers — never log raw descriptions).
- Legacy rows (pre-UID) are fingerprinted lazily on first import touching their month:
  `fp = sha256(userSub|date|amount|descNormalized)` and assigned a UID in col J.

---

## 2. Matching algorithm

Two stages: cheap **blocking** to find candidates, then **scoring** to decide.

### 2.1 Blocking key

A new row (from either side) is compared only against rows where ALL of:

| Block dimension | Rule |
|---|---|
| User | same `userSub` (tenant isolation invariant — never cross) |
| Direction | same col H (expense vs income never match) |
| Amount | `|a1 − a2| ≤ max(1 ILS, 2% × max(a1,a2))` after FX normalization (§3.5) |
| Date | within ±4 calendar days (covers card posting lag; ±3 scoring window + 1 slack) |
| Source asymmetry | one side `G ∈ {WhatsApp}` (manual), other side `G ∈ {ייבוא CSV, בנק}` (import). Import-vs-import pairs use exact-dup logic only (§7 case 8). |

Blocking reads `recon:idx:{userSub}:{YYYY-MM}` for the row's month ± adjacent month
(date windows cross month boundaries). Typical candidate set: 0–3 rows.

### 2.2 Scoring (0.0 – 1.0)

`score = w_amount + w_date + w_merchant + w_uniqueness`

| Component | Max | Rules |
|---|---|---|
| Amount | 0.45 | exact match = 0.45; manual-side **round-number tolerance**: manual is integer and `|manual − import| ≤ max(1 ILS, 2%)` = 0.40; within 2%/1 ILS otherwise = 0.32; outside = blocked anyway |
| Date | 0.25 | same day = 0.25; ±1d = 0.20; ±2d = 0.14; ±3d = 0.08; ±4d = 0.03 |
| Merchant/category compatibility | 0.20 | import description maps (via `lib/categories.js` keyword table) to the SAME category as the manual row's col D = 0.20; same top-level group = 0.12; unknown merchant (no keyword hit) = 0.10 (neutral); CONTRADICTORY mapping (e.g. import says דלק, manual says מסעדה) = 0.00 |
| Uniqueness | 0.10 | only candidate in block = 0.10; 2 candidates = 0.05; ≥3 = 0.00 |

**Manual-vs-import asymmetry, by design:** manual entries are sparse ("קפה", no merchant)
and rounded ("35" for 34.90). The scoring therefore (a) treats an integer manual amount
within tolerance as a near-exact match, (b) lets a bare manual description score neutral
on merchant rather than penalizing it, and (c) never requires description similarity —
category compatibility stands in for it.

### 2.3 Decision thresholds

| Score | Decision | Action |
|---|---|---|
| ≥ 0.90 | `auto_link` | merge silently (§4), one-line bot notice, undoable |
| 0.60 – 0.89 | `needs_review` | queue + bot confirmation (§5); rows stay UNMERGED until answered |
| < 0.60 | `distinct` | both rows stand; no user interruption |

Ties: if two candidates both score ≥ 0.90, downgrade BOTH to `needs_review` (never
auto-pick between twins — e.g. two 35 ILS coffees on the same day are common).

---

## 3. Special rules (run BEFORE generic scoring)

### 3.1 Card-to-bank settlement = transfer, not expense
A bank-statement debit whose description matches a card-issuer pattern
(`ישראכרט|מקס|כאל|לאומי קארד|אמריקן אקספרס|VISA|חיוב כרטיס`) and whose amount ≈ the sum of
that card's transactions in the billing cycle is classified **העברה (transfer)** — written
with category `העברות פנימיות`, excluded from expense SUMIFS (col H rule: transfers get a
dedicated marker, proposed `H=TRANSFER` literal alongside TRUE/FALSE — dashboard formulas
filter `H=TRUE` so transfers fall out automatically). It must NEVER pair-match against an
individual card expense (amount magnitude alone could collide on small cycles).

### 3.2 Own-wallet crypto moves = transfer
If both legs exist in the ledger (e.g. exchange withdrawal −0.05 BTC equivalent, wallet
deposit +0.05 BTC equivalent, opposite signs, amount within 2% after FX/fee tolerance,
within 2 days) → link as `self_transfer`, both legs marked העברות פנימיות. The fee delta
(network fee) MAY be split out as a real expense row — needs_review prompt offers this.

### 3.3 Installments (תשלומים)
Card imports show `תשלום k מתוך N` rows of `total/N`. Manual entry is usually the TOTAL
("1200 מקרר"). Rule: if a manual amount ≈ N × import amount for N ∈ 2..36 and the import
description carries an installment marker, link the manual row to the installment GROUP
(`recon:grp:{userSub}:{uid}` lists all N child UIDs as they arrive month by month).
Ledger keeps the per-month installment rows (cash-flow truth); the manual total row is
absorbed into the group, not summed.

### 3.4 Standing orders (הוראת קבע)
Same merchant hash + same amount (±2%) recurring monthly ±3 days = recurring series.
Series members never match manual one-offs of similar amounts UNLESS same-month + amount
within tolerance (then normal scoring applies). Series metadata: `recon:rec:{userSub}:{seriesId}`.

### 3.5 FX normalization
Imports in USD/EUR are converted to ILS with the bot's `_kfl_fxRate` (rate AS OF the
transaction date, not import date) before amount blocking. FX tolerance widens to **3%**
(rate drift between authorization and settlement). Original currency+amount preserved in
the audit record.

---

## 4. Merge behavior

A confirmed link (auto or user-approved) keeps **ONE ledger row**:

| Field | Winner | Why |
|---|---|---|
| A date, C amount | **import** | bank precision beats memory (34.90 over 35) |
| D category, E subcategory | **manual** | user intent beats keyword guessing |
| F description | **manual**, import merchant appended in parens: `קפה (קפה גרג בע"מ)` | keep intent, keep evidence |
| G source | `מאוחד` (merged) | dashboard can count merged rows |
| H, I | manual (user may have set VAT flag deliberately) | |
| J UID | surviving row keeps its UID; absorbed UID recorded in audit | |

Mechanics: the import row is UPDATED in place with manual D/E/F/H/I; the manual row is
DELETED from תנועות — but its full 9-column snapshot is stored first in
`recon:audit:{userSub}:{linkId}` (KV, 24-month TTL) together with the pre-merge snapshot
of the surviving row, scores, decision type, and actor (`auto` | `user` | `admin`).

**Unmerge** (`בטל איחוד` via bot, or admin): restore the absorbed row from the snapshot,
revert the surviving row's overwritten fields, mark the pair `user_distinct` so the same
pair is never re-suggested. Every merge/unmerge/confirm/reject appends an audit event —
nothing is ever silently destroyed (aligns with the financial-data-integrity guard:
backup-first, reversible, logged).

Idempotency: re-importing the same CSV finds the import-side fingerprint already in
`recon:idx` → row skipped at import (existing dedup), so no second merge cycle fires.

---

## 5. User confirmation flow (bot, Hebrew)

Trigger: a `needs_review` pair is created during import. After the import summary message,
the bot sends one message per pair (max 3 per import; the rest drain via `יש לי שאלות` /
the daily digest):

```
יכול להיות כפילות? 🤔
רשמת אצלי: 35 ש״ח – קפה (8.6)
בדף הבנק: 34.90 ש״ח – קפה גרג בע״מ (8.6)
זו אותה הוצאה?
```

WhatsApp interactive buttons (Meta Cloud API `interactive.button`, already used by the
bot's menu flows):

| Button | id | Effect |
|---|---|---|
| ✅ אותה הוצאה | `recon_same:{linkId}` | merge per §4, reply: `מעולה, איחדתי. נשארה שורה אחת של 34.90 ש״ח ✅` |
| ❌ הוצאה אחרת | `recon_diff:{linkId}` | mark `user_distinct`, both rows stand, never re-ask |
| 🕐 אחר כך | `recon_later:{linkId}` | stays in queue; resurfaces in next digest |

Auto-link notice (score ≥ 0.90) is one line, fire-and-forget:
`איחדתי כפילות: "קפה" מ-8.6 הופיעה גם בדף הבנק (34.90 ש״ח). לביטול: בטל איחוד`.
Unanswered `needs_review` pairs expire to `distinct` after 14 days (never auto-merge on
silence — double-count is more visible and more fixable than a silently eaten expense...
actually the opposite: silence keeps BOTH rows, i.e. the conservative, visible state).

---

## 6. Confidence scoring table (worked examples)

| # | Manual | Import | Amount | Date | Merchant | Uniq | Score | Decision |
|---|---|---|---|---|---|---|---|---|
| 1 | 35 קפה 8.6 | 35.00 קפה גרג 8.6 | 0.45 | 0.25 | 0.20 | 0.10 | 1.00 | auto_link |
| 2 | 35 קפה 8.6 | 34.90 קפה גרג 8.6 | 0.40 | 0.25 | 0.20 | 0.10 | 0.95 | auto_link |
| 3 | 35 קפה 8.6 | 34.90 קפה גרג 10.6 | 0.40 | 0.14 | 0.20 | 0.10 | 0.84 | needs_review |
| 4 | 200 מסעדה 5.6 | 198.50 unknown 7.6 | 0.40 | 0.14 | 0.10 | 0.10 | 0.74 | needs_review |
| 5 | 35 קפה 8.6 | 34.50 דלק פז 8.6 | 0.40 | 0.25 | 0.00 | 0.10 | 0.75 | needs_review |
| 6 | 35 קפה 8.6 | 34.90 קפה; second 35.00 קפה same day | — | — | — | tie | both ≥0.9→demoted | needs_review ×2 |
| 7 | 50 מתנה 1.6 | 50.00 unknown 5.6 | 0.45 | 0.03 | 0.10 | 0.10 | 0.68 | needs_review |
| 8 | 120 ביגוד 1.6 | 89.00 H&M 1.6 | blocked (>2%) | — | — | — | — | distinct |

---

## 7. Test plan — 12 concrete cases

Suite: `tests/test_reconciliation.js` (pure-logic, no network, per repo test pattern).

| # | Case | Input | Expected |
|---|---|---|---|
| 1 | Exact dup | manual 35.00 קפה 08/06 + import 35.00 "קפה גרג" 08/06 | score 1.00 → auto_link; one row; C=35.00; D/E from manual; F=`קפה (קפה גרג בע"מ)`; audit event written |
| 2 | Fuzzy amount (rounding) | manual 35 + import 34.90, same day, compatible category | score 0.95 → auto_link; surviving C=34.90 |
| 3 | Cross-day | manual 35 on 08/06 + import 34.90 on 11/06 | score ≈0.78 → needs_review; NO merge until user answers; both rows present meanwhile |
| 4 | Installment | manual "1200 מקרר" + import "תשלום 1 מתוך 12" 100.00 | installment rule: link manual→group; ledger shows 100/month rows; manual total absorbed; month total +100 not +1300 |
| 5 | Card settlement transfer | bank import "חיוב ישראכרט" 4,231.77 ≈ sum of cycle's card rows | classified transfer (H=TRANSFER, D=העברות פנימיות); expense SUMIFS unchanged; NOT matched to any single card row |
| 6 | Crypto self-transfer | exchange −0.05 BTC (≈6,300 ILS) 09/06 + wallet +0.0498 BTC 10/06 | self_transfer link; both legs העברות פנימיות; fee delta (~25 ILS) offered as expense via needs_review |
| 7 | FX | manual "35 דולר קפה" + import $34.80 (USD), `_kfl_fxRate` 3.65 as of txn date | both normalized via same date-rate; amount delta 0.57% < 3% FX tolerance → auto_link; original USD kept in audit |
| 8 | Double-import idempotency | same CSV uploaded twice | second run: every row hits existing fingerprint in `recon:idx` → 0 new rows, 0 new links, 0 new bot messages |
| 9 | User says different (split) | needs_review pair, user taps ❌ הוצאה אחרת | pair marked `user_distinct`; both rows remain; re-import of same CSV does NOT re-ask |
| 10 | Unmerge | after case 2, user sends `בטל איחוד` | manual row restored from snapshot (35.00, original D/E/F); import row's overwritten fields reverted; pair marked `user_distinct`; 2 audit events total |
| 11 | Recurring standing order | "הוראת קבע חשמל" 412.30 on 2nd ±3d for 3 months + manual one-off "400 חשמל" in month 4 | months 1–3 form series, no prompts; month-4 manual vs month-4 series row → normal scoring (≈0.79) → needs_review, asked ONCE |
| 12 | Queue drain | import creates 7 needs_review pairs | exactly 3 bot prompts sent; remaining 4 in `recon:queue:{userSub}`; `יש לי שאלות` drains 3 more; 14-day expiry resolves leftovers to distinct with audit reason `expired` |

Pass criteria: all 12 green; golden-set classifier suite unaffected; no raw descriptions
or amounts in any log line (mask as `len=N hash=xxxx…`); all examples in code/tests use
masked identifiers (`9725XXXXXXX`, `userSub: 1182…masked`).

---

## 8. Open questions (for Steven, before any build)

1. `H=TRANSFER` third state vs a separate col-K flag — needs a dashboard-formula impact check (`kesefle-formula-validator`).
2. Max prompts per import (3?) and digest cadence for queue drain.
3. Should auto_link be OFF for the first 2 weeks (everything ≥0.6 goes to needs_review) to calibrate thresholds on real user data (~10 users — cheap to review)?
