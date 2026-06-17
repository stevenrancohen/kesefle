// Operational-vocab pack validation gate. The 2026-06-17 audit found the
// generated operational keyword pack had leaked junk (foreign-script
// mistranslations, bare TLDs, bare generics, ambiguous 1-2 char tokens) that
// fired dishonest recognizer hits. The upstream workflow has no validation, so
// this gate fails CI if junk re-enters on the next regeneration.
//
// Run: node tests/test_vocab_pack.js
'use strict';

const fs = require('fs');
const path = require('path');

const PACK = path.join(__dirname, '../bot/keywords/packs/operational-2026-06-17.json');
if (!fs.existsSync(PACK)) {
  console.log('✅ VOCAB PACK: no pack file (skipped)');
  process.exit(0);
}

const pack = JSON.parse(fs.readFileSync(PACK, 'utf8'));
const kws = pack.keywords || [];

const FOREIGN = /[฀-๿؀-ۿЀ-ӿç]/; // Thai / Arabic / Cyrillic / ç
const BARE_GENERIC = new Set(['קבלה', 'קבלות', 'משרד', 'אחסון', 'גיבוי', 'חשבונית', 'מנוי', 'תוכנה', 'שירות', 'ענן', 'עסק', 'subscription', 'software', 'service', 'cloud']);
const SHORT = /^[a-z֐-׿]{1,2}$/; // bare 1-2 char alpha token

const bad = [];
const seen = new Set();
for (const k of kws) {
  const s = String(k);
  if (FOREIGN.test(s)) bad.push(['foreign-script', s]);
  else if (s.startsWith('.')) bad.push(['bare-TLD', s]);
  else if (BARE_GENERIC.has(s)) bad.push(['bare-generic', s]);
  else if (SHORT.test(s)) bad.push(['too-short', s]);
  if (seen.has(s)) bad.push(['duplicate', s]);
  seen.add(s);
}
if (typeof pack.count === 'number' && pack.count !== kws.length) {
  bad.push(['meta', 'count header ' + pack.count + ' != ' + kws.length + ' keywords']);
}

if (bad.length) {
  console.log('❌ VOCAB PACK: ' + bad.length + ' invalid entr(ies):');
  bad.slice(0, 30).forEach((b) => console.log('  [' + b[0] + ']  ' + b[1]));
  process.exit(1);
}
console.log('✅ VOCAB PACK PASSED — ' + kws.length + ' operational keywords, no junk');
process.exit(0);
