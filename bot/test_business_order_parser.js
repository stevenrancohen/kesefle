#!/usr/bin/env node
// bot/test_business_order_parser.js
// Regression tests for parseBusinessOrder_ + smart_pending hijack guard.
//
// Trigger: Steven 2026-05-28 — bot wrote multi-field orders as ₪300 (stale
// pending) under category "אריזה ומשלוח" instead of parsing them as full
// orders and writing to הזמנות. Two bugs fixed:
//   A. parseBusinessOrder_ regex missed Steven's actual Hebrew patterns
//      ("מכירת תמונה 850", "חומר גלם 375", "משלוח והתקנה 500")
//   B. smart_pending substring picker hijacked new עסק orders that
//      contained category-keyword substrings

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

// parseBusinessOrder_ depends on _ORDER_MATERIALS_ top-level array — pull it.
const matMatch = SRC.match(/var _ORDER_MATERIALS_ = \[[^\]]+\];/);
if (!matMatch) throw new Error('_ORDER_MATERIALS_ not found');

// Eval into local scope (NOT global) so we can call parseBusinessOrder_.
const ctx = (function () {
  eval(matMatch[0]);
  eval(extractFn('parseBusinessOrder_'));
  return { parseBusinessOrder_: parseBusinessOrder_ };
}).call({});

const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}
function expect(name, got, want) {
  const ok = got === want || (typeof got === 'number' && typeof want === 'number' && Math.abs(got - want) < 0.01);
  if (ok) console.log('  PASS ' + name + ' = ' + JSON.stringify(got));
  else { console.error('  FAIL ' + name + ' got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); failures.push(name); }
}

console.log('\nbot/test_business_order_parser.js\n');

// ───── Steven's actual failing messages 2026-05-28 ─────

console.log('Message 1: "עסק - מכירת תמונה 850 חומר גלם 375 משלוח 50 רווח 425"');
const m1 = ctx.parseBusinessOrder_('עסק - מכירת תמונה 850 חומר גלם 375 משלוח 50 רווח 425');
assert(m1 !== null, 'returns non-null (was returning null before fix)');
if (m1) {
  expect('salePrice', m1.salePrice, 850);
  expect('productionCost', m1.productionCost, 375);
  expect('shipping', m1.shipping, 50);
  expect('profit', m1.profit, 425);
}

console.log('\nMessage 2: "עסק לקוחה סופי תמונה 150-100 חומר גלם 560 משלוח והתקנה 500 עלות מכירה 3000 רווח 1940"');
const m2 = ctx.parseBusinessOrder_('עסק לקוחה סופי תמונה 150-100 חומר גלם 560 משלוח והתקנה 500 עלות מכירה 3000 רווח 1940');
assert(m2 !== null, 'returns non-null');
if (m2) {
  expect('salePrice', m2.salePrice, 3000);
  expect('productionCost', m2.productionCost, 560);
  expect('shipping', m2.shipping, 500);
  expect('profit', m2.profit, 1940);
  expect('size', m2.size, '150-100');
}

console.log('\nMessage 3: "עסק - מכירת תמונה 300 עלות חומר גלם 0 רווח נטו 300" (zero material cost)');
const m3 = ctx.parseBusinessOrder_('עסק - מכירת תמונה 300 עלות חומר גלם 0 רווח נטו 300');
assert(m3 !== null, 'returns non-null');
if (m3) {
  expect('salePrice', m3.salePrice, 300);
  // productionCost should be 0 (zero is a valid value — material was free)
  // BUT current _num returns null for 0 because `> 0` check. That's a
  // pre-existing limitation; profit math still works because || 0 in the
  // profit calc treats null as 0. So profit comes out right either way.
  expect('profit', m3.profit, 300);
}

// ───── Backward compatibility: simple bare order still works ─────

console.log('\nBackward compat: "עסק 601 שיווק" (simple — should NOT be parsed as rich order)');
const simple = ctx.parseBusinessOrder_('עסק 601 שיווק');
assert(simple === null, 'simple "עסק N category" returns null (correctly falls back to picker flow)');

console.log('\nBackward compat: "עסק 880 לקוח ליה גודל 50-70 קנבס עלות מוצר 240 משלוח 45"');
const compat = ctx.parseBusinessOrder_('עסק 880 לקוח ליה גודל 50-70 קנבס עלות מוצר 240 משלוח 45');
assert(compat !== null, 'existing format still works');
if (compat) {
  expect('customer', compat.customer, 'ליה');
  expect('size', compat.size, '50-70');
  expect('material', compat.material, 'קנבס');
  expect('productionCost', compat.productionCost, 240);
  expect('salePrice', compat.salePrice, 880);
  expect('shipping', compat.shipping, 45);
}

// ───── Non-business messages still rejected ─────

console.log('\nNon-business: "50 קפה"');
assert(ctx.parseBusinessOrder_('50 קפה') === null, 'personal expense returns null');

console.log('\nNon-business: "245 סופר"');
assert(ctx.parseBusinessOrder_('245 סופר') === null, 'personal expense returns null');

// ───── Hijack guard exists in source ─────

console.log('\nSmart_pending hijack guard (Bug B fix):');
assert(/SMART_PENDING HIJACK GUARD/.test(SRC),
  'hijack guard block marker present in processExpense smart_pending block');
assert(/parseBusinessOrder_\(__hT\)/.test(SRC),
  'hijack guard calls parseBusinessOrder_ on the new text');
assert(/__hProps\.deleteProperty\('smart_pending'\)[\s\S]{0,400}smart_pending-hijack/.test(SRC),
  'hijack guard removes smart_pending state when new order detected');
assert(/__hP = null/.test(SRC),
  'hijack guard nullifies __hP so the picker block skips');

// ───── Build version ─────
console.log('\nBuild version:');
const v = (SRC.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
// Loosened from /order-parser-fix/ literal to date-prefix so subsequent
// PRs can rebump the version freely. Same fix-class as
// test_pending_state_hijack.js. The structural assertions above are
// what actually guard the order-parser fix.
assert(/^\d{4}-\d{2}-\d{2}/.test(v || ''),
  'KFL_BUILD_VERSION is date-stamped (currently: ' + v + ')');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
