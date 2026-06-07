#!/usr/bin/env node
// bot/test_ai_contract.js
// ============================================================================
// AI classify-contract + env-provider + NEVER-silently-corrupt regression test.
//
// Loads the REAL helpers from bot/ExpenseBot_FIXED.gs (no mocking framework) by
// reading the source and eval-ing the relevant declarations into a sandbox
// where Apps Script globals (PropertiesService, UrlFetchApp, Logger) are
// replaced with controllable fakes. This is the same balanced-brace-extraction
// pattern as bot/test_classify.js and bot/test_llm_profession_boost.js.
//
// Asserts (the three things the task requires):
//   1. The 13-field contract SHAPE is produced by _normalizeAiClassifyResult_
//      and attached to _aiCategorizeRich's return.
//   2. A LOW-confidence (or ambiguous) result sets should_ask_user=true AND
//      needs_review=true, and the live write-decision in processExpense REQUIRES
//      !should_ask_user — so a low-confidence AI result can NEVER silently
//      write a financial row.
//   3. The provider key is read from env / Script Properties ONLY and the FIRST
//      configured provider (in OPENAI -> GEMINI -> XAI -> ANTHROPIC ->
//      OPENROUTER order) is picked; with no key the AI step is skipped.
//
// Run: node bot/test_ai_contract.js
// ============================================================================

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

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

// ── controllable Apps Script fakes ───────────────────────────────────────────
// scriptProps: the mutable Script-Property store. fetchPlan: a function that,
// given (url, options), returns { code, body } so we can simulate any provider.
const scriptProps = {};
let lastFetch = null;
let fetchPlan = function () { return { code: 200, body: '{}' }; };

const FakeLogger = { log: function () {} };
const FakeProps = {
  getScriptProperties: function () {
    return {
      getProperty: function (k) { return Object.prototype.hasOwnProperty.call(scriptProps, k) ? scriptProps[k] : null; }
    };
  }
};
function _resp(code, body) {
  return { getResponseCode: function () { return code; }, getContentText: function () { return body; } };
}
const FakeUrlFetchApp = {
  fetch: function (url, options) {
    lastFetch = { url: url, options: options };
    const plan = fetchPlan(url, options) || { code: 200, body: '{}' };
    return _resp(plan.code, plan.body);
  }
};

// Build the loadable code: the data tables + the pure/HTTP helpers the classify
// path depends on, plus exports onto an injected `__exports` object. The Apps
// Script globals (PropertiesService, UrlFetchApp, Logger) and `process` are
// passed in as named function params so the eval'd source resolves them to our
// controllable fakes. We deliberately keep `process` available so the env
// fallback inside _aiReadKey_ is exercisable; each test clears env first so the
// Script Properties remain the primary source.
const code = [
  'var _AI_PROVIDER_PRIORITY_ = ' + balanced('var _AI_PROVIDER_PRIORITY_ =', '[', ']') + ';',
  'var _AI_AMBIGUOUS_CATEGORIES_ = ' + balanced('var _AI_AMBIGUOUS_CATEGORIES_ =', '[', ']') + ';',
  fn('_kflConfidenceAskThreshold_'),
  fn('_isIncomeCategory_'),
  fn('_aiReadKey_'),
  fn('_aiProviderResolve_'),
  fn('_aiChatComplete_'),
  fn('_aiAskFloor_'),
  fn('_normalizeAiClassifyResult_'),
  '__exports.PRIORITY = _AI_PROVIDER_PRIORITY_;',
  '__exports.AMBIG = _AI_AMBIGUOUS_CATEGORIES_;',
  '__exports.resolve = _aiProviderResolve_;',
  '__exports.readKey = _aiReadKey_;',
  '__exports.chat = _aiChatComplete_;',
  '__exports.normalize = _normalizeAiClassifyResult_;',
  '__exports.askFloor = _aiAskFloor_;',
  '__exports.threshold = _kflConfidenceAskThreshold_;',
].join('\n');

const sandbox = {};
new Function(
  'PropertiesService', 'UrlFetchApp', 'Logger', 'process', '__exports',
  code
)(FakeProps, FakeUrlFetchApp, FakeLogger, { env: {} }, sandbox);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' --- ' + detail : '')); }
}
function clearProps() { Object.keys(scriptProps).forEach(function (k) { delete scriptProps[k]; }); }

const CONTRACT_FIELDS = ['intent','amount','currency','type','profile_type','category','subcategory','project_name','business_name','confidence_score','reason','should_ask_user','needs_review'];

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== (1) CONTRACT SHAPE — exactly the 13 agreed fields ===\n');
// ════════════════════════════════════════════════════════════════════════════
(function () {
  clearProps();
  const c = sandbox.normalize(
    { category: 'אוכל', subcategory: 'אוכל לבית', confidence: 0.97, reason: 'שופרסל סופרמרקט' },
    { amount: 245, currency: 'ILS' }
  );
  const got = Object.keys(c).sort();
  const want = CONTRACT_FIELDS.slice().sort();
  check('contract has exactly the 13 contract fields',
    JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got));
  CONTRACT_FIELDS.forEach(function (f) {
    check('contract includes field: ' + f, Object.prototype.hasOwnProperty.call(c, f));
  });
  // value sanity for a confident expense
  check('confident result: category passthrough', c.category === 'אוכל');
  check('confident result: subcategory passthrough', c.subcategory === 'אוכל לבית');
  check('confident result: confidence_score is the numeric confidence', c.confidence_score === 0.97);
  check('confident result: amount carried from opts', c.amount === 245);
  check('confident result: currency defaults/carries ILS', c.currency === 'ILS');
  check('confident result: type derived = expense', c.type === 'expense');
  check('confident result: intent defaults to log_expense', c.intent === 'log_expense');
  // income derivation
  const inc = sandbox.normalize({ category: 'הכנסות', subcategory: 'משכורת', confidence: 0.99, reason: 'x' }, { amount: 12000 });
  check('income category derives type=income', inc.type === 'income');
})();

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== (2) NEVER-SILENTLY-CORRUPT — low conf / ambiguous => ask + review ===\n');
// ════════════════════════════════════════════════════════════════════════════
(function () {
  clearProps();
  // default threshold (env unset) is 0.85; floor is 0.6.
  // 2a. Clearly LOW confidence (below the 0.6 hard floor) -> must ask.
  const lo = sandbox.normalize({ category: 'אוכל', subcategory: 'אוכל בחוץ', confidence: 0.35, reason: 'ניחוש חלש' }, { amount: 50 });
  check('low conf (0.35): should_ask_user = true', lo.should_ask_user === true);
  check('low conf (0.35): needs_review = true', lo.needs_review === true);

  // 2b. Mid confidence (0.7) below default env threshold 0.85 -> still ask.
  const mid = sandbox.normalize({ category: 'אוכל', subcategory: 'אוכל בחוץ', confidence: 0.7, reason: 'בינוני' }, { amount: 50 });
  check('mid conf (0.70 < 0.85 default): should_ask_user = true', mid.should_ask_user === true);
  check('mid conf (0.70): needs_review = true', mid.needs_review === true);

  // 2c. High confidence (0.97) >= threshold and real category -> may write.
  const hi = sandbox.normalize({ category: 'אוכל', subcategory: 'אוכל לבית', confidence: 0.97, reason: 'ברור' }, { amount: 50 });
  check('high conf (0.97 >= 0.85): should_ask_user = false', hi.should_ask_user === false);
  check('high conf (0.97): needs_review = false', hi.needs_review === false);

  // 2d. Ambiguous bucket at HIGH numeric confidence still must ask (category gate).
  ['שונות', 'שונות ואחרים', 'בלתי מזוהה'].forEach(function (amb) {
    const r = sandbox.normalize({ category: amb, subcategory: 'לא ברור', confidence: 0.99, reason: 'x' }, { amount: 50 });
    check('ambiguous category "' + amb + '" @0.99 still should_ask_user=true', r.should_ask_user === true);
    check('ambiguous category "' + amb + '" still needs_review=true', r.needs_review === true);
  });

  // 2e. HARD FLOOR invariant: even if the env threshold is mis-set BELOW 0.6,
  // a sub-0.6 confidence must STILL ask (env can only make it stricter).
  clearProps();
  scriptProps['KFL_CONFIDENCE_ASK_THRESHOLD'] = '0.30';
  const floored = sandbox.normalize({ category: 'אוכל', subcategory: 'אוכל בחוץ', confidence: 0.5, reason: 'x' }, { amount: 50 });
  check('env threshold 0.30 cannot lower the 0.6 floor: 0.50 still asks',
    floored.should_ask_user === true, 'should_ask_user=' + floored.should_ask_user);
  // and a 0.65 with env=0.30 -> above the 0.6 floor AND above env -> may write.
  const okAboveFloor = sandbox.normalize({ category: 'אוכל', subcategory: 'אוכל לבית', confidence: 0.65, reason: 'x' }, { amount: 50 });
  check('env threshold 0.30, conf 0.65 (> 0.6 floor) -> may write (ask=false)',
    okAboveFloor.should_ask_user === false, 'should_ask_user=' + okAboveFloor.should_ask_user);
  clearProps();
})();

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== (2b) SOURCE WIRING — processExpense gates write on the contract ===\n');
// ════════════════════════════════════════════════════════════════════════════
(function () {
  // The decision block must compute should_ask from the contract and require
  // !should_ask to write. Grep the source so a refactor that drops the guard
  // (and reintroduces a silent low-confidence write) trips this test.
  check('processExpense derives aiShouldAsk from contract.should_ask_user',
    /aiShouldAsk\s*=\s*aiRich && aiRich\.contract \? !!aiRich\.contract\.should_ask_user : true/.test(SRC));
  check('processExpense write-gate aiMayWrite REQUIRES !aiShouldAsk',
    /aiMayWrite\s*=\s*aiOK && aiConf >= TIER_DIRECT && !aiShouldAsk/.test(SRC));
  check('processExpense only writes when aiMayWrite is true (else asks)',
    /if \(aiMayWrite\) \{/.test(SRC));
  check('low-confidence path returns { ambiguousSent: true } (no row appended)',
    /return \{ ambiguousSent: true \};/.test(SRC));
  check('_aiCategorizeRich attaches the normalized contract',
    /rich\.contract = _normalizeAiClassifyResult_\(rich, \{ text: text \}\);/.test(SRC));
  check('the misc/ambiguous early-return also attaches the contract',
    /miscRich\.contract = _normalizeAiClassifyResult_\(miscRich, \{ text: text \}\);/.test(SRC));
})();

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== (3) ENV-BASED PROVIDER PICK (mock Script Properties) ===\n');
// ════════════════════════════════════════════════════════════════════════════
(function () {
  // 3a. No key configured -> resolver returns null (AI skipped gracefully).
  clearProps();
  check('no key set -> resolver returns null (AI skipped)', sandbox.resolve() === null);

  // 3b. Single provider configured -> that one is picked.
  clearProps();
  scriptProps['GEMINI_API_KEY'] = 'g-key';
  let r = sandbox.resolve();
  check('only GEMINI set -> provider=gemini', r && r.provider === 'gemini', JSON.stringify(r));
  check('only GEMINI set -> keyName=GEMINI_API_KEY', r && r.keyName === 'GEMINI_API_KEY');
  check('only GEMINI set -> key value carried', r && r.key === 'g-key');

  // 3c. PRIORITY ORDER: OPENAI > GEMINI > XAI > ANTHROPIC > OPENROUTER.
  clearProps();
  scriptProps['OPENAI_API_KEY'] = 'o';
  scriptProps['GEMINI_API_KEY'] = 'g';
  scriptProps['XAI_API_KEY'] = 'x';
  scriptProps['ANTHROPIC_API_KEY'] = 'a';
  scriptProps['OPENROUTER_API_KEY'] = 'r';
  check('all 5 set -> OPENAI wins (highest priority)', sandbox.resolve().provider === 'openai');

  clearProps();
  scriptProps['GEMINI_API_KEY'] = 'g';
  scriptProps['XAI_API_KEY'] = 'x';
  scriptProps['ANTHROPIC_API_KEY'] = 'a';
  check('OPENAI absent -> GEMINI wins', sandbox.resolve().provider === 'gemini');

  clearProps();
  scriptProps['XAI_API_KEY'] = 'x';
  scriptProps['ANTHROPIC_API_KEY'] = 'a';
  scriptProps['OPENROUTER_API_KEY'] = 'r';
  check('OPENAI+GEMINI absent -> XAI wins', sandbox.resolve().provider === 'xai');

  clearProps();
  scriptProps['ANTHROPIC_API_KEY'] = 'a';
  scriptProps['OPENROUTER_API_KEY'] = 'r';
  check('only ANTHROPIC+OPENROUTER -> ANTHROPIC wins', sandbox.resolve().provider === 'anthropic');

  clearProps();
  scriptProps['OPENROUTER_API_KEY'] = 'r';
  check('only OPENROUTER -> openrouter picked (last resort)', sandbox.resolve().provider === 'openrouter');

  // 3d. Whitespace-only key is treated as unset.
  clearProps();
  scriptProps['ANTHROPIC_API_KEY'] = '   ';
  check('whitespace-only key is treated as unset', sandbox.resolve() === null);

  // 3e. NO HARDCODED KEYS anywhere in the provider plumbing (source grep).
  // The resolver + dispatch must read keys only through _aiReadKey_ /
  // Script Properties — never a literal "sk-"/"AIza"/"xai-" token.
  check('source has no hardcoded OpenAI-style key literal',
    !/['"]sk-[A-Za-z0-9_-]{12,}['"]/.test(SRC));
  check('source has no hardcoded Google AIza key literal',
    !/['"]AIza[A-Za-z0-9_-]{20,}['"]/.test(SRC));
  check('source has no hardcoded xai- key literal',
    !/['"]xai-[A-Za-z0-9_-]{12,}['"]/.test(SRC));
  check('_aiProviderResolve_ reads keys via _aiReadKey_ (not inline getProperty)',
    /function _aiProviderResolve_[\s\S]*?_aiReadKey_\(entry\.key\)/.test(SRC));
})();

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== (3f) PROVIDER DISPATCH routes to the correct endpoint (mock fetch) ===\n');
// ════════════════════════════════════════════════════════════════════════════
(function () {
  const sysP = 'system', userP = 'user';

  // anthropic -> messages endpoint, x-api-key header, content[0].text reply
  fetchPlan = function () { return { code: 200, body: JSON.stringify({ content: [{ text: '{"category":"אוכל"}' }] }) }; };
  let out = sandbox.chat('anthropic', 'a-key', sysP, userP);
  check('anthropic dispatch hits api.anthropic.com', /api\.anthropic\.com\/v1\/messages/.test(lastFetch.url), lastFetch.url);
  check('anthropic dispatch sends x-api-key header', lastFetch.options.headers['x-api-key'] === 'a-key');
  check('anthropic dispatch returns content[0].text', out === '{"category":"אוכל"}');

  // openai -> chat/completions, Bearer auth, choices[0].message.content reply
  fetchPlan = function () { return { code: 200, body: JSON.stringify({ choices: [{ message: { content: 'OAI' } }] }) }; };
  out = sandbox.chat('openai', 'o-key', sysP, userP);
  check('openai dispatch hits api.openai.com/v1/chat/completions', /api\.openai\.com\/v1\/chat\/completions/.test(lastFetch.url), lastFetch.url);
  check('openai dispatch sends Bearer auth', lastFetch.options.headers['Authorization'] === 'Bearer o-key');
  check('openai dispatch returns choices[0].message.content', out === 'OAI');

  // xai -> x.ai endpoint
  fetchPlan = function () { return { code: 200, body: JSON.stringify({ choices: [{ message: { content: 'X' } }] }) }; };
  out = sandbox.chat('xai', 'x-key', sysP, userP);
  check('xai dispatch hits api.x.ai', /api\.x\.ai\/v1\/chat\/completions/.test(lastFetch.url), lastFetch.url);
  check('xai dispatch returns content', out === 'X');

  // openrouter -> openrouter.ai endpoint
  fetchPlan = function () { return { code: 200, body: JSON.stringify({ choices: [{ message: { content: 'OR' } }] }) }; };
  out = sandbox.chat('openrouter', 'r-key', sysP, userP);
  check('openrouter dispatch hits openrouter.ai', /openrouter\.ai\/api\/v1\/chat\/completions/.test(lastFetch.url), lastFetch.url);
  check('openrouter dispatch returns content', out === 'OR');

  // gemini -> generateContent with key in query string
  clearProps();
  fetchPlan = function () { return { code: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'GEM' }] } }] }) }; };
  out = sandbox.chat('gemini', 'g-key', sysP, userP);
  check('gemini dispatch hits generativelanguage generateContent', /generativelanguage\.googleapis\.com.*generateContent/.test(lastFetch.url), lastFetch.url);
  check('gemini dispatch passes key in query string', /key=g-key/.test(lastFetch.url));
  check('gemini dispatch returns candidates[0].content.parts[0].text', out === 'GEM');

  // non-200 -> null (graceful degrade, no throw)
  fetchPlan = function () { return { code: 500, body: 'err' }; };
  out = sandbox.chat('openai', 'o-key', sysP, userP);
  check('non-200 response degrades to null (no throw)', out === null);
})();

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== (4) SOURCE: env-only keys, single LLM path, version bump ===\n');
// ════════════════════════════════════════════════════════════════════════════
(function () {
  // The 5 provider key names must all appear in the priority table.
  ['OPENAI_API_KEY','GEMINI_API_KEY','XAI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY'].forEach(function (k) {
    check('priority table references ' + k, sandbox.PRIORITY.some(function (e) { return e.key === k; }));
  });
  check('priority order STARTS WITH the original 5 (openai,gemini,xai,anthropic,openrouter)',
    sandbox.PRIORITY.map(function (e) { return e.provider; }).join(',').indexOf('openai,gemini,xai,anthropic,openrouter') === 0);

  // _aiCategorizeRich now resolves a provider rather than reading ANTHROPIC
  // directly, and routes through the single _aiChatComplete_ dispatcher (the
  // EXISTING LLM path was refactored, not duplicated).
  const richFn = SRC.slice(SRC.indexOf('function _aiCategorizeRich('));
  const richBody = richFn.slice(0, richFn.indexOf('\n}\n'));
  check('_aiCategorizeRich calls _aiProviderResolve_ (env-based key)',
    /_aiProviderResolve_\(\)/.test(richBody));
  check('_aiCategorizeRich does NOT read ANTHROPIC_API_KEY directly anymore',
    !/getProperty\('ANTHROPIC_API_KEY'\)/.test(richBody));
  check('_aiCategorizeRich routes through the resilient dispatcher wrapper',
    /_aiChatCompleteResilient_\(systemPrompt, userMsg\)/.test(richBody));
  // The resilient wrapper adds opt-in cross-provider failover but is the ONLY
  // new indirection: it still funnels every provider through the single
  // _aiChatComplete_ dispatcher and makes no inline provider fetch of its own.
  const resFn = SRC.slice(SRC.indexOf('function _aiChatCompleteResilient_('));
  const resBody = resFn.slice(0, resFn.indexOf('\n}\n'));
  check('_aiChatCompleteResilient_ funnels through _aiChatComplete_ (no inline fetch)',
    /_aiChatComplete_\(/.test(resBody) && !/api\.anthropic\.com|generativelanguage|chat\/completions/.test(resBody));
  // The classify path must NOT make its own inline anthropic fetch — it routes
  // through the dispatcher (the EXISTING LLM path was refactored, not
  // duplicated). The other anthropic calls in the file (receipt-OCR vision,
  // keyword-learning, synonym-cron) are provider-specific by design and are NOT
  // the classifier, so we only assert _aiCategorizeRich is clean.
  check('_aiCategorizeRich has NO inline api.anthropic.com fetch (uses dispatcher)',
    !/api\.anthropic\.com/.test(richBody));
  // Exactly one anthropic call site lives inside the dispatcher _aiChatComplete_.
  const dispFn = SRC.slice(SRC.indexOf('function _aiChatComplete_('));
  const dispBody = dispFn.slice(0, dispFn.indexOf('\n}\n'));
  const dispAnth = (dispBody.match(/api\.anthropic\.com\/v1\/messages/g) || []).length;
  check('dispatcher _aiChatComplete_ has exactly one anthropic call site',
    dispAnth === 1, 'count=' + dispAnth);

  // version bumped (date-stamped) and reflects the AI providers/contract change.
  const v = (SRC.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
  check('KFL_BUILD_VERSION is date-stamped (currently: ' + v + ')', /^\d{4}-\d{2}-\d{2}/.test(v || ''));
})();

console.log('\n' + (fail === 0
  ? 'PASS ALL ' + pass + ' CHECKS PASSED'
  : 'FAIL ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
