# Weekly Digest

Sunday-morning weekly summary feature for the Kesefle WhatsApp bot.
Fires every Sunday at 08:00 Asia/Jerusalem and pushes a Hebrew recap of
the previous 7 days to subscribers.

File: `WEEKLY_DIGEST.gs`
Depends on: `BOT_COMMANDS.gs` (uses `sendWhatsAppReply`, `_formatShekel`,
`_dateRangeFilter`, `_groupByCategory`).

## Install

1. Open the Apps Script project
   `1znNProbptLBkwqPmV-xWp6EirX7n_mJZvoJHf9si9Tw98y5-kvUgrHTo`.
2. Confirm project timezone is `Asia/Jerusalem` under
   *Project Settings > Time zone*. Time-based triggers fire in the project
   timezone, so this controls when 08:00 lands.
3. Make sure `BOT_COMMANDS.gs` is in the same project (it provides
   `sendWhatsAppReply` and the formatting helpers).
4. Confirm Script Properties contain `WA_TOKEN` and `WA_PHONE_ID`
   (already required for the bot in general).
5. Add the subscriber list (see next section).
6. From the Apps Script editor, run `INSTALL_WEEKLY_DIGEST_TRIGGER` once
   and approve the OAuth scopes (UrlFetch + Spreadsheet + Triggers).
7. Verify under *Triggers* that a weekly time-driven trigger now points at
   `_WEEKLY_DIGEST_HANDLER_`.

To remove the trigger: run `UNINSTALL_WEEKLY_DIGEST_TRIGGER`.

## Adding subscribers

Subscribers live in a Script Property named `SUBSCRIBERS` as a JSON array
of E.164 phone strings (no `+`, just digits as the Meta API expects):

```
["972500000000","972541234567"]
```

To edit:

1. Apps Script editor > *Project Settings* > *Script Properties* > Edit.
2. Set property `SUBSCRIBERS` to the JSON array above.
3. Save.

There is no UI for this yet. TODO: replace with the KV-backed user
registry once the bot's edge service exposes a list endpoint to
Apps Script.

### Opting a user out

Set a Script Property `optout:<phone>` (e.g. `optout:972500000000`) to any
non-empty value such as `1`. The digest handler reads this key and skips
delivery. This mirrors the KV key the edge service already uses.

## Test plan

1. Add your own phone number to `SUBSCRIBERS`.
2. From the Apps Script editor, run `TEST_WEEKLY_DIGEST_RENDER`. This
   builds the digest text for the first subscriber and logs it via
   `Logger.log` without sending. Inspect under *Executions > Log*.
3. Once the text looks right, run `RUN_WEEKLY_DIGEST_NOW`. This calls the
   real handler and sends the message via WhatsApp. The handler returns
   `{ ok, sent, skipped, errors }`.
4. Confirm the WhatsApp message landed. The 24h customer-window rule from
   Meta applies; outside the window the call returns an error and we log
   it. Long-term: register a pre-approved utility template for the digest.

### Behaviour to verify

- A subscriber with 0 transactions in the last 7 days is skipped (no spam).
- A subscriber whose `optout:<phone>` property is set is skipped.
- Income/expense classification follows the `D` (type) column. Rows
  containing `income` or the Hebrew `הכנסה` are summed into income.
- Top category is computed over expense rows only.
- Percent delta compares last 7 days vs the prior 7 days of expense
  totals. If the prior week is zero, the digest prints "אין נתון להשוואה".
- Spike alert (>= 2x weekly average over the prior 4 weeks) only fires
  when there is no other tone line in play.

## Debugging

- Open *Executions* in the Apps Script editor and filter by function name
  `_WEEKLY_DIGEST_HANDLER_` or `RUN_WEEKLY_DIGEST_NOW`. Each run logs one
  line per subscriber with `Logger.log('Digest <phone>: ' + ...)`.
- If you see `no subscribers configured` in the logs, the Script Property
  `SUBSCRIBERS` is missing or not valid JSON.
- If the handler logs `send_failed` with an HTTP 4xx code, the most
  common cause is the 24h customer-window expired - try sending any
  message to the bot from that phone first, then re-run.
- If timestamps in the sheet are strings instead of dates, the reader
  coerces them with `new Date(...)` and skips unparseable rows. Look for
  invalid `A` column values.
- To preview without sending, always use `TEST_WEEKLY_DIGEST_RENDER`.

## Tone rules (per-user)

- expense delta <= -10% : encouragement
- expense delta >= +25% : gentle nudge to review
- otherwise, if a category spiked >= 2x its 4-week weekly average :
  spike alert
- otherwise : neutral "balanced week" line

## Sample output

```
🌅 בוקר טוב!
📊 שבוע שעבר (10-16 במאי):
🟢 הכנסה: ₪4,200 (3 תנועות)
🔴 הוצאה: ₪2,847 (19 תנועות)
💰 יתרה: ₪1,353

🏆 קטגוריה מובילה: סופר (₪812)
📈 שינוי vs השבוע שעבר: -14%

כל הכבוד, ירידה יפה בהוצאות השבוע! 💪

🤖 שלח 'החודש?' לסיכום חודשי
שלח 'עצור' כדי לא לקבל יותר
```
