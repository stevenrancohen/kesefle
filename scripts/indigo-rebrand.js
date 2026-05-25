#!/usr/bin/env node
// Indigo/Cyan/Teal rebrand — replaces the monday purple palette with
// a "Deep Ocean" palette: indigo primary + cyan + teal accents.
// Better fit for a finance product (trustworthy, cool, premium).
//
// Idempotent. Run: node scripts/indigo-rebrand.js

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// Tailwind brand block (purple -> indigo).
const PURPLE_BRAND = "brand:   { 50:'#f3f1ff', 100:'#e5e0ff', 200:'#c9bdff', 300:'#a98fff', 400:'#8a6aff', 500:'#5034ff', 600:'#4326e0', 700:'#3520b8', 800:'#2a1990', 900:'#1f126b' },";
const INDIGO_BRAND = "brand:   { 50:'#eef2ff', 100:'#e0e7ff', 200:'#c7d2fe', 300:'#a5b4fc', 400:'#818cf8', 500:'#6366f1', 600:'#4f46e5', 700:'#4338ca', 800:'#3730a3', 900:'#312e81' },";

// Accent block (pink+orange -> cyan+teal).
const PINK_ACCENT = "accent:  { 500:'#ff158a', 600:'#fcab10' }";
const CYAN_ACCENT = "accent:  { 500:'#06b6d4', 600:'#14b8a6' }";

// Hex replacements that appear outside the Tailwind config (inline
// styles, gradients, shadows). The full color scale + accent variants
// + rgb/rgba forms used in shadow glows.
const HEX_MAP = [
  // primary scale
  ['#5034ff', '#4f46e5'],
  ['#4326e0', '#4338ca'],
  ['#3520b8', '#3730a3'],
  ['#2a1990', '#312e81'],
  ['#1f126b', '#1e1b4b'],
  ['#f3f1ff', '#eef2ff'],
  ['#e5e0ff', '#e0e7ff'],
  ['#c9bdff', '#c7d2fe'],
  ['#a98fff', '#a5b4fc'],
  ['#8a6aff', '#818cf8'],
  // accent (pink + orange -> cyan + teal)
  ['#ff158a', '#06b6d4'],
  ['#fcab10', '#14b8a6'],
  // rgb/rgba in shadows
  ['rgb(80 52 255',   'rgb(79 70 229'],
  ['rgb(80, 52, 255', 'rgb(79, 70, 229'],
  ['rgba(80,52,255',  'rgba(79,70,229'],
  ['rgba(80, 52, 255','rgba(79, 70, 229'],
  // theme-color meta
  ['theme-color" content="#5034ff"', 'theme-color" content="#4f46e5"'],
];

let totalFiles = 0, totalEdits = 0;
const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
htmlFiles.forEach((f) => {
  const full = path.join(ROOT, f);
  let src = fs.readFileSync(full, 'utf8');
  const before = src;

  src = src.split(PURPLE_BRAND).join(INDIGO_BRAND);
  src = src.split(PINK_ACCENT).join(CYAN_ACCENT);
  HEX_MAP.forEach(([from, to]) => { src = src.split(from).join(to); });

  if (src !== before) {
    fs.writeFileSync(full, src);
    totalFiles++;
    const edits = (before.split(PURPLE_BRAND).length - 1)
                + (before.split(PINK_ACCENT).length - 1)
                + HEX_MAP.reduce((n, [from]) => n + (before.split(from).length - 1), 0);
    totalEdits += edits;
    console.log('  ' + f + ': ' + edits + ' edits');
  }
});

console.log('\n=== ' + totalFiles + ' files updated, ' + totalEdits + ' total edits ===');
