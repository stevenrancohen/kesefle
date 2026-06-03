#!/usr/bin/env node
// bot/test_multiitem_guard.js
// ============================================================================
// MULTI-ITEM NEVER-SILENTLY-CORRUPT regression test.
//
// Background (the bug this guards):
//   The "AI must NEVER silently write a financial row when low-confidence /
//   ambiguous" invariant is enforced on the SINGLE-item expense path (the
//   processExpense pre-pass gates on _aiCategorizeRich's contract.should_ask_user
//   + the 0.6 hard floor). But the MULTI-ITEM path
//   (parsed.items.forEach -> matchCategorySmart -> sheet.appendRow) routes every
//   item through matchCategorySmart. matchCategorySmart's old Step-3 called the
//   thin _aiCategorize wrapper, which DISCARDED contract.should_ask_user /
//   needs_review and the 0.6 floor and returned ANY category != 'בלתי מזוהה'.
//   So a {אוכל, confidence 0.45} multi-item result was written SILENTLY.
//
// The fix:
//   matchCategorySmart Step-3 now calls _aiCategorizeRich directly and only
//   returns the AI category when the normalized contract says it is safe to
//   auto-write (!contract.should_ask_user) AND confidence clears the 0.6 hard
//   floor. Otherwise it falls through to the keyword/DEFAULT match
//   (שונות ואחרים / שונות) so the caller files it in the explicit needs-review
//   bucket instead of writing a confident-looking wrong category. The thin
//   _aiCategorize wrapper is disabled (returns null) so NO path can bypass the
//   contract.
//
// What this test does (same balanced-brace-extraction pattern as
// bot/test_ai_contract.js / bot/test_classify.js — loads REAL source, no mocking
// framework, fakes PropertiesService/UrlFetchApp/Logger):
//   * Runs the REAL matchCategorySmart + REAL _normalizeAiClassifyResult_ +
//     REAL _aiAskFloor_ / _isIncomeCategory_ / _kflConfidenceAskThreshold_.
//   * Injects a controllable _aiCategorizeRich that builds its `contract` with
//     the SAME real _normalizeAiClassifyResult_ the production function uses, so
//     the gate is exercised against the real contract semantics (0.6 floor,
//     ambiguous-category handling).
//   * The leaf lookups (_learnedLookup, _autoSynonymLookup_, matchCategory,
//     _globalLearnLookup_, _learnedSave, _hasActivePremium_) are stubbed to
//     steer flow to Step-3, exactly as a genuine new vendor would.
//
// Asserts:
//   1. A 0.45-confidence AI result reached via matchCategorySmart MUST NOT be
//      returned as its (confident) category — it falls through to DEFAULT
//      (שונות ואחרים / שונות), the needs-review bucket. => no silent write.
//   2. A >=0.6 UNAMBIGUOUS AI result IS returned as its category (so the fix
//      does not over-block correct categorizations).
//   3. An ambiguous-bucket result at HIGH numeric confidence (e.g. שונות @0.99)
//      still falls through to DEFAULT (category gate, not just the float).
//   4. The thin _aiCategorize wrapper is disabled (returns null) and is not a
//      live bypass; matchCategorySmart Step-3 wires through _aiCategorizeRich +
//      the contract gate (source grep, so a refactor that drops it trips here).
//
// Run: node bot/test_multiitem_guard.js
// ============================================================================

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

// ── function-body extractor for hoisted `function name(...) { ... }` decls ────
function fn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let p = SRC.indexOf('(', start), pd = 0, k = p;
  for (; k < SRC.length; k++) {
    if (SRC[k] === '(') pd++;
    else if (SRC[k] === ')') { pd--; if (!pd) { k++; break; } }
  }
  let i = SRC.indexOf('{', k), d = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') d++;
    else if (SRC[j] === '}') { d--; if (!d) { j++; break; } }
  }
  return SRC.slice(start, j);
}

// ── balanced-delimiter slice (first `open` after `marker` -> matching closer) ─
function balanced(marker, open, close) {
  const s = SRC.indexOf(marker);
  if (s < 0) throw new Error('marker not found: ' + marker);
  const i = SRC.indexOf(open, s);
  let d = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === open) d++;
    else if (SRC[j] === close) { d--; if (!d) { j++; break; } }
  }
  return SRC.slice(i, j);
}

// ── controllable Apps Script fakes ───────────────────────────────────────────
const scriptProps = {};
const FakeLogger = { log: function () {} };
const FakeProps = {
  getScriptProperties: function () {
    return {
      getProperty: function (k) { return Object.prototype.hasOwnProperty.call(scriptProps, k) ? scriptProps[k] : null; },
      setProperty: function () {}
    };
  }
};
const FakeUrlFetchApp = { fetch: function () { return { getResponseCode: function () { return 200; }, getContentText: function () { return '{}'; } }; } };

// `_aiPlan_` is what the injected _aiCategorizeRich returns to matchCategorySmart.
// Tests set it per-case. null => provider unavailable / gibberish (AI skipped).
let _aiPlan_ = null;
// Records that the (disabled) thin wrapper was never used as a live bypass.
let _learnedSaved = [];

// Build the loadable code. We extract the REAL functions under test + the REAL
// contract normalizer, and inject the leaf dependencies + a controllable
// _aiCategorizeRich (whose contract is built by the SAME real normalizer).
const code = [
  'var _AI_AMBIGUOUS_CATEGORIES_ = ' + balanced('var _AI_AMBIGUOUS_CATEGORIES_ =', '[', ']') + ';',
  // DEFAULT_CATEGORY: the misc / needs-review bucket matchCategorySmart falls back to.
  "var DEFAULT_CATEGORY = { category: 'שונות ואחרים', subcategory: 'שונות', isIncome: false };",

  // ── REAL functions under test ──
  fn('_kflConfidenceAskThreshold_'),
  fn('_isIncomeCategory_'),
  fn('_aiAskFloor_'),
  fn('_normalizeAiClassifyResult_'),
  fn('matchCategorySmart'),

  // ── leaf stubs that steer matchCategorySmart to Step-3 (new vendor) ──
  // No learned cache, no auto-synonym, keyword map misses (returns DEFAULT),
  // no cross-user global hit. Premium present so the AI gate is reached.
  'function _learnedLookup(t) { return null; }',
  'function _autoSynonymLookup_(t) { return null; }',
  'function matchCategory(t) { return { category: DEFAULT_CATEGORY.category, subcategory: DEFAULT_CATEGORY.subcategory, isIncome: false }; }',
  'function _globalLearnLookup_(t) { return null; }',
  'function _learnedSave(t, v, src) { __exports.learnedSaved.push({ text: t, value: v, src: src }); }',
  'function _hasActivePremium_(p) { return true; }',

  // ── controllable _aiCategorizeRich ──
  // Mirrors the REAL function's contract attachment: it builds rich.contract via
  // the REAL _normalizeAiClassifyResult_, so matchCategorySmart's gate is tested
  // against the genuine contract semantics. __exports.aiPlan() returns the raw
  // {category, subcategory, confidence, reason} a provider would yield (or null).
  'function _aiCategorizeRich(text, fromPhone) {',
  '  var raw = __exports.aiPlan();',
  '  if (!raw) return null;',
  '  var rich = { category: raw.category, subcategory: raw.subcategory, confidence: raw.confidence, reason: raw.reason || "" };',
  '  rich.contract = _normalizeAiClassifyResult_(rich, { text: text });',
  '  return rich;',
  '}',

  // ── exports ──
  '__exports.matchCategorySmart = matchCategorySmart;',
  '__exports.normalize = _normalizeAiClassifyResult_;',
  '__exports.DEFAULT = DEFAULT_CATEGORY;',
].join('\n');

const sandbox = {
  aiPlan: function () { return _aiPlan_; },
  learnedSaved: _learnedSaved,
};
new Function(
  'PropertiesService', 'UrlFetchApp', 'Logger', '__exports',
  code
)(FakeProps, FakeUrlFetchApp, FakeLogger, sandbox);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' --- ' + detail : '')); }
}
function isDefault(m) {
  return m && m.category === sandbox.DEFAULT.category && m.subcategory === sandbox.DEFAULT.subcategory;
}
const PHONE = '972500000000';

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== (1) LOW-CONFIDENCE AI via multi-item path => NO silent write ===\n');
// ════════════════════════════════════════════════════════════════════════════
(function () {
  // The exact scenario from the bug report: {אוכל, confidence 0.45}.
  _learnedSaved.length = 0;
  _aiPlan_ = { category: 'אוכל', subcategory: 'אוכל בחוץ', confidence: 0.45, reason: 'ניחוש חלש' };
  const m = sandbox.matchCategorySmart('משהו עמום כלשהו', PHONE);

  check('0.45 AI result is NOT returned as its (confident) category',
    m.category !== 'אוכל', 'got category=' + m.category);
  check('0.45 AI result falls through to DEFAULT (שונות ואחרים / שונות) bucket',
    isDefault(m), JSON.stringify(m));
  // DEFAULT == the needs-review sink: it is the misc bucket, never a confident
  // financial row. (The live caller routes this to the ambiguity/needs_review
  // flow rather than silently filing it under אוכל.)
  check('the withheld low-conf category is NOT learned/cached as a confident AI hit',
    !_learnedSaved.some(function (s) { return s.value && s.value.category === 'אוכל'; }),
    JSON.stringify(_learnedSaved));

  // Cross-check the contract the gate read: should_ask_user must be true at 0.45.
  const c = sandbox.normalize({ category: 'אוכל', subcategory: 'אוכל בחוץ', confidence: 0.45 }, { text: 'x' });
  check('contract for 0.45 sets should_ask_user=true (the gate input)', c.should_ask_user === true);
  check('contract for 0.45 sets needs_review=true', c.needs_review === true);
})();

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== (2) HIGH-CONFIDENCE unambiguous AI via multi-item path => returns it ===\n');
// ════════════════════════════════════════════════════════════════════════════
(function () {
  // >= 0.6 floor AND >= default env threshold (0.85) AND a real category.
  _learnedSaved.length = 0;
  _aiPlan_ = { category: 'אוכל', subcategory: 'אוכל לבית', confidence: 0.97, reason: 'שופרסל' };
  const m = sandbox.matchCategorySmart('245 שופרסל סניף חדש', PHONE);

  check('0.97 unambiguous AI result IS returned as its category', m.category === 'אוכל', JSON.stringify(m));
  check('0.97 result carries the AI subcategory', m.subcategory === 'אוכל לבית', JSON.stringify(m));
  check('0.97 result is NOT the DEFAULT bucket', !isDefault(m), JSON.stringify(m));
  check('a confident AI hit IS learned/cached for next time', _learnedSaved.length >= 1, JSON.stringify(_learnedSaved));
})();

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== (3) BOUNDARY + AMBIGUOUS-BUCKET behavior ===\n');
// ════════════════════════════════════════════════════════════════════════════
(function () {
  // 3a. Exactly at the 0.6 hard floor but BELOW the default env ask-threshold
  //     (0.85): the contract still asks => must NOT write the AI category.
  _aiPlan_ = { category: 'תחבורה', subcategory: 'דלק', confidence: 0.6, reason: 'בינוני' };
  let m = sandbox.matchCategorySmart('תדלוק כלשהו', PHONE);
  check('0.60 (>= floor but < 0.85 env ask-threshold) does NOT write the AI category',
    isDefault(m), 'got ' + JSON.stringify(m));

  // 3b. Ambiguous category at HIGH numeric confidence (שונות @0.99): the
  //     category gate (not just the float) must force fall-through to DEFAULT.
  ['שונות', 'שונות ואחרים', 'בלתי מזוהה'].forEach(function (amb) {
    _aiPlan_ = { category: amb, subcategory: 'לא ברור', confidence: 0.99, reason: 'x' };
    const r = sandbox.matchCategorySmart('עוד משהו עמום', PHONE);
    check('ambiguous "' + amb + '" @0.99 still falls through to DEFAULT (no silent write)',
      isDefault(r), 'got ' + JSON.stringify(r));
  });

  // 3c. Below the floor, env threshold mis-set LOW (0.30): the 0.6 hard floor
  //     still wins, so a 0.5 confidence does NOT write. (Env can only make the
  //     bot stricter, never lower the floor.)
  scriptProps['KFL_CONFIDENCE_ASK_THRESHOLD'] = '0.30';
  _aiPlan_ = { category: 'אוכל', subcategory: 'אוכל בחוץ', confidence: 0.5, reason: 'x' };
  m = sandbox.matchCategorySmart('משהו', PHONE);
  check('env=0.30 cannot lower the 0.6 floor: 0.50 still does NOT write the AI category',
    isDefault(m), 'got ' + JSON.stringify(m));

  // 3d. With env=0.30, a 0.65 (> 0.6 floor AND > env) unambiguous result DOES
  //     write — proving the gate is the contract, not a hardcoded 0.85.
  _aiPlan_ = { category: 'אוכל', subcategory: 'אוכל לבית', confidence: 0.65, reason: 'x' };
  m = sandbox.matchCategorySmart('משהו אחר', PHONE);
  check('env=0.30, conf 0.65 (> floor, > env, unambiguous) IS returned as its category',
    m.category === 'אוכל' && !isDefault(m), 'got ' + JSON.stringify(m));
  delete scriptProps['KFL_CONFIDENCE_ASK_THRESHOLD'];

  // 3e. No provider / gibberish (AI returns null) -> DEFAULT, never throws.
  _aiPlan_ = null;
  m = sandbox.matchCategorySmart('asdfgh', PHONE);
  check('AI unavailable (null) -> DEFAULT bucket, no throw', isDefault(m), JSON.stringify(m));
})();

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== (4) SOURCE WIRING — no path bypasses the contract ===\n');
// ════════════════════════════════════════════════════════════════════════════
(function () {
  // The thin _aiCategorize wrapper must be DISABLED (return null) so no caller
  // can re-introduce a contract bypass.
  const wrap = fn('_aiCategorize');
  check('_aiCategorize wrapper is disabled (returns null, makes no _aiCategorizeRich call)',
    /return null;/.test(wrap) && !/_aiCategorizeRich\(/.test(wrap), wrap.slice(0, 200));

  // matchCategorySmart Step-3 must wire through _aiCategorizeRich AND require the
  // contract (!should_ask_user) + the 0.6 floor before returning the AI category.
  const mcs = fn('matchCategorySmart');
  check('matchCategorySmart calls _aiCategorizeRich (not the thin _aiCategorize)',
    /_aiCategorizeRich\(text, fromPhone\)/.test(mcs) && !/_aiCategorize\(text, fromPhone\)/.test(mcs));
  check('matchCategorySmart gate requires !rich.contract.should_ask_user',
    /!rich\.contract\.should_ask_user/.test(mcs), 'gate missing');
  check('matchCategorySmart gate requires confidence >= 0.6 hard floor',
    /richConf\s*>=\s*0\.6/.test(mcs), 'floor missing');
  check('matchCategorySmart still excludes the בלתי מזוהה bucket',
    /rich\.category !== 'בלתי מזוהה'/.test(mcs));
  check('matchCategorySmart preserves the premium gate (_hasActivePremium_)',
    /_hasActivePremium_\(fromPhone\)/.test(mcs));

  // KFL_BUILD_VERSION is present and date-prefixed (YYYY-MM-DD-...). The
  // version string is bumped on every deploy, so this no longer pins a
  // specific feature marker (that would break on the very next deploy).
  const v = (SRC.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
  check('KFL_BUILD_VERSION present + date-prefixed (currently: ' + v + ')',
    /^\d{4}-\d{2}-\d{2}-.+/.test(v || ''), v);
})();

console.log('\n' + (fail === 0
  ? 'PASS ALL ' + pass + ' CHECKS PASSED'
  : 'FAIL ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
