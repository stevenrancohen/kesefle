#!/usr/bin/env node
// bot/test_migration.js
// Regression test for bot/MIGRATE_OLD_TO_KESEFLE.gs (Phase 2 of the
// Kesefle migration epic — Steven 2026-05-28).
//
// Verifies the migration script has the right safety guards wired in.
// Same string-match style as test_pending_state_hijack.js / test_phase_a_v2_uncertainty.js
// (Apps Script isn't easy to run locally, so we assert source structure).
//
// Steven's critical safety guarantees that MUST be present:
//   - DRY_RUN_MIGRATE_RAW only reads, never writes
//   - APPLY_MIGRATE_RAW refuses without literal "YES I UNDERSTAND" arg
//   - APPLY_MIGRATE_RAW_NOW zero-arg wrapper for function dropdown
//   - Dedupe before write (idempotent, safe to re-run)
//   - Both OLD sheet ID + NEW sheet ID are correct
//   - Source rows tagged with Migration_Phase_2_v1 in col J
//   - Audit-trail note written to NEW תנועות A1
//   - Empty/invalid rows skipped (never writes garbage)
//   - Headers detected and skipped in מאזן חברה order scan
//   - "Do not delete from OLD" rule honored — script only READS old sheet
//   - "Do not overwrite NEW without backup" rule — script only APPENDS to NEW

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'MIGRATE_OLD_TO_KESEFLE.gs'), 'utf8');
const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_migration.js\n');

// ── Sheet IDs ───────────────────────────────────────────────────────────
console.log('Sheet IDs:');
assert(/_MIG_OLD_SHEET_ID_\s*=\s*['"]1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo['"]/.test(SRC),
  'OLD sheet ID is the canonical OLD (1UKr...)');
assert(/_MIG_NEW_SHEET_ID_\s*=\s*['"]1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A['"]/.test(SRC),
  'NEW sheet ID is the canonical Kesefle (1rti...)');
assert(/_MIG_TX_TAB_\s*=\s*['"]תנועות['"]/.test(SRC),
  'תנועות tab name constant defined');
assert(/_MIG_ORDERS_TAB_\s*=\s*['"]הזמנות['"]/.test(SRC),
  'הזמנות tab name constant defined');
assert(/_MIG_COMPANY_TAB_\s*=\s*['"]מאזן חברה['"]/.test(SRC),
  'מאזן חברה tab name constant defined');

// ── Public entry points ─────────────────────────────────────────────────
console.log('\nPublic entry points:');
assert(/function DRY_RUN_MIGRATE_RAW\(\)/.test(SRC),
  'DRY_RUN_MIGRATE_RAW() exists (zero-arg, dropdown-friendly)');
assert(/function APPLY_MIGRATE_RAW\(confirmation\)/.test(SRC),
  'APPLY_MIGRATE_RAW(confirmation) exists');
assert(/function APPLY_MIGRATE_RAW_NOW\(\)/.test(SRC),
  'APPLY_MIGRATE_RAW_NOW() zero-arg wrapper exists (for function dropdown)');

// ── Safety: APPLY refuses without literal "YES I UNDERSTAND" ───────────
console.log('\nAPPLY safety lock:');
assert(/if \(confirmation !== ['"]YES I UNDERSTAND['"]\)/.test(SRC),
  'APPLY_MIGRATE_RAW refuses when confirmation !== "YES I UNDERSTAND"');
assert(/refused:\s*true/.test(SRC),
  'APPLY returns { refused: true } on missing confirmation (not silent fail)');
assert(/APPLY_MIGRATE_RAW\(['"]YES I UNDERSTAND['"]\)/.test(SRC),
  'APPLY_MIGRATE_RAW_NOW passes the literal confirmation internally');

// ── DRY_RUN must NOT write ──────────────────────────────────────────────
console.log('\nDRY_RUN read-only guarantee:');
// DRY_RUN calls scanner with false (apply=false).
assert(/_mig_scanAndOptionallyApply_\(false\)/.test(SRC),
  'DRY_RUN_MIGRATE_RAW calls scanner with applyMode=false');
// Scanner guards all writes inside if (applyMode) {}
assert(/if \(applyMode\) \{[\s\S]{0,5000}setValues/.test(SRC),
  'All setValues() calls are inside if (applyMode) block (no writes in dry-run)');
// No setValues outside the applyMode block
const setValuesBlocks = SRC.match(/\.setValues\(/g) || [];
const applyBlockStart = SRC.indexOf('if (applyMode) {');
const applyBlockEnd = SRC.indexOf('=== APPLY COMPLETE ===');
let setValuesInsideApply = 0;
let setValuesOutsideApply = 0;
let cursor = 0;
while (true) {
  const idx = SRC.indexOf('.setValues(', cursor);
  if (idx < 0) break;
  if (idx >= applyBlockStart && idx <= applyBlockEnd) setValuesInsideApply++;
  else setValuesOutsideApply++;
  cursor = idx + 1;
}
assert(setValuesOutsideApply === 0,
  'Zero .setValues() calls outside the apply block (got ' + setValuesOutsideApply + ')');
assert(setValuesInsideApply >= 2,
  '.setValues() called inside apply block for both תנועות + הזמנות (got ' + setValuesInsideApply + ')');

// ── Dedupe (idempotent) ─────────────────────────────────────────────────
console.log('\nDedupe (idempotent re-runs):');
assert(/function _mig_txKey_\(row\)/.test(SRC),
  '_mig_txKey_(row) deterministic key for תנועות rows');
assert(/function _mig_orderKey_\(row\)/.test(SRC),
  '_mig_orderKey_(row) deterministic key for orders');
assert(/existingTxKeys\s*=\s*\{\}/.test(SRC),
  'Build existingTxKeys map from NEW תנועות');
assert(/existingOrderKeys\s*=\s*\{\}/.test(SRC),
  'Build existingOrderKeys map from NEW הזמנות');
assert(/if \(existingTxKeys\[key\]\)/.test(SRC),
  'Skip when existingTxKeys[key] already present (dedupe)');
assert(/if \(existingOrderKeys\[orderKey\]\)/.test(SRC),
  'Skip when existingOrderKeys[orderKey] already present (dedupe)');
// After deciding to migrate, mark key so two OLD rows that hash same don't both write
assert(/existingTxKeys\[key\]\s*=\s*true/.test(SRC),
  'Mark in-flight tx key after deciding to migrate (intra-batch dedupe)');
assert(/existingOrderKeys\[orderKey\]\s*=\s*true/.test(SRC),
  'Mark in-flight order key after deciding to migrate (intra-batch dedupe)');

// ── Migration tag (so rollback can filter) ─────────────────────────────
console.log('\nMigration tag (for rollback):');
assert(/_MIG_VERSION_\s*=\s*['"]Migration_Phase_2_v1['"]/.test(SRC),
  'Migration version tag is "Migration_Phase_2_v1"');
// Tag goes into col J of the order row
const orderRowBlock = SRC.match(/return \[[\s\S]{0,1200}_MIG_VERSION_/);
assert(orderRowBlock && /_MIG_VERSION_,\s*\/\/ J/.test(orderRowBlock[0] + SRC.slice(SRC.indexOf('_MIG_VERSION_,'), SRC.indexOf('_MIG_VERSION_,') + 200)),
  'Order row col J contains _MIG_VERSION_ (so rollback can filter)');

// ── Empty/invalid row protection ───────────────────────────────────────
console.log('\nEmpty/invalid row protection:');
assert(/if \(!row\[0\] && !row\[2\] && !row\[5\]\)/.test(SRC),
  'Skip empty rows (no date, amount, or description)');
assert(/if \(!isFinite\(amt\) \|\| amt === 0\)/.test(SRC),
  'Skip rows with non-finite or zero amount');
assert(/header_row\+\+/.test(SRC),
  'Detect + skip header-like rows in מאזן חברה');
assert(/no_amount\+\+/.test(SRC),
  'Track no_amount skip count for orders');

// ── Audit trail ────────────────────────────────────────────────────────
console.log('\nAudit trail:');
assert(/setNote\(trail\)/.test(SRC),
  'Audit-trail note written via setNote() (visible to Steven in NEW sheet)');
assert(/trail\s*=\s*_MIG_VERSION_/.test(SRC),
  'Audit trail includes the migration version + timestamp + counts');
assert(/getRange\(['"]A1['"]\)\.setNote/.test(SRC),
  'Audit note goes to A1 of NEW תנועות (predictable location)');

// ── Read-only on OLD ───────────────────────────────────────────────────
console.log('\nRead-only on OLD (Steven rule: "Do not delete from OLD"):');
const oldSheetReads = (SRC.match(/oldSS|oldTxSheet|oldCompany/g) || []).length;
assert(oldSheetReads > 0, 'OLD sheet handle exists');
// No mutation methods on OLD — check each forbidden suffix individually
// (avoid greedy [\s\S]+ that crosses multiple statements)
function _noOldMutation(handle) {
  const forbidden = ['setValues', 'setValue', 'setNote', 'setFormula',
                     'deleteRow', 'deleteRows', 'deleteColumn', 'clear',
                     'clearContent', 'insertRow'];
  for (const m of forbidden) {
    const re = new RegExp(handle + '\\.' + m + '\\b');
    if (re.test(SRC)) return 'found ' + handle + '.' + m + '()';
  }
  return null;
}
const oldTxBad = _noOldMutation('oldTxSheet');
assert(oldTxBad === null,
  'OLD תנועות sheet is never mutated (' + (oldTxBad || 'no mutation methods') + ')');
const oldCompBad = _noOldMutation('oldCompany');
assert(oldCompBad === null,
  'OLD מאזן חברה sheet is never mutated (' + (oldCompBad || 'no mutation methods') + ')');
assert(!/oldSS\.(deleteSheet|setName|removeMenu)/.test(SRC),
  'OLD spreadsheet structure never modified');

// ── Append-only on NEW (Steven rule: "Do not overwrite without backup") ─
console.log('\nAppend-only on NEW (Steven rule: "Do not overwrite NEW"):');
// We use getLastRow() + 1 as start, never overwrite row 1 (headers)
assert(/newTxSheet\.getLastRow\(\) \+ 1/.test(SRC),
  'NEW תנועות writes start at getLastRow()+1 (append-only)');
assert(/newOrdersSheet\.getLastRow\(\) \+ 1/.test(SRC),
  'NEW הזמנות writes start at getLastRow()+1 (append-only)');
// No clear/delete on NEW
assert(!/newTxSheet\.(clear|deleteRow|deleteRows)/.test(SRC),
  'Never clears or deletes from NEW תנועות');
assert(!/newOrdersSheet\.(clear|deleteRow|deleteRows)/.test(SRC),
  'Never clears or deletes from NEW הזמנות');

// ── Logging discipline (Steven needs visibility) ───────────────────────
console.log('\nLogging discipline (so Steven can audit dry-run):');
assert(/=== KESEFLE MIGRATION/.test(SRC),
  'Log header announces migration mode');
assert(/Sample \(first 5 to migrate\)/.test(SRC),
  'Logs sample of first 5 transactions for review');
assert(/Sample order \(first\)/.test(SRC),
  'Logs sample of first order for review');
assert(/DRY-RUN COMPLETE/.test(SRC),
  'Logs explicit DRY-RUN COMPLETE marker');
assert(/APPLY COMPLETE/.test(SRC),
  'Logs explicit APPLY COMPLETE marker');

// ── Return shape (so caller can verify) ────────────────────────────────
console.log('\nReturn shape:');
assert(/return \{[\s\S]{0,300}transactions:\s*\{[\s\S]{0,200}toMigrate:[\s\S]{0,200}skipped:/.test(SRC),
  'Returns { transactions: { toMigrate, skipped: {...} } }');
assert(/orders:\s*\{[\s\S]{0,200}toMigrate:[\s\S]{0,200}skipped:/.test(SRC),
  'Returns { orders: { toMigrate, skipped: {...} } }');

// ── No SHEET_ID env-var override (Steven rule: explicit only) ──────────
console.log('\nNo silent SHEET_ID override (explicit constants only):');
assert(!/PropertiesService[\s\S]{0,200}_MIG_(OLD|NEW)_SHEET_ID_/.test(SRC),
  'Sheet IDs never come from Script Properties (always explicit constants)');
assert(!/process\.env\._MIG_/.test(SRC),
  'No process.env override (Apps Script, but defensive)');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
