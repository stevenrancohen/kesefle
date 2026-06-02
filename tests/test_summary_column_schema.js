#!/usr/bin/env node
// tests/test_summary_column_schema.js
//
// Regression guard for the dashboard KPI summary endpoint
// (api/sheet/summary.js). A prior audit found it read the WRONG column
// schema: it pulled the amount from col B and "type" from col D, while the
// CANONICAL row layout (lib/sheet-writer.js buildExpenseRow) is:
//
//   0 A=date(ISO) | 1 B=month(YYYY-MM) | 2 C=amount(number) | 3 D=category |
//   4 E=subcategory | 5 F=detail | 6 G=source | 7 H=status(true=expense /
//   false=income) | 8 I=VAT-flag
//
// With the old read, amount = parseFloat(col B) === the YEAR (~2026 per row)
// and income was NEVER detected (col D is a category, never the string
// "income"; col H is a boolean). This suite locks the FIX:
//   * amount is read from col C  -> row[2]
//   * income is detected from col H (status) -> row[7], where false = income
// and asserts the dead-schema reads are gone, so the bug cannot silently
// regress.
//
// House pattern: no mocking framework, no network. We load the real endpoint
// source as TEXT and assert on the row-loop reads (same idiom as
// tests/test_sheet_ownership_guard_5_endpoints.js).
//
//   Run: node tests/test_summary_column_schema.js

const fs = require('fs');
const path = require('path');

const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\ntests/test_summary_column_schema.js\n');

const SUMMARY_PATH = path.join(__dirname, '..', 'api/sheet/summary.js');
const src = fs.readFileSync(SUMMARY_PATH, 'utf8');

// Isolate the per-row loop body so the assertions below describe how each
// transaction row is interpreted (not, say, an unrelated array index elsewhere
// in the file). The loop is `for (const row of rows) { ... }`.
const loopStart = src.indexOf('for (const row of rows)');
assert(loopStart >= 0, 'summary.js has a `for (const row of rows)` loop');
let bodyOpen = src.indexOf('{', loopStart);
let depth = 0, end = bodyOpen;
for (; end < src.length; end++) {
  if (src[end] === '{') depth++;
  else if (src[end] === '}') { depth--; if (depth === 0) { end++; break; } }
}
const loop = src.slice(loopStart, end);

// --- 1. Amount is read from col C (index 2), never col B (index 1) ----------
console.log('\n== 1. amount from col C ==');
// Positive: an amount assignment that reads row[2].
assert(/\bconst\s+amount\s*=[^;]*\brow\[\s*2\s*\]/.test(loop),
  'amount is read from col C (row[2])');
// Negative: the dead-schema read of col B as the amount must be gone.
assert(!/\bconst\s+amount\s*=[^;]*\brow\[\s*1\s*\]/.test(loop),
  'amount is NOT read from col B (row[1]) -- the dead "B=amount" schema');

// --- 2. Income is detected from col H (status, index 7) ---------------------
console.log('\n== 2. income from col H ==');
// The status column (col H) must be consulted in the row loop.
assert(/\brow\[\s*7\s*\]/.test(loop),
  'col H status is read (row[7]) in the row loop');
// isIncome must be derived from that status read, not from a "type" string.
// In the canonical schema col H is a boolean -> false means income, so the
// fix tests the falsy/"false" status (matching monthly-statement.js /
// bot-query.js), NOT `type === 'income'`.
assert(/\bisIncome\s*=[^;]*\bfalse\b/.test(loop),
  'isIncome is derived from the col H status (false = income)');

// Negative: the dead-schema income detection must be gone.
assert(!/\btype\s*=\s*\([^)]*\brow\[\s*3\s*\]/.test(loop),
  'no `type = (row[3]...)` read -- col D is a category, not a type');
assert(!/===\s*['"]income['"]/.test(loop),
  "no `=== 'income'` string match -- col H is a boolean, never the word income");

// --- 3. category / subcategory / detail shift back to the canonical columns -
// These moved with the amount fix (D/E/F, not E/F/G). Lock them so a partial
// revert can't leave the labels one column off while the amount is correct.
console.log('\n== 3. category/subcategory/detail columns ==');
assert(/\bconst\s+category\s*=[^;]*\brow\[\s*3\s*\]/.test(loop),
  'category is read from col D (row[3])');
assert(/\bconst\s+subcategory\s*=[^;]*\brow\[\s*4\s*\]/.test(loop),
  'subcategory is read from col E (row[4])');

console.log('\n' + (failures.length === 0
  ? 'OK: summary.js reads amount from col C and income from col H ('
      + 'all checks passed)'
  : 'FAILED: ' + failures.length + ' check(s): ' + failures.join('; ')));
process.exit(failures.length === 0 ? 0 : 1);
