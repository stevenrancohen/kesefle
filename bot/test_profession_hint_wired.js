#!/usr/bin/env node
// bot/test_profession_hint_wired.js (auto-discovered by the gauntlet)
// Locks the GAP-1 fix from the epic audit (Steven 2026-06-08): the profession +
// tracking-type AI hint was built (_aiCategorizeRich derives it from fromPhone via
// _profileProfessionCached_) but the MAIN expense path called matchCategorySmart
// WITHOUT fromPhone, so personalization was dead on 90%+ of expenses. Every call
// site in processExpense / receipt / family-log now threads fromPhone. Additive:
// no profile -> empty hint -> identical behaviour (golden stays 96.7%).
const fs = require('node:fs'), path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
let pass = 0, fail = 0;
const ok = (l, c) => { if (c) pass++; else { fail++; console.log('  FAIL ' + l); } };

ok('matchCategorySmart(text, fromPhone) signature', /function matchCategorySmart\(text, fromPhone\)/.test(SRC));
ok('hot-loop item.description passes fromPhone', /matchCategorySmart\(item\.description, fromPhone\)/.test(SRC));
ok('__lastItem call passes fromPhone', /matchCategorySmart\(__lastItem\.description, fromPhone\)/.test(SRC));
ok('__budgetLastItem call passes fromPhone', /matchCategorySmart\(__budgetLastItem\.description, fromPhone\)/.test(SRC));
ok('it.description call passes fromPhone', /matchCategorySmart\(it\.description, fromPhone\)/.test(SRC));
ok('receipt vendor call passes fromPhone', /matchCategorySmart\(\(vendor[^)]*\) \+ description, fromPhone\)/.test(SRC));
ok('family-log call passes fromPhone', /\? matchCategorySmart\(description, fromPhone\)/.test(SRC));
ok('sole-item AI call passes fromPhone', /_aiCategorizeRich\(soleItem\.description, fromPhone\)/.test(SRC));
// the hint is real: fromPhone -> profession, and matchCategorySmart forwards it
ok('AI hint derives profession from fromPhone', /_profileProfessionCached_\(fromPhone\)/.test(SRC));
ok('matchCategorySmart forwards fromPhone to the AI path', /_aiCategorizeRich\(text, fromPhone\)/.test(SRC));

console.log('test_profession_hint_wired: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
