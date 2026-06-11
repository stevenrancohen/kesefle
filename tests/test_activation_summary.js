// Unit test: api/admin/activation-summary.js + lib/activation.js
// Mocks Upstash KV (scan + get for user/sheet/phone), calls handlerImpl directly
// (bypasses requireAdmin), and asserts the HEALTH-segmented activation the LLM
// Council asked for: "0% activation" is meaningless until you separate users who
// COULD use the bot (sheet + WhatsApp linked) from those physically blocked.
// Run: node tests/test_activation_summary.js
process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'tok';

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;

let users = {}, sheets = {}, phones = {};
function mk(id, { count = 0, linked = false, hasSheet = false, daysAgo = 0 } = {}) {
  users['user:' + id] = { email: id + '@x.com', connectedAt: iso(now - daysAgo * DAY - 60000), expensesCount: count, lastActive: count ? iso(now - 60000) : null };
  if (hasSheet || linked) sheets['sheet:' + id] = { spreadsheetId: 'sheet-' + id };
  if (linked) phones['userPhone:' + id] = { phone: '97250' + id };
}
function reset() { users = {}; sheets = {}; phones = {}; }

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/scan/')) return new Response(JSON.stringify({ result: ['0', Object.keys(users)] }), { status: 200 });
  const m = u.match(/\/get\/(.+)$/);
  if (m) {
    const key = decodeURIComponent(m[1]);
    const rec = users[key] || sheets[key] || phones[key] || null;
    return new Response(JSON.stringify({ result: rec ? JSON.stringify(rec) : null }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

const { handlerImpl } = await import('../api/admin/activation-summary.js');
const res = () => ({ statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const run = async () => { const r = res(); await handlerImpl({ method: 'GET', query: { days: '30' } }, r); return r.body; };

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) pass++; else { fail++; console.log('  FAIL ' + l); } };

// ---- main: 6 linked (3 returned), 4 pending-link, 2 no-sheet ----
reset();
['l0', 'l1', 'l2', 'l3', 'l4', 'l5'].forEach((id, i) => mk(id, { count: [2, 3, 5, 1, 1, 0][i], linked: true })); // e1=5, e2=3
['p0', 'p1', 'p2', 'p3'].forEach((id) => mk(id, { count: 0, hasSheet: true })); // pending link
['n0', 'n1'].forEach((id) => mk(id, { count: 0 }));                              // no sheet
let b = await run();
const h = b.headline, rh = b.registration_health;
ok('200 ok', b.ok === true);
ok('healthy_signups = 6 (fully-linked only)', h.healthy_signups === 6);
ok('healthy_logged_2nd = 3', h.healthy_logged_2nd === 3);
ok('healthy activation rate = 50%', h.activation_rate_pct === 50);
ok('raw_signups = 12 (everyone)', h.raw_signups === 12);
ok('raw rate = 25% (3 of 12) -- the misleading number', h.raw_rate_pct === 25);
ok('verdict OK (>=5 linked, rate >= 30%)', h.verdict === 'OK');
ok('registration_health: linked 6 / pending 4 / no_sheet 2', rh.linked === 6 && rh.pending_link === 4 && rh.no_sheet === 2);
ok('blocked = 6 (the plumbing-stuck users)', rh.blocked === 6);

// ---- PLUMBING: most signups stuck unlinked (<5 linked) ----
reset();
['l0', 'l1', 'l2'].forEach((id) => mk(id, { count: 2, linked: true }));
['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].forEach((id) => mk(id, { count: 0, hasSheet: true }));
b = await run();
ok('PLUMBING verdict when <5 are fully linked', b.headline.verdict === 'PLUMBING');

// ---- VALUE_PROBLEM: enough linked, but they don't return ----
reset();
['l0', 'l1', 'l2', 'l3', 'l4', 'l5'].forEach((id) => mk(id, { count: 1, linked: true })); // all logged once, none twice
b = await run();
ok('VALUE_PROBLEM verdict when >=5 linked but 0% return', b.headline.verdict === 'VALUE_PROBLEM' && b.headline.activation_rate_pct === 0);

// ---- cache: a primed activation:summary:30 key short-circuits the scan ----
reset();
const CACHED = { ok: true, cohort_window_days: 30, headline: { verdict: "OK", activation_rate_pct: 55 } };
const origFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes(encodeURIComponent("activation:summary:30")) && u.includes("/get/"))
    return new Response(JSON.stringify({ result: JSON.stringify(CACHED) }), { status: 200 });
  return origFetch(url);
};
b = await run();
ok("cache hit returns cached:true + cached verdict", b.cached === true && b.headline.verdict === "OK" && b.headline.activation_rate_pct === 55);
const rf = res();
await handlerImpl({ method: "GET", query: { days: "30", fresh: "1" } }, rf);
ok("fresh=1 bypasses cache", rf.body.cached !== true && rf.body.headline.activation_rate_pct !== 55);

console.log('\n' + (fail === 0 ? '✅ test_activation_summary: ALL ' + pass + ' PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
