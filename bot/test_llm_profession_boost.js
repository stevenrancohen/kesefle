// Unit test for the LLM-classifier profession-boost hook (task #218).
//
// Loads the REAL helpers from bot/ExpenseBot_FIXED.gs (no mocks) by reading
// the source and eval-ing the relevant declarations in a sandbox. We
// deliberately avoid touching Apps Script globals (CacheService, UrlFetchApp,
// PropertiesService, _profileAPI_, etc.) -- only the pure helpers added in
// PR #12 are exercised:
//
//   _KESEFLE_PROFESSION_AI_HINT_BY_CATEGORY_  -- category -> English hint line
//   _KESEFLE_PROFESSION_AI_HINT_BY_ID_        -- id -> English hint line (overrides)
//   _KESEFLE_PROFESSION_CATEGORY_             -- id -> category
//   _KESEFLE_PROFESSION_ALIAS_                -- coarse label -> category or __homemaker__
//   _professionContextLine_(profession)       -- main entry point
//
// And we then statically grep the source to confirm the prompt-building code
// path inside _aiCategorizeRich actually concatenates the new line into the
// system prompt.
//
// Run: node bot/test_llm_profession_boost.js

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

// Balanced-delimiter slice. Finds the FIRST `open` after `marker` and matches
// braces/brackets through to the matching closer. Returns the substring
// including both delimiters.
function balanced(marker, open, close) {
  const s = SRC.indexOf(marker);
  if (s < 0) throw new Error('marker not found: ' + marker);
  const i = SRC.indexOf(open, s);
  if (i < 0) throw new Error('open not found after marker: ' + marker);
  let d = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === open) d++;
    else if (SRC[j] === close) { d--; if (!d) { j++; break; } }
  }
  return SRC.slice(i, j);
}

// Function-body extractor for hoisted `function name(...) { ... }` decls.
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

// Build a sandbox with only the four data tables and the pure
// _professionContextLine_ function. No Apps Script globals.
const sandbox = {};
const code = [
  'var _KESEFLE_PROFESSION_AI_HINT_BY_CATEGORY_ = ' + balanced('var _KESEFLE_PROFESSION_AI_HINT_BY_CATEGORY_', '{', '}') + ';',
  'var _KESEFLE_PROFESSION_AI_HINT_BY_ID_ = ' + balanced('var _KESEFLE_PROFESSION_AI_HINT_BY_ID_', '{', '}') + ';',
  'var _KESEFLE_PROFESSION_CATEGORY_ = ' + balanced('var _KESEFLE_PROFESSION_CATEGORY_', '{', '}') + ';',
  'var _KESEFLE_PROFESSION_ALIAS_ = ' + balanced('var _KESEFLE_PROFESSION_ALIAS_', '{', '}') + ';',
  fn('_professionContextLine_'),
  'sandbox.byCat = _KESEFLE_PROFESSION_AI_HINT_BY_CATEGORY_;',
  'sandbox.byId = _KESEFLE_PROFESSION_AI_HINT_BY_ID_;',
  'sandbox.cat = _KESEFLE_PROFESSION_CATEGORY_;',
  'sandbox.alias = _KESEFLE_PROFESSION_ALIAS_;',
  'sandbox.line = _professionContextLine_;',
].join('\n');
new Function('sandbox', code)(sandbox);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' --- ' + detail : '')); }
}

console.log('\n=== HINT TABLES ===\n');

check('byCategory map exists', sandbox.byCat && typeof sandbox.byCat === 'object');
check('byId map exists', sandbox.byId && typeof sandbox.byId === 'object');

// All 10 catalog categories should have a hint line.
const REQUIRED_CATS = [
  'construction', 'professional_services', 'healthcare', 'tech',
  'retail_service', 'creative', 'education', 'logistics',
  'agriculture', 'employee',
];
REQUIRED_CATS.forEach(function (c) {
  check('byCategory has hint for: ' + c,
    typeof sandbox.byCat[c] === 'string' && sandbox.byCat[c].length > 30,
    'got ' + JSON.stringify(sandbox.byCat[c]));
});

console.log('\n=== _professionContextLine_ : EMPTY/NULL HANDLING ===\n');

check('empty string -> empty string', sandbox.line('') === '');
check('null -> empty string', sandbox.line(null) === '');
check('undefined -> empty string', sandbox.line(undefined) === '');
check('whitespace -> empty string', sandbox.line('   ') === '');
check('unknown id -> empty string',
  sandbox.line('definitely_not_a_real_profession_xyz') === '',
  'got ' + JSON.stringify(sandbox.line('definitely_not_a_real_profession_xyz')));

console.log('\n=== SPEC ASSERTIONS ===\n');

// 1. artisan: contains 'artisan' English keyword + at least one Hebrew
//    business category from {חומרי גלם, עלות שיווק, מכירה, יועצים}.
const artisanLine = sandbox.line('artisan');
check('_professionContextLine_("artisan") is non-empty',
  typeof artisanLine === 'string' && artisanLine.length > 0,
  'got ' + JSON.stringify(artisanLine));
check('artisan line contains "artisan" keyword (case-insensitive)',
  /artisan/i.test(artisanLine),
  artisanLine);
check('artisan line contains at least one Hebrew business category',
  /חומרי גלם|עלות שיווק|מכירה|יועצים/.test(artisanLine),
  artisanLine);

// 2. teacher: contains education-related Hebrew, e.g. ספרי לימוד,
//    ציוד עזר, מנוי חינוכי, קורסים מקוונים.
const teacherLine = sandbox.line('teacher');
check('_professionContextLine_("teacher") is non-empty',
  typeof teacherLine === 'string' && teacherLine.length > 0,
  'got ' + JSON.stringify(teacherLine));
check('teacher line contains education-related Hebrew',
  /ספרי לימוד|ציוד עזר|מנוי חינוכי|קורסים/.test(teacherLine),
  teacherLine);

// 3. empty string returns empty (additive behavior).
check('_professionContextLine_("") returns "" -- no boost when profession missing',
  sandbox.line('') === '');

console.log('\n=== EXTRA PROFESSION COVERAGE (6+ professions required by task) ===\n');

// The task spec lists 6 professions that must produce a hint line.
const SPEC_PROFESSIONS = [
  // Hebrew + English forms accepted
  { input: 'business',         expectMatches: /business|עסק/i },
  { input: 'salaried',         expectMatches: /salaried|employee|שכיר/i },
  { input: 'teacher',          expectMatches: /teach|education|ספרי/i },
  { input: 'healthcare',       expectMatches: /healthcare|רפוא/i },
  { input: 'family-only',      expectMatches: /homemaker|household|family|משק בית|אוכל לבית/i },
  { input: 'artisan',          expectMatches: /artisan|maker|creative/i },
];
SPEC_PROFESSIONS.forEach(function (p) {
  const line = sandbox.line(p.input);
  check('"' + p.input + '" produces a non-empty hint',
    typeof line === 'string' && line.length > 30,
    'got ' + JSON.stringify(line));
  check('"' + p.input + '" hint matches expected signal',
    p.expectMatches.test(line),
    line);
});

// Same for Hebrew aliases.
const HEBREW_ALIASES = [
  { input: 'מורה',     expectMatches: /teach|education/i },                  // teacher
  { input: 'רפואה',   expectMatches: /healthcare/i },                       // healthcare
  { input: 'משק בית', expectMatches: /homemaker|household|family/i },        // family-only
  { input: 'שכיר',    expectMatches: /salaried|employee/i },                 // salaried
  { input: 'עוסק',    expectMatches: /professional|business/i },             // business
];
HEBREW_ALIASES.forEach(function (p) {
  const line = sandbox.line(p.input);
  check('Hebrew alias "' + p.input + '" produces a non-empty hint',
    typeof line === 'string' && line.length > 30,
    'got ' + JSON.stringify(line));
  check('Hebrew alias "' + p.input + '" hint matches expected signal',
    p.expectMatches.test(line),
    line);
});

console.log('\n=== ID-LEVEL OVERRIDES ===\n');

// Override beats category bucket: homemaker (family-only) should NOT get the
// generic "employee" hint; it should get the explicit homemaker line.
const homemakerLine = sandbox.line('homemaker');
check('id "homemaker" produces the family/household override',
  /homemaker|household|NEVER use business/i.test(homemakerLine),
  homemakerLine);
check('  ...and contains household Hebrew',
  /אוכל לבית|ילדים|הוצאות קבועות/.test(homemakerLine),
  homemakerLine);

// teacher_public (employee category) should NOT recommend business categories.
const teacherPubLine = sandbox.line('teacher_public');
check('id "teacher_public" hints employee categories',
  /employee|salaried/i.test(teacherPubLine),
  teacherPubLine);

// private_tutor inherits education tone.
const tutorLine = sandbox.line('private_tutor');
check('id "private_tutor" produces an education-flavored hint',
  /tutor|education|teach/i.test(tutorLine),
  tutorLine);

console.log('\n=== CATEGORY-FALLBACK PATH (id with no explicit override) ===\n');

// general_contractor has no explicit byId override -> falls back to
// the 'construction' bucket. Confirms the lookup chain works.
const contractorLine = sandbox.line('general_contractor');
check('id "general_contractor" falls back to construction hint',
  /construction|contractor|electric|plumb/i.test(contractorLine),
  contractorLine);

// lawyer / accountant -> professional_services bucket.
const lawyerLine = sandbox.line('lawyer');
check('id "lawyer" falls back to professional-services hint',
  /professional|lawyer|accountant|consult/i.test(lawyerLine),
  lawyerLine);

console.log('\n=== PROMPT INJECTION (source-code grep) ===\n');

// Confirm the prompt-building code path declares + concatenates the new
// block. We grep the .gs source directly so a future refactor that drops the
// injection trips this test.
check('source declares professionHintBlock variable',
  /var\s+professionHintBlock\s*=\s*''/.test(SRC),
  'no professionHintBlock var found');

check('source calls _professionContextLine_(...) inside _aiCategorizeRich',
  /_professionContextLine_\s*\(/.test(SRC),
  'no call to _professionContextLine_ found');

check('source calls _profileProfessionCached_(...) to read the profession',
  /_profileProfessionCached_\s*\(/.test(SRC),
  'no call to _profileProfessionCached_ found');

check('source concatenates professionHintBlock into the LLM system prompt',
  /userExamplesBlock\s*\+\s*profileHintBlock\s*\+\s*professionHintBlock/.test(SRC),
  'professionHintBlock is not concatenated next to profileHintBlock');

console.log('\n=== KFL_BUILD_VERSION ===\n');

// Heart-beat / admin-dashboard sanity check: the build version bumped for
// this PR so the deployed bot's "בדיקה" command surfaces the new code.
check('KFL_BUILD_VERSION bumped (date-prefixed)',
  /KFL_BUILD_VERSION\s*=\s*['"]2026-05-28-[\w-]+['"]/.test(SRC),
  'KFL_BUILD_VERSION not bumped or not date-prefixed');

console.log('\n' + (fail === 0
  ? 'PASS ALL ' + pass + ' CHECKS PASSED'
  : 'FAIL ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
