"""
The gameplay cursor and its trail: cursor.png, cursormiddle.png and
cursortrail.png (all @2x).

The game sizes cursor sprites like lazer's legacy cursor (NonPlayfieldSprite):
an image displays at pixels × 0.5 (@2x) / 1.6 playfield units, and trail parts
the same way, spaced 1/2.5 of their width apart. The images here
are sized so that gives what the cursor looked like before skins existed:

- the ring's outer edge spans OsuCursor.SIZE (28 units); our art's ring is
  186px of its 250px canvas, so the whole image is 250 × 28 / 186 ≈ 37.6
  units → 120px at @2x;
- lazer's cursortrail.png (10px) drew at 2.5 units, one unit apart → 8px.

cursormiddle.png holds the centre dot (lazer's DefaultCursor keeps its centre
out of the expand on press) and, being present, makes the trail continuous
for any skin that takes its cursor from here.
"""
import numpy as np
from PIL import Image

STABLE_MAGIC_SCALE = 1.6
CURSOR_UNITS = 250 * 28 / 186
TRAIL_UNITS = 2.5
# The centre dot of art/sprites/cursor.png: white, radius ~8.5px of 250.
DOT_RADIUS = 8.6
# The pink disc around it.
INNER_RGBA = (255, 180, 194, 133)


def at2x(units: float) -> int:
    return round(units * STABLE_MAGIC_SCALE * 2)


def build(ctx) -> None:
    src = ctx.art_image('cursor.png')
    n = src.width
    c = (n - 1) / 2
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    d = np.hypot(x - c, y - c)

    # cursor: the art with the dot painted over in the surrounding pink.
    body = np.array(src).astype(np.float32)
    hole = d <= DOT_RADIUS + 1.5
    body[hole] = INNER_RGBA
    cursor = Image.fromarray(body.astype(np.uint8))

    # cursormiddle: just the dot, anti-aliased, on the same canvas (same centre).
    ss = 4
    m = n * ss
    yy, xx = np.mgrid[0:m, 0:m].astype(np.float32)
    dd = np.hypot(xx - (m - 1) / 2, yy - (m - 1) / 2) / ss
    alpha = np.clip(DOT_RADIUS - dd + 0.5, 0, 1) * 255
    dot = np.dstack([np.full_like(alpha, 255)] * 3 + [alpha]).astype(np.uint8)
    middle = Image.fromarray(dot).resize((n, n), Image.LANCZOS)

    size = at2x(CURSOR_UNITS)
    ctx.save(cursor.resize((size, size), Image.LANCZOS), 'cursor@2x.png')
    ctx.save(middle.resize((size, size), Image.LANCZOS), 'cursormiddle@2x.png')

    trail = Image.open(ctx.root / 'public' / 'assets' / 'skin' / 'cursor' / 'cursortrail.png').convert('RGBA')
    t = at2x(TRAIL_UNITS)
    ctx.save(trail.resize((t, t), Image.LANCZOS), 'cursortrail@2x.png')
