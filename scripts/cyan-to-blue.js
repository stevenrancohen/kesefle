#!/usr/bin/env node
// cyan-to-blue.js — retone the entire Kesefle site from cyan to blue.
//
// The dashboard and app were already blue (#3b82f6 / #2563eb).
// This script makes the marketing pages + residual dashboard fragments
// cohesively blue to match.
//
// Mapping rationale:
//   cyan-600 (#0891b2)  -> blue-600  (#2563eb)  [primary interactive]
//   cyan-700 (#0e7490)  -> blue-700  (#1d4ed8)  [darker/hover states]
//   cyan-800 (#155e75)  -> blue-800  (#1e40af)  [deepest tones]
//   cyan-900 (#164e63)  -> blue-900  (#1e3a8a)  [Tailwind brand block]
//   cyan-500 (#06b6d4)  -> blue-500  (#3b82f6)  [lighter accents]
//   cyan-400 (#22d3ee)  -> sky-400   (#38bdf8)  [very light accent - sky is fine here]
//   cyan-300 (#67e8f9)  -> sky-300   (#7dd3fc)  [light gradient stops]
//   cyan-200 (#a5f3fc)  -> sky-200   (#bae6fd)  [ultra-light tints]
//   cyan-100 (#cffafe)  -> sky-100   (#e0f2fe)  [barely-there tints]
//   cyan-50  (#ecfeff)  -> sky-50    (#f0f9ff)  [hover backgrounds]
//
//   rgba(6,182,212,...)  -> rgba(59,130,246,...)   [box-shadow blue glow]
//   rgba(8,145,178,...)  -> rgba(37,99,235,...)    [darker glow]
//   rgba(14,116,144,...) -> rgba(29,78,216,...)    [darkest rgba]
//   UPPERCASE variants handled too (#06B6D4 etc)
//
// Idempotent. Run: node scripts/cyan-to-blue.js
// Does NOT touch scripts/complete-tailwind-palette.js or the ink/neutral palette.

'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// --- Tailwind brand block replacements ---
// (exact string match so we swap the whole brand scale atomically)
const BRAND_BLOCKS = [
  // most pages (space after colon + no space variants)
  [
    "brand:   { 50:'#ecfeff', 100:'#cffafe', 200:'#a5f3fc', 300:'#67e8f9', 400:'#22d3ee', 500:'#06b6d4', 600:'#0891b2', 700:'#0e7490', 800:'#155e75', 900:'#164e63' },",
    "brand:   { 50:'#f0f9ff', 100:'#e0f2fe', 200:'#bae6fd', 300:'#7dd3fc', 400:'#38bdf8', 500:'#3b82f6', 600:'#2563eb', 700:'#1d4ed8', 800:'#1e40af', 900:'#1e3a8a' },"
  ],
  // welcome.html variant (different key order)
  [
    "brand: { 50:'#ecfeff', 100:'#cffafe', 500:'#0891b2', 600:'#0e7490', 700:'#155e75', 200:'#a5f3fc', 300:'#67e8f9', 400:'#22d3ee', 800:'#155e75', 900:'#164e63' }",
    "brand: { 50:'#f0f9ff', 100:'#e0f2fe', 500:'#3b82f6', 600:'#2563eb', 700:'#1d4ed8', 200:'#bae6fd', 300:'#7dd3fc', 400:'#38bdf8', 800:'#1e40af', 900:'#1e3a8a' }"
  ],
  // admin.html variant (no trailing comma, compact)
  [
    "brand:  { 50:'#ecfeff',100:'#cffafe',200:'#a5f3fc',300:'#67e8f9',400:'#22d3ee',500:'#06b6d4',600:'#0891b2',700:'#0e7490',800:'#155e75',900:'#164e63' },",
    "brand:  { 50:'#f0f9ff',100:'#e0f2fe',200:'#bae6fd',300:'#7dd3fc',400:'#38bdf8',500:'#3b82f6',600:'#2563eb',700:'#1d4ed8',800:'#1e40af',900:'#1e3a8a' },"
  ],
];

// Accent block replacement
const ACCENT_BLOCKS = [
  ["accent:  { 500:'#06b6d4', 600:'#14b8a6' }", "accent:  { 500:'#3b82f6', 600:'#60a5fa' }"],
  ["accent:  { 500:'#06b6d4', 600:'#14b8a6' }", "accent:  { 500:'#3b82f6', 600:'#60a5fa' }"],
  ["accent: { 400:'#22d3ee',500:'#06b6d4',600:'#14b8a6' }", "accent: { 400:'#38bdf8',500:'#3b82f6',600:'#60a5fa' }"],
];

// --- Hex color replacements (order matters: more specific / darker first) ---
const HEX_MAP = [
  // Cyan scale -> Blue/Sky scale
  // 600 (primary): #0891b2 -> #2563eb (blue-600)
  ['#0891b2', '#2563eb'],
  ['#0891B2', '#2563eb'],
  // 700: #0e7490 -> #1d4ed8 (blue-700)
  ['#0e7490', '#1d4ed8'],
  ['#0E7490', '#1d4ed8'],
  // 800: #155e75 -> #1e40af (blue-800)
  ['#155e75', '#1e40af'],
  ['#155E75', '#1e40af'],
  // 900: #164e63 -> #1e3a8a (blue-900)
  ['#164e63', '#1e3a8a'],
  ['#164E63', '#1e3a8a'],
  // 500: #06b6d4 -> #3b82f6 (blue-500)
  ['#06b6d4', '#3b82f6'],
  ['#06B6D4', '#3b82f6'],
  // 400: #22d3ee -> #38bdf8 (sky-400 — deliberately lighter accent)
  ['#22d3ee', '#38bdf8'],
  ['#22D3EE', '#38bdf8'],
  // 300: #67e8f9 -> #7dd3fc (sky-300)
  ['#67e8f9', '#7dd3fc'],
  ['#67E8F9', '#7dd3fc'],
  // 200: #a5f3fc -> #bae6fd (sky-200)
  ['#a5f3fc', '#bae6fd'],
  ['#A5F3FC', '#bae6fd'],
  // 100: #cffafe -> #e0f2fe (sky-100)
  ['#cffafe', '#e0f2fe'],
  ['#CFFAFE', '#e0f2fe'],
  // 50: #ecfeff -> #f0f9ff (sky-50)
  ['#ecfeff', '#f0f9ff'],
  ['#ECFEFF', '#f0f9ff'],
];

// --- rgba/rgb replacements ---
// cyan rgb(6,182,212) -> blue rgb(59,130,246)
// cyan rgba(...) glows become blue glows
const RGBA_MAP = [
  // Various spacing forms of rgba(6,182,212,...)
  ['rgba(  6,182,212,', 'rgba(59,130,246,'],
  ['rgba(6,182,212,',   'rgba(59,130,246,'],
  ['rgba(6, 182, 212,', 'rgba(59, 130, 246,'],
  ['rgba( 6, 182, 212,','rgba(59, 130, 246,'],
  // rgba(8,145,178,...) darker cyan -> rgba(37,99,235,...) blue-600
  ['rgba(8,145,178,',   'rgba(37,99,235,'],
  ['rgba(8, 145, 178,', 'rgba(37, 99, 235,'],
  // rgba(14,116,144,...) cyan-700 -> rgba(29,78,216,...) blue-700
  ['rgba(14,116,144,',  'rgba(29,78,216,'],
  ['rgba(14, 116, 144,','rgba(29, 78, 216,'],
  // rgb(6,182,212) solid form
  ['rgb(6,182,212)',    'rgb(59,130,246)'],
  ['rgb(6, 182, 212)', 'rgb(59, 130, 246)'],
];

// --- Collect target files ---
// Root-level public *.html + admin/*.html
function collectHtml() {
  const files = [];
  fs.readdirSync(ROOT)
    .filter(f => f.endsWith('.html'))
    .forEach(f => files.push(path.join(ROOT, f)));
  const adminDir = path.join(ROOT, 'admin');
  if (fs.existsSync(adminDir)) {
    fs.readdirSync(adminDir)
      .filter(f => f.endsWith('.html'))
      .forEach(f => files.push(path.join(adminDir, f)));
  }
  return files;
}

// --- Apply all replacements to a string ---
function applyReplacements(src) {
  // 1. Brand blocks (exact string, in-order)
  for (const [from, to] of BRAND_BLOCKS) {
    src = src.split(from).join(to);
  }
  // 2. Accent blocks
  for (const [from, to] of ACCENT_BLOCKS) {
    src = src.split(from).join(to);
  }
  // 3. rgba/rgb (before hex so we don't corrupt the rgb numbers)
  for (const [from, to] of RGBA_MAP) {
    src = src.split(from).join(to);
  }
  // 4. Hex values
  for (const [from, to] of HEX_MAP) {
    src = src.split(from).join(to);
  }
  return src;
}

// --- Main ---
const files = collectHtml();
let totalFiles = 0, totalEdits = 0;
const changed = [];

for (const fullPath of files) {
  const original = fs.readFileSync(fullPath, 'utf8');
  const updated  = applyReplacements(original);

  if (updated !== original) {
    fs.writeFileSync(fullPath, updated, 'utf8');
    totalFiles++;

    // Count approximate substitutions
    let edits = 0;
    for (const [from] of BRAND_BLOCKS) edits += (original.split(from).length - 1);
    for (const [from] of ACCENT_BLOCKS) edits += (original.split(from).length - 1);
    for (const [from] of RGBA_MAP) edits += (original.split(from).length - 1);
    for (const [from] of HEX_MAP) edits += (original.split(from).length - 1);
    totalEdits += edits;

    const rel = path.relative(ROOT, fullPath);
    changed.push(rel);
    console.log('  ' + rel + ': ' + edits + ' edits');
  }
}

console.log('\n=== cyan-to-blue: ' + totalFiles + ' files updated, ' + totalEdits + ' total substitutions ===');
if (changed.length) {
  console.log('Changed: ' + changed.join(', '));
}
