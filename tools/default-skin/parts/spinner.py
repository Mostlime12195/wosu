"""
Spinner elements for wosu!'s default skin, in osu!'s new-style (Version 2+)
layout, keeping wosu!'s own spinner look.

lazer's LegacyNewStyleSpinner draws every disc layer at SPRITE_SCALE
(0.625) inside a container scaled 0.8 → 1.0 with progress, so an @2x
image spans px × 0.5 × 0.625 osu! px at full progress. Our spinner disc is
380 osu! px across (it fills the playfield height):

  spinner-bottom   the dark base disc (turns at a third of the top's speed)
  spinner-glow     the progress fill, as a white disc lazer tints blue
                   (3, 151, 255), draws additively and fades in with progress
  spinner-top      the hub (0.3 of the disc), which turns with the cursor:
                   there's deliberately no spinner-middle2, so lazer turns
                   the top at full speed (turn ratio 1) like our old hub
  spinner-approachcircle  our approach ring; lazer starts it at 1.86 ×
                   SPRITE_SCALE, so it begins at the full disc size
  spinner-spin / spinner-clear  Venera "spin!" / "clear!" at our old
                   34 osu! px size
  spinner-rpm      the box behind the RPM counter (label on the left;
                   the number is right-aligned at its right end)

No spinner-middle: our look has no fixed centre piece (lazer fades that
one from white to red over the spinner's length).
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build import bitmap_text  # noqa: E402

SPRITE_SCALE = 0.625
# osu! px per @2x image pixel for disc layers at full progress.
PX = 0.5 * SPRITE_SCALE
DISC = 380  # osu! px


def _size(osu_px: float) -> int:
    return round(osu_px / PX)


def _resize_to(img: Image.Image, w: int) -> Image.Image:
    h = round(img.height * w / img.width)
    return img.resize((w, h), Image.LANCZOS)


def _white(img: Image.Image) -> Image.Image:
    """Same alpha, white colour (for elements the game tints)."""
    a = np.array(img)
    a[..., :3] = 255
    return Image.fromarray(a)


def _with_alpha(img: Image.Image, k: float) -> Image.Image:
    a = np.array(img).astype(np.float32)
    a[..., 3] *= k
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def _rpm_box(ctx) -> Image.Image:
    # osu!'s spinner-rpm is 560×112 @2x: the counter's right edge sits 8 osu! px
    # (25.6 image px) inside the box's right end.
    w, h, ss = 560, 112, 4
    big = Image.new('RGBA', (w * ss, h * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.rounded_rectangle((2 * ss, 2 * ss, (w - 2) * ss, (h - 2) * ss), radius=22 * ss,
                        fill=(8, 22, 32, 190), outline=(102, 204, 255, 90), width=3 * ss)
    box = big.resize((w, h), Image.LANCZOS)
    label = bitmap_text('RPM', 44, (160, 214, 240))
    box.alpha_composite(label, (32, (h - label.height) // 2))
    return box


def build(ctx) -> None:
    disc = _size(DISC)  # 1216
    ctx.save(_resize_to(ctx.art_image('spinnerbase.png'), disc), 'spinner-bottom@2x.png')
    ctx.save(_white(_resize_to(ctx.art_image('spinnerprogress.png'), disc)), 'spinner-glow@2x.png')
    ctx.save(_resize_to(ctx.art_image('spinnertop.png'), _size(DISC * 0.3)), 'spinner-top@2x.png')

    # Approach ring: our art (252 px) spanned the whole disc at 75% opacity.
    ring = _resize_to(ctx.art_image('approachcircle.png'), round(DISC / (1.86 * PX)))
    ctx.save(_with_alpha(ring, 0.75), 'spinner-approachcircle@2x.png')

    # Text: our old prompts were Venera at 34 osu! px; lazer draws these at SPRITE_SCALE.
    text_px = 34 / PX
    ctx.save(bitmap_text('spin!', text_px, (255, 255, 255)), 'spinner-spin@2x.png')
    ctx.save(bitmap_text('clear!', text_px, (255, 255, 255)), 'spinner-clear@2x.png')
    ctx.save(_rpm_box(ctx), 'spinner-rpm@2x.png')
