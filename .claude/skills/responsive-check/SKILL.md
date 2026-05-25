---
name: responsive-check
description: Manual responsive design sweep at 320 / 375 / 430px mobile widths to confirm a page or component renders without horizontal scroll or clipped content.
---

# Responsive check (mobile)

Most Kesefle users are on phones. WhatsApp users → phone is the primary surface. Always verify any new UI at the small mobile widths BEFORE committing.

## Widths to test
- **320px** — iPhone SE 1st gen, smallest realistic target.
- **375px** — iPhone SE 2/3, iPhone 12 mini, common Android.
- **430px** — iPhone Pro Max, large Android.

## Steps
1. Open the page in Brave / Chrome DevTools. Toggle device toolbar.
2. For each width:
   - No horizontal scroll. Scrollbar appears? → something is too wide; find with `* { outline: 1px solid red }` then narrow.
   - All buttons reachable; no overlap.
   - Text wraps without leaving an orphan word on its own line wherever it matters (headlines).
   - Tappable targets ≥ 44×44 px (iOS HIG).
3. Check sticky / fixed elements (header, CTA bar) — do they cover content on a short viewport?
4. Modals: must scroll inside themselves, never overflow the viewport.
5. Forms: inputs span full width; keyboard doesn't push critical buttons off-screen (test by focusing).

## Verification
- Screenshot at each width; eyeball.
- Run on a real device if anything looks off in the emulator — Safari iOS has its own quirks (100vh including the address bar).

## Common pitfalls
- Fixed-width container (e.g. `max-w-[800px]` with no `w-full`) leaves a sliver and no scroll, looks fine but is brittle.
- Long Hebrew word in a narrow column — add `overflow-wrap: anywhere` if you can't shorten the copy.
- `position: fixed` element using `vh` units — viewport quirks; use `dvh` or test on the real device.
- Tailwind `lg:` / `md:` classes assume desktop-first; verify the base (mobile) styles actually work without them.
