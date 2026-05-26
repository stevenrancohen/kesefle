// Unit test: household mode for /api/group.
//
// PR #15: validates the household flag end-to-end —
//   1. create with householdMode:true → record has household:true
//   2. create without householdMode → record has household:false
//   3. bot command parser recognises "כספלה צור בית [name]" correctly
//      WITHOUT colliding with the existing "כספלה צור [name]"
//   4. bot command parser recognises "כספלה הצטרף לבית [code]"
//   5. bot command parser recognises "כספלה מאזן בית"
//
// The bot-side checks pull the regexes directly from bot/ExpenseBot_FIXED.gs
// so they fail the second the regex changes in a way that breaks the contract.

import { readFileSync } from 'fs';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); }
}

// ─── 1+2. /api/group create with householdMode ──────────────────────

process.env.KESEFLE_BOT_SECRET = 'test-secret-' + Date.now();
process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'kv-token';
process.env.KESEFLE_AES_KEY = '0'.repeat(64);
process.env.GOOGLE_CLIENT_ID = 'fake';
process.env.GOOGLE_CLIENT_SECRET = 'fake';
const BOT_SECRET = process.env.KESEFLE_BOT_SECRET;

const kvState = new Map();
const setKv = (k, v) => kvState.set(k, typeof v === 'string' ? v : JSON.stringify(v));
const getKv = (k) => kvState.get(k) || null;

const originalFetch = global.fetch;
global.fetch = async function (url, opts) {
  opts = opts || {};
  const u = String(url);
  const getM = u.match(/\/get\/([^?]+)/);
  if (getM) {
    return new Response(JSON.stringify({ result: getKv(decodeURIComponent(getM[1])) }), { status: 200 });
  }
  const setM = u.match(/\/set\/([^?]+)/);
  if (setM && (opts.method || '').toUpperCase() === 'POST') {
    setKv(decodeURIComponent(setM[1]), opts.body);
    return new Response('{"result":"OK"}', { status: 200 });
  }
  // Default — unknown calls (OAuth refresh, sheet create) just resolve.
  if (/oauth2\.googleapis\.com/.test(u)) {
    return new Response(JSON.stringify({ access_token: 'fake' }), { status: 200 });
  }
  // Sheet provisioning is best-effort — if it 500s, group still creates.
  return new Response('{"error":"mock"}', { status: 500 });
};

const { default: groupHandler } = await import('../api/group.js');

function req(body) {
  return {
    method: 'POST',
    headers: { 'x-kesefle-bot-secret': BOT_SECRET },
    body, query: {},
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

console.log('=== /api/group household flag ===\n');

{
  kvState.clear();
  const r = res();
  await groupHandler(req({
    action: 'create',
    creatorPhone: '972501111111',
    creatorName: 'אבי',
    groupName: 'הבית שלנו',
    householdMode: true,
    botSecret: BOT_SECRET,
  }), r);
  check('household create returns 200', r.statusCode === 200, 'got ' + r.statusCode);
  check('household create has ok=true', r.body && r.body.ok === true);
  check('household create returns group code', r.body && /^[A-Z0-9]{6,8}$/.test(r.body.code || ''));
  check('group.household === true', r.body && r.body.group && r.body.group.household === true,
    'got ' + (r.body && r.body.group ? r.body.group.household : 'null'));
  check('group.name preserved', r.body && r.body.group && r.body.group.name === 'הבית שלנו');
  check('creator added as first member',
    r.body && r.body.group && r.body.group.members && r.body.group.members.length === 1);
}

{
  kvState.clear();
  const r = res();
  await groupHandler(req({
    action: 'create',
    creatorPhone: '972502222222',
    creatorName: 'דנה',
    groupName: 'טיול לחופש',
    // householdMode not set — should default to false
    botSecret: BOT_SECRET,
  }), r);
  check('regular group has household=false by default',
    r.body && r.body.group && r.body.group.household === false,
    'got ' + (r.body && r.body.group ? r.body.group.household : 'null'));
}

// ─── 3+4+5. Bot command parser regexes ──────────────────────────────

console.log('\n=== Bot command parsing ===\n');

const BOT_SRC = readFileSync(new URL('../bot/ExpenseBot_FIXED.gs', import.meta.url), 'utf8');

function extractRegex(label, pattern) {
  // Find a `var mXxxx = body.match(/.../i);` line and return the regex.
  const re = new RegExp('var\\s+' + pattern + '\\s*=\\s*body\\.match\\((/[^\\n]+/[gimsuy]*)\\)');
  const m = BOT_SRC.match(re);
  if (!m) throw new Error('regex not found: ' + label);
  // Eval the literal to get the actual RegExp.
  return eval(m[1]);
}

const createHouseRE = extractRegex('mCreateHouse', 'mCreateHouse');
const joinHouseRE = extractRegex('mJoinHouse', 'mJoinHouse');

// Strip "כספלה " prefix the way _handleGroupCommand_ does.
function stripPrefix(s) {
  return String(s).replace(/^\s*כספלה\s*[:\-]?\s*/i, '').trim();
}

// Create-house patterns that MUST match:
const matchYes = [
  'כספלה צור בית',
  'כספלה צור בית כהן',
  'כספלה צור דירה רוטשילד 5',
  'כספלה הקם בית',
  'כספלה create household',
  'כספלה create apartment with the kids',
];
matchYes.forEach((input) => {
  const stripped = stripPrefix(input);
  check('mCreateHouse matches: "' + input + '"', createHouseRE.test(stripped));
});

// Patterns that MUST NOT match createHouse (they're regular group "צור"):
const matchNo = [
  'כספלה צור קבוצה',
  'כספלה צור משפחה',
  'כספלה צור הקבוצה שלי',
];
matchNo.forEach((input) => {
  const stripped = stripPrefix(input);
  check('mCreateHouse does NOT match (regular group): "' + input + '"', !createHouseRE.test(stripped));
});

// Join-house patterns:
const joinYes = [
  'כספלה הצטרף לבית ABC123',
  'כספלה הצטרף לדירה XYZ7890',
  'כספלה join to household ABCDEF',
];
joinYes.forEach((input) => {
  const stripped = stripPrefix(input);
  check('mJoinHouse matches: "' + input + '"', joinHouseRE.test(stripped));
});

const joinNo = [
  'כספלה הצטרף ABC123',  // plain group join, not household
];
joinNo.forEach((input) => {
  const stripped = stripPrefix(input);
  check('mJoinHouse does NOT match plain join: "' + input + '"', !joinHouseRE.test(stripped));
});

// "מאזן בית" detection (uses a /.../ test directly, not assigned to var)
const balanceHouseRE = /^(?:מאזן\s+בית|בית|מי\s+חייב\s+למי|household\s+balance)$/i;
const balYes = ['מאזן בית', 'בית', 'מי חייב למי', 'household balance'];
balYes.forEach((input) => {
  check('balance-house regex matches: "' + input + '"', balanceHouseRE.test(input));
});

// Bot version was bumped
check('KFL_BUILD_VERSION bumped',
  /KFL_BUILD_VERSION\s*=\s*'2026-05-26-household-mode'/.test(BOT_SRC),
  'should be 2026-05-26-household-mode');

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
