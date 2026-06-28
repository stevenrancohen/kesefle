#!/usr/bin/env node
// bot/test_survey_q0_passthrough.js  (auto-discovered by the gauntlet)
//
// REGRESSION GATE for the activation P0 (2026-06-27): a new user sitting in the
// survey's gender step (q0) must NEVER have a real first expense swallowed by the
// "כתוב בן או בת" re-ask. The fix in _surveyHandleText_ falls through (handled:false
// -> the expense logs) when the message (a) has NO gender word and (b) parses as an
// expense. This test mirrors that exact decision (the full flow needs Apps Script
// CacheService; here we verify the two pure components the guard is built on).
'use strict';
const { predict } = require('../scripts/wa-sim.js');

// The guard regex, kept in sync with bot/ExpenseBot_FIXED.gs _surveyHandleText_ q0.
const GENDER_RE = /(?:^|\s)(?:בן|בת|זכר|נקבה|גבר|אישה|אשה|בחור|בחורה)(?:\s|$)/;

function fallsThroughToLog(t) {
  if (GENDER_RE.test(t)) return false;          // gender statement -> re-ask, don't log
  let p = null;
  try { p = predict(t); } catch (_e) { return false; }
  return !!(p && p.items && p.items.length && typeof p.amount === 'number' && !isNaN(p.amount));
}

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('  FAIL ' + name); } }

// Real first-message expenses MUST fall through (get logged), not be swallowed.
ok('"50 קפה" logs', fallsThroughToLog('50 קפה') === true);
ok('"ארנונה 400" logs', fallsThroughToLog('ארנונה 400') === true);
ok('"200 דלק" logs', fallsThroughToLog('200 דלק') === true);
ok('"1200 שכר דירה" logs', fallsThroughToLog('1200 שכר דירה') === true);

// Gender answers + gender statements MUST stay on the gate (not logged as expense).
ok('"בן" stays on gate', fallsThroughToLog('בן') === false);
ok('"בת" stays on gate', fallsThroughToLog('בת') === false);
ok('"אני בן 30" not logged as ₪30 expense', fallsThroughToLog('אני בן 30') === false);
ok('"אני בת" stays on gate', fallsThroughToLog('אני בת') === false);

// Non-expense chatter stays on the gate (re-ask).
ok('"שלום" stays on gate', fallsThroughToLog('שלום') === false);
ok('"מה נשמע" stays on gate', fallsThroughToLog('מה נשמע') === false);

console.log(`test_survey_q0_passthrough: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
