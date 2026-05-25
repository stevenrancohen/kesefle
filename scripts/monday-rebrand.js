#!/usr/bin/env node
// One-shot color-rebrand script. Replaces the Kesefle green Tailwind
// brand block + purple accent block + a handful of inline green hex
// codes with monday.com-inspired purple/pink/orange across all HTML
// pages. Idempotent -- run twice, second pass changes nothing.
//
// Run: node scripts/monday-rebrand.js

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// --- Monday-inspired palette ---------------------------------------
// Primary purple scale (Monday.com's signature #5034ff at 500).
const PURPLE = "brand:   { 50:'#f3f1ff', 100:'#e5e0ff', 200:'#c9bdff', 300:'#a98fff', 400:'#8a6aff', 500:'#5034ff', 600:'#4326e0', 700:'#3520b8', 800:'#2a1990', 900:'#1f126b' },";
// Accent: monday's gradient pair (pink + orange) for highlights + gradient text.
const ACCENT = "accent:  { 500:'#ff158a', 600:'#fcab10' }";

// What we're replacing (the original Kesefle green + purple accent).
const GREEN_RE  = /brand:\s*\{\s*50:'#f0fdf6'[^}]*900:'#14532d'\s*\},?/g;
const PURPLE_RE = /accent:\s*\{\s*500:'#a855f7',\s*600:'#9333ea'\s*\}/g;

// Inline hex-code aliases that show up outside the Tailwind config (the
// curtain logo gradient, glow-shadow color, hardcoded green buttons).
// Map old -> new. Run last so we don't double-substitute inside the
// brand block above.
const HEX_MAP = [
  // primary scale (deep -> dark)
  ['#22c55e', '#5034ff'],
  ['#16a34a', '#4326e0'],
  ['#15803d', '#3520b8'],
  ['#14532d', '#1f126b'],
  ['#166534', '#2a1990'],
  // light scale (pale tints used on dark mode + badges)
  ['#f0fdf6', '#f3f1ff'],
  ['#dcfce9', '#e5e0ff'],
  ['#bbf7d3', '#c9bdff'],
  ['#86efb1', '#a98fff'],
  ['#4ade85', '#8a6aff'],
  // rgb / rgba shadow + alpha variants
  ['rgb(34 197 94',   'rgb(80 52 255'],
  ['rgb(34, 197, 94', 'rgb(80, 52, 255'],
  ['rgba(34,197,94',  'rgba(80,52,255'],
  ['rgba(34, 197, 94','rgba(80, 52, 255'],
];

let totalFiles = 0;
let totalChanges = 0;
const skipped = [];

const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
htmlFiles.forEach((f) => {
  const full = path.join(ROOT, f);
  let src = fs.readFileSync(full, 'utf8');
  const before = src;

  src = src.replace(GREEN_RE, PURPLE);
  src = src.replace(PURPLE_RE, ACCENT);
  HEX_MAP.forEach(([from, to]) => {
    src = src.split(from).join(to);
  });

  if (src !== before) {
    fs.writeFileSync(full, src);
    totalFiles++;
    const greenHits = (before.match(GREEN_RE) || []).length;
    const accentHits = (before.match(PURPLE_RE) || []).length;
    const hexHits = HEX_MAP.reduce((n, [from]) => n + (before.split(from).length - 1), 0);
    const fileChanges = greenHits + accentHits + hexHits;
    totalChanges += fileChanges;
    console.log('  ' + f + ': ' + fileChanges + ' edits (brand:' + greenHits + ', accent:' + accentHits + ', hex:' + hexHits + ')');
  } else {
    skipped.push(f);
  }
});

console.log('\n=== ' + totalFiles + ' files updated, ' + totalChanges + ' total edits ===');
if (skipped.length) {
  console.log('Skipped (no green brand block found): ' + skipped.length + ' file(s)');
  skipped.forEach((s) => console.log('  ' + s));
}
