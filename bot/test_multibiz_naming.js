// Unit test for the new _parseBusinessNumberPrefix_ regex logic.
// Loads the function out of bot/ExpenseBot_FIXED.gs via balanced-brace
// extraction so we exercise the REAL source -- same pattern used by
// bot/test_parser.js etc.
//
// Steven 2026-05-26: covers the multi-business naming feature.

const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, 'ExpenseBot_FIXED.gs'),
  'utf8',
);

// Extract _parseBusinessNumberPrefix_ via balanced-brace scan.
function extractFn(name) {
  const idx = src.indexOf('function ' + name + '(');
  if (idx < 0) throw new Error('function ' + name + ' not found in source');
  let depth = 0, end = -1, started = false;
  for (let i = idx; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true; }
    else if (src[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('could not balance braces for ' + name);
  return src.slice(idx, end);
}

const fnSrc = extractFn('_parseBusinessNumberPrefix_');
// eslint-disable-next-line no-new-func
const fn = new Function(fnSrc + '\nreturn _parseBusinessNumberPrefix_;')();

const cases = [
  // Steven's exact failing message
  { in: 'עסק 2 כספלה - 52 hostinger -hermes', want: { n: 2, name: 'כספלה', rest: '52 hostinger -hermes' } },
  // Original format (no name) -- backward compat
  { in: 'עסק 2 320 שיווק',                       want: { n: 2, name: null,    rest: '320 שיווק' } },
  { in: 'עסק 1 250 דלק',                          want: { n: 1, name: null,    rest: '250 דלק' } },
  // Set-name-only
  { in: 'עסק 2 כספלה',                            want: { n: 2, name: 'כספלה', rest: '' } },
  // Income syntax
  { in: 'עסק 2 כספלה - +1500 מכירה',              want: { n: 2, name: 'כספלה', rest: '+1500 מכירה' } },
  // Colon separator
  { in: 'עסק 3 הרמס: 88 ספרים',                  want: { n: 3, name: 'הרמס',  rest: '88 ספרים' } },
  // Em-dash separator
  { in: 'עסק 4 חברה ב — 200 שיווק',              want: { n: 4, name: 'חברה ב', rest: '200 שיווק' } },
  // English name
  { in: 'עסק 5 Hermes - 40 stripe',               want: { n: 5, name: 'Hermes', rest: '40 stripe' } },
  // No "עסק N" prefix -> null
  { in: '250 דלק',                                 want: null },
  // עסק without number -> null
  { in: 'עסק שיווק 200',                          want: null },
  // N out of range -> null
  { in: 'עסק 100 250 דלק',                        want: null },
  // Empty
  { in: '',                                        want: null },
  // null/undefined
  { in: null,                                       want: null },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = fn(c.in);
  const ok = JSON.stringify(got) === JSON.stringify(c.want);
  if (ok) {
    pass++;
    console.log('  PASS  ' + JSON.stringify(c.in));
  } else {
    fail++;
    console.log('  FAIL  ' + JSON.stringify(c.in));
    console.log('        want=' + JSON.stringify(c.want));
    console.log('        got =' + JSON.stringify(got));
  }
}

console.log('');
console.log(pass + '/' + (pass + fail) + ' passed');
if (fail > 0) process.exit(1);
