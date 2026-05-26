# Legal-risk audit — kesefle.com (top findings, HIGH first)

Date: 2026-05-26
Scope: public HTML pages — read-only investigation.
Reviewer: paralegal / legal-risk auditor sub-agent.

## HIGH (probable lawsuit / regulator risk)

### 1. WhatsApp "מקצה לקצה" — FALSE
- File: `index.html:1290`, `demo.html:322`
- Quote: `🔒 ההודעות מוצפנות מקצה לקצה`
- Risk: Messages routed through WhatsApp Business API to our server are NOT E2EE — Meta and we can read them.
- Replace: `🔒 ההודעה מוצפנת ב-TLS בדרך לבוט`

### 2. "30-day money-back" vs terms.html 14
- Files: `pricing.html` (multiple) vs `terms.html:62`
- Fix: align both to one number.

### 3. Free plan "ללא הגבלה" vs "30/month"
- `pricing.html:368` vs `terms.html:58` + `index.html:1454` + `about.html:646`
- Fix pricing: `רישום עד 30 הוצאות והכנסות בחודש`

### 4. "שום דבר לא נשמר" — FALSE
- `index.html:1038`
- KV stores phone↔userSub, OAuth refresh tokens (wrapped), expense metadata.
- Replace: `הנתונים הפיננסיים נשמרים בגיליון ה-Drive שלך. פרטי חשבון בלבד נשמרים אצלנו.`

### 5. "18,725 keywords" — suspiciously precise across 5 places
- Replace: `מעל 2,000 מילות מפתח` (or verified count).

### 6. Fabricated testimonials with full names + cities + tenure
- `referral.html:325-360`
- Fix: remove until consent-signed real testimonials exist.

### 7. "אלפי משפחות בישראל" — fabricated count
- `pricing.html:620`
- Replace: drop "אלפי משפחות".

### 8. "85% מפסיקים" — unsourced statistic
- `index.html:807`
- Replace with qualitative wording.

### 9. "החזר משוער מרשות המסים" — implied tax-authority endorsement
- `tax-report.html:131-133, 192-193`
- Fix: add prominent disclaimer banner "אינו ייעוץ מס".

### 10. "מוכן ל-1099 / 6111 / הצהרת ההון" — 1099 is US tax form
- `business.html:266` (DELETED in this PR — resolved)

## MED (10 findings)
"אף פעם" absolute promise; "100% במנוי" combined with affiliate links; "אישור מיידי" contradicts "תוך כמה שעות"; AI accuracy without disclaimer in marketing; promo T&Cs not in terms; countdown timer without timestamp; encryption-at-rest claim needs verification; "אין שיתוף עם צד שלישי" but we have sub-processors; "תמיד נגישים" absolute; "תואם חוק" needs softening.

## LOW (5 findings)
Quantified savings without caveat; prescriptive AI insight language; "exactly" claims; descriptive vs prescriptive math labels; example calculations missing "היפותטי" qualifier.

## Cross-cutting recommendations
1. `terms.html` = single source of truth for refund/free-tier/promo numbers.
2. Add Sub-processors list to `privacy.html` (Google, Meta, Anthropic, Vercel, Upstash, PayPal, Coinbase).
3. "אינו ייעוץ מס/פיננסי/משפטי" footer disclaimer on any page mentioning tax terms.
4. Replace WhatsApp E2EE bubble in demo + homepage.

**Totals: 25 findings (10 HIGH, 10 MED, 5 LOW).**
