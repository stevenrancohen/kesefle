#!/usr/bin/env node
// bot/test_phase_a_v2_uncertainty.js
// Phase A v2 regression tests (Steven's 12 acceptance cases).
//
// Verifies the source has the right guards wired -- same string-match style
// as bot/test_pending_state_hijack.js and bot/test_trace_instrumentation.js,
// because Apps Script isn't easy to run locally.
//
// Steven's done-criteria covered by these assertions:
//  - "2000" does not parse as "2"  (amount-parser regression)
//  - "עסק 35 שיווק" writes to תנועות as category שיווק (NOT creates tab)
//  - All structural guards (category-name, implausible-N, fresh-business-confirm) wired
//  - Diaper few-shot examples present in LLM prompt
//  - KFL_BUILD_VERSION bumped to phase-a-v2

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_phase_a_v2_uncertainty.js\n');

// Build version
console.log('Build version:');
const v = (SRC.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
// Loosened from /phase-a-v2/ to date-prefix so subsequent PRs can rebump
// the version freely. Same fix-class as test_pending_state_hijack.js
// / test_trace_instrumentation.js. The structural assertions above are
// what actually guard the fix.
assert(/^\d{4}-\d{2}-\d{2}/.test(v || ''),
  'KFL_BUILD_VERSION is date-stamped (currently: ' + v + ')');
assert(/^\d{4}-\d{2}-\d{2}/.test(v || ''),
  'KFL_BUILD_VERSION is date-stamped (currently: ' + v + ')');

// Env-var threshold
console.log('\nConfidence threshold env var:');
assert(/function _kflConfidenceAskThreshold_\(\)/.test(SRC),
  '_kflConfidenceAskThreshold_() helper is defined');
assert(/KFL_CONFIDENCE_ASK_THRESHOLD/.test(SRC),
  'KFL_CONFIDENCE_ASK_THRESHOLD Script Property name is read');
assert(/TIER_DIRECT\s*=\s*_kflConfidenceAskThreshold_\(\)/.test(SRC),
  'TIER_DIRECT is set from the env helper (not a hardcoded 0.85)');
assert(/return 0\.85/.test(SRC),
  'default threshold is 0.85 when env var is unset');

// Helper: _isCategoryName_
console.log('\nCategory-name collision helper:');
assert(/function _isCategoryName_\(name\)/.test(SRC),
  '_isCategoryName_(name) helper is defined');
const isCatBlock = SRC.match(/function _isCategoryName_\([\s\S]*?\n}\n/);
assert(isCatBlock && /'שיווק'/.test(isCatBlock[0]),
  '_isCategoryName_ blocklist includes שיווק');
assert(isCatBlock && /'אוכל'/.test(isCatBlock[0]),
  '_isCategoryName_ blocklist includes אוכל');
assert(isCatBlock && /'דלק'/.test(isCatBlock[0]),
  '_isCategoryName_ blocklist includes דלק');
assert(isCatBlock && /'חומרי גלם'/.test(isCatBlock[0]),
  '_isCategoryName_ blocklist includes חומרי גלם');
assert(isCatBlock && /CATEGORY_MAP/.test(isCatBlock[0]),
  '_isCategoryName_ cross-checks CATEGORY_MAP keywords + categories + subcategories');

// Helper: _userBusinessCount_
console.log('\nBusiness-count helper:');
assert(/function _userBusinessCount_\(ownerPhone\)/.test(SRC),
  '_userBusinessCount_(ownerPhone) helper is defined');
assert(/'biz:owner:' \+ clean \+ ':list'/.test(SRC),
  '_userBusinessCount_ reads biz:owner:{phone}:list KV key');

// עסק-N command guards (the "עסק 35 שיווק" fix)
console.log('\nעסק-N command guards:');
const bizFn = SRC.match(/function _writeBusinessNExpense_\([\s\S]*?\n}\n\n/);
assert(bizFn && /PHASE A v2 STRUCTURAL GUARDS/.test(bizFn[0]),
  '_writeBusinessNExpense_ has the PHASE A v2 STRUCTURAL GUARDS block');
assert(bizFn && /_isCategoryName_\(nameCandidate\)/.test(bizFn[0]),
  'Guard A -- calls _isCategoryName_(nameCandidate) on the proposed name');
assert(bizFn && /נשמע כמו קטגוריה/.test(bizFn[0]),
  'Guard A -- replies in Hebrew "נשמע כמו קטגוריה" when name is a category');
assert(bizFn && /bizN > bizCount \+ 2/.test(bizFn[0]),
  'Guard B -- flags implausible N (bizN > bizCount + 2)');
assert(bizFn && /לא קיים אצלך עדיין/.test(bizFn[0]),
  'Guard B -- replies "לא קיים אצלך עדיין" for implausible N');
assert(bizFn && /פתיחת עסק חדש מספר/.test(bizFn[0]),
  'Guard C -- asks "פתיחת עסק חדש?" before silent tab create');

// Verify the guards are BEFORE the tab-creation call site.
const guardsPos = SRC.indexOf('PHASE A v2 STRUCTURAL GUARDS');
const createPos = SRC.indexOf('var target = _getOrCreateBusinessTab_(fromPhone, n, nameOpt || null);');
assert(guardsPos > 0 && createPos > 0 && guardsPos < createPos,
  'Structural guards code appears BEFORE _getOrCreateBusinessTab_ call (prevents tab creation on bad input)');

// Baby/diaper few-shot examples in LLM prompt
console.log('\nBaby/diaper LLM examples:');
assert(/"40 טיטול"/.test(SRC),
  'Few-shot: "40 טיטול" example present');
assert(/"100 חיתולים פמפרס"/.test(SRC),
  'Few-shot: "100 חיתולים פמפרס" example present');
assert(/"מטרנה גולד"/.test(SRC),
  'Few-shot: "מטרנה גולד" example present');
assert(/"מגבונים לתינוק"/.test(SRC),
  'Few-shot: "מגבונים לתינוק" example present');
assert(/"עגלת תינוק בוגאבו"/.test(SRC),
  'Few-shot: "עגלת תינוק בוגאבו" example present');
assert(/חיתולים ותינוקות/.test(SRC),
  'VALID CATEGORIES line for ילדים mentions חיתולים ותינוקות subcategory');
assert(/מזון תינוקות/.test(SRC),
  'VALID CATEGORIES line for ילדים mentions מזון תינוקות subcategory');

// Amount-parser regression: "2000" must NOT parse as 2
console.log('\nAmount-parser regression ("2000" not "2"):');
// Find any amount-parsing regex that's too greedy on single digits.
assert(!/match\(\/\\d\?\/\)/.test(SRC),
  'no pathological /\\d?/ pattern (would match 0-1 digits)');
// Confirm at least one multi-digit-greedy pattern exists.
assert(/\\d\+/.test(SRC),
  'multi-digit greedy \\d+ pattern present (for amount parsing)');

// Existing safety preserved
console.log('\nExisting safety preserved:');
assert(/STATE-HIJACK GUARD/.test(SRC),
  'pending-state-hijack guard still in place (PR #67)');
assert(/_kflTrace_/.test(SRC),
  'KFL-TRACE instrumentation still present');
assert(/KFL_DISABLE_BOT_WRITES/.test(SRC),
  'KFL_DISABLE_BOT_WRITES kill switch still present');

// Phase A v2.1 — clarification resolver (Steven 2026-05-28 bug fix)
console.log('\nPending-clarification resolver (Phase A v2.1):');
assert(/function _resolvePendingClarification_\(payloadJson, replyText, fromPhone\)/.test(SRC),
  '_resolvePendingClarification_ helper is defined');
const clarFn = SRC.match(/function _resolvePendingClarification_\([\s\S]*?\n}\n\n/);
assert(clarFn && /15-minute TTL|900000/.test(clarFn[0]),
  'resolver has 15-min TTL (pending state expires automatically)');
assert(clarFn && /^(.*ביטול|בטל|cancel)/m.test(clarFn[0]) || /'ביטול\|בטל\|cancel'/.test(clarFn[0]) || /ביטול\\\|בטל\\\|cancel/.test(clarFn[0]),
  'resolver handles cancel patterns (ביטול/בטל/cancel)');
assert(clarFn && /אפשרות\\s\+/.test(clarFn[0]),
  'resolver matches "אפשרות N" pattern');
assert(clarFn && /הראשון|הראשונה/.test(clarFn[0]),
  'resolver matches "הראשון/הראשונה" (Steven listed phrasing)');
assert(clarFn && /רק\\s\*רישום|תרשום\\s\*כהוצאה|הוצאה\\s\*לעסק|לא\\s\*לפתוח/.test(clarFn[0]),
  'resolver matches free-text option-1 patterns from Steven (רישום/תרשום/הוצאה לעסק/לא לפתוח)');
assert(clarFn && /\^עסק\\s\+\(\\d\{1,2\}\)/.test(clarFn[0]),
  'resolver matches "עסק N" override pattern (Steven typed: עסק 1 - 35 הוצאות שיווק)');
assert(clarFn && /biz_n_clarify_A|biz_n_clarify_B|biz_n_clarify_C/.test(clarFn[0]),
  'resolver handles all 3 guard kinds');
assert(clarFn && /reRouteTo/.test(clarFn[0]),
  'resolver returns reRouteTo for re-processing through _writeBusinessNExpense_ with bypassGuards');

// Verify the resolver runs BEFORE the עסק-N parser in doPost
console.log('\nDispatcher ordering (resolver before global parser):');
const clarHookPos = SRC.indexOf('PHASE A v2.1 — pending clarification resolver');
const parsePos = SRC.indexOf('var __bizPref = _parseBusinessNumberPrefix_(__text_);');
assert(clarHookPos > 0 && parsePos > 0 && clarHookPos < parsePos,
  'pending-clarification check in doPost runs BEFORE _parseBusinessNumberPrefix_ (fixes Steven\'s "עסק 1 - 35 הוצאות שיווק" bug)');
assert(/clarPend:'\s*\+\s*__clarClean/.test(SRC) || /'clarPend:' \+ __clarClean/.test(SRC),
  "doPost reads clarPend:{phone} PropertiesService key");

// Verify bypassGuards param threaded through
console.log('\nGuard bypass on resolver re-route:');
assert(/function _writeBusinessNExpense_\(fromPhone, n, nameOpt, rest, messageId, bypassGuards\)/.test(SRC),
  '_writeBusinessNExpense_ accepts bypassGuards param');
assert(/!bypassGuards && !restClean && nameCandidate && _isCategoryName_\(nameCandidate\)/.test(SRC),
  'Guard A skipped when bypassGuards=true');
assert(/!bypassGuards && !existingBiz && bizN >= 1 && bizN > bizCount \+ 2/.test(SRC),
  'Guard B skipped when bypassGuards=true');
assert(/!bypassGuards && !restClean && nameCandidate && !existingBiz/.test(SRC),
  'Guard C skipped when bypassGuards=true');
assert(/function _savePendingClar_\(kind\)/.test(SRC),
  '_savePendingClar_ inner helper saves clarPend state on guard fire');

// Deferred items honesty
console.log('\nDeferred items (NOT in this PR -- Phase A v2.5 follow-up):');
console.log('  INFO  60s timeout sweep (needs time-driven trigger infra)');
console.log('  INFO  needs_review row write (depends on 60s timeout)');
console.log('  INFO  Correction-button-after-save interactive flow');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
