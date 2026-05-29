// =====================================================================
// CLEANUP_DUPLICATES_AND_TABS.gs  (v2 — no UI popups, works in standalone scripts)
// 1) Removes the DUPLICATE "סיכום פיננסי — תמונת מצב 4 שנים" section
//    in מאזן חברה (keeps the first; deletes the second).
// 2) Audits tabs and deletes/hides+renames the ones the bot added.
//
// USAGE — run in this order:
//   STEP1A_PREVIEW_DUPLICATE     — read-only; logs the plan
//   STEP1B_APPLY_DUPLICATE       — actually deletes the duplicate
//   STEP2_AUDIT_TABS             — read-only; logs the plan
//   STEP3_APPLY_TAB_CLEANUP      — actually deletes/hides
//
// After each run, click "יומן ביצוע" (Execution log) at the bottom to see the result.
// =====================================================================

var KFL_CL_SHEET_ID = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var KFL_CL_DASH     = 'מאזן חברה';
var KFL_CL_MARKER   = 'EMBEDDED_FINANCIAL_SUMMARY';

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

// Tabs that get hidden + renamed to dontdeleteN (useful as reference)
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

// ============================================================
// STEP 1A — PREVIEW duplicate removal (logs only)
// ============================================================
function STEP1A_PREVIEW_DUPLICATE() {
  var result = findDuplicate_();
  if (!result.ok) {
    Logger.log('❌ ' + result.msg);
    return;
  }
  Logger.log('📋 תכנית מחיקה (טרם הוחל):');
  Logger.log('  נמצאו ' + result.starts.length + ' מופעים של "סיכום פיננסי".');
  Logger.log('  מקטע ראשון (נשמר):  שורות ' + result.starts[0] + ' - ' + result.ends[0]);
  Logger.log('  מקטע שני (למחיקה): שורות ' + result.s2 + ' - ' + result.e2 + ' (' + result.rowsToDelete + ' שורות)');
  if (result.usingFallback) {
    Logger.log('  ⚠ הסימונים הנסתרים בעמודה H לא נמצאו — שיערתי גודל מקטע. בדוק לאחר מכן.');
  }
  Logger.log('');
  Logger.log('✅ אם זה נראה תקין — הרץ עכשיו STEP1B_APPLY_DUPLICATE');
}

// ============================================================
// STEP 1B — APPLY duplicate removal (actually deletes)
// ============================================================
function STEP1B_APPLY_DUPLICATE() {
  var result = findDuplicate_();
  if (!result.ok) {
    Logger.log('❌ ' + result.msg);
    return;
  }
  if (result.rowsToDelete < 5 || result.rowsToDelete > 60) {
    Logger.log('🛑 עצרתי — חישוב חשוד. ' + result.rowsToDelete + ' שורות נראה לא תקין. בדוק שורות ' + result.s2 + '-' + result.e2);
    return;
  }
  var ss = SpreadsheetApp.openById(KFL_CL_SHEET_ID);
  var dash = ss.getSheetByName(KFL_CL_DASH);
  dash.deleteRows(result.s2, result.rowsToDelete);
  Logger.log('✅ הוסר. נמחקו ' + result.rowsToDelete + ' שורות.');
  Logger.log('   המופע הראשון בשורות ' + result.starts[0] + '-' + result.ends[0] + ' נשמר.');
  Logger.log('   פתח את הגיליון "מאזן חברה" כדי לוודא.');
}

// Internal: locates the duplicate. Returns {ok, starts, ends, s2, e2, rowsToDelete, usingFallback, msg}
function findDuplicate_() {
  var ss = SpreadsheetApp.openById(KFL_CL_SHEET_ID);
  var dash = ss.getSheetByName(KFL_CL_DASH);
  if (!dash) return { ok: false, msg: 'לא נמצאה לשונית: ' + KFL_CL_DASH };

  var lastRow = dash.getLastRow();
  if (lastRow < 5) return { ok: false, msg: 'הלשונית ריקה.' };

  // Pass 1: hidden markers in column H
  var colH = dash.getRange(1, 8, lastRow, 1).getValues();
  var starts = [], ends = [];
  for (var i = 0; i < colH.length; i++) {
    var v = String(colH[i][0] || '');
    if (v === KFL_CL_MARKER + ':START') starts.push(i + 1);
    if (v === KFL_CL_MARKER + ':END')   ends.push(i + 1);
  }

  var usingFallback = false;
  if (starts.length < 2 || ends.length < 2) {
    // Pass 2 (fallback): search col A header text
    var colA = dash.getRange(1, 1, lastRow, 1).getValues();
    var headerHits = [];
    for (var j = 0; j < colA.length; j++) {
      var s = String(colA[j][0] || '');
      if (s.indexOf('סיכום פיננסי') !== -1 && s.indexOf('תמונת מצב') !== -1) {
        headerHits.push(j + 1);
      }
    }
    if (headerHits.length < 2) {
      return { ok: false, msg: 'לא נמצאה כפילות. (כותרות=' + headerHits.length + ', START=' + starts.length + ', END=' + ends.length + ')' };
    }
    var sectionLen = measureSectionLen_(dash, headerHits[0], lastRow);
    starts = [headerHits[0], headerHits[1]];
    ends   = [headerHits[0] + sectionLen - 1, headerHits[1] + sectionLen - 1];
    usingFallback = true;
  }

  if (starts.length < 2 || ends.length < 2) {
    return { ok: false, msg: 'יש רק מופע אחד — אין כפילות.' };
  }

  var s2 = starts[1], e2 = ends[1];
  return {
    ok: true, starts: starts, ends: ends,
    s2: s2, e2: e2, rowsToDelete: e2 - s2 + 1,
    usingFallback: usingFallback,
  };
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
    if (emptyStreak >= 3) return r - 2;
  }
  return Math.min(25, maxLook);
}

// ============================================================
// STEP 2 — audit tabs (read-only, logs only)
// ============================================================
function STEP2_AUDIT_TABS() {
  var plan = buildTabPlan_();
  Logger.log('📋 תכנית ניקוי לשוניות (טרם הוחל):');
  Logger.log('');
  Logger.log('🗑️ למחיקה (' + plan.del.length + '):');
  if (plan.del.length === 0) Logger.log('  (אין)');
  else plan.del.forEach(function(n){ Logger.log('  • ' + n); });
  Logger.log('');
  Logger.log('👁️ להסתרה + שינוי שם ל-dontdeleteN (' + plan.hide.length + '):');
  if (plan.hide.length === 0) Logger.log('  (אין)');
  else plan.hide.forEach(function(n){ Logger.log('  • ' + n); });
  Logger.log('');
  Logger.log('✅ נשמרות (' + plan.keep.length + '):');
  plan.keep.forEach(function(n){ Logger.log('  • ' + n); });
  Logger.log('');
  if (plan.del.length === 0 && plan.hide.length === 0) {
    Logger.log('🎉 אין מה לנקות.');
  } else {
    Logger.log('▶️ אם זה נראה תקין — הרץ עכשיו STEP3_APPLY_TAB_CLEANUP');
  }
}

// ============================================================
// STEP 3 — apply tab cleanup (actually deletes/hides)
// ============================================================
function STEP3_APPLY_TAB_CLEANUP() {
  var plan = buildTabPlan_();
  if (plan.del.length === 0 && plan.hide.length === 0) {
    Logger.log('🎉 אין מה לנקות.');
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
  // Hide+rename first
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

  Logger.log('✅ הסתיים.');
  Logger.log('');
  Logger.log('נמחקו (' + deleted.length + '):');
  if (deleted.length === 0) Logger.log('  (אין)');
  else deleted.forEach(function(n){ Logger.log('  • ' + n); });
  Logger.log('');
  Logger.log('הוסתרו + שונה שם (' + renamed.length + '):');
  if (renamed.length === 0) Logger.log('  (אין)');
  else renamed.forEach(function(n){ Logger.log('  • ' + n); });
}

// Internal: builds {del, hide, keep}
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
