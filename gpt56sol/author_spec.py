from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
SPEC_PATH = ROOT / "object-sculpt-spec.json"


def action_profile(role: str, pivot_mode: str, collider: str, material: str) -> dict[str, Any]:
    movable = role in {"root", "cat-root", "head", "ear", "tail", "limb"}
    return {
        "animationRole": role,
        "pivot": {
            "mode": pivot_mode,
            "localPosition": [0.0, 0.0, 0.0],
            "axis": [0.0, 1.0, 0.0],
            "confidence": 0.9,
        },
        "transformChannels": {
            "translate": role in {"root", "cat-root"},
            "rotate": movable,
            "scale": True,
            "bend": role in {"tail", "limb"},
            "twist": role in {"head", "ear", "tail"},
            "detach": False,
            "visibility": True,
            "materialState": True,
        },
        "sockets": [],
        "collider": {
            "type": collider,
            "offset": [0.0, 0.0, 0.0],
            "scale": [1.0, 1.0, 1.0],
            "isTrigger": False,
        },
        "constraints": [],
        "destruction": {
            "breakable": False,
            "fractureGroup": "soft-body",
            "seamRefs": [],
            "detachableFragments": [],
            "breakImpulse": 0.0,
            "debrisMaterial": material,
        },
    }


def component(
    component_id: str,
    name: str,
    level: str,
    role: str,
    primitive: str,
    parent: str | None,
    position: tuple[float, float, float],
    scale: tuple[float, float, float],
    material: str,
    evidence: str,
    confidence: float,
    local_features: list[str] | None = None,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    topology: str = "continuous-sculpt",
    pivot_mode: str = "center",
) -> dict[str, Any]:
    albedo_by_material = {
        "hidden": (0, 0, 0, 0.0),
        "black-fur": (17, 16, 15, 1.0),
        "tabby-fur": (139, 96, 59, 1.0),
        "white-fur": (232, 215, 189, 1.0),
        "black-inner-ear": (74, 44, 37, 1.0),
        "tabby-inner-ear": (185, 121, 98, 1.0),
        "iris-green": (169, 184, 79, 1.0),
        "pupil": (3, 5, 4, 1.0),
        "cornea": (216, 241, 229, 0.22),
        "black-nose": (41, 32, 29, 1.0),
        "tabby-nose": (155, 95, 76, 1.0),
        "whisker": (231, 223, 207, 1.0),
        "tabby-stripe": (42, 33, 27, 1.0),
    }
    red, green, blue, alpha = albedo_by_material[material]
    material_class = "glass" if material == "cornea" else "unknown" if material == "hidden" else "skin"
    item: dict[str, Any] = {
        "id": component_id,
        "name": name,
        "level": level,
        "role": role,
        "importance": 1.0 if level == "macro" else 0.8 if level == "meso" else 0.6,
        "confidence": confidence,
        "primitive": primitive,
        "topologyClass": topology,
        "topologyRationale": f"{name} is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in {evidence}.",
        "geometryDescriptor": {
            "topologyIntent": "soft rounded procedural volume with stable named pivot" if topology == "continuous-sculpt" else "separate procedural surface or assembled detail",
            "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3},
            "deformationStack": ["elliptical scale", "reference-proportion adjustment"],
            "uvStrategy": "generated triplanar or local procedural coordinates",
            "normalStrategy": "vertex normals plus independent procedural micro-normal response",
        },
        "parent": parent,
        "attachment": None,
        "dimensions": {
            "width": scale[0],
            "height": scale[1],
            "depth": scale[2],
            "units": "world",
            "confidence": confidence,
        },
        "transform": {
            "position": list(position),
            "rotation": list(rotation),
            "scale": list(scale),
        },
        "actionProfile": action_profile(role, pivot_mode, "capsule" if role in {"cat-root", "limb", "tail"} else "sphere", material),
        "material": material,
        "materialLayers": [material],
        "colorMaterialRecipe": {
            "dominantAlbedo": f"rgba({red}, {green}, {blue}, {alpha})",
            "secondaryAlbedo": f"rgba({min(255, red + 12)}, {min(255, green + 10)}, {min(255, blue + 8)}, {alpha})",
            "materialClass": material_class,
            "materialClassConfidence": 0.9 if material != "hidden" else 1.0,
        },
        "deformations": [],
        "joints": [],
        "seams": [],
        "localFeatures": local_features or [],
        "surfaceDetail": {
            "macroRoughness": 0.08,
            "microRoughness": 0.04,
            "bumpAmplitude": 0.012 if "fur" in material else 0.004,
            "normalPattern": "short-fur-flow" if "fur" in material else "dielectric-surface",
            "displacementPattern": "sparse-silhouette-tufts" if "fur" in material else "none",
            "occlusionPattern": "contact-and-fold-cavity",
            "edgeWearPattern": "none",
            "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO.",
        },
        "viewEvidenceRefs": [evidence],
    }
    if parent is not None:
        item["attachment"] = {
            "parentId": parent,
            "parentSocket": f"{parent}-socket",
            "localStart": [0.0, 0.0, 0.0],
            "localEnd": [0.0, max(0.08, scale[1]), 0.0],
            "contactType": "overlap",
            "embedDepth": 0.04,
            "gapTolerance": 0.01,
            "contactNormal": [0.0, 1.0, 0.0],
            "evidenceRefs": [evidence],
        }
    return item


def material(
    material_id: str,
    color: str,
    roughness: float,
    normal_strength: float,
    overrides: list[dict[str, Any]] | None = None,
    utility: bool = False,
) -> dict[str, Any]:
    return {
        "id": material_id,
        "name": material_id.replace("-", " ").title(),
        "type": "standard",
        "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR",
        "qualityTier": "utility" if utility else "hero-procedural",
        "baseColor": color,
        "color": color,
        "colorVariation": {
            "palette": [color, color],
            "pattern": "component-local deterministic variation",
            "amplitude": 0.04,
            "heightCorrelation": 0.0,
        },
        "albedo": {"primary": color, "secondary": color, "map": f"procedural-{material_id}-albedo"},
        "roughness": {"base": roughness, "variation": 0.08, "map": f"procedural-{material_id}-roughness"},
        "metalness": {"base": 0.0, "variation": 0.0},
        "normal": {"strength": normal_strength, "map": f"procedural-{material_id}-normal"},
        "ambientOcclusion": {"strength": 0.35, "map": f"procedural-{material_id}-ao"},
        "opacity": {"base": 0.0 if material_id == "hidden" else 1.0},
        "clearcoat": 0.45 if material_id in {"cornea", "black-nose", "tabby-nose"} else 0.0,
        "clearcoatRoughness": 0.08,
        "textureResolution": 1024,
        "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4},
        "surfaceFrequencyBands": [
            {"id": "macro", "frequency": 0.35, "amplitude": 0.025},
            {"id": "meso", "frequency": 3.5, "amplitude": 0.012},
            {"id": "micro", "frequency": 42.0, "amplitude": 0.004},
        ],
        "localOverrides": overrides or [],
        "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."],
    }


def build_components() -> list[dict[str, Any]]:
    c: list[dict[str, Any]] = []
    add = c.append
    add(component("root", "Paired cats root", "macro", "root", "box", None, (0, 0, 0), (0.01, 0.01, 0.01), "hidden", "full-object", 1.0, topology="assembled-solid"))

    add(component("black-cat", "Black cat quadruped root", "macro", "cat-root", "box", "root", (-0.68, 0.0, 0.0), (0.01, 0.01, 0.01), "hidden", "black-body", 0.9, topology="assembled-solid", pivot_mode="base"))
    add(component("black-torso", "Black cat upright torso", "macro", "body", "ellipsoid", "black-cat", (-0.68, 1.42, -0.04), (0.88, 1.62, 0.72), "black-fur", "black-body", 0.92, ["black-coat-directional-flow"]))
    add(component("black-rump", "Black cat seated rump", "macro", "body", "ellipsoid", "black-cat", (-0.78, 0.75, -0.2), (1.02, 0.78, 0.82), "black-fur", "black-body", 0.72))
    add(component("black-chest", "Black cat tapered chest", "meso", "body", "ellipsoid", "black-torso", (-0.68, 1.48, 0.28), (0.72, 1.18, 0.42), "black-fur", "black-body", 0.9, ["black-coat-warm-rim"]))
    add(component("black-neck", "Black cat neck bridge", "meso", "connector", "ellipsoid", "black-torso", (-0.68, 2.27, 0.1), (0.58, 0.52, 0.5), "black-fur", "black-body", 0.84))
    add(component("black-head", "Black cat head pivot", "macro", "head", "ellipsoid", "black-neck", (-0.7, 2.88, 0.22), (0.72, 0.75, 0.62), "black-fur", "black-face", 0.96, ["black-eye-wetline", "black-round-pupil", "black-iris-ring"], pivot_mode="joint"))
    for side, sx, angle in (("l", -1.0, 0.12), ("r", 1.0, -0.12)):
        add(component(f"black-ear-{side}", f"Black cat {side} ear pivot", "meso", "ear", "cone", "black-head", (-0.7 + sx * 0.39, 3.58, 0.19), (0.43, 0.78, 0.2), "black-fur", "ear-region", 0.94, ["black-inner-ear-ridges"] if side == "l" else [], rotation=(0.0, 0.0, angle), topology="assembled-solid", pivot_mode="base"))
        add(component(f"black-inner-ear-{side}", f"Black cat {side} inner ear", "micro", "detail", "cone", f"black-ear-{side}", (-0.7 + sx * 0.39, 3.55, 0.35), (0.26, 0.54, 0.06), "black-inner-ear", "ear-region", 0.88, topology="surface-relief"))
    for side, sx in (("l", -1.0), ("r", 1.0)):
        ex = -0.7 + sx * 0.25
        add(component(f"black-eye-{side}", f"Black cat {side} eyeball", "meso", "detail", "sphere", "black-head", (ex, 2.99, 0.72), (0.25, 0.27, 0.16), "iris-green", "black-face", 0.98))
        add(component(f"black-iris-{side}", f"Black cat {side} iris ring", "micro", "detail", "sphere", f"black-eye-{side}", (ex, 2.99, 0.825), (0.205, 0.22, 0.035), "iris-green", "black-face", 0.97))
        add(component(f"black-pupil-{side}", f"Black cat {side} round pupil", "micro", "detail", "sphere", f"black-iris-{side}", (ex, 2.99, 0.855), (0.13, 0.145, 0.022), "pupil", "black-face", 0.99))
        add(component(f"black-cornea-{side}", f"Black cat {side} convex cornea", "micro", "detail", "sphere", f"black-eye-{side}", (ex, 2.99, 0.87), (0.225, 0.24, 0.05), "cornea", "black-face", 0.96))
    for side, sx in (("l", -1.0), ("r", 1.0)):
        add(component(f"black-muzzle-{side}", f"Black cat {side} muzzle pad", "meso", "body", "ellipsoid", "black-head", (-0.7 + sx * 0.18, 2.66, 0.7), (0.27, 0.22, 0.2), "black-fur", "black-face", 0.92))
        add(component(f"black-whiskers-{side}", f"Black cat {side} whisker fan", "micro", "detail", "instanced-cluster", f"black-muzzle-{side}", (-0.7 + sx * 0.28, 2.67, 0.83), (0.72, 0.34, 0.05), "whisker", "black-face", 0.93, ["black-whisker-fan"], topology="fiber-strand", pivot_mode="root"))
    add(component("black-nose", "Black cat triangular nose", "micro", "detail", "cone", "black-head", (-0.7, 2.72, 0.87), (0.17, 0.14, 0.1), "black-nose", "black-face", 0.94, topology="assembled-solid"))
    add(component("black-chin", "Black cat chin", "micro", "detail", "ellipsoid", "black-head", (-0.7, 2.52, 0.66), (0.26, 0.15, 0.16), "black-fur", "black-face", 0.82))
    for side, sx in (("l", -1.0), ("r", 1.0)):
        lx = -0.68 + sx * 0.24
        add(component(f"black-front-leg-{side}", f"Black cat {side} front leg", "meso", "limb", "capsule", "black-torso", (lx, 0.72, 0.28), (0.27, 1.18, 0.29), "black-fur", "black-body", 0.9, pivot_mode="root"))
        add(component(f"black-front-paw-{side}", f"Black cat {side} front paw", "meso", "limb", "ellipsoid", f"black-front-leg-{side}", (lx, 0.16, 0.45), (0.36, 0.23, 0.48), "black-fur", "black-paws", 0.94, ["black-paw-toe-grooves"] if side == "l" else [], pivot_mode="root"))
        add(component(f"black-hind-leg-{side}", f"Black cat {side} folded hind leg", "meso", "limb", "ellipsoid", "black-rump", (-0.68 + sx * 0.48, 0.45, -0.02), (0.52, 0.6, 0.6), "black-fur", "black-body", 0.52, pivot_mode="root"))
        add(component(f"black-hind-paw-{side}", f"Black cat {side} hind paw", "meso", "limb", "ellipsoid", f"black-hind-leg-{side}", (-0.68 + sx * 0.48, 0.16, 0.24), (0.48, 0.24, 0.52), "black-fur", "black-paws", 0.58, pivot_mode="root"))
    add(component("black-tail", "Black cat inferred curled tail pivot", "meso", "tail", "curve-sweep", "black-rump", (-1.15, 0.4, -0.26), (0.25, 1.55, 0.25), "black-fur", "hidden-posterior", 0.3, ["inferred-curled-tail"], topology="continuous-sculpt", pivot_mode="root"))

    add(component("tabby-cat", "Tabby cat quadruped root", "macro", "cat-root", "box", "root", (0.7, 0.0, 0.08), (0.01, 0.01, 0.01), "hidden", "tabby-body", 0.9, topology="assembled-solid", pivot_mode="base"))
    add(component("tabby-torso", "Tabby cat broad torso", "macro", "body", "ellipsoid", "tabby-cat", (0.68, 1.36, -0.02), (1.02, 1.32, 0.82), "tabby-fur", "tabby-body", 0.94, ["tabby-torso-stripes"]))
    add(component("tabby-rump", "Tabby cat posterior rump", "macro", "body", "ellipsoid", "tabby-cat", (0.82, 1.0, -0.4), (1.08, 0.9, 0.9), "tabby-fur", "tabby-body", 0.5))
    add(component("tabby-chest", "Tabby cat chest volume", "meso", "body", "ellipsoid", "tabby-torso", (0.7, 1.43, 0.35), (0.82, 1.0, 0.46), "tabby-fur", "tabby-body", 0.92))
    add(component("tabby-bib", "Tabby cat white chest bib", "meso", "panel", "ellipsoid", "tabby-chest", (0.7, 1.66, 0.68), (0.62, 0.78, 0.08), "white-fur", "tabby-body", 0.97, ["tabby-white-bib"], topology="conforming-shell"))
    add(component("tabby-neck", "Tabby cat neck bridge", "meso", "connector", "ellipsoid", "tabby-torso", (0.72, 2.23, 0.12), (0.65, 0.5, 0.52), "tabby-fur", "tabby-body", 0.86))
    add(component("tabby-head", "Tabby cat head pivot", "macro", "head", "ellipsoid", "tabby-neck", (0.78, 2.75, 0.32), (0.78, 0.76, 0.66), "tabby-fur", "tabby-face", 0.97, ["tabby-eye-wetline", "tabby-round-pupil", "tabby-iris-ring", "tabby-forehead-m", "tabby-cheek-stripes"], pivot_mode="joint"))
    for side, sx, angle in (("l", -1.0, 0.1), ("r", 1.0, -0.16)):
        add(component(f"tabby-ear-{side}", f"Tabby cat {side} ear pivot", "meso", "ear", "cone", "tabby-head", (0.78 + sx * 0.42, 3.47, 0.28), (0.45, 0.79, 0.21), "tabby-fur", "ear-region", 0.95, ["tabby-inner-ear-ridges"] if side == "l" else [], rotation=(0.0, 0.0, angle), topology="assembled-solid", pivot_mode="base"))
        add(component(f"tabby-inner-ear-{side}", f"Tabby cat {side} inner ear", "micro", "detail", "cone", f"tabby-ear-{side}", (0.78 + sx * 0.42, 3.43, 0.45), (0.28, 0.56, 0.06), "tabby-inner-ear", "ear-region", 0.92, topology="surface-relief"))
    for side, sx in (("l", -1.0), ("r", 1.0)):
        ex = 0.78 + sx * 0.27
        add(component(f"tabby-eye-{side}", f"Tabby cat {side} eyeball", "meso", "detail", "sphere", "tabby-head", (ex, 2.88, 0.84), (0.27, 0.29, 0.17), "iris-green", "tabby-face", 0.99))
        add(component(f"tabby-iris-{side}", f"Tabby cat {side} iris ring", "micro", "detail", "sphere", f"tabby-eye-{side}", (ex, 2.88, 0.955), (0.22, 0.24, 0.04), "iris-green", "tabby-face", 0.98))
        add(component(f"tabby-pupil-{side}", f"Tabby cat {side} round pupil", "micro", "detail", "sphere", f"tabby-iris-{side}", (ex, 2.88, 0.985), (0.145, 0.16, 0.024), "pupil", "tabby-face", 0.99))
        add(component(f"tabby-cornea-{side}", f"Tabby cat {side} convex cornea", "micro", "detail", "sphere", f"tabby-eye-{side}", (ex, 2.88, 1.0), (0.245, 0.26, 0.052), "cornea", "tabby-face", 0.97))
    for side, sx in (("l", -1.0), ("r", 1.0)):
        add(component(f"tabby-muzzle-{side}", f"Tabby cat {side} white muzzle pad", "meso", "body", "ellipsoid", "tabby-head", (0.78 + sx * 0.19, 2.53, 0.82), (0.29, 0.23, 0.21), "white-fur", "tabby-face", 0.96))
        add(component(f"tabby-whiskers-{side}", f"Tabby cat {side} whisker fan", "micro", "detail", "instanced-cluster", f"tabby-muzzle-{side}", (0.78 + sx * 0.31, 2.55, 0.95), (0.78, 0.38, 0.05), "whisker", "tabby-face", 0.96, ["tabby-whisker-fan"], topology="fiber-strand", pivot_mode="root"))
    add(component("tabby-nose", "Tabby cat triangular nose", "micro", "detail", "cone", "tabby-head", (0.78, 2.61, 1.0), (0.18, 0.15, 0.1), "tabby-nose", "tabby-face", 0.96, topology="assembled-solid"))
    add(component("tabby-chin", "Tabby cat white chin", "micro", "detail", "ellipsoid", "tabby-head", (0.78, 2.4, 0.79), (0.3, 0.16, 0.17), "white-fur", "tabby-face", 0.9))
    for side, sx in (("l", -1.0), ("r", 1.0)):
        lx = 0.7 + sx * 0.3
        add(component(f"tabby-front-leg-{side}", f"Tabby cat {side} front leg", "meso", "limb", "capsule", "tabby-torso", (lx, 0.72, 0.34), (0.31, 1.0, 0.33), "tabby-fur", "tabby-body", 0.95, ["tabby-leg-stripes"] if side == "l" else [], pivot_mode="root"))
        add(component(f"tabby-front-paw-{side}", f"Tabby cat {side} white front paw", "meso", "limb", "ellipsoid", f"tabby-front-leg-{side}", (lx, 0.17, 0.54), (0.4, 0.25, 0.52), "white-fur", "tabby-paws", 0.97, ["tabby-white-paws", "tabby-paw-toe-grooves"] if side == "l" else [], pivot_mode="root"))
        add(component(f"tabby-hind-leg-{side}", f"Tabby cat {side} hind leg", "meso", "limb", "capsule", "tabby-rump", (0.76 + sx * 0.43, 0.74, -0.1), (0.38, 0.86, 0.42), "tabby-fur", "tabby-body", 0.55, pivot_mode="root"))
        add(component(f"tabby-hind-paw-{side}", f"Tabby cat {side} white hind paw", "meso", "limb", "ellipsoid", f"tabby-hind-leg-{side}", (0.76 + sx * 0.43, 0.18, 0.16), (0.42, 0.24, 0.52), "white-fur", "tabby-paws", 0.62, pivot_mode="root"))
    add(component("tabby-tail", "Tabby cat inferred resting tail pivot", "meso", "tail", "curve-sweep", "tabby-rump", (1.2, 0.7, -0.48), (0.27, 1.7, 0.27), "tabby-fur", "hidden-posterior", 0.3, ["inferred-striped-tail"], topology="continuous-sculpt", pivot_mode="root"))
    add(component("tabby-forehead-stripes", "Tabby forehead M stripe relief", "micro", "detail", "plane-card", "tabby-head", (0.78, 3.14, 0.95), (0.48, 0.42, 0.03), "tabby-stripe", "tabby-face", 0.96, ["tabby-forehead-m"], topology="surface-relief"))
    add(component("tabby-cheek-stripes-l", "Tabby left cheek stripe set", "micro", "detail", "instanced-cluster", "tabby-head", (0.38, 2.59, 0.89), (0.36, 0.27, 0.04), "tabby-stripe", "tabby-face", 0.91, ["tabby-cheek-stripes"], topology="surface-relief"))
    add(component("tabby-cheek-stripes-r", "Tabby right cheek stripe set", "micro", "detail", "instanced-cluster", "tabby-head", (1.18, 2.59, 0.89), (0.36, 0.27, 0.04), "tabby-stripe", "tabby-face", 0.91, topology="surface-relief"))
    add(component("tabby-torso-stripe-system", "Tabby torso curved stripe system", "micro", "detail", "instanced-cluster", "tabby-torso", (0.68, 1.42, 0.73), (0.92, 0.9, 0.05), "tabby-stripe", "tabby-body", 0.9, ["tabby-torso-stripes"], topology="surface-relief"))
    add(component("tabby-leg-stripe-system-l", "Tabby left leg stripe rings", "micro", "detail", "instanced-cluster", "tabby-front-leg-l", (0.4, 0.8, 0.64), (0.34, 0.62, 0.05), "tabby-stripe", "tabby-body", 0.95, ["tabby-leg-stripes"], topology="surface-relief"))
    add(component("tabby-leg-stripe-system-r", "Tabby right leg stripe rings", "micro", "detail", "instanced-cluster", "tabby-front-leg-r", (1.0, 0.8, 0.64), (0.34, 0.62, 0.05), "tabby-stripe", "tabby-body", 0.95, topology="surface-relief"))
    return c


def main() -> None:
    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    spec["referenceCamera"] = {
        "solved": True,
        "fovDegrees": 34.0,
        "aspect": 1402 / 1122,
        "orientation": {"yaw": -0.03, "pitch": -0.015, "roll": 0.0},
        "positionHint": [0.0, 2.05, 8.2],
        "target": [0.0, 1.8, 0.1],
        "confidence": 0.72,
        "note": "Manual single-view camera estimate for silhouette review; no hidden-side geometry is implied.",
    }
    spec["suitability"] = "conditional"
    unresolved = spec["preSpecAssessment"].get("unknownsToResolveBeforeImplementation", [])
    spec["preSpecAssessment"]["resolvedUnknowns"] = [
        {"statement": statement, "resolution": "Implemented as a labelled low-confidence approximation in inferredRegions."}
        for statement in unresolved
    ]
    spec["preSpecAssessment"]["unknownsToResolveBeforeImplementation"] = []
    spec["scores"] = {
        "object_isolation": 2,
        "silhouette_readability": 3,
        "depth_inference": 1,
        "primitive_decomposition": 3,
        "material_procedurality": 3,
        "occlusion_risk": 3,
        "interaction_fit": 3,
    }
    spec["qualityTargets"]["targetFidelity"] = 0.76
    spec["qualityTargets"]["mustMatch"] = [
        "paired quadruped silhouette and asymmetric body-unit proportions",
        "oversized yellow-green eyes with large round pupils",
        "near-black short coat versus warm tabby coat with cream bib and paws",
        "feline muzzle, triangular ears, foreleg stance, and broad whisker fans",
        "head, ear, and tail pivots plus deterministic looping idle",
    ]
    spec["qualityTargets"]["reviewViewpoints"] = ["reference-match", "front", "left-orbit", "right-orbit", "eye-close-up"]
    spec["coordinateFrame"] = {
        "front": "+Z faces the reference camera",
        "up": "+Y",
        "right": "+X",
        "scaleReference": "one black-cat cranial length equals 1.0 body unit",
        "supportPlaneY": 0.0,
    }
    spec["silhouette"] = {
        "boundingShape": "two adjacent tapered feline body columns with triangular ear peaks and four visible front paws",
        "aspectRatios": ["paired width:height approximately 0.94", "black head width:height approximately 0.96", "tabby head width:height approximately 1.03"],
        "symmetry": "bilateral per cat with asymmetric paired placement",
        "dominantCurves": ["rounded cranial vaults", "tapered chests", "convex shoulder-to-rump arcs", "curved whisker fans"],
        "negativeSpaces": ["narrow wedge between heads", "small gap between black forepaws", "larger gap between tabby forepaws"],
        "landmarks": ["black ear apex y=3.97", "tabby ear apex y=3.86", "black eye line y=2.99", "tabby eye line y=2.88", "paw contact y=0.04"],
    }
    spec["viewEvidence"] = [
        {"id": "full-object", "view": "front-three-quarter", "imageRegion": {"x": 0.17, "y": 0.1, "width": 0.65, "height": 0.75, "units": "normalized"}, "observations": ["paired silhouette and pose"], "confidence": 0.94},
        {"id": "black-face", "view": "front-three-quarter", "imageRegion": {"x": 0.25, "y": 0.2, "width": 0.25, "height": 0.26, "units": "normalized"}, "observations": ["oversized eyes, dark muzzle, triangular ears, whiskers"], "confidence": 0.97},
        {"id": "tabby-face", "view": "front-three-quarter", "imageRegion": {"x": 0.5, "y": 0.18, "width": 0.3, "height": 0.3, "units": "normalized"}, "observations": ["green eyes, round pupils, stripe placement, white muzzle"], "confidence": 0.98},
        {"id": "black-body", "view": "front-three-quarter", "imageRegion": {"x": 0.22, "y": 0.42, "width": 0.27, "height": 0.38, "units": "normalized"}, "observations": ["upright narrow chest, parallel forelegs, black paws"], "confidence": 0.91},
        {"id": "tabby-body", "view": "front-three-quarter", "imageRegion": {"x": 0.45, "y": 0.4, "width": 0.32, "height": 0.38, "units": "normalized"}, "observations": ["broad chest, stripes, white bib, short forelegs"], "confidence": 0.94},
        {"id": "black-paws", "view": "front-three-quarter", "imageRegion": {"x": 0.28, "y": 0.72, "width": 0.18, "height": 0.11, "units": "normalized"}, "observations": ["black rounded paws and toe grooves"], "confidence": 0.92},
        {"id": "tabby-paws", "view": "front-three-quarter", "imageRegion": {"x": 0.48, "y": 0.66, "width": 0.22, "height": 0.14, "units": "normalized"}, "observations": ["cream-white paws and rounded toes"], "confidence": 0.97},
        {"id": "ear-region", "view": "front-three-quarter", "imageRegion": {"x": 0.24, "y": 0.09, "width": 0.58, "height": 0.23, "units": "normalized"}, "observations": ["four triangular ears and layered inner-ear fur"], "confidence": 0.93},
        {"id": "hidden-posterior", "view": "unobserved", "imageRegion": {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0, "units": "normalized"}, "observations": ["posterior bodies and tails inferred from conservative feline anatomy"], "confidence": 0.3},
    ]
    spec["componentTree"] = build_components()
    spec["materials"] = [
        material("hidden", "#000000", 1.0, 0.0, utility=True),
        material("black-fur", "#11100f", 0.78, 0.18, [{"id": "black-coat-warm-rim", "region": "silhouette-facing normals", "baseColor": "#2a211b", "roughness": 0.7}]),
        material("tabby-fur", "#8b603b", 0.76, 0.2, [{"id": "tabby-warm-flank", "region": "visible shoulders and flank", "baseColor": "#a8794a", "roughness": 0.72}]),
        material("white-fur", "#e8d7bd", 0.82, 0.16, [{"id": "cream-shadow", "region": "bib and paw cavities", "baseColor": "#c9b397", "roughness": 0.86}]),
        material("black-inner-ear", "#4a2c25", 0.72, 0.08),
        material("tabby-inner-ear", "#b97962", 0.68, 0.08),
        material("iris-green", "#a9b84f", 0.26, 0.03, [{"id": "olive-limbal-ring", "region": "iris perimeter", "baseColor": "#59612e", "roughness": 0.3}]),
        material("pupil", "#030504", 0.18, 0.0),
        material("cornea", "#d8f1e5", 0.06, 0.0, [{"id": "corneal-highlight", "region": "upper camera-facing quadrant", "baseColor": "#ffffff", "roughness": 0.03}]),
        material("black-nose", "#29201d", 0.32, 0.04, [{"id": "black-nose-gloss", "region": "nose center", "baseColor": "#352825", "roughness": 0.18}]),
        material("tabby-nose", "#9b5f4c", 0.3, 0.04, [{"id": "tabby-nose-gloss", "region": "nose center", "baseColor": "#b6755e", "roughness": 0.16}]),
        material("whisker", "#e7dfcf", 0.46, 0.0, utility=True),
        material("tabby-stripe", "#2a211b", 0.8, 0.12, [{"id": "stripe-soft-edge", "region": "stripe boundaries", "baseColor": "#3a2a21", "roughness": 0.82}]),
    ]
    spec["repetitionSystems"] = [
        {"id": "paired-eye-system", "componentRefs": ["black-eye-l", "black-eye-r", "tabby-eye-l", "tabby-eye-r"], "distribution": "bilateral per head with observed non-identical spacing", "count": 4, "buildsGeometry": True, "realization": "named meshes"},
        {"id": "whisker-fan-system", "componentRefs": ["black-whiskers-l", "black-whiskers-r", "tabby-whiskers-l", "tabby-whiskers-r"], "distribution": "six curved strands per muzzle side with deterministic angular spread", "count": 24, "buildsGeometry": True, "realization": "curve tubes"},
        {"id": "paw-toe-system", "componentRefs": ["black-front-paw-l", "black-front-paw-r", "tabby-front-paw-l", "tabby-front-paw-r"], "distribution": "three shallow grooves and three rounded toe lobes per visible forepaw", "count": 12, "buildsGeometry": True, "realization": "small named toe meshes"},
        {"id": "tabby-stripe-system", "componentRefs": ["tabby-forehead-stripes", "tabby-cheek-stripes-l", "tabby-cheek-stripes-r", "tabby-torso-stripe-system", "tabby-leg-stripe-system-l", "tabby-leg-stripe-system-r"], "distribution": "reference-placed curved bands with bilateral variation", "count": 23, "buildsGeometry": True, "realization": "conforming relief curves"},
        {"id": "inner-ear-ridge-system", "componentRefs": ["black-inner-ear-l", "black-inner-ear-r", "tabby-inner-ear-l", "tabby-inner-ear-r"], "distribution": "five nested pale curves per ear", "count": 20, "buildsGeometry": True, "realization": "fine curve tubes"},
    ]
    spec["featureReviewTargets"] = [
        {"id": "paired-quadruped-silhouette", "name": "Paired quadruped silhouette and asymmetric body-unit proportions", "tier": "critical", "passIds": ["blockout", "structural-pass", "form-refinement"], "minimumScore": 0.8, "mustPass": True, "componentRefs": ["black-cat", "tabby-cat", "black-torso", "tabby-torso"], "evidenceRefs": ["full-object"]},
        {"id": "oversized-eye-system", "name": "Oversized green eyes with large round pupils", "tier": "critical", "passIds": ["structural-pass", "form-refinement", "material-pass", "lighting-pass"], "minimumScore": 0.84, "mustPass": True, "componentRefs": ["black-eye-l", "black-eye-r", "tabby-eye-l", "tabby-eye-r"], "evidenceRefs": ["black-face", "tabby-face"]},
        {"id": "feline-face-structure", "name": "Feline head, muzzle, triangular ears, and whisker fans", "tier": "critical", "passIds": ["structural-pass", "form-refinement"], "minimumScore": 0.8, "mustPass": True, "componentRefs": ["black-head", "tabby-head", "black-ear-l", "tabby-ear-l", "black-whiskers-l", "tabby-whiskers-l"], "evidenceRefs": ["black-face", "tabby-face", "ear-region"]},
        {"id": "coat-identity", "name": "Black coat versus tabby stripes, white bib, and white paws", "tier": "critical", "passIds": ["material-pass", "lighting-pass"], "minimumScore": 0.8, "mustPass": True, "componentRefs": ["black-torso", "tabby-torso", "tabby-bib", "tabby-front-paw-l", "tabby-torso-stripe-system"], "evidenceRefs": ["black-body", "tabby-body", "tabby-paws"]},
        {"id": "quadruped-runtime", "name": "Named head, ear, and tail pivots with looping idle", "tier": "critical", "passIds": ["interaction-pass", "optimization-pass"], "minimumScore": 0.8, "mustPass": True, "componentRefs": ["black-head", "tabby-head", "black-ear-l", "black-ear-r", "tabby-ear-l", "tabby-ear-r", "black-tail", "tabby-tail"], "evidenceRefs": ["full-object", "hidden-posterior"]},
        {"id": "neutral-light-readability", "name": "Fur, eye, and nose response under neutral lighting", "tier": "important", "passIds": ["lighting-pass"], "minimumScore": 0.7, "mustPass": False, "componentRefs": ["black-torso", "tabby-torso", "black-cornea-l", "tabby-cornea-l"], "evidenceRefs": ["full-object"]},
    ]
    all_ids = [item["id"] for item in spec["componentTree"]]
    macro_ids = [item["id"] for item in spec["componentTree"] if item["level"] == "macro"]
    structure_ids = [item["id"] for item in spec["componentTree"] if item["level"] in {"macro", "meso"}]
    passes = [
        {"id": "blockout", "goal": "Match paired outer silhouette and quadruped body-unit proportions without identity materials.", "componentRefs": macro_ids, "acceptance": ["Black cat reads taller and narrower than the shorter broader tabby.", "Four front paws contact y=0 and the paired negative spaces match the reference.", "AI vision comparison and critical feature scores pass threshold."]},
        {"id": "structural-pass", "goal": "Build named feline anatomy, facial volumes, limbs, attachments, and pivots.", "componentRefs": structure_ids, "acceptance": ["No humanoid anatomy is present.", "Heads, ears, legs, paws, and tails are separate named parts with complete attachment contracts.", "Eye placement and feline muzzle structure match the reference."]},
        {"id": "form-refinement", "goal": "Add eyes, round pupils, whiskers, toe masses, inner ears, white bib, and stripe relief.", "componentRefs": all_ids, "acceptance": ["Oversized eye diameter and round pupil ratios match both faces.", "Whiskers, toe grooves, ear interiors, and tabby stripe systems are visible and attached.", "Two orbit views retain non-degenerate volumetric silhouettes."]},
        {"id": "material-pass", "goal": "Match black, tabby, cream, iris, nose, and corneal material response with independent PBR channels.", "componentRefs": all_ids, "acceptance": ["Near-black coat retains warm edge response without becoming gray.", "Tabby brown, dark stripes, cream bib/paws, green irises, and dark round pupils match visible regions.", "Independent procedural albedo, roughness, normal, and AO channels remain unaliased."]},
        {"id": "lighting-pass", "goal": "Reproduce warm upper-right key, soft fill, contact shadows, and readable eye highlights.", "componentRefs": all_ids, "acceptance": ["ACES tone mapping and exposure preserve black-fur detail and cream-fur highlights.", "Eye corneas show compact highlights without obscuring green irises or pupils.", "Ground contact shadows anchor every visible paw."]},
        {"id": "interaction-pass", "goal": "Expose picking/explode parts and deterministic looping idle animation.", "componentRefs": all_ids, "acceptance": ["root.userData.sculptRuntime exposes named parts, meshes, sockets, colliders, and pivots.", "root.userData.tick drives breathing, blinking, and gentle tail motion without transform drift.", "Explode scales part layout about model center and picking uses the same part definition."]},
        {"id": "optimization-pass", "goal": "Meet real-time budgets without deleting identity-defining eyes, whiskers, stripes, or pivots.", "componentRefs": all_ids, "acceptance": ["Build and typecheck pass.", "Runtime verification confirms both cats, pivots, tick, picking, and explode metadata.", "Final reference and two orbit captures are non-degenerate and visually accepted."]},
    ]
    spec["buildPasses"] = passes
    spec["sculptPipeline"] = {"passOrder": [item["id"] for item in passes], "currentPass": "blockout", "completedPasses": [], "blockedReason": None, "passGateMode": "locked-sequential"}
    spec["selfCorrectLoop"]["reviewAfterPasses"] = [item["id"] for item in passes]
    spec["selfCorrectLoop"]["screenshotPolicy"]["requiredForPasses"] = [item["id"] for item in passes if item["id"] != "optimization-pass"]
    spec["lookDevTargets"]["qualityPriority"] = "procedural-stylized"
    spec["lookDevTargets"]["materialPass"]["referencePbrExtraction"]["requiredWhenSourceImagePresent"] = False
    spec["lightingFromPhoto"] = [
        "Warm 4200K directional key from upper camera-right at intensity 3.2; preserve visible fur-normal gradients.",
        "Soft neutral hemisphere and frontal fill at combined intensity 1.5; exposure 1.08 with ACES filmic tone mapping.",
        "Warm rim and large-area contact shadow lighting; ambient occlusion at paw/support contacts and under chins.",
    ]
    spec["proceduralStrategy"] = [
        "Author each cat from a distinct quadruped body-unit parameter set; never mirror one whole cat into the other.",
        "Use ellipsoids and capsules for continuous soft-tissue masses, separate cone ear shells, and curve sweeps for inferred tails.",
        "Build oversized eyes from iris, pupil, wetline, and transparent convex cornea layers; pupils remain round.",
        "Create tabby markings as deterministic conforming relief curves and white regions as separate shell geometry.",
        "Create whiskers and inner-ear ridges from deterministic curve tubes rather than downloaded assets.",
        "Expose stable named pivots and a non-accumulating idle tick for breathing, blinks, ear micro-motion, and tail sway.",
    ]
    spec["assumptions"] = [
        "Rear body volume, dorsal contours, far hind legs, and undersides use conservative domestic-cat anatomy and are not claimed as observed.",
        "Both tail paths, lengths, and hidden stripe continuation are inferred at confidence 0.3.",
        "Short fur is stylized with PBR response and sparse silhouette fibers, not strand-level photoreal grooming.",
    ]
    spec["inferredRegions"] = [
        {"id": "black-posterior", "regions": ["back", "rump rear", "underside", "far hind leg"], "confidence": 0.45, "basis": "conservative seated domestic-cat anatomy"},
        {"id": "black-tail", "regions": ["complete tail path", "tail tip"], "confidence": 0.3, "basis": "small dark curled mass near the visible left rump"},
        {"id": "tabby-posterior", "regions": ["back", "rump rear", "underside", "far hind leg"], "confidence": 0.45, "basis": "conservative standing-crouch domestic-cat anatomy"},
        {"id": "tabby-tail", "regions": ["complete tail path", "tail stripe continuation"], "confidence": 0.3, "basis": "tail is not visible in the source image"},
    ]
    spec["runtimeContract"] = {
        "factory": "createTwoCatsModel",
        "tickSignature": "(elapsedSeconds: number, deltaSeconds?: number) => void",
        "requiredPivots": ["black-head", "black-ear-l", "black-ear-r", "black-tail", "tabby-head", "tabby-ear-l", "tabby-ear-r", "tabby-tail"],
        "idleChannels": ["breathing", "blink", "tail-sway", "ear-micro-motion"],
        "deterministicSeed": 5602,
        "loopDurationSeconds": 8.0,
    }
    spec["performanceBudget"] = {"fpsTarget": 60, "triangleTarget": 85000, "drawCallTarget": 120, "textureMemoryMB": 32, "notes": "Hero browser prop with two animated stylized cats."}
    spec["reviewHistory"] = []
    spec["visualEvidence"] = []
    SPEC_PATH.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
