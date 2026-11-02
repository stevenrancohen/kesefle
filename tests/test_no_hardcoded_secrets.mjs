// tests/test_no_hardcoded_secrets.mjs — repo guard (no network).
// Fails if a personal WhatsApp number, a wa.me/<digits> link, a Meta access
// token (EAA…) or the retired webhook verify token appears in the repo
// outside the single number config (config/kesefle-numbers.js).
//
// Legacy spots that still need a manual migration are frozen in
// tests/no_hardcoded_secrets.baseline.json as per-file match COUNTS:
//   - a NEW file with a match            -> FAIL
//   - a baseline file whose count grows  -> FAIL
//   - a count that shrinks               -> pass (prints a hint to lower the baseline)
// Tokens are NEVER baselined: any EAA… / verify-token hit fails.
// Regenerate (only after review!):  node tests/test_no_hardcoded_secrets.mjs --write-baseline
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'tests/no_hardcoded_secrets.baseline.json');
const SELF = 'tests/test_no_hardcoded_secrets.mjs';
const ALLOW_FILES = new Set(['config/kesefle-numbers.js', SELF, 'tests/no_hardcoded_secrets.baseline.json']);
const MOCK_DIGITS = new Set(['972500000000', '972500000001', '972599999999', '972541111111']);

// Patterns are assembled from parts so this file does not match itself.
const P = (s) => s.join('');
const NUMBER_RX = [
  new RegExp(P(['9725477', '6064', '3'])), new RegExp(P(['(?<![0-9])0547', '760643'])), new RegExp(P(['054-776-', '0643'])),
  new RegExp(P(['054-7760', '643'])), new RegExp(P(['54-776-', '0643'])), new RegExp(P(['54 776 ', '0643'])),
  new RegExp(P(['9725477', '6636', '1'])), new RegExp(P(['(?<![0-9])0547', '766361'])), new RegExp(P(['54-776-', '6361'])),
];
const WAME_RX = /wa\.me\/\+?(\d{6,})/g;
const TOKEN_RX = [new RegExp(P(['(?<![A-Za-z0-9+/])E', 'AA[A-Za-z0-9]{20,}'])), new RegExp(P(['expense_bot_', 'verify_', '2026']))];
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|otf|mp4|mp3|xlsx|docx|pptx)$/i;

const files = execSync('git ls-files -co --exclude-standard', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter((f) => !BINARY.test(f) && !f.startsWith('node_modules/') && fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());

const counts = {}; const tokenHits = [];
for (const f of files) {
  if (ALLOW_FILES.has(f)) continue;
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  text.split('\n').forEach((line, i) => {
    let n = 0;
    for (const rx of NUMBER_RX) if (rx.test(line)) n++;
    for (const m of line.matchAll(WAME_RX)) if (!MOCK_DIGITS.has(m[1])) n++;
    if (n) counts[f] = (counts[f] || 0) + n;
    for (const rx of TOKEN_RX) if (rx.test(line)) tokenHits.push(`${f}:${i + 1}`);
  });
}

if (process.argv.includes('--write-baseline')) {
  fs.writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(Object.entries(counts).sort()), null, 2) + '\n');
  console.log('baseline written:', Object.keys(counts).length, 'files'); process.exit(0);
}

const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const errors = []; const hints = [];
for (const t of tokenHits) errors.push('SECRET (token/verify token) at ' + t);
for (const [f, n] of Object.entries(counts)) {
  if (!(f in base)) errors.push(`NEW hardcoded number / wa.me/<digits> in ${f} (${n}) — use config/kesefle-numbers.js, /wa, or lib/wa-config.js`);
  else if (n > base[f]) errors.push(`MORE hardcoded numbers in ${f}: ${n} > baseline ${base[f]}`);
  else if (n < base[f]) hints.push(`${f}: ${n} < baseline ${base[f]} (lower the baseline)`);
}
// Production surfaces must be fully clean (never baselined).
for (const f of Object.keys(base)) if (/^(api|lib|js)\//.test(f) || (/\.html$/.test(f) && !f.includes('/'))) errors.push('baseline must not cover production file ' + f);

hints.forEach((h) => console.log('  hint ' + h));
console.log(`scanned ${files.length} files; ${Object.keys(counts).length} with legacy matches (baseline ${Object.keys(base).length}); ${tokenHits.length} token hits`);
if (errors.length) { errors.forEach((e) => console.log('  FAIL ' + e)); console.log(`test_no_hardcoded_secrets: FAIL (${errors.length})`); process.exit(1); }
console.log('test_no_hardcoded_secrets: PASS'); process.exit(0);
