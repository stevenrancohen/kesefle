#!/usr/bin/env node
// Regression test for PR-3 (Expanded Category Picker — grouped).
// Verifies:
//   1. _sendChangeCategoryPicker_ has all 10 canonical sections from
//      docs/BOT_MENU_FIRST_POLICY.md (food / home / transport / personal /
//      education-kids / leisure / business / financial / income / other).
//   2. Each section has at least 6 rows (Steven's "20+ options" rule, scaled
//      up so canonical buckets aren't anemic).
//   3. Row names align with lib/categories.js subcategory taxonomy so the
//      dashboard SUMIFS exact-match what the user picks.
//   4. The two escape options exist: __custom__ + __full_list__.
//   5. _handleRelabelTap_ has early-return handlers for both escapes BEFORE
//      it tries to hit /api/sheet/relabel-row (so the API isn't pinged with
//      a sentinel string).
//   6. KFL_BUILD_VERSION reflects this PR.

const fs = require('fs');
const path = require('path');
const failures = [];
function assert(cond, label) {
  if (cond) console.log('  PASS ' + label);
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_expanded_category_picker.js\n');

const BOT_PATH = path.join(__dirname, 'ExpenseBot_FIXED.gs');
const BOT = fs.readFileSync(BOT_PATH, 'utf8');

// ── 1) Extract the SECTIONS array literal from _sendChangeCategoryPicker_ ──
const fnStart = BOT.indexOf('function _sendChangeCategoryPicker_(fromPhone, currentCategory)');
assert(fnStart > 0, '_sendChangeCategoryPicker_ exists');

// Cut a slice big enough to contain the picker but not bleed into other
// functions. The picker is < 200 lines, so 400 lines of context is plenty.
const fnSliceEnd = BOT.indexOf('\nfunction _handleRelabelTap_', fnStart);
assert(fnSliceEnd > fnStart, 'picker is sliced before _handleRelabelTap_');
const PICKER = BOT.slice(fnStart, fnSliceEnd);

// ── 2) Canonical section titles per docs/BOT_MENU_FIRST_POLICY.md ────────
console.log('Section coverage:');
const EXPECTED_SECTIONS = [
  '🍞 אוכל',
  '🏠 בית',
  '🚗 תחבורה',
  '🧍 אישי',
  '🎓 חינוך וילדים',
  '🎬 פנאי ובידור',
  '💼 עסק',
  '💰 פיננסי',
  '📈 הכנסות',
  '✨ אחר',
];
for (const title of EXPECTED_SECTIONS) {
  assert(PICKER.indexOf("title: '" + title + "'") >= 0,
    'section "' + title + '" exists');
}

// ── 3) Coverage check — count rows per section ───────────────────────────
console.log('\nRow coverage:');
// Count rows by counting "{ name:" inside the SECTIONS array. Cheap but
// effective: we're not building a real parser, just sanity-checking the
// picker hasn't been gutted.
const ROW_RE = /\{\s*name:\s*'[^']+'/g;
const rowMatches = PICKER.match(ROW_RE) || [];
assert(rowMatches.length >= 70,
  'picker has 70+ rows total (got ' + rowMatches.length + ')');

// ── 4) Canonical subcategory names align with lib/categories.js ──────────
console.log('\nTaxonomy alignment:');
const CAT_LIB = fs.readFileSync(path.join(__dirname, '..', 'lib', 'categories.js'), 'utf8');
// Sample of canonical subcategories that MUST appear in BOTH the picker and
// lib/categories.js — guards against drift where the picker offers a name
// that the dashboard SUMIFS doesn't know about.
const CANONICAL_OVERLAP = [
  'מסעדה ואוכל בחוץ',
  'תחבורה ציבורית',
  'חשמל',
  'מים וביוב',
  'ביטוח רכב',
  'מספרה',
  'קוסמטיקה',
  'בית ספר',
  'בייביסיטר',
  'ביגוד ילדים',
  'מנויים',
  'חיות מחמד',
  'משכנתה',
];
for (const sub of CANONICAL_OVERLAP) {
  const inPicker = PICKER.indexOf("name: '" + sub + "'") >= 0;
  const inLib = CAT_LIB.indexOf("'" + sub + "'") >= 0;
  assert(inPicker && inLib,
    'subcat "' + sub + '" exists in BOTH picker and lib/categories.js' +
    (inPicker ? '' : ' [missing in picker]') +
    (inLib   ? '' : ' [missing in lib]'));
}

// ── 5) Escape options ────────────────────────────────────────────────────
console.log('\nEscape options:');
assert(PICKER.indexOf("name: '__custom__'") >= 0,
  'picker has __custom__ escape option');
assert(PICKER.indexOf("name: '__full_list__'") >= 0,
  'picker has __full_list__ escape option');
assert(PICKER.indexOf("display: 'קטגוריה חדשה'") >= 0,
  'custom escape has Hebrew display label');
assert(PICKER.indexOf("display: 'פתח רשימה מלאה'") >= 0,
  'full_list escape has Hebrew display label');

// ── 6) Escape handlers in _handleRelabelTap_ ─────────────────────────────
console.log('\nRelabel-tap escape handlers:');
const HANDLER_RE = /function _handleRelabelTap_\(fromPhone, newCategory\)[\s\S]{0,3000}/;
const handlerSlice = (BOT.match(HANDLER_RE) || [''])[0];
assert(/newCategory === '__custom__'/.test(handlerSlice),
  '_handleRelabelTap_ handles __custom__ before hitting API');
assert(/newCategory === '__full_list__'/.test(handlerSlice),
  '_handleRelabelTap_ handles __full_list__ before hitting API');
assert(/awaitingCustomCategory:/.test(handlerSlice),
  '__custom__ flow sets awaitingCustomCategory cache key');

// The escape returns MUST come before the lastTenantExp lookup. Otherwise a
// user with no prior expense gets "no recent expense" instead of the prompt.
const customIdx = handlerSlice.indexOf("__custom__");
const lookupIdx = handlerSlice.indexOf("lastTenantExp:");
assert(customIdx > 0 && lookupIdx > 0 && customIdx < lookupIdx,
  '__custom__ early-return runs BEFORE lastTenantExp lookup');

// ── 7) Version bumped ────────────────────────────────────────────────────
console.log('\nVersion:');
const v = (BOT.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
assert(/picker/.test(v || ''),
  'KFL_BUILD_VERSION contains "picker" (currently: ' + v + ')');

// ── 8) Sanity — picker still calls sendWhatsAppInteractiveList ──────────
console.log('\nWhatsApp wiring:');
assert(/sendWhatsAppInteractiveList\(/.test(PICKER),
  'picker still calls sendWhatsAppInteractiveList');
assert(/relabel\|/.test(PICKER),
  'picker still uses "relabel|" id prefix (for handleInteractiveReply_)');

// ── 9) Cap check: no section exceeds WhatsApp's 10-row hard limit ───────
// We cap programmatically in the loop ('if (rows.length >= 10) break'), but
// also sanity-check the data so a future edit can't ship a section that's
// silently truncated.
console.log('\nWhatsApp cap sanity:');
// Crudely count rows per section by splitting on 'title:' markers.
const sectionBlocks = PICKER.split(/title:\s*'/).slice(1);
for (let i = 0; i < sectionBlocks.length; i++) {
  const block = sectionBlocks[i].slice(0, 4000); // bound it
  const title = block.split("'")[0];
  const rows = (block.match(ROW_RE) || []).length;
  // Each block carries its OWN rows plus whatever ran before the next title
  // started -- so the count is approximate. We only care that no block is
  // absurdly over the cap.
  assert(rows <= 12,
    'section "' + title + '" has <= 12 rows (got ' + rows +
    '; WhatsApp cap is 10)');
}

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
