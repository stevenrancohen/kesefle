#!/usr/bin/env node
// Light-mode flip — converts the leftover dark-only sections (bg-ink-900,
// bg-ink-950 with white text inside) to white-on-dark-text so the site
// reads cleanly with class="dark" removed from <html>.
//
// Idempotent. Run: node scripts/light-mode-flip.js

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Class swaps. Order matters — longer/more-specific patterns first.
const SWAPS = [
  // dark backgrounds -> white
  ['bg-ink-950/40', 'bg-ink-50'],
  ['bg-ink-950/60', 'bg-ink-50'],
  ['bg-ink-950/70', 'bg-ink-50'],
  ['bg-ink-950',    'bg-white'],
  ['bg-ink-900/40', 'bg-ink-50'],
  ['bg-ink-900/60', 'bg-ink-50'],
  ['bg-ink-900/70', 'bg-ink-50'],
  ['bg-ink-900/80', 'bg-white'],
  ['bg-ink-900',    'bg-white'],
  ['bg-ink-800/60', 'bg-ink-50'],
  ['bg-ink-800/70', 'bg-ink-50'],
  ['bg-ink-800/90', 'bg-white'],
  ['bg-ink-800',    'bg-white'],

  // dark borders -> light gray borders
  ['border-ink-700', 'border-ink-200'],
  ['border-ink-800', 'border-ink-200'],
  ['border-white/10', 'border-ink-200'],
  ['border-white/20', 'border-ink-200'],

  // dark mode text colors used as defaults -> light alternatives
  ['text-ink-100',  'text-ink-700'],
  ['text-ink-200',  'text-ink-700'],
  ['text-ink-300',  'text-ink-600'],
  ['text-ink-400',  'text-ink-500'],
];

let totalFiles = 0, totalSwaps = 0;
const htmlFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
htmlFiles.forEach((f) => {
  const full = path.join(ROOT, f);
  let src = fs.readFileSync(full, 'utf8');
  const before = src;
  let fileSwaps = 0;
  SWAPS.forEach(([from, to]) => {
    // ONLY replace when the class is NOT prefixed with "dark:" (those
    // are intentional dark-mode-specific styles we want to leave alone).
    // Use a negative lookbehind via split-on-prefix.
    const parts = src.split(from);
    const next = [];
    for (let i = 0; i < parts.length; i++) {
      next.push(parts[i]);
      if (i < parts.length - 1) {
        // Check if the previous part ends with "dark:" or "hover:dark:" etc.
        const tail = parts[i].slice(-12);
        if (/(^|\s|"|:)dark:$/.test(tail) || /(^|\s|"):hover:dark:$/.test(tail)) {
          next.push(from); // keep -- it's a dark: variant
        } else {
          next.push(to);
          fileSwaps++;
        }
      }
    }
    src = next.join('');
  });

  if (src !== before) {
    fs.writeFileSync(full, src);
    totalFiles++;
    totalSwaps += fileSwaps;
    console.log('  ' + f + ': ' + fileSwaps + ' swaps');
  }
});

console.log('\n=== ' + totalFiles + ' files updated, ' + totalSwaps + ' class swaps ===');
