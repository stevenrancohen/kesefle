#!/usr/bin/env node
// Adds Rubik 900 display font for headings across every HTML page.
// Idempotent. Run: node scripts/add-display-font.js

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// Google Fonts URL with Rubik added.
const OLD_FONTS_URL = /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Heebo:wght@300;400;500;600;700;800;900[^"]*"[^>]*>/;
const NEW_FONTS_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;600;700;800;900&family=Rubik:wght@600;700;800;900&family=Inter:wght@400;500;600;700;800;900&display=swap" />';

// CSS block injected once per page (right after body { font-family ... }).
const CSS_BLOCK = `
  /* Display font (Steven 2026-05-26): Rubik 900 for headings, Behance-style. */
  h1, h2, h3 {
    font-family: 'Rubik', 'Heebo', system-ui, sans-serif;
    font-weight: 900;
    letter-spacing: -0.035em;
    line-height: 1;
  }
  h4, h5 {
    font-family: 'Rubik', 'Heebo', system-ui, sans-serif;
    font-weight: 800;
    letter-spacing: -0.02em;
  }`;
const MARKER = "/* Display font (Steven 2026-05-26):";

const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
let updated = 0;
htmlFiles.forEach((f) => {
  const full = path.join(ROOT, f);
  let src = fs.readFileSync(full, 'utf8');
  const before = src;

  // Skip if already updated (marker present).
  if (src.indexOf(MARKER) >= 0) return;

  // 1. Swap the Google Fonts URL to include Rubik.
  src = src.replace(OLD_FONTS_URL, NEW_FONTS_LINK);

  // 2. Inject the heading CSS after `body { font-family: 'Heebo' ... }`
  // (or after the first `<style>` open if no body rule found).
  if (src.indexOf("body { font-family: 'Heebo'") >= 0) {
    src = src.replace(
      /(body \{ font-family: 'Heebo'[^}]*\})/,
      `$1${CSS_BLOCK}`
    );
  } else if (src.indexOf('<style>') >= 0) {
    src = src.replace(/<style>/, `<style>${CSS_BLOCK}`);
  }

  if (src !== before) {
    fs.writeFileSync(full, src);
    updated++;
    console.log('  ' + f);
  }
});
console.log('\n=== ' + updated + ' files updated with display font ===');
