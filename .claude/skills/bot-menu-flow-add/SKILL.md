# bot-menu-flow-add

Add a new menu-first flow to `bot/ExpenseBot_FIXED.gs` per `docs/BOT_MENU_FIRST_POLICY.md`. Use this for any structured action where free-text guessing could produce a wrong write (the "2000 שח → ₪2" class of bug).

## When to use

The bot receives a Hebrew trigger and needs to:
- Collect more than 1 field from the user (multi-step)
- Confirm a destructive action
- Disambiguate between two interpretations (personal/business, expense/income, etc.)
- Set a value where the wrong interpretation costs the user real money/data

## When NOT to use

- Simple commands with a single deterministic outcome ("שלום", "עזרה", "סטטוס")
- Read-only queries ("כמה הוצאתי החודש")
- Flows where free-text is the natural input (sending an expense like "45 קפה")

## Pattern (3 pieces)

### 1. Trigger detection in `doPost`

Add a dispatcher BEFORE the existing free-text expense parser:
```js
if (typeof _handle<FlowName>Command_ === "function") {
  try {
    var __res = _handle<FlowName>Command_(__from_, __text_);
    if (__res && __res.handled) {
      sendWhatsAppMessage(__from_, __res.replyText);
      return ContentService.createTextOutput('OK');
    }
  } catch (_err) { Logger.log('<FlowName> err: ' + (_err && _err.message)); }
}
```

### 2. The handler `_handle<FlowName>Command_(fromPhone, text)`

Returns `{ handled, replyText }` or `null` if not matched.

```js
function _handle<FlowName>Command_(fromPhone, text) {
  if (!text) return null;
  // Trigger phrases — keep specific, avoid false matches
  var triggers = ['<trigger 1>', '<trigger 2>'];
  if (!triggers.some(function(t){ return text.indexOf(t) >= 0; })) return null;

  // For multi-step flows, store state in CacheService:
  var cache = CacheService.getScriptCache();
  var stateKey = 'pendingFlow:' + fromPhone;
  var state = JSON.parse(cache.get(stateKey) || '{}');

  // Decide which step the user is on; ask the next question.
  // The menu MUST use sendWhatsAppInteractiveList with concrete options,
  // not free-text questions like "כמה? כתוב/י את הסכום."

  // ...

  return { handled: true, replyText: 'next question or confirmation' };
}
```

### 3. State machine via CacheService

For multi-step flows, store the partial state with 600s TTL:
```js
cache.put('pendingFlow:' + fromPhone, JSON.stringify({
  flow: '<flowName>',
  step: '<currentStep>',
  collected: { /* fields gathered so far */ },
  startedAt: Date.now(),
}), 600);
```

Then the dispatcher `_handlePendingFlowStep_` (already in bot at ~line 1873) routes the user's next reply back to your handler with the cached state.

## Critical rules from BOT_MENU_FIRST_POLICY.md

1. **Confidence threshold ≥ 0.85 to auto-write.** Anything below that → ask via menu, never write.
2. **Suspicious low amount guard.** In a budget context, amount < 50 → ASK ("did you mean ₪2 or ₪2000?"), never write.
3. **Category picker minimum 20+ options** with the canonical 7 groups. Plus "קטגוריה חדשה" + "פתח רשימה מלאה" escapes (per PR-3).
4. **Confirmation step** for any flow that writes a row, mutes a goal, deletes a budget, or changes a tier.
5. **Hebrew, RTL-safe, ASCII-comment-only in code.**

## Testing

Write a regression test via `regression-test-no-eval` skill. Pattern:
```js
assert(/function _handle<FlowName>Command_\(fromPhone, text\)/.test(BOT),
  '_handle<FlowName>Command_ function exists in bot');
assert(/_handle<FlowName>Command_\(__from_, __text_\)/.test(BOT),
  'doPost dispatches to _handle<FlowName>Command_');
// All trigger phrases present
for (const t of TRIGGERS) {
  assert(BOT.indexOf(t) >= 0, 'bot recognizes "' + t + '"');
}
```

## Version bump

EVERY bot PR must bump `KFL_BUILD_VERSION` (line 57 of bot/ExpenseBot_FIXED.gs) to a new date-stamped string like `'2026-05-28-flow-X-added'`. The admin freshness badge uses this to detect undeployed code.

## Deploy

After the change, run the assembly script:
```bash
head -95 bot/ExpenseBot_DEPLOY.gs > /tmp/x.js && tail -n +21 bot/ExpenseBot_FIXED.gs >> /tmp/x.js && node --check /tmp/x.js && cp /tmp/x.js bot/ExpenseBot_DEPLOY.gs
```
Verify single `doPost`: `grep -c "function doPost" bot/ExpenseBot_DEPLOY.gs` should be `1`.

Then tell Steven (per `bot-deploy-paste` skill) to re-paste `bot/ExpenseBot_DEPLOY.gs` into Apps Script.

## Examples

- PR-3 (#87) — expanded category picker (4 sections → 10, 71 categories, escape options)
- PR-2 wizard pattern (#86) — stateful 'יעד חדש' wizard with cache-backed state machine

## Anti-patterns

- Don't add a free-text parser for a structured flow. Use a menu.
- Don't skip the confirmation step on destructive actions ("מחק", "אפס", "סגור").
- Don't write a row when confidence < 0.85.
- Don't ship without bumping KFL_BUILD_VERSION.
- Don't forget the regression test.
