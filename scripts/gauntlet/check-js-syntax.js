#!/usr/bin/env node
/**
 * scripts/gauntlet/check-js-syntax.js — group 3 of the regression gauntlet.
 *
 * `node --check` every committed *.js in the repo, plus the two Apps Script
 * bot *.gs files (copied to a temp .js — the originals are NEVER modified).
 *
 * Output: prints each failure (file :: first error line) to stderr, then a
 * final machine-readable line "COUNT <pass> <fail>" to stdout. Exit 0 unless
 * the runner itself crashes (per-file failures are reported via the count, so
 * the bash orchestrator owns the pass/fail verdict).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const root = process.argv[2] || process.cwd();
process.chdir(root);

// Single `find .` so nothing is double-counted; exclude build/vendor dirs.
const list = cp.execSync(
  'find . -name "*.js" -not -path "./node_modules/*" -not -path "./.next/*" -not -path "./.vercel/*" -not -path "./.git/*"',
  { maxBuffer: 64 * 1024 * 1024 }
).toString().trim().split('\n').filter(Boolean);

const files = [...new Set(list)].sort();
let pass = 0, fail = 0;
const fails = [];

for (const f of files) {
  try { cp.execFileSync('node', ['--check', f], { stdio: 'pipe' }); pass++; }
  catch (e) { fail++; fails.push(f + ' :: ' + (e.stderr || '').toString().split('\n')[0]); }
}

// The two Apps Script files are JS but carry a .gs extension Node won't accept
// directly. Copy each to a temp .js and --check it. READ-ONLY: never edited.
for (const gs of ['bot/ExpenseBot_FIXED.gs', 'bot/ExpenseBot_DEPLOY.gs']) {
  if (!fs.existsSync(gs)) continue;
  const tmp = path.join(os.tmpdir(), 'gauntlet_' + path.basename(gs, '.gs') + '.js');
  try {
    fs.copyFileSync(gs, tmp);
    cp.execFileSync('node', ['--check', tmp], { stdio: 'pipe' });
    pass++;
  } catch (e) { fail++; fails.push(gs + ' :: ' + (e.stderr || '').toString().split('\n')[0]); }
}

for (const m of fails) console.error('  \x1b[31m✗ ' + m + '\x1b[0m');
console.log('COUNT ' + pass + ' ' + fail);
