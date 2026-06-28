#!/usr/bin/env node
// scripts/gauntlet/check-i18n.js
//
// Validates every localized page under the per-language directories (ar/ ru/ fr/
// it/ en/). Ends stdout with "COUNT <pass> <fail>" for the gauntlet runner. A
// localized page must:
//   - declare <html lang="<lang>" ...> with the correct dir (ar => rtl, others => ltr)
//   - carry the reciprocal hreflang anchor (hreflang="he-IL") + a self canonical
//     under /<lang>
//   - mount the language switcher (.lang-switch) + load /js/lang-switch.js
//   - have exactly one <h1>
//   - have every inline <script> parse as valid JS
//   - contain no leftover invisible bidi control characters
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.argv[2] || process.cwd();
const LANG_DIR = { ar: 'rtl', ru: 'ltr', fr: 'ltr', it: 'ltr', en: 'ltr' };
const BIDI = /[‎‏‪-‮⁦-⁩]/;

let pass = 0, fail = 0;
const errs = [];
function check(file, cond, msg) { if (cond) pass++; else { fail++; errs.push(`${file}: ${msg}`); } }

for (const [lang, dir] of Object.entries(LANG_DIR)) {
  const d = path.join(ROOT, lang);
  let files = [];
  try { files = fs.readdirSync(d).filter((f) => f.endsWith('.html')); } catch (_e) { continue; } // dir may not exist yet
  for (const f of files) {
    const rel = `${lang}/${f}`;
    const html = fs.readFileSync(path.join(d, f), 'utf8');
    const head = html.slice(0, 4000);

    const htmlTag = (html.match(/<html[^>]*>/i) || [''])[0];
    check(rel, /\blang\s*=\s*["']/.test(htmlTag) && new RegExp('lang\\s*=\\s*["\\\']' + lang + '\\b').test(htmlTag), `<html> lang must be "${lang}"`);
    check(rel, new RegExp('dir\\s*=\\s*["\\\']' + dir + '["\\\']').test(htmlTag), `<html> dir must be "${dir}"`);

    if (lang !== 'en') { // en is the legacy homepage; full hreflang lands when its funnel ships
      check(rel, /hreflang=["']he-IL["']/.test(html), 'missing reciprocal hreflang="he-IL"');
      check(rel, new RegExp('rel=["\\\']canonical["\\\'][^>]*kesefle\\.com/' + lang).test(html), `canonical must point under /${lang}`);
      check(rel, /class=["'][^"']*\blang-switch\b/.test(html), 'missing .lang-switch switcher');
      check(rel, /\/js\/lang-switch\.js/.test(html), 'missing /js/lang-switch.js');
    }

    const h1s = (html.match(/<h1[\s>]/gi) || []).length;
    check(rel, h1s === 1, `must have exactly one <h1> (found ${h1s})`);

    check(rel, !BIDI.test(html), 'contains invisible bidi control characters');

    let blk = 0, bad = 0;
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const body = m[1];
      if (/application\/(ld\+json|json)/i.test(m[0])) { try { JSON.parse(body); } catch (_e) { bad++; } continue; }
      blk++;
      try { new Function(body); } catch (_e) { bad++; }
    }
    check(rel, bad === 0, `${bad} inline script/JSON block(s) failed to parse`);
  }
}

if (errs.length) errs.slice(0, 40).forEach((e) => console.error('  x ' + e));
console.log(`COUNT ${pass} ${fail}`);
process.exit(fail ? 1 : 0);
