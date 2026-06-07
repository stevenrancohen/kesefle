// tests/bot/test_category_picker.js
//
// Validates the expanded category picker (PR — Steven asked for 30+ more
// categories 2026-05-26). Loads the real source file, extracts the
// SECTIONS array via balanced-brace parsing (no eval), and asserts the
// 4-tier QA contract:
//
//   Tier 1 (functional): ≥30 categories, 4 sections, every row has icon+name
//   Tier 2 (boundary):   no title >24 chars, no section >10 rows, no >10 sections
//   Tier 3 (negative):   no duplicate names across sections, no empty rows
//   Tier 4 (adversarial): "אחר" (catch-all) exists once and only once
//
// Run: node bot/test_category_picker.js
// Hooked into tests/full_qa.js gauntlet.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; fails.push(label); console.log('  ❌ ' + label); }
}

// ── Extract SECTIONS via balanced-bracket parsing ─────────────────────────
const startMarker = 'var SECTIONS = [';
const startIdx = src.indexOf(startMarker);
if (startIdx < 0) {
  console.log('FATAL: var SECTIONS = [ not found in ExpenseBot_FIXED.gs');
  process.exit(1);
}
// Walk forward counting brackets until we close the top-level array.
let depth = 0, i = startIdx + startMarker.length - 1;
for (; i < src.length; i++) {
  if (src[i] === '[') depth++;
  else if (src[i] === ']') { depth--; if (depth === 0) { i++; break; } }
}
const literal = src.slice(startIdx + startMarker.length - 1, i); // includes the outer [ ]

// Pull out each section's title + names without eval. Simple regex is fine
// for our known shape.
const sectionRe = /title:\s*'([^']+)',\s*rows:\s*\[([\s\S]*?)\]\s*,?\s*\}/g;
const sections = [];
let m;
while ((m = sectionRe.exec(literal)) !== null) {
  const title = m[1];
  const rowsBlock = m[2];
  // Tolerate optional trailing fields after icon (e.g. cat/sub/display tags):
  // `{ name: 'X', icon: 'Y', cat: 'עסק', sub: 'שיווק' }`. [^}]* stops at the row's
  // closing brace, so extra keys are skipped without missing the row.
  const rowRe = /name:\s*'([^']+)',\s*icon:\s*'([^']+)'[^}]*\}/g;
  const rows = [];
  let rm;
  while ((rm = rowRe.exec(rowsBlock)) !== null) {
    rows.push({ name: rm[1], icon: rm[2] });
  }
  sections.push({ title, rows });
}

console.log('\n══ Category picker QA — Tier 1 functional ══');
ok('SECTIONS array parsed', sections.length > 0);
// PR-3 (2026-05-26): picker expanded from 4 to 10 sections per the canonical
// buckets in docs/BOT_MENU_FIRST_POLICY.md (food, home, transport, personal,
// education-kids, leisure, business, financial, income, other).
ok('Has 7-10 sections (post PR-3)', sections.length >= 7 && sections.length <= 10);

const allRows = sections.flatMap(s => s.rows);
ok('At least 30 categories total', allRows.length >= 30);
console.log('  → ' + allRows.length + ' categories across ' + sections.length + ' sections');
ok('Every row has a non-empty name', allRows.every(r => r.name && r.name.length > 0));
ok('Every row has an icon', allRows.every(r => r.icon && r.icon.length > 0));

console.log('\n══ Tier 2 boundary ══');
ok('Section count ≤ 10 (WhatsApp cap)', sections.length <= 10);
ok('No section has > 10 rows (WhatsApp cap)', sections.every(s => s.rows.length <= 10));
const longTitles = allRows.filter(r => (r.icon + ' ' + r.name).length > 24);
ok('No row title > 24 chars after icon+name', longTitles.length === 0);
if (longTitles.length) console.log('  → offenders: ' + longTitles.map(r => r.name + '(' + (r.icon + ' ' + r.name).length + ')').join(', '));
ok('No section title > 24 chars', sections.every(s => s.title.length <= 24));

console.log('\n══ Tier 3 negative ══');
const names = allRows.map(r => r.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
ok('No duplicate category names across sections', dupes.length === 0);
if (dupes.length) console.log('  → duplicates: ' + [...new Set(dupes)].join(', '));
ok('No row name contains the pipe separator (would collide with id parsing)', !names.some(n => n.indexOf('|') >= 0));

console.log('\n══ Tier 4 adversarial ══');
// PR-3: catch-all moved from "אחר" (which collided with the section title) to
// "שונות". The "אחר" section title still exists, but no row is named "אחר".
const catchAllCount = names.filter(n => n === 'שונות').length;
ok('Catch-all "שונות" exists exactly once', catchAllCount === 1);
const incomeSection = sections.find(s => s.title.includes('הכנסות'));
ok('Income section exists', !!incomeSection);
ok('Income section contains משכורת', incomeSection && incomeSection.rows.some(r => r.name === 'משכורת'));
const businessSection = sections.find(s => s.title.includes('עסק'));
ok('Business section exists', !!businessSection);
ok('Business section contains שיווק ופרסום', businessSection && businessSection.rows.some(r => r.name === 'שיווק ופרסום'));
// PR-3 renamed "עובדים" -> "שכר עובדים" to make the row title cleaner.
ok('Business section contains שכר עובדים', businessSection && businessSection.rows.some(r => r.name === 'שכר עובדים'));

console.log('\n──────────────────────────────────────');
console.log(`PASS: ${pass}   FAIL: ${fail}`);
if (fail > 0) {
  console.log('Failed: ' + fails.join(', '));
  process.exit(1);
}
console.log('✅ Category picker QA: ALL TESTS PASSED (' + pass + ' assertions)');
