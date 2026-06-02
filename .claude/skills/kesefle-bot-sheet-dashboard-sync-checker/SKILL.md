---
name: kesefle-bot-sheet-dashboard-sync-checker
description: Verify the bot, the per-tenant Google Sheet, the dashboard formulas, the admin endpoints, the website (/account, /dashboard), and the open-sheet links all point at the same active source — same sheet ID, same category vocabulary, same year selector. Catches the silent failure where the bot writes a category the dashboard doesn't sum, or admin shows stats from a different sheet than the user sees. Use after migration, before any production sheet switch, after sheet ID env changes, and on any user complaint of the form "the dashboard total is wrong" / "my expense disappeared".
---

# Kesefle Bot ↔ Sheet ↔ Dashboard ↔ Admin Sync Checker

The most insidious Kesefle bug class is misalignment between systems that all look correct in isolation. The bot says it wrote a row. The sheet shows the row. The dashboard shows zero. The admin says everything is fine. None are lying — they're each pointing at a slightly different "truth". This skill audits every layer end-to-end and surfaces the drift.

## The 7 systems that must agree

| Layer | Where the "truth" lives | What this skill checks |
|-------|------------------------|-----------------------|
| Bot Apps Script | `SHEET_ID` Script Property + `_resolveTenant_` resolution chain | The bot's effective sheet ID for the test phone |
| `lib/sheet-writer.js` | `appendRowToUserSheet` + tenant token from `user:{sub}` | Matches the bot's expectation |
| `/api/sheet/append` | Reads `user:{sub}` and `sheet:{sub}` | Resolves to the same sheet ID |
| Dashboard tabs | `מאזן חברה`, `מאזן אישי` row labels + SUMIFS criteria | Match `תנועות` col D / col E values |
| Admin endpoints | `/api/admin/*` route sheet IDs | Match per-tenant resolution |
| Website pages | `account.html`, `dashboard.html` "open sheet" links | Match per-tenant resolution |
| KV | `user:{sub}`, `sheet:{sub}`, `phone:{e164}` | All consistent for the test identity |

## When to invoke

- After migration apply (`APPLY_*` Apps Script function ran).
- Before any production sheet ID switch (changing `SHEET_ID` Script Property or `PERSONAL_TEMPLATE_SHEET_ID` in `bot/config.gs`).
- After `lib/sheet-writer.js` `buildTenantSheetSpec` changes.
- After `_resolveTenant_` changes.
- On any user complaint of "the dashboard total is wrong" / "my expense disappeared".
- Nightly as part of `kesefle-bot-self-heal-check`.

## Audit phases

### Phase 1 — Pick a test identity

Either:
- A specific phone the user complained about (Steven: `972547760643`).
- A synthetic test phone (`+972000000001`).
- The owner phone for end-to-end owner-flow validation.

Record: phone, expected `userSub`, expected `sheet:{sub}` ID.

### Phase 2 — Resolve through each layer

For the test identity, capture the resolved sheet ID at each layer:

```
[SYNC_CHECKER]
Test identity: phone=+972547760643

Layer A — Bot script properties:
  SHEET_ID (Script Properties)              → 1rtiPQs1sABkDr_viCiDDg7LuQNGY0bxzPvKT-KEqP0A
  
Layer B — Bot _resolveTenant_:
  _resolveTenant_('+972547760643')          → { userSub: 'sub_xxx', sheetId: '1rti...' }

Layer C — KV records:
  phone:+972547760643                       → { userSub: 'sub_xxx', linkedAt: '2026-...' }
  user:sub_xxx                              → { sheetId: '1rti...', token: '...' }
  sheet:sub_xxx                             → { sheetId: '1rti...', createdAt: '...' }

Layer D — /api/sheet/append resolution:
  POST /api/sheet/append { phone: '+972547760643' } → writes to '1rti...'

Layer E — Dashboard "open sheet" link in /dashboard:
  <a href="https://docs.google.com/spreadsheets/d/1rti.../edit"> → 1rti...

Layer F — Admin /api/admin/users:
  user.sheetId field                        → 1rti...

Layer G — bot/config.gs PERSONAL_TEMPLATE_SHEET_ID:
  → 1rti...
```

If ANY of these resolves to a different sheet ID, that's a **CRITICAL** drift.

### Phase 3 — Vocabulary alignment

For the bot's `CATEGORY_MAP` (in `bot/ExpenseBot_FIXED.gs`), assert every `category` and `subcategory` value used in writes also exists as a row label in the dashboard sheets:

```
Bot writes col D = '<category>', col E = '<subcategory>'.
Dashboard SUMIFS uses criterion '<dashboard_row_label>'.
If subcategory ≠ dashboard_row_label EXACTLY, the SUMIFS returns 0.
```

Cross-reference list:
- `bot/ExpenseBot_FIXED.gs` `CATEGORY_MAP` entries (`category` + `subcategory`)
- `מאזן חברה` col A row labels (every row that has a SUMIFS formula in cols C-N)
- `מאזן אישי` col A row labels (same)
- `קטגוריות` master `display_name` field (once that tab exists)

Output the diff:

```
Bot writes that dashboard does NOT sum:
  Bot subcategory     | Dashboard expected | Status
  שיווק              | שיווק/קידום         | MISMATCH (write to bot will drop)
  רוביקון            | (no row)            | MISSING (add row to מאזן חברה)
  ...

Dashboard rows that bot NEVER writes:
  Dashboard row label | Bot equivalent      | Status
  אבא                | (no bot keyword)    | DORMANT (Steven-only, populated by manual entry)
  ...
```

### Phase 4 — Year-selector wiring

Run the `kesefle-sheet-formula-year-selector-validator` skill as a sub-check. Its findings feed in here.

### Phase 5 — Admin parity

Hit:
- `GET /api/admin/recent-signups` — does the user appear?
- `GET /api/admin/user-reports` — does the user's reported issue appear?
- `GET /api/admin/bot-version` — bot version matches `KFL_BUILD_VERSION` in source?
- `GET /api/admin/config-drift` — any drift flagged?

Compare the admin's `sheetId` field for the test user against Layer C `sheet:{sub}`.

### Phase 6 — Website parity

For the test phone:
- `account.html` displays the correct sheet ID in the "Your sheet" widget.
- `dashboard.html` "Open in Sheets" link points to the same.
- `/api/whatsapp/link` GET returns the same `userSub`.

## Output format

```
[BOT_SHEET_DASHBOARD_SYNC_CHECKER]
Test identity: <phone or 'owner' or 'synthetic'>
Expected userSub: <sub or 'auto-resolved'>
Expected sheetId: <id or 'auto-resolved'>

Sheet ID resolution (7 layers):
  Layer | Source                       | Resolved sheet ID    | Matches expected?
  A     | Bot Script Properties        | 1rti...              | YES
  B     | Bot _resolveTenant_          | 1rti...              | YES
  C     | KV user:{sub}                | 1rti...              | YES
  D     | /api/sheet/append            | 1rti...              | YES
  E     | /dashboard "open sheet"      | 1rti...              | YES
  F     | /api/admin/users             | 1rti...              | YES
  G     | bot/config.gs                | 1rti...              | YES

Drift count: 0 → OK
            else → CRITICAL — block deploy

Vocabulary alignment:
  Bot writes → Dashboard sums:        <pct match> %
  Mismatched subcategories:           <count>  (list)
  Missing dashboard rows for bot subs: <count>  (list)
  Dashboard rows with no bot writes:  <count>  (note as dormant)

Year-selector wiring:
  Selector value:                     2026
  Formulas using $B$4:                <count>
  Formulas with hardcoded year:       <count>  (BLOCKER if > 0)

Admin parity:
  Bot version match:                  YES / NO
  User in /api/admin/users:           YES / NO
  Config drift flagged:               <list>

Website parity:
  account.html sheet ID:              MATCH / MISMATCH
  /dashboard "open sheet" link:       MATCH / MISMATCH

Final status: SYNC_OK | DRIFT_DETECTED | CRITICAL_DRIFT
Next action: <specific fix>
```

## Common drifts + fixes

| Drift | Likely cause | Fix |
|-------|--------------|-----|
| Bot writes to OLD sheet, dashboard reads NEW | `_resolveTenant_` returning owner SHEET_ID fallback for non-owner phone | Fix `_resolveTenant_` to fail-closed (no fallback). See PRs #4-8. |
| `שיווק` write, dashboard sums `שיווק/קידום` | `CATEGORY_MAP` drift from dashboard template | Use `kesefle-adaptive-category-profile-builder` to reconcile both to `קטגוריות` master |
| Admin shows different sheet than user sees | Admin endpoint uses wrong KV key (e.g. `phone:` instead of `user:{sub}`) | Audit the admin endpoint resolution chain |
| `account.html` "Open sheet" 404s | Stale link from before re-provisioning | Re-provision flow should update the cached link |
| Year selector says 2026 but totals are zero | Either no 2026 data yet, OR formulas hardcoded to 2025 | Run year-selector validator skill |

## Hand-off

- `SYNC_OK` → ship.
- `DRIFT_DETECTED` (vocabulary or admin-parity) → fix surgically; non-blocking but should not ship without addressing.
- `CRITICAL_DRIFT` (sheet ID drift, tenant leak) → STOP; this is a P0; involve `kesefle-qa-security-data-integrity-officer` immediately.

## Relationship to existing skills

- Complements `kesefle-link-checker` (file-level link grep) by being end-to-end live-data.
- Complements `bot-test-isolation` (bot-side test only) by checking dashboard + admin + website too.
- Feeds findings to `kesefle-monday-sync` for tracking.
