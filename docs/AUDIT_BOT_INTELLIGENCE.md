# Audit: Kesefle Bot Intelligence

**Date:** 2026-05-26
**File audited:** `bot/ExpenseBot_FIXED.gs` (14269 lines)
**Build:** `2026-05-26-q4-profession`

This report audits classifier accuracy, onboarding flow, welcome UX, help discoverability, income tracking, receipt OCR, voice handling, fallback paths, multi-business support, and produces a prioritized improvement backlog.

---

## 1. Classifier accuracy

### Static dictionary size

`const CATEGORY_MAP` lives at `bot/ExpenseBot_FIXED.gs:69-460`. Plus a smaller `BUSINESS_CATEGORY_MAP` at line 7654 that augments business accounts.

Measured by parsing the array directly:

| Metric | Count |
|---|---|
| Map entries (subcategory blocks) | **347** |
| Keyword instances (sum) | **22,150** |
| Unique keywords (lowercased) | **20,833** |
| Duplicate keywords across entries | ~1,317 |
| Top-level categories | 19 distinct |
| Distinct subcategory buckets | 40 distinct |

The vocabulary is enormous and clearly hand-curated, with full English + Hebrew bilingual coverage for high-value verticals (travel, fuel, supermarkets, kids/baby).

### Top-level category sizes

```
 5486  אוכל                        (food, supermarkets, restaurants, delivery, drinks)
 3517  תחבורה                       (transport, fuel, parking, vehicle, public transit, travel)
 3150  הוצאות קבועות                (recurring/utilities/rent/mortgage/tax obligations)
  903  קניות / ביגוד                (shopping → clothing)
  801  בידור                        (entertainment, subscriptions, going-out)
  776  עסק                          (business)
  745  חינוך                        (education)
  665  ממשלה ומיסים                  (government and taxes)
  600  קניות                        (shopping general)
  483  הוצאות קבועות / בית          (recurring → home/property)
  476  קניות / רהיטים               (furniture)
  405  קניות / חשמל ואלקטרוניקה     (electronics)
  379  שונות ואחרים                  (catch-all)
  372  פיננסים / השקעות             (finance / investments)
  367  בריאות                        (health)
   90  טיפוח                        (grooming)
   18  חיות מחמד                    (pets — top-level catch-all)
   17  תחזוקת בית                   (home maintenance)
   15  מתנות                        (gifts)
   15  הכנסות                       (income)
   13  נסיעות                       (travel — duplicate of תחבורה/תיירות?)
   10  כושר ומנויים                 (fitness)
   10  בנקאות                       (banking)
    1  הוצאות זמניות                (a stale "temporary" subcat — possibly dead data)
```

### Gaps: top 20 thinnest subcategories

These have the FEWEST keywords and are the most likely to misfire or DEFAULT:

```
 1  הוצאות זמניות / אבא                 (legacy/personal — probably should be removed)
 1  הוצאות קבועות / אפולו                (legacy/personal — looks like a one-off vendor)
 2  הכנסות / שונות (הכנסות)              (income misc — extend with: דיבידנד, שכ"ד דירה, החזר, מענק)
 2  תחבורה / רוביקון                     (single jeep model — pointless)
 3  הכנסות / הכנסה 1 — משכורת            (only 3 salary keywords; missing: שכר נטו, ברוטו, תלוש)
 4  הכנסות / הכנסה 2 — עסק               (missing: תשלום מלקוח, חשבונית, התקבל)
 4  בריאות / ביטוח בריאות                (missing major insurers: כלל, הראל, מנורה)
 4  הוצאות קבועות / בית / נדל            (typo: "נדל" without "ן"; unreachable)
 5  תחבורה / BMW s1000                   (single motorcycle model — personal noise)
 5  שונות ואחרים / אירועים               (events too thin — missing: חתונה, בר מצווה, אזכרה)
 6  הכנסות / הכנסה 3 — נוסף              (gig income missing: פרילנס, צד, הוראה פרטית)
 6  תחבורה / ליים                        (Lime scooter — fine but tiny)
 6  שונות ואחרים / לוטו                  (gambling — missing: טוטו, ויקטור, וויןסט)
 7  קניות / רהיטים                       (only 7 keywords?! see "Note" below)
 7  שונות ואחרים / ספרים                 (overlaps with קניות/ספרים — possible bucket conflict)
 8  הוצאות קבועות / בית                  (utilities/rent — see "Note" — actually the deep bucket has 483)
 9  שונות ואחרים / בילויים                (overlaps with בידור/בילוי ויציאה)
10  תחבורה / כסאות בטיחות לילדים          (missing: בוסטר רכב, ספדק, באבי ארט)
10  כושר ומנויים / כושר                  (missing: ענרגיים זול, פיט, פפאיה, גולדס)
10  בנקאות / בנקאות                      (missing: סוויפט, ראקטל, פיביי, פייפאל ישראל)
```

**Note** — `קניות / רהיטים` appears twice in the sorted output (7 and 476). This is because the map uses BOTH `"רהיטים"` and `"קניות / רהיטים"` as subcategory strings on different entries. Same fate for "הוצאות קבועות / בית" (8 entries with that exact string + 483 with subcategory parts). **This is a real taxonomy inconsistency** — the matcher will sometimes report a subcategory of `"רהיטים"` and sometimes of `"קניות / רהיטים"`, breaking SUMIFS in dashboards that key on either form.

### Over-broad subcategories (top 5 likely to over-match)

```
 1304  הוצאות קבועות / כלי עבודה            ⚠️ "כלי עבודה" is generic; sweeps in unrelated tool-purchases
 1082  הוצאות קבועות / אפליקציות            ⚠️ Misnamed bucket — apps aren't all recurring (one-time game purchase trapped here)
  702  אוכל / אוכל בחוץ — פאבים וברים       ⚠️ Caught "פאב 150" in the golden set as בידור instead of אוכל
  621  תחבורה / מוסך                       ⚠️ Sweeps almost any שיפוץ/החלפה word
  602  תחבורה / תחבורה ציבורית              (less risky — relatively specific terms)
```

The most acute risks are #1 (`כלי עבודה`) and #2 (`אפליקציות`). They both pull a generic concept into `הוצאות קבועות` even when the user means a one-time purchase.

### Golden-set accuracy (measured)

`tests/golden_set.js` — **155 labeled Hebrew messages**, threshold 93%.

Ran live:
```
ACCURACY: 94.8% (147/155)   threshold 93% — PASS
```

**8 misses** (root causes):

| Input | Want | Got | Cause |
|---|---|---|---|
| `פאב 150` | אוכל | בידור / בילוי ויציאה | "פאב" listed under entertainment subcat (line 100) |
| `ספרי לימוד 300` | הוצאות קבועות | חינוך וילדים / ספרים | Genuine ambiguity — current bucket arguable |
| `מעמ 1800` | ממשלה ומיסים | עסק / מיסים | Business map's `"מעמ"` keyword wins priority over personal map (line 80) |
| `שכר לימוד 5000` | חינוך | חינוך וילדים / חינוך וטיפול | Top-level mismatch only (top says "חינוך וילדים", test wants "חינוך") |
| `גן ילדים 2500` | חינוך | חינוך וילדים | Same — taxonomy/test naming drift |
| `צהרון 1200` | חינוך | חינוך וילדים | Same |
| `מעון 2800` | חינוך | חינוך וילדים | Same |
| `צעצוע לילד 120` | DEFAULT | בידור / צעצועים ומשחקי ילדים | Confident match where test wanted ambiguity |

**5 of the 8 misses are "חינוך" vs "חינוך וילדים" — a single taxonomy name mismatch.** The classifier is consistent; only the test labels disagree. True accuracy on intent is **~98%** if you collapse those.

---

## 2. Onboarding flow audit

Survey functions: `_surveyStart_` (line 4176) → `_surveySendQ1_` (3969) → `_surveySendQ2_` (3983) → `_surveySendQ3_` (3991) → `_surveySendQ4_` (4073) → `_surveyFinish_` (4576).

Plus two interjected pre-Q2 questions: kids names (free-text) and pets (button), and car (button), which spawn dedicated dashboard rows. So the actual flow is 4 questions + up to 3 lifestyle interjections.

### Current flow

| Step | Prompt | Captured into |
|---|---|---|
| Q1 (`_surveySendQ1_`) | "מהו סוג המעקב העיקרי שלך?" | `trackingType` ∈ {personal, family, group, business} |
| (interjection if family/group) | "יש לך ילדים? מה השמות?" | per-child dashboard row |
| (interjection if family/group) | "🐶 יש בבית חיית מחמד?" (כלב/חתול/אין) | pet dashboard row |
| (interjection if family/group) | "🚗 יש לך רכב?" | רכב dashboard row |
| Q2 (`_surveySendQ2_`) | "האם יש לך הוצאות קבועות בכל חודש?" + free-text recurring capture | `hasRecurring` + parsed קבועות |
| Q3 (`_surveySendQ3_`) | "האם הבוט ירשום אוטומטית, או רק יתזכר?" | `autoLogPref` ∈ {auto, remind} |
| Q4 (`_surveySendQ4_`) | "מה המקצוע שלך?" (10-row interactive list + free-text fallback) | `profession` ∈ 119-entry catalog |

### What v2 needs that isn't here

| Steven's spec item | Status | Where |
|---|---|---|
| Goal selection (track vs reduce vs prep-for-accountant) | **MISSING** | — |
| Income range | **MISSING** | — |
| Fixed recurring payments setup | partial — free-text capture only | Q2 follow-up |
| Savings goals | **MISSING** | — |
| Report cadence (weekly/monthly) | **MISSING** (weekly digest is on by default for all; not user-chosen) | `cronWeeklySummary` |
| Budget alert preferences | partial — alerts fire at 80% automatically; user can set ceilings via "תקציב X 1500" later, but never asked during onboarding | `_budgetAlertTail_` |
| Currency | **MISSING** — assumes ILS; FX kicks in opportunistically on `$50 amazon` |

The flow currently centers on dashboard structure (kids/pets/car/profession rows), NOT on financial goals. There is no question that captures intent ("I want to reduce spending on…", "I want to save 2000 a month").

### Rating

**Current onboarding: 6/10**

Pros: short (3-4 taps), interactive (no typing required for the common path), the lifestyle interjections feel concrete and create tangible per-row value, profession picker is sharp.

Cons: never asks WHY the user is here, never asks income, never asks goals, never offers cadence/format preferences. A user who wants "prep my data for my accountant" gets the exact same flow as "I want to reduce eating out" — the bot can't tailor reports or nudges to either.

---

## 3. Welcome / first-message UX

### Trigger path

`_maybeSendWelcome_(fromPhone)` at line 1050, gated by Script Property `welcomed:<phone>`. Called from `doPost` at line 1581 before any expense parsing.

The survey is NOT kicked off here anymore (PR 2026-05-26 split it out). Instead, after the user sends their FIRST successful expense, `_surveyMaybeStartAfterFirstExpense_` (line 1099) fires the questionnaire. This matches Steven's spec.

### The actual welcome message (verbatim, line 1066-1078)

```
👋 *ברוך הבא לכספ'לה!*
אני עוזר לך לעקוב אחרי הוצאות והכנסות דרך וואטסאפ.

אפשר לשלוח לי הודעות פשוטות כמו:
━━━━━━━━━━━━━━━━━━
• *42 קפה*
• *245 סופר*
• *1,800 שכר דירה*
• *12,000 משכורת* ← הכנסה
• *+500 בונוס* ← הכנסה (סימן +)

🎯 *רוצה להתחיל? שלח לי עכשיו הוצאה אחת מהיום.*

_(אחר כך אשאל אותך 3-4 שאלות קצרות כדי להתאים את המעקב אליך.)_

📊 הגיליון שלך:
<sheet URL>

💡 לעוד פקודות, שלח *עזרה*. כל פקודות הבוט שם.
```

### vs Steven's spec

| Spec line | In current message? |
|---|---|
| ברוך הבא לכספ׳לה 👋 | YES |
| אני עוזר לך לעקוב אחרי הוצאות והכנסות דרך וואטסאפ. | YES (verbatim) |
| אפשר לשלוח לי הודעות פשוטות כמו: | YES (verbatim) |
| 42 קפה / 245 סופר / 1800 שכר דירה / 12000 משכורת | YES — all 4 examples |
| רוצה להתחיל? שלח לי עכשיו הוצאה אחת מהיום. | YES (verbatim, with extra emphasis) |

PLUS: income-with-sign example, sheet link, "send עזרה" pointer, survey heads-up note. None of these dilute the spec; they extend it sensibly.

### Score: **9/10**

- (a) explains what the bot does: YES, 1-line intro
- (b) example expenses: YES, 5 examples covering expense + income
- (c) how to get help: YES, mentions `עזרה`
- Single CTA preserved (no menu overload)
- Sheet link surfaces immediately

The only nit: the spec was 6 lines; the live message is 13 lines including a section divider. Steven might want to test cutting it down to mirror the spec exactly, but the additions are non-noisy.

---

## 4. Help / commands discoverability

`getHelpMessage()` at line 9397.

### What it lists

Counted by section, 30+ commands across 9 sections: רישום הוצאה, תאריך, רישום הכנסה, הזמנה עסקית, פיצול לתשלומים, הוצאות קבוצתיות, הוצאות קבועות, תקציבים חודשיים, קטגוריות מותאמות אישית, פקודות מהירות (16 sub-commands), המנוע.

### Naming consistency: poor

**Three different command styles coexist:**

1. **Bare Hebrew verb** — `סיכום`, `סיכון`, `דוגמאות`, `סנכרן`, `מילון`, `מנוע`, `עזרה`, `הזמנות`, `תקציב`, `תזכורת`, `תזכורות`, `הזמן`, `מחק אחרון`, `הגדרות`, `אזור זמן`, `שאלון`, `אשר`
2. **`כספלה X`** prefix (group/family flow) — `כספלה צור משפחה כהן`, `כספלה הצטרף ABC123`, `כספלה 245 סופר`, `כספלה יתרות`, `כספלה עזרה`
3. **English keyword** (e.g. `code XXXXXX`, `link XXXXXX`) — only mentioned in code, not in the help message
4. **Hebrew with English-style argument** — `קבוע 2500 שכירות כל 1 לחודש`, `תיקון סכום 250`

Commands like `מחק חשבון`, `מחק הזמנה`, `מחק קבוע`, `מחק לימוד`, `השהה קבוע`, `סנכרן הוצאות קבועות`, `רשימת קבועות`, `צור קטגוריה`, `יעד תקציב X = Y` are NOT prefixed but are NOT all listed. `עסקים שלי` (multi-business list) and `עסק N ...` (write to business N) are **not** in `getHelpMessage()`. The voice/receipt commands (just send media) aren't documented either.

### Missing from help

- `עסקים שלי`, `עסק N ...` (multi-business — owner only)
- `כספלה X` is documented but does not appear in the "פקודות מהירות" section, only in its own group section
- `שאלון` (re-run the questionnaire) — only mentioned in survey end message
- `דלג` / `לא` / `אין` / `כן` / `אשר` confirmation tokens
- Photo receipt and voice message instructions — only the bot-side reply mentions them
- `קוד XXXXXX` / `link XXXXXX` (account linking)
- `מחק חשבון` is mentioned but its GDPR consequences are not
- `הערה: שילמתי במזומן` — appears in welcome but not in help

### Score: **5/10**

Long, dense, covers a lot, but mixes prefix conventions, omits ~10 commands, and doesn't group "if you're new" vs "power user" commands. A first-time user reading this will be overwhelmed.

---

## 5. Income tracking

### Visual acknowledgment

`processExpense` returns one of two reply shapes (line 7398 — single item path):

```
✅ ₪<amount> ל<description>. נשמר אצלך בגיליון 📊
📂 <category> [→ subcategory]
[💡 month-to-date context]
[anomaly tail]
[budget tail]
[recurring suggestion]
[streak]
[soft hint]

❓ קטגוריה לא מדויקת? שלח "קטגוריה <השם הנכון>" ואני אלמד.
כתוב "סיכום" לראות איפה אתה עומד החודש.
[sheet URL]
```

In the **multi-item** path (`writtenLines.push`, line 7311) the emoji DOES differentiate: `💵 ₪x` for income and `💸 ₪x` for expense.

In the **single-item** path: **NO income/expense visual differentiation.** Both an expense and an income return `✅ ₪x ל<description>`. There is no green vs red, no "+5000 התקבל" vs "-245 הוצאת" framing. The user only knows it was income if `category === 'הכנסות'`.

This is a clear product gap.

### Monthly summary

`getMonthlySummary` (line 9307) **does** separate income and expense correctly:

```
💵 הכנסות: ₪X
💸 הוצאות: ₪X
🟰 נטו: ₪X

פירוט לפי קטגוריה:
• <each non-income category>
```

Good — income totals appear, net is computed, the per-category breakdown excludes income (line 9344). The summary side is fine.

### Recurring income detection

`_detectRecurringCandidate_` exists (line 8521) and is unit-tested (`tests/recurring_detect.js`). But:

1. The detector EXPLICITLY excludes income: see test line 56 `ok('income (משכורת) → no'...)` confirms `isIncome` items are filtered out before stability checks.
2. `_recurringSuggestionLine_` (called at line 7389) only fires when the detector returns a non-null candidate. For income it always returns null.
3. There is no `recurring_income` flow, no `_detectRecurringIncomeCandidate_`, no income-stability check.

**Recurring income is not wired anywhere.** Salary appearing month after month at the same amount produces no "want to track this as a salary?" prompt.

---

## 6. Receipt OCR quality

`_handleReceiptImage_` at line 8605. Pipeline: WhatsApp media → Meta media URL → bytes → base64 → Claude vision (`claude-haiku-4-5-20251001`) → JSON parse → category match → write row.

### What it extracts (line 8659-8666 prompt)

```
- vendor: store/business name
- amount: FINAL TOTAL (largest סה״כ line)
- date: YYYY-MM-DD
- description: 2-4 word Hebrew summary
```

That is, **vendor + amount + date + short description**, nothing else.

### NOT extracted

- VAT (מע"מ) breakdown — even though most Israeli receipts print it
- Line items (the prompt explicitly summarizes them down to 2-4 words)
- Payment method (cash / credit / cheque) — would let the bot tag "השם המסחרי של הכרטיס" automatically
- Tip
- Discount
- Subtotal
- Number of items
- Receipt number / asmachta (for an accountant's audit trail)

### Low-confidence path

There is no confidence score from the prompt. The fallback paths are:

- Returns `{"error":"not_a_receipt"}` → reply "🤔 לא נראה לי שזו קבלה. תוכל לרשום ידנית?"
- `amount` is NaN or ≤ 0 → "🤔 לא הצלחתי לזהות סכום. שלח שוב או רשום ידנית."
- No JSON in Claude reply → "🤔 לא הצלחתי לזהות את פרטי הקבלה. רשום ידנית: סכום פירוט."
- Claude HTTP error → "😬 הבינה לא הצליחה לקרוא את הקבלה כרגע"
- File > 5MB → "📸 התמונה גדולה מדי"

**There is no "I'm not sure" path** — if the model returns plausible JSON, the row is written without confirmation. If vendor is wrong, the user must use `קטגוריה X` to fix. There is no "is this right? כן/לא" gate the way text expenses get for low-confidence cases.

---

## 7. Voice message handling

`_handleVoiceMessage_` at line 8836.

### What it does

1. Download voice note from Meta media endpoint
2. Convert MIME to a Whisper-acceptable filename (ogg/mp3/m4a/wav/webm)
3. POST to OpenAI **`whisper-1`** with `language: 'he'`
4. Take `text` field from Whisper response
5. Feed transcript into `processExpense` exactly like a typed message
6. Append a voice-source note to the resulting sheet row's note cell

### Transcription engine

**OpenAI Whisper (`whisper-1`), not Gemini.** Comment at line 8834 explicitly notes "Anthropic models do not accept audio input in Apps Script, so we use OpenAI Whisper."

### Languages

`language: 'he'` is **hard-coded**. Hebrew only. A user speaking English, Russian, Arabic, or Amharic will get garbled output that processExpense will then mis-classify.

### Error paths

- Missing `OPENAI_API_KEY` → "🎙️ אין תמיכה בקול עדיין" + hint to type
- Missing `WHATSAPP_TOKEN` → same
- Media metadata fetch fails → "😬 לא הצלחתי להוריד את הקול"
- Media bytes fetch fails → same
- File > 5MB → "🎙️ ההקלטה גדולה מדי"
- Whisper HTTP error → "😬 התמלול נכשל"
- Whisper JSON parse fails → same
- Whisper returns empty text → "😬 לא הצלחתי להבין את ההקלטה — דבר ברור יותר, סכום קודם"
- Transcribed text doesn't parse as expense → echoes transcript + "זה לא נראה כמו הוצאה — דבר משהו כמו 'מאתיים שקל סופר'"
- Successful path → echoes "🎙️ שמעתי: '<text>'" + the normal expense confirmation

The transcript echo is good UX. But the file gives a misleading reply on `'OPENAI_API_KEY' missing` (says "no voice support YET" even though the user could enable it instantly). And a transcription that's just "hello" or a short clip with no amount gets a helpful prompt rather than logging garbage.

---

## 8. Error / fallback paths

When AI confidence falls below 0.85 (`TIER_DIRECT`, line 7194), the bot does NOT silently write. It HOLDS the expense in `pending:<phone>` cache and sends an **interactive list of up to 6 category options** (line 7250).

Confidence tiers (line 7194-7196):
- `TIER_DIRECT = 0.85` — write directly
- `TIER_SOFT = 0.70` — was once a "soft hint, still auto-write" tier, **now collapsed into the list path** (per inline comment: "an unclear expense/income is NEVER filed silently")
- `TIER_LIST_SMALL = 0.40` — at confidence ≥0.40 show 4 options, else 6

### The literal "I'm unsure" reply

The interactive list arrives as a WhatsApp List Message with:
- Header text: `'צריך אישור'` if AI returned a guess, else `'לא בטוח בקטגוריה'`
- Body text (line 7244-7249):
  ```
  ₪<amount> • "<description>"

  🤖 ניחוש: <category> / <subcategory> (<conf>%)

  בחר את הקטגוריה הנכונה:
  ```
- Footer: `'הבחירה תילמד אוטומטית'`
- Button: `'בחר'`

### Does it remember the user's choice?

YES. When the user taps an option, the handler calls `_learnedSave` to persist the mapping (`description → category/subcategory`). Subsequent identical descriptions hit the learning cache (`tier 1 — Cache`) and skip the AI call entirely. This is the personalized-learning system (see `bot/PERSONALIZED_LEARNING.gs`).

### Other fallback shapes

- No amount detected at all → `'😕 לא הצלחתי לזהות סכום. נסה: "245 סופר"'` (line 5925)
- Generic parse fail → `'😬 משהו השתבש בכתיבה לגיליון: <err>. ננסה שוב בעוד דקה? אם זה ממשיך — שלח "עזרה".'` (line 7396)
- Unrecognized command/keyword → `'😬 לא הבנתי. שלח "כספלה עזרה" לרשימת הפקודות.'` (line 2736)

The fallback design is consistent and well thought through. **The dropdown-list-with-confidence is one of the best designed parts of the bot.**

---

## 9. Multi-business support

### Routing

Owner-only feature. `_parseBusinessNumberPrefix_` (line 10118) matches `^עסק\s+(\d{1,2})\s+(.+)$` and only if the sender is an owner per `_isOwnerPhone_` (line 1758).

- `עסק 1 X` → main `SHEET_ID`
- `עסק N X` (N≥2) → KV-stored `biz:{ownerPhone}:{n}` sheet, AUTO-CREATED on first use by cloning the main sheet via `DriveApp.getFileById(SHEET_ID).makeCopy(...)`
- `עסקים שלי` → lists provisioned sheets

`_writeBusinessNExpense_` (line 10174) supports:
- `עסק N <amount> <desc>` — expense
- `עסק N +<amount> <desc>` — income
- Classifies via `matchCategory('עסק ' + description)` so business keywords get prefix priority
- Writes to תנועות in that sheet, recomputes `מאזן חברה`

### Non-owner protection

`_isOwnerPhone_` is checked **19 times** in the file. The multi-business commands, budget commands, learning commands, subscription commands, and category correction are ALL gated behind `_isOwnerPhone_(__from_)`. Non-owners hit `processExpense` (the tenant-isolated path) and their writes go to their own provisioned sheet via `/api/sheet/append`.

If a non-owner types `עסק 2 320 שיווק`, the `_parseBusinessNumberPrefix_` block at line 1772 is never reached (the surrounding `if (_isOwnerPhone_(__from_))` block excludes them). The message falls through to normal expense processing and is treated as just `עסק 2 320 שיווק` — likely classified as a business expense and written to the sender's own sheet.

**Multi-business is owner-only and the isolation looks correct.** Tenants going through `/api/sheet/append` get only their single provisioned sheet; the bot has no way to create multiple sheets for a non-owner. The skill file `.claude/skills/sheet-multi-business/SKILL.md` documents this.

### Limitations called out in code

> "Multi-tenant multi-biz is a future enhancement (would need extending the api/sheet provisioner)."

So a customer who runs 3 small businesses currently can't get 3 sheets — only Steven can.

---

## 10. Top 15 bot improvements (ranked)

| # | Title | 1-liner | Min | Impact |
|---|---|---|---|---|
| 1 | **Income vs expense visual differentiation in single-item reply** | `processExpense` line 7398 returns `✅ ₪x` for both. Add `+` sign + 💵 emoji + "received" phrasing for income, keep 💸 + spent phrasing for expense. | 30 | HIGH |
| 2 | **Onboarding Q5 — goal selection** | Add a question after Q4: "מה המטרה שלך?" with options: track, reduce, save, prep-for-accountant. Tailor weekly digest tone + budget alerts to the answer. | 90 | HIGH |
| 3 | **Onboarding Q6 — income range** | One-tap list: <5k, 5-12k, 12-25k, 25k+. Drives realistic budget suggestions and the "save X% of income" framing. | 60 | HIGH |
| 4 | **Wire recurring-income detector** | `_detectRecurringCandidate_` filters out income. Add a sibling `_detectRecurringIncomeCandidate_` that runs on income rows and prompts: "noticed ₪12,000 משכורת for 3 months — track as recurring income?" | 120 | HIGH |
| 5 | **Help message — group commands by user maturity** | Split `getHelpMessage()` into "מתחילים" (5 commands), "יומיומי" (10), "מתקדם" (20). One section under the fold, expandable via `עזרה מתקדם`. | 45 | MED |
| 6 | **Fix taxonomy duplicate buckets (רהיטים, בית, ספרים, בילויים)** | 4 subcategories appear with both short ("רהיטים") and long ("קניות / רהיטים") forms. SUMIFS in dashboards key on one or the other and silently miss rows. Normalize. | 120 | HIGH |
| 7 | **Receipt OCR — extract VAT, payment method, receipt number** | Update Claude prompt at line 8659 to also pull `vat`, `payment_method`, `receipt_number`. Store as note on the row so an accountant can audit. | 60 | MED |
| 8 | **Receipt OCR — confirmation gate for low-confidence** | The OCR path writes without asking. Mirror the text-expense pattern: if Claude's response feels uncertain (vendor empty OR description == "קבלה" fallback), show the dropdown list before writing. | 90 | MED |
| 9 | **Voice — auto-detect language** | `language: 'he'` is hard-coded in `_handleVoiceMessage_`. Drop the param so Whisper auto-detects. Steven's spec is "any language" — bot should handle English/Russian/Arabic naturally. | 15 | MED |
| 10 | **Add `עסקים שלי` and `עסק N ...` to help message** | Currently invisible to anyone but Steven. Once multi-business goes multi-tenant (per Q11), these need discoverability. | 5 | LOW |
| 11 | **Multi-tenant multi-business** | Extend `/api/sheet/append` to allow N sheets per user. Currently only the owner gets multiple business sheets. Several pro plans request this. | 480 | MED |
| 12 | **Currency question in onboarding + first-message detection** | Bot assumes ILS. Add Q in survey for primary currency, and detect mismatch (e.g. "50 dollars yesterday") + offer auto-convert with rate snapshot. | 90 | MED |
| 13 | **Soft-prune over-broad subcats `כלי עבודה` and `אפליקציות`** | 1304 + 1082 keywords in these two buckets — both pull unrelated purchases into `הוצאות קבועות`. Split into "כלי עבודה — חד-פעמי" (קניות) and "כלי עבודה — מנוי" (הוצאות קבועות), same for אפליקציות. | 120 | MED |
| 14 | **Help section for media (photo receipt + voice)** | Neither photo nor voice is in `getHelpMessage`. Add a 3-line "📸 שלח תמונת קבלה / 🎙️ שלח הקלטה קולית" section. | 10 | LOW |
| 15 | **Streamline welcome to spec-length** | Live message is 13 lines vs Steven's 6-line spec. A/B test the shorter version against current. Drop the survey heads-up + sheet link to a second message that fires after the first expense. | 30 | LOW |

---

## Summary

**File:** `docs/AUDIT_BOT_INTELLIGENCE.md`

The classifier is mature: 20,833 unique keywords across 347 subcategories, hitting 94.8% on the 155-message golden set. Welcome message matches Steven's spec almost verbatim. Multi-business routing and tenant isolation look correct. The interactive-list "I'm unsure" path is well-designed.

The three biggest opportunities are: (1) income still looks like expense in the single-item reply, (2) onboarding never asks WHY the user is here or their income range, and (3) the recurring detector explicitly excludes income, leaving recurring-salary recognition wired but inert.
