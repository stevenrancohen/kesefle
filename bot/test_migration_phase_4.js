#!/usr/bin/env node
// bot/test_migration_phase_4.js
// Regression test for bot/MIGRATE_PHASE_4_CATEGORIES_NOTES.gs
// (Phase 4 of the Kesefle migration epic — Steven 2026-05-28).
//
// Same string-match style as bot/test_migration.js — Apps Script can't
// run easily in Node, so we assert source structure. This locks in the
// safety guards Steven cares about so a future edit can't quietly
// break them.
//
// Critical safety guarantees that MUST be present:
//   - DRY_RUN_PHASE4 only reads, never writes
//   - APPLY_PHASE4 refuses without literal "YES I UNDERSTAND" arg
//   - APPLY_PHASE4_NOW zero-arg wrapper for function dropdown
//   - Dedupe before write (idempotent, safe to re-run)
//   - Both OLD sheet ID + NEW sheet ID are correct
//   - Categories rows tagged with Migration_Phase_4_v1
//   - Notes rows tagged with Migration_Phase_4_v1
//   - Audit-trail note written to NEW קטגוריות_מקור + הערות_היסטוריות A1
//   - "Do not delete from OLD" rule honored — script only READS old sheet
//   - "Do not overwrite NEW" rule — script only APPENDS to NEW
//   - Concurrent-run lock (ScriptLock, not DocumentLock)
//   - Sheet IDs as explicit constants, never env-var

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'MIGRATE_PHASE_4_CATEGORIES_NOTES.gs'), 'utf8');
const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_migration_phase_4.js\n');

// ── Sheet IDs + tab constants ────────────────────────────────────────────
console.log('Sheet IDs + tab constants:');
assert(/_MIG4_OLD_SHEET_ID_\s*=\s*['"]1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo['"]/.test(SRC),
  'OLD sheet ID is the canonical OLD (1UKr...)');
assert(/_MIG4_NEW_SHEET_ID_\s*=\s*['"]1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A['"]/.test(SRC),
  'NEW sheet ID is the canonical Kesefle (1rti...)');
assert(/_MIG4_OLD_PERSONAL_TAB_\s*=\s*['"]מאזן אישי['"]/.test(SRC),
  'OLD מאזן אישי tab name constant defined');
assert(/_MIG4_OLD_TX_TAB_\s*=\s*['"]תנועות['"]/.test(SRC),
  'OLD תנועות tab name constant defined (for inline-notes scan)');
assert(/_MIG4_OLD_NOTES_HEB_TAB_\s*=\s*['"]הערות['"]/.test(SRC),
  'OLD הערות (Hebrew notes) tab name constant defined');
assert(/_MIG4_OLD_NOTES_EN_TAB_\s*=\s*['"]Notes['"]/.test(SRC),
  'OLD Notes (English fallback) tab name constant defined');
assert(/_MIG4_NEW_CATEGORIES_TAB_\s*=\s*['"]קטגוריות_מקור['"]/.test(SRC),
  'NEW קטגוריות_מקור tab name constant defined');
assert(/_MIG4_NEW_NOTES_TAB_\s*=\s*['"]הערות_היסטוריות['"]/.test(SRC),
  'NEW הערות_היסטוריות tab name constant defined');

// ── Public entry points ─────────────────────────────────────────────────
console.log('\nPublic entry points:');
assert(/function DRY_RUN_PHASE4\(\)/.test(SRC),
  'DRY_RUN_PHASE4() exists (zero-arg, dropdown-friendly)');
assert(/function APPLY_PHASE4\(confirmation\)/.test(SRC),
  'APPLY_PHASE4(confirmation) exists');
assert(/function APPLY_PHASE4_NOW\(\)/.test(SRC),
  'APPLY_PHASE4_NOW() zero-arg wrapper exists (for function dropdown)');

// ── Safety: APPLY refuses without literal "YES I UNDERSTAND" ───────────
console.log('\nAPPLY safety lock:');
assert(/if \(confirmation !== ['"]YES I UNDERSTAND['"]\)/.test(SRC),
  'APPLY_PHASE4 refuses when confirmation !== "YES I UNDERSTAND"');
assert(/refused:\s*true/.test(SRC),
  'APPLY returns { refused: true } on missing confirmation (not silent fail)');
assert(/APPLY_PHASE4\(['"]YES I UNDERSTAND['"]\)/.test(SRC),
  'APPLY_PHASE4_NOW passes the literal confirmation internally');

// ── DRY_RUN must NOT write ──────────────────────────────────────────────
console.log('\nDRY_RUN read-only guarantee:');
assert(/_mig4_scanAndOptionallyApply_\(false\)/.test(SRC),
  'DRY_RUN_PHASE4 calls scanner with applyMode=false');

// Header writes happen in _mig4_ensureCategoriesTab_ / _mig4_ensureNotesTab_,
// both of which return null in dry-run.
const ensureCatStart = SRC.indexOf('function _mig4_ensureCategoriesTab_');
const ensureCatEnd   = SRC.indexOf('function _mig4_ensureNotesTab_', ensureCatStart);
const ensureNotesStart = SRC.indexOf('function _mig4_ensureNotesTab_');
const ensureNotesEnd   = SRC.indexOf('// Core scanner', ensureNotesStart);
const applyBlockStart = SRC.indexOf('if (applyMode) {');
let setValuesInsideApply = 0;
let setValuesInsideEnsure = 0;
let setValuesOutsideAll  = 0;
let cursor = 0;
while (true) {
  const idx = SRC.indexOf('.setValues(', cursor);
  if (idx < 0) break;
  if ((idx >= ensureCatStart && idx <= ensureCatEnd) ||
      (idx >= ensureNotesStart && idx <= ensureNotesEnd)) setValuesInsideEnsure++;
  else if (idx >= applyBlockStart) setValuesInsideApply++;
  else setValuesOutsideAll++;
  cursor = idx + 1;
}
assert(setValuesOutsideAll === 0,
  'Zero .setValues() calls outside the apply block / ensure-tab helpers (got ' + setValuesOutsideAll + ')');
assert(setValuesInsideApply >= 2,
  '.setValues() called inside apply block for both categories + notes (got ' + setValuesInsideApply + ')');
assert(setValuesInsideEnsure >= 2,
  '.setValues() in ensure-tab helpers for headers (one per tab, only on first APPLY)');

// Ensure both tab-creators are only invoked in apply mode (return null in dry-run)
assert(/_mig4_ensureCategoriesTab_\(newSS, applyMode\)/.test(SRC),
  '_mig4_ensureCategoriesTab_ receives applyMode flag (dry-run never creates tab)');
assert(/_mig4_ensureNotesTab_\(newSS, applyMode\)/.test(SRC),
  '_mig4_ensureNotesTab_ receives applyMode flag (dry-run never creates tab)');
const ensureNullGuards = (SRC.match(/if \(!applyMode\) return null;/g) || []).length;
assert(ensureNullGuards >= 2,
  'Both ensure-tab helpers return null in dry-run (no insertSheet) — count=' + ensureNullGuards);

// ── Dedupe (idempotent) ─────────────────────────────────────────────────
console.log('\nDedupe (idempotent re-runs):');
assert(/function _mig4_catKey_\(sourceRow, label\)/.test(SRC),
  '_mig4_catKey_(sourceRow, label) deterministic key for category rows');
assert(/function _mig4_noteKey_\(sourceTab, sourceRow, noteText\)/.test(SRC),
  '_mig4_noteKey_(sourceTab, sourceRow, noteText) deterministic key for notes');
assert(/existingCatKeys\s*=\s*\{\}/.test(SRC),
  'Build existingCatKeys map from NEW קטגוריות_מקור');
assert(/existingNoteKeys\s*=\s*\{\}/.test(SRC),
  'Build existingNoteKeys map from NEW הערות_היסטוריות');
assert(/if \(existingCatKeys\[catKey\]\)/.test(SRC),
  'Skip when existingCatKeys[catKey] already present (dedupe)');
assert(/if \(existingNoteKeys\[key\]\)/.test(SRC),
  'Skip when existingNoteKeys[key] already present (dedupe)');
assert(/existingCatKeys\[catKey\]\s*=\s*true/.test(SRC),
  'Mark in-flight category key after deciding to capture (intra-batch dedupe)');
assert(/existingNoteKeys\[key\]\s*=\s*true/.test(SRC),
  'Mark in-flight note key after deciding to capture (intra-batch dedupe)');

// ── Notes harvest priority ─────────────────────────────────────────────
console.log('\nNotes harvest priority:');
assert(/function _harvestNoteTab_\(tab, tabName\)/.test(SRC),
  '_harvestNoteTab_ helper exists (shared logic for Heb/En dedicated tabs)');
assert(/_harvestNoteTab_\(oldNotesHeb, _MIG4_OLD_NOTES_HEB_TAB_\)/.test(SRC),
  'Hebrew הערות tab harvested first');
assert(/_harvestNoteTab_\(oldNotesEn, _MIG4_OLD_NOTES_EN_TAB_\)/.test(SRC),
  'English Notes tab harvested as fallback');
assert(/oldTx\.getRange\(2, 6, txLastRow - 1, 1\)/.test(SRC),
  'Inline cell-notes harvested from תנועות col F (description col, per ExpenseBot)');
assert(/getNotes\(\)/.test(SRC),
  'Uses getNotes() (not just getValues) so cell-notes are read');
assert(/notesSkipped\.no_cell_notes\+\+/.test(SRC),
  'Empty cell-notes are counted + skipped (not silently dropped)');

// ── Migration tag (so rollback can filter) ─────────────────────────────
console.log('\nMigration tag (for rollback):');
assert(/_MIG4_VERSION_\s*=\s*['"]Migration_Phase_4_v1['"]/.test(SRC),
  'Migration version tag is "Migration_Phase_4_v1"');
// Tag appears in both category rows and note rows
assert(/concat\(\[totalVal, _MIG4_VERSION_, capturedAt\]\)/.test(SRC),
  'Category row appends _MIG4_VERSION_ + capturedAt');
assert(/_MIG4_VERSION_, capturedAt\]\);/.test(SRC),
  'Note rows include _MIG4_VERSION_ + capturedAt (so rollback can filter)');

// ── Empty/missing-tab protection ───────────────────────────────────────
console.log('\nEmpty/missing-tab protection:');
assert(/catSkipped\s*=\s*\{\s*duplicate:\s*0,\s*empty:\s*0,\s*missing_tab:\s*0/.test(SRC),
  'catSkipped tracks duplicate / empty / missing_tab counters');
assert(/notesSkipped\s*=\s*\{\s*duplicate:\s*0,\s*empty:\s*0,\s*no_dedicated_tab:\s*0,\s*no_cell_notes:\s*0/.test(SRC),
  'notesSkipped tracks duplicate / empty / no_dedicated_tab / no_cell_notes counters');
assert(/catSkipped\.missing_tab\+\+/.test(SRC),
  'Categories step gracefully skips if OLD מאזן אישי tab is missing');
assert(/notesSkipped\.no_dedicated_tab\+\+/.test(SRC),
  'Notes step gracefully skips if both dedicated notes tabs are missing');

// ── Audit trail ────────────────────────────────────────────────────────
console.log('\nAudit trail:');
assert(/setNote\(trail\)/.test(SRC),
  'Audit-trail note written via setNote() (visible to Steven in NEW sheet)');
assert(/trail\s*=\s*_MIG4_VERSION_/.test(SRC),
  'Audit trail includes the migration version + timestamp + counts');
assert(/catTab\.getRange\(['"]A1['"]\)\.setNote/.test(SRC),
  'Audit note goes to A1 of NEW קטגוריות_מקור (predictable location)');
assert(/notesTab\.getRange\(['"]A1['"]\)\.setNote/.test(SRC),
  'Audit note goes to A1 of NEW הערות_היסטוריות (predictable location)');

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
const oldPersonalBad = _noOldMutation('oldPersonal');
assert(oldPersonalBad === null,
  'OLD מאזן אישי sheet is never mutated (' + (oldPersonalBad || 'no mutation methods') + ')');
const oldTxBad = _noOldMutation('oldTx');
assert(oldTxBad === null,
  'OLD תנועות sheet is never mutated (' + (oldTxBad || 'no mutation methods') + ')');
assert(!/oldSS\.(deleteSheet|setName|insertSheet|removeMenu)/.test(SRC),
  'OLD spreadsheet structure never modified');

// ── Append-only on NEW (Steven rule: "Do not overwrite without backup") ─
console.log('\nAppend-only on NEW (Steven rule: "Do not overwrite NEW"):');
assert(/catTab\.getLastRow\(\) \+ 1/.test(SRC),
  'NEW קטגוריות_מקור writes start at getLastRow()+1 (append-only)');
assert(/notesTab\.getLastRow\(\) \+ 1/.test(SRC),
  'NEW הערות_היסטוריות writes start at getLastRow()+1 (append-only)');
assert(!/catTab\.(clear|deleteRow|deleteRows)/.test(SRC),
  'Never clears or deletes from NEW קטגוריות_מקור');
assert(!/notesTab\.(clear|deleteRow|deleteRows)/.test(SRC),
  'Never clears or deletes from NEW הערות_היסטוריות');

// ── Logging discipline (Steven needs visibility) ───────────────────────
console.log('\nLogging discipline (so Steven can audit dry-run):');
assert(/=== KESEFLE PHASE 4/.test(SRC),
  'Log header announces Phase 4 mode');
assert(/Raw sample of OLD מאזן אישי A-N/.test(SRC),
  'Logs first 3 RAW source rows for col-layout verification');
assert(/Sample \(first 5 category rows to write\)/.test(SRC),
  'Logs sample of first 5 category rows for review');
assert(/Sample \(first 3 notes to write\)/.test(SRC),
  'Logs sample of first 3 notes for review');
assert(/DRY-RUN COMPLETE/.test(SRC),
  'Logs explicit DRY-RUN COMPLETE marker');
assert(/APPLY COMPLETE/.test(SRC),
  'Logs explicit APPLY COMPLETE marker');

// ── Return shape ───────────────────────────────────────────────────────
console.log('\nReturn shape:');
assert(/return \{[\s\S]{0,400}categories:\s*\{[\s\S]{0,200}toWrite:[\s\S]{0,200}skipped:/.test(SRC),
  'Returns { categories: { toWrite, skipped } }');
assert(/notes:\s*\{[\s\S]{0,400}toWrite:[\s\S]{0,200}skipped:/.test(SRC),
  'Returns { notes: { toWrite, skipped, hebrew, english, inline } }');

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
assert(!/PropertiesService[\s\S]{0,200}_MIG4_(OLD|NEW)_SHEET_ID_/.test(SRC),
  'Sheet IDs never come from Script Properties (always explicit constants)');
assert(!/process\.env\._MIG4_/.test(SRC),
  'No process.env override (defensive)');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
