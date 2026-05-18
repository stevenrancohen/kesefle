#!/usr/bin/env python3
"""Generate a 1024x1024 app icon for Meta Developer Console.

Design: rounded-square dark gradient background with a centered white shekel
sign on a green circle. Matches the OG image's visual language.
"""

from PIL import Image, ImageDraw, ImageFont, ImageFilter

S = 1024
OUT = "/Users/stevenrancohen/Documents/Claude/Projects/kesefle/icon-1024.png"
HEBREW_FONT = "/tmp/fonts/NotoSansHebrew-Bold.ttf"

# --- Full-square gradient background ----------------------------------------
# Meta and OS launchers apply their own rounding, so we render to the edges.
bg = Image.new("RGBA", (S, S), (14, 16, 24, 255))
draw = ImageDraw.Draw(bg)
top    = (12, 60, 30)
bottom = (14, 16, 24)
for y in range(S):
    r = int(top[0] + (bottom[0]-top[0]) * y / S)
    g = int(top[1] + (bottom[1]-top[1]) * y / S)
    b = int(top[2] + (bottom[2]-top[2]) * y / S)
    draw.line([(0, y), (S, y)], fill=(r, g, b, 255))

# --- Soft accent circles to match the OG ------------------------------------
accent = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ad = ImageDraw.Draw(accent)
ad.ellipse((S-340, -120, S+220, 440), fill=(60, 196, 116, 90))
accent = accent.filter(ImageFilter.GaussianBlur(8))
bg.alpha_composite(accent)

accent2 = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ad2 = ImageDraw.Draw(accent2)
ad2.ellipse((-180, S-280, 280, S+200), fill=(56, 50, 110, 150))
accent2 = accent2.filter(ImageFilter.GaussianBlur(8))
bg.alpha_composite(accent2)

# --- Centered green disc with a white shekel sign ---------------------------
draw = ImageDraw.Draw(bg)
cx, cy, r = S//2, S//2, 290
draw.ellipse((cx-r, cy-r, cx+r, cy+r), fill="#2ecc71")

# White ₪ glyph using Noto Sans Hebrew (supports U+20AA).
shek_font = ImageFont.truetype(HEBREW_FONT, 380)
try:
    shek_font.set_variation_by_axes([800, 100])  # ExtraBold
except Exception:
    pass
bbox = draw.textbbox((0, 0), "₪", font=shek_font)
gw, gh = bbox[2]-bbox[0], bbox[3]-bbox[1]
draw.text((cx - gw/2 - bbox[0], cy - gh/2 - bbox[1] - 14), "₪", fill="white", font=shek_font)

bg.convert("RGB").save(OUT, "PNG", optimize=True)
print(f"Wrote {OUT}")
