# design-from-screenshot

When Steven sends a screenshot (FastBots / a Plotly dashboard / a competitor's pricing page) and says "I want this", translate the visual into engineering requirements WITHOUT over-promising. Pixel-for-pixel is not the goal — capturing the user-facing INTENT is.

## When to use

Steven attaches an image and says any variant of:
- "take this as inspiration"
- "make it look like this"
- "I want this for the customer"
- "I saw this on <competitor>"

The image becomes the reference UI. Your job: extract the right LEVEL of fidelity for what we can ship.

## When NOT to use

- Steven sends a screenshot showing a BUG in our product → use `bot-trace-message` or `audit-finding-to-pr` instead
- Steven sends a screenshot of his own design (Figma/Canva) → that IS the spec, no translation needed, just implement

## The 4-question decoder

Apply these before writing a line of code or even a Monday spec:

### 1. What's the JOB the user does with this screen?

Not "what does it look like" — "what does the user accomplish here". Examples:
- FastBots screenshot → job = "see + fix bot replies"
- Plotly P&L dashboard → job = "understand month-over-month financial trends"

If you can't name the job in 5 words, ask Steven.

### 2. What's the SIMPLEST shape that does that job?

Strip the screenshot to the minimum primitives:
- 4-panel chart dashboard → 4 charts, period. Not "must use Plotly", not "must have hover tooltips matching pixel for pixel".
- Customer conversation list → table + detail-pane, period. Not "must have animated transitions".

The screenshot is showing ONE way to do the job. There may be simpler ways. Propose the simplest first.

### 3. What's the FIDELITY budget?

Categorize what to copy literally vs interpret freely:
| Element | Default fidelity |
|---|---|
| Chart types (bar/line/etc) | Copy literally |
| Color palette | Match Kesefle brand, don't copy competitor colors |
| Typography | Use Kesefle stack (Rubik/Heebo), never copy competitor fonts |
| Layout/grid | Copy structure (4 panels → 4 panels), not exact pixel sizes |
| Microcopy | Hebrew + Kesefle voice, never English from screenshot |
| Interactions (hover/animate) | Skip in PR-V1, evaluate in PR-V2 |

### 4. What's the IMPLEMENTATION cost?

Be brutal here. Some screenshots show features that cost 10x more to ship than they look:
- "Just a line chart" with Sheets API = surprisingly easy
- "Just a tooltip on hover" with Sheets API = NOT possible (Sheets charts don't support custom HTML tooltips)
- "Customer can drag-drop to reorder" = entire UX subsystem
- "Real-time updates" = WebSocket infra we don't have

If the screenshot shows a feature with hidden cost, name it in the Monday spec's RISK section.

## Required output (in the Monday spec)

When this skill runs, the resulting Monday item MUST include 2 extra fields beyond the standard `monday-feature-spec` template:

### "What we COPY literally"
Bulleted list of the elements being copied 1:1 (chart types, panel count, etc).

### "What we DELIBERATELY DON'T COPY"
Bulleted list of intentional divergence + why:
- Colors → Kesefle brand, not <competitor>
- Fonts → Rubik/Heebo, not <competitor>
- Hover interactions → out of scope for v1 because <reason>
- Brand wording → Hebrew + Kesefle voice, not English

This list PREVENTS Steven from later thinking I forgot something. It says "I saw it, I chose not to copy it, here's why."

## Anti-patterns

- **Don't promise pixel-for-pixel.** Sheets API can't render gradients in chart legends. Brave Force Dark can't be matched 1:1. Be honest.
- **Don't copy competitor brand colors.** Their orange/red/blue is THEIRS. Kesefle is cyan→purple per PR #91. Map competitor colors to Kesefle palette in the spec.
- **Don't include screenshots in the Monday item.** "Reference UI: <competitor name> <feature name>" is enough. Screenshots bloat the board.
- **Don't promise interactivity Sheets API doesn't support.** If the screenshot shows a hover tooltip, name it in "DELIBERATELY DON'T COPY" with the technical reason.
- **Don't skip the JOB question.** Implementing "the visual" without naming the user job = wrong feature shipped beautifully.

## Examples

- 2026-05-27 — Steven sent FastBots chat-history screenshot. Job = "see + edit + resend bot replies". Translated to `Admin Conversation Console` Monday item with 3-PR plan, explicit "DELIBERATELY DON'T COPY: FastBots' English UI / cyan-brand chrome / hover animations".
- 2026-05-27 — Steven sent Plotly P&L dashboard. Job = "understand monthly financial trends". Translated to `Tenant Sheet Visual Dashboard` Monday item. COPY: 4-panel layout + chart types. DON'T COPY: Plotly's color palette, English labels, custom tooltips (Sheets API limit).

## Related skills

- `monday-feature-spec` — runs alongside this skill; the 7-section template absorbs the 4-question decoder output
- `screenshot-share-with-user` — the INVERSE skill (when WE want to show Steven a UI we built)
- `pr-incremental-plan` — for breaking the resulting feature into 3 PRs
