# status-chip-apply

Sweep `.kfl-chip-*` classes (introduced in PR-W3 #99) onto existing markup that currently uses inline state styling. Use this AFTER PR-W3 is merged.

## When to use

Anywhere there's an inline status badge that hand-rolls color + padding + border. Common patterns to look for:

```html
<!-- Pattern A: hand-rolled pill with inline color -->
<span style="background: #ECFDF5; color: #047857; padding: 2px 8px; ...">Pro</span>

<!-- Pattern B: Tailwind-only state pill -->
<span class="rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-xs font-bold">פעיל</span>

<!-- Pattern C: kfl-badge from PR-A2 admin (similar but admin-scoped) -->
<span class="kfl-badge kfl-badge-ok">OK</span>
```

All of these can become:
```html
<span class="kfl-chip kfl-chip-success">Pro</span>
```

## Decision table

| Existing pattern | Variant to use |
|---|---|
| Green / "פעיל" / "OK" / "במסלול" | `kfl-chip-success` |
| Amber / "Trial" / "תקוע" / "pending" | `kfl-chip-warn` |
| Red / "Error" / "חריגה" / "Overdue" | `kfl-chip-danger` |
| Purple / "Pro" / "AI" / "Premium" | `kfl-chip-premium` |
| Cyan / "Info" / "מידע" | `kfl-chip-info` |
| Slate / "?"  / "Unknown" / default | `kfl-chip-neutral` |

## Steps

1. **Grep for candidates**:
   ```bash
   grep -rn "rounded-full.*bg-emerald-\|rounded-full.*bg-amber-\|rounded-full.*bg-red-\|rounded-full.*bg-purple-" --include="*.html" .
   ```

2. **For each match, decide:** does it represent a STATE (use chip) or just a visual accent (leave alone)?

3. **Replace the inline span** with the chip class. Preserve any surrounding content (icon, dot, etc).

4. **Validate inline scripts** — `node -e` validator on each touched HTML.

5. **Run full_qa**.

## Critical rules

- Don't apply chips to elements that aren't STATES. A purple icon background that's just decoration shouldn't become `.kfl-chip-premium`.
- Don't break Tailwind utility specificity. If the existing markup has 10 utility classes, the chip only replaces the color/pad/radius/border ones.
- Don't sweep into pages with open PRs touching them (check `gh pr list` first).

## Anti-patterns

- Don't gold-plate by adding chips to every status display. The chip system is for surfaces where consistent state-reading matters (admin tables, dashboard tiles, account pages).
- Don't ship a "convert 200 inline pills to chips" mega-PR. Split per-page or per-section.
- Don't apply chips to bot reply text — bot lives in WhatsApp; emoji + bold + plain text only.

## Examples

PR-W3 (#99) shipped the chip system without applying anywhere — by design, per "scope discipline" in `brand-token-extend` skill.

Future PRs to sweep:
- admin.html — convert legacy `.kfl-badge-*` (PR-A2) usages to `.kfl-chip-*` for consistency
- dashboard.html MoM card — color tier could become chip
- pricing.html — "Pro" tier badge
