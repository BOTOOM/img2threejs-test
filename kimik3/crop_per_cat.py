#!/usr/bin/env python3
"""Crop an image to the foreground bbox found inside a horizontal window.

Used for per-cat Tier-1 diagnostics: crop the reference mask and the render to
the SAME cat (left/right window) so the 224-grid mask comparison is per-subject.
"""
from __future__ import annotations

import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent / ".claude/skills/img2threejs"
sys.path.insert(0, str(SKILL / "forge/stage1_intake"))
from extract_pbr_evidence import load_image, build_foreground_mask  # noqa: E402
from delight_albedo import write_png_rgba  # noqa: E402


def main() -> None:
    src = Path(sys.argv[1]).resolve()
    dst = Path(sys.argv[2]).resolve()
    wx0, wx1 = float(sys.argv[3]), float(sys.argv[4])
    margin = float(sys.argv[5]) if len(sys.argv) > 5 else 0.05
    width, height, pixels, _ = load_image(src)
    mask, _diag, _warn = build_foreground_mask(width, height, pixels)
    x0w, x1w = int(wx0 * width), int(wx1 * width)
    xs, ys = [], []
    for y in range(height):
        for x in range(x0w, x1w):
            if mask[y * width + x]:
                xs.append(x)
                ys.append(y)
    if not xs:
        raise SystemExit(f"empty mask in window {wx0}-{wx1} of {src.name}")
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    mx, my = int((x1 - x0) * margin), int((y1 - y0) * margin)
    x0, x1 = max(0, x0 - mx), min(width - 1, x1 + mx)
    y0, y1 = max(0, y0 - my), min(height - 1, y1 + my)
    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    has_alpha = any(p[3] < 245 for p in pixels)
    buf = bytearray()
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            r, g, b, a = pixels[y * width + x]
            buf += bytes((r, g, b, a if has_alpha else 255))
    write_png_rgba(dst, cw, ch, bytes(buf))
    print(f"{src.name} [{wx0}-{wx1}] -> {dst.name} {cw}x{ch} bbox=({x0},{y0})-({x1},{y1})")


if __name__ == "__main__":
    main()
