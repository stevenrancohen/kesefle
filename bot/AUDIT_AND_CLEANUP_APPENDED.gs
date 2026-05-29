/**
 * AUDIT_AND_CLEANUP_APPENDED.gs - paste-once Apps Script
 *
 * Steven's 2026-05-29 post-APPLY problem: the rows that
 * MIGRATE_DASHBOARD_FROM_OLD appended under the "🏷️ מהגיליון הקודם"
 * banner mostly show ₪0 because their strict SUMIFS criteria don't match
 * any col-E value in NEW תנועות. Two distinct sub-problems:
 *
 *  1. The 4 appended business rows (עלות חומרי גלם / עלות שיווק /
 *     משלוחים והתקנות / הוצאות תפעוליות) duplicate EXISTING dashboard rows
 *     above the banner. The existing rows use looser formulas that DO sum;
 *     the appended duplicates use strict SUMIFS that don't match. They are
 *     pure noise — should be deleted.
 *
 *  2. Some personal appended rows (e.g. רוביקון, אבא, גיא) may not have any
 *     transactions in NEW תנועות col E because Steven only ever entered
 *     them as manual cell values in OLD dashboard, never as transaction
 *     rows. Those will keep showing 0 until the bot CATEGORY_MAP starts
 *     writing them.
 *
 * This script:
 *   - AUDIT_APPENDED_ROWS  - scans every row under the "🏷️ מהגיליון הקודם"
 *     banner on both dashboards, counts how many תנועות rows match its col-E
 *     criterion, and logs the verdict (keep / 0-matches / duplicate).
 *   - DRY_RUN_CLEANUP      - lists the rows that would be deleted if you
 *     ran CLEANUP. No writes.
 *   - CLEANUP_APPENDED     - gated by CONFIRM_CLEANUP_APPENDED = YES I UNDERSTAND.
 *     Deletes (a) the 4 business duplicates always, (b) optionally any
 *     personal appended row whose col-E criterion has 0 transaction matches
 *     IF you also set DELETE_ZERO_MATCH_PERSONAL = YES.
 *
 * Safe-mode defaults:
 *   - DELETE_ZERO_MATCH_PERSONAL is OFF unless you opt in. The personal
 *     zero-match rows might be categories Steven WANTS to track going
 *     forward, even if there's no history yet. He decides.
 *
 * Reversible: a fresh DocumentProperties backup is taken at CLEANUP start;
 * ROLLBACK_CLEANUP_APPENDED restores it.
 */

// ============================================================
// Constants (kept consistent with MIGRATE_DASHBOARD_FROM_OLD.gs)
// ============================================================
var _AAC_NEW_SHEET_ID_ = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var _AAC_TX_     = 'תנועות';
var _AAC_PERSON_ = 'מאזן אישי';
var _AAC_BIZ_    = 'מאזן חברה';
var _AAC_BANNER_ = '🏷️ מהגיליון הקודם';

// The 4 known-duplicate business labels (always delete from the appended block).
var _AAC_BIZ_DUPLICATES_ = [
  'עלות חומרי גלם',
  'עלות שיווק',
  'משלוחים והתקנות',
  'הוצאות תפעוליות'
];

// ============================================================
// Self-test: prove Hebrew literals decoded right.
// ============================================================
function AAC_SELF_TEST_HEBREW() {
  Logger.log('=== AAC self-test ===');
  Logger.log('תנועות     -> ' + _AAC_TX_);
  Logger.log('מאזן אישי  -> ' + _AAC_PERSON_);
  Logger.log('מאזן חברה  -> ' + _AAC_BIZ_);
  Logger.log('banner     -> ' + _AAC_BANNER_);
  Logger.log('biz dups   -> ' + _AAC_BIZ_DUPLICATES_.join(' | '));
}

// ============================================================
// Find the banner row on a dashboard. Returns row index (1-based) or 0.
// ============================================================
function _AAC_findBannerRow_(sheet) {
  if (!sheet) return 0;
  var values = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues();
  for (var r = 0; r < values.length; r++) {
    var v = String(values[r][0] == null ? '' : values[r][0]).trim();
    if (v === _AAC_BANNER_) return r + 1;
  }
  return 0;
}

// ============================================================
// Read distinct col-E values from תנועות, with counts.
// Returns { value -> count }.
// ============================================================
function _AAC_collectTxColE_(newSS) {
  var tx = newSS.getSheetByName(_AAC_TX_);
  if (!tx) throw new Error('תנועות tab not found in NEW.');
  var lastRow = tx.getLastRow();
  if (lastRow < 2) return {};
  // Skip header row (row 1).
  var eVals = tx.getRange(2, 5, lastRow - 1, 1).getValues();  // col E = col 5
  var counts = {};
  for (var i = 0; i < eVals.length; i++) {
    var k = String(eVals[i][0] == null ? '' : eVals[i][0]).trim();
    if (!k) continue;
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

// ============================================================
// AUDIT — for each appended row, count תנועות matches + classify.
// ============================================================
function AUDIT_APPENDED_ROWS() {
  var ss = SpreadsheetApp.openById(_AAC_NEW_SHEET_ID_);
  var personal = ss.getSheetByName(_AAC_PERSON_);
  var biz      = ss.getSheetByName(_AAC_BIZ_);
  if (!personal || !biz) throw new Error('NEW dashboards not found.');

  var txCounts = _AAC_collectTxColE_(ss);
  var totalTxLabels = 0;
  for (var k in txCounts) totalTxLabels++;

  var out = [];
  out.push('=== AAC AUDIT ===');
  out.push('NEW sheet: ' + _AAC_NEW_SHEET_ID_);
  out.push('Distinct col-E values in תנועות: ' + totalTxLabels);
  out.push('');

  [
    { name: _AAC_PERSON_, sheet: personal, isBiz: false },
    { name: _AAC_BIZ_,    sheet: biz,      isBiz: true  }
  ].forEach(function(target) {
    var bannerRow = _AAC_findBannerRow_(target.sheet);
    out.push('## ' + target.name + ' — appended rows under banner');
    if (!bannerRow) {
      out.push('  (no banner found — nothing appended)');
      out.push('');
      return;
    }
    out.push('  Banner at row: ' + bannerRow);
    var lastRow = target.sheet.getLastRow();
    if (lastRow <= bannerRow) {
      out.push('  (banner has no rows beneath)');
      out.push('');
      return;
    }
    var labels = target.sheet.getRange(bannerRow + 1, 1, lastRow - bannerRow, 1).getValues();
    var hits = 0, misses = 0, dupes = 0;
    out.push('  Row | Label                                        | TX matches | Verdict');
    out.push('  --- | -------------------------------------------- | ---------- | -------');
    for (var i = 0; i < labels.length; i++) {
      var lbl = String(labels[i][0] == null ? '' : labels[i][0]).trim();
      if (!lbl) continue;
      var n = txCounts[lbl] || 0;
      var verdict;
      if (target.isBiz && _AAC_BIZ_DUPLICATES_.indexOf(lbl) !== -1) {
        verdict = 'DUPLICATE (existing row above already sums this)';
        dupes++;
      } else if (n === 0) {
        verdict = 'NO_MATCH (col-E has no rows with this exact value)';
        misses++;
      } else {
        verdict = 'OK (' + n + ' matching tx rows)';
        hits++;
      }
      var rowNum = bannerRow + 1 + i;
      out.push('  ' + _AAC_pad_(rowNum, 3) + ' | ' + _AAC_pad_(lbl, 44) + ' | ' + _AAC_pad_(n, 10) + ' | ' + verdict);
    }
    out.push('  ---');
    out.push('  Summary: ' + hits + ' OK, ' + misses + ' NO_MATCH, ' + dupes + ' DUPLICATE');
    out.push('');
  });

  out.push('Legend:');
  out.push('  OK         = future bot writes routing to this label will be summed correctly.');
  out.push('  NO_MATCH   = label has no current history. Keep if you want bot to start populating');
  out.push('               it (after CATEGORY_MAP sync). Delete if you do not want this category.');
  out.push('  DUPLICATE  = existing row above the banner already sums this. Delete (it shows ₪0');
  out.push('               whereas the existing row above shows real numbers).');

  Logger.log(out.join('\n'));
  return out.join('\n');
}

function _AAC_pad_(v, n) {
  var s = String(v);
  while (s.length < n) s += ' ';
  return s;
}

// ============================================================
// DRY_RUN_CLEANUP — list the rows that would be deleted.
// ============================================================
function DRY_RUN_CLEANUP_APPENDED() {
  var props = PropertiesService.getScriptProperties();
  var deleteZero = props.getProperty('DELETE_ZERO_MATCH_PERSONAL') === 'YES';

  var ss = SpreadsheetApp.openById(_AAC_NEW_SHEET_ID_);
  var personal = ss.getSheetByName(_AAC_PERSON_);
  var biz      = ss.getSheetByName(_AAC_BIZ_);
  var txCounts = _AAC_collectTxColE_(ss);

  var plan = _AAC_buildDeletionPlan_(personal, biz, txCounts, deleteZero);

  var out = [];
  out.push('=== AAC DRY_RUN_CLEANUP ===');
  out.push('DELETE_ZERO_MATCH_PERSONAL: ' + (deleteZero ? 'YES (also deletes personal NO_MATCH rows)' : 'NO (default — keep personal NO_MATCH for future bot writes)'));
  out.push('');
  out.push('Personal rows to delete:');
  if (!plan.personalDeleteRows.length) out.push('  (none)');
  else plan.personalDeleteRows.forEach(function(r) {
    out.push('  row ' + r.row + ' = "' + r.label + '" (' + r.reason + ')');
  });
  out.push('');
  out.push('Business rows to delete:');
  if (!plan.bizDeleteRows.length) out.push('  (none)');
  else plan.bizDeleteRows.forEach(function(r) {
    out.push('  row ' + r.row + ' = "' + r.label + '" (' + r.reason + ')');
  });
  out.push('');
  out.push('To apply:');
  out.push('  1. Project Settings -> Script Properties -> set CONFIRM_CLEANUP_APPENDED = YES I UNDERSTAND');
  out.push('  2. (Optional) Also set DELETE_ZERO_MATCH_PERSONAL = YES to nuke personal no-match rows too');
  out.push('  3. Run CLEANUP_APPENDED');

  Logger.log(out.join('\n'));
  return plan;
}

// ============================================================
// CLEANUP — gated, backs up, deletes.
// ============================================================
function CLEANUP_APPENDED() {
  var props = PropertiesService.getScriptProperties();
  var gate = props.getProperty('CONFIRM_CLEANUP_APPENDED');
  if (gate !== 'YES I UNDERSTAND') {
    throw new Error('Refusing to CLEANUP. Set Script Property CONFIRM_CLEANUP_APPENDED = YES I UNDERSTAND first.');
  }
  var deleteZero = props.getProperty('DELETE_ZERO_MATCH_PERSONAL') === 'YES';

  var ss = SpreadsheetApp.openById(_AAC_NEW_SHEET_ID_);
  var personal = ss.getSheetByName(_AAC_PERSON_);
  var biz      = ss.getSheetByName(_AAC_BIZ_);
  var txCounts = _AAC_collectTxColE_(ss);

  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var stamp = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyyMMdd_HHmmss');
    var docProps = PropertiesService.getDocumentProperties();

    var plan = _AAC_buildDeletionPlan_(personal, biz, txCounts, deleteZero);

    // Snapshot the rows we're about to delete (col A:N for each).
    var backup = { stamp: stamp, deleteZero: deleteZero, personal: [], biz: [] };
    plan.personalDeleteRows.forEach(function(r) {
      backup.personal.push({ row: r.row, label: r.label, values: personal.getRange(r.row, 1, 1, 14).getValues()[0], formulas: personal.getRange(r.row, 1, 1, 14).getFormulas()[0] });
    });
    plan.bizDeleteRows.forEach(function(r) {
      backup.biz.push({ row: r.row, label: r.label, values: biz.getRange(r.row, 1, 1, 14).getValues()[0], formulas: biz.getRange(r.row, 1, 1, 14).getFormulas()[0] });
    });
    docProps.setProperty('aac_backup_' + stamp, JSON.stringify(backup));
    Logger.log('[BACKUP] aac_backup_' + stamp + ' — ' + (backup.personal.length + backup.biz.length) + ' rows snapshot');

    // Delete bottom-up so row indexes don't shift.
    var personalToDelete = plan.personalDeleteRows.slice().sort(function(a, b) { return b.row - a.row; });
    var bizToDelete      = plan.bizDeleteRows.slice().sort(function(a, b) { return b.row - a.row; });
    personalToDelete.forEach(function(r) {
      personal.deleteRow(r.row);
      Logger.log('[DELETE] ' + _AAC_PERSON_ + '!row ' + r.row + ' was "' + r.label + '"');
    });
    bizToDelete.forEach(function(r) {
      biz.deleteRow(r.row);
      Logger.log('[DELETE] ' + _AAC_BIZ_ + '!row ' + r.row + ' was "' + r.label + '"');
    });

    SpreadsheetApp.flush();

    // Clear gate so a fresh cleanup needs fresh approval.
    props.deleteProperty('CONFIRM_CLEANUP_APPENDED');

    Logger.log('=== CLEANUP done ===');
    Logger.log('Personal rows deleted: ' + plan.personalDeleteRows.length);
    Logger.log('Business rows deleted: ' + plan.bizDeleteRows.length);
    Logger.log('Backup key: aac_backup_' + stamp);
    Logger.log('To roll back: run ROLLBACK_CLEANUP_APPENDED');
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ============================================================
// Plan helper: which rows would be deleted under current settings.
// ============================================================
function _AAC_buildDeletionPlan_(personal, biz, txCounts, deleteZero) {
  var plan = { personalDeleteRows: [], bizDeleteRows: [] };

  // Business: always delete the 4 known duplicates under the banner.
  var bizBanner = _AAC_findBannerRow_(biz);
  if (bizBanner) {
    var bizLast = biz.getLastRow();
    if (bizLast > bizBanner) {
      var bizLabels = biz.getRange(bizBanner + 1, 1, bizLast - bizBanner, 1).getValues();
      for (var i = 0; i < bizLabels.length; i++) {
        var lbl = String(bizLabels[i][0] == null ? '' : bizLabels[i][0]).trim();
        if (!lbl) continue;
        if (_AAC_BIZ_DUPLICATES_.indexOf(lbl) !== -1) {
          plan.bizDeleteRows.push({ row: bizBanner + 1 + i, label: lbl, reason: 'duplicate of existing dashboard row above' });
        }
      }
    }
  }

  // Personal: only if user opts into deleting zero-match rows.
  if (deleteZero) {
    var personalBanner = _AAC_findBannerRow_(personal);
    if (personalBanner) {
      var personalLast = personal.getLastRow();
      if (personalLast > personalBanner) {
        var pLabels = personal.getRange(personalBanner + 1, 1, personalLast - personalBanner, 1).getValues();
        for (var j = 0; j < pLabels.length; j++) {
          var lbl2 = String(pLabels[j][0] == null ? '' : pLabels[j][0]).trim();
          if (!lbl2) continue;
          var n = txCounts[lbl2] || 0;
          if (n === 0) {
            plan.personalDeleteRows.push({ row: personalBanner + 1 + j, label: lbl2, reason: '0 matches in תנועות col-E' });
          }
        }
      }
    }
  }
  return plan;
}

// ============================================================
// ROLLBACK — restore the rows we just deleted (insertRowsAfter + setValues).
// ============================================================
function ROLLBACK_CLEANUP_APPENDED() {
  var docProps = PropertiesService.getDocumentProperties();
  var keys = docProps.getKeys().filter(function(k) { return k.indexOf('aac_backup_') === 0; }).sort();
  if (!keys.length) throw new Error('No AAC backup found.');
  var key = keys[keys.length - 1];
  var b = JSON.parse(docProps.getProperty(key));

  var ss = SpreadsheetApp.openById(_AAC_NEW_SHEET_ID_);
  var personal = ss.getSheetByName(_AAC_PERSON_);
  var biz      = ss.getSheetByName(_AAC_BIZ_);

  // Restore top-down (sort ascending by original row).
  var pAsc = b.personal.slice().sort(function(a, b) { return a.row - b.row; });
  var bAsc = b.biz.slice().sort(function(a, b) { return a.row - b.row; });

  pAsc.forEach(function(r) {
    personal.insertRowBefore(r.row);
    var range = personal.getRange(r.row, 1, 1, 14);
    // Set formulas where present, values otherwise.
    for (var c = 0; c < 14; c++) {
      var f = r.formulas[c];
      if (f) range.getCell(1, c + 1).setFormula(f);
      else   range.getCell(1, c + 1).setValue(r.values[c]);
    }
    Logger.log('[RESTORE] ' + _AAC_PERSON_ + '!row ' + r.row + ' = "' + r.label + '"');
  });
  bAsc.forEach(function(r) {
    biz.insertRowBefore(r.row);
    var range = biz.getRange(r.row, 1, 1, 14);
    for (var c = 0; c < 14; c++) {
      var f = r.formulas[c];
      if (f) range.getCell(1, c + 1).setFormula(f);
      else   range.getCell(1, c + 1).setValue(r.values[c]);
    }
    Logger.log('[RESTORE] ' + _AAC_BIZ_ + '!row ' + r.row + ' = "' + r.label + '"');
  });

  // Clear backup + gate.
  docProps.deleteProperty(key);
  PropertiesService.getScriptProperties().deleteProperty('CONFIRM_CLEANUP_APPENDED');

  Logger.log('=== ROLLBACK done ===');
  Logger.log('Restored ' + pAsc.length + ' personal + ' + bAsc.length + ' business rows');
  Logger.log('Backup ' + key + ' cleared');
}
