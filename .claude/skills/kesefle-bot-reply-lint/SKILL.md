---
name: kesefle-bot-reply-lint
description: Lint a NEW or edited Hebrew bot reply string in bot/ExpenseBot_FIXED.gs against tone, gender (masculine default), brand spelling, emoji budget, and WhatsApp length rules before reassembling DEPLOY.gs.
---

# Kesefle bot reply lint

Every user-facing string in `bot/ExpenseBot_FIXED.gs` is read by a real person inside WhatsApp, in Hebrew, in Steven's voice. This skill is the pre-deploy gate for any reply you add or edit before `bot-deploy-paste` reassembles `bot/ExpenseBot_DEPLOY.gs`. It complements `bot-reply-style` (the rules) and `hebrew-copy-check` (the scanner) with a concrete per-string checklist.

## Steps
1. Find the exact string you changed: `grep -n "<snippet>" bot/ExpenseBot_FIXED.gs`. Lint the literal as it appears in source, not a paraphrase. Hebrew lives only inside the string literal; the surrounding `//` comments must stay ASCII.
2. Brand: the name is spelled `כספ'לה` (medial pe + geresh). Run `grep -n "כסף'" bot/ExpenseBot_FIXED.gs` and confirm your new line is NOT a hit (final-fe spelling is wrong). English fallback `Kesefle` only where Hebrew can't render (e.g. a Meta template field).
3. Gender + person: second person, masculine default — `רשמתי לך`, `שלך`, `אתה`. Never ship a dual `אתה/את` slash form inline; it reads like a government form. Verb/number agreement must hold.
4. Emoji budget: at most two per message, and only from the project's convention set used elsewhere in the file. Confirm against neighbours: `✅` new row recorded, `💸` expense, `💰` income, `⚠️` correctable warning, `🛑` hard error, `📊` stats/dashboard link. No decorative emoji that isn't already a convention.
5. Length: confirmations <= 3 short lines, explanations <= 6. Multi-paragraph only for explicit `help` / weekly-digest replies. Count the `\n` in the literal. Every extra word is WhatsApp friction.
6. No self-reference as `מערכת` / `בוט` unless the user literally asked who/what it is.
7. Numbers/currency stay ASCII inside the Hebrew run (`₪490`, not Hebrew-numeral). The bot already wraps amounts — don't undo that.
8. Bidi hygiene: confirm no stray U+200E/U+200F/U+202A-E control chars rode in from a copy-paste: `grep -nP "[\x{200E}\x{200F}\x{202A}-\x{202E}]" bot/ExpenseBot_FIXED.gs`.
9. Never hardcode PII into a reply template (owner phone `972547760643` stays as the `OWNER_PHONE` const, not pasted into a user string), and never echo a secret VALUE (token/key) into any reply.
10. Punctuation: prefer a period + line break over a comma run-on; a question gets exactly one trailing `?`. No double `!!`.

## Worked example
A new "recorded" confirmation, linted to PASS:
```
✅ רשמתי לך ₪490 על דלק.
רוצה לראות את הדשבורד? 📊
```
- One `✅` opener + one `📊` closer = within the two-emoji budget and on-convention.
- Masculine `רשמתי לך`, second person, two short lines, amount as ASCII `₪490`.
- Single trailing `?`, brand not even needed here (don't shoehorn `כספ'לה` into every reply).

FAILs to reject: `נרשם בהצלחה!! 💰🎉✨ אתה/את יכול/ה לראות את הדוח שלך במערכת כסף'לה...` — three+ emoji incl. off-convention, dual-gender slash form, `מערכת` self-reference, wrong final-fe brand, run-on with `!!`.

## Verification
- `grep -n "כסף'" bot/ExpenseBot_FIXED.gs` returns nothing.
- `node --check bot/ExpenseBot_FIXED.gs` exits 0 (a smart-quote or unescaped char in the literal would fail here, not in Apps Script).
- Run the `hebrew-copy-check` skill on the new strings; bidi + brand scans are clean.
- Replay a message that triggers the reply and read the rendered text: `node bot/bot-replay.js --json "245 סופר"` — confirm the path that emits your string, then send it to your own phone and read it in WhatsApp, not just in code.
- If the reply is a new confirmation/category-picker line, run `node bot/test_category_picker.js` and `node bot/test_classify.js` to confirm no copy-keyed assertion broke.

## Common pitfalls
- Pasting a reply from a chat/doc and dragging in invisible bidi marks that corrupt the line and break the diff.
- Tone whiplash inside one reply — warm `תרשום לעצמך` then stiff `נא לבדוק`. Pick one register.
- Slipping the final-fe `כסף'לה` brand spelling in; it passes `node --check` but is wrong.
- Adding a third emoji or a non-convention emoji "to be friendly" — it dilutes the `⚠️`/`🛑` signal the user relies on.
- Editing `bot/ExpenseBot_FIXED.gs` and forgetting that the live bot runs `bot/ExpenseBot_DEPLOY.gs` — deploy is a manual Apps Script paste via `bot-deploy-paste`; an agent must never push to main or claim the reply is live until Steven re-pastes.
