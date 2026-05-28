#!/usr/bin/env node
// bot/test_migration_phase_7.js
// Regression test for bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs (Phase 7 of
// the Kesefle migration epic — Steven 2026-05-28).
//
// Phase 7 is the post-migration sweep: after Phase 5 verified the NEW
// dashboard is healthy, this audits every bot/*.gs file that still
// hardcodes the OLD sheet ID and classifies each as:
//   (a) UTILITY-NEEDS-UPDATE → rewire to NEW
//   (b) ARCHIVE-DEPRECATED   → leave alone
//   (c) INTENTIONAL-OLD      → MUST keep pointing at OLD (CLEANUP_LEAKED_ROWS,
//                              MIGRATE_OLD_TO_KESEFLE — they need to READ
//                              OLD to do their job)
//   (d) ALREADY-MIGRATED     → OLD literal only in a rollback comment
//
// The test:
//   1) Loads the live source so the classification list stays honest.
//   2) Runs grep on the real bot/ directory to find every file with the
//      OLD sheet ID — then asserts every such file appears in the
//      classification map (no orphans).
//   3) Asserts every file in the classification map exists.
//   4) Locks in the (c) intentional-OLD list — CLEANUP_LEAKED_ROWS and
//      MIGRATE_OLD_TO_KESEFLE must always be (c). If a regression moves
//      them to (a), this test fails LOUDLY.
//   5) Asserts the APPLY gate: refuses without "YES I UNDERSTAND", uses
//      LockService, never writes to a sheet (the rewrite is local-repo,
//      not sheet-data).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC = fs.readFileSync(path.join(__dirname, 'MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs'), 'utf8');
const REPO_ROOT = path.join(__dirname, '..');
const BOT_DIR = path.join(REPO_ROOT, 'bot');

const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_migration_phase_7.js\n');

// ── Constants ──────────────────────────────────────────────────────────
console.log('Sheet ID constants:');
assert(/_MP7_OLD_SHEET_ID_\s*=\s*['"]1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo['"]/.test(SRC),
  'OLD sheet ID is the canonical OLD (1UKr...)');
assert(/_MP7_NEW_SHEET_ID_\s*=\s*['"]1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A['"]/.test(SRC),
  'NEW sheet ID is the canonical Kesefle (1rti...)');
assert(/_MP7_VERSION_\s*=\s*['"]Migration_Phase_7_v1['"]/.test(SRC),
  'Phase 7 version tag set');

// ── Public entry points ────────────────────────────────────────────────
console.log('\nPublic entry points:');
assert(/function DRY_RUN_PHASE_7_SWEEP\(\)/.test(SRC),
  'DRY_RUN_PHASE_7_SWEEP() exists (zero-arg, dropdown-friendly)');
assert(/function APPLY_PHASE_7_REWIRE\(confirmation\)/.test(SRC),
  'APPLY_PHASE_7_REWIRE(confirmation) exists');
assert(/function APPLY_PHASE_7_REWIRE_NOW\(\)/.test(SRC),
  'APPLY_PHASE_7_REWIRE_NOW() zero-arg wrapper exists');

// ── APPLY safety gate ──────────────────────────────────────────────────
console.log('\nAPPLY safety gate (Steven\'s iron rule):');
assert(/if \(confirmation !== ['"]YES I UNDERSTAND['"]\)/.test(SRC),
  'APPLY refuses unless confirmation === "YES I UNDERSTAND"');
assert(/refused:\s*true/.test(SRC),
  'APPLY returns { refused: true } on wrong arg (not silent fail)');
assert(/APPLY_PHASE_7_REWIRE\(['"]YES I UNDERSTAND['"]\)/.test(SRC),
  'APPLY_PHASE_7_REWIRE_NOW passes literal confirmation internally');

// ── Concurrent-run lock (APPLY only) ──────────────────────────────────
console.log('\nConcurrent-run lock:');
assert(/LockService\.getScriptLock\(\)/.test(SRC),
  'APPLY uses LockService.getScriptLock (works for standalone Apps Script)');
assert(!/LockService\.getDocumentLock\(\)/.test(SRC),
  'No getDocumentLock — bot is standalone');
assert(/tryLock\(30000\)/.test(SRC),
  'Lock has 30s timeout');
assert(/error:\s*['"]lock_held['"]/.test(SRC),
  'Returns { error: "lock_held" } if another run is active');
assert(/releaseLock\(\)/.test(SRC),
  'Lock released after APPLY');

// DRY-RUN must NOT lock (read-only path doesn't need it)
const lockGuard = SRC.match(/var _mp7Lock = null;[\s\S]{0,400}if \(applyMode\)/);
assert(lockGuard !== null,
  'Lock acquisition gated by `if (applyMode)` — DRY-RUN never locks');

// ── DRY-RUN never writes (the iron rule) ──────────────────────────────
console.log('\nDRY-RUN never writes:');
assert(/_mp7_audit_\(false\)/.test(SRC),
  'DRY_RUN_PHASE_7_SWEEP calls auditor with applyMode=false');

// Phase 7 doesn't touch any sheet data — it edits .gs files via a logged
// sed plan. Assert NO setValue / setValues / setFormula calls anywhere.
const forbiddenSheetWrites = ['setValue', 'setValues', 'setFormula', 'setFormulas',
                              'setNote', 'setNotes', 'deleteRow', 'deleteRows',
                              'insertRow', 'insertRows', 'clear', 'clearContent',
                              'clearDataValidations', 'insertSheet', 'deleteSheet'];
forbiddenSheetWrites.forEach(function (verb) {
  const re = new RegExp('\\.' + verb + '\\b');
  assert(!re.test(SRC),
    'Phase 7 source contains NO .' + verb + '() — does NOT touch sheet data');
});

// ── Classification map sanity ──────────────────────────────────────────
console.log('\nClassification map:');
assert(/_MP7_FILE_CLASSIFICATIONS_/.test(SRC),
  '_MP7_FILE_CLASSIFICATIONS_ map defined');

// Pull the file list out of the source for cross-checking with grep.
const classifiedFiles = [];
const fileEntryRe = /['"](bot\/[A-Za-z0-9_\.\-]+\.gs)['"]\s*:\s*\{[^}]*category:\s*['"]([a-d])['"]/g;
let m;
while ((m = fileEntryRe.exec(SRC)) !== null) {
  classifiedFiles.push({ path: m[1], category: m[2] });
}
assert(classifiedFiles.length >= 14,
  'Classification map has at least 14 entries (got ' + classifiedFiles.length + ')');

// ── Locked-in (c) intentional-OLD list ─────────────────────────────────
console.log('\nLocked-in (c) INTENTIONAL-OLD list (must NEVER be (a)):');
const cFiles = classifiedFiles.filter(function (e) { return e.category === 'c'; }).map(function (e) { return e.path; });
assert(cFiles.indexOf('bot/CLEANUP_LEAKED_ROWS.gs') >= 0,
  'CLEANUP_LEAKED_ROWS.gs locked to (c) INTENTIONAL-OLD');
assert(cFiles.indexOf('bot/MIGRATE_OLD_TO_KESEFLE.gs') >= 0,
  'MIGRATE_OLD_TO_KESEFLE.gs locked to (c) — it reads OLD to copy to NEW');

// Files that must NOT be in (a) — defending against regression
const aFiles = classifiedFiles.filter(function (e) { return e.category === 'a'; }).map(function (e) { return e.path; });
assert(aFiles.indexOf('bot/CLEANUP_LEAKED_ROWS.gs') < 0,
  'CLEANUP_LEAKED_ROWS.gs is NOT in (a) — would corrupt the cleanup target');
assert(aFiles.indexOf('bot/MIGRATE_OLD_TO_KESEFLE.gs') < 0,
  'MIGRATE_OLD_TO_KESEFLE.gs is NOT in (a) — would break the OLD→NEW copy');

// ── Locked-in (a) UTILITY list — at least these utilities MUST be (a) ─
console.log('\nLocked-in (a) UTILITY-NEEDS-UPDATE (must be rewired to NEW):');
const expectedA = [
  'bot/config.gs',
  'bot/WEEKLY_DIGEST.gs',
  'bot/BOT_COMMANDS.gs',
  'bot/DASHBOARD_QUICK_WINS.gs',
  'bot/CLEANUP_DUPLICATES_AND_TABS.gs'
];
expectedA.forEach(function (p) {
  assert(aFiles.indexOf(p) >= 0, p + ' is in (a) UTILITY-NEEDS-UPDATE');
});

// ── Locked-in (b) ARCHIVE-DEPRECATED ───────────────────────────────────
console.log('\nLocked-in (b) ARCHIVE-DEPRECATED (one-shot historical, no-op now):');
const bFiles = classifiedFiles.filter(function (e) { return e.category === 'b'; }).map(function (e) { return e.path; });
assert(bFiles.indexOf('bot/FIX_DASHBOARD_safe.gs') >= 0,
  'FIX_DASHBOARD_safe.gs is in (b) ARCHIVE');
assert(bFiles.indexOf('bot/FIX_DASHBOARD_2023_2024_2025.gs') >= 0,
  'FIX_DASHBOARD_2023_2024_2025.gs is in (b) ARCHIVE');

// ── Locked-in (d) ALREADY-MIGRATED (OLD only in comment) ──────────────
console.log('\nLocked-in (d) ALREADY-MIGRATED (OLD literal in rollback comment only):');
const dFiles = classifiedFiles.filter(function (e) { return e.category === 'd'; }).map(function (e) { return e.path; });
assert(dFiles.indexOf('bot/ExpenseBot_FIXED.gs') >= 0,
  'ExpenseBot_FIXED.gs is in (d) — Phase 1 swap already done');
assert(dFiles.indexOf('bot/ExpenseBot_DEPLOY.gs') >= 0,
  'ExpenseBot_DEPLOY.gs is in (d) — Phase 1 swap already done');
assert(dFiles.indexOf('bot/personal_sheet_fix.gs') >= 0,
  'personal_sheet_fix.gs is in (d) — Phase 1 swap already done');

// ── Grep parity: every file with OLD literal in repo must be classified ─
console.log('\nGrep parity (every repo file with OLD literal is classified):');
let grepOutput;
try {
  grepOutput = execSync(
    "grep -rl '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo' bot/ --include='*.gs' || true",
    { cwd: REPO_ROOT, encoding: 'utf8' }
  ).trim();
} catch (e) {
  grepOutput = '';
}
const grepFiles = grepOutput.split('\n').filter(Boolean).map(function (p) {
  // Normalize potential ./bot/foo to bot/foo
  return p.replace(/^\.\//, '');
});
console.log('  Grep found ' + grepFiles.length + ' files with OLD literal in bot/');

const classifiedSet = new Set(classifiedFiles.map(function (e) { return e.path; }));
grepFiles.forEach(function (p) {
  assert(classifiedSet.has(p),
    'Grep-found file ' + p + ' is in the classification map (no orphans)');
});

// And the reverse — every classified file actually exists on disk.
//
// EXCEPTION: bot/MIGRATE_OLD_TO_KESEFLE.gs is the Phase 2 file that
// lands in a separate PR (#120). It's pre-classified here so Phase 7 is
// correct from day-1 of being deployed, but we don't fail the test if
// PR #120 hasn't merged yet — phase 7 only RUNS after phase 5 confirms
// the migrated data is healthy, which requires phase 2 anyway.
const _missingFileExceptions = new Set(['bot/MIGRATE_OLD_TO_KESEFLE.gs']);
classifiedFiles.forEach(function (entry) {
  const exists = fs.existsSync(path.join(REPO_ROOT, entry.path));
  if (_missingFileExceptions.has(entry.path)) {
    if (exists) {
      console.log('  PASS Classified file ' + entry.path + ' exists on disk (Phase 2 merged)');
    } else {
      console.log('  INFO Classified file ' + entry.path + ' not yet on disk (lands via PR #120) — OK');
    }
    return;
  }
  assert(exists, 'Classified file ' + entry.path + ' exists on disk');
});

// ── Auditor function ─────────────────────────────────────────────────
console.log('\nAuditor function:');
assert(/function _mp7_audit_\(applyMode\)/.test(SRC),
  '_mp7_audit_ scanner exists');
assert(/applyMode\s*\?\s*'\(APPLY\)'\s*:\s*'\(DRY-RUN\)'/.test(SRC),
  'Auditor distinguishes APPLY vs DRY-RUN modes in log');
assert(/byCategory\s*=\s*\{/.test(SRC),
  'Auditor groups files by category');
assert(/Markdown audit table/.test(SRC),
  'Auditor logs the markdown table');

// ── APPLY plan logging ────────────────────────────────────────────────
console.log('\nAPPLY rewrite plan logging:');
assert(/APPLY REWRITE PLAN/.test(SRC),
  'APPLY mode logs the rewrite plan header');
assert(/sed -i\.bak/.test(SRC),
  'APPLY logs a portable sed command (with .bak for safety on macOS sed)');
assert(/Do NOT run sed on/.test(SRC),
  'APPLY warns NOT to run sed on (b) + (c) files');
assert(/test_migration_phase_7/.test(SRC),
  'APPLY tells Steven to re-run THIS test after sed');

// ── Return shape ──────────────────────────────────────────────────────
console.log('\nReturn shape:');
assert(/totalAudited:/.test(SRC),
  'Returns { totalAudited }');
assert(/categories:\s*\{/.test(SRC),
  'Returns { categories: { a, b, c, d, other } }');
assert(/rewireTargets:/.test(SRC),
  'Returns { rewireTargets } — the (a) list');
assert(/keepAsIs:/.test(SRC),
  'Returns { keepAsIs } — the (b)+(c)+(d) list');

// ── Audit table helper ────────────────────────────────────────────────
console.log('\nAudit table helper:');
assert(/function _mp7_buildAuditTable_/.test(SRC),
  '_mp7_buildAuditTable_ helper exists');
assert(/REWIRE -> NEW/.test(SRC),
  'Table labels (a) action as REWIRE -> NEW');
assert(/NO-OP \(archive\)/.test(SRC),
  'Table labels (b) action as NO-OP (archive)');
assert(/KEEP \(intentional\)/.test(SRC),
  'Table labels (c) action as KEEP (intentional)');

// ── Secrets check ─────────────────────────────────────────────────────
console.log('\nSecrets check:');
assert(!/AKIA[A-Z0-9]{16,}/.test(SRC), 'No AWS access key in source');
assert(!/sk_live_[A-Za-z0-9]{20,}/.test(SRC), 'No Stripe live secret in source');
assert(!/ghp_[A-Za-z0-9]{36,}/.test(SRC), 'No GitHub PAT in source');
assert(!/AIza[A-Za-z0-9_-]{35,}/.test(SRC), 'No Google API key in source');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
