// Unit test: lib/professions.js catalog integrity + lib/profession-template.js helpers.
// Run: node tests/test_professions.js

import { PROFESSIONS, findProfession, professionsByCategory, TOTAL_PROFESSIONS, CATEGORIES } from '../lib/professions.js';
import {
  getProfessionRows,
  getProfessionBoostKeywords,
  getProfessionLabel,
  getProfessionCategory,
  getProfessionVat,
  getProfessionTemplateExtras,
  describeProfession,
  getPopularProfessions,
  getProfessionsGrouped,
  POPULAR_PROFESSION_IDS,
} from '../lib/profession-template.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('=== CATALOG STRUCTURE ===\n');

check('PROFESSIONS array exists', Array.isArray(PROFESSIONS));
check('TOTAL_PROFESSIONS matches array length',
  TOTAL_PROFESSIONS === PROFESSIONS.length,
  'TOTAL_PROFESSIONS=' + TOTAL_PROFESSIONS + ' vs PROFESSIONS.length=' + PROFESSIONS.length);
check('Catalog has 80-150 entries (sanity bounds)',
  PROFESSIONS.length >= 80 && PROFESSIONS.length <= 150,
  'got ' + PROFESSIONS.length);
check('CATEGORIES has exactly 10 buckets',
  Array.isArray(CATEGORIES) && CATEGORIES.length === 10,
  'got ' + (CATEGORIES ? CATEGORIES.length : 'undefined'));

const REQUIRED_CATS = ['construction', 'professional_services', 'healthcare', 'tech', 'retail_service', 'creative', 'education', 'logistics', 'agriculture', 'employee'];
REQUIRED_CATS.forEach(function (c) {
  check('category present: ' + c, CATEGORIES.indexOf(c) >= 0);
});

console.log('\n=== ENTRY SHAPE ===\n');

const seenIds = new Set();
let shapeErrors = 0;
PROFESSIONS.forEach(function (p, idx) {
  const errs = [];
  if (typeof p.id !== 'string' || !p.id) errs.push('missing id');
  if (typeof p.he !== 'string' || !p.he) errs.push('missing he');
  if (typeof p.en !== 'string' || !p.en) errs.push('missing en');
  if (REQUIRED_CATS.indexOf(p.category) < 0) errs.push('bad category ' + p.category);
  if (['osek_morshe', 'osek_patur', 'employee', 'employer'].indexOf(p.vat) < 0) errs.push('bad vat ' + p.vat);
  if (!Array.isArray(p.income_subs) || p.income_subs.length < 2) errs.push('income_subs missing or too short');
  if (!Array.isArray(p.expense_subs) || p.expense_subs.length < 2) errs.push('expense_subs missing or too short');
  if (!Array.isArray(p.keywords_boost) || p.keywords_boost.length < 5) errs.push('keywords_boost missing or too short');
  if (seenIds.has(p.id)) errs.push('duplicate id');
  seenIds.add(p.id);
  if (errs.length) {
    shapeErrors++;
    if (shapeErrors <= 5) console.log('  ❌ entry[' + idx + '] (' + p.id + '): ' + errs.join(', '));
  }
});
check('all entries pass shape validation', shapeErrors === 0, shapeErrors + ' entries failed');

console.log('\n=== LOOKUPS ===\n');

const sample = findProfession('general_contractor');
check('findProfession returns known profession', sample && sample.id === 'general_contractor');
check('  ...with Hebrew label', sample && /[א-ת]/.test(sample.he));
check('findProfession returns null for unknown id', findProfession('definitely_not_a_real_profession_xyz') === null
  || findProfession('definitely_not_a_real_profession_xyz') === undefined);

const grouped = professionsByCategory();
check('professionsByCategory returns object',
  grouped && typeof grouped === 'object' && Object.keys(grouped).length === 10,
  'got ' + (grouped ? Object.keys(grouped).length : 'null') + ' keys');
check('every category has at least 3 entries',
  REQUIRED_CATS.every(function (c) { return (grouped[c] || []).length >= 3; }));

console.log('\n=== HELPER API ===\n');

const rows = getProfessionRows('lawyer');
check('getProfessionRows returns {income, expense}', rows && Array.isArray(rows.income) && Array.isArray(rows.expense));
check('  ...lawyer has lawyer-y income subs',
  rows.income.length >= 2,
  'got ' + rows.income.length + ' income subs');

check('getProfessionRows for unknown id returns empty arrays',
  (function () {
    const r = getProfessionRows('xyz');
    return r.income.length === 0 && r.expense.length === 0;
  })());

const kw = getProfessionBoostKeywords('accountant');
check('getProfessionBoostKeywords returns array of strings',
  Array.isArray(kw) && kw.length >= 5 && kw.every(function (k) { return typeof k === 'string'; }));

check('getProfessionLabel("lawyer") returns Hebrew',
  /[א-ת]/.test(getProfessionLabel('lawyer')));
check('getProfessionLabel(null) safely returns "—"',
  getProfessionLabel(null) === '—');

check('getProfessionCategory returns valid bucket',
  REQUIRED_CATS.indexOf(getProfessionCategory('photographer')) >= 0);
check('getProfessionVat returns one of 4 known values',
  ['osek_morshe', 'osek_patur', 'employee', 'employer'].indexOf(getProfessionVat('accountant')) >= 0);

check('getProfessionTemplateExtras returns array',
  Array.isArray(getProfessionTemplateExtras('general_contractor')));

check('describeProfession produces a readable string',
  typeof describeProfession('lawyer') === 'string' && describeProfession('lawyer').indexOf('(') > 0);
check('describeProfession(null) returns "none"',
  describeProfession(null) === 'none');

console.log('\n=== POPULAR + GROUPED ===\n');

const popular = getPopularProfessions();
check('getPopularProfessions returns 10 entries',
  popular.length === POPULAR_PROFESSION_IDS.length,
  'got ' + popular.length);
check('all popular entries have id+he+category',
  popular.every(function (p) { return p.id && p.he && p.category; }));

const allGrouped = getProfessionsGrouped();
check('getProfessionsGrouped covers all 10 categories',
  Object.keys(allGrouped).length === 10);
check('total entries in grouped = total in catalog',
  Object.values(allGrouped).reduce(function (s, arr) { return s + arr.length; }, 0) === PROFESSIONS.length);

console.log('\n=== KEYWORD QUALITY (spot checks) ===\n');

// Diagnostic keywords should reflect the actual profession.
const accountantKw = getProfessionBoostKeywords('accountant').join(' ');
check('accountant has accounting-software keyword (חשבשבת/icount/rivhit/etc.)',
  /חשבשבת|icount|rivhit|מס הכנסה|מע|טופס/i.test(accountantKw),
  'kw: ' + accountantKw);

const contractorKw = getProfessionBoostKeywords('general_contractor').join(' ');
check('general_contractor has construction material keyword (בטון/גבס/etc.)',
  /בטון|גבס|טיט|חומרי|בניין|פועלים|אינסטלציה/i.test(contractorKw),
  'kw: ' + contractorKw);

const taxiKw = getProfessionBoostKeywords('taxi_driver').join(' ');
check('taxi_driver has taxi-relevant keyword (דלק/גט/חניה/etc.)',
  /דלק|גט|gett|מונית|רישוי|חניה/i.test(taxiKw),
  'kw: ' + taxiKw);

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
