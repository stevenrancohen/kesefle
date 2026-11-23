import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'kv-token';
process.env.GOOGLE_CLIENT_ID = 'client-id';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const kv = new Map([
  ['sheet:user-1', JSON.stringify({
    spreadsheetId: 'sheet-1',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1',
  })],
  ['user:user-1', JSON.stringify({
    userSub: 'user-1',
    spreadsheetId: 'sheet-1',
    email: 'person@example.com',
    refreshToken: 'refresh-token',
  })],
]);

let lastSheetBody = null;
global.fetch = async function mockFetch(url, options = {}) {
  const value = String(url);
  if (value === 'https://kv.test/pipeline') {
    return new Response(JSON.stringify([{ result: 1 }, { result: 1 }]), { status: 200 });
  }
  if (value.startsWith('https://kv.test/get/')) {
    const key = decodeURIComponent(value.slice('https://kv.test/get/'.length));
    return new Response(JSON.stringify({ result: kv.get(key) || null }), { status: 200 });
  }
  if (value.startsWith('https://kv.test/set/')) {
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  }
  if (value === 'https://oauth2.googleapis.com/token') {
    return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200 });
  }
  if (value.includes('sheets.googleapis.com') && value.includes(':append')) {
    lastSheetBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ updates: { updatedRange: "'תנועות'!A2:I2" } }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

const { handlerImpl, resolveWebClassification } = await import('../api/sheet/web-append.js');

let pass = 0;
let fail = 0;
function check(label, condition, detail = '') {
  if (condition) {
    pass++;
    console.log('  ✅ ' + label);
  } else {
    fail++;
    console.log('  ❌ ' + label + (detail ? ' — ' + detail : ''));
  }
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
  };
}

async function write(body) {
  lastSheetBody = null;
  const req = {
    method: 'POST',
    body,
    user: { sub: 'user-1', email: 'person@example.com' },
    headers: {},
    reqId: 'classifier-test',
  };
  const res = response();
  await handlerImpl(req, res);
  return { res, row: lastSheetBody?.values?.[0] };
}

console.log('\n=== classification resolution ===');
{
  const c = resolveWebClassification({ rawText: 'שופרסל אונליין', isIncome: false });
  check('blank category resolves automatically', c.source === 'keyword' && c.subcategory === 'מזון', JSON.stringify(c));
}
{
  const c = resolveWebClassification({ rawText: 'שופרסל', category: 'דלק', isIncome: false });
  check('manual category always wins', c.source === 'manual' && c.category === 'דלק' && c.subcategory === 'דלק', JSON.stringify(c));
}
{
  const c = resolveWebClassification({ rawText: 'שכר עובדים', isIncome: false });
  check('expense toggle prevents salary flip', c.source === 'fallback' && c.subcategory === 'שונות', JSON.stringify(c));
}
{
  const c = resolveWebClassification({ rawText: 'משכורת', isIncome: 'false' });
  check('string "false" cannot flip an expense to income', c.source === 'fallback' && c.subcategory === 'שונות', JSON.stringify(c));
}
{
  const c = resolveWebClassification({ rawText: 'לא זוכר', isIncome: true });
  check('unknown income gets visible income fallback',
    c.source === 'fallback' && c.category === 'הכנסות שונות' && c.subcategory === 'הכנסות שונות - כללי',
    JSON.stringify(c));
}

console.log('\n=== authenticated write contract ===');
{
  const secretDescription = 'שופרסל SECRET-DESCRIPTION-DO-NOT-LOG';
  const captured = [];
  const originalLog = console.log;
  console.log = (...args) => captured.push(args.join(' '));
  const { res, row } = await write({ amount: 245.9, rawText: secretDescription, isIncome: false });
  console.log = originalLog;
  check('automatic write succeeds', res.statusCode === 200 && res.body?.ok === true, JSON.stringify(res.body));
  check('response reports stored category',
    res.body?.category === 'מזון ופארמה' && res.body?.subcategory === 'אוכל לבית' && res.body?.classificationSource === 'keyword',
    JSON.stringify(res.body));
  check('sheet row receives resolved top-level + subcategory', row?.[3] === 'מזון ופארמה' && row?.[4] === 'אוכל לבית', JSON.stringify(row));
  check('raw description never enters application logs', !captured.join('\n').includes('SECRET-DESCRIPTION-DO-NOT-LOG'));
}
{
  const { res, row } = await write({ amount: 80, rawText: 'שופרסל', category: 'דלק', isIncome: false });
  check('manual write source is returned', res.body?.classificationSource === 'manual', JSON.stringify(res.body));
  check('manual choice wins in sheet row', row?.[3] === 'דלק' && row?.[4] === 'דלק', JSON.stringify(row));
}
{
  const { res, row } = await write({ amount: 9000, rawText: 'משכורת נובמבר', isIncome: true });
  check('explicit income stays income', row?.[7] === false && res.body?.category === 'שכר', JSON.stringify(row));
  check('salary maps to visible dashboard row', row?.[4] === 'הכנסה 1 — משכורת', JSON.stringify(row));
}
{
  const { res, row } = await write({ amount: 12, rawText: 'לא זוכר', isIncome: false });
  check('unknown expense write succeeds', res.statusCode === 200 && res.body?.classificationSource === 'fallback');
  check('unknown expense is visible in dashboard catch-all', row?.[3] === 'אישי' && row?.[4] === 'שונות', JSON.stringify(row));
}

console.log('\n=== browser contract ===');
const expenseHtml = fs.readFileSync(path.join(root, 'expense.html'), 'utf8');
check('browser sends blank category through unchanged', /category:\s*category,/.test(expenseHtml));
check('browser no longer forces uncategorized entries to שונות', !/category:\s*category\s*\|\|\s*\(isIncome/.test(expenseHtml));
check('saved-now UI uses the server-resolved subcategory', /savedCategory\s*=\s*j\.subcategory\s*\|\|\s*j\.category/.test(expenseHtml));
check('auto-classification confirmation uses textContent',
  /status\.textContent\s*=\s*j\.classificationSource\s*===\s*'keyword'/.test(expenseHtml));

console.log('\n' + (fail === 0
  ? `✅ ALL ${pass} WEB-APPEND CLASSIFIER CHECKS PASSED`
  : `❌ ${fail} FAILED, ${pass} passed`));
process.exit(fail === 0 ? 0 : 1);
