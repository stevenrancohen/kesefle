// PERSONALIZED_LEARNING.gs
// Per-user "teach the bot" layer. When a user resolves a dropdown ambiguity,
// we persist {phone, text_substring, category_key, subcategory, timestamp} so
// future messages with similar substrings are auto-classified WITHOUT keyword
// matching or LLM calls.
//
// FLOW:
//   1. handleUserClassificationReply_ (in DROPDOWN_FOR_UNSURE.gs) calls
//      recordUserCorrection_(phone, originalText, resolved) right after the
//      resolved struct is written to תנועות. We pull the salient tokens from
//      originalText (longest non-numeric ones), store one row per pending text.
//   2. doPost calls classifyWithPersonalLearning_(phone, text) BEFORE
//      _SRC_classify_v2_. If any past correction by this phone has a stored
//      token that appears in the new text, we short-circuit and return the
//      saved classification. Token-level rather than full-string matching is
//      what gives the "personal slang" effect.
//   3. The _CORRECTIONS_ tab is human-readable so the user can edit/delete
//      bad teachings directly. We also expose deleteUserCorrection_ for
//      programmatic cleanup.
//
// SHEET SCHEMA (_CORRECTIONS_):
//   A timestamp | B phone | C original_text | D learn_tokens (csv) |
//   E category | F subcategory | G routes_to | H is_income | I sheet | J active
//
// COST: zero. Pure spreadsheet lookup, cached in memory per execution.
//
// SAFETY:
//   - Per-user scoping: a correction by phone A never affects phone B. Eliminates
//     the "Steven types X meaning groceries, partner types X meaning meds" risk.
//   - active=FALSE row excluded from lookups. User can soft-delete by toggling.
//   - Min token length 3 to avoid matching single-char noise like punctuation.
//   - Skip numeric-only tokens and stopwords (Hebrew + English).
//   - Maximum 500 active corrections per user - older rows soft-archived to a
//     companion tab _CORRECTIONS_ARCHIVE_ to keep lookup O(n) bounded.
//
// ASCII-only comments. Hebrew lives only in string literals.

var _CORR_TAB = '_CORRECTIONS_';
var _CORR_ARCHIVE_TAB = '_CORRECTIONS_ARCHIVE_';
var _CORR_MAX_PER_USER = 500;
var _CORR_MIN_TOKEN_LEN = 3;
var _CORR_CACHE_TTL_S = 60;

// Stopwords - tokens we never store/match on. Keep tight.
var _CORR_STOPWORDS = {
  'של': 1, 'את': 1, 'על': 1, 'גם': 1, 'אני': 1, 'אנחנו': 1, 'הוא': 1, 'היא': 1, 'זה': 1,
  'אבל': 1, 'או': 1, 'כי': 1, 'אם': 1, 'אז': 1, 'יש': 1, 'אין': 1, 'לא': 1, 'כן': 1,
  'מאוד': 1, 'יותר': 1, 'פחות': 1, 'עוד': 1,
  'the': 1, 'and': 1, 'for': 1, 'with': 1, 'this': 1, 'that': 1, 'have': 1, 'just': 1,
  'from': 1, 'paid': 1, 'bought': 1, 'spent': 1
};

// Public entry point - call this BEFORE _SRC_classify_v2_.
function classifyWithPersonalLearning_(phone, text) {
  if (!phone || !text) return null;
  var rows = _corrLoadForPhone_(phone);
  if (!rows.length) return null;
  var clean = String(text).toLowerCase().replace(/[\d,.]+\s*(?:שח|ש"ח|ש״ח|₪|nis|ils|שקל)?/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  // Iterate newest first - latest teach wins on ambiguity.
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i];
    if (!r.active) continue;
    if (!r.learnTokens || !r.learnTokens.length) continue;
    var matchedToken = null;
    for (var j = 0; j < r.learnTokens.length; j++) {
      var tk = r.learnTokens[j];
      if (tk && clean.indexOf(tk) >= 0) { matchedToken = tk; break; }
    }
    if (!matchedToken) continue;
    var amtMatch = String(text).match(/([\d,]+(?:\.\d+)?)\s*(?:שח|ש"ח|ש״ח|₪|nis|ils|שקל)?/i);
    var amount = amtMatch ? parseFloat(amtMatch[1].replace(/,/g, '')) : null;
    return {
      category: r.category,
      subcategory: r.subcategory,
      routes_to: r.routesTo,
      sheet: r.sheet,
      is_income: !!r.isIncome,
      confidence: 95,
      matched_keyword: '[personal:' + matchedToken + ']',
      amount: amount,
      is_biz_prefixed: /^(עסק|biz|business|work)/i.test(String(text)),
      needs_question: false,
      via: 'personal_learning'
    };
  }
  return null;
}

// Call from handleUserClassificationReply_ after the row is written.
// originalText: the raw message that triggered the dropdown.
// resolved: the struct the user picked (must have category, subcategory,
// routes_to, sheet, is_income).
function recordUserCorrection_(phone, originalText, resolved) {
  if (!phone || !originalText || !resolved || !resolved.category) return;
  var tokens = _corrExtractTokens_(originalText);
  if (!tokens.length) return;
  try {
    var sh = _corrEnsureSheet_();
    sh.appendRow([
      new Date(),
      String(phone),
      String(originalText),
      tokens.join(','),
      resolved.category || '',
      resolved.subcategory || '',
      resolved.routes_to || '',
      resolved.is_income ? 'TRUE' : 'FALSE',
      resolved.sheet || '',
      'TRUE'
    ]);
    _corrInvalidateCache_(phone);
    _corrTrimUser_(phone);
  } catch (err) {
    Logger.log('[LEARN] record failed: ' + err);
  }
}

// Soft-delete a teaching by row id (1-indexed within the sheet incl header).
function deleteUserCorrection_(rowNumber) {
  try {
    var sh = _corrEnsureSheet_();
    if (rowNumber < 2 || rowNumber > sh.getLastRow()) return false;
    sh.getRange(rowNumber, 10).setValue('FALSE');
    _corrInvalidateCacheAll_();
    return true;
  } catch (err) {
    Logger.log('[LEARN] delete failed: ' + err);
    return false;
  }
}

// --- internals -----------------------------------------------------------

function _corrEnsureSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(_CORR_TAB);
  if (!sh) {
    sh = ss.insertSheet(_CORR_TAB);
    sh.getRange(1, 1, 1, 10).setValues([['timestamp', 'phone', 'original_text', 'learn_tokens', 'category', 'subcategory', 'routes_to', 'is_income', 'sheet', 'active']]);
    sh.setFrozenRows(1);
    sh.hideSheet();
  }
  return sh;
}

function _corrExtractTokens_(text) {
  // Split on whitespace and punctuation, lowercase, drop short/numeric/stopword.
  var raw = String(text).toLowerCase().split(/[\s,.;:!?\-­־׀׳״"'()\[\]{}\/\\|<>]+/);
  var out = [];
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var tk = raw[i].trim();
    if (!tk || tk.length < _CORR_MIN_TOKEN_LEN) continue;
    if (/^[\d.,]+$/.test(tk)) continue;
    if (/^(שח|nis|ils|שקל)$/i.test(tk)) continue;
    if (_CORR_STOPWORDS[tk]) continue;
    if (seen[tk]) continue;
    seen[tk] = 1;
    out.push(tk);
    if (out.length >= 8) break; // cap per row to keep scans cheap
  }
  // Sort by length desc - longer tokens are more discriminating, matched first.
  out.sort(function (a, b) { return b.length - a.length; });
  return out;
}

// In-execution cache - lifetime of one invocation. For cross-invocation cache,
// use CacheService.getScriptCache() with a TTL, but per-user list is small.
var _corrMemCache = {};

function _corrLoadForPhone_(phone) {
  var key = String(phone);
  if (_corrMemCache[key] && (Date.now() - _corrMemCache[key].ts) < _CORR_CACHE_TTL_S * 1000) {
    return _corrMemCache[key].rows;
  }
  var rows = [];
  try {
    var sh = _corrEnsureSheet_();
    var last = sh.getLastRow();
    if (last < 2) {
      _corrMemCache[key] = { ts: Date.now(), rows: rows };
      return rows;
    }
    var values = sh.getRange(2, 1, last - 1, 10).getValues();
    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      if (String(row[1]) !== key) continue;
      rows.push({
        rowNumber: i + 2,
        timestamp: row[0],
        phone: row[1],
        originalText: row[2],
        learnTokens: String(row[3] || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean),
        category: row[4],
        subcategory: row[5],
        routesTo: row[6],
        isIncome: String(row[7]).toUpperCase() === 'TRUE',
        sheet: row[8],
        active: String(row[9]).toUpperCase() === 'TRUE'
      });
    }
  } catch (err) {
    Logger.log('[LEARN] load failed: ' + err);
  }
  _corrMemCache[key] = { ts: Date.now(), rows: rows };
  return rows;
}

function _corrInvalidateCache_(phone) {
  delete _corrMemCache[String(phone)];
}

function _corrInvalidateCacheAll_() {
  _corrMemCache = {};
}

function _corrTrimUser_(phone) {
  // If a user crosses _CORR_MAX_PER_USER active rows, move the oldest excess
  // to the archive tab. Keeps the hot lookup path bounded.
  try {
    var rows = _corrLoadForPhone_(phone);
    var active = rows.filter(function (r) { return r.active; });
    if (active.length <= _CORR_MAX_PER_USER) return;
    var sh = _corrEnsureSheet_();
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var arc = ss.getSheetByName(_CORR_ARCHIVE_TAB);
    if (!arc) {
      arc = ss.insertSheet(_CORR_ARCHIVE_TAB);
      arc.getRange(1, 1, 1, 10).setValues([['timestamp', 'phone', 'original_text', 'learn_tokens', 'category', 'subcategory', 'routes_to', 'is_income', 'sheet', 'active']]);
      arc.hideSheet();
    }
    var overflow = active.length - _CORR_MAX_PER_USER;
    // active is in append order, oldest first.
    for (var i = 0; i < overflow; i++) {
      var r = active[i];
      arc.appendRow([r.timestamp, r.phone, r.originalText, (r.learnTokens || []).join(','), r.category, r.subcategory, r.routesTo, r.isIncome ? 'TRUE' : 'FALSE', r.sheet, 'FALSE']);
      sh.getRange(r.rowNumber, 10).setValue('FALSE');
    }
    _corrInvalidateCache_(phone);
  } catch (err) {
    Logger.log('[LEARN] trim failed: ' + err);
  }
}

// Manual tests - run from the Apps Script editor.
function TEST_LEARN_ROUNDTRIP() {
  var phone = '+972555550123';
  recordUserCorrection_(phone, 'הזמנתי טוקיוקיו 86', {
    category: 'אוכל', subcategory: 'אוכל בחוץ', routes_to: 'personal',
    sheet: 'תנועות', is_income: false
  });
  var r = classifyWithPersonalLearning_(phone, 'טוקיוקיו 110 משלוח');
  Logger.log('after teach: ' + (r ? r.subcategory + ' via=' + r.via : 'null'));
  var rOther = classifyWithPersonalLearning_('+972555559999', 'טוקיוקיו 110');
  Logger.log('other phone: ' + (rOther ? r.subcategory : 'null - good, scoped per user'));
}

function TEST_LEARN_TOKEN_EXTRACT() {
  var samples = ['קניתי בטוקיוקיו 86 שח', 'paid 42 at the local cafe', 'עסק 300 פייסבוק מודעות'];
  for (var i = 0; i < samples.length; i++) {
    Logger.log(samples[i] + ' -> [' + _corrExtractTokens_(samples[i]).join(', ') + ']');
  }
}
