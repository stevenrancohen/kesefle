/**
 * ============================================================================
 *  CLEANUP_LEAKED_ROWS.gs  —  owner-run helper to find & remove rows that
 *  leaked into YOUR sheet from other (test) users BEFORE the multi-tenant
 *  isolation fix.
 * ============================================================================
 *
 *  WHY: until the isolation fix, expenses from other phone numbers could be
 *  written into your personal "תנועות" tab. The code fix stops FUTURE leaks,
 *  but it cannot un-write the rows already there. Your sheet has no
 *  "sender phone" column, so leaked rows can't be filtered automatically —
 *  YOU identify them by eye (by date/amount/description), then delete them.
 *
 *  HOW TO USE (run each function from the Apps Script editor ▷ Run):
 *
 *   1) kflBackupTransactionsSheet()
 *        → makes a timestamped backup copy of the "תנועות" tab. ALWAYS do
 *          this first. (kflDeleteRowsByIndices also auto-backs-up, but a
 *          manual backup is cheap insurance.)
 *
 *   2) kflListRowsForReview('2026-05-16', '2026-05-20')
 *        → READ-ONLY. Builds a tab "🔎 בדיקת_דליפה" listing every תנועות row
 *          in that date range, with its ORIGINAL row number, amount,
 *          category, description and the provenance cell-note. Open that tab,
 *          eyeball it, and write down the original row numbers that belong to
 *          the test users (NOT yours).
 *
 *   3) kflDeleteRowsByIndices('7, 12, 13')
 *        → auto-backs-up, logs each row it is about to delete, then deletes
 *          exactly those ORIGINAL row numbers (highest-first so numbers stay
 *          valid). Nothing else is touched.
 *
 *  SAFETY: nothing here runs automatically (no triggers). Deletion only ever
 *  happens for the explicit row numbers YOU pass to kflDeleteRowsByIndices.
 *  CLR_-prefixed names avoid clashing with the main bot's constants.
 * ============================================================================
 */

var CLR_SHEET_ID = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var CLR_TAB = 'תנועות';
var CLR_REVIEW_TAB = '🔎 בדיקת_דליפה';

/** Make a timestamped backup copy of the תנועות tab. Returns the new tab name. */
function kflBackupTransactionsSheet() {
  var ss = SpreadsheetApp.openById(CLR_SHEET_ID);
  var src = ss.getSheetByName(CLR_TAB);
  if (!src) throw new Error('לא נמצאה לשונית "' + CLR_TAB + '"');
  var stamp = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd_HH-mm');
  var name = 'גיבוי_תנועות_' + stamp;
  var copy = src.copyTo(ss);
  copy.setName(name);
  Logger.log('✅ גיבוי נוצר: "' + name + '" (' + (copy.getLastRow()) + ' שורות).');
  return name;
}

/**
 * READ-ONLY. List all תנועות rows whose date is within [fromDateStr, toDateStr]
 * (inclusive, format 'YYYY-MM-DD') into the review tab so you can identify
 * which rows are foreign (test users') and which are yours.
 */
function kflListRowsForReview(fromDateStr, toDateStr) {
  if (!fromDateStr || !toDateStr) {
    throw new Error('שימוש: kflListRowsForReview("2026-05-16","2026-05-20")');
  }
  var from = new Date(fromDateStr + 'T00:00:00');
  var to = new Date(toDateStr + 'T23:59:59');
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new Error('תאריך לא תקין. פורמט: YYYY-MM-DD');
  }

  var ss = SpreadsheetApp.openById(CLR_SHEET_ID);
  var sheet = ss.getSheetByName(CLR_TAB);
  if (!sheet) throw new Error('לא נמצאה לשונית "' + CLR_TAB + '"');

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('אין נתונים.'); return 0; }

  // Columns A:H = date, month, amount, category, subcategory, description, source, status
  var values = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var notes = sheet.getRange(2, 6, lastRow - 1, 1).getNotes(); // notes live on the "פירוט" (F) cell

  var out = [['שורה_מקורית', 'תאריך', 'סכום', 'קטגוריה', 'תת-קטגוריה', 'פירוט', 'מקור', 'הערת_מקור']];
  for (var i = 0; i < values.length; i++) {
    var rowNum = i + 2; // actual sheet row
    var dateVal = values[i][0];
    var d = (dateVal instanceof Date) ? dateVal : new Date(dateVal);
    if (isNaN(d.getTime())) continue;
    if (d < from || d > to) continue;
    out.push([
      rowNum,
      Utilities.formatDate(d, 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm'),
      values[i][2], // amount
      values[i][3], // category
      values[i][4], // subcategory
      values[i][5], // description
      values[i][6], // source
      (notes[i] && notes[i][0]) ? notes[i][0] : ''
    ]);
  }

  var review = ss.getSheetByName(CLR_REVIEW_TAB);
  if (review) review.clear(); else review = ss.insertSheet(CLR_REVIEW_TAB);
  review.getRange(1, 1, out.length, out[0].length).setValues(out);
  review.setFrozenRows(1);
  review.getRange(1, 1, 1, out[0].length).setFontWeight('bold');
  review.autoResizeColumns(1, out[0].length);

  var found = out.length - 1;
  Logger.log('🔎 ' + found + ' שורות בטווח ' + fromDateStr + '–' + toDateStr +
             ' נכתבו ללשונית "' + CLR_REVIEW_TAB + '". פתח אותה, סמן אילו שורות זרות, ' +
             'ואז הרץ kflDeleteRowsByIndices("מספרי_שורות").');
  return found;
}

/**
 * Delete specific ORIGINAL row numbers from תנועות. Auto-backs-up first and
 * logs each row's content before deleting. Pass a comma-separated string of
 * the "שורה_מקורית" numbers from the review tab, e.g. "7, 12, 13".
 */
function kflDeleteRowsByIndices(csvIndices) {
  if (!csvIndices) throw new Error('שימוש: kflDeleteRowsByIndices("7,12,13")');
  var nums = String(csvIndices).split(',')
    .map(function (s) { return parseInt(String(s).trim(), 10); })
    .filter(function (n) { return !isNaN(n) && n >= 2; }); // never row 1 (header)
  if (!nums.length) throw new Error('לא זוהו מספרי שורות תקינים.');

  // Always back up before any destructive change.
  var backupName = kflBackupTransactionsSheet();

  var ss = SpreadsheetApp.openById(CLR_SHEET_ID);
  var sheet = ss.getSheetByName(CLR_TAB);

  // Log what we're about to delete, then delete highest row number first so
  // earlier indices stay valid as rows shift up.
  nums.sort(function (a, b) { return b - a; });
  var deleted = 0;
  for (var i = 0; i < nums.length; i++) {
    var r = nums[i];
    if (r > sheet.getLastRow()) { Logger.log('דילוג: שורה ' + r + ' מעבר לסוף הגיליון.'); continue; }
    var rowVals = sheet.getRange(r, 1, 1, 8).getValues()[0];
    Logger.log('🗑️ מוחק שורה ' + r + ': ' + JSON.stringify(rowVals));
    sheet.deleteRow(r);
    deleted++;
  }
  Logger.log('✅ נמחקו ' + deleted + ' שורות. גיבוי מלא קיים בלשונית "' + backupName + '". ' +
             'אם משהו השתבש — העתק ממנו את השורות בחזרה.');
  return deleted;
}
