// Core expense-parser test — loads the REAL parseAmountAndDescription +
// _parseIsraeliNumber_ out of ExpenseBot_FIXED.gs and runs realistic Hebrew
// inputs. Guards the single most important feature: turning a WhatsApp text
// into an amount + description. Run: node bot/test_parser.js
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/ExpenseBot_FIXED.gs', 'utf8');

function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('fn not found: ' + name);
  let i = src.indexOf('{', start), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(start, j);
}

(0, eval)(extractFn('_parseIsraeliNumber_'));
(0, eval)(extractFn('parseAmountAndDescription'));

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = got === want;
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + ' → ' + JSON.stringify(got) + (ok ? '' : '  (expected ' + JSON.stringify(want) + ')'));
  ok ? pass++ : fail++;
}

// helper: first item's amount + note, or null
function P(text) {
  const r = globalThis.parseAmountAndDescription(text);
  if (!r || !r.items || !r.items.length) return null;
  return { amount: r.items[0].amount, note: r.items[0].description, count: r.items.length };
}

console.log('\n── _parseIsraeliNumber_ ──');
eq('"245"', globalThis._parseIsraeliNumber_('245'), 245);
eq('"1,800" (thousands)', globalThis._parseIsraeliNumber_('1,800'), 1800);
eq('"1,234,567"', globalThis._parseIsraeliNumber_('1,234,567'), 1234567);
eq('"42.5" (period decimal)', globalThis._parseIsraeliNumber_('42.5'), 42.5);
eq('"12,5" (comma decimal)', globalThis._parseIsraeliNumber_('12,5'), 12.5);

console.log('\n── parseAmountAndDescription: common Hebrew expenses ──');
eq('"245 סופר" amount', P('245 סופר').amount, 245);
eq('"245 סופר" note', P('245 סופר').note, 'סופר');
eq('"1,800 ארנונה" amount', P('1,800 ארנונה').amount, 1800);
eq('"1,800 ארנונה" note', P('1,800 ארנונה').note, 'ארנונה');
eq('"42.5 קפה" amount', P('42.5 קפה').amount, 42.5);
eq('"8500 משכורת" amount', P('8500 משכורת').amount, 8500);
eq('"60 אובר" amount', P('60 אובר').amount, 60);
eq('"רכב 1,234,567" amount', P('רכב 1,234,567').amount, 1234567);

console.log('\n── edge cases ──');
eq('empty string → null', P(''), null);
eq('no digits ("סופר") → null', P('סופר'), null);
eq('amount only ("100") → note fallback', P('100').note, 'ללא פירוט');
eq('multi-number "352+165 אוכל" → 2 items', P('352+165 אוכל').count, 2);
eq('multi-number first amount', P('352+165 אוכל').amount, 352);

console.log('\n── currency tokens stripped from description ──');
eq('"₪50 קפה" amount', P('₪50 קפה').amount, 50);
eq('"₪50 קפה" note (₪ stripped)', P('₪50 קפה').note, 'קפה');
eq('"50 שח סופר" note (שח stripped)', P('50 שח סופר').note, 'סופר');
eq('"50 שקל קפה" note (שקל stripped)', P('50 שקל קפה').note, 'קפה');
eq('"50 שקל" only → note fallback', P('50 שקל').note, 'ללא פירוט');

// all parsed items (not just the first) for multi-item assertions
function ALL(text){ var r = globalThis.parseAmountAndDescription(text); return (r && r.items) || []; }
function pair(it){ return it ? (it.amount + '|' + it.description) : null; }

console.log('\n── date tokens are NOT amounts (Steven 2026-06-14) ──');
eq('"ב15/6 ב200 שח" → 1 item only', P('ב15/6 ב200 שח').count, 1);
eq('"ב15/6 ב200 שח" amount = 200 (not 15/6)', P('ב15/6 ב200 שח').amount, 200);
eq('"200 שח 15/6" amount = 200 (trailing date stripped)', P('200 שח 15/6').amount, 200);
eq('"קפה 30/6" → 1 item, amount 30? NO -> date stripped, no amount', ALL('קפה 30/6').length, 0);

console.log('\n── k / אלף thousand multiplier (Steven 2026-06-14) ──');
eq('"2.5k" → 2500', P('2.5k').amount, 2500);
eq('"2.5 אלף" → 2500', P('2.5 אלף').amount, 2500);
eq('"5k קניות" → 5000', P('5k קניות').amount, 5000);
eq('"5k קניות" note = "קניות"', P('5k קניות').note, 'קניות');
eq('"2.5kg עגבניות" stays 2.5 (kg = unit, NOT x1000)', P('2.5kg עגבניות').amount, 2.5);

console.log('\n── per-item multi-item descriptions (Steven 2026-06-14) ──');
var _mm = ALL('42 קפה, 245 סופר, 1800 ארנונה');
eq('comma list → 3 items', _mm.length, 3);
eq('item1 = 42|קפה', pair(_mm[0]), '42|קפה');
eq('item2 = 245|סופר', pair(_mm[1]), '245|סופר');
eq('item3 = 1800|ארנונה', pair(_mm[2]), '1800|ארנונה');
var _mb = ALL('50 קפה, עסק 601 שיווק');
eq('biz/personal mix → 2 items', _mb.length, 2);
eq('item1 = 50|קפה (personal)', pair(_mb[0]), '50|קפה');
eq('item2 = 601|עסק שיווק (business)', pair(_mb[1]), '601|עסק שיווק');
eq('"1,800 ארנונה" stays ONE item (thousands comma, not a delimiter)', ALL('1,800 ארנונה').length, 1);
eq('"תיקון מזגן, חלפים 350" stays ONE item (only 1 number)', ALL('תיקון מזגן, חלפים 350').length, 1);

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' PARSER CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
