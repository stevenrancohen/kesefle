// Unit test: api/learn.js consensus threshold (PR #17).
//
// Validates that the GET endpoint only returns `found:true` once enough
// corrections have agreed on the same (hash, category). Without this gate,
// a single user correction (potentially malicious) overwrites the global
// learning for every future user.
//
// Run: node tests/test_learn_consensus.js

process.env.KESEFLE_BOT_SECRET = 'test-bot-secret-' + Date.now();
process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'kv-token';
process.env.KESEFLE_LEARN_CONSENSUS_THRESHOLD = '3';

const BOT_SECRET = process.env.KESEFLE_BOT_SECRET;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); }
}

// Mock KV.
const kvState = new Map();
const setKv = (k, v) => kvState.set(k, typeof v === 'string' ? v : JSON.stringify(v));
const getKv = (k) => kvState.get(k) || null;

global.fetch = async (url, opts) => {
  opts = opts || {};
  const u = String(url);
  const getM = u.match(/\/get\/([^?]+)/);
  if (getM) return new Response(JSON.stringify({ result: getKv(decodeURIComponent(getM[1])) }), { status: 200 });
  const setM = u.match(/\/set\/([^?]+)/);
  if (setM && (opts.method || '').toUpperCase() === 'POST') {
    setKv(decodeURIComponent(setM[1]), opts.body);
    return new Response('{"result":"OK"}', { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

const { default: handler } = await import('../api/learn.js');

function req(method, headers, body, query) {
  return {
    method, headers: headers || {}, body, query: query || {},
    reqId: 'test-' + Math.random().toString(36).slice(2, 6),
  };
}
function res() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    setHeader() { return this; },
  };
}

const TEST_HASH = 'a'.repeat(40);

console.log('=== POST: record corrections ===\n');

// Submit 3 corrections — each one increments count.
for (let i = 1; i <= 3; i++) {
  const r = res();
  await handler(req('POST',
    { 'x-kesefle-bot-secret': BOT_SECRET },
    { hash: TEST_HASH, category: 'אוכל', subcategory: 'מסעדות', botSecret: BOT_SECRET }
  ), r);
  check('POST #' + i + ' returns 200 ok', r.statusCode === 200 && r.body.ok === true);
  check('POST #' + i + ' count === ' + i, r.body.count === i, 'got ' + r.body.count);
}

console.log('\n=== GET: consensus gate ===\n');

// Submit 1 correction for a NEW hash, GET should return found:false
// because count (1) < threshold (3).
const NEW_HASH = 'b'.repeat(40);
{
  const postR = res();
  await handler(req('POST',
    { 'x-kesefle-bot-secret': BOT_SECRET },
    { hash: NEW_HASH, category: 'תחבורה', subcategory: 'דלק', botSecret: BOT_SECRET }
  ), postR);
  check('seed 1 correction for NEW_HASH', postR.statusCode === 200);

  const getR = res();
  await handler(req('GET',
    { 'x-kesefle-bot-secret': BOT_SECRET },
    null, { h: NEW_HASH }
  ), getR);
  check('GET with count=1 returns found:false (below threshold)',
    getR.body.found === false, 'body=' + JSON.stringify(getR.body));
  check('GET returns pending: { count, needed }',
    getR.body.pending && getR.body.pending.count === 1 && getR.body.pending.needed === 3);
}

// TEST_HASH has count=3 (from earlier loop). GET should return found:true.
{
  const getR = res();
  await handler(req('GET',
    { 'x-kesefle-bot-secret': BOT_SECRET },
    null, { h: TEST_HASH }
  ), getR);
  check('GET with count=3 returns found:true (at threshold)',
    getR.body.found === true, 'body=' + JSON.stringify(getR.body));
  check('GET returns the learned category', getR.body.category === 'אוכל');
  check('GET returns the learned subcategory', getR.body.subcategory === 'מסעדות');
  check('GET returns the count', getR.body.count === 3);
}

// One more POST — count=4, still found:true.
{
  const postR = res();
  await handler(req('POST',
    { 'x-kesefle-bot-secret': BOT_SECRET },
    { hash: TEST_HASH, category: 'אוכל', subcategory: 'מסעדות', botSecret: BOT_SECRET }
  ), postR);
  check('4th correction increments count', postR.body.count === 4);
}

console.log('\n=== AUTH ===\n');

{
  const getR = res();
  await handler(req('GET',
    { 'x-kesefle-bot-secret': 'wrong-secret' },
    null, { h: TEST_HASH }
  ), getR);
  check('wrong bot secret -> 401', getR.statusCode === 401);
}

{
  const postR = res();
  await handler(req('POST',
    {},
    { hash: TEST_HASH, category: 'אוכל', botSecret: BOT_SECRET }
  ), postR);
  // body.botSecret is also accepted
  check('botSecret in body works', postR.statusCode === 200);
}

console.log('\n=== VALIDATION ===\n');

{
  const postR = res();
  await handler(req('POST',
    { 'x-kesefle-bot-secret': BOT_SECRET },
    { hash: TEST_HASH, category: 'הקטגוריה הלא קיימת', botSecret: BOT_SECRET }
  ), postR);
  check('invalid category -> 400',
    postR.statusCode === 400 && postR.body.error === 'invalid_category');
}

{
  const postR = res();
  await handler(req('POST',
    { 'x-kesefle-bot-secret': BOT_SECRET },
    { hash: 'not-a-hash', category: 'אוכל', botSecret: BOT_SECRET }
  ), postR);
  check('invalid hash -> 400',
    postR.statusCode === 400 && postR.body.error === 'invalid_hash');
}

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
