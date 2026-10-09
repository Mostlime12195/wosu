#!/usr/bin/env python3
"""
Builds wosu!'s default skin (public/assets/skins/default/) as a normal
osu!-format skin: @2x images at osu!'s standard sizes, hitsounds, a
skin.ini and a manifest.json listing every file (the game loads the
default through the same code as imported .osk skins).

Sources are the hand-made sprites in art/sprites (and the Venera font for
judgement text). Requires Pillow and numpy:

    python3 -m pip install pillow numpy
    python3 tools/default-skin/build.py

Element sizes follow osu!: at @2x a 256px hitcircle spans one circle
diameter. Our art was drawn for a 240px diameter (radius/120 per pixel),
so most sprites scale by 256/240. Extra parts (spinner, health bar, …)
live in parts/*.py: each defines build(ctx) and writes into ctx.out.
"""
import importlib.util
import json
import math
import shutil
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'art' / 'sprites'
OUT = ROOT / 'public' / 'assets' / 'skins' / 'default'
HITSOUNDS = ROOT / 'art' / 'hitsounds'
FONT = ROOT / 'public' / 'assets' / 'fonts'
HERE = Path(__file__).resolve().parent

# Our art: radius/120 per pixel. osu! @2x: radius/128 per pixel.
K = 128 / 120


def art(name: str) -> Image.Image:
    return Image.open(ART / name).convert('RGBA')


def scaled(img: Image.Image, k: float) -> Image.Image:
    w, h = max(1, round(img.width * k)), max(1, round(img.height * k))
    return img.resize((w, h), Image.LANCZOS)


def save(img: Image.Image, name: str) -> None:
    img.save(OUT / name, optimize=True)


def supersampled_circle(size: int, draw, ss: int = 4) -> Image.Image:
    """Draw with numpy on an ss× grid and downsample, for clean anti-aliased shapes."""
    n = size * ss
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    c = (n - 1) / 2
    d = np.hypot(x - c, y - c) / ss  # distance in output pixels
    rgba = draw(d, x / ss, y / ss)
    img = Image.fromarray(np.clip(rgba, 0, 255).astype(np.uint8))
    return img.resize((size, size), Image.LANCZOS)


# ---------------------------------------------------------------------------
# Hit circles
# ---------------------------------------------------------------------------

def hit_circles() -> None:
    save(scaled(art('disc.png'), K), 'hitcircle@2x.png')
    save(scaled(art('hitcircleoverlay.png'), K), 'hitcircleoverlay@2x.png')
    save(scaled(art('approachcircle.png'), K), 'approachcircle@2x.png')
    # Combo numbers: our score digits, drawn at 0.8 of circle scale (osu!'s number scale).
    # Ours were radius/150 per pixel; osu!'s are 0.8 × radius/128 = radius/160.
    for i in range(10):
        save(scaled(art(f'score-{i}.png'), 160 / 150), f'default-{i}@2x.png')


# ---------------------------------------------------------------------------
# Sliders
# ---------------------------------------------------------------------------

def slider_ball() -> None:
    """The shaded ball (ported from src/skin/ballData.ts), at osu! scale."""
    S = 256
    C = (S - 1) / 2
    y, x = np.mgrid[0:S, 0:S].astype(np.float64)
    d = np.hypot(x - C, y - C)
    u = d / 96
    dirn = ((C - y) / 96) * (1 - u * u) * 20
    hd = np.hypot(x - (C - 30), y - (C - 38)) / 55
    sheen = np.where(hd >= 1, 0, 8 * (1 - hd * hd) ** 2)
    core = np.clip(np.round(255 - 18 * u * u + dirn + sheen), 0, 255)
    rim = np.round(237 - 97 * ((d - 96) / 12))
    rgb = np.where(d <= 96, core, np.where(d <= 108, rim, 140))
    alpha = np.where(d <= 108, 255, np.where(d < 126, np.round(255 * (1 - (d - 108) / 18)), 0))
    img = np.dstack([rgb, rgb, rgb, alpha]).astype(np.uint8)
    ball = Image.fromarray(img)
    # Ours: 0.98 × radius/120 per pixel.
    save(scaled(ball, 0.98 * K), 'sliderb@2x.png')


def slider_parts() -> None:
    # Follow circle: ours ends at 2.4 circle diameters; osu!'s texture is drawn
    # as-is at circle scale, so bake that size in (redrawn crisply, not upscaled).
    target = round(2.4 * 256)
    src = art('sliderfollowcircle.png')
    ring = np.array(src)[src.height // 2, :, :]  # sample the colours along a row
    rim_rgb = tuple(int(v) for v in ring[6][:3])
    fill = np.array(src)[src.height // 2, src.width // 2]
    fill_rgb, fill_a = tuple(int(v) for v in fill[:3]), int(fill[3])
    border = target * (8 / 259)  # our ring is ~8px of 259

    def draw(d, _x, _y):
        r = target / 2
        a_rim = np.clip(r - d, 0, 1) * np.clip(d - (r - border) + 1, 0, 1)
        a_in = np.clip((r - border) - d, 0, 1)
        rgba = np.zeros(d.shape + (4,), np.float32)
        for i in range(3):
            rgba[..., i] = np.where(a_rim > 0, rim_rgb[i], fill_rgb[i])
        rgba[..., 3] = np.maximum(a_rim * 255, a_in * fill_a)
        return rgba

    save(supersampled_circle(target, draw), 'sliderfollowcircle@2x.png')
    save(scaled(art('sliderscorepoint.png'), K), 'sliderscorepoint@2x.png')
    # Reverse arrows were drawn at 0.75 of circle scale.
    save(scaled(art('reversearrow.png'), 0.75 * K), 'reversearrow@2x.png')
    # Follow points were drawn at 0.9 of circle scale.
    save(scaled(art('followpoint.png'), 0.9 * K), 'followpoint@2x.png')


# ---------------------------------------------------------------------------
# Judgements and hit lighting
# ---------------------------------------------------------------------------

def bitmap_text(text: str, px: float, colour) -> Image.Image:
    """Render text with the Venera bitmap font (BMFont XML), tinted, at `px` size."""
    root = ET.parse(FONT / 'venera.fnt').getroot()
    size = int(root.find('info').get('size'))
    common = root.find('common')
    line_h, base = int(common.get('lineHeight')), int(common.get('base'))
    page = Image.open(FONT / root.find('pages/page').get('file')).convert('RGBA')
    chars = {int(c.get('id')): {k: int(v) for k, v in c.attrib.items() if k != 'id'} for c in root.find('chars')}
    kerns = {}
    k = root.find('kernings')
    if k is not None:
        for e in k:
            kerns[(int(e.get('first')), int(e.get('second')))] = int(e.get('amount'))
    width = 0
    prev = None
    for ch in text:
        c = chars[ord(ch)]
        width += c['xadvance'] + (kerns.get((prev, ord(ch)), 0) if prev else 0)
        prev = ord(ch)
    pad = 8
    canvas = Image.new('RGBA', (width + pad * 2, line_h + pad * 2), (0, 0, 0, 0))
    x = pad
    prev = None
    for ch in text:
        c = chars[ord(ch)]
        if prev:
            x += kerns.get((prev, ord(ch)), 0)
        glyph = page.crop((c['x'], c['y'], c['x'] + c['width'], c['y'] + c['height']))
        canvas.alpha_composite(glyph, (x + c['xoffset'], pad + c['yoffset']))
        x += c['xadvance']
        prev = ord(ch)
    # Tint: the font is white; colour it, keeping alpha.
    arr = np.array(canvas).astype(np.float32)
    for i in range(3):
        arr[..., i] = arr[..., i] / 255 * colour[i]
    tinted = Image.fromarray(arr.astype(np.uint8))
    bbox = tinted.getbbox()
    tinted = tinted.crop(bbox) if bbox else tinted
    return scaled(tinted, px / size)


def rgb(hex_: int):
    return ((hex_ >> 16) & 255, (hex_ >> 8) & 255, hex_ & 255)


def judgements() -> None:
    # Our text was Venera 20px at radius/48 per pixel; osu!'s judgements draw at radius/128.
    px = 20 * 128 / 48
    for name, text, col in [('hit300', 'GREAT', 0x66ccff), ('hit100', 'OK', 0x88b300),
                            ('hit50', 'MEH', 0xffcc22), ('hit0', 'MISS', 0xed1121)]:
        save(bitmap_text(text, px, rgb(col)), f'{name}@2x.png')


def lighting() -> None:
    # Our hit lighting: a soft white glow 2.6 radii across, at osu! scale.
    size = round(2.6 * 128)

    def draw(d, _x, _y):
        t = d / (size / 2)
        a = np.interp(t, [0, 0.35, 1], [1, 0.45, 0]) * 255
        a = np.where(t >= 1, 0, a)
        rgba = np.zeros(d.shape + (4,), np.float32)
        rgba[..., :3] = 255
        rgba[..., 3] = a
        return rgba

    save(supersampled_circle(size, draw, ss=2), 'lighting@2x.png')


# ---------------------------------------------------------------------------
# HUD fonts
# ---------------------------------------------------------------------------

def score_font() -> None:
    for i in range(10):
        shutil.copy(ART / f'score-{i}.png', OUT / f'score-{i}@2x.png')
    shutil.copy(ART / 'score-..png', OUT / 'score-dot@2x.png')
    shutil.copy(ART / 'score-percent.png', OUT / 'score-percent@2x.png')
    shutil.copy(ART / 'score-x.png', OUT / 'score-x@2x.png')


# ---------------------------------------------------------------------------

SKIN_INI = """[General]
Name: wosu! default
Author: wosu! contributors
Version: 2.7
AnimationFramerate: -1
AllowSliderBallTint: 0
SliderBallFlip: 0
CursorRotate: 0
CursorExpand: 1
CursorCentre: 1
HitCircleOverlayAboveNumber: 1

[Colours]
Combo1: 96,159,159
Combo2: 192,192,192
Combo3: 128,255,255
Combo4: 139,191,222
SliderBorder: 255,255,255

[Fonts]
HitCirclePrefix: default
HitCircleOverlap: 6
ScorePrefix: score
ScoreOverlap: 6
ComboPrefix: score
ComboOverlap: 6
"""


def hitsounds() -> None:
    for f in HITSOUNDS.iterdir():
        if f.suffix in ('.wav', '.ogg') or f.name == 'LICENCE.md':
            shutil.copy(f, OUT / f.name)


def run_parts() -> None:
    ctx = type('Ctx', (), {'out': OUT, 'art': ART, 'root': ROOT, 'save': staticmethod(save), 'art_image': staticmethod(art),
                           'scaled': staticmethod(scaled), 'K': K, 'circle': staticmethod(supersampled_circle)})
    for part in sorted((HERE / 'parts').glob('*.py')):
        spec = importlib.util.spec_from_file_location(part.stem, part)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        print('part', part.stem)
        mod.build(ctx)


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    hit_circles()
    slider_ball()
    slider_parts()
    judgements()
    lighting()
    score_font()
    hitsounds()
    (OUT / 'skin.ini').write_text(SKIN_INI)
    run_parts()
    files = sorted(p.name for p in OUT.iterdir() if p.name != 'manifest.json')
    (OUT / 'manifest.json').write_text(json.dumps({'files': files}, indent=1) + '\n')
    print(f'{len(files)} files in {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    sys.exit(main())
