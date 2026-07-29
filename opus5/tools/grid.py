#!/usr/bin/env python3
"""Overlay a labelled coordinate grid on a PNG so outline points can be read off.

Grid lines are drawn in source-image pixel coordinates; every `--major` line is
solid, every `--minor` line is dotted. Digit labels are drawn with a tiny 3x5
bitmap font at each major intersection along the top and left edges.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SKILL_ROOT = Path("/home/botom/devintest/arena/img2threejs/.claude/skills/img2threejs")
sys.path.insert(0, str(SKILL_ROOT))

from forge.stage4_review.make_comparison_sheet import read_png, write_png_rgb  # noqa: E402

FONT = {
    "0": ("111", "101", "101", "101", "111"),
    "1": ("010", "110", "010", "010", "010"),
    "2": ("111", "001", "111", "100", "111"),
    "3": ("111", "001", "111", "001", "111"),
    "4": ("101", "101", "111", "001", "001"),
    "5": ("111", "100", "111", "001", "111"),
    "6": ("111", "100", "111", "101", "111"),
    "7": ("111", "001", "001", "001", "001"),
    "8": ("111", "101", "111", "101", "111"),
    "9": ("111", "101", "111", "001", "111"),
}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("src", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--box", nargs=4, type=int, required=True, metavar=("X0", "Y0", "X1", "Y1"))
    parser.add_argument("--major", type=int, default=100)
    parser.add_argument("--minor", type=int, default=25)
    parser.add_argument("--scale", type=float, default=1.0)
    args = parser.parse_args(argv)

    width, height, src_pixels = read_png(args.src)
    x0, y0, x1, y1 = args.box
    scale = args.scale
    out_w = int((x1 - x0) * scale)
    out_h = int((y1 - y0) * scale)
    canvas = [(0, 0, 0)] * (out_w * out_h)
    for oy in range(out_h):
        sy = min(height - 1, y0 + int(oy / scale))
        row = src_pixels[sy * width : (sy + 1) * width]
        for ox in range(out_w):
            sx = min(width - 1, x0 + int(ox / scale))
            r, g, b = row[sx][:3]
            canvas[oy * out_w + ox] = (r, g, b)

    def put(px: int, py: int, color: tuple[int, int, int]) -> None:
        if 0 <= px < out_w and 0 <= py < out_h:
            canvas[py * out_w + px] = color

    def label(px: int, py: int, text: str, color: tuple[int, int, int]) -> None:
        for index, char in enumerate(text):
            glyph = FONT.get(char)
            if not glyph:
                continue
            for gy, bits in enumerate(glyph):
                for gx, bit in enumerate(bits):
                    if bit == "1":
                        for dy in range(2):
                            for dx in range(2):
                                put(px + index * 8 + gx * 2 + dx, py + gy * 2 + dy, color)

    magenta = (255, 0, 200)
    cyan = (0, 230, 255)
    for src_x in range(x0 - x0 % args.minor, x1, args.minor):
        ox = int((src_x - x0) * scale)
        major = src_x % args.major == 0
        for oy in range(out_h):
            if major or oy % 6 < 2:
                put(ox, oy, magenta if major else cyan)
        if major:
            label(ox + 2, 2, str(src_x), magenta)
    for src_y in range(y0 - y0 % args.minor, y1, args.minor):
        oy = int((src_y - y0) * scale)
        major = src_y % args.major == 0
        for ox in range(out_w):
            if major or ox % 6 < 2:
                put(ox, oy, magenta if major else cyan)
        if major:
            label(2, oy + 2, str(src_y), magenta)

    write_png_rgb(args.out, out_w, out_h, canvas)
    print(f"{args.out} {out_w}x{out_h} box=({x0},{y0},{x1},{y1}) scale={scale}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
