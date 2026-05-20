#!/usr/bin/env node
// Integration-style unit tests for the bot's pure parsing/classification
// logic — the parts that don't need the Apps Script runtime or live
// Sheets. Run with: node scripts/test_bot_logic.js
//
// These mirror the implementations in bot/ExpenseBot_FIXED.gs. Keeping
// them here gives a fast regression net for the parsers without booting
// Apps Script. When you change a parser in the .gs, mirror it here.

let failed = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name + ' — got ' + g + ' want ' + w); failed++; }
}
function ok(name, cond) {
  if (cond) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name); failed++; }
}

// ---- Israeli number parser ----
function _parseIsraeliNumber_(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (!s) return NaN;
  if (s.indexOf('.') >= 0) return parseFloat(s.replace(/,/g, ''));
  const commaIdx = s.indexOf(',');
  if (commaIdx < 0) return parseFloat(s);
  const groups = s.split(',');
  const allThree = groups.slice(1).every((g) => /^\d{3}$/.test(g));
  if (allThree) return parseFloat(s.replace(/,/g, ''));
  return parseFloat(s.replace(',', '.'));
}

console.log('Israeli number parser:');
eq('1,200 → 1200', _parseIsraeliNumber_('1,200'), 1200);
eq('12,5 → 12.5', _parseIsraeliNumber_('12,5'), 12.5);
eq('1,234,567 → 1234567', _parseIsraeliNumber_('1,234,567'), 1234567);
eq('12.50 → 12.5', _parseIsraeliNumber_('12.50'), 12.5);
eq('99 → 99', _parseIsraeliNumber_('99'), 99);

// ---- leading-date parser (the 3.5 לחם fix) ----
function _extractLeadingDate_(text) {
  if (!text) return null;
  let s = String(text).trim();
  function withTime(d) { const n = new Date(); d.setHours(n.getHours(), n.getMinutes(), n.getSeconds(), 0); return d; }
  const wordRe = /^(אתמול|שלשום|מחר|yesterday|tomorrow)(?=\s|$)\s*/i;
  const wm = s.match(wordRe);
  if (wm) {
    let off = 0; const w = wm[1].toLowerCase();
    if (w === 'אתמול' || w === 'yesterday') off = -1;
    else if (w === 'שלשום') off = -2;
    else if (w === 'מחר' || w === 'tomorrow') off = 1;
    const d = new Date(); d.setDate(d.getDate() + off);
    return { date: withTime(d), remaining: s.slice(wm[0].length).trim() };
  }
  const numRe = /^(\d{1,2})([\/.])(\d{1,2})(?:[\/.](\d{2,4}))?(?=\s|$)/;
  const nm = s.match(numRe);
  if (nm) {
    const day = parseInt(nm[1], 10), sep = nm[2], mon = parseInt(nm[3], 10), yearGroup = nm[4];
    if (day < 1 || day > 31 || mon < 1 || mon > 12) return null;
    if (sep === '.' && !yearGroup) {
      const after = s.slice(nm[0].length).trim();
      if (!/^\d/.test(after)) return null;
    }
    const now = new Date();
    let year = yearGroup ? (parseInt(yearGroup, 10) < 100 ? 2000 + parseInt(yearGroup, 10) : parseInt(yearGroup, 10)) : now.getFullYear();
    const dt = new Date(year, mon - 1, day);
    if (dt.getMonth() !== mon - 1 || dt.getDate() !== day) return null;
    return { date: withTime(dt), remaining: s.slice(nm[0].length).trim() };
  }
  return null;
}

console.log('\nLeading-date parser:');
ok('"3.5 לחם" is NOT a date (decimal amount)', _extractLeadingDate_('3.5 לחם') === null);
ok('"12.5 קפה" is NOT a date', _extractLeadingDate_('12.5 קפה') === null);
ok('"אתמול 60 מכולת" IS a date', _extractLeadingDate_('אתמול 60 מכולת') !== null);
ok('"12/4 80 דלק" IS a date', _extractLeadingDate_('12/4 80 דלק') !== null);
ok('"3.5.26 80 לחם" IS a date (has year)', _extractLeadingDate_('3.5.26 80 לחם') !== null);
ok('"245 סופר" is NOT a date', _extractLeadingDate_('245 סופר') === null);

// ---- spam detector ----
const _SPAM_URL_RE_ = /(https?:\/\/|www\.)[^\s]+/i;
const _SPAM_ALLOWED_HOSTS_ = /\b(kesefle\.com|wa\.me|whatsapp\.com|paybox|tranzila|cardcom|payme|isracard|max\.co\.il|cal-online)\b/i;
const _SPAM_INJECT_RE_ = /(<script|javascript:|onerror=|onload=|=\s*importxml|=\s*importdata|\beval\()/i;
function _looksSpammy_(text) {
  if (!text) return false;
  const t = String(text);
  if (_SPAM_INJECT_RE_.test(t)) return true;
  if (_SPAM_URL_RE_.test(t) && !_SPAM_ALLOWED_HOSTS_.test(t)) return true;
  return false;
}

console.log('\nSpam detector:');
ok('plain expense not spam', !_looksSpammy_('245 סופר רמי לוי'));
ok('bit.ly link is spam', _looksSpammy_('check this http://bit.ly/scam'));
ok('kesefle.com link allowed', !_looksSpammy_('see https://kesefle.com/account'));
ok('script injection blocked', _looksSpammy_('<script>alert(1)</script>'));
ok('formula injection blocked', _looksSpammy_('=IMPORTXML(evil)'));

// ---- group settlement (mirror of api/group.js) ----
function computeSettlements(balances) {
  const debtors = [], creditors = [];
  for (const [p, n] of Object.entries(balances)) {
    if (n < -0.005) debtors.push({ p, a: -n }); else if (n > 0.005) creditors.push({ p, a: n });
  }
  debtors.sort((x, y) => y.a - x.a); creditors.sort((x, y) => y.a - x.a);
  const t = []; let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].a, creditors[j].a);
    t.push({ from: debtors[i].p, to: creditors[j].p, amount: Math.round(pay * 100) / 100 });
    debtors[i].a -= pay; creditors[j].a -= pay;
    if (debtors[i].a < 0.005) i++; if (creditors[j].a < 0.005) j++;
  }
  return t;
}

console.log('\nGroup settlement:');
const settle = computeSettlements({ A: 200, B: -100, C: -100 });
eq('A paid 300/3 → 2 transfers to A', settle.length, 2);
ok('both transfers target A', settle.every((x) => x.to === 'A'));

console.log(failed === 0 ? '\nALL TESTS PASSED ✅' : '\n' + failed + ' FAILED ❌');
process.exit(failed === 0 ? 0 : 1);
