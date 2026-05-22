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

// Tab names match the template the user provided.
const TX_TAB = 'תנועות';
const ORDERS_TAB = 'הזמנות';
const PERSONAL_DASHBOARD_TAB = 'מאזן אישי';
const COMPANY_DASHBOARD_TAB = 'מאזן חברה';
const GROUP_LEDGER_TAB = 'הוצאות קבוצה';

// Transactions tab columns (A:H) -- the bot writes one row per expense/income
// here, and the dashboards SUMIFS by col B ("YYYY-MM") + col D (top category)
// + col E (subcategory). This column order is load-bearing for the dashboard
// formulas below; do not reorder without updating both the dashboards AND
// buildExpenseRow.
const TX_HEADERS = ['תאריך', 'חודש', 'סכום', 'קטגוריה', 'תת-קטגוריה', 'פירוט', 'מקור', 'סטטוס'];

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
const PERSONAL_FIXED_ROWS = [
  'בית', 'מכון כושר', 'אפליקציות', 'תקשורת', 'לימודים',
  'ביטוח אישי', 'בנקאות', 'פלייסטיישן', 'חשמל', 'מים',
  'אופציה 1', 'אופציה 2',
];
const PERSONAL_VARIABLE_ROWS = [
  'אופציה 3', 'אופציה 4', 'אופציה 5',
];
const PERSONAL_FOOD_ROWS = [
  'אוכל לבית', 'אוכל בחוץ',
];
const PERSONAL_TRANSPORT_ROWS = [
  'דלק', 'חניה', 'מונית', 'ליים', 'רכב', 'אופנוע', 'ביטוח רכב', 'אוטובוס/רכבת',
];
const PERSONAL_MISC_ROWS = [
  'ביגוד', 'טיפוח', 'בריאות', 'אטרקציות', 'שונות',
];

// Company dashboard rows. The SUMIFS criterion is hard-coded in the formula
// (col D = "עסק" AND col E = <subcategory>); user can rename the display
// label in A but to change the criterion they edit the formula.
const COMPANY_EXPENSE_ROWS = [
  { label: '🎨 עלות חומרי גלם', subcategory: 'חומרי גלם' },
  { label: '📣 עלות שיווק', subcategory: 'שיווק' },
  { label: '🚚 משלוחים והתקנות', subcategory: 'אריזה ומשלוח' },
  { label: '🏢 הוצאות תפעוליות', subcategory: 'תוכנות' },
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
      index: 0,
      gridProperties: { frozenRowCount: 1, columnCount: 8 },
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
      index: 1,
      gridProperties: { frozenRowCount: 1, columnCount: 8 },
    },
    data: [{ startRow: 0, startColumn: 0, rowData: [header] }],
  };
}

// ─── Personal dashboard helpers ───────────────────────────────────────────
// Returns a row of cells for a single category line. Col A = label, Col B =
// SUM(C:N) annual, Cols C..N = monthly SUMIFS keyed by year-month in $B$2.
function _personalCategoryRow(rowNum, label) {
  const cells = [];
  cells.push(_sw_str(label)); // A
  cells.push(_sw_currencyFmt(_sw_formula(`=SUM(C${rowNum}:N${rowNum})`))); // B
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    cells.push(_sw_currencyFmt(_sw_formula(
      `=IFERROR(SUMIFS('${TX_TAB}'!C:C, '${TX_TAB}'!B:B, $B$2&"-${mm}", '${TX_TAB}'!E:E, $A${rowNum}), 0)`
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
// Layout (1-indexed rows):
//   R1  : title (purple bg)
//   R2  : "📅 שנה:" | <year>
//   R3  : header (קטגוריה | סיכום שנתי | ינואר..דצמבר)
//   R4  : 📥 הכנסות (section header)
//   R5-8: 4 income categories
//   R9  : סה״כ הכנסות (FIXED: SUM(B5:B8) -- was SUM(B5:B8) in xlsx, OK)
//   R10 : סה״כ הוצאות = B28+B34+B39+B50+B58 (sum of section totals)
//   R11 : 💰 נטו / חיסכון = B9-B10
//   R12 : 📊 אחוז חיסכון = IFERROR(B11/B9, 0)
//   R13 : (blank)
//   R14 : 📤 הוצאות (header)
//   R15 : 🏠 הוצאות קבועות (sub-header)
//   R16-27: 12 fixed expense categories
//   R28 : סה״כ הוצאות קבועות (FIXED: SUM(B16:B27) -- xlsx had SUM(B13:B24))
//   R29 : (blank)
//   R30 : ⚡ הוצאות זמניות (sub-header)
//   R31-33: 3 variable categories
//   R34 : סה״כ הוצאות זמניות (FIXED: SUM(B31:B33) -- xlsx had SUM(B28:B30))
//   R35 : (blank)
//   R36 : 🍽️ אוכל (sub-header)
//   R37-38: 2 food categories
//   R39 : סה״כ אוכל (FIXED: SUM(B37:B38) -- xlsx had SUM(B34:B35))
//   R40 : (blank)
//   R41 : 🚗 תחבורה (sub-header)
//   R42-49: 8 transport categories
//   R50 : סה״כ תחבורה (FIXED: SUM(B42:B49) -- xlsx had SUM(B39:B46))
//   R51 : (blank)
//   R52 : 🎁 שונות ואחרים (sub-header)
//   R53-57: 5 misc categories
//   R58 : סה״כ שונות (FIXED: SUM(B53:B57) -- xlsx had SUM(B50:B54))
function _buildPersonalDashboardTab(defaultYear) {
  const rows = [];

  // R1: title
  const r1 = _sw_row([
    _sw_str(''),
    _sw_bg(_sw_bold(_sw_str('📊  מאזן אישי — הוצאות והכנסות')), RGB_ACCENT_50),
  ]);
  rows.push(r1);

  // R2: year selector
  const r2 = _sw_row([
    _sw_bold(_sw_str('📅 שנה:')),
    _sw_bold(_sw_num(defaultYear)),
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
  // Cells: A label, B = formula, C-N = monthly = C28+C34+C39+C50+C58 etc.
  const r10cells = [
    _sw_bg(_sw_bold(_sw_str('סה״כ הוצאות')), RGB_BRAND_100),
    _sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula('=B28+B34+B39+B50+B58'))), RGB_BRAND_100),
  ];
  ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'].forEach(function (cl) {
    r10cells.push(_sw_bg(_sw_bold(_sw_currencyFmt(_sw_formula(`=${cl}28+${cl}34+${cl}39+${cl}50+${cl}58`))), RGB_BRAND_100));
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

  // R31-33: variable categories (3 rows)
  PERSONAL_VARIABLE_ROWS.forEach(function (label, i) {
    rows.push(_personalCategoryRow(31 + i, label));
  });

  // R34: סה״כ הוצאות זמניות = SUM(B31:B33)  [FIXED]
  rows.push(_personalSectionTotal('סה״כ הוצאות זמניות', 31, 33));

  // R35: blank
  rows.push(_sw_blank());

  // R36: 🍽️ אוכל sub-header
  rows.push(_personalSectionHeader('🍽️ אוכל'));

  // R37-38: food categories (2 rows)
  PERSONAL_FOOD_ROWS.forEach(function (label, i) {
    rows.push(_personalCategoryRow(37 + i, label));
  });

  // R39: סה״כ אוכל = SUM(B37:B38)  [FIXED]
  rows.push(_personalSectionTotal('סה״כ אוכל', 37, 38));

  // R40: blank
  rows.push(_sw_blank());

  // R41: 🚗 תחבורה sub-header
  rows.push(_personalSectionHeader('🚗 תחבורה'));

  // R42-49: transport (8 rows)
  PERSONAL_TRANSPORT_ROWS.forEach(function (label, i) {
    rows.push(_personalCategoryRow(42 + i, label));
  });

  // R50: סה״כ תחבורה = SUM(B42:B49)  [FIXED]
  rows.push(_personalSectionTotal('סה״כ תחבורה', 42, 49));

  // R51: blank
  rows.push(_sw_blank());

  // R52: 🎁 שונות ואחרים sub-header
  rows.push(_personalSectionHeader('🎁 שונות ואחרים'));

  // R53-57: misc (5 rows)
  PERSONAL_MISC_ROWS.forEach(function (label, i) {
    rows.push(_personalCategoryRow(53 + i, label));
  });

  // R58: סה״כ שונות = SUM(B53:B57)  [FIXED]
  rows.push(_personalSectionTotal('סה״כ שונות', 53, 57));

  return {
    properties: {
      title: PERSONAL_DASHBOARD_TAB,
      index: 2,
      gridProperties: { frozenRowCount: 3, frozenColumnCount: 2, rowCount: 60, columnCount: 14 },
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

  // R4: year selector
  rows.push(_sw_row([
    _sw_bold(_sw_str('📅 שנת:')),
    _sw_bold(_sw_num(defaultYear)),
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

  // R8-11: business expense categories
  COMPANY_EXPENSE_ROWS.forEach(function (item, i) {
    const rowNum = 8 + i;
    const cells = [
      _sw_str(item.label),
      _sw_currencyFmt(_sw_formula(`=SUM(C${rowNum}:N${rowNum})`)),
    ];
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0');
      cells.push(_sw_currencyFmt(_sw_formula(
        `=IFERROR(SUMIFS('${TX_TAB}'!C:C, '${TX_TAB}'!B:B, $B$4&"-${mm}", '${TX_TAB}'!D:D, "עסק", '${TX_TAB}'!E:E, "${item.subcategory}"), 0)`
      )));
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
    sheets: [
      _buildTxTab(),
      _buildOrdersTab(),
      _buildPersonalDashboardTab(defaultYear),
      _buildCompanyDashboardTab(defaultYear),
    ],
  };
}

// ─── Create a fresh per-tenant spreadsheet ────────────────────────────────
// Uses the user's OWN access token, so the sheet is owned by them and the
// app only ever touches this one file (drive.file scope).
export async function createUserSheetWithToken(accessToken, name, opts) {
  if (!accessToken) throw new Error('no_access_token');

  async function attempt(spec) {
    const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
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
  return {
    spreadsheetId: res.j.spreadsheetId,
    spreadsheetUrl: res.j.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${res.j.spreadsheetId}`,
  };
}

// Refresh-token variant for server-side callers (e.g. group creation) that
// hold an envelope rather than a live browser access token.
export async function createUserSheetWithRefresh({ refreshTokenEnvelope, refreshToken, userSub, name, opts }) {
  let actualRefresh = refreshToken;
  if (!actualRefresh && refreshTokenEnvelope) actualRefresh = decryptRefreshToken(refreshTokenEnvelope, userSub);
  if (!actualRefresh) throw new Error('no_refresh_token');
  const accessToken = await exchangeRefreshForAccess(actualRefresh);
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
  const accessToken = await exchangeRefreshForAccess(actualRefresh);
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
  try { accessToken = await exchangeRefreshForAccess(actualRefresh); }
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
      accessToken = await exchangeRefreshForAccess(actualRefresh);
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

// ─── Build the 8-column row we write into the תנועות tab ──────────────────
//
// Column order is load-bearing for the dashboards:
//   A=תאריך (ISO date string), B=חודש ("YYYY-MM"), C=סכום (number),
//   D=קטגוריה (top-level, e.g. "עסק" or "אוכל"), E=תת-קטגוריה (matches the
//   personal-dashboard row labels like "אוכל בחוץ" or company subcategory
//   like "חומרי גלם"), F=פירוט (raw user text), G=מקור ("whatsapp"),
//   H=סטטוס ("expense" or "income").
//
// The dashboards SUMIFS on col B (month), col D (top), col E (subcategory).
// Do not reorder.
export function buildExpenseRow({ amount, category, subcategory, rawText, date, isIncome }) {
  // `date` lets callers backfill a historical row (e.g. recurring catch-up
  // for a mid-month signup); defaults to now for normal live writes.
  const d = date ? new Date(date) : new Date();
  const dateISO = d.toISOString();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const monthKey = `${yyyy}-${mm}`;

  return [
    dateISO,                                    // A תאריך
    monthKey,                                   // B חודש  (YYYY-MM)
    typeof amount === 'number' ? amount : 0,    // C סכום
    sanitizeCell(category || 'אישי'),           // D קטגוריה (top)
    sanitizeCell(subcategory || ''),            // E תת-קטגוריה
    sanitizeCell(rawText),                      // F פירוט
    'whatsapp',                                 // G מקור
    // H סטטוס: TRUE = expense, FALSE = income. Boolean matches what the
    // Apps Script bot writes (`!isIncome`) so both write paths produce
    // identical rows. Dashboards do not filter by col H today.
    !isIncome,
  ];
}

// ─── Exchange a refresh token for an access token ─────────────────────────
// Throws on any non-success -- callers should catch and degrade.
export async function exchangeRefreshForAccess(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId) throw new Error('google_client_id_missing');
  if (!clientSecret) throw new Error('google_client_secret_missing');
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    throw new Error('refresh_failed: ' + (j.error_description || j.error || r.status));
  }
  return j.access_token;
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
    accessToken = await exchangeRefreshForAccess(refreshToken);
  } catch (e) {
    return { ok: false, error: 'token_refresh_failed', detail: e.message };
  }

  // Write to columns A:H (8-col template); the dashboards read C:C, B:B,
  // D:D, E:E from this range.
  const range = encodeURIComponent(`'${TX_TAB}'!A:H`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${userRecord.spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const fetchOpts = (token) => ({
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });

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
      accessToken = await exchangeRefreshForAccess(refreshToken);
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
