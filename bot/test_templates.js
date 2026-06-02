#!/usr/bin/env node
// Test the 10 TEMPLATE PRESETS added to bot/ExpenseBot_FIXED.gs.
//
// A preset is a named bundle of EXTRA category-rows to seed (Hebrew labels)
// + the dashboard sections it expects, applied through the existing
// idempotent add-category-row path (applyTemplatePreset_ -> _addCategoryRows_
// -> POST /api/sheet/add-category-row). The endpoint dedups by label, so
// seeding a row the default template already has — or running the same
// preset twice — must come back as a DUPLICATE and never create a 2nd row.
//
// We exercise the REAL source: the _TEMPLATE_PRESETS_ table + the
// _resolveTemplatePresetId_ + applyTemplatePreset_ functions are sliced out
// of the .gs and eval'd. applyTemplatePreset_ accepts an injected seedFn
// (opts.seedFn) so we replay it against an in-memory fake of the server
// (which models the per-user dashboard row set + its real dedup) — no
// network, no mocking framework, mirroring bot/test_onboarding_flow.js.
//
// Asserts, for every one of the 10 presets:
//   (1) it seeds EXACTLY the rows declared in its table entry (in a clean
//       sheet) — the "expected rows" contract;
//   (2) running it a SECOND time seeds NOTHING (all duplicates) — the
//       no-duplicate-row-creation contract;
//   (3) rows already present in the default template are reported as
//       duplicates, not re-created;
//   (4) its `sections` metadata is well-formed.
// Plus: the 10 ids stay in sync with _ONBOARDING_PRESETS_ (bot) and
// PROFILE_TYPES (api/profile.js), and the onboarding finish wires seeding.
//
// Run: node bot/test_templates.js

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'ExpenseBot_FIXED.gs'), 'utf8');
const PROFILE_JS = fs.readFileSync(path.join(__dirname, '..', 'api', 'profile.js'), 'utf8');

let pass = 0, fail = 0;
const fails = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; fails.push(label); console.log('  FAIL ' + label + (detail ? ' -- ' + detail : '')); }
}

// ── Slice the template-preset block out of the source: from the
// _TEMPLATE_PRESETS_ table down to (but not including) cronRecurringExpenses,
// which immediately follows applyTemplatePreset_. ────────────────────────────
function sliceBetween(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('start marker not found: ' + startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('end marker not found: ' + endMarker);
  return src.slice(i, j);
}

const blockSrc = sliceBetween(
  SRC,
  'var _TEMPLATE_PRESETS_',
  '\nfunction cronRecurringExpenses'
);

// ── In-memory fake of the add-category-row endpoint. Models ONE user's
// dashboard as a Set of existing labels, seeded with a realistic slice of
// the DEFAULT template (lib/sheet-writer.js personal rows) so we can prove
// the dedup against pre-existing template rows. Returns the SAME human reply
// strings _addCategoryRows_ produces, which applyTemplatePreset_ parses. ─────
function makeFakeServer(preExisting) {
  const rows = new Set(preExisting || []);
  let addCalls = 0;     // how many NEW rows were actually created
  let dupCalls = 0;     // how many calls hit an existing row
  function seedFn(_phone, name) {
    name = String(name || '').trim();
    if (!name) return '😬 לא הצליח: (ריק)';
    if (rows.has(name)) {
      dupCalls++;
      return 'ℹ️ כבר קיים: ' + name;
    }
    rows.add(name);
    addCalls++;
    return '✅ נוספו לגיליון *מאזן אישי*: ✨ ' + name + '\n\nמעכשיו כל הוצאה שמזכירה את השם תיכנס לשורה הזאת אוטומטית.';
  }
  return {
    seedFn,
    rows,
    get addCalls() { return addCalls; },
    get dupCalls() { return dupCalls; },
    has(n) { return rows.has(n); },
    size() { return rows.size; },
  };
}

// A realistic subset of the DEFAULT personal-dashboard template (from
// lib/sheet-writer.js PERSONAL_* row constants). Used to prove that a preset
// row colliding with the default template is deduped, never re-created.
const DEFAULT_TEMPLATE_ROWS = [
  'בית', 'חשמל', 'מים', 'תקשורת', 'אפליקציות', 'מנויים דיגיטליים',
  'דלק', 'חניה', 'מונית', 'אחזקת רכב', 'תחבורה ציבורית', 'ביטוח רכב', 'מוסך',
  'אוכל לבית', 'אוכל בחוץ', 'ביגוד', 'טיפוח', 'בריאות', 'בילויים', 'שונות',
  'מתנות', 'חיות מחמד', 'תרופות', 'חופשות', 'תינוק',
];

// ── Build the sandbox: eval the real block, mock only Logger + the seeder.
function makeSandbox() {
  const sandbox = {};
  sandbox.Logger = { log() {} };
  // _addCategoryRows_ is referenced as the DEFAULT seedFn inside
  // applyTemplatePreset_ (only used when opts.seedFn is omitted). We always
  // inject opts.seedFn in tests, so this default must merely EXIST so the
  // function reference resolves at eval time; it must never be called.
  sandbox._addCategoryRows_ = function () {
    throw new Error('default _addCategoryRows_ should not be called — test injects seedFn');
  };

  const code = blockSrc +
    '\nsandbox._TEMPLATE_PRESETS_ = _TEMPLATE_PRESETS_;' +
    '\nsandbox._resolveTemplatePresetId_ = _resolveTemplatePresetId_;' +
    '\nsandbox.applyTemplatePreset_ = applyTemplatePreset_;';
  new Function('sandbox', 'Logger', '_addCategoryRows_', code)(
    sandbox, sandbox.Logger, sandbox._addCategoryRows_
  );
  return sandbox;
}

const S = makeSandbox();
const PRESETS = S._TEMPLATE_PRESETS_;
const PRESET_IDS = Object.keys(PRESETS);

// The 10 ids the epic asks for (snake_case). Order-independent.
const EXPECTED_IDS = [
  'basic_personal', 'couple', 'family', 'divorced', 'employee',
  'freelancer', 'business', 'contractor', 'mixed', 'advanced_imported',
];

const PHONE = '972526001234';

// ════════════════════════════════════════════════════════════════════════
// 1) The table defines exactly the 10 expected presets, each well-formed.
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 1) preset table shape ==');
check('exactly 10 presets defined', PRESET_IDS.length === 10, 'got ' + PRESET_IDS.length + ': ' + PRESET_IDS.join(','));
EXPECTED_IDS.forEach(function (id) {
  check('preset present: ' + id, PRESETS.hasOwnProperty(id));
});
PRESET_IDS.forEach(function (id) {
  const p = PRESETS[id];
  check(id + ': has Hebrew label', !!p.label && /[֐-׿]/.test(p.label), JSON.stringify(p.label));
  check(id + ': sections is non-empty array', Array.isArray(p.sections) && p.sections.length >= 1);
  check(id + ': sections includes personal', p.sections.indexOf('personal') >= 0, JSON.stringify(p.sections));
  check(id + ': extraRows is an array', Array.isArray(p.extraRows));
  // No accidental dup labels inside a single preset's row list.
  const u = new Set(p.extraRows);
  check(id + ': no duplicate rows within the preset', u.size === p.extraRows.length,
    JSON.stringify(p.extraRows));
  // Every row is a non-empty Hebrew string (ASCII-only would be a bug — these
  // are dashboard labels the classifier writes Hebrew into).
  check(id + ': all rows are non-empty Hebrew strings',
    p.extraRows.every(function (r) { return typeof r === 'string' && r.trim() && /[֐-׿]/.test(r); }),
    JSON.stringify(p.extraRows));
});

// Section vocabulary is restricted to the 4 known dashboard areas.
console.log('\n== 1b) section vocabulary ==');
const KNOWN_SECTIONS = { personal: 1, business: 1, projects: 1, historical: 1 };
PRESET_IDS.forEach(function (id) {
  check(id + ': only known sections', PRESETS[id].sections.every(function (s) { return KNOWN_SECTIONS[s]; }),
    JSON.stringify(PRESETS[id].sections));
});
// Sanity: business/projects/historical presets actually request those areas.
check('business preset enables business section', PRESETS.business.sections.indexOf('business') >= 0);
check('contractor preset enables projects section', PRESETS.contractor.sections.indexOf('projects') >= 0);
check('advanced_imported enables historical section', PRESETS.advanced_imported.sections.indexOf('historical') >= 0);
check('basic_personal is personal-only', PRESETS.basic_personal.sections.length === 1 && PRESETS.basic_personal.sections[0] === 'personal');

// ════════════════════════════════════════════════════════════════════════
// 2) Each preset seeds EXACTLY its declared rows into a CLEAN sheet.
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 2) each preset seeds its expected rows (clean sheet) ==');
PRESET_IDS.forEach(function (id) {
  const expectedRows = PRESETS[id].extraRows;
  const srv = makeFakeServer([]);            // clean sheet
  const r = S.applyTemplatePreset_(id, PHONE, { seedFn: srv.seedFn });

  check(id + ': ok=true', r.ok === true, JSON.stringify(r.failed));
  check(id + ': profileType echoed', r.profileType === id, r.profileType);
  check(id + ': requested == declared rows',
    JSON.stringify(r.requested) === JSON.stringify(expectedRows));
  // seeded set equals the declared rows (order-independent).
  check(id + ': seeded EXACTLY the declared rows',
    sameSet(r.seeded, expectedRows),
    'seeded=' + JSON.stringify(r.seeded) + ' expected=' + JSON.stringify(expectedRows));
  check(id + ': no duplicates on a clean sheet', r.duplicates.length === 0, JSON.stringify(r.duplicates));
  check(id + ': no failures', r.failed.length === 0, JSON.stringify(r.failed));
  // The server actually created one row per declared row, no more, no less.
  check(id + ': server created exactly ' + expectedRows.length + ' rows',
    srv.addCalls === expectedRows.length, 'addCalls=' + srv.addCalls);
  check(id + ': every declared row now exists on the sheet',
    expectedRows.every(function (row) { return srv.has(row); }));
});

// ════════════════════════════════════════════════════════════════════════
// 3) NO DUPLICATE ROW CREATION — re-running a preset seeds nothing new.
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 3) idempotency: second run creates ZERO new rows ==');
PRESET_IDS.forEach(function (id) {
  const expectedRows = PRESETS[id].extraRows;
  const srv = makeFakeServer([]);
  S.applyTemplatePreset_(id, PHONE, { seedFn: srv.seedFn });   // 1st run
  const sizeAfterFirst = srv.size();
  const addsAfterFirst = srv.addCalls;
  const r2 = S.applyTemplatePreset_(id, PHONE, { seedFn: srv.seedFn }); // 2nd run

  check(id + ': 2nd run created NO new rows', srv.addCalls === addsAfterFirst,
    'addCalls went ' + addsAfterFirst + ' -> ' + srv.addCalls);
  check(id + ': sheet row count unchanged after re-run', srv.size() === sizeAfterFirst,
    sizeAfterFirst + ' -> ' + srv.size());
  // For presets WITH rows, the 2nd run reports them all as duplicates.
  if (expectedRows.length) {
    check(id + ': 2nd run reports all rows as duplicates',
      sameSet(r2.duplicates, expectedRows) && r2.seeded.length === 0,
      'dup=' + JSON.stringify(r2.duplicates) + ' seeded=' + JSON.stringify(r2.seeded));
    check(id + ': 2nd run still ok=true', r2.ok === true);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 4) Rows that already exist in the DEFAULT template are deduped, not added.
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 4) dedup against the default template ==');
// Family adds "תינוק" which IS a default-template row — it must dedup.
(function () {
  const srv = makeFakeServer(DEFAULT_TEMPLATE_ROWS.slice());
  const baseSize = srv.size();
  const r = S.applyTemplatePreset_('family', PHONE, { seedFn: srv.seedFn });
  check('family: "תינוק" (a default row) is reported duplicate',
    r.duplicates.indexOf('תינוק') >= 0, JSON.stringify(r.duplicates));
  check('family: never re-created the existing "תינוק" row',
    srv.rows.size === baseSize + r.seeded.length);
  // The genuinely-new family rows (e.g. חוגים) were created.
  check('family: a genuinely new row (חוגים) WAS seeded',
    r.seeded.indexOf('חוגים') >= 0, JSON.stringify(r.seeded));
  check('family: ok=true with a mix of new + duplicate', r.ok === true);
})();

// ════════════════════════════════════════════════════════════════════════
// 5) Robustness: unknown profile_type falls back; bad phone fails cleanly.
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 5) robustness ==');
check('unknown id resolves to basic_personal', S._resolveTemplatePresetId_('does_not_exist') === 'basic_personal');
check('null id resolves to basic_personal', S._resolveTemplatePresetId_(null) === 'basic_personal');
check('mixed-case id resolves', S._resolveTemplatePresetId_('  Business ') === 'business');
(function () {
  const srv = makeFakeServer([]);
  const r = S.applyTemplatePreset_('does_not_exist', PHONE, { seedFn: srv.seedFn });
  // basic_personal has no extra rows -> ok, nothing seeded, no server calls.
  check('unknown id -> basic_personal seeds nothing', r.profileType === 'basic_personal' && r.seeded.length === 0 && srv.addCalls === 0, JSON.stringify(r));
})();
(function () {
  const srv = makeFakeServer([]);
  const r = S.applyTemplatePreset_('business', '', { seedFn: srv.seedFn });
  check('empty phone -> not ok, nothing seeded, server untouched',
    r.ok === false && r.seeded.length === 0 && srv.addCalls === 0, JSON.stringify(r));
  check('empty phone -> all rows recorded as failed',
    r.failed.length === PRESETS.business.extraRows.length, JSON.stringify(r.failed));
})();
(function () {
  // A seedFn that throws on one row must not abort the rest.
  let n = 0;
  const r = S.applyTemplatePreset_('business', PHONE, {
    seedFn: function (_p, name) {
      n++;
      if (n === 2) throw new Error('boom');
      return '✅ נוספו לגיליון *מאזן אישי*: ✨ ' + name;
    },
  });
  check('a throwing row is counted failed, others still seeded',
    r.failed.length === 1 && r.seeded.length === PRESETS.business.extraRows.length - 1, JSON.stringify({ s: r.seeded.length, f: r.failed.length }));
  check('overall ok=false when any row failed', r.ok === false);
})();

// ════════════════════════════════════════════════════════════════════════
// 6) SYNC: ids match _ONBOARDING_PRESETS_ (bot) + PROFILE_TYPES (api).
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 6) cross-file id sync ==');
// Pull _ONBOARDING_PRESETS_ keys straight from the source text.
function onboardingPresetKeys(src) {
  const m = src.match(/var _ONBOARDING_PRESETS_\s*=\s*\{([\s\S]*?)\};/);
  if (!m) return [];
  return (m[1].match(/^\s*([a-z_]+)\s*:/gm) || []).map(function (s) { return s.replace(/[\s:]/g, ''); });
}
const obKeys = onboardingPresetKeys(SRC);
check('_ONBOARDING_PRESETS_ has all 10 ids', sameSet(obKeys, EXPECTED_IDS), JSON.stringify(obKeys));
check('_ONBOARDING_PRESETS_ ids == _TEMPLATE_PRESETS_ ids', sameSet(obKeys, PRESET_IDS), JSON.stringify(obKeys) + ' vs ' + JSON.stringify(PRESET_IDS));

// PROFILE_TYPES from api/profile.js must accept all 10 (else profile.set 400s).
function profileTypesList(src) {
  const m = src.match(/const PROFILE_TYPES\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return (m[1].match(/'([a-z_]+)'/g) || []).map(function (s) { return s.replace(/'/g, ''); });
}
const ptList = profileTypesList(PROFILE_JS);
check('api/profile.js PROFILE_TYPES has all 10 ids', sameSet(ptList, EXPECTED_IDS), JSON.stringify(ptList));

// ════════════════════════════════════════════════════════════════════════
// 7) WIRING: onboarding finish seeds the preset via applyTemplatePreset_.
// ════════════════════════════════════════════════════════════════════════
console.log('\n== 7) source wiring ==');
check('_onboardingFinishSections_ calls applyTemplatePreset_',
  /_onboardingFinishSections_[\s\S]{0,800}applyTemplatePreset_\(preset,\s*clean\)/.test(SRC));
check('applyTemplatePreset_ is defined as a function', /function applyTemplatePreset_\(/.test(SRC));
check('applyTemplatePreset_ uses the existing _addCategoryRows_ path by default',
  /seedFn\s*=\s*\(typeof opts\.seedFn === 'function'\)\s*\?\s*opts\.seedFn\s*:\s*_addCategoryRows_/.test(SRC));
check('_onboardingPickPreset_ can emit freelancer (osek patur)',
  /osekType === 'patur'[\s\S]{0,40}return 'freelancer'/.test(SRC));

// ── helpers ──────────────────────────────────────────────────────────────
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = new Set(a), sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

// ── Result ──────────────────────────────────────────────────────────────
console.log('\n' + (fail === 0
  ? 'ALL ' + pass + ' CHECKS PASSED'
  : fail + ' FAILED, ' + pass + ' passed\n  - ' + fails.join('\n  - ')));
process.exit(fail === 0 ? 0 : 1);
