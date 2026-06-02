/**
 * ⚙️ קובץ הגדרות — Kesefle Bot Config
 * ====================================
 * Constants shared across the bot's command surface (personal + family modes).
 * Apps Script's V8 runtime auto-merges all .gs files in the project, so the
 * `var` declarations below are visible to ExpenseBot_FIXED.gs without import.
 *
 * --------------------------------------------------------------------
 * SHEET CREATION MODEL (as of 2026-05-30):
 *   - Personal sheets: created FRESH per user by the Vercel /api/sheet/provision
 *     endpoint (lib/sheet-writer.js → createUserSheetWithToken). No template
 *     copy — minimal OAuth scope (drive.file) requires app-created files.
 *     PERSONAL_TEMPLATE_SHEET_ID below is legacy and used only by old bot
 *     fallback paths; new signups never touch it.
 *   - Family sheets: still copy from FAMILY_TEMPLATE_SHEET_ID via Apps Script
 *     DriveApp.makeCopy (see _familyCreate_ in ExpenseBot_FIXED.gs). If the
 *     placeholder is left as-is, the bot returns a "תבנית משפחה לא הוגדרה"
 *     reply instead of crashing.
 *
 * TO PROVISION A FAMILY TEMPLATE (one-time, by Steven):
 *   1. Open the master template Google Sheet
 *      (current PERSONAL_TEMPLATE_SHEET_ID below)
 *   2. File → Make a copy → name 'Kesefle Family Budget Template'
 *   3. On the main expenses log tab, insert a column 'Member'
 *      immediately after 'Date'
 *   4. Rename that tab to 'Family Budget'
 *   5. Share → Anyone with the link → Viewer
 *      (so future families can copy)
 *   6. Copy the new Sheet ID from the URL and paste it into
 *      FAMILY_TEMPLATE_SHEET_ID below
 * --------------------------------------------------------------------
 */

// Legacy personal template ID. The active provisioning path creates fresh
// sheets in lib/sheet-writer.js — this constant is referenced only by old
// bot fallback paths and kept for backward compatibility.
var PERSONAL_TEMPLATE_SHEET_ID = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';

// TODO(steven): provision a family template per the steps in the header
// comment above, then replace this placeholder with the real Sheet ID.
// Until then, family-create requests get a graceful "template not
// configured" reply (see _familyCreate_ in ExpenseBot_FIXED.gs).
var FAMILY_TEMPLATE_SHEET_ID = 'REPLACE_WITH_FAMILY_TEMPLATE_ID';

var BOT_PHONE_NUMBER_ID = '1090404180828069';

var VERCEL_KV_REST_URL_PROP = 'VERCEL_KV_REST_URL';
var VERCEL_KV_REST_TOKEN_PROP = 'VERCEL_KV_REST_TOKEN';
