# dashboard-card-data-bound

Add a new KPI / stat card to `dashboard.html` that reads from the EXISTING `renderDashboard(d)` payload. **No new endpoint, no new fetch, no schema change.** Pattern used by PR-D3 (hero strip) and PR-D4 (MoM + top-category cards).

## When to use

User wants to "see X on the dashboard" and X is already computable from existing data in `d`. Examples:
- "Show me my biggest category" → uses `d.top_categories[0]`
- "What's my month-over-month change" → uses `d.month_expenses_delta_pct`
- "How many days are left in the month" → computed via `new Date()`

## When NOT to use

- The data isn't in `d` yet. Then you need to extend the backend endpoint first (separate PR).
- It needs cross-month aggregation that requires new SUMIFS. Backend PR first.

## Anatomy of a KPI card

```html
<div class="stat-card min-w-0 rounded-2xl border border-ink-200 bg-white p-6 shadow-soft dark:border-ink-700 dark:bg-ink-800" id="card-NAME">
  <div class="flex items-center justify-between">
    <div class="text-sm font-semibold text-ink-500 dark:text-ink-300">Hebrew label</div>
    <div id="NAME-icon" class="grid h-7 w-7 place-items-center rounded-lg bg-ink-100 text-ink-500 dark:bg-ink-700 dark:text-ink-300">↗</div>
  </div>
  <div class="mt-2 text-3xl font-black">
    <span class="num stat-num text-ink-900 dark:text-white" id="NAME-value">—</span>
  </div>
  <div class="mt-1 text-xs font-medium text-ink-500 dark:text-ink-400" id="NAME-sub">—</div>
</div>
```

Insert it inside `<section id="summary-cards">` (around dashboard.html line 844 area). Bump the grid columns if needed:
- 4 cards → `md:grid-cols-4`
- 5-6 cards → `md:grid-cols-3 lg:grid-cols-6`

## Populator (in renderDashboard)

```js
// --- PR-DX: short description of what this card shows.
try {
  var el = document.getElementById('NAME-value');
  var subEl = document.getElementById('NAME-sub');
  var iconEl = document.getElementById('NAME-icon');
  if (CONDITION && el) {
    el.textContent = formatValue(d.X);
    el.className = 'num stat-num ' + colorForValue(d.X);
    if (subEl) subEl.textContent = subLabel(d.X);
    if (iconEl) {
      iconEl.textContent = arrowFor(d.X);
      iconEl.className = 'grid h-7 w-7 place-items-center rounded-lg ' + iconBgFor(d.X);
    }
  } else if (el) {
    el.textContent = '—';
    if (subEl) subEl.textContent = 'אין מספיק נתונים';
  }
} catch (_err) { /* never block render */ }
```

## Critical rules

1. **Always wrap populator in try/catch.** A missing field must NEVER block the rest of the dashboard.
2. **Color-code:** red for bad/over, green for good/down, grey for ±2% flat zone, amber for warn.
3. **Use Hebrew labels in markup**, English IDs in JS. RTL-safe.
4. **Numbers use `.num` class + `dir="ltr"`-isolated** so big numerals render correctly in RTL context.
5. **Empty state matters:** "אין מספיק נתונים" / "אין הוצאות החודש" — never blank.
6. **Don't break the grid** on mobile (320px). Test at 320 / 375 / 768 / 1024 / 1280.

## Verification

- `node -e` inline-script validator on dashboard.html → all 17+ blocks parse
- `node tests/full_qa.js` → 118/118
- Manual: open with real data + as empty new user → both states render

## Examples

- PR-D3 (#89) — Financial Overview hero with 3 metrics + status pill
- PR-D4 (#98) — MoM + top-category cards

## Anti-patterns

- Don't fetch new data in renderDashboard. The function is sync after data lands.
- Don't add a card that reads `d.X` where `X` isn't documented in the backend.
- Don't gold-plate with charts/sparklines if a single number tells the story.
- Don't forget the `try/catch` — one undefined throws and the whole dashboard goes blank.
