# App Strategy — WhatsApp + App, not WhatsApp alone

**Decision date:** 2026-05-27
**Decided by:** Steven (founder)
**Status:** APPROVED — start Phase A

## The 5 decisions

1. **WhatsApp stays the input layer.** Users keep sending `245 סופר` / `עסק הכנסה 10000` / etc. We don't ask them to switch.

2. **The existing `dashboard.html` becomes the correction + control layer.** We extend it with a **"צריך אישור"** tab. We do NOT build a new app surface.

3. **No native iOS/Android now.** PWA via `manifest.webmanifest` + Add-to-Home-Screen on the existing dashboard. Re-evaluate native only after real users use the PWA.

4. **Bot stops guessing on high-risk classifications.** Confidence below 0.85 → WhatsApp menu with buttons. No answer in 60 seconds → row marked `needs_review` in the Sheet (yellow background) instead of being written as final. Implementation reuses the menu-first dispatcher already in `docs/BOT_MENU_FIRST_POLICY.md`.

5. **Corrections teach the system.** When the user fixes a `needs_review` row in the dashboard, the rule (`"שופרסל" → "סופר"`) saves to the learned-categories KV. Next message of the same shape classifies right automatically.

## Sequence

- **Phase A** — bot uncertainty: low-confidence on personal/business/project/category → menu, not silent write.
- **Phase B** — "צריך אישור" tab in `dashboard.html` showing `needs_review` rows + one-tap correction buttons.
- **Phase C** — `manifest.webmanifest` + service worker registration on `/dashboard` → PWA install banner on mobile.

Each phase = its own focused PR per `pr-incremental-plan` skill.

## What we explicitly DO NOT build now

- Full native iOS app
- Full native Android app
- 7-tab complex app (per ChatGPT's earlier 12-screen proposal)
- New backend architecture rewrite
- Separate database as source of truth (Google Sheets stays primary for now; the `needs_review` queue lives in Sheets too, NOT in a new table)
- Broad dashboard rebuild unrelated to Review Inbox

## Risk + rollback

- **Risk:** users get spammed with "are you sure?" buttons → friction kills adoption.
- **Mitigation:** the threshold 0.85 is configurable via env var (`KFL_CONFIDENCE_ASK_THRESHOLD`). Start at 0.85, monitor, adjust. If too many asks, raise to 0.90.
- **Rollback:** revert Phase A PRs. The `needs_review` rows remain readable in the Sheet (just no longer get flagged); the dashboard tab degrades to an empty state.

## When to revisit "native app?" question

After 30 days of PWA being live with at least 10 active users. Decision criteria:
- Are users actually installing the PWA? (analytics: `kfl_pwa_installed` event)
- Do they open it ≥ 3×/week?
- Do they correct rows there vs ignore them?

If yes to all 3 → native app is justified. If no → keep PWA, fix what's blocking adoption.

---

*One-page rule: this document is intentionally short. Detailed implementation lives in the corresponding PRs. The 5 decisions above are the only durable contract.*
