#!/usr/bin/env node
// Exercises the real PayPal invoice coordinator with an in-memory Redis model.
// It proves replay/concurrency/lost-response paths never issue a second legal
// tax document and that uncertainty is durably escalated instead.

const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAYPAL = fs.readFileSync(path.join(ROOT, 'api/billing/paypal.js'), 'utf8');

function fnSrc(src, name) {
  let start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let p = src.indexOf('(', start), pd = 0, k = p;
  for (; k < src.length; k++) {
    if (src[k] === '(') pd++;
    else if (src[k] === ')' && --pd === 0) { k++; break; }
  }
  let i = src.indexOf('{', k), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) { j++; break; }
  }
  return src.slice(start, j);
}

function templateValue(name) {
  const marker = `const ${name} = \``;
  const start = PAYPAL.indexOf(marker);
  if (start < 0) throw new Error('template not found: ' + name);
  const bodyStart = start + marker.length;
  const end = PAYPAL.indexOf('`;', bodyStart);
  return PAYPAL.slice(bodyStart, end);
}

const CLAIM_INVOICE_JOB_LUA = templateValue('CLAIM_INVOICE_JOB_LUA');
const COMPLETE_INVOICE_JOB_LUA = templateValue('COMPLETE_INVOICE_JOB_LUA');
const RECONCILE_INVOICE_JOB_LUA = templateValue('RECONCILE_INVOICE_JOB_LUA');
const INVOICE_JOB_TTL_SEC = 400 * 24 * 3600;
const INVOICE_JOB_LEASE_MS = 2 * 60 * 1000;
const log = { info() {}, warn() {}, error() {} };

const jobs = new Map();
const receipts = new Map();
const queued = [];
let loseCompletionResponse = false;
let dropJobBeforeCompletion = false;
let createInvoiceImpl = async () => ({ ok: true, invoiceId: 'INV-DEFAULT', pdfUrl: null, ts: new Date().toISOString() });

async function billingKvEval(script, keys, args) {
  const key = keys[0];
  if (script.includes('KESEFLE_PAYPAL_INVOICE_CLAIM_V1')) {
    const record = jobs.get(key);
    if (!record) {
      jobs.set(key, { state: 'processing', startedAtMs: Number(args[0]), updatedAt: args[1] });
      return { status: 'claimed' };
    }
    if (record.state === 'complete') return { status: 'complete' };
    if (record.state === 'reconciliation') return { status: 'reconciliation' };
    if (Number(args[0]) - Number(record.startedAtMs) < Number(args[2])) return { status: 'busy' };
    jobs.set(key, { ...record, state: 'reconciliation', reason: 'invoice_lease_expired', updatedAt: args[1] });
    return { status: 'reconciliation' };
  }
  if (script.includes('KESEFLE_PAYPAL_INVOICE_COMPLETE_V1')) {
    if (dropJobBeforeCompletion) {
      dropJobBeforeCompletion = false;
      jobs.delete(key);
    }
    const record = jobs.get(key);
    if (!record) return { status: 'missing' };
    if (record.state === 'complete') return { status: 'complete' };
    if (record.state !== 'processing') return { status: record.state };
    jobs.set(key, { ...record, state: 'complete', invoiceId: args[0], completedAt: args[1] });
    if (loseCompletionResponse) {
      loseCompletionResponse = false;
      throw new Error('redis_response_lost');
    }
    return { status: 'completed' };
  }
  if (script.includes('KESEFLE_PAYPAL_INVOICE_RECONCILE_V1')) {
    const record = jobs.get(key);
    if (!record) {
      jobs.set(key, { state: 'reconciliation', reason: args[0], updatedAt: args[1] });
      return { status: 'reconciliation' };
    }
    if (record.state === 'complete') return { status: 'complete' };
    jobs.set(key, { ...record, state: 'reconciliation', reason: args[0], updatedAt: args[1] });
    return { status: 'reconciliation' };
  }
  throw new Error('unexpected script');
}
async function billingKvGet(key) {
  if (jobs.has(key)) return jobs.get(key);
  if (key.startsWith('user:') || key.startsWith('profile:')) return null;
  return receipts.get(key) || null;
}
async function billingKvSet(key, value) { receipts.set(key, value); return true; }
async function queueBillingReconciliation(item) { queued.push(item); return { ok: true }; }
async function resolveBillingReconciliation() { return true; }
async function createInvoice(options) { return createInvoiceImpl(options); }

eval(fnSrc(PAYPAL, 'invoiceJobKey')); // eslint-disable-line no-eval
eval(fnSrc(PAYPAL, 'paypalInvoiceReceiptKey')); // eslint-disable-line no-eval
eval(fnSrc(PAYPAL, 'deliverPaypalInvoiceReceipt')); // eslint-disable-line no-eval
const maybeIssueInvoiceForPayment = eval('(' + fnSrc(PAYPAL, 'maybeIssueInvoiceForPayment') + ')'); // eslint-disable-line no-eval

const failures = [];
function check(value, label) {
  if (value) console.log('  PASS ' + label);
  else { failures.push(label); console.error('  FAIL ' + label); }
}
const args = (externalId) => ({
  reqId: 'test', userSub: 'user-1', plan: 'pro', amountILS: 19, externalId,
});

(async () => {
  console.log('\nPayPal invoice exact-once coordinator:');

  let creates = 0;
  createInvoiceImpl = async () => ({
    ok: true, invoiceId: 'INV-' + (++creates), pdfUrl: null, ts: new Date().toISOString(),
  });
  const first = await maybeIssueInvoiceForPayment(args('SALE-REPLAY'));
  const replay = await maybeIssueInvoiceForPayment(args('SALE-REPLAY'));
  check(first.ok && replay.replayed === true, 'completed sale replays from the durable receipt');
  check(creates === 1, 'completed sale creates exactly one invoice');

  let release;
  creates = 0;
  createInvoiceImpl = () => new Promise((resolve) => {
    creates++;
    release = () => resolve({ ok: true, invoiceId: 'INV-CONCURRENT', pdfUrl: null, ts: new Date().toISOString() });
  });
  const inFlight = maybeIssueInvoiceForPayment(args('SALE-CONCURRENT'));
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await maybeIssueInvoiceForPayment(args('SALE-CONCURRENT'));
  check(concurrent.busy === true, 'concurrent delivery sees the live lease and does not POST');
  release();
  await inFlight;
  check(creates === 1, 'concurrent deliveries create exactly one invoice');

  creates = 0;
  createInvoiceImpl = async () => {
    creates++;
    return { ok: false, error: 'network_error', ambiguous: true };
  };
  const ambiguous = await maybeIssueInvoiceForPayment(args('SALE-AMBIGUOUS'));
  const ambiguousReplay = await maybeIssueInvoiceForPayment(args('SALE-AMBIGUOUS'));
  check(ambiguous.queued && ambiguousReplay.queued, 'ambiguous provider outcome is durably reconciled');
  check(creates === 1, 'ambiguous provider outcome is never automatically POSTed again');
  check(queued.some((item) => item.externalId === 'SALE-AMBIGUOUS' && item.kind === 'invoice_ambiguous'),
    'ambiguous sale is visible in the monitored billing queue');

  creates = 0;
  createInvoiceImpl = async () => {
    creates++;
    return { ok: true, invoiceId: 'INV-LOST-RESPONSE', pdfUrl: null, ts: new Date().toISOString() };
  };
  loseCompletionResponse = true;
  const lost = await maybeIssueInvoiceForPayment(args('SALE-LOST-COMMIT-RESPONSE'));
  const lostReplay = await maybeIssueInvoiceForPayment(args('SALE-LOST-COMMIT-RESPONSE'));
  check(lost.ok && lostReplay.replayed, 'lost Redis response is reconciled by reading the committed receipt');
  check(creates === 1, 'lost Redis response never creates a second invoice');
  check(receipts.get('invoice:user-1:SALE-LOST-COMMIT-RESPONSE')?.invoiceId === 'INV-LOST-RESPONSE',
    'invoice retrieval receipt is durable before the job can become complete');
  check(queued.some((item) => item.externalId === 'SALE-LOST-COMMIT-RESPONSE' && item.kind === 'invoice_delivery_pending'),
    'lost response leaves a monitored delivery task instead of stranding the invoice');

  creates = 0;
  createInvoiceImpl = async () => {
    creates++;
    return { ok: true, invoiceId: 'INV-MISSING-LEASE', pdfUrl: null, ts: new Date().toISOString() };
  };
  dropJobBeforeCompletion = true;
  const missingLease = await maybeIssueInvoiceForPayment(args('SALE-MISSING-LEASE'));
  const missingLeaseReplay = await maybeIssueInvoiceForPayment(args('SALE-MISSING-LEASE'));
  check(missingLease.queued && missingLeaseReplay.queued,
    'missing lease after provider success becomes durable reconciliation');
  check(creates === 1, 'missing lease after provider success never permits another document POST');

  console.log('\nInvoice API ambiguity contract:');
  const savedKey = process.env.GREEN_INVOICE_KEY;
  const savedSecret = process.env.GREEN_INVOICE_SECRET;
  const savedEnv = process.env.GREEN_INVOICE_ENV;
  const realFetch = global.fetch;
  process.env.GREEN_INVOICE_KEY = 'test-key';
  process.env.GREEN_INVOICE_SECRET = 'test-secret';
  process.env.GREEN_INVOICE_ENV = 'test';
  let documentPosts = 0;
  global.fetch = async (url) => {
    if (String(url).endsWith('/api/v1/account/token')) {
      return { ok: true, status: 200, json: async () => ({ token: 'TEST-JWT', expires: 1800 }) };
    }
    documentPosts++;
    return { ok: false, status: 503, json: async () => ({}) };
  };
  try {
    const invoice = await import('../lib/invoice.js?exact-once=' + Date.now());
    invoice._resetJwtCache();
    const body = invoice.buildDocumentBody({ amount: 19, description: 'Kesefle', paymentReference: 'SALE-MARKER' });
    check(body.description.includes('[Kesefle:SALE-MARKER]'), 'stable payment reference is embedded for provider search');
    const result = await invoice.createInvoice({ amount: 19, paymentMethod: 'paypal', paymentReference: 'SALE-503' });
    check(result.ambiguous === true && result.error === 'http_503', '5xx create response is classified as ambiguous');
    check(documentPosts === 1, 'ambiguous document POST is never retried in-process');
  } finally {
    global.fetch = realFetch;
    if (savedKey === undefined) delete process.env.GREEN_INVOICE_KEY; else process.env.GREEN_INVOICE_KEY = savedKey;
    if (savedSecret === undefined) delete process.env.GREEN_INVOICE_SECRET; else process.env.GREEN_INVOICE_SECRET = savedSecret;
    if (savedEnv === undefined) delete process.env.GREEN_INVOICE_ENV; else process.env.GREEN_INVOICE_ENV = savedEnv;
  }

  if (failures.length) {
    console.error('\nFAIL: ' + failures.length + ' invoice assertion(s) failed');
    process.exit(1);
  }
  console.log('\nOK: PayPal invoice creation is exact-once and ambiguity-safe');
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
