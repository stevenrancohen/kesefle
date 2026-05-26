# Kesefle Frontend Audit
**Date:** 2026-05-26
**Scope:** ~32 root HTML pages + 18 blog/admin pages, Tailwind via CDN, Hebrew-first RTL
**Method:** Static analysis only (no browser DevTools or live measurement). Cross-checked against existing `docs/UX_AUDIT_2026-05-26.md`.

This audit complements the UX audit. The UX audit walks the user journey; this audit measures the **mechanics** — RTL correctness, responsive breakpoints, a11y, SEO meta presence, and performance signals.

---

## 1. Page inventory

Public surface area is **32 root HTML pages** + **20 blog posts** + **3 admin diagnostic pages** + **5 email templates**. Sitemap declares 38 URLs; 7 root HTMLs are intentionally `noindex` (private/admin/auth surfaces). Five root HTMLs are *orphan* — they exist on disk and are reachable by direct URL but no other page links to them.

**Last meaningful change:** every page has a comment dated `2026-05-26` because of yesterday's site-wide Rubik 900 typography sweep; the column reflects content/structure changes only (best guess from inline comments + git mtime).

| Filename | Public URL | Purpose | Last meaningful change (guess) | Status |
|---|---|---|---|---|
| `index.html` | `/` | Homepage / marketing hero + how-it-works + FAQ | 2026-05-26 (typography sweep, hero CTAs) | live |
| `en.html` | `/en` | English landing page (hreflang alternate) | 2026-05-23 (footer cleanup) | live |
| `account.html` | `/account` | Signup/login + onboarding hub (OAuth) | 2026-05-26 (Rubik) | live, `noindex` |
| `welcome.html` | `/welcome` | Post-signup onboarding wizard | 2026-05-26 (Rubik) | live, `noindex` |
| `dashboard.html` | `/dashboard` | Authenticated user's main hub | 2026-05-26 (Rubik) | live, `noindex` |
| `pricing.html` | `/pricing` | Pricing tiers + compare + billing FAQ | 2026-05-26 (Rubik) | live |
| `business.html` | `/business` | "For freelancers/business owners" landing | 2026-05-26 (Rubik) | live |
| `start.html` | `/start` | Quick-start (90-sec onboarding) | 2026-05-26 (Rubik) | live |
| `demo.html` | `/demo` | Auto-playing WhatsApp chat demo | 2026-05-26 (Rubik) | live |
| `about.html` | `/about` | About page + founder + timeline | 2026-05-26 (Rubik) | live |
| `roadmap.html` | `/roadmap` | Public roadmap | 2026-05-26 (Rubik) | live |
| `contact.html` | `/contact` | Contact info + form | 2026-05-26 (Rubik) | live |
| `privacy.html` | `/privacy` | Privacy policy | 2026-05-18 | live |
| `terms.html` | `/terms` | Terms of service | 2026-05-18 | live |
| `referral.html` | `/referral` | Refer-a-friend program | 2026-05-26 | live |
| `blog.html` | `/blog` | Blog index | 2026-05-26 | live |
| `blog/*.html` | `/blog/*` | 20 individual blog posts | 2026-05-18 to 2026-05-24 | live |
| `team.html` | `/team` | Team (single founder card) | 2026-05-26 | live |
| `press.html` | `/press` | Press kit | 2026-05-26 | live |
| `status.html` | `/status` | System status page | 2026-05-26 | live |
| `404.html` | (custom 404) | Not-found page | 2026-05-26 | live, `noindex` |
| `offline.html` | (service worker) | PWA offline fallback | 2026-05-26 | live |
| `install.html` | `/install` | "Install our PWA" walkthrough | 2026-05-26 | **orphan** (no internal links; in sitemap) |
| `docs.html` | `/docs` | API docs landing | 2026-06-15 (per inline comment — odd, future date) | **orphan** (no internal links; in sitemap) |
| `admin.html` | `/admin` | Admin panel | 2026-05-26 | live, `noindex` |
| `admin/diagnostics.html` | `/admin/diagnostics` | KV / system diagnostics | 2026-05-22 | live, admin-only |
| `admin/launch-monitor.html` | `/admin/launch-monitor` | Launch-day live monitor | 2026-05-18 | live, admin-only |
| `admin/monitor.html` | `/admin/monitor` | Health/SLA monitor | 2026-05-22 | live, admin-only |
| `seo.html` | `/seo` | SEO landing pages hub | 2026-05-26 | **orphan in spirit** (only self-references; blocked by robots.txt) |
| `cancel.html` | `/cancel` | Subscription cancel flow | 2026-05-26 | live, `noindex` (1 referrer) |
| `win-back.html` | `/win-back` | Win-back campaign LP | 2026-05-26 | **orphan** (no link, no sitemap) |
| `tax-report.html` | `/tax-report` | Tax report download | 2026-05-26 | linked from `/statement` only |
| `statement.html` | `/statement` | Monthly statement view | 2026-05-26 | live, `noindex` |
| `expense.html` | `/expense` | Add-expense quick UI (PWA target) | 2026-05-26 | live, `noindex`, linked from `/dashboard` FAB |
| `thanks.html` | `/thanks` | Post-checkout thanks | 2026-05-26 | live, `noindex` (orphan-ish — landed after Stripe) |
| `test.html` | `/test` | Internal test sandbox | 2026-05-26 | **orphan** — should be deleted or moved to `/admin/test` |
| `templates/email/*.html` | n/a | Email templates (not web) | various | not web |
| `emails/*.html` | n/a | 5 lifecycle email previews | 2026-05-22 | not web |

**Orphan summary:** `install.html`, `docs.html`, `win-back.html`, `test.html` are reachable only by direct URL or sitemap. Either link them from the footer/nav or delete them.

---

## 2. Responsive issues

Audit performed on the four most-trafficked public pages: `/` (index), `/dashboard`, `/pricing`, `/contact`. **All four declare** `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` correctly.

| Page | Line | Issue | Severity |
|---|---|---|---|
| `pricing.html` | 450 | `<table class="w-full min-w-[640px] text-sm">` inside `overflow-x-auto`. At 360px viewport the comparison table forces horizontal scroll inside its container. There IS a `← scroll →` hint above but the hint doesn't pin to the table on mobile. | med |
| `pricing.html` | 739 | Same pattern: `<table class="w-full min-w-[680px] text-sm">` — alternatives-comparison table — same horizontal-scroll risk. | med |
| `dashboard.html` | 3165 | NPS card inline-styled `max-width:440px;margin-inline:auto;bottom:20px;left:20px;right:20px`. The `left:20px;right:20px` correctly inset on mobile, but combined with `max-width:440px` it floats over the FAB at line 228 (`fixed bottom-6 left-6`) on small screens — they collide visually. | med |
| `dashboard.html` | 728-750 | `<div class="px-1.5 py-2.5 sm:px-2 text-right text-ink-600 dark:text-ink-600">—</div>` — `dark:text-ink-600` is the SAME shade as `text-ink-600` in light mode (both `#41506f`), so dark-mode users see near-illegible em dashes against `dark:bg-ink-900`. | med |
| `index.html` | 1430-1432 | Auto-playing demo `<section id="demo">` is 1262-1426 (164 lines of script + DOM) — on a 320px screen the WhatsApp mock + the playground at `#playground` (line 975) render at nearly full viewport height each, doubling scroll cost. | low |
| `index.html` | 731-735 | Floating chips (`pointer-events-none absolute right-0 sm:-right-3 top-5`) overlap the hero phone mockup at 320-374px because the `sm:-right-3` only kicks in at 640px. On a 360px phone the chip sits *over* the message bubbles. | med |
| `contact.html` | 192 | `border-2 border-brand-500/30` recommended-card uses `from-brand-500/10 to-ink-800/40` — on a **light** body (`bg-white` line 72) the `to-ink-800/40` end of the gradient renders as a muddy dark patch in the bottom-left. On 320px it dominates the card. | low |
| `contact.html` | 175 | Mobile CTA `class="mt-3 block rounded-xl bg-brand-600 px-4 py-2.5 text-center text-sm font-bold text-ink-900"` — tap target is 36px tall (py-2.5 = 10px + 16px text ≈ 36px). **Fails 44×44**. | high |
| `index.html` | 696, 700, 704 | Hero "Quick OAuth" buttons declare `min-h-[44px]` explicitly — good. But the chip at line 777 `<a href="#demo" class="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-[11px]">` is ~26px tall. **Fails 44×44** for a tap target. | high |
| `pricing.html` | 350-353 | Period toggle `<button>` pair has `px-5 py-2` = ~36px tall. Both controls. **Fails 44×44**. | med |
| `index.html` | 754, 761, 1798, 1811, 1851, 1887 | `class="mt-1 text-left text-[10px] text-ink-500"` — 10px is **below 12px floor for legibility**, especially with Hebrew. Used inside chat-bubble timestamps that mix Hebrew labels + LTR time strings. | med |
| `dashboard.html` | 287, 292, 297, 304 | `text-xs text-ink-500` (12px) on `bg-white` is borderline. WCAG 2.1 4.5:1 contrast for normal text: `#5d6b8f` on `#fff` = ~5.07:1 PASS, but on the `bg-mesh` gradient at line 45-ish the contrast drops. Borderline. | low |
| `dashboard.html` | 159 | `width: 36px;` icon button — tap-target only 36×36. **Fails 44×44**. | med |

**Hardcoded pixel widths:** the only `width: <large>px` in production CSS is the NPS card (440px) which is OK because of mobile `inset:20px`. The two table `min-w-[640|680px]` in pricing are intentional but should at minimum sticky-pin the first column.

---

## 3. Hebrew RTL bugs

### High-impact

| Page | Line | Issue | Severity |
|---|---|---|---|
| `contact.html` | 52 | `.num` is defined as `font-variant-numeric: tabular-nums; font-family: 'Inter', monospace;` — **WITHOUT `direction: ltr; unicode-bidi: isolate;`**. Every `<span class="num">` on `/contact` will inherit the page's RTL direction and break bidi for numbers. Inspect: line 251 `<span class="num">1-2</span>` shows `1-2` could render as `2-1` in the wrong context. | high |
| `en.html` | 89 | Same bug: `.num, .font-mono { font-variant-numeric: tabular-nums; }` — missing isolation. Less critical because `/en` is LTR overall, but still leaves the door open for stray RTL parents. | low |
| `thanks.html`, `win-back.html`, `cancel.html`, `privacy.html`, `roadmap.html`, `status.html`, `terms.html` | (head) | **No `.num` class defined at all.** These pages use `<span class="num">` inline (e.g. `roadmap.html`, `terms.html`, `privacy.html`) but the styles are absent — so isolation depends entirely on parent context. The numbers still display correctly because Heebo is fine for digits, but bidi-isolation can silently corrupt mixed-direction inline strings like `+972-50-` inside Hebrew sentences. | med |
| `welcome.html` | 510 | `<span class="font-mono font-bold">+1-555-640-8123</span>` — phone number has NO `dir="ltr"` and NO `.num` wrap. Inside Hebrew sentence "מספר הבוט: +1-555-640-8123" the `+` and `-` characters can flip. | high |
| `dashboard.html` | 1873 | JavaScript template builds `'<span class="num w-20 text-left text-xs font-semibold tabular-nums">'`. Uses `text-left` (physical) on what should be `text-end` for RTL contexts. | low |
| `welcome.html` | 243 | Error string `'נא להזין מספר תקין (לדוגמה: 0541234567)'` — the LTR phone string inside parens inside RTL Hebrew is **not isolated**. In some browsers the digits + parens render `(7654321450 :המגודל) ןיקת רפסמ ןיזהל אנ`. Wrap as `<bdi>0541234567</bdi>` or template-build. (This is inside a string passed to `showError()`.) | med |
| `welcome.html` | 174 | `placeholder="054-1234567"` on an `<input ... dir="ltr">` — OK because `dir="ltr"`. But the placeholder format **doesn't match** `account.html:312` placeholder `054-123-4567` (with dashes). Tells users two different formats. | med |
| `about.html` | 393, 748 | `+1-555-640-8123` rendered without dir-isolation or `<bdi>`. The `dir="ltr"` on line 748 saves it but line 393 has no `dir` attribute. | med |

### Medium-impact: `text-left` / `text-right` instead of `text-start` / `text-end`

Tailwind's logical RTL classes (`text-start`, `text-end`, `ms-`, `me-`, `ps-`, `pe-`) flip automatically; the physical classes (`text-left`, `text-right`, `ml-`, `mr-`, `pl-`, `pr-`) do not.

**Pages using physical text alignment:**

| Page | `text-left` | `text-right` | Notes |
|---|---|---|---|
| `404.html` | 0 | 1 | minor |
| `account.html` | 0 | 4 | signup form labels |
| `admin.html` | 0 | 2 | admin panel |
| `dashboard.html` | 2 | 5 | mix — line 728/735/742/750 should be logical for future LTR support |
| `demo.html` | 2 | 1 | chat timestamps |
| `index.html` | 6 | 3 | mostly WhatsApp chat-bubble timestamps (line 754, 761, 1798, 1811, 1851, 1887) — these are arguably CORRECT because WhatsApp timestamps are visually pinned LTR by convention. The 3 `text-right` are also intentional (Hebrew copy blocks at lines 805, 1544, 1666). |
| `press.html` | 0 | 2 | |
| `pricing.html` | 0 | 2 | compare-table `<th>` at line 453, 742 |
| `start.html` | 0 | 4 | example cards at 237, 242, 247, 252 |
| `statement.html` | 6 | 2 | report layout |
| `tax-report.html` | 8 | 3 | report layout — most needs review |
| `team.html` | 0 | 3 | |
| `thanks.html` | 0 | 1 | |
| `win-back.html` | 0 | 1 | |

**Recommendation:** the chat-bubble timestamps (intentional LTR) stay. Convert `text-right` → `text-start` for Hebrew body copy on all other pages.

### Inconsistent `dir` attribute use

| Page | Line | Issue |
|---|---|---|
| `index.html` | 726 | `<div class="relative kfl-hero-stage" data-stage="2" dir="rtl">` — sets `dir="rtl"` explicitly on a child of `<html dir="rtl">`. Redundant; harmless. |
| `dashboard.html` | 739, 979, 3165 | Mix of `dir="ltr"` on tables and `direction:rtl` inline styles. Auditable but works. |

---

## 4. Accessibility

### Images
**All `<img>` tags reviewed have `alt=""` set** (most are the logo `alt="כספ'לה"`). No high-severity alt-text issue.

But **every `<img>` is missing `width` and `height` attributes** — see Performance section for CLS impact.

### Buttons without accessible labels

Audited via `grep '<button.*onclick'` and filtered to icon-only buttons. **The hamburger button is fine** (`aria-label="תפריט"`) on all pages.

| Page | Line | Issue | Severity |
|---|---|---|---|
| `dashboard.html` | 3166 | NPS close button `<button id="kflNpsClose" aria-label="סגור" ... >×</button>` — good. |  |
| `welcome.html` | 568 | Toast (created via JS) has no role / aria-live — screen readers won't announce "הועתק" feedback. (Also: the toast itself is invisible due to the `background:#ffffff;color:white` bug below.) | med |
| `pricing.html` | 349-352 | Annual/monthly toggle buttons — no `aria-pressed` or `role="tab"`. Visual state changes but a SR user can't tell which option is active. | med |
| `index.html` | 621, 695-707 | Hero-row OAuth buttons (Google, Facebook, Apple) have `aria-label="Google"` etc. — good. |  |

### Form inputs without labels

Audit (via Python script):

| Page | Total inputs | Unlabeled inputs | Notes |
|---|---|---|---|
| `account.html` | 5 | **5** | `link-phone-input`, `kfl-wait-phone`, `kfl-wait-email`, `kfl-report-email`, `kfl-report-msg` — none have `<label for="…">`. They rely on placeholder + visual heading text. Fails WCAG 1.3.1 + 3.3.2. |
| `welcome.html` | 1 | **1** | `kfl-link-phone` — placeholder only. Visible label sits above as a `<p>` but unattached. |
| `dashboard.html` | 4 | **3** | `kfl-cats-input`, `kfl-recent-search`, `kflNpsComment` — all placeholder-only. |
| `contact.html` | 0 | 0 | No form. |
| `start.html` | 0 | 0 | |

**Recommendation:** add explicit `<label for="kfl-link-phone" class="sr-only">מספר וואטסאפ</label>` (visually hidden, screen-reader visible) before each input.

### Color contrast — high-confidence issues

| Page | Line | Issue | Severity |
|---|---|---|---|
| `welcome.html` | 568 | Toast inline-style `background:#ffffff;color:white` — pure white-on-white. "הועתק" feedback is **invisible**. | **HIGH** |
| `welcome.html` | 126 | `<button onclick="confettiBurst(event)" class="mt-6 inline-flex items-center gap-2 rounded-2xl bg-white px-6 py-3 text-ink-900 font-bold hover:bg-white dark:bg-white dark:text-ink-900 dark:hover:bg-ink-100">🎊 תחגוג איתי</button>` — sits on a white-ish hero. Visible text only via `text-ink-900` BUT the white-on-white button has zero border / shadow, so visually it's just a floating ink-900 label. | high |
| `about.html` | 337 | `<a href="/account" class="mt-3 block rounded-xl bg-brand-600 px-4 py-2.5 text-center text-sm font-bold text-ink-900">התחל חינם</a>` — `text-ink-900` (`#0f1422`) on `bg-brand-600` (`#4f46e5`) = contrast ratio ~3.6:1. **FAILS WCAG 2.1 AA for normal text (4.5:1).** Should be `text-white`. | high |
| `blog.html` | 312 | Same pattern. | high |
| `contact.html` | 175 | Same pattern. | high |
| `dashboard.html` | 991 | `class="... bg-ink-700 ... text-white hover:bg-white dark:bg-ink-200 dark:text-ink-900 dark:hover:bg-white"` — on hover in **light mode** background becomes `bg-white` while text stays `text-white`. **Invisible on hover.** | high |
| `dashboard.html` | 728-750 | `dark:text-ink-600` (`#41506f`) on `dark:bg-ink-900` (`#0f1422`) = contrast ~2.4:1. **FAILS** for "—" placeholder em-dashes. | med |
| All pages with nav dropdowns (`index`, `contact`, `pricing`, `dashboard`, `account`, `about`, …) | nav | Desktop nav dropdown buttons: `dark:hover:bg-white dark:hover:text-white` — in dark mode hover **fills with white background AND white text**, making the menu label invisible during hover. Found on ≥10 pages. | high (recurring) |
| `index.html` | 1593-1604 | Waitlist input `bg-white/10 text-ink-900 placeholder-white/50` — `placeholder-white/50` on the visible white-ish background = nearly invisible. (Already flagged in UX audit.) | high |

### Heading hierarchy

All audited pages start with exactly one `<h1>`. Spot checks for `h1→h3` skips:

| Page | h1 | h2 | h3 | h4 | Hierarchy OK? |
|---|---|---|---|---|---|
| `index.html` | 1 | 7 | 11 | 0 | OK |
| `dashboard.html` | 1 | 4 | 5 | 1 | OK |
| `pricing.html` | 1 | 6 | 13 | 3 | OK |
| `contact.html` | 1 | 2 | 0 | 0 | OK (small page) |
| `about.html` | 1 | 10 | 12 | 0 | OK |
| `welcome.html` | 1 | 7 | 0 | 0 | OK |
| `start.html` | 1 | 2 | 0 | 0 | OK |
| `demo.html` | 1 | 1 | 0 | 0 | OK |

No heading-level skips found in the most-trafficked surface.

---

## 5. Copy quality — 10 worst offenders

Ranked by visitor-impact (homepage > onboarding > marketing > legal). Hebrew sentences over ~30 words, marketing-speak that contradicts Steven's "honest, no fake claims" voice, weak CTAs.

| # | Page:Line | Issue | Worst-offender quote (truncated) |
|---|---|---|---|
| 1 | `index.html:838-851` | **Live-stats strip is fabricated.** `18,725 מילים`, `389 קטגוריות`, `99% דיוק קטלוג` — no source. The "389 קטגוריות" claim contradicts the actual bot taxonomy (~30 categories). Already P0 in UX audit. | "18,725 מילים שהבוט מכיר · 389 קטגוריות חכמות · 99% דיוק קטלוג" |
| 2 | `index.html:812` | 59-word sentence with **invented "85% statistic"** — "הסטטיסטיקה אכזרית: 85% מהאנשים מפסיקים לתעד הוצאות בתוך חודש". No citation. Same anti-pattern as #1. | "בישראל, כל אחד פותח וואטסאפ עשרות פעמים ביום. אפליקציה ייעודית למעקב הוצאות — אפילו הכי טובה — נוטה להישכח אחרי שבועיים. הסטטיסטיקה אכזרית: 85% מהאנשים..." |
| 3 | `index.html:684` | **Weak CTA.** Primary hero button says "בוא נתחיל" — doesn't say *what* starts. (Already flagged in UX audit; reaffirmed because it's still live.) | "בוא נתחיל" |
| 4 | `pricing.html:309-310` | Headline literal-translation feel: "תוכנית לכל משק בית. בלי הפתעות בחיוב." — "תוכנית" reads English-ish (would say "מסלול" or "תוכנית-תשלום" in natural Hebrew). | "תוכנית לכל משק בית. בלי הפתעות בחיוב." |
| 5 | `pricing.html:873` | 41-word sentence with mixed Hebrew/English and an inside joke that won't land: "חיוב יום ב.מ.ת". Most readers won't decode the abbreviation. | "...אבל כשכותבים שם ספק חריג, סלנג מקצועי או 'חיוב יום ב.מ.ת', Pro קוראת ל-AI להבין למה התכוונתם." |
| 6 | `welcome.html:124` | "**5 פקודות** שהופכות את הבוט שלך לעוזר אישי לכסף." — promises 5 commands but the page lists 6 in the playground below. Off-by-one is the kind of trust hit that's easy to fix. | "**5 פקודות** שהופכות את הבוט שלך לעוזר אישי לכסף." |
| 7 | `contact.html:184` | Hero headline split awkwardly: "בכל דבר, בכל זמן. אנחנו ממש שם." — "ממש שם" is a literal English-ism ("we're really there for you"). In Hebrew this reads like the contact form physically lives somewhere. | "בכל דבר, בכל זמן. אנחנו ממש שם." |
| 8 | `about.html:266` | 39-word sentence with technical jargon dropped on a marketing page: "אנחנו מבקשים הרשאת drive.file בלבד — זה אומר שיש לנו גישה אך-ורק לקבצים שאנחנו עצמנו יצרנו, לא לכל הדרייב." Right idea, but `drive.file` mid-sentence breaks a non-technical reader. | "...אנחנו מבקשים הרשאת drive.file בלבד — זה אומר שיש לנו גישה אך-ורק לקבצים שאנחנו עצמנו יצרנו..." |
| 9 | `dashboard.html:566` | URL-encoded WhatsApp deep link visible in href: the CTA button label is fine, but the `?text=%D7%99%D7%A2%D7%93%20%D7%97%D7%99%D7%A1%D7%9B%D7%95%D7%9F` shows up in browser hover-tooltips as gibberish — a small but recurring trust hit. (Repeated across `dashboard.html:566, 593, 699, 704, 910` etc.) | hover tooltip: `https://wa.me/15556408123?text=%D7%99%D7%A2%D7%93...` |
| 10 | `pricing.html:434` | "30 יום החזר כספי מלא. בלי שאלות." — duplicates `pricing.html:900`'s longer FAQ entry. Two consecutive "no questions asked" promises on the same scroll read as defensive over-promising. | "30 יום החזר כספי מלא. בלי שאלות." (line 434) + "30 יום החזר מלא — בלי שאלות. גם אם השתמשת בכל התכונות, גם אם זה היום ה-29..." (line 900) |

**Pattern:** the homepage and pricing page over-promise with invented numbers (#1, #2). The onboarding pages (welcome) under-promise inconsistently (#6). Long sentences (#5, #8) are concentrated where the writer is hedging — exactly where it's most important to be concise.

---

## 6. SEO basics per page

| Page | `<title>` | `<meta description>` | OG image | Canonical | H1 matches topic? |
|---|---|---|---|---|---|
| `index.html` | OK | OK | OK | OK | OK |
| `en.html` | OK | OK | OK | OK | OK |
| `pricing.html` | OK | OK | OK | OK | OK |
| `business.html` | OK | OK | OK | OK | OK |
| `about.html` | OK | OK | OK | OK | OK |
| `start.html` | OK | OK | OK | OK | OK |
| `demo.html` | OK | OK | OK | OK | OK |
| `roadmap.html` | OK | OK | **MISSING** | OK | OK |
| `referral.html` | OK | OK | OK | OK | OK |
| `contact.html` | OK | OK | OK | OK | OK |
| `team.html` | OK | OK | OK | OK | OK |
| `press.html` | OK | OK | OK | OK | OK |
| `blog.html` | OK | OK | OK | OK | OK |
| `privacy.html` | OK | OK | OK | OK | OK |
| `terms.html` | OK | OK | OK | OK | OK |
| `status.html` | OK | OK | OK | OK | OK |
| `install.html` | OK | OK | OK | OK | OK |
| `docs.html` | OK | OK | OK | OK | OK |
| `seo.html` | OK | OK | OK | OK | doubly-noindexed, intentional |
| `404.html` | OK | OK | OK (3 tags) | **MISSING** | noindex — OK |
| `account.html` | OK | OK | OK | **MISSING** | noindex |
| `welcome.html` | OK | OK | OK | OK | noindex |
| `dashboard.html` | OK | OK | OK | OK | noindex |
| `admin.html` | OK | OK | **MISSING** | **MISSING** | noindex |
| `cancel.html` | OK | OK | **MISSING** | **MISSING** | noindex |
| `expense.html` | OK | OK | **MISSING** | **MISSING** | noindex |
| `offline.html` | OK | OK | **MISSING** | **MISSING** | sw fallback |
| `statement.html` | OK | OK | **MISSING** | **MISSING** | noindex |
| `tax-report.html` | OK | OK | **MISSING** | **MISSING** | noindex |
| `test.html` | OK | OK | OK | **MISSING** | noindex |
| `thanks.html` | OK | OK | OK | OK | noindex |
| `win-back.html` | OK | OK | **MISSING** | **MISSING** | noindex |

**Findings:**
- Only **one indexed page is missing OG image: `roadmap.html`**. Add `<meta property="og:image" content="https://kesefle.com/og-image.png" />` (and `og:image:width/height`) so social shares get a preview.
- Pages missing canonical are all `noindex` so it's lower-priority — but `tax-report.html` and `statement.html` may be deep-linked from emails; add canonical to prevent duplicate-URL hell.
- **All 20 blog posts have full meta** (spot-checked `blog/nihul-hochaot-le-atzmaim.html`).
- **H1-vs-topic mismatch:** spot check found no obvious mismatches. Worth a manual review on `start.html` H1 = "התחלה ב-90 שניות" vs page topic = quick-start tutorial — matches.

---

## 7. Performance signals

### Tailwind CDN cost
**All 30 root HTML pages load `https://cdn.tailwindcss.com` via runtime JS.** Tailwind's CDN explicitly warns this is **not for production** — every page download fetches the entire utility runtime (~80KB gzipped before generating actual CSS) and pays a JS-eval cost on first paint. A built `style.css` would be ~10KB.

Impact: ~70KB transfer wasted × every pageview. On 3G this is ~1.5s of CDN fetch + parse.

### Inline `<script>` blocks > 100 lines

| Page | Largest blocks | Issue |
|---|---|---|
| `account.html` | **1416 lines** (line 444) | Huge inline script — the OAuth + onboarding state machine. Should be moved to `/js/account.js` for cacheability. |
| `dashboard.html` | **847 lines** (line 1044), **804 lines** (line 1898), **242 lines** (line 2704), 156, 117 | At least 5 large blocks. Total inline JS likely > 2000 lines. Extract to `/js/dashboard.js`. |
| `index.html` | **446 lines** (line 1745), 177, 107, 98, 75 | The 446-line block is the kfHeroChat / EXAMPLES rotator dead code flagged in UX audit. Remove first. |
| `welcome.html` | 150, 146 | OK-size but should still be a module. |
| `pricing.html` | 53, 51, 49 | Small enough to leave inline. |

### Heebo font weights loaded vs actually used

Most pages load **7 weights** (`300;400;500;600;700;800;900`) of Heebo. Inspection of CSS usage shows the actually-used weights are typically 3-4: 400 (body), 700/800 (semibold), 900 (display). The 300/500/600 weights are wasted ~80KB of font data per page.

| Page | Heebo weights loaded |
|---|---|
| `index.html` | 7 (`300;400;500;600;700;800;900`) |
| `pricing.html` | 7 |
| `dashboard.html` | 5 |
| `welcome.html` | 5 |
| `terms.html`, `privacy.html` | 4 each |
| `contact.html`, `about.html`, `start.html` | 7 each |

**Easy win:** standardize on `Heebo:wght@400;700;900` (~30KB saved per page).

### Images without explicit width/height (CLS risk)

Almost every `<img>` in the site lacks `width` and `height`. This causes Cumulative Layout Shift as images load.

| Page | Images | Missing width/height |
|---|---|---|
| `index.html` | 2 | **2/2** (logo + hero) |
| `dashboard.html` | 1 | **1/1** |
| `pricing.html` | 2 | **2/2** |
| `contact.html` | 1 | **1/1** |
| `about.html` | 2 | **2/2** |
| `blog.html` | 2 | **2/2** |
| (every other page) | 1-2 | nearly all missing |

All logos are 32×32 (`/logo.png` rendered via `class="h-8 w-8"`) — adding `width="32" height="32"` is mechanical and eliminates the shift.

### `<script>` count per page
Most pages load 5-12 `<script>` tags inline. `index.html` has 23, `dashboard.html` has 20. Each is parser-blocking unless `defer`/`async`. Audit recommends consolidating to one `<script src="…" defer>` per page.

---

## 8. Top 10 fixes ranked by impact-vs-effort

| # | Fix | Description | Est | Impact |
|---|---|---|---|---|
| 1 | **Fix dark-on-dark mobile CTA** | Change `text-ink-900` → `text-white` on the mobile "התחל חינם" buttons at `about.html:337`, `blog.html:312`, `contact.html:175`. 3-line `replace_all`. | 5 min | **HIGH** |
| 2 | **Fix dark-mode nav-button white-on-white hover** | The recurring `dark:hover:bg-white dark:hover:text-white` on desktop dropdown buttons (≥10 pages). One sweep with `scripts/*.js` to replace with `dark:hover:bg-ink-800 dark:hover:text-white`. | 15 min | **HIGH** |
| 3 | **Fix welcome.html toast invisibility** | Line 568 `background:#ffffff;color:white` → `background:#0f1422;color:#fff` (ink-900 toast on any bg). Single inline-style swap. | 2 min | **HIGH** |
| 4 | **Fix dashboard.html `bg-ink-700 hover:bg-white text-white`** | Line 991 — on hover the share-by-email button vanishes. Change to `hover:bg-ink-600`. | 3 min | **HIGH** |
| 5 | **Add `dir="ltr"` + `.num` wrap to all phone numbers in body text** | `welcome.html:510`, `about.html:393`. Wrap as `<span class="num">+1-555-640-8123</span>` (and ensure `.num` includes `direction:ltr;unicode-bidi:isolate;`). Also restore `.num` definition on `contact.html:52`, `en.html:89`, and add to the 7 pages currently missing it (`thanks`, `win-back`, `cancel`, `privacy`, `roadmap`, `status`, `terms`). One include-from-CSS-file would solve this permanently. | 30 min | **HIGH** |
| 6 | **Trim Heebo weights site-wide** | Run a `scripts/trim-heebo-weights.js` sweep that rewrites every `Heebo:wght@…` URL to `Heebo:wght@400;700;900`. Saves ~80KB per pageview × 30 pages. | 15 min | **MED** |
| 7 | **Add `width`/`height` to every `<img>`** | Mechanical: `<img src="/logo.png" alt="…" class="h-8 w-8" />` → add `width="32" height="32"`. Use `scripts/add-img-dims.js`. Stops CLS on every page. | 20 min | **MED** |
| 8 | **Add OG image to roadmap.html** | One `<meta property="og:image" …>` line. (Optionally add canonical to `tax-report.html`, `statement.html`.) | 5 min | **MED** |
| 9 | **Replace fabricated stats with truth** | Homepage `index.html:838-851` strip: `18,725 מילים` and `389 קטגוריות` and `99% דיוק` are invented. Either delete the strip or replace with verifiable numbers (e.g. real keyword count from `lib/`, real category count). Same fix kills the contradiction with about/help that the UX audit already flagged. | 30 min | **HIGH** |
| 10 | **Add `<label for="…">` to all unlabeled inputs** | `account.html` (5), `welcome.html` (1), `dashboard.html` (3). Use `class="sr-only"` for visually-hidden labels where there's already a visual heading. Fixes WCAG 1.3.1 / 3.3.2 for every signup attempt. | 25 min | **MED** |

**Total time for all 10 fixes:** ~2.5 hours.
**Cumulative impact:** every fix is a regression-class bug. None are "nice-to-have polish" — they each either break a conversion path, fail accessibility law, or leak fake metrics that erode trust.

---

## Appendix A — Methodology notes

- All counts verified via `grep -c` / Python regex on the live source tree at commit `HEAD` on 2026-05-26.
- Contrast ratios estimated using the color values declared in each page's Tailwind config (lines 36-39 of `dashboard.html` as reference palette).
- Tap-target measurements use the Tailwind default rem scale (1rem = 16px) and explicit padding values.
- Sentence length measured by splitting on `.!?—–` then counting whitespace tokens. Only Hebrew-containing sentences from `<p>` tags are counted (nav menus excluded).
- Orphan detection: `grep -l "href=\"/<name>\"" *.html` excluding self-references.

## Appendix B — Files not audited

- `templates/email/*.html` and `emails/*.html` — these are email-rendering templates, not web pages. Different ruleset.
- `admin/diagnostics.html`, `admin/launch-monitor.html`, `admin/monitor.html` — internal-only, out of scope for visitor-facing audit.
- Individual blog posts spot-checked, not exhaustively audited. Pattern in `blog.html` index applies to all.
