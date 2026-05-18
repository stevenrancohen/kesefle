// ============================================================
// KESEFLE BOT TEST SUITE
// ============================================================
// Self-contained automated regression suite for ExpenseBot_FIXED.gs.
//
// HOW TO USE
//   1. In the Apps Script editor, add a new file called TEST_SUITE.gs.
//   2. Paste the contents of this file into it.
//   3. Pick `runAllBotTests` from the function dropdown and click Run.
//   4. Watch the Execution log. The last lines summarize pass/fail counts.
//
// WHAT IT DOES
//   - Tests the parser (parseAmountAndDescription, parseForeignCurrencyHint).
//   - Tests category resolution (matchCategory, matchCategorySmart) using the
//     1,480-word keyword map. No network calls — _aiCategorize is stubbed so
//     even ambiguous text falls back to the keyword/default path.
//   - Tests every read-only command dispatcher (status, help, summary,
//     goals, learning, budgets, timezone, subscriptions, anomalies).
//   - Tests format helpers (_progressBar_, _vendorEmoji_, _kfl_fxLookup).
//   - Tests edge cases (empty text, gibberish, very long input, mixed
//     Hebrew/English, multiple amounts in one message).
//
// WHAT IT DOES NOT DO
//   - Never calls Meta's Cloud API. sendWhatsAppMessage and
//     sendWhatsAppInteractiveList are monkey-patched to push into an
//     in-memory `__captured` array. Captures restored at the end.
//   - Never writes to the sheet via processExpense — tests stop at the
//     parser level. Anything heavier than that would mutate the user's
//     real data, which we explicitly do not want.
//   - Never calls Anthropic — _aiCategorize is replaced with a stub that
//     returns null for the duration of the run.
//
// CONSTRAINTS
//   - Single file, no external libraries (Apps Script has no npm).
//   - All helpers prefixed with `_t` to avoid clashing with ExpenseBot.gs.
//   - Test functions prefixed `test*`. Names checked against the
//     existing _testSetup / _testAnomalyDetection etc. — no clashes.
//   - Designed to run in under 30s. The full suite (no network) finishes
//     in well under 5 seconds on a normal Apps Script account.
// ============================================================

// ---------- Test framework ----------

var __testResults = { passed: 0, failed: 0, errors: [] };
var __captured = [];
var __originalSendWA = null;
var __originalSendList = null;
var __originalAiCat = null;

function _t(name, fn) {
  try {
    fn();
    __testResults.passed++;
    Logger.log('  PASS ' + name);
  } catch (e) {
    __testResults.failed++;
    __testResults.errors.push({ name: name, error: (e && e.message) || String(e) });
    Logger.log('  FAIL ' + name + ' -- ' + ((e && e.message) || e));
  }
}

function _eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

function _approxEq(actual, expected, tolerance, msg) {
  tolerance = tolerance || 0.01;
  if (Math.abs(Number(actual) - Number(expected)) > tolerance) {
    throw new Error((msg || 'approxEq') + ': expected ~' + expected + ' (tol ' + tolerance + '), got ' + actual);
  }
}

function _contains(str, substr, msg) {
  if (String(str || '').indexOf(substr) < 0) {
    var preview = String(str || '').slice(0, 120).replace(/\n/g, ' / ');
    throw new Error((msg || 'contains') + ': "' + substr + '" not in "' + preview + '..."');
  }
}

function _notContains(str, substr, msg) {
  if (String(str || '').indexOf(substr) >= 0) {
    throw new Error((msg || 'notContains') + ': "' + substr + '" unexpectedly found');
  }
}

function _truthy(value, msg) {
  if (!value) throw new Error((msg || 'truthy') + ': value was falsy: ' + JSON.stringify(value));
}

function _falsy(value, msg) {
  if (value) throw new Error((msg || 'falsy') + ': value was truthy: ' + JSON.stringify(value));
}

function _hasFn(name) {
  return typeof this[name] === 'function' || (typeof globalThis !== 'undefined' && typeof globalThis[name] === 'function');
}

// Sets up monkey-patches that prevent network calls.
function _tInstallMocks() {
  __captured = [];
  try {
    if (typeof sendWhatsAppMessage === 'function') {
      __originalSendWA = sendWhatsAppMessage;
      sendWhatsAppMessage = function(to, text) {
        __captured.push({ kind: 'text', to: to, text: text });
      };
    }
  } catch (e) { Logger.log('mock sendWhatsAppMessage failed: ' + e.message); }

  try {
    if (typeof sendWhatsAppInteractiveList === 'function') {
      __originalSendList = sendWhatsAppInteractiveList;
      sendWhatsAppInteractiveList = function(to, header, body, footer, btn, sections) {
        __captured.push({ kind: 'list', to: to, header: header, body: body, sections: sections });
      };
    }
  } catch (e) { Logger.log('mock sendWhatsAppInteractiveList failed: ' + e.message); }

  // Force _aiCategorize to return null so matchCategorySmart never hits the
  // Anthropic API. Tests must be deterministic and offline.
  try {
    if (typeof _aiCategorize === 'function') {
      __originalAiCat = _aiCategorize;
      _aiCategorize = function() { return null; };
    }
  } catch (e) { Logger.log('mock _aiCategorize failed: ' + e.message); }
}

function _tRestoreMocks() {
  try { if (__originalSendWA) sendWhatsAppMessage = __originalSendWA; } catch (e) {}
  try { if (__originalSendList) sendWhatsAppInteractiveList = __originalSendList; } catch (e) {}
  try { if (__originalAiCat) _aiCategorize = __originalAiCat; } catch (e) {}
  __originalSendWA = null;
  __originalSendList = null;
  __originalAiCat = null;
}

// ---------- Entry point ----------

function runAllBotTests() {
  Logger.log('==============================================');
  Logger.log(' KESEFLE BOT TEST SUITE');
  Logger.log('==============================================');
  __testResults = { passed: 0, failed: 0, errors: [] };
  _tInstallMocks();

  try {
    Logger.log('');
    Logger.log('-- PARSER TESTS --');
    testParser();

    Logger.log('');
    Logger.log('-- CATEGORY RESOLUTION TESTS --');
    testCategoryResolution();

    Logger.log('');
    Logger.log('-- COMMAND DISPATCHER TESTS --');
    testCommands();

    Logger.log('');
    Logger.log('-- HELPER TESTS --');
    testHelpers();

    Logger.log('');
    Logger.log('-- EDGE CASE TESTS --');
    testEdgeCases();
  } finally {
    _tRestoreMocks();
  }

  Logger.log('');
  Logger.log('==============================================');
  Logger.log(' SUMMARY: ' + __testResults.passed + ' passed, ' + __testResults.failed + ' failed');
  Logger.log('==============================================');
  if (__testResults.failed > 0) {
    Logger.log('');
    Logger.log('Failures:');
    for (var i = 0; i < __testResults.errors.length; i++) {
      Logger.log('  - ' + __testResults.errors[i].name + ': ' + __testResults.errors[i].error);
    }
  }
  return __testResults;
}

// ---------- 1. PARSER TESTS ----------

function testParser() {
  _t('parseAmountAndDescription: "245 sofer" parses amount 245', function() {
    if (typeof parseAmountAndDescription !== 'function') throw new Error('parseAmountAndDescription not defined');
    var r = parseAmountAndDescription('245 ' + 'סופר');
    _truthy(r && r.items && r.items.length === 1, 'parsed 1 item');
    _eq(r.items[0].amount, 245, 'amount');
    _contains(r.items[0].description, 'סופר', 'description has Hebrew word');
  });

  _t('parseAmountAndDescription: "1800 arnona"', function() {
    var r = parseAmountAndDescription('1800 ' + 'ארנונה');
    _truthy(r && r.items.length === 1);
    _eq(r.items[0].amount, 1800);
  });

  _t('parseAmountAndDescription: decimal "42.5 cafe"', function() {
    var r = parseAmountAndDescription('42.5 ' + 'קפה ארומה');
    _truthy(r && r.items.length === 1);
    _eq(r.items[0].amount, 42.5);
  });

  _t('parseAmountAndDescription: comma decimal "42,5 cafe"', function() {
    var r = parseAmountAndDescription('42,5 ' + 'קפה');
    _truthy(r);
    _eq(r.items[0].amount, 42.5);
  });

  _t('parseAmountAndDescription: only number falls back to default desc', function() {
    var r = parseAmountAndDescription('500');
    _truthy(r);
    _eq(r.items[0].amount, 500);
    // Description must NOT be empty
    _truthy(r.items[0].description && r.items[0].description.length > 0, 'desc not empty');
  });

  _t('parseAmountAndDescription: empty string returns null', function() {
    var r = parseAmountAndDescription('');
    _falsy(r);
  });

  _t('parseAmountAndDescription: whitespace returns null', function() {
    var r = parseAmountAndDescription('     \t  ');
    _falsy(r);
  });

  _t('parseAmountAndDescription: only Hebrew word returns null', function() {
    var r = parseAmountAndDescription('סופר');
    _falsy(r, 'no amount = no parse');
  });

  _t('parseAmountAndDescription: gibberish without numbers returns null', function() {
    var r = parseAmountAndDescription('xyzlmnab qwerty');
    _falsy(r);
  });

  _t('parseAmountAndDescription: zero amount filtered out', function() {
    var r = parseAmountAndDescription('0 ' + 'בדיקה');
    // 0 is filtered (n > 0 check) so should be null
    _falsy(r);
  });

  _t('parseForeignCurrencyHint: "50$ amazon" converts USD to ILS', function() {
    if (typeof parseForeignCurrencyHint !== 'function') throw new Error('parseForeignCurrencyHint missing');
    var fx = parseForeignCurrencyHint('50$ amazon');
    _truthy(fx, 'fx returned');
    _truthy(fx.ilsAmount > 50, 'ilsAmount > 50 (FX > 1)');
    _truthy(fx.autoConverted === true, 'auto converted');
    _eq(fx.foreignAmount, 50);
  });

  _t('parseForeignCurrencyHint: "12 EUR spotify" works', function() {
    var fx = parseForeignCurrencyHint('12 EUR spotify');
    _truthy(fx);
    _truthy(fx.ilsAmount > 12, 'EUR > ILS');
  });

  _t('parseForeignCurrencyHint: pure Hebrew has no FX', function() {
    var fx = parseForeignCurrencyHint('245 ' + 'סופר');
    _falsy(fx);
  });

  _t('parseForeignCurrencyHint: empty input returns null', function() {
    var fx = parseForeignCurrencyHint('');
    _falsy(fx);
  });

  _t('parseForeignCurrencyHint: user-supplied ILS bypasses auto-convert', function() {
    var fx = parseForeignCurrencyHint('50$ amazon 180 ' + 'שח');
    _truthy(fx);
    _eq(fx.ilsAmount, 180, 'user ILS used verbatim');
    _falsy(fx.autoConverted);
  });

  _t('_kfl_fxLookup: USD returns rate', function() {
    if (typeof _kfl_fxLookup !== 'function') throw new Error('_kfl_fxLookup missing');
    var r = _kfl_fxLookup('USD');
    _truthy(r > 1, 'rate > 1');
  });

  _t('_kfl_fxLookup: unknown symbol returns null', function() {
    var r = _kfl_fxLookup('XYZ');
    _falsy(r);
  });
}

// ---------- 2. CATEGORY RESOLUTION TESTS ----------

function testCategoryResolution() {
  _t('matchCategory: "wolt תל אביב" -> אוכל / אוכל בחוץ', function() {
    if (typeof matchCategory !== 'function') throw new Error('matchCategory missing');
    var m = matchCategory('wolt ' + 'תל אביב');
    _truthy(m);
    _eq(m.category, 'אוכל');
    _eq(m.subcategory, 'אוכל בחוץ');
  });

  _t('matchCategory: "245 שופרסל" -> אוכל / אוכל לבית', function() {
    var m = matchCategory('245 ' + 'שופרסל');
    _truthy(m);
    _eq(m.category, 'אוכל');
    _eq(m.subcategory, 'אוכל לבית');
  });

  _t('matchCategory: "ארנונה" -> הוצאות קבועות / בית', function() {
    var m = matchCategory('ארנונה');
    _truthy(m);
    _eq(m.category, 'הוצאות קבועות');
    _eq(m.subcategory, 'בית');
  });

  _t('matchCategory: "חברת חשמל" -> הוצאות קבועות / חשמל', function() {
    var m = matchCategory('חברת חשמל');
    _truthy(m);
    _eq(m.category, 'הוצאות קבועות');
    _eq(m.subcategory, 'חשמל');
  });

  _t('matchCategory: "netflix" -> הוצאות קבועות / אפליקציות', function() {
    var m = matchCategory('netflix');
    _truthy(m);
    _eq(m.subcategory, 'אפליקציות');
  });

  _t('matchCategory: "uber" -> תחבורה / מונית', function() {
    var m = matchCategory('uber');
    _truthy(m);
    _eq(m.category, 'תחבורה');
  });

  _t('matchCategory: "פנגו חניה" -> תחבורה / חניה', function() {
    var m = matchCategory('פנגו חניה');
    _truthy(m);
    _eq(m.subcategory, 'חניה');
  });

  _t('matchCategory: "סונול" -> תחבורה / דלק', function() {
    var m = matchCategory('סונול');
    _truthy(m);
    _eq(m.subcategory, 'דלק');
  });

  _t('matchCategory: "zara" -> קניות / ביגוד', function() {
    var m = matchCategory('zara');
    _truthy(m);
    _eq(m.subcategory, 'ביגוד');
  });

  _t('matchCategory: "super pharm" -> בריאות / בריאות', function() {
    var m = matchCategory('super pharm');
    _truthy(m);
    _eq(m.category, 'בריאות');
  });

  _t('matchCategory: "משכורת" -> הכנסות (isIncome=true)', function() {
    var m = matchCategory('משכורת');
    _truthy(m);
    _eq(m.category, 'הכנסות');
    _truthy(m.isIncome === true, 'isIncome flag');
  });

  _t('matchCategory: gibberish returns DEFAULT_CATEGORY', function() {
    var m = matchCategory('xyzlmnabqwerty');
    _truthy(m);
    // DEFAULT_CATEGORY is "שונות ואחרים" / "שונות"
    _eq(m.category, 'שונות ואחרים');
  });

  _t('matchCategory: empty string returns DEFAULT_CATEGORY', function() {
    var m = matchCategory('');
    _truthy(m);
    _eq(m.category, 'שונות ואחרים');
  });

  _t('matchCategory: business prefix routes to BUSINESS_CATEGORY_MAP', function() {
    var m = matchCategory('עסק facebook');
    _truthy(m);
    _eq(m.category, 'עסק');
    _eq(m.subcategory, 'עלות שיווק');
  });

  _t('matchCategory: business prefix with raw materials', function() {
    var m = matchCategory('עסק זכוכית');
    _truthy(m);
    _eq(m.category, 'עסק');
    _eq(m.subcategory, 'עלות חומרי גלם');
  });

  _t('matchCategorySmart: returns same as matchCategory for known terms (mock _aiCategorize=null)', function() {
    if (typeof matchCategorySmart !== 'function') throw new Error('matchCategorySmart missing');
    var m = matchCategorySmart('wolt');
    _truthy(m);
    _eq(m.category, 'אוכל');
  });

  _t('matchCategorySmart: gibberish falls to default (no AI hit thanks to mock)', function() {
    var m = matchCategorySmart('xyzlmnabqwerty');
    _truthy(m);
    _eq(m.category, 'שונות ואחרים');
  });

  _t('_coerceCategoryBySubcategory: "אוכל בחוץ" forces category=אוכל', function() {
    if (typeof _coerceCategoryBySubcategory !== 'function') throw new Error('_coerceCategoryBySubcategory missing');
    var m = { category: 'something-wrong', subcategory: 'אוכל בחוץ' };
    _coerceCategoryBySubcategory(m);
    _eq(m.category, 'אוכל');
  });
}

// ---------- 3. COMMAND DISPATCHER TESTS ----------

function testCommands() {
  var phone = '972500000000';

  _t('getHelpMessage: contains command list', function() {
    if (typeof getHelpMessage !== 'function') throw new Error('getHelpMessage missing');
    var msg = getHelpMessage();
    _contains(msg, 'סיכום');
    _contains(msg, 'מחק אחרון');
    _contains(msg, 'מנוע');
  });

  _t('getBotStatusMessage: contains "מצב הבוט"', function() {
    if (typeof getBotStatusMessage !== 'function') throw new Error('getBotStatusMessage missing');
    var msg = getBotStatusMessage(phone);
    _contains(msg, 'מצב הבוט');
  });

  _t('getEngineStatus: contains "מצב המנוע"', function() {
    if (typeof getEngineStatus !== 'function') throw new Error('getEngineStatus missing');
    var msg = getEngineStatus();
    // either success or failure path — both branches mention some keyword
    _truthy(msg.indexOf('המנוע') >= 0 || msg.indexOf('שגיאה') >= 0 || msg.indexOf('משהו השתבש') >= 0);
  });

  _t('getCurrenciesMessage: returns non-empty', function() {
    if (typeof getCurrenciesMessage !== 'function') throw new Error('getCurrenciesMessage missing');
    var msg = getCurrenciesMessage();
    _truthy(msg && msg.length > 5);
  });

  _t('getDictionaryLink: returns string', function() {
    if (typeof getDictionaryLink !== 'function') throw new Error('getDictionaryLink missing');
    var msg = getDictionaryLink();
    _truthy(msg && msg.length > 0);
  });

  _t('getGoalsMessage: returns goals section header', function() {
    if (typeof getGoalsMessage !== 'function') throw new Error('getGoalsMessage missing');
    var msg = getGoalsMessage();
    _truthy(msg);
    _contains(msg, 'מטרות');
  });

  _t('parseGoalCommand: parses cap goal', function() {
    if (typeof parseGoalCommand !== 'function') throw new Error('parseGoalCommand missing');
    var p = parseGoalCommand('מטרה: עד 800 שח על אוכל בחוץ בחודש');
    _truthy(p);
    _eq(p.type, 'cap');
    _eq(p.target, 800);
  });

  _t('parseGoalCommand: parses save goal', function() {
    var p = parseGoalCommand('מטרה: חיסכון 5000 לחופשה');
    _truthy(p);
    _eq(p.type, 'save');
    _eq(p.target, 5000);
  });

  _t('parseGoalCommand: non-goal text returns null', function() {
    var p = parseGoalCommand('245 קפה');
    _falsy(p);
  });

  _t('_handleBudgetCommand_: "תקציבים" returns handled=true', function() {
    if (typeof _handleBudgetCommand_ !== 'function') throw new Error('_handleBudgetCommand_ missing');
    var r = _handleBudgetCommand_(phone, 'תקציבים');
    _truthy(r);
    _eq(r.handled, true);
    _truthy(r.replyText && r.replyText.length > 0);
  });

  _t('_handleBudgetCommand_: random text returns handled=false', function() {
    var r = _handleBudgetCommand_(phone, 'random gibberish');
    _truthy(r);
    _eq(r.handled, false);
  });

  _t('_handleBudgetCommand_: rejects malformed set-budget command', function() {
    var r = _handleBudgetCommand_(phone, 'יעד תקציב = abc');
    // Either handled=false or replyText warns user
    _truthy(r);
    if (r.handled) _truthy(r.replyText, 'has reply if handled');
  });

  _t('_handleTimezoneCommand_: bare "אזור זמן" returns current tz info', function() {
    if (typeof _handleTimezoneCommand_ !== 'function') throw new Error('_handleTimezoneCommand_ missing');
    var r = _handleTimezoneCommand_(phone, 'אזור זמן');
    _truthy(r);
    _eq(r.handled, true);
    _contains(r.replyText, 'אזור הזמן');
  });

  _t('_handleTimezoneCommand_: invalid IANA returns error message', function() {
    var r = _handleTimezoneCommand_(phone, 'אזור זמן NotARealTz');
    _truthy(r);
    _eq(r.handled, true);
    _contains(r.replyText, 'לא תקין');
  });

  _t('_handleTimezoneCommand_: non-tz text returns handled=false', function() {
    var r = _handleTimezoneCommand_(phone, '245 קפה');
    _truthy(r);
    _eq(r.handled, false);
  });

  _t('_isValidTz_: Asia/Jerusalem is valid', function() {
    if (typeof _isValidTz_ !== 'function') throw new Error('_isValidTz_ missing');
    _truthy(_isValidTz_('Asia/Jerusalem'));
  });

  _t('_isValidTz_: garbage rejected', function() {
    _falsy(_isValidTz_('Not/A/Tz'));
  });

  _t('_tzFromPhone_: Israeli number -> Asia/Jerusalem', function() {
    if (typeof _tzFromPhone_ !== 'function') throw new Error('_tzFromPhone_ missing');
    _eq(_tzFromPhone_('972500000000'), 'Asia/Jerusalem');
  });

  _t('_tzFromPhone_: empty phone returns default tz', function() {
    _eq(_tzFromPhone_(''), 'Asia/Jerusalem');
  });

  _t('_handleLearningCommand_: bare "לימוד" returns a list message', function() {
    if (typeof _handleLearningCommand_ !== 'function') throw new Error('_handleLearningCommand_ missing');
    var r = _handleLearningCommand_(phone, 'לימוד');
    _truthy(r);
    _eq(r.handled, true);
  });

  _t('_handleLearningCommand_: non-learning text returns null', function() {
    var r = _handleLearningCommand_(phone, '245 קפה');
    _falsy(r);
  });

  _t('_handleLearningCommand_: malformed "מחק לימוד" still handled', function() {
    var r = _handleLearningCommand_(phone, 'מחק לימוד 99');
    _truthy(r);
    _eq(r.handled, true);
  });

  _t('_handleSubscriptionCommand_: "מנויים" handled', function() {
    if (typeof _handleSubscriptionCommand_ !== 'function') throw new Error('_handleSubscriptionCommand_ missing');
    var r = _handleSubscriptionCommand_(phone, 'מנויים');
    _truthy(r);
    _eq(r.handled, true);
    _truthy(r.replyText && r.replyText.length > 0);
  });

  _t('_handleSubscriptionCommand_: random text not handled', function() {
    var r = _handleSubscriptionCommand_(phone, 'hello world');
    _truthy(r);
    _eq(r.handled, false);
  });

  _t('_handleFamilyMultiCommand_: "מצב אישי" handled with reply', function() {
    if (typeof _handleFamilyMultiCommand_ !== 'function') throw new Error('_handleFamilyMultiCommand_ missing');
    var r = _handleFamilyMultiCommand_(phone, 'מצב אישי');
    _truthy(r);
    _eq(r.handled, true);
    _contains(r.replyText, 'אישי');
  });

  _t('_handleFamilyMultiCommand_: unrecognized text returns handled=false', function() {
    var r = _handleFamilyMultiCommand_(phone, '245 קפה');
    _truthy(r);
    _eq(r.handled, false);
  });

  _t('getAnomaliesReportMessage: returns a string', function() {
    if (typeof getAnomaliesReportMessage !== 'function') throw new Error('getAnomaliesReportMessage missing');
    var msg = getAnomaliesReportMessage();
    _truthy(msg && msg.length > 0);
  });
}

// ---------- 4. HELPER TESTS ----------

function testHelpers() {
  _t('_progressBar_(0) returns empty progress bar', function() {
    if (typeof _progressBar_ !== 'function') throw new Error('_progressBar_ missing');
    var bar = _progressBar_(0);
    _truthy(bar && bar.length > 0);
    // No filled blocks
    _eq(bar.indexOf('▰'), -1, 'no filled');
  });

  _t('_progressBar_(50) returns half-filled', function() {
    var bar = _progressBar_(50);
    _truthy(bar.indexOf('▰') >= 0, 'has filled');
    _truthy(bar.indexOf('▱') >= 0, 'has empty');
  });

  _t('_progressBar_(100) returns fully filled', function() {
    var bar = _progressBar_(100);
    _eq(bar.indexOf('▱'), -1, 'no empty');
  });

  _t('_progressBar_(150) caps at 100%', function() {
    var bar = _progressBar_(150);
    // Should still be 10 chars total, no empty boxes
    _eq(bar.indexOf('▱'), -1);
  });

  _t('_vendorEmoji_ returns string', function() {
    if (typeof _vendorEmoji_ !== 'function') throw new Error('_vendorEmoji_ missing');
    var e = _vendorEmoji_('netflix');
    _truthy(e && e.length > 0);
  });

  _t('_cadenceHe_ returns Hebrew label', function() {
    if (typeof _cadenceHe_ !== 'function') throw new Error('_cadenceHe_ missing');
    var c = _cadenceHe_('monthly');
    _truthy(c && c.length > 0);
  });

  _t('_normalizeVendorKey_ removes punctuation', function() {
    if (typeof _normalizeVendorKey_ !== 'function') throw new Error('_normalizeVendorKey_ missing');
    var n = _normalizeVendorKey_('Netflix.com  ');
    _truthy(n && n.length > 0);
  });

  _t('sanitizeForSheet: removes leading "="', function() {
    if (typeof sanitizeForSheet !== 'function') throw new Error('sanitizeForSheet missing');
    var r = sanitizeForSheet('=SUM(A1:A2)');
    // First character should not still be a literal "=" that Sheets parses as formula
    _truthy(String(r).charAt(0) !== '=' || r === '');
  });

  _t('sanitizeForSheet: preserves normal Hebrew', function() {
    var r = sanitizeForSheet('סופר רמי לוי');
    _eq(r, 'סופר רמי לוי');
  });
}

// ---------- 5. EDGE CASE TESTS ----------

function testEdgeCases() {
  _t('parseAmountAndDescription handles 500-char input without throwing', function() {
    var longText = '245 ';
    for (var i = 0; i < 30; i++) longText += 'סופר רמי לוי ';
    var r = parseAmountAndDescription(longText);
    _truthy(r);
    _eq(r.items[0].amount, 245);
  });

  _t('parseAmountAndDescription handles mixed Hebrew+English', function() {
    var r = parseAmountAndDescription('50 wolt תל אביב');
    _truthy(r);
    _eq(r.items[0].amount, 50);
  });

  _t('parseAmountAndDescription handles multiple amounts (returns first item)', function() {
    var r = parseAmountAndDescription('245 ' + 'סופר 42 קפה');
    _truthy(r);
    // The current parser returns ALL numbers as separate items, each with full description
    _truthy(r.items.length >= 1, 'at least one item');
    _eq(r.items[0].amount, 245);
  });

  _t('matchCategory handles mixed Hebrew+English', function() {
    var m = matchCategory('wolt תל אביב');
    _truthy(m);
    _eq(m.category, 'אוכל');
  });

  _t('matchCategory: emoji-only text falls to default', function() {
    var m = matchCategory('🍕🍔');
    _truthy(m);
    // No keyword match → DEFAULT
    _eq(m.category, 'שונות ואחרים');
  });

  _t('matchCategory: leading/trailing whitespace tolerated', function() {
    var m = matchCategory('   ' + 'wolt' + '   ');
    _truthy(m);
    _eq(m.category, 'אוכל');
  });

  _t('matchCategorySmart: very long input does not throw', function() {
    var s = '';
    for (var i = 0; i < 50; i++) s += 'lorem ipsum dolor sit amet ';
    var m = matchCategorySmart(s);
    _truthy(m);
  });

  _t('matchCategorySmart: null input returns valid object', function() {
    var m = matchCategorySmart(null);
    _truthy(m);
    _truthy(m.category, 'has category');
  });

  _t('parseGoalCommand: handles colon variants', function() {
    var p1 = parseGoalCommand('מטרה: חיסכון 1000');
    var p2 = parseGoalCommand('מטרה - חיסכון 1000');
    _truthy(p1);
    _truthy(p2);
    _eq(p1.target, 1000);
    _eq(p2.target, 1000);
  });

  _t('parseForeignCurrencyHint: dollar before number "$50 amazon" works', function() {
    var fx = parseForeignCurrencyHint('$50 amazon');
    _truthy(fx);
    _eq(fx.foreignAmount, 50);
  });

  _t('parseForeignCurrencyHint: Hebrew "דולר" recognized', function() {
    var fx = parseForeignCurrencyHint('50 דולר amazon');
    _truthy(fx);
    _truthy(fx.ilsAmount > 50);
  });
}
