# Disclaimers and Regulated-Activity Boundaries — Kesefle

Last updated: 2026-05-16
Owner: Steven Ran Cohen
Purpose: keep Kesefle on the safe side of "expense tracker" and far away from "financial advice / tax services / investment advisor / payment institution"

---

## 1. Where Kesefle could accidentally cross into regulated territory

| Feature (today or near-future) | Regulated activity risk | Israeli regulator | EU regulator | Where it crosses the line |
|---|---|---|---|---|
| Recording transactions | None | — | — | Pure record-keeping is unregulated |
| Categorizing expenses (rules-based) | None | — | — | Mechanical classification is not advice |
| Categorizing expenses (LLM-based) | Low — only if categories steer financial decisions | — | — | When suggestions affect a "buy/don't buy" decision |
| Monthly summary "you spent ₪X" | None | — | — | Factual reporting |
| Charts of spending trends | None | — | — | Factual visualization |
| **"You're spending too much on coffee — reduce by ₪200/month"** | Low-medium — borderline financial guidance | רשות שוק ההון, ביטוח וחיסכון (CMI) if savings/investment framing | — | When phrased as a recommendation |
| **"Save more by switching electricity providers to X"** | High — could be "comparison broker" requiring license | רשות שוק ההון (קמעונאות פיננסית) | — | Promoting a specific provider for compensation |
| **"You should report ₪Y for taxes"** | High — tax advice without license | רשות המסים (Tax Authority) + לשכת רואי החשבון | EU member-state tax authorities | Without רואה חשבון/יועץ מס license, this is prohibited paid advice |
| **"Based on your spending, consider this credit card / loan"** | High — credit advisory / brokerage | רשות שוק ההון, רישוי "יועץ אשראי" | EU consumer credit directive | Without a credit-advisor license, prohibited |
| **"Invest your savings in X fund"** | Very high — investment advice | רשות ניירות ערך — חוק הסדרת העיסוק בייעוץ השקעות | MiFID II in EU | Requires Israeli ISA license / MiFID license |
| **Holding money / wallet feature** | Very high — payment institution | בנק ישראל / רשות שוק ההון (Payment Services Law 2019) | PSD2 | Anything that custodies funds requires license |
| **Sending money / paying bills** | Very high — payment services | בנק ישראל / רשות שוק ההון | PSD2 PI license | Strictly off-limits without licensing |
| **Selling user financial data** | Privacy + financial regulation | PPA + CMI | GDPR | Don't even consider |

### Rules of thumb

1. **Describe, don't prescribe.** "You spent ₪X on coffee" ✓. "You should spend less on coffee" ✗.
2. **No specific product names.** "Consider a high-yield account" ✓. "Switch to Bank Hapoalim Plus account" ✗ (unless we have a license and disclose).
3. **No tax math beyond simple totals.** "Your business expense total this month is ₪X" ✓. "You should declare ₪X for VAT" ✗.
4. **No revenue from financial product affiliates** until licensed. Even an honest affiliate link could be construed as commission-based advice.

---

## 2. Required disclaimers — where, when, exact text

### 2.1 Footer of every page (kesefle.app, /privacy, /terms, /account)

```
"כספ'לה" הוא שירות לרישום הוצאות והכנסות. הוא אינו תחליף לייעוץ
פיננסי, חשבונאי, השקעות או מסים מורשה.
```

Already present (partially) in terms.html §5. **Action:** add the same line as a small footer to every page, not just terms.

### 2.2 First-run welcome WhatsApp message

After opt-in:
```
שלום! 👋 חברנו את המספר שלך לחשבון "כספ'לה" שלך.
שים לב: אני בוט לרישום הוצאות. אני לא יועץ פיננסי או יועץ מס.
לפעולות מורכבות פנה לאיש מקצוע מורשה.
```

### 2.3 Monthly summary template message

When sending the auto-generated monthly summary:
```
סיכום {{1}}: סה״כ ₪{{2}}. הפירוט המלא בגיליון: {{3}}
* הסיכום חישובי בלבד. אינו ייעוץ פיננסי.
```

### 2.4 Dashboard / charts page (when built)

Persistent disclaimer at top of charts page:
```
המידע המוצג כאן מבוסס על הנתונים שהזנת לבד. הוא מיועד לעזר בלבד
ואינו מהווה ייעוץ פיננסי, חשבונאי, השקעות או מס. החלטות כלכליות
התייעץ עם איש מקצוע מורשה.
```

### 2.5 Tax-related responses (see §3 below)

Pre-written response — see §3.

---

## 3. "How much should I report for taxes?" — what the bot must reply

**Never compute, suggest, or imply a tax amount.** Use this exact response (and variants for "tax", "מס", "מע״מ", "VAT", "ניכוי", "החזר"):

```
אני לא יועץ מס ולא יכול לעזור בחישובי מס. הנתונים שלך בגיליון
"כספ'לה" יכולים להיות בסיס טוב לפגישה עם רואה חשבון או יועץ מס
מורשה. רוצה לייצא את הנתונים? שלח "ייצא".
```

### Trigger keywords (regex, Hebrew + English)
```js
const TAX_REGEX = /(\bמס\b|מע"?מ|ניכויים?|החזר מס|דו"?ח שנתי|tax|vat|deduction|refund)/iu;
if (TAX_REGEX.test(text)) {
  await sendReply(fromPhone, TAX_DISCLAIMER_RESPONSE);
  await kvSet(`disclaimer_shown:${fromPhone}:tax`, { ts: Date.now() }, { EX: 86400 });
  return;
}
```

**Important:** still **log the transaction** the user might be embedding ("רישום מס הכנסה ₪500" → log as expense). The disclaimer triggers in addition to logging, not instead of.

### Variations to also block
- "כמה אני צריך לשלם מס?"
- "תעזור לי עם הדו״ח השנתי"
- "כמה החזר אקבל?"
- "האם זה מוכר במע״מ?"
- "מה אחוז המע״מ של ההוצאה הזאת?"

All get the same tax disclaimer response.

---

## 4. Other regulated-question handlers

### 4.1 Investment / savings advice

Trigger: `(השקעות?|להשקיע|מניות|ETF|קופת גמל|פנסיה|invest|stocks|portfolio)`

Reply:
```
אני לא יועץ השקעות. אני יכול רק לעזור לך לראות לאן הולך הכסף שלך.
החלטות השקעה חשוב להתייעץ עם יועץ השקעות מורשה (רשימה: isa.gov.il).
```

### 4.2 Loans / credit

Trigger: `(הלוואה|אשראי|ריבית|loan|credit card|interest rate)`

Reply:
```
אני לא יועץ אשראי ולא ממליץ על מוצרים פיננסיים. ההוצאות שלך בגיליון
יכולות לעזור לך להבין את התמונה. להמלצות פנה ליועץ אשראי מורשה.
```

### 4.3 Bank/account-specific questions

Trigger: `(בנק [א-ת]+|חשבון בנק|כרטיס אשראי [א-ת]+|bank of|account at)`

Reply:
```
לא יכול להתייחס לבנק או חוזה ספציפי. שאל את הבנק שלך.
```

### 4.4 Cryptocurrency

Trigger: `(ביטקוין|אתריום|crypto|bitcoin|ethereum|wallet)`

Reply: same as investment advice + extra caution.

```
לא יכול לייעץ על קריפטו. רק רישום ההוצאות שלך — שלח "X ₪ קריפטו" ואני ארשום.
```

---

## 5. LLM safety — if/when we add an LLM categorizer

Today's classifier is rule-based (KESEFLE_KEYWORDS_v2.gs). When we move to LLM-based categorization or summarization:

### Output constraints
- The LLM gets a **system prompt** that explicitly forbids:
  - Recommending products, brands, banks, investments
  - Computing or suggesting tax amounts
  - Predicting "you will spend X" beyond pure trend lines
  - Mentioning specific financial products by name
- All LLM outputs pass through a **post-filter** for the trigger regexes in §3 + §4. If matched, replace with the appropriate disclaimer.

### System prompt (English, for clarity; use in production)

```
You are a categorizer for Kesefle, a Hebrew expense tracker. Your ONLY job is:
1. Identify the amount (currency: ILS).
2. Classify the expense into one of these categories: [LIST].
3. Return JSON { amount: number, category: string, confidence: 0-1 }.

You MUST NOT:
- Give financial, tax, investment, or credit advice
- Recommend specific products or brands
- Compute taxes or VAT
- Predict future spending
- Suggest budget changes
- Discuss the user's overall financial health

If the user's message asks anything beyond categorization, return:
{ amount: null, category: "unclear", confidence: 0, escalate: "advice_request" }
```

### Logging
Every LLM call: log the input, output, and whether the post-filter flagged it. Retain 90 days.

---

## 6. Marketing copy — boundaries

The homepage and ads MUST NOT claim:
- "Save N₪/month" without basis
- "Reduce your taxes" — implies tax-prep service
- "Best for entrepreneurs" — fine
- "Replaces your accountant" — NOT fine; "complements your accountant" is OK
- Any specific dollar/shekel savings number that isn't from an independent study

Check the current index.html for any forbidden phrasing.

---

## 7. Disclaimer copy — for inclusion in terms.html update

Add to terms.html §5 (current "אחריות"):

```html
<h2>5. אחריות והגבלת אחריות</h2>
<p>השירות ניתן כפי שהוא ("AS IS") וכפי שזמין ("AS AVAILABLE"). אנחנו פועלים
לדיוק מירבי אך לא מתחייבים לדיוק 100%. הינך אחראי לבדיקת הרשומות בגיליון
שלך לפני כל שימוש בהן.</p>
<p>השירות <strong>אינו תחליף ואינו מהווה ייעוץ פיננסי, חשבונאי, השקעות, מס,
אשראי או משפטי</strong>. כל החלטה כלכלית התייעץ עם איש מקצוע מורשה.</p>
<p>בגבול המותר על פי דין, "כספ'לה" ובעלי המניות, נושאי המשרה והעובדים שלה
לא יישאו באחריות לכל נזק עקיף, תוצאתי, מיוחד או פיצוי עונשי הנובע משימוש
או מאי-שימוש בשירות. סך אחריותנו לכל תביעה לא תעלה על הסכום ששילמת לשירות
ב-12 החודשים שקדמו לאירוע, או 100₪ (הגבוה מבין השניים).</p>
<p>החריגים: אין באמור לעיל כדי לגרוע מאחריות שלא ניתן להתנות עליה לפי
חוק הגנת הצרכן או חוק האחריות למוצרים פגומים.</p>
```

The "100₪ floor" is intentional — Israeli consumer protection courts may refuse to enforce a "zero liability" cap.

---

## 8. Periodic review

Re-read this document quarterly. The boundary shifts as we add features. Specifically before:
- Launching any new chart, summary, or alert (does it cross from descriptive to prescriptive?)
- Adding any LLM feature
- Partnering with any bank, broker, or financial product
- Launching in any new jurisdiction (EU member states have varied rules)
- Adding payment processing / wallet features (would require licensing)
