// lib/profile-configs.js
//
// Per-customer-TYPE dashboard configuration (council 2026-06-25, see
// docs/TEMPLATE_GENERATOR_PLAN.md). The תנועות LEDGER is universal and identical
// across every type — "type" is purely a dashboard VIEW. A profile config only
// selects WHICH of the existing dashboard rows are shown; it NEVER invents a new
// row label (that would need a new SUMIFS) and NEVER touches the ledger. Hiding a
// row keeps its ledger transactions intact — they simply stop showing a summary
// line, and re-appear if the user switches back. This makes every type-switch
// structurally lossless.
//
// SAFETY: configs express EXCLUSIONS from the full row set (default = exclude
// nothing = byte-identical to today, so already-provisioned sheets are unchanged
// — proven by tests/test_profile_configs.js parity check). The dashboard
// generator (buildTenantSheetSpec, to be wired next behind the parity gate) must
// recompute the load-bearing section-total RANGES from the selected row counts,
// never hardcode them.
//
// This module is ADDITIVE and not yet wired into the live builder.
'use strict';

// hideRows: dashboard row labels to omit for this type (must be a subset of the
// labels that exist in lib/sheet-writer.js PERSONAL_*_ROWS — the test enforces it).
const PROFILE_CONFIGS = {
  // Default / single-person baseline = the FULL current set (identity). Existing
  // users and anyone unmatched land here -> zero change.
  basic_personal: { label: 'בסיסי / יחיד',      hideRows: [] },
  // A single person with no kids: drop the baby row.
  single:         { label: 'רווק/ה',            hideRows: ['תינוק'] },
  // A couple (dual income, typically no young kids yet): drop the baby row.
  couple:         { label: 'זוג',               hideRows: ['תינוק'] },
  // A family keeps everything (the current default set is already family-oriented:
  // baby row, kids categories). Identity to the full set.
  family:         { label: 'משפחה',             hideRows: [] },
  divorced:       { label: 'גרוש/ה',            hideRows: [] },
  employee:       { label: 'שכיר/ה',            hideRows: ['תינוק'] },
  // Self-employed: surface the business income/expense view, drop the baby row.
  freelancer:     { label: 'עצמאי/ת',           hideRows: ['תינוק'], showCompany: true },
  business:       { label: 'בעל/ת עסק',         hideRows: ['תינוק'], showCompany: true },
  contractor:     { label: 'קבלן/ית',           hideRows: ['תינוק'], showCompany: true },
  mixed:          { label: 'משולב',             hideRows: [], showCompany: true },
  advanced_imported: { label: 'מיובא / מתקדם',   hideRows: [] },
};

const DEFAULT_TYPE = 'basic_personal';

// Map a free-text Hebrew request ("אקסל לזוג" / "תבנית משפחה" / "אני עצמאי") to a
// profileType, so the bot can switch a user's dashboard view by message.
function parseProfileTypeFromText(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  // require a template/sheet intent word so a plain expense isn't captured
  if (!/(?:אקסל|גיליון|טמפלט|תבנית|פרופיל|מסך|דשבורד)/.test(s)) return null;
  if (/(?:זוג|זוגי|בני\s*זוג|לשנינו)/.test(s)) return 'couple';
  if (/(?:משפח|ילדים|הורים)/.test(s)) return 'family';
  if (/(?:עצמאי|פרילנס|freelance|עוסק\s*פטור)/.test(s)) return 'freelancer';
  if (/(?:עסק|חברה|בעל\s*עסק|business)/.test(s)) return 'business';
  if (/(?:קבלן|contractor)/.test(s)) return 'contractor';
  if (/(?:לבד|יחיד|רווק|single|בסיסי)/.test(s)) return 'basic_personal';
  if (/(?:שכיר|עובד\s*שכיר|employee)/.test(s)) return 'employee';
  if (/(?:גרוש|פרוד|alimony|מזונות)/.test(s)) return 'divorced';
  return null;
}

// Select which rows of a full group are active for a profile type. `fullRows` is
// an array of row labels (strings) or row objects with a `.label`. Returns the
// same shape, filtered. Default type / unknown type -> identity (no filtering).
function selectRows(profileType, fullRows) {
  const cfg = PROFILE_CONFIGS[profileType] || PROFILE_CONFIGS[DEFAULT_TYPE];
  const hide = new Set(cfg.hideRows || []);
  if (!hide.size) return fullRows.slice();
  return fullRows.filter((r) => !hide.has(typeof r === 'string' ? r : (r && r.label)));
}

module.exports = { PROFILE_CONFIGS, DEFAULT_TYPE, parseProfileTypeFromText, selectRows };
