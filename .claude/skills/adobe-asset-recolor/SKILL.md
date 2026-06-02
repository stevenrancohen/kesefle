# adobe-asset-recolor

Use the Adobe MCP connector to **recolor an existing brand asset** (logo, social-share image, marketing graphic) to match Steven's current palette. This is the only Adobe creative path available in the current environment.

## Hard limit (be honest with Steven)

**Generative text-to-image is NOT available in this Adobe environment.** I cannot generate a new logo from a text prompt. I CAN:
- Recolor existing pixels (`image_adjust_hsl`, `image_apply_color_overlay`, `image_apply_monochromatic_tint`)
- Vectorize a raster logo to SVG (`image_vectorize`)
- Crop/resize/extend canvas (`image_crop_*`, `image_generative_expand`)
- Apply effects (blur, glitch, halftone, etc.)
- Search Adobe Stock for licensed templates

I CANNOT:
- Generate a logo from "a sleek minimal wordmark" prompt
- Change the typeface of an existing logo (need source font file)
- Generative-fill replace whole regions

## When to use

Steven says "regenerate the logo with the new gradient" or "make a new social share image". Tell him upfront what's possible and ask him to upload the source.

## Steps

1. **Initialize Adobe.** Call `mcp__c039cc3a-6eae-4a01-804f-24e966658680__adobe_mandatory_init` with the skill name.

2. **Get the source asset.** Two paths:
   - **Steven uploads:** call `asset_add_file()` — opens picker. Wait for him to select.
   - **Existing in Adobe cloud:** `asset_search({query: 'kesefle logo', entityScope: 'CCAsset'})`.

3. **Preview to verify it's the right image:** `asset_inline_preview({presignedAssetUrl: <url>})`.

4. **Recolor.** Pick the right tool for the job:
   - **Single-color logo → gradient:** `image_apply_color_overlay` won't do gradient. Instead: `image_vectorize` first → manual SVG edit with the brand gradient → re-upload.
   - **Multi-color logo, hue shift:** `image_adjust_hsl({hue: <degrees>})`
   - **Tint a black/white logo:** `image_apply_monochromatic_tint`

5. **Export each required size.** The favicon needs:
   - `icon-192.png` (192×192) — `image_crop_and_resize`
   - `icon-512.png` (512×512)
   - `favicon.ico` — NOT directly supported. Recommend Steven runs an offline `convert` after.
   - `og-image.png` (1200×630) — `image_crop_and_resize` with aspect ratio `"1200:630"`

6. **Show the result** with `asset_preview_file({assets: [{presignedAssetUrl: out_url}]})` so Steven can approve before commit.

7. **Download to repo** (egress enabled):
   ```bash
   OUTPUT_DIR="/Users/stevenrancohen/Documents/Claude/Projects/kesefle"
   curl -L -o "$OUTPUT_DIR/icon-192.png" "<output_url>"
   ```

8. **Verify** the PNG is non-corrupt: `file icon-192.png` should report `PNG image data, 192 x 192`.

9. **Ship as its own PR** via `ship-small-pr` skill. Title: `feat(brand): regenerate logo.png + icon-192.png with new gradient`.

## Critical rules

- **Always preview before saving** — `asset_inline_preview` to confirm.
- **Always verify pixel dimensions after crop** — the Adobe docs warn that `image_crop_and_resize` can stretch if you pass pixel dimensions instead of aspect strings.
- **Don't auto-replace `/logo.png`** without showing Steven the result first.
- **Don't claim "regenerated logo" if you only recolored** — say "recolored existing logo to new gradient".

## Anti-patterns

- Don't promise "Adobe-generated original logo from prompt". Not possible in this env.
- Don't sweep all brand assets in one PR. One asset = one PR.
- Don't skip the `asset_preview_file` step — Steven needs to see it.

## When to ask for Figma/Canva instead

If Steven asks for:
- "Animated logo" — not in Adobe env, recommend Figma's prototype mode or Canva animations
- "Brand identity kit" — Figma is the right tool, mention it's not connected
- "Mockup screens" — Figma. Tell Steven to install the Figma connector.

In those cases, surface the connector gap instead of half-doing it in Adobe.
