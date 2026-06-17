# Admin v4 — Classification-Review & Correction Loop (architecture spec)

Status: **DESIGN ONLY** — no product code yet. Author hands this to the engineers.
Date: 2026-06-17. Owner decision required on the "Open decisions" at the bottom before build.

---

## 1. Problem & why now

Every expense the bot (or a CSV import) records gets a **category + subcategory**. Today
that classification is fire-and-forget:

- When the bot is unsure it falls through to `שונות` (misc) or pops a menu — but **no one
  ever sees which classifications were shaky**, so a quietly-miscategorised row just sits in
  the user's sheet and silently distorts their dashboard.
- The bot **never learns** from a correction. The same ambiguous merchant gets mis-filed
  forever.
- The related **A2 bug**: server-side CSV/bank import writes a blank/invalid col-E subcategory,
  so imported money is invisible to the dashboard SUMIFS (`lib/categories.js` is the col-E
  authority; the import path doesn't go through it). Same failure class — "classification
  produced bad output, no one caught it."

The admin OS (v1–v3) is pure **monitoring**. v4 turns it into a **control loop**: surface the
shaky classifications, let Steven correct them in one click, and feed the corrections back so
both the bot and the import path get smarter. This is the actual Kesefle flywheel.

## 2. Constraints (binding — from the project's standing rules)

1. **Data honesty.** The review queue shows *real* low-confidence items, *empty*, *outage*, or
   *sign-in* — **never fabricated rows to look busy**. No demo data, ever.
2. **Tenant isolation.** A review item is scoped to one user. `userSub` is resolved
   **server-side** from the phone→token→sheet mapping (like `api/append.js`) — never trusted
   from a client/bot payload. User A's items never surface under user B.
3. **Privacy.** Store the *minimum* raw text needed to re-judge a classification, with a TTL
   (≤30d). No long-term message-content store. Admin view is `requireAdmin`-gated.
4. **Financial-data-integrity.** Applying a correction to a user's *existing* sheet row is a
   financial write → it goes through the integrity guard: backup the cell → dry-run → approve →
   `safeSetValue` on the **category cell only** (never touch user-typed cells, never the amount)
   → validate. Append-only on `תנועות` stays intact.
5. **Bot-paste boundary.** Any change to `bot/ExpenseBot_FIXED.gs` ships only by Steven's manual
   paste. The bot delta must be **minimal, isolated, and fail-open** (never block an expense
   write). Prefer slices that need **no** paste.
6. **KV discipline.** Bounded queues (hard cap), TTLs on every key, no unbounded scans.

## 3. The classification authority (`lib/classify.js`) — single source of truth

Build the long-open `lib/classify.js` as a **pure CJS module** (testable, no I/O), the one
place that turns free text → `{ category, subcategory, isIncome, confidence, candidates[] }`.

- Built on the existing `CATEGORY_MAP` (keyword table) + `lib/categories.js` (subcategory↔
  dashboard col-E authority). It does **not** re-implement categories — it consumes them.
- **Confidence buckets** (already latent in the bot):
  - `high` — a direct, unambiguous keyword hit.
  - `medium` — matched via a weak/short keyword, or an AI/heuristic fallback, or multiple
    plausible candidates.
  - `low` — defaulted to `שונות`/misc (no real signal).
- An injectable **override map** (see §6) is consulted first, so learned corrections take
  precedence without editing `CATEGORY_MAP`.
- This module is the shared brain for: (a) CSV/bank import (fixes A2 immediately), (b) the
  review-signal scorer, and (c) eventually the bot.

## 4. Signal capture — two sources, paste-ordered

### 4.0 Source A — server-side import (NO bot paste) ← **ship this first**
`api/sheet/csv-import.js` and `api/import/bank-csv.js` already run server-side. Route every
imported row through `lib/classify.js`:
- Write the **correct** col-E subcategory (this alone **fixes the A2 bug**).
- For `medium`/`low` rows, enqueue a review candidate (§5).

This delivers a real, populated review queue **and** the A2 fix with **zero bot changes**.

### 4.0b Source B — bot low-confidence (ONE small paste, later)
After 4.0 proves out, add a minimal bot delta: when the bot classifies `medium`/`low`, send a
**fire-and-forget** POST to a new `/api/log/classification` (bot already has API base + secret).
The endpoint resolves `userSub` server-side and enqueues a candidate. Fail-open: if the POST
fails, the expense still records. No change to the write path itself.

## 5. Storage (KV — bounded + TTL)

```
review:item:{id}        JSON candidate, TTL 30d
                        { id, userSub, source:'import|bot', rowRef, amount,
                          rawSnippet(≤80 chars), chosen{cat,sub}, candidates[],
                          confidence, ts }
review:queue            ZSET of ids by ts (newest first), capped at 500 (drop oldest)
review:user:{sub}       SET of that user's open ids (isolation + targeted fetch), TTL 30d
classify:corrections    LIST of { rawSnippet, chosen, corrected, by, ts } — the learning log
classify:override       HASH keyword→{cat,sub} — learned overrides consumed by lib/classify.js
```
All keys TTL'd; queue hard-capped; no `*` scans on the hot path.

## 6. Admin endpoints (both `requireAdmin`)

- `GET /api/admin/needs-classification?limit=50` → newest open review items (bounded), masked
  (email masked, snippet truncated). Honest empty/outage/auth.
- `POST /api/admin/classify-correct` `{ id, correctedCat, correctedSub, applyToSheet?:bool }`:
  1. Append to `classify:corrections` (always — the learning signal).
  2. If the correction implies a reusable rule, upsert `classify:override` (so future
     classifications self-heal).
  3. If `applyToSheet` (default **false** in v4.0): retro-correct the user's existing row —
     **only** via the integrity guard (backup→`safeSetValue` on the category cell→validate).
  4. Remove the item from `review:queue` + `review:user:{sub}`.
  5. Write an audit-log entry.

## 7. Admin UI (extends the existing `טעון בדיקה` section in `admin-os.html`)

Add a **"סיווגים לבדיקה"** panel above the existing inbox:
- Each row: amount · raw snippet · chosen category (pill) · confidence pill · candidate
  categories · a category `<select>` (driven by `lib/categories.js`, never hardcoded) ·
  **אשר** (confirm as-is) / **תקן** (correct) buttons.
- Honest empty/auth/outage states; deep-link friendly (`#/needs-review`).
- A small **"מילים שנלמדו"** sub-view: "the word *Z* was corrected to *Y* N times — add as a
  rule?" → approving upserts `classify:override`.

## 8. The learning loop (where it actually gets smarter)

```
import/bot classifies → low/medium enqueued → admin corrects →
  classify:corrections (log)  +  classify:override (rule) →
    lib/classify.js consults override first →
      next import/bot classification is already right
        → fewer items in the queue over time (the success metric)
```

## 9. Rollout phases

- **v4.0 (no bot paste):** `lib/classify.js` + wire it into the two import endpoints (fixes A2)
  + enqueue low/medium + `GET needs-classification` + `POST classify-correct` (records +
  override, `applyToSheet:false`) + admin panel + learned-words sub-view. Fully auto-deploy.
- **v4.1:** enable `applyToSheet` retro-correction of the user's existing row — **gated by the
  financial-data-integrity guard** (backup + validate + rollback function).
- **v4.0b / v4.2:** the one small bot paste (Source B), then the bot consults `classify:override`
  at classify time (server round-trip or next paste) — closes the loop end-to-end.

## 10. Acceptance criteria

- A low/medium import classification appears in the admin queue within seconds, scoped to the
  right user, with real data (and the A2 col-E value is now correct on the sheet).
- An admin correction is recorded, clears the queue item, is auditable, and a repeated pattern
  becomes an override that prevents recurrence.
- Zero cross-tenant leakage; zero fabricated rows; honest empty/outage/auth everywhere.
- KV bounded (caps + TTLs); no unbounded scans added.
- v4.1 sheet writes prove backup + validate + rollback; never overwrite user-typed cells.

## 11. What NOT to do

- Don't store full message history (privacy) — minimal snippet, TTL'd.
- Don't trust `userSub` from the bot/client — resolve server-side.
- Don't auto-apply corrections to user sheets without the integrity guard + explicit toggle.
- Don't synthesize review items to make the screen look active.
- Don't block an expense/import write if enqueue fails (fail-open).
- Don't hardcode category lists in the UI — drive from `lib/categories.js`.
- Don't edit `CATEGORY_MAP` for one-off corrections — use `classify:override`.

## 12. Open decisions for Steven (before/around build)

1. **Retro-correction (v4.1):** should a correction also fix the user's *existing* sheet row
   (powerful, but a financial write to their data), or only improve *future* classification?
   Recommendation: ship v4.0 future-only; turn on v4.1 once the guard path is proven.
2. **Bot signal (4.0b):** OK to schedule the one small bot paste after v4.0 proves out, or keep
   it import-only for now? Recommendation: import-first, paste later.
3. **Override authority:** auto-apply a learned override after N consistent corrections, or
   always require your one-click approval? Recommendation: require approval (no silent rules).
