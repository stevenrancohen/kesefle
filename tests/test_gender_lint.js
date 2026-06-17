// Gender / persona lint — enforces the masculine-default rule and forbids
// inline dual-gender forms in user-facing Hebrew strings. This is the gate
// behind the 2026-06-17 audit class of bugs (feminine LLM persona, feminine
// link-code reply, dual "נסה/י" imperatives, feminine signup steps): the
// bot-reply-style skill is guidance, not enforcement — this makes it CI.
//
// Run: node tests/test_gender_lint.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'bot/ExpenseBot_FIXED.gs',
  'index.html', 'account.html', 'pricing.html', 'help.html', 'dashboard.html',
];

const HEB = 'א-ת';
// 1) Inline dual-gender slash imperative: any Hebrew word + "/י" + boundary.
//    No legitimate Hebrew word contains "<letters>/י"; status labels use "/ה".
const DUAL = new RegExp('[' + HEB + ']{2,}\\/י(?![' + HEB + '])', 'g');
// 2) Feminine singular imperatives that are unambiguously bot-voice (not nouns).
const FEM_WORDS = ['צרי', 'שלחי', 'ממתינה', 'רענני', 'הזיני', 'תגיבי', 'הביני', 'התאימי', 'תמציאי', 'החזירי', 'השתמשי', 'הקלידי', 'בחרי', 'לחצי'];
const FEM = FEM_WORDS.map(function (w) {
  return { w: w, re: new RegExp('(^|[^' + HEB + '])(' + w + ')(?![' + HEB + '])', 'g') };
});

let violations = [];

for (const rel of FILES) {
  const fp = path.join(ROOT, rel);
  if (!fs.existsSync(fp)) continue;
  const lines = fs.readFileSync(fp, 'utf8').split('\n');
  lines.forEach(function (line, i) {
    let m;
    DUAL.lastIndex = 0;
    while ((m = DUAL.exec(line)) !== null) {
      violations.push({ file: rel, line: i + 1, kind: 'dual-gender', hit: m[0] });
    }
    for (const f of FEM) {
      f.re.lastIndex = 0;
      if (f.re.test(line)) violations.push({ file: rel, line: i + 1, kind: 'feminine', hit: f.w });
    }
  });
}

if (violations.length) {
  console.log('❌ GENDER LINT: ' + violations.length + ' violation(s) (masculine-default rule):');
  violations.slice(0, 60).forEach(function (v) {
    console.log('  ' + v.file + ':' + v.line + '  [' + v.kind + ']  ' + v.hit);
  });
  process.exit(1);
}
console.log('✅ GENDER LINT PASSED — no feminine/dual-gender forms in user-facing strings');
process.exit(0);
