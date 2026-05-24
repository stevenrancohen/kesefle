/**
 * tests/test_bank_parsers.js
 *
 *   node tests/test_bank_parsers.js
 *
 * Hand-crafted Israeli bank statement fixtures (Hapoalim, Leumi, Discount,
 * Mizrahi-Tefahot). The exact column layouts of Israeli bank exports vary
 * between formats and over time; the fixtures here are realistic SAMPLES
 * based on the published header names and common signed-amount /
 * debit-credit conventions. The parser is header-DRIVEN, so the same parser
 * works as long as the headers are in the known alias list (DATE_ALIASES,
 * AMOUNT_ALIASES, DEBIT_ALIASES, etc.).
 *
 * When Steven has a real export, paste it in as another fixture below.
 */

import {
  parseHapoalimCsv, parseLeumiCsv, parseDiscountCsv, parseMizrahiCsv,
  BANK_PARSERS, __test,
} from '../lib/bank-parsers.js';

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; fails.push(label); console.log('  FAIL  ' + label); }
}

console.log('\n== 1. Date parser ==');
ok('DD/MM/YYYY -> ISO',     __test.parseDate('14/03/2026') === '2026-03-14');
ok('DD.MM.YYYY -> ISO',     __test.parseDate('14.03.2026') === '2026-03-14');
ok('DD-MM-YYYY -> ISO',     __test.parseDate('14-03-2026') === '2026-03-14');
ok('YYYY-MM-DD passthrough',__test.parseDate('2026-03-14') === '2026-03-14');
ok('2-digit year (<70) -> 20YY', __test.parseDate('01/01/24') === '2024-01-01');
ok('2-digit year (>=70) -> 19YY', __test.parseDate('01/01/95') === '1995-01-01');
ok('invalid month rejected', __test.parseDate('01/13/2026') === null);
ok('invalid day rejected',   __test.parseDate('31/02/2026') === null);
ok('garbage rejected',       __test.parseDate('hello') === null);

console.log('\n== 2. Amount parser ==');
ok('1234.56 -> 1234.56',          __test.parseAmount('1234.56') === 1234.56);
ok('1,234.56 -> 1234.56',         __test.parseAmount('1,234.56') === 1234.56);
ok('1234,56 (Israeli comma decimal) -> 1234.56', __test.parseAmount('1234,56') === 1234.56);
ok('"-50.00" -> -50',             __test.parseAmount('-50.00') === -50);
ok('"(50.00)" -> -50 (paren neg)', __test.parseAmount('(50.00)') === -50);
ok('whitespace + currency stripped', __test.parseAmount('  ₪ 99.90 ') === 99.90);
ok('empty -> NaN',                Number.isNaN(__test.parseAmount('')));

console.log('\n== 3. CSV line splitter ==');
ok('simple',          JSON.stringify(__test.splitCsvLine('a,b,c', ',')) === '["a","b","c"]');
ok('quoted comma',    JSON.stringify(__test.splitCsvLine('a,"b,c",d', ',')) === '["a","b,c","d"]');
ok('escaped quotes',  JSON.stringify(__test.splitCsvLine('a,"b""x",c', ',')) === '["a","b\\"x","c"]');
ok('trailing empty',  JSON.stringify(__test.splitCsvLine('a,b,', ',')) === '["a","b",""]');

console.log('\n== 4. Hapoalim sample (5 rows, BOM, DD/MM/YYYY, comma decimal) ==');
// Realistic Hapoalim export: a couple of header rows above the table (account
// number, balance), then the column header, then transactions. Columns:
// תאריך | תאריך ערך | תיאור | אסמכתא | בחובה | בזכות | יתרה
const HAPOALIM_CSV = '﻿' + [
  'חשבון: 12345-678,,,,,,',
  'תקופה: 01/03/2026-31/03/2026,,,,,,',
  '',
  'תאריך,תאריך ערך,תיאור,אסמכתא,בחובה,בזכות,יתרה',
  '01/03/2026,01/03/2026,משכורת חברה אבג,9001,,12500,12500',
  '03/03/2026,03/03/2026,שופרסל אונליין,9002,"245,90",,12254.10',
  '05/03/2026,05/03/2026,חשמל חברת חשמל,9003,"189,00",,12065.10',
  '07/03/2026,07/03/2026,העברה מההורים,9004,,500,12565.10',
  '15/03/2026,15/03/2026,דלק פז סניף הרצליה,9005,"320,00",,12245.10',
  'יתרה לתקופה,,,,,,12245.10',
].join('\n');

const hapResult = parseHapoalimCsv(HAPOALIM_CSV);
ok('Hapoalim: parsed 5 rows',            hapResult.rows.length === 5);
ok('Hapoalim: 0 unexpected skips',       hapResult.skipped.length === 0);
ok('Hapoalim: row 1 = income (salary)',  hapResult.rows[0].isIncome === true && hapResult.rows[0].amount === 12500);
ok('Hapoalim: row 2 = expense (super)',  hapResult.rows[1].isIncome === false && hapResult.rows[1].amount === 245.90);
ok('Hapoalim: row 4 = income (transfer)', hapResult.rows[3].isIncome === true && hapResult.rows[3].amount === 500);
ok('Hapoalim: dates ISO',                hapResult.rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date)));
ok('Hapoalim: descriptions captured',    hapResult.rows[1].description.includes('שופרסל'));
ok('Hapoalim: no bidi marks in desc',    !/[‎‏‪-‮]/.test(hapResult.rows.map(r => r.description).join('|')));
ok('Hapoalim: rawRow present',           hapResult.rows.every(r => r.rawRow && r.rawRow.length > 0));

console.log('\n== 5. Leumi sample (5 rows, single signed amount, DD.MM.YYYY) ==');
// Leumi's CSV export. Columns: תאריך | תאריך ערך | תיאור | אסמכתא | סכום | יתרה
// Signed amount column: negative = expense, positive = income.
const LEUMI_CSV = [
  'תאריך,תאריך ערך,תיאור,אסמכתא,סכום,יתרה',
  '01.04.2026,01.04.2026,העברה ממשכורת,L001,15000.00,15000.00',
  '02.04.2026,02.04.2026,רמי לוי הרצליה,L002,-432.50,14567.50',
  '03.04.2026,03.04.2026,חניון חוצות המפרץ,L003,-25.00,14542.50',
  '04.04.2026,04.04.2026,החזר ביטוח לאומי,L004,180.00,14722.50',
  '10.04.2026,10.04.2026,ועד בית אפריל,L005,-220.00,14502.50',
].join('\n');

const leuResult = parseLeumiCsv(LEUMI_CSV);
ok('Leumi: parsed 5 rows',           leuResult.rows.length === 5);
ok('Leumi: 0 unexpected skips',      leuResult.skipped.length === 0);
ok('Leumi: row 1 = income (salary)', leuResult.rows[0].isIncome === true && leuResult.rows[0].amount === 15000);
ok('Leumi: row 2 = expense (super)', leuResult.rows[1].isIncome === false && leuResult.rows[1].amount === 432.50);
ok('Leumi: row 4 = income (refund)', leuResult.rows[3].isIncome === true && leuResult.rows[3].amount === 180);
ok('Leumi: dates ISO',               leuResult.rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date)));
ok('Leumi: descriptions captured',   leuResult.rows[1].description.includes('רמי לוי'));

console.log('\n== 5b. Discount sample (5 rows, "סכום חיוב"/"סכום זיכוי", DD/MM/YYYY) ==');
// Realistic Discount export. Columns:
// תאריך | תאריך ערך | תיאור הפעולה | אסמכתא | סכום חיוב | סכום זיכוי | יתרה
// Note: includes leading RTL mark + bidi marks around amounts (real exports
// from Discount's web portal sprinkle these). The parser strips them.
const DISCOUNT_CSV = [
  'תאריך,תאריך ערך,תיאור הפעולה,אסמכתא,סכום חיוב,סכום זיכוי,יתרה',
  '02/04/2026,02/04/2026,העברה בנקאית נכנסת,D101,,8200.00,8200.00',
  '04/04/2026,04/04/2026,‏סופר רמי לוי הוד השרון‏,D102,312.40,,7887.60',
  '06/04/2026,06/04/2026,חברת חשמל הוראת קבע,D103,540.00,,7347.60',
  '11/04/2026,11/04/2026,החזר ביטוח לאומי,D104,,180.00,7527.60',
  '20/04/2026,20/04/2026,חניון אזריאלי,D105,42.00,,7485.60',
  'יתרת סגירה,,,,,,7485.60',
].join('\n');

const discResult = parseDiscountCsv(DISCOUNT_CSV);
ok('Discount: parsed 5 rows',             discResult.rows.length === 5);
ok('Discount: 0 unexpected skips',        discResult.skipped.length === 0);
ok('Discount: row 1 = income (transfer)', discResult.rows[0].isIncome === true && discResult.rows[0].amount === 8200);
ok('Discount: row 2 = expense (super)',   discResult.rows[1].isIncome === false && discResult.rows[1].amount === 312.40);
ok('Discount: row 4 = income (refund)',   discResult.rows[3].isIncome === true && discResult.rows[3].amount === 180);
ok('Discount: dates ISO',                 discResult.rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date)));
ok('Discount: descriptions captured',     discResult.rows[1].description.includes('רמי לוי'));
ok('Discount: no bidi marks in desc',     !/[‎‏‪-‮]/.test(discResult.rows.map(r => r.description).join('|')));

console.log('\n== 5c. Mizrahi sample (5 rows, BOM, summary row, "סכום חובה"/"סכום זכות") ==');
// Realistic Mizrahi-Tefahot export. Columns:
// תאריך הפעולה | תאריך ערך | אסמכתא/מספר | תיאור הפעולה | סכום חובה | סכום זכות | יתרת חשבון
// Starts with UTF-8 BOM and ends with a summary row -- both common in
// Mizrahi's web export. Q-COMPANY is an intentionally generic merchant name.
const MIZRAHI_CSV = '﻿' + [
  'תאריך הפעולה,תאריך ערך,אסמכתא/מספר,תיאור הפעולה,סכום חובה,סכום זכות,יתרת חשבון',
  '03/05/2026,03/05/2026,M2001,העברה ממעסיק Q-COMPANY,,14250.00,14250.00',
  '05/05/2026,05/05/2026,M2002,יוחננוף הרצליה,387.20,,13862.80',
  '07/05/2026,07/05/2026,M2003,פז דלק סניף 412,290.00,,13572.80',
  '12/05/2026,12/05/2026,M2004,ביטוח לאומי החזר,,225.00,13797.80',
  '18/05/2026,18/05/2026,M2005,ועד בית מאי,180.00,,13617.80',
  'סך הכל,,,,1077.20,14475.00,13617.80',
].join('\n');

const mizResult = parseMizrahiCsv(MIZRAHI_CSV);
ok('Mizrahi: parsed 5 rows',            mizResult.rows.length === 5);
ok('Mizrahi: 0 unexpected skips',       mizResult.skipped.length === 0);
ok('Mizrahi: row 1 = income (salary)',  mizResult.rows[0].isIncome === true && mizResult.rows[0].amount === 14250);
ok('Mizrahi: row 2 = expense (super)',  mizResult.rows[1].isIncome === false && mizResult.rows[1].amount === 387.20);
ok('Mizrahi: row 4 = income (refund)',  mizResult.rows[3].isIncome === true && mizResult.rows[3].amount === 225);
ok('Mizrahi: dates ISO',                mizResult.rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date)));
ok('Mizrahi: descriptions captured',    mizResult.rows[1].description.includes('יוחננוף'));
ok('Mizrahi: BOM stripped',             mizResult.rows[0].description.charCodeAt(0) !== 0xFEFF);
ok('Mizrahi: summary row silently ignored', mizResult.skipped.length === 0);

console.log('\n== 5d. Cross-bank robustness (garbage in -> header_not_found) ==');
// Feed obvious garbage to each new parser -- they MUST return header_not_found
// in the skipped[] array instead of throwing or returning random rows. This
// is the same contract the Hapoalim/Leumi parsers already honor.
ok('Discount: garbage input -> header_not_found',
   parseDiscountCsv('hello world\nfoo bar\nbaz qux').skipped.some(s => s.reason === 'header_not_found'));
ok('Mizrahi: garbage input -> header_not_found',
   parseMizrahiCsv('hello world\nfoo bar\nbaz qux').skipped.some(s => s.reason === 'header_not_found'));
ok('Discount: empty input -> no rows, no throw', parseDiscountCsv('').rows.length === 0);
ok('Mizrahi: empty input -> no rows, no throw',  parseMizrahiCsv('').rows.length === 0);

console.log('\n== 6. Encoding fallback (windows-1255 buffer) ==');
// Build a tiny windows-1255 encoded buffer of one header + one row, then
// confirm decodeIfBuffer can read it. (Hebrew "א" = 0xE0 in 1255.)
// We can't easily encode arbitrary Hebrew without a 1255 encoder, so we
// only assert that the decoder picks utf-8 over 1255 when input is clean
// utf-8, and that the BOM path works.
const utf8Buf = Buffer.from('﻿תאריך,תיאור\n01/01/2026,test\n', 'utf-8');
const decoded = __test.decodeIfBuffer(utf8Buf);
ok('UTF-8 BOM decoded',              decoded.includes('תאריך') && decoded.includes('test'));
const utf8NoBom = Buffer.from('תאריך,תיאור\n01/01/2026,test\n', 'utf-8');
ok('UTF-8 no BOM decoded',           __test.decodeIfBuffer(utf8NoBom).includes('תאריך'));

console.log('\n== 7. BANK_PARSERS registry ==');
ok('BANK_PARSERS.hapoalim is parseHapoalimCsv', BANK_PARSERS.hapoalim === parseHapoalimCsv);
ok('BANK_PARSERS.leumi is parseLeumiCsv',       BANK_PARSERS.leumi === parseLeumiCsv);
ok('BANK_PARSERS.discount is parseDiscountCsv', BANK_PARSERS.discount === parseDiscountCsv);
ok('BANK_PARSERS.mizrahi is parseMizrahiCsv',   BANK_PARSERS.mizrahi === parseMizrahiCsv);

console.log('\n== 8. Robustness ==');
ok('empty input -> empty rows, no throw', parseHapoalimCsv('').rows.length === 0);
ok('garbage input -> header_not_found', parseHapoalimCsv('hello world\nfoo bar').skipped.some(s => s.reason === 'header_not_found'));
// Summary rows like "יתרה לתקופה" must be silently skipped (count as skipped=0).
ok('Hapoalim summary row silently ignored', hapResult.skipped.length === 0);
// Sanity: parser must not log description or amount. Detect by string-search
// over the captured stdout would require spawning; we trust the audit here.
ok('rawRow capped at 500 chars', hapResult.rows.every(r => r.rawRow.length <= 500));

console.log('\n' + (fail === 0
  ? '== OK: ALL ' + pass + ' BANK-PARSER CHECKS PASSED =='
  : '== FAIL: ' + fail + ' (' + fails.join('; ') + '), ' + pass + ' passed =='));

process.exit(fail === 0 ? 0 : 1);
