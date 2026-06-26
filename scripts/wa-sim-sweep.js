#!/usr/bin/env node
// scripts/wa-sim-sweep.js
//
// 10k-scale category-COVERAGE sweep: for every keyword the bot knows
// (CATEGORY_MAP), send "<keyword> 100" through the REAL classifier (wa-sim's
// predict) and assert it routes back to that keyword's OWN declared category.
// Catches keyword COLLISIONS (a keyword that, in a full sentence, loses to a
// longer/earlier keyword in a different category), amount-parse breaks on the
// keyword, and DEFAULT/שונות fallbacks. Deterministic, no agents, no live writes.
//
// Run: node scripts/wa-sim-sweep.js [--phrasings] [--limit N] [--json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { predict } = require('./wa-sim.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bot', 'ExpenseBot_FIXED.gs'), 'utf8');

// Extract the const CATEGORY_MAP = [ ... ]; array literal by balanced brackets.
function extractArray(decl) {
  const start = SRC.indexOf(decl);
  if (start < 0) return null;
  const open = SRC.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '[') depth++;
    else if (SRC[i] === ']') { depth--; if (depth === 0) return SRC.slice(open, i + 1); }
  }
  return null;
}
let CATEGORY_MAP = [];
try { CATEGORY_MAP = eval(extractArray('const CATEGORY_MAP =')); } catch (e) { console.error('CATEGORY_MAP eval failed:', e.message); process.exit(2); }

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const phrasings = args.includes('--phrasings');
const limIdx = args.indexOf('--limit');
const limit = limIdx >= 0 ? Number(args[limIdx + 1]) : Infinity;

// Build the test list: each keyword expects its row's category.
const tests = [];
for (const row of CATEGORY_MAP) {
  if (!row || !Array.isArray(row.keywords)) continue;
  for (const kw of row.keywords) {
    const k = String(kw || '').trim();
    if (!k || /^\d+$/.test(k)) continue;          // skip pure-number keywords (amount collision by design)
    if (k.length < 2) continue;                    // 1-char keywords are noise
    tests.push({ kw: k, category: row.category, subcategory: row.subcategory });
    if (phrasings) {
      tests.push({ kw: k, category: row.category, subcategory: row.subcategory, tmpl: 'amount-after' });
      tests.push({ kw: k, category: row.category, subcategory: row.subcategory, tmpl: 'shekel' });
    }
    if (tests.length >= limit) break;
  }
  if (tests.length >= limit) break;
}

function msgFor(t) {
  if (t.tmpl === 'amount-after') return t.kw + ' 100';     // "<kw> 100"
  if (t.tmpl === 'shekel') return '100 שח ' + t.kw;        // "100 שח <kw>"
  return '100 ' + t.kw;                                     // "100 <kw>"
}

let pass = 0, catMiss = 0, defaultFell = 0, amountWrong = 0, crash = 0;
const collisions = [];
for (const t of tests) {
  const msg = msgFor(t);
  let p;
  try { p = predict(msg); } catch (e) { crash++; continue; }
  if (Number(p.amount) !== 100 && !(p.items && p.items.some(i => Number(i.amount) === 100))) amountWrong++;
  const gotDefault = !p.category || p.subcategory === 'שונות' || p.category === 'שונות ואחרים';
  if (p.category === t.category) { pass++; }
  else {
    catMiss++;
    if (gotDefault) defaultFell++;
    // record a sample of real collisions (keyword -> wrong NON-default category)
    if (!gotDefault && collisions.length < 400) collisions.push({ kw: t.kw, want: t.category, got: p.category + '/' + p.subcategory, msg });
  }
}

const total = tests.length;
const report = {
  total, pass, catMiss, defaultFell, amountWrong, crash,
  coverage: total ? +(pass / total * 100).toFixed(2) : 0,
  collisions: collisions.slice(0, 60),
};
if (jsonMode) { console.log(JSON.stringify(report)); }
else {
  console.log('=== WA-SIM KEYWORD COVERAGE SWEEP ===');
  console.log(`keywords tested: ${total}  | routed to own category: ${pass} (${report.coverage}%)`);
  console.log(`category mismatches: ${catMiss}  (of which fell to DEFAULT/שונות: ${defaultFell})`);
  console.log(`amount-parse wrong: ${amountWrong}  | crashes: ${crash}`);
  console.log(`\n--- COLLISIONS (keyword routed to a WRONG non-default category) — first ${report.collisions.length} ---`);
  report.collisions.forEach(c => console.log(`  "${c.kw}"  want=${c.want}  got=${c.got}`));
}
process.exit(0);

module.exports = { CATEGORY_MAP };
