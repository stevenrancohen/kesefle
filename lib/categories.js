// lib/categories.js
//
// Single source of truth for Kesefle's expense + income category taxonomy.
// Adopted from Pa'amonim's "רשימת הסעיפים" (the de-facto Israeli household
// budgeting standard) -- Steven's brief 2026-05-24. Used by:
//   - lib/sheet-writer.js (rows in the personal dashboard tab + pie charts)
//   - bot/ExpenseBot_FIXED.gs classifier (top-level + subcategory routing)
//   - api/admin/* (category-aware admin reports)
//
// Layout:
//   EXPENSE_GROUPS: array of { label, key, color, items: [string] }
//   INCOME_GROUPS:  same shape, for income side of the dashboard
//
// Adding a new sub-category? Just append to the `items` array. The
// dashboard rebuilds itself; the bot's free-text matcher still works
// because it matches HIERARCHICAL strings ("חינוך / בית ספר"), the row
// labels in the sheet are the same strings, and SUMIFS on col E exact-
// matches them.

export const EXPENSE_GROUPS = [
  {
    label: 'מזון ופארמה',
    key: 'food_pharma',
    icon: '🍞',
    items: ['מזון', 'פארמה וטואלטיקה', 'בר מים', 'אוכל מוכן / בעבודה', 'עישון', 'מזון ופארמה - כללי'],
  },
  {
    label: 'פנאי, בילוי ותחביבים',
    key: 'leisure',
    icon: '🎬',
    items: ['מסעדה ואוכל בחוץ', 'ספורט', 'חופשות', 'בילויים ומופעים', 'חיות מחמד', 'חוגי מבוגרים', 'בייביסיטר', 'הגרלות', 'פנאי - כללי'],
  },
  {
    label: 'ביגוד והנעלה',
    key: 'clothing',
    icon: '👕',
    items: ['ביגוד הורים', 'ביגוד ילדים', 'נעליים', 'ביגוד והנעלה - כללי'],
  },
  {
    label: 'תכולת בית',
    key: 'household_goods',
    icon: '🛋️',
    items: ['ריהוט', 'מוצרי חשמל ואלקטרוניקה', 'משחקים, צעצועים וספרים', 'כלי בית', 'תכולת בית - כללי'],
  },
  {
    label: 'אחזקת בית',
    key: 'home_maintenance',
    icon: '🏠',
    items: ['חשמל', 'מים וביוב', 'גז', 'ניקיון', 'תיקונים בבית / במכשירים', 'גינה', 'אחזקת בית - כללי'],
  },
  {
    label: 'טיפוח',
    key: 'grooming',
    icon: '💇',
    items: ['מספרה', 'קוסמטיקה', 'טיפוח - כללי'],
  },
  {
    label: 'חינוך',
    key: 'education',
    icon: '🎓',
    items: ['בית ספר', 'מסגרות צהריים', 'מסגרות יום', 'צהרון / מטפלת', 'הסעות', 'שיעור פרטי', 'מסגרות קיץ', 'חוגים ותנועת נוער', 'לימודים והשתלמות לבוגרים', 'חינוך - כללי'],
  },
  {
    label: 'אירועים, תרומות, צרכי דת',
    key: 'events_charity',
    icon: '🎁',
    items: ['חגים וצרכי דת', 'אירוע בעבודה / לחברים', 'תרומות'],
  },
  {
    label: 'בריאות',
    key: 'health',
    icon: '🩺',
    items: ['קופ"ח תשלום קבוע', 'ביטוח רפואי נוסף', 'טיפולים פרטיים', 'תרופות', 'טיפולי שיניים', 'אופטיקה', 'בריאות - כללי'],
  },
  {
    label: 'תחבורה',
    key: 'transport',
    icon: '🚗',
    items: ['דלק', 'חניה', 'כבישי אגרה', 'ביטוח רכב', 'תחזוקת רכב', 'תחבורה ציבורית', 'רישוי רכב', 'תחבורה שיתופית', 'ליסינג', 'תחבורה - כללי'],
  },
  {
    label: 'משפחה',
    key: 'family',
    icon: '👨‍👩‍👧',
    items: ['אירועי שמחות במשפחה', 'דמי כיס', 'עזרה למשפחה', 'תשלום מזונות', 'משפחה - כללי'],
  },
  {
    label: 'תקשורת',
    key: 'communication',
    icon: '📱',
    items: ['טלפון נייד ונייח', 'טלויזיה ואינטרנט (ספק ותשתית)', 'שירותי תוכן', 'מנויים', 'תקשורת - כללי'],
  },
  {
    label: 'דיור',
    key: 'housing',
    icon: '🏘️',
    items: ['משכנתה', 'שכר דירה', 'מיסי ישוב / ועד בית', 'ארנונה', 'ביטוח נכס ותכולה', 'דיור - כללי'],
  },
  {
    label: 'התחייבויות',
    key: 'liabilities',
    icon: '💳',
    items: ['החזר חובות חודשי (למעט משכנתה) - כללי', 'ריביות משיכת יתר'],
  },
  {
    label: 'נכסים',
    key: 'assets_savings',
    icon: '💰',
    items: ['הפקדות לחסכונות - כללי'],
  },
  {
    label: 'פיננסים',
    key: 'financial',
    icon: '🏦',
    items: ['עמלות', 'ביטוח חיים', 'ביטוח לאומי (למי שלא עובד)', 'פיננסים - כללי'],
  },
];

export const INCOME_GROUPS = [
  {
    label: 'שכר',
    key: 'salary',
    icon: '💼',
    items: ['שכר עבודה 1', 'שכר עבודה 2', 'שכר עבודה 3', 'שכר עבודה 4', 'שכר - כללי'],
  },
  {
    label: 'קצבאות',
    key: 'benefits',
    icon: '🤝',
    items: ['קצבת ילדים', 'קצבת נכות', 'סיוע בשכר דירה', 'קצבת זיקנה', 'קצבאות - כללי'],
  },
  {
    label: 'הכנסות שונות',
    key: 'misc_income',
    icon: '💵',
    items: ['קבלת מזונות', 'הכנסה מנכס', 'עזרה מההורים', 'הכנסות שונות - כללי'],
  },
];

// Flat lookup helpers -------------------------------------------------------

export const ALL_EXPENSE_TOPLEVEL = EXPENSE_GROUPS.map(g => g.label);
export const ALL_INCOME_TOPLEVEL = INCOME_GROUPS.map(g => g.label);
export const ALL_EXPENSE_SUBCATEGORIES = EXPENSE_GROUPS.flatMap(g => g.items);
export const ALL_INCOME_SUBCATEGORIES = INCOME_GROUPS.flatMap(g => g.items);

// Returns the top-level group label for a given subcategory, or null.
//   findGroupForSubcategory('מספרה') -> 'טיפוח'
export function findGroupForSubcategory(sub) {
  if (!sub) return null;
  for (const g of EXPENSE_GROUPS) if (g.items.includes(sub)) return g.label;
  for (const g of INCOME_GROUPS)  if (g.items.includes(sub)) return g.label;
  return null;
}

// Returns whether the given top-level label is an INCOME group.
export function isIncomeGroup(label) {
  return INCOME_GROUPS.some(g => g.label === label);
}

// Total count for sanity-checking the dashboard layout.
export const TOTAL_EXPENSE_SUBCATEGORIES = ALL_EXPENSE_SUBCATEGORIES.length;
export const TOTAL_INCOME_SUBCATEGORIES = ALL_INCOME_SUBCATEGORIES.length;
