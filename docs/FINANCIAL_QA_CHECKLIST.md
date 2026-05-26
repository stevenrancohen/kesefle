# Financial Formula QA Checklist — מאזן חברה

The product is a finance tool. If the numbers lie, the product is worthless. This document defines what "correct" means for every metric in מאזן חברה and how to verify it.

**Run before every release. Run after every formula change. Run on the first of every month.**

---

## The metrics (in order they appear on the dashboard)

| # | Hebrew name | English | Formula (semantic) | Cell type |
|---|---|---|---|---|
| 1 | מחזור ברוטו | Gross revenue | Σ amount where cat=עסק AND H=FALSE (income) AND sub or desc matches `מחזור\|revenue\|sale\|sales\|gross` | Direct sum |
| 2 | עלות חומרי גלם | Raw material cost | Σ amount where cat=עסק AND H=TRUE (expense) AND sub or desc matches `חומרי גלם\|raw material` | Direct sum |
| 3 | עלות שיווק | Marketing cost | Σ amount where cat=עסק AND H=TRUE AND sub or desc matches marketing pattern (25+ keywords, see `_PSF_MARKETING_PATTERN_`) | Direct sum |
| 4 | משלוחים והתקנות | Shipping & installations | Σ amount where cat=עסק AND H=TRUE AND sub or desc matches `משלוח\|אריזה\|shipping\|packaging\|הובלה\|התקנה` | Direct sum |
| 5 | הוצאות תפעוליות | Operational expenses | Σ amount where cat=עסק AND H=TRUE AND sub or desc matches `תפעולי\|operational\|יועצים\|תוכנות\|ציוד עסקי\|מיסים\|consulting\|software\|equipment\|taxes` | Direct sum |
| 6 | סה"כ הוצאות עסקיות | Total business expenses | Σ of rows 2-5 | Computed from above |
| 7 | רווח נטו חודשי | Monthly net profit | row 1 − row 6 | Computed |
| 8 | אחוז רווחיות | Profit margin | row 7 / row 1 (× 100 for display %) | Computed |

---

## The 12 rules every metric must obey

| # | Rule | Why |
|---|------|-----|
| 1 | Only rows where `D = "עסק"` count | Personal expenses must not leak into the company dashboard |
| 2 | Income/expense direction matches the bucket | A "+5000 שיווק" (income) must NOT increase marketing cost |
| 3 | The month criterion (`B = "YYYY-MM"`) is exact-match, not LIKE | "2026-05" and "2026-5" must both work via padding, never partial match |
| 4 | Marketing keyword match is `(?i)` case-insensitive | `Facebook`, `facebook`, `FACEBOOK` all count |
| 5 | A row is counted ONCE even if subcat AND description both match | `SUMPRODUCT(((REGEXMATCH(E)+REGEXMATCH(F))>0))`, not addition |
| 6 | Formulas reference `'תנועות'!`, never local-column ranges | A SUMIFS without sheet prefix reads from the dashboard tab itself → 0 |
| 7 | No hardcoded `+ N` or `- N` suffix on formulas | Only allowed exception: 2026-05 marketing gets `+2100` (Steven's cash) |
| 8 | Net profit formula doesn't subtract revenue twice | Common typo — must verify visually |
| 9 | Profit margin formula uses `IFERROR(.../revenue, 0)` | Zero-revenue months must show 0%, not `#DIV/0!` |
| 10 | Year scoping — formula references the YEAR of the block it's in | The 2024 block must filter `B = "2024-MM"`, not the current B4 year |
| 11 | New rows added to תנועות are picked up automatically | Ranges must extend to row 5000 (or use C:C/B:B unbounded) |
| 12 | Per-business tabs (PR #35) are summed in or explicitly excluded | After PR #35, biz tabs exist alongside תנועות — clarify which dashboards aggregate which |

---

## How to verify

### Daily — read-only audit (1 minute)
1. Open the bot's Apps Script editor.
2. Function dropdown → `AUDIT_COMPANY_DASHBOARD` → Run.
3. View → Logs (Cmd+Enter).
4. Expected: `🎉 Dashboard matches תנועות exactly.`
5. Any `❌ MISMATCH` line tells you cell address, current value, expected value, and delta.

### After making any change to formulas
1. Run `AUDIT_COMPANY_DASHBOARD` first — record baseline mismatches.
2. Run `FIX_ALL_BUCKETS_ALL_YEARS` (or whatever fix function applies).
3. Run `AUDIT_COMPANY_DASHBOARD` again — expect 0 mismatches.

### Synthetic regression test
Send these 10 expenses to the bot in one batch (Steven's QA spec):
| Message | Should land as |
|---|---|
| `500 שיווק` | עלות שיווק |
| `1200 פייסבוק` | עלות שיווק |
| `800 Google Ads` | עלות שיווק |
| `1500 קמפיין` | עלות שיווק |
| `99 Canva` | עלות שיווק |
| `245 סופר` | (personal — NOT in dashboard) |
| `1800 שכירות` | (personal — NOT in dashboard) |
| `350 חשמל` | (personal — NOT in dashboard) |
| `+3000 הכנסה מלקוח` | מחזור ברוטו (revenue, NOT marketing) |
| `220 דלק` | (personal — NOT in dashboard) |

Expected after running `AUDIT_COMPANY_DASHBOARD`:
- Current month marketing = ₪500 + 1200 + 800 + 1500 + 99 = **₪4,099**
- Current month revenue = **₪3,000**
- Marketing cost must NOT include 245/1800/350/220 (personal) or 3000 (income)

---

## Files involved

| File | Role |
|---|---|
| `bot/personal_sheet_fix.gs` | All Apps Script repair + audit functions |
| `bot/test_marketing_formula.js` | Node tests for regex + bucket classification |
| `docs/SHEET_FORMULAS.md` | Architecture reference (formulas, bug classes) |
| `docs/FINANCIAL_QA_CHECKLIST.md` | This document |
| `bot/ExpenseBot_FIXED.gs` `_writeBusinessNExpense_` | Bot side — writes 8-col rows with cat="עסק", H=isExpense |

---

## Known gaps tracked

| # | Gap | Tracked where | Severity |
|---|-----|---------------|----------|
| 1 | מאזן חברה only sums `תנועות`, not per-business tabs created by PR #35 | `docs/SHEET_FORMULAS.md`, `SCAN_BUSINESS_TABS()` Apps Script function | MED — only affects users with multiple biz tabs |
| 2 | The 2026-05 marketing +2100 manual override is hardcoded in `FIX_ALL_BUCKETS_ALL_YEARS` | Code comment | LOW — explicit + documented |
| 3 | Description-side regex match relies on the bot writing sensible descriptions | Bot has `matchCategory` for this | MED — bot-side issue, not formula-side |
| 4 | Per-tenant (non-owner) dashboards do not exist yet | `docs/TENANT_ISOLATION_MODEL.md` | LOW — owner-only feature for now |

---

## Pass/fail criteria for release

A release is **financially trustworthy** when:
- ✅ `AUDIT_COMPANY_DASHBOARD` returns 0 mismatches for the current year
- ✅ `bot/test_marketing_formula.js` is 100% passing
- ✅ The synthetic 10-message regression above lands correctly
- ✅ No `❌` lines in the previous month's audit log

A release is **NOT shippable** when:
- ❌ Any mismatch exists in the current month
- ❌ Any cell shows a formula matching `_isBrokenDashFormula_`
- ❌ Revenue line includes any row where H=TRUE (expense)
- ❌ Any cost bucket includes any row where H=FALSE (income)
- ❌ Tests fail
