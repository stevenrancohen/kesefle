#!/usr/bin/env python3
"""Regenerate kesefle.com og-image.png with proper Hebrew rendering."""

from PIL import Image, ImageDraw, ImageFont, ImageFilter
from bidi.algorithm import get_display

W, H = 1200, 630
OUT = "/Users/stevenrancohen/Documents/Claude/Projects/kesefle/og-image.png"

# Noto Sans Hebrew — full Unicode coverage incl. geresh/apostrophe, comma,
# and ₪ glyph. Glyphs are rasterised into the PNG so the recipient device
# does not need any Hebrew font support.
HEBREW_FONT      = "/tmp/fonts/NotoSansHebrew-Bold.ttf"
HEBREW_FONT_REG  = "/tmp/fonts/NotoSansHebrew-Regular.ttf"
LATIN_FONT       = "/System/Library/Fonts/SFNS.ttf"

def heb(text):
    """Convert logical-order Hebrew (Python string) to visual-order for PIL."""
    return get_display(text)

# --- Build the background ----------------------------------------------------
# Vertical gradient from #0c2716 (top, deep green) -> #0e1018 (bottom, near-black)
img = Image.new("RGB", (W, H), "#0e1018")
draw = ImageDraw.Draw(img)
top    = (12, 39, 22)
bottom = (14, 16, 24)
for y in range(H):
    r = int(top[0] + (bottom[0]-top[0]) * y / H)
    g = int(top[1] + (bottom[1]-top[1]) * y / H)
    b = int(top[2] + (bottom[2]-top[2]) * y / H)
    draw.line([(0, y), (W, y)], fill=(r, g, b))

# Top-right semi-transparent green circle (radial accent)
accent = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ad = ImageDraw.Draw(accent)
ad.ellipse((W-360, -180, W+180, 360), fill=(60, 196, 116, 110))
accent = accent.filter(ImageFilter.GaussianBlur(4))
img.paste(accent, (0, 0), accent)

# Bottom-left muted purple circle (matches existing aesthetic)
accent2 = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ad2 = ImageDraw.Draw(accent2)
ad2.ellipse((-180, H-260, 200, H+140), fill=(56, 50, 110, 180))
accent2 = accent2.filter(ImageFilter.GaussianBlur(4))
img.paste(accent2, (0, 0), accent2)

# --- Center logo circle ------------------------------------------------------
cx, cy, r = W//2, 200, 70
draw.ellipse((cx-r, cy-r, cx+r, cy+r), fill="#2ecc71")
# White shekel sign inside the circle. Noto Sans Hebrew covers U+20AA (₪).
shek_font = ImageFont.truetype(HEBREW_FONT, 78)
try:
    shek_font.set_variation_by_axes([800, 100])  # ExtraBold to match brand mark
except Exception:
    pass
sb = draw.textbbox((0, 0), "₪", font=shek_font)
sw, sh = sb[2]-sb[0], sb[3]-sb[1]
draw.text((cx - sw/2 - sb[0], cy - sh/2 - sb[1] - 4), "₪", fill="white", font=shek_font)

# --- Hebrew brand name -------------------------------------------------------
brand_font = ImageFont.truetype(HEBREW_FONT, 120)
try:
    brand_font.set_variation_by_axes([800, 100])  # weight=ExtraBold, width=100%
except Exception:
    pass
brand_text = heb("כסף'לה")
bb = draw.textbbox((0, 0), brand_text, font=brand_font)
bw, bh = bb[2]-bb[0], bb[3]-bb[1]
brand_y = 320
draw.text((W/2 - bw/2 - bb[0], brand_y - bb[1]), brand_text, fill="white", font=brand_font)

# --- Tagline -----------------------------------------------------------------
tag_font = ImageFont.truetype(HEBREW_FONT_REG, 44)
try:
    tag_font.set_variation_by_axes([500, 100])  # weight=Medium
except Exception:
    pass
tag_text = heb("הכסף שלך, על אוטומט")
tb = draw.textbbox((0, 0), tag_text, font=tag_font)
tw, th = tb[2]-tb[0], tb[3]-tb[1]
tag_y = brand_y + bh + 28
draw.text((W/2 - tw/2 - tb[0], tag_y - tb[1]), tag_text, fill="#cfd8dc", font=tag_font)

# --- URL footer --------------------------------------------------------------
url_font = ImageFont.truetype(LATIN_FONT, 34)
url_text = "kesefle.com"
ub = draw.textbbox((0, 0), url_text, font=url_font)
uw, uh = ub[2]-ub[0], ub[3]-ub[1]
draw.text((W/2 - uw/2 - ub[0], H - 70 - ub[1]), url_text, fill="#2ecc71", font=url_font)

img.save(OUT, "PNG", optimize=True)
print(f"Wrote {OUT}")
