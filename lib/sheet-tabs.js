// lib/sheet-tabs.js — single source of truth for the Hebrew tab (worksheet)
// names of a Kesefle tenant Google Sheet.
//
// WHY THIS FILE EXISTS
// --------------------
// These tab names were previously hardcoded as bare string literals in ~10+
// places across lib/ and api/ (e.g. `const TX_TAB = '<txTab>'` re-declared in
// four different endpoints, plus inline `'<txTab>'!A2:I5001` A1-notation
// ranges). A single silent rename of a tab would break sheet reads/writes in
// some files while leaving stale copies elsewhere — a classic
// duplicated-constant footgun. Centralizing here means a rename is a one-line
// change with a clear blast radius.
//
// INVARIANT (do not break):
//   The string VALUES below are load-bearing. They must stay byte-identical to
//   the actual worksheet titles inside every tenant's Google Sheet AND to the
//   tab names the Apps Script bot (bot/ExpenseBot_FIXED.gs) writes to. Changing
//   a value here without renaming every existing tenant tab (and the bot) will
//   silently send writes to a non-existent tab. If you ever DO rename a tab,
//   change it here and migrate every tenant sheet + the bot in the same ship.
//
// The bot .gs files are a SEPARATE Apps Script runtime and cannot import this
// module; they keep their own literals. This module is the source of truth for
// the Node side (lib/ + api/) only.

// ── Canonical tab names ──────────────────────────────────────────────────────
// Transactions log — the bot appends one row per expense/income here (A:I).
const TX_TAB = 'תנועות';
// Orders/sales log — business & group sale rows (A:H).
const ORDERS_TAB = 'הזמנות';
// Personal dashboard (income/expense summary the user opens first).
const PERSONAL_DASHBOARD_TAB = 'מאזן אישי';
// Company dashboard (revenue + business-expense P&L).
const COMPANY_DASHBOARD_TAB = 'מאזן חברה';
// Extended granular breakdown dashboard.
const EXTENDED_DASHBOARD_TAB = 'פירוט מורחב';
// Shared group-expense ledger.
const GROUP_LEDGER_TAB = 'הוצאות קבוצה';

// Frozen lookup object for ergonomic, typo-resistant access:
//   import { SHEET_TABS } from '.../lib/sheet-tabs.js';
//   SHEET_TABS.TRANSACTIONS  // 'תנועות'
const SHEET_TABS = Object.freeze({
  TRANSACTIONS: TX_TAB,
  ORDERS: ORDERS_TAB,
  PERSONAL: PERSONAL_DASHBOARD_TAB,
  COMPANY: COMPANY_DASHBOARD_TAB,
  EXTENDED: EXTENDED_DASHBOARD_TAB,
  GROUP_LEDGER: GROUP_LEDGER_TAB,
});

export {
  SHEET_TABS,
  TX_TAB,
  ORDERS_TAB,
  PERSONAL_DASHBOARD_TAB,
  COMPANY_DASHBOARD_TAB,
  EXTENDED_DASHBOARD_TAB,
  GROUP_LEDGER_TAB,
};
