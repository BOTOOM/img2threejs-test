#!/usr/bin/env python3
"""Crop / scale a PNG region using the skill's stdlib PNG codec.

Used only to prepare reference crops for observation and for the PBR/texture
scripts, which expect small single-region PNG inputs.

Usage:
  crop.py <src.png> <out.png> --box X0 Y0 X1 Y1 [--scale N] [--zoom N]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SKILL_ROOT = Path("/home/botom/devintest/arena/img2threejs/.claude/skills/img2threejs")
sys.path.insert(0, str(SKILL_ROOT))

from forge.stage4_review.make_comparison_sheet import read_png, write_png_rgb  # noqa: E402


def crop(pixels, width, box):
    x0, y0, x1, y1 = box
    out = []
    for y in range(y0, y1):
        row = pixels[y * width : (y + 1) * width]
        out.extend(row[x0:x1])
    return out, x1 - x0, y1 - y0


def resample(pixels, width, height, factor):
    """Nearest-neighbour zoom (factor > 1) or box-average shrink (factor < 1)."""
    if factor == 1:
        return pixels, width, height
    out_w = max(1, int(width * factor))
    out_h = max(1, int(height * factor))
    out = []
    if factor > 1:
        for y in range(out_h):
            src_y = min(height - 1, int(y / factor))
            row = pixels[src_y * width : (src_y + 1) * width]
            for x in range(out_w):
                out.append(row[min(width - 1, int(x / factor))])
        return out, out_w, out_h
    step_x = width / out_w
    step_y = height / out_h
    for y in range(out_h):
        y_start, y_end = int(y * step_y), max(int(y * step_y) + 1, int((y + 1) * step_y))
        for x in range(out_w):
            x_start, x_end = int(x * step_x), max(int(x * step_x) + 1, int((x + 1) * step_x))
            acc_r = acc_g = acc_b = count = 0
            for sy in range(y_start, min(y_end, height)):
                base = sy * width
                for sx in range(x_start, min(x_end, width)):
                    r, g, b = pixels[base + sx][:3]
                    acc_r += r
                    acc_g += g
                    acc_b += b
                    count += 1
            out.append((acc_r // count, acc_g // count, acc_b // count))
    return out, out_w, out_h


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("src", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--box", nargs=4, type=int, required=True, metavar=("X0", "Y0", "X1", "Y1"))
    parser.add_argument("--scale", type=float, default=1.0, help="resample factor")
    args = parser.parse_args(argv)

    width, height, pixels = read_png(args.src)
    x0, y0, x1, y1 = args.box
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    region, rw, rh = crop(pixels, width, (x0, y0, x1, y1))
    region, rw, rh = resample(region, rw, rh, args.scale)
    write_png_rgb(args.out, rw, rh, [(p[0], p[1], p[2]) for p in region])
    print(f"{args.out} {rw}x{rh} from box=({x0},{y0},{x1},{y1}) of {width}x{height}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
