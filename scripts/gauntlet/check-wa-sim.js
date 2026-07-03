#!/usr/bin/env node
// scripts/gauntlet/check-wa-sim.js
//
// MERGE-GATE RATCHET for the WhatsApp-bot simulator corpus
// (tests/wa-sim/corpus.jsonl) — the only realistic income-sign + amount benchmark
// (1200+ labeled messages run through the REAL bot logic via bot-replay). This
// gate makes every classifier / parser / keyword / sign edit provably
// non-regressing:
//   * HARD FAIL if ANY transaction "disappears" from the dashboard (must be 0).
//     (An income/expense whose col-E label + col-H sign land it in no SUMIFS total
//     — the exact "money vanished" class of bug.)
//   * RATCHET FAIL if corpus accuracy drops below the pinned baseline floor.
//
// When accuracy improves, RAISE BASELINE_ACCURACY so the floor ratchets up and a
// later regression below the new high-water mark is caught.
'use strict';
const { execSync } = require('node:child_process');
const path = require('node:path');

const BASELINE_ACCURACY = 93.0; // high-water mark ~93.1% (2026-06-27) — raise as it climbs
const ROOT = path.join(__dirname, '..', '..');

// NOTE: the wa-sim CLI exits non-zero whenever accuracy < 100% (by design), so
// run it via the shell with `|| true` and redirect the JSON to a temp file —
// that way execSync never throws on the expected non-zero exit and we read the
// report back from disk.
const fs = require('node:fs');
const os = require('node:os');
const TMP = path.join(os.tmpdir(), 'kfl-gauntlet-wasim.json');
let rep;
try {
  execSync(`node scripts/wa-sim.js --corpus tests/wa-sim/corpus.jsonl --json > ${TMP} 2>/dev/null || true`, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  rep = JSON.parse(fs.readFileSync(TMP, 'utf8'));
} catch (e) {
  console.error('  x wa-sim corpus run failed: ' + (e && e.message));
  process.exit(1);
}

const acc = rep.accuracy;
const disappeared = (rep.dashboard && rep.dashboard.disappeared) ? rep.dashboard.disappeared.length : 0;
let fail = 0;

if (disappeared > 0) {
  console.error(`  x wa-sim: ${disappeared} transaction(s) DISAPPEAR from the dashboard (must be 0)`);
  rep.dashboard.disappeared.slice(0, 5).forEach((d) => console.error(`      "${d.msg}"  -> ${d.category}/${d.subcategory}`));
  fail = 1;
}
if (acc == null || acc < BASELINE_ACCURACY) {
  console.error(`  x wa-sim: corpus accuracy ${acc}% < baseline ${BASELINE_ACCURACY}% (ratchet floor)`);
  fail = 1;
}
// 10K CATEGORY RATCHET (2026-07-03): the 17k persona corpus asserts CATEGORY at
// the dashboard-bucket level via wa-sim-triage. Floor = 70% (72.01% at ratchet
// time; raise as it climbs). Also floors amount/income accuracy.
try {
  execSync(`node scripts/wa-sim-triage.js tests/wa-sim/corpus-10k.jsonl --json > ${TMP}.10k 2>/dev/null || true`, { cwd: ROOT, encoding: "utf8", maxBuffer: 64*1024*1024 });
  const r10 = JSON.parse(fs.readFileSync(TMP + ".10k", "utf8"));
  const cat = r10.category && r10.category.accuracy, amt = r10.amount && r10.amount.accuracy, inc = r10.isIncome && r10.isIncome.accuracy;
  if (cat == null || cat < 75) { console.error(`  x 10k corpus CATEGORY % < 75% floor`); fail = 1; }
  if (amt == null || amt < 98.5) { console.error(`  x 10k corpus AMOUNT ${amt}% < 98.5% floor`); fail = 1; }
  if (inc == null || inc < 97) { console.error(`  x 10k corpus INCOME ${inc}% < 97% floor`); fail = 1; }
  if (!fail) console.log(`  10k corpus: category ${cat}% / amount ${amt}% / income ${inc}% — floors 70/98.5/97 OK`);
} catch (e) { console.error("  x 10k ratchet failed to run: " + e.message); fail = 1; }

if (!fail) {
  console.log(`  wa-sim corpus: ${acc}% accuracy (>= ${BASELINE_ACCURACY}% floor), 0 disappeared-money — OK`);
}
process.exit(fail ? 1 : 0);
