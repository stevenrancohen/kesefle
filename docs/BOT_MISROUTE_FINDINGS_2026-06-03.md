# Bot classifier mis-route findings — National-Insurance allowance sign-flips (2026-06-03)

Replayed a fresh, realistic Hebrew corpus through the **REAL** classifier
(`matchCategory` + `_matchCategory_long` + `CATEGORY_MAP` + `BUSINESS_CATEGORY_MAP`,
loaded read-only via the house balanced-brace extraction used by
`bot/test_classify.js` + `tests/golden_set.js`, **no mocks, no live writes**),
hunting specifically for income/expense **SIGN-FLIPS** — the most damaging bug
class because it silently corrupts the personal/company P&L (money received
booked as money spent, or vice-versa).

This cycle found a **NEW** sign-flip class the prior hunt
(`bot/BOT_IMPROVEMENTS.md`, 2026-06-02) did not cover: **National-Insurance
allowances and other employer/state payments TO the user** — child allowance,
old-age / disability / survivors' pension, maternity pay, severance, reserve-duty
pay, discharge grant, income supplement, vacation-day cashout. Every one is
**money IN**, but the current keyword maps book them as a `ממשלה ומיסים`
**EXPENSE** (`col H = TRUE`).

This document is intentionally **NON-destructive**: the prescribed fix only ADDS
one `CATEGORY_MAP` row, never removes or re-orders an existing one. The bot file
is **off-limits in this PR** (it deploys manually via Apps Script paste, and a
separate edit is pending) — so this PR ships only the measurement layer: this
doc + the additive `tests/golden_set.js` regression guards. Apply the fix below
in the same change that re-pastes the bot, then un-comment the paired anchors in
the "Anchors to add when fixed" section.

The fix was **simulated against a scratch copy** of `bot/ExpenseBot_FIXED.gs`:
it resolves all 18 sign-flips, every regression guard still passes, and the full
golden set holds at **96.3% (210/218) with ZERO regressions** (identical miss
list before and after).

---

## Why these are genuine sign-flips (verified, not opinion)

The codebase's own authority is the LLM few-shot contract in
`bot/ExpenseBot_FIXED.gs` (~line 10683), which defines the income category as:

    הכנסות (משכורת, עצמאי, החזרים, בונוסים, מכירות)

and the government category as money you **pay**:

    ממשלה ומיסים (מס הכנסה, ביטוח לאומי, רישוי, קנסות, דמי גמל)

A National-Insurance **allowance** (קצבה), a **grant** (מענק), **maternity pay**
(דמי לידה), or **severance** (פיצויי פיטורין) is a payment **received** by the
user — income, not a government fee. The deterministic matcher contradicts the
contract; the matcher is wrong. (Because the keyword matcher runs FIRST and the
LLM is only a fallback for DEFAULT / low-confidence, these never reach the LLM —
so the deterministic mis-route is the live production behavior.)

---

## Corpus result summary

| bucket | count |
|---|---|
| messages replayed (this cycle) | 60+ |
| NEW genuine allowance/benefit sign-flips (fix prescribed) | 14 distinct phrases (18 inputs) |
| prior-cycle sign-flips re-confirmed still unfixed (see `bot/BOT_IMPROVEMENTS.md`) | 4 |
| bare refund/credit forms that correctly ASK (DEFAULT — NOT a misroute) | 6 |
| currently-correct adjacent cases anchored as guards this cycle | 20 |

---

## CONFIRMED current mis-routes + the EXACT additive fix

### Mis-route class — NI allowances / benefits booked as a government EXPENSE

All of the following route today to category `ממשלה ומיסים` with `isIncome:false`
(**col H = TRUE = expense**). Correct target: `הכנסות` (income, **col H =
FALSE**). Reproduce any line with:

    node bot/bot-replay.js --json "קצבת ילדים 500"

| input | today (WRONG) | should be |
|---|---|---|
| `קצבת ילדים 500` | `ממשלה ומיסים / ממשלה - מיסים, אגרות ודוחות` [expense] | `הכנסות` [income] |
| `קצבת זקנה 1800` | `ממשלה ומיסים / ממשלה - מיסים, אגרות ודוחות` [expense] | `הכנסות` [income] |
| `קצבת נכות 2500` | `ממשלה ומיסים / ממשלה - מיסים, אגרות ודוחות` [expense] | `הכנסות` [income] |
| `קצבת שאירים 3000` | `ממשלה ומיסים / ביטוח לאומי - קצבאות וניכויים מיוחדים` [expense] | `הכנסות` [income] |
| `קצבת הבטחת הכנסה 1500` | `ממשלה ומיסים / ביטוח לאומי - קצבאות וניכויים מיוחדים` [expense] | `הכנסות` [income] |
| `דמי לידה 8000` | `ממשלה ומיסים / ממשלה - מיסים, אגרות ודוחות` [expense] | `הכנסות` [income] |
| `מענק לידה 2000` | `ממשלה ומיסים / ביטוח לאומי - קצבאות וניכויים מיוחדים` [expense] | `הכנסות` [income] |
| `פיצויי פיטורין 30000` | `ממשלה ומיסים / ביטוח לאומי - קצבאות וניכויים מיוחדים` [expense] | `הכנסות` [income] |
| `פיצויי פרישה 50000` | `ממשלה ומיסים / ביטוח לאומי - קצבאות וניכויים מיוחדים` [expense] | `הכנסות` [income] |
| `פדיון ימי חופשה 4000` | `ממשלה ומיסים / ביטוח לאומי - קצבאות וניכויים מיוחדים` [expense] | `הכנסות` [income] |
| `מענק שחרור 12000` | `ממשלה ומיסים / ביטוח לאומי - קצבאות וניכויים מיוחדים` [expense] | `הכנסות` [income] |
| `תגמולי מילואים 2200` | `ממשלה ומיסים / ממשלה - מיסים, אגרות ודוחות` [expense] | `הכנסות` [income] |
| `השלמת הכנסה 1200` | `ממשלה ומיסים / ביטוח לאומי - קצבאות וניכויים מיוחדים` [expense] | `הכנסות` [income] |
| `מענק קורונה 6000` | `אוכל / אוכל לבית — יין ואלכוהול` [expense] **(also WRONG category)** | `הכנסות` [income] |

Note on the last row: `מענק קורונה` is a *double* bug — it substring-hits the
beer brand keyword `"קורונה"` (Corona, on the wine/alcohol row ~line 467) and is
filed under food/alcohol. The same fix corrects it (the added income phrase
`"מענק קורונה"` is longer than `"קורונה"`, so it wins the length sort).

#### Root cause

`_matchCategory_long` flattens `CATEGORY_MAP` into `(keyword, category, sub,
isIncome)` entries, **sorts by keyword length descending**, and the first
`_kflKwHit_` wins. The allowance phrases currently live ONLY on two
**government-EXPENSE** rows:

- line **555** — `category:"ממשלה ומיסים"`, `subcategory:"ממשלה - מיסים, אגרות
  ודוחות"` — holds `"קצבת ילדים"`, `"קצבת זקנה"`, `"קצבת נכות"`, `"דמי לידה"`,
  `"תגמולי מילואים"`, `"קצבת שאירים"`, ...
- line **556** — `category:"ממשלה ומיסים"`, `subcategory:"ביטוח לאומי - קצבאות
  וניכויים מיוחדים"` — holds `"מענק לידה"`, `"פיצויי פיטורין"`, `"פיצויי פרישה"`,
  `"פדיון ימי חופשה"`, `"השלמת הכנסה"`, `"קצבת הבטחת הכנסה"`, `"מענק שחרור"`, ...

There is **no income row** carrying these phrases, so they always resolve to the
expense row and inherit `isIncome:false`.

#### Fix — `bot/ExpenseBot_FIXED.gs`: add ONE income row at the TOP of `CATEGORY_MAP`

Same mechanism as the prior cycle's Fix C for `החזר מס`: a length tie is broken
by **array order** (V8's sort is stable), and the government rows sit late in
`CATEGORY_MAP`. So adding the phrases to a *late* income row would NOT win.
Insert a dedicated income row as the **FIRST** array element (adds a row,
removes / re-orders nothing) so the income entry wins every tie:

Immediately after `const CATEGORY_MAP = [` (line 271), insert as the first element:

    {"keywords":["קצבת ילדים","קצבת זקנה","קצבת נכות","קצבת שאירים","קצבת אזרח ותיק","קצבת ניידות","קצבת הבטחת הכנסה","הבטחת הכנסה","השלמת הכנסה","דמי לידה","מענק לידה","דמי אבטלה","מענק עבודה","מענק שחרור","מענק קורונה","תגמולי מילואים","דמי מילואים","פיצויי פיטורין","פיצויי פרישה","פדיון ימי חופשה","פדיון ימי מחלה","גמלת סיעוד"],"category":"הכנסות","subcategory":"קצבאות וזכאויות","isIncome":true},

Notes:
- All phrases are length > 3, so they substring-match (Hebrew prefixes still work)
  and the income row wins the length-tie against the identical phrases on the
  government rows via array order.
- The existing government rows (555 / 556) are **left untouched** — this is
  purely additive. Anything that legitimately matched them still does for every
  *other* keyword on those rows.
- A few phrases (`דמי אבטלה`, `הבטחת הכנסה`, `מענק עבודה`, `גמלת סיעוד`) are not
  keywords anywhere today (they currently fall to DEFAULT / ASK). Including them
  here both fixes the ones already mis-routing AND captures these as income
  rather than leaving them ambiguous — they are unambiguously money in.
- `subcategory:"קצבאות וזכאויות"` ("allowances & entitlements") is a new income
  bucket name. If the personal income dashboard rolls income up under the four
  `הכנסה N` rows, map this sub there in the dashboard layer; the polarity (col H
  = income) is correct regardless of the sub label.

#### Why the fix is safe (verified on a scratch copy — no regressions)

Confirmed AFTER the fix, every one of these still routes to **EXPENSE** (the fix
does not over-reach):

- Government **outflows**: `מס הכנסה`, `תשלום מס הכנסה`, `מקדמות מס`, `ביטוח לאומי`,
  `דמי ביטוח לאומי`, `מעמ`, `תשלום מעמ`, `מס שבח`, `מס רכישה`, `קנס משטרה`,
  `אגרת רישוי`, `דרכון`, `ארנונה` — all stay expense.
- **Debt repayments** (money OUT): `החזר חוב` (DEFAULT/ask), `החזר הלוואה`
  (בנקאות), `החזר משכנתא` (הוצאות קבועות / בית) — all stay expense. This is the
  exact failure the prior cycle warned about (a blanket `"החזר"` income keyword
  would flip these); the allowance fix lists only specific `קצבת`/`מענק`/`דמי
  לידה`/`פיצויי` phrases and **never a bare `החזר`**, so it does not touch them.
- **Savings / pension deposits** (money OUT): `קרן השתלמות`, `קופת גמל`,
  `ביטוח מנהלים`, `הפקדה לפנסיה` — all stay expense.

Golden-set: identical 8-item miss list and identical **96.3%** before and after
the scratch patch.

---

## Prior-cycle sign-flips — RE-CONFIRMED still unfixed (not re-claimed here)

The 4 sign-flips documented in `bot/BOT_IMPROVEMENTS.md` (2026-06-02) still
mis-route on current `bot/ExpenseBot_FIXED.gs` (verified this cycle). They are
tracked there with their exact fixes (Fixes A / B / C); not duplicated here:

| input | today | should be | fix (see BOT_IMPROVEMENTS.md) |
|---|---|---|---|
| `עסק החזר מעמ 900` | `עסק / הוצאות תפעוליות` [expense] | `עסק / מחזור` [income] | Fix A |
| `עסק תמונות החזר מעמ 1200` | `עסק / הוצאות תפעוליות` [expense] | `עסק / מחזור` [income] | Fix A |
| `זיכוי מעמ 450` | `עסק / הוצאות תפעוליות` [expense] | `עסק / מחזור` [income] | Fix A + B |
| `החזר מס 600` | `ממשלה ומיסים / מיסי חברה - תאגידי וניהול` [expense] | `הכנסות / החזר מס` [income] | Fix C |

The allowance income row above can be added in the **same** edit as Fixes A/B/C
(they touch different rows; no conflict).

---

## Deliberately NOT auto-fixed (correct behavior — bot should ASK)

Bare refund/credit forms with no NI / tax / business context are genuinely
ambiguous (could net an upcoming bill, or be true cash back) and correctly fall
to **DEFAULT** so the bot asks — this is the right product behavior, not a
mis-route. Anchored as DEFAULT guards in `tests/golden_set.js`:

- `זיכוי 300`, `החזר כספי 400`, `קיבלתי החזר 500`

A future bot-side ASK flow ("האם זה החזר שקיבלת?") is the safe way to capture
these, not a blanket keyword (which would flip `החזר חוב`/`החזר הלוואה` outflows).

---

## What was added to `tests/golden_set.js` this cycle (purely additive guards)

A "2026-06-03 NATIONAL-INSURANCE ALLOWANCE" block of **20 regression guards**,
all of which PASS on the current source (the suite stays green; accuracy
228/236 = 96.6%). They lock in the currently-correct adjacent cases so the
prescribed allowance fix can be applied **without collateral damage**:

- (F) government tax/fee/fine outflows stay expense (`מס שבח`, `מס רכישה`,
  `קנס משטרה`, `דוח חניה`, `אגרת רישוי`, `דרכון`)
- (G) debt repayments stay expense (`החזר הלוואה`, `החזר משכנתא`, `החזר חוב`=ASK)
- (H) savings/pension deposits stay expense (`קרן השתלמות`, `קופת גמל`, `ביטוח מנהלים`)
- (I) income polarity anchors (`קיבלתי משכורת`, `בונוס`, `תקבול`)
- (J) ambiguous bare refunds stay DEFAULT (`זיכוי`, `החזר כספי`, `קיבלתי החזר`)

The failing allowance inputs themselves are **NOT** added (they fail today; the
suite is a passing gate). Add them when the fix lands — see next section.

---

## Anchors to add when the fix lands

These FAIL on current source (the mis-routes above) and are therefore NOT yet
active in `tests/golden_set.js`. The moment the income row above is added to
`bot/ExpenseBot_FIXED.gs`, append them to the `GOLDEN` array so the corrected
income polarity is locked (top-level `הכנסות` proves both the category and,
via the income row, the `col H = FALSE` polarity):

    // NI allowances / benefits -> income (2026-06-03 fix)
    ['קצבת ילדים 500', 'הכנסות'],
    ['קצבת זקנה 1800', 'הכנסות'],
    ['קצבת נכות 2500', 'הכנסות'],
    ['קצבת שאירים 3000', 'הכנסות'],
    ['דמי לידה 8000', 'הכנסות'],
    ['מענק לידה 2000', 'הכנסות'],
    ['פיצויי פיטורין 30000', 'הכנסות'],
    ['פיצויי פרישה 50000', 'הכנסות'],
    ['פדיון ימי חופשה 4000', 'הכנסות'],
    ['מענק שחרור 12000', 'הכנסות'],
    ['תגמולי מילואים 2200', 'הכנסות'],
    ['השלמת הכנסה 1200', 'הכנסות'],
    ['מענק קורונה 6000', 'הכנסות'],

## Reproduce

    node bot/bot-replay.js --json "קצבת ילדים 500"   # shows the current sign-flip (expense)
    node bot/bot-replay.js --json "פיצויי פיטורין 30000"
    node tests/golden_set.js                          # 236 anchors, 96.6%, must stay PASS
    npm run gauntlet                                  # full offline gate, 0 failures
