# PWA Icon Generation — Kesefle

The manifest references these icon files at the project root:

| File | Size | Purpose |
|------|------|---------|
| `icon-192.png` | 192×192 | Android home-screen, shortcuts |
| `icon-512.png` | 512×512 | Splash screen, app drawer |
| `icon-512-maskable.png` | 512×512 | Android adaptive (safe-zone padded) |

Until proper icons are generated, the existing `og-image.png` works as a fallback for `any` purpose (browser will letterbox it). For a real install experience, generate proper square icons.

## Option A — realfavicongenerator.net (recommended, no install)
1. Upload a square 1024×1024 source (the ₪ logo on the brand-emerald gradient).
2. In the "Web App Manifest" section, set background `#0f1422` and theme `#22c55e`.
3. Download the package, copy `android-chrome-192x192.png` → `icon-192.png` and `android-chrome-512x512.png` → `icon-512.png`.
4. For the maskable, regenerate with the "Web App Manifest" → "Maskable icon" toggle, save as `icon-512-maskable.png`.

## Option B — ImageMagick (local, fastest)
Already have a square source as `source-icon.png`:
```sh
cd /Users/stevenrancohen/Documents/Claude/Projects/kesefle
magick source-icon.png -resize 192x192 icon-192.png
magick source-icon.png -resize 512x512 icon-512.png
# maskable: add ~20% safe-zone padding on each side
magick source-icon.png -resize 358x358 \
  -background "#0f1422" -gravity center -extent 512x512 \
  icon-512-maskable.png
```

Quick repurpose of the existing og-image (16:9, not square — will be cropped):
```sh
magick og-image.png -gravity center -crop 630x630+0+0 +repage -resize 192x192 icon-192.png
magick og-image.png -gravity center -crop 630x630+0+0 +repage -resize 512x512 icon-512.png
magick og-image.png -gravity center -crop 630x630+0+0 +repage -resize 358x358 \
  -background "#0f1422" -gravity center -extent 512x512 icon-512-maskable.png
```

## Option C — pwa-asset-generator (blocked by npm policy)
Normally:
```sh
npx pwa-asset-generator source-icon.png . \
  --background "#0f1422" --opaque true --padding "10%" \
  --icon-only --type png --favicon
```
Skip unless npm is permitted in this environment.

## Verification
After dropping the files in:
```sh
ls -la icon-192.png icon-512.png icon-512-maskable.png
```
Then open Chrome DevTools → Application → Manifest. The "Installability" panel should show no warnings, and "Maskable" should preview correctly inside the safe-zone circle.
