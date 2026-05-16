// =====================================================================
// CLEANUP_DUPLICATES_AND_TABS.gs
// 1) Removes the DUPLICATE "סיכום פיננסי — תמונת מצב 4 שנים" section
//    in מאזן חברה (keeps the first; deletes the second).
// 2) Audits tabs and deletes/hides+renames the ones the bot added.
//
// USAGE (run in this order):
//   STEP1_REMOVE_DUPLICATE_SUMMARY    — fixes the dashboard duplicate
//   STEP2_AUDIT_TABS                  — read-only; shows what will happen
//   STEP3_APPLY_TAB_CLEANUP           — actually deletes/hides
// =====================================================================

var KFL_CL_SHEET_ID = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var KFL_CL_DASH      = 'מאזן חברה';
var KFL_CL_MARKER    = 'EMBEDDED_FINANCIAL_SUMMARY';

// Tabs that get deleted outright (backup / scratch / test residue)
var KFL_CL_SAFE_DELETE = [
  /^_BAK_/,
  /^_DRYRUN_/,
  /^_AUDIT_/,
  /^_TEST_/,
  /^_SCRATCH_/,
  /^Copy of /,
  /^עותק של /,
];

// Tabs that get hidden + renamed to dontdeleteN (useful as reference, not visible)
var KFL_CL_HIDE_RENAME = [
  /^סיכום פיננסי$/,
  /^FINANCIAL/i,
  /^Sheet\d*$/,
  /^גיליון\s*\d*$/,
  /^_REF_/,
];

// User's real tabs — never touched
var KFL_CL_USER_TABS = [
  'דשבורד', 'DASHBOARD', 'מאזן חברה',
  '2020', '2021', '2022', '2023', '2024', '2025', '2026', '2027',
  'הגדרות', 'Settings', 'משכורות', 'השקעות', 'הוצאות', 'הכנסות',
  'דוחות', 'תקציב', 'פרויקטים', 'תזרים', 'לקוחות', 'ספקים',
];

// =====================================================================
// STEP 1 — remove duplicate "סיכום פיננסי" section
// =====================================================================
function STEP1_REMOVE_DUPLICATE_SUMMARY() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.openById(KFL_CL_SHEET_ID);
  var dash = ss.getSheetByName(KFL_CL_DASH);
  if (!dash) { ui.alert('לא נמצאה לשונית: ' + KFL_CL_DASH); return; }

  var lastRow = dash.getLastRow();
  if (lastRow < 5) { ui.alert('הלשונית ריקה.'); return; }

  // Pass 1: look for the hidden START/END markers in column H
  var colH = dash.getRange(1, 8, lastRow, 1).getValues();
  var starts = [], ends = [];
  for (var i = 0; i < colH.length; i++) {
    var v = String(colH[i][0] || '');
    if (v === KFL_CL_MARKER + ':START') starts.push(i + 1);
    if (v === KFL_CL_MARKER + ':END')   ends.push(i + 1);
  }

  var usingFallback = false;
  if (starts.length < 2 || ends.length < 2) {
    // Pass 2 (fallback): the markers might have been cleared. Search column A header text.
    var colA = dash.getRange(1, 1, lastRow, 1).getValues();
    var headerHits = [];
    for (var j = 0; j < colA.length; j++) {
      var s = String(colA[j][0] || '');
      if (s.indexOf('סיכום פיננסי') !== -1 && s.indexOf('תמונת מצב') !== -1) {
        headerHits.push(j + 1);
      }
    }
    if (headerHits.length < 2) {
      ui.alert(
        'לא נמצאה כפילות.',
        'מצאתי: ' + headerHits.length + ' כותרת + ' + starts.length + ' START + ' + ends.length + ' END.',
        ui.ButtonSet.OK
      );
      return;
    }
    // Estimate the section length from the first occurrence
    var firstHeader = headerHits[0];
    // section spans header → ~25 rows of: data table + delta row + insights
    // measure: distance to next non-empty block break (>2 consecutive empties in col A)
    var sectionLen = measureSectionLen_(dash, firstHeader, lastRow);
    starts = [firstHeader, headerHits[1]];
    ends   = [firstHeader + sectionLen - 1, headerHits[1] + sectionLen - 1];
    usingFallback = true;
  }

  if (starts.length < 2 || ends.length < 2) {
    ui.alert('יש רק מופע אחד — אין כפילות למחוק.');
    return;
  }

  var s2 = starts[1], e2 = ends[1];
  var rowsToDelete = e2 - s2 + 1;

  if (rowsToDelete < 5 || rowsToDelete > 60) {
    ui.alert('עצרתי — חישוב חשוד.', 'מנסה למחוק ' + rowsToDelete + ' שורות (' + s2 + '-' + e2 + '). זה לא נראה תקין.', ui.ButtonSet.OK);
    return;
  }

  var msg = 'נמצאו ' + starts.length + ' מופעים של "סיכום פיננסי".\n\n';
  msg += 'מקטע ראשון (נשמר): שורות ' + starts[0] + '-' + ends[0] + '\n';
  msg += 'מקטע שני (למחיקה): שורות ' + s2 + '-' + e2 + ' (' + rowsToDelete + ' שורות)\n';
  if (usingFallback) msg += '\n⚠ הסימונים הנסתרים לא נמצאו — שיערתי את גודל המקטע. בדוק לאחר מכן.\n';
  msg += '\nלהמשיך?';

  if (ui.alert('אישור מחיקת כפילות', msg, ui.ButtonSet.YES_NO) !== ui.Button.YES) {
    ui.alert('בוטל.');
    return;
  }

  dash.deleteRows(s2, rowsToDelete);
  ui.alert('✓ הוסר',
    'נמחקו ' + rowsToDelete + ' שורות.\nהמופע הראשון בשורות ' + starts[0] + '-' + ends[0] + ' נשמר.',
    ui.ButtonSet.OK);
}

// Heuristic: walk down until we hit ≥3 consecutive empty rows in col A
function measureSectionLen_(sh, startRow, lastRow) {
  var maxLook = Math.min(40, lastRow - startRow + 1);
  var col = sh.getRange(startRow, 1, maxLook, 1).getValues();
  var emptyStreak = 0;
  for (var r = 0; r < col.length; r++) {
    var v = String(col[r][0] || '').trim();
    if (v === '') emptyStreak++;
    else emptyStreak = 0;
    if (emptyStreak >= 3) return r - 2;   // section ended 2 rows back
  }
  return Math.min(25, maxLook);            // safe default
}

// =====================================================================
// STEP 2 — audit tabs (read-only)
// =====================================================================
function STEP2_AUDIT_TABS() {
  var ui = SpreadsheetApp.getUi();
  var plan = buildTabPlan_();
  var msg = 'תכנית ניקוי לשוניות (טרם הוחל):\n\n';
  msg += '🗑️ למחיקה (' + plan.del.length + '):\n';
  msg += (plan.del.length ? plan.del.map(function(n){return '  • ' + n;}).join('\n') : '  (אין)') + '\n\n';
  msg += '👁️ להסתרה + שינוי שם ל-dontdeleteN (' + plan.hide.length + '):\n';
  msg += (plan.hide.length ? plan.hide.map(function(n){return '  • ' + n;}).join('\n') : '  (אין)') + '\n\n';
  msg += '✅ נשמרות (' + plan.keep.length + '):\n';
  msg += plan.keep.map(function(n){return '  • ' + n;}).join('\n');
  msg += '\n\nכדי להחיל — הרץ STEP3_APPLY_TAB_CLEANUP';
  Logger.log(msg);
  ui.alert('AUDIT — תכנית', msg, ui.ButtonSet.OK);
}

// =====================================================================
// STEP 3 — apply tab cleanup
// =====================================================================
function STEP3_APPLY_TAB_CLEANUP() {
  var ui = SpreadsheetApp.getUi();
  var plan = buildTabPlan_();

  if (plan.del.length === 0 && plan.hide.length === 0) {
    ui.alert('אין מה לנקות.');
    return;
  }

  var preview = 'יימחקו: ' + plan.del.length + ' לשוניות\nיוסתרו+ישונה שם: ' + plan.hide.length + '\n\nלהמשיך?';
  if (ui.alert('אישור החלת ניקוי', preview, ui.ButtonSet.YES_NO) !== ui.Button.YES) {
    ui.alert('בוטל.');
    return;
  }

  var ss = SpreadsheetApp.openById(KFL_CL_SHEET_ID);
  var sheets = ss.getSheets();
  var nameToSheet = {};
  sheets.forEach(function(s){ nameToSheet[s.getName()] = s; });

  // Find max existing dontdelete number
  var hideCounter = 1;
  sheets.forEach(function(sh) {
    var m = sh.getName().match(/^dontdelete(\d+)$/);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n >= hideCounter) hideCounter = n + 1;
    }
  });

  var deleted = [], renamed = [];
  // Hide+rename first (deletion of others may shift indices, but rename doesn't)
  plan.hide.forEach(function(name) {
    var sh = nameToSheet[name];
    if (!sh) return;
    try {
      var newName = 'dontdelete' + hideCounter++;
      sh.setName(newName);
      sh.hideSheet();
      renamed.push(name + ' → ' + newName);
    } catch (e) { Logger.log('hide+rename failed: ' + name + ' — ' + e.message); }
  });
  // Then delete
  plan.del.forEach(function(name) {
    var sh = nameToSheet[name];
    if (!sh) return;
    try { ss.deleteSheet(sh); deleted.push(name); }
    catch (e) { Logger.log('delete failed: ' + name + ' — ' + e.message); }
  });

  var report = '✓ הסתיים\n\n';
  report += 'נמחקו (' + deleted.length + '):\n' + (deleted.length ? deleted.map(function(n){return '• ' + n;}).join('\n') : '(אין)');
  report += '\n\nהוסתרו+שונה שם (' + renamed.length + '):\n' + (renamed.length ? renamed.map(function(n){return '• ' + n;}).join('\n') : '(אין)');
  ui.alert('סיכום ניקוי', report, ui.ButtonSet.OK);
}

// Internal: builds {del, hide, keep} for the tab plan
function buildTabPlan_() {
  var ss = SpreadsheetApp.openById(KFL_CL_SHEET_ID);
  var sheets = ss.getSheets();
  var del = [], hide = [], keep = [];

  sheets.forEach(function(sh) {
    var name = sh.getName();
    if (/^dontdelete\d+$/.test(name)) { keep.push(name + ' (כבר מוסתר)'); return; }
    var isUserTab = KFL_CL_USER_TABS.indexOf(name) !== -1;
    if (isUserTab) { keep.push(name); return; }

    var isSafeDelete = KFL_CL_SAFE_DELETE.some(function(re){ return re.test(name); });
    if (isSafeDelete) { del.push(name); return; }

    var isHide = KFL_CL_HIDE_RENAME.some(function(re){ return re.test(name); });
    if (isHide) { hide.push(name); return; }

    // Unknown tab — be conservative, keep it
    keep.push(name + ' (לא זוהה — נשאר)');
  });

  return { del: del, hide: hide, keep: keep };
}
