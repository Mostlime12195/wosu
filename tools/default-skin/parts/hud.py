"""
Health bar for wosu!'s default skin, as osu! new-style (skin.ini Version
2.0+) scorebar images built from our health bar art (art/sprites):

  hpbarright.png  black 12px core     → scorebar-bg     (the track, 45% black)
  hpbarleft.png   white-cyan core     → scorebar-colour (the fill, with its glow)
                  and cyan glow
  hpbarmid.png    the glowing end cap → scorebar-marker (mirrored into a full glow)

plus old-style scorebar-ki / kidanger / kidanger2 so a Version 1 skin that
only ships scorebar-bg still gets a marker.

Geometry (all @2x, so 2px per HUD unit): osu! draws the new-style fill
at (7.5, 7.8) × 1.6 = (12, 12.48) units from the bar's top-left and
reveals it left to right by health; the marker is centred on the fill's
end. The fill here is a 20px (10 unit) rounded bar with 10px of glow
around it, and scorebar-bg is a matching track under it: together the
same 560 × 10 unit bar with round ends the HUD drew before skinning.
"""
import numpy as np
from PIL import Image

CORE_W = 1120      # bar length at full health (560 units)
CORE_H = 20        # bar thickness (10 units)
GLOW = 10          # glow around the fill's core
FILL_X, FILL_Y = 24, 24.96  # osu!'s new-style fill offset, (7.5, 7.8) × 1.6 units, in @2x px
BG_ALPHA = 0.45    # the old HUD's track opacity
SS = 4             # supersampling for the shapes


def _capsule_distance(w, h, x0, x1, cy, r, ss=SS):
    """Signed distance (output px) to a horizontal capsule, on an ss× grid of a w×h image."""
    y, x = np.mgrid[0:h * ss, 0:w * ss].astype(np.float32)
    x = (x + 0.5) / ss
    y = (y + 0.5) / ss
    cx = np.clip(x, x0 + r, x1 - r)
    return np.hypot(x - cx, y - cy) - r


def _down(arr, w, h, ss=SS):
    """Average an ss× RGBA float array down to w×h (premultiplied, so edges stay clean)."""
    a = arr[..., 3:4] / 255
    pre = np.concatenate([arr[..., :3] * a, a * 255], axis=-1)
    pre = pre.reshape(h, ss, w, ss, 4).mean(axis=(1, 3))
    alpha = pre[..., 3:4] / 255
    rgb = np.where(alpha > 1e-4, pre[..., :3] / np.maximum(alpha, 1e-4), 0)
    out = np.concatenate([rgb, pre[..., 3:4]], axis=-1)
    return Image.fromarray(np.clip(np.round(out), 0, 255).astype(np.uint8))


def _art_profile(ctx):
    """Core colour, glow colour and the glow's alpha falloff (per px outside the core) from hpbarleft.png."""
    a = np.array(ctx.art_image('hpbarleft.png')).astype(np.float32)
    col = a[:, a.shape[1] // 2]
    core_rows = np.where(col[:, 3] >= 250)[0]
    core = col[core_rows].mean(axis=0)[:3]
    top = col[:core_rows[0]][::-1]  # nearest the core first
    glow_rgb = top[:, :3].mean(axis=0)
    falloff = top[:, 3] / 255  # alpha at 1, 2, 3… px from the core (art scale)
    return core, glow_rgb, falloff


def fill(ctx, core, glow_rgb, falloff):
    w, h = CORE_W + GLOW, CORE_H + 2 * GLOW
    r = CORE_H / 2
    # The core runs past the right edge: osu! cuts the fill off there by health.
    d = _capsule_distance(w, h, GLOW, w + 4 * r, h / 2, r)
    # Glow: the art's falloff, stretched so its 14 art px span our GLOW px.
    t = np.clip(d, 0, None) * (len(falloff) / GLOW)
    glow_a = np.interp(t, np.arange(len(falloff)) + 0.5, falloff, right=0)
    inside = (d <= 0).astype(np.float32)  # anti-aliased by the supersampling
    rgba = np.zeros(d.shape + (4,), np.float32)
    for i in range(3):
        rgba[..., i] = np.where(inside > 0, core[i], glow_rgb[i])
    rgba[..., 3] = np.where(inside > 0, 255, glow_a * 255)
    ctx.save(_down(rgba, w, h), 'scorebar-colour@2x.png')


def background(ctx):
    x0 = FILL_X + GLOW
    y0 = FILL_Y + GLOW
    w, h = round(x0 + CORE_W + FILL_X), round(y0 + CORE_H + FILL_Y)
    d = _capsule_distance(w, h, x0, x0 + CORE_W, y0 + CORE_H / 2, CORE_H / 2)
    track = np.array(ctx.art_image('hpbarright.png')).astype(np.float32)
    colour = track[track.shape[0] // 2, track.shape[1] // 2, :3]
    rgba = np.zeros(d.shape + (4,), np.float32)
    rgba[..., :3] = colour
    rgba[..., 3] = (d <= 0) * 255 * BG_ALPHA
    ctx.save(_down(rgba, w, h), 'scorebar-bg@2x.png')


def marker(ctx):
    cap = np.array(ctx.art_image('hpbarmid.png')).astype(np.float32)  # glow fading rightwards from x=0
    full = np.concatenate([cap[:, ::-1], cap], axis=1)
    img = Image.fromarray(np.clip(full, 0, 255).astype(np.uint8))
    img = ctx.scaled(img, 1.5)
    a = np.array(img).astype(np.float32)
    a[..., 3] = np.clip(a[..., 3] * 2.2, 0, 255)  # the cap is faint on its own; it marks the bar's end
    ctx.save(Image.fromarray(a.astype(np.uint8)), 'scorebar-marker@2x.png')


def ki(ctx, glow_rgb):
    size = 64

    def blob(colour):
        def draw(dist, _x, _y):
            t = dist / (size / 2)
            a = np.interp(t, [0, 0.25, 0.4, 1], [1, 1, 0.55, 0])
            core = np.clip((0.3 - t) / 0.08, 0, 1)
            rgba = np.zeros(dist.shape + (4,), np.float32)
            for i in range(3):
                rgba[..., i] = core * 255 + (1 - core) * colour[i]
            rgba[..., 3] = np.where(t >= 1, 0, a * 255)
            return rgba
        return ctx.circle(size, draw)

    ctx.save(blob(glow_rgb), 'scorebar-ki@2x.png')
    ctx.save(blob((255, 160, 40)), 'scorebar-kidanger@2x.png')
    ctx.save(blob((255, 40, 40)), 'scorebar-kidanger2@2x.png')


def score_font_spacing(ctx):
    """
    Our score glyphs are drawn edge to edge. osu! puts the score at the very
    top of the screen and spaces glyphs by their width minus ScoreOverlap
    (6 units here), so pad them the way osu! skins do: 8 units above every
    glyph (the old HUD's top margin) and 5px either side of the dot, which
    the overlap would otherwise swallow (the old HUD barely overlapped it).
    """
    for name in [f'score-{i}' for i in range(10)] + ['score-dot', 'score-percent', 'score-x']:
        path = ctx.out / f'{name}@2x.png'
        if not path.exists():
            continue
        img = Image.open(path).convert('RGBA')
        side = 5 if name == 'score-dot' else 0
        out = Image.new('RGBA', (img.width + 2 * side, img.height + 16), (0, 0, 0, 0))
        out.paste(img, (side, 16))
        ctx.save(out, path.name)


def build(ctx):
    score_font_spacing(ctx)
    core, glow_rgb, falloff = _art_profile(ctx)
    fill(ctx, core, glow_rgb, falloff)
    background(ctx)
    marker(ctx)
    ki(ctx, glow_rgb)
