// Unit test: bot-loop detection signatures.
// Run: node bot/test_botloop.js
//
// Validates that _BOT_ECHO_REGEXES_ matches the actual Hermes traffic
// Steven captured in his WhatsApp screenshot, plus a few common
// auto-responder patterns we want to defend against.

'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

// Extract the regex array from the source — keeps the test honest to
// what's actually deployed, not a copy that can drift out of sync.
const match = SRC.match(/var _BOT_ECHO_REGEXES_ = \[([\s\S]*?)\];/);
if (!match) {
  console.error('FAIL: _BOT_ECHO_REGEXES_ array not found in ExpenseBot_FIXED.gs');
  process.exit(1);
}

// eslint-disable-next-line no-new-func
const regexes = new Function('return [' + match[1] + ']')();

function looksLikeBotEcho(text) {
  if (!text) return false;
  const t = String(text);
  return regexes.some((re) => re.test(t));
}

let pass = 0;
let fail = 0;

function expectTrue(input, label) {
  const got = looksLikeBotEcho(input);
  if (got) { pass++; console.log('  ✅ catches: ' + label); }
  else     { fail++; console.log('  ❌ MISSED:  ' + label + ' -- text: ' + JSON.stringify(input.slice(0, 100))); }
}
function expectFalse(input, label) {
  const got = looksLikeBotEcho(input);
  if (!got) { pass++; console.log('  ✅ ignores: ' + label); }
  else      { fail++; console.log('  ❌ FALSE POSITIVE: ' + label + ' -- text: ' + JSON.stringify(input.slice(0, 100))); }
}

console.log('=== BOT-LOOP DETECTION TESTS ===\n');

console.log('-- Hermes Agent traffic (from Steven\'s screenshot) --');
expectTrue('```json\n{"action":"chat","reply":"היי!"}\n```', 'Hermes JSON reply with action:chat');
expectTrue('```json\n{"action":"chat","reply":"היי! כספ"}\n```', 'Hermes JSON Hebrew reply');
expectTrue('```json\n{"action":"reply","reply":"היי! נראה ש"}\n```', 'Hermes action:reply variant');

console.log('\n-- Generic auto-responder signals --');
expectTrue('[Silent]', 'silent marker');
expectTrue('[Silent - bot loop continues. Not responding.]', 'self-aware silent reply');
expectTrue('[Loop detected with another bot - not responding to break the cycle.]', 'loop-detected marker');
expectTrue('⚡ Interrupting current task (iteration 1/90). I\'ll respond to your message shortly.', 'interrupting current task');
expectTrue('[bot] hi', 'bot bracket prefix');
expectTrue('בוט: שלום', 'hebrew bot prefix');
expectTrue('הודעה אוטומטית: אני לא זמין', 'hebrew automated message');
expectTrue('this is an automated reply', 'plain automated reply');
expectTrue('I\'ll respond to your message when I return', 'auto-vacation');

console.log('\n-- Real human messages (must NOT trigger) --');
expectFalse('320 שיווק פייסבוק', 'normal expense message');
expectFalse('42 קפה ארומה', 'normal cafe expense');
expectFalse('היי, מה קורה?', 'casual hebrew greeting');
expectFalse('עסק 2 100 חומרי גלם', 'multi-business write');
expectFalse('כספלה אישי', 'kespelle context command');
expectFalse('שלום, רציתי לשאול אם תוכל לעזור', 'longer hebrew sentence');
expectFalse('₪50 לסופר אתמול', 'expense with currency symbol');
expectFalse('action item: buy milk', 'human writing "action" but not JSON');
expectFalse('the reply was good', 'human writing "reply" naturally');
expectFalse('', 'empty string');
expectFalse(null, 'null input');
expectFalse(undefined, 'undefined input');

console.log('\n=== RESULT: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail === 0 ? 0 : 1);
