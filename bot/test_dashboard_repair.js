#!/usr/bin/env node
// bot/test_dashboard_repair.js
// Phase A v2.2 — DRY_RUN + APPLY dashboard repair regression tests.
//
// Steven's done-criteria (verbatim):
//   - dry-run must not change any cell
//   - apply must not run without exact confirmation
//   - all main rows in מאזן חברה return to formulas (not hardcoded values)
//   - 2025 and 2026 formulas do not return #REF!
//   - new transaction in תנועות auto-updates מאזן חברה
//
// String-match style (Apps Script can't run locally) — verifies the
// shipped source has all required structure.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'personal_sheet_fix.gs'), 'utf8');
const failures = [];
function assert(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.error('  FAIL ' + label); failures.push(label); }
}

console.log('\nbot/test_dashboard_repair.js\n');

// ───── Constants exist ─────
console.log('Constants:');
assert(/var _PSF_PATTERNS_v2_ = \{/.test(SRC),
  '_PSF_PATTERNS_v2_ object defined');
assert(/var _PSF_DASH_METRICS_v2_ = \[/.test(SRC),
  '_PSF_DASH_METRICS_v2_ array defined');

// All 4 expense patterns
const patternsBlock = SRC.match(/var _PSF_PATTERNS_v2_ = \{[\s\S]*?\};/);
assert(patternsBlock && /materials\s*:/.test(patternsBlock[0]),
  '_PSF_PATTERNS_v2_ has materials pattern');
assert(patternsBlock && /marketing\s*:/.test(patternsBlock[0]),
  '_PSF_PATTERNS_v2_ has marketing pattern');
assert(patternsBlock && /shipping\s*:/.test(patternsBlock[0]),
  '_PSF_PATTERNS_v2_ has shipping pattern');
assert(patternsBlock && /ops\s*:/.test(patternsBlock[0]),
  '_PSF_PATTERNS_v2_ has ops pattern');

// Patterns include the Hebrew keywords Steven listed
assert(patternsBlock && /חומרי\\s\*גלם|חומרים/.test(patternsBlock[0]),
  'materials pattern includes חומרי גלם / חומרים');
assert(patternsBlock && /שיווק|פרסום|קמפיין/.test(patternsBlock[0]),
  'marketing pattern includes שיווק / פרסום / קמפיין');
assert(patternsBlock && /משלוח|התקנ|הובל|שליח/.test(patternsBlock[0]),
  'shipping pattern includes משלוח / התקנ / הובל / שליח');
assert(patternsBlock && /תפעולי|תוכנ|משרד|טלפון|אינטרנט/.test(patternsBlock[0]),
  'ops pattern includes תפעולי / תוכנ / משרד');

// All 9 dashboard metrics
const metricsBlock = SRC.match(/var _PSF_DASH_METRICS_v2_ = \[[\s\S]*?\];/);
const metricKeys = ['revenue', 'orderCount', 'materials', 'marketing', 'shipping', 'ops', 'totalExp', 'netProfit', 'marginPct'];
for (const k of metricKeys) {
  assert(metricsBlock && new RegExp("key:\\s*'" + k + "'").test(metricsBlock[0]),
    'metric key "' + k + '" defined');
}
const metricLabels = ['מחזור ברוטו', "מס' הזמנות", 'עלות חומרי גלם', 'עלות שיווק',
                      'משלוחים והתקנות', 'הוצאות תפעוליות', 'סה"כ הוצאות עסקיות',
                      'רווח נטו חודשי', 'אחוז רווחיות'];
for (const lab of metricLabels) {
  assert(metricsBlock && metricsBlock[0].indexOf(lab) >= 0,
    'metric label "' + lab + '" present');
}

// ───── Formula builder ─────
console.log('\nFormula builder:');
assert(/function _psf_buildFormula_v2_\(year, mi, metricKey, rowOffsets, col0Based\)/.test(SRC),
  '_psf_buildFormula_v2_(year, mi, metricKey, rowOffsets, col0Based) defined');
const fbBlock = SRC.match(/function _psf_buildFormula_v2_\([\s\S]*?\n}\n/);
assert(fbBlock && /SUMPRODUCT/.test(fbBlock[0]),
  'formula builder uses SUMPRODUCT (more flexible than SUMIFS literal)');
assert(fbBlock && /REGEXMATCH/.test(fbBlock[0]),
  'formula builder uses REGEXMATCH for wildcard category matching');
assert(fbBlock && /"עסק"/.test(fbBlock[0]) || /"עסק"/.test(fbBlock[0]),
  'formula builder filters by category="עסק"');
assert(fbBlock && /IFERROR\(/.test(fbBlock[0]),
  'formula builder wraps in IFERROR (avoids #REF/#DIV errors)');
assert(fbBlock && /metricKey === 'revenue'/.test(fbBlock[0]),
  'formula builder handles revenue metric');
assert(fbBlock && /metricKey === 'orderCount'/.test(fbBlock[0]),
  'formula builder handles orderCount metric');
assert(fbBlock && /metricKey === 'totalExp'/.test(fbBlock[0]),
  'formula builder handles totalExp metric');
assert(fbBlock && /metricKey === 'netProfit'/.test(fbBlock[0]),
  'formula builder handles netProfit metric (cross-cell reference)');
assert(fbBlock && /metricKey === 'marginPct'/.test(fbBlock[0]),
  'formula builder handles marginPct metric (handles zero-revenue div)');
// Phase A v2.2-fix1: no destructive "=0" fallback for netProfit/marginPct.
assert(fbBlock && /Fallback — compute directly from תנועות/.test(fbBlock[0]),
  'netProfit has direct-from-תנועות fallback (no destructive "=0")');
assert(fbBlock && /Inline ratio direct from תנועות/.test(fbBlock[0]),
  'marginPct has direct-from-תנועות fallback (no destructive "=0")');
assert(!/if \(!rowOffsets\.revenue \|\| !rowOffsets\.totalExp\) return '=0'/.test(fbBlock ? fbBlock[0] : ''),
  'old destructive "=0" fallback for netProfit is REMOVED');
assert(!/if \(!rowOffsets\.netProfit \|\| !rowOffsets\.revenue\) return '=0'/.test(fbBlock ? fbBlock[0] : ''),
  'old destructive "=0" fallback for marginPct is REMOVED');

// Phase A v2.2-fix2: preserve non-zero hardcoded values (historical data).
console.log('\nHistorical-value preservation (fix2):');
assert(/existing[A-Za-z]*NonZeroNumber|existingIsNonZeroNumber/.test(SRC),
  'scanner checks for existing non-zero numeric value');
assert(/likely historical|PRESERVE/i.test(SRC),
  'scanner comments explain historical-data preservation');
assert(/empty\/zero cell \(no formula\)/.test(SRC),
  'scanner only marks empty/zero hardcoded cells for repair (not non-zero)');

// Phase A v2.2: zero-arg APPLY wrapper for the function dropdown.
console.log('\nAPPLY wrapper (zero-arg, for function dropdown):');
assert(/function APPLY_DASHBOARD_REPAIR_NOW\(\)/.test(SRC),
  'APPLY_DASHBOARD_REPAIR_NOW() wrapper defined (no args, runs from dropdown)');
assert(/APPLY_DASHBOARD_REPAIR\('YES I UNDERSTAND'\)/.test(SRC),
  'wrapper passes literal "YES I UNDERSTAND" internally');

// ───── DRY_RUN ─────
console.log('\nDRY_RUN_DASHBOARD_REPAIR (Steven explicit: no writes):');
assert(/function DRY_RUN_DASHBOARD_REPAIR\(\)/.test(SRC),
  'DRY_RUN_DASHBOARD_REPAIR() defined');
const dryFn = SRC.match(/function DRY_RUN_DASHBOARD_REPAIR\(\)[\s\S]*?\n}\n/);
assert(dryFn && /_psf_scanDashboardForRepair_v2_\(false\)/.test(dryFn[0]),
  'DRY_RUN calls scanner with applyMode=false');
assert(dryFn && !/\.setFormula\(/.test(dryFn[0]),
  'DRY_RUN body does NOT call .setFormula() — pure log');
assert(dryFn && !/\.setValue\(/.test(dryFn[0]),
  'DRY_RUN body does NOT call .setValue() — pure log');
assert(dryFn && /WOULD|would change/i.test(dryFn[0]) || /WOULD FIX|would change|nothing was changed/i.test(dryFn[0]),
  'DRY_RUN log states "would change" / "not modified"');
assert(dryFn && /APPLY_DASHBOARD_REPAIR/.test(dryFn[0]),
  'DRY_RUN points user toward APPLY_DASHBOARD_REPAIR next step');

// ───── APPLY ─────
console.log('\nAPPLY_DASHBOARD_REPAIR (requires exact confirmation):');
assert(/function APPLY_DASHBOARD_REPAIR\(confirmation\)/.test(SRC),
  'APPLY_DASHBOARD_REPAIR(confirmation) defined');
const applyFn = SRC.match(/function APPLY_DASHBOARD_REPAIR\(confirmation\)[\s\S]*?\n}\n/);
assert(applyFn && /confirmation !== 'YES I UNDERSTAND'/.test(applyFn[0]),
  'APPLY refuses when confirmation !== "YES I UNDERSTAND"');
assert(applyFn && /REFUSED/.test(applyFn[0]),
  'APPLY logs REFUSED on bad confirmation');
assert(applyFn && /_psf_scanDashboardForRepair_v2_\(true\)/.test(applyFn[0]),
  'APPLY calls scanner with applyMode=true (only after confirm passes)');
assert(applyFn && /setNote\(/.test(applyFn[0]),
  'APPLY writes audit trail to cell note');
assert(applyFn && /KFL_DASHBOARD_REPAIR_v1/.test(applyFn[0]),
  'audit trail includes version stamp KFL_DASHBOARD_REPAIR_v1');
assert(applyFn && /yyyy-MM-dd HH:mm|HH:mm/.test(applyFn[0]),
  'audit trail includes timestamp');

// ───── Scanner core ─────
console.log('\nScanner core:');
assert(/function _psf_scanDashboardForRepair_v2_\(applyMode\)/.test(SRC),
  '_psf_scanDashboardForRepair_v2_(applyMode) defined');
// Locate scanner block by finding start marker → next top-level function marker.
const scanStart = SRC.indexOf('function _psf_scanDashboardForRepair_v2_(applyMode)');
const scanEnd = SRC.indexOf('function DRY_RUN_DASHBOARD_REPAIR');
const scanBody = (scanStart >= 0 && scanEnd > scanStart) ? SRC.slice(scanStart, scanEnd) : '';
assert(scanBody && /שנת\\s\+\(20\\d\{2\}\)/.test(scanBody),
  'scanner finds all "שנת YYYY" year headers');
assert(scanBody && /_bucketLabelMatch_/.test(scanBody),
  'scanner reuses existing _bucketLabelMatch_ helper');
assert(scanBody && /_isBrokenDashFormula_/.test(scanBody),
  'scanner reuses existing _isBrokenDashFormula_ helper');
assert(scanBody && /\.getFormula\(\)/.test(scanBody),
  'scanner reads existing formula via getFormula()');
assert(scanBody && /#REF/.test(scanBody),
  'scanner detects #REF! errors');
assert(scanBody && /no_year_blocks|no_tab/.test(scanBody),
  'scanner returns descriptive error codes');
assert(scanBody && /if \(applyMode\) cell\.setFormula\(newFormula\)/.test(scanBody),
  'scanner only writes when applyMode=true');

// ───── Special 2026 May +2100 preservation ─────
console.log('\n2026 May +2100 preservation:');
assert(/blk\.year === 2026 && mi === 5 && metric\.key === 'marketing'/.test(SRC),
  'preserves the 2026-May manual +2100 marketing adjustment');

// ───── Existing safety preserved ─────
console.log('\nExisting safety preserved:');
assert(/function _isBrokenDashFormula_/.test(SRC),
  'existing _isBrokenDashFormula_ helper still present');
assert(/function FIX_MARKETING_ALL_YEARS/.test(SRC),
  'existing FIX_MARKETING_ALL_YEARS still present (backwards compat)');
assert(/function APPLY_RESTORE_2026/.test(SRC),
  'existing APPLY_RESTORE_2026 still present (backwards compat)');
assert(/function RECOMPUTE_COMPANY_DASHBOARD/.test(SRC),
  'existing RECOMPUTE_COMPANY_DASHBOARD still present (backwards compat)');

console.log('');
if (failures.length) {
  console.error('FAIL: ' + failures.length + ' assertion(s) failed');
  process.exit(1);
}
console.log('OK: all assertions passed');
