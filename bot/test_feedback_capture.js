#!/usr/bin/env node
// bot/test_feedback_capture.js  (auto-discovered by the gauntlet)
// Locks the "ביקורת" (feedback) capture feature (Steven 2026-06-07):
// a standalone trigger word arms feedback mode; the next message is forwarded
// to the owner + persisted; the trigger never hijacks a real expense; help and
// the confirmation nudge are wired. Structural + regex-behavior asserts (the
// capture logic is inline in processExpense, so we test the contract, not a
// live WhatsApp round-trip).
const fs = require('node:fs'), path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
let pass = 0, fail = 0;
function ok(label, cond) { if (cond) pass++; else { fail++; console.log('  FAIL ' + label); } }

// --- regex behavior (mirror of the inline trigger/cancel patterns) ---
const TRIG = /^(ביקורת|בקורת|פידבק|פדבק|feedback)[!.?\s]*$/i;
const CANCEL = /^(ביטול|בטל|cancel)[!.?\s]*$/i;
ok('trigger matches "ביקורת"', TRIG.test('ביקורת'));
ok('trigger matches "פידבק"', TRIG.test('פידבק'));
ok('trigger matches "feedback"', TRIG.test('feedback'));
ok('trigger matches with trailing "!"', TRIG.test('ביקורת!'));
ok('trigger does NOT match car-inspection expense "ביקורת רכב 350"', !TRIG.test('ביקורת רכב 350'));
ok('trigger does NOT match a sentence "ביקורת על השירות"', !TRIG.test('ביקורת על השירות'));
ok('cancel matches "ביטול"', CANCEL.test('ביטול'));
ok('cancel matches "cancel"', CANCEL.test('cancel'));
ok('cancel does NOT match "ביטולים 5"', !CANCEL.test('ביטולים 5'));

// --- the inline capture wiring is present in processExpense ---
ok('source contains the exact trigger pattern', SRC.indexOf('ביקורת|בקורת|פידבק|פדבק|feedback') >= 0);
ok('source contains the exact cancel pattern', SRC.indexOf('ביטול|בטל|cancel') >= 0);
ok('arms the awaitingFeedback cache flag', /awaitingFeedback:/.test(SRC));
ok('feedback block runs before the GROUP COMMAND ROUTER', SRC.indexOf('awaitingFeedback:') < SRC.indexOf('GROUP COMMAND ROUTER'));

// --- _captureFeedback_: forwards to owner + persists ---
ok('_captureFeedback_ is defined', /function _captureFeedback_\(/.test(SRC));
ok('_captureFeedback_ forwards via _adminAlertOnce_', /_adminAlertOnce_\(/.test(SRC) && /ביקורת מלקוח/.test(SRC));
ok('_captureFeedback_ best-effort posts to /api/feedback', /\/api\/feedback/.test(SRC));
ok('processExpense calls _captureFeedback_ on the captured message', /_captureFeedback_\(fromPhone, text\)/.test(SRC));

// --- discoverability: help line + confirmation nudge ---
ok('_feedbackNudge_ is defined', /function _feedbackNudge_\(/.test(SRC));
ok('_mtdTail_ appends the nudge', /_feedbackNudge_\(fromPhone\)/.test(SRC));
ok('help message mentions "ביקורת"', /"ביקורת" — ספר לנו/.test(SRC));

// --- safety: the capture path must not write to a sheet ---
const block = SRC.slice(SRC.indexOf('FEEDBACK ("bikoret") CAPTURE'), SRC.indexOf('GROUP COMMAND ROUTER'));
ok('capture block has no appendRow/setValue (never-corrupt floor)',
  block.length > 0 && !/appendRow|setValue|setFormula|\/api\/sheet\/append/.test(block));

console.log('test_feedback_capture: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
