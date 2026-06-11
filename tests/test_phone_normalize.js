#!/usr/bin/env node
// Locks normalizeE164 paste-pattern parity (audit 2026-06-10): each missed
// pattern produced a DIFFERENT KV key than the bot computes -> the user linked
// under one key while the bot looked up another ("linked but bot ignores me").
const fs = require('node:fs'), path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '../api/whatsapp/link.js'), 'utf8');
const i = src.indexOf('function normalizeE164');
const fn = src.slice(i, src.indexOf('\n}', i) + 2);
const normalizeE164 = eval('(' + fn.replace('function normalizeE164', 'function') + ')');
const CASES = [
  ['0541234567', '972541234567'],          // leading zero (already worked)
  ['+972 54-776-0643', '972547760643'],    // formatted paste (already worked)
  ['+9720547760643', '972547760643'],      // zero kept after country code (NEW)
  ['9720541234567', '972541234567'],       // same, no plus (NEW)
  ['972972547760643', '972547760643'],     // double country code (NEW)
  ['541234567', '972541234567'],           // bare 9-digit mobile (NEW; used to pass AS-IS = wrong key)
  ['972547760643', '972547760643'],        // canonical unchanged
  ['', null], ['abc', null], ['123', null], ['12345678901234567890', null],
];
let pass = 0, fail = 0;
for (const [inp, want] of CASES) {
  const got = normalizeE164(inp);
  if (got === want) pass++;
  else { fail++; console.log(`  FAIL "${inp}" -> ${got} (want ${want})`); }
}
console.log('test_phone_normalize: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
