"""
A blank sliderendcircle.png.

With osu!-format skins, lazer (like osu!stable) draws a circle at every
slider repeat and at the slider's tail: sliderendcircle(+overlay), or the
skin's hitcircle(+overlay) when the skin that provides hitcircle has no
sliderendcircle (LegacyMainCirclePiece). wosu!'s default never had end
circles, so, like many stable skins, it ships a transparent
sliderendcircle to hide them. The game skips drawing such a placeholder.

A user skin with its own hitcircle still gets end circles from its own
art: the lookup only uses sliderendcircle from the skin providing
hitcircle.
"""
from PIL import Image


def build(ctx) -> None:
    ctx.save(Image.new('RGBA', (2, 2), (0, 0, 0, 0)), 'sliderendcircle@2x.png')
