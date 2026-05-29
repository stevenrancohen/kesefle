#!/usr/bin/env node
// bot/test_b1_income_flag_propagation.js
// Regression tests for B1 income flag propagation
// (autonomous-audit PR #136, Agent 4, HIGH severity).
//
// Bug: in the main processExpense -> appendRowToUserSheet flow, col H of the
// תנועות row was hardcoded TRUE (expense). For messages like "עסק הכנסה
// 10000" the categorizer DID find a category with isIncome:true (CATEGORY_MAP
// line 387), but downstream col-H assignment ignored the flag, silently
// flipping income rows to expense in the sheet and dashboard.
//
// Fix (3 layers):
//   1. _matchCategory_long propagates item.isIncome from each CATEGORY_MAP
//      entry into the returned object (previously flattened away).
//   2. matchCategory's BUSINESS path returns isIncome:true when the matched
//      subcategory is 'מחזור' (revenue).
//   3. processExpense + smart_pending hijack write + interactive-picker reply
//      all call the new _resolveIsIncome_(matched, raw, cat, sub) helper and
//      write `!isIncome` into col H instead of hardcoded TRUE.
//
// This test loads the REAL source via balanced-brace extraction (Kesefle
// pattern, see test_business_order_parser.js + test_classify.js) -- no
// mocking framework.

const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

// ---- Balanced-brace extractors (same pattern as test_classify.js) ----

function extractFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('fn not found: ' + name);
  // skip the param-list parens first
  let p = SRC.indexOf('(', start), pd = 0, k = p;
  for (; k < SRC.length; k++) {
    if (SRC[k] === '(') pd++;
    else if (SRC[k] === ')') { pd--; if (!pd) { k++; break; } }
  }
  let i = SRC.indexOf('{', k), d = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') d++;
    else if (SRC[j] === '}') { d--; if (!d) { j++; break; } }
  }
  return SRC.slice(start, j);
}

function balanced(marker, open, close) {
  const s = SRC.indexOf(marker); const i = SRC.indexOf(open, s);
  let d = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === open) d++;
    else if (SRC[j] === close) { d--; if (!d) { j++; break; } }
  }
  return SRC.slice(i, j);
}

// ---- Load real source into local scope ----

// CATEGORY_MAP is the big array of {keywords, category, subcategory, isIncome?}.
globalThis.CATEGORY_MAP = eval(balanced('const CATEGORY_MAP = [', '[', ']'));
globalThis.BUSINESS_CATEGORY_MAP = eval('(' + balanced('var BUSINESS_CATEGORY_MAP = {', '{', '}') + ')');
globalThis.DEFAULT_CATEGORY = eval('(' + balanced('const DEFAULT_CATEGORY =', '{', '}') + ')');
globalThis._CANONICAL_CAT_BY_SUB = eval('(' + balanced('var _CANONICAL_CAT_BY_SUB =', '{', '}') + ')');

// Word-char + keyword-hit helpers, then the four matcher functions in order.
(0, eval)(extractFn('_kflIsWordChar_'));
(0, eval)(extractFn('_kflKwHit_'));
(0, eval)(extractFn('_matchCategory_orig'));
(0, eval)(extractFn('_matchCategory_long'));
(0, eval)(extractFn('_coerceCategoryBySubcategory'));
(0, eval)(extractFn('matchCategory'));

// The two helpers introduced by this B1 fix.
(0, eval)(extractFn('_isIncomeCategory_'));
(0, eval)(extractFn('_resolveIsIncome_'));

// ---- Test harness ----

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); pass++; }
  else { console.error('  FAIL ' + label); fail++; }
}
function expect(name, got, want) {
  const ok = got === want;
  if (ok) { console.log('  PASS ' + name + ' = ' + JSON.stringify(got)); pass++; }
  else { console.error('  FAIL ' + name + ' got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); fail++; }
}

console.log('\nbot/test_b1_income_flag_propagation.js\n');

// ===== Layer 1: _matchCategory_long propagates isIncome =====

console.log('Layer 1: _matchCategory_long must propagate isIncome from CATEGORY_MAP entries');

// "הכנסה עסקית" hits CATEGORY_MAP row 387 (subcategory "הכנסה 2 — עסק", isIncome:true).
const m1 = matchCategory('הכנסה עסקית 10000');
expect('matched.category for "הכנסה עסקית 10000"', m1.category, 'הכנסות');
expect('matched.isIncome', m1.isIncome, true);

// "משכורת" hits CATEGORY_MAP row 386 (isIncome:true).
const m2 = matchCategory('משכורת 12000');
expect('matched.category for "משכורת 12000"', m2.category, 'הכנסות');
expect('matched.isIncome', m2.isIncome, true);

// Non-income hits should propagate isIncome:false (or absent -> falsy).
const m3 = matchCategory('50 קפה');
assert(!m3.isIncome, 'matched.isIncome is falsy for "50 קפה"');
const m4 = matchCategory('245 סופר');
assert(!m4.isIncome, 'matched.isIncome is falsy for "245 סופר"');

// ===== Layer 2: BUSINESS path returns isIncome for מחזור =====

console.log('\nLayer 2: matchCategory BUSINESS path returns isIncome:true for subcategory מחזור');

const b1 = matchCategory('עסק הכנסה 10000');
expect('biz category', b1.category, 'עסק');
expect('biz subcategory', b1.subcategory, 'מחזור');
expect('biz isIncome', b1.isIncome, true);

const b2 = matchCategory('עסק מכירה 5000');
expect('biz subcategory מכירה -> מחזור', b2.subcategory, 'מחזור');
expect('biz isIncome', b2.isIncome, true);

// Non-revenue business subcategory must NOT be income.
const b3 = matchCategory('עסק שיווק 300');
expect('biz שיווק category', b3.category, 'עסק');
expect('biz שיווק isIncome', b3.isIncome, false);

const b4 = matchCategory('עסק חומר גלם 500');
expect('biz חומר גלם isIncome', b4.isIncome, false);

// ===== Layer 3: _isIncomeCategory_ definitional fallback =====

console.log('\nLayer 3: _isIncomeCategory_ derives income from category/subcategory alone');

expect('_isIncomeCategory_("הכנסות", "X")', _isIncomeCategory_('הכנסות', 'משכורת'), true);
expect('_isIncomeCategory_("עסק", "מחזור")', _isIncomeCategory_('עסק', 'מחזור'), true);
expect('_isIncomeCategory_("עסק", "שיווק") -> false', _isIncomeCategory_('עסק', 'שיווק'), false);
expect('_isIncomeCategory_("אוכל", "סופר") -> false', _isIncomeCategory_('אוכל', 'סופר'), false);
expect('_isIncomeCategory_("שונות ואחרים", "שונות") -> false', _isIncomeCategory_('שונות ואחרים', 'שונות'), false);
// Null safety
expect('_isIncomeCategory_(null, null) -> false', _isIncomeCategory_(null, null), false);
expect('_isIncomeCategory_(undefined, "מחזור") -> false', _isIncomeCategory_(undefined, 'מחזור'), false);

// ===== Layer 4: _resolveIsIncome_ combines all signals =====

console.log('\nLayer 4: _resolveIsIncome_ combines matched.isIncome, "+" prefix, and categorical fallback');

// Signal 1: explicit matched.isIncome
expect('matched.isIncome=true wins', _resolveIsIncome_({ isIncome: true }, '500 משכורת', 'הכנסות', 'משכורת'), true);

// Signal 2: "+" prefix on raw text
expect('"+1500 משכורת" raw -> income', _resolveIsIncome_(null, '+1500 משכורת', 'הכנסות', 'משכורת'), true);
expect('"+500 קפה" raw + non-income cat -> income (user intent)', _resolveIsIncome_(null, '+500 קפה', 'אוכל', 'סופר'), true);

// Signal 3: categorical fallback (no matched, no "+" prefix)
expect('hekn category fallback', _resolveIsIncome_(null, '1500 משכורת', 'הכנסות', 'משכורת'), true);
expect('biz מחזור fallback', _resolveIsIncome_(null, '10000 הכנסה', 'עסק', 'מחזור'), true);

// All-false case
expect('expense path: 50 קפה', _resolveIsIncome_({ isIncome: false }, '50 קפה', 'אוכל', 'סופר'), false);
expect('expense path: 245 סופר', _resolveIsIncome_(null, '245 סופר', 'אוכל', 'סופר'), false);
expect('expense path: עסק שיווק', _resolveIsIncome_({ isIncome: false }, 'עסק שיווק 300', 'עסק', 'עלות שיווק'), false);

// Whitespace tolerance for "+" prefix
expect('"  +500 משכורת" with leading space', _resolveIsIncome_(null, '  +500 משכורת', 'אוכל', 'סופר'), true);

// ===== Full-flow assertions (the actual task spec) =====

console.log('\n===== Full-flow assertions (col H = !_resolveIsIncome_) =====');

function flowColH(rawText) {
  // Mimic processExpense main-loop: parse description, match, resolve.
  // Strip digits/symbols the way parseAmountAndDescription does so the
  // matcher sees the same description string the real bot does.
  const desc = String(rawText || '')
    .replace(/[\d.,+₪$€]/g, ' ')
    .replace(/(^|\s)(שח|ש"ח|ש״ח|שקל|שקלים|nis|ils|usd|eur)(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  const matched = matchCategory(desc);
  _coerceCategoryBySubcategory(matched);
  const isInc = _resolveIsIncome_(matched, rawText, matched.category, matched.subcategory);
  return { matched: matched, isIncome: isInc, colH: !isInc };
}

// Spec case 1
const c1 = flowColH('עסק הכנסה 10000');
expect('"עסק הכנסה 10000" matched.isIncome', c1.matched.isIncome, true);
expect('"עסק הכנסה 10000" col H', c1.colH, false);

// Spec case 2
const c2 = flowColH('3000 הכנסה עסקית');
expect('"3000 הכנסה עסקית" matched.isIncome', c2.matched.isIncome, true);
expect('"3000 הכנסה עסקית" col H', c2.colH, false);

// Spec case 3: "+" prefix
const c3 = flowColH('+1500 משכורת');
expect('"+1500 משכורת" isIncome', c3.isIncome, true);
expect('"+1500 משכורת" col H', c3.colH, false);

// Spec case 4: expense
const c4 = flowColH('50 קפה');
expect('"50 קפה" isIncome', c4.isIncome, false);
expect('"50 קפה" col H', c4.colH, true);

// Spec case 5: expense
const c5 = flowColH('245 סופר');
expect('"245 סופר" isIncome', c5.isIncome, false);
expect('"245 סופר" col H', c5.colH, true);

// ===== Verify the helpers actually exist in the deployed bot source =====

console.log('\nSource-level assertions (helpers + call-site wiring exist):');
assert(/function _isIncomeCategory_\(/.test(SRC),
  '_isIncomeCategory_ defined in source');
assert(/function _resolveIsIncome_\(/.test(SRC),
  '_resolveIsIncome_ defined in source');
// Verify the THREE appendRow sites all use _resolveIsIncome_, not hardcoded
// `true`. Each must have the helper call AND the `!__xIsInc` arg in col H.
assert(/var __isInc = _resolveIsIncome_\(matched,[\s\S]{0,400}sheet\.appendRow\([\s\S]*?'WhatsApp', !__isInc\]/.test(SRC),
  'processExpense main appendRow uses _resolveIsIncome_ for col H');
assert(/var __hPIsInc = _resolveIsIncome_\(__hPicked[\s\S]{0,400}__hPSheet\.appendRow\([\s\S]*?'WhatsApp', !__hPIsInc\]/.test(SRC),
  'smart_pending hijack appendRow uses _resolveIsIncome_ for col H');
assert(/var __interIsInc = _resolveIsIncome_\(null[\s\S]{0,400}sheet\.appendRow\([\s\S]*?'WhatsApp \(interactive\)', !__interIsInc\]/.test(SRC),
  'interactive picker reply appendRow uses _resolveIsIncome_ for col H');
// Negative: NO appendRow site for the תנועות sheet still has the old
// hardcoded `true` flag in the col-H position with the 'WhatsApp' / 'WhatsApp
// (interactive)' source marker. Catches future regressions where someone
// adds a new write path with hardcoded TRUE.
assert(!/sheet\.appendRow\([^)]*'WhatsApp', true\]/.test(SRC),
  'no תנועות appendRow with hardcoded TRUE in col H (WhatsApp source)');
assert(!/sheet\.appendRow\([^)]*'WhatsApp \(interactive\)', true\]/.test(SRC),
  'no תנועות appendRow with hardcoded TRUE in col H (interactive source)');

// ===== Build version =====

console.log('\nBuild version:');
const v = (SRC.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
assert(/^\d{4}-\d{2}-\d{2}/.test(v || ''),
  'KFL_BUILD_VERSION is date-stamped (currently: ' + v + ')');
// We used to pin "b1-income" in the build string, but every new feature bumps
// that string and the b1 token can't ride along forever. Instead verify the
// B1-fix code marker still lives in the source — that's what actually matters.
assert(/B1 fix: include isIncome/.test(SRC),
  'B1 fix marker present in ExpenseBot_FIXED.gs (the "// B1 fix: include isIncome" comment by the income-flag propagation site)');

console.log('');
if (fail) {
  console.error('FAIL: ' + fail + ' assertion(s) failed, ' + pass + ' passed');
  process.exit(1);
}
console.log('OK: all ' + pass + ' assertions passed');
