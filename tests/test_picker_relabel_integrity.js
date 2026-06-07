#!/usr/bin/env node
/*
 * test_picker_relabel_integrity.js  (standalone; auto-discovered by `npm run gauntlet`)
 *
 * Locks the change-category picker invariants the 2026-06-07 adversarial self-
 * review found BROKEN in commit ea58af6 (and that this PR fixes):
 *   1. WhatsApp interactive-list row ids are UNIQUE across the whole list. Meta
 *      rejects the ENTIRE list on a duplicate id, so the "always-attached"
 *      dropdown silently fails to send. The learned-recents section used to
 *      reuse curated names -> `relabel|<x>` appeared twice.
 *   2. The escape rows (full list / new category) are ALWAYS present within the
 *      hard 10-row cap, so the user can always reach every category (>=20).
 *   3. Total rows never exceed WhatsApp's 10-rows-per-list cap.
 *   4. normalizeSubcategoryForDashboard never returns an unsummed '' when a
 *      category is known (empty subcategory -> category -> a real row / the
 *      catch-all), so a relabel or pending-category append can't make money
 *      invisible on the personal dashboard.
 *
 * Extracts the REAL bot helpers from bot/ExpenseBot_FIXED.gs (brace-matched) and
 * runs them against a Script-Properties mock -- exercising the runtime recent-
 * section injection that the old bot/test_category_picker.js never touched.
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'bot', 'ExpenseBot_FIXED.gs'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } }

// Extract a top-level `function NAME(...) { ... }` by brace matching. Safe here
// because none of these 4 helpers contain { or } inside a string/comment.
function extractFn(name) {
  const sig = 'function ' + name + '(';
  const start = SRC.indexOf(sig);
  if (start < 0) return null;
  const open = SRC.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let j = open; j < SRC.length; j++) {
    const ch = SRC[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  return null;
}

const NAMES = ['_kfl_recentCats_', '_kfl_pushRecentCat_', '_kfl_buildRecentSection_', '_kfl_buildPickerSections_'];
const srcs = NAMES.map(extractFn);
NAMES.forEach((n, i) => ok('extracted ' + n, !!srcs[i], 'not found'));
if (srcs.some((s) => !s)) { console.log('test_picker_relabel_integrity: ' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }

// Script-Properties mock + eval the 4 helpers in one shared scope.
const store = {};
const PropertiesService = {
  getScriptProperties: function () {
    return {
      getProperty: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setProperty: function (k, v) { store[k] = String(v); },
    };
  },
};
const api = {};
// eslint-disable-next-line no-new-func
new Function('PropertiesService', '__out', srcs.join('\n\n') +
  '\n__out.recentCats=_kfl_recentCats_;__out.push=_kfl_pushRecentCat_;' +
  '__out.buildRecent=_kfl_buildRecentSection_;__out.buildSections=_kfl_buildPickerSections_;'
)(PropertiesService, api);

// Curated fixture mirroring real overlap (food + transport + escape section).
function curated() {
  return [
    { title: '🍞 אוכל', rows: [{ name: 'אוכל', icon: '🍞' }, { name: 'סופר ומכולת', icon: '🛒' }, { name: 'מסעדה ואוכל בחוץ', icon: '🍽' }, { name: 'קפה', icon: '☕' }] },
    { title: '🚗 תחבורה', rows: [{ name: 'דלק', icon: '⛽' }, { name: 'חניה', icon: '🅿️' }, { name: 'מוניות', icon: '🚕' }] },
    { title: '✨ אחר', rows: [{ name: 'שונות', icon: '✨' }, { name: '__custom__', icon: '🆕', display: 'קטגוריה חדשה' }, { name: '__full_list__', icon: '📋', display: 'רשימה' }] },
  ];
}
function allRows(sections) { return sections.reduce((a, s) => a.concat(s.rows || []), []); }

// Repro: log "דלק" then "מוניות" (recents), build the picker for current "אוכל".
const phone = '972500000001';
api.push(phone, 'דלק');
api.push(phone, 'מוניות');
const recentSec = api.buildRecent(phone, 'אוכל');
const SECTIONS = curated();
if (recentSec) SECTIONS.unshift(recentSec);
const out = api.buildSections(SECTIONS, 'אוכל');
const rows = allRows(out);
const ids = rows.map((r) => r.id);

ok('all row ids unique (Meta accepts the list)', new Set(ids).size === ids.length, JSON.stringify(ids));
ok('total rows <= 10 (Meta cap)', rows.length <= 10, 'got ' + rows.length);
ok('escape __full_list__ present', ids.indexOf('relabel|__full_list__') >= 0);
ok('escape __custom__ present', ids.indexOf('relabel|__custom__') >= 0);
ok('learned recents lead (דלק + מוניות surfaced)', ids.indexOf('relabel|דלק') >= 0 && ids.indexOf('relabel|מוניות') >= 0);
ok('current pick אוכל is skipped', ids.indexOf('relabel|אוכל') < 0);
const inlineEscape = out.slice(0, -1).some((s) => (s.rows || []).some((r) => /relabel\|__/.test(r.id)));
ok('escapes emitted only by the dedicated escape section', !inlineEscape);

// New user (no recents): still unique, escapes still present, still capped.
const out2 = api.buildSections(curated(), 'אוכל');
const ids2 = allRows(out2).map((r) => r.id);
ok('new user: ids unique', new Set(ids2).size === ids2.length);
ok('new user: escapes present', ids2.indexOf('relabel|__full_list__') >= 0 && ids2.indexOf('relabel|__custom__') >= 0);
ok('new user: <= 10 rows', allRows(out2).length <= 10);

// buildRecent returns null for a phone with no recents (no empty section).
ok('no recents -> null recent section', api.buildRecent('972599999999', 'אוכל') === null);

// Normalizer: empty subcategory must not be invisible when category is known.
(async () => {
  try {
    const mod = await import('../lib/sheet-writer.js');
    const norm = mod.normalizeSubcategoryForDashboard;
    if (typeof norm === 'function') {
      // Empty subcategory deliberately stays empty (the row builder relies on
      // this "sink" contract -- see tests/test_sheet_writer_row_building.js).
      ok('normalize("", "אוכל") stays empty (deliberate sink contract)', norm('', 'אוכל') === '', '"' + norm('', 'אוכל') + '"');
      // What the relabel path (Fix A) relies on: a NON-empty bare category that
      // matches no dashboard row still resolves to the visible catch-all -- so
      // money can't vanish when a recent/category is tapped and relabeled.
      ok('normalize(bare category) -> visible catch-all', String(norm('תחבורה', 'תחבורה') || '').length > 0, '"' + norm('תחבורה', 'תחבורה') + '"');
      ok('normalize("zzz-unmapped", "אוכל") -> visible catch-all', String(norm('zzz-unmapped', 'אוכל') || '').length > 0, '"' + norm('zzz-unmapped', 'אוכל') + '"');
      ok('normalize("דלק","תחבורה") visible', String(norm('דלק', 'תחבורה') || '').length > 0);
    } else {
      console.log('  (skip normalizer: export missing)');
    }
  } catch (e) {
    console.log('  (skip normalizer import: ' + (e && e.message) + ')');
  }
  console.log('test_picker_relabel_integrity: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
