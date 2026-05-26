// Unit test: api/sheet/csv-import.js
// Validates the parser + column-detection logic. Network is mocked.
// Run: node tests/test_csv_import.js

process.env.KESEFLE_BOT_SECRET = 'test-' + Date.now();
process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'tok';
process.env.KESEFLE_AES_KEY = '0'.repeat(64);
process.env.GOOGLE_CLIENT_ID = 'fake';
process.env.GOOGLE_CLIENT_SECRET = 'fake';
const BOT_SECRET = process.env.KESEFLE_BOT_SECRET;

const kv = new Map();
const setKv = (k, v) => kv.set(k, typeof v === 'string' ? v : JSON.stringify(v));

global.fetch = async (url, opts) => {
  opts = opts || {};
  const u = String(url);
  const getM = u.match(/\/get\/([^?]+)/);
  if (getM) return new Response(JSON.stringify({ result: kv.get(decodeURIComponent(getM[1])) || null }), { status: 200 });
  const setM = u.match(/\/set\/([^?]+)/);
  if (setM && (opts.method || '').toUpperCase() === 'POST') {
    kv.set(decodeURIComponent(setM[1]), opts.body); return new Response('{"result":"OK"}', { status: 200 });
  }
  if (/oauth2\.googleapis\.com/.test(u)) {
    return new Response(JSON.stringify({ access_token: 'fake' }), { status: 200 });
  }
  if (/spreadsheets\/.+\/values\/.+/.test(u) && (!opts.method || opts.method.toUpperCase() === 'GET')) {
    return new Response(JSON.stringify({ values: [['2026-04-15','2026-04','99','אוכל','','קפה ארומה']] }), { status: 200 });
  }
  if (/:append/.test(u)) return new Response('{"updates":{}}', { status: 200 });
  return new Response('{}', { status: 404 });
};

const { default: handler } = await import('../api/sheet/csv-import.js');

function req(body, headers) {
  return { method: 'POST', headers: headers || {}, body, query: {}, reqId: 'test' };
}
function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, setHeader() { return this; } };
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('=== AUTH ===\n');
{
  const r = res();
  await handler(req({ phone: '972501111111', csv: 'date,amount\n2026-05-01,100' }, {}), r);
  check('rejects no bot secret', r.statusCode === 401);
}

console.log('\n=== VALIDATION ===\n');
{
  const r = res();
  await handler(req({ csv: 'a,b\n1,2' }, { 'x-kesefle-bot-secret': BOT_SECRET }), r);
  check('rejects missing phone', r.statusCode === 400 && r.body.error === 'missing_phone');
}
{
  const r = res();
  await handler(req({ phone: '972501111111' }, { 'x-kesefle-bot-secret': BOT_SECRET }), r);
  check('rejects missing csv', r.statusCode === 400 && r.body.error === 'missing_csv');
}
{
  const r = res();
  // CSV that has no recognizable date/amount columns
  await handler(req({ phone: '972501111111', csv: 'foo,bar,baz\n1,2,3' }, { 'x-kesefle-bot-secret': BOT_SECRET }), r);
  check('rejects when no date+amount columns detected', r.statusCode === 400 && r.body.error === 'could_not_detect_columns');
}

console.log('\n=== PREVIEW (Hebrew bank export) ===\n');
{
  const csv = 'תאריך,סכום,תיאור,קטגוריה\n01/04/2026,45.5,קפה ארומה,אוכל\n02/04/2026,1800,שכר דירה,בית\n03/04/2026,250,שופרסל,אוכל\n';
  const r = res();
  await handler(req({ phone: '972501111111', csv, mode: 'preview' }, { 'x-kesefle-bot-secret': BOT_SECRET }), r);
  check('preview returns 200', r.statusCode === 200, 'got ' + r.statusCode + ' ' + JSON.stringify(r.body));
  check('preview detected Hebrew date column', r.body.detected && r.body.detected.dateCol === 0);
  check('preview detected Hebrew amount column', r.body.detected && r.body.detected.amountCol === 1);
  check('preview detected Hebrew desc column', r.body.detected && r.body.detected.descCol === 2);
  check('preview detected Hebrew category column', r.body.detected && r.body.detected.categoryCol === 3);
  check('preview parsed 3 valid records', r.body.validRecords === 3, 'got ' + r.body.validRecords);
  check('preview did NOT write (mode=preview)', r.body.mode === 'preview');
  if (r.body.sampleRows) {
    check('first record date parsed DMY → ISO', r.body.sampleRows[0].date === '2026-04-01', 'got ' + r.body.sampleRows[0].date);
    check('first record amount 45.5', r.body.sampleRows[0].amount === 45.5);
    check('first record description preserved', r.body.sampleRows[0].description === 'קפה ארומה');
  }
}

console.log('\n=== PREVIEW (English bank export with quoted fields + currency symbols) ===\n');
{
  const csv = 'Date,Description,Amount\n2026-04-15,"Starbucks, Tel Aviv","₪45.00"\n2026-04-20,"Salary","₪15,000.00"\n';
  const r = res();
  await handler(req({ phone: '972501111111', csv, mode: 'preview' }, { 'x-kesefle-bot-secret': BOT_SECRET }), r);
  check('English headers detected', r.body.ok === true);
  check('quoted description with embedded comma preserved',
    r.body.sampleRows && r.body.sampleRows[0].description === 'Starbucks, Tel Aviv');
  check('₪ stripped + thousands comma stripped from amount',
    r.body.sampleRows && r.body.sampleRows[1].amount === 15000);
  check('salary detected as income via description',
    r.body.sampleRows && r.body.sampleRows[1].isIncome === true);
}

console.log('\n=== HEADER ROW NOT AT INDEX 0 ===\n');
{
  // Title row + blank + actual headers
  const csv = 'My Export from BankX\n\nתאריך,סכום,תיאור\n15/04/2026,100,קפה\n';
  const r = res();
  await handler(req({ phone: '972501111111', csv, mode: 'preview' }, { 'x-kesefle-bot-secret': BOT_SECRET }), r);
  check('skipped title rows, detected headers at row 2', r.body.detected && r.body.detected.headerRow === 2);
  check('parsed 1 record after offset header', r.body.validRecords === 1);
}

console.log('\n=== EDGE: bad date / bad amount tracked as errors ===\n');
{
  const csv = 'תאריך,סכום\n01/04/2026,100\nnot-a-date,200\n02/04/2026,not-a-number\n03/04/2026,150\n';
  const r = res();
  await handler(req({ phone: '972501111111', csv, mode: 'preview' }, { 'x-kesefle-bot-secret': BOT_SECRET }), r);
  check('valid records = 2 (rows 1 and 4)', r.body.validRecords === 2);
  check('errors array has 2 entries', r.body.errors && r.body.errors.length === 2);
  check('first error is bad_date', r.body.errors[0].why === 'bad_date');
  check('second error is bad_amount', r.body.errors[1].why === 'bad_amount');
}

console.log('\n=== COMMIT (tenant isolation) ===\n');
{
  // No user record → 404 no_user
  kv.clear();
  const csv = 'תאריך,סכום,תיאור\n01/04/2026,100,קפה\n';
  const r = res();
  await handler(req({ phone: '972501111111', csv, mode: 'commit' }, { 'x-kesefle-bot-secret': BOT_SECRET }), r);
  check('commit with unlinked phone → 404 no_user', r.statusCode === 404 && r.body.error === 'no_user');
}
{
  // Set up tenant
  kv.clear();
  setKv('phone:972501111111', { userSub: 'sub-A' });
  setKv('user:sub-A', { refreshToken: 'rt', spreadsheetId: 'sheet-A' });
  setKv('sheet:sub-A', { spreadsheetId: 'sheet-A' });
  const csv = 'תאריך,סכום,תיאור\n01/04/2026,100,קפה חדש\n';
  const r = res();
  await handler(req({ phone: '972501111111', csv, mode: 'commit' }, { 'x-kesefle-bot-secret': BOT_SECRET }), r);
  check('commit happy path returns 200', r.statusCode === 200, 'got ' + r.statusCode + ' ' + JSON.stringify(r.body));
  check('commit imported 1 row', r.body.imported === 1);
}
{
  // Dedup: existing row with same date+amount+desc should be skipped
  const csv = 'תאריך,סכום,תיאור\n15/04/2026,99,קפה ארומה\n';
  const r = res();
  await handler(req({ phone: '972501111111', csv, mode: 'commit' }, { 'x-kesefle-bot-secret': BOT_SECRET }), r);
  check('dedup: matching existing row skipped', r.body.skippedDuplicates >= 1, 'skipped=' + r.body.skippedDuplicates);
}

console.log('\n' + (fail === 0 ? '✅ ALL ' + pass + ' CHECKS PASSED' : '❌ ' + fail + ' FAILED, ' + pass + ' passed'));
process.exit(fail === 0 ? 0 : 1);
