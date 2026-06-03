# Bot classifier improvements — sign-flip hunt (2026-06-02)

Replayed a realistic 45-message Hebrew corpus through the REAL classifier via
`bot/bot-replay.js` (`matchCategory` + `BUSINESS_CATEGORY_MAP` + `CATEGORY_MAP`,
no mocks, no live writes), looking specifically for income/expense SIGN-FLIPS:
the most damaging class of bug because it silently corrupts the company P&L
(revenue counted as cost, or a cost counted as revenue) and the dashboard nets.

This document records each GENUINE misroute the corpus surfaced and the EXACT
additive keyword fix to apply later. It is intentionally NON-destructive: the
fixes only ADD keywords / one map row, never remove or re-order existing ones.

**Why the bot source is not touched in this PR:** a separate change is already
pending in `bot/ExpenseBot_FIXED.gs` / `bot/ExpenseBot_DEPLOY.gs`. Editing those
files here would create a merge conflict. So this PR ships only the measurement
layer: the documented fixes + the expanded `tests/golden_set.js` guard anchors.
Apply the fixes below in the same change that resolves the pending edit, then
un-comment the paired golden anchors (section "Anchors to add when fixed").

All fixes below were simulated against a scratch copy of the bot: each resolves
its misroute, every regression guard still passes, and the full golden set holds
at 96.3% (206/214) with ZERO regressions.

---

## Corpus result summary

| bucket | count |
|---|---|
| messages replayed | 45 |
| correctly routed (category + sign) | 39 |
| GENUINE sign-flip misroutes (fix prescribed) | 4 |
| tricky personal refunds (ASK, not auto-flip — deliberately NOT fixed) | 2 |
| parser-path (not a classifier issue — out of scope) | 1 |

The 18 currently-correct income / expense / installment cases the corpus
exercised were anchored into `tests/golden_set.js` this cycle so their polarity
can never silently regress (see the "2026-06-02 SIGN-FLIP" block there).

---

## GENUINE misroutes + exact fixes

### Misroute 1 + 2 — business-prefixed VAT refund booked as an operating expense

- Inputs: `עסק החזר מעמ 900`, `עסק תמונות החזר מעמ 1200`
- Today routes to: `עסק / הוצאות תפעוליות` **[expense]**  ← SIGN FLIP
- Correct: `עסק / מחזור` **[income]** (a VAT refund is revenue coming in)

Root cause: when a message carries the business prefix (`עסק` / `בעסק` ...),
`matchCategory` consults ONLY `BUSINESS_CATEGORY_MAP` (the `hasBusinessPrefix`
branch), NOT the global `CATEGORY_MAP`. The previous cycle added the no-geresh
form `"החזר מעמ"` to the `CATEGORY_MAP` income row (line ~633) only, so the plain
`החזר מעמ 900` routes income — but the business-prefixed variant misses it and
falls through to the branch default `{category:"עסק", subcategory:"הוצאות
תפעוליות", isIncome:false}`. The `BUSINESS_CATEGORY_MAP` `מחזור` row carries the
geresh form `"החזר מע\"מ"` but not the no-geresh `"החזר מעמ"`.

**Fix A** — `bot/ExpenseBot_FIXED.gs`, the `BUSINESS_CATEGORY_MAP["עסק"]["מחזור"]`
array (currently the only line containing `"מע\"מ החזר", "החזר מע\"מ", "החזר מס"]`).
Add the no-geresh + VAT-credit forms right before `"החזר מס"`:

Replace:

    "מע\"מ החזר", "החזר מע\"מ", "החזר מס"]

with:

    "מע\"מ החזר", "החזר מע\"מ", "החזר מעמ", "מעמ החזר", "זיכוי מעמ", "זיכוי מע\"מ", "החזר מס"]

(All four are length > 3, so they match as substrings and Hebrew prefixes still
work; they are revenue synonyms, so income polarity is correct.)

### Misroute 3 — VAT *credit* ("זיכוי מע"מ") booked as an operating expense

- Input: `זיכוי מעמ 450`
- Today routes to: `עסק / הוצאות תפעוליות` **[expense]**  ← SIGN FLIP
- Correct: `עסק / מחזור` **[income]**

Root cause: `זיכוי` (credit) is the accountant's word for a refund, but neither
map's income (`מחזור`) row lists `"זיכוי מעמ"` / `"זיכוי מע\"מ"`. With no income
hit and no expense hit, it lands on the no-prefix path's fallthrough into the
business default expense.

**Fix B** — `bot/ExpenseBot_FIXED.gs`, the `CATEGORY_MAP` income row
(`...,"subcategory":"מחזור","isIncome":true}` — the line that already contains
`"החזר מעמ","מעמ החזר"`). Add the two VAT-credit forms:

Replace:

    "החזר מעמ","מעמ החזר","מע\"מ החזר","החזר מע\"מ","מע״מ החזר","vat refund","tax refund"]

with:

    "החזר מעמ","מעמ החזר","זיכוי מעמ","זיכוי מע\"מ","מע\"מ החזר","החזר מע\"מ","מע״מ החזר","vat refund","tax refund"]

(Fix A already covers the business-prefixed `עסק זיכוי מעמ`; Fix B covers the
no-prefix `זיכוי מעמ`.)

### Misroute 4 — income-tax refund booked as a government TAX EXPENSE

- Input: `החזר מס 600`
- Today routes to: `ממשלה ומיסים / מיסי חברה - תאגידי וניהול` **[expense]** ← SIGN FLIP
- Correct: `הכנסות / החזר מס` **[income]**

Root cause + self-evidence: `"החזר מס"` (tax refund = money in) is listed as a
keyword on the GOVERNMENT-EXPENSE row (`category:"ממשלה ומיסים"`, the line
containing `"corporate tax","hahzer mas",...,"החזר מס","טופס 102"`). So a refund
is booked as a tax expense. The codebase's OWN LLM few-shot prompt disagrees and
gives the right answer — it teaches the model:

    "החזר מס" -> {"category":"הכנסות","subcategory":"החזר מס", ... "reason":"החזר ממס הכנסה"}

The deterministic matcher and the LLM contract contradict each other; the matcher
is wrong. A length tie (`"החזר מס"` is 7 chars on both the expense row and any
income row) is broken by ARRAY ORDER (V8's sort is stable), and the government
row sits earlier in `CATEGORY_MAP` than any income row — so simply adding
`"החזר מס"` to a later income row does NOT win. The additive, non-destructive fix
is to insert a dedicated income row at the TOP of `CATEGORY_MAP` (adds a row,
removes/re-orders nothing) so the income entry wins the tie:

**Fix C** — `bot/ExpenseBot_FIXED.gs`, immediately after `const CATEGORY_MAP = [`,
insert as the FIRST array element:

    {"keywords":["החזר מס הכנסה","החזר ממס הכנסה","מס הכנסה החזר","זיכוי מס","החזר מס"],"category":"הכנסות","subcategory":"החזר מס","isIncome":true},

This matches the LLM prompt's own label (`הכנסות / החזר מס`). Verified guard: a
tax PAYMENT is unaffected — `מס הכנסה 2000` and `מקדמות מס 900` still route to
`הוצאות קבועות / מיסים ואגרות` [expense], and `מס חברות 5000` still routes to the
government corporate-tax row. Only the *refund* phrasing flips to income.

---

## Deliberately NOT auto-fixed (documented, lower priority)

### Personal municipal-tax / insurance refunds — bot should ASK, not auto-flip

- Inputs: `החזר ארנונה 320`, `החזר ביטוח 450`
- Today routes to: `הוצאות קבועות / בית` and `.../ ביטוח` **[expense]**
- A refund IS income, BUT these are rare, personal, and genuinely ambiguous
  (could be a credit note that nets an upcoming bill, or true cash back).

Why not a broad fix: adding a generic `"החזר"` income keyword would mis-flip the
common OUTFLOWS `החזר חוב` / `החזר הלוואה` / `החזר משכנתא` (debt/loan repayments,
money going OUT) into income — a worse, more frequent sign-flip than the one it
fixes. The safe path is a future bot-side ASK flow ("האם זה החזר שקיבלת?") rather
than a deterministic keyword. Tracked here, not patched.

### `עסק חומרי גלם 1500` — parsed as an ORDER, not a classifier route (out of scope)

The corpus message `עסק חומרי גלם 1500` is captured by `parseBusinessOrder_`
(salePrice 1500, customer "חומרי גלם") BEFORE `matchCategory` runs, so it goes to
the `הזמנות` tab, not a `תנועות` category. That is the order-parser's behavior,
not a classifier keyword bug; changing it risks the order flow and is outside the
"additive keyword/regex" scope of this task. Noted for a separate look at whether
a bare `חומרי גלם` line (no customer/profit numbers) should prefer the expense
route over the order parser.

---

## Anchors to add when the fixes land

These 4 anchors FAIL on current source (the misroutes above) and are therefore
NOT yet active in `tests/golden_set.js` (it is a passing gate). The moment Fixes
A/B/C land in `bot/ExpenseBot_FIXED.gs`, add them to the `GOLDEN` array so the
corrected polarity is locked:

    // VAT refund with the business prefix -> revenue (Fix A)
    ['עסק החזר מעמ 900', 'sub:מחזור'],
    ['עסק תמונות החזר מעמ 1200', 'sub:מחזור'],
    // VAT credit (zicuy) -> revenue (Fix A + B)
    ['זיכוי מעמ 450', 'sub:מחזור'],
    // income-tax refund -> income, matching the LLM prompt (Fix C)
    ['החזר מס 600', 'הכנסות'],

## Reproduce

    node bot/bot-replay.js --json "עסק החזר מעמ 900"   # shows the current misroute
    node tests/golden_set.js                            # 214 anchors, 96.3%, must stay PASS
