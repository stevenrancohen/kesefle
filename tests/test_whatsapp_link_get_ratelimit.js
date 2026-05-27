#!/usr/bin/env node
// Regression test for PR-S6 (Backend QA audit Bug #2).
// Guards against the GET path of /api/whatsapp/link re-becoming a phone
// enumeration oracle.
//
// The audit's specific finding:
//   /api/whatsapp/link GET explicitly skips rate limiting (link.js:189-200)
//   and returns {linked:true} for any phone -- phone-number enumeration oracle.
//
// The fix:
//   - GET path now has an IP-based rate limit for anonymous callers
//     (key='wa_link_status', limit=60, windowSec=60). 60/min/IP is 4x the
//     legitimate polling cadence so legitimate flows are unaffected, but
//     an attacker iterating phone numbers gets 429'd quickly.
//   - Bot-secret callers still skip the limit (server-to-server, trusted).

const fs = require('fs');
const path = require('path');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\ntests/test_whatsapp_link_get_ratelimit.js\n');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'api', 'whatsapp', 'link.js'),
  'utf8'
);

// Strip comments so doc lines about the old vulnerability don't false-positive.
const CODE = SRC.split('\n')
  .filter(line => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

console.log('GET-path rate-limit guard:');

// Must declare a wa_link_status rate-limit config in active code.
assert(/key:\s*['"]wa_link_status['"]/.test(CODE),
  'GET path defines a wa_link_status rate-limit key');

// Must call rateLimit() inside the GET branch.
// Heuristic: there must be a `req.method === 'GET'` block that contains a
// rateLimit() call inside its body before the `} else` (or end).
const getBlockMatch = CODE.match(/if\s*\(\s*req\.method\s*===\s*['"]GET['"]\s*\)\s*\{[\s\S]*?(?:\}\s*else|\}\s*\n\s*\n)/);
assert(getBlockMatch !== null,
  'GET-method branch exists in active code');
if (getBlockMatch) {
  const block = getBlockMatch[0];
  assert(/rateLimit\s*\(\s*req/.test(block),
    'GET branch CALLS rateLimit(req, ...) in active code');
  assert(/wa_link_status/.test(block),
    'GET branch uses the wa_link_status key (not a stray copy of wa_link_request)');
  assert(/return\s+res\.status\(\s*429\s*\)/.test(block),
    'GET branch returns 429 on rate-limit fail');
}

// Must SKIP the rate limit for bot-secret callers (so the bot's own
// per-message lookups aren't rate-limited by the public cap).
assert(/isBotCaller\w*/.test(CODE),
  'GET branch has a bot-secret check (isBotCaller* variable)');
assert(/constantTimeEqual\s*\(\s*String\s*\(\s*presentedSecret\s*\)\s*,\s*String\s*\(\s*botSecret\s*\)\s*\)/.test(CODE),
  'bot-secret comparison uses constantTimeEqual (no timing leak)');

// Sanity: legitimate browser-poll flow still works. Cap must be high
// enough that a normal onboarding doesn't trip it.
//   - Poll cadence: 6s fast / 15s slow / 3min cap (per the file comment)
//   - 15 polls per onboarding ~= 0.25/sec peak ~= 15/min peak
//   - 60/min/IP = 4x headroom. OK.
const limitMatch = CODE.match(/key:\s*['"]wa_link_status['"][\s\S]{0,80}?limit:\s*(\d+)/);
const wsMatch = CODE.match(/key:\s*['"]wa_link_status['"][\s\S]{0,80}?windowSec:\s*(\d+)/);
if (limitMatch && wsMatch) {
  const limit = Number(limitMatch[1]);
  const ws = Number(wsMatch[1]);
  assert(limit >= 30 && limit <= 120,
    'wa_link_status limit is in the 30-120 range (got ' + limit + ')');
  assert(ws <= 120,
    'wa_link_status windowSec is short enough to not lock users out (got ' + ws + 's)');
}

// Negative check: the old `if (req.method !== 'GET')` block that explicitly
// SKIPPED the GET path must not be the only rate-limit gate anymore. Verify
// the POST gate still exists too (we kept it for confirm/request flows).
assert(/wa_link_request/.test(CODE),
  'POST request-mint flow still has wa_link_request limit');
assert(/wa_link_confirm/.test(CODE),
  'POST confirm flow still has wa_link_confirm limit');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
