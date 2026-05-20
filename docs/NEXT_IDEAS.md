# Kesefle — NEXT_IDEAS (Prioritized Product Roadmap)

> Forward-looking feature roadmap. Authored 2026-05-20. Research + planning only — no code here.
> Scoring: **Impact 1-10** (revenue + retention + Israeli-market fit). **Effort S/M/L** (S ≈ days, M ≈ 1-2 weeks, L ≈ 3+ weeks).

## Grounding — what already ships (don't rebuild)
Read before proposing: `bot/ExpenseBot_FIXED.gs` (header), `bot/COMMANDS.md`, `api/sheet/*`, `api/billing/*`, `pricing.html`, `roadmap.html`.

- **Expenses**: free-text Hebrew (`245 סופר`), receipt OCR (Claude Vision), voice (Whisper), AI categorization (Pro) + ~19k-keyword dictionary, per-user learning + cross-user hashed global store.
- **Budgets (partial!)**: `תקציבים` shows pace **vs last-month baseline**; `יעד תקציב X = Y` sets a custom monthly target; 3-tier proactive alerts (⚠️/🚨/🔥), throttled 6h. → Idea #2 is an *upgrade*, not net-new.
- **Family/group (partial!)**: `הקמת משפחה`, invite code, `הצטרפות`, admin `אישור`/`דחייה` for *join requests*. → Idea #6 adds *per-expense* approval, not membership approval (already exists).
- **Reports**: `סיכום`, `חריגות`, weekly digest, savings goals, subscription detection. CSV export exists (`/api/account/export` GDPR + transaction CSV).
- **Explicitly NOT done (by design)**: no bank/Open-Banking connection (`COMMANDS.md`). → Idea #7 is *file import*, never live bank scraping.
- **Income**: not implemented anywhere — bot is expense-only. → Idea #1 is a true gap.
- **Stack**: Apps Script bot + Vercel serverless + Vercel KV + each user's own Google Sheet. Tiers: Free / Pro ₪19 / Family ₪39.

---

## The ideas

### 1. Income tracking — הכנסות / משכורת
**Pitch (HE):** "הכנסת ₪12,000 משכורת" — והבוט סוף-סוף יודע כמה *נשאר*, לא רק כמה יצא.
**Value:** Closes the loop from expense-tracker → real cash-flow tool. Net balance (הכנסות − הוצאות), savings-rate %, and "כמה נשאר עד סוף החודש" — the #1 question Israelis ask. Foundational for #2, #5, #4.
**Effort:** S-M (new sign convention in `תנועות`, `הכנסה`/`משכורת` parse path, dashboard net row, summary line).
**Dependencies:** none. Touches sheet schema + summary.
**Impact:** **10**

### 2. True monthly budget limits per category — תקציב חודשי קשיח
**Pitch (HE):** "תקציב אוכל = 2,000 בחודש" — והבוט בולם אותך לפני שחרגת, עם טבעת התקדמות בדשבורד.
**Value:** Today budgets are *last-month-relative* + scattered targets. Users want a deliberate plan: persistent caps per category, % consumed, projected month-end overspend, "envelope" view. Strong Pro upsell (set 3 free, unlimited on Pro).
**Effort:** M (persist budget table per user, dashboard ring widget, refactor existing pace alerts to read hard caps when set).
**Dependencies:** builds on existing `יעד תקציב`; far better paired with #1 (budget vs income).
**Impact:** **9**

### 3. Tax categories for עוסק פטור / מורשה — מע"מ + הוצאה מוכרת
**Pitch (HE):** סמן הוצאה כ"מוכרת" והבוט שומר מע"מ, אחוז הכרה וסכום נטו — מוכן לרו"ח.
**Value:** Israel has ~500k+ עוסקים. No Hebrew WhatsApp tool does VAT-aware expense capture. Flag deductible %, split מע"מ (17%) vs net, tag עוסק-פטור (no VAT) vs מורשה. This is the single biggest *new-segment* unlock and justifies a future "Business ₪49" tier (note `business.html` already exists).
**Effort:** L (per-user business profile: status + default deduction rules; new sheet columns מע"מ / מוכר %/ נטו; categorization prompt extension; UI in account.html).
**Dependencies:** strongest when combined with #4 (export) and #1.
**Impact:** **9**

### 4. End-of-month / year accountant export — ייצוא לרו"ח
**Pitch (HE):** "ייצוא לרו"ח" — וקובץ Excel/PDF מסודר לפי חודש, קטגוריה ומע"מ נוחת במייל.
**Value:** Turns a year of WhatsApp messages into the report an Israeli accountant actually accepts (monthly totals, VAT column, deductible subtotal). Removes the painful Jan/April scramble. Existing CSV export is raw GDPR data — this is *formatted financial output*.
**Effort:** M (server-side xlsx/pdf builder reading the Sheet; email delivery already wired via `emails/`).
**Dependencies:** **#3** (tax fields) for full value; works in basic form on raw data alone.
**Impact:** **8**

### 5. Debt & loan tracking — חובות והלוואות (משכנתא, אשראי)
**Pitch (HE):** "הלוואה 50,000 ב-24 תשלומים" — והבוט עוקב אחרי יתרה, ריבית ומתי תהיה חופשי.
**Value:** Mortgage (משכנתא) + consumer credit are central to Israeli households. Track principal, monthly payment, remaining balance, payoff date, total interest. Pairs with savings goals for a full net-worth picture (assets − liabilities).
**Effort:** M (loans table per user, amortization calc, monthly auto-decrement, `חובות` command + dashboard panel).
**Dependencies:** none; complements #1.
**Impact:** **8**

### 6. Shared household with per-expense approval — אישור הוצאות משותפות
**Pitch (HE):** הוצאה מעל ₪500 של בן/בת הזוג ממתינה לאישורך לפני שנכנסת לתקציב המשפחתי.
**Value:** Family Sheet membership-approval already exists; the missing piece is *spend* control. Configurable threshold → expense parks as "ממתין לאישור", partner gets approve/deny buttons (reuse the join-request approval pattern in `api/group.js`). Reduces money-fights — a sticky couples feature that defends the Family ₪39 tier.
**Effort:** M (pending-expense state in KV + family Sheet status column, reuse approve/deny handler, threshold setting).
**Dependencies:** existing family system + `api/group.js` approval flow.
**Impact:** **7**

### 7. Bank / credit-card statement import — ייבוא דף בנק / אשראי
**Pitch (HE):** העלה דף אשראי (Excel/CSV/PDF) — והבוט מסווג הכל אוטומטית ומסמן כפילויות.
**Value:** Backfill history fast without typing months of expenses. NOT live Open Banking (out of scope by design) — user-uploaded statements from Isracard / Max / Cal / Leumi / Hapoalim. Parse + AI-categorize + dedupe against existing rows. Huge onboarding accelerator ("your last 3 months in 30 seconds").
**Effort:** L (per-issuer column mapping for messy Hebrew CSV/Excel; PDF table extraction; dedupe; bulk append + review screen).
**Dependencies:** AI categorization (exists); strong with #1 (statements carry income too).
**Impact:** **8**

### 8. Recurring / fixed expenses confirmation — הוצאות קבועות
**Pitch (HE):** ה-1 בחודש: "ארנונה ₪650 כרגיל?" — אישור בלחיצה, בלי להקליד שוב.
**Value:** Directly extends the recurring-templates system being built. Auto-prompt on schedule, one-tap confirm/skip/edit. Fixed costs (שכר דירה, ארנונה, ביטוח, גן) are predictable — capturing them passively boosts data completeness, which makes #2/#4 trustworthy.
**Effort:** S-M (scheduler over the templates table + confirm flow). Mostly built; finish the loop.
**Dependencies:** the in-progress recurring-templates system.
**Impact:** **8**

### 9. Hebrew financial dashboard PDF / monthly review card — סיכום חודשי יפה
**Pitch (HE):** בסוף כל חודש: כרטיס סיכום מעוצב — לאן הלך הכסף, מגמות, וטיפ אחד.
**Value:** Shareable, screenshot-able monthly card (top categories, vs last month, savings rate, one AI insight). Drives organic WhatsApp sharing → growth loop, and reinforces the weekly-digest habit at month granularity.
**Effort:** M (render image/PDF server-side; schedule month-end send).
**Dependencies:** #1 for savings-rate; weekly-digest infra exists to reuse.
**Impact:** **6**

### 10. Multi-currency & travel mode — מטבע חוץ ונסיעות לחו"ל
**Pitch (HE):** "120€ מלון ברלין" — והבוט ממיר לשקל לפי שער היום ומתייג כנסיעה.
**Value:** `50$ amazon` already parses a currency symbol — formalize it: live FX, per-trip tag, trip total in ₪. Relevant for frequent-flyer Israelis and freelancers billing abroad.
**Effort:** S-M (FX rate fetch + cache in KV, trip tag, conversion at log time).
**Dependencies:** none; partial currency parse already present.
**Impact:** **6**

### 11. Bituach Leumi / זיכויי מס reminders & deduction finder — מיצוי זכויות
**Pitch (HE):** הבוט מזהה הוצאות שמזכות בהחזר מס (תרומות, חיסכון פנסיוני, ביטוח חיים) ומזכיר.
**Value:** Uniquely Israeli. Flags donations (תרומות §46), pension/keren-hishtalmut, life insurance — categories that yield tax credits — and nudges a return filing. High perceived value, strong word-of-mouth ("הבוט החזיר לי כסף").
**Effort:** L (rules engine + up-to-date credit thresholds; needs careful, non-advisory framing).
**Dependencies:** #3 tax layer + #1 income.
**Impact:** **7**

### 12. Savings-goals upgrade: auto-allocate & round-up — עיגול לחיסכון
**Pitch (HE):** כל קנייה מתעגלת כלפי מעלה והעודף נכנס ליעד החיסכון שלך.
**Value:** Extends existing savings goals with behavioral mechanics (round-up, auto % of income). Light but sticky engagement feature; pairs with #1 (allocate from income).
**Effort:** S (logic on top of existing goals).
**Dependencies:** savings goals (exist) + #1.
**Impact:** **5**

### 13. Spending insights & forecasting — תחזית סוף חודש
**Pitch (HE):** "בקצב הזה תסיים את החודש ב-₪9,200 — ₪700 מעל הרגיל."
**Value:** Predictive end-of-month projection per category and total; "what-if" if you cut a category. Deepens the AI value prop and Pro stickiness.
**Effort:** M (trend model over historical Sheet rows).
**Dependencies:** #1 (for net forecast) + budget data from #2.
**Impact:** **6**

---

## Recommended top-5 build order

| # | Feature | Effort | Impact | Why now |
|---|---------|--------|--------|---------|
| 1 | **Income tracking (#1)** | S-M | 10 | Foundational. Converts an expense logger into a cash-flow tool; unblocks budgets-vs-income, forecasting, accountant export, round-up. Cheapest high-leverage win. |
| 2 | **Recurring fixed-expense confirmation (#8)** | S-M | 8 | Already mid-build — finish it. Captures predictable fixed costs passively, raising data completeness so every downstream report is trustworthy. Fast to ship. |
| 3 | **True monthly budget limits (#2)** | M | 9 | Upgrades the half-built budget feature into a deliberate plan with a dashboard ring. Clear Pro upsell, and pairs with #1 immediately. |
| 4 | **Tax categories עוסק פטור/מורשה (#3)** | L | 9 | Opens an entirely new, underserved segment (~500k+ עוסקים) with no Hebrew-WhatsApp competitor — justifies a paid Business tier. Bigger lift, so it follows the quick wins. |
| 5 | **Accountant export (#4)** | M | 8 | The natural payoff of #3 + #1: turns a year of messages into the file an Israeli רו"ח accepts. Converts tax users into renewers right when they feel the pain (year-end). |

**Sequencing logic:** ship the cheap foundational win (#1) and finish in-flight work (#8) first for fast momentum and better data; then monetize retention-side consumers (#2); then attack the highest-value *new market* (#3) and immediately deliver its payoff (#4). Statement import (#7) is the strongest "fast-six" — slot it next as the premier onboarding accelerator once income parsing (#1) exists to absorb credits in the statements.
