// WEEKLY_DIGEST.gs - Sunday morning weekly digest for Kesefle WhatsApp bot.
// Purpose: every Sunday at 08:00 Asia/Jerusalem, push a Hebrew summary of the
// previous week (last 7 days) to subscribed users.
//
// Dependencies:
//   - BOT_COMMANDS.gs exports sendWhatsAppReply(toPhone, text)
//   - BOT_COMMANDS.gs exports _formatShekel, _dateRangeFilter, _groupByCategory
//   - 'תנועות' tab schema: A=timestamp, B=amount, C=currency, D=type,
//     E=category, F=subcategory, G=raw_text, H=source, I=message_id
//
// Public API:
//   INSTALL_WEEKLY_DIGEST_TRIGGER()    - create the Sunday 08:00 trigger
//   UNINSTALL_WEEKLY_DIGEST_TRIGGER()  - delete it
//   RUN_WEEKLY_DIGEST_NOW()            - manual fire for testing
//   _WEEKLY_DIGEST_HANDLER_()          - trigger entry point
//   _sendWeeklyDigestToPhone_(phone, sheetId)
//
// Subscriber discovery: Script Property SUBSCRIBERS holds a JSON array of
// E.164 phone strings, e.g. ["972500000000","972541234567"].
// TODO: migrate this to the KV-backed user registry once the bot's edge
// service exposes a list endpoint to Apps Script.
//
// Opt-out: a Script Property optout:<phone> with any truthy value (e.g. "1")
// suppresses delivery. This mirrors the KV key the edge service uses.
//
// ASCII-only comments. Hebrew text only inside string literals.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// 2026-05-29: was hardcoded to the OLD pre-migration sheet
// (1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo). If the
// Sunday 08:00 trigger fires while pointing at OLD, every
// subscriber receives stale data. Switched to the NEW Kesefle
// sheet. For multi-tenant the right answer is to resolve a
// per-subscriber sheet via _resolveTenant_, but the digest is
// currently owner-only so the NEW sheet is the right default.
var WD_SHEET_ID = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';
var WD_TX_SHEET = 'תנועות';
var WD_TRIGGER_HANDLER = '_WEEKLY_DIGEST_HANDLER_';
var WD_TZ = 'Asia/Jerusalem';

// Column indexes (0-based) inside the תנועות sheet. Mirrors BC_COL in
// BOT_COMMANDS.gs but kept local so this file is standalone-loadable.
var WD_COL = {
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

// Type values that count as expenses.
var WD_EXPENSE_TYPES = ['expense', 'הוצאה', 'business_expense', 'personal_expense'];

// Threshold: a category counts as a "spike" if last week's spend in it is
// more than this multiple of the user's per-week category average over the
// prior 4 weeks.
var WD_SPIKE_MULTIPLIER = 2.0;

// ---------------------------------------------------------------------------
// Trigger install / uninstall
// ---------------------------------------------------------------------------

// Install a time-driven trigger that runs every Sunday at 08:00.
// NOTE: Apps Script time triggers fire in the script's project timezone (set
// via File > Project Settings > Time Zone). Ensure the project timezone is
// Asia/Jerusalem; otherwise the 08:00 will be off.
function INSTALL_WEEKLY_DIGEST_TRIGGER() {
  UNINSTALL_WEEKLY_DIGEST_TRIGGER();
  ScriptApp.newTrigger(WD_TRIGGER_HANDLER)
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(8)
    .everyWeeks(1)
    .inTimezone(WD_TZ)
    .create();
  Logger.log('Weekly digest trigger installed (Sunday 08:00 ' + WD_TZ + ').');
  return { ok: true };
}

// Remove every trigger pointing at the digest handler.
function UNINSTALL_WEEKLY_DIGEST_TRIGGER() {
  var trigs = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < trigs.length; i++) {
    if (trigs[i].getHandlerFunction() === WD_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigs[i]);
      removed++;
    }
  }
  Logger.log('Weekly digest triggers removed: ' + removed);
  return { ok: true, removed: removed };
}

// Manual test entry point - run from the Apps Script editor.
function RUN_WEEKLY_DIGEST_NOW() {
  return _WEEKLY_DIGEST_HANDLER_({ manual: true });
}

// 2026-05-29 resweep R4: redact full E.164 phones in Logger.log output.
// Apps Script Stackdriver retains these for ~30 days; the bot's [KFL-TRACE]
// line already uses last-4 (see bot/ExpenseBot_FIXED.gs:257), this matches
// that pattern.
function _WD_phoneTail_(p) {
  return '...' + String(p || '').slice(-4);
}

// ---------------------------------------------------------------------------
// Trigger handler: iterate subscribers, dispatch per-user digests.
// ---------------------------------------------------------------------------
function _WEEKLY_DIGEST_HANDLER_(_event) {
  var subscribers = _WD_loadSubscribers_();
  if (subscribers.length === 0) {
    Logger.log('Weekly digest: no subscribers configured. Set Script Property SUBSCRIBERS to a JSON array of phone numbers.');
    return { ok: true, sent: 0, skipped: 0, errors: 0 };
  }
  var sent = 0, skipped = 0, errors = 0;
  for (var i = 0; i < subscribers.length; i++) {
    var phone = subscribers[i];
    try {
      var res = _sendWeeklyDigestToPhone_(phone, WD_SHEET_ID);
      if (res.sent) sent++;
      else skipped++;
      Logger.log('Digest ' + _WD_phoneTail_(phone) + ': ' + JSON.stringify(res));
    } catch (e) {
      errors++;
      Logger.log('Digest ' + _WD_phoneTail_(phone) + ' threw: ' + (e && e.message ? e.message : String(e)));
    }
  }
  return { ok: true, sent: sent, skipped: skipped, errors: errors };
}

// 2026-05-31 audit follow-up (docs/AUDIT_WEEKLY_DIGEST_AND_CRONS_2026_05_31.md §4):
// Defensive owner-phone allowlist. WD_SHEET_ID is hardcoded to Steven's NEW
// sheet, so every subscriber received Steven's data. The SUBSCRIBERS Script
// Property is owner-only by design, but the TODO at line 20 flags that we'll
// add per-tenant resolution later. Until then this allowlist makes the
// cross-tenant leak class impossible if SUBSCRIBERS is ever updated by
// accident or by future code. Add a phone here only after confirming it
// should receive Steven's sheet contents.
var WD_OWNER_PHONES = ['972547760643'];

// ---------------------------------------------------------------------------
// Per-user digest builder + sender.
// Returns: { sent: bool, reason?: string, replyText?: string, transport?: any }
// ---------------------------------------------------------------------------
function _sendWeeklyDigestToPhone_(phone, sheetId) {
  var phoneStr = String(phone == null ? '' : phone).trim();
  if (!phoneStr) return { sent: false, reason: 'empty_phone' };

  if (WD_OWNER_PHONES.indexOf(phoneStr) === -1) {
    Logger.log('Weekly digest: ' + _WD_phoneTail_(phoneStr) + ' not in WD_OWNER_PHONES allowlist; skipping.');
    return { sent: false, reason: 'not_owner_phone' };
  }

  if (_WD_isOptedOut_(phoneStr)) {
    return { sent: false, reason: 'opted_out' };
  }

  var rows = _WD_getRows_(sheetId);
  if (rows.length === 0) {
    return { sent: false, reason: 'no_data' };
  }

  var now = new Date();
  var lastWeek = _WD_weekRange_(now, 0);          // [-7d, now]
  var prevWeek = _WD_weekRange_(now, 1);          // [-14d, -7d]
  var prior4w = _WD_priorWindow_(now, 28, 7);     // [-35d, -7d] for category baseline

  var lastWeekRows = _dateRangeFilter(rows, lastWeek.start, lastWeek.end);
  if (lastWeekRows.length === 0) {
    return { sent: false, reason: 'zero_transactions_this_week' };
  }

  var prevWeekRows = _dateRangeFilter(rows, prevWeek.start, prevWeek.end);
  var priorRows = _dateRangeFilter(rows, prior4w.start, prior4w.end);

  var lastIncome = _WD_sumByType_(lastWeekRows, 'income');
  var lastExpense = _WD_sumByType_(lastWeekRows, 'expense');
  var lastIncCount = _WD_countByType_(lastWeekRows, 'income');
  var lastExpCount = _WD_countByType_(lastWeekRows, 'expense');
  var balance = lastIncome.total - lastExpense.total;

  var prevExpense = _WD_sumByType_(prevWeekRows, 'expense').total;
  var deltaPct = _WD_pctDelta_(lastExpense.total, prevExpense);

  // Top category among last-week expenses only.
  var lastWeekExpenseRows = _WD_filterByType_(lastWeekRows, 'expense');
  var byCat = _groupByCategory(lastWeekExpenseRows);
  var topCat = byCat.length > 0 ? byCat[0] : null;

  // Spike detection: any category whose last-week spend exceeds
  // WD_SPIKE_MULTIPLIER * (priorRows weekly avg in that category).
  var spike = _WD_detectSpike_(lastWeekExpenseRows, priorRows);

  var replyText = _WD_renderDigest_({
    rangeLabel: _WD_rangeLabel_(lastWeek.start, lastWeek.end),
    income: lastIncome.total,
    incomeCount: lastIncCount,
    expense: lastExpense.total,
    expenseCount: lastExpCount,
    balance: balance,
    topCategory: topCat,
    deltaPct: deltaPct,
    deltaKnown: prevExpense > 0,
    spike: spike
  });

  var transport;
  try {
    transport = sendWhatsAppReply(phoneStr, replyText);
  } catch (e) {
    return { sent: false, reason: 'send_threw:' + (e && e.message ? e.message : String(e)), replyText: replyText };
  }
  if (!transport || transport.ok !== true) {
    return { sent: false, reason: 'send_failed', transport: transport, replyText: replyText };
  }
  return { sent: true, replyText: replyText, transport: transport };
}

// ---------------------------------------------------------------------------
// Digest text renderer (Hebrew).
// ---------------------------------------------------------------------------
function _WD_renderDigest_(ctx) {
  var L = [];
  L.push('🌅 בוקר טוב!');
  L.push('📊 שבוע שעבר (' + ctx.rangeLabel + '):');
  L.push('🟢 הכנסה: ' + _formatShekel(ctx.income) + ' (' + ctx.incomeCount + ' תנועות)');
  L.push('🔴 הוצאה: ' + _formatShekel(ctx.expense) + ' (' + ctx.expenseCount + ' תנועות)');
  L.push('💰 יתרה: ' + _formatShekel(ctx.balance));
  L.push('');

  if (ctx.topCategory) {
    L.push('🏆 קטגוריה מובילה: ' + ctx.topCategory.name + ' (' + _formatShekel(ctx.topCategory.total) + ')');
  }
  if (ctx.deltaKnown) {
    var sign = ctx.deltaPct > 0 ? '+' : '';
    L.push('📈 שינוי vs השבוע שעבר: ' + sign + ctx.deltaPct + '%');
  } else {
    L.push('📈 שינוי vs השבוע שעבר: אין נתון להשוואה');
  }
  L.push('');

  // Tone: encouragement if expenses dropped, gentle nudge if rose sharply.
  if (ctx.deltaKnown && ctx.deltaPct <= -10) {
    L.push('כל הכבוד, ירידה יפה בהוצאות השבוע! 💪');
  } else if (ctx.deltaKnown && ctx.deltaPct >= 25) {
    L.push('שים לב, ההוצאות עלו משמעותית השבוע. שווה לעבור על העסקאות.');
  } else if (ctx.spike) {
    L.push('שים לב: ' + ctx.spike.name + ' היה השבוע ' + ctx.spike.ratio + '× מהממוצע השבועי שלך.');
  } else {
    L.push('שבוע מאוזן. ממשיכים. ✨');
  }

  L.push('');
  L.push('🤖 שלח \'החודש?\' לסיכום חודשי');
  L.push('שלח \'עצור\' כדי לא לקבל יותר');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Subscribers + opt-out (Script Properties based; TODO migrate to KV).
// ---------------------------------------------------------------------------
function _WD_loadSubscribers_() {
  var sp = PropertiesService.getScriptProperties();
  var raw = sp.getProperty('SUBSCRIBERS') || '';
  if (!raw) return [];
  try {
    var arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = String(arr[i] || '').trim();
      if (v) out.push(v);
    }
    return out;
  } catch (e) {
    Logger.log('SUBSCRIBERS JSON parse error: ' + (e && e.message ? e.message : String(e)));
    return [];
  }
}

function _WD_isOptedOut_(phone) {
  var sp = PropertiesService.getScriptProperties();
  var v = sp.getProperty('optout:' + phone);
  return !!(v && String(v).trim());
}

// ---------------------------------------------------------------------------
// Sheet read + classification.
// ---------------------------------------------------------------------------
function _WD_getRows_(sheetId) {
  try {
    var ss = SpreadsheetApp.openById(sheetId);
    var sh = ss.getSheetByName(WD_TX_SHEET);
    if (!sh) return [];
    var last = sh.getLastRow();
    if (last < 2) return [];
    var width = Math.max(sh.getLastColumn(), WD_COL.MESSAGE_ID + 1);
    var values = sh.getRange(2, 1, last - 1, width).getValues();
    var out = [];
    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      if (!row[WD_COL.TIMESTAMP]) continue;
      if (!(row[WD_COL.TIMESTAMP] instanceof Date)) {
        var maybe = new Date(row[WD_COL.TIMESTAMP]);
        if (isNaN(maybe.getTime())) continue;
        row[WD_COL.TIMESTAMP] = maybe;
      }
      out.push(row);
    }
    return out;
  } catch (e) {
    Logger.log('WD_getRows error: ' + (e && e.message ? e.message : String(e)));
    return [];
  }
}

// Returns 'income' | 'expense' | 'other' for a row.
function _WD_classifyRow_(row) {
  var type = String(row[WD_COL.TYPE] || '').toLowerCase();
  if (!type) return 'expense'; // default: treat unlabeled as expense
  if (type.indexOf('income') !== -1 || type.indexOf('הכנסה') !== -1) return 'income';
  if (WD_EXPENSE_TYPES.indexOf(type) !== -1) return 'expense';
  return 'other';
}

function _WD_filterByType_(rows, kind) {
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (_WD_classifyRow_(rows[i]) === kind) out.push(rows[i]);
  }
  return out;
}

function _WD_sumByType_(rows, kind) {
  var sum = 0, n = 0;
  for (var i = 0; i < rows.length; i++) {
    if (_WD_classifyRow_(rows[i]) !== kind) continue;
    sum += _WD_num_(rows[i][WD_COL.AMOUNT]);
    n++;
  }
  return { total: sum, count: n };
}

function _WD_countByType_(rows, kind) {
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    if (_WD_classifyRow_(rows[i]) === kind) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Time windows + math helpers.
// ---------------------------------------------------------------------------

// weekBackIdx = 0 -> last 7 days; 1 -> the 7 days before that, etc.
function _WD_weekRange_(now, weekBackIdx) {
  var end = new Date(now.getTime() - (weekBackIdx * 7 * 86400000));
  var start = new Date(end.getTime() - (7 * 86400000));
  return { start: start, end: end };
}

// Window of `windowDays` days ending `offsetDays` days ago.
// Used to build the prior-4-weeks baseline excluding the most recent week.
function _WD_priorWindow_(now, windowDays, offsetDays) {
  var end = new Date(now.getTime() - (offsetDays * 86400000));
  var start = new Date(end.getTime() - (windowDays * 86400000));
  return { start: start, end: end };
}

function _WD_pctDelta_(curr, prev) {
  if (!prev || prev === 0) return 0;
  var d = ((curr - prev) / prev) * 100;
  return Math.round(d);
}

// Returns {name, ratio} for the worst spike, or null if none.
// ratio is rounded to 1 decimal place. priorRows covers ~4 weeks, so the
// per-week average is sumInCategory / 4.
function _WD_detectSpike_(lastWeekExpenseRows, priorRows) {
  var priorExpenses = _WD_filterByType_(priorRows, 'expense');
  if (priorExpenses.length === 0) return null;

  var priorByCat = _groupByCategory(priorExpenses);
  var priorMap = {};
  for (var i = 0; i < priorByCat.length; i++) {
    priorMap[priorByCat[i].name] = priorByCat[i].total / 4.0; // weekly avg
  }

  var lastByCat = _groupByCategory(lastWeekExpenseRows);
  var worst = null;
  for (var j = 0; j < lastByCat.length; j++) {
    var name = lastByCat[j].name;
    var lastTot = lastByCat[j].total;
    var avg = priorMap[name];
    if (!avg || avg <= 0) continue;
    var ratio = lastTot / avg;
    if (ratio >= WD_SPIKE_MULTIPLIER) {
      if (!worst || ratio > worst.ratio) {
        worst = { name: name, ratio: Math.round(ratio * 10) / 10 };
      }
    }
  }
  return worst;
}

function _WD_rangeLabel_(start, end) {
  var s = Utilities.formatDate(start, WD_TZ, 'd');
  var e = Utilities.formatDate(end, WD_TZ, 'd');
  var monthHe = _WD_hebrewMonth_(end);
  return s + '-' + e + ' ב' + monthHe;
}

function _WD_hebrewMonth_(d) {
  var names = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  return names[d.getMonth()] || '';
}

function _WD_num_(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  var n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// Self-test helpers (run from Apps Script editor).
// ---------------------------------------------------------------------------

// Dry-run the digest builder for a phone without sending. Logs the message
// that WOULD be sent.
function TEST_WEEKLY_DIGEST_RENDER() {
  var subs = _WD_loadSubscribers_();
  var phone = subs.length > 0 ? subs[0] : '+972500000000';
  var rows = _WD_getRows_(WD_SHEET_ID);
  var now = new Date();
  var lastWeek = _WD_weekRange_(now, 0);
  var prevWeek = _WD_weekRange_(now, 1);
  var prior4w = _WD_priorWindow_(now, 28, 7);
  var lastWeekRows = _dateRangeFilter(rows, lastWeek.start, lastWeek.end);
  var prevWeekRows = _dateRangeFilter(rows, prevWeek.start, prevWeek.end);
  var priorRows = _dateRangeFilter(rows, prior4w.start, prior4w.end);
  var lastWeekExpenseRows = _WD_filterByType_(lastWeekRows, 'expense');
  var lastIncome = _WD_sumByType_(lastWeekRows, 'income');
  var lastExpense = _WD_sumByType_(lastWeekRows, 'expense');
  var prevExpense = _WD_sumByType_(prevWeekRows, 'expense').total;
  var deltaPct = _WD_pctDelta_(lastExpense.total, prevExpense);
  var byCat = _groupByCategory(lastWeekExpenseRows);
  var topCat = byCat.length > 0 ? byCat[0] : null;
  var spike = _WD_detectSpike_(lastWeekExpenseRows, priorRows);
  var text = _WD_renderDigest_({
    rangeLabel: _WD_rangeLabel_(lastWeek.start, lastWeek.end),
    income: lastIncome.total,
    incomeCount: _WD_countByType_(lastWeekRows, 'income'),
    expense: lastExpense.total,
    expenseCount: _WD_countByType_(lastWeekRows, 'expense'),
    balance: lastIncome.total - lastExpense.total,
    topCategory: topCat,
    deltaPct: deltaPct,
    deltaKnown: prevExpense > 0,
    spike: spike
  });
  // 2026-05-29 resweep R4: redact full E.164 phone.
  Logger.log('--- digest preview for ' + _WD_phoneTail_(phone) + ' ---');
  Logger.log(text);
  return text;
}
