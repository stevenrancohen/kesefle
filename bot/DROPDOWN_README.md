# Dropdown-for-Unsure (WhatsApp interactive list classifier)

## Feature overview

When `_SRC_classify_v2_(text)` cannot confidently classify a WhatsApp expense
message, the bot replies with a WhatsApp **interactive list** (or, in the
specific personal-vs-business ambiguity, a 3-button quick reply). The user
taps the right category, the bot writes the row to the sheet, and confirms.

What counts as "unsure":

1. `confidence < 70`, OR
2. `needs_question === true`, OR
3. `category == null` while `amount != null` (amount detected, no category match)

Implementation lives in `DROPDOWN_FOR_UNSURE.gs`. Public entry points:

- `isUnsureClassification_(result)` — boolean
- `askUserToClassify_(phone, text, amount, classifyResult)` — sends the dropdown
- `handleUserClassificationReply_(phone, replyText, replyListId)` — resolves
  a pending pick into a writable row object
- `getPendingClassification_(phone)` / `clearPendingClassification_(phone)`
- `sendClassificationConfirmation_(phone, resolved)`

State is stored in `PropertiesService.getUserProperties()` under the key
`pending_classify_<phone>`. TTL is **1 hour**. If a new expense arrives while a
pending pick exists, the old pending is auto-resolved to `שונות / שונות ואחרים`
to avoid losing data, and the user gets a one-line conflict notice before the
new dropdown appears.

## Files

| File | Purpose |
| --- | --- |
| `DROPDOWN_FOR_UNSURE.gs` | All logic: state, payload builders, transport, sample doPost |
| `DROPDOWN_README.md` | This doc |

## Required Script Properties

Set these once in **Project Settings -> Script Properties** of the bot
project `1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo`:

| Key | Value |
| --- | --- |
| `WA_TOKEN` | Meta Graph API permanent access token |
| `WA_PHONE_ID` | Phone-number ID from Meta WhatsApp Business Manager |
| `WA_GRAPH_VERSION` | optional, default `v18.0` |

Do **not** hardcode these in the source.

## Integration: 5–10 line snippet to add to `ExpenseBot.gs`

Inside the existing `doPost(e)` function in `ExpenseBot.gs`, find the place
that currently:

1. parses an incoming WhatsApp text message,
2. calls `_SRC_classify_v2_(body)`,
3. writes the row to the sheet.

Replace the "write the row" branch with the snippet below. It checks pending
state first (so a user's reply to a dropdown is handled), then handles
interactive-list/button replies, then runs the classifier with an unsure check:

```javascript
// --- DROPDOWN INTEGRATION (add inside doPost, after parsing msg) ---
if (msg.type === 'interactive' && msg.interactive) {
  var inter = msg.interactive;
  var rid = (inter.list_reply && inter.list_reply.id) || (inter.button_reply && inter.button_reply.id) || '';
  var r = handleUserClassificationReply_(from, '', rid);
  if (r.ok && r.action === 'resolved') { writeExpenseRow_(r.resolved); sendClassificationConfirmation_(from, r.resolved); }
  return ContentService.createTextOutput('ok');
}
var classified = _SRC_classify_v2_(body);
if (isUnsureClassification_(classified)) { askUserToClassify_(from, body, classified.amount, classified); return ContentService.createTextOutput('asked'); }
writeExpenseRow_({ category: classified.category, subcategory: classified.subcategory, routes_to: classified.routes_to, sheet: classified.sheet, is_income: classified.is_income, amount: classified.amount, original_text: body });
```

The sample function `doPost_DROPDOWN_SAMPLE` at the bottom of
`DROPDOWN_FOR_UNSURE.gs` shows the full end-to-end flow you can copy from if
the existing `doPost` is bare-bones.

Important: the integration assumes a function `writeExpenseRow_(rowObj)`
already exists in `ExpenseBot.gs`. If yours is named differently (e.g.
`appendToTnuot_`, `writeRow_`), search-and-replace the two call sites.

## Test plan

### A. Unit tests inside Apps Script (no WhatsApp needed)

1. Open the bot project, function dropdown -> `TEST_DD_UNSURE_DETECTION`. Run.
   Expected `Logger.log` output:
   ```
   low conf      -> unsure=true
   needs_q true  -> unsure=true
   amount no cat -> unsure=true
   high conf     -> unsure=false
   ```
2. Run `TEST_DD_PENDING_ROUNDTRIP`. Expected:
   ```
   roundtrip: true
   cleared:   true
   ```
3. Run `TEST_DD_PAYLOAD_BUILD`. Expected `sections=5` and a `first row id=`
   starting with `cat::`.

### B. End-to-end with real WhatsApp

Pre-req: webhook deployed, `WA_TOKEN` and `WA_PHONE_ID` set.

1. **Trigger the unsure path.** From your phone, send the bot:
   `45 משהו מוזר`
   This should land on `category == null && amount != null` -> unsure.
   Expected: within 1–2 seconds you receive a WhatsApp message with header
   "לא בטוח איך לסווג" and a "בחר קטגוריה" button. Tap it. You should see
   sections: הוצאות אישיות, הוצאות אישיות / סגנון חיים, הוצאות עסק, הכנסות,
   אחר.
2. **Resolve via list.** Tap "אוכל בחוץ". Expected: the bot replies
   "נשמר: 45 ש"ח, אוכל בחוץ" and a new row appears in the תנועות sheet of
   `1UKrXDkdiBwGzrvehacNfWOEvCukNTOAYoyXOIyKW-Qo`.
3. **Resolve via typed text.** Send `60 לא יודע`. When the dropdown arrives,
   reply with the text `אוכל בחוץ`. Bot should still resolve it (free-text
   fallback by exact title match).
4. **Route-only ambiguity.** Send `עסק 45 וולט` (biz prefix on a personal
   keyword). Classifier returns `needs_question: true`. You should get a
   3-button reply: `אישי` / `עסקי` / `בטל`. Tap `עסקי`. Row should be written
   to `מאזן חברה`.
5. **Cancel.** Trigger the dropdown then tap "בטל". Expected: a "בוטל." message
   and **no** new row in the sheet. Verify with `getPendingClassification_(yourPhone)`
   in the Apps Script REPL returns `null`.
6. **Expiry.** Send an unsure expense, do not reply for 61 minutes, then send
   text `אוכל בחוץ`. Expected: bot treats it as a brand new expense, runs
   classifier, writes a row with amount=null (or asks again if unsure).
7. **Conflict.** Send `45 לא ברור` (do not reply). Then send `30 קפה`. Expected:
   you receive a conflict notice mentioning the previous one was saved as
   "שונות", AND a new high-confidence write happens for the קפה (אוכל בחוץ).
   Sheet should now have two rows.

### C. Sanity checks

- Inspect Apps Script execution log: every `_DD_sendWhatsApp_` call should
  return HTTP 200. A 401 means `WA_TOKEN` is wrong; 400 with `(#100)` means
  payload shape is off (commonly: row title > 24 chars — handled by
  `_DD_truncate_` but worth checking).
- `PropertiesService.getUserProperties().getKeys()` should never accumulate
  more than ~5 `pending_classify_*` keys; if it does, run a one-off purge.

## Notes & limitations

- WhatsApp `list_reply.id` has a hard 200-char cap. Our ids look like
  `cat::עסק_חומרי_גלם` — well under the limit.
- Row titles cap at 24 chars, descriptions at 72 — enforced via
  `_DD_truncate_`.
- The catalog `DD_CATALOG` is a curated subset of `KESEFLE_KEYWORDS` (we skip
  rarely-needed buckets like `ביטוחים`, `לימודים`, `אבא`, `לוטו`, `BMW_S1000`,
  `ליים` to keep the picker scannable). If you want them shown, add them to
  the appropriate group array in `DROPDOWN_FOR_UNSURE.gs`.
- The bot only auto-resolves a stale pending when a new expense arrives.
  Stale entries that never get displaced will simply expire after 1 hour and
  not write anything.
