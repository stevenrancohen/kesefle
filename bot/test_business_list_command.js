#!/usr/bin/env node
// bot/test_business_list_command.js  (auto-discovered by the gauntlet)
// Locks the read-only "עסקים" command (Steven 2026-06-07): it lists the
// sender's registered businesses sorted by number, shows how to register a
// new one (maxN+1), and never writes anything.
const fs = require('node:fs'), path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

function extractFn(name) {
  const idx = SRC.indexOf('function ' + name + '(');
  if (idx < 0) throw new Error('fn not found: ' + name);
  let depth = 0, end = -1, started = false;
  for (let i = idx; i < SRC.length; i++) {
    if (SRC[i] === '{') { depth++; started = true; }
    else if (SRC[i] === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }
  }
  return SRC.slice(idx, end);
}
const BODY = extractFn('_businessListReply_');
function makeReply(list) {
  return new Function('_ownerBusinessList_', BODY + '\nreturn _businessListReply_;')(function () { return list; });
}

let pass = 0, fail = 0;
function ok(label, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL ' + label + (extra ? ('  [' + extra + ']') : '')); } }

// empty registry -> onboarding hint
const empty = makeReply([])('972500000000');
ok('empty -> "lo rashamt" hint', /עוד לא רשמת/.test(empty));
ok('empty -> suggests "עסק 1"', /עסק 1/.test(empty));

// real list (unsorted, #1 appended last like _ownerBusinessList_)
const LIST = [
  { n: 2, tabName: 'כספלה', name: 'כספלה' },
  { n: 3, tabName: 'הרמס', name: 'הרמס' },
  { n: 1, tabName: 'תנועות', name: 'תמונות' },
];
const r = makeReply(LIST)('972547760643');
ok('lists #1 תמונות', /1\. תמונות/.test(r));
ok('lists #2 כספלה', /2\. כספלה/.test(r));
ok('lists #3 הרמס', /3\. הרמס/.test(r));
ok('sorted: #1 before #2 before #3', r.indexOf('1. תמונות') < r.indexOf('2. כספלה') && r.indexOf('2. כספלה') < r.indexOf('3. הרמס'));
ok('next business = maxN+1 = 4', /עסק 4 /.test(r));
ok('expense example uses lowest n (1)', /עסק 1 120/.test(r));
ok('offers by-name routing hint', /עסק כספלה|עסק תמונות/.test(r));

// dedup on duplicate n
const dup = makeReply([{ n: 2, name: 'A' }, { n: 2, name: 'A2' }, { n: 1, name: 'B' }])('972500000001');
ok('dedup duplicate n=2 (only one "2.")', (dup.match(/(^|\n)2\. /g) || []).length === 1, 'got ' + JSON.stringify((dup.match(/(^|\n)2\. /g) || [])));

// --- structural: wired + read-only ---
ok('command dispatch wires "עסקים"', /trimmed === 'עסקים'/.test(SRC));
ok('_businessListReply_ defined', /function _businessListReply_\(/.test(SRC));
ok('reads _ownerBusinessList_', /_ownerBusinessList_\(fromPhone\)/.test(BODY));
ok('read-only (no sheet/registry write in the helper)', !/kvSet|setValue|setFormula|appendRow|\/api\/sheet\/append/.test(BODY));
ok('help mentions "עסקים"', /"עסקים" — רשימת העסקים/.test(SRC));

// --- one-click create-business flow (owner-gated) ---
const bizCmdBlock = SRC.slice(SRC.indexOf("trimmed === 'עסקים'"), SRC.indexOf('_businessListReply_(fromPhone)'));
ok('עסקים command is owner-gated', /_isOwnerPhone_/.test(bizCmdBlock));
ok('sends "+ new business" button (kfl_newbiz)', /kfl_newbiz/.test(SRC) && /sendWhatsAppQuickButtons/.test(SRC));
ok('tap handler for kfl_newbiz', /String\(picked\) === 'kfl_newbiz'/.test(SRC));
ok('tap handler is owner-gated', /String\(picked\) === 'kfl_newbiz'[\s\S]{0,170}_isOwnerPhone_/.test(SRC));
ok('arms awaitingNewBizName flag', /awaitingNewBizName:/.test(SRC));
ok('name-capture hook is owner-gated', /awaitingNewBizName:[\s\S]{0,260}_isOwnerPhone_/.test(SRC));
ok('_startNewBusinessFlow_ defined', /function _startNewBusinessFlow_\(/.test(SRC));
ok('_createBusinessFromTemplate_ owner-gated', /function _createBusinessFromTemplate_\([\s\S]{0,120}_isOwnerPhone_/.test(SRC));
ok('create duplicates the template via _getOrCreateBusinessTab_', /_getOrCreateBusinessTab_\(fromPhone, n, nm\)/.test(SRC));

// unit-test _nextBusinessNumber_ against a stubbed registry
const NEXTBODY = extractFn('_nextBusinessNumber_');
function nextNum(list) { return new Function('_ownerBusinessList_', NEXTBODY + '\nreturn _nextBusinessNumber_;')(function () { return list; }); }
ok('nextNum empty -> 2', nextNum([])('x') === 2);
ok('nextNum [1] -> 2', nextNum([{ n: 1, name: 'a' }])('x') === 2);
ok('nextNum [1,2,3] -> 4', nextNum([{ n: 1 }, { n: 2 }, { n: 3 }])('x') === 4);
ok('nextNum [2,5] -> 6', nextNum([{ n: 2 }, { n: 5 }])('x') === 6);

console.log('test_business_list_command: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
