// lib/sheet-writer.js
//
// Shared helpers for writing rows into a Kesefle tenant's personal Google
// Sheet using their stored Google OAuth refresh token. Extracted from
// api/whatsapp/webhook.js so multiple callers (the WhatsApp webhook for
// users whose Meta webhook is pointed at Vercel, and the Apps-Script
// bridge endpoint /api/sheet/append for users whose webhook still lands
// in Apps Script) can share the same encryption + retry behaviour.
//
// Every function here treats the tenant boundary as load-bearing:
// each row is written to the user's OWN sheet via the user's OWN OAuth
// token. The Kesefle backend never sees the cell values, just the API call.
//
// 2026-05-23: the per-tenant spec was rewritten to mirror Steven's xlsx
// template exactly (4 tabs: transactions, orders, personal dashboard,
// company dashboard). The buggy total-row ranges in the original xlsx are
// corrected here (see PERSONAL DASHBOARD section comments).

import { decryptRefreshToken } from './crypto.js';
import { EXPENSE_GROUPS, INCOME_GROUPS } from './categories.js';
import { recordSheetCall } from './sheet-quota.js';
// Tab names are centralized in lib/sheet-tabs.js (single source of truth).
// They are re-exported below for backwards compatibility with existing
// importers of this module.
import {
  TX_TAB,
  ORDERS_TAB,
  PERSONAL_DASHBOARD_TAB,
  COMPANY_DASHBOARD_TAB,
  EXTENDED_DASHBOARD_TAB,
  GROUP_LEDGER_TAB,
} from './sheet-tabs.js';

// Transactions tab columns (A:I) -- the bot writes one row per expense/income
// here, and the dashboards SUMIFS by col B ("YYYY-MM") + col D (top category)
// + col E (subcategory). This column order is load-bearing for the dashboard
// formulas below; do not reorder without updating both the dashboards AND
// buildExpenseRow.
//
// Column I "ניכוי מע״מ" (2026-05-24) is the VAT-deductible flag for עוסק
// מורשה users — TRUE = the row's amount is VAT-deductible at year-end. The
// dashboards do NOT SUMIFS on col I (it's a side-channel used by
// /api/sheet/tax-report); existing sheets that lack col I keep working
// because the Sheets append API extends the range automatically and our
// self-heal seeds the header from TX_HEADERS.
const TX_HEADERS = ['תאריך', 'חודש', 'סכום', 'קטגוריה', 'תת-קטגוריה', 'פירוט', 'מקור', 'סטטוס', 'ניכוי מע״מ'];

// Orders tab columns (A:H) -- the bot writes here when the group/business
// command fires (a sale, a customer order). Date in col A is a real Sheets
// date so the company dashboard's DATE()-based SUMIFS work.
const ORDERS_HEADERS = ['תאריך', 'שם לקוח', 'גודל / תיאור', 'סכום', 'מטבע', 'מקור', 'raw', 'timestamp'];

// Personal dashboard row groups. Counts are load-bearing: the section-total
// SUM ranges below depend on these lengths (income=4, fixed=12, variable=3,
// food=2, transport=8, misc=5). All rows are user-customizable -- they can
// rename a row in column A and the SUMIFS auto-rebinds because the formula
// references $A{row}.
const PERSONAL_INCOME_ROWS = [
  'הכנסה 1 — משכורת',
  'הכנסה 2 — עסק',
  'הכנסה 3 — נוסף',
  'שונות (הכנסות)',
];
// 2026-05-25: row labels are SUMIFS criteria — they must match what the
// classifier actually writes. Dead rows (אופציה 1-5, פלייסטיישן, אופנוע,
// אטרקציות) renamed to live concepts that classifier produces. Same row
// COUNT per section so the section-total ranges below stay valid.
//
// 2026-05-31 (docs/AUDIT_BOT_DASHBOARD_CROSS_REF_2026_05_31.md Bug #4):
// Renamed 'תינוקות' (plural) → 'תינוק' (singular). The SUMIFS criterion
// becomes `*תינוק*` which is a strict superset of `*תינוקות*` — old
// data with subcategory 'חיתולים ותינוקות' / 'מזון תינוקות ופעוטות'
// still matches (those strings contain 'תינוק'), AND we now also catch
// the granular baby-product subs the bot was already writing but the
// dashboard silently dropped: 'ציוד וטיפוח לתינוק', 'עגלות תינוק',
// 'מנשאי תינוק', 'רהיטי תינוק', 'בגדי תינוק', etc.
const PERSONAL_FIXED_ROWS = [
  'בית', 'מכון כושר', 'אפליקציות', 'תקשורת', 'לימודים',
  'ביטוח אישי', 'בנקאות', 'מנויים דיגיטליים', 'חשמל', 'מים',
  'תחזוקת בית', 'תינוק',
];
// 2026-05-29 deep-review WS4: חופשות promoted to its own row per Steven's
// decision. Previously vacation spending fell into "שונות" / "בילויים" or
// was hidden inside "נסיעות" elsewhere; users want a clear separate annual
// total for vacation budgeting. The bot's interactive picker already lists
// "חופשות" as a distinct subcategory (see bot/ExpenseBot_FIXED.gs around
// line 5910), so the SUMIFS wildcard match on the new row label will sweep
// up every classifier write that lands in col E with "חופשות" anywhere in
// the subcategory string. Adding this row shifts every section-total below
// by one (variable 3 -> 4 rows), so R10's overall expense sum and the
// downstream section-total ranges are updated to match.
const PERSONAL_VARIABLE_ROWS = [
  'מתנות', 'חיות מחמד', 'תרופות', 'חופשות',
];
const PERSONAL_FOOD_ROWS = [
  'אוכל לבית', 'אוכל בחוץ',
];
// 2026-05-29 deep-review WS4: row label aligned with the bot CATEGORY_MAP
// writes. The classifier writes "אחזקת רכב" into col E (תת-קטגוריה) for car-
// maintenance keywords (see bot/ExpenseBot_FIXED.gs around line 315). The
// personal dashboard's SUMIFS criterion is "*"&$A{row}&"*" -- so the row
// label must be a substring of what the bot writes, OR vice-versa. Before
// this fix the label was "תחזוקת רכב" (ת prefix) and the SUMIFS produced
// "*תחזוקת רכב*", which never matched "אחזקת רכב" (א prefix). Result: every
// car-maintenance expense vanished from the personal dashboard. Pa'amonim
// taxonomy in lib/categories.js still uses the historical "תחזוקת רכב" so
// the extended dashboard remains consistent with the standard; only the
// simple personal-dashboard row label is renamed here.
const PERSONAL_TRANSPORT_ROWS = [
  'דלק', 'חניה', 'מונית', 'ליים', 'אחזקת רכב', 'תחבורה ציבורית', 'ביטוח רכב', 'מוסך',
];
const PERSONAL_MISC_ROWS = [
  'ביגוד', 'טיפוח', 'בריאות', 'בילויים', 'שונות',
];

// Company dashboard rows. The SUMIFS criterion is hard-coded in the formula
// (col D = "עסק" AND col E = <subcategory>); user can rename the display
// label in A but to change the criterion they edit the formula.
// Each entry's `criteria` is an ARRAY of SUMIFS subcategory criteria that
// all roll into the same dashboard row. The generated formula sums each
// SUMIFS together (one per criterion).
//
// Why arrays + wildcards: the bot classifier writes a few different
// strings into col E for the same business concept — e.g. "שיווק" /
// "עלות שיווק", or "תוכנות" / "ציוד עסקי" / "מיסים" / "הוצאות תפעוליות"
// (all of which the interactive picker maps to "הוצאות תפעוליות"). Before
// this fix the dashboard SUMIFS was a single literal string criterion and
// every business expense vanished from the dashboard. Steven 2026-05-25.
//
// Wildcards (`*X*`) are supported in SUMIFS text criteria in Google Sheets.
const COMPANY_EXPENSE_ROWS = [
  { label: '🎨 עלות חומרי גלם',  criteria: ['*חומרי גלם*'] },
  { label: '📣 עלות שיווק',      criteria: ['*שיווק*'] },
  { label: '🚚 משלוחים והתקנות', criteria: ['*משלוח*', '*אריזה*'] },
  // Ops row catches every operating-cost string the classifier + the normalizer
  // (normalizeSubcategoryForDashboard / _normalizeSubForDashboard_) can now emit
  // for col E. ROOT CAUSE #2 (business users): the bot writes the CANONICAL
  // strings "הוצאות תפעוליות" / "יועצים" / "קולקציות" but the old criteria only
  // matched the umbrella "*תפעולי*" plus a few EXACT sub-labels, so consultants,
  // accountants and product collections landed in no row and the cost vanished
  // from מאזן חברה. All criteria are wildcards now (only ever WIDEN the match,
  // tenant-safe) and include the advisor / accountant / collection vocabulary.
  // NB Hebrew final-form letters: "יועץ" (final ץ, standalone) vs "יועצים"
  // (medial צ) need BOTH "*יועץ*" and "*יועצ*" or "יועץ מס" slips through.
  { label: '🏢 הוצאות תפעוליות', criteria: ['*תפעולי*', '*הוצאות תפעוליות*', '*יועצ*', '*יועץ*', '*ייעוץ*', '*רואה חשבון*', '*קולקצי*', '*תוכנות*', '*תוכנה*', '*ציוד עסקי*', '*מיסים*'] },
];

const MONTH_NAMES_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

// ─── Cell helpers ──────────────────────────────────────────────────────────
function _sw_str(s) { return { userEnteredValue: { stringValue: String(s == null ? '' : s) } }; }
function _sw_num(n) { return { userEnteredValue: { numberValue: Number(n) } }; }
function _sw_formula(f) { return { userEnteredValue: { formulaValue: f } }; }
function _sw_bold(cell) { cell.userEnteredFormat = Object.assign({}, cell.userEnteredFormat || {}, { textFormat: { bold: true } }); return cell; }
function _sw_bg(cell, rgb) { cell.userEnteredFormat = Object.assign({}, cell.userEnteredFormat || {}, { backgroundColor: rgb }); return cell; }
function _sw_align(cell, h) { cell.userEnteredFormat = Object.assign({}, cell.userEnteredFormat || {}, { horizontalAlignment: h }); return cell; }
function _sw_currencyFmt(cell) {
  cell.userEnteredFormat = Object.assign({}, cell.userEnteredFormat || {}, {
    numberFormat: { type: 'CURRENCY', pattern: '#,##0.00 ₪' },
  });
  return cell;
}
function _sw_percentFmt(cell) {
  cell.userEnteredFormat = Object.assign({}, cell.userEnteredFormat || {}, {
    numberFormat: { type: 'PERCENT', pattern: '0.0%' },
  });
  return cell;
}
function _sw_row(cells) { return { values: cells }; }
function _sw_blank() { return { values: [] }; }

// Year selector values for the dataValidation dropdown on B1/B2/B4. Covers
// the historical-data window (2023+) up through near-future planning years
// (2030). Bump the end when needed -- the dashboards already use INDIRECT-
// safe SUMIFS keyed on the cell's value, so widening the list does not break
// any existing tenant sheet.
//
// 2026-05-29 deep-review WS4: before this list existed, the B-cell was a
// plain number with no validation -- one accidental Backspace by a fresh
// tenant blanked the cell and every SUMIFS dashboard formula silently
// returned 0. The strict ONE_OF_LIST condition below means Sheets refuses
// to accept any non-listed value, so the cell can never go blank or hold
// garbage like "20226" / "twenty-twenty-five".
const YEAR_SELECTOR_VALUES = ['2023', '2024', '2025', '2026', '2027', '2028', '2029', '2030'];

// Wraps a cell (e.g. the output of _sw_num(year)) with a strict ONE_OF_LIST
// dataValidation rule using YEAR_SELECTOR_VALUES. The result is a valid
// CellData object per Sheets API v4 -- `dataValidation` is a sibling of
// `userEnteredValue` / `userEnteredFormat` and gets sent on the initial
// POST /v4/spreadsheets create call (no separate batchUpdate needed).
//
// `showCustomUi: true` renders the dropdown arrow on the cell. `strict: true`
// means Sheets rejects writes of anything not in the list (clipboard paste,
// typed values, formula output). The user can still pick a different year
// from the dropdown -- this only blocks ACCIDENTAL deletion/garbage input.
function _sw_yearSelector(cell) {
  cell.dataValidation = {
    condition: {
      type: 'ONE_OF_LIST',
      values: YEAR_SELECTOR_VALUES.map(function (v) {
        return { userEnteredValue: v };
      }),
    },
    inputMessage: 'בחר/י שנה מהרשימה',
    strict: true,
    showCustomUi: true,
  };
  return cell;
}

// Brand colors lifted from the homepage palette: brand-50 (light green) for
// section headers, ink-50 for header rows, accent-500 (purple) for the title.
const RGB_BRAND_50 = { red: 0.94, green: 0.99, blue: 0.96 };
const RGB_INK_50 = { red: 0.97, green: 0.97, blue: 0.98 };
const RGB_BRAND_100 = { red: 0.86, green: 0.99, blue: 0.91 };
const RGB_ACCENT_50 = { red: 0.97, green: 0.94, blue: 0.99 };

// ─── Build the תנועות (transactions) tab ───────────────────────────────────
function _buildTxTab() {
  const header = _sw_row(TX_HEADERS.map(function (h) {
    return _sw_bg(_sw_bold(_sw_str(h)), RGB_INK_50);
  }));
  return {
    properties: {
      title: TX_TAB,
      index: 1,
      // 9 columns to accommodate col I "ניכוי מע״מ" (the VAT-deductible flag
      // for עוסק מורשה users). Keep frozenRowCount=1 so the header sticks.
      gridProperties: { frozenRowCount: 1, columnCount: 9 },
    },
    data: [{ startRow: 0, startColumn: 0, rowData: [header] }],
  };
}

// ─── Build the הזמנות (orders) tab ─────────────────────────────────────────
function _buildOrdersTab() {
  const header = _sw_row(ORDERS_HEADERS.map(function (h) {
    return _sw_bg(_sw_bold(_sw_str(h)), RGB_INK_50);
  }));
  return {
    properties: {
      title: ORDERS_TAB,
      index: 2,
      gridProperties: { frozenRowCount: 1, columnCount: 8 },
    },
    data: [{ startRow: 0, startColumn: 0, rowData: [header] }],
  };
}

// ─── Personal dashboard helpers ───────────────────────────────────────────
// Returns a row of cells for a single category line. Col A = label, Col B =
// SUM(C:N) annual, Cols C..N = monthly SUMIFS keyed by year-month in $B$2.
// 2026-05-25 fix: SUMIFS criterion was a literal $A{row} match, so any
// classifier write with a longer subcategory ("אוכל בחוץ — מסעדה",
// "מוצרי טיפוח ויופי", "תקשורת - ספקי אינטרנט וכו'") silently leaked.
// Wrap the row label with `*X*` wildcards (Sheets SUMIFS supports them
// in text criteria). The row label still shows clean Hebrew; the formula
// matches every variant whose subcategory CONTAINS that label.
function _personalCategoryRow(rowNum, label) {
  const cells = [];
  cells.push(_sw_str(label)); // A
  cells.push(_sw_currencyFmt(_sw_formula(`=SUM(C${rowNum}:N${rowNum})`))); // B
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    cells.push(_sw_currencyFmt(_sw_formula(
      `=IFERROR(SUMIFS('${TX_TAB}'!C:C, '${TX_TAB}'!B:B, $B$2&"-${mm}", '${TX_TAB}'!E:E, "*"&$A${rowNum}&"*"), 0)`
    )));
  }
  return _sw_row(cells);
}

// Section-header row (e.g. "🏠 הוצאות קבועות"). Just the label in A, lightly
// shaded. Spans full width visually but only one cell with value.
function _personalSectionHeader(label, rgb) {
  const a = _sw_bg(_sw_bold(_sw_str(label)), rgb || RGB_BRAND_50);
  return _sw_row([a]);
}

// Section-total row. Col A = label, Col B = SUM of section B's, Cols C..N =
// SUM of section C..N's (so monthly totals work, not just annual).
function _personalSectionTotal(label, firstRow, lastRow) {
  const cells = [];
  cells.push(_sw_bg(_sw_bold(_sw_str(label)), RGB_BRAND_100));
  cells.push(_sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula(`=SUM(B${firstRow}:B${lastRow})`))), RGB_BRAND_100));
  const colLetters = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'];
  for (let i = 0; i < 12; i++) {
    const cl = colLetters[i];
    cells.push(_sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula(`=SUM(${cl}${firstRow}:${cl}${lastRow})`))), RGB_BRAND_100));
  }
  return _sw_row(cells);
}

// ─── Build the מאזן אישי (personal dashboard) tab ──────────────────────────
//
// Layout (1-indexed rows). 2026-05-29 deep-review WS4: variable section
// expanded from 3 -> 4 rows (added חופשות), which shifts every row from
// R35 downward by 1. R10's overall expense sum + every subsequent section-
// total range was updated to match.
//
//   R1  : title (purple bg)
//   R2  : "📅 שנה:" | <year>   (B2 dropdown: YEAR_SELECTOR_VALUES)
//   R3  : header (קטגוריה | סיכום שנתי | ינואר..דצמבר)
//   R4  : 📥 הכנסות (section header)
//   R5-8: 4 income categories
//   R9  : סה״כ הכנסות (SUM(B5:B8))
//   R10 : סה״כ הוצאות = B28+B35+B40+B51+B59 (sum of section totals)
//   R11 : 💰 נטו / חיסכון = B9-B10
//   R12 : 📊 אחוז חיסכון = IFERROR(B11/B9, 0)
//   R13 : (blank)
//   R14 : 📤 הוצאות (header)
//   R15 : 🏠 הוצאות קבועות (sub-header)
//   R16-27: 12 fixed expense categories
//   R28 : סה״כ הוצאות קבועות (SUM(B16:B27))
//   R29 : (blank)
//   R30 : ⚡ הוצאות זמניות (sub-header)
//   R31-34: 4 variable categories (was 3, +חופשות 2026-05-29)
//   R35 : סה״כ הוצאות זמניות (SUM(B31:B34))
//   R36 : (blank)
//   R37 : 🍽️ אוכל (sub-header)
//   R38-39: 2 food categories
//   R40 : סה״כ אוכל (SUM(B38:B39))
//   R41 : (blank)
//   R42 : 🚗 תחבורה (sub-header)
//   R43-50: 8 transport categories
//   R51 : סה״כ תחבורה (SUM(B43:B50))
//   R52 : (blank)
//   R53 : 🎁 שונות ואחרים (sub-header)
//   R54-58: 5 misc categories
//   R59 : סה״כ שונות (SUM(B54:B58))
function _buildPersonalDashboardTab(defaultYear) {
  const rows = [];

  // R1: title
  const r1 = _sw_row([
    _sw_str(''),
    _sw_bg(_sw_bold(_sw_str('📊  מאזן אישי — הוצאות והכנסות')), RGB_ACCENT_50),
  ]);
  rows.push(r1);

  // R2: year selector. B2 gets a strict ONE_OF_LIST dataValidation rule
  // (YEAR_SELECTOR_VALUES) so the cell can never be accidentally blanked --
  // the SUMIFS formulas below all reference $B$2 and would silently return
  // 0 if it were empty. See _sw_yearSelector comment for the rationale.
  const r2 = _sw_row([
    _sw_bold(_sw_str('📅 שנה:')),
    _sw_yearSelector(_sw_bold(_sw_num(defaultYear))),
  ]);
  rows.push(r2);

  // R3: column header (קטגוריה | סיכום שנתי | ינואר..דצמבר)
  const r3cells = [
    _sw_bg(_sw_bold(_sw_str('קטגוריה')), RGB_INK_50),
    _sw_bg(_sw_bold(_sw_str('סיכום שנתי')), RGB_INK_50),
  ];
  MONTH_NAMES_HE.forEach(function (m) {
    r3cells.push(_sw_bg(_sw_bold(_sw_str(m)), RGB_INK_50));
  });
  rows.push(_sw_row(r3cells));

  // R4: 📥 הכנסות header
  rows.push(_personalSectionHeader('📥 הכנסות'));

  // R5-8: income categories
  PERSONAL_INCOME_ROWS.forEach(function (label, i) {
    rows.push(_personalCategoryRow(5 + i, label));
  });

  // R9: סה״כ הכנסות = SUM(B5:B8) + monthly SUMs
  rows.push(_personalSectionTotal('סה״כ הכנסות', 5, 8));

  // R10: סה״כ הוצאות = sum of expense section totals
  // 2026-05-29 WS4: section totals shifted (variable 34->35, food 39->40,
  // transport 50->51, misc 58->59) because חופשות joined the variable rows.
  // Cells: A label, B = formula, C-N = monthly = C28+C35+C40+C51+C59 etc.
  const r10cells = [
    _sw_bg(_sw_bold(_sw_str('סה״כ הוצאות')), RGB_BRAND_100),
    _sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula('=B28+B35+B40+B51+B59'))), RGB_BRAND_100),
  ];
  ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'].forEach(function (cl) {
    r10cells.push(_sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula(`=${cl}28+${cl}35+${cl}40+${cl}51+${cl}59`))), RGB_BRAND_100));
  });
  rows.push(_sw_row(r10cells));

  // R11: 💰 נטו / חיסכון = B9-B10
  const r11cells = [
    _sw_bold(_sw_str('💰 נטו / חיסכון')),
    _sw_bold(_sw_currencyFmt(_sw_formula('=B9-B10'))),
  ];
  ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'].forEach(function (cl) {
    r11cells.push(_sw_currencyFmt(_sw_formula(`=${cl}9-${cl}10`)));
  });
  rows.push(_sw_row(r11cells));

  // R12: 📊 אחוז חיסכון = IFERROR(B11/B9, 0)
  const r12cells = [
    _sw_str('📊 אחוז חיסכון'),
    _sw_percentFmt(_sw_formula('=IFERROR(B11/B9, 0)')),
  ];
  ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'].forEach(function (cl) {
    r12cells.push(_sw_percentFmt(_sw_formula(`=IFERROR(${cl}11/${cl}9, 0)`)));
  });
  rows.push(_sw_row(r12cells));

  // R13: blank
  rows.push(_sw_blank());

  // R14: 📤 הוצאות header
  rows.push(_personalSectionHeader('📤 הוצאות', RGB_ACCENT_50));

  // R15: 🏠 הוצאות קבועות sub-header
  rows.push(_personalSectionHeader('🏠 הוצאות קבועות'));

  // R16-27: fixed expense categories (12 rows)
  PERSONAL_FIXED_ROWS.forEach(function (label, i) {
    rows.push(_personalCategoryRow(16 + i, label));
  });

  // R28: סה״כ הוצאות קבועות = SUM(B16:B27)  [FIXED from xlsx bug]
  rows.push(_personalSectionTotal('סה״כ הוצאות קבועות', 16, 27));

  // R29: blank
  rows.push(_sw_blank());

  // R30: ⚡ הוצאות זמניות sub-header
  rows.push(_personalSectionHeader('⚡ הוצאות זמניות'));

  // R31-34: variable categories (4 rows; was 3 pre-2026-05-29 WS4 -- חופשות)
  PERSONAL_VARIABLE_ROWS.forEach(function (label, i) {
    rows.push(_personalCategoryRow(31 + i, label));
  });

  // R35: סה״כ הוצאות זמניות = SUM(B31:B34)  [WS4: was B31:B33 pre-חופשות]
  rows.push(_personalSectionTotal('סה״כ הוצאות זמניות', 31, 34));

  // R36: blank
  rows.push(_sw_blank());

  // R37: 🍽️ אוכל sub-header
  rows.push(_personalSectionHeader('🍽️ אוכל'));

  // R38-39: food categories (2 rows)
  PERSONAL_FOOD_ROWS.forEach(function (label, i) {
    rows.push(_personalCategoryRow(38 + i, label));
  });

  // R40: סה״כ אוכל = SUM(B38:B39)  [WS4: shifted down 1 row]
  rows.push(_personalSectionTotal('סה״כ אוכל', 38, 39));

  // R41: blank
  rows.push(_sw_blank());

  // R42: 🚗 תחבורה sub-header
  rows.push(_personalSectionHeader('🚗 תחבורה'));

  // R43-50: transport (8 rows)
  PERSONAL_TRANSPORT_ROWS.forEach(function (label, i) {
    rows.push(_personalCategoryRow(43 + i, label));
  });

  // R51: סה״כ תחבורה = SUM(B43:B50)  [WS4: shifted down 1 row]
  rows.push(_personalSectionTotal('סה״כ תחבורה', 43, 50));

  // R52: blank
  rows.push(_sw_blank());

  // R53: 🎁 שונות ואחרים sub-header
  rows.push(_personalSectionHeader('🎁 שונות ואחרים'));

  // R54-58: misc (5 rows)
  PERSONAL_MISC_ROWS.forEach(function (label, i) {
    rows.push(_personalCategoryRow(54 + i, label));
  });

  // R59: סה״כ שונות = SUM(B54:B58)  [WS4: shifted down 1 row]
  rows.push(_personalSectionTotal('סה״כ שונות', 54, 58));

  return {
    properties: {
      title: PERSONAL_DASHBOARD_TAB,
      index: 0,
      // rowCount: 61 (was 60 before 2026-05-29 WS4) -- חופשות added one row
      // to the variable section, shifting the bottom total to R59.
      gridProperties: { frozenRowCount: 3, frozenColumnCount: 2, rowCount: 61, columnCount: 14 },
    },
    data: [{ startRow: 0, startColumn: 0, rowData: rows }],
  };
}

// ─── Build the מאזן חברה (company dashboard) tab ──────────────────────────
//
// Layout:
//   R1: title
//   R2: subtitle (description)
//   R3: blank
//   R4: "📅 שנת:" | <year>
//   R5: column header (קטגוריה | סיכום שנתי | ינואר..דצמבר)
//   R6: 💰 מחזור ברוטו (revenue from הזמנות D:D by date range)
//   R7: 📦 מס׳ הזמנות (count from הזמנות by date range)
//   R8: 🎨 עלות חומרי גלם (SUMIFS תנועות D="עסק" E="חומרי גלם")
//   R9: 📣 עלות שיווק
//   R10: 🚚 משלוחים והתקנות
//   R11: 🏢 הוצאות תפעוליות
//   R12: 🧮 סה״כ הוצאות עסקיות = SUM(B8:B11)
//   R13: 📈 רווח נטו חודשי = B6-B12
//   R14: 📊 אחוז רווחיות = IFERROR(B13/B6, 0)
function _buildCompanyDashboardTab(defaultYear) {
  const rows = [];

  // R1: title
  rows.push(_sw_row([_sw_bg(_sw_bold(_sw_str('📊  מאזן חברה — מחזור והוצאות עסקיות')), RGB_ACCENT_50)]));

  // R2: subtitle
  rows.push(_sw_row([_sw_str("נתונים מחושבים אוטומטית מהלשוניות 'תנועות' ו-'הזמנות'")]));

  // R3: blank
  rows.push(_sw_blank());

  // R4: year selector. B4 gets a strict ONE_OF_LIST dataValidation rule
  // (YEAR_SELECTOR_VALUES). Every company-dashboard SUMIFS / DATE() formula
  // below references $B$4 -- if B4 ever blanks out, the whole revenue + ops
  // grid silently returns 0. The strict validation makes accidental Backspace
  // / paste impossible. See _sw_yearSelector comment for the rationale.
  rows.push(_sw_row([
    _sw_bold(_sw_str('📅 שנת:')),
    _sw_yearSelector(_sw_bold(_sw_num(defaultYear))),
  ]));

  // R5: column header
  const r5cells = [
    _sw_bg(_sw_bold(_sw_str('קטגוריה')), RGB_INK_50),
    _sw_bg(_sw_bold(_sw_str('סיכום שנתי')), RGB_INK_50),
  ];
  MONTH_NAMES_HE.forEach(function (m) {
    r5cells.push(_sw_bg(_sw_bold(_sw_str(m)), RGB_INK_50));
  });
  rows.push(_sw_row(r5cells));

  // R6: 💰 מחזור ברוטו -- SUMIFS הזמנות D by date range
  const r6cells = [
    _sw_bold(_sw_str('💰 מחזור ברוטו')),
    _sw_bold(_sw_currencyFmt(_sw_formula('=SUM(C6:N6)'))),
  ];
  for (let m = 1; m <= 12; m++) {
    r6cells.push(_sw_currencyFmt(_sw_formula(
      `=IFERROR(SUMIFS('${ORDERS_TAB}'!D:D, '${ORDERS_TAB}'!A:A, ">="&DATE($B$4,${m},1), '${ORDERS_TAB}'!A:A, "<"&DATE($B$4,${m + 1},1)), 0)`
    )));
  }
  rows.push(_sw_row(r6cells));

  // R7: 📦 מס׳ הזמנות -- COUNTIFS by date range
  const r7cells = [
    _sw_str('📦 מס׳ הזמנות'),
    _sw_formula('=SUM(C7:N7)'),
  ];
  for (let m = 1; m <= 12; m++) {
    r7cells.push(_sw_formula(
      `=COUNTIFS('${ORDERS_TAB}'!A:A, ">="&DATE($B$4,${m},1), '${ORDERS_TAB}'!A:A, "<"&DATE($B$4,${m + 1},1))`
    ));
  }
  rows.push(_sw_row(r7cells));

  // R8-11: business expense categories. Each row's formula sums one SUMIFS
  // per criterion (multiple criteria roll into the same row -- see the
  // COMPANY_EXPENSE_ROWS comment block above for why).
  COMPANY_EXPENSE_ROWS.forEach(function (item, i) {
    const rowNum = 8 + i;
    const cells = [
      _sw_str(item.label),
      _sw_currencyFmt(_sw_formula(`=SUM(C${rowNum}:N${rowNum})`)),
    ];
    // Backwards-compat shim — earlier shape used `subcategory` (string).
    const crits = Array.isArray(item.criteria) ? item.criteria
                : (item.subcategory ? [item.subcategory] : []);
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      const parts = crits.map(function (cr) {
        // Escape any double-quote in the criterion (none in our data today,
        // belt-and-suspenders). Wildcards `*` and `?` pass through literally.
        const safe = String(cr).replace(/"/g, '""');
        return `SUMIFS('${TX_TAB}'!C:C, '${TX_TAB}'!B:B, $B$4&"-${mm}", '${TX_TAB}'!D:D, "עסק", '${TX_TAB}'!E:E, "${safe}")`;
      });
      // IFERROR wraps the whole sum so a stale/bad row gives 0, not #N/A.
      const sumExpr = parts.length ? parts.join(' + ') : '0';
      cells.push(_sw_currencyFmt(_sw_formula(`=IFERROR(${sumExpr}, 0)`)));
    }
    rows.push(_sw_row(cells));
  });

  // R12: 🧮 סה״כ הוצאות עסקיות = SUM(B8:B11) per column
  const r12cells = [
    _sw_bg(_sw_bold(_sw_str('🧮 סה״כ הוצאות עסקיות')), RGB_BRAND_100),
    _sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula('=SUM(B8:B11)'))), RGB_BRAND_100),
  ];
  ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'].forEach(function (cl) {
    r12cells.push(_sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula(`=SUM(${cl}8:${cl}11)`))), RGB_BRAND_100));
  });
  rows.push(_sw_row(r12cells));

  // R13: 📈 רווח נטו חודשי = B6-B12 per column
  const r13cells = [
    _sw_bg(_sw_bold(_sw_str('📈 רווח נטו חודשי')), RGB_BRAND_50),
    _sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula('=B6-B12'))), RGB_BRAND_50),
  ];
  ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'].forEach(function (cl) {
    r13cells.push(_sw_bg(_sw_currencyFmt(_sw_formula(`=${cl}6-${cl}12`)), RGB_BRAND_50));
  });
  rows.push(_sw_row(r13cells));

  // R14: 📊 אחוז רווחיות = IFERROR(B13/B6, 0) per column
  const r14cells = [
    _sw_str('📊 אחוז רווחיות'),
    _sw_percentFmt(_sw_formula('=IFERROR(B13/B6, 0)')),
  ];
  ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'].forEach(function (cl) {
    r14cells.push(_sw_percentFmt(_sw_formula(`=IFERROR(${cl}13/${cl}6, 0)`)));
  });
  rows.push(_sw_row(r14cells));

  return {
    properties: {
      title: COMPANY_DASHBOARD_TAB,
      index: 3,
      gridProperties: { frozenRowCount: 5, frozenColumnCount: 2, rowCount: 16, columnCount: 14 },
    },
    data: [{ startRow: 0, startColumn: 0, rowData: rows }],
  };
}

// ─── Build the פירוט מורחב (Pa'amonim-extended dashboard) tab ─────────────
//
// Adopts the full Pa'amonim "רשימת הסעיפים" taxonomy from lib/categories.js
// (16 expense groups, 86 subcategories; 3 income groups, 14 subcategories).
// Steven's brief 2026-05-24: "תבנה גם טבלאות ועוגה של הוצאות הכנסות". This
// tab is the FULL detail breakdown -- the מאזן אישי tab stays simple for
// at-a-glance use; users who want full Pa'amonim-style detail come here.
//
// Layout (per Pa'amonim convention):
//   R1: title + year selector
//   R2: column header (קטגוריה | סיכום שנתי | ינואר..דצמבר)
//   R3+: income groups, then expense groups; each group = subcategories +
//        section total. After all groups, grand totals + savings %.
//
// SUMIFS pattern per subcategory row, identical to מאזן אישי:
//   =IFERROR(SUMIFS('תנועות'!C:C, 'תנועות'!B:B, $B$1&"-MM", 'תנועות'!E:E, $A{row}), 0)
// User can rename a row in col A and the formula auto-rebinds because $A{row}
// is a reference, not a literal.
function _buildExtendedDashboardTab(defaultYear) {
  const rows = [];

  // R1: year selector in B1 (so the SUMIFS formulas can reference $B$1).
  // B1 gets a strict ONE_OF_LIST dataValidation rule (YEAR_SELECTOR_VALUES).
  // Every subcategory SUMIFS below references $B$1 -- if it blanks out, the
  // entire Pa'amonim extended dashboard silently returns 0 for all 86
  // subcategories. See _sw_yearSelector comment for the rationale.
  rows.push(_sw_row([
    _sw_bold(_sw_str('📅 שנה:')),
    _sw_yearSelector(_sw_bold(_sw_num(defaultYear))),
  ]));

  // R2: column header.
  const r2cells = [
    _sw_bg(_sw_bold(_sw_str('קטגוריה')), RGB_INK_50),
    _sw_bg(_sw_bold(_sw_str('סיכום שנתי')), RGB_INK_50),
  ];
  MONTH_NAMES_HE.forEach(function (m) {
    r2cells.push(_sw_bg(_sw_bold(_sw_str(m)), RGB_INK_50));
  });
  rows.push(_sw_row(r2cells));

  // Track section-total row positions so we can build the grand-total formula
  // + the pie chart ranges later.
  const incomeSectionTotalRows = [];  // [rowIndex, ...]
  const expenseSectionTotalRows = [];

  // Helper: emit a subcategory row (col A = label, col B = SUM(C:N),
  // C..N = SUMIFS by month + col E exact match). rowNum is 1-indexed.
  function emitSubcatRow(rowNum, label) {
    const cells = [_sw_str(label)];
    cells.push(_sw_currencyFmt(_sw_formula(`=SUM(C${rowNum}:N${rowNum})`)));
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      cells.push(_sw_currencyFmt(_sw_formula(
        `=IFERROR(SUMIFS('${TX_TAB}'!C:C, '${TX_TAB}'!B:B, $B$1&"-${mm}", '${TX_TAB}'!E:E, $A${rowNum}), 0)`
      )));
    }
    return _sw_row(cells);
  }

  // Helper: emit a section total row that SUMs the rows of a given range.
  // firstRow / lastRow are 1-indexed inclusive.
  function emitSectionTotalRow(label, firstRow, lastRow, accentBg) {
    const bg = accentBg || RGB_BRAND_100;
    const cells = [
      _sw_bg(_sw_bold(_sw_str(label)), bg),
      _sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula(`=SUM(B${firstRow}:B${lastRow})`))), bg),
    ];
    const colLetters = ['C','D','E','F','G','H','I','J','K','L','M','N'];
    for (let i = 0; i < 12; i++) {
      const cl = colLetters[i];
      cells.push(_sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula(`=SUM(${cl}${firstRow}:${cl}${lastRow})`))), bg));
    }
    return _sw_row(cells);
  }

  // Helper: emit a section header row (just the label in col A).
  function emitSectionHeader(label) {
    return _sw_row([_sw_bg(_sw_bold(_sw_str(label)), RGB_BRAND_50)]);
  }

  // ── INCOME side ────────────────────────────────────────────────────────
  // R3: 📥 הכנסות section header
  rows.push(emitSectionHeader('📥 הכנסות'));
  let currentRow = 3; // already used R1-R2; next is R3 which we just wrote.

  INCOME_GROUPS.forEach(function (group) {
    currentRow += 1;
    // Group sub-header
    rows.push(emitSectionHeader((group.icon || '') + ' ' + group.label));
    const firstSubRow = currentRow + 1;
    group.items.forEach(function (item) {
      currentRow += 1;
      rows.push(emitSubcatRow(currentRow, item));
    });
    // Section total
    currentRow += 1;
    rows.push(emitSectionTotalRow('סה״כ ' + group.label, firstSubRow, currentRow - 1));
    incomeSectionTotalRows.push(currentRow);
    // Blank spacer
    currentRow += 1;
    rows.push(_sw_blank());
  });

  // Grand income total = SUM of incomeSectionTotalRows
  currentRow += 1;
  const incomeGrandTotalRow = currentRow;
  const incomeSumExpr = incomeSectionTotalRows.map(r => `B${r}`).join('+');
  {
    const cells = [
      _sw_bg(_sw_bold(_sw_str('💰 סה״כ הכנסות')), RGB_BRAND_100),
      _sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula('=' + incomeSumExpr))), RGB_BRAND_100),
    ];
    const colLetters = ['C','D','E','F','G','H','I','J','K','L','M','N'];
    for (let i = 0; i < 12; i++) {
      const cl = colLetters[i];
      const sumExpr = incomeSectionTotalRows.map(r => `${cl}${r}`).join('+');
      cells.push(_sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula('=' + sumExpr))), RGB_BRAND_100));
    }
    rows.push(_sw_row(cells));
  }
  currentRow += 1;
  rows.push(_sw_blank());

  // ── EXPENSE side ───────────────────────────────────────────────────────
  currentRow += 1;
  rows.push(emitSectionHeader('📤 הוצאות'));

  EXPENSE_GROUPS.forEach(function (group) {
    currentRow += 1;
    rows.push(emitSectionHeader((group.icon || '') + ' ' + group.label));
    const firstSubRow = currentRow + 1;
    group.items.forEach(function (item) {
      currentRow += 1;
      rows.push(emitSubcatRow(currentRow, item));
    });
    currentRow += 1;
    rows.push(emitSectionTotalRow('סה״כ ' + group.label, firstSubRow, currentRow - 1));
    expenseSectionTotalRows.push(currentRow);
    currentRow += 1;
    rows.push(_sw_blank());
  });

  // Grand expense total
  currentRow += 1;
  const expenseGrandTotalRow = currentRow;
  const expenseSumExpr = expenseSectionTotalRows.map(r => `B${r}`).join('+');
  {
    const cells = [
      _sw_bg(_sw_bold(_sw_str('💸 סה״כ הוצאות')), RGB_BRAND_100),
      _sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula('=' + expenseSumExpr))), RGB_BRAND_100),
    ];
    const colLetters = ['C','D','E','F','G','H','I','J','K','L','M','N'];
    for (let i = 0; i < 12; i++) {
      const cl = colLetters[i];
      const sumExpr = expenseSectionTotalRows.map(r => `${cl}${r}`).join('+');
      cells.push(_sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula('=' + sumExpr))), RGB_BRAND_100));
    }
    rows.push(_sw_row(cells));
  }

  // Net + savings %
  currentRow += 1;
  rows.push(_sw_row([
    _sw_bold(_sw_str('💰 נטו / חיסכון')),
    _sw_bold(_sw_currencyFmt(_sw_formula(`=B${incomeGrandTotalRow}-B${expenseGrandTotalRow}`))),
  ]));
  currentRow += 1;
  rows.push(_sw_row([
    _sw_str('📊 אחוז חיסכון'),
    _sw_percentFmt(_sw_formula(`=IFERROR((B${incomeGrandTotalRow}-B${expenseGrandTotalRow})/B${incomeGrandTotalRow}, 0)`)),
  ]));

  // Attach the section-total-row indices to the tab object so
  // createUserSheetWithToken can wire up pie charts post-create.
  const tab = {
    properties: {
      title: EXTENDED_DASHBOARD_TAB,
      index: 4,
      gridProperties: { frozenRowCount: 2, frozenColumnCount: 2, rowCount: Math.max(currentRow + 5, 200), columnCount: 14 },
    },
    data: [{ startRow: 0, startColumn: 0, rowData: rows }],
  };
  tab._meta = { incomeSectionTotalRows, expenseSectionTotalRows };
  return tab;
}

// ─── Public: build the full spreadsheet spec ──────────────────────────────
//
// Returns the body of POST /v4/spreadsheets that creates a fresh per-tenant
// tracker matching Steven's xlsx template (4 tabs + dashboards). Pure (no I/O).
//
// The Sheets API expects en_US formula syntax (comma separators) even when
// the spreadsheet locale is he_IL. createUserSheetWithToken retries WITHOUT
// the locale property if Google rejects it, so the formula syntax is the
// only thing that determines correctness here.
export function buildTenantSheetSpec(name, opts) {
  const o = opts || {};
  const defaultYear = (typeof o.year === 'number' && o.year >= 2000 && o.year < 3000)
    ? o.year
    : new Date().getFullYear();
  return {
    properties: {
      title: String(name || "כספ'לה").slice(0, 200),
      // Google Sheets uses the LEGACY code 'iw_IL' for Hebrew/Israel (not
      // 'he_IL', which the API rejects as "Unsupported locale"). If even
      // 'iw_IL' is rejected on the user's region, createUserSheetWithToken
      // retries without locale/timeZone -- formulas are en_US either way.
      locale: 'iw_IL',
      timeZone: 'Asia/Jerusalem',
    },
    // Tab order = display order in the Google Sheets UI. Steven's request:
    // "מאזן אישי" is the first thing the user should see when they open
    // their sheet (it's the dashboard, where they actually look at their
    // money). Then "תנועות" (the raw log) for power users. Orders + business
    // dashboards come after for biz users who care about them. Extended is
    // the Pa'amonim deep breakdown at the end.
    sheets: [
      _buildPersonalDashboardTab(defaultYear),
      _buildTxTab(),
      _buildOrdersTab(),
      _buildCompanyDashboardTab(defaultYear),
      _buildExtendedDashboardTab(defaultYear),
    ],
  };
}

// Compute the pie-chart batchUpdate requests for the extended dashboard tab.
// Called by createUserSheetWithToken AFTER the spreadsheet is created, since
// charts reference sheet IDs which only exist post-create.
//
// Two charts:
//   1. EXPENSE pie -- domain = A column of expense section-total rows,
//      data = B column of same rows. Anchored at the side of the tab.
//   2. INCOME pie -- same structure, 3 slices.
//
// Returns [] if we can't compute (missing meta / sheetId).
function buildPieChartRequests(extendedSheetId, extendedMeta) {
  if (!extendedSheetId || !extendedMeta) return [];
  const { incomeSectionTotalRows, expenseSectionTotalRows } = extendedMeta;
  if (!incomeSectionTotalRows?.length || !expenseSectionTotalRows?.length) return [];

  function rangeForRows(rowIndices, col) {
    // Sheets API ranges are 0-indexed and half-open. Build one source per
    // row (since rows are non-contiguous, separated by section sub-rows).
    return rowIndices.map(r => ({
      sheetId: extendedSheetId,
      startRowIndex: r - 1,  // convert 1-indexed -> 0-indexed
      endRowIndex: r,
      startColumnIndex: col,
      endColumnIndex: col + 1,
    }));
  }

  function pieRequest(title, rowIndices, anchorCol, anchorRow) {
    return {
      addChart: {
        chart: {
          spec: {
            title,
            pieChart: {
              legendPosition: 'RIGHT_LEGEND',
              threeDimensional: false,
              pieHole: 0.35,
              domain: { sources: rangeForRows(rowIndices, 0) },   // col A labels
              series: { sources: rangeForRows(rowIndices, 1) },   // col B annual totals
            },
            hiddenDimensionStrategy: 'SKIP_HIDDEN_ROWS_AND_COLUMNS',
            backgroundColor: { red: 1, green: 1, blue: 1 },
          },
          position: {
            overlayPosition: {
              anchorCell: { sheetId: extendedSheetId, rowIndex: anchorRow, columnIndex: anchorCol },
              widthPixels: 500, heightPixels: 320,
              offsetXPixels: 8, offsetYPixels: 8,
            },
          },
        },
      },
    };
  }

  return [
    // Expense pie: anchored at column P, row 1 (top-right of the data).
    pieRequest('פילוח הוצאות (לפי קטגוריה)', expenseSectionTotalRows, 15, 1),
    // Income pie: below the expense pie.
    pieRequest('פילוח הכנסות', incomeSectionTotalRows, 15, 20),
  ];
}

// Compute column-width batchUpdate requests so the tenant sheet is readable on
// a PHONE, not just desktop. Until 2026-05-31 the template NEVER set any column
// width, so col A kept Sheets' ~100px default while holding long Hebrew labels
// ("סה״כ הוצאות קבועות", "🚚 משלוחים והתקנות") that truncated on a ~375px screen,
// and the 12 month columns (C..N) rendered at full default width, burying the
// annual-summary column (B) — the one number users actually want — behind a wall
// of horizontal scroll.
//
// This sets widths ONLY (no row/column is moved, no formula touched), so it is
// position-safe with respect to every SUMIFS in the dashboards. The two frozen
// columns on each dashboard tab (A=label, B=annual) are sized so A+B together
// fit inside a narrow phone viewport (190+110 = 300px < 375px), meaning the
// category name and its annual total stay visible while the user scrolls the
// month columns sideways. Month columns are compact (78px) but still legible.
//
// Called by createUserSheetWithToken AFTER create (sheetId only exists then),
// folded into the same best-effort batchUpdate as the pie charts. Pure helper.
//
// `sheetIdByTitle` maps tab title -> numeric sheetId from the create response.
function buildColumnWidthRequests(sheetIdByTitle) {
  if (!sheetIdByTitle) return [];

  // One updateDimensionProperties request per contiguous column band.
  // `band` = [startColumnIndex (0-based, inclusive), endColumnIndex (exclusive), pixelSize].
  function widthReq(sheetId, startCol, endCol, px) {
    return {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: startCol, endIndex: endCol },
        properties: { pixelSize: px },
        fields: 'pixelSize',
      },
    };
  }

  // Per-tab width plans. Each entry: title -> array of [startCol, endCol, px].
  // Dashboard tabs share the same shape (A label / B annual / C..N months) so
  // they share the same plan; the two log tabs get column-purpose widths.
  const DASHBOARD_WIDTHS = [
    [0, 1, 190],  // A: category label (long Hebrew + section totals)
    [1, 2, 110],  // B: annual summary — kept visible next to the label (frozen)
    [2, 14, 78],  // C..N: 12 month columns — compact but readable
  ];
  const plans = {
    [PERSONAL_DASHBOARD_TAB]: DASHBOARD_WIDTHS,
    [COMPANY_DASHBOARD_TAB]: DASHBOARD_WIDTHS,
    [EXTENDED_DASHBOARD_TAB]: DASHBOARD_WIDTHS,
    // תנועות (raw log): size by column purpose so a phone shows date+amount+
    // category without horizontal scroll; פירוט (free text) gets the slack.
    [TX_TAB]: [
      [0, 1, 96],   // A תאריך
      [1, 2, 72],   // B חודש
      [2, 3, 88],   // C סכום
      [3, 4, 104],  // D קטגוריה
      [4, 5, 132],  // E תת-קטגוריה
      [5, 6, 190],  // F פירוט (free text)
      [6, 9, 80],   // G מקור / H סטטוס / I ניכוי מע״מ
    ],
    // הזמנות (orders log): customer + description are the wide ones.
    [ORDERS_TAB]: [
      [0, 1, 96],   // A תאריך
      [1, 2, 132],  // B שם לקוח
      [2, 3, 170],  // C גודל / תיאור
      [3, 4, 88],   // D סכום
      [4, 8, 80],   // E מטבע / F מקור / G raw / H timestamp
    ],
  };

  const requests = [];
  Object.keys(plans).forEach(function (title) {
    const sheetId = sheetIdByTitle[title];
    if (sheetId == null) return; // tab not in response — skip silently
    plans[title].forEach(function (band) {
      requests.push(widthReq(sheetId, band[0], band[1], band[2]));
    });
  });
  return requests;
}

// ─── Create a fresh per-tenant spreadsheet ────────────────────────────────
// Uses the user's OWN access token, so the sheet is owned by them and the
// app only ever touches this one file (drive.file scope).
export async function createUserSheetWithToken(accessToken, name, opts) {
  if (!accessToken) throw new Error('no_access_token');

  // P0 fix (2026-05-24): _buildExtendedDashboardTab attaches a `_meta` field
  // to its tab object for downstream chart construction. That field is NOT a
  // valid Google Sheets API key — sending it produced
  //   "Invalid JSON payload received. Unknown name _meta at
  //    spreadsheet.sheets[4]: Cannot find field"
  // which blocked EVERY new signup.
  //
  // Defense in depth: instead of just stripping `_meta`, whitelist the
  // Sheets API's documented sheet-object keys. Any other top-level key
  // (current OR future side-channel) is dropped before the POST. Same for
  // the top-level spec — only properties/sheets/namedRanges/developerMetadata
  // are valid on the spreadsheet body.
  const SHEET_KEYS = new Set([
    'properties', 'data', 'merges', 'conditionalFormats',
    'filterViews', 'protectedRanges', 'basicFilter', 'charts',
    'bandedRanges', 'developerMetadata', 'rowGroups', 'columnGroups',
    'slicers',
  ]);
  const SPEC_KEYS = new Set([
    'properties', 'sheets', 'namedRanges', 'developerMetadata',
    'dataSources',
  ]);
  function stripMeta(spec) {
    if (!spec || typeof spec !== 'object') return spec;
    // Strip top-level unknown keys.
    for (const k of Object.keys(spec)) {
      if (!SPEC_KEYS.has(k)) delete spec[k];
    }
    if (Array.isArray(spec.sheets)) {
      for (const sh of spec.sheets) {
        if (!sh || typeof sh !== 'object') continue;
        for (const k of Object.keys(sh)) {
          if (!SHEET_KEYS.has(k)) delete sh[k];
        }
      }
    }
    return spec;
  }

  async function attempt(spec) {
    const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(stripMeta(spec)),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  }

  let res = await attempt(buildTenantSheetSpec(name, opts));

  // Some Google accounts/regions reject locale/timeZone in properties
  // ("Unsupported locale", "Invalid properties"). Retry once WITHOUT them --
  // the tab data + SUMIFS formulas are locale-independent (the API parses
  // formulas in en_US regardless), so dropping locale never affects
  // correctness.
  if (!res.ok && /locale|invalid propert|timezone|time zone/i.test(JSON.stringify(res.j?.error || ''))) {
    const spec2 = buildTenantSheetSpec(name, opts);
    if (spec2.properties) {
      delete spec2.properties.locale;
      delete spec2.properties.timeZone;
    }
    res = await attempt(spec2);
  }

  if (!res.ok || !res.j.spreadsheetId) {
    throw new Error('sheet_create_failed: ' + (res.j?.error?.message || res.status));
  }

  const spreadsheetId = res.j.spreadsheetId;
  const spreadsheetUrl = res.j.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

  // Best-effort post-create batchUpdate: (1) mobile-friendly COLUMN WIDTHS on
  // every tab, (2) 2 pie charts (expenses + income) on the פירוט מורחב tab.
  // Both reference tabs by sheetId, which only exists after creation. If this
  // fails (network blip, permission edge case), we DO NOT fail the provision --
  // the user still gets a fully-working sheet, just with default widths and/or
  // without the visual charts. Logged via console for diagnostics.
  try {
    // Map every tab's title -> sheetId from the create response. Used for both
    // the column-width requests and the chart anchor below.
    const sheetIdByTitle = {};
    (res.j.sheets || []).forEach(function (s) {
      const t = s?.properties?.title;
      if (t != null && s.properties.sheetId != null) sheetIdByTitle[t] = s.properties.sheetId;
    });

    const widthRequests = buildColumnWidthRequests(sheetIdByTitle);

    // Re-compute the meta (section-total row indices) from the spec we just
    // sent. The build returns the tab with `._meta`, but the response from
    // the create call strips it. Rebuild fresh.
    const freshSpec = buildTenantSheetSpec(name, opts);
    const freshTab = (freshSpec.sheets || []).find(s => s.properties?.title === EXTENDED_DASHBOARD_TAB);
    const meta = freshTab?._meta;
    const chartRequests = buildPieChartRequests(sheetIdByTitle[EXTENDED_DASHBOARD_TAB], meta);

    // Widths first so the charts (which can overlap the grid) anchor against an
    // already-sized sheet. One round-trip for both.
    const requests = widthRequests.concat(chartRequests);
    if (requests.length) {
      const buRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      });
      if (!buRes.ok) {
        const err = await buRes.text().catch(() => '');
        console.warn('createUserSheetWithToken.post_create_batch_failed', { status: buRes.status, error: err.slice(0, 200) });
      }
    }
  } catch (e) {
    console.warn('createUserSheetWithToken.post_create_batch_threw', { error: e.message });
  }

  return { spreadsheetId, spreadsheetUrl };
}

// Refresh-token variant for server-side callers (e.g. group creation) that
// hold an envelope rather than a live browser access token.
export async function createUserSheetWithRefresh({ refreshTokenEnvelope, refreshToken, userSub, name, opts }) {
  let actualRefresh = refreshToken;
  if (!actualRefresh && refreshTokenEnvelope) actualRefresh = decryptRefreshToken(refreshTokenEnvelope, userSub);
  if (!actualRefresh) throw new Error('no_refresh_token');
  const accessToken = await exchangeRefreshForAccess(actualRefresh, userSub);
  return createUserSheetWithToken(accessToken, name, opts);
}

// ─── Legacy: copy a Drive template (KEPT for backwards compatibility) ─────
// New signups go through createUserSheetWithToken (drive.file, no template
// copy = no drive.readonly scope needed). This helper remains for any older
// code path that still copies a template by Drive file ID.
export async function copyTemplateToUserDrive({ refreshTokenEnvelope, refreshToken, userSub, templateId, name }) {
  if (!templateId) throw new Error('template_id_missing');
  let actualRefresh = refreshToken;
  if (!actualRefresh && refreshTokenEnvelope) {
    actualRefresh = decryptRefreshToken(refreshTokenEnvelope, userSub);
  }
  if (!actualRefresh) throw new Error('no_refresh_token');
  const accessToken = await exchangeRefreshForAccess(actualRefresh, userSub);
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(templateId)}/copy?supportsAllDrives=true`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: String(name || "כספ'לה קבוצה").slice(0, 200) }),
    }
  );
  const j = await r.json();
  if (!r.ok || !j.id) {
    throw new Error('drive_copy_failed: ' + (j?.error?.message || r.status));
  }
  return {
    spreadsheetId: j.id,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${j.id}`,
  };
}

// ─── Append helpers (write into a tenant's sheet) ─────────────────────────

// Append a row to a NAMED tab of a spreadsheet (vs the default תנועות tab).
// Used by the group ledger to write into "הוצאות קבוצה" -- auto-creates the
// tab on first write if the user's template predated it.
export async function appendRowToTab({ refreshTokenEnvelope, refreshToken, userSub, spreadsheetId, tabName, row }) {
  if (!spreadsheetId) return { ok: false, error: 'no_spreadsheet_id' };
  let actualRefresh = refreshToken;
  if (!actualRefresh && refreshTokenEnvelope) {
    try { actualRefresh = decryptRefreshToken(refreshTokenEnvelope, userSub); }
    catch (e) { return { ok: false, error: 'refresh_decrypt_failed', detail: e.message }; }
  }
  if (!actualRefresh) return { ok: false, error: 'no_refresh_token' };
  let accessToken;
  try { accessToken = await exchangeRefreshForAccess(actualRefresh, userSub); }
  catch (e) { return { ok: false, error: 'token_refresh_failed', detail: e.message }; }

  const range = encodeURIComponent(`'${tabName}'!A:Z`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const opts = (tok) => ({
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });

  let resp;
  try { resp = await fetch(url, opts(accessToken)); }
  catch (e) { return { ok: false, error: 'sheets_unreachable', detail: e.message }; }

  // If the tab doesn't exist yet, Sheets returns 400. Auto-provision it
  // and retry once -- covers users whose template was created before the
  // group tab was added.
  if (resp.status === 400) {
    const errBody = await resp.text().catch(() => '');
    if (/Unable to parse range|not found/i.test(errBody)) {
      try {
        const addTabRes = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
          }
        );
        if (addTabRes.ok) resp = await fetch(url, opts(accessToken));
      } catch (e) { /* fall through to error */ }
    }
  }
  if (resp.status === 401) {
    try {
      // Force a fresh mint — the cached token is what just got rejected.
      accessToken = await exchangeRefreshForAccess(actualRefresh, userSub, { noCache: true });
      resp = await fetch(url, opts(accessToken));
    } catch (e) { return { ok: false, error: 'token_refresh_retry_failed', detail: e.message }; }
  }
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return { ok: false, error: 'sheets_append_status_' + resp.status, detail: errText.slice(0, 200) };
  }
  return { ok: true };
}

export { GROUP_LEDGER_TAB, TX_TAB, ORDERS_TAB, PERSONAL_DASHBOARD_TAB, COMPANY_DASHBOARD_TAB, TX_HEADERS, ORDERS_HEADERS };

// ─── Cell sanitisation ────────────────────────────────────────────────────
// Formula-injection sanitiser. If a Hebrew text payload starts with =, +, -,
// @ or a tab character Sheets will interpret it as a formula under
// valueInputOption=USER_ENTERED. We use RAW + this guard so even if someone
// flips the input option later, the sanitisation still holds.
export function sanitizeCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  const s = String(v);
  if (s.length === 0) return '';
  // Strip zero-width + bidi override chars that can hide injected formulas.
  const cleaned = s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
  const firstNonSpace = cleaned.trimStart()[0];
  if (firstNonSpace === '=' || firstNonSpace === '+' || firstNonSpace === '-' || firstNonSpace === '@' || firstNonSpace === '\t') {
    return "'" + cleaned;
  }
  return cleaned;
}

// ─── Taxonomy normalization: granular subcategory -> dashboard row label ───
//
// ROOT CAUSE (the "disappearing money" bug): the classifier emits a GRANULAR
// subcategory string into col E (e.g. "אוכל לבית — שופרסל וריאציות",
// "Electronics - big chains", "שיניים"), but the dashboards exact-match
// (פירוט מורחב) or wildcard-match (מאזן אישי / מאזן חברה) col E against a much
// SMALLER set of row labels. Any granular sub that is not a substring of some
// row label hits NO row, so the amount is silently invisible on every
// dashboard -- ~59% of the classifier's distinct subcategories before this fix.
//
// FIX: normalize col E to a CANONICAL dashboard-row label before writing.
// Pipeline (first match wins) so money is NEVER invisible:
//   1. business rows (col D = "עסק") -> BIZ_SUB_TO_DASHBOARD_ROW (the 6 canonical
//      company-dashboard buckets). Unmapped business subs fall back to the ops
//      catch-all "הוצאות תפעוליות".
//   2. personal rows -> exact key in SUB_TO_DASHBOARD_ROW.
//   3. split on " — " (U+2014) and retry the prefix against the map / rows --
//      catches FUTURE "<row> — <brand>" granular subs the classifier may add.
//   4. if the value already CONTAINS a personal row label (the מאזן אישי
//      wildcard would already catch it), leave it unchanged.
//   5. ultimate catch-all -> "שונות" (a real מאזן אישי row; פירוט מורחב has a
//      "<section> - כללי" sink), so an unrecognized sub still lands somewhere.
//
// This module mirrors _KFL_SUB_TO_DASHBOARD_ROW + _normalizeSubForDashboard_ in
// bot/ExpenseBot_FIXED.gs (the Apps Script write path is a separate runtime and
// cannot import this file). Keep the two in lock-step; tests/test_taxonomy_normalize.js
// asserts every CATEGORY_MAP subcategory the bot can emit maps to a real row.

// Business subcategory -> canonical מאזן חברה bucket. Mirror of _BIZ_DASH_SUBS.
const BIZ_SUB_TO_DASHBOARD_ROW = {
  // Already-canonical (idempotent)
  'מחזור': 'מחזור',
  'עלות חומרי גלם': 'עלות חומרי גלם',
  'עלות שיווק': 'עלות שיווק',
  'משלוחים והתקנות': 'משלוחים והתקנות',
  'הוצאות תפעוליות': 'הוצאות תפעוליות',
  'יועצים': 'יועצים',
  // Raw-material variants
  'חומרי גלם': 'עלות חומרי גלם',
  'חומרים': 'עלות חומרי גלם',
  'חומר גלם': 'עלות חומרי גלם',
  'רכש': 'עלות חומרי גלם',
  'מלאי': 'עלות חומרי גלם',
  'סחורה': 'עלות חומרי גלם',
  // Marketing variants
  'שיווק': 'עלות שיווק',
  'פרסום': 'עלות שיווק',
  'קמפיין': 'עלות שיווק',
  // Shipping + install variants
  'משלוח': 'משלוחים והתקנות',
  'משלוחים': 'משלוחים והתקנות',
  'אריזה': 'משלוחים והתקנות',
  'אריזה ומשלוח': 'משלוחים והתקנות',
  'הובלה': 'משלוחים והתקנות',
  'התקנה': 'משלוחים והתקנות',
  'התקנות': 'משלוחים והתקנות',
  // Operations / everything-else-overhead variants
  'תפעוליות': 'הוצאות תפעוליות',
  'תפעול': 'הוצאות תפעוליות',
  'תוכנות': 'הוצאות תפעוליות',
  'ציוד עסקי': 'הוצאות תפעוליות',
  'מיסים': 'הוצאות תפעוליות',
  'אחר': 'הוצאות תפעוליות',
  'שונות': 'הוצאות תפעוליות',
  'שונות עסק': 'הוצאות תפעוליות',
  'קולקציות': 'הוצאות תפעוליות',
};

// Personal granular subcategory -> canonical מאזן אישי row label. Every value
// here is one of the 35 PERSONAL_*_ROWS labels (so the dashboard wildcard
// "*"&row&"*" SUMIFS sweeps it up). Generated from the classifier's CATEGORY_MAP.
const SUB_TO_DASHBOARD_ROW = {
  'אוכל בחוץ — אפליקציות משלוח': 'אוכל בחוץ',
  'מזון רחוב / קיוסקים / חטיפים': 'אוכל בחוץ',
  'משקאות — מותגים שמופיעים בהוצאות': 'אוכל בחוץ',
  'אוכל לבית — אורגני ובריאות': 'אוכל לבית',
  'אוכל לבית — גבינות ומעדנים': 'אוכל לבית',
  'אוכל לבית — דגים': 'אוכל לבית',
  'אוכל לבית — חנויות נוחות 24/7': 'אוכל לבית',
  'אוכל לבית — יין ואלכוהול': 'אוכל לבית',
  'אוכל לבית — מאפיות ולחם': 'אוכל לבית',
  'אוכל לבית — סופר מינים אחרים': 'אוכל לבית',
  'אוכל לבית — סופרמרקטים ארציים': 'אוכל לבית',
  'אוכל לבית — קמחנים ודברי מאפה': 'אוכל לבית',
  'אוכל לבית — קצביות': 'אוכל לבית',
  'אוכל לבית — שווקים פתוחים': 'אוכל לבית',
  'אוכל לבית — שופרסל וריאציות': 'אוכל לבית',
  'השכרת רכב': 'אחזקת רכב',
  'רישוי': 'אחזקת רכב',
  'רכב שכור': 'אחזקת רכב',
  'BMW s1000': 'אחזקת רכב',
  'Accessories': 'ביגוד',
  'Baby and children stores': 'ביגוד',
  'International fashion chains': 'ביגוד',
  'Israeli fashion chains - men': 'ביגוד',
  'Israeli fashion chains - women': 'ביגוד',
  'Israeli kids fashion': 'ביגוד',
  'Luxury and designer brands': 'ביגוד',
  'Online shopping additional': 'ביגוד',
  'Shoes - Israeli chains': 'ביגוד',
  'Specialty retail': 'ביגוד',
  'Sportswear chains': 'ביגוד',
  'Toys and games': 'ביגוד',
  'Travel goods': 'ביגוד',
  'Underwear and swimwear': 'ביגוד',
  'ביטוח': 'ביטוח אישי',
  'ביטוח בנייני ועסקים': 'ביטוח אישי',
  'ביטוח כללי - חברות נוספות': 'ביטוח אישי',
  'ביטוחי חיים וחיסכון - מותגי משנה': 'ביטוח אישי',
  'ספקי אבטחה ואזעקות': 'ביטוח אישי',
  'אירועים': 'בילויים',
  'בילוי ויציאה': 'בילויים',
  'חצי איירון מן': 'בילויים',
  'יציאות': 'בילויים',
  'לוטו': 'בילויים',
  'משחקי מחשב וקונסולה': 'בילויים',
  'משחקים': 'בילויים',
  'פלייסטיישן': 'בילויים',
  'נדל': 'בית',
  'נדל"ן - אגרות בנייה והיתרים': 'בית',
  'ספקי מנעולים ושירות חירום': 'בית',
  'תיווך ונדל': 'בית',
  'תיווך ונדל"ן - תשלומי שכירות': 'בית',
  'השקעות': 'בנקאות',
  'חיסכון ופנסיה - גמל וקרנות השתלמות': 'בנקאות',
  'פיקדונות, ניהול חשבון ועמלות בנקאיות': 'בנקאות',
  'שירותים מקצועיים - רואי חשבון ומיסים': 'בנקאות',
  'שירותים מקצועיים נוספים - יעוץ': 'בנקאות',
  'שירותים פיננסיים - ברוקרים והשקעות': 'בנקאות',
  'תוכנות חשבונאות וניהול': 'בנקאות',
  'תכנון פנסיוני וזכויות': 'בנקאות',
  'ביטוח רפואי - השלמות וביטוחים פרטיים': 'בריאות',
  'הוצאות לבעלי חיים - וטרינר ושירותים': 'בריאות',
  'ספורט ותוספים': 'בריאות',
  'שיניים': 'בריאות',
  'שירותי דיור מוגן וגיל הזהב': 'בריאות',
  'שירותי קלינאות והעצמה': 'בריאות',
  'שירותי שיקום וגיל הזהב': 'בריאות',
  'שכר טיפול ושיניים בילדים': 'בריאות',
  'כביש 6': 'דלק',
  'טיסות': 'חופשות',
  'מלונות': 'חופשות',
  'מרוץ - אוסטריה': 'חופשות',
  'תיירות': 'חופשות',
  'Pet food brands': 'חיות מחמד',
  'Pet stores - chains': 'חיות מחמד',
  'Veterinary': 'חיות מחמד',
  'גז': 'חשמל',
  'Beauty and cosmetics chains': 'טיפוח',
  'Hair salons and styling': 'טיפוח',
  'קורקינט': 'ליים',
  'אקדמיה - אגרות וביטוחי סטודנט': 'לימודים',
  'חינוך': 'לימודים',
  'חינוך - אוניברסיטאות ומכללות': 'לימודים',
  'חינוך - גנים ובתי ספר פרטיים': 'לימודים',
  'חינוך - חוגים והעשרה': 'לימודים',
  'חינוך - שיעורים פרטיים ובגרות': 'לימודים',
  'חינוך וטיפול': 'לימודים',
  'מוסדות אקדמיים - תקצוב מדינה': 'לימודים',
  'מוסדות חינוך - מקצועות הרפואה': 'לימודים',
  'מסלולי לימוד מבוגרים והעצמה': 'לימודים',
  'מסלולי לימוד מקצועיים ותעודות': 'לימודים',
  'קורסים מקוונים': 'לימודים',
  'כושר': 'מכון כושר',
  'כושר ומנויים': 'מכון כושר',
  'אפולו': 'מנויים דיגיטליים',
  'חדשות ומגזינים': 'מנויים דיגיטליים',
  'סטרימינג': 'מנויים דיגיטליים',
  'AI ובינה': 'מנויים דיגיטליים',
  'אבא': 'שונות',
  'אגרות תעבורה - לרכב ולמשאיות': 'שונות',
  'אישי': 'שונות',
  'אלקטרוניקה': 'שונות',
  'ביטוח לאומי - קצבאות וניכויים מיוחדים': 'שונות',
  'ביטוח לאומי - שירותים מקוונים': 'שונות',
  'גיא': 'שונות',
  'ועדת מנהלת ואיגוד מקצועי': 'שונות',
  'מוסדות תרבות וטריבליות': 'שונות',
  'מיסי חברה - תאגידי וניהול': 'שונות',
  'מיסים ואגרות': 'שונות',
  'ממשלה - מיסים, אגרות ודוחות': 'שונות',
  'נסיעות': 'שונות',
  'ספרים': 'שונות',
  'קניות מקוונות': 'שונות',
  'רהיטים': 'שונות',
  'רוביקון': 'שונות',
  'שירותי דת והלכה - גמ': 'שונות',
  'שירותי דת והלכה - גמ"חים': 'שונות',
  'שירותי דת ומועצות דתיות': 'שונות',
  'שירותים מיוחדים - גמלאים ונכים': 'שונות',
  'שירותים מקצועיים - עורכי דין': 'שונות',
  'תוכניות ושוברי תרבות': 'שונות',
  'תיירות, אגרות וביטוחי נסיעות': 'שונות',
  'Bedding and textiles': 'שונות',
  'Books and culture': 'שונות',
  'Computer and gaming': 'שונות',
  'Electronics - big chains': 'שונות',
  'Eyewear and optics': 'שונות',
  'Furniture additional': 'שונות',
  'Furniture and home decor chains': 'שונות',
  'Garden and plants': 'שונות',
  'Hardware and DIY': 'שונות',
  'Home appliances brands': 'שונות',
  'Home decor and accessories': 'שונות',
  'Home goods small chains': 'שונות',
  'Jewelry and watches': 'שונות',
  'Mobile phones and accessories': 'שונות',
  'Music stores': 'שונות',
  'Stationery and office supplies': 'שונות',
  'Watches additional': 'שונות',
  'אגף הרישוי - מבחנים לרכב': 'תחבורה ציבורית',
  'שירותי הסעות פרטיות וצי רכבים': 'תחבורה ציבורית',
  'תחבורה': 'תחבורה ציבורית',
  'תחבורה - אגד, דן וחברות אוטובוסים': 'תחבורה ציבורית',
  'תחבורה - נסיעות לחו': 'תחבורה ציבורית',
  'תחבורה - נסיעות לחו"ל וטיסות פנים ארץ': 'תחבורה ציבורית',
  'כלי עבודה': 'תחזוקת בית',
  'כסאות בטיחות לילדים': 'תינוק',
  'צעצועים ומשחקי ילדים': 'תינוק',
  'חשבונות': 'תקשורת',
  'מוקדי שירות וטלפוניה לעסקים': 'תקשורת',
  'שירותים אדמיניסטרטיביים': 'תקשורת',
  'שירותים מקצועיים - SaaS עסקי וIT': 'תקשורת',
  'Cosmetic supplements': 'תרופות',
  'Pharmacies extended': 'תרופות',
};

// The 35 canonical מאזן אישי row labels (union of PERSONAL_*_ROWS), used by the
// pipeline's "already contains a row label" + " — " prefix checks.
const _PERSONAL_DASH_ROWS = [].concat(
  PERSONAL_INCOME_ROWS, PERSONAL_FIXED_ROWS, PERSONAL_VARIABLE_ROWS,
  PERSONAL_FOOD_ROWS, PERSONAL_TRANSPORT_ROWS, PERSONAL_MISC_ROWS
);

// Normalize a (subcategory, category) pair to the dashboard row label that col E
// must hold so the amount is visible. Pure function, no side effects.
export function normalizeSubcategoryForDashboard(subcategory, category) {
  const raw = String(subcategory == null ? '' : subcategory)
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '') // strip zero-width / bidi
    .trim();
  if (!raw) return raw;

  const cat = String(category == null ? '' : category).trim();

  // 1. business rows -> canonical company bucket (ops catch-all if unmapped).
  if (cat === 'עסק') {
    return BIZ_SUB_TO_DASHBOARD_ROW[raw] || 'הוצאות תפעוליות';
  }

  // 2. exact personal mapping.
  if (Object.prototype.hasOwnProperty.call(SUB_TO_DASHBOARD_ROW, raw)) {
    return SUB_TO_DASHBOARD_ROW[raw];
  }

  // 3. " — " split: map the granular tail off a known parent ("אוכל לבית — X").
  const dash = raw.indexOf(' — ');
  if (dash >= 0) {
    const prefix = raw.slice(0, dash).trim();
    if (Object.prototype.hasOwnProperty.call(SUB_TO_DASHBOARD_ROW, prefix)) {
      return SUB_TO_DASHBOARD_ROW[prefix];
    }
    if (_PERSONAL_DASH_ROWS.indexOf(prefix) >= 0) return prefix;
  }

  // 4. already-visible: the מאזן אישי wildcard "*"&row&"*" matches when a row
  //    label is a substring of the written value. Leave such subs unchanged.
  for (let i = 0; i < _PERSONAL_DASH_ROWS.length; i++) {
    if (raw.indexOf(_PERSONAL_DASH_ROWS[i]) >= 0) return raw;
  }

  // 5. ultimate catch-all so the amount is never invisible.
  return 'שונות';
}

// ─── Build the 9-column row we write into the תנועות tab ──────────────────
//
// Column order is load-bearing for the dashboards:
//   A=תאריך (ISO date string), B=חודש ("YYYY-MM"), C=סכום (number),
//   D=קטגוריה (top-level, e.g. "עסק" or "אוכל"), E=תת-קטגוריה (matches the
//   personal-dashboard row labels like "אוכל בחוץ" or company subcategory
//   like "חומרי גלם"), F=פירוט (raw user text), G=מקור ("whatsapp"),
//   H=סטטוס ("expense" or "income"), I=ניכוי מע״מ (boolean,
//   true = VAT-deductible for עוסק מורשה year-end report).
//
// The dashboards SUMIFS on col B (month), col D (top), col E (subcategory).
// /api/sheet/tax-report SUMs col C where col I = TRUE.
// Do not reorder.
export function buildExpenseRow({ amount, category, subcategory, rawText, date, isIncome, vatDeductible }) {
  // `date` lets callers backfill a historical row (e.g. recurring catch-up
  // for a mid-month signup); defaults to now for normal live writes.
  const d = date ? new Date(date) : new Date();
  const dateISO = d.toISOString();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const monthKey = `${yyyy}-${mm}`;

  // ROOT-CAUSE FIX (disappearing money): canonicalize the granular subcategory
  // to a dashboard ROW LABEL so the SUMIFS actually picks it up. The `typeof`
  // guard keeps buildExpenseRow self-contained for the brace-extraction tests
  // in tests/full_qa.js that eval it without the helper -- in that case col E
  // falls back to the verbatim subcategory (the pre-fix behaviour).
  const dashSub = (typeof normalizeSubcategoryForDashboard === 'function')
    ? normalizeSubcategoryForDashboard(subcategory || '', category || '')
    : (subcategory || '');

  return [
    dateISO,                                    // A תאריך
    monthKey,                                   // B חודש  (YYYY-MM)
    typeof amount === 'number' ? amount : 0,    // C סכום
    sanitizeCell(category || 'אישי'),           // D קטגוריה (top)
    sanitizeCell(dashSub),                      // E תת-קטגוריה (canonical row label)
    sanitizeCell(rawText),                      // F פירוט
    'whatsapp',                                 // G מקור
    // H סטטוס: TRUE = expense, FALSE = income. Boolean matches what the
    // Apps Script bot writes (`!isIncome`) so both write paths produce
    // identical rows. Dashboards do not filter by col H today.
    !isIncome,
    // I ניכוי מע״מ: TRUE = the row is VAT-deductible for the עוסק מורשה
    // year-end report. Default FALSE for safety (personal users + legacy
    // callers that don't pass the flag). The bot exposes a "/מעמ" command
    // that flips the most recent row to TRUE after the fact.
    !!vatDeductible,
  ];
}

// ─── Exchange a refresh token for an access token ─────────────────────────
// Throws on any non-success -- callers should catch and degrade.
//
// Delegates to lib/oauth.js exchangeRefreshForAccess, which ALSO captures a
// rotated refresh_token when Google returns one (audit H1, 2026-05-31). Google
// rotates grants older than ~6 months and revokes the old token within hours,
// so a discarded rotation silently breaks the user's writes within weeks.
//
// CONTRACT PRESERVED: this still returns the access-token STRING, so the ~20
// existing importers (export/tax-report/mark-vat/bot-query/stats/provision/...)
// keep working unchanged. Pass `userSub` (2nd arg) so a rotated token can be
// re-encrypted (AAD-bound) + persisted; without it the access token still
// returns but a rotation can't be saved (logged, not fatal). Callers that hold
// the user record SHOULD pass userSub.
export async function exchangeRefreshForAccess(refreshToken, userSub, { noCache = false } = {}) {
  const { exchangeRefreshForAccess: exchange } = await import('./oauth.js');
  // oauth.js caches the minted access token per (userSub + refresh-token
  // fingerprint) on the warm instance, so repeated expense writes reuse it
  // instead of re-hitting Google. `noCache` forces a fresh mint — used by the
  // 401 retry below, where the cached token is exactly what was rejected.
  const { accessToken } = await exchange({ refreshToken, userSub, noCache });
  return accessToken;
}

// ─── Append `row` (array of 8 cells) to the תנועות tab ────────────────────
// Handles a 401 retry once with a freshly minted access token. Returns
// { ok, rowIndex } or { ok:false, error }.
export async function appendRowToUserSheet({ userRecord, row }) {
  if (!userRecord?.spreadsheetId) {
    return { ok: false, error: 'no_spreadsheet_id_in_user_record' };
  }

  let refreshToken = null;
  if (userRecord.refreshTokenEnvelope) {
    try {
      refreshToken = decryptRefreshToken(userRecord.refreshTokenEnvelope, userRecord.userSub);
    } catch (e) {
      return { ok: false, error: 'refresh_token_decrypt_failed', detail: e.message };
    }
  } else if (userRecord.refreshToken) {
    refreshToken = userRecord.refreshToken; // legacy unencrypted
  } else {
    return { ok: false, error: 'no_refresh_token_relink_needed' };
  }

  let accessToken;
  try {
    // Pass userSub so a rotated refresh_token (audit H1) is captured + persisted.
    // This is the bot's primary tenant-write path, so it's the most important
    // place to keep the refresh token current.
    accessToken = await exchangeRefreshForAccess(refreshToken, userRecord.userSub);
  } catch (e) {
    return { ok: false, error: 'token_refresh_failed', detail: e.message };
  }

  // Write to columns A:I (9-col template); the dashboards read C:C, B:B,
  // D:D, E:E from this range, and the tax-report endpoint reads C:C + I:I.
  // Sheets API auto-extends the sheet's columnCount on append if the target
  // tab still has 8 cols (legacy users created before col I was added) --
  // verified offline 2026-05-24; the new col gets created as a blank.
  const range = encodeURIComponent(`'${TX_TAB}'!A:I`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${userRecord.spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const fetchOpts = (token) => ({
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });

  // Track per-tenant Sheets API usage (in-memory, zero KV cost). Alerts when
  // a single tenant approaches Google's 100 writes/100s budget.
  recordSheetCall(userRecord.spreadsheetId, 'write');

  let resp;
  try { resp = await fetch(url, fetchOpts(accessToken)); }
  catch (e) { return { ok: false, error: 'sheets_api_unreachable', detail: e.message }; }

  // Self-heal: if the תנועות tab is missing (400), create it + the header
  // row and retry once. Covers freshly-created sheets and any edge where
  // the tab was renamed/removed -- a write should never be lost over a
  // missing tab.
  if (resp.status === 400) {
    const errBody = await resp.text().catch(() => '');
    if (/Unable to parse range|not found|not exist/i.test(errBody)) {
      try {
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${userRecord.spreadsheetId}:batchUpdate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: TX_TAB } } }] }),
        });
        // Seed the header row so the dashboards line up.
        const hdrRange = encodeURIComponent(`'${TX_TAB}'!A1`);
        await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${userRecord.spreadsheetId}/values/${hdrRange}?valueInputOption=RAW`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [TX_HEADERS] }),
        });
        resp = await fetch(url, fetchOpts(accessToken));
      } catch (e) { /* fall through to error reporting */ }
    }
  }

  if (resp.status === 401) {
    try {
      // Force a fresh mint: the 401 means the (possibly cached) access token was
      // rejected, so reusing it would just 401 again. noCache bypasses the
      // warm-instance cache and re-exchanges with Google.
      accessToken = await exchangeRefreshForAccess(refreshToken, userRecord.userSub, { noCache: true });
      resp = await fetch(url, fetchOpts(accessToken));
    } catch (e) {
      return { ok: false, error: 'token_refresh_retry_failed', detail: e.message };
    }
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return { ok: false, error: 'sheets_append_status_' + resp.status, detail: errText.slice(0, 200) };
  }

  const j = await resp.json().catch(() => ({}));
  return { ok: true, rowIndex: j?.updates?.updatedRange || null };
}
