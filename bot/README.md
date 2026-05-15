# Kesef'le Bot — Apps Script Files

These files belong to the deployed bot at Apps Script project `1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo` (the same project that holds the WhatsApp webhook + master sheet code).

## What's here

- **`KESEFLE_KEYWORDS_v2.gs`** — comprehensive keyword classification system. ~700 Hebrew + English keywords across 30 subcategories. Includes:
  - 4 income categories (salary, SRC business, phone resale, misc)
  - 15 personal expense categories (food/home, food/out, transport, fuel, parking, car insurance, lime/scooter, BMW S1000, housing, comms, apps, gym, gaming, insurance, banking fees, dad, lotto)
  - 9 NEW personal categories (health, pets, entertainment, travel, gifts, clothing, beauty, education, kids, gadgets, savings, dad, lotto)
  - 9 business categories (marketing, AI/SaaS, consultants, shipping, packaging, inventory, raw materials, employees, taxes)
  - **Vertical override** (`VERTICAL_FORCE_BIZ`) — canvas/glass/print materials route to business regardless of prefix (specific to the founder's custom-print vertical)
  - **`_SRC_classify_v2_(text)` function** — returns `{ category, subcategory, routes_to, sheet, is_income, confidence, matched_keyword, amount, is_biz_prefixed, needs_question }`
  - Confidence rubric: 95 (explicit prefix+kw) / 90 (long keyword) / 85 (short keyword) / 50 (conflict — ask user) / 0 (no match)

## How to deploy

**Option A — Dual-run alongside existing classifier (recommended):**
1. Copy `KESEFLE_KEYWORDS_v2.gs` content into a new file in the Apps Script editor.
2. Save (Cmd+S).
3. The `SRC_ROUTER_handle()` function in `model/6` can call `_SRC_classify_v2_(text)` first. If `result.confidence >= 70`, use it. Else, fall back to existing `_SRC_explicitMatch_` or `mpClassify_`.
4. Run for 7 days to validate against historical messages.
5. Promote to primary once accuracy verified.

**Option B — Replace immediately:**
1. Same file copy.
2. Modify `SRC_ROUTER_handle()` to use `_SRC_classify_v2_(text)` exclusively.
3. Monitor `_AUDIT_` tab (already auto-created by R&D pass) for misclassifications.

## Test inputs (golden set)

After deployment, run these through `_SRC_classify_v2_` and verify:
```
"245 סופר" → אוכל לבית, personal, conf 90
"60 וולט" → אוכל בחוץ, personal, conf 90
"42 קפה" → אוכל בחוץ, personal, conf 90
"עסק 300 פייסבוק" → עלות שיווק, business, conf 90
"300 פייסבוק" → needs_question (ambiguous), conf 50
"2500 קנבס 50x70" → חומרי גלם, business, conf 85 (vertical override)
"15000 משכורת" → הכנסה 1, personal, is_income=true
"מכרתי אייפון 1500" → הכנסה 3, personal, is_income=true
"200 וטרינר" → חיות, personal
"ביטוח חיים 290" → ביטוחים, personal
"39 נטפליקס" → אפליקציות, personal
"runway 35$" → עלות שיווק (AI/SaaS), business (vertical NOT, but biz-only kw + always business for AI tools)
```

## Existing bot architecture (unchanged)

The bot already has these working features:
- Installments parser (`X תשלומים Y`)
- Standing orders parser (`הוראת קבע`)
- Multi-month writer routing to `מאזן חברה` (hidden raw AB-AM) or `תנועות`
- Cell notes (every routed message saved as a note on col A)
- Router with `INSTALLMENT_GUARD_` catching installment/recurring first

Don't break these. The new classifier supersedes only the category-detection step, not the multi-month or installment logic.
