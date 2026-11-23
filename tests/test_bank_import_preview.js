// Runtime security and behavior tests for /api/import/bank-csv.
// No real network, KV, OAuth or Google Sheets calls are made.

import crypto from 'node:crypto';

process.env.KV_REST_API_URL = 'https://kv.test';
process.env.KV_REST_API_TOKEN = 'kv-token';
process.env.SESSION_SECRET = 'bank-import-test-secret-123456';
process.env.GOOGLE_CLIENT_ID = 'client.test';
process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
process.env.KESEFLE_AES_KEY = '0'.repeat(64);

const userSub = 'bank-preview-user';
const kv = new Map([
  ['user:' + userSub, JSON.stringify({ email:'test@example.com', refreshToken:'refresh-test', spreadsheetId:'sheet-test' })],
  ['sheet:' + userSub, JSON.stringify({ spreadsheetId:'sheet-test' })],
]);
const calls = { pipeline:[], lock:0, batchGet:0, batchSet:0, batchDelete:0, activitySet:0, smismember:0, oauth:0, sheets:0, sadd:0, expire:0, lastSheetBody:null };
let dedupMode = 'none';
let dedupStatus = 200;
let saddStatus = 200;
let expireStatus = 200;
let sheetsStatus = 200;
let sheetsThrows = false;
let lockAvailable = true;

function resetCalls() {
  calls.pipeline.length = 0; calls.lock = 0; calls.batchGet = 0; calls.batchSet = 0; calls.batchDelete = 0; calls.activitySet = 0; calls.smismember = 0; calls.oauth = 0;
  calls.sheets = 0; calls.sadd = 0; calls.expire = 0; calls.lastSheetBody = null;
  dedupMode = 'none'; dedupStatus = 200; saddStatus = 200; expireStatus = 200; sheetsStatus = 200; sheetsThrows = false; lockAvailable = true;
  for (const key of kv.keys()) if (key.startsWith('import:commit:')) kv.delete(key);
}

global.fetch = async function mockFetch(url, options = {}) {
  const target = String(url);
  if (target === 'https://kv.test/pipeline') {
    const commands = JSON.parse(options.body || '[]');
    calls.pipeline.push(commands);
    return new Response(JSON.stringify([{ result:1 }, { result:1 }]), { status:200 });
  }
  const getMatch = target.match(/^https:\/\/kv\.test\/get\/(.+)$/);
  if (getMatch) {
    const key = decodeURIComponent(getMatch[1]);
    if (key.startsWith('import:commit:')) calls.batchGet++;
    return new Response(JSON.stringify({ result:kv.get(key) || null }), { status:200 });
  }
  if (target.startsWith('https://kv.test/set/import%3Alock%3A')) {
    calls.lock++;
    return new Response(JSON.stringify({ result:lockAvailable ? 'OK' : null }), { status:200 });
  }
  const batchSet = target.match(/^https:\/\/kv\.test\/set\/([^?]+)\?ex=/);
  if (batchSet) {
    const key = decodeURIComponent(batchSet[1]); calls.batchSet++;
    kv.set(key, options.body || 'null');
    return new Response(JSON.stringify({ result:'OK' }), { status:200 });
  }
  const batchDelete = target.match(/^https:\/\/kv\.test\/del\/(.+)$/);
  if (batchDelete) {
    calls.batchDelete++; kv.delete(decodeURIComponent(batchDelete[1]));
    return new Response(JSON.stringify({ result:1 }), { status:200 });
  }
  const userSet = target.match(/^https:\/\/kv\.test\/set\/(user%3A[^?]+)$/);
  if (userSet) {
    calls.activitySet++; kv.set(decodeURIComponent(userSet[1]), options.body || 'null');
    return new Response(JSON.stringify({ result:'OK' }), { status:200 });
  }
  if (target.startsWith('https://kv.test/smismember/')) {
    calls.smismember++;
    if (dedupStatus !== 200) return new Response('{}', { status:dedupStatus });
    const parts = target.replace('https://kv.test/smismember/', '').split('/');
    const count = Math.max(0, parts.length - 1);
    const result = Array(count).fill(dedupMode === 'all' ? 1 : 0);
    return new Response(JSON.stringify({ result }), { status:200 });
  }
  if (target.startsWith('https://kv.test/sadd/')) {
    calls.sadd++;
    return new Response(JSON.stringify({ result:1 }), { status:saddStatus });
  }
  if (target.startsWith('https://kv.test/expire/')) {
    calls.expire++;
    return new Response(JSON.stringify({ result:1 }), { status:expireStatus });
  }
  if (target === 'https://oauth2.googleapis.com/token') {
    calls.oauth++;
    return new Response(JSON.stringify({ access_token:'access-test', expires_in:3600 }), { status:200 });
  }
  if (target.includes('sheets.googleapis.com')) {
    calls.sheets++;
    if (target.includes(':append')) calls.lastSheetBody = options.body || null;
    if (sheetsThrows) throw new Error('mock_network_drop');
    if (sheetsStatus !== 200) return new Response('PRIVATE_GOOGLE_ERROR_DETAIL', { status:sheetsStatus });
    return new Response(JSON.stringify({ updates:{ updatedRange:'תנועות!A2:I2' } }), { status:200 });
  }
  return new Response('{}', { status:404 });
};

const { default: handler } = await import('../api/import/bank-csv.js');

function sessionCookie(sub) {
  const header = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ userId:sub, iat:now, exp:now + 3600 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(header + '.' + payload).digest('base64url');
  return 'kefle_session=' + header + '.' + payload + '.' + sig;
}
function request(body, headers = {}) {
  return { method:'POST', url:'/api/import/bank-csv', headers:{ cookie:sessionCookie(userSub), 'content-type':'application/json', ...headers }, body };
}
function response() {
  return {
    statusCode:200, body:null, headers:{}, headersSent:false,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
  };
}
async function invoke(body, headers) {
  const res = response(); await handler(request(body, headers), res); return res;
}

const csv = [
  'תאריך,תאריך ערך,תיאור,אסמכתא,בחובה,בזכות,יתרה',
  '03/03/2026,03/03/2026,שופרסל סודי,9002,245.90,,1000',
  '04/03/2026,04/03/2026,משכורת פרטית,9003,,12500,13500',
].join('\n');
function payload(text, dryRun, previewToken, bank = 'hapoalim') {
  return { bank, csvBase64:Buffer.from(text, 'utf8').toString('base64'), dryRun, ...(previewToken ? { previewToken } : {}) };
}
function windows1255(text) {
  const bytes = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code <= 0x7f) bytes.push(code);
    else if (code >= 0x05d0 && code <= 0x05ea) bytes.push(0xe0 + code - 0x05d0);
    else throw new Error('unsupported_windows_1255_fixture_char_' + code.toString(16));
  }
  return Buffer.from(bytes);
}
async function getPreview(text = csv, bank = 'hapoalim') {
  return invoke(payload(text, true, null, bank));
}

let passed = 0, failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log('  ✅ ' + label); }
  else { failed++; console.log('  ❌ ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\n== Bank import preview: read-only + classified ==');
resetCalls();
const preview = await getPreview();
check('preview succeeds', preview.statusCode === 200 && preview.body?.ok === true, JSON.stringify(preview.body));
check('preview returns ready count without importing', preview.body?.dryRun === true && preview.body?.ready === 2 && preview.body?.imported === 0);
check('preview returns income and expense totals', preview.body?.totals?.income === 12500 && preview.body?.totals?.expense === 245.9);
check('preview sample is classified for the mobile UI', preview.body?.sample?.length === 2 && preview.body.sample.every((row) => row.category && row.subcategory));
check('preview returns a short-lived exact-file grant', typeof preview.body?.previewToken === 'string' && /Z$/.test(preview.body?.expiresAt || ''));
check('preview never resolves OAuth or writes Sheets/hashes', calls.oauth === 0 && calls.sheets === 0 && calls.sadd === 0 && calls.expire === 0);
check('preview uses its own 20/hour rate bucket', calls.pipeline.some((commands) => commands?.[0]?.[1] === 'rl:preview_bank_csv:' + userSub));
check('API response is explicitly no-store', preview.headers['Cache-Control'] === 'no-store, max-age=0');

console.log('\n== Preview grant: required and exact-file bound ==');
resetCalls();
const noGrant = await invoke(payload(csv, false));
check('commit without preview grant is rejected before lock/write', noGrant.statusCode === 409 && noGrant.body?.error === 'preview_token_invalid' && calls.lock === 0 && calls.sheets === 0);
const validGrant = (await getPreview()).body.previewToken;
resetCalls();
const changedFile = await invoke(payload(csv + '\n', false, validGrant));
check('grant cannot authorize different file bytes', changedFile.statusCode === 409 && changedFile.body?.error === 'preview_token_mismatch' && calls.lock === 0);
resetCalls();
const changedBank = await invoke(payload(csv, false, validGrant, 'discount'));
check('grant cannot authorize a different bank parser', changedBank.statusCode === 409 && changedBank.body?.error === 'preview_token_mismatch' && calls.lock === 0);

console.log('\n== Request contract: JSON + Base64 + row cap ==');
resetCalls();
const wrongType = await invoke(payload(csv, true), { 'content-type':'text/plain' });
check('non-JSON request is rejected', wrongType.statusCode === 415 && wrongType.body?.error === 'content_type_required');
const hugeCsv = ['תאריך,תאריך ערך,תיאור,אסמכתא,בחובה,בזכות,יתרה']
  .concat(Array.from({ length:5001 }, (_, i) => `03/03/2026,03/03/2026,עסקה ${i},${i + 1},1,,100`)).join('\n');
resetCalls();
const tooMany = await getPreview(hugeCsv);
check('more than 5,000 parsed rows fail closed before dedup', tooMany.statusCode === 413 && tooMany.body?.error === 'too_many_rows' && calls.smismember === 0);

const legacyCsv = [
  'תאריך,תיאור,בחובה,בזכות',
  '03/03/2026,שופרסל,42,',
].join('\n');
resetCalls();
const legacy = await invoke({ bank:'hapoalim', csvBase64:windows1255(legacyCsv).toString('base64'), dryRun:true });
check('real windows-1255 bytes survive browser-to-parser Base64 path', legacy.statusCode === 200 && legacy.body?.sample?.[0]?.description === 'שופרסל');

const outgoingWageCsv = [
  'תאריך,תיאור,בחובה,בזכות',
  '03/03/2026,שכר עובדים,5000,',
].join('\n');
resetCalls();
const outgoingWage = await getPreview(outgoingWageCsv);
check('authoritative debit direction prevents false income classification', outgoingWage.body?.sample?.[0]?.isIncome === false && outgoingWage.body?.sample?.[0]?.category === 'פיננסים' && outgoingWage.body?.sample?.[0]?.classificationSource === 'fallback');

const repeatedRowCsv = [
  'תאריך,תיאור,אסמכתא,בחובה,בזכות',
  '03/03/2026,קפה,1001,20,',
  '03/03/2026,קפה,1001,20,',
].join('\n');
resetCalls();
const repeatedRows = await getPreview(repeatedRowCsv);
check('byte-identical duplicate inside one file is removed', repeatedRows.body?.ready === 1 && repeatedRows.body?.duplicates === 1);

const distinctReferenceCsv = [
  'תאריך,תיאור,אסמכתא,בחובה,בזכות',
  '03/03/2026,קפה,1001,20,',
  '03/03/2026,קפה,1002,20,',
].join('\n');
resetCalls();
const distinctReferences = await getPreview(distinctReferenceCsv);
check('same-day same-amount rows with distinct bank references stay distinct', distinctReferences.body?.ready === 2 && distinctReferences.body?.duplicates === 0);

console.log('\n== Dedup outage: fail closed ==');
const outageGrant = (await getPreview()).body.previewToken;
resetCalls(); dedupStatus = 500;
const outage = await invoke(payload(csv, false, outageGrant));
check('dedup outage returns stable 503', outage.statusCode === 503 && outage.body?.error === 'dedup_unavailable');
check('dedup outage performs no OAuth or Sheets write', calls.oauth === 0 && calls.sheets === 0 && calls.sadd === 0);

console.log('\n== Concurrent commit: per-user lock ==');
resetCalls();
const concurrentGrant = (await getPreview()).body.previewToken;
resetCalls(); lockAvailable = false;
const concurrent = await invoke(payload(csv, false, concurrentGrant));
check('second simultaneous commit is rejected safely', concurrent.statusCode === 409 && concurrent.body?.error === 'import_in_progress');
check('locked request never reaches dedup/OAuth/Sheets', calls.lock === 1 && calls.smismember === 0 && calls.oauth === 0 && calls.sheets === 0);

console.log('\n== Preview/commit race: commit rechecks duplicates ==');
resetCalls();
const firstPreview = await getPreview();
dedupMode = 'all';
const racedCommit = await invoke(payload(csv, false, firstPreview.body.previewToken));
check('preview originally found rows', firstPreview.body?.ready === 2);
check('commit rechecks and imports zero newly-seen duplicates', racedCommit.statusCode === 200 && racedCommit.body?.imported === 0 && racedCommit.body?.duplicates === 2);
check('race-safe duplicate result makes no Sheets write', calls.smismember === 2 && calls.sheets === 0);
check('commit uses separate 5/hour rate bucket', calls.pipeline.some((commands) => commands?.[0]?.[1] === 'rl:import_bank_csv:' + userSub));

console.log('\n== Post-write hash failure: success with explicit warning ==');
resetCalls();
const hashGrant = (await getPreview()).body.previewToken;
resetCalls(); saddStatus = 500;
const hashFailure = await invoke(payload(csv, false, hashGrant));
check('Sheets write succeeds before hash-save failure', calls.sheets === 1 && calls.sadd === 1);
check('response remains 200 so UI does not encourage a duplicate retry', hashFailure.statusCode === 200 && hashFailure.body?.imported === 2);
check('response exposes dedup warning', hashFailure.body?.dedupWarning === true);
const writtenValues = calls.lastSheetBody ? JSON.parse(calls.lastSheetBody).values : [];
check('written rows are auditable as bank imports', writtenValues.length === 2 && writtenValues.every((row) => row[6] === 'ייבוא בנק'));
check('activation/activity count is advanced by imported row count', calls.activitySet === 1 && JSON.parse(kv.get('user:' + userSub)).expensesCount === 2);
const storedBatch = [...kv.entries()].find(([key]) => key.startsWith('import:commit:'))?.[1] || '';
check('long-lived idempotency state stores counts, not financial samples/totals', !storedBatch.includes('שופרסל סודי') && !storedBatch.includes('משכורת פרטית') && !storedBatch.includes('12500') && !storedBatch.includes('245.9') && !storedBatch.includes('sample') && !storedBatch.includes('totals'));
const repeated = await invoke(payload(csv, false, hashGrant));
check('same exact file returns stored result idempotently', repeated.statusCode === 200 && repeated.body?.idempotent === true && repeated.body?.imported === 2 && calls.sheets === 1);

resetCalls();
const expiryGrant = (await getPreview()).body.previewToken;
resetCalls(); expireStatus = 500;
const expiryFailure = await invoke(payload(csv, false, expiryGrant));
check('hash-expiry failure remains successful but warns against retry', expiryFailure.statusCode === 200 && expiryFailure.body?.imported === 2 && expiryFailure.body?.dedupWarning === true && calls.sheets === 1 && calls.expire === 1);

console.log('\n== Parser diagnostics and upstream errors are sanitized ==');
resetCalls();
const invalidCsv = [
  'תאריך,תאריך ערך,תיאור,אסמכתא,בחובה,בזכות,יתרה',
  'PRIVATE_DATE_999,PRIVATE_DATE_999,פרטי,1,20,,100',
  '03/03/2026,03/03/2026,תקין,2,30,,70',
].join('\n');
const invalid = await getPreview(invalidCsv);
const invalidText = JSON.stringify(invalid.body);
check('invalid date becomes stable code + row number', invalid.body?.skippedReasons?.some((item) => item.reason === 'invalid_date' && item.rowNumber === 2));
check('raw invalid cell is absent from response', !invalidText.includes('PRIVATE_DATE_999'));

resetCalls();
const sheetGrant = (await getPreview()).body.previewToken;
resetCalls(); sheetsStatus = 500;
const sheetFailure = await invoke(payload(csv, false, sheetGrant));
check('Sheets error is standardized', sheetFailure.statusCode === 502 && sheetFailure.body?.error === 'sheets_write_failed');
check('raw Google error detail is absent from response', !JSON.stringify(sheetFailure.body).includes('PRIVATE_GOOGLE_ERROR_DETAIL'));
check('definitive Sheets failure clears pending batch for a safe retry', calls.batchDelete === 1);

console.log('\n== Ambiguous Sheets network result remains pending ==');
resetCalls();
const ambiguousGrant = (await getPreview()).body.previewToken;
resetCalls(); sheetsThrows = true;
const ambiguous = await invoke(payload(csv, false, ambiguousGrant));
check('network loss during append returns status-unknown, not retryable success/failure', ambiguous.statusCode === 409 && ambiguous.body?.error === 'import_status_unknown');
sheetsThrows = false;
const ambiguousRetry = await invoke(payload(csv, false, ambiguousGrant));
check('retry of pending batch is blocked before a second Sheets append', ambiguousRetry.statusCode === 409 && ambiguousRetry.body?.error === 'import_status_unknown' && calls.sheets === 1);

console.log('\n== Logs contain counts, not financial descriptions/amounts ==');
resetCalls();
const originalLog = console.log, originalWarn = console.warn, originalError = console.error;
const captured = [];
console.log = console.warn = console.error = function (line) { captured.push(String(line)); };
try { await getPreview(); }
finally { console.log = originalLog; console.warn = originalWarn; console.error = originalError; }
const logs = captured.join('\n');
check('logs omit transaction descriptions', !logs.includes('שופרסל סודי') && !logs.includes('משכורת פרטית'));
check('logs omit transaction amounts', !logs.includes('12500') && !logs.includes('245.9'));

console.log('\n' + (failed ? '❌ ' + failed + ' FAILED, ' + passed + ' passed' : '✅ ALL ' + passed + ' CHECKS PASSED'));
process.exit(failed ? 1 : 0);

