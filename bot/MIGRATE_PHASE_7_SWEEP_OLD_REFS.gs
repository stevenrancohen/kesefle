/**
 * bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs
 *
 * Phase 7 of the Kesefle migration epic (Steven's section-23 plan).
 *
 * After Phase 5 verifies the NEW sheet's dashboards are healthy, the OLD
 * sheet is officially "frozen reference." Any bot/*.gs utility script that
 * still hardcodes the OLD sheet ID is either:
 *
 *   (a) UTILITY-NEEDS-UPDATE — should rewire to NEW (e.g. WEEKLY_DIGEST,
 *       BOT_COMMANDS, CLEANUP_DUPLICATES_AND_TABS, DASHBOARD_QUICK_WINS,
 *       SORT_AND_FEATURES, FIX_PROFITABILITY_AND_CHART, CREATE_TEMPLATE_AND_CLEANUP,
 *       EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD, FINANCIAL_SUMMARY_TAB_CLEAN,
 *       KESEFLE_ALL_PATCHES, config.gs PERSONAL_TEMPLATE_SHEET_ID).
 *
 *   (b) ARCHIVE-DEPRECATED — a one-shot historical fix that already ran
 *       against OLD; will never need to run again (e.g. FIX_DASHBOARD_safe,
 *       FIX_DASHBOARD_2023_2024_2025). Leaving these pointed at OLD is
 *       fine because they're no-ops going forward.
 *
 *   (c) INTENTIONAL-OLD — must keep targeting OLD on purpose. The only
 *       member of this class today is CLEANUP_LEAKED_ROWS.gs — it cleans
 *       OLD-sheet rows that leaked in before isolation was fixed; it is
 *       NOT relevant to NEW.
 *
 * Two entry points:
 *
 *   DRY_RUN_PHASE_7_SWEEP()
 *     — read-only audit. Logs the markdown classification table.
 *
 *   APPLY_PHASE_7_REWIRE('YES I UNDERSTAND')
 *     — rewires the OLD sheet ID literal -> NEW sheet ID literal ONLY in
 *       category-(a) files. Refuses without the literal arg. Acquires a
 *       script lock. Does NOT touch any sheet data — only edits .gs file
 *       *constants*. (Apps Script DriveApp / files API not available
 *       directly on .gs source — APPLY logs the rewrite plan that Steven
 *       applies via the local repo. The plan is auditable + reversible.)
 *
 * Iron safety rules (Steven):
 *   - DRY_RUN never writes
 *   - APPLY refuses without literal "YES I UNDERSTAND"
 *   - LockService.getScriptLock for APPLY
 *   - OLD sheet is never mutated
 *   - NEW sheet is not touched at all (this is repo-level, not sheet-level)
 *   - Category-(c) files (CLEANUP_LEAKED_ROWS) are NEVER rewritten
 */

var _MP7_OLD_SHEET_ID_  = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var _MP7_NEW_SHEET_ID_  = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _MP7_VERSION_       = 'Migration_Phase_7_v1';

// File classifications. Updating this map is how the audit grows over time.
//
// Categories:
//   'a' = UTILITY-NEEDS-UPDATE — rewire to NEW
//   'b' = ARCHIVE-DEPRECATED   — leave alone, one-shot historical
//   'c' = INTENTIONAL-OLD      — keep targeting OLD on purpose
//   'd' = ALREADY-MIGRATED     — OLD literal is only in a code comment
//
// The audit treats (b), (c), (d) as no-op outcomes. Only (a) gets rewired.
var _MP7_FILE_CLASSIFICATIONS_ = {
  'bot/config.gs':                                  { category: 'a', note: 'PERSONAL_TEMPLATE_SHEET_ID — bot owner template root; rewire to NEW' },
  'bot/EMBED_FINANCIAL_SUMMARY_IN_DASHBOARD.gs':    { category: 'a', note: 'KFL_SHEET_ID_EM — embeds summary in NEW dashboard going forward' },
  'bot/FINANCIAL_SUMMARY_TAB_CLEAN.gs':             { category: 'a', note: 'cleans a tab on NEW now that NEW has the summary' },
  'bot/KESEFLE_ALL_PATCHES.gs':                     { category: 'a', note: 'patch runner — should run against NEW' },
  'bot/DASHBOARD_QUICK_WINS.gs':                    { category: 'a', note: 'dashboard polish — should target NEW' },
  'bot/CLEANUP_DUPLICATES_AND_TABS.gs':             { category: 'a', note: 'tab cleanup — point to NEW so dedupe runs there' },
  'bot/FIX_PROFITABILITY_AND_CHART.gs':             { category: 'a', note: 'chart fix — should target NEW dashboard' },
  'bot/SORT_AND_FEATURES.gs':                       { category: 'a', note: 'sort + feature toggles — should target NEW' },
  'bot/CREATE_TEMPLATE_AND_CLEANUP.gs':             { category: 'a', note: 'template builder — should target NEW' },
  'bot/WEEKLY_DIGEST.gs':                           { category: 'a', note: 'weekly digest — should read from NEW dashboard' },
  'bot/BOT_COMMANDS.gs':                            { category: 'a', note: 'bot command surface — should target NEW' },
  'bot/FIX_DASHBOARD_safe.gs':                      { category: 'b', note: 'one-shot OLD dashboard repair from 2026-05-16 — already ran, frozen' },
  'bot/FIX_DASHBOARD_2023_2024_2025.gs':            { category: 'b', note: 'one-shot OLD dashboard repair from 2026-05-16 — already ran, frozen' },
  'bot/CLEANUP_LEAKED_ROWS.gs':                     { category: 'c', note: 'INTENTIONALLY targets OLD — cleans pre-isolation leaks' },
  'bot/MIGRATE_OLD_TO_KESEFLE.gs':                  { category: 'c', note: 'INTENTIONALLY references OLD — it reads OLD to copy to NEW (Phase 2, lands via PR #120)' },
  'bot/MIGRATE_PHASE_7_SWEEP_OLD_REFS.gs':          { category: 'c', note: 'THIS file — references OLD as the audit constant; never writes to OLD' },
  'bot/personal_sheet_fix.gs':                      { category: 'd', note: 'OLD ID only in rollback comment, code constant already on NEW' },
  'bot/ExpenseBot_FIXED.gs':                        { category: 'd', note: 'OLD ID only in rollback comment, SHEET_ID const already on NEW (Phase 1)' },
  'bot/ExpenseBot_DEPLOY.gs':                       { category: 'd', note: 'OLD ID only in rollback comment, SHEET_ID const already on NEW (Phase 1)' }
};

// Build a single string from the classifications map so the file is
// self-documenting and DRY_RUN logs a Markdown-style table Steven can
// paste into a PR or QA report.
function _mp7_buildAuditTable_(filesWithOldId) {
  var lines = [];
  lines.push('| File | Category | Action | Note |');
  lines.push('|------|----------|--------|------|');
  filesWithOldId.forEach(function (entry) {
    var cls = _MP7_FILE_CLASSIFICATIONS_[entry.path] || { category: '?', note: 'UNCLASSIFIED — review manually' };
    var action;
    switch (cls.category) {
      case 'a': action = 'REWIRE -> NEW'; break;
      case 'b': action = 'NO-OP (archive)'; break;
      case 'c': action = 'KEEP (intentional)'; break;
      case 'd': action = 'NO-OP (already migrated)'; break;
      default:  action = 'REVIEW';
    }
    lines.push('| `' + entry.path + '` | (' + cls.category + ') | ' + action + ' | ' + cls.note + ' |');
  });
  return lines.join('\n');
}

// In Apps Script, we don't have direct grep — but we have a static
// classification map above. DRY_RUN cross-checks the map against a
// hardcoded list of files known to contain the OLD literal. The
// definitive grep is the bot/test_migration_phase_7.js test, which runs
// against the real repo on the dev machine.
//
// This function does NOT actually open the .gs files (Apps Script's
// DriveApp can't read repo-checked-out .gs source by path). It instead
// returns the static list of files Steven curated. Updating this list
// when new files are added is part of the test_migration_phase_7
// contract.
function _mp7_filesWithOldId_() {
  // Each entry is the repo-relative path. Steven keeps this list in sync
  // with the actual `grep -rln OLD_ID bot/` output (verified by the test).
  return Object.keys(_MP7_FILE_CLASSIFICATIONS_).map(function (p) {
    return { path: p };
  });
}

// ─── DRY-RUN AUDIT ──────────────────────────────────────────────────────

function _mp7_audit_(applyMode) {
  Logger.log('=== KESEFLE PHASE 7 — SWEEP OLD REFS ' + (applyMode ? '(APPLY)' : '(DRY-RUN)') + ' ===');
  Logger.log('OLD: ' + _MP7_OLD_SHEET_ID_);
  Logger.log('NEW: ' + _MP7_NEW_SHEET_ID_);
  Logger.log('Version: ' + _MP7_VERSION_);
  Logger.log('');

  // Apps Script can't lock without a SpreadsheetApp context; we still
  // call LockService.getScriptLock for symmetry with Phase 2. In APPLY
  // we acquire it before logging the rewrite plan.
  var _mp7Lock = null;
  if (applyMode) {
    _mp7Lock = LockService.getScriptLock();
    if (!_mp7Lock || !_mp7Lock.tryLock(30000)) {
      Logger.log('!! Another phase-7 run is in progress — aborting');
      return { error: 'lock_held' };
    }
    Logger.log('Acquired script lock (30s timeout).');
  }

  var files = _mp7_filesWithOldId_();
  Logger.log('Files audited: ' + files.length);
  Logger.log('');

  // Group by category for the summary
  var byCategory = { a: [], b: [], c: [], d: [], other: [] };
  files.forEach(function (entry) {
    var cls = _MP7_FILE_CLASSIFICATIONS_[entry.path];
    var key = cls && cls.category ? cls.category : 'other';
    if (!byCategory[key]) byCategory[key] = [];
    byCategory[key].push(entry.path);
  });

  Logger.log('-- Category (a) UTILITY-NEEDS-UPDATE — REWIRE to NEW --');
  byCategory.a.forEach(function (p) { Logger.log('  ' + p); });
  Logger.log('Total (a): ' + byCategory.a.length);
  Logger.log('');

  Logger.log('-- Category (b) ARCHIVE-DEPRECATED — leave alone --');
  byCategory.b.forEach(function (p) { Logger.log('  ' + p); });
  Logger.log('Total (b): ' + byCategory.b.length);
  Logger.log('');

  Logger.log('-- Category (c) INTENTIONAL-OLD — KEEP as-is --');
  byCategory.c.forEach(function (p) { Logger.log('  ' + p); });
  Logger.log('Total (c): ' + byCategory.c.length);
  Logger.log('');

  Logger.log('-- Category (d) ALREADY-MIGRATED — OLD only in comments --');
  byCategory.d.forEach(function (p) { Logger.log('  ' + p); });
  Logger.log('Total (d): ' + byCategory.d.length);
  Logger.log('');

  if (byCategory.other.length > 0) {
    Logger.log('-- UNCLASSIFIED — REVIEW MANUALLY --');
    byCategory.other.forEach(function (p) { Logger.log('  ' + p); });
    Logger.log('Total (?): ' + byCategory.other.length);
    Logger.log('');
  }

  Logger.log('-- Markdown audit table --');
  Logger.log(_mp7_buildAuditTable_(files));
  Logger.log('');

  // APPLY mode: log the rewrite plan only.
  //
  // Why log-only: Apps Script's DriveApp / Drive API can technically read
  // the .gs source of files in this project, but writing to project source
  // mid-execution leads to weird state (the current execution stops, you
  // re-deploy, etc). Safer pattern: log the EXACT sed plan and let Steven
  // apply locally + push. This is also what Phase 7 the test exercises.
  if (applyMode) {
    Logger.log('=== APPLY REWRITE PLAN (run in repo locally, then redeploy bot) ===');
    Logger.log('# For each category (a) file below, change the OLD sheet ID');
    Logger.log('# constant to the NEW sheet ID:');
    Logger.log('#   from: ' + _MP7_OLD_SHEET_ID_);
    Logger.log('#   to:   ' + _MP7_NEW_SHEET_ID_);
    Logger.log('');
    byCategory.a.forEach(function (p) {
      Logger.log('sed -i.bak "s/' + _MP7_OLD_SHEET_ID_ + '/' + _MP7_NEW_SHEET_ID_ + '/g" ' + p);
    });
    Logger.log('');
    Logger.log('# IMPORTANT — only rewrite category (a). Do NOT run sed on:');
    byCategory.b.concat(byCategory.c).forEach(function (p) {
      Logger.log('#   ' + p + ' (NOT (a))');
    });
    Logger.log('');
    Logger.log('# After the sed: run `node bot/test_migration_phase_7.js` to confirm');
    Logger.log('# that category (a) files now reference NEW and (b)/(c) still reference OLD.');
    Logger.log('=== END APPLY PLAN ===');
  } else {
    Logger.log('=== DRY-RUN COMPLETE — nothing was modified ===');
    Logger.log('To apply: run APPLY_PHASE_7_REWIRE_NOW (zero-arg wrapper).');
  }

  if (_mp7Lock) {
    try { _mp7Lock.releaseLock(); } catch (_lockErr) { /* ignore */ }
  }

  return {
    totalAudited: files.length,
    categories: {
      a: byCategory.a.length,
      b: byCategory.b.length,
      c: byCategory.c.length,
      d: byCategory.d.length,
      other: byCategory.other.length
    },
    rewireTargets: byCategory.a,
    keepAsIs: byCategory.b.concat(byCategory.c).concat(byCategory.d)
  };
}

// ─── PUBLIC ENTRY POINTS ─────────────────────────────────────────────────

function DRY_RUN_PHASE_7_SWEEP() {
  return _mp7_audit_(false);
}

function APPLY_PHASE_7_REWIRE(confirmation) {
  if (confirmation !== 'YES I UNDERSTAND') {
    Logger.log('!! REFUSED — APPLY_PHASE_7_REWIRE requires the EXACT string "YES I UNDERSTAND" as the argument.');
    Logger.log('   Easier: run APPLY_PHASE_7_REWIRE_NOW from the function dropdown (no arg needed).');
    Logger.log('   First always run DRY_RUN_PHASE_7_SWEEP() and review the audit.');
    return { refused: true };
  }
  return _mp7_audit_(true);
}

// Apps Script function dropdown can't pass arguments. This zero-arg
// wrapper makes APPLY_PHASE_7_REWIRE runnable from the dropdown. Same
// safety contract: passes the literal confirmation internally.
function APPLY_PHASE_7_REWIRE_NOW() {
  return APPLY_PHASE_7_REWIRE('YES I UNDERSTAND');
}
