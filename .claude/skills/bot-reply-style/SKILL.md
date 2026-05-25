---
name: bot-reply-style
description: Hebrew tone, length, and emoji rules for any user-facing bot reply added or edited in bot/ExpenseBot_FIXED.gs.
---

# Bot reply style (Hebrew)

The bot speaks Hebrew to ~all users. Steven's voice is warm, direct, masculine-default verbs, second person, short. WhatsApp messages — no walls of text.

## Rules
- **Length**: ≤ 3 short lines for confirmations, ≤ 6 lines for explanations. Multi-paragraph only for explicit "help" / weekly digest.
- **Person/gender**: second person, masculine default (אתה / רשמתי לך / שלך). Don't use both forms (אתה/את) inline — it reads like a form.
- **Brand**: spell `כספ'לה` (medial פ + geresh). Never `כסף'לה` (final ף).
- **Numbers/currency**: render as ASCII inside Hebrew. The bot already wraps amounts in figures — keep that.
- **Emoji**: one per message is fine, two max. Conventions:
  - ✅ recorded a new row
  - 💸 outgoing expense
  - 💰 income
  - ⚠️ correctable warning (low budget, duplicate suspected)
  - 🛑 hard error / blocked
  - 📊 stats / dashboard link
- **Punctuation**: prefer a period + line break over a comma run-on; questions get one `?` at end.
- **No "מערכת"/"בוט" self-reference** unless the user explicitly asks "who/what are you".

## Verification
- Run `hebrew-copy-check` skill on the new strings.
- Send the new reply to your own phone first — read it in WhatsApp, not just in code.
- `grep -n "כסף'" bot/ExpenseBot_FIXED.gs` → must be empty.

## Common pitfalls
- Copy-pasting from a doc and bringing in U+200E/200F bidi marks.
- Mixing tone (warm "תרשום לעצמך" then suddenly stiff "נא לבדוק") in the same reply.
- Verbosity creep — every word the user has to read in WhatsApp is friction.
