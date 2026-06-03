# brand-token-extend

Add a new variant or utility class to `css/brand.css` without breaking site-wide assumptions. Used by PR #91 (gradient sweep) and PR #99 (chip palette).

## When to use

- Adding a new color variant (red/orange/purple/etc state)
- Adding a new component utility class (`.kfl-btn-*`, `.kfl-chip-*`, `.kfl-card-*`)
- Adding a new gradient or token

## When NOT to use

- Page-specific styling (keep inline)
- One-off Tailwind utility (use a Tailwind class directly)
- Animation that only fires on one page (inline `<style>`)

## File rules (from the file header)

> Keep this file SMALL. Add a class only when it appears on > 1 page AND its absence is visible.

## Pattern

1. **Decide naming.** Use the `kfl-` prefix to avoid Tailwind collisions:
   - `kfl-btn-*` = buttons
   - `kfl-chip-*` = status chips
   - `kfl-card-*` = card variants
   - `kfl-{utility}-{variant}` for everything else

2. **Add the base class first**, then variants:
   ```css
   .kfl-chip { /* shared shape */ }
   .kfl-chip-success { /* color only */ }
   .kfl-chip-warn { /* color only */ }
   ```

3. **Always add a matching `html.dark` rule** for dark-mode contrast:
   ```css
   .kfl-chip-success { background: #ECFDF5; color: #047857; border-color: #A7F3D0; }
   html.dark .kfl-chip-success { background: rgba(4,120,87,0.18); color: #6EE7B7; border-color: rgba(167,243,208,0.35); }
   ```

4. **Use Steven's canonical palette tokens** where possible:
   - `--k-cyan: #06B6D4` (brand primary)
   - `--k-purple: #872B97` (premium, pro, AI)
   - `--k-orange: #FF7130` (warning, pending)
   - `--k-red: #FF3C68` (urgent, error)
   - `--k-teal: #14B8A6`
   - `--k-dark: #171721`

5. **Document usage at the top of the block:**
   ```css
   /* ====================================================================
      PR-XX (DATE): <one-line purpose>.
      Steven's brief: "<quoted intent>".
      Usage:
        <span class="kfl-chip kfl-chip-success">...</span>
      ==================================================================== */
   ```

6. **Scope discipline:** DO NOT apply the new class anywhere in this PR. Ship the utility separately. Future PRs pick it up.
   - Reason: applying = touching many HTML files = merge conflicts with other open PRs.

## Verification

- File-only change. No HTML touched.
- `node tests/full_qa.js` still passes (the new utility doesn't break anything).
- Eyeball brand.css to confirm it's still small (< 250 lines is the target).

## Anti-patterns

- Don't add a token used in one place. Inline it.
- Don't override Tailwind utility classes via `.bg-brand-X { background: ... !important }` unless that's the whole point of the PR (e.g. PR #91's gradient sweep).
- Don't ship without dark-mode pair.
- Don't ship a "premium" badge that only renders well on light theme.

## Examples

- PR #91 — `.kfl-btn-gradient`, `.kfl-logo-text` + Tailwind override sweep
- PR #99 — `.kfl-chip` + 6 status variants
- Existing in repo — `.holo-text`, `.aurora`, `.dotgrid`
