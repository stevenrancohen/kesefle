// /lib/profession-template.js
//
// Thin helper layer on top of lib/professions.js. The catalog itself is
// just data (119 entries) — this module turns that data into the things
// the rest of the codebase actually consumes:
//
//   getProfessionRows(id)     -> { income: string[], expense: string[] }
//                                Category labels we want added to the
//                                user's dashboard for THIS profession.
//
//   getProfessionBoostKeywords(id) -> string[]
//                                Hebrew + English keywords the
//                                classifier should weight higher for
//                                this user (10-20 diagnostic terms).
//
//   getProfessionLabel(id)    -> string   ("קבלן בניין")
//   getProfessionCategory(id) -> string   ("construction")
//   getProfessionVat(id)      -> string   ('osek_morshe' | etc.)
//
// All functions accept null/empty input and return safe defaults so
// callers don't need to null-guard.

import { findProfession, PROFESSIONS } from './professions.js';

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Returns the income + expense subcategory labels for a profession.
 * Used by the sheet generator to seed profession-tailored rows.
 * @param {string} id - profession id (e.g. 'general_contractor')
 * @returns {{income: string[], expense: string[]}}
 */
export function getProfessionRows(id) {
  const p = findProfession(id);
  if (!p) return { income: [], expense: [] };
  return {
    income: Array.isArray(p.income_subs) ? p.income_subs.slice() : [],
    expense: Array.isArray(p.expense_subs) ? p.expense_subs.slice() : [],
  };
}

/**
 * Returns the 10-20 diagnostic keywords for a profession.
 * Used by the classifier to bias matches when the user's profession
 * is known (e.g. a contractor sending "בטון 800" should be classified
 * as construction materials, not "שונות").
 * @param {string} id
 * @returns {string[]}
 */
export function getProfessionBoostKeywords(id) {
  const p = findProfession(id);
  if (!p || !Array.isArray(p.keywords_boost)) return [];
  return p.keywords_boost.slice();
}

/**
 * Returns the human-readable Hebrew label for a profession.
 * Falls back to '—' for unknown ids so it never breaks string concat.
 * @param {string} id
 * @returns {string}
 */
export function getProfessionLabel(id) {
  const p = findProfession(id);
  return p && p.he ? p.he : '—';
}

/**
 * Returns the category bucket ('construction' / 'tech' / etc.) for a
 * profession. Used by the questionnaire to group the list.
 * @param {string} id
 * @returns {string|null}
 */
export function getProfessionCategory(id) {
  const p = findProfession(id);
  return p ? p.category : null;
}

/**
 * Returns the VAT classification ('osek_morshe', 'osek_patur',
 * 'employee', 'employer') for a profession. Used by the invoice
 * generator + lifecycle prompts ("רוצה לרשום חשבונית מס?").
 * @param {string} id
 * @returns {string|null}
 */
export function getProfessionVat(id) {
  const p = findProfession(id);
  return p ? p.vat : null;
}

/**
 * Returns the template_extras array (e.g. ['tip_jar', 'gear_depreciation'])
 * for a profession. Empty array for unknown ids.
 * @param {string} id
 * @returns {string[]}
 */
export function getProfessionTemplateExtras(id) {
  const p = findProfession(id);
  return p && Array.isArray(p.template_extras) ? p.template_extras.slice() : [];
}

/**
 * Returns a compact summary string for logging: "קבלן בניין (construction, osek_morshe)".
 * @param {string} id
 * @returns {string}
 */
export function describeProfession(id) {
  const p = findProfession(id);
  if (!p) return id ? `unknown(${id})` : 'none';
  return `${p.he} (${p.category}, ${p.vat})`;
}

// ─── Bot-friendly groupings ────────────────────────────────────────────

// Top-of-mind professions to show as quick-pick chips in the bot's
// onboarding question (before the user has to scroll a long list).
// Picked to cover the most common Israeli self-employed + employee
// types. Order = display order.
export const POPULAR_PROFESSION_IDS = [
  'general_contractor',
  'software_developer_freelance',
  'lawyer',
  'accountant',
  'private_tutor',
  'hairstylist',
  'taxi_driver',
  'cashier',
  'office_worker',
  'other_employee',
];

/**
 * Returns the popular professions as an array of {id, he, category}
 * for the bot's first-pass quick-pick. The user can still ask for
 * "אחר" / "עוד" to see the full catalog.
 * @returns {Array<{id:string, he:string, category:string}>}
 */
export function getPopularProfessions() {
  return POPULAR_PROFESSION_IDS
    .map(function (id) { return findProfession(id); })
    .filter(Boolean)
    .map(function (p) { return { id: p.id, he: p.he, category: p.category }; });
}

/**
 * Returns the full catalog grouped by category, with each entry as
 * {id, he}. Used to build the "see all" picker.
 * @returns {Object<string, Array<{id:string, he:string}>>}
 */
export function getProfessionsGrouped() {
  const out = {};
  PROFESSIONS.forEach(function (p) {
    if (!out[p.category]) out[p.category] = [];
    out[p.category].push({ id: p.id, he: p.he });
  });
  return out;
}
