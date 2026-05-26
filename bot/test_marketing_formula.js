// Unit test for the marketing-cost formula generation logic in
// bot/personal_sheet_fix.gs. We extract the building blocks via
// balanced-brace extraction and exercise them against fixtures.

const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'personal_sheet_fix.gs'), 'utf8');

// Extract _COMPANY_SUB_BUCKETS_ literal (a JS array) and eval it.
function extractVar(name) {
  const re = new RegExp('var\\s+' + name + '\\s*=\\s*');
  const m = src.match(re);
  if (!m) throw new Error('var ' + name + ' not found');
  const start = m.index + m[0].length;
  // Walk to the matching ]; for arrays.
  let depth = 0, end = -1, openChar = src[start];
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('balanced extraction failed for ' + name);
  return src.slice(start, end);
}

const bucketsLit = extractVar('_COMPANY_SUB_BUCKETS_');
// eslint-disable-next-line no-new-func
const buckets = new Function('return ' + bucketsLit + ';')();

// Extract _isBrokenDashFormula_ + _bucketForBizSub_
function extractFn(name) {
  const idx = src.indexOf('function ' + name + '(');
  if (idx < 0) throw new Error('fn not found: ' + name);
  let depth = 0, end = -1, started = false;
  for (let i = idx; i < src.length; i++) {
    if (src[i] === '{') { depth++; started = true; }
    else if (src[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }
  }
  return src.slice(idx, end);
}

const isBroken = new Function('_COMPANY_SUB_BUCKETS_', extractFn('_isBrokenDashFormula_') + '\nreturn _isBrokenDashFormula_;')(buckets);
const bucketForSub = new Function('_COMPANY_SUB_BUCKETS_', extractFn('_bucketForBizSub_') + '\nreturn _bucketForBizSub_;')(buckets);

let pass = 0, fail = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)));
  ok ? pass++ : fail++;
}

console.log('-- _isBrokenDashFormula_ --');
// Steven's exact screenshot formula -- the local-column SUMIFS bug.
check("local-col SUMIFS '=SUMIFS($I$20:$I$500,$A$20:$A$500,\"יוני\")'",
  isBroken('=SUMIFS($I$20:$I$500,$A$20:$A$500,"יוני")'), true);
check("hardcoded +N suffix",
  isBroken("=SUMIFS('תנועות'!C:C,'תנועות'!B:B,\"2026-05\") + 2100"), true);
check("hardcoded -N suffix",
  isBroken("=SUMIFS('תנועות'!C:C,'תנועות'!B:B,\"2026-05\")  -  150"), true);
check("clean תנועות SUMIFS  (PRESERVE)",
  isBroken("=SUMIFS('תנועות'!C:C,'תנועות'!B:B,\"2026-05\",'תנועות'!D:D,\"עסק\")"), false);
check("SUMPRODUCT formula  (PRESERVE)",
  isBroken("=IFERROR(SUMPRODUCT(('תנועות'!C2:C5000)*('תנועות'!B2:B5000=\"2026-05\")),0)"), false);
check("empty cell",      isBroken(''),       false);
check("non-formula",     isBroken('123.45'), false);
check("plain text",      isBroken('hello'),  false);

console.log('\n-- _bucketForBizSub_ (subcategory -> dashboard label) --');
// Marketing-bucket positive cases
[['שיווק','עלות שיווק'], ['פרסום','עלות שיווק'], ['Facebook','עלות שיווק'],
 ['פייסבוק','עלות שיווק'], ['google ads','עלות שיווק'], ['קמפיין','עלות שיווק'],
 ['Adwords','עלות שיווק'], ['Instagram','עלות שיווק']].forEach(function (p) {
  check('"' + p[0] + '" -> ' + p[1], bucketForSub(p[0]), p[1]);
});
// Non-marketing must NOT land in marketing
[['חומרי גלם','עלות חומרי גלם'], ['raw materials','עלות חומרי גלם'],
 ['משלוח','משלוחים והתקנות'], ['shipping','משלוחים והתקנות'],
 ['תוכנות','הוצאות תפעוליות'], ['operational','הוצאות תפעוליות']].forEach(function (p) {
  check('"' + p[0] + '" -> ' + p[1], bucketForSub(p[0]), p[1]);
});
// Unrelated -> null
[['סופר','אוכל'], ['קפה','אוכל'], ['ארנונה','בית'], ['דלק','רכב'], ['חשמל','בית']]
  .forEach(function (p) { check('"' + p[0] + '" (unrelated to biz buckets)', bucketForSub(p[0]), null); });

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
if (fail) process.exit(1);
