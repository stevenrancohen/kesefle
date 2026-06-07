#!/usr/bin/env node
// bot/test_named_business_routing.js  (auto-discovered by the gauntlet)
// Locks the named-business routing fix (Steven 2026-06-07): "עסק <name> ..."
// (a registered business, NO number) resolves to the right business N, and the
// business write-path converts foreign currency like the personal path.
// Extracts the REAL pure resolver from ExpenseBot_FIXED.gs (balanced-brace) and
// asserts the structural FX + named-route wiring is present.
const fs = require('node:fs'), path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

function extractFn(name) {
  const idx = SRC.indexOf('function ' + name + '(');
  if (idx < 0) throw new Error('fn not found: ' + name);
  let depth = 0, end = -1, started = false;
  for (let i = idx; i < SRC.length; i++) {
    if (SRC[i] === '{') { depth++; started = true; }
    else if (SRC[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }
  }
  return SRC.slice(idx, end);
}
const resolve = new Function(extractFn('_resolveBusinessNamePrefix_') + '\nreturn _resolveBusinessNamePrefix_;')();

const LIST = [
  { n: 1, tabName: 'תנועות', name: 'תמונות' },
  { n: 2, tabName: 'כספלה',  name: 'כספלה' },
  { n: 3, tabName: 'הרמס',   name: 'הרמס' },
  { n: 4, tabName: 'כספלה סטודיו', name: 'כספלה סטודיו' },
];
let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log('  FAIL ' + label + '\n      want=' + JSON.stringify(want) + '\n      got =' + JSON.stringify(got)); }
}

// THE bug: Steven's exact message routes to business #2 (כספלה).
eq('עסק כספלה הוצאה 5 דולר קלוד', resolve('עסק כספלה הוצאה 5 דולר קלוד', LIST), { n: 2, name: 'כספלה', rest: '5 דולר קלוד' });
eq('lead-in before marker', resolve('הוצאה עסק כספלה 5 דולר קלוד', LIST), { n: 2, name: 'כספלה', rest: '5 דולר קלוד' });
eq('clitic בעסק', resolve('בעסק כספלה 52 hostinger', LIST), { n: 2, name: 'כספלה', rest: '52 hostinger' });
eq('clitic לעסק', resolve('לעסק הרמס 88 ספרים', LIST), { n: 3, name: 'הרמס', rest: '88 ספרים' });
eq('deal form עסקה', resolve('עסקה כספלה 5 דולר קלוד', LIST), { n: 2, name: 'כספלה', rest: '5 דולר קלוד' });
eq('separator after name', resolve('עסק כספלה - 5 דולר קלוד', LIST), { n: 2, name: 'כספלה', rest: '5 דולר קלוד' });
eq('longest-name-first', resolve('עסק כספלה סטודיו 30 שיווק', LIST), { n: 4, name: 'כספלה סטודיו', rest: '30 שיווק' });
eq('name-only (no body)', resolve('עסק הרמס', LIST), { n: 3, name: 'הרמס', rest: '' });
eq('biz #1 by persisted name', resolve('עסק תמונות 288 שיווק', LIST), { n: 1, name: 'תמונות', rest: '288 שיווק' });

// MUST-NOT-MATCH (preserve legacy contracts + safety).
eq('unknown word שיווק -> null', resolve('עסק שיווק 200', LIST), null);
eq('unknown word דלק -> null', resolve('עסק דלק 50', LIST), null);
eq('numbered shape -> null (numbered route owns it)', resolve('עסק 2 כספלה - 52 hostinger', LIST), null);
eq('glued word -> null', resolve('עסק כספלהדבר 5', LIST), null);
eq('empty registry -> null', resolve('עסק כספלה 5 דולר קלוד', []), null);
eq('non-business message -> null', resolve('250 דלק', LIST), null);

// Structural: FX + lead-in wired into _writeBusinessNExpense_, named route into doPost.
const wbody = extractFn('_writeBusinessNExpense_');
function ok(label, cond) { if (cond) pass++; else { fail++; console.log('  FAIL ' + label); } }
ok('_writeBusinessNExpense_ calls parseForeignCurrencyHint', /parseForeignCurrencyHint\(/.test(wbody));
ok('_writeBusinessNExpense_ strips the expense/income lead-in', /הוצאה\|הוצאת\|הכנסה\|הכנסת/.test(wbody));
ok('doPost wires _resolveBusinessNamePrefix_', /_resolveBusinessNamePrefix_\(/.test(SRC));
ok('_parseBusinessNumberPrefix_ still exists (numbered route intact)', /function _parseBusinessNumberPrefix_\(/.test(SRC));

console.log('test_named_business_routing: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
