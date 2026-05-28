---
name: kesefle-category-profile-audit
description: For a user's sheet, audit the `קטגוריות` master + `User_Category_Profile` mirror — every active category must have a matching row in master, every dashboard row must map to an active category, no orphans either way.
---

# kesefle-category-profile-audit

When invoked: reconciliation between master library + user profile + dashboard rows.

## Inputs
- `sheetId` — required
- `userSub` — optional (for KV mirror check)

## Three-way reconciliation

### Master `קטגוריות` ↔ `User_Category_Profile`
- Every `category_id` in profile must exist in master
- Every active category in profile must have non-null `display_name_he` + `group` in master
- Orphan profile rows (id missing from master) → fail

### Profile ↔ Dashboard rows
- Every dashboard row (label in col A) must map to a `User_Category_Profile.active=TRUE` row
- Active profile rows without a dashboard row → either it's about to be added (OK) or it's stale (flag)

### Profile ↔ KV mirror
- `user_profile:{sub}` KV record must contain the same active category list
- Drift > 5 minutes → flag (last sync timestamp check)

### Steven's OLD-category preservation
- Every one of Steven's 23 OLD categories must appear in master with `source_sheet=steven_old`
- Verify `display_name_he` preserves original (not normalized)

## Pass criteria
- 0 orphans in either direction
- 0 profile entries missing from master
- KV drift < 5 min
- Steven's 23 OLD categories all preserved

## Outputs
- `category-profile-audit-{sheetId-short}-{YYYY-MM-DD}.md`
- Table: Mismatch type | category_id | Detail | Remediation

## Hard NO
- No writes — flag mismatches only
- Steven decides whether to add missing rows / remove orphans
