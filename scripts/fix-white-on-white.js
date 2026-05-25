#!/usr/bin/env node
// Find class attributes that contain BOTH a white-ish bg (bg-white,
// bg-ink-50) AND text-white. Replace `text-white` with `text-ink-900`
// in those specific cases so we don't render invisible text on the
// sections we just flipped from dark to light.
//
// Conservative: only edits the class attribute as a whole; never
// touches text-white on elements whose bg is colored (brand, accent,
// arbitrary like bg-[#25d366]).
//
// Run: node scripts/fix-white-on-white.js

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));

// Match either single- or double-quoted class attributes.
const CLASS_RE = /class=(["'])([^"']*)\1/g;
// White-ish bg detector + text-white detector.
const HAS_WHITE_BG = /(?:^|\s)(?:bg-white|bg-ink-50)(?:\s|\/|$)/;
const HAS_TEXT_WHITE = /(?:^|\s)text-white(?:\s|$)/;

let totalFiles = 0, totalEdits = 0;
htmlFiles.forEach((f) => {
  const full = path.join(ROOT, f);
  let src = fs.readFileSync(full, 'utf8');
  let fileEdits = 0;
  src = src.replace(CLASS_RE, (full, quote, classes) => {
    if (HAS_WHITE_BG.test(classes) && HAS_TEXT_WHITE.test(classes)) {
      // Replace EXACT `text-white` token only (not text-white/X opacity)
      const next = classes.replace(/(^|\s)text-white(?=\s|$)/g, '$1text-ink-900');
      if (next !== classes) {
        fileEdits++;
        return 'class=' + quote + next + quote;
      }
    }
    return full;
  });
  if (fileEdits) {
    fs.writeFileSync(full, src);
    totalFiles++;
    totalEdits += fileEdits;
    console.log('  ' + f + ': ' + fileEdits + ' white-on-white fixes');
  }
});

console.log('\n=== ' + totalFiles + ' files, ' + totalEdits + ' class-list fixes ===');
