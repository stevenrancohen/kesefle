// Unit test: api/admin/activation-summary.js
// Mocks Upstash KV (scan + get), calls handlerImpl directly (bypasses
// requireAdmin), and asserts the activation cohort math + kill-criterion verdict
// the LLM Council asked for. Run: node tests/test_activation_summary.js
process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'tok';

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;

// Build a user set: 12 signed up "now" (3 with >=2 expenses, 4 with exactly 1,
// 5 with zero) + 2 old signups (60d ago) with 10 expenses each (all-time only).
const users = {};
for (let i = 0; i < 12; i++) {
  const count = i < 3 ? [2, 3, 5][i] : (i < 7 ? 1 : 0);
  users['user:c' + i] = {
    email: 'c' + i + '@x.com', connectedAt: iso(now - 60000),
    expensesCount: count, lastActive: count ? iso(now - 60000) : null,
    firstExpenseAt: count ? iso(now - 60000) : null,
  };
}
for (let i = 0; i < 2; i++) {
  users['user:o' + i] = {
    email: 'o' + i + '@x.com', connectedAt: iso(now - 60 * DAY),
    expensesCount: 10, lastActive: iso(now - 60 * DAY),
  };
}
// noise records that must be ignored
users['user:empty'] = {}; // not looksReal -> skipped
users['user:c0:archived'] = { email: 'x', expensesCount: 99 }; // sub-key -> filtered out

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/scan/')) {
    const keys = Object.keys(users);
    return new Response(JSON.stringify({ result: ['0', keys] }), { status: 200 });
  }
  const m = u.match(/\/get\/(.+)$/);
  if (m) {
    const key = decodeURIComponent(m[1]);
    const rec = users[key];
    return new Response(JSON.stringify({ result: rec ? JSON.stringify(rec) : null }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

const { handlerImpl } = await import('../api/admin/activation-summary.js');

function res() {
  return { statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) pass++; else { fail++; console.log('  FAIL ' + l); } };

const r = res();
await handlerImpl({ method: 'GET', query: { days: '30' } }, r);

ok('200 ok', r.statusCode === 200 && r.body && r.body.ok);
const h = r.body.headline, f = r.body.cohort_funnel, a = r.body.all_time;
ok('cohort signups = 12 (excludes old + noise)', h.signups === 12);
ok('logged 2nd expense = 3', h.logged_2nd_expense === 3);
ok('activation rate = 25%', h.activation_rate_pct === 25);
ok('verdict = FREEZE_FEATURES (25% < 30%)', h.verdict === 'FREEZE_FEATURES');
ok('cohort logged 1st = 7', f.logged_1st_expense === 7);
ok('cohort logged 5+ = 1', f.logged_5plus === 1);
ok('first->2nd pct = 42.9 (3 of 7)', f.pct.first_to_2nd === 42.9);
ok('all-time real users = 14 (12 cohort + 2 old, noise excluded)', a.total_real_users === 14);
ok('all-time ever logged 2 = 5 (3 + 2 old)', a.ever_logged_2 === 5);
ok('sub-key user:c0:archived filtered out', r.body.meta.user_keys_scanned === 14);

// small-sample branch
const r2 = res();
global.fetch = (orig => async (url) => {
  if (String(url).includes('/scan/')) return new Response(JSON.stringify({ result: ['0', ['user:c0', 'user:c1', 'user:c2']] }), { status: 200 });
  return orig(url);
})(global.fetch);
await handlerImpl({ method: 'GET', query: { days: '30' } }, r2);
ok('small cohort -> SAMPLE_TOO_SMALL', r2.body.headline.verdict === 'SAMPLE_TOO_SMALL');

console.log('\n' + (fail === 0 ? '✅ test_activation_summary: ALL ' + pass + ' PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
