#!/usr/bin/env node
// tests/test_profile_configs.js  (auto-discovered by the gauntlet)
// SAFETY GATE for the per-type dashboard config (lib/profile-configs.js), per the
// council plan (docs/TEMPLATE_GENERATOR_PLAN.md). Proves:
//   1. PARITY: the default/family configs reproduce the EXACT current row set, so
//      already-provisioned sheets are byte-identical (zero change) once wired.
//   2. SUBSET-ONLY: every hideRows label actually EXISTS in lib/sheet-writer.js's
//      PERSONAL_*_ROWS — a config can only HIDE a real row, never invent one
//      (inventing a label would create an unmatched SUMIFS = money disappears).
//   3. The free-text router maps "אקסל לזוג"/"תבנית משפחה"/... to the right type
//      and ignores plain expenses.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PROFILE_CONFIGS, DEFAULT_TYPE, selectRows, parseProfileTypeFromText } = require('../lib/profile-configs.js');

// Extract a `const NAME = [ ... ];` string-array literal from sheet-writer source.
const SW = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sheet-writer.js'), 'utf8');
function arr(name) {
  const m = SW.match(new RegExp('const ' + name + ' = (\\[[\\s\\S]*?\\n\\]);'));
  if (!m) throw new Error('row group not found: ' + name);
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}
const GROUPS = {
  income: arr('PERSONAL_INCOME_ROWS'),
  fixed: arr('PERSONAL_FIXED_ROWS'),
  variable: arr('PERSONAL_VARIABLE_ROWS'),
  food: arr('PERSONAL_FOOD_ROWS'),
  transport: arr('PERSONAL_TRANSPORT_ROWS'),
  misc: arr('PERSONAL_MISC_ROWS'),
};
const ALL_LABELS = new Set([].concat(...Object.values(GROUPS)).map(r => (typeof r === 'string' ? r : r.label)));

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); } }

// 1. PARITY — default + family hide nothing -> identity across every group.
for (const t of [DEFAULT_TYPE, 'family']) {
  for (const [g, rows] of Object.entries(GROUPS)) {
    const sel = selectRows(t, rows);
    ok(`parity ${t}/${g} identical`, sel.length === rows.length && sel.every((r, i) => r === rows[i]));
  }
}
// unknown type -> identity (safe fallback)
ok('unknown type -> identity', selectRows('no_such_type', GROUPS.fixed).length === GROUPS.fixed.length);

// 2. SUBSET-ONLY — every hideRows label is a REAL existing row label.
for (const [type, cfg] of Object.entries(PROFILE_CONFIGS)) {
  for (const lbl of (cfg.hideRows || [])) {
    ok(`${type} hides a real row "${lbl}"`, ALL_LABELS.has(lbl), 'not in PERSONAL_*_ROWS');
  }
}
// and a hide actually removes exactly that row, nothing else
const single = selectRows('single', GROUPS.fixed);
ok('single drops תינוק from fixed', !single.includes('תינוק') && single.length === GROUPS.fixed.length - 1);
ok('single keeps every other fixed row', GROUPS.fixed.filter(r => r !== 'תינוק').every(r => single.includes(r)));

// 3. free-text router
const R = parseProfileTypeFromText;
ok('"אקסל לזוג" -> couple', R('אקסל לזוג') === 'couple');
ok('"תבנית משפחה" -> family', R('תבנית משפחה') === 'family');
ok('"אני עצמאי תכין לי אקסל" -> freelancer', R('אני עצמאי תכין לי אקסל') === 'freelancer');
ok('"גיליון לבד" -> basic_personal', R('גיליון לבד') === 'basic_personal');
ok('"תבנית לבעל עסק" -> business', R('תבנית לבעל עסק') === 'business');
ok('plain expense "50 קפה" -> null (no template word)', R('50 קפה') === null);
ok('"עסק שירים 50" -> null (no template word)', R('עסק שירים 50') === null);

console.log(`test_profile_configs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
