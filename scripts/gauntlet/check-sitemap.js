#!/usr/bin/env node
/**
 * scripts/gauntlet/check-sitemap.js — group 5 of the regression gauntlet.
 *
 * Validates sitemap.xml: well-formed <urlset>, balanced <url> tags, at least
 * one <loc>, and every <loc> an absolute https://kesefle.com URL (so a stray
 * localhost / vercel-preview / http URL can't leak into the production
 * sitemap). A missing sitemap is recorded as a single skipped-pass, not a
 * regression.
 *
 * Output: failures to stderr, then "COUNT <pass> <fail>" to stdout.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || process.cwd();
const p = path.join(root, 'sitemap.xml');

let pass = 0, fail = 0;
const fails = [];
function chk(label, cond) { if (cond) pass++; else { fail++; fails.push(label); } }

if (!fs.existsSync(p)) {
  console.log('COUNT 1 0');         // no sitemap → nothing to regress
  process.exit(0);
}

const xml = fs.readFileSync(p, 'utf8');
const opens = (xml.match(/<url>/g) || []).length;
const closes = (xml.match(/<\/url>/g) || []).length;

chk('<urlset> present', /<urlset[\s>]/.test(xml));
chk('<url> open/close balance (' + opens + '/' + closes + ')', opens === closes && opens > 0);

const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
chk('has <loc> entries (' + locs.length + ')', locs.length > 0);

const bad = locs.filter((u) => !/^https:\/\/kesefle\.com(\/|$)/.test(u));
chk('all <loc> are https://kesefle.com', bad.length === 0);
if (bad.length) fails.push('  non-canonical loc: ' + bad.slice(0, 3).join(', '));

for (const m of fails) console.error('  \x1b[31m✗ ' + m + '\x1b[0m');
console.log('COUNT ' + pass + ' ' + fail);
