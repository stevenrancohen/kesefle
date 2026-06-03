# reconcile-conflicting-strategy

When a new strategic ask from Steven overlaps or contradicts a still-binding prior strategy (a PR from earlier today, a doc shipped last week, a Monday Epic in flight), do NOT silently override and do NOT refuse the new ask. **Reconcile explicitly in a table**, then propose a merged direction.

## When to use

- New strategic ask arrives (e.g. "rebuild the dashboard") and a recent doc explicitly forbade or scoped it differently (e.g. morning's "DO NOT broadly rebuild the dashboard")
- New ask names a system that already has a recent contract (Monday Epic in progress, PRs shipped this week)
- New ask flips a source-of-truth decision (Sheets ↔ KV, web ↔ native, single-tenant ↔ multi)
- Two of Steven's messages within 24 hours arrive at different conclusions

## When NOT to use

- New ask is purely additive (no conflict — just expand scope per `pr-incremental-plan`)
- Prior decision is older than ~30 days AND was time-limited (the "30-day revisit" trigger already fired)
- Conflict is trivial (e.g. naming, color choice)
- Steven explicitly says "ignore my earlier plan" — then you DO override

## The reconciliation pattern

### Step 1 — Surface the conflict before any code
In the first turn after the new ask:
1. Quote the prior decision verbatim (PR link, doc heading, Monday Epic ID)
2. Quote the new ask verbatim
3. Name them as conflicting — do NOT pretend they're aligned

### Step 2 — Build a reconciliation table
Required columns: `Decision | Prior (binding) | New (proposed) | Reconciled`.

The `Reconciled` cell is one of:
- ✓ **Keep** — new ask agrees with prior, no change
- 🟡 **Merge** — both are partially right, here's how they layer (state the layering rule)
- 🔄 **Flip** — new ask overrides prior; explicitly retire the old decision and note its end-date
- ⏸ **Defer** — neither now; revisit after specific objective trigger

Every row needs a verb. "TBD" is not acceptable.

### Step 3 — Write a companion doc, not a replacement doc
The new strategy doc must:
- Cite the prior doc by path + PR link at the top under "Companion doc:"
- Have a "Conflict flag — honest reconciliation" section with the table
- End with "How this fits with [prior Epic/PR]"
- NOT delete or supersede the prior doc unless every row in the table is 🔄 Flip

### Step 4 — Update Monday Epic, don't create a duplicate
If the prior Epic exists, reshuffle subtasks (use `change_item_column_values` to update existing items + `create_item` for new ones). Create a NEW Epic only if every prior subtask is now obsolete.

### Step 5 — Wait for explicit "go ahead with reconciled direction" before code
Per `honest-counter-opinion`: end with one of three verbs (✅ ship reconciled / 🟡 ship leaner subset / 🔴 don't ship — fix something else first). Do NOT touch code until Steven picks one.

## Anti-patterns

- **Silent override.** Writing the new doc as if the old one doesn't exist. Future-you (or a contractor reading the repo cold) will find both docs and ship the wrong one.
- **"Both/and" handwave.** Saying "we'll do both" without naming HOW they layer. Steven will assume you'll figure it out; you won't.
- **Creating a 2nd Epic.** Now there are 2 Epics with overlapping subtasks. Steven has to triage which one to look at. Always reshuffle the existing Epic.
- **Refusing the new ask.** "But you said earlier..." is not a productive response. Steven is allowed to change his mind. Your job is to make the change coherent, not to enforce consistency.
- **Implementing before reconciliation lands.** Writing PR-S2 code while PR-S1 (strategy doc) is still in review. The strategy must merge first; otherwise you're committing to a direction Steven hasn't approved.

## Critical rules

1. **One verb per reconciliation row.** ✓ / 🟡 / 🔄 / ⏸. No essay cells.
2. **Cite both sides by URL.** PR links, doc paths, Monday Epic IDs.
3. **The new doc explicitly subordinates to the prior doc** by stating "this doc reconciles with [prior], it does not replace it" at the top — unless every row is 🔄.
4. **No code until Steven approves the reconciled direction.** This is a planning skill, not an implementation skill.

## Examples

- **2026-05-27 evening — Sheet + Dashboard strategy vs morning's WhatsApp+App strategy.** Morning PR #108 said "Sheets stays primary, no broad dashboard rebuild." Evening ask wanted "Sheets = backup, rebuild dashboard". I wrote `docs/SHEET_AND_DASHBOARD_STRATEGY.md` with a 7-row reconciliation table. 3 rows ✓ Keep, 4 rows 🟡 Merge (with explicit layering rule). PR #110 shipped as companion to PR #108, not replacement. Existing Epic 2944316144 to be reshuffled after Steven approves direction.

## Related skills

- `honest-counter-opinion` — when the new ask is from an external source (ChatGPT, competitor), use that first; if Steven still presses for it after the pushback, then apply THIS skill to reconcile
- `pr-incremental-plan` — used to break the reconciled direction into ≤3 PR slices
- `monday-feature-spec` — used to capture the ⏸ Defer rows as future-work items
- `monday-sync-at-turn-end` — the turn-end workflow this skill plugs into
