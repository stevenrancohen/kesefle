#!/usr/bin/env node
// bot/test_migration_phase_3.js
// Regression test for bot/MIGRATE_PHASE_3_HISTORICAL_DASHBOARD.gs
// (Phase 3 of the Kesefle migration epic — Steven 2026-05-28).
//
// Same string-match style as bot/test_migration.js — Apps Script can't
// run easily in Node, so we assert source structure. This locks in the
// safety guards Steven cares about so a future edit can't quietly
// break them.
//
// Critical safety guarantees that MUST be present:
//   - DRY_RUN_PHASE3 only reads, never writes
//   - APPLY_PHASE3 refuses without literal "YES I UNDERSTAND" arg
//   - APPLY_PHASE3_NOW zero-arg wrapper for function dropdown
//   - Dedupe before write (idempotent, safe to re-run)
//   - Both OLD sheet ID + NEW sheet ID are correct
//   - Year-block row map matches FIX_DASHBOARD_2023_2024_2025.gs
//   - Snapshot rows tagged with Migration_Phase_3_v1
//   - Audit-trail note written to NEW סיכום היסטורי A1
//   - "Do not delete from OLD" rule honored — script only READS old sheet
//   - "Do not overwrite NEW" rule — script only APPENDS to NEW (and
//     only CREATES סיכום היסטורי if absent in APPLY mode)
//   - Concurrent-run lock (ScriptLock, not DocumentLock)
//   - Sheet IDs as explicit constants, never env-var

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'MIGRATE_PHASE_3_HISTORICAL_DASHBOARD.gs'), 'utf8');
const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_migration_phase_3.js\n');

// ── Sheet IDs ───────────────────────────────────────────────────────────
console.log('Sheet IDs + tab constants:');
assert(/_MIG3_OLD_SHEET_ID_\s*=\s*['"]1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo['"]/.test(SRC),
  'OLD sheet ID is the canonical OLD (1UKr...)');
assert(/_MIG3_NEW_SHEET_ID_\s*=\s*['"]1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A['"]/.test(SRC),
  'NEW sheet ID is the canonical Kesefle (1rti...)');
assert(/_MIG3_OLD_COMPANY_TAB_\s*=\s*['"]מאזן חברה['"]/.test(SRC),
  'OLD מאזן חברה tab name constant defined');
assert(/_MIG3_NEW_SNAPSHOT_TAB_\s*=\s*['"]סיכום היסטורי['"]/.test(SRC),
  'NEW סיכום היסטורי tab name constant defined');

// ── Year-block row map matches FIX_DASHBOARD ──────────────────────────
console.log('\nYear-block row map (matches FIX_DASHBOARD_2023_2024_2025.gs):');
assert(/'2026'\s*:\s*\{\s*startRow:\s*1\s*,\s*endRow:\s*13\s*\}/.test(SRC),
  '2026 block = rows 1-13');
assert(/'2025'\s*:\s*\{\s*startRow:\s*14\s*,\s*endRow:\s*25\s*\}/.test(SRC),
  '2025 block = rows 14-25');
assert(/'2024'\s*:\s*\{\s*startRow:\s*26\s*,\s*endRow:\s*37\s*\}/.test(SRC),
  '2024 block = rows 26-37');
assert(/'2023'\s*:\s*\{\s*startRow:\s*38\s*,\s*endRow:\s*49\s*\}/.test(SRC),
  '2023 block = rows 38-49');

// ── Public entry points ─────────────────────────────────────────────────
console.log('\nPublic entry points:');
assert(/function DRY_RUN_PHASE3\(\)/.test(SRC),
  'DRY_RUN_PHASE3() exists (zero-arg, dropdown-friendly)');
assert(/function APPLY_PHASE3\(confirmation\)/.test(SRC),
  'APPLY_PHASE3(confirmation) exists');
assert(/function APPLY_PHASE3_NOW\(\)/.test(SRC),
  'APPLY_PHASE3_NOW() zero-arg wrapper exists (for function dropdown)');

// ── Safety: APPLY refuses without literal "YES I UNDERSTAND" ───────────
console.log('\nAPPLY safety lock:');
assert(/if \(confirmation !== ['"]YES I UNDERSTAND['"]\)/.test(SRC),
  'APPLY_PHASE3 refuses when confirmation !== "YES I UNDERSTAND"');
assert(/refused:\s*true/.test(SRC),
  'APPLY returns { refused: true } on missing confirmation (not silent fail)');
assert(/APPLY_PHASE3\(['"]YES I UNDERSTAND['"]\)/.test(SRC),
  'APPLY_PHASE3_NOW passes the literal confirmation internally');

// ── DRY_RUN must NOT write ──────────────────────────────────────────────
console.log('\nDRY_RUN read-only guarantee:');
assert(/_mig3_scanAndOptionallyApply_\(false\)/.test(SRC),
  'DRY_RUN_PHASE3 calls scanner with applyMode=false');
assert(/if \(applyMode\) \{[\s\S]{0,5000}setValues/.test(SRC),
  'All setValues() calls are inside if (applyMode) block (no writes in dry-run)');

// Count setValues — header writes happen in _mig3_ensureSnapshotTab_ which
// itself is only called with applyMode=true (asserted below). The scanner's
// data write is also gated by applyMode. So we expect zero setValues
// outside the gated regions.
const applyBlockStart = SRC.indexOf('if (applyMode) {');
let setValuesInsideApply = 0;
let setValuesInsideEnsure = 0;
let setValuesOutsideAll  = 0;
const ensureFnStart = SRC.indexOf('function _mig3_ensureSnapshotTab_');
const ensureFnEnd   = SRC.indexOf('// Core scanner', ensureFnStart);
let cursor = 0;
while (true) {
  const idx = SRC.indexOf('.setValues(', cursor);
  if (idx < 0) break;
  if (idx >= ensureFnStart && idx <= ensureFnEnd) setValuesInsideEnsure++;
  else if (idx >= applyBlockStart) setValuesInsideApply++;
  else setValuesOutsideAll++;
  cursor = idx + 1;
}
assert(setValuesOutsideAll === 0,
  'Zero .setValues() calls outside the apply block / ensure-tab helper (got ' + setValuesOutsideAll + ')');
assert(setValuesInsideApply >= 1,
  '.setValues() called inside apply block for snapshot rows (got ' + setValuesInsideApply + ')');
assert(setValuesInsideEnsure >= 1,
  '.setValues() in ensure-tab helper (header row, only on first APPLY)');

// Ensure the tab-creation helper is only invoked in apply mode (its 2nd
// arg is applyMode; in DRY-RUN it returns null without creating)
assert(/_mig3_ensureSnapshotTab_\(newSS, applyMode\)/.test(SRC),
  '_mig3_ensureSnapshotTab_ receives applyMode flag (dry-run never creates tab)');
assert(/if \(!applyMode\) return null;/.test(SRC),
  'Ensure-tab helper returns null in dry-run (no insertSheet)');

// ── Dedupe (idempotent) ─────────────────────────────────────────────────
console.log('\nDedupe (idempotent re-runs):');
assert(/function _mig3_snapKey_\(sourceRow, year, label\)/.test(SRC),
  '_mig3_snapKey_(sourceRow, year, label) deterministic key for snapshot rows');
assert(/existingSnapKeys\s*=\s*\{\}/.test(SRC),
  'Build existingSnapKeys map from NEW סיכום היסטורי');
assert(/if \(existingSnapKeys\[key\]\)/.test(SRC),
  'Skip when existingSnapKeys[key] already present (dedupe)');
assert(/existingSnapKeys\[key\]\s*=\s*true/.test(SRC),
  'Mark in-flight snapshot key after deciding to write (intra-batch dedupe)');

// ── Year lookup helper ──────────────────────────────────────────────────
console.log('\nYear-block lookup:');
assert(/function _mig3_yearForRow_\(sourceRow\)/.test(SRC),
  '_mig3_yearForRow_(sourceRow) maps OLD row index to year');
assert(/sourceRow >= blk\.startRow && sourceRow <= blk\.endRow/.test(SRC),
  'Year lookup uses inclusive startRow/endRow range check');

// ── Capture range ───────────────────────────────────────────────────────
console.log('\nCapture range:');
assert(/_MIG3_ROW_START_\s*=\s*1/.test(SRC),
  'Row capture starts at 1 (per spec)');
assert(/_MIG3_ROW_END_\s*=\s*50/.test(SRC),
  'Row capture ends at 50 (per spec)');
assert(/_MIG3_COL_START_\s*=\s*1/.test(SRC),
  'Col capture starts at A (1)');
assert(/_MIG3_COL_END_\s*=\s*15/.test(SRC),
  'Col capture ends at O (15) per spec');

// ── Migration tag (so rollback can filter) ─────────────────────────────
console.log('\nMigration tag (for rollback):');
assert(/_MIG3_VERSION_\s*=\s*['"]Migration_Phase_3_v1['"]/.test(SRC),
  'Migration version tag is "Migration_Phase_3_v1"');
// The version is included in every snapped row (concat'd onto the schema)
assert(/concat\(\[totalVal, extraVal, _MIG3_VERSION_, capturedAt\]\)/.test(SRC),
  'Snapshot row appends _MIG3_VERSION_ + capturedAt (so rollback can filter)');

// ── Empty/invalid row protection ───────────────────────────────────────
console.log('\nEmpty/invalid row protection:');
assert(/snapSkipped\s*=\s*\{\s*duplicate:\s*0,\s*empty:\s*0,\s*no_year:\s*0\s*\}/.test(SRC),
  'snapSkipped tracks duplicate / empty / no_year counters');
assert(/snapSkipped\.empty\+\+/.test(SRC),
  'Empty rows counted + skipped');
assert(/snapSkipped\.no_year\+\+/.test(SRC),
  'Rows outside any year block counted + skipped');
assert(/snapSkipped\.duplicate\+\+/.test(SRC),
  'Duplicate rows counted + skipped');

// ── Per-year reporting ──────────────────────────────────────────────────
console.log('\nPer-year diagnostics:');
assert(/perYearCount\s*=\s*\{\s*'2023':\s*0,\s*'2024':\s*0,\s*'2025':\s*0,\s*'2026':\s*0/.test(SRC),
  'perYearCount initialized for 2023-2026 (so dry-run shows per-year scope)');
assert(/2023=' \+ perYearCount\['2023'\]/.test(SRC) || /2023:'\s*\+\s*perYearCount\['2023'\]/.test(SRC) || /'\s*2023:.*perYearCount\['2023'\]/.test(SRC),
  'Audit trail includes per-year count for 2023');

// ── Audit trail ────────────────────────────────────────────────────────
console.log('\nAudit trail:');
assert(/setNote\(trail\)/.test(SRC),
  'Audit-trail note written via setNote() (visible to Steven in NEW sheet)');
assert(/trail\s*=\s*_MIG3_VERSION_/.test(SRC),
  'Audit trail includes the migration version + timestamp + counts');
assert(/getRange\(['"]A1['"]\)\.setNote/.test(SRC),
  'Audit note goes to A1 of NEW סיכום היסטורי (predictable location)');

// ── Read-only on OLD ───────────────────────────────────────────────────
console.log('\nRead-only on OLD (Steven rule: "Do not delete from OLD"):');
function _noOldMutation(handle) {
  const forbidden = ['setValues', 'setValue', 'setNote', 'setFormula',
                     'deleteRow', 'deleteRows', 'deleteColumn', 'clear',
                     'clearContent', 'insertRow'];
  for (const m of forbidden) {
    const re = new RegExp('\\b' + handle + '\\.' + m + '\\b');
    if (re.test(SRC)) return 'found ' + handle + '.' + m + '()';
  }
  return null;
}
const oldCompBad = _noOldMutation('oldCompany');
assert(oldCompBad === null,
  'OLD מאזן חברה sheet is never mutated (' + (oldCompBad || 'no mutation methods') + ')');
assert(!/oldSS\.(deleteSheet|setName|insertSheet|removeMenu)/.test(SRC),
  'OLD spreadsheet structure never modified');

// ── Append-only on NEW (Steven rule: "Do not overwrite without backup") ─
console.log('\nAppend-only on NEW (Steven rule: "Do not overwrite NEW"):');
assert(/snapTab\.getLastRow\(\) \+ 1/.test(SRC),
  'NEW סיכום היסטורי writes start at getLastRow()+1 (append-only)');
assert(!/snapTab\.(clear|deleteRow|deleteRows)/.test(SRC),
  'Never clears or deletes from NEW סיכום היסטורי');

// ── Logging discipline (Steven needs visibility) ───────────────────────
console.log('\nLogging discipline (so Steven can audit dry-run):');
assert(/=== KESEFLE PHASE 3/.test(SRC),
  'Log header announces Phase 3 mode');
assert(/Raw sample of OLD מאזן חברה A-O/.test(SRC),
  'Logs first 3 RAW source rows for col-layout verification');
assert(/Sample \(first 5 snapshot rows to write\)/.test(SRC),
  'Logs sample of first 5 snapshot rows for review');
assert(/DRY-RUN COMPLETE/.test(SRC),
  'Logs explicit DRY-RUN COMPLETE marker');
assert(/APPLY COMPLETE/.test(SRC),
  'Logs explicit APPLY COMPLETE marker');

// ── Return shape ───────────────────────────────────────────────────────
console.log('\nReturn shape:');
assert(/return \{[\s\S]{0,400}snapshot:\s*\{[\s\S]{0,200}toWrite:[\s\S]{0,200}skipped:/.test(SRC),
  'Returns { snapshot: { toWrite, skipped: {...}, perYear: {...} } }');

// ── Concurrent-run lock ────────────────────────────────────────────────
console.log('\nConcurrent-run lock (APPLY only):');
assert(/LockService\.getScriptLock\(\)/.test(SRC),
  'APPLY mode acquires a script lock (standalone Apps Script — getDocumentLock returns null)');
assert(!/LockService\.getDocumentLock\(\)/.test(SRC),
  'No getDocumentLock — Steven\'s bot is standalone, not container-bound');
assert(/tryLock\(30000\)/.test(SRC),
  'Lock has 30s timeout');
assert(/error:\s*['"]lock_held['"]/.test(SRC),
  'Returns { error: "lock_held" } if another run is active');
assert(/releaseLock\(\)/.test(SRC),
  'Lock released after APPLY completes (no orphan locks)');
const lockGuard = SRC.match(/var _migLock = null;[\s\S]{0,800}if \(applyMode\) \{[\s\S]{0,400}getScriptLock/);
assert(lockGuard !== null,
  'Lock acquisition is gated by `if (applyMode)` — dry-run never locks');

// ── No SHEET_ID env-var override ───────────────────────────────────────
console.log('\nNo silent SHEET_ID override (explicit constants only):');
assert(!/PropertiesService[\s\S]{0,200}_MIG3_(OLD|NEW)_SHEET_ID_/.test(SRC),
  'Sheet IDs never come from Script Properties (always explicit constants)');
assert(!/process\.env\._MIG3_/.test(SRC),
  'No process.env override (defensive)');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
