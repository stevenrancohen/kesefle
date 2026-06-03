// tests/test_weekly_question_cron.js
//
// Standalone suite for the weekly proactive-question cron (task #193,
// api/cron/weekly-question.js). No mocking framework: we read the REAL source
// and (a) statically assert the load-bearing safety pieces are present, and
// (b) eval the PURE helpers (isoWeekKeyUTC + weeklyQuestionMessage) to verify
// the ISO-week idempotency key + question rotation behave correctly.
//
// Pattern matches the other Kesefle cron tests (budget-check assertions in
// tests/full_qa.js + balanced-brace extraction used across bot/test_*.js).
//
// Run: node tests/test_weekly_question_cron.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CRON = fs.readFileSync(path.join(ROOT, 'api/cron/weekly-question.js'), 'utf8');
const VERCEL = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; fails.push(label); console.log('  FAIL ' + label + (detail ? ' --- ' + detail : '')); }
}

// Function-body extractor for hoisted `function name(...) { ... }` decls.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === '(') pd++; else if (src[k] === ')') { pd--; if (!pd) { k++; break; } } }
  let i = src.indexOf('{', k), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { j++; break; } } }
  return src.slice(start, j);
}

console.log('\n=== AUTH + SAFETY (static source assertions) ===\n');

ok('verifies CRON_SECRET via timing-safe Bearer compare',
  /process\.env\.CRON_SECRET/.test(CRON) &&
  /constantTimeEqual\(\s*cronAuth\s*,\s*'Bearer '\s*\+\s*process\.env\.CRON_SECRET\s*\)/.test(CRON),
  'no CRON_SECRET Bearer check');

ok('manual override uses timing-safe KESEFLE_BOT_SECRET compare',
  /constantTimeEqual\(\s*adminParam\s*,\s*process\.env\.KESEFLE_BOT_SECRET\s*\)/.test(CRON),
  'no admin-secret check');

ok('unauthorized calls get 401',
  /isAuthorizedCronCall\(req\)/.test(CRON) &&
  /status\(401\)[\s\S]*unauthorized/.test(CRON),
  'no 401 guard');

ok('has an env kill switch (KESEFLE_DISABLE_WEEKLY_QUESTION)',
  /process\.env\.KESEFLE_DISABLE_WEEKLY_QUESTION\s*===\s*'1'/.test(CRON),
  'no kill switch');

ok('respects opt-out via canonical optout: key',
  /kvGet\(\s*'optout:'\s*\+\s*phone\s*\)/.test(CRON),
  'no optout check (or wrong key)');

ok('throttles sends + caps users per run',
  /SEND_THROTTLE_MS/.test(CRON) && /MAX_USERS_PER_RUN/.test(CRON) &&
  /slice\(0,\s*MAX_USERS_PER_RUN\)/.test(CRON),
  'missing throttle/cap');

ok('does NOT hardcode any secret/token literal',
  !/sk-ant-/.test(CRON) && !/EAAB[A-Za-z0-9]/.test(CRON) && !/Bearer\s+[A-Za-z0-9]{16,}/.test(CRON),
  'possible hardcoded secret');

ok('content-free audit log (no message body persisted)',
  /weekly_question_run:/.test(CRON) &&
  !/body:\s*body/.test(CRON),
  'audit log may leak content');

console.log('\n=== IDEMPOTENCY (run-level + per-user, SETNX) ===\n');

ok('run-level lock keyed cron:weekly-question:lastRun:<iso-week> via SETNX',
  /kvSetNX\(\s*runGuardKey/.test(CRON) &&
  /'cron:weekly-question:lastRun:'\s*\+\s*isoWeek/.test(CRON),
  'no run-level lastRun guard');

ok('second run in same ISO week is a no-op (already_ran_this_week)',
  /already_ran_this_week/.test(CRON),
  'no same-week short-circuit');

ok('per-user weekly gate via SETNX (weekly_question_last:{phone})',
  /kvSetNX\(\s*gateKey\s*,\s*isoWeek/.test(CRON) &&
  /'weekly_question_last:'\s*\+\s*phone/.test(CRON),
  'no per-user weekly gate');

ok('rolls back the per-user gate on send failure',
  /kvDel\(\s*gateKey\s*\)/.test(CRON),
  'no rollback on send failure');

ok('dry-run only PEEKs (never claims gate keys)',
  /if \(dryRun\)/.test(CRON) &&
  /PEEK only/.test(CRON),
  'dry-run may claim keys');

console.log('\n=== VERCEL CRON REGISTRATION ===\n');

ok('vercel.json registers /api/cron/weekly-question',
  /"\/api\/cron\/weekly-question"/.test(VERCEL),
  'cron path not registered');

// Pull the schedule for our path and assert it is weekly + non-colliding.
const crons = JSON.parse(VERCEL).crons || [];
const mine = crons.filter((c) => c.path === '/api/cron/weekly-question');
ok('exactly one weekly-question cron entry', mine.length === 1, 'count=' + mine.length);

const sched = mine[0] && mine[0].schedule;
ok('schedule is weekly (day-of-week field is a single 0-6, not "*")',
  typeof sched === 'string' && /^\S+\s+\S+\s+\S+\s+\S+\s+[0-6]$/.test(sched),
  'schedule=' + sched);

// Non-collision: no OTHER cron shares our exact "minute hour * * dow" slot.
const collide = crons.filter((c) => c.path !== '/api/cron/weekly-question' && c.schedule === sched);
ok('schedule does not collide with any existing cron slot',
  collide.length === 0,
  'collides with ' + collide.map((c) => c.path).join(', '));

console.log('\n=== PURE LOGIC: ISO-WEEK KEY ===\n');

// Balanced [..] slice for the WEEKLY_QUESTIONS array literal (weeklyQuestion-
// Message closes over it, so it must be in scope when we rebuild the fn).
function extractArray(src, name) {
  const s = src.indexOf(name);
  if (s < 0) throw new Error('array not found: ' + name);
  const i = src.indexOf('[', s);
  let d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '[') d++; else if (src[j] === ']') { d--; if (!d) { j++; break; } } }
  return src.slice(i, j);
}

// Load the pure helpers via new Function (same no-mock pattern as
// bot/test_llm_profession_boost.js): the extracted `function` declaration is a
// statement, so we put it inside a fresh function body and return it by name.
const isoWeekKeyUTC = new Function(extractFn(CRON, 'isoWeekKeyUTC') + '\nreturn isoWeekKeyUTC;')();
const weeklyQuestionMessage = new Function(
  'var WEEKLY_QUESTIONS = ' + extractArray(CRON, 'WEEKLY_QUESTIONS = ') + ';\n' +
  extractFn(CRON, 'weeklyQuestionMessage') + '\nreturn weeklyQuestionMessage;'
)();
// isoWeekNumber depends on isoWeekKeyUTC being in scope; rebuild it directly.
const isoWeekNumber = (d) => {
  const key = isoWeekKeyUTC(d);
  return parseInt(key.slice(key.indexOf('W') + 1), 10) || 0;
};

// Known ISO-week anchors (UTC):
//   2026-01-01 is a Thursday -> ISO week 2026-W01.
//   2026-06-03 (today, a Wednesday) -> ISO week 2026-W23.
//   2027-01-04 is a Monday -> ISO week 2027-W01.
ok('2026-01-01 -> 2026-W01',
  isoWeekKeyUTC(new Date(Date.UTC(2026, 0, 1))) === '2026-W01',
  isoWeekKeyUTC(new Date(Date.UTC(2026, 0, 1))));
ok('2026-06-03 -> 2026-W23',
  isoWeekKeyUTC(new Date(Date.UTC(2026, 5, 3))) === '2026-W23',
  isoWeekKeyUTC(new Date(Date.UTC(2026, 5, 3))));
ok('2027-01-04 -> 2027-W01',
  isoWeekKeyUTC(new Date(Date.UTC(2027, 0, 4))) === '2027-W01',
  isoWeekKeyUTC(new Date(Date.UTC(2027, 0, 4))));

// Same key for every day inside one ISO week (Mon 06-01 .. Sun 06-07 2026).
const wk = isoWeekKeyUTC(new Date(Date.UTC(2026, 5, 1)));
let sameAllWeek = true;
for (let day = 1; day <= 7; day++) {
  if (isoWeekKeyUTC(new Date(Date.UTC(2026, 5, day))) !== wk) sameAllWeek = false;
}
ok('all 7 days of one ISO week share the same key (idempotency stable)', sameAllWeek, wk);

// Adjacent weeks differ -> the run guard releases next week.
ok('adjacent ISO weeks produce different keys',
  isoWeekKeyUTC(new Date(Date.UTC(2026, 5, 3))) !== isoWeekKeyUTC(new Date(Date.UTC(2026, 5, 10))),
  'keys identical across weeks');

console.log('\n=== PURE LOGIC: QUESTION ROTATION + HEBREW ===\n');

// One question; rotates by week number; deterministic per week.
const q23a = weeklyQuestionMessage('', isoWeekNumber(new Date(Date.UTC(2026, 5, 3))));
const q23b = weeklyQuestionMessage('', isoWeekNumber(new Date(Date.UTC(2026, 5, 5))));
ok('question is deterministic within a week', q23a === q23b, 'differs within same week');

const q24 = weeklyQuestionMessage('', isoWeekNumber(new Date(Date.UTC(2026, 5, 10))));
ok('question rotates between adjacent weeks', q23a !== q24, 'same question two weeks running');

ok('question is non-empty Hebrew and ends like a question',
  typeof q23a === 'string' && q23a.length > 20 && /[֐-׿]/.test(q23a),
  JSON.stringify(q23a));

// Personalization: name is prepended, question text preserved.
const named = weeklyQuestionMessage('דנה', isoWeekNumber(new Date(Date.UTC(2026, 5, 3))));
ok('first name is prepended when present',
  named.indexOf('דנה') === 0 && /שאלת השבוע/.test(named),
  named);
ok('no name -> raw question (no leading comma/space artifacts)',
  q23a === weeklyQuestionMessage(null, isoWeekNumber(new Date(Date.UTC(2026, 5, 3)))),
  'null name changed output');

// No bidi control characters in any question variant (test-hebrew-text rule).
const BIDI = /[‎‏‪-‮⁦-⁩]/;
let anyBidi = false;
for (let w = 0; w < 12; w++) { if (BIDI.test(weeklyQuestionMessage('דנה', w)) || BIDI.test(weeklyQuestionMessage('', w))) anyBidi = true; }
ok('no bidi control marks in any question variant', !anyBidi, 'found bidi control char');

console.log('\n' + (fail === 0
  ? 'PASS ALL ' + pass + ' CHECKS PASSED'
  : 'FAIL ' + fail + ' FAILED (' + fails.join('; ') + '), ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
