#!/usr/bin/env python3
"""Author the quadruped two-cat ObjectSculptSpec from the generated starter.

Replaces the humanoid template (auto-applied because primaryDomain=character) with a
feline quadruped body plan: two seated cats (black smooth coat, brown tabby with white
blaze/socks) sharing a root. Units are feline head-units (1 HU = black-cat head height);
seat plane is y=0, +Z faces the reference camera.
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC_PATH = HERE / "object-sculpt-spec.json"

spec = json.loads(SPEC_PATH.read_text())

# ----------------------------------------------------------------------------- helpers

def rgba(hex_color: str, alpha: str = "1") -> str:
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"rgba({r}, {g}, {b}, {alpha})"


def recipe(dominant: str, secondary: str, confidence: float, klass: str = "skin") -> dict:
    return {
        "dominantAlbedo": rgba(dominant),
        "secondaryAlbedo": rgba(secondary),
        "materialClass": klass,
        "materialClassConfidence": confidence,
        "finishStyle": "satin short fur / glossy eye and nose leather, per reference",
    }


def socket(sid: str, pos: list[float]) -> dict:
    return {"id": sid, "localPosition": pos, "accepts": "embedded child part root"}


def attach(parent_socket: str, start: list[float], end: list[float], contact: str,
           embed: float, gap: float, evidence: list[str]) -> dict:
    return {
        "parentSocket": parent_socket,
        "localStart": start,
        "localEnd": end,
        "contactType": contact,
        "embedDepth": embed,
        "overlap": embed,
        "gapTolerance": gap,
        "evidenceRefs": evidence,
    }


def _action(anim_role: str, pivot_mode: str = "center",
            pivot_pos: list[float] | None = None, pivot_axis: list[float] | None = None,
            sockets_: list[dict] | None = None, debris: str = "fur-black") -> dict:
    return {
        "animationRole": anim_role,
        "pivot": {
            "mode": pivot_mode,
            "localPosition": pivot_pos or [0, 0, 0],
            "axis": pivot_axis or [0, 1, 0],
            "confidence": 0.8,
        },
        "transformChannels": {
            "translate": True, "rotate": True, "scale": True,
            "bend": anim_role in {"tail", "appendage"}, "twist": False,
            "detach": False, "visibility": True, "materialState": False,
        },
        "sockets": sockets_ or [],
        "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1],
                     "isTrigger": False, "notes": "capsule proxy for organic part"},
        "constraints": [],
        "destruction": {"breakable": False, "fractureGroup": "none", "seamRefs": [],
                        "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": debris},
    }


def comp(cid: str, name: str, level: str, role: str, primitive: str, topo: str, rationale: str,
         parent: str | None, pos: list[float], scale: list[float], material: str,
         rot: list[float] | None = None, importance: float = 0.7, confidence: float = 0.85,
         recipe_: dict | None = None, attachment_: dict | None = None,
         action: dict | None = None, features: list[dict] | None = None,
         descriptor: dict | None = None, evidence: list[str] | None = None,
         anim_role: str = "static", debris: str | None = None) -> dict:
    return {
        "id": cid, "name": name, "level": level, "role": role,
        "importance": importance, "confidence": confidence, "primitive": primitive,
        "topologyClass": topo, "topologyRationale": rationale,
        "geometryDescriptor": descriptor or {
            "topologyIntent": "stylized organic feline part",
            "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1},
            "deformationStack": [], "uvStrategy": "generated procedural coordinates",
            "normalStrategy": "smooth vertex normals",
        },
        "parent": parent, "attachment": attachment_,
        "dimensions": {"width": scale[0], "height": scale[1], "depth": scale[2],
                       "units": "feline-head-units", "confidence": confidence},
        "transform": {"position": pos, "rotation": rot or [0, 0, 0], "scale": scale},
        "actionProfile": action or _action(anim_role, debris=debris or material),
        "material": material, "materialLayers": [material],
        "deformations": [], "joints": [], "seams": [],
        "localFeatures": features or [],
        "colorMaterialRecipe": recipe_ or recipe("#888888", "#666666", 0.5, "unknown"),
        "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0,
                          "normalPattern": "", "displacementPattern": "", "occlusionPattern": "",
                          "edgeWearPattern": "", "notes": ""},
        "evidenceRefs": evidence or ["full-object"],
        "details": [], "fidelityTier": "blockout",
    }


def feat(fid: str, description: str) -> dict:
    return {"id": fid, "description": description}


# ----------------------------------------------------------------------------- geometry descriptors

LATHE_TORSO = {
    "topologyIntent": "seated feline torso revolved around the spine axis, then Z-scaled 1.08 for chest depth",
    "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1},
    "deformationStack": ["scale-z-1.08"],
    "uvStrategy": "lathe revolve coordinates (u angular, v spine)",
    "normalStrategy": "smooth vertex normals",
    "latheProfile": {
        "points": [[0.02, 0.0], [0.40, 0.02], [0.45, 0.25], [0.42, 0.55], [0.35, 0.85],
                   [0.30, 1.05], [0.25, 1.25], [0.17, 1.40], [0.02, 1.46]],
        "segments": 48,
    },
}


def ear_profile(width: float, height: float, depth: float) -> dict:
    w, h = width / 2.0, height
    return {
        "topologyIntent": "thin upright triangular ear shell with rounded tip, slight forward cup",
        "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1},
        "deformationStack": ["bend-back-8deg", "cup-forward"],
        "uvStrategy": "extrude profile coordinates",
        "normalStrategy": "smooth vertex normals",
        "profile2D": {
            "points": [[-w, 0.0], [-w * 0.9, h * 0.35], [-w * 0.55, h * 0.75], [0.0, h],
                       [w * 0.55, h * 0.75], [w * 0.9, h * 0.35], [w, 0.0], [0.0, -h * 0.08]],
            "depth": depth,
        },
    }


TAIL_SPINE_BC = [[0.10, 0.30, -0.38], [-0.20, 0.15, -0.40], [-0.42, 0.09, -0.22],
                 [-0.50, 0.07, 0.05], [-0.44, 0.065, 0.30], [-0.24, 0.06, 0.44], [-0.05, 0.06, 0.42]]
TAIL_SPINE_TC = [[-0.10, 0.30, -0.38], [0.20, 0.15, -0.40], [0.42, 0.09, -0.22],
                 [0.50, 0.07, 0.05], [0.44, 0.065, 0.30], [0.24, 0.06, 0.44], [0.05, 0.06, 0.42]]


def tail_descriptor(spine: list[list[float]]) -> dict:
    ring = []
    import math as _m
    for i in range(8):
        a = i / 8 * 2 * _m.pi
        ring.append([round(0.055 * _m.cos(a), 4), round(0.055 * _m.sin(a), 4)])
    return {
        "topologyIntent": "long tail swept along a curl path around the flank onto the seat, tapering to the tip",
        "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1},
        "deformationStack": ["taper-to-tip-0.6"],
        "uvStrategy": "sweep coordinates (u around section, v along spine)",
        "normalStrategy": "smooth vertex normals",
        "curveSweep": {"spine": spine, "crossSection": {"points": ring}, "closed": False},
    }


MOUTH_TUBE = {
    "topologyIntent": "short shallow inverted arc for the closed mouth line under the nose",
    "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1},
    "deformationStack": [],
    "uvStrategy": "tube coordinates",
    "normalStrategy": "smooth vertex normals",
    "tubePath": {"points": [[-0.045, 0.0, 0.0], [0.0, -0.025, 0.015], [0.045, 0.0, 0.0]],
                 "radius": 0.008, "closed": False},
}

WHISKER_CLUSTER = {
    "topologyIntent": "fan of 6 thin tapered whisker strands per cheek side, slight downward curve",
    "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1},
    "deformationStack": ["fan-spread-35deg", "droop-10deg"],
    "uvStrategy": "tube coordinates",
    "normalStrategy": "smooth vertex normals",
    "baseGeometry": "tube",
    "tubePath": {"points": [[0.0, 0.0, 0.0], [0.22, 0.01, 0.10], [0.40, -0.02, 0.14]],
                 "radius": 0.004, "closed": False},
}


# ----------------------------------------------------------------------------- cat builder

def build_cat(p: str, group_id: str, *, fur: str, inner_ear: str, nose_mat: str, eye_mat: str,
              fur_dom: str, fur_sec: str, eye_dom: str, eye_sec: str, nose_dom: str, inner_dom: str,
              tabby: bool, tail_spine: list[list[float]], tail_confidence: float) -> list[dict]:
    g = group_id
    ev_self = ["full-object", "black-cat" if not tabby else "tabby-cat"]
    ev_head = ev_self + ["zone-r0c1" if not tabby else "zone-r1c2"]
    torso_sockets = [
        socket("neckSocket", [0, 1.42, 0.02]), socket("tailSocket", [0.10 if not tabby else -0.10, 0.30, -0.38]),
        socket("legSocketFL", [0.135, 0.95, 0.18]), socket("legSocketFR", [-0.135, 0.95, 0.18]),
        socket("haunchSocketL", [0.30, 0.50, -0.05]), socket("haunchSocketR", [-0.30, 0.50, -0.05]),
        socket("chestSocket", [0, 0.98, 0.28]),
    ]
    head_sockets = [
        socket("eyeSocketL", [0.205, 0.08, 0.35]), socket("eyeSocketR", [-0.205, 0.08, 0.35]),
        socket("earSocketL", [0.30, 0.30, -0.02]), socket("earSocketR", [-0.30, 0.30, -0.02]),
        socket("muzzleSocket", [0, -0.16, 0.46]), socket("noseSocket", [0, -0.08, 0.50]),
    ]
    head_action = _action("head-pivot", "custom", [0, -0.33, -0.03], [1, 0, 0], head_sockets, fur)
    parts: list[dict] = []

    parts.append(comp(
        f"{p}-torso", f"{p.upper()} torso (seated pear)", "macro", "body", "lathe", "continuous-sculpt",
        "Single smoothly-varying seated volume: wide folded haunches at the seat tapering to a narrow "
        "chest and neck; revolved profile matches the pear silhouette, not an assembled stack.",
        g, [0, 0, 0], [1.0, 1.0, 1.08], fur, importance=1.0,
        recipe_=recipe(fur_dom, fur_sec, 0.9), descriptor=LATHE_TORSO,
        action=_action("static", sockets_=torso_sockets, debris=fur),
        evidence=ev_self,
    ))
    parts.append(comp(
        f"{p}-head", f"{p.upper()} head (oversized cranium)", "macro", "body", "ellipsoid", "continuous-sculpt",
        "One continuous rounded cranium volume, wider than deep, dominating the seated proportions "
        "(~0.43 of seated height); not a faceted primitive assembly.",
        g, [0, 1.78, 0.05], [1.06, 1.0, 0.94], fur, importance=1.0,
        recipe_=recipe(fur_dom, fur_sec, 0.9),
        attachment_=attach("neckSocket", [0, 1.45, 0.02], [0, 1.78, 0.05], "embed", 0.12, 0.03, ev_self),
        action=head_action,
features=([
            feat("forehead-m-marking", "Dark tabby 'M' stripe marking between the ears (drawn in the head stripe texture)"),
            feat("cheek-stripe-fan", "Two to three dark stripes fanning back from the outer eye corners across the cheeks"),
        ] if tabby else []),
        evidence=ev_head,
    ))

    # ---- head-mounted parts (parent = head, head-local coordinates)
    parts.append(comp(
        f"{p}-muzzle", f"{p.upper()} muzzle", "meso", "detail", "ellipsoid", "continuous-sculpt",
        "Short rounded snout volume protruding from the lower face; smooth continuous bulge, "
        "whiter on the tabby where it meets the blaze.",
        f"{p}-head", [0, -0.18, 0.44], [0.42, 0.24, 0.30],
        "fur-white" if tabby else fur, importance=0.85,
        recipe_=recipe("#f0eade" if tabby else fur_dom, "#ded6c6" if tabby else fur_sec, 0.85),
        attachment_=attach("muzzleSocket", [0, -0.16, 0.46], [0, -0.18, 0.44], "embed", 0.06, 0.02, ev_head),
        features=[feat("whisker-follicle-dots", "Rows of small dark dots at the whisker roots on the muzzle pads")],
        evidence=ev_head,
    ))
    for side, sx in (("l", 0.205), ("r", -0.205)):
        parts.append(comp(
            f"{p}-eye-{side}", f"{p.upper()} eye {side.upper()} (huge green)", "meso", "detail", "ellipsoid",
            "continuous-sculpt",
            "Oversized glossy eyeball sphere protruding slightly from the face; each eye ~0.29 of head width, "
            "the single most identity-defining feature of the reference.",
            f"{p}-head", [sx, 0.08, 0.35], [0.30, 0.30, 0.27], eye_mat, importance=1.0,
            recipe_=recipe(eye_dom, eye_sec, 0.9),
            attachment_=attach(f"eyeSocket{side.upper()}", [sx, 0.08, 0.30], [sx, 0.08, 0.35], "socket", 0.03, 0.01, ev_head),
            features=[
                feat("catchlight-highlight", "Bright white specular catchlight at the upper-left of the eye dome"),
                feat("iris-radial-gradient", "Darker limbal rim to brighter yellow-green toward the pupil"),
            ],
            evidence=ev_head + ["zone-r1c1"],
        ))
        parts.append(comp(
            f"{p}-eyelid-{side}", f"{p.upper()} eyelid {side.upper()}", "meso", "detail", "ellipsoid",
            "conforming-shell",
            "Thin fur-covered cap conforming to the eyeball that rotates down over the eye for the blink "
            "cycle; parked open (rotated up behind the brow) at rest.",
            f"{p}-head", [sx, 0.08, 0.35], [0.32, 0.32, 0.30], fur, importance=0.7,
            recipe_=recipe(fur_dom, fur_sec, 0.85),
            attachment_=attach(f"eyeSocket{side.upper()}", [sx, 0.08, 0.35], [sx, 0.08, 0.35], "overlap", 0.0, 0.01, ev_head),
            action=_action("blink-pivot", "custom", [0, 0, 0], [1, 0, 0], debris=fur),
            evidence=ev_head,
        ))
        parts.append(comp(
            f"{p}-pupil-{side}", f"{p.upper()} pupil {side.upper()}", "micro", "detail", "ellipsoid",
            "assembled-solid",
            "Large perfectly round black pupil disc (~0.52 of eye diameter) sitting proud of the iris front; "
            "discrete rounded part, not a painted dot.",
            f"{p}-head", [sx, 0.08, 0.455], [0.145, 0.155, 0.05], "pupil-dark", importance=0.9,
            recipe_=recipe("#0b0b0d", "#1a1a1e", 0.9, "unknown"), evidence=ev_head + ["zone-r1c1"],
        ))
        parts.append(comp(
            f"{p}-catchlight-{side}", f"{p.upper()} catchlight {side.upper()}", "micro", "detail", "ellipsoid",
            "assembled-solid",
            "Small emissive white dome at the eye's upper-left replicating the reference catchlight; "
            "discrete part so it survives relighting instead of being painted into albedo.",
            f"{p}-head", [sx - 0.045, 0.135, 0.475], [0.05, 0.05, 0.05], "catchlight-glow", importance=0.8,
            recipe_=recipe("#ffffff", "#e8f0ff", 0.85, "unknown"), evidence=ev_head + ["zone-r1c1"],
        ))
        parts.append(comp(
            f"{p}-limbal-{side}", f"{p.upper()} limbal ring {side.upper()}", "micro", "detail", "torus",
            "assembled-solid",
            "Thin dark-green ring at the iris edge sharpening the huge-eye read; a genuine slim torus part.",
            f"{p}-head", [sx, 0.08, 0.44], [0.33, 0.33, 0.33], "pupil-dark", importance=0.6,
            recipe_=recipe("#22301a", "#101807", 0.8, "unknown"), evidence=ev_head,
        ))
        ear_sx = 0.30 if sx > 0 else -0.30
        parts.append(comp(
            f"{p}-ear-{side}", f"{p.upper()} ear {side.upper()} (tall triangular)", "meso", "appendage", "extrude",
            "conforming-shell",
            "Thin upright triangular ear shell with rounded tip and slight forward cup; a curved skin shell, "
            "not a solid cone — inner cone is a separate inset part.",
            f"{p}-head", [ear_sx, 0.36, -0.03], [1, 1, 1], fur, rot=[-0.10, 0, -0.28 if sx > 0 else 0.28],
            importance=0.95,
            recipe_=recipe(fur_dom, fur_sec, 0.85),
            descriptor=ear_profile(0.30, 0.42, 0.06),
            attachment_=attach(f"earSocket{side.upper()}", [ear_sx, 0.20, -0.02], [ear_sx, 0.42, -0.03], "embed", 0.06, 0.02, ev_head),
            action=_action("ear-pivot", "custom", [0, 0, 0], [0, 0, 1], debris=fur),
            features=[feat("ear-tip-tuft", "Short dark tuft of longer hairs breaking the silhouette at the ear tip")],
            evidence=ev_head + ["zone-r0c0", "zone-r0c1"],
        ))
        parts.append(comp(
            f"{p}-inner-ear-{side}", f"{p.upper()} inner ear {side.upper()}", "micro", "detail", "extrude",
            "conforming-shell",
            "Inset thin shell of exposed ear skin inside the outer ear cup; fine fur striations along its length.",
            f"{p}-head", [ear_sx, 0.37, 0.02], [1, 1, 1], inner_ear, rot=[-0.10, 0, -0.28 if sx > 0 else 0.28],
            importance=0.75,
            recipe_=recipe(inner_dom, "#e8b9a0" if tabby else "#2e201c", 0.8),
            descriptor=ear_profile(0.18, 0.30, 0.02),
            attachment_=attach(f"earSocket{side.upper()}", [ear_sx, 0.22, 0.0], [ear_sx, 0.40, 0.02], "overlap", 0.01, 0.01, ev_head),
            features=[feat("inner-ear-fur-striations", "Fine parallel fur striations lining the inner ear cone")],
            evidence=ev_head + ["zone-r0c1", "zone-r0c2"],
        ))
    parts.append(comp(
        f"{p}-nose", f"{p.upper()} nose leather", "micro", "detail", "ellipsoid", "assembled-solid",
        "Small rounded-triangle nose leather pad at the muzzle tip; discrete satiny part with its own gloss.",
        f"{p}-head", [0, -0.08, 0.50], [0.085, 0.05, 0.05], nose_mat, importance=0.8,
        recipe_=recipe(nose_dom, "#8a4f45" if tabby else "#141010", 0.85),
        evidence=ev_head + ["zone-r1c1"],
    ))
    parts.append(comp(
        f"{p}-mouth", f"{p.upper()} mouth line", "micro", "detail", "tube", "fiber-strand",
        "Short shallow curved line closing the muzzle under the nose; a thin elongated form following a path.",
        f"{p}-head", [0, -0.155, 0.53], [1, 1, 1], nose_mat, importance=0.5,
        recipe_=recipe(nose_dom, "#8a4f45" if tabby else "#141010", 0.7),
        descriptor=MOUTH_TUBE,
        attachment_=attach("muzzleSocket", [-0.045, -0.155, 0.53], [0.045, -0.155, 0.53], "overlap", 0.01, 0.01, ev_head),
        evidence=ev_head,
    ))
    parts.append(comp(
        f"{p}-whiskers", f"{p.upper()} whisker fan", "micro", "appendage", "instanced-cluster", "fiber-strand",
        "Twelve long thin white whiskers fanning from the muzzle pads (six per side) with a slight downward "
        "curve; repeated strand forms, never flat cards.",
        f"{p}-head", [0, -0.14, 0.45], [1, 1, 1], "whisker-white", importance=0.7,
        recipe_=recipe("#f2efe8", "#d8d4c8", 0.8),
        descriptor=WHISKER_CLUSTER,
        attachment_=attach("muzzleSocket", [0.10, -0.16, 0.48], [0.45, -0.10, 0.55], "embed", 0.02, 0.02, ev_head),
        evidence=ev_head + ["zone-r1c1"],
    ))

    # ---- body-mounted parts (parent = cat group)
    for side, sx in (("fl", 0.135), ("fr", -0.135)):
        parts.append(comp(
            f"{p}-leg-{side}", f"{p.upper()} front leg {side.upper()}", "meso", "leg", "capsule", "continuous-sculpt",
            "Slim straight front leg descending from the chest to the seat; smooth tapered limb volume.",
            g, [sx, 0.50, 0.22], [0.20, 0.62, 0.20], fur, importance=0.9,
            recipe_=recipe(fur_dom, fur_sec, 0.85),
            attachment_=attach(f"legSocketF{'L' if sx > 0 else 'R'}", [sx, 0.95, 0.18], [sx, 0.10, 0.24], "embed", 0.08, 0.02, ev_self),
            features=[feat("leg-ring-stripes", "Horizontal dark tabby rings wrapping the leg above the white sock")] if tabby else [],
            evidence=ev_self + ["zone-r2c1"],
        ))
        parts.append(comp(
            f"{p}-paw-{side}", f"{p.upper()} front paw {side.upper()}", "micro", "detail", "ellipsoid",
            "continuous-sculpt",
            "Small rounded front paw resting flat on the seat with shallow toe separation grooves.",
            g, [sx, 0.065, 0.30], [0.19, 0.11, 0.26],
            "fur-white" if tabby else fur, importance=0.8,
            recipe_=recipe("#f0eade" if tabby else fur_dom, "#ded6c6" if tabby else fur_sec, 0.85),
            features=[feat("toe-separation-grooves", "Shallow vertical grooves separating the toes on the paw top")],
            evidence=ev_self + ["zone-r2c1"],
        ))
    for side, sx in (("l", 0.33), ("r", -0.33)):
        parts.append(comp(
            f"{p}-haunch-{side}", f"{p.upper()} folded haunch {side.upper()}", "meso", "leg", "ellipsoid",
            "continuous-sculpt",
            "Folded hind leg mass flanking the torso base in the seated pose; smooth continuous volume, "
            "mostly hidden from the reference camera (inferred volume behind the front legs).",
            g, [sx, 0.30, -0.02], [0.36, 0.52, 0.55], fur, importance=0.7, confidence=0.55,
            recipe_=recipe(fur_dom, fur_sec, 0.6),
            attachment_=attach(f"haunchSocket{side.upper()}", [sx * 0.9, 0.55, -0.05], [sx, 0.08, 0.10], "embed", 0.10, 0.03, ev_self),
            evidence=ev_self,
        ))
    parts.append(comp(
        f"{p}-tail", f"{p.upper()} tail (curled)", "meso", "tail", "curve-sweep", "continuous-sculpt",
        ("Tail swept along a measured curl path from the rump around the left flank onto the seat, "
         "visible in the reference" if not tabby else
         "Tail NOT visible in the reference; inferred symmetric curl around the right flank matching the "
         "black cat's visible wrap, with tabby ring striping"),
        g, [0, 0, 0], [1, 1, 1], fur, importance=0.85, confidence=tail_confidence,
        recipe_=recipe(fur_dom, fur_sec, tail_confidence),
        descriptor=tail_descriptor(tail_spine),
        attachment_=attach("tailSocket", tail_spine[0], tail_spine[-1], "socket", 0.08, 0.03, ev_self),
        action=_action("tail", "custom", tail_spine[0], [0, 1, 0], debris=fur),
        evidence=ev_self + (["zone-r2c0"] if not tabby else []),
    ))
    if tabby:
        parts.append(comp(
            f"{p}-chest", f"{p.upper()} white chest blaze", "meso", "detail", "ellipsoid", "conforming-shell",
            "Thin fluffy white shell conforming to the torso front from chin to belly, with a soft irregular "
            "boundary against the striped fur; rides the torso surface rather than having independent volume.",
            g, [0, 0.98, 0.27], [0.40, 0.62, 0.18], "fur-white", importance=0.9,
            recipe_=recipe("#f0eade", "#ded6c6", 0.9),
            attachment_=attach("chestSocket", [0, 1.30, 0.24], [0, 0.60, 0.30], "overlap", 0.02, 0.02, ["tabby-cat"]),
            features=[feat("blaze-soft-edge", "Soft irregular boundary where the white blaze meets the striped fur")],
            evidence=["tabby-cat", "zone-r1c1"],
        ))
    return parts


# ----------------------------------------------------------------------------- component tree

tree: list[dict] = [
    comp("root", "Two stylized cats (root)", "macro", "body", "box", "assembled-solid",
         "Hidden unit-scale container for the two-cat group; never renders.",
         None, [0, 0, 0], [1, 1, 1], "hidden", importance=1.0,
         recipe_=recipe("#888888", "#666666", 0.3, "unknown"),
         action=_action("root", debris="hidden")),
    comp("blackCat", "Black cat (group)", "macro", "body", "box", "assembled-solid",
         "Hidden group node carrying the black cat's parts; unit scale, yaw only, so no scale cascade.",
         "root", [-0.62, 0, 0.02], [1, 1, 1], "hidden", rot=[0, 0.09, 0], importance=1.0,
         recipe_=recipe("#232226", "#1a191e", 0.9),
         action=_action("group", debris="hidden")),
    comp("tabbyCat", "Tabby cat (group)", "macro", "body", "box", "assembled-solid",
         "Hidden group node carrying the tabby cat's parts; unit scale, yaw only.",
         "root", [0.62, 0, -0.04], [1, 1, 1], "hidden", rot=[0, -0.20, 0], importance=1.0,
         recipe_=recipe("#8f7154", "#463426", 0.9),
         action=_action("group", debris="hidden")),
]

tree += build_cat(
    "bc", "blackCat", fur="fur-black", inner_ear="inner-ear-dark", nose_mat="nose-dark",
    eye_mat="eye-black-cat", fur_dom="#232226", fur_sec="#1a191e", eye_dom="#b7c448", eye_sec="#3a4518",
    nose_dom="#241d1a", inner_dom="#4a332c", tabby=False, tail_spine=TAIL_SPINE_BC, tail_confidence=0.8,
)
tree += build_cat(
    "tc", "tabbyCat", fur="fur-tabby", inner_ear="inner-ear-pink", nose_mat="nose-pink",
    eye_mat="eye-tabby", fur_dom="#8f7154", fur_sec="#463426", eye_dom="#a5c783", eye_sec="#3f5230",
    nose_dom="#b9746a", inner_dom="#c98d76", tabby=True, tail_spine=TAIL_SPINE_TC, tail_confidence=0.35,
)

spec["componentTree"] = tree


# ----------------------------------------------------------------------------- materials

def bands(macro_f: float, macro_a: float, meso_f: float, meso_a: float, micro_f: float, micro_a: float,
          meso_role: str) -> list[dict]:
    return [
        {"id": "macro", "frequency": macro_f, "amplitude": macro_a,
         "role": "broad albedo breakup across the coat / surface"},
        {"id": "meso", "frequency": meso_f, "amplitude": meso_a, "role": meso_role},
        {"id": "micro", "frequency": micro_f, "amplitude": micro_a,
         "role": "fine fur grain visible under grazing key light"},
    ]


def material(mid: str, name: str, base: str, secondary: list[str], rough_base: float, rough_var: float,
             *, meso_role: str, overrides: list[dict] | None = None, clearcoat: float | None = None,
             emissive: str | None = None, quality_tier: str | None = None,
             rough_map: str = "independent procedural roughness field (seeded value noise)",
             normal_strength: float = 0.25, ao_cavity: float = 0.3) -> dict:
    mat = {
        "id": mid, "name": name, "type": "physical",
        "shaderModel": "MeshPhysicalMaterial (PBR, clearcoat where noted)",
        "baseColor": base, "color": base,
        "albedo": {"dominant": base, "secondary": secondary,
                   "samplingNotes": "Sampled from gatos.png zone crops; baked lighting avoided by taking the shadow-side value."},
        "colorVariation": {"palette": [base] + secondary, "pattern": "mottled-fur", "amplitude": 0.10,
                           "heightCorrelation": 0.2},
        "textureResolution": 1024,
        "textureProjection": {"mode": "generated-uv", "repeat": [1.0, 1.0], "anisotropy": 8,
                              "texelDensityIntent": "Stable object-scale fur/stripe detail independent of component scale."},
        "surfaceFrequencyBands": bands(1.5, 0.30, 9.0, 0.18, 48.0, 0.06, meso_role),
        "roughness": {"base": rough_base, "variation": rough_var, "map": rough_map,
                      "localResponse": "lower roughness on nose/eye gloss zones, higher in fur cavities"},
        "metalness": {"base": 0.0, "variation": 0.0},
        "normal": {"pattern": "independent-fur-grain-height-field", "strength": normal_strength,
                   "scale": 24.0, "space": "tangent"},
        "bump": {"pattern": "short-directional-fur-striation", "amplitude": 0.02, "scale": 40.0},
        "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": False},
        "ambientOcclusion": {"cavityStrength": ao_cavity, "contactShadowBias": 0.35,
                             "notes": "Darken ear bases, eye sockets, leg-torso junctions, tail-seat contact."},
        "wear": {"edgeWear": 0.0, "scratches": [], "chips": []},
        "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"},
        "localOverrides": overrides or [],
        "shaderNotes": ["Fur sheen via slight clearcoat + warm rim from lighting, never via metalness."],
    }
    if clearcoat is not None:
        mat["clearcoat"] = {"base": clearcoat, "roughness": 0.25}
    if emissive is not None:
        mat["emissive"] = {"color": emissive, "intensity": 1.6}
    if quality_tier is not None:
        mat["qualityTier"] = quality_tier
    return mat


spec["materials"] = [
    material("fur-black", "Black smooth cat fur", "#232226", ["#2e2c33", "#1a191e", "#3a3740"],
             0.68, 0.12, meso_role="short dense fur clumping with subtle directional grain",
             clearcoat=0.12, normal_strength=0.28,
             overrides=[
                 {"id": "warm-rim-sheen", "roughness": 0.55, "clearcoatBoost": 0.1,
                  "note": "Warm golden rim response along back/head edges from the key light; satin, not matte."},
                 {"id": "cavity-deepen", "aoBoost": 0.15,
                  "note": "Deepen occlusion under chin, between front legs and around curled tail."},
             ]),
    material("fur-tabby", "Brown tabby fur with stripes", "#8f7154", ["#6b5238", "#463426", "#a98a68"],
             0.72, 0.10, meso_role="tabby stripe field: dark mackerel bars on tan base, curved on flanks, rings on legs/tail",
             normal_strength=0.25,
             overrides=[
                 {"id": "stripe-field", "albedoSecondary": "#463426",
                  "note": "Procedural seeded stripe texture: forehead M, cheek fans, flank swirls, leg/tail rings."},
                 {"id": "belly-lighten", "albedoBoost": "#a98a68",
                  "note": "Value lifts toward the belly and lower muzzle, per reference."},
             ]),
    material("fur-white", "White blaze and sock fur", "#f0eade", ["#ded6c6", "#faf6ee"],
             0.75, 0.08, meso_role="slightly longer fluffy fur on chest blaze, soft clumping", normal_strength=0.22),
    material("inner-ear-dark", "Black cat inner ear skin", "#4a332c", ["#5d4038", "#2e201c"],
             0.60, 0.10, meso_role="fine parallel fur striations lining the ear cone", normal_strength=0.3),
    material("inner-ear-pink", "Tabby inner ear skin", "#c98d76", ["#e8b9a0", "#a06a55"],
             0.58, 0.10, meso_role="fine white fuzz striations over pink ear skin", normal_strength=0.3),
    material("nose-dark", "Black cat nose leather", "#241d1a", ["#141010", "#3a2f2a"],
             0.30, 0.06, meso_role="fine leather pebbling", clearcoat=0.5, normal_strength=0.15,
             overrides=[{"id": "nose-satin-gloss", "roughness": 0.25,
                         "note": "Satiny highlight zone on the nose bridge, glossier than surrounding fur."}]),
    material("nose-pink", "Tabby pink nose leather", "#b9746a", ["#8a4f45", "#d89a8c"],
             0.32, 0.06, meso_role="fine leather pebbling", clearcoat=0.5, normal_strength=0.15,
             overrides=[{"id": "nose-satin-gloss", "roughness": 0.25,
                         "note": "Satiny highlight zone on the nose bridge."}]),
    material("eye-black-cat", "Black cat chartreuse iris", "#b7c448", ["#8a9c2e", "#d3dd7a", "#3a4518"],
             0.10, 0.05, meso_role="radial iris fiber striation", clearcoat=1.0, normal_strength=0.05, ao_cavity=0.1,
             overrides=[{"id": "iris-radial-stops", "roughness": 0.08,
                         "note": "Radial gradient: darker limbal rim #3a4518, mid chartreuse #b7c448, bright ring #d3dd7a around pupil."}]),
    material("eye-tabby", "Tabby pale green iris", "#a5c783", ["#7da055", "#cfe3a8", "#3f5230"],
             0.10, 0.05, meso_role="radial iris fiber striation", clearcoat=1.0, normal_strength=0.05, ao_cavity=0.1,
             overrides=[{"id": "iris-radial-stops", "roughness": 0.08,
                         "note": "Radial gradient: darker limbal rim #3f5230, mid pale green #a5c783, bright ring #cfe3a8 around pupil."}]),
    material("pupil-dark", "Round black pupil", "#0b0b0d", ["#1a1a1e"],
             0.15, 0.03, meso_role="near-perfect absorber, minimal response", clearcoat=0.6, normal_strength=0.0, ao_cavity=0.0),
    material("catchlight-glow", "Eye catchlight", "#ffffff", ["#e8f0ff"],
             0.05, 0.0, meso_role="emissive dome, independent of scene light", emissive="#ffffff",
             normal_strength=0.0, ao_cavity=0.0),
    material("whisker-white", "Whisker strands", "#f2efe8", ["#d8d4c8"],
             0.50, 0.05, meso_role="smooth keratin sheen along the strand", normal_strength=0.05, ao_cavity=0.0),
    material("hidden", "Hidden container material", "#000000", ["#000000"],
             1.0, 0.0, meso_role="never rendered", quality_tier="utility", ao_cavity=0.0),
]


# ----------------------------------------------------------------------------- repetition systems

spec["repetitionSystems"] = [
    {
        "id": "tabby-stripe-field",
        "kind": "surface-pattern",
        "appliesTo": ["tc-torso", "tc-head", "tc-leg-fl", "tc-leg-fr", "tc-tail", "tc-haunch-l", "tc-haunch-r"],
        "distribution": "seeded wavy dark bands (8-14 per region) on the tan base; orientation follows region: "
                        "vertical swirls on flanks, rings on legs/tail, M + cheek fans on the head",
        "realization": "map-based procedural canvas texture (albedo), deterministic seed 20260728",
        "buildsGeometry": False,
        "instances": None,
        "evidenceRefs": ["tabby-cat", "zone-r1c1", "zone-r1c2", "zone-r2c1"],
    },
    {
        "id": "whisker-fan",
        "kind": "instanced-strands",
        "appliesTo": ["bc-whiskers", "tc-whiskers"],
        "distribution": "6 strands per cheek side, fan spread ~35 deg, lengths 0.30-0.45 HU, slight droop",
        "realization": "merged tapered tube geometry per cat (12 instances), deterministic seed 42",
        "buildsGeometry": True,
        "geometry": "tapered tube per strand",
        "instances": 24,
        "evidenceRefs": ["full-object", "zone-r1c1"],
    },
]


# ----------------------------------------------------------------------------- build passes

meso_ids = [c["id"] for c in tree if c["level"] == "meso"]
micro_ids = [c["id"] for c in tree if c["level"] == "micro"]
idle_ids = [cid for cid in ("bc-head", "tc-head", "bc-ear-l", "bc-ear-r", "tc-ear-l", "tc-ear-r",
                            "bc-tail", "tc-tail", "bc-eyelid-l", "bc-eyelid-r",
                            "tc-eyelid-l", "tc-eyelid-r")]

spec["buildPasses"] = [
    {"id": "blockout",
     "goal": "Lock the two-cat group envelope: pear torsos, oversized heads, relative placement and yaw.",
     "componentRefs": ["root", "blackCat", "tabbyCat", "bc-torso", "bc-head", "tc-torso", "tc-head"],
     "acceptance": [
         "Seated silhouette per cat reads as cranium-over-pear from the reference camera",
         "Head height is ~0.43 of seated height (styleHeads ~2.6)",
         "Black cat left / tabby right, slight inward yaws, sizes match within 5%",
     ]},
    {"id": "structural-pass",
     "goal": "Add every meso part with its pivot, socket and attachment contract (ears, eyes, eyelids, "
             "muzzle, legs, haunches, tails, chest blaze).",
     "componentRefs": meso_ids,
     "acceptance": [
         "Every limb/tail/ear has parentSocket + localStart/localEnd + embed + gapTolerance",
         "Head, ear, tail and eyelid pivots exist at their semantic roots",
         "No mid-air parts: every appendage root is embedded in its parent volume",
     ]},
    {"id": "form-refinement",
     "goal": "Add micro detail: nose, mouth, inner ears, paws, whiskers, pupils, catchlights, limbal rings; "
             "refine ear cup, muzzle protrusion and paw shapes against the reference.",
     "componentRefs": micro_ids,
     "acceptance": [
         "Eye assembly reads: huge iris, round pupil ~0.52 of eye, limbal ring, upper-left catchlight",
         "Ear profile is a rounded triangle with visible inner-ear inset",
         "Paws sit flat on the seat with toe-groove placement marked",
     ]},
    {"id": "material-pass",
     "goal": "Apply the full material system: black satin fur, tabby stripe field, white blaze/socks, "
             "glossy eyes, nose leather, inner-ear skin, whiskers.",
     "componentRefs": [],
     "acceptance": [
         "Black coat is very dark warm gray (#232226 family), never pure black, satin sheen",
         "Tabby shows forehead M, cheek fans, flank swirls, leg rings and white blaze/socks",
         "Irises are radially graded green (chartreuse vs pale) with clearcoat gloss",
         "Independent roughness/normal/AO channels; no albedo aliasing into other channels",
     ]},
    {"id": "lighting-pass",
     "goal": "Reproduce the reference lookdev: warm key, cool fill, warm rim, soft contact shadows, ACES.",
     "componentRefs": [],
     "acceptance": [
         "Warm golden key from camera-left/above with soft shadow edges",
         "Cool low fill keeps black-fur shadow detail readable",
         "Warm rim separates both cats from a neutral backdrop; ACES tone mapping ~1.1 exposure",
         "Contact shadows anchor paws, haunches and curled tails to the ground",
     ]},
    {"id": "interaction-pass",
     "goal": "Wire the runtime: head/ear/tail/eyelid pivots, sculptRuntime nodes, explode + part picking, "
             "and a looping idle userData.tick (breathing, blink, tail sway, ear twitch).",
     "componentRefs": idle_ids,
     "acceptance": [
         "root.userData.sculptRuntime exposes nodes/meshes/sockets/colliders/destructionGroups",
         "root.userData.tick(t, dt) drives breath (~0.25 Hz torso scale), staggered blinks, "
         "tail sway and occasional ear twitches, deterministic and loop-safe",
         "Explode separates named parts about the model centre; raycast picking returns part names",
     ]},
    {"id": "optimization-pass",
     "goal": "Budget geometry segments and texture sizes for 60 fps real-time playback of the idle loop.",
     "componentRefs": [],
     "acceptance": [
         "Total triangles stay under ~250k at the default quality setting",
         "Canvas textures are 1024px and generated once at build time (deterministic seeds)",
         "tick() performs zero allocations per frame",
     ]},
]

spec["sculptPipeline"] = {
    "passGateMode": "locked-sequential",
    "passOrder": ["blockout", "structural-pass", "form-refinement", "material-pass",
                  "lighting-pass", "interaction-pass", "optimization-pass"],
    "currentPass": "blockout",
    "completedPasses": [],
    "lastCompletedPass": "",
    "blockedReason": "blockout requires a browser screenshot and self-correction review before structural-pass unlocks",
    "nextRequiredEvidence": [
        "blockout browser render screenshot from the reference camera",
        "side-by-side reference/render comparison sheet",
        "AI vision score >= 0.7 with layer scores and per-feature reviews",
    ],
}


# ----------------------------------------------------------------------------- feature review targets

spec["featureReviewTargets"] = [
    {"id": "anatomy-proportion", "name": "Quadruped feline proportions (head-units)",
     "tier": "critical", "passIds": ["blockout", "form-refinement"],
     "componentRefs": ["blackCat", "tabbyCat", "bc-torso", "bc-head", "tc-torso", "tc-head"],
     "evidenceRefs": ["full-object", "black-cat", "tabby-cat"], "minimumScore": 0.8,
     "mustPass": True,
     "acceptance": "Head ~0.43 of seated height; pear torso; slim straight front legs; ~2.6 styleHeads."},
    {"id": "pose-silhouette", "name": "Seated two-cat pose and silhouette",
     "tier": "critical", "passIds": ["blockout"],
     "componentRefs": ["blackCat", "tabbyCat"],
     "evidenceRefs": ["full-object"], "minimumScore": 0.8, "mustPass": True,
     "acceptance": "Both cats seated upright side by side; black left, tabby right with slight inward yaws; "
                   "cranium-over-pear outline with ear triangles."},
    {"id": "face-landmark-placement", "name": "Feline face landmark placement",
     "tier": "critical", "passIds": ["form-refinement"],
     "componentRefs": ["bc-head", "tc-head", "bc-muzzle", "tc-muzzle", "bc-nose", "tc-nose"],
     "evidenceRefs": ["black-cat", "tabby-cat", "zone-r1c1"], "minimumScore": 0.8, "mustPass": True,
     "acceptance": "Eye line ~0.51 of head height; eyes ~0.29 head width; nose at ~0.73; mouth at ~0.85."},
    {"id": "eye-identity-system", "name": "Huge green eyes: iris gradient, round pupil, catchlight",
     "tier": "critical", "passIds": ["material-pass", "lighting-pass"],
     "componentRefs": ["bc-eye-l", "bc-eye-r", "tc-eye-l", "tc-eye-r",
                       "bc-pupil-l", "bc-pupil-r", "tc-pupil-l", "tc-pupil-r",
                       "bc-catchlight-l", "bc-catchlight-r", "tc-catchlight-l", "tc-catchlight-r"],
     "evidenceRefs": ["zone-r1c1", "zone-r1c2"], "minimumScore": 0.8, "mustPass": True,
     "acceptance": "Chartreuse iris (black cat) and pale green iris (tabby), radial gradient, big round "
                   "black pupil, white upper-left catchlight, clearcoat gloss."},
    {"id": "coat-pattern-identity", "name": "Coat identity: solid black vs tabby + white blaze/socks",
     "tier": "critical", "passIds": ["material-pass"],
     "componentRefs": ["bc-torso", "tc-torso", "tc-chest", "tc-head", "tc-leg-fl", "tc-leg-fr",
                       "tc-paw-fl", "tc-paw-fr"],
     "evidenceRefs": ["black-cat", "tabby-cat", "zone-r1c1", "zone-r2c1"], "minimumScore": 0.8, "mustPass": True,
     "acceptance": "Black cat uniformly very dark warm gray; tabby shows M, cheek fans, flank swirls, leg "
                   "rings, white muzzle/chest/paws."},
    {"id": "ear-and-inner-ear-detail", "name": "Ear shape and inner-ear inset",
     "tier": "important", "passIds": ["form-refinement"],
     "componentRefs": ["bc-ear-l", "bc-ear-r", "tc-ear-l", "tc-ear-r",
                       "bc-inner-ear-l", "bc-inner-ear-r", "tc-inner-ear-l", "tc-inner-ear-r"],
     "evidenceRefs": ["zone-r0c0", "zone-r0c1", "zone-r0c2"], "minimumScore": 0.65,
     "acceptance": "Tall rounded-triangle ears; inner cone dark auburn (black cat) vs pink with fuzz (tabby)."},
    {"id": "paw-toe-linework", "name": "Paw toe grooves and white socks",
     "tier": "important", "passIds": ["material-pass"],
     "componentRefs": ["bc-paw-fl", "bc-paw-fr", "tc-paw-fl", "tc-paw-fr"],
     "evidenceRefs": ["zone-r2c1"], "minimumScore": 0.65,
     "acceptance": "Shallow toe grooves on all four front paws; tabby paws are white socks under ringed legs."},
    {"id": "idle-animation-liveliness", "name": "Idle loop: breathing, blink, tail sway",
     "tier": "important", "passIds": ["interaction-pass"],
     "componentRefs": idle_ids,
     "evidenceRefs": ["full-object"], "minimumScore": 0.65,
     "acceptance": "tick() drives subtle breath, staggered blinks, tail sway and ear twitches without "
                   "breaking the seated pose."},
]


# ----------------------------------------------------------------------------- remaining top-level fields

spec["suitability"] = "conditional"
spec["scores"] = {
    "object_isolation": 2,
    "silhouette_readability": 3,
    "depth_inference": 2,
    "primitive_decomposition": 2,
    "material_procedurality": 2,
    "occlusion_risk": 2,
    "interaction_fit": 3,
}
spec["referenceCamera"] = {
    "solved": False,
    "fovDegrees": 38.0,
    "aspect": 1.2496,
    "orientation": {"yaw": 0.0, "pitch": -5.0, "roll": 0.0},
    "positionHint": [0.10, 1.75, 4.6],
    "lookAtHint": [0.0, 1.30, 0.0],
    "note": ("Estimated by hand from the reference framing (both cats full-body, eye-level camera). "
             "No projection route: procedural stylized materials, so no camera solve was required."),
}
spec["coordinateFrame"] = {
    "front": "+Z faces the reference camera",
    "up": "+Y up; seat plane is y=0",
    "scaleReference": "1 world unit = 1 feline head-unit (black-cat crown-to-chin); seated height ~2.6 units",
}
spec["silhouette"] = {
    "boundingShape": "two adjacent seated quadrupeds; each an oversized spherical cranium over a pear-shaped torso",
    "aspectRatios": ["seated height : head height = 2.6", "head width : head height = 1.06",
                     "ear height : head height = 0.40"],
    "symmetry": "bilateral per cat (mirrored L/R part pairs)",
    "dominantCurves": ["round cranium", "pear torso profile", "C-curved tail on the seat",
                       "straight parallel front legs"],
    "negativeSpaces": ["thin gap between the front legs", "under-chin gap between head and chest",
                       "low arch between the two cats' backs"],
    "landmarks": ["ear tips", "eye centers", "nose tips", "paw row on the seat", "black tail tip front-left"],
}
spec["lightingFromPhoto"] = [
    "Warm golden-hour key light from camera-left and above (~35 deg elevation), soft-edged shadows, "
    "visible as the bright side on both cats' left cheeks and the warm rim on the black coat",
    "Cool sky fill from camera-right at low intensity, keeping shadow-side black fur readable (not crushed)",
    "Warm rim/back light from behind-right separating both cats from the beige wall backdrop",
    "ACES filmic tone mapping, exposure ~1.1; soft contact shadows under haunches, paws and the curled "
    "tail where they meet the chair seat (grounded, never floating)",
]
spec["lookDevTargets"]["referencePbrExtractionNote"] = (
    "referencePbrExtraction.requiredWhenSourceImagePresent is set false: the reference is itself a "
    "stylized CG render with baked lighting, and the target look is produced by procedural stylized "
    "materials (seeded stripe canvas, radial iris geometry, clearcoat gloss). Inverse-rendered PBR maps "
    "are not the fidelity path here; zone-crop sampling grounds every albedo choice instead."
)
spec["lookDevTargets"]["materialPass"]["referencePbrExtraction"]["requiredWhenSourceImagePresent"] = False

qc = spec["qualityContract"]
qc["qualityBar"] = "complex"
qc["minimumSpecDepth"] = {
    "macroComponents": 5, "mesoComponents": 12, "microFeatureGroups": 10,
    "materialLayers": 8, "repetitionSystems": 2, "reviewViewpoints": 4,
}
qc["featureGroups"] += [
    {"id": "eye-identity", "name": "Huge green eye assemblies",
     "required": True,
     "qualityCriteria": [
         "Each eye carries radially graded green iris, round black pupil ~0.52 of eye diameter, "
         "dark limbal ring and an upper-left catchlight.",
         "Chartreuse for the black cat, paler green for the tabby; clearcoat gloss, never flat albedo.",
     ],
     "evidenceRefs": ["zone-r1c1", "zone-r1c2"],
     "failureModes": ["eyes read small or flat", "missing catchlight kills the alive look",
                      "same iris color reused for both cats"]},
    {"id": "coat-pattern-identity", "name": "Coat patterns: solid black vs striped tabby + white",
     "required": True,
     "qualityCriteria": [
         "Black coat is uniform very dark warm gray with satin sheen; zero striping.",
         "Tabby carries forehead M, cheek fans, flank swirls, leg/tail rings plus white muzzle/chest/paws.",
     ],
     "evidenceRefs": ["black-cat", "tabby-cat", "zone-r2c1"],
     "failureModes": ["tabby reads as plain brown cat", "white blaze missing or hard-edged",
                      "black coat crushed to pure black"]},
]
qt = spec["qualityTargets"]
qt["targetFidelity"] = 0.72
qt["reviewViewpoints"] = ["front-reference", "three-quarter-right", "left-side", "back-three-quarter-inferred"]
qt["mustMatch"] = [
    "two-cat seated silhouette and head-unit proportions (2.6 HU, head ~0.43)",
    "huge green eyes with round pupil and catchlight",
    "solid black coat vs tabby stripe field with white blaze/socks",
    "tall triangular ears with inner-ear inset",
]
qt["niceToHave"] = [
    "whisker follicle dots and inner-ear striations",
    "warm rim response on the black coat",
]

spec["proceduralStrategy"] = [
    "Block out the two pear torsos + oversized heads from the reference silhouette first.",
    "Attach every meso appendage (ears, eyes, legs, haunches, tails, blaze) with socket contracts.",
    "Refine micro detail: nose, mouth, inner ears, paws, whiskers, pupil/catchlight/limbal parts.",
    "Generate materials procedurally: seeded stripe canvas for the tabby, radial iris geometry, "
    "clearcoat gloss zones; independent roughness/normal/AO channels.",
    "Reproduce the reference lighting rig (warm key, cool fill, warm rim, ACES, contact shadows).",
    "Wire pivots and a deterministic looping userData.tick (breath, blink, tail sway, ear twitch).",
]
spec["actionReadiness"]["defaultRigType"] = "quadruped-character-pivots"
spec["actionReadiness"]["rootMotionNode"] = "root"
spec["actionReadiness"]["authoringRules"] = [
    "Put transforms on component pivot groups, not only on raw meshes.",
    "For attached child parts, put the pivot at the semantic root/socket and build visible geometry from localStart to localEnd.",
    "Head-mounted parts (eyes, ears, muzzle) parent to the head pivot so head motion carries the face.",
    "root.userData.tick(t, dt) must be allocation-free, deterministic (seeded), and loop-safe for recording.",
    "Explode and part picking share one definition of a part via sculptRuntime nodes.",
]
spec["animationAnchors"] = [
    {"id": "head-pivot", "nodeRefs": ["bc-head", "tc-head"], "channels": ["rotate"], "note": "subtle bob/tilt"},
    {"id": "ear-pivots", "nodeRefs": ["bc-ear-l", "bc-ear-r", "tc-ear-l", "tc-ear-r"], "channels": ["rotate"], "note": "occasional twitch"},
    {"id": "tail-pivots", "nodeRefs": ["bc-tail", "tc-tail"], "channels": ["rotate", "bend"], "note": "slow sway"},
    {"id": "blink-pivots", "nodeRefs": ["bc-eyelid-l", "bc-eyelid-r", "tc-eyelid-l", "tc-eyelid-r"], "channels": ["rotate"], "note": "staggered blink"},
    {"id": "breath", "nodeRefs": ["bc-torso", "tc-torso"], "channels": ["scale"], "note": "~0.25 Hz chest swell"},
]
spec["risks"] = [
    "INFERRED REGION: dorsal/back surfaces of both cats are hidden; stripe continuation on the tabby's "
    "back is inferred from visible flanks (confidence ~0.4).",
    "INFERRED REGION: the tabby's tail is not visible; modeled as a symmetric seat-curl with ring "
    "striping (confidence 0.35), matching the black cat's visible wrap.",
    "INFERRED REGION: hind paws are folded under the bodies; only haunch volumes are modeled (confidence 0.55).",
    "Stylized target: the reference is a CG-animated look; output is a stylized procedural approximation, "
    "not a photoreal cat.",
    "Single view: exact ear-back shape and tail tip rest position are approximations.",
]
spec["assumptions"] = [
    "Unit scale is the feline head-unit; real-world scale is out of scope.",
    "Chair, grass and flowers are context, not part of the reconstruction target.",
    "Stripe pattern on hidden surfaces repeats the visible mackerel language with the same seed family.",
]

# viewEvidence: keep full-object, add cat framing + zone ids used by components/details
spec["viewEvidence"] = [
    {"id": "full-object", "view": "primary", "imageRegion": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0, "units": "normalized"},
     "observations": ["Two stylized cats seated side by side on a beige chair in grass; eye-level camera."],
     "confidence": 0.95},
    {"id": "black-cat", "view": "primary", "imageRegion": {"x": 0.16, "y": 0.13, "width": 0.32, "height": 0.72, "units": "normalized"},
     "observations": ["Smooth black cat, chartreuse eyes, tail curled to its front-left on the seat."],
     "confidence": 0.9},
    {"id": "tabby-cat", "view": "primary", "imageRegion": {"x": 0.45, "y": 0.12, "width": 0.37, "height": 0.73, "units": "normalized"},
     "observations": ["Brown tabby, pale green eyes, white muzzle/chest/paws, slight three-quarter pose."],
     "confidence": 0.9},
] + [
    {"id": f"zone-r{r}c{c}", "view": "detail-zone",
     "imageRegion": {"x": round(c / 3, 4), "y": round(r / 3, 4), "width": 0.3333, "height": 0.3333, "units": "normalized"},
     "observations": [f"3x3 grid zone r{r}c{c}; see kimik3/di_zones/zone-r{r}c{c}.png"],
     "confidence": 0.8}
    for r in range(3) for c in range(3)
]

SPEC_PATH.write_text(json.dumps(spec, indent=2, ensure_ascii=False) + "\n")
print(f"spec written: {len(tree)} components, {len(spec['materials'])} materials, "
      f"{len(spec['featureReviewTargets'])} feature targets")

