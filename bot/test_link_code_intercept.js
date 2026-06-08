#!/usr/bin/env node
// bot/test_link_code_intercept.js (auto-discovered by the gauntlet)
// Locks the WhatsApp link-code fix (Steven 2026-06-08): a user sending their
// link code "קוד 870549" was mis-parsed as a ₪870,549 EXPENSE because an
// upstream router bypassed the matcher in processExpense -- so users could
// never link (the broken plumbing behind 0% activation). The fix intercepts the
// code at the very top of the doPost wrapper, before the fast-path + all routers.
const fs = require('node:fs'), path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
let pass = 0, fail = 0;
const ok = (l, c) => { if (c) pass++; else { fail++; console.log('  FAIL ' + l); } };

// structural: the intercept exists and is BEFORE the fast-path
ok('link-code intercept present in doPost wrapper',
  /var __linkCodeM = __text_ && String\(__text_\)\.match\(/.test(SRC));
ok('intercept runs BEFORE the fast-path looksLikeExpense check',
  SRC.indexOf('var __linkCodeM =') >= 0 &&
  SRC.indexOf('var __linkCodeM =') < SRC.indexOf('var __looksLikeExpense = /^\\s*\\d/'));
ok('intercept calls handleLinkCode_ then returns OK',
  /handleLinkCode_\(__linkCodeM\[1\], __from_\)[\s\S]{0,260}ContentService\.createTextOutput\("OK"\)/.test(SRC));

// behavioural: the exact regex the bot uses
const re = /(?:קוד|code|link)\s*[:\-]?\s*(\d{6})\b/i;
ok('"קוד 870549" matches + extracts 870549', (('קוד 870549'.match(re) || [])[1]) === '870549');
ok('"code 123456" matches (English)', re.test('code 123456'));
ok('"link 555000" matches', re.test('link 555000'));
ok('"קוד: 870549" matches (with colon)', re.test('קוד: 870549'));
ok('a real expense "850 שיווק" does NOT match', !re.test('850 שיווק'));
ok('"45 קפה" does NOT match', !re.test('45 קפה'));
ok('5-digit "קוד 12345" does NOT match (needs 6)', !re.test('קוד 12345'));

console.log('test_link_code_intercept: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
