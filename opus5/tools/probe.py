#!/usr/bin/env python3
"""Print per-row (or per-column) runs of pixels matching a predicate.

Used to read exact silhouette edges off the reference. The black cat separates
from the chair by luma and from the grass by hue (grass has g > r), so a
predicate probe gives its outline to the pixel; the tabby's fur is
chromatically identical to the shadowed chair back and must be traced by hand.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SKILL_ROOT = Path("/home/botom/devintest/arena/img2threejs/.claude/skills/img2threejs")
sys.path.insert(0, str(SKILL_ROOT))

from forge.stage4_review.make_comparison_sheet import read_png  # noqa: E402


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("src", type=Path)
    parser.add_argument("--box", nargs=4, type=int, required=True, metavar=("X0", "Y0", "X1", "Y1"))
    parser.add_argument("--axis", choices=("row", "col"), default="row")
    parser.add_argument("--step", type=int, default=10)
    parser.add_argument("--expr", default="luma < 0.32 and r >= g - 2")
    parser.add_argument("--min-run", type=int, default=6)
    args = parser.parse_args(argv)

    width, height, pixels = read_png(args.src)
    x0, y0, x1, y1 = args.box
    code = compile(args.expr, "<expr>", "eval")

    def match(px: tuple[int, int, int, int]) -> bool:
        r, g, b = px[0], px[1], px[2]
        luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
        top = max(r, g, b)
        sat = 0.0 if top == 0 else (top - min(r, g, b)) / top
        return bool(eval(code, {"r": r, "g": g, "b": b, "luma": luma, "sat": sat}))

    outer = range(y0, y1, args.step) if args.axis == "row" else range(x0, x1, args.step)
    for outer_value in outer:
        runs: list[tuple[int, int]] = []
        start = None
        inner = range(x0, x1) if args.axis == "row" else range(y0, y1)
        for inner_value in inner:
            px = (
                pixels[outer_value * width + inner_value]
                if args.axis == "row"
                else pixels[inner_value * width + outer_value]
            )
            if match(px):
                start = inner_value if start is None else start
            elif start is not None:
                if inner_value - start >= args.min_run:
                    runs.append((start, inner_value - 1))
                start = None
        if start is not None and inner.stop - start >= args.min_run:
            runs.append((start, inner.stop - 1))
        label = "y" if args.axis == "row" else "x"
        print(f"{label}={outer_value:4d}  " + "  ".join(f"[{a}..{b}]" for a, b in runs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
