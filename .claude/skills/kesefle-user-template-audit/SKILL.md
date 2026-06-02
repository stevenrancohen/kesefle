---
name: kesefle-user-template-audit
description: Verify a tenant's sheet was provisioned with the correct template preset (Basic Personal / Family / Business / Contractor / Mixed / Advanced Imported) based on their onboarding answers + Settings tab + actual category activations.
---

# kesefle-user-template-audit

When invoked: confirm a tenant's template matches their declared profile.

## Inputs
- `sheetId` — required
- `userSub` — required (for onboarding answers from KV)

## Audit steps

### 1. Detect declared template
- Read `Settings!template_type` value
- Cross-check against onboarding answers in KV `onboarding:{sub}`

### 2. Detect actual template (from active categories)
- Read `User_Category_Profile` for active categories
- Match active set against the 6 preset definitions (Basic / Family / Business / Contractor / Mixed / Advanced)
- Identify nearest preset by overlap

### 3. Drift check
- Declared vs actual must match (or actual = declared + extras = OK)
- If actual is a STRICT SUBSET of declared, user may have hidden too many → flag for outreach
- If actual is COMPLETELY DIFFERENT from declared, severe drift → flag for re-onboarding

### 4. has_* flags consistency
- Settings.has_car=TRUE but no car-group categories active → flag
- Settings.has_business=TRUE but no business-group categories active → flag
- Settings.has_business=FALSE but מאזן חברה has data → flag

### 5. Migration-from-OLD check (Steven-specific)
- If `Settings.template_type=mixed_imported` → verify Steven's 23 OLD categories all active

## Pass criteria
- Declared = actual (or actual ⊇ declared)
- No has_* contradictions
- No critical drift

## Outputs
- `user-template-audit-{sheetId-short}.md`
- Recommendation: keep current / re-onboard / migrate to different preset

## Hard NO
- No writes
- No automatic re-onboarding
- Recommendations only — Steven decides
