// lib/normalize-transaction.js
// Pure normalizer: maps a RAW import/bank/card/manual row into the canonical
// transaction shape the reconciliation engine (lib/reconcile.js) and the sheet
// writer consume. One function, no I/O, fully unit-testable. See
// docs/FINANCIAL_INTEGRATION_ARCHITECTURE.md (universal transaction schema).
//
// Input (any subset; sensible defaults):
//   { date, amount, description, currency, isIncome, source, provider,
//     externalId, cardLast4, accountLast4 }
//   - date: 'YYYY-MM-DD' | 'DD/MM/YYYY' | Date | ms
//   - amount: number (sign optional) | string
//   - isIncome: bool (preferred) OR a negative amount => expense convention
//
// Output (the shape reconcile.js + the dashboard expect):
//   { uid, source, provider, externalId, direction, dateISO, month, year,
//     amount(+magnitude), currency, descRaw, descNorm, cardLast4,
//     accountLast4, fingerprint }

'use strict';
const { normDesc, fingerprint } = require('./reconcile.js');

function _num(v) {
  if (typeof v === 'number') return v;
  // Keep only digits, separators, sign. Then disambiguate US ("1,234.50") vs
  // EU ("1.234,50"): when both separators appear, the LAST one is the decimal
  // point and the other is the thousands grouping. With only a comma, a 3-digit
  // tail is thousands ("1,234"), otherwise it is a decimal comma ("12,5").
  var s = String(v == null ? '' : v).replace(/[^0-9.,\-]/g, '');
  var lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = (s.length - lastComma - 1) === 3 && s.indexOf(',') === lastComma ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  var n = parseFloat(s);
  return isFinite(n) ? n : NaN;
}

// Coerce a date to 'YYYY-MM-DD' (Asia/Jerusalem-agnostic — date-only). Accepts
// ISO, DD/MM/YYYY, DD.MM.YYYY, Date, or ms epoch. Returns '' if unparseable.
function toISODate(d) {
  if (d == null || d === '') return '';
  if (d instanceof Date) return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  if (typeof d === 'number') { var dt = new Date(d); return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10); }
  var s = String(d).trim();
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  var dmy = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/);
  if (dmy) {
    var day = dmy[1].padStart(2, '0'), mon = dmy[2].padStart(2, '0'), yr = dmy[3];
    if (yr.length === 2) yr = (Number(yr) > 70 ? '19' : '20') + yr;
    var dd = Number(day), mm = Number(mon);
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) return yr + '-' + mon + '-' + day;
  }
  var parsed = Date.parse(s);
  return isNaN(parsed) ? '' : new Date(parsed).toISOString().slice(0, 10);
}

// Short opaque uid — deterministic when an externalId exists (so the same
// provider row always maps to the same uid), else derived from the content.
function makeUid(parts) {
  var basis = parts.filter(Boolean).join('|');
  var h = 0;
  for (var i = 0; i < basis.length; i++) { h = (h * 31 + basis.charCodeAt(i)) >>> 0; }
  return 'kfl_' + h.toString(36).padStart(7, '0').slice(0, 10);
}

function last4(v) {
  var s = String(v == null ? '' : v).replace(/\D/g, '');
  return s ? s.slice(-4) : '';
}

/**
 * normalizeImportRow(raw, opts) -> normalized row | null (null = unusable: no
 * amount or no date). opts.source/opts.provider default the row's source.
 */
function normalizeImportRow(raw, opts) {
  raw = raw || {};
  opts = opts || {};
  var dateISO = toISODate(raw.date);
  var amtSigned = _num(raw.amount);
  if (!dateISO || !isFinite(amtSigned) || amtSigned === 0) return null;

  // direction: explicit isIncome wins; else a negative amount = expense,
  // positive = income is NOT assumed (banks vary) — default expense unless told.
  var direction;
  if (raw.direction) direction = raw.direction;
  else if (typeof raw.isIncome === 'boolean') direction = raw.isIncome ? 'income' : 'expense';
  else direction = amtSigned < 0 ? 'expense' : 'expense'; // default expense; income must be explicit

  var amount = Math.abs(amtSigned);
  var descRaw = String(raw.description == null ? '' : raw.description).trim();
  var source = raw.source || opts.source || 'import';
  var currency = String(raw.currency || 'ILS').toUpperCase();
  if (currency === 'NIS' || currency === '₪') currency = 'ILS';

  var row = {
    uid: raw.uid || makeUid([source, raw.provider || opts.provider, raw.externalId, dateISO, String(Math.round(amount * 100)), normDesc(descRaw)]),
    source: source,
    provider: raw.provider || opts.provider || (source === 'manual' ? 'whatsapp' : 'csv'),
    externalId: raw.externalId ? String(raw.externalId) : '',
    direction: direction,
    dateISO: dateISO,
    month: dateISO.slice(0, 7),
    year: dateISO.slice(0, 4),
    amount: amount,
    currency: currency,
    descRaw: descRaw,
    descNorm: normDesc(descRaw),
    cardLast4: last4(raw.cardLast4),
    accountLast4: last4(raw.accountLast4),
    category: raw.category != null ? raw.category : null,
  };
  row.fingerprint = fingerprint(row);
  return row;
}

// Normalize a batch; drop unusable rows.
function normalizeBatch(rawRows, opts) {
  return (rawRows || []).map(function (r) { return normalizeImportRow(r, opts); }).filter(Boolean);
}

module.exports = {
  normalizeImportRow: normalizeImportRow,
  normalizeBatch: normalizeBatch,
  toISODate: toISODate,
  makeUid: makeUid,
  last4: last4,
};
