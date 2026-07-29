#!/usr/bin/env python3
"""Crop a render PNG to its foreground bbox (+3% margin) for Tier-1 framing parity.

The reference mask PNG is cats-only (alpha). diagnose_render compares 224-grid masks,
so both sides must fill their frames equivalently; cropping the render to its subject
bbox makes scale/aspect deltas measure GEOMETRY, not camera distance.
"""
from __future__ import annotations

import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent / ".claude/skills/img2threejs"
sys.path.insert(0, str(SKILL / "forge/stage1_intake"))
from extract_pbr_evidence import load_image, build_foreground_mask, write_png_rgb  # noqa: E402


def main() -> None:
    src = Path(sys.argv[1]).resolve()
    dst = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else src
    margin = float(sys.argv[3]) if len(sys.argv) > 3 else 0.03
    width, height, pixels, _ = load_image(src)
    mask, _diag, _warn = build_foreground_mask(width, height, pixels)
    xs = [i % width for i, v in enumerate(mask) if v]
    ys = [i // width for i, v in enumerate(mask) if v]
    if not xs:
        raise SystemExit("empty foreground mask")
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    mx = int((x1 - x0) * margin)
    my = int((y1 - y0) * margin)
    x0 = max(0, x0 - mx); x1 = min(width - 1, x1 + mx)
    y0 = max(0, y0 - my); y1 = min(height - 1, y1 + my)
    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    buf = bytearray()
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            r, g, b, _a = pixels[y * width + x]
            buf += bytes((r, g, b))
    write_png_rgb(dst, cw, ch, bytes(buf))
    print(f"{src.name} -> {dst.name} {cw}x{ch} bbox=({x0},{y0})-({x1},{y1})")


if __name__ == "__main__":
    main()
