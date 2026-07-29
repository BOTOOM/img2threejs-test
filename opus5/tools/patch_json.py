#!/usr/bin/env python3
"""Deep-merge a JSON patch into a JSON document, in place.

Dicts merge recursively. Any other value (including lists) replaces the target,
so a patch can rewrite componentTree/materials wholesale while still editing a
single nested scalar elsewhere. A key whose patch value is the string
"__DELETE__" is removed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

DELETE = "__DELETE__"


def merge(target: Any, patch: Any) -> Any:
    if not isinstance(target, dict) or not isinstance(patch, dict):
        return patch
    for key, value in patch.items():
        if value == DELETE:
            target.pop(key, None)
        elif key in target:
            target[key] = merge(target[key], value)
        else:
            target[key] = value
    return target


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document", type=Path)
    parser.add_argument("patch", type=Path)
    parser.add_argument("--out", type=Path, help="write here instead of in place")
    args = parser.parse_args(argv)

    document = json.loads(args.document.read_text(encoding="utf-8"))
    patch = json.loads(args.patch.read_text(encoding="utf-8"))
    merged = merge(document, patch)
    destination = args.out or args.document
    destination.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"patched {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
