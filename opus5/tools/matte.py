#!/usr/bin/env python3
"""Build an alpha-matted reference cutout from hand-traced polygons.

The silhouette gates (diagnose_render.py, divine_eye.py) compare foreground
masks. The source photo contains a chair, grass and a wall, so the raw photo
cannot serve as silhouette ground truth: its foreground mask is the whole
frame. This builds the cats-only ground truth.

Modes:
  --mode overlay  draw the polygon edges over the photo, to verify the trace
  --mode cutout   write an RGBA PNG: traced pixels keep their colour, the rest
                  is fully transparent (alpha 0)
  --mode mask     write a white-on-black RGB mask

Polygons come from a JSON file: {"crop": [x0,y0,x1,y1], "polygons": [{"id": .., "points": [[x,y], ...]}]}
Points are in source-image pixel coordinates.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import zlib
from pathlib import Path

SKILL_ROOT = Path("/home/botom/devintest/arena/img2threejs/.claude/skills/img2threejs")
sys.path.insert(0, str(SKILL_ROOT))

from forge.stage4_review.make_comparison_sheet import read_png, write_png_rgb  # noqa: E402

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def write_png_rgba(path: Path, width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> None:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        checksum = zlib.crc32(kind)
        checksum = zlib.crc32(payload, checksum) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

    scanlines = bytearray()
    for y in range(height):
        scanlines.append(0)
        for red, green, blue, alpha in pixels[y * width : (y + 1) * width]:
            scanlines.extend((red, green, blue, alpha))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        PNG_SIGNATURE
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(scanlines), level=6))
        + chunk(b"IEND", b"")
    )


def scanline_fill(polygons: list[list[tuple[float, float]]], width: int, height: int) -> list[bool]:
    """Even-odd scanline fill with 3x vertical supersampling for smoother edges."""
    inside = [False] * (width * height)
    samples = (0.25, 0.5, 0.75)
    for y in range(height):
        hits = 0
        counts = [0] * width
        for offset in samples:
            sample_y = y + offset
            crossings: list[float] = []
            for points in polygons:
                count = len(points)
                for index in range(count):
                    x_a, y_a = points[index]
                    x_b, y_b = points[(index + 1) % count]
                    if (y_a <= sample_y < y_b) or (y_b <= sample_y < y_a):
                        t = (sample_y - y_a) / (y_b - y_a)
                        crossings.append(x_a + t * (x_b - x_a))
            crossings.sort()
            for pair in range(0, len(crossings) - 1, 2):
                start = max(0, int(round(crossings[pair])))
                end = min(width, int(round(crossings[pair + 1])))
                for x in range(start, end):
                    counts[x] += 1
        for x in range(width):
            if counts[x] >= 2:
                inside[y * width + x] = True
                hits += 1
    return inside


def boundary_band(inside: list[bool], width: int, height: int, band: int) -> list[bool]:
    """Pixels inside the mask within `band` pixels of its boundary (BFS depth limit)."""
    depth = [-1] * (width * height)
    frontier: list[int] = []
    for index, value in enumerate(inside):
        if not value:
            continue
        x, y = index % width, index // width
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if nx < 0 or ny < 0 or nx >= width or ny >= height or not inside[ny * width + nx]:
                depth[index] = 0
                frontier.append(index)
                break
    for step in range(band):
        nxt: list[int] = []
        for index in frontier:
            x, y = index % width, index // width
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < width and 0 <= ny < height:
                    neighbour = ny * width + nx
                    if inside[neighbour] and depth[neighbour] < 0:
                        depth[neighbour] = step + 1
                        nxt.append(neighbour)
        frontier = nxt
        if not frontier:
            break
    return [value >= 0 for value in depth]


def apply_rule(
    inside: list[bool],
    pixels: list[tuple[int, int, int, int]],
    width: int,
    height: int,
    expression: str,
    band: int,
) -> list[bool]:
    code = compile(expression, "<rule>", "eval")
    in_band = boundary_band(inside, width, height, band)
    result = list(inside)
    for index, value in enumerate(inside):
        if not value or not in_band[index]:
            continue
        r, g, b = pixels[index][:3]
        luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
        top = max(r, g, b)
        sat = 0.0 if top == 0 else (top - min(r, g, b)) / top
        if not eval(code, {"r": r, "g": g, "b": b, "luma": luma, "sat": sat}):
            result[index] = False
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("polygons", type=Path)
    parser.add_argument("--src", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--mode", choices=("overlay", "cutout", "mask"), default="cutout")
    parser.add_argument("--only", help="comma-separated polygon ids to include")
    parser.add_argument("--no-rule", action="store_true", help="ignore per-polygon snap rules")
    args = parser.parse_args(argv)

    data = json.loads(args.polygons.read_text())
    crop = data.get("crop")
    wanted = set(args.only.split(",")) if args.only else None
    selected = [
        poly for poly in data["polygons"] if wanted is None or poly.get("id") in wanted
    ]
    if not selected:
        raise SystemExit("no polygons selected")

    width, height, pixels = read_png(args.src)
    inside = [False] * (width * height)
    for poly in selected:
        points = [(float(px), float(py)) for px, py in poly["points"]]
        filled = scanline_fill([points], width, height)
        rule = poly.get("rule")
        if rule and not args.no_rule:
            filled = apply_rule(
                filled, pixels, width, height, rule, int(poly.get("band", 30))
            )
        for index, value in enumerate(filled):
            if value:
                inside[index] = True

    if args.mode == "overlay":
        canvas = [(p[0], p[1], p[2]) for p in pixels]
        for y in range(height):
            for x in range(width):
                here = inside[y * width + x]
                right = inside[y * width + x + 1] if x + 1 < width else here
                down = inside[(y + 1) * width + x] if y + 1 < height else here
                if here != right or here != down:
                    canvas[y * width + x] = (255, 0, 220)
        if crop:
            x0, y0, x1, y1 = crop
            cropped = []
            for y in range(y0, y1):
                cropped.extend(canvas[y * width + x0 : y * width + x1])
            write_png_rgb(args.out, x1 - x0, y1 - y0, cropped)
        else:
            write_png_rgb(args.out, width, height, canvas)
        print(f"{args.out} overlay written")
        return 0

    x0, y0, x1, y1 = crop if crop else (0, 0, width, height)
    out_w, out_h = x1 - x0, y1 - y0
    if args.mode == "mask":
        rows = []
        for y in range(y0, y1):
            for x in range(x0, x1):
                rows.append((255, 255, 255) if inside[y * width + x] else (0, 0, 0))
        write_png_rgb(args.out, out_w, out_h, rows)
    else:
        rows_rgba: list[tuple[int, int, int, int]] = []
        for y in range(y0, y1):
            for x in range(x0, x1):
                red, green, blue = pixels[y * width + x][:3]
                rows_rgba.append((red, green, blue, 255) if inside[y * width + x] else (0, 0, 0, 0))
        write_png_rgba(args.out, out_w, out_h, rows_rgba)
    covered = sum(1 for y in range(y0, y1) for x in range(x0, x1) if inside[y * width + x])
    print(f"{args.out} {out_w}x{out_h} coverage={covered / (out_w * out_h):.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
