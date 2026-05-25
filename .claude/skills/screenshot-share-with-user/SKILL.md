---
name: screenshot-share-with-user
description: Capture screenshots of a Kesefle UI change at the right viewport sizes and describe them to Steven so he can approve without opening the browser himself.
---

# Screenshot + describe for Steven

Steven is non-technical-ish and time-poor; he wants to approve a change from a screenshot, not by checking out a branch. Make the screenshot do the work.

## Steps
1. **Capture**: open the relevant page in Brave (preferred per project memory). Use DevTools device toolbar.
2. **Sizes**:
   - Mobile **375px** (always — primary surface).
   - Desktop **1280px** (when relevant).
   - **Before** + **After** if it's a visual change.
3. **Crop tight** — only the changed component plus a few px of context. No browser chrome unless the URL bar is the point.
4. **Annotate** if needed — a red arrow / box over the changed element. Tools: macOS Preview, Skitch.
5. **Describe** in the message:
   - One sentence: what changed.
   - One sentence: why.
   - "Live at https://kesefle.com/<page> after merge."
   - End with: "OK to merge?"
6. **Save** the screenshot in `/tmp/` if local; never commit screenshots to the repo unless they're documentation assets.

## Verification
- The screenshot shows the change unambiguously without needing Steven to open the page.
- The Hebrew text is readable (not tiny, not blurred).
- RTL direction is visible (text reads right-to-left in the screenshot).

## Common pitfalls
- Sending a desktop-only screenshot for a mobile-first change.
- Forgetting the before — Steven can't tell what's different.
- Tiny screenshot of a full page — relevant change invisible.
- Hebrew text reverses in the screenshot because of a screenshot tool bug → use the rendered browser image, not a copy-paste of text.
