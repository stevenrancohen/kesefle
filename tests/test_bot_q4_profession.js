// Unit test: bot Q4 profession picker.
//
// Extracts the helpers from bot/ExpenseBot_FIXED.gs (which is .gs, not ESM)
// by reading the source and eval-ing the relevant blocks in a sandbox. We
// deliberately don't load the whole bot — Apps Script globals (SpreadsheetApp,
// UrlFetchApp, CacheService, etc.) aren't available in Node. We only exercise
// the pure helpers added in PR #10:
//
//   _KESEFLE_POPULAR_PROFESSIONS_    -- 10-item array (9 + "other")
//   _KESEFLE_PROFESSION_HUMAN_       -- id → Hebrew label
//   _matchProfessionFromText_(text)  -- free-text → known profession id
//
// Run: node tests/test_bot_q4_profession.js

import { readFileSync } from 'fs';

const SRC = readFileSync(new URL('../bot/ExpenseBot_FIXED.gs', import.meta.url), 'utf8');

function sliceBetween(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('start marker not found: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(i, j);
}

// Pull the three blocks we need.
const popularSrc = sliceBetween(
  SRC,
  'var _KESEFLE_POPULAR_PROFESSIONS_',
  '\nvar _KESEFLE_PROFESSION_HUMAN_'
);
const humanSrc = sliceBetween(
  SRC,
  'var _KESEFLE_PROFESSION_HUMAN_',
  '\nfunction _surveySendQ4_'
);
const matcherSrc = sliceBetween(
  SRC,
  'function _matchProfessionFromText_',
  '\n  return null;\n}'
) + '\n  return null;\n}';

// Execute in a sandbox: declare the three so the matcher can return values.
const sandbox = {};
const code = popularSrc + '\n' + humanSrc + '\n' + matcherSrc +
  '\nsandbox.popular = _KESEFLE_POPULAR_PROFESSIONS_;' +
  '\nsandbox.human = _KESEFLE_PROFESSION_HUMAN_;' +
  '\nsandbox.match = _matchProfessionFromText_;';
new Function('sandbox', code)(sandbox);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('=== POPULAR PROFESSIONS LIST ===\n');

check('popular list exists', Array.isArray(sandbox.popular));
check('popular list has 9 entries (will become 10 with "other" added at render time)',
  sandbox.popular.length === 9, 'got ' + sandbox.popular.length);

const REQUIRED_POPULAR_IDS = [
  'general_contractor', 'software_developer_freelance', 'lawyer',
  'accountant', 'private_tutor', 'hairstylist', 'taxi_driver',
  'cashier', 'office_worker',
];
REQUIRED_POPULAR_IDS.forEach(function (id) {
  const found = sandbox.popular.find(function (p) { return p.id === id; });
  check('popular includes: ' + id, !!found, found ? '' : 'missing');
  if (found) {
    check('  ' + id + ' has Hebrew label',
      typeof found.he === 'string' && /[֐-׿]/.test(found.he),
      'he=' + found.he);
    check('  ' + id + ' has description',
      typeof found.desc === 'string' && found.desc.length > 0,
      'desc=' + found.desc);
  }
});

console.log('\n=== HUMAN LABEL MAP ===\n');

check('human map is object', sandbox.human && typeof sandbox.human === 'object');
REQUIRED_POPULAR_IDS.forEach(function (id) {
  check('human map covers popular id: ' + id,
    typeof sandbox.human[id] === 'string' && sandbox.human[id].length > 0,
    'got ' + sandbox.human[id]);
});

console.log('\n=== FREE-TEXT MATCHER ===\n');

// Each test: input → expected id. The matcher should be aggressive enough
// to catch real Hebrew + English user input, but not match nonsense.
const matchCases = [
  // Hebrew construction
  { in: 'קבלן',                          out: 'general_contractor' },
  { in: 'קבלן שיפוצים',                  out: 'general_contractor' },
  { in: 'שיפוצים',                       out: 'general_contractor' },
  // Tech
  { in: 'מפתח תוכנה',                    out: 'software_developer_freelance' },
  { in: 'מפתח פולסטאק',                  out: 'software_developer_freelance' },
  { in: 'developer',                     out: 'software_developer_freelance' },
  { in: 'fullstack engineer',            out: 'software_developer_freelance' },
  // Legal
  { in: 'עורך דין',                      out: 'lawyer' },
  { in: 'עו״ד',                          out: 'lawyer' },
  { in: 'lawyer',                        out: 'lawyer' },
  // Accounting
  { in: 'רואה חשבון',                    out: 'accountant' },
  { in: 'רו״ח',                          out: 'accountant' },
  { in: 'cpa',                           out: 'accountant' },
  // Beauty / hair
  { in: 'מספרה',                         out: 'hairstylist' },
  { in: 'קוסמטיקה',                      out: 'hairstylist' },
  { in: 'barber',                        out: 'hairstylist' },
  // Transport
  { in: 'נהג מונית',                     out: 'taxi_driver' },
  { in: 'gett',                          out: 'taxi_driver' },
  { in: 'uber driver',                   out: 'taxi_driver' },
  { in: 'יאנגו',                         out: 'taxi_driver' },
  // Office
  { in: 'עובד משרד',                     out: 'office_worker' },
  // Tutoring
  { in: 'מורה פרטית',                    out: 'private_tutor' },
  { in: 'מורה',                          out: 'private_tutor' },
  { in: 'tutor',                         out: 'private_tutor' },
  // Cashier
  { in: 'קופאי',                         out: 'cashier' },
  // Extended (off-popular but in matcher)
  { in: 'רופא שיניים',                   out: 'dentist' },
  { in: 'שיניים',                        out: 'dentist' },
  { in: 'dentist',                       out: 'dentist' },
  { in: 'פסיכולוג',                      out: 'psychologist' },
  { in: 'פיזיותרפיסט',                   out: 'physiotherapist' },
  { in: 'אדריכל',                        out: 'architect' },
  { in: 'חשמלאי',                        out: 'electrician' },
  { in: 'אינסטלטור',                     out: 'plumber' },
  { in: 'גנן',                           out: 'gardener' },
  { in: 'מנקה',                          out: 'cleaner' },
  { in: 'cleaning lady',                 out: 'cleaner' },
  { in: 'וטרינר',                        out: 'veterinarian' },
  { in: 'מתווך נדל״ן',                   out: 'real_estate_agent' },
  { in: 'real estate agent',             out: 'real_estate_agent' },
  { in: 'מאמן כושר',                     out: 'personal_trainer' },
  { in: 'יוגה',                          out: 'yoga_instructor' },
  { in: 'pilates',                       out: 'yoga_instructor' },
  { in: 'דיאטנית',                       out: 'nutritionist' },
  { in: 'שף',                            out: 'chef' },
  { in: 'קייטרינג',                      out: 'caterer' },
  { in: 'אופה',                          out: 'baker' },
  { in: 'מסעדה',                         out: 'restaurant_owner' },
  { in: 'בית קפה',                       out: 'cafe_owner' },
  { in: 'barista',                       out: 'cafe_owner' },
  { in: 'חנות אונליין',                  out: 'online_store' },
  { in: 'shopify',                       out: 'online_store' },
  { in: 'שליח',                          out: 'delivery_driver' },
  { in: 'wolt',                          out: 'delivery_driver' },
  { in: 'חקלאי',                         out: 'farmer' },
  { in: 'דייג',                          out: 'fisherman' },
  { in: 'graphic designer',              out: 'graphic_designer' },
  { in: 'מעצב גרפי',                     out: 'graphic_designer' },
  { in: 'photographer',                  out: 'photographer' },
  { in: 'צלם',                           out: 'photographer' },
  { in: 'מתרגם',                         out: 'translator' },
  { in: 'מאפר',                          out: 'makeup_artist' },
  { in: 'מאפרת',                         out: 'makeup_artist' },
];

matchCases.forEach(function (c) {
  const got = sandbox.match(c.in);
  check('"' + c.in + '" → ' + c.out,
    got === c.out,
    'got ' + got);
});

console.log('\n=== NEGATIVE CASES ===\n');

const negCases = [
  '', null, undefined, '   ', '???', 'foobar xyz random text',
  '12345', '!@#$%',
];
negCases.forEach(function (c) {
  check('rejects garbage input: ' + JSON.stringify(c),
    sandbox.match(c) === null,
    'got ' + sandbox.match(c));
});

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
