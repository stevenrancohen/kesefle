#!/usr/bin/env node
// bot/test_misroute_fixes.js (auto-discovered by the gauntlet)
// Locks the misroute fixes the QA fleet surfaced (Steven 2026-06-08):
//  1) numeric keywords (247, 9000, 1688...) collided with the AMOUNT and pulled
//     messages to a wrong "brand" bucket -> removed from CATEGORY_MAP.
//  2) bare "השתתפות עצמית" (medical co-pay) sat in CAR insurance -> removed.
//  3) catch-all income (freelance/payday/bonus/מענק/דמי הבראה) -> income vocab.
// Uses the real classifier via bot/classify-one.js (primary + index fallback).
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const ONE = path.join(__dirname, 'classify-one.js');
function classify(msg) {
  const out = execFileSync('node', [ONE, msg], { encoding: 'utf8' }).trim();
  const [cat, sub, inc] = out.split(' | ');
  return { cat: (cat || '').trim(), income: /income=true/.test(inc) };
}
const CASES = [
  { msg: 'groceries at Shufersal 247', wantCat: 'אוכל', why: 'amount 247 no longer matches brand "247"' },
  { msg: 'year end bonus 9000', wantIncome: true, why: 'amount 9000 no longer matches insurance "9000"; bonus=income' },
  { msg: 'קופת חולים כללית השתתפות עצמית 45', wantCat: 'בריאות', why: 'co-pay no longer routes to car insurance' },
  { msg: 'freelance payment from client 4500', wantIncome: true, why: 'freelance payment = income' },
  { msg: 'payday 15300', wantIncome: true, why: 'payday = income' },
  { msg: 'מענק שנתי 5000', wantIncome: true, why: 'annual grant = income' },
  { msg: 'דמי הבראה 2700', wantIncome: true, why: 'convalescence pay = income' },
  { msg: 'client paid the invoice 6700', wantIncome: true, why: 'client paid = income' },
  // QA fleet round 3 category fixes
  { msg: "פלאפון 120 לחודש", wantCat: "הוצאות קבועות", why: "Pelephone is telecom, not electronics" },
  { msg: "בזק טלפון 65", wantCat: "הוצאות קבועות", why: "Bezeq landline is telecom" },
  { msg: "פנסיון כלבים לשבוע 250", wantCat: "חיות מחמד", why: "dog boarding is pets, not hotels" },
  { msg: "חיסון לכלב 95", wantCat: "חיות מחמד", why: "dog vaccine is pets, not kids health" },
  { msg: "חיתולים האגיס מסופר פארם 95", wantCat: "חינוך וילדים", why: "diapers are kids, not health" },
  { msg: "כדורסל חוג שבועי 90", wantCat: "חינוך וילדים", why: "kids class, not business SaaS" },
  { msg: "זיכוי כספי 300", wantIncome: true, why: "store refund is income" },
];
let pass = 0, fail = 0;
for (const c of CASES) {
  const r = classify(c.msg);
  let ok = true;
  if (c.wantCat && r.cat.indexOf(c.wantCat) < 0) ok = false;
  if (c.wantIncome && !r.income) ok = false;
  if (ok) pass++; else { fail++; console.log('  FAIL "' + c.msg + '" -> cat=' + r.cat + ' income=' + r.income + '  (' + c.why + ')'); }
}
console.log('test_misroute_fixes: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
