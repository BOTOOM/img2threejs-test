#!/usr/bin/env python3
"""Crop gatos.png to the two-cat subject region for Tier-1/Tier-2 review.

The full photo's corner background sampler marks wall+grass as background, so the
foreground mask covers cats+chair+grass — a no-op for silhouette IoU. Cropping to
the cats region (chair fabric merges into the beige background) yields a mask that
is actually the cats. Pure stdlib, reuses the skill's PNG codec.
"""
from __future__ import annotations

import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent / ".claude/skills/img2threejs"
sys.path.insert(0, str(SKILL / "forge/stage1_intake"))
sys.path.insert(0, str(SKILL / "forge/_shared"))

from extract_pbr_evidence import load_image, write_png_rgb  # noqa: E402

SRC = Path(__file__).resolve().parent.parent / "gatos.png"
DST = Path(__file__).resolve().parent / "reference-cats-crop.png"

# crop window in normalized coords (cats bbox + small margin; grass/chair edge excluded)
X0, Y0, X1, Y1 = 0.14, 0.11, 0.85, 0.87

width, height, pixels, _ = load_image(SRC)
x0, y0 = int(X0 * width), int(Y0 * height)
x1, y1 = int(X1 * width), int(Y1 * height)
cw, ch = x1 - x0, y1 - y0
buf = bytearray()
for y in range(ch):
    for x in range(cw):
        r, g, b, _a = pixels[(y0 + y) * width + x0 + x]
        buf += bytes((r, g, b))
write_png_rgb(DST, cw, ch, bytes(buf))
print(f"wrote {DST} {cw}x{ch}")
