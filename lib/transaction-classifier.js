// lib/transaction-classifier.js
//
// Small, deterministic, zero-cost classifier for the web-entry and bank-CSV
// paths. It intentionally contains only high-confidence Israeli merchants and
// explicit financial phrases. Unknown text returns null so callers can use a
// visible catch-all instead of guessing.

import { findGroupForSubcategory } from './categories.js';

const RULES = [
  // Food / groceries.
  { keyword: 'סופר פארם', subcategory: 'פארמה וטואלטיקה', direction: 'expense' },
  { keyword: 'שופרסל', subcategory: 'מזון', direction: 'expense' },
  { keyword: 'רמי לוי', subcategory: 'מזון', direction: 'expense' },
  { keyword: 'יוחננוף', subcategory: 'מזון', direction: 'expense' },
  { keyword: 'ויקטורי', subcategory: 'מזון', direction: 'expense' },
  { keyword: 'אושר עד', subcategory: 'מזון', direction: 'expense' },
  { keyword: 'טיב טעם', subcategory: 'מזון', direction: 'expense' },
  { keyword: 'מגה', subcategory: 'מזון', direction: 'expense' },
  { keyword: 'סופר', subcategory: 'מזון', direction: 'expense' },
  { keyword: 'be פארם', subcategory: 'פארמה וטואלטיקה', direction: 'expense' },

  // Restaurants / eating out.
  { keyword: 'מקדונלד', subcategory: 'מסעדה ואוכל בחוץ', direction: 'expense' },
  { keyword: 'בורגר', subcategory: 'מסעדה ואוכל בחוץ', direction: 'expense' },
  { keyword: 'דומינו', subcategory: 'מסעדה ואוכל בחוץ', direction: 'expense' },
  { keyword: 'מסעדה', subcategory: 'מסעדה ואוכל בחוץ', direction: 'expense' },
  { keyword: 'פיצה', subcategory: 'מסעדה ואוכל בחוץ', direction: 'expense' },
  { keyword: 'ארומה', subcategory: 'מסעדה ואוכל בחוץ', direction: 'expense' },
  { keyword: 'קפה', subcategory: 'מסעדה ואוכל בחוץ', direction: 'expense' },
  { keyword: 'wolt', subcategory: 'מסעדה ואוכל בחוץ', direction: 'expense' },
  { keyword: '10bis', subcategory: 'מסעדה ואוכל בחוץ', direction: 'expense' },

  // Transport.
  { keyword: 'רכבת ישראל', subcategory: 'תחבורה ציבורית', direction: 'expense' },
  { keyword: 'תחבורה ציבורית', subcategory: 'תחבורה ציבורית', direction: 'expense' },
  { keyword: 'כביש 6', subcategory: 'כבישי אגרה', direction: 'expense' },
  { keyword: 'דור אלון', subcategory: 'דלק', direction: 'expense' },
  { keyword: 'רב קו', subcategory: 'תחבורה ציבורית', direction: 'expense' },
  { keyword: 'חניון', subcategory: 'חניה', direction: 'expense' },
  { keyword: 'חניה', subcategory: 'חניה', direction: 'expense' },
  { keyword: 'אגרה', subcategory: 'כבישי אגרה', direction: 'expense' },
  { keyword: 'סונול', subcategory: 'דלק', direction: 'expense' },
  { keyword: 'דלק', subcategory: 'דלק', direction: 'expense' },
  { keyword: 'פז', subcategory: 'דלק', direction: 'expense' },
  { keyword: 'אגד', subcategory: 'תחבורה ציבורית', direction: 'expense' },

  // Housing / utilities.
  { keyword: 'חברת חשמל', subcategory: 'חשמל', direction: 'expense' },
  { keyword: 'מי אביבים', subcategory: 'מים וביוב', direction: 'expense' },
  { keyword: 'תאגיד מים', subcategory: 'מים וביוב', direction: 'expense' },
  { keyword: 'ועד בית', subcategory: 'מיסי ישוב / ועד בית', direction: 'expense' },
  { keyword: 'שכר דירה', subcategory: 'שכר דירה', direction: 'expense' },
  { keyword: 'משכנתה', subcategory: 'משכנתה', direction: 'expense' },
  { keyword: 'ארנונה', subcategory: 'ארנונה', direction: 'expense' },
  { keyword: 'חשמל', subcategory: 'חשמל', direction: 'expense' },
  // Kept only for the legacy bank-import matcher: too broad for free text.
  { keyword: 'מים', subcategory: 'מים וביוב', direction: 'expense', legacyOnly: true },

  // Communication.
  { keyword: 'פרטנר', subcategory: 'טלפון נייד ונייח', direction: 'expense' },
  { keyword: 'סלקום', subcategory: 'טלפון נייד ונייח', direction: 'expense' },
  { keyword: 'פלאפון', subcategory: 'טלפון נייד ונייח', direction: 'expense' },
  { keyword: 'netflix', subcategory: 'שירותי תוכן', direction: 'expense' },
  { keyword: 'spotify', subcategory: 'שירותי תוכן', direction: 'expense' },
  { keyword: 'בזק', subcategory: 'טלויזיה ואינטרנט (ספק ותשתית)', direction: 'expense' },
  { keyword: 'הוט', subcategory: 'טלויזיה ואינטרנט (ספק ותשתית)', direction: 'expense' },
  { keyword: 'יס', subcategory: 'טלויזיה ואינטרנט (ספק ותשתית)', direction: 'expense', legacyOnly: true },

  // Income. The caller's explicit income/expense toggle is authoritative, so
  // "שכר עובדים" entered as an expense can never be flipped to salary.
  { keyword: 'שכר דירה', subcategory: 'הכנסה מנכס', direction: 'income' },
  { keyword: 'החזר ביטוח לאומי', subcategory: 'קצבת ילדים', direction: 'income' },
  { keyword: 'ביטוח לאומי', subcategory: 'קצבת ילדים', direction: 'income' },
  { keyword: 'משכורת', subcategory: 'שכר עבודה 1', direction: 'income' },
  { keyword: 'קצבת', subcategory: 'קצבת ילדים', direction: 'income' },
  { keyword: 'שכר', subcategory: 'שכר עבודה 1', direction: 'income' },
];

const SORTED_RULES = RULES
  .map((rule) => ({ ...rule, keyword: rule.keyword.toLowerCase() }))
  .sort((a, b) => b.keyword.length - a.keyword.length);

// The simple mobile dashboard uses a smaller set of row labels than the
// canonical Pa'amonim taxonomy. Keep both values: the bank importer retains
// the canonical subcategory, while the web writer can store the exact visible
// dashboard row and deliver a useful first insight immediately.
const DASHBOARD_SUBCATEGORY = {
  'מזון': 'אוכל לבית',
  'פארמה וטואלטיקה': 'תרופות',
  'מסעדה ואוכל בחוץ': 'אוכל בחוץ',
  'טלפון נייד ונייח': 'תקשורת',
  'טלויזיה ואינטרנט (ספק ותשתית)': 'תקשורת',
  'שירותי תוכן': 'מנויים דיגיטליים',
  'מיסי ישוב / ועד בית': 'בית',
  'ארנונה': 'בית',
  'משכנתה': 'בית',
  'שכר דירה': 'בית',
  'שכר עבודה 1': 'הכנסה 1 — משכורת',
  'קצבת ילדים': 'הכנסה 3 — נוסף',
  'הכנסה מנכס': 'הכנסה 3 — נוסף',
};

function normalizeDescription(value) {
  return String(value || '')
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function containsKeyword(text, keyword) {
  // Very short substrings (פז, שכר, הוט...) otherwise create noisy matches
  // inside unrelated Hebrew words. Require token boundaries for <=3 chars;
  // longer merchant/phrase rules remain substring-based to tolerate the
  // prefixes and suffixes common in bank exports.
  if ([...keyword].length > 3) return text.includes(keyword);
  let index = text.indexOf(keyword);
  const wordChar = /[\p{L}\p{N}]/u;
  while (index >= 0) {
    const before = index > 0 ? text[index - 1] : '';
    const after = text[index + keyword.length] || '';
    if ((!before || !wordChar.test(before)) && (!after || !wordChar.test(after))) return true;
    index = text.indexOf(keyword, index + keyword.length);
  }
  return false;
}

/**
 * Return a high-confidence classification or null.
 *
 * `legacyDirection` exists only so the existing bank importer can preserve
 * its historical cross-direction matching while sharing this table. New
 * interactive callers must keep the default false.
 */
export function classifyTransactionDescription(description, {
  isIncome = false,
  legacyDirection = false,
} = {}) {
  const text = normalizeDescription(description);
  if (text.length < 2) return null;
  const direction = isIncome ? 'income' : 'expense';

  for (const rule of SORTED_RULES) {
    if (!legacyDirection && rule.legacyOnly) continue;
    if (!legacyDirection && rule.direction !== direction) continue;
    if (!(legacyDirection ? text.includes(rule.keyword) : containsKeyword(text, rule.keyword))) continue;
    const category = findGroupForSubcategory(rule.subcategory);
    if (!category) return null;
    return {
      category,
      subcategory: rule.subcategory,
      dashboardSubcategory: DASHBOARD_SUBCATEGORY[rule.subcategory] || rule.subcategory,
      source: 'keyword',
      confidence: 'high',
    };
  }
  return null;
}

export const __test = {
  normalizeDescription,
  containsKeyword,
  ruleCount: SORTED_RULES.length,
};
