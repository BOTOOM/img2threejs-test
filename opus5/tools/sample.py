#!/usr/bin/env python3
"""Report median / p10 / p90 RGB inside named boxes of a PNG.

Observation aid: material albedo and colorMaterialRecipe values must come from
reference pixels, not memory. Boxes are given as name=x0,y0,x1,y1 in source
image pixel coordinates.
"""

from __future__ import annotations

import sys
from pathlib import Path

SKILL_ROOT = Path("/home/botom/devintest/arena/img2threejs/.claude/skills/img2threejs")
sys.path.insert(0, str(SKILL_ROOT))

from forge.stage4_review.make_comparison_sheet import read_png  # noqa: E402


def stats(values: list[int]) -> tuple[int, int, int]:
    ordered = sorted(values)
    n = len(ordered)
    return ordered[n // 10], ordered[n // 2], ordered[min(n - 1, (9 * n) // 10)]


def main(argv: list[str]) -> int:
    src = Path(argv[0])
    width, height, pixels = read_png(src)
    print(f"# {src.name} {width}x{height}")
    print(f"{'name':<22} {'median hex':<10} {'median rgb':<16} {'p10 rgb':<16} {'p90 rgb':<16} px")
    for spec in argv[1:]:
        name, box = spec.split("=", 1)
        x0, y0, x1, y1 = (int(v) for v in box.split(","))
        reds: list[int] = []
        greens: list[int] = []
        blues: list[int] = []
        for y in range(max(0, y0), min(height, y1)):
            row = pixels[y * width : (y + 1) * width]
            for x in range(max(0, x0), min(width, x1)):
                r, g, b = row[x][:3]
                reds.append(r)
                greens.append(g)
                blues.append(b)
        if not reds:
            print(f"{name:<22} EMPTY")
            continue
        r10, r50, r90 = stats(reds)
        g10, g50, g90 = stats(greens)
        b10, b50, b90 = stats(blues)
        print(
            f"{name:<22} #{r50:02X}{g50:02X}{b50:02X}   "
            f"{f'{r50},{g50},{b50}':<16} {f'{r10},{g10},{b10}':<16} "
            f"{f'{r90},{g90},{b90}':<16} {len(reds)}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
