#!/usr/bin/env node
// bot/test_create_business_command.js  (auto-discovered by the gauntlet)
// Locks the natural-language "create a new business named X" command
// (_parseCreateBusinessName_) added 2026-06-17 after Steven sent
// "תיצור גיליון חדש שנקרא עסק שירים" and the bot replied "didn't understand".
//
// Two things must hold:
//   1. Real create phrasings WITH an inline name -> match + correct name.
//   2. Bare triggers, confirmation replies, list command, and ordinary
//      business EXPENSES must NOT match (so we never preempt existing flows).
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
const parse = new Function(
  extractFn('_cleanBizName_') + '\n' + extractFn('_parseCreateBusinessName_') +
  '\nreturn _parseCreateBusinessName_;'
)();

let pass = 0, fail = 0;
function ok(label, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL ' + label + (extra ? ('  [' + extra + ']') : '')); } }

function expectName(text, name) {
  const r = parse(text);
  ok('"' + text + '" -> match name="' + name + '"', r.match && r.name === name, 'got ' + JSON.stringify(r));
}
function expectNoMatch(text) {
  const r = parse(text);
  ok('"' + text + '" -> NO match', !r.match, 'got ' + JSON.stringify(r));
}

// --- SHOULD create (with inline name) ---
expectName('תיצור גיליון חדש שנקרא עסק שירים', 'עסק שירים'); // Steven's exact message
expectName('צור עסק שירים', 'שירים');
expectName('פתח עסק חדש בשם כספלה', 'כספלה');
expectName('עסק חדש שירים', 'שירים');
expectName('עסק חדש בשם הרמס', 'הרמס');
expectName('צור גיליון שירים', 'שירים');
expectName('הקם עסק שנקרא דוגמה', 'דוגמה');
expectName('תיצור גיליון חדש שנקרא "עסק שירים"', 'עסק שירים'); // quotes stripped

// --- MUST NOT match (no inline name / existing flows / expenses) ---
expectNoMatch('עסק חדש');            // bare trigger -> existing flow asks for name
expectNoMatch('פתח עסק חדש');        // confirmation reply elsewhere
expectNoMatch('צור עסק חדש');        // no inline name
expectNoMatch('עסקים');              // list command
expectNoMatch('עסק שירים 50 קפה');   // named-business EXPENSE routing
expectNoMatch('עסק 2 320 שיווק');    // numbered-business EXPENSE
expectNoMatch('50 קפה');             // plain expense
expectNoMatch('סיכום');              // summary command
expectNoMatch('');                   // empty

// --- structural: wired into doPost, owner-gated, uses the tested create path ---
ok('dispatch calls _handleCreateBusinessCommand_', /_handleCreateBusinessCommand_\(__from_, __text_\)/.test(SRC));
ok('dispatch is owner-gated', /_handleCreateBusinessCommand_ === "function" && _isOwnerPhone_\(__from_\)/.test(SRC));
ok('handler defined', /function _handleCreateBusinessCommand_\(/.test(SRC));
ok('handler owner-gated', /function _handleCreateBusinessCommand_\([\s\S]{0,140}_isOwnerPhone_/.test(SRC));
ok('handler reuses _createBusinessFromTemplate_', /_createBusinessFromTemplate_\(fromPhone, parsed\.name\)/.test(SRC));

console.log('test_create_business_command: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
