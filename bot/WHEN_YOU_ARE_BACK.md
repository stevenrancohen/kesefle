# When you're back — paste session (15 min total)

You have 2 files to paste into Apps Script. **Do them in this order** — do NOT skip the manual `Cmd+S` step, that's the only thing that actually saves to Google's servers.

---

## Paste 1 — `KESEFLE_ALL_PATCHES.gs` (213 lines)

Contains: keywords (700+), `_SRC_classify_v2_` classifier, `TEST_CLASSIFIER`, `SORT_TNUOT_NEWEST_FIRST`, `ADD_CHECKMARK_COLUMN`, `INSTALL_NEWEST_FIRST_TRIGGER`, `_AUTO_SORT_TNUOT_`, `UNINSTALL_NEWEST_FIRST_TRIGGER`, `VERIFY_SORT_AND_FEATURES`.

**Steps:**
1. Open Apps Script editor: https://script.google.com/d/1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo/edit
2. If you see unsaved changes from the prior failed automation — **discard** them (`Cmd+R` → "Discard").
3. Click **`+`** (top-left, next to "קבצים") → **"סקריפט"** → name: `KESEFLE_ALL_PATCHES` → Enter.
4. Open `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/KESEFLE_ALL_PATCHES.gs` in **TextEdit** (right-click → Open With → TextEdit; if asked, accept "convert to plain text").
5. In TextEdit: `Cmd+A` → `Cmd+C`.
6. Back in Apps Script — click in the new file's editor → `Cmd+A` → **Delete** → `Cmd+V`.
7. **Press `Cmd+S` on your real keyboard** (this is what was missing in my automation).
8. Function dropdown should now show: `TEST_CLASSIFIER`, `SORT_TNUOT_NEWEST_FIRST`, `ADD_CHECKMARK_COLUMN`, `INSTALL_NEWEST_FIRST_TRIGGER`, `VERIFY_SORT_AND_FEATURES`.
9. Run in order:
   - `TEST_CLASSIFIER` → expect 6/6 in logs
   - `SORT_TNUOT_NEWEST_FIRST` → expect popup "Sorted X rows newest-first. Backup: _BAK_tnuot_..."
   - `ADD_CHECKMARK_COLUMN` → expect "Added checkmark to X rows"
   - `INSTALL_NEWEST_FIRST_TRIGGER` → expect "Auto-sort installed"
   - `VERIFY_SORT_AND_FEATURES` → expect summary popup

After this, open the `תנועות` tab — newest entry should be at row 2 with ✅ in col H.

---

## Paste 2 — `DROPDOWN_FOR_UNSURE.gs` (631 lines)

Contains: `askUserToClassify_`, `handleUserClassificationReply_`, state cache helpers, sample `doPost` integration snippet.

**Prerequisite:** WhatsApp Cloud API token + phone number ID must be in Script Properties (`WA_TOKEN`, `WA_PHONE_ID`). To set them:
- Apps Script editor → settings cog (⚙️) bottom-left → "Project Settings" → "Script Properties" → "Edit script properties" → Add `WA_TOKEN` + `WA_PHONE_ID` rows.

**Steps:**
1. Click **`+`** → **"סקריפט"** → name: `DROPDOWN_FOR_UNSURE` → Enter.
2. TextEdit: open `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/bot/DROPDOWN_FOR_UNSURE.gs` → `Cmd+A` → `Cmd+C`.
3. Apps Script: in new file → `Cmd+A` → **Delete** → `Cmd+V` → **`Cmd+S`**.
4. Run `TEST_DD_INTERACTIVE_LIST` from function dropdown to send yourself a test list message. You should receive a WhatsApp message titled "צריך אישור".

---

## Wire dropdown into the live bot (5–10 lines)

Open `ExpenseBot.gs` → find `function doPost(e)` → add this block right after `body` is parsed (look at `bot/DROPDOWN_README.md` for the exact snippet):

```javascript
if (msg.type === 'interactive' && msg.interactive) {
  var inter = msg.interactive;
  var rid = (inter.list_reply && inter.list_reply.id) || (inter.button_reply && inter.button_reply.id) || '';
  var r = handleUserClassificationReply_(from, '', rid);
  if (r.ok && r.action === 'resolved') { writeExpenseRow_(r.resolved); sendClassificationConfirmation_(from, r.resolved); }
  return ContentService.createTextOutput('ok');
}
var classified = _SRC_classify_v2_(body);
if (isUnsureClassification_(classified)) { askUserToClassify_(from, body, classified.amount, classified); return ContentService.createTextOutput('asked'); }
// ... existing write logic continues as before
```

`Cmd+S` to save.

---

## Verify end-to-end

Send these WhatsApp messages to the bot one at a time:

| Send | Expected behavior |
|------|------|
| `245 סופר` | Auto-routes to אוכל לבית in תנועות, new row at top with ✅ |
| `42 קפה` | Auto-routes to אוכל בחוץ |
| `300 פייסבוק` | **Bot replies with WhatsApp dropdown asking personal-or-business** (this is the new feature) |
| Pick "עסק - שיווק" from dropdown | Bot writes to מאזן חברה, confirms with ✅ |

Once confirmed working, tell me and I'll:
1. Re-add the V2_OBSERVE → V2_SWITCH patch (v2 takes over from legacy when conf≥70)
2. Help spec the next set of features

---

## What's already deployed (you don't need to do anything for these)

- ✅ Sheet dashboard fix: 2023/2024/2025 net profit recomputed, 2023 משלוחים spread monthly
- ✅ Website at https://kesefle.vercel.app: dark mode works, real WhatsApp number, voice modal removed, og-image present, OAuth scopes documented, robots/sitemap/canonical/JSON-LD all live
- ✅ Test suite at https://kesefle.vercel.app/test: 31 automated checks
- ✅ Google OAuth test users added (you did this earlier)

**Last live deploy:** commit [1bcb040](https://github.com/stevenrancohen/kesefle/commit/1bcb040).
