// lib/reconcile.js
// Pure, deterministic transaction reconciliation engine for Kesefle's
// import-first pipeline. Implements docs/TRANSACTION_RECONCILIATION_MODEL.md:
// blocking -> scoring (0..1) -> decision (auto_link / needs_review / distinct),
// the card-settlement transfer rule, FX normalization, and exact-dup
// idempotency. NO I/O, NO KV, NO logging of raw descriptions/amounts — callers
// pass already-normalized rows + an injectable categoryOf() so the whole module
// is unit-testable offline (like the SRC buildLedger ledger core).
//
// A normalized row:
//   { uid, dateISO:'YYYY-MM-DD', amount:Number(>0 magnitude), currency:'ILS',
//     direction:'expense'|'income'|'transfer', descNorm:String,
//     category:String|null, source:'manual'|'import', descRaw?:String }
//
// CommonJS so `node tests/*.js` can require it and Vercel/esbuild can import it.

'use strict';

// Card-issuer / settlement descriptors (special rule 3.1). A bank debit matching
// one of these AND ~= the card cycle sum is a TRANSFER, never an expense.
var CARD_SETTLEMENT_RE = /(ישראכרט|מקס\b|מקס איט|כ\.?א\.?ל|כאל\b|לאומי קארד|אמריקן אקספרס|אמקס|amex|american express|visa|ויזה|mastercard|מאסטרקארד|חיוב כרטיס|כרטיס אשראי|חברת אשראי|העברה לכרטיס)/i;

function _num(n) { var x = Number(n); return isFinite(x) ? x : NaN; }

// Normalize a description for hashing/compare: lowercase, collapse whitespace,
// strip punctuation + the Hebrew geresh/gershayim. Pure string -> string.
function normDesc(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/["'`׳״.,\-()/\\|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Deterministic fingerprint of a row for exact-dup idempotency. Same import row
// re-uploaded -> same fp -> skipped. (Not a crypto hash here; callers may wrap
// with sha256 before persisting — this is the pure identity key.)
function fingerprint(row) {
  return [row.source || '', row.direction || 'expense', row.dateISO || '',
    Math.round(_num(row.amount) * 100), normDesc(row.descNorm || row.descRaw || '')].join('|');
}

// FX -> ILS. rateFor(currency, dateISO) -> Number (rate AS OF the txn date).
// Defaults to identity for ILS / when no rate function supplied.
function toILS(amount, currency, dateISO, rateFor) {
  var a = _num(amount);
  if (!isFinite(a)) return NaN;
  var cur = String(currency || 'ILS').toUpperCase();
  if (cur === 'ILS' || cur === 'NIS' || cur === '₪') return a;
  var r = typeof rateFor === 'function' ? _num(rateFor(cur, dateISO)) : NaN;
  return isFinite(r) && r > 0 ? a * r : NaN;
}

// Whole calendar days between two YYYY-MM-DD strings (absolute).
function dayDelta(d1, d2) {
  var a = Date.parse(d1 + 'T00:00:00Z'), b = Date.parse(d2 + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return Infinity;
  return Math.round(Math.abs(a - b) / 86400000);
}

// Amount blocking tolerance: |a-b| <= max(1 ILS, pct * max(a,b)); pct=3% when FX
// was applied (settlement drift), else 2%.
function amountWithinBlock(a, b, isFx) {
  var pct = isFx ? 0.03 : 0.02;
  return Math.abs(a - b) <= Math.max(1, pct * Math.max(a, b));
}

// ---- scoring components (docs section 2.2) ----
function amountComponent(manualAmt, importAmt, manualIsInteger) {
  if (manualAmt === importAmt) return 0.45;            // exact
  var within = Math.abs(manualAmt - importAmt) <= Math.max(1, 0.02 * Math.max(manualAmt, importAmt));
  if (within && manualIsInteger) return 0.40;          // rounded manual
  if (within) return 0.32;                              // close, non-integer
  return 0;                                             // (blocked upstream)
}
function dateComponent(delta) {
  if (delta === 0) return 0.25;
  if (delta === 1) return 0.20;
  if (delta === 2) return 0.14;
  if (delta === 3) return 0.08;
  if (delta === 4) return 0.03;
  return 0;
}
// merchant/category compatibility: manualCategory vs the import's mapped category.
// importCategory === null  => unknown merchant (neutral 0.10).
function merchantComponent(manualCategory, importCategory, sameGroup) {
  if (importCategory == null) return 0.10;             // unknown -> neutral
  if (manualCategory && importCategory === manualCategory) return 0.20; // same category
  if (sameGroup) return 0.12;                          // same top-level group
  return 0;                                            // contradictory
}
function uniquenessComponent(candidateCount) {
  if (candidateCount <= 1) return 0.10;
  if (candidateCount === 2) return 0.05;
  return 0;
}

// Score a single (manual, import) pair. opts: { candidateCount, isFx, sameGroup }.
function scorePair(manual, imp, opts) {
  opts = opts || {};
  var manualAmt = _num(manual.amount), importAmt = _num(imp.amount);
  var manualIsInteger = Number.isInteger(manualAmt);
  var amount = amountComponent(manualAmt, importAmt, manualIsInteger);
  var date = dateComponent(dayDelta(manual.dateISO, imp.dateISO));
  var merchant = merchantComponent(manual.category, imp.category, !!opts.sameGroup);
  var uniqueness = uniquenessComponent(opts.candidateCount || 1);
  var score = amount + date + merchant + uniqueness;
  return {
    score: Math.round(score * 100) / 100,
    components: { amount: amount, date: date, merchant: merchant, uniqueness: uniqueness },
  };
}

function decide(score) {
  if (score >= 0.90) return 'auto_link';
  if (score >= 0.60) return 'needs_review';
  return 'distinct';
}

// Special rule 3.1: is this import row a card-bill settlement (a transfer)?
// cycleSum = sum of that card's individual transactions in the cycle (caller
// supplies it; null => can't confirm, treat as normal expense).
function isCardSettlement(importRow, cycleSum) {
  if (!CARD_SETTLEMENT_RE.test(String(importRow.descRaw || importRow.descNorm || ''))) return false;
  if (cycleSum == null) return false;
  var a = _num(importRow.amount), s = _num(cycleSum);
  if (!isFinite(a) || !isFinite(s) || s <= 0) return false;
  return Math.abs(a - s) <= Math.max(2, 0.02 * Math.max(a, s)); // ~= cycle sum
}

// Blocking: candidates from the manual index for one import row.
// manualIndex: array of normalized manual rows for the user (already same tenant).
function blockingCandidates(importRow, manualIndex, isFx) {
  var ia = _num(importRow.amount);
  return (manualIndex || []).filter(function (m) {
    if (m.source !== 'manual') return false;             // source asymmetry
    if ((m.direction || 'expense') !== (importRow.direction || 'expense')) return false; // never cross direction
    if (m.linked) return false;                          // already consumed
    if (dayDelta(m.dateISO, importRow.dateISO) > 4) return false; // ±4d window
    return amountWithinBlock(_num(m.amount), ia, isFx);  // amount block
  });
}

/**
 * reconcile(importRows, manualIndex, opts) -> { results, audit }
 * Pure: decides what to do with each incoming import row against existing manual
 * rows. Writes NOTHING. The caller (api/sheet/csv-import) performs the actual
 * sheet/KV writes for the returned decisions.
 *
 * opts: {
 *   seenFingerprints?: Set<string>,          // for exact-dup idempotency
 *   categoryOf?: (descNorm)=>category|null,  // inject the real classifier; default null
 *   sameGroupOf?: (catA,catB)=>bool,         // optional top-level-group check
 *   rateFor?: (currency,dateISO)=>number,    // FX
 *   cycleSumFor?: (importRow)=>number|null,  // card-settlement sum
 * }
 *
 * result item: { row, decision, match?, score?, reason }
 *   decision ∈ 'duplicate'|'transfer'|'auto_link'|'needs_review'|'distinct'
 */
function reconcile(importRows, manualIndex, opts) {
  opts = opts || {};
  var seen = opts.seenFingerprints || new Set();
  var categoryOf = opts.categoryOf || function () { return null; };
  var sameGroupOf = opts.sameGroupOf || function () { return false; };
  var results = [];
  var audit = [];
  var idx = (manualIndex || []).map(function (m) {
    return Object.assign({}, m, { category: m.category != null ? m.category : categoryOf(m.descNorm) });
  });

  for (var i = 0; i < (importRows || []).length; i++) {
    var raw = importRows[i];
    // FX normalize the import amount to ILS for comparison.
    var isFx = raw.currency && String(raw.currency).toUpperCase() !== 'ILS' && String(raw.currency).toUpperCase() !== 'NIS';
    var amountILS = isFx ? toILS(raw.amount, raw.currency, raw.dateISO, opts.rateFor) : _num(raw.amount);
    var row = Object.assign({}, raw, {
      amount: isFinite(amountILS) ? amountILS : _num(raw.amount),
      currency: 'ILS',
      origCurrency: raw.currency,
      origAmount: raw.amount,
      category: raw.category != null ? raw.category : categoryOf(raw.descNorm),
    });

    // (a) exact-dup idempotency
    var fp = fingerprint(row);
    if (seen.has(fp)) { results.push({ row: row, decision: 'duplicate', reason: 'fingerprint_seen' }); continue; }
    seen.add(fp);

    // (b) card-settlement transfer (special rule 3.1)
    if (isCardSettlement(row, opts.cycleSumFor ? opts.cycleSumFor(row) : null)) {
      row.direction = 'transfer';
      results.push({ row: row, decision: 'transfer', reason: 'card_settlement' });
      audit.push({ type: 'transfer', uid: row.uid, reason: 'card_settlement' });
      continue;
    }

    // (c) blocking + scoring
    var cands = blockingCandidates(row, idx, isFx);
    if (cands.length === 0) { results.push({ row: row, decision: 'distinct', reason: 'no_candidate' }); continue; }
    var scored = cands.map(function (m) {
      return { m: m, s: scorePair(m, row, { candidateCount: cands.length, isFx: isFx, sameGroup: sameGroupOf(m.category, row.category) }) };
    }).sort(function (a, b) { return b.s.score - a.s.score; });

    var best = scored[0];
    var decision = decide(best.s.score);

    // Tie rule: two candidates both >= 0.90 -> never auto-pick, demote to review.
    if (decision === 'auto_link' && scored.length > 1 && scored[1].s.score >= 0.90) {
      decision = 'needs_review';
    }
    if (decision === 'auto_link') best.m.linked = true; // consume the manual row
    results.push({ row: row, decision: decision, match: best.m.uid, score: best.s.score, components: best.s.components, reason: 'scored' });
    audit.push({ type: decision, uid: row.uid, match: best.m.uid, score: best.s.score });
  }
  return { results: results, audit: audit };
}

module.exports = {
  normDesc: normDesc,
  fingerprint: fingerprint,
  toILS: toILS,
  dayDelta: dayDelta,
  amountWithinBlock: amountWithinBlock,
  scorePair: scorePair,
  decide: decide,
  isCardSettlement: isCardSettlement,
  blockingCandidates: blockingCandidates,
  reconcile: reconcile,
  CARD_SETTLEMENT_RE: CARD_SETTLEMENT_RE,
};
