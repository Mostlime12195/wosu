"""
cursor-smoke@2x.png: the puff the smoke key draws along the cursor's path
(osu!'s cursor-smoke; lazer's SmokeSegment draws each point at
0.33 × the texture's display size, additively, spaced 7/8 of a half width).

A soft, grainy white puff: a radial envelope times seeded value noise, so
overlapping points read as smoke rather than a smooth tube. 128px at @2x
(64 display units, like lazer's own smoke texture) puts a point at about
21 playfield units across.

Standard library only (zlib + struct), so it builds without Pillow. It also
runs on its own and adds itself to the existing default skin:

    python3 tools/default-skin/parts/cursor_smoke.py
"""
import json
import math
import random
import struct
import zlib
from pathlib import Path

SIZE = 128
NAME = 'cursor-smoke@2x.png'
SEED = 0x5304
PEAK_ALPHA = 0.8


def _value_noise(size: int, cells: int, rng: random.Random):
    """Smoothly interpolated random lattice values in [0, 1], `cells` per side."""
    grid = [[rng.random() for _ in range(cells + 1)] for _ in range(cells + 1)]

    def at(x: float, y: float) -> float:
        gx, gy = x / size * cells, y / size * cells
        x0, y0 = min(int(gx), cells - 1), min(int(gy), cells - 1)
        fx, fy = gx - x0, gy - y0
        sx, sy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
        top = grid[y0][x0] + (grid[y0][x0 + 1] - grid[y0][x0]) * sx
        bot = grid[y0 + 1][x0] + (grid[y0 + 1][x0 + 1] - grid[y0 + 1][x0]) * sx
        return top + (bot - top) * sy

    return at


def smoke_alpha(size: int = SIZE, seed: int = SEED) -> list:
    """Alpha (0-255) per pixel, row-major."""
    rng = random.Random(seed)
    octaves = [(_value_noise(size, c, rng), w) for c, w in ((4, 0.45), (8, 0.3), (16, 0.17), (32, 0.08))]
    c = (size - 1) / 2
    out = []
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - c, y - c) / (size / 2)
            # Soft round envelope: full in the middle, gone by the edge.
            env = max(0.0, 1 - d) ** 1.1
            n = sum(f(x, y) * w for f, w in octaves)
            # Contrast the noise into wisps and gaps.
            n = min(1.0, max(0.0, (n - 0.22) / 0.45))
            out.append(round(255 * PEAK_ALPHA * env * n))
    return out


def png_rgba(width: int, height: int, alpha: list) -> bytes:
    """A white RGBA PNG with the given alpha (filter 0 rows, deflated)."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows += bytes((255, 255, 255, alpha[y * width + x]))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b'')


def write(out: Path) -> None:
    (out / NAME).write_bytes(png_rgba(SIZE, SIZE, smoke_alpha()))


def build(ctx) -> None:
    write(ctx.out)


if __name__ == '__main__':
    out = Path(__file__).resolve().parents[3] / 'public' / 'assets' / 'skins' / 'default'
    write(out)
    manifest = out / 'manifest.json'
    files = sorted(p.name for p in out.iterdir() if p.name != 'manifest.json')
    manifest.write_text(json.dumps({'files': files}, indent=1) + '\n')
    print(f'wrote {NAME}; {len(files)} files in the manifest')
