// BOT_COMMANDS.gs - Conversational commands for the Kesefle WhatsApp bot.
// Purpose: handle quick text intents BEFORE the classifier runs:
//   - Summary queries (today, yesterday, week, month, year)
//   - Category-specific queries ("how much did I spend on Wolt?")
//   - UNDO / correction commands (delete last, fix category, delete match)
//   - Help / stats commands
//
// Public API:
//   handleBotCommand_(from, text)  ->  { handled: true, replyText } | { handled: false }
//   sendWhatsAppReply(toPhone, text)
//
// Sheet schema for 'תנועות':
//   A=timestamp, B=amount, C=currency, D=type, E=category,
//   F=subcategory, G=raw_text, H=source, I=message_id
//
// ASCII-only comments. Hebrew text only inside string literals.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

var BC_SHEET_ID = '1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo';
var BC_TX_SHEET = 'תנועות';

// Column indexes (0-based) inside the תנועות sheet.
var BC_COL = {
  TIMESTAMP: 0,
  AMOUNT: 1,
  CURRENCY: 2,
  TYPE: 3,
  CATEGORY: 4,
  SUBCATEGORY: 5,
  RAW_TEXT: 6,
  SOURCE: 7,
  MESSAGE_ID: 8
};

// Type values that count as expenses (vs income).
var BC_EXPENSE_TYPES = ['expense', 'הוצאה', 'business_expense', 'personal_expense'];

// Hebrew/English emoji decorations for the bot replies.
var BC_EMOJI = {
  money: '💰',
  receipt: '🧾',
  chart: '📊',
  calendar: '📅',
  trophy: '🏆',
  trash: '🗑',
  check: '✅',
  warn: '⚠️',
  help: '❓'
};

// Cached sheet read for the lifetime of one invocation.
var _BC_CACHE = null;

// ---------------------------------------------------------------------------
// Entry point — call this BEFORE _SRC_classify_v2_ in SRC_ROUTER_handle.
// ---------------------------------------------------------------------------
function handleBotCommand_(from, text) {
  var raw = String(text == null ? '' : text).trim();
  if (!raw) return { handled: false };

  // Strip leading slash so "/help" works the same as "help".
  var norm = raw.replace(/^\//, '').trim();
  var low = norm.toLowerCase();

  // --- Help -----------------------------------------------------------------
  if (_BC_isHelpCommand_(low, norm)) {
    return { handled: true, replyText: _BC_helpText_() };
  }

  // --- Stats ----------------------------------------------------------------
  if (low === 'stats' || low === 'סטטיסטיקות' || low === 'סטטיסטיקה') {
    return { handled: true, replyText: _BC_statsReply_() };
  }

  // --- UNDO / corrections (check before summaries, prefix-style) ------------
  if (low === 'undo' || norm === 'מחק אחרון' || norm === 'מחק את האחרון' || low === 'מחק') {
    return { handled: true, replyText: _BC_undoLastReply_() };
  }
  var fixMatch = norm.match(/^תקן\s*ל[:\s]\s*(.+)$/);
  if (fixMatch) {
    return { handled: true, replyText: _BC_fixLastCategoryReply_(fixMatch[1]) };
  }
  var delMatch = norm.match(/^מחק\s+את\s+(.+)$/);
  if (delMatch) {
    return { handled: true, replyText: _BC_deleteByTextReply_(delMatch[1]) };
  }

  // --- Summary queries ------------------------------------------------------
  var sum = _BC_matchSummary_(low, norm);
  if (sum) {
    return { handled: true, replyText: _BC_summaryReply_(sum) };
  }

  // --- Category-specific queries (כמה הוצאתי על X / כמה על X) --------------
  var catQuery = _BC_matchCategoryQuery_(norm);
  if (catQuery) {
    return { handled: true, replyText: _BC_categoryQueryReply_(catQuery) };
  }

  return { handled: false };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function _BC_isHelpCommand_(low, norm) {
  return low === 'help' || low === '?' || norm === 'עזרה' || norm === 'הוראות';
}

function _BC_helpText_() {
  var L = [];
  L.push(BC_EMOJI.help + ' פקודות מהירות:');
  L.push('');
  L.push(BC_EMOJI.chart + ' סיכומים:');
  L.push('  היום? / today?');
  L.push('  אתמול?');
  L.push('  השבוע?');
  L.push('  החודש? / month?');
  L.push('  החודש שעבר?');
  L.push('  שנה?');
  L.push('');
  L.push(BC_EMOJI.receipt + ' שאילתות לפי קטגוריה:');
  L.push('  כמה הוצאתי על וולט?');
  L.push('  כמה הוצאתי על אוכל בחוץ?');
  L.push('  כמה על קפה?');
  L.push('');
  L.push(BC_EMOJI.trash + ' תיקונים:');
  L.push('  מחק אחרון / UNDO');
  L.push('  תקן ל: <קטגוריה>');
  L.push('  מחק את <טקסט>');
  L.push('');
  L.push(BC_EMOJI.trophy + ' שונות:');
  L.push('  סטטיסטיקות / stats');
  L.push('  עזרה / help / ?');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Summary queries
// ---------------------------------------------------------------------------
function _BC_matchSummary_(low, norm) {
  // Order matters: longer phrases first.
  if (norm === 'החודש שעבר?' || norm === 'החודש שעבר' || low === 'last month?' || low === 'last month') {
    return 'last_month';
  }
  if (norm === 'היום?' || norm === 'היום' || low === 'today?' || low === 'today') return 'today';
  if (norm === 'אתמול?' || norm === 'אתמול' || low === 'yesterday?' || low === 'yesterday') return 'yesterday';
  if (norm === 'השבוע?' || norm === 'השבוע' || low === 'week?' || low === 'week' || low === 'this week') return 'week';
  if (norm === 'החודש?' || norm === 'החודש' || low === 'month?' || low === 'month' || low === 'this month') return 'month';
  if (norm === 'שנה?' || norm === 'שנה' || norm === 'השנה?' || norm === 'השנה' || low === 'year?' || low === 'year' || low === 'ytd') return 'year';
  return null;
}

function _BC_summaryReply_(kind) {
  var range = _BC_rangeFor_(kind);
  var rows = _BC_getExpenseRows_();
  var filtered = _dateRangeFilter(rows, range.start, range.end);
  var total = _BC_sumAmounts_(filtered);
  var count = filtered.length;

  var header = range.label;
  var lines = [];
  lines.push(BC_EMOJI.chart + ' ' + header);
  lines.push(BC_EMOJI.money + ' סה"כ: ' + _formatShekel(total));
  lines.push(BC_EMOJI.receipt + ' תנועות: ' + count);

  if (count === 0) return lines.join('\n');

  if (kind === 'week' || kind === 'month' || kind === 'year') {
    var top = _groupByCategory(filtered);
    if (kind === 'year') {
      lines.push('');
      lines.push(BC_EMOJI.trophy + ' 5 הקטגוריות המובילות:');
      var slice5 = top.slice(0, 5);
      for (var i = 0; i < slice5.length; i++) {
        lines.push('  ' + (i + 1) + '. ' + slice5[i].name + ' — ' + _formatShekel(slice5[i].total));
      }
    } else if (top.length > 0) {
      lines.push(BC_EMOJI.trophy + ' מובילה: ' + top[0].name + ' (' + _formatShekel(top[0].total) + ')');
    }
  }

  return lines.join('\n');
}

function _BC_rangeFor_(kind) {
  var tz = _BC_tz_();
  var now = new Date();
  if (kind === 'today') {
    var s = _BC_startOfDay_(now);
    return { start: s, end: _BC_endOfDay_(now), label: 'היום (' + _BC_fmtDate_(now, tz) + ')' };
  }
  if (kind === 'yesterday') {
    var y = new Date(now.getTime() - 86400000);
    return { start: _BC_startOfDay_(y), end: _BC_endOfDay_(y), label: 'אתמול (' + _BC_fmtDate_(y, tz) + ')' };
  }
  if (kind === 'week') {
    var start7 = new Date(now.getTime() - 7 * 86400000);
    return { start: _BC_startOfDay_(start7), end: _BC_endOfDay_(now), label: '7 הימים האחרונים' };
  }
  if (kind === 'month') {
    var ms = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return { start: ms, end: _BC_endOfDay_(now), label: 'החודש (' + (now.getMonth() + 1) + '/' + now.getFullYear() + ')' };
  }
  if (kind === 'last_month') {
    var lmStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    var lmEnd = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    lmEnd = new Date(lmEnd.getTime() - 1);
    return { start: lmStart, end: lmEnd, label: 'החודש שעבר (' + (lmStart.getMonth() + 1) + '/' + lmStart.getFullYear() + ')' };
  }
  // year
  var ys = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
  return { start: ys, end: _BC_endOfDay_(now), label: 'מתחילת השנה (' + now.getFullYear() + ')' };
}

// ---------------------------------------------------------------------------
// Category-specific query: "כמה הוצאתי על X" / "כמה על X"
// ---------------------------------------------------------------------------
function _BC_matchCategoryQuery_(norm) {
  // Strip trailing punctuation/question marks.
  var clean = norm.replace(/[?؟]+$/, '').trim();
  var m = clean.match(/^כמה\s+הוצאתי\s+על\s+(.+)$/);
  if (m) return m[1].trim();
  m = clean.match(/^כמה\s+על\s+(.+)$/);
  if (m) return m[1].trim();
  m = clean.match(/^how\s+much\s+(?:did\s+i\s+spend\s+)?on\s+(.+)$/i);
  if (m) return m[1].trim();
  return null;
}

function _BC_categoryQueryReply_(needle) {
  if (!needle) return BC_EMOJI.warn + ' לא הבנתי איזו קטגוריה לחפש.';
  var rows = _BC_getExpenseRows_();
  var hits = _BC_searchByText_(rows, needle);
  var total = _BC_sumAmounts_(hits);

  var lines = [];
  lines.push(BC_EMOJI.receipt + ' חיפוש: "' + needle + '"');
  lines.push(BC_EMOJI.money + ' סה"כ: ' + _formatShekel(total));
  lines.push('תנועות: ' + hits.length);

  if (hits.length === 0) {
    lines.push('');
    lines.push('לא נמצאו תנועות תואמות. נסה מילת מפתח אחרת.');
    return lines.join('\n');
  }
  // Show up to 3 most-recent hits
  hits.sort(function (a, b) { return b[BC_COL.TIMESTAMP] - a[BC_COL.TIMESTAMP]; });
  var sample = hits.slice(0, 3);
  lines.push('');
  lines.push('דוגמאות אחרונות:');
  for (var i = 0; i < sample.length; i++) {
    var r = sample[i];
    var when = _BC_fmtDate_(new Date(r[BC_COL.TIMESTAMP]), _BC_tz_());
    var amt = _formatShekel(_BC_num_(r[BC_COL.AMOUNT]));
    var raw = String(r[BC_COL.RAW_TEXT] || '').substring(0, 40);
    lines.push('  ' + when + ' · ' + amt + ' · ' + raw);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// UNDO / corrections
// ---------------------------------------------------------------------------
function _BC_undoLastReply_() {
  var ctx = _BC_findLastRow_();
  if (!ctx) return BC_EMOJI.warn + ' לא נמצאו תנועות למחיקה.';
  var row = ctx.row;
  var amt = _formatShekel(_BC_num_(row[BC_COL.AMOUNT]));
  var sub = String(row[BC_COL.SUBCATEGORY] || row[BC_COL.CATEGORY] || 'לא ידוע');
  try {
    ctx.sheet.deleteRow(ctx.sheetRow);
  } catch (e) {
    return BC_EMOJI.warn + ' שגיאה במחיקה: ' + (e && e.message ? e.message : String(e));
  }
  return BC_EMOJI.check + ' נמחק: ' + amt + ' · ' + sub;
}

function _BC_fixLastCategoryReply_(newCategoryRaw) {
  var newCat = String(newCategoryRaw || '').trim();
  if (!newCat) return BC_EMOJI.warn + ' חסר שם קטגוריה. דוגמה: תקן ל: אוכל בחוץ';
  var ctx = _BC_findLastRow_();
  if (!ctx) return BC_EMOJI.warn + ' אין תנועה אחרונה לעדכן.';
  try {
    // Update subcategory column (F) for the last row.
    ctx.sheet.getRange(ctx.sheetRow, BC_COL.SUBCATEGORY + 1).setValue(newCat);
  } catch (e) {
    return BC_EMOJI.warn + ' שגיאה בעדכון: ' + (e && e.message ? e.message : String(e));
  }
  var amt = _formatShekel(_BC_num_(ctx.row[BC_COL.AMOUNT]));
  return BC_EMOJI.check + ' עודכן: ' + amt + ' -> ' + newCat;
}

function _BC_deleteByTextReply_(needleRaw) {
  var needle = String(needleRaw || '').trim();
  if (!needle) return BC_EMOJI.warn + ' חסר טקסט לחיפוש.';
  var sh = _BC_sheet_();
  if (!sh) return BC_EMOJI.warn + ' לא נמצא גליון תנועות.';
  var last = sh.getLastRow();
  if (last < 2) return BC_EMOJI.warn + ' אין תנועות.';
  var values = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
  // Walk from bottom to top, delete first match.
  var lowNeedle = needle.toLowerCase();
  for (var i = values.length - 1; i >= 0; i--) {
    var raw = String(values[i][BC_COL.RAW_TEXT] || '').toLowerCase();
    var sub = String(values[i][BC_COL.SUBCATEGORY] || '').toLowerCase();
    if (raw.indexOf(lowNeedle) !== -1 || sub.indexOf(lowNeedle) !== -1) {
      var sheetRow = i + 2;
      var amt = _formatShekel(_BC_num_(values[i][BC_COL.AMOUNT]));
      var subDisp = String(values[i][BC_COL.SUBCATEGORY] || values[i][BC_COL.CATEGORY] || '');
      try {
        sh.deleteRow(sheetRow);
      } catch (e) {
        return BC_EMOJI.warn + ' שגיאה במחיקה: ' + (e && e.message ? e.message : String(e));
      }
      _BC_CACHE = null;
      return BC_EMOJI.check + ' נמחק: ' + amt + ' · ' + subDisp + ' · "' + needle + '"';
    }
  }
  return BC_EMOJI.warn + ' לא נמצאה תנועה התואמת ל"' + needle + '".';
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function _BC_statsReply_() {
  var rows = _BC_getExpenseRows_();
  var totalEntries = rows.length;
  if (totalEntries === 0) {
    return BC_EMOJI.chart + ' אין עדיין תנועות.';
  }
  var tz = _BC_tz_();
  var now = new Date();
  var ms = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  var monthRows = _dateRangeFilter(rows, ms, _BC_endOfDay_(now));
  var monthCount = monthRows.length;

  // Average per day across all rows (span = first row date -> today)
  var earliest = now;
  for (var i = 0; i < rows.length; i++) {
    var d = rows[i][BC_COL.TIMESTAMP];
    if (d instanceof Date && d.getTime() < earliest.getTime()) earliest = d;
  }
  var spanDays = Math.max(1, Math.round((now.getTime() - earliest.getTime()) / 86400000));
  var totalAll = _BC_sumAmounts_(rows);
  var avgPerDay = totalAll / spanDays;

  var byCat = _groupByCategory(rows);
  var busiest = (byCat.length > 0) ? byCat[0] : { name: 'לא ידוע', total: 0, count: 0 };

  var lines = [];
  lines.push(BC_EMOJI.chart + ' סטטיסטיקות');
  lines.push('סה"כ תנועות: ' + totalEntries);
  lines.push('החודש: ' + monthCount);
  lines.push('ממוצע ליום: ' + _formatShekel(avgPerDay));
  lines.push(BC_EMOJI.trophy + ' הקטגוריה הכי פעילה: ' + busiest.name + ' (' + busiest.count + ' תנועות)');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Sheet readers + helpers
// ---------------------------------------------------------------------------
function _BC_sheet_() {
  try {
    var ss = SpreadsheetApp.openById(BC_SHEET_ID);
    return ss.getSheetByName(BC_TX_SHEET);
  } catch (e) {
    return null;
  }
}

// Returns array of all expense rows (skips income rows). Each row is the raw
// values array from the sheet, indexed by BC_COL.*.
function _BC_getExpenseRows_() {
  if (_BC_CACHE) return _BC_CACHE;
  var sh = _BC_sheet_();
  if (!sh) { _BC_CACHE = []; return _BC_CACHE; }
  var last = sh.getLastRow();
  if (last < 2) { _BC_CACHE = []; return _BC_CACHE; }
  var width = Math.max(sh.getLastColumn(), BC_COL.MESSAGE_ID + 1);
  var values = sh.getRange(2, 1, last - 1, width).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!row[BC_COL.TIMESTAMP]) continue;
    var type = String(row[BC_COL.TYPE] || '').toLowerCase();
    if (type && BC_EXPENSE_TYPES.indexOf(type) === -1 && type !== '') {
      // Heuristic: if type contains "income" or "הכנסה", skip.
      if (type.indexOf('income') !== -1 || type.indexOf('הכנסה') !== -1) continue;
    }
    // Coerce timestamp to Date.
    if (!(row[BC_COL.TIMESTAMP] instanceof Date)) {
      var maybe = new Date(row[BC_COL.TIMESTAMP]);
      if (isNaN(maybe.getTime())) continue;
      row[BC_COL.TIMESTAMP] = maybe;
    }
    out.push(row);
  }
  _BC_CACHE = out;
  return out;
}

// Filter rows where timestamp falls inside [start, end] inclusive.
function _dateRangeFilter(rows, start, end) {
  var sMs = start.getTime();
  var eMs = end.getTime();
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var t = rows[i][BC_COL.TIMESTAMP];
    if (!(t instanceof Date)) continue;
    var ms = t.getTime();
    if (ms >= sMs && ms <= eMs) out.push(rows[i]);
  }
  return out;
}

// Sum the amount column.
function _BC_sumAmounts_(rows) {
  var sum = 0;
  for (var i = 0; i < rows.length; i++) {
    sum += _BC_num_(rows[i][BC_COL.AMOUNT]);
  }
  return sum;
}

// Group rows by subcategory (falling back to category). Returns array sorted
// desc by total.
function _groupByCategory(rows) {
  var map = {};
  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i][BC_COL.SUBCATEGORY] || rows[i][BC_COL.CATEGORY] || 'לא ידוע');
    if (!map[key]) map[key] = { name: key, total: 0, count: 0 };
    map[key].total += _BC_num_(rows[i][BC_COL.AMOUNT]);
    map[key].count += 1;
  }
  var arr = [];
  for (var k in map) if (map.hasOwnProperty(k)) arr.push(map[k]);
  arr.sort(function (a, b) { return b.total - a.total; });
  return arr;
}

// Match by raw text OR subcategory containing needle (case-insensitive).
function _BC_searchByText_(rows, needle) {
  var low = String(needle || '').toLowerCase();
  if (!low) return [];
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var raw = String(rows[i][BC_COL.RAW_TEXT] || '').toLowerCase();
    var sub = String(rows[i][BC_COL.SUBCATEGORY] || '').toLowerCase();
    var cat = String(rows[i][BC_COL.CATEGORY] || '').toLowerCase();
    if (raw.indexOf(low) !== -1 || sub.indexOf(low) !== -1 || cat.indexOf(low) !== -1) {
      out.push(rows[i]);
    }
  }
  return out;
}

// Find the last (most recent by timestamp) expense row + sheet row index.
function _BC_findLastRow_() {
  var sh = _BC_sheet_();
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;
  var width = Math.max(sh.getLastColumn(), BC_COL.MESSAGE_ID + 1);
  var values = sh.getRange(2, 1, last - 1, width).getValues();
  var bestIdx = -1;
  var bestMs = -Infinity;
  for (var i = 0; i < values.length; i++) {
    var t = values[i][BC_COL.TIMESTAMP];
    if (!t) continue;
    var d = (t instanceof Date) ? t : new Date(t);
    if (isNaN(d.getTime())) continue;
    if (d.getTime() > bestMs) { bestMs = d.getTime(); bestIdx = i; }
  }
  if (bestIdx === -1) return null;
  return { row: values[bestIdx], sheetRow: bestIdx + 2, sheet: sh };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function _formatShekel(n) {
  var v = _BC_num_(n);
  var rounded = Math.round(v);
  var s = String(Math.abs(rounded));
  // Add thousands separators.
  var withCommas = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (rounded < 0 ? '-' : '') + '₪' + withCommas;
}

function _BC_num_(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function _BC_tz_() {
  try { return SpreadsheetApp.openById(BC_SHEET_ID).getSpreadsheetTimeZone() || 'Asia/Jerusalem'; }
  catch (e) { return 'Asia/Jerusalem'; }
}

function _BC_fmtDate_(d, tz) {
  try { return Utilities.formatDate(d, tz || 'Asia/Jerusalem', 'dd/MM'); }
  catch (e) { return ''; }
}

function _BC_startOfDay_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function _BC_endOfDay_(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

// ---------------------------------------------------------------------------
// WhatsApp transport (wraps the existing Meta Graph API call). Returns
// { ok, code? , error? }.
// ---------------------------------------------------------------------------
function sendWhatsAppReply(toPhone, text) {
  var sp = PropertiesService.getScriptProperties();
  var token = sp.getProperty('WA_TOKEN') || '';
  var phoneId = sp.getProperty('WA_PHONE_ID') || '';
  var version = sp.getProperty('WA_GRAPH_VERSION') || 'v18.0';
  if (!token || !phoneId) {
    return { ok: false, error: 'missing_wa_credentials' };
  }
  var payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(toPhone),
    type: 'text',
    text: { body: String(text == null ? '' : text) }
  };
  var url = 'https://graph.facebook.com/' + version + '/' + phoneId + '/messages';
  var options = {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload)
  };
  try {
    var resp = UrlFetchApp.fetch(url, options);
    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) return { ok: true, code: code };
    return { ok: false, error: 'http_' + code, body: resp.getContentText() };
  } catch (e) {
    return { ok: false, error: 'fetch_threw:' + (e && e.message ? e.message : String(e)) };
  }
}

// ---------------------------------------------------------------------------
// Self-test (run from Apps Script editor). Logs each command's reply.
// ---------------------------------------------------------------------------
function TEST_BOT_COMMANDS() {
  var samples = [
    'עזרה',
    'help',
    '?',
    'היום?',
    'אתמול?',
    'השבוע?',
    'החודש?',
    'החודש שעבר?',
    'שנה?',
    'today?',
    'month?',
    'כמה הוצאתי על וולט?',
    'כמה על קפה?',
    'כמה הוצאתי על אוכל בחוץ?',
    'how much on coffee?',
    'סטטיסטיקות',
    'stats'
    // NOTE: UNDO / fix / delete commands skipped here to avoid mutating data.
  ];
  for (var i = 0; i < samples.length; i++) {
    var r = handleBotCommand_('+972500000000', samples[i]);
    Logger.log('--- ' + samples[i] + ' ---');
    Logger.log('handled=' + r.handled);
    if (r.handled) Logger.log(r.replyText);
  }
}
