#!/usr/bin/env node
// bot/test_owner_apollo.js  (auto-discovered by the gauntlet)
//
// Steven 2026-06-27: any message from the OWNER that mentions "אפולו" (his dog)
// must file under the "אפולו" subcategory, no matter what other keywords it
// carries (רישיון/חיסון/וטרינר would otherwise win the longest-match and land it
// in business/health/pets). This guards the owner-priority Step 0 in
// matchCategorySmart. Owner-gated, so tenants are unaffected.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

// extract matchCategorySmart; Step 0 returns before touching its other deps, so
// stubbing _isOwnerPhone_ (+ Logger) is enough to exercise the owner path.
const fi = src.indexOf('function matchCategorySmart(');
let d = 0, start = src.indexOf('{', fi), end = -1;
for (let j = start; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) { end = j; break; } } }
/* eslint-disable no-unused-vars, no-eval */
var Logger = { log() {} };
var _isOwnerPhone_ = () => true;
const matchCategorySmart = eval('(' + src.slice(fi, end + 1) + ')');
/* eslint-enable no-eval */

const OWNER = '972547760643';
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); } }

const CASES = [
  'אפולו 61 תשלום עבור רישיון חיסון כלב',
  'אפולו 200 וטרינר',
  'אפולו חיסון 61',
  'אוכל לאפולו 90',
  'תרופות לאפולו 120',
  'אפולו',
];
for (const m of CASES) {
  const r = matchCategorySmart(m, OWNER);
  ok(`owner "${m}" -> subcategory אפולו`, r && r.subcategory === 'אפולו' && r.isIncome === false, r && JSON.stringify(r));
}

// The CATEGORY_MAP entry also exists (so the fallback keyword path is covered
// even outside the owner-priority pre-check).
ok('CATEGORY_MAP has an אפולו -> אפולו entry', /"keywords":\[[^\]]*"אפולו"[^\]]*\][^}]*"subcategory":"אפולו"/.test(src));

console.log(`test_owner_apollo: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
