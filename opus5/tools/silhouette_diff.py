#!/usr/bin/env python3
"""Overlay two silhouettes so a shape error points at a component.

An IoU number says "0.857"; it does not say which ear is short. This writes a
three-colour map on the same grid the gates use:

  red    = reference only  -> the model is missing volume here
  green  = render only     -> the model has volume the reference does not
  grey   = agreement

It also prints a per-band breakdown (rows and columns) so the dominant error can
be localised to a region without eyeballing.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SKILL_ROOT = Path("/home/botom/devintest/arena/img2threejs/.claude/skills/img2threejs")
sys.path.insert(0, str(SKILL_ROOT))
sys.path.insert(0, str(SKILL_ROOT / "forge" / "stage1_intake"))

from forge.stage4_review.make_comparison_sheet import write_png_rgb  # noqa: E402
from extract_pbr_evidence import build_foreground_mask, load_image  # noqa: E402

GRID = 224


def mask_grid(path: Path, size: int = GRID) -> list[bool]:
    width, height, pixels, _warnings = load_image(path)
    mask, _diag, _warn = build_foreground_mask(width, height, pixels)
    out: list[bool] = []
    for y in range(size):
        sy = min(height - 1, int(y * height / size))
        for x in range(size):
            sx = min(width - 1, int(x * width / size))
            out.append(mask[sy * width + sx])
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--render", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--scale", type=int, default=3)
    args = parser.parse_args(argv)

    reference = mask_grid(args.reference)
    render = mask_grid(args.render)

    pixels: list[tuple[int, int, int]] = []
    only_reference = only_render = both = 0
    for ref, ren in zip(reference, render):
        if ref and ren:
            pixels.append((150, 150, 150))
            both += 1
        elif ref:
            pixels.append((235, 40, 40))
            only_reference += 1
        elif ren:
            pixels.append((40, 210, 90))
            only_render += 1
        else:
            pixels.append((20, 20, 24))
    union = both + only_reference + only_render
    scale = max(1, args.scale)
    scaled: list[tuple[int, int, int]] = []
    for y in range(GRID * scale):
        row = pixels[(y // scale) * GRID : (y // scale + 1) * GRID]
        for x in range(GRID * scale):
            scaled.append(row[x // scale])
    write_png_rgb(args.out, GRID * scale, GRID * scale, scaled)

    print(f"IoU              {both / union:.4f}")
    print(f"reference-only   {only_reference / union:.4f}  (model missing volume)")
    print(f"render-only      {only_render / union:.4f}  (model has extra volume)")
    print("")
    print("row bands (top -> bottom), share of that band's union:")
    for band in range(8):
        y0, y1 = band * GRID // 8, (band + 1) * GRID // 8
        miss = extra = tot = 0
        for y in range(y0, y1):
            for x in range(GRID):
                ref, ren = reference[y * GRID + x], render[y * GRID + x]
                if ref or ren:
                    tot += 1
                    if ref and not ren:
                        miss += 1
                    elif ren and not ref:
                        extra += 1
        if tot:
            print(f"  rows {y0:3d}-{y1:3d}  missing {miss / tot:.3f}  extra {extra / tot:.3f}")
    print("")
    print("column bands (left -> right):")
    for band in range(8):
        x0, x1 = band * GRID // 8, (band + 1) * GRID // 8
        miss = extra = tot = 0
        for y in range(GRID):
            for x in range(x0, x1):
                ref, ren = reference[y * GRID + x], render[y * GRID + x]
                if ref or ren:
                    tot += 1
                    if ref and not ren:
                        miss += 1
                    elif ren and not ref:
                        extra += 1
        if tot:
            print(f"  cols {x0:3d}-{x1:3d}  missing {miss / tot:.3f}  extra {extra / tot:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
