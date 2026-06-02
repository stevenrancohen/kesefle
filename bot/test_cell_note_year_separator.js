// Regression test for the dashboard cell-note year-separator feature.
//
// Steven asked (2026-05-29) for:
//   1. Full date including year in every cell-note line (dd/MM/yyyy HH:mm)
//   2. "=== YYYY ===" header line separating entries from different years
//
// We test two layers:
//   (A) The pure string helper _composeNoteWithYearSeparator_  → 6 cases
//   (B) The wrapper _dashboardDetailNote_ that prepends the date+year+amount
//       to the description and passes the year tag through.
//
// We load the real source from bot/ExpenseBot_FIXED.gs (no mocks of the
// helper) by extracting the function bodies with balanced-brace parsing,
// then evaluate them in a sandbox where SpreadsheetApp / Utilities / Logger
// are stubbed. This catches any drift between this test and the deployed
// helper.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');

function extractFunction(src, name) {
  const marker = 'function ' + name + '(';
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('function not found: ' + name);
  // Find the opening brace after the signature.
  let i = src.indexOf('{', start);
  if (i === -1) throw new Error('no opening brace for ' + name);
  let depth = 1;
  i++;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) throw new Error('unbalanced braces for ' + name);
  return src.substring(start, i);
}

const composeSrc = extractFunction(SRC, '_composeNoteWithYearSeparator_');
const detailSrc = extractFunction(SRC, '_dashboardDetailNote_');

// Sandbox stubs.
let lastSetNote = null;
const sandbox = {
  // Share host Date so `when instanceof Date` works on Date objects we create
  // in the test (vm.createContext otherwise gives the sandbox its own Date and
  // every `instanceof Date` check returns false → fallback to `new Date()`).
  Date: Date,
  Logger: { log: function () {} },
  Utilities: {
    formatDate: function (d, tz, fmt) {
      // Minimal formatter — we only need dd/MM/yyyy HH:mm and yyyy patterns.
      const pad = (n) => String(n).padStart(2, '0');
      const map = {
        'yyyy': d.getFullYear(),
        'MM': pad(d.getMonth() + 1),
        'dd': pad(d.getDate()),
        'HH': pad(d.getHours()),
        'mm': pad(d.getMinutes())
      };
      return fmt
        .replace(/yyyy/g, map.yyyy)
        .replace(/MM/g, map.MM)
        .replace(/dd/g, map.dd)
        .replace(/HH/g, map.HH)
        .replace(/mm/g, map.mm);
    }
  },
  // _dashboardDetailNote_ calls setDashboardNoteForTransaction_; stub it
  // so we can inspect the args.
  setDashboardNoteForTransaction_: function (category, sub, monthKey, line, yearTag) {
    lastSetNote = { category, sub, monthKey, line, yearTag };
    return true;
  }
};
vm.createContext(sandbox);
vm.runInContext(composeSrc + '\n' + detailSrc, sandbox);

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
  }
}

console.log('\n=== _composeNoteWithYearSeparator_ pure helper ===');
const compose = sandbox._composeNoteWithYearSeparator_;

// Case 1: empty note + 2026 entry → header + line.
{
  const out = compose('', '28/05/2026 23:06 · ₪490 · דלק', 2026);
  check('empty note gets === 2026 === header',
    out === '=== 2026 ===\n28/05/2026 23:06 · ₪490 · דלק',
    'got: ' + JSON.stringify(out));
}

// Case 2: existing 2026 block + 2026 entry → just append (no extra header).
{
  const existing = '=== 2026 ===\n28/05/2026 23:06 · ₪490 · דלק';
  const out = compose(existing, '29/05/2026 10:00 · ₪50 · קפה', 2026);
  check('same-year append does NOT duplicate header',
    out === existing + '\n29/05/2026 10:00 · ₪50 · קפה',
    'got: ' + JSON.stringify(out));
}

// Case 3: existing 2024 block + 2026 entry → new header inserted.
{
  const existing = '=== 2024 ===\n10/01/2024 12:00 · ₪100 · גז';
  const out = compose(existing, '29/05/2026 10:00 · ₪50 · קפה', 2026);
  check('different-year append inserts new === 2026 === header',
    out === existing + '\n=== 2026 ===\n29/05/2026 10:00 · ₪50 · קפה',
    'got: ' + JSON.stringify(out));
}

// Case 4: legacy note (no === header at all) + 2026 entry → header inserted
// after the legacy block. Legacy lines stay untouched at the top.
{
  const legacy = '28/05 23:06 · ₪490 · דלק'; // old format, no year, no header
  const out = compose(legacy, '29/05/2026 10:00 · ₪50 · קפה', 2026);
  check('legacy note (no header) gets === 2026 === inserted before new line',
    out === legacy + '\n=== 2026 ===\n29/05/2026 10:00 · ₪50 · קפה',
    'got: ' + JSON.stringify(out));
}

// Case 5: 2024 block followed by 2026 block, append another 2026 entry.
// New line should slot under the existing 2026 header — no third header.
{
  const existing = '=== 2024 ===\n10/01/2024 12:00 · ₪100 · גז\n=== 2026 ===\n28/05/2026 23:06 · ₪490 · דלק';
  const out = compose(existing, '29/05/2026 10:00 · ₪50 · קפה', 2026);
  check('append under most-recent matching year — no duplicate header',
    out === existing + '\n29/05/2026 10:00 · ₪50 · קפה',
    'got: ' + JSON.stringify(out));
}

// Case 6: 2024 block + 2026 block, then a 2027 entry → fresh 2027 header.
{
  const existing = '=== 2024 ===\n10/01/2024 12:00 · ₪100 · גז\n=== 2026 ===\n28/05/2026 23:06 · ₪490 · דלק';
  const out = compose(existing, '02/01/2027 09:00 · ₪75 · חניה', 2027);
  check('third-year entry adds its own === 2027 === header',
    out === existing + '\n=== 2027 ===\n02/01/2027 09:00 · ₪75 · חניה',
    'got: ' + JSON.stringify(out));
}

console.log('\n=== _dashboardDetailNote_ wrapper ===');
const detail = sandbox._dashboardDetailNote_;

// Case 7: line includes 4-digit year (the bug we are fixing).
{
  lastSetNote = null;
  // 28 May 2026, 23:06 local — use any Date, our stubbed Utilities ignores tz.
  const when = new Date(2026, 4, 28, 23, 6); // months 0-indexed
  const ok = detail('עסק', 'דלק ורכב', '2026-05', 490, 'דלק', when);
  check('detail wrapper returns true',
    ok === true,
    'got: ' + ok);
  check('line carries dd/MM/yyyy HH:mm',
    lastSetNote && /^28\/05\/2026 23:06/.test(lastSetNote.line),
    'got line: ' + (lastSetNote && lastSetNote.line));
  check('yearTag passed through to setDashboardNoteForTransaction_',
    lastSetNote && lastSetNote.yearTag === 2026,
    'got yearTag: ' + (lastSetNote && lastSetNote.yearTag));
  check('amount formatted with ₪ separator',
    lastSetNote && lastSetNote.line.indexOf('₪490') !== -1,
    'got line: ' + (lastSetNote && lastSetNote.line));
  check('description appended after second middot',
    lastSetNote && lastSetNote.line.indexOf(' · דלק') !== -1,
    'got line: ' + (lastSetNote && lastSetNote.line));
}

// Case 8: description longer than 50 chars is truncated (existing behavior).
{
  lastSetNote = null;
  const longDesc = 'א'.repeat(80);
  const when = new Date(2026, 0, 1, 9, 0);
  detail('עסק', 'תפעול', '2026-01', 100, longDesc, when);
  const tail = lastSetNote.line.split(' · ').pop();
  check('description truncated to 50 chars',
    tail.length === 50,
    'got tail length: ' + tail.length);
}

// Case 9: KFL_BUILD_VERSION bumped to mention the new feature.
{
  const m = SRC.match(/KFL_BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/);
  check('KFL_BUILD_VERSION declared',
    !!m,
    'no version line found');
  // The feature is the function pair _composeNoteWithYearSeparator_ + the
  // year-separator marker line. Verify the FEATURE CODE is still in the source
  // — not the build-version string, which legitimately bumps on every release.
  check('year-separator feature still in source',
    /=== ' \+ year \+ ' ===/.test(SRC) && /_composeNoteWithYearSeparator_/.test(SRC),
    'got: ' + (m && m[1]));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) process.exit(1);
