# admin-stat-card-pr-a2

Add a new stat card to `admin.html` using the typography utilities introduced in PR-A2 (#88). Replaces the legacy inline `text-3xl font-black style="color:#0f1422;"` pattern.

## When to use

Steven wants a new KPI on /admin (e.g. "show me total VAT collected this month").

## Anatomy

```html
<div class="card card-hover p-5">
  <div class="flex items-center justify-between">
    <div class="kfl-kpi-eyebrow">HEBREW LABEL</div>
    <!-- 18px Lucide-style SVG icon, cyan stroke #06b6d4 -->
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <!-- path... -->
    </svg>
  </div>
  <div class="mt-3 kfl-kpi-num" id="kfl-kpi-NAME">—</div>
  <div class="mt-1 kfl-kpi-sub">sub-label in Hebrew</div>
</div>
```

## Variants

- Default cyan eyebrow: just `.kfl-kpi-eyebrow`
- Warning state: `.kfl-kpi-eyebrow.warn` + amber SVG (`#f59e0b`)
- Critical state: `.kfl-kpi-eyebrow.crit` + red SVG (`#ef4444`)

## Populator (in the `loadKpi` IIFE)

```js
set('kfl-kpi-NAME', d.METRIC || '—');
```

## SVG icon picker

Use Lucide icons (https://lucide.dev — copy the SVG path directly). Don't introduce emoji icons — admin is for CEO-glance, not playful.

## Grid

The KPI strip uses `grid-cols-2 md:grid-cols-3 lg:grid-cols-6`. Adding a 7th card pushes one to a new row on lg — usually fine but verify.

## Status badges inside a card

For a card that needs a state pill (e.g. "Pro" badge on a paying-customers card), use the `.kfl-badge` utility from PR-A2:

```html
<span class="kfl-badge kfl-badge-ok">Pro</span>
<span class="kfl-badge kfl-badge-warn">Trial</span>
<span class="kfl-badge kfl-badge-crit">Overdue</span>
```

## Verification

- `node -e` inline-script validator on admin.html → all 6 blocks OK
- `node tests/full_qa.js` → 118/118

## Anti-patterns

- Don't use the legacy `font-display text-3xl font-black style="color:#0f1422;"` inline. Use `.kfl-kpi-num`.
- Don't use emoji icons on admin (use SVG). Dashboard is OK.
- Don't show raw private financial data on admin without masking — per privacy/security audit rules.
- Don't add a card whose data source isn't in `/api/admin?action=stats`. Either extend that endpoint or split to a separate PR.

## Examples

- PR-A2 (#88) — all 6 KPI cards converted to `.kfl-kpi-*`
- See admin.html lines 264-316 for the canonical 6-card strip
