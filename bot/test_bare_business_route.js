#!/usr/bin/env node
// bot/test_bare_business_route.js  (auto-discovered by the gauntlet)
//
// Steven 2026-06-27: the owner can drop the "עסק" marker when logging a
// registered business expense — "מוזיקה 50 seedance" must route to the מוזיקה
// business exactly like "עסק מוזיקה 50 seedance". doPost achieves this by
// re-resolving with a synthesized "עסק " prefix (owner-gated). This guards that
// the resolver + the synthesize-prefix fallback behave, and that a non-business
// word ("קפה 50") does NOT get hijacked.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

const fi = src.indexOf('function _resolveBusinessNamePrefix_(');
let d = 0, start = src.indexOf('{', fi), end = -1;
for (let j = start; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) { end = j; break; } } }
/* eslint-disable no-eval */
const _resolveBusinessNamePrefix_ = eval('(' + src.slice(fi, end + 1) + ')');
/* eslint-enable no-eval */

// mirror the doPost owner path: try bare, then synthesize the "עסק " marker.
function routeOwner(msg, list) {
  return _resolveBusinessNamePrefix_(msg, list) || _resolveBusinessNamePrefix_('עסק ' + msg, list);
}

const LIST = [{ n: 2, name: 'מוזיקה' }, { n: 3, name: 'תמונות' }];
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); } }

const HITS = [
  ['עסק מוזיקה 50 seedance', 2, '50 seedance'],
  ['מוזיקה 50 seedance', 2, '50 seedance'],
  ['מוזיקה 5 twilio', 2, '5 twilio'],
  ['מוזיקה 16 suno', 2, '16 suno'],
  ['תמונות 200 קנבס', 3, '200 קנבס'],
];
for (const [msg, n, rest] of HITS) {
  const r = routeOwner(msg, LIST);
  ok(`route "${msg}" -> biz ${n}`, r && r.n === n, r && JSON.stringify(r));
  ok(`route "${msg}" rest`, r && String(r.rest || '').trim() === rest, r && JSON.stringify(r));
}
// non-business words must NOT route (fall through to the normal expense flow)
for (const msg of ['קפה 50', '85 חלב', 'דלק 200']) {
  ok(`"${msg}" does NOT route to a business`, routeOwner(msg, LIST) === null, JSON.stringify(routeOwner(msg, LIST)));
}
// with no registered businesses, nothing routes
ok('empty registry -> no route', routeOwner('מוזיקה 50 suno', []) === null);

console.log(`test_bare_business_route: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
