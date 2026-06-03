#!/usr/bin/env node
// bot/test_tool_destructive_gating.js
// Destructive-function-audit follow-up (Monday: "Destructive-function audit
// findings -- 3 HIGH (dormant), 8 MEDIUM (partial gating)").
//
// The standalone Apps Script TOOL files SMART_REMAP_DASHBOARD,
// WIRE_YEAR_SELECTOR and the personal-dashboard repairs each rewrite cells in
// the customer's company / personal dashboard. The audit found they had only
// PARTIAL gating (lock + backup, or no guards at all) and no confirmation gate
// -- so a stray dropdown-run in the Apps Script editor could overwrite data.
//
// This adds the missing CONFIRM_* gate + (where absent) LockService + backup +
// a ROLLBACK, matching the kesefle-financial-data-integrity-guard pattern that
// the newer TOOL files (FPT_/WEN_/AYD_/FMC_/...) already follow.
//
// Apps Script can't run locally, so -- same style as
// bot/test_destructive_delete_confirm.js -- we assert the structural guards are
// present in the source text.

const fs = require('fs');
const path = require('path');

const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}
function read(rel) {
  return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

console.log('\nbot/test_tool_destructive_gating.js\n');

// ── SMART_REMAP_DASHBOARD ────────────────────────────────────────────────
console.log('SHEET_DASHBOARD_SMART_REMAP.gs (was: lock + backup, NO gate):');
{
  const SRC = read('SHEET_DASHBOARD_SMART_REMAP.gs');
  assert(/_SR_CONFIRM_PROP_\s*=\s*'CONFIRM_SMART_REMAP_DASHBOARD'/.test(SRC),
    'declares CONFIRM_SMART_REMAP_DASHBOARD gate property');
  assert(/_SR_CONFIRM_VAL_\s*=\s*'YES I UNDERSTAND'/.test(SRC),
    'gate value is the exact "YES I UNDERSTAND" token');
  // The gate check must live inside SMART_REMAP_DASHBOARD (the APPLY fn).
  const apply = (SRC.match(/function SMART_REMAP_DASHBOARD\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  assert(/getProperty\(_SR_CONFIRM_PROP_\)\s*!==\s*_SR_CONFIRM_VAL_/.test(apply),
    'SMART_REMAP_DASHBOARD refuses unless the gate property is set');
  assert(/return 'refused-no-confirm'/.test(apply),
    'SMART_REMAP_DASHBOARD returns refused-no-confirm when ungated');
  // Gate must be BEFORE any write (the first setFormulas). Position check.
  const gatePos = SRC.indexOf("getProperty(_SR_CONFIRM_PROP_)");
  const writePos = SRC.indexOf('.setFormulas([row])');
  assert(gatePos > 0 && writePos > 0 && gatePos < writePos,
    'gate check precedes the setFormulas write');
  assert(/LockService\.getScriptLock\(\)/.test(apply),
    'SMART_REMAP_DASHBOARD still takes a script lock (pre-existing guard kept)');
  assert(/function ROLLBACK_SMART_REMAP_DASHBOARD\(\)/.test(SRC),
    'ROLLBACK_SMART_REMAP_DASHBOARD exists (undo)');
  assert(/_BAK_remap_/.test(SRC.match(/function ROLLBACK_SMART_REMAP_DASHBOARD[\s\S]*?\n\}/)[0]),
    'rollback restores from a _BAK_remap_* backup tab');
}

// ── WIRE_YEAR_SELECTOR ───────────────────────────────────────────────────
console.log('\nSHEET_YEAR_SELECTOR_WIRE.gs (was: lock + backup, NO gate):');
{
  const SRC = read('SHEET_YEAR_SELECTOR_WIRE.gs');
  assert(/_YS_CONFIRM_PROP_\s*=\s*'CONFIRM_WIRE_YEAR_SELECTOR'/.test(SRC),
    'declares CONFIRM_WIRE_YEAR_SELECTOR gate property');
  assert(/_YS_CONFIRM_VAL_\s*=\s*'YES I UNDERSTAND'/.test(SRC),
    'gate value is the exact "YES I UNDERSTAND" token');
  const apply = (SRC.match(/function WIRE_YEAR_SELECTOR\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  assert(/getProperty\(_YS_CONFIRM_PROP_\)\s*!==\s*_YS_CONFIRM_VAL_/.test(apply),
    'WIRE_YEAR_SELECTOR refuses unless the gate property is set');
  assert(/return 'refused-no-confirm'/.test(apply),
    'WIRE_YEAR_SELECTOR returns refused-no-confirm when ungated');
  const gatePos = SRC.indexOf("getProperty(_YS_CONFIRM_PROP_)");
  const writePos = SRC.indexOf('range.setFormulas([newFormulas])');
  assert(gatePos > 0 && writePos > 0 && gatePos < writePos,
    'gate check precedes the setFormulas write');
  assert(/LockService\.getScriptLock\(\)/.test(apply),
    'WIRE_YEAR_SELECTOR still takes a script lock (pre-existing guard kept)');
  assert(/function ROLLBACK_YEAR_SELECTOR_WIRE\(\)/.test(SRC),
    'ROLLBACK_YEAR_SELECTOR_WIRE exists (undo)');
  assert(/_BAK_yearwire_/.test(SRC.match(/function ROLLBACK_YEAR_SELECTOR_WIRE[\s\S]*?\n\}/)[0]),
    'rollback restores from a _BAK_yearwire_* backup tab');
}

// ── personal_sheet_fix.gs: fixPersonalDashboardFormulas + APPLY_RESTORE_2026 ─
console.log('\npersonal_sheet_fix.gs (fixPersonalDashboardFormulas: was NO gate/lock/backup):');
{
  const SRC = read('personal_sheet_fix.gs');
  assert(/_PSF_PERSONAL_CONFIRM_PROP_\s*=\s*'CONFIRM_FIX_PERSONAL_DASHBOARD'/.test(SRC),
    'declares CONFIRM_FIX_PERSONAL_DASHBOARD gate property');
  const fn = (SRC.match(/function fixPersonalDashboardFormulas\(\)\s*\{[\s\S]*?\n\}\n/) || [''])[0];
  assert(/getProperty\(_PSF_PERSONAL_CONFIRM_PROP_\)\s*!==\s*_PSF_PERSONAL_CONFIRM_VAL_/.test(fn),
    'fixPersonalDashboardFormulas refuses unless gated');
  assert(/LockService\.getDocumentLock\(\)/.test(fn),
    'fixPersonalDashboardFormulas now takes a document lock');
  assert(/_backupPersonalDashboard_\(ss\)/.test(fn),
    'fixPersonalDashboardFormulas backs up the personal tab before writing');
  // Gate + backup must precede the setFormulas write -- measured WITHIN the
  // function body (so we don't pick up the helper definition elsewhere).
  const gatePos = fn.indexOf('getProperty(_PSF_PERSONAL_CONFIRM_PROP_)');
  const bkPos = fn.indexOf('_backupPersonalDashboard_(ss)');
  const writePos = fn.indexOf("sheet.getRange('C' + rowNum");
  assert(gatePos >= 0 && bkPos > gatePos && writePos > bkPos,
    'order is gate -> backup -> write');
  assert(/function _backupPersonalDashboard_\(ss\)/.test(SRC),
    '_backupPersonalDashboard_ helper exists (snapshots maazan ishi)');
  assert(/function ROLLBACK_FIX_PERSONAL_DASHBOARD\(\)/.test(SRC),
    'ROLLBACK_FIX_PERSONAL_DASHBOARD exists (undo)');

  console.log('\npersonal_sheet_fix.gs (APPLY_RESTORE_2026: was backup-only, NO gate/lock):');
  assert(/_PSF_RESTORE_CONFIRM_PROP_\s*=\s*'CONFIRM_RESTORE_2026'/.test(SRC),
    'declares CONFIRM_RESTORE_2026 gate property');
  const restore = (SRC.match(/function APPLY_RESTORE_2026\(\)\s*\{[\s\S]*?\n\}\n/) || [''])[0];
  assert(/getProperty\(_PSF_RESTORE_CONFIRM_PROP_\)\s*!==\s*_PSF_RESTORE_CONFIRM_VAL_/.test(restore),
    'APPLY_RESTORE_2026 refuses unless gated');
  assert(/LockService\.getDocumentLock\(\)/.test(restore),
    'APPLY_RESTORE_2026 now takes a document lock');
  assert(/_backupCompanyDashboard_\(ss\)/.test(restore),
    'APPLY_RESTORE_2026 still backs up the company dashboard (pre-existing guard kept)');

  // FIX_EVERYTHING still calls both halves (must not silently drop a half).
  console.log('\nFIX_EVERYTHING wiring:');
  const fe = (SRC.match(/function FIX_EVERYTHING\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  assert(/APPLY_RESTORE_2026\(\)/.test(fe) && /fixPersonalDashboardFormulas\(\)/.test(fe),
    'FIX_EVERYTHING still invokes both gated halves');
  assert(/refused-no-confirm/.test(fe),
    'FIX_EVERYTHING surfaces the refused-no-confirm state to the user');
}

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
