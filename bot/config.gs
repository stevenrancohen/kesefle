/**
 * ⚙️ קובץ הגדרות — Kesefle Bot Config
 * ====================================
 * Constants shared across the bot's command surface (personal + family modes).
 * Apps Script's V8 runtime auto-merges all .gs files in the project, so the
 * `var` declarations below are visible to ExpenseBot_FIXED.gs without import.
 *
 * --------------------------------------------------------------------
 * DUPLICATE TEMPLATE STEPS (one-time, by Steven):
 *   1. Open the master template Google Sheet
 *      (https://docs.google.com/spreadsheets/d/1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo/edit)
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

var PERSONAL_TEMPLATE_SHEET_ID = '1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A';

var FAMILY_TEMPLATE_SHEET_ID = 'REPLACE_WITH_FAMILY_TEMPLATE_ID';

var BOT_PHONE_NUMBER_ID = '1090404180828069';

var VERCEL_KV_REST_URL_PROP = 'VERCEL_KV_REST_URL';
var VERCEL_KV_REST_TOKEN_PROP = 'VERCEL_KV_REST_TOKEN';
