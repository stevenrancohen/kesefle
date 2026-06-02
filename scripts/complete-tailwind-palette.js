#!/usr/bin/env node
// scripts/complete-tailwind-palette.js
//
// Fixes the site-wide "invisible white-on-white" bug (Steven 2026-06-01).
//
// ROOT CAUSE: many pages have an inline `tailwind.config` whose `ink`
// (and sometimes `brand`) color map is MISSING shades that the page's
// own class names use. The Tailwind CDN silently drops a class that
// references an undefined shade. The worst offender is `ink-950`:
// every page uses `dark:bg-ink-950` for the dark-mode background, but
// almost no page DEFINES 950 -- so when dark mode is active the page
// background stays white while `dark:text-white` makes the text white
// => invisible white-on-white. Borders (`ink-200`) and muted text
// (`ink-400/600`) break the same way in light mode.
//
// FIX: for every page that declares an `ink`/`brand` palette, ADD any
// shade that is USED in a class name but MISSING from the map. Existing
// values are NEVER changed (so per-page brand scales are preserved).
//
// The fill values come from the canonical homepage palette (index.html),
// which uses the same `ink` hex ramp on every page; only the *presence*
// of a shade differs. `brand` fills use the canonical cyan/teal ramp,
// which is visually coherent with both brand scales in use.
//
// Idempotent: re-running makes no further changes once palettes are
// complete. Run: node scripts/complete-tailwind-palette.js

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Canonical fill values (from index.html / admin.html). Used only to
// supply MISSING shades; present shades are left untouched.
const CANON = {
  ink: {
    50: '#f7f8fb', 100: '#eef0f6', 200: '#dde1ec', 300: '#bcc4d6',
    400: '#8a95b3', 500: '#5d6b8f', 600: '#41506f', 700: '#2f3b54',
    800: '#1e2638', 900: '#0f1422', 950: '#070b16',
  },
  brand: {
    50: '#ecfeff', 100: '#cffafe', 200: '#a5f3fc', 300: '#67e8f9',
    400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2', 700: '#0e7490',
    800: '#155e75', 900: '#164e63',
  },
};

// Matches a single palette declaration like  ink: { 50:'#..', 100:'#..' }
function palBlockRe(name) {
  return new RegExp('(' + name + '\\s*:\\s*\\{)([^}]*)(\\})');
}

// Classes that can reference a color shade.
const UTIL = '(?:bg|text|border|from|to|via|ring|divide|placeholder|decoration|fill|stroke|shadow|outline|accent|caret)';

function parseShades(block) {
  const m = {};
  const re = /(\d+)\s*:\s*['"]([^'"]+)['"]/g;
  let x;
  while ((x = re.exec(block))) m[x[1]] = x[2];
  return m;
}

function usedShades(src, name) {
  const re = new RegExp(UTIL + '-' + name + '-(\\d+)', 'g');
  const set = new Set();
  let x;
  while ((x = re.exec(src))) set.add(x[1]);
  return set;
}

const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
let filesChanged = 0;
const report = [];

for (const f of htmlFiles) {
  const full = path.join(ROOT, f);
  let src = fs.readFileSync(full, 'utf8');
  let pageChanged = false;
  const added = {};

  for (const name of ['ink', 'brand']) {
    const re = palBlockRe(name);
    const m = src.match(re);
    if (!m) continue; // page has no inline palette for this name
    const defined = parseShades(m[2]);
    const used = usedShades(src, name);
    const missing = [...used]
      .filter((k) => !(k in defined) && CANON[name][k] !== undefined)
      .sort((a, b) => Number(a) - Number(b));
    if (!missing.length) continue;

    // Build additions string, matching the existing quote style.
    const quote = /:\s*"/.test(m[2]) ? '"' : "'";
    const additions = missing
      .map((k) => k + ':' + quote + CANON[name][k] + quote)
      .join(', ');
    // Insert before the closing brace, keeping a comma separator.
    const inner = m[2].replace(/\s*$/, '');
    const sep = inner.trim().endsWith(',') || inner.trim() === '' ? ' ' : ', ';
    const rebuilt = m[1] + inner + sep + additions + ' ' + m[3];
    src = src.replace(re, rebuilt.replace(/\$/g, '$$$$'));
    added[name] = missing;
    pageChanged = true;
  }

  if (pageChanged) {
    fs.writeFileSync(full, src);
    filesChanged++;
    report.push(
      '  ' + f.padEnd(16) +
      (added.ink ? ' +ink[' + added.ink.join(',') + ']' : '') +
      (added.brand ? ' +brand[' + added.brand.join(',') + ']' : '')
    );
  }
}

console.log(report.join('\n'));
console.log('\n=== ' + filesChanged + ' files updated ===');
