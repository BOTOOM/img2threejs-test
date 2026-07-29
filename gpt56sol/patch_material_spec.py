from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SPEC_PATH = ROOT / "object-sculpt-spec.json"

MATERIALS = {
    "hidden": (0, 0, 0, 0.0, "#000000"),
    "black-fur": (27, 24, 21, 1.0, "#1b1815"),
    "tabby-fur": (160, 111, 67, 1.0, "#a06f43"),
    "white-fur": (222, 201, 169, 1.0, "#dec9a9"),
    "black-inner-ear": (74, 44, 37, 1.0, "#4a2c25"),
    "tabby-inner-ear": (185, 121, 98, 1.0, "#b97962"),
    "iris-green": (192, 201, 106, 1.0, "#c0c96a"),
    "pupil": (2, 4, 3, 1.0, "#020403"),
    "cornea": (192, 201, 106, 0.24, "#c0c96a"),
    "black-nose": (41, 32, 29, 1.0, "#29201d"),
    "tabby-nose": (196, 120, 95, 1.0, "#c4785f"),
    "whisker": (234, 223, 206, 1.0, "#eadfce"),
    "tabby-stripe": (47, 33, 24, 1.0, "#2f2118"),
}

spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
for material in spec["materials"]:
    material_id = material["id"]
    if material_id not in MATERIALS:
        continue
    red, green, blue, alpha, color = MATERIALS[material_id]
    material["baseColor"] = color
    material["color"] = color
    material["albedo"]["primary"] = color
    if material_id == "black-fur":
        material["roughness"] = {"base": 0.92, "variation": 0.08, "map": "procedural-black-fur-roughness"}
    elif material_id == "tabby-fur":
        material["roughness"] = {"base": 0.88, "variation": 0.08, "map": "procedural-tabby-fur-roughness"}
    elif material_id == "white-fur":
        material["roughness"] = {"base": 0.9, "variation": 0.08, "map": "procedural-white-fur-roughness"}
    if material_id == "iris-green":
        material["localOverrides"] = [{"id": "olive-limbal-ring", "region": "iris perimeter", "baseColor": "#59612e", "roughness": 0.3}]
    material["colorVariation"]["palette"] = [color, color]

for component in spec["componentTree"]:
    material_id = component["material"]
    if material_id not in MATERIALS:
        continue
    red, green, blue, alpha, _ = MATERIALS[material_id]
    secondary = (255, 255, 255) if material_id == "cornea" else (min(255, red + 12), min(255, green + 10), min(255, blue + 8))
    component["colorMaterialRecipe"]["dominantAlbedo"] = f"rgba({red}, {green}, {blue}, {alpha})"
    component["colorMaterialRecipe"]["secondaryAlbedo"] = f"rgba({secondary[0]}, {secondary[1]}, {secondary[2]}, {alpha})"

spec["materialEvidence"] = {
    "blackFur": {"confidence": 0.8, "report": str(ROOT / "pbr/black-fur/report.json"), "roughnessBase": 0.713, "normalStrength": 0.204},
    "tabbyFur": {"confidence": 0.829, "report": str(ROOT / "pbr/tabby-fur/report.json"), "roughnessBase": 0.702, "normalStrength": 0.189, "warning": "weak object/background separation"},
    "whiteFur": {"confidence": 0.829, "report": str(ROOT / "pbr/white-fur/report.json"), "warning": "palette contaminated by background; physical scalar evidence only"},
    "iris": {"confidence": 0.829, "report": str(ROOT / "pbr/iris/report.json"), "warning": "palette contaminated by face crop; color taken from direct visual review"},
}
SPEC_PATH.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
