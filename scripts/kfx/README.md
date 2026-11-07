# kfx · cinematic motion layer (2026-11-08)

Cinematic scroll motion for every public page of kesefle.com, in the site's own white + blue.
Self-hosted, no build step for the site itself.

| Piece | File |
|---|---|
| Engine: Lenis smooth scroll synced to GSAP ScrollTrigger, split-text headings, staggered reveals, clip-path image reveals, parallax, counters and text scramble, magnetic buttons, custom cursor, hover reveal, homepage preloader lift | `js/kfx-motion.js` |
| Homepage: pinned scroll-scrubbed story (a WhatsApp message becomes a sheet row and the balance updates), before/after wipe, Three.js phone | `js/kfx-home.js`, sections `#kfx-story`, `#kfx-compare`, `#kfx-3d` in `index.html` |
| 3D phone (lazy, only near the section) | `js/kfx-phone3d.mjs`, source `scripts/kfx/phone3d.src.mjs`, rebuild `scripts/kfx/build-phone3d.sh` |
| Tokens, preloader, cursor, sections (white + blue), dark safety net for visitors who pick dark | `css/kfx-motion.css` |
| Libraries (GSAP 3.15.1 with ScrollTrigger + SplitText, Lenis 1.3.27) | `js/vendor/`, licenses in `js/vendor/LICENSES.md` |
| Head block on every public page + legacy motion guards | `scripts/kfx/rollout.js` |
| Guard test (runs in the gauntlet) | `tests/test_kfx_motion.js` |

## Everyday use
- New public page: `node scripts/kfx/rollout.js` (idempotent). `--check` fails if a page is missing or stale.
- Private pages (app, account, dashboard, admin...) are listed in `EXCLUDE` inside `rollout.js`.
- Changed `css/kfx-motion.css` or any `js/kfx-*` file: bump `V` in `rollout.js` (`kfx1` → `kfx2`) and rerun it, the service worker caches js/css by URL.
- Compare with the old site: add `?kfx=off` to any URL.

## Safety
- `prefers-reduced-motion`: no smooth scroll, no pin, no motion; every section shows its final state.
- No JS, a blocked library or any init error: everything is shown; the head snippet adds `.kfx-fail` after 3.5 s if the engine never started.
- Touch devices never get the cursor or hover-only effects; the before/after only takes sideways drags, vertical swipes keep scrolling.
- The layer never changes the theme: white + blue as before; a page's own theme toggle still works, and dark gets the safety net.
- Rollback: `git revert` the kfx commit (one commit), nothing else depends on it.

## Shipping without a terminal (Claude inbox)
`.github/workflows/claude-inbox.yml` (added on GitHub, workflow files stay manual) ships a change to main:
1. Build the change on a branch on top of the current `origin/main`, run the gauntlet, then `bash scripts/kfx/make-inbox-bundle.sh out.bundle`.
2. On github.com: Add file > Upload files (on main), drop the bundle, choose "Create a new branch for this commit", name it `claude-inbox/<name>`, Propose changes. Do not open a pull request.
3. The workflow accepts the bundle only as a fast forward of main that does not touch `.github/`, runs `npm run gauntlet`, then fast forwards main (Vercel deploys) and deletes the inbox branch. Any failure leaves main and the live site untouched; the run is visible under Actions.
