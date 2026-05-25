# Hermes Bot-Loop Fix (2026-05-25)

## Incident

Steven connected an external auto-responder ("Hermes Agent") to the same WhatsApp number Kesefle's bot uses. The two bots got into an infinite reply loop visible in his screenshot — both kept sending `[Silent]` / `⚡ Interrupting current task` / ```json{"action":"chat","reply":"..."} messages back and forth.

Concrete risks if left unfixed:
1. WhatsApp Cloud API quota exhaustion (Meta tier 1 = 1k messages/24h; loop burns this in minutes)
2. Sheet rows that contain JSON instead of expenses
3. WhatsApp quality rating drop → number suspension
4. Real users get rate-limited because a bot loop is eating the quota

## Fix

Three independent guards, all in `bot/ExpenseBot_FIXED.gs` `doPost`, stacked in order so failure of any one falls through to the next:

### 1. `_shouldMuteBotLoop_` (signature + counter)

- `_BOT_ECHO_REGEXES_` matches the 12 strongest auto-responder patterns observed in the Hermes traffic and common vacation autoreplies.
- Every match bumps a per-phone counter in `CacheService` (2-minute window).
- 3 bot-like messages in 2 minutes → mute that phone for **30 minutes** + one admin alert per episode (`_adminAlertOnce_` dedupes).
- Even **before** the threshold, the suspicious individual message is silently dropped — we never reply to anything that looks like a bot, ever.

### 2. `_checkReplyCap_` (hard outbound cap)

- Counts reply attempts per phone in a 60-second window.
- **20 replies / 60 s / phone** → hard reject the next.
- Defends against runaway bugs that don't match any signature.

### 3. `_killSwitchActive_` (panic button)

- Reads Script Properties `KFL_DISABLE_BOT_WRITES` or `KFL_MAINTENANCE_MODE`.
- Set either to `true` and the bot stops processing messages within seconds (no redeploy).
- Replies once per user per hour with a maintenance notice so users aren't left in the dark.

## Validation

`bot/test_botloop.js` extracts the live `_BOT_ECHO_REGEXES_` array from the source and asserts:

- 12 known auto-responder patterns are caught (incl. all 3 Hermes JSON variants from Steven's screenshot)
- 12 real human expense messages are **NOT** caught (zero false positives)

Run: `node bot/test_botloop.js` → `24/24 pass`.

## Operating notes

- The mute cache key (`botloop:mute:{phone}`) auto-expires after 30 min; you don't need to manually un-mute.
- Want to force-unmute now? Delete the cache key from Apps Script's CacheService (Run a one-liner: `CacheService.getScriptCache().remove('botloop:mute:9725XXXXXXX')`).
- Want to lower / raise the threshold? `_shouldMuteBotLoop_` has the magic numbers (3 in 120s, 30-min mute).

## What this does NOT solve

- A human spamming 100 identical "120 קפה" messages won't trip the bot-echo regexes — they look like real expenses. The per-phone reply cap covers this case instead.
- If our own bot's reply text ever happens to match `_BOT_ECHO_REGEXES_`, we'd silence ourselves on a self-loop. None of our current reply templates match, but if you add a new one, run the test suite.
