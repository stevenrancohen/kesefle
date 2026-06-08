#!/usr/bin/env node
// bot/test_business_dashboard.js (auto-discovered by the gauntlet)
// Locks the per-business dashboard (Steven 2026-06-08): a business created via
// the bot must get the FULL company-dashboard template (Maazan Hevra style),
// not a bare expense list. Extracts _createBusinessDashboard_ + _sanitizeTabName_
// from source, runs it against a stubbed SpreadsheetApp, and asserts the grid
// of formulas it writes (revenue = H FALSE, costs = H TRUE + E wildcard, the
// $B$4 year selector, total/net/profit rows) -- all pointing at the business's
// OWN tab. Also asserts _getOrCreateBusinessTab_ calls it on a new business.
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
function extract(name) {
  const i = SRC.indexOf('function ' + name + '(');
  let depth = 0, started = false;
  for (let j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') { started = true; depth++; }
    else if (SRC[j] === '}') { depth--; if (started && depth === 0) return SRC.slice(i, j + 1); }
  }
  return '';
}

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) pass++; else { fail++; console.log('  FAIL ' + label); } }

// ---- structural: the call is wired into business creation ----
ok('_getOrCreateBusinessTab_ calls _createBusinessDashboard_ on a new tab',
  /isNew = true;[\s\S]{0,120}_createBusinessDashboard_\(ss, desiredTabName/.test(SRC));

// ---- functional: run the generator against a stubbed Sheets API ----
let captured = null;
const rangeStub = {
  setValues(v) { if (v.length > 3) captured = v; return this; },
  setDataValidation() { return this; },
  setFontWeight() { return this; },
};
const sheetStub = {
  setRightToLeft() {}, setFrozenRows() {}, setFrozenColumns() {},
  getRange() { return rangeStub; }, getSheetId() { return 123; },
};
const ssStub = { getSheetByName() { return null; }, insertSheet() { return sheetStub; } };
const SpreadsheetApp = {
  newDataValidation() { return { requireValueInList() { return { build() { return {}; } }; } }; },
  flush() {},
};
const Logger = { log() {} };

eval(extract('_sanitizeTabName_'));
eval(extract('_createBusinessDashboard_'));
_createBusinessDashboard_(ssStub, 'כספלה', 'כספלה');

ok('wrote a grid of 14 rows', captured && captured.length === 14);
if (captured) {
  const find = (label) => captured.find(r => String(r[0]).indexOf(label) >= 0);
  const rev = find('מחזור ברוטו');
  const cost = find('עלות שיווק');
  const tot = find('סה״כ');
  const net = find('רווח נטו');
  const pct = find('אחוז רווחיות');
  ok('revenue row sums the business tab income (H FALSE)',
    rev && /SUMIFS\('כספלה'!C:C[\s\S]*'כספלה'!H:H, FALSE/.test(rev[2]));
  ok('cost row filters expense (H TRUE) + subcategory wildcard',
    cost && /'כספלה'!E:E, "\*שיווק\*"[\s\S]*'כספלה'!H:H, TRUE/.test(cost[2]));
  ok('formulas use the $B$4 year selector', rev && /\$B\$4&"-01"/.test(rev[2]));
  ok('total row sums the 4 cost rows', tot && /=SUM\(C8:C11\)/.test(tot[2]));
  ok('net profit = revenue - total', net && /=C6-C12/.test(net[2]));
  ok('profit % = net / revenue', pct && /=IFERROR\(C13\/C6/.test(pct[2]));
  const opex = find('תפעוליות'), ship = find('משלוחים');
  ok('opex row covers consultants + software + taxes (matches COMPANY_EXPENSE_ROWS)',
    opex && /\*יועצ\*/.test(opex[2]) && /\*תוכנות\*/.test(opex[2]) && /\*מיסים\*/.test(opex[2]));
  ok('shipping row covers packaging (*ariza*)', ship && /\*אריזה\*/.test(ship[2]));
  ok('year selector cell B4 holds the year', captured[3][1] && /^\d{4}$/.test(String(captured[3][1])));
}

console.log('test_business_dashboard: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
