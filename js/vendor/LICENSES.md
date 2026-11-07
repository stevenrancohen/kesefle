# Vendored libraries (self-hosted, no CDN)

| File | Library | Version | License |
|---|---|---|---|
| `gsap.min.js`, `ScrollTrigger.min.js`, `SplitText.min.js` | GSAP by GreenSock (Webflow) | 3.15.1 | GSAP Standard "no charge" license, https://gsap.com/standard-license (free for commercial sites) |
| `lenis.min.js` + `/css/lenis.css` | Lenis by darkroom.engineering | 1.3.27 | MIT |
| `/js/kfx-phone3d.mjs` (bundled) | three.js | 0.187.0 | MIT, Copyright © 2010-2026 three.js authors |

Copied unmodified from the npm packages (`gsap/dist`, `lenis/dist`); only a
license banner was added on top of `lenis.min.js`. Rebuild the 3D bundle with
`scripts/kfx/build-phone3d.sh`.
