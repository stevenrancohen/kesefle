# Frontend XSS / CSRF / secret-leak audit -- 2026-05-31

Scope: Public-facing HTML pages at repo root + `admin/*.html`. Excludes
`templates/email/*` (server-rendered, no JS exec), `emails/*` (broadcast
templates), worktrees, tests, and node_modules.

## Summary

- HTML pages scanned: 53 (53 root + 3 admin subpages; `templates/email/*`
  and `emails/*` excluded as static email bodies)
- `innerHTML` w/ unescaped user data: **1 confirmed live XSS** (admin.html
  activity feed) + 2 medium-risk (server-string concatenation in
  account.html error paths) + 4 low-risk (defensive cleanups)
- `eval` / `new Function` / `document.write`: **0** -- clean
- POST without auth header: many; **0** sensitive (all unauth endpoints
  validate via OAuth token in body, or are intentionally public)
- Secret in HTML source: **0** -- only references to env-var *names*
- Mixed content (`http://`): **0** -- all third-party links use https
- Service-worker auto-update: **deployed correctly** on every PWA page
  (the `controllerchange + reload` pattern from PR #13 is uniformly
  pasted)
- SRI hash on external scripts: **0** -- `cdn.tailwindcss.com`,
  `accounts.google.com/gsi/client`, Apple ID SDK, FB SDK loaded with no
  integrity attribute
- CSP / Referrer-Policy / X-Frame-Options meta tags: **0** on any page
  (relying entirely on Vercel response headers; not verified here)
- **Bugs found: 3** (1 high, 2 medium) + 4 defensive notes + 1 hygiene
  recommendation

## Per-page matrix

Risk legend: **H** high, **M** medium, **L** low/defensive, **--** none.

| Page                       | innerHTML | eval | POST safety        | Secrets | Mixed | SW   | Risk |
| -------------------------- | --------- | ---- | ------------------ | ------- | ----- | ---- | ---- |
| 404.html                   | --        | --   | log-only           | --      | --    | auto | --   |
| about.html                 | --        | --   | --                 | --      | --    | auto | --   |
| account.html               | escaped\* | --   | bearer + creds     | --      | --    | --   | **M** |
| admin.html                 | esc\*     | --   | bearer + creds     | --      | --    | --   | **H** |
| admin/diagnostics.html     | --        | --   | public action ok   | --      | --    | --   | --   |
| admin/launch-monitor.html  | --        | --   | bearer + creds     | --      | --    | --   | --   |
| admin/monitor.html         | --        | --   | --                 | --      | --    | --   | --   |
| blog.html (+ 19 posts)     | --        | --   | unauth waitlist    | --      | --    | auto | --   |
| cancel.html                | --        | --   | creds + cookie     | --      | --    | auto | --   |
| contact.html               | --        | --   | unauth submit      | --      | --    | --   | --   |
| dashboard.html             | escapeHtml| --   | creds + token      | --      | --    | --   | **L** |
| demo.html                  | escapeAndNumify | -- | --              | --      | --    | --   | --   |
| docs.html                  | --        | --   | --                 | (refs)  | --    | --   | --   |
| en.html                    | --        | --   | log-only           | --      | --    | --   | --   |
| expense.html               | --        | --   | creds + cookie     | --      | --    | auto | --   |
| index.html                 | escapeHtml| --   | OAuth-body auth    | --      | --    | auto | **L** |
| install.html               | --        | --   | --                 | --      | --    | auto | --   |
| offline.html               | hardcoded | --   | --                 | --      | --    | --   | --   |
| pricing.html               | --        | --   | creds + log        | --      | --    | auto | --   |
| privacy.html / terms.html  | --        | --   | --                 | --      | --    | auto | --   |
| referral.html / roadmap.html | --      | --   | --                 | --      | --    | --   | --   |
| start.html / seo.html      | --        | --   | --                 | --      | --    | --   | --   |
| statement.html             | escapeHtml| --   | --                 | --      | --    | auto | --   |
| tax-report.html            | escapeHtml| --   | --                 | --      | --    | auto | --   |
| team.html / press.html     | --        | --   | --                 | --      | --    | --   | --   |
| test.html                  | hardcoded | --   | unauth self-test   | --      | --    | --   | --   |
| thanks.html                | --        | --   | --                 | --      | --    | --   | --   |
| welcome.html               | escaped\* | --   | --                 | --      | --    | auto | --   |
| win-back.html              | hardcoded | --   | creds + cookie     | --      | --    | --   | --   |

\* uses `escapeHtml`/`esc` defensively at most call sites; specific
   exceptions noted in Findings.

## Findings

### F1 (HIGH) -- Stored XSS in admin activity feed

**File:** `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/admin.html`
**Lines:** 1659-1662, 1195-1206 (renderer)
**Severity:** HIGH

The activity-feed builder concatenates `x.email || x.name` -- raw user-
controlled signup strings -- into an `innerHTML` template without
escaping:

```js
// admin.html:1660 (unescaped):
var recent = mapped.slice(0, 12).map(function (x) {
  return {
    text: '<span style="font-weight: 500;">'
        + (x.email || x.name)   // <-- not escaped
        + '</span> signed up for Kesefle',
    time: x.signupRaw
  };
});
```

Then `activityRow(act)` (line 1195) does:

```js
<div class="text-sm" style="color: #1E293B;">${act.text}</div>
```

A user who signs up via OAuth with display-name
`</span><img src=x onerror=alert(document.cookie)>` will execute that
script in the admin's session every time the admin opens `/admin`. Because
the admin holds an `ADMIN_EMAILS` bearer token, this is account-takeover-
class.

**Fix:** Wrap both fields in `esc()` (already defined at line 1255) when
constructing the activity entry, and additionally escape inside
`activityRow` so future callers can't reintroduce the bug:

```js
text: '<span style="font-weight: 500;">' + esc(x.email || x.name || '')
    + '</span> signed up for Kesefle'
```

Or better, switch the template to take separate fields and template them
with escapes:

```js
return `<li ...>
  <div class="text-sm">${esc(act.who)} signed up for Kesefle</div>
  <div class="text-[11px]">${esc(act.time)}</div>
</li>`;
```

### F2 (MEDIUM) -- Unescaped server error detail in account provision flow

**File:** `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/account.html`
**Lines:** 1823, 1830, 1834, 1844, 1849
**Severity:** MEDIUM

The provisioning failure handler interpolates `j.detail` and `e.message`
into `status.innerHTML` without escaping. Source: `/api/sheet/provision`
response and JS `Error.message`. Today `j.detail` is constructed
server-side from Google Drive API errors (mostly safe), but Google error
strings have historically included user-supplied data (sheet titles, file
names), and any future code path that surfaces a user-typed value will
produce DOM-text-to-DOM-HTML conversion.

```js
// account.html:1823
why = detail ? 'פרטים טכניים: ' + detail.slice(0, 120) : '...';

// account.html:1830 (interpolated)
'<div class="text-xs mt-1 text-red-600">' + why + '</div>'

// account.html:1834
'<div class="mt-1">' + (detail ? detail.slice(0, 220) : '...') + '</div>'

// account.html:1849
'<details ...><div class="mt-1">' + (em ? em : '...') + '</div></details>'
```

**Fix:** Define an `escapeHtml` helper at the top of the IIFE (account.html
already uses similar patterns elsewhere -- e.g. welcome.html:698) and
wrap every `detail`/`em` interpolation:
`escapeHtml((detail || '').slice(0, 220))`.

### F3 (MEDIUM) -- Brittle escape in custom-categories list

**File:** `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/dashboard.html`
**Lines:** 3895-3900 (renderer), `escapeHtml` def at 3864
**Severity:** MEDIUM (latent -- mitigated server-side today)

```js
list.innerHTML = (data.items || []).map(function (item) {
  return '<li ...>' +
    '<span>' + escapeHtml(item.name) + '</span>' +
    '<button onclick="kflCatRemove(\'' +
      escapeHtml(item.name).replace(/'/g, '\\\'') + '\')" ...>×</button>' +
  '</li>';
})
```

`escapeHtml(item.name)` already converts `'` to `&#39;`. The browser
decodes `&#39;` back to `'` when parsing the `onclick` attribute, which
then breaks the JS string. The follow-up `.replace(/'/g, '\\\'')` matches
nothing (escapeHtml already stripped the literal `'`), so it's a no-op.

Currently NOT exploitable because the backend
(`/api/custom-categories` -> `sanitizeName`) strips the range `[ -]`
(U+0020 through U+002D, includes `'`, `"`, `&`, etc.) before storage.
But the client is one server-side validation change away from XSS.

**Fix:** Use a `data-name` attribute + an event delegator instead of an
inline `onclick`:

```js
'<button class="kfl-cat-rm" data-name="' + escapeHtml(item.name) + '" ...>'
// then once:
list.addEventListener('click', function (e) {
  var b = e.target.closest('.kfl-cat-rm');
  if (b) kflCatRemove(b.dataset.name);
});
```

### F4 (LOW) -- Partial escape in account.html link error

**File:** `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/account.html`
**Lines:** 599-606

`_kflShowLinkError(msg)` only escapes `<`:

```js
var safe = String(msg || 'שגיאה').replace(/</g,'&lt;');
el.innerHTML = '...<div class="font-bold">' + safe + '</div>...';
```

Today `msg` is a local validation string, but the function is general
purpose. **Fix:** swap for the standard 5-char escape (`& < > " '`).

### F5 (LOW) -- Weak `esc()` in index.html demo chat

**File:** `/Users/stevenrancohen/Documents/Claude/Projects/kesefle/index.html`
**Line:** 774

```js
function esc(t) { return String(t).replace(/[<>&]/g, function (c) { ... }); }
```

Only handles 3 characters; called with hardcoded demo-script strings so
not currently exploitable. Replace with the same 5-char escape used
elsewhere in the file (line 1187).

### F6 (LOW) -- `addBotBubble(html, ...)` accepts raw HTML

`demo.html:521-535` -- all current call sites pass hardcoded demo
strings. Add a `// trusted-HTML-only` comment to prevent future misuse.

### F7 (LOW) -- Missing SRI hashes on third-party scripts

Every page loads `cdn.tailwindcss.com` (a JIT compiler shipping with
`eval`-like behaviour for class strings), plus Google Sign-In, Apple ID,
and FB SDK from third-party origins, with no `integrity=` or
`crossorigin=` attributes. A CDN compromise would inject script with no
detection. Tailwind v3+ explicitly recommends compiling locally for
production -- `cdn.tailwindcss.com` is dev-only.

**Fix:** schedule a swap to a self-hosted compiled Tailwind CSS bundle
(matches existing `css/` directory). For Google/Apple/FB SDKs, accept
the risk (no SRI on a versioned moving-target URL) but document it.

### F8 (HYGIENE) -- No CSP / Referrer-Policy / X-Frame-Options on any page

No `<meta http-equiv="Content-Security-Policy">` or
`<meta name="referrer">` tags on any page. The repo relies on Vercel
response headers (not audited here). If `vercel.json` doesn't already
ship them, missing CSP means findings F1-F4 have no defense in depth.

**Fix:** verify `vercel.json` ships at minimum:
- `Content-Security-Policy: default-src 'self' https://cdn.tailwindcss.com
  https://accounts.google.com https://www.googleapis.com
  https://appleid.cdn-apple.com https://connect.facebook.net;
  img-src 'self' data: https:; style-src 'self' 'unsafe-inline';
  script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com
  https://accounts.google.com https://appleid.cdn-apple.com
  https://connect.facebook.net;`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: DENY` (or CSP `frame-ancestors 'none'`)
- `X-Content-Type-Options: nosniff`

## Recommendations (safe-to-ship PR list, in priority order)

1. **PR-1 (HIGH, ~5 LOC):** Fix F1 stored XSS -- escape `x.email || x.name`
   in admin.html:1660 with the existing `esc()` helper.
2. **PR-2 (MED, ~15 LOC):** Fix F2 -- add an `escapeHtml` helper at the
   top of the account.html provisioning IIFE and wrap every `detail` /
   `em` interpolation in `status.innerHTML`.
3. **PR-3 (MED, ~10 LOC):** Fix F3 -- replace inline `onclick` with a
   delegated handler reading `data-name` in dashboard.html custom-
   categories list.
4. **PR-4 (LOW, ~5 LOC):** Tighten the 2 weak escape helpers
   (account.html:599, index.html:774) to the 5-char standard.
5. **PR-5 (HYGIENE):** Verify `vercel.json` headers cover CSP /
   Referrer-Policy / X-Frame-Options / X-Content-Type-Options. If not,
   add them.
6. **PR-6 (PROJECT):** Move Tailwind off `cdn.tailwindcss.com` to a
   self-hosted compiled bundle in `css/` -- removes the runtime
   compiler and unblocks a strict CSP.

## What was clean

- Zero `eval`, `new Function`, or `document.write` anywhere in scope.
- No secrets in any in-scope HTML; only references to env-var names in
  `docs.html` and `admin/diagnostics.html`.
- No mixed-content (`http://`) links.
- Service-worker auto-update pattern from PR #13 is correctly pasted on
  all PWA-cached pages -- users won't get stuck on stale assets.
- All authenticated POST endpoints use `credentials: 'include'` and/or
  `Authorization: Bearer ${token}`. Unauthenticated POSTs (waitlist,
  funnel-log, NPS, user-report, push-subscribe, OAuth-token-in-body
  login) are intentional and rely on server-side rate-limit + content
  validation rather than CSRF tokens, which is acceptable for the
  threat model.
- `/api/config` exposes only public-safe values (bot number/name,
  GA4/Meta/TikTok pixel IDs which are public by design, VAPID public
  key). No secret leakage.
- Most user-data renderers in dashboard.html, statement.html,
  tax-report.html, welcome.html use `escapeHtml` correctly. admin.html
  user-list table (line 1130) was explicitly hardened in a prior pass
  ("Steven 2026-05-26 (QA HIGH #3)" comment at line 1127).
