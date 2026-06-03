#!/usr/bin/env node
/**
 * scripts/gauntlet/check-html-scripts.js — group 4 of the regression gauntlet.
 *
 * For every committed *.html:
 *   - every inline <script> block (no src=) must parse as valid JS — the same
 *     `new Function(body)` SYNTAX check the inline-script-validate skill uses
 *     (the CSP allows unsafe-inline, so these blocks DO execute in prod).
 *   - every <script type="application/ld+json"> block must be valid JSON
 *     (broken structured data silently tanks rich results / SEO).
 *
 * Blocks with a src= attribute are external files — they're covered by the JS
 * syntax group (node --check), so they're skipped here. type="text/template"
 * and other non-JS template blocks are skipped too.
 *
 * Output: failures to stderr, then "COUNT <pass> <fail> <jsBlocks> <ldBlocks>"
 * to stdout.
 */
'use strict';
const fs = require('fs');
const cp = require('child_process');

const root = process.argv[2] || process.cwd();
process.chdir(root);

const files = cp.execSync(
  'find . -name "*.html" -not -path "./node_modules/*" -not -path "./.next/*" -not -path "./.vercel/*" -not -path "./.git/*"',
  { maxBuffer: 64 * 1024 * 1024 }
).toString().trim().split('\n').filter(Boolean).sort();

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let jsBlocks = 0, ldBlocks = 0, fail = 0;
const fails = [];

for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  let m, idx = -1;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html))) {
    idx++;
    const attrs = m[1] || '', body = m[2] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;                       // external file — checked by node --check
    if (/type\s*=\s*["']application\/ld\+json["']/i.test(attrs)) {
      ldBlocks++;
      try { JSON.parse(body); }
      catch (e) { fail++; fails.push('[JSON-LD] ' + f + ' block#' + idx + ' :: ' + e.message); }
      continue;
    }
    // Skip non-JS template blocks (e.g. type="text/template"); validate JS otherwise.
    const tm = attrs.match(/type\s*=\s*["']([^"']+)["']/i);
    if (tm && !/^(text\/javascript|module|application\/javascript)$/i.test(tm[1])) continue;
    jsBlocks++;
    try { new Function(body); }                                  // SYNTAX check only (matches the skill)
    catch (e) { fail++; fails.push('[JS] ' + f + ' block#' + idx + ' :: ' + e.message); }
  }
}

for (const m of fails) console.error('  \x1b[31m✗ ' + m + '\x1b[0m');
console.log('COUNT ' + (jsBlocks + ldBlocks - fail) + ' ' + fail + ' ' + jsBlocks + ' ' + ldBlocks);
