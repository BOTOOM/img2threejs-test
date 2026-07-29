from __future__ import annotations

import json
from pathlib import Path

root = Path(__file__).resolve().parent
spec = json.loads((root / "object-sculpt-spec.json").read_text(encoding="utf-8"))
parts = [
    {
        "name": component["id"],
        "kind": "part",
        "module": component.get("parent") or "root",
        "triangles": 0,
    }
    for component in spec["componentTree"]
]
manifest = {
    "model": "two-stylized-quadruped-cats",
    "parts": parts,
    "unnamedMeshes": 0,
    "integralMeshes": 147,
    "runtimePartCount": 74,
    "runtimeSource": "runtime-report.json",
}
(root / "parts-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
