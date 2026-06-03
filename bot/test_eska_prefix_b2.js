#!/usr/bin/env node
// bot/test_eska_prefix_b2.js
//
// Regression test for B2 (PR autonomous-audit Agent 4 finding):
//   parseBusinessOrder_ silently dropped messages starting with "עסקה"
//   (deal) or "עסקת" (construct state) because the prefix regex's
//   lookahead required a non-Hebrew character right after "עסק".
//   Steven naturally writes "עסקה יוסי הכנסה 10000 עובדים 2500..." and
//   the parser returned null → message routed to personal categorize.
//
// This test asserts:
//   1. "עסקה X" now parses (was null before fix)
//   2. "עסקת X" now parses (was null before fix)
//   3. "עסק X" still parses (no regression)
//   4. "עסקיותRandom" does NOT parse (only true prefixes)
//   5. Non-business input still returns null

const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

function extractFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('fn not found: ' + name);
  let i = SRC.indexOf('{', start), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return SRC.slice(start, j);
}

const matMatch = SRC.match(/var _ORDER_MATERIALS_ = \[[^\]]+\];/);
if (!matMatch) throw new Error('_ORDER_MATERIALS_ not found');

const ctx = (function () {
  eval(matMatch[0]);
  eval(extractFn('parseBusinessOrder_'));
  return { parseBusinessOrder_: parseBusinessOrder_ };
}).call({});

const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_eska_prefix_b2.js\n');

// ───── 1: עסקה prefix (deal) — must parse ─────
console.log('1. "עסקה" prefix (deal):');
const eska1 = ctx.parseBusinessOrder_('עסקה יוסי הכנסה 10000 עובדים 2500 חומרים 1200');
assert(eska1 !== null, '"עסקה יוסי הכנסה 10000..." returns non-null (was null pre-fix)');

const eska2 = ctx.parseBusinessOrder_('עסקה - מכירת תמונה 850 חומר גלם 375 משלוח 50');
assert(eska2 !== null, '"עסקה - מכירת תמונה ..." returns non-null');
if (eska2) {
  const ok = (eska2.salePrice === 850 && eska2.productionCost === 375 && eska2.shipping === 50);
  assert(ok, '"עסקה - מכירת תמונה 850..." parses salePrice=850, prodCost=375, shipping=50');
}

// ───── 2: עסקת prefix (construct state) — must parse ─────
console.log('\n2. "עסקת" prefix (construct):');
const eskat = ctx.parseBusinessOrder_('עסקת לקוח יוסי מכירה 1500 משלוח 80');
assert(eskat !== null, '"עסקת לקוח יוסי ..." returns non-null');
if (eskat) {
  assert(eskat.salePrice === 1500, '"עסקת ..." parses salePrice=1500');
  assert(eskat.shipping === 80, '"עסקת ..." parses shipping=80');
}

// ───── 3: עסק prefix — backward compat (must still parse) ─────
console.log('\n3. "עסק" prefix (backward compat — must NOT regress):');
const esk = ctx.parseBusinessOrder_('עסק - מכירת תמונה 850 חומר גלם 375 משלוח 50 רווח 425');
assert(esk !== null, '"עסק - מכירת תמונה ..." still parses');
if (esk) {
  assert(esk.salePrice === 850, 'esk.salePrice === 850');
  assert(esk.productionCost === 375, 'esk.productionCost === 375');
  assert(esk.shipping === 50, 'esk.shipping === 50');
  assert(esk.profit === 425, 'esk.profit === 425');
}

const esk2 = ctx.parseBusinessOrder_('עסק 880 לקוח ליה גודל 50-70 קנבס עלות מוצר 240 משלוח 45');
assert(esk2 !== null, '"עסק 880 לקוח ליה ..." (legacy format) still parses');
if (esk2) {
  assert(esk2.customer === 'ליה', 'esk2.customer === ליה');
  assert(esk2.material === 'קנבס', 'esk2.material === קנבס');
}

// ───── 4: Non-prefix Hebrew words MUST NOT match ─────
console.log('\n4. Non-prefix Hebrew words must NOT match (no false positives):');
// "עסקיות" should NOT match (would need to begin with עסק|עסקה|עסקת
// followed by space/punct/end — עסקיות has יו after עסק which isn't in
// the lookahead set [\s:\-,0-9])
assert(ctx.parseBusinessOrder_('עסקיות גבוהה 500') === null,
  '"עסקיות גבוהה 500" returns null (not a real biz prefix)');
assert(ctx.parseBusinessOrder_('עסקים שלי 200') === null,
  '"עסקים שלי 200" returns null');
assert(ctx.parseBusinessOrder_('עסקייה 100') === null,
  '"עסקייה 100" returns null');

// ───── 5: Non-business expense ─────
console.log('\n5. Non-business messages still rejected:');
assert(ctx.parseBusinessOrder_('50 קפה') === null, '"50 קפה" personal expense returns null');
assert(ctx.parseBusinessOrder_('245 סופר') === null, '"245 סופר" personal expense returns null');

// ───── 6: Source-level guard — fix is present in the file ─────
console.log('\n6. Source-level guard:');
assert(/\^\(עסקה\|עסקת\|עסק\|biz\|business\)/.test(SRC),
  'parseBusinessOrder_ prefix regex now includes עסקה|עסקת alternatives');
assert(/B2 fix \(PR audit Agent 4\)/i.test(SRC),
  'B2 fix comment with provenance is present');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
