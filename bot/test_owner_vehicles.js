#!/usr/bin/env node
// bot/test_owner_vehicles.js  (auto-discovered by the gauntlet)
// Locks the owner's custom vehicle SUBCATEGORIES under תחבורה so a message like
// "10000 רכב רוביקון" lands in the רוביקון dashboard row, not תחבורה/שונות.
// Steven 2026-06-25: the live bot booked "10000 רכב רוביקון" to שונות because it
// was running OLD code; the mapping exists in CATEGORY_MAP (lines ~435-439) and
// this gate keeps it from regressing.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
function classify(msg) {
  const out = execFileSync('node', [path.join(__dirname, 'bot-replay.js'), '--json', msg], { encoding: 'utf8' });
  const j = JSON.parse(out);
  const pt = j.predicted_target || {};
  return { category: pt.category || '', sub: pt.subcategory || '', amount: (j.decisions && j.decisions.amountMatch && j.decisions.amountMatch.amount) || null };
}

const CASES = [
  // [message, expected category, expected subcategory, expected amount]
  ['10000 רכב רוביקון', 'תחבורה', 'רוביקון', 10000],
  ['10000 רוביקון',     'תחבורה', 'רוביקון', 10000],
  ['רוביקון 500',        'תחבורה', 'רוביקון', 500],
  ['גיפ רוביקון 300',    'תחבורה', 'רוביקון', 300],
  ['ליים 12',            'תחבורה', 'ליים',    12],
  ['lime 15',            'תחבורה', 'ליים',    15],
  ['bmw s1000 800',      'תחבורה', 'BMW s1000', 800],
  ['אופנוע 250',         'תחבורה', 'BMW s1000', 250],
];

let pass = 0, fail = 0;
for (const [msg, cat, sub, amt] of CASES) {
  const r = classify(msg);
  const ok = r.category === cat && r.sub === sub && Number(r.amount) === Number(amt);
  if (ok) pass++;
  else { fail++; console.log(`  FAIL "${msg}" -> ${r.category}/${r.sub} ₪${r.amount} (want ${cat}/${sub} ₪${amt})`); }
}
console.log(`test_owner_vehicles: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
