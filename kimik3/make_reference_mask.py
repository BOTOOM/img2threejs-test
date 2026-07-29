#!/usr/bin/env python3
"""Build a cats-only alpha mask for the reference crop via border-seeded flood fill.

The corner-sampler in build_foreground_mask fails on gatos.png crops because the
bottom corners contain grass (mixed clusters -> huge noise -> degenerate mask).
Flood fill from the image border marks as background only pixels CONTINUOUSLY
similar to the border color field (wall / chair fabric / grass), so interior
light regions (white blaze, pale muzzle) stay foreground. Output: RGBA PNG with
transparent background; diagnose_render then masks purely by alpha.
"""
from __future__ import annotations

import sys
from collections import deque
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent / ".claude/skills/img2threejs"
sys.path.insert(0, str(SKILL / "forge/stage1_intake"))
from extract_pbr_evidence import load_image  # noqa: E402
from delight_albedo import write_png_rgba  # noqa: E402

SRC = Path(__file__).resolve().parent / "reference-cats-crop.png"
DST = Path(__file__).resolve().parent / "reference-cats-mask.png"

TOL = 26.0          # local continuity (RGB euclidean between neighbours)
GLOBAL_TOL = 55.0   # candidate must also stay near a border colour cluster


def border_clusters(pixels: list[tuple[int, int, int, int]], width: int, height: int) -> tuple[list[float], list[float]]:
    """Two crude border colour clusters: green (grass) and non-green (wall/chair)."""
    green = [0.0, 0.0, 0.0]
    other = [0.0, 0.0, 0.0]
    ng = no = 0

    def feed(i: int) -> None:
        nonlocal ng, no
        r, g, b, _a = pixels[i]
        if g > r + 8 and g > b + 8:
            green[0] += r; green[1] += g; green[2] += b; ng += 1
        else:
            other[0] += r; other[1] += g; other[2] += b; no += 1

    for x in range(width):
        feed(x)
        feed((height - 1) * width + x)
    for y in range(height):
        feed(y * width)
        feed(y * width + width - 1)
    if ng:
        green = [v / ng for v in green]
    if no:
        other = [v / no for v in other]
    return green, other


def main() -> None:
    width, height, pixels, _ = load_image(SRC)
    n = width * height
    is_bg = bytearray(n)

    def dist2(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
        return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)

    tol2 = TOL * TOL
    gtol2 = GLOBAL_TOL * GLOBAL_TOL
    green, other = border_clusters(pixels, width, height)

    def near_cluster(p: tuple[int, int, int, int]) -> bool:
        dg = (p[0] - green[0]) ** 2 + (p[1] - green[1]) ** 2 + (p[2] - green[2]) ** 2
        do = (p[0] - other[0]) ** 2 + (p[1] - other[1]) ** 2 + (p[2] - other[2]) ** 2
        return min(dg, do) < gtol2

    queue: deque[int] = deque()
    for x in range(width):
        for idx in (x, (height - 1) * width + x):
            is_bg[idx] = 1
            queue.append(idx)
    for y in range(height):
        for idx in (y * width, y * width + width - 1):
            if not is_bg[idx]:
                is_bg[idx] = 1
                queue.append(idx)

    while queue:
        idx = queue.popleft()
        px = pixels[idx]
        x, y = idx % width, idx // width
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if nx < 0 or ny < 0 or nx >= width or ny >= height:
                continue
            ni = ny * width + nx
            if is_bg[ni]:
                continue
            npix = pixels[ni]
            if dist2(npix, px) < tol2 and near_cluster(npix):
                is_bg[ni] = 1
                queue.append(ni)

    buf = bytearray()
    for i, p in enumerate(pixels):
        if is_bg[i]:
            buf += bytes((0, 0, 0, 0))
        else:
            buf += bytes((p[0], p[1], p[2], 255))
    write_png_rgba(DST, width, height, bytes(buf))
    fg = n - sum(is_bg)
    print(f"wrote {DST} fg={fg / n:.3f} of {width}x{height}")


if __name__ == "__main__":
    main()
