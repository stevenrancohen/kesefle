# Bot improvements — Batch 2 (Monday: 3 bot-file fixes) — 2026-06-02

Three Monday items, each verified against the LIVE `bot/ExpenseBot_FIXED.gs`
(HEAD at the time of writing). For each I traced the actual code path (and,
where a parser was involved, replayed the real extracted functions in Node),
then prescribed the EXACT additive fix to apply in the next bot re-paste.

**Why the bot source is NOT edited in this PR:** a separate change is already
pending in `bot/ExpenseBot_FIXED.gs` / `bot/ExpenseBot_DEPLOY.gs`. Editing those
files here would create a merge conflict against that pending work. So this PR
ships only this prescription document. Apply the fixes below in the same
re-paste that resolves the pending edit.

Every fix below is **additive and non-destructive**: it ADDS a guard / a new
handler / a couple of router lines. It never removes, re-orders, or rewrites
existing logic, never touches another tenant's data (all new writes reuse the
existing per-owner KV keys + the owner-gated business helpers), and keeps every
Hebrew string RTL-correct.

---

## Verification summary

| # | Monday item | Status in current code | Action |
|---|---|---|---|
| 1 | `יעד חדש 1/2/3/4` reply "1" saved as ₪1 | **ALREADY FIXED** (2026-06-01) + has a behavioral test | No re-paste change. Regression-protection note only. |
| 2 | budget-intent guard (`2000 שח` must not parse as ₪2) | "₪2" mis-parse does NOT reproduce; a DIFFERENT real bug exists (budget phrases booked as a phantom expense) | Add `_handleBudgetIntentGuard_` (drop-in below) |
| 3 | Bot Command System Polish | Partially present; 4 verbs missing | Add `_handleBusinessAdminCommand_` + 2 aliases (drop-in below) |

---

## ITEM 1 — `יעד חדש 1/2/3/4` → ₪1 expense  ▸  ALREADY FIXED

**Verified fixed.** The bug (a bare `1`/`2`/`3`/`4` reply to the "יעד חדש"
prompt hitting the doPost expense FAST-PATH `^\s*\d` and being written as a
1-shekel expense) was fixed on 2026-06-01. In the current source:

- Pending-state helpers exist: `_objPendKey_` / `_objPendGet_` / `_objPendSet_`
  / `_objPendClear_` (CacheService, 15-min TTL) — around line 4654.
- Both prompt sites (`_handleObjectiveCommand_`: bare `יעד חדש` ~L11659, and
  the one-shot-missing-horizon branch ~L11617) call `_objPendSet_(clean, ...)`.
- The dispatcher `_handleObjectivePendingReply_` (~L11692) is wired into
  `doPost` **BEFORE** the expense fast-path (~L2254). It consumes an
  END-ANCHORED `^[1-4]$` reply and the follow-up goal text, and critically
  returns `{handled:false}` for `"1 קפה"` (NOT end-anchored) so a real expense
  still books exactly as before.
- A dedicated behavioral test loads the REAL helpers and asserts the routing:
  `bot/test_objective_pending_dispatch.js` (9 cases, all PASS).

Confirmed `node bot/test_objective_pending_dispatch.js` → `OK: all assertions
passed`, and `node bot/test_objective_commands.js` → PASS.

**Re-paste action: NONE for the fix itself.** The single thing that matters is
**do not regress it** during the pending re-paste. Concretely, when reassembling
the file, the `doPost` block at ~L2246 (`=== PENDING OBJECTIVE REPLY (2026-06-01
FIX) ===`) MUST stay **above** the `var __looksLikeExpense = /^\s*\d/...`
fast-path line (~L2271). If those two blocks get re-ordered, the bug returns.

Optional hardening (only if you want belt-and-suspenders — NOT required):
the fast-path itself could also defer to the pending dispatcher. But since the
dispatcher already runs first, this is redundant; leave it unless the ordering
guarantee above is hard to preserve in the re-paste.

---

## ITEM 2 — budget-intent guard

### What I actually found (the Monday wording is half-right)

The literal claim "`2000 שח` parses as ₪2" does **NOT** reproduce. I replayed
the REAL extracted `parseAmountAndDescription` + `_parseIsraeliNumber_` in Node:

```
"2000 שח"        -> amount=2000  note="ללא פירוט"   ✅ correct
"2,000 שח"       -> amount=2000  note="ללא פירוט"   ✅ correct (comma=thousands)
"תקציב 2000 שח"  -> amount=2000  note="תקציב"        ⚠️  booked as a ₪2000 EXPENSE
"2.000 שח"       -> amount=2     note="ללא פירוט"   ⚠️  dot read as decimal -> ₪2
```

So there are TWO distinct real problems, and the Monday note conflates them:

1. **The genuine "budget-intent" bug:** a budget-STATING phrase
   (`תקציב 2000 שח`, `התקציב שלי 2000`, `קבע תקציב חודשי 3000`, `רוצה תקציב 1500`)
   is not caught by any router. It starts with a Hebrew word (so it skips the
   `^\s*\d` fast-path), `_handleBudgetCommand_` only matches the structured
   `יעד תקציב <cat> = <amt>` form and the bare `תקציבים` list — so the phrase
   falls all the way through to `_doPost_orig` → `processExpense`, which books a
   **phantom ₪2000 expense** under the note "תקציב". That is the real damage:
   money the user never spent shows up in their dashboard.

2. **The "₪2" edge:** only `"2.000 שח"` (a DOT used as a thousands separator,
   which is unusual in Israeli input but happens) is read as ₪2. This is a
   separate parser-ambiguity question and is **out of scope** for this guard —
   changing `_parseIsraeliNumber_`'s dot handling risks the well-tested
   `"3.5 לחם"` = ₪3.50 case. Do NOT touch the parser. The guard below catches
   the dangerous *budget* phrasings before they ever reach the parser, which is
   what protects the user.

### The fix — `_handleBudgetIntentGuard_`

A new router that recognises a *budget-stating* message and, instead of
silently booking an expense, asks the user what they meant (set a monthly
budget vs. record an expense). It is intentionally CONSERVATIVE: it only fires
when an explicit budget word (`תקציב` / `תקרה`) co-occurs with an amount and the
message is NOT already a recognised structured budget/goal command. Plain
expenses like `"2000 שכירות"` or `"תקציב"` alone never trigger it.

**Drop-in function** — paste anywhere in the command-handler region (e.g.
directly ABOVE `function _handleBudgetCommand_(fromPhone, text)`):

```javascript
// ── BUDGET-INTENT GUARD (Batch 2, 2026-06-02) ───────────────────────────────
// A message that STATES a budget ("תקציב 2000 שח", "התקציב שלי 2000",
// "קבע תקציב חודשי 3000", "רוצה תקציב 1500 לאוכל") used to fall through every
// router to processExpense and get booked as a PHANTOM expense (note "תקציב",
// amount = the budget figure). That silently corrupts the dashboard with money
// the user never spent. This guard catches the intent BEFORE the expense
// fast-path / processExpense and asks the user what they meant, so nothing is
// written until they confirm. It is deliberately narrow:
//   - fires ONLY when an explicit budget word (תקציב / תקרה) co-occurs with a
//     number; a bare "תקציב" (no amount) is left to _handleBudgetCommand_'s
//     list path, and a plain expense ("2000 שכירות") never matches.
//   - never fires for the already-structured forms ("יעד תקציב X = Y",
//     "תקציבים", "קבע יעד ...") so it can't shadow _handleBudgetCommand_ /
//     _handleGoalCommand_.
// Returns { handled, replyText } or { handled:false } to fall through.
function _handleBudgetIntentGuard_(fromPhone, text) {
  if (!fromPhone || !text) return { handled: false };
  var t = String(text).trim();
  if (!t) return { handled: false };

  // Must mention a budget/cap word. "תקציב"/"תקרה" + optional clitic prefixes.
  if (!/(^|\s)[בלמהו]?(תקציב|תקרה)/.test(t)) return { handled: false };

  // Leave the structured forms to their existing handlers (no shadowing).
  //   "יעד תקציב X = Y"  -> _handleBudgetCommand_ set path
  //   "תקציבים" / "budgets" -> _handleBudgetCommand_ list path
  //   "קבע/הגדר יעד ..."  -> _handleGoalCommand_
  if (/^יעד\s+תקציב\s+[^=]+=\s*\d/.test(t)) return { handled: false };
  if (/^תקציבים$/.test(t) || /^budgets?$/i.test(t)) return { handled: false };
  if (/^(?:קבע|הגדר)\s+יעד\b/.test(t)) return { handled: false };

  // Must carry an amount (so a bare "תקציב" stays a list command, not a guard).
  // Reuse the same Israeli number shape parseAmountAndDescription uses.
  var numM = t.match(/\d{1,3}(?:[,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/);
  if (!numM) return { handled: false };
  var amount = (typeof _parseIsraeliNumber_ === 'function')
    ? _parseIsraeliNumber_(numM[0])
    : parseFloat(String(numM[0]).replace(/,/g, ''));
  if (!isFinite(amount) || amount <= 0) return { handled: false };

  // Optional category: text after "על"/"ל" that isn't a currency word.
  var catM = t.match(/(?:על|ל)\s*([֐-׿A-Za-z'"׳״\-\s]{2,30}?)(?=\s*(?:\d|שח|ש"ח|ש״ח|שקל|₪|$))/);
  var cat = catM ? catM[1].replace(/\s+/g, ' ').trim() : '';
  // Drop a trailing currency word if it leaked into the category capture.
  cat = cat.replace(/\s*(שח|ש"ח|ש״ח|שקל|שקלים|חודשי|בחודש)\s*$/u, '').trim();

  var amtStr = '₪' + Math.round(amount).toLocaleString('he-IL');
  var setCmd = cat
    ? ('יעד תקציב ' + cat + ' = ' + Math.round(amount))
    : ('קבע יעד ' + Math.round(amount));
  // ASCII-escaped Hebrew kept out of code comments; the reply text itself is
  // composed from real Hebrew below so it renders RTL-correct in WhatsApp.
  var lines = [
    '🤔 רגע — זה תקציב או הוצאה?',
    '',
    '🎯 להגדיר תקציב ' + (cat ? ('ל' + cat + ' ') : 'חודשי ') + amtStr + ' — שלח:',
    '   "' + setCmd + '"',
    '',
    '💸 לרשום הוצאה שכבר הוצאת ' + amtStr + ' — שלח:',
    '   "' + Math.round(amount) + (cat ? (' ' + cat) : ' תיאור') + '"',
  ];
  return { handled: true, replyText: lines.join('\n') };
}
```

> Rendered reply (for review — the code above stores these as the SAME glyphs):
> ```
> 🤔 רגע — זה תקציב או הוצאה?
>
> 🎯 להגדיר תקציב לאוכל ₪2,000 — שלח:
>    "יעד תקציב אוכל = 2000"
>
> 💸 לרשום הוצאה שכבר הוצאת ₪2,000 — שלח:
>    "2000 אוכל"
> ```

**Where it goes in `doPost`:** add the router call inside the existing
`if (!__looksLikeExpense) { ... }` block, immediately AFTER the
`_handleBudgetCommand_` block (~L2320) and BEFORE the learning/objective
routers. That ordering means the structured budget commands win first, then
this guard catches the loose phrasings, and only THEN does anything fall through
to processExpense:

```javascript
          // Budget-INTENT guard (Batch 2): catch "תקציב 2000 שח" style phrases
          // that state a budget so they aren't booked as a phantom expense.
          // Runs AFTER _handleBudgetCommand_ (structured forms win first).
          if (typeof _handleBudgetIntentGuard_ === "function" && _isOwnerPhone_(__from_)) {
            try {
              var __biRes = _handleBudgetIntentGuard_(__from_, __text_);
              if (__biRes && __biRes.handled) {
                if (__biRes.replyText && typeof sendWhatsAppMessage === "function") {
                  sendWhatsAppMessage(__from_, __biRes.replyText);
                }
                Logger.log('doPost: budget-intent guard handled');
                return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
              }
            } catch (_biErr) {
              Logger.log('doPost: budget-intent guard error: ' + (_biErr && _biErr.stack || _biErr));
            }
          }
```

**Note on the `^\s*\d` fast-path:** a message that *starts* with the amount and
mentions a budget word (e.g. `"2000 תקציב אוכל"`) would hit the fast-path before
this guard. Those are rare and ambiguous; the safe, owner-gated behaviour is to
catch the common Hebrew-leading phrasings (which this guard does) and leave the
digit-leading form to book as an expense exactly as today. If you want the
digit-leading budget phrasing caught too, move the guard call to run BEFORE the
`var __looksLikeExpense = ...` line — but keep it AFTER the pending-objective
dispatcher so it doesn't interfere with ITEM 1. (Recommended: ship the
conservative placement first.)

**`_isOwnerPhone_` gate:** kept because the structured target it points users
at (`יעד תקציב X = Y`) writes to the owner's `budget:` KV via
`_handleBudgetCommand_`, which is itself owner-gated in doPost (~L2307). Keeping
the same gate avoids advertising a command a tenant can't run.

---

## ITEM 3 — Bot Command System Polish

The Monday item lists 7 commands. Audit of the current source:

| command | present today? | notes |
|---|---|---|
| `עזרה` | ✅ yes | `processExpense` ~L8655 (`עזרה`/`help`/`?`) + `כספלה עזרה` ~L3367 |
| `סטטוס` | ✅ yes | ~L9053 (`סטטוס`/`מצב`/`status`/`health`) |
| `סיכום` | ✅ yes | ~L8817 (`סיכום`/`summary`) |
| `רשימת עסקים` | ⚠️ partial | `_handleMyBusinessesCommand_` matches only `עסקים שלי` / `עסקים` / `my businesses` (~L13773) — NOT `רשימת עסקים` |
| `פתח עסק חדש` | ❌ missing | no explicit open-new-business command; today you must send `עסק 2 <name> - <amt> <desc>` to implicitly create |
| `עבור עסק` | ❌ missing | no "switch active business" command at all |
| `שנה שם עסק` | ❌ missing | rename only happens as a side effect of `עסק N <newname> - <amt>`; no explicit verb |

So the polish is: (a) add `רשימת עסקים` as an alias, and (b) add a small
business-admin command router for the 3 missing verbs. Both REUSE the existing,
already-tested helpers (`_getOrCreateBusinessTab_`, `_writeBusinessNExpense_`,
the `biz:<phone>:<n>` + `biz:owner:<phone>:list` KV schema) — no new
sheet-writing or KV-schema logic is introduced, which keeps this safe.

### 3a) `רשימת עסקים` alias (one-line edit)

In `_handleMyBusinessesCommand_` (~L13773), widen the match regex:

```javascript
// BEFORE:
  if (!/^עסקים\s*שלי$|^my\s+businesses$|^עסקים$/i.test(t)) return { handled: false };
// AFTER (adds "רשימת עסקים" / "רשימת העסקים"):
  if (!/^עסקים\s*שלי$|^my\s+businesses$|^עסקים$|^רשימת\s+ה?עסקים$/i.test(t)) return { handled: false };
```

### 3b) `פתח עסק חדש` / `עבור עסק` / `שנה שם עסק` — `_handleBusinessAdminCommand_`

A new owner-gated router. Each verb maps onto an existing helper:

- **`פתח עסק חדש [<name>]`** → resolves the next free business N (max existing
  N + 1, min 2 because N=1 is the main `תנועות` tab) and calls
  `_writeBusinessNExpense_(phone, n, name||null, '')` — the set-name-only path
  that creates the tab + persists the KV record. If no name is given, it tells
  the user how to set one.
- **`עבור עסק <N|name>`** → resolves which business the user means and stores a
  short-lived "active business" pointer in CacheService, plus tells them the
  exact write syntax. (There is no persistent server-side "active business"
  concept; this is a convenience pointer + clear instructions, so it can't
  mis-route anyone's money.)
- **`שנה שם עסק <N> <newname>`** → calls
  `_writeBusinessNExpense_(phone, n, newname, '')`, which (for an existing tab)
  renames the tab and updates the KV record via the existing rename branch in
  `_getOrCreateBusinessTab_`.

**Drop-in function** — paste directly BELOW `_handleMyBusinessesCommand_`:

```javascript
// ── BUSINESS-ADMIN COMMANDS (Batch 2, 2026-06-02) ───────────────────────────
// Adds the 3 explicit multi-business verbs the command-polish item asked for.
// Each REUSES the existing, tested helpers (_writeBusinessNExpense_ for
// create/rename via its set-name-only path; the biz:<phone>:<n> +
// biz:owner:<phone>:list KV schema) so NO new sheet/KV write logic is added.
// OWNER-ONLY: these touch SHEET_ID (only the owner can edit it). doPost gates
// the call with _isOwnerPhone_ so a tenant typing these falls through to the
// normal expense flow and never reaches owner-only sheet writes.
//   "פתח עסק חדש [שם]"        -> create the next business tab (N = maxN+1)
//   "עבור עסק <N|שם>"          -> remember an active-business pointer + syntax
//   "שנה שם עסק <N> <שם חדש>"   -> rename business N's tab
// Returns { handled, replyText } or { handled:false } to fall through.
function _handleBusinessAdminCommand_(fromPhone, text) {
  if (!fromPhone || !text) return { handled: false };
  var t = String(text).trim();
  if (!t) return { handled: false };
  var clean = String(fromPhone).replace(/[^0-9]/g, '');
  if (!clean) return { handled: false };

  // Resolve a business reference (a number, or a stored name) to its N.
  function _resolveBizN_(ref) {
    var r = String(ref || '').trim();
    if (!r) return null;
    if (/^\d{1,2}$/.test(r)) { var nn = parseInt(r, 10); return (nn >= 1 && nn <= 50) ? nn : null; }
    // Name lookup against the owner list.
    var list = [];
    try { list = kvGet('biz:owner:' + clean + ':list') || []; } catch (_e) {}
    var lc = r.toLowerCase();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].name && String(list[i].name).toLowerCase() === lc) return list[i].n;
    }
    return null;
  }

  function _nextFreeBizN_() {
    var maxN = 1; // N=1 is always the main תנועות tab.
    var list = [];
    try { list = kvGet('biz:owner:' + clean + ':list') || []; } catch (_e) {}
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].n && list[i].n > maxN) maxN = list[i].n;
    }
    return maxN + 1;
  }

  // ── פתח עסק חדש [name] ────────────────────────────────────────────────────
  var mOpen = t.match(/^(?:פתח|פתיחת)\s+עסק\s+חדש(?:\s+(.+))?$/);
  if (mOpen) {
    var openName = (mOpen[1] || '').trim().slice(0, 40);
    var n = _nextFreeBizN_();
    if (!openName) {
      return { handled: true, replyText:
        '🆕 פתיחת עסק חדש (עסק ' + n + ').\n\n' +
        'איך קוראים לו? שלח:\n' +
        '   "פתח עסק חדש <שם>"\n' +
        'לדוגמה: "פתח עסק חדש כספלה"' };
    }
    // Reuse the proven create path (set-name-only). bypassGuards=true so the
    // explicit "open new business" intent isn't re-questioned by the Phase-A
    // clarification guards (the user already said they want a new business).
    try {
      var res = _writeBusinessNExpense_(fromPhone, n, openName, '', null, true);
      if (res && res.replyText) return { handled: true, replyText: res.replyText };
      return { handled: true, replyText:
        '✅ עסק ' + n + ' = ' + openName + '\n\n' +
        'עכשיו שלח לדוגמה: "עסק ' + n + ' 320 שיווק"' };
    } catch (e) {
      try { Logger.log('_handleBusinessAdminCommand_ open err: ' + (e && e.message)); } catch (_) {}
      return { handled: true, replyText: '😬 לא הצלחתי לפתוח עסק חדש. נסה שוב.' };
    }
  }

  // ── עבור [ל]עסק <N|name> ──────────────────────────────────────────────────
  var mSwitch = t.match(/^עבור\s+ל?עסק\s+(.+)$/);
  if (mSwitch) {
    var n2 = _resolveBizN_(mSwitch[1]);
    if (!n2) {
      return { handled: true, replyText:
        '🤔 לא מצאתי את העסק הזה.\n' +
        'שלח "רשימת עסקים" לראות מה קיים, או "עבור עסק 2".' };
    }
    // Convenience pointer only (15-min). The actual write target is ALWAYS the
    // explicit "עסק N ..." prefix, so this can never silently mis-route money.
    try { CacheService.getScriptCache().put('activeBiz:' + clean, String(n2), 900); } catch (_e) {}
    var bizRec = {};
    try { bizRec = kvGet('biz:' + clean + ':' + n2) || {}; } catch (_e2) {}
    var nm2 = bizRec.name ? (' (' + bizRec.name + ')') : '';
    return { handled: true, replyText:
      '✅ עברתי לעסק ' + n2 + nm2 + '.\n\n' +
      'כדי לרשום לעסק הזה שלח לדוגמה:\n' +
      '   "עסק ' + n2 + ' 320 שיווק"' };
  }

  // ── שנה שם עסק <N> <new name> ─────────────────────────────────────────────
  var mRename = t.match(/^(?:שנה|עדכן)\s+שם\s+עסק\s+(\d{1,2})\s+(.+)$/);
  if (mRename) {
    var n3 = parseInt(mRename[1], 10);
    var newName = (mRename[2] || '').trim().slice(0, 40);
    if (!(n3 >= 1 && n3 <= 50) || !newName) {
      return { handled: true, replyText:
        '🤔 פורמט: "שנה שם עסק <מספר> <שם חדש>"\n' +
        'לדוגמה: "שנה שם עסק 2 כספלה"' };
    }
    try {
      // Set-name-only path renames the tab (existing-tab rename branch in
      // _getOrCreateBusinessTab_) and updates the KV record. bypassGuards=true
      // because the rename intent is explicit.
      var res3 = _writeBusinessNExpense_(fromPhone, n3, newName, '', null, true);
      if (res3 && res3.replyText) return { handled: true, replyText: res3.replyText };
      return { handled: true, replyText: '✅ עסק ' + n3 + ' = ' + newName };
    } catch (e) {
      try { Logger.log('_handleBusinessAdminCommand_ rename err: ' + (e && e.message)); } catch (_) {}
      return { handled: true, replyText: '😬 לא הצלחתי לשנות את השם. נסה שוב.' };
    }
  }

  return { handled: false };
}
```

> Rendered replies (for review):
> - `פתח עסק חדש כספלה` → reuses the existing set-name-only confirmation
>   ("✅ עסק N = כספלה" + new-tab + sheet link), so the wording matches the rest
>   of the multi-business UX.
> - `עבור עסק 2` → "✅ עברתי לעסק 2 (כספלה). כדי לרשום לעסק הזה שלח: \"עסק 2 320 שיווק\""
> - `שנה שם עסק 2 כספלה` → reuses the set-name-only rename confirmation.

**Where it goes in `doPost`:** add the router call inside the `if
(!__looksLikeExpense) { ... }` block, immediately AFTER the
`_handleMyBusinessesCommand_` block (~L2211) and BEFORE the
`_parseBusinessNumberPrefix_` write block (~L2228), gated by `_isOwnerPhone_`:

```javascript
          // Business-admin commands (Batch 2): פתח עסק חדש / עבור עסק / שנה שם עסק.
          // OWNER-ONLY (writes to SHEET_ID). Runs AFTER the list command and
          // BEFORE the "עסק N <amount>" write so the verbs win over a name that
          // happens to start with "עסק".
          if (typeof _handleBusinessAdminCommand_ === "function" && _isOwnerPhone_(__from_)) {
            try {
              var __baRes = _handleBusinessAdminCommand_(__from_, __text_);
              if (__baRes && __baRes.handled) {
                if (__baRes.replyText && typeof sendWhatsAppMessage === "function") {
                  sendWhatsAppMessage(__from_, __baRes.replyText);
                }
                Logger.log('doPost: business-admin command handled');
                return ContentService.createTextOutput("OK").setMimeType(ContentService.MimeType.TEXT);
              }
            } catch (_baErr) { Logger.log('doPost: business-admin cmd err: ' + (_baErr && _baErr.stack || _baErr)); }
          }
```

**Ordering rationale:** `_parseBusinessNumberPrefix_` only matches
`^עסק\s+\d` (a digit right after "עסק"), so `פתח עסק חדש`, `עבור עסק 2`, and
`שנה שם עסק 2 כספלה` never collide with it — but placing the admin router first
is the safe belt-and-suspenders ordering and keeps the verbs unambiguous.

### Also update the help text (so the new commands are discoverable)

In the business-help block (~L12483, the "כספלה" / business commands help), and
in the `_handleMyBusinessesCommand_` "add a second business" hint (~L13799),
mention the new verbs, e.g. add these lines to the help body:

```
   • "רשימת עסקים" — כל העסקים שלך
   • "פתח עסק חדש <שם>" — לפתוח עסק נוסף
   • "עבור עסק <מספר>" — לעבור לעסק אחר
   • "שנה שם עסק <מספר> <שם>" — לשנות שם של עסק
```

(Compose those as real Hebrew glyphs in the source, copied from THIS file — not
retyped — to avoid bidi corruption. See `feedback_chat_paste_hebrew_bidi`.)

---

## Suggested regression tests to add alongside the re-paste

These are NOT shipped in this PR (they'd need the re-pasted source to pass), but
write them in the same change that applies the fixes, following the
balanced-brace "load REAL source" pattern of
`bot/test_objective_pending_dispatch.js`:

1. **`bot/test_budget_intent_guard.js`** — extract `_handleBudgetIntentGuard_`
   (+ `_parseIsraeliNumber_`), assert:
   - `"תקציב 2000 שח"` → `handled:true`, reply mentions both
     `יעד תקציב ... = 2000` and the expense alternative (NO write).
   - `"קבע תקציב חודשי 3000"` → `handled:true`.
   - `"2000 שכירות"` → `handled:false` (plain expense still books).
   - `"תקציבים"` → `handled:false` (left to `_handleBudgetCommand_` list).
   - `"יעד תקציב אוכל = 1500"` → `handled:false` (structured form wins).
2. **`bot/test_business_admin_commands.js`** — mock CacheService + `kvGet`/`kvSet`
   + `_writeBusinessNExpense_`, assert:
   - `"רשימת עסקים"` is now matched by `_handleMyBusinessesCommand_`.
   - `"פתח עסק חדש כספלה"` resolves N = maxN+1 and calls the set-name path.
   - `"עבור עסק 2"` stores the `activeBiz:` pointer and replies with the write
     syntax; `"עבור עסק <unknown-name>"` → not-found reply.
   - `"שנה שם עסק 2 כספלה"` calls `_writeBusinessNExpense_(.., 2, 'כספלה', '')`.
   - a NON-owner phone falls through (`handled:false`) — tenant isolation.

---

## What was deliberately NOT changed

- **`_parseIsraeliNumber_` dot handling** (the `"2.000 שח"` → ₪2 edge). Changing
  it risks the well-tested `"3.5 לחם"` = ₪3.50 path. The budget-intent guard
  protects the user from the dangerous *budget* phrasings without touching the
  parser.
- **The expense fast-path ordering for ITEM 1.** It is already correct; the only
  requirement is to preserve it across the re-paste.
- **Any tenant-facing write surface.** Both new routers are owner-gated and reuse
  the existing per-owner KV keys; no cross-tenant read/write is introduced.
