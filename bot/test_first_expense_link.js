#!/usr/bin/env node
// Locks the first-expense dashboard-link fix (2026-06-09): the append response's
// spreadsheetUrl is cached into the same 'sheeturl:' key _userSheetUrl_ reads,
// so a brand-new user's FIRST expense confirmation shows a tappable sheet link
// (was only appearing from expense #2 after the server self-healed the phone record).
const fs = require('node:fs'), path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
let pass = 0, fail = 0; const ok = (l, c) => { if (c) pass++; else { fail++; console.log('  FAIL ' + l); } };
ok('append response caches spreadsheetUrl', SRC.includes("CacheService.getScriptCache().put('sheeturl:' + __suC"));
ok('cache write guarded by __j.spreadsheetUrl', /if \(__j && __j\.spreadsheetUrl\)/.test(SRC));
ok('_userSheetUrl_ reads the same sheeturl: cache before KV', /var ck = 'sheeturl:' \+ clean;/.test(SRC) && /var cached = cache\.get\(ck\);/.test(SRC));
console.log('test_first_expense_link: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
