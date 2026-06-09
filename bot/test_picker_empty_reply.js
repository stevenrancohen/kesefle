#!/usr/bin/env node
// Locks the category-picker empty-reply fix (2026-06-09): if the interactive
// list fails to send, the bot gives a TEXT fallback, not silence.
const fs = require('node:fs'), path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
const i = SRC.indexOf('function _sendPendingCategoryPicker_');
const fn = SRC.slice(i, SRC.indexOf('\n}\n', i));
let pass = 0, fail = 0; const ok = (l, c) => { if (c) pass++; else { fail++; console.log('  FAIL ' + l); } };
ok('send-failure gives a text fallback (not silence)', fn.includes('ההוצאה לא נרשמה. שלח אותה שוב'));
ok('fallback lives inside the catch block', /catch \(_sErr\) \{[\s\S]*ההוצאה לא נרשמה/.test(fn));
ok('post-success path still returns empty (picker IS the reply)', fn.includes("return { reply: '' };"));
console.log('test_picker_empty_reply: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
