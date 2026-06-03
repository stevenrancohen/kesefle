// tests/test_recurring_backfill_month_tz.js
//
// REGRESSION GUARD: buildExpenseRow (lib/sheet-writer.js) must put a backfilled
// recurring / imported expense in the correct CALENDAR month regardless of the
// runtime's local timezone.
//
// WHY THIS EXISTS
// ---------------
// Col B (חודש, "YYYY-MM") is the key EVERY dashboard SUMIFS buckets a row by, so
// it must be the intended calendar month. Two real write paths pass a date-only
// value to buildExpenseRow:
//   - the recurring engine  (api/recurring.js -> logOccurrence: date = dateStr,
//     a bare "YYYY-MM-DD" produced by the cron's Asia/Jerusalem calendar)
//   - the bank-CSV importer (api/import/bank-csv.js: date = r.date + 'T00:00:00Z')
// Before the 2026-06-03 fix, buildExpenseRow derived the month via
// `new Date(s).getMonth()`, which reads the month in the HOST's local timezone.
// For a bare date / UTC-midnight value, a negative-offset TZ (e.g. a non-UTC CI
// box, or any deploy region west of UTC) rolls midnight back to the previous
// day -> "2026-06-01" silently filed under "2026-05", and a Jan-1 backfill under
// the PREVIOUS YEAR ("2026-01-01" -> "2025-12"). Vercel runs UTC so production
// is unaffected today, but the bug is latent and defeats the careful
// todayIsrael() calendar pinning the recurring cron does upstream.
//
// HOW IT GUARDS REGARDLESS OF HOST TZ
// -----------------------------------
// The gauntlet runs this file in whatever TZ the host happens to be (often UTC,
// where the bug is invisible). So this suite RE-EXECS a child `node` with a
// fixed adversarial timezone (America/Los_Angeles, UTC-7/8) and asserts the
// month there. That makes the guard deterministic: it fails on the pre-fix code
// even on a UTC build machine. No mocking framework; the child loads the REAL ES
// module so the integrated buildExpenseRow pipeline is what's under test.
//
// Run: node tests/test_recurring_backfill_month_tz.js

'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; fails.push(label); console.log('  ❌ ' + label); }
}

const SHEET_WRITER = path.join(__dirname, '..', 'lib', 'sheet-writer.js');

// Run buildExpenseRow for a batch of {date} inputs inside a child node process
// pinned to `tz`, and return the parsed [{ date, colA, colB }] results.
// Using a child process is the only way to force process.env.TZ deterministically
// (the zoneinfo is read once at process start; setting TZ at runtime is unreliable).
function rowsUnderTz(tz, dates) {
  const child = `
    import('${SHEET_WRITER.replace(/\\/g, '\\\\')}').then((m) => {
      const out = ${JSON.stringify(dates)}.map((dt) => {
        const r = m.buildExpenseRow({ amount: 100, rawText: 'x', date: dt });
        return { date: dt, colA: r[0], colB: r[1] };
      });
      process.stdout.write(JSON.stringify(out));
    }).catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(2); });
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    env: Object.assign({}, process.env, { TZ: tz }),
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error('child failed (TZ=' + tz + ', exit ' + res.status + '): ' + (res.stderr || '').slice(0, 400));
  }
  return JSON.parse(res.stdout);
}

(function main() {
  console.log('\n══ buildExpenseRow calendar-month TZ stability ══');

  // (input date, expected "YYYY-MM"). Mix of bare dates (recurring) and
  // explicit UTC-midnight (CSV importer), including both month and YEAR
  // boundaries — the worst cases for an off-by-one TZ roll.
  const CASES = [
    ['2026-06-01', '2026-06'],            // recurring: 1st of month
    ['2026-01-01', '2026-01'],            // recurring: Jan 1 (year boundary)
    ['2026-12-31', '2026-12'],            // recurring: last day of year
    ['2026-03-01', '2026-03'],            // recurring: another month start
    ['2026-06-01T00:00:00Z', '2026-06'],  // CSV importer shape
    ['2026-01-01T00:00:00Z', '2026-01'],  // CSV importer at year boundary
  ];
  const inputs = CASES.map((c) => c[0]);

  // Two timezones whose midnight straddles the UTC date line in OPPOSITE
  // directions, so a TZ-naive month derivation must fail in at least one.
  const ADVERSARIAL_TZS = ['America/Los_Angeles' /* UTC-7/8 */, 'Pacific/Kiritimati' /* UTC+14 */];

  for (const tz of ADVERSARIAL_TZS) {
    let rows;
    try { rows = rowsUnderTz(tz, inputs); }
    catch (e) { ok('child runs under TZ=' + tz, false); console.log('    ' + e.message); continue; }
    const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
    for (const [input, expectMonth] of CASES) {
      const got = byDate[input];
      ok('[' + tz + '] ' + input + ' -> col B ' + expectMonth + ' (got ' + (got && got.colB) + ')',
        !!got && got.colB === expectMonth);
      // The col-A display day must also match the intended calendar day so a
      // reader in any timezone shows the right date (anchored to UTC noon).
      const wantDay = input.slice(0, 10);
      ok('[' + tz + '] ' + input + ' -> col A day ' + wantDay,
        !!got && typeof got.colA === 'string' && got.colA.slice(0, 10) === wantDay);
    }
  }

  // Sanity: the live-write path (no date supplied) still yields a valid month
  // key in the host TZ — the fix must not disturb the default "now" branch.
  console.log('\n══ live-write (no date) still valid ══');
  try {
    const live = rowsUnderTz('UTC', [null]);
    const colB = live[0] && live[0].colB;
    ok('no-date live write yields a YYYY-MM month key', /^\d{4}-\d{2}$/.test(String(colB)));
  } catch (e) {
    ok('no-date live write runs', false); console.log('    ' + e.message);
  }

  console.log('\n' + (fail === 0
    ? '✅ recurring backfill month TZ: ALL ' + pass + ' CHECKS PASSED'
    : '❌ ' + fail + ' FAILED (' + fails.join('; ') + '), ' + pass + ' passed'));
  process.exit(fail === 0 ? 0 : 1);
})();
