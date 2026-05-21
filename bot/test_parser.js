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

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' PARSER CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
