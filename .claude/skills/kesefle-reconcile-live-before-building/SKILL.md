---
name: kesefle-reconcile-live-before-building
description: A workflow's "verified" number is a SIMULATION, not the live sheet — before building on it or telling Steven a figure, re-read the LIVE sheet via the Drive connector. Use before any sheet-dependent build, and before quoting any dashboard number to Steven.
---

# Reconcile the LIVE sheet before trusting a number

A verify agent can prove "after MOE the 2023 net is ₪24,472" — but that's what the sheet WOULD show *if Steven runs the APPLY*. The **live** sheet may still show ₪113,631 (gross) because the gated APPLY hasn't been run. Simulation ≠ live state.

## Rule
Before (a) building a tool that depends on current sheet state, or (b) quoting a dashboard figure to Steven, **re-export the live sheet fresh** via the Drive connector ([[kesefle-live-sheet-read-via-drive]], [[kesefle-drive-connector-access-limits]]) and read the actual `תנועות`/`הזמנות` rows + the dashboard formulas. Don't reuse a stale `/tmp/*.xlsx` cache — check the byte size/mtime, and compare cache vs live to see what actually landed.

## What this caught (2026-06-01)
- The MOO/MFB tools landed (orders + COGS formulas live), but **MOE had not been applied** — zero `עסק` opex rows existed for 2023-2025, so live historical net was GROSS, not the simulated post-MOE net. Quoting the simulated ₪24,472 as "live" would have been wrong.
- The cross-year leak: `מאזן אישי` R6 mirrored `עסק תמונות`!C13 which followed the company tab's *own* B4 year — only visible by reading the live formula, not a simulation.

## How
Verify with BOTH `data_only=False` (formulas) and `data_only=True` (cached values); note that Google-only functions (SUMPRODUCT/REGEXMATCH) export as `__xludf.DUMMYFUNCTION` with a possibly-stale cached value — so cross-check the underlying `תנועות` DATA, not just the cached cell. Distinguish "tool built" from "tool applied". See [[kesefle-reconcile-old-vs-new-by-year]], [[verify-data-sources-before-formula-repair]].
