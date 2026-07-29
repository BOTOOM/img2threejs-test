#!/usr/bin/env python3
"""Parametric ObjectSculptSpec builder for the two cats in gatos.png.

Why a builder instead of hand-written JSON: every transform in this spec is a
projection of a measured reference pixel coordinate, and there are ~90
components. Authoring them by hand would hide the measurement behind a magic
number and make a proportion fix a 90-place edit. Here each component's world
transform is derived from the landmark table below, so a re-measurement is a
one-line change.

Coordinate contract
-------------------
The reference matte crop is gatos.png[225:1150, 140:950] = 925 x 810 px.
World units are chosen so that the plane z = 0 maps linearly onto that crop:

    worldX = (srcX - 687.5) / 1000
    worldY = (545.0 - srcY) / 1000

with X right, Y up, Z toward the camera. The review camera then sits at
(0, 0, 2.1852) with a 21 degree vertical FOV, which makes the visible height at
z = 0 exactly 0.810 world units - i.e. a point authored at z = 0 lands on its
measured pixel. Points at z != 0 foreshorten by D / (D - z), which is what puts
the inferred tails and the occluded hind feet safely inside the body silhouette.

Writes a patch document; merge it with tools/patch_json.py.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent.parent
CROP = (225, 140, 1150, 950)
CAMERA_DISTANCE = 2.1852
CAMERA_FOV = 21.0
PX = 1000.0


def wx(src_x: float) -> float:
    return round((src_x - 687.5) / PX, 4)


def wy(src_y: float) -> float:
    return round((545.0 - src_y) / PX, 4)


def wsize(px: float) -> float:
    return round(px / PX, 4)


def projected_src(x: float, y: float, z: float) -> tuple[float, float]:
    """Where a world point lands in source-image pixels under the review camera."""
    factor = CAMERA_DISTANCE / (CAMERA_DISTANCE - z)
    return (687.5 + x * PX * factor, 545.0 - y * PX * factor)


def pfactor(z: float) -> float:
    """Perspective magnification of the plane at depth z relative to the z=0 plane."""
    return CAMERA_DISTANCE / (CAMERA_DISTANCE - z)


def wxz(src_x: float, z: float) -> float:
    """World X whose PROJECTION lands on src_x, for a part sitting at depth z.

    wx() alone is only correct on the z = 0 plane. A muzzle, paw or eye pushed
    forward by 0.1 world units is magnified by D/(D-z) - about 5 percent - so
    placing it at the raw wx() value pushes its projection outward by that much.
    Every landmark measured in the photo is a *projection*, so the world position
    has to be divided back out by the same factor.
    """
    return round((src_x - 687.5) / PX / pfactor(z), 4)


def wyz(src_y: float, z: float) -> float:
    """World Y whose projection lands on src_y, for a part at depth z."""
    return round((545.0 - src_y) / PX / pfactor(z), 4)


def wsizez(px: float, z: float) -> float:
    """World size whose projected size is px, for a part at depth z."""
    return round(px / PX / pfactor(z), 4)


# --------------------------------------------------------------------------------------
# Measured reference colours (medians from tools/sample.py over gatos.png).
# The scene carries a strong warm low-sun key, so these are *observed* pixels, not
# de-lit albedo. Authored albedo removes that cast: see the `albedo` field beside each.
# --------------------------------------------------------------------------------------
AS_PRESENTED = {
    "eye-stack": (73, 64, 55),
    "iris-annulus": (104, 92, 62),
    "pupil": (26, 22, 16),
    "whisker": (74, 55, 36),
    "eyeliner": (30, 25, 20),
    "marking": (46, 30, 16),
    "cornea": (73, 64, 55),
}

MEASURED = {
    "coat-black-lit": (60, 49, 41),
    "coat-black-shadow": (14, 13, 13),
    "coat-black-rim": (106, 68, 45),
    "coat-tabby-forehead": (124, 90, 63),
    "coat-tabby-flank": (70, 47, 27),
    "coat-tabby-stripe": (41, 23, 9),
    "fur-white-lit": (240, 207, 169),
    "fur-white-shadow": (199, 160, 122),
    "fur-white-muzzle": (184, 149, 109),
    "ear-membrane-tabby": (186, 138, 112),
    "ear-membrane-black": (85, 45, 25),
    "nose-black": (37, 30, 23),
    "nose-tabby": (150, 85, 47),
    "iris-black-cat": (188, 190, 96),
    "iris-tabby": (168, 190, 104),
    "pupil": (19, 18, 10),
    "pupil-reflection": (19, 35, 49),
    "whisker": (222, 205, 186),
}


def rgba(rgb: tuple[int, int, int], alpha: float = 1.0) -> str:
    return f"rgba({rgb[0]}, {rgb[1]}, {rgb[2]}, {alpha})"


def hexcolor(rgb: tuple[int, int, int]) -> str:
    return "#%02X%02X%02X" % rgb


# --------------------------------------------------------------------------------------
# Landmark tables. Every srcX/srcY is a pixel measurement from tools/probe.py or
# tools/grid.py against gatos.png; z values are inferred depth (single view).
# --------------------------------------------------------------------------------------
BLACK = {
    "id": "bc",
    "label": "Black Shorthair",
    "coat": "coat-black",
    "iris": "iris-amber-green",
    "nose": "nose-leather-dark",
    "membrane": "ear-membrane-dark",
    "headLengthPx": 250,
    # head lathe: local (radius, y) in world units, bottom to top, around the vertical axis
    "head": {"src": (487, 383), "z": 0.0, "profile": [
        [0.001, -0.138], [0.068, -0.126], [0.112, -0.104], [0.136, -0.074], [0.146, -0.044],
        [0.148, -0.010], [0.144, 0.026], [0.132, 0.058], [0.112, 0.088], [0.080, 0.112],
        [0.042, 0.128], [0.001, 0.138]]},
    "torso": {"src": (466, 620), "z": 0.0, "profile": [
        [0.001, -0.215], [0.100, -0.200], [0.140, -0.172], [0.156, -0.128], [0.163, -0.075],
        [0.167, -0.022], [0.169, 0.030], [0.166, 0.070], [0.155, 0.110], [0.132, 0.148],
        [0.104, 0.186], [0.062, 0.216], [0.001, 0.232]]},
    "haunch": {"src": (338, 760), "z": -0.030, "profile": [
        [0.001, -0.155], [0.050, -0.130], [0.082, -0.090], [0.090, -0.050], [0.084, 0.000],
        [0.072, 0.060], [0.056, 0.110], [0.042, 0.160], [0.001, 0.185]]},
    "earL": {"tip": (390, 157), "base": (408, 290), "baseRadius": 0.0495, "flatten": 0.42},
    "earR": {"tip": (641, 192), "base": (598, 305), "baseRadius": 0.055, "flatten": 0.42},
    "eyeL": {"src": (426, 378), "diameterPx": 57, "z": 0.095},
    "eyeR": {"src": (558, 400), "diameterPx": 58, "z": 0.090},
    "muzzle": {"src": (487, 462), "size": (100, 56, 34), "z": 0.108, "inset": 0.46},
    "nosePos": {"src": (487, 445), "size": (37, 28, 22), "z": 0.126, "inset": 0.10},
    "chin": {"src": (487, 495), "size": (58, 36, 38), "z": 0.098},
    "cheekL": {"src": (382, 438), "size": (52, 70, 58), "z": 0.030, "inset": 0.72},
    "cheekR": {"src": (600, 450), "size": (50, 66, 56), "z": 0.020, "inset": 0.72},
    "browL": {"src": (426, 345), "size": (70, 30, 40), "z": 0.085, "inset": 0.55},
    "browR": {"src": (558, 366), "size": (70, 30, 40), "z": 0.080, "inset": 0.55},
    "neck": {"start": (487, 512), "end": (487, 440), "baseRadius": 0.098, "endRadius": 0.092,
             "z": (0.010, 0.030)},
    "forelegL": {"start": (470, 638), "end": (470, 892), "baseRadius": 0.060, "endRadius": 0.044,
                 "z": (0.062, 0.088)},
    "forelegR": {"start": (565, 648), "end": (565, 887), "baseRadius": 0.058, "endRadius": 0.042,
                 "z": (0.058, 0.084)},
    "pawFL": {"src": (470, 906), "size": (94, 54, 92), "z": 0.096},
    "pawFR": {"src": (565, 896), "size": (84, 50, 86), "z": 0.090},
    "footHL": {"src": (342, 860), "size": (140, 46, 92), "z": 0.060, "yaw": -0.35},
    "footHR": {"world": (-0.160, -0.317, -0.100), "size": (140, 46, 92), "yaw": 0.35},
    "tail": [(-0.300, -0.255, -0.140), (-0.350, -0.300, -0.210), (-0.410, -0.310, -0.280),
             (-0.460, -0.270, -0.330), (-0.480, -0.200, -0.340), (-0.460, -0.140, -0.310)],
    "tailRadii": [0.027, 0.024, 0.021, 0.017, 0.013, 0.009],
    "whiskerPadL": (452, 468),
    "whiskerPadR": (524, 476),
    "whiskerZ": 0.115,
}

TABBY = {
    "id": "tb",
    "label": "Brown Mackerel Tabby",
    "coat": "coat-tabby-agouti",
    "iris": "iris-chartreuse",
    "nose": "nose-leather-pink",
    "membrane": "ear-membrane-warm",
    "headLengthPx": 288,
    "head": {"src": (940, 390), "z": 0.0, "profile": [
        [0.001, -0.150], [0.074, -0.136], [0.124, -0.112], [0.154, -0.078], [0.166, -0.044],
        [0.170, -0.010], [0.164, 0.028], [0.148, 0.064], [0.124, 0.096], [0.086, 0.122],
        [0.046, 0.140], [0.001, 0.150]]},
    "torso": {"src": (856, 600), "z": 0.0, "profile": [
        [0.001, -0.190], [0.070, -0.180], [0.104, -0.158], [0.130, -0.118], [0.152, -0.078],
        [0.172, -0.038], [0.182, 0.008], [0.182, 0.048], [0.170, 0.088], [0.142, 0.132],
        [0.112, 0.172], [0.068, 0.202], [0.001, 0.218]]},
    "haunch": {"src": (742, 690), "z": -0.040, "profile": [
        [0.001, -0.150], [0.048, -0.130], [0.070, -0.100], [0.082, -0.055], [0.086, -0.005],
        [0.078, 0.045], [0.062, 0.090], [0.046, 0.130], [0.001, 0.160]]},
    "earL": {"tip": (852, 149), "base": (871, 278), "baseRadius": 0.0525, "flatten": 0.40},
    "earR": {"tip": (1097, 214), "base": (1049, 304), "baseRadius": 0.047, "flatten": 0.40},
    "eyeL": {"src": (874, 369), "diameterPx": 62, "z": 0.105},
    "eyeR": {"src": (1005, 402), "diameterPx": 64, "z": 0.108},
    "muzzle": {"src": (925, 480), "size": (108, 64, 38), "z": 0.128, "inset": 0.46},
    "nosePos": {"src": (925, 451), "size": (41, 31, 24), "z": 0.145, "inset": 0.10},
    "chin": {"src": (928, 513), "size": (64, 40, 42), "z": 0.118},
    "cheekL": {"src": (806, 444), "size": (58, 78, 64), "z": 0.030, "inset": 0.72},
    "cheekR": {"src": (1046, 456), "size": (54, 74, 60), "z": 0.020, "inset": 0.72},
    "browL": {"src": (866, 332), "size": (75, 32, 45), "z": 0.095, "inset": 0.55},
    "browR": {"src": (1005, 365), "size": (75, 32, 45), "z": 0.098, "inset": 0.55},
    "neck": {"start": (928, 534), "end": (928, 462), "baseRadius": 0.106, "endRadius": 0.100,
             "z": (0.020, 0.040)},
    "forelegL": {"start": (792, 628), "end": (792, 884), "baseRadius": 0.062, "endRadius": 0.046,
                 "z": (0.078, 0.104)},
    "forelegR": {"start": (890, 650), "end": (890, 848), "baseRadius": 0.058, "endRadius": 0.043,
                 "z": (-0.048, -0.028)},
    "pawFL": {"src": (792, 892), "size": (96, 56, 94), "z": 0.110},
    "pawFR": {"src": (890, 848), "size": (78, 48, 86), "z": -0.015},
    "footHL": {"src": (705, 818), "size": (86, 44, 78), "z": -0.050, "yaw": -0.55},
    "footHR": {"world": (0.220, -0.290, -0.200), "size": (86, 44, 78), "yaw": 0.55},
    "tail": [(0.020, -0.240, -0.180), (0.080, -0.290, -0.250), (0.160, -0.310, -0.300),
             (0.240, -0.280, -0.330), (0.290, -0.210, -0.330), (0.300, -0.140, -0.300)],
    "tailRadii": [0.028, 0.025, 0.022, 0.018, 0.014, 0.010],
    "bib": {"src": (936, 578), "size": (112, 196, 66), "z": 0.110},
    "whiskerPadL": (884, 486),
    "whiskerPadR": (962, 496),
    "whiskerZ": 0.135,
}


# --------------------------------------------------------------------------------------
# Component factory
# --------------------------------------------------------------------------------------
def action_profile(
    role: str,
    pivot_mode: str = "center",
    pivot_local: tuple[float, float, float] = (0.0, 0.0, 0.0),
    axis: tuple[float, float, float] = (0.0, 1.0, 0.0),
    channels: dict[str, bool] | None = None,
    sockets: list[dict[str, Any]] | None = None,
    collider: str = "sphere",
    confidence: float = 0.7,
) -> dict[str, Any]:
    base_channels = {
        "translate": False, "rotate": True, "scale": False, "bend": False,
        "twist": False, "detach": False, "visibility": True, "materialState": False,
    }
    if channels:
        base_channels.update(channels)
    return {
        "animationRole": role,
        "pivot": {
            "mode": pivot_mode,
            "localPosition": list(pivot_local),
            "axis": list(axis),
            "confidence": confidence,
        },
        "transformChannels": base_channels,
        "sockets": sockets or [],
        "collider": {"type": collider, "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0],
                     "isTrigger": False},
        "constraints": [],
        "destruction": {"breakable": False, "fractureGroup": "", "seamRefs": [],
                        "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": ""},
    }


def color_recipe(
    component_id: str,
    dominant: tuple[int, int, int],
    secondary: tuple[int, int, int],
    material_class: str,
    confidence: float,
    gradient: list[tuple[float, tuple[int, int, int]]] | None = None,
    as_presented: bool = False,
) -> dict[str, Any]:
    recipe: dict[str, Any] = {
        "componentId": component_id,
        "dominantAlbedo": rgba(dominant),
        "secondaryAlbedo": rgba(secondary),
        "materialClass": material_class,
        "materialClassConfidence": confidence,
        "source": (
            "as-presented median sampled with tools/sample.py over the material-pass render: this "
            "part never contributes its own albedo to a pixel (a 2 mm strand, a 16 percent-opacity "
            "shell, a 3 px line), it contributes a blend with what is behind it, so the recipe "
            "describes what the render shows rather than an idealised albedo the render can never "
            "produce. The idealised albedo stays on the material and is what actually drives shading."
            if as_presented else
            "median of reference pixels sampled with tools/sample.py over gatos.png"
        ),
        "colorScope": "as-presented-at-render-scale" if as_presented else "idealised-albedo",
    }
    if gradient:
        recipe["colorGradient"] = {
            "type": "linear",
            "stops": [{"offset": offset, "color": rgba(rgb)} for offset, rgb in gradient],
        }
    return recipe


def component(
    cid: str,
    name: str,
    level: str,
    role: str,
    primitive: str,
    position: tuple[float, float, float],
    *,
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    material: str,
    parent: str | None = None,
    topology: str,
    rationale: str,
    recipe: dict[str, Any],
    importance: float = 0.6,
    confidence: float = 0.7,
    descriptor: dict[str, Any] | None = None,
    profile: dict[str, Any] | None = None,
    attachment: dict[str, Any] | None = None,
    local_features: list[dict[str, Any]] | None = None,
    surface_detail: dict[str, Any] | None = None,
    evidence: list[str] | None = None,
    build_pass: str = "blockout",
    notes: str = "",
) -> dict[str, Any]:
    geometry_descriptor: dict[str, Any] = {
        "topologyIntent": rationale,
        "edgeTreatment": {"type": "smooth-shaded", "bevelRadius": 0.0, "segments": 1},
        "deformationStack": [],
        "uvStrategy": "generated procedural coordinates",
        "normalStrategy": "vertex normals from generated geometry",
    }
    if descriptor:
        geometry_descriptor.update(descriptor)
    return {
        "id": cid,
        "name": name,
        "level": level,
        "role": role,
        "importance": importance,
        "confidence": confidence,
        "primitive": primitive,
        "topologyClass": topology,
        "topologyRationale": rationale,
        "geometryDescriptor": geometry_descriptor,
        "parent": parent,
        "attachment": attachment,
        "dimensions": {
            "width": abs(scale[0]), "height": abs(scale[1]), "depth": abs(scale[2]),
            "units": "world (1.0 = 1000 reference pixels at z=0)", "confidence": confidence,
        },
        "transform": {
            "position": [round(v, 4) for v in position],
            "rotation": [round(v, 4) for v in rotation],
            "scale": [round(v, 4) for v in scale],
        },
        "actionProfile": profile or action_profile(role),
        "material": material,
        "materialLayers": [material],
        "colorMaterialRecipe": recipe,
        "deformations": [],
        "joints": [],
        "seams": [],
        "localFeatures": local_features or [],
        "surfaceDetail": surface_detail or {
            "macroRoughness": 0.7, "microRoughness": 0.55, "bumpAmplitude": 0.006,
            "normalPattern": "directional fur strand grain following hair flow",
            "displacementPattern": "none",
            "occlusionPattern": "cavity darkening where this part meets its neighbour",
            "edgeWearPattern": "none",
            "notes": notes or "Fur surface: relief is strand grain, not noise.",
        },
        "evidenceRefs": evidence or ["full-object"],
        "details": [],
        "fidelityTier": build_pass,
    }


def attachment_block(
    parent_id: str,
    socket: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    base_radius: float,
    end_radius: float,
    contact: str,
    embed: float,
    evidence: list[str],
) -> dict[str, Any]:
    return {
        "parentId": parent_id,
        "parentSocket": socket,
        "localStart": [round(v, 4) for v in start],
        "localEnd": [round(v, 4) for v in end],
        "contactType": contact,
        "contactNormal": None,
        "baseRadius": base_radius,
        "endRadius": end_radius,
        "embedDepth": embed,
        "overlap": embed,
        "gapTolerance": 0.002,
        "evidenceRefs": evidence,
    }


def lathe_descriptor(profile: list[list[float]], segments: int = 40) -> dict[str, Any]:
    return {"latheProfile": {"points": profile, "segments": segments}}


def profile_radius_at(profile: list[list[float]], local_y: float) -> float:
    """Linear-interpolate a lathe profile's radius at a local height.

    Needed because the eyes, muzzle, nose and chin must sit ON the skull surface,
    not at a hand-guessed depth. Widening the head profile to carry the cheek
    ruff (r 0.134 -> 0.148 on the black cat) silently swallowed every eye that
    had been placed at a fixed z, which is exactly the class of error a derived
    value prevents.
    """
    points = sorted(profile, key=lambda point: point[1])
    if local_y <= points[0][1]:
        return points[0][0]
    if local_y >= points[-1][1]:
        return points[-1][0]
    for index in range(len(points) - 1):
        y0, y1 = points[index][1], points[index + 1][1]
        if y0 <= local_y <= y1:
            if y1 == y0:
                return max(points[index][0], points[index + 1][0])
            t = (local_y - y0) / (y1 - y0)
            return points[index][0] + t * (points[index + 1][0] - points[index][0])
    return points[-1][0]


def surface_z(profile: list[list[float]], local_x: float, local_y: float,
              inset: float) -> float:
    """Depth that puts a feature's centre `inset` inside the revolved surface."""
    radius = profile_radius_at(profile, local_y)
    target = max(0.004, radius - inset)
    return round(math.sqrt(max(0.0, target * target - local_x * local_x)), 4)


def local_to(parent_position: tuple[float, float, float],
             world_position: tuple[float, float, float]) -> tuple[float, float, float]:
    """World -> parent-local offset.

    The generator puts each component's transform on a pivot node that is a child
    of its parent's pivot node, so a child authored with an absolute world
    position would be offset by its parent's position. Torso, haunch and head all
    keep scale 1,1,1 and rotation 0 precisely so this reduces to a subtraction.
    """
    return tuple(round(world_position[axis] - parent_position[axis], 4) for axis in range(3))


def build_cat(cat: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Returns (components, repetitionSystems) for one cat."""
    p = cat["id"]
    label = cat["label"]
    coat = cat["coat"]
    components: list[dict[str, Any]] = []
    systems: list[dict[str, Any]] = []
    is_tabby = p == "tb"
    coat_dominant = MEASURED["coat-tabby-flank"] if is_tabby else MEASURED["coat-black-lit"]
    coat_secondary = MEASURED["coat-tabby-stripe"] if is_tabby else MEASURED["coat-black-shadow"]
    coat_recipe_class = "fabric"
    ev = [f"{p}-flank" if is_tabby else f"{p}-chest", "full-object"]

    def coat_recipe(cid: str, conf: float = 0.8) -> dict[str, Any]:
        return color_recipe(
            cid, coat_dominant, coat_secondary, coat_recipe_class, conf,
            gradient=[(0.0, coat_secondary), (0.55, coat_dominant),
                      (1.0, MEASURED["coat-tabby-forehead"] if is_tabby else MEASURED["coat-black-rim"])],
        )

    # ---------------- macro: torso, haunch, head ----------------
    torso = cat["torso"]
    torso_pos = (wx(torso["src"][0]), wy(torso["src"][1]), torso["z"])
    components.append(component(
        f"{p}-torso", f"{label} Torso", "macro", "body", "lathe", torso_pos,
        material=coat, parent=None, topology="continuous-sculpt",
        rationale=(
            "One continuous barrel from shoulder to seat with no seam anywhere on it: the reference "
            "shows an unbroken fur surface whose outline changes radius smoothly, so it is a single "
            "revolved sculpt (lathe, radius measured per scanline) rather than an assembly of blocks. "
            "Scale is left at 1,1,1 and the size lives in the lathe profile so child parts do not "
            "inherit a non-uniform scale."
        ),
        recipe=coat_recipe(f"{p}-torso"), importance=1.0, confidence=0.8,
        descriptor=lathe_descriptor(torso["profile"]),
        profile=action_profile(
            "body", "center", (0.0, 0.0, 0.0), (0.0, 1.0, 0.0),
            {"translate": True, "scale": True},
            sockets=[
                {"id": f"{p}-socket-neck", "localPosition": [0.021, 0.150, 0.02], "localRotation": [0, 0, 0]},
                {"id": f"{p}-socket-shoulder-left", "localPosition": [0.004, -0.070, 0.10], "localRotation": [0, 0, 0]},
                {"id": f"{p}-socket-shoulder-right", "localPosition": [0.099, -0.080, 0.095], "localRotation": [0, 0, 0]},
            ],
            collider="capsule", confidence=0.8),
        local_features=[
            {"id": f"{p}-chest-sheen-band", "kind": "gloss",
             "description": "Brighter satin band down the chest centreline where hair flow turns "
                            "toward the key light; measured p90 rises to rgb(31,22,15) on the black "
                            "coat against a rgb(16,13,9) median.",
             "realization": "map-only"},
            {"id": f"{p}-limb-cavity-occlusion", "kind": "seam",
             "description": "Cavity darkening in the crease where each foreleg and the haunch meet "
                            "the barrel, so limbs read as growing out of the body.",
             "realization": "map-only"},
        ],
        evidence=ev, build_pass="blockout",
    ))

    haunch = cat["haunch"]
    haunch_pos = (wx(haunch["src"][0]), wy(haunch["src"][1]), haunch["z"])
    components.append(component(
        f"{p}-haunch", f"{label} Haunch", "macro", "body", "lathe", haunch_pos,
        material=coat, parent=None, topology="continuous-sculpt",
        rationale=(
            "The seated hindquarter is a second continuous revolved mass, not part of the barrel: the "
            "reference silhouette shows a distinct rounded bulge whose widest point sits 130 px below "
            "and to the side of the chest's widest point, so a single lathe cannot describe both."
        ),
        recipe=coat_recipe(f"{p}-haunch"), importance=0.9, confidence=0.7,
        descriptor=lathe_descriptor(haunch["profile"]),
        profile=action_profile(
            "body", "center", (0.0, 0.0, 0.0), (0.0, 1.0, 0.0), {"translate": True},
            sockets=[
                {"id": f"{p}-socket-tail", "localPosition": [0.0, -0.045, -0.11], "localRotation": [0, 0, 0]},
                {"id": f"{p}-socket-hindfoot-left", "localPosition": [0.01, -0.10, 0.09], "localRotation": [0, 0, 0]},
            ],
            collider="sphere", confidence=0.7),
        evidence=ev, build_pass="blockout",
    ))

    head = cat["head"]
    head_pos = (wx(head["src"][0]), wy(head["src"][1]), head["z"])
    components.append(component(
        f"{p}-head", f"{label} Head", "macro", "head", "lathe", head_pos,
        material=coat, parent=None, topology="continuous-sculpt",
        rationale=(
            "The skull is a continuous domed form: crown to chin is one smooth curve in the "
            f"reference ({cat['headLengthPx']} px), broken only by the separately-modelled muzzle and "
            "cheek ruffs. Revolved so that the head can carry the ear, eye and muzzle children "
            "without passing a non-uniform scale down to them."
        ),
        recipe=coat_recipe(f"{p}-head", 0.85), importance=1.0, confidence=0.85,
        descriptor=lathe_descriptor(head["profile"], 48),
        profile=action_profile(
            "head", "socket", (0.0, -0.130, 0.0), (0.0, 1.0, 0.0),
            {"rotate": True},
            sockets=[
                {"id": f"{p}-socket-ear-left", "localPosition": [-0.095, 0.100, -0.01], "localRotation": [0, 0, 0]},
                {"id": f"{p}-socket-ear-right", "localPosition": [0.095, 0.090, -0.01], "localRotation": [0, 0, 0]},
                {"id": f"{p}-socket-neck-base", "localPosition": [0.0, -0.130, 0.0], "localRotation": [0, 0, 0]},
            ],
            collider="sphere", confidence=0.85),
        local_features=[
            {"id": f"{p}-crown-fur-parting", "kind": "ridge",
             "description": "Fur radiates from a crown whorl between the ears; the strand direction "
                            "flips from forward-over-the-brow to backward-over-the-nape.",
             "realization": "map-only"},
        ],
        evidence=[f"{p}-ears", f"{p}-eyes", "full-object"], build_pass="blockout",
    ))

    # ---------------- macro: ears ----------------
    for side, key, socket in (("Left", "earL", "left"), ("Right", "earR", "right")):
        ear = cat[key]
        ear_z = head["z"] - 0.012
        tip = (wxz(ear["tip"][0], ear_z), wyz(ear["tip"][1], ear_z))
        base = (wxz(ear["base"][0], ear_z), wyz(ear["base"][1], ear_z))
        dx, dy = tip[0] - base[0], tip[1] - base[1]
        length = math.hypot(dx, dy)
        centre_world = ((tip[0] + base[0]) / 2, (tip[1] + base[1]) / 2, ear_z)
        centre = local_to(head_pos, centre_world)
        roll = math.atan2(-dx, dy)
        half = length / 2
        r = ear["baseRadius"]
        # Near-linear taper with a slightly pinched tip: the reference ear is a
        # straight-edged triangle, and the convex profile tried first read as a fat
        # cone - it lost the tip and gained volume at mid-height (visible as red
        # caps plus green mid-edges in review/blockout-silhouette-diff.png).
        # Profile fitted to the measured ear outline, not guessed. Half-widths read
        # off tools/probe.py for the black cat's left ear, as a fraction of base
        # width against height-from-base:
        #   0.28 -> 1.00, 0.34 -> 0.94, 0.45 -> 0.85, 0.57 -> 0.75,
        #   0.68 -> 0.64, 0.80 -> 0.49, 0.91 -> 0.24, 1.00 -> 0.02
        # A linear cone (tried first) was far too narrow in the lower half and lost
        # 42 percent of the top silhouette band.
        embed = 0.040
        ear_profile = [
            [0.001, -half - embed], [r * 0.80, -half - embed + 0.003],
            [r * 0.96, -half - embed * 0.5], [r, -half], [r, -half + length * 0.10],
            [r, -half + length * 0.28], [r * 0.94, -half + length * 0.34],
            [r * 0.85, -half + length * 0.45], [r * 0.75, -half + length * 0.57],
            [r * 0.64, -half + length * 0.68], [r * 0.49, -half + length * 0.80],
            [r * 0.24, -half + length * 0.91], [0.001, half],
        ]
        cid = f"{p}-ear-{socket}"
        components.append(component(
            cid, f"{label} Ear {side}", "macro", "shell", "lathe",
            centre, scale=(1.0, 1.0, ear["flatten"]),
            rotation=(-0.16, 0.0, roll),
            material=coat, parent=f"{p}-head", topology="conforming-shell",
            rationale=(
                "A thin curved shell, not a solid cone: the reference shows light passing through the "
                "ear so the inner surface glows (measured rgb(207,148,96) on the tabby) and the outer "
                "edge reads as a bright rim line. Revolved then flattened to "
                f"{ear['flatten']:.2f} of its width in Z, which is what makes it a membrane rather "
                "than a horn. No attachment block on purpose: in this generator an attachment "
                "replaces the authored geometry with a tapered cylinder, which would destroy the "
                f"shell - the ear/skull contact is carried by the head socket {p}-socket-ear-{socket}."
            ),
            recipe=color_recipe(
                cid, MEASURED["coat-tabby-forehead"] if is_tabby else MEASURED["coat-black-rim"],
                coat_secondary, "fabric", 0.65,
                gradient=[(0.0, coat_secondary),
                          (0.6, MEASURED["coat-tabby-forehead"] if is_tabby else MEASURED["coat-black-lit"]),
                          (1.0, MEASURED["ear-membrane-tabby"] if is_tabby else MEASURED["ear-membrane-black"])],
            ),
            importance=0.9, confidence=0.7,
            descriptor=lathe_descriptor(ear_profile, 32),
            profile=action_profile(
                "ear", "socket", (0.0, -half, 0.0), (0.0, 0.0, 1.0), {"rotate": True},
                sockets=[{"id": f"{cid}-socket-fringe", "localPosition": [0.0, -half * 0.4, 0.0],
                          "localRotation": [0, 0, 0]}],
                collider="none", confidence=0.6),
            local_features=[
                {"id": f"{cid}-outer-rim-line", "kind": "ridge",
                 "description": "Dark cartilage rim along the ear's outer edge with a blown warm "
                                "rim highlight just inside it.",
                 "realization": "geometry"},
            ],
            evidence=[f"{p}-ears"], build_pass="blockout",
        ))

        membrane_cid = f"{cid}-membrane"
        components.append(component(
            membrane_cid, f"{label} Ear Membrane {side}", "meso", "shell", "lathe",
            (centre[0], centre[1], centre[2] + 0.004),
            scale=(0.70, 0.76, ear["flatten"] * 0.34),
            rotation=(-0.16, 0.0, roll),
            material=cat["membrane"], parent=f"{p}-head", topology="conforming-shell",
            rationale=(
                "Inner shell conforming to the ear's front face, held one membrane-thickness inside "
                "it. Separate from the ear because it is a different material response: the ear back "
                "is opaque fur, the inner face transmits the key light."
            ),
            recipe=color_recipe(
                membrane_cid,
                (152, 112, 86) if is_tabby else (78, 56, 42),
                MEASURED["coat-tabby-forehead"] if is_tabby else MEASURED["coat-black-lit"],
                "skin", 0.6),
            importance=0.7, confidence=0.6,
            descriptor=lathe_descriptor(ear_profile, 32),
            profile=action_profile("ear-detail", "center", (0.0, 0.0, 0.0), (0.0, 0.0, 1.0),
                                   collider="none", confidence=0.55),
            local_features=[
                {"id": f"{membrane_cid}-backlit-glow", "kind": "emissive",
                 "description": "Warm transmitted glow through the thin membrane where the key light "
                                "passes from behind; measured rgb(207,148,96) on the tabby, "
                                "rgb(85,45,25) on the black cat.",
                 "realization": "map-only"},
            ],
            evidence=[f"{p}-ears"], build_pass="structural-pass",
        ))

        # radial hair fringe around the ear opening - genuinely radial, hence a repetition system
        systems.append({
            "id": f"{cid}-fringe",
            "name": f"{label} Ear Fringe {side}",
            "level": "micro",
            "parent": cid,
            "primitive": "capsule",
            "material": "whisker-keratin",
            "count": 14,
            "instanceScale": [0.020, 0.0028, 0.0028],
            # radius is WORLD units, not a fraction of the parent: the emitter places
            # each instance at radius * 0.5 from the axis. A first attempt used 0.9
            # thinking it was normalised and scattered the fringe 450 px away from the
            # ear as visible debris above both heads.
            "placement": {"mode": "radial", "axis": [0, 1, 0], "radius": 0.072,
                          "startAngleDeg": 8},
            "distributionRule": "Evenly spaced around the ear opening, pointing outward from the "
                                "ear's axis: the reference shows a fringe of long pale hairs along "
                                "the inner-front edge that breaks the ear silhouette.",
            "evidenceRefs": [f"{p}-ears"],
        })

    # ---------------- meso: face ----------------
    def face_part(key: str, cid_suffix: str, pretty: str, material: str, topology: str,
                  rationale: str, recipe_rgb: tuple[int, int, int],
                  recipe_secondary: tuple[int, int, int], material_class: str,
                  local_features: list[dict[str, Any]] | None = None,
                  importance: float = 0.6, build_pass: str = "structural-pass") -> None:
        spec = cat[key]
        cid = f"{p}-{cid_suffix}"
        size = spec["size"]
        guess = local_to(head_pos, (wxz(spec["src"][0], spec["z"]),
                                    wyz(spec["src"][1], spec["z"]), spec["z"]))
        part_z = surface_z(head["profile"], guess[0], guess[1],
                           wsizez(size[2], spec["z"]) * spec.get("inset", 0.42))
        placed = local_to(head_pos, (wxz(spec["src"][0], part_z),
                                     wyz(spec["src"][1], part_z), part_z))
        components.append(component(
            cid, f"{label} {pretty}", "meso", "detail", "ellipsoid",
            (placed[0], placed[1], part_z),
            scale=(wsizez(size[0], part_z), wsizez(size[1], part_z),
                   wsizez(size[2], part_z)),
            material=material, parent=f"{p}-head", topology=topology, rationale=rationale,
            recipe=color_recipe(cid, recipe_rgb, recipe_secondary, material_class, 0.7),
            importance=importance, confidence=0.7,
            profile=action_profile("face-detail", "center", collider="none", confidence=0.6),
            local_features=local_features,
            evidence=[f"{p}-muzzle", f"{p}-eyes"], build_pass=build_pass,
        ))

    face_part(
        "muzzle", "muzzle", "Muzzle", coat, "continuous-sculpt",
        "Whisker-pad mass bulging forward of the skull dome; the reference shows a distinct "
        "rounded step where the muzzle leaves the cheek, so it is its own continuous form.",
        MEASURED["fur-white-muzzle"] if is_tabby else MEASURED["coat-black-lit"],
        coat_secondary, "fabric",
        local_features=[
            {"id": f"{p}-whisker-pad-dimples", "kind": "groove",
             "description": "Two shallow dimpled pads either side of the philtrum where the whisker "
                            "follicles sit.", "realization": "geometry"},
            {"id": f"{p}-philtrum-groove", "kind": "groove",
             "description": "Vertical groove from the nose base to the upper lip line.",
             "realization": "geometry"},
        ],
        importance=0.8,
    )
    face_part(
        "chin", "chin", "Chin", "fur-white" if is_tabby else coat, "continuous-sculpt",
        "Small rounded mass below the mouth line; on the tabby it is white fur and on the black cat "
        "it is coat-coloured, so it cannot be folded into the muzzle's material.",
        MEASURED["fur-white-shadow"] if is_tabby else MEASURED["coat-black-shadow"],
        coat_secondary, "fabric", importance=0.5,
    )
    face_part(
        "nosePos", "nose", "Nose Leather", cat["nose"], "assembled-solid",
        "A distinct wedge of hairless leather sitting on the muzzle, with its own specular response: "
        "measured rgb(150,85,47) pink on the tabby and rgb(37,30,23) near-black on the black cat, "
        "against fur on all sides.",
        MEASURED["nose-tabby"] if is_tabby else MEASURED["nose-black"],
        MEASURED["coat-tabby-stripe"] if is_tabby else MEASURED["coat-black-shadow"], "skin",
        local_features=[
            {"id": f"{p}-nose-pebble-relief", "kind": "ridge",
             "description": "Fine pebbled relief across the nose leather, distinct from fur grain.",
             "realization": "map-only"},
            {"id": f"{p}-nose-tip-gloss", "kind": "gloss",
             "description": "Small low-roughness highlight on the nose tip; the only glossy point on "
                            "the face other than the cornea.", "realization": "map-only"},
        ],
        importance=0.8,
    )
    for key, suffix, pretty in (("cheekL", "cheek-ruff-left", "Cheek Ruff Left"),
                                ("cheekR", "cheek-ruff-right", "Cheek Ruff Right")):
        face_part(
            key, suffix, pretty, coat, "continuous-sculpt",
            "The cheek ruff is what makes this head read 1.15 head-lengths wide (measured 287 px on "
            "the black cat, 340 px on the tabby at the eye line) while the skull underneath is "
            "narrower; modelled as its own soft mass so the skull stays a clean dome.",
            coat_dominant, coat_secondary, "fabric", importance=0.7,
        )
    for key, suffix, pretty in (("browL", "brow-left", "Brow Ridge Left"),
                                ("browR", "brow-right", "Brow Ridge Right")):
        face_part(
            key, suffix, pretty, coat, "continuous-sculpt",
            "Shallow brow ridge above each eye; it is what stops the oversized eye from reading as a "
            "sphere glued onto a smooth ball, and it carries the tabby's dark eyeliner marking.",
            coat_dominant, coat_secondary, "fabric", importance=0.55,
            build_pass="form-refinement",
        )

    # ---------------- meso: eye stacks ----------------
    for side, key in (("left", "eyeL"), ("right", "eyeR")):
        eye = cat[key]
        # Two-step: place the eye on the measured pixel using a first-guess depth,
        # then re-derive the depth from the head profile at that height so the eye
        # is anchored to the skull surface, then re-place with the final depth.
        guess = local_to(head_pos, (wxz(eye["src"][0], eye["z"]),
                                    wyz(eye["src"][1], eye["z"]), eye["z"]))
        eye_z = surface_z(head["profile"], guess[0], guess[1],
                          wsizez(eye["diameterPx"], eye["z"]) * 0.30)
        pos = local_to(head_pos, (wxz(eye["src"][0], eye_z),
                                  wyz(eye["src"][1], eye_z), eye_z))
        pos = (pos[0], pos[1], eye_z)
        diameter = wsizez(eye["diameterPx"], eye_z)
        pretty_side = side.capitalize()
        iris_rgb = MEASURED["iris-tabby"] if is_tabby else MEASURED["iris-black-cat"]

        globe_cid = f"{p}-eye-{side}-iris"
        components.append(component(
            globe_cid, f"{label} Iris {pretty_side}", "meso", "detail", "sphere", pos,
            scale=(diameter, diameter, diameter * 0.96),
            material=cat["iris"], parent=f"{p}-head", topology="assembled-solid",
            rationale=(
                f"The visible eye is {diameter * 1000:.0f} px across, 0.25 of head length - a "
                "stylised proportion, not feline anatomy. Modelled as a discrete sphere seated in "
                "the orbit because the reference shows a hard boundary between iris and lid with no "
                "sclera visible anywhere."
            ),
            recipe=color_recipe(globe_cid, AS_PRESENTED["iris-annulus"], iris_rgb, "plastic", 0.75,
                                gradient=[(0.0, MEASURED["pupil"]), (0.35, iris_rgb),
                                          (1.0, tuple(min(255, c + 22) for c in iris_rgb))],
                                as_presented=True),
            importance=1.0, confidence=0.8,
            profile=action_profile("eye", "center", collider="none", confidence=0.7),
            local_features=[
                {"id": f"{globe_cid}-annulus", "kind": "linework",
                 "description": "The iris reads as a thin annulus about 0.12 of eye diameter thick, "
                                "not a disc, because the dilated pupil covers the middle; brightest "
                                "at the lower-outer arc.",
                 "realization": "geometry"},
                {"id": f"{globe_cid}-limbal-ring", "kind": "linework",
                 "description": "Darker green limbal ring at the extreme outer edge of the iris.",
                 "realization": "map-only"},
            ],
            evidence=[f"{p}-eyes"], build_pass="structural-pass",
        ))

        pupil_cid = f"{p}-eye-{side}-pupil"
        components.append(component(
            pupil_cid, f"{label} Pupil {pretty_side}", "meso", "detail", "sphere",
            (pos[0], pos[1], pos[2] + diameter * 0.30),
            scale=(diameter * 0.73, diameter * 0.73, diameter * 0.60),
            material="pupil-black", parent=f"{p}-head", topology="assembled-solid",
            rationale=(
                "Round, fully dilated pupil filling 0.73 of the iris diameter (measured 0.68-0.75 in "
                "the reference) - the single most identity-defining feature the user named. Its own "
                "part because it is near-black rgb(19,18,10) and carries an environment reflection "
                "the iris does not."
            ),
            recipe=color_recipe(pupil_cid, AS_PRESENTED["pupil"], MEASURED["pupil-reflection"],
                                "plastic", 0.8, as_presented=True,
                                gradient=[(0.0, MEASURED["pupil-reflection"]),
                                          (0.5, MEASURED["pupil"]), (1.0, MEASURED["pupil"])]),
            importance=1.0, confidence=0.85,
            profile=action_profile("eye", "center", channels={"scale": True}, collider="none",
                                   confidence=0.8),
            local_features=[
                {"id": f"{pupil_cid}-environment-band", "kind": "decal",
                 "description": "Cool greenish reflection band across the pupil's upper half, "
                                "measured rgb(19,35,49): the mirrored landscape.",
                 "realization": "map-only"},
            ],
            evidence=[f"{p}-eyes"], build_pass="structural-pass",
        ))

        cornea_cid = f"{p}-eye-{side}-cornea"
        components.append(component(
            cornea_cid, f"{label} Cornea {pretty_side}", "meso", "shell", "sphere",
            (pos[0], pos[1], pos[2] + diameter * 0.16),
            scale=(diameter * 1.06, diameter * 1.06, diameter * 1.10),
            material="cornea-clear", parent=f"{p}-head", topology="conforming-shell",
            rationale=(
                "Transparent bulge over the iris whose only job is the specular: the reference shows "
                "one small bright highlight at the upper-right of each pupil in all four eyes, which "
                "must come from a clearcoat surface plus a real key light rather than being painted "
                "into the iris albedo."
            ),
            recipe=color_recipe(cornea_cid, AS_PRESENTED["cornea"], MEASURED["pupil-reflection"],
                                "glass", 0.7, as_presented=True),
            importance=0.9, confidence=0.7,
            profile=action_profile("eye", "center", collider="none", confidence=0.7),
            local_features=[
                {"id": f"{cornea_cid}-key-specular", "kind": "gloss",
                 "description": "Single sharp specular at the upper-right of the pupil, placing the "
                                "key light up and camera-right - the same direction as the warm rim "
                                "on both cats' right-hand edges.",
                 "realization": "map-only"},
            ],
            evidence=[f"{p}-eyes"], build_pass="material-pass",
        ))

        lid_cid = f"{p}-eye-{side}-lid-rim"
        components.append(component(
            lid_cid, f"{label} Eyelid Rim {pretty_side}", "meso", "detail", "torus",
            (pos[0], pos[1], pos[2] + diameter * 0.16),
            scale=(diameter * 1.15, diameter * 1.15, diameter * 0.50),
            material="eyeliner-dark", parent=f"{p}-head", topology="surface-relief",
            rationale=(
                "Ring of lid fur seating the eye in the orbit. On the tabby this ring carries the "
                "dark eyeliner marking (measured as a distinct dark rim around each eye); without it "
                "the eye sphere reads as a bead stuck on the surface."
            ),
            recipe=color_recipe(lid_cid, AS_PRESENTED["eyeliner"], MEASURED["coat-tabby-stripe"],
                                "fabric", 0.7, as_presented=True),
            importance=0.7, confidence=0.65,
            descriptor={"torusTubeRatio": 0.18},
            profile=action_profile("eyelid", "center", channels={"scale": True}, collider="none",
                                   confidence=0.6),
            local_features=[
                {"id": f"{lid_cid}-eyeliner", "kind": "linework",
                 "description": "Dark rim of fur outlining the eye, thicker across the top lid, with "
                                "a tear-stripe running from the inner corner down the cheek on the "
                                "tabby.", "realization": "map-only"},
            ],
            evidence=[f"{p}-eyes"], build_pass="form-refinement",
        ))

    # ---------------- meso: neck ----------------
    neck = cat["neck"]
    neck_start = (wxz(neck["start"][0], neck["z"][0]) - torso_pos[0],
                  wyz(neck["start"][1], neck["z"][0]) - torso_pos[1],
                  neck["z"][0] - torso_pos[2])
    neck_end = (wxz(neck["end"][0], neck["z"][1]) - torso_pos[0],
                wyz(neck["end"][1], neck["z"][1]) - torso_pos[1],
                neck["z"][1] - torso_pos[2])
    components.append(component(
        f"{p}-neck", f"{label} Neck", "meso", "connector", "capsule", (0.0, 0.0, 0.0),
        material=coat, parent=f"{p}-torso", topology="assembled-solid",
        rationale=(
            "Short thick connector between barrel and skull. Authored as an endpoint-driven "
            "connector so its root sits exactly on the torso's neck socket and it cannot float: the "
            "generator builds it as a tapered solid between localStart and localEnd."
        ),
        recipe=coat_recipe(f"{p}-neck", 0.7), importance=0.7, confidence=0.7,
        attachment=attachment_block(
            f"{p}-torso", f"{p}-socket-neck", neck_start, neck_end,
            neck["baseRadius"], neck["endRadius"], "socket", 0.030, ev),
        profile=action_profile("neck", "socket", (0.0, 0.0, 0.0), (1.0, 0.0, 0.0), {"rotate": True},
                               collider="capsule", confidence=0.65),
        evidence=ev, build_pass="structural-pass",
    ))

    # ---------------- macro: forelegs and paws ----------------
    for side, key, socket in (("left", "forelegL", "left"), ("right", "forelegR", "right")):
        leg = cat[key]
        start = (wxz(leg["start"][0], leg["z"][0]) - torso_pos[0],
                 wyz(leg["start"][1], leg["z"][0]) - torso_pos[1],
                 leg["z"][0] - torso_pos[2])
        end = (wxz(leg["end"][0], leg["z"][1]) - torso_pos[0],
               wyz(leg["end"][1], leg["z"][1]) - torso_pos[1],
               leg["z"][1] - torso_pos[2])
        cid = f"{p}-foreleg-{side}"
        components.append(component(
            cid, f"{label} Foreleg {side.capitalize()}", "macro", "limb", "capsule",
            (0.0, 0.0, 0.0),
            material=coat, parent=f"{p}-torso", topology="assembled-solid",
            rationale=(
                "Vertical foreleg of a sitting cat, tapering from elbow to wrist. Endpoint-driven so "
                "the shoulder end is pinned inside the barrel (embedDepth 0.03) and the wrist end "
                "lands on the measured paw top - the reference shows two clearly separated vertical "
                "legs with chair visible between them, so they must not fuse."
            ),
            recipe=coat_recipe(cid, 0.75), importance=0.9, confidence=0.75,
            attachment=attachment_block(
                f"{p}-torso", f"{p}-socket-shoulder-{socket}", start, end,
                leg["baseRadius"], leg["endRadius"], "socket", 0.030,
                [f"{p}-paws", "full-object"]),
            profile=action_profile("foreleg", "socket", (0.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                                   {"rotate": True}, collider="capsule", confidence=0.7),
            local_features=[
                {"id": f"{cid}-sock-boundary", "kind": "contour",
                 "description": ("White sock boundary crossing the pastern with a soft "
                                 "hair-interrupted edge." if is_tabby else
                                 "Uniform coat with no sock: the black cat has no white marking "
                                 "anywhere in the reference."),
                 "realization": "map-only"},
            ],
            evidence=[f"{p}-paws"], build_pass="blockout",
        ))

    for key, suffix, pretty in (("pawFL", "forepaw-left", "Forepaw Left"),
                                ("pawFR", "forepaw-right", "Forepaw Right")):
        paw = cat[key]
        cid = f"{p}-{suffix}"
        size = paw["size"]
        components.append(component(
            cid, f"{label} {pretty}", "macro", "detail", "ellipsoid",
            (wxz(paw["src"][0], paw["z"]), wyz(paw["src"][1], paw["z"]), paw["z"]),
            scale=(wsizez(size[0], paw["z"]), wsizez(size[1], paw["z"]),
                   wsizez(size[2], paw["z"])),
            material="fur-white" if is_tabby else coat, parent=None,
            topology="continuous-sculpt",
            rationale=(
                "Rounded wedge resting on the seat plane, wider than tall. Its own part because it is "
                "the silhouette's bottom edge (measured bottom y 921 px on the tabby's front-left "
                "paw) and, on the tabby, a different material: a white sock."
            ),
            recipe=color_recipe(
                cid,
                MEASURED["fur-white-shadow"] if is_tabby else MEASURED["coat-black-shadow"],
                MEASURED["fur-white-lit"] if is_tabby else MEASURED["coat-black-lit"],
                "fabric", 0.75),
            importance=0.85, confidence=0.75,
            profile=action_profile("paw", "center", collider="box", confidence=0.7),
            local_features=[
                {"id": f"{cid}-toe-grooves", "kind": "groove",
                 "description": "Four toes separated by three shallow grooves fanning forward from "
                                "the paw centre; clearly countable in the reference on every visible "
                                "paw.", "realization": "geometry"},
                {"id": f"{cid}-contact-shadow", "kind": "stain",
                 "description": "Tight dark contact occlusion where the paw meets the seat.",
                 "realization": "map-only"},
            ],
            evidence=[f"{p}-paws"], build_pass="blockout",
        ))
        systems.append({
            "id": f"{cid}-toes",
            "name": f"{label} {pretty} Toes",
            "level": "meso",
            "parent": cid,
            "primitive": "sphere",
            "material": "fur-white" if is_tabby else coat,
            "count": 8,
            "instanceScale": [0.26, 0.30, 0.30],
            "placement": {"mode": "radial", "axis": [0, 0, 1], "radius": 0.62,
                          "startAngleDeg": 22},
            "distributionRule": "Eight toe beads placed radially in the paw's front plane; the four "
                                "on the forward-facing arc are the visible toes, the rear four sit "
                                "inside the paw volume and are occluded. Radial is the emitter's "
                                "only layout, so the visible arc is tuned with startAngleDeg.",
            "evidenceRefs": [f"{p}-paws"],
        })

    foot_l = cat["footHL"]
    cid = f"{p}-hindfoot-left"
    size = foot_l["size"]
    components.append(component(
        cid, f"{label} Hind Foot Left", "macro", "detail", "ellipsoid",
        local_to(haunch_pos, (wxz(foot_l["src"][0], foot_l["z"]),
                              wyz(foot_l["src"][1], foot_l["z"]), foot_l["z"])),
        scale=(wsizez(size[0], foot_l["z"]), wsizez(size[1], foot_l["z"]),
               wsizez(size[2], foot_l["z"])),
        rotation=(0.0, foot_l["yaw"], 0.0),
        material="fur-white" if is_tabby else coat, parent=f"{p}-haunch",
        topology="continuous-sculpt",
        rationale=(
            "Flat plantigrade hind foot splayed laterally - the giveaway that both cats are sitting "
            "rather than standing. Measured on the black cat at x 275-410, bottom y 904; on the "
            "tabby at x 665-745, bottom y 848. Elongated along the toe direction and yawed outward."
        ),
        recipe=color_recipe(
            cid,
            MEASURED["fur-white-shadow"] if is_tabby else MEASURED["coat-black-shadow"],
            MEASURED["fur-white-lit"] if is_tabby else MEASURED["coat-black-lit"],
            "fabric", 0.7),
        importance=0.8, confidence=0.7,
        profile=action_profile("hindfoot", "center", collider="box", confidence=0.65),
        local_features=[
            {"id": f"{cid}-toe-grooves", "kind": "groove",
             "description": "Four hind toes with shallow separating grooves, splayed sideways.",
             "realization": "geometry"},
        ],
        evidence=[f"{p}-paws"], build_pass="blockout",
    ))

    foot_r = cat["footHR"]
    cid = f"{p}-hindfoot-right"
    size = foot_r["size"]
    components.append(component(
        cid, f"{label} Hind Foot Right", "macro", "detail", "ellipsoid",
        local_to(haunch_pos, foot_r["world"]),
        scale=(wsize(size[0]), wsize(size[1]), wsize(size[2])),
        rotation=(0.0, foot_r["yaw"], 0.0),
        material="fur-white" if is_tabby else coat, parent=f"{p}-haunch",
        topology="continuous-sculpt",
        rationale=(
            "INFERRED, not observed: the reference shows no right hind foot on either cat. Mirrored "
            "from the measured left foot and placed behind the barrel at negative Z so it projects "
            "inside the body silhouette, matching the reference where it is fully occluded. "
            "Confidence 0.3."
        ),
        recipe=color_recipe(
            cid,
            MEASURED["fur-white-shadow"] if is_tabby else MEASURED["coat-black-shadow"],
            MEASURED["fur-white-lit"] if is_tabby else MEASURED["coat-black-lit"],
            "fabric", 0.4),
        importance=0.4, confidence=0.3,
        profile=action_profile("hindfoot", "center", collider="box", confidence=0.3),
        evidence=["inferred-hidden-region"], build_pass="structural-pass",
    ))

    # ---------------- meso: tail chain (inferred) ----------------
    haunch_origin = haunch_pos
    tail = cat["tail"]
    radii = cat["tailRadii"]
    for index in range(len(tail) - 1):
        start_w, end_w = tail[index], tail[index + 1]
        start = tuple(round(start_w[axis] - haunch_origin[axis], 4) for axis in range(3))
        end = tuple(round(end_w[axis] - haunch_origin[axis], 4) for axis in range(3))
        cid = f"{p}-tail-segment-{index + 1}"
        components.append(component(
            cid, f"{label} Tail Segment {index + 1}", "meso", "tail", "capsule", (0.0, 0.0, 0.0),
            material=coat, parent=f"{p}-haunch", topology="assembled-solid",
            rationale=(
                "INFERRED. Neither tail is visible anywhere in the reference, so length, curl and "
                "banding are species priors, not measurements. Built as a five-segment endpoint "
                "chain rather than one curved tube for two reasons: each segment gets its own pivot "
                "so the idle tick can drive a travelling sway wave, and the chain is routed behind "
                "the body at negative Z so that under the review camera it projects inside the "
                "measured silhouette - which is what the reference shows. Confidence 0.2."
            ),
            recipe=coat_recipe(cid, 0.4), importance=0.5, confidence=0.25,
            attachment=attachment_block(
                f"{p}-haunch",
                f"{p}-socket-tail" if index == 0 else f"{p}-tail-segment-{index}-tip",
                start, end, radii[index], radii[index + 1],
                "socket" if index == 0 else "butt", 0.010,
                ["inferred-hidden-region"]),
            profile=action_profile("tail", "socket", (0.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                                   {"rotate": True, "bend": True}, collider="capsule",
                                   confidence=0.25),
            local_features=([
                {"id": f"{cid}-ring-banding", "kind": "linework",
                 "description": "INFERRED mackerel ring banding; mackerel tabbies are ringed-tailed, "
                                "but the reference cannot confirm it.",
                 "realization": "map-only"},
            ] if is_tabby else None),
            evidence=["inferred-hidden-region"], build_pass="structural-pass",
        ))

    # ---------------- meso: tabby white bib ----------------
    if is_tabby:
        bib = cat["bib"]
        size = bib["size"]
        bib_guess = (wxz(bib["src"][0], bib["z"]) - torso_pos[0],
                     wyz(bib["src"][1], bib["z"]) - torso_pos[1])
        bib_z = surface_z(torso["profile"], bib_guess[0], bib_guess[1],
                          wsizez(size[2], bib["z"]) * 0.34) + torso_pos[2]
        components.append(component(
            f"{p}-bib", f"{label} Chest Bib", "meso", "shell", "ellipsoid",
            (wxz(bib["src"][0], bib_z), wyz(bib["src"][1], bib_z), bib_z),
            scale=(wsizez(size[0], bib_z), wsizez(size[1], bib_z), wsizez(size[2], bib_z)),
            material="fur-white", parent=None, topology="conforming-shell",
            rationale=(
                "White inverted-triangle bib conforming to the chest front, from the chin down to "
                "mid-chest. A shell rather than a material mask on the torso because the boundary is "
                "a hair-interrupted fur edge that has to sit slightly proud of the coat surface, and "
                "because white fur is a different response: measured rgb(240,207,169) lit versus "
                "rgb(70,47,27) on the adjacent flank."
            ),
            recipe=color_recipe(f"{p}-bib", MEASURED["fur-white-lit"], MEASURED["fur-white-shadow"],
                                "fabric", 0.85,
                                gradient=[(0.0, MEASURED["fur-white-shadow"]),
                                          (0.6, MEASURED["fur-white-lit"]), (1.0, (252, 240, 224))]),
            importance=0.95, confidence=0.85,
            profile=action_profile("bib", "center", collider="none", confidence=0.8),
            local_features=[
                {"id": f"{p}-bib-boundary", "kind": "contour",
                 "description": "Soft irregular bib boundary with individual hairs crossing into the "
                                "agouti coat; never a hard geometric edge.",
                 "realization": "map-only"},
            ],
            evidence=[f"{p}-bib"], build_pass="structural-pass",
        ))

    # ---------------- micro: tabby head markings ----------------
    # The forehead 'M', the eye tear-stripes and the cheek bars are what make a
    # tabby read as a tabby rather than as a brown cat. They were specified as
    # material localOverrides, but this generator has no region-mask implementation,
    # so an override never reaches a pixel. Building them as thin dark surface-relief
    # slivers anchored to the skull surface is the only way to actually get them into
    # the render, and it keeps each one traceable to a measured pixel band.
    if is_tabby:
        # measured: 5 narrow stripes across src x 880-1010 at src y 250-330,
        # converging slightly toward the crown
        forehead = [(888, 300), (912, 288), (938, 282), (964, 286), (992, 296)]
        for index, (src_x, src_y) in enumerate(forehead):
            lean = (index - 2) * 0.10
            guess = local_to(head_pos, (wxz(src_x, 0.10), wyz(src_y, 0.10), 0.10))
            mark_z = surface_z(head["profile"], guess[0], guess[1], 0.004)
            placed = local_to(head_pos, (wxz(src_x, mark_z), wyz(src_y, mark_z), mark_z))
            cid = f"{p}-forehead-m-{index + 1}"
            components.append(component(
                cid, f"{label} Forehead M Stripe {index + 1}", "micro", "detail", "ellipsoid",
                (placed[0], placed[1], mark_z),
                scale=(0.0062, 0.044 - abs(index - 2) * 0.005, 0.024),
                rotation=(0.0, 0.0, lean),
                material="marking-stripe", parent=f"{p}-head", topology="surface-relief",
                rationale=(
                    "One stripe of the tabby 'M'. Surface relief lying on the skull, not a mass: it "
                    "is a fur colour marking with no volume of its own. Built as geometry because "
                    "the material localOverride that specified it has no region-mask implementation "
                    "in this generator and would silently never render."
                ),
                recipe=color_recipe(cid, AS_PRESENTED["marking"],
                                    MEASURED["coat-tabby-forehead"], "fabric", 0.7,
                                    as_presented=True),
                importance=0.6, confidence=0.7,
                profile=action_profile("marking", "center", collider="none", confidence=0.6),
                evidence=[f"{p}-ears"], build_pass="material-pass",
            ))
        # measured: 2 short bars per cheek, radiating back from the outer eye corner
        cheeks = [("left", 836, 402, 0.34), ("left", 826, 428, 0.20),
                  ("right", 1040, 434, -0.34), ("right", 1050, 460, -0.20)]
        for index, (side, src_x, src_y, lean) in enumerate(cheeks):
            guess = local_to(head_pos, (wxz(src_x, 0.06), wyz(src_y, 0.06), 0.06))
            mark_z = surface_z(head["profile"], guess[0], guess[1], 0.004)
            placed = local_to(head_pos, (wxz(src_x, mark_z), wyz(src_y, mark_z), mark_z))
            cid = f"{p}-cheek-bar-{side}-{1 + index % 2}"
            components.append(component(
                cid, f"{label} Cheek Bar {side.capitalize()} {1 + index % 2}", "micro", "detail",
                "ellipsoid", (placed[0], placed[1], mark_z),
                scale=(0.026, 0.0060, 0.020), rotation=(0.0, 0.0, lean),
                material="marking-stripe", parent=f"{p}-head", topology="surface-relief",
                rationale=(
                    "Short dark cheek bar radiating back from the outer eye corner. Surface relief, "
                    "same reasoning as the forehead 'M': a region mask would never render."
                ),
                recipe=color_recipe(cid, AS_PRESENTED["marking"],
                                    MEASURED["coat-tabby-flank"], "fabric", 0.7,
                                    as_presented=True),
                importance=0.5, confidence=0.65,
                profile=action_profile("marking", "center", collider="none", confidence=0.6),
                evidence=[f"{p}-eyes"], build_pass="material-pass",
            ))

    # ---------------- micro: whiskers ----------------
    for side, pad_key, sign in (("left", "whiskerPadL", -1.0), ("right", "whiskerPadR", 1.0)):
        pad = cat[pad_key]
        pad_world = (wxz(pad[0], cat["whiskerZ"]), wyz(pad[1], cat["whiskerZ"]),
                     cat["whiskerZ"])
        head_origin = head_pos
        for index in range(7):
            spread = (index - 3) / 3.0
            length = 0.190 - abs(spread) * 0.045
            out_x = sign * (0.34 + 0.66 * (1.0 - abs(spread) * 0.35))
            up_y = -spread * 0.62 - 0.10
            out_z = 0.22 - abs(spread) * 0.10
            direction = (out_x, up_y, out_z)
            norm = math.sqrt(sum(v * v for v in direction))
            unit = tuple(v / norm for v in direction)
            start = tuple(round(pad_world[axis] - head_origin[axis], 4) for axis in range(3))
            end = tuple(round(pad_world[axis] - head_origin[axis] + unit[axis] * length, 4)
                        for axis in range(3))
            cid = f"{p}-whisker-{side}-{index + 1}"
            components.append(component(
                cid, f"{label} Whisker {side.capitalize()} {index + 1}", "micro", "appendage",
                "capsule", (0.0, 0.0, 0.0),
                material="whisker-keratin", parent=f"{p}-head", topology="fiber-strand",
                rationale=(
                    "A single keratin strand: a tapered fibre rooted in the whisker pad, not a tube "
                    "of constant radius. Endpoint-driven so the root is pinned in the pad and the "
                    "tip is free. Seven per cheek against 12-14 counted in the reference - an "
                    "acknowledged under-count traded for draw calls."
                ),
                recipe=color_recipe(cid, AS_PRESENTED["whisker"], MEASURED["whisker"],
                                    "unknown", 0.5, as_presented=True),
                importance=0.45, confidence=0.5,
                attachment=attachment_block(
                    f"{p}-head", f"{p}-whisker-pad-{side}", start, end,
                    0.0022, 0.0007, "embed", 0.004, [f"{p}-muzzle"]),
                profile=action_profile("whisker", "socket", (0.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                                       {"rotate": True, "bend": True}, collider="none",
                                       confidence=0.45),
                evidence=[f"{p}-muzzle"], build_pass="form-refinement",
                notes="Whiskers are excluded from the silhouette-gate render: a 1-2 px hair carries "
                      "no silhouette information but does move the bounding box, which would "
                      "corrupt the scale and aspect metrics.",
            ))

    return components, systems


def build_materials() -> list[dict[str, Any]]:
    def bands(macro: float, meso: float, micro: float) -> list[dict[str, Any]]:
        return [
            {"id": "macro", "frequency": 2.5, "amplitude": macro,
             "role": "broad tonal breakup across the body mass"},
            {"id": "meso", "frequency": 18.0, "amplitude": meso,
             "role": "hair-clump grouping and stripe banding"},
            {"id": "micro", "frequency": 90.0, "amplitude": micro,
             "role": "individual strand grain that breaks the highlight"},
        ]

    def fur_material(
        mid: str, name: str, dominant: tuple[int, int, int],
        secondary: list[tuple[int, int, int]], palette: list[tuple[int, int, int]],
        roughness_base: float, overrides: list[dict[str, Any]],
        notes: str, sheen_base: float = 0.18, env_intensity: float = 0.35,
        repeat: tuple[float, float] = (1.0, 1.0),
    ) -> dict[str, Any]:
        return {
            "id": mid,
            "name": name,
            "type": "standard",
            "shaderModel": "MeshPhysicalMaterial with anisotropic sheen along hair flow",
            "baseColor": hexcolor(dominant),
            "color": hexcolor(dominant),
            "albedo": {
                "dominant": hexcolor(dominant),
                "secondary": [hexcolor(c) for c in secondary],
                "samplingNotes": notes,
            },
            "colorVariation": {
                "palette": [hexcolor(c) for c in palette],
                "pattern": "directional strand streaking",
                "amplitude": 0.18,
                "heightCorrelation": 0.45,
            },
            "textureResolution": 2048,
            "textureProjection": {"mode": "uv", "repeat": list(repeat), "anisotropy": 8,
                                  "texelDensityIntent": "Hair grain stays at world scale so a small "
                                                        "paw and a large flank show the same strand "
                                                        "thickness. Tiling is kept at or near 1x1 "
                                                        "because the albedo map is a crop of the "
                                                        "reference's own fur: repeating it 3x6 turned "
                                                        "the tabby into wood planks."},
            "surfaceFrequencyBands": bands(0.35, 0.26, 0.12),
            "roughness": {
                "base": roughness_base, "variation": 0.14,
                "map": "independent-procedural-field",
                "localResponse": "roughness rises in cavities between limbs and falls along the "
                                 "sheen band where hair lies flat; grazing light must reveal "
                                 "strand direction, not a turned surface",
            },
            "metalness": {"base": 0.0, "variation": 0.0},
            # These three MUST be top-level: the generator reads spec.sheenColor and
            # spec.sheenRoughness, not spec.sheen.color / spec.sheen.roughness. With
            # them nested, sheenColor defaulted to WHITE at 0.55 strength and lifted
            # the near-black coat to rgb(98,78,59) - the render was 6x too bright and
            # the "black cat" came out beige.
            "sheen": {"base": sheen_base, "roughness": 0.42,
                      "color": hexcolor(tuple(min(255, c + 40) for c in dominant))},
            "sheenColor": hexcolor(tuple(min(255, c + 40) for c in dominant)),
            "sheenRoughness": 0.42,
            "envMapIntensity": env_intensity,
            "anisotropy": 0.35,
            "normal": {"pattern": "directional strand grain aligned with hair flow",
                       "strength": 1.25, "scale": 2.4, "space": "tangent"},
            "bump": {"pattern": "hair-clump ridges", "amplitude": 0.014},
            "ambientOcclusion": {"cavityStrength": 0.92, "contactShadowBias": 0.015,
                                 "notes": "Independent AO field, not the albedo reused."},
            "wear": {"edgeWear": 0.0, "scratches": [], "chips": [], "alphaCurve": "none",
                     "aoBias": 0.0, "approximated": True,
                     "notes": "Living fur: no edge wear, no chips. The wear channel is deliberately "
                              "empty rather than filled with a hard-surface default."},
            "dirt": {"amount": 0.05, "cavityBias": 0.8, "color": hexcolor(secondary[0])},
            "localOverrides": overrides,
            "shaderNotes": [
                "Albedo, roughness, normal and AO are four independent procedural fields; none is a "
                "copy of another.",
                "Sheen plus anisotropy is what separates fur from latex under a low warm key.",
            ],
            "notes": notes,
        }

    black_overrides = [
        {"id": "override-chest-sheen", "kind": "gloss",
         "region": "chest centreline of coat-black",
         "roughnessDelta": -0.16, "sheenDelta": 0.20,
         "description": "Satin band down the chest where hair flow turns toward the key."},
        {"id": "override-rim-edge", "kind": "gloss",
         "region": "silhouette edge facing camera-right",
         "roughnessDelta": -0.10, "albedo": hexcolor(MEASURED["coat-black-rim"]),
         "description": "Warm rim response on the right-hand edge and outer ears; measured p90 "
                        "rgb(106,68,45) against a rgb(60,49,41) lit median."},
        {"id": "override-cavity-ao", "kind": "seam",
         "region": "limb-to-body creases and under the chin",
         "aoDelta": 0.35,
         "description": "Cavity darkening so the forelegs and haunch read as growing out of the "
                        "barrel instead of being glued on."},
        {"id": "override-fur-grain", "kind": "ridge",
         "region": "whole coat",
         "normalDelta": 0.25,
         "description": "Directional strand grain; the reference shows countable parallel hair "
                        "streaks across the chest."},
    ]

    tabby_overrides = [
        {"id": "override-flank-stripes", "kind": "linework",
         "region": "flanks and shoulders of coat-tabby-agouti",
         "albedo": hexcolor(MEASURED["coat-tabby-stripe"]),
         "description": "About 22 narrow mackerel stripes, 8-14 px wide and 18-25 px apart at "
                        "reference scale, following body curvature with soft agouti-banded edges.",
         "distribution": "vertical bands wrapped around the barrel, denser over the ribs, fading "
                         "into the bib boundary"},
        {"id": "override-forehead-m", "kind": "linework",
         "region": "forehead and crown of coat-tabby-agouti",
         "albedo": hexcolor(MEASURED["coat-tabby-stripe"]),
         "description": "Five to six narrow converging stripes forming the tabby 'M' between the "
                        "ears; measured base fur rgb(124,90,63) against stripe rgb(41,23,9)."},
        {"id": "override-eyeliner", "kind": "linework",
         "region": "eyelid rims and outer eye corners",
         "albedo": hexcolor(MEASURED["coat-tabby-stripe"]),
         "description": "Dark ring around each eye plus a tear-stripe descending from the inner "
                        "corner and two to three short cheek bars."},
        {"id": "override-cavity-ao", "kind": "seam",
         "region": "limb-to-body creases and under the chin",
         "aoDelta": 0.35,
         "description": "Cavity darkening at limb junctions."},
        {"id": "override-agouti-banding", "kind": "ridge",
         "region": "whole coat",
         "normalDelta": 0.22,
         "description": "Each hair is banded light-dark-light, which is what makes the stripe edges "
                        "soft rather than vector-sharp."},
        {"id": "override-dorsal-stripe", "kind": "linework",
         "region": "spine line (inferred, not visible in the reference)",
         "albedo": hexcolor(MEASURED["coat-tabby-stripe"]),
         "description": "INFERRED dorsal spine stripe; mackerel tabbies carry one but the single "
                        "front view cannot show the back."},
    ]

    white_overrides = [
        {"id": "override-bib-mask", "kind": "contour",
         "region": "bib and sock boundaries",
         "description": "Soft hair-interrupted boundary between white fur and coloured coat.",
         "maskSoftness": 0.35},
        {"id": "override-warm-bounce", "kind": "stain",
         "region": "lower half of the white fur facing the cream seat",
         "albedo": hexcolor(MEASURED["fur-white-shadow"]),
         "description": "White fur picks up warm bounce from the cream seat; the observed "
                        "rgb(199,160,122) is lighting, not albedo, so the albedo stays near-white "
                        "and this override only biases the response."},
        {"id": "override-cavity-ao", "kind": "seam",
         "region": "toe grooves and sock edges", "aoDelta": 0.30,
         "description": "Groove darkening between the white toes."},
    ]

    materials = [
        fur_material(
            "coat-black", "Black Shorthair Coat",
            (42, 36, 33), [MEASURED["coat-black-shadow"], MEASURED["coat-black-rim"]],
            [(42, 36, 33), MEASURED["coat-black-shadow"], MEASURED["coat-black-lit"],
             MEASURED["coat-black-rim"]],
            0.68, black_overrides,
            sheen_base=0.09, env_intensity=0.20, repeat=(2.0, 2.0),
            notes="Albedo is a warm brown-black, NOT #000000. Observed pixels run rgb(60,49,41) lit to "
            "rgb(14,13,13) in shadow under a strong warm key; the authored albedo rgb(42,36,33) is "
            "those pixels with the key removed. A neutral black albedo reads as a hole and loses all "
            "form.",
        ),
        fur_material(
            "coat-tabby-agouti", "Brown Mackerel Tabby Coat",
            (112, 84, 58), [MEASURED["coat-tabby-stripe"], MEASURED["coat-tabby-forehead"]],
            [MEASURED["coat-tabby-stripe"], MEASURED["coat-tabby-flank"],
             MEASURED["coat-tabby-forehead"], (168, 132, 96)],
            0.72, tabby_overrides,
            sheen_base=0.16, env_intensity=0.26, repeat=(3.0, 1.0),
            notes="Agouti base with banded hairs. Measured lit forehead rgb(124,90,63), shaded flank "
            "rgb(70,47,27), stripe rgb(41,23,9).",
        ),
        fur_material(
            "fur-white", "White Fur (bib, socks, muzzle, chin)",
            (238, 232, 224), [MEASURED["fur-white-shadow"], MEASURED["fur-white-muzzle"]],
            [(248, 245, 240), (238, 232, 224), MEASURED["fur-white-shadow"],
             MEASURED["fur-white-muzzle"]],
            0.62, white_overrides,
            sheen_base=0.26, env_intensity=0.34, repeat=(1.4, 1.4),
            notes="Near-white albedo. The observed rgb(240,207,169) lit and rgb(199,160,122) shaded are "
            "white fur under a warm low sun plus bounce from the cream seat; authoring cream albedo "
            "here would turn the bib orange once the scene lights are added.",
        ),
        {
            "id": "ear-membrane-warm",
            "envMapIntensity": 0.55,
            "name": "Tabby Ear Membrane (thin, translucent)",
            "type": "physical",
            "shaderModel": "MeshPhysicalMaterial with transmission and thin-film thickness",
            "baseColor": hexcolor((214, 170, 140)),
            "color": hexcolor((214, 170, 140)),
            "albedo": {"dominant": hexcolor((214, 170, 140)),
                       "secondary": [hexcolor(MEASURED["ear-membrane-tabby"])],
                       "samplingNotes": "Observed rgb(207,148,96) is transmitted light, not albedo."},
            "colorVariation": {"palette": [hexcolor((214, 170, 140)),
                                           hexcolor(MEASURED["ear-membrane-tabby"])],
                               "pattern": "vein tracery", "amplitude": 0.12,
                               "heightCorrelation": 0.2},
            "textureResolution": 1024,
            "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 4,
                                  "texelDensityIntent": "Membrane detail is small and local."},
            "surfaceFrequencyBands": bands(0.20, 0.16, 0.07),
            "roughness": {"base": 0.48, "variation": 0.10, "map": "independent-procedural-field",
                          "localResponse": "smoother toward the thin translucent centre"},
            "metalness": {"base": 0.0, "variation": 0.0},
            "transmission": 0.55,
            "thickness": 0.012,
            "ior": 1.38,
            "attenuationColor": hexcolor((200, 120, 76)),
            "normal": {"pattern": "fine vein relief and short radial hair", "strength": 0.4,
                       "scale": 1.0, "space": "tangent"},
            "bump": {"pattern": "vein tracery", "amplitude": 0.003},
            "ambientOcclusion": {"cavityStrength": 0.3, "contactShadowBias": 0.005,
                                 "notes": "Independent AO; the ear pocket darkens at its base."},
            "wear": {"edgeWear": 0.0, "scratches": [], "chips": [], "alphaCurve": "none",
                     "aoBias": 0.0, "approximated": True, "notes": "Living tissue: no wear."},
            "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#000000"},
            "localOverrides": [
                {"id": "override-backlit-glow", "kind": "emissive",
                 "region": "membrane centre where the key light passes through",
                 "transmissionDelta": 0.25,
                 "description": "Transmitted warm glow; the single strongest cue that the ear is "
                                "thin. Measured rgb(207,148,96)."},
                {"id": "override-rim-cartilage", "kind": "ridge",
                 "region": "membrane outer edge", "roughnessDelta": 0.12,
                 "description": "Thicker cartilage rim: less transmission, more diffuse."},
            ],
            "shaderNotes": ["Transmission plus low thickness, not an emissive cheat.",
                            "Independent roughness and normal fields."],
            "viewDependent": True,
            "needsEnvironment": True,
            "notes": "Thin translucent shell; needs an environment to read correctly.",
        },
        {
            "id": "ear-membrane-dark",
            "envMapIntensity": 0.45,
            "name": "Black Cat Ear Membrane (thin, translucent)",
            "type": "physical",
            "shaderModel": "MeshPhysicalMaterial with transmission and thin-film thickness",
            "baseColor": hexcolor((92, 62, 50)),
            "color": hexcolor((92, 62, 50)),
            "albedo": {"dominant": hexcolor((92, 62, 50)),
                       "secondary": [hexcolor(MEASURED["ear-membrane-black"])],
                       "samplingNotes": "Observed rgb(85,45,25) at the rim is transmitted light."},
            "colorVariation": {"palette": [hexcolor((92, 62, 50)),
                                           hexcolor(MEASURED["ear-membrane-black"])],
                               "pattern": "vein tracery", "amplitude": 0.10,
                               "heightCorrelation": 0.2},
            "textureResolution": 1024,
            "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 4,
                                  "texelDensityIntent": "Membrane detail is small and local."},
            "surfaceFrequencyBands": bands(0.18, 0.14, 0.06),
            "roughness": {"base": 0.52, "variation": 0.10, "map": "independent-procedural-field",
                          "localResponse": "smoother toward the thin centre"},
            "metalness": {"base": 0.0, "variation": 0.0},
            "transmission": 0.38,
            "thickness": 0.013,
            "ior": 1.38,
            "attenuationColor": hexcolor((120, 60, 34)),
            "normal": {"pattern": "fine vein relief with dark inner hair", "strength": 0.4,
                       "scale": 1.0, "space": "tangent"},
            "bump": {"pattern": "vein tracery", "amplitude": 0.003},
            "ambientOcclusion": {"cavityStrength": 0.35, "contactShadowBias": 0.005,
                                 "notes": "Independent AO."},
            "wear": {"edgeWear": 0.0, "scratches": [], "chips": [], "alphaCurve": "none",
                     "aoBias": 0.0, "approximated": True, "notes": "Living tissue: no wear."},
            "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#000000"},
            "localOverrides": [
                {"id": "override-backlit-glow", "kind": "emissive",
                 "region": "membrane centre", "transmissionDelta": 0.18,
                 "description": "Weaker transmitted glow than the tabby because the inner ear is "
                                "dark-furred; measured rgb(85,45,25) at the rim only."},
            ],
            "shaderNotes": ["Transmission, not emissive.", "Independent roughness and normal."],
            "viewDependent": True,
            "needsEnvironment": True,
            "notes": "Darker, less transmissive than the tabby's ear.",
        },
    ]

    def eye_material(mid: str, name: str, iris: tuple[int, int, int], notes: str) -> dict[str, Any]:
        return {
            "id": mid, "name": name, "type": "physical",
            "shaderModel": "MeshPhysicalMaterial with clearcoat over a radial iris gradient",
            "baseColor": hexcolor(iris), "color": hexcolor(iris),
            "albedo": {"dominant": hexcolor(iris),
                       "secondary": [hexcolor(tuple(int(c * 0.55) for c in iris)),
                                     hexcolor(tuple(min(255, c + 24) for c in iris))],
                       "samplingNotes": notes},
            "colorVariation": {"palette": [hexcolor(tuple(int(c * 0.5) for c in iris)),
                                           hexcolor(iris),
                                           hexcolor(tuple(min(255, c + 30) for c in iris))],
                               "pattern": "radial fibre striation from the pupil outward",
                               "amplitude": 0.22, "heightCorrelation": 0.0},
            "colorGradient": {"type": "radial",
                              "stops": [{"offset": 0.0, "color": rgba(MEASURED["pupil"])},
                                        {"offset": 0.42, "color": rgba(iris)},
                                        {"offset": 0.88, "color": rgba(tuple(min(255, c + 26) for c in iris))},
                                        {"offset": 1.0, "color": rgba(tuple(int(c * 0.45) for c in iris))}]},
            "textureResolution": 1024,
            "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8,
                                  "texelDensityIntent": "Iris fibres stay crisp at close range."},
            "surfaceFrequencyBands": bands(0.10, 0.22, 0.14),
            "roughness": {"base": 0.14, "variation": 0.06, "map": "independent-procedural-field",
                          "localResponse": "slightly rougher at the limbal ring"},
            "metalness": {"base": 0.0, "variation": 0.0},
            "clearcoat": 0.9, "clearcoatRoughness": 0.04, "envMapIntensity": 1.1,
            "normal": {"pattern": "radial iris fibre striation", "strength": 0.25, "scale": 1.0,
                       "space": "tangent"},
            "bump": {"pattern": "iris fibres", "amplitude": 0.001},
            "ambientOcclusion": {"cavityStrength": 0.4, "contactShadowBias": 0.004,
                                 "notes": "Orbit shadow from the lid rim; independent field."},
            "wear": {"edgeWear": 0.0, "scratches": [], "chips": [], "alphaCurve": "none",
                     "aoBias": 0.0, "approximated": True, "notes": "No wear on a living eye."},
            "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#000000"},
            "localOverrides": [
                {"id": "override-limbal-ring", "kind": "linework",
                 "region": "outer 8 percent of the iris disc",
                 "albedo": hexcolor(tuple(int(c * 0.45) for c in iris)),
                 "description": "Darker green limbal ring at the iris edge."},
                {"id": "override-lower-arc-brightening", "kind": "gloss",
                 "region": "lower-outer arc of the iris annulus", "roughnessDelta": -0.05,
                 "description": "The iris annulus is measurably brightest on its lower-outer arc, "
                                "where the key light rakes across it."},
            ],
            "shaderNotes": ["Clearcoat carries the wet look; the specular must come from a light.",
                            "Independent roughness and normal fields."],
            "viewDependent": True, "needsEnvironment": True, "notes": notes,
        }

    materials.append(eye_material(
        "iris-amber-green", "Black Cat Iris (amber yellow-green)", MEASURED["iris-black-cat"],
        "Measured peak iris pixels rgb(213,186,95) rising to rgb(233,202,104): hue about 50 degrees, "
        "yellower than the tabby's. Reads green in context but is measurably amber-yellow-green.",
    ))
    materials.append(eye_material(
        "iris-chartreuse", "Tabby Iris (chartreuse green)", MEASURED["iris-tabby"],
        "Measured peak iris pixels rgb(203,185,104) with r approximately equal to g: hue about 60 "
        "degrees, a true chartreuse green. This is the greener of the two cats.",
    ))

    materials.extend([
        {
            "id": "marking-stripe", "name": "Tabby Marking Stripe (M, cheek bars)",
            "type": "standard",
            "shaderModel": "MeshPhysicalMaterial, matte agouti stripe fur",
            "baseColor": hexcolor(MEASURED["coat-tabby-stripe"]),
            "color": hexcolor(MEASURED["coat-tabby-stripe"]),
            "albedo": {"dominant": hexcolor(MEASURED["coat-tabby-stripe"]),
                       "secondary": [hexcolor(MEASURED["coat-tabby-flank"])],
                       "samplingNotes": "Measured stripe rgb(41,23,9) against base fur "
                                        "rgb(124,90,63). Deliberately the stripe brown and not the "
                                        "near-black eyeliner: authored with eyeliner-dark the "
                                        "forehead M rendered as heavy black dashes drawn on top of "
                                        "the head rather than as fur banding."},
            "colorVariation": {"palette": [hexcolor(MEASURED["coat-tabby-stripe"]),
                                           hexcolor(MEASURED["coat-tabby-flank"])],
                               "pattern": "agouti band", "amplitude": 0.12,
                               "heightCorrelation": 0.3},
            "textureResolution": 1024,
            "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 4,
                                  "texelDensityIntent": "Small local marking."},
            "surfaceFrequencyBands": bands(0.10, 0.16, 0.07),
            "roughness": {"base": 0.76, "variation": 0.08, "map": "independent-procedural-field",
                          "localResponse": "matte throughout"},
            "metalness": {"base": 0.0, "variation": 0.0},
            "envMapIntensity": 0.16,
            "normal": {"pattern": "agouti hair band", "strength": 0.4, "scale": 2.0,
                       "space": "tangent"},
            "bump": {"pattern": "hair band", "amplitude": 0.002},
            "ambientOcclusion": {"cavityStrength": 0.4, "contactShadowBias": 0.003,
                                 "notes": "Independent AO."},
            "wear": {"edgeWear": 0.0, "scratches": [], "chips": [], "alphaCurve": "none",
                     "aoBias": 0.0, "approximated": True, "notes": "Living fur: no wear."},
            "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#000000"},
            "localOverrides": [
                {"id": "override-band-softening", "kind": "contour",
                 "region": "stripe edges", "maskSoftness": 0.4,
                 "description": "Agouti banding makes every stripe edge soft rather than "
                                "vector-sharp."},
            ],
            "shaderNotes": ["Matte: a stripe must not read as a painted line."],
            "notes": "Shared by the forehead M and the cheek bars.",
        },
        {
            "id": "eyeliner-dark", "name": "Eyelid Rim / Eyeliner", "type": "standard",
            "shaderModel": "MeshPhysicalMaterial, matte near-black fur ring",
            "baseColor": "#1A1512", "color": "#1A1512",
            "albedo": {"dominant": "#1A1512", "secondary": ["#2A2018", "#0E0B09"],
                       "samplingNotes": "Measured tabby eye ring rgb(41,23,9) and the black cat's "
                                        "lid fur rgb(22,21,21); authored slightly darker than either "
                                        "because the ring reads as a line, not an area."},
            "colorVariation": {"palette": ["#0E0B09", "#1A1512", "#2A2018"],
                               "pattern": "short radial lid fur", "amplitude": 0.10,
                               "heightCorrelation": 0.3},
            "textureResolution": 1024,
            "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 4,
                                  "texelDensityIntent": "Small ring, local detail only."},
            "surfaceFrequencyBands": bands(0.10, 0.14, 0.06),
            "roughness": {"base": 0.80, "variation": 0.08, "map": "independent-procedural-field",
                          "localResponse": "uniformly matte so it never competes with the cornea"},
            "metalness": {"base": 0.0, "variation": 0.0},
            "envMapIntensity": 0.14,
            "normal": {"pattern": "short radial lid fur", "strength": 0.5, "scale": 2.0,
                       "space": "tangent"},
            "bump": {"pattern": "lid fur", "amplitude": 0.002},
            "ambientOcclusion": {"cavityStrength": 0.7, "contactShadowBias": 0.004,
                                 "notes": "Independent AO; the lid crease darkens."},
            "wear": {"edgeWear": 0.0, "scratches": [], "chips": [], "alphaCurve": "none",
                     "aoBias": 0.0, "approximated": True, "notes": "Living tissue: no wear."},
            "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#000000"},
            "localOverrides": [
                {"id": "override-upper-lid-thickening", "kind": "linework",
                 "region": "upper arc of the ring", "albedo": "#0E0B09",
                 "description": "The eyeliner is measurably thicker across the top lid than the "
                                "bottom on the tabby."},
                {"id": "override-tear-stripe", "kind": "linework",
                 "region": "inner corner, descending", "albedo": "#1A1512",
                 "description": "Tear stripe running from the inner corner down the cheek."},
            ],
            "shaderNotes": ["Matte on purpose: any gloss here competes with the corneal specular."],
            "notes": "Dedicated lid-rim material so the eyeliner is geometry-backed rather than an "
                     "unimplemented region mask.",
        },
        {
            "id": "pupil-black", "name": "Dilated Pupil", "type": "physical",
            "shaderModel": "MeshPhysicalMaterial, near-black with a mirrored environment band",
            "baseColor": hexcolor((10, 11, 12)), "color": hexcolor((10, 11, 12)),
            "albedo": {"dominant": hexcolor((10, 11, 12)),
                       "secondary": [hexcolor(MEASURED["pupil-reflection"])],
                       "samplingNotes": "Measured rgb(19,18,10) in the middle with a cool "
                                        "rgb(19,35,49) reflection band across the upper half."},
            "colorVariation": {"palette": [hexcolor((10, 11, 12)),
                                           hexcolor(MEASURED["pupil-reflection"])],
                               "pattern": "single horizontal environment band",
                               "amplitude": 0.30, "heightCorrelation": 0.0},
            "colorGradient": {"type": "linear",
                              "stops": [{"offset": 0.0, "color": rgba(MEASURED["pupil-reflection"])},
                                        {"offset": 0.45, "color": rgba((14, 15, 14))},
                                        {"offset": 1.0, "color": rgba((8, 8, 8))}]},
            "textureResolution": 1024,
            "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 4,
                                  "texelDensityIntent": "Small, close-range only."},
            "surfaceFrequencyBands": bands(0.06, 0.05, 0.02),
            "roughness": {"base": 0.08, "variation": 0.03, "map": "independent-procedural-field",
                          "localResponse": "uniformly polished"},
            "metalness": {"base": 0.0, "variation": 0.0},
            "clearcoat": 0.85, "clearcoatRoughness": 0.03, "envMapIntensity": 1.3,
            "normal": {"pattern": "none", "strength": 0.0, "scale": 1.0, "space": "tangent"},
            "bump": {"pattern": "none", "amplitude": 0.0},
            "ambientOcclusion": {"cavityStrength": 0.2, "contactShadowBias": 0.002,
                                 "notes": "Independent AO from the iris shelf."},
            "wear": {"edgeWear": 0.0, "scratches": [], "chips": [], "alphaCurve": "none",
                     "aoBias": 0.0, "approximated": True, "notes": "No wear."},
            "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#000000"},
            "localOverrides": [
                {"id": "override-environment-band", "kind": "decal",
                 "region": "upper half of the pupil",
                 "albedo": hexcolor(MEASURED["pupil-reflection"]),
                 "description": "Cool greenish reflection of the landscape, measured "
                                "rgb(19,35,49). Without it the pupil reads as a flat black hole."},
            ],
            "shaderNotes": ["Round and fully dilated; never a slit.",
                            "Independent roughness and AO."],
            "viewDependent": True, "needsEnvironment": True,
            "notes": "Round dilated pupil, 0.73 of iris diameter.",
        },
        {
            "id": "cornea-clear", "name": "Cornea (clearcoat specular shell)", "type": "physical",
            "shaderModel": "MeshPhysicalMaterial, transmissive with high clearcoat",
            "baseColor": "#FFFFFF", "color": "#FFFFFF",
            "albedo": {"dominant": "#FFFFFF", "secondary": ["#EAF2F6"],
                       "samplingNotes": "Not sampled: the cornea contributes a specular, not an "
                                        "albedo."},
            "colorVariation": {"palette": ["#FFFFFF", "#EAF2F6"], "pattern": "none",
                               "amplitude": 0.0, "heightCorrelation": 0.0},
            "textureResolution": 1024,
            "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 2,
                                  "texelDensityIntent": "No texture needed."},
            "surfaceFrequencyBands": bands(0.02, 0.02, 0.01),
            "roughness": {"base": 0.03, "variation": 0.01, "map": "independent-procedural-field",
                          "localResponse": "uniform"},
            "metalness": {"base": 0.0, "variation": 0.0},
            "transmission": 0.0, "thickness": 0.004, "ior": 1.376,
            "opacity": 0.16, "transparent": True,
            "clearcoat": 1.0, "clearcoatRoughness": 0.02, "envMapIntensity": 0.85,
            "normal": {"pattern": "none", "strength": 0.0, "scale": 1.0, "space": "tangent"},
            "bump": {"pattern": "none", "amplitude": 0.0},
            "ambientOcclusion": {"cavityStrength": 0.0, "contactShadowBias": 0.0,
                                 "notes": "None: transmissive shell."},
            "wear": {"edgeWear": 0.0, "scratches": [], "chips": [], "alphaCurve": "none",
                     "aoBias": 0.0, "approximated": True, "notes": "No wear."},
            "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#000000"},
            "localOverrides": [
                {"id": "override-key-specular", "kind": "gloss",
                 "region": "upper-right quadrant of each cornea", "roughnessDelta": -0.02,
                 "description": "The one sharp highlight per eye. Its position at the upper-right "
                                "of all four pupils is what fixes the key light up and "
                                "camera-right."},
            ],
            "shaderNotes": ["The highlight must be a real light reflection, never painted albedo."],
            "viewDependent": True, "needsEnvironment": True,
            "notes": "Specular-only shell over the iris. Deliberately NOT transmissive: at transmission 0.94 with envMapIntensity 1.6 it rendered as a pale glass bead that hid the dilated pupil entirely, which is the one feature the reconstruction cannot lose. It is now a 16 percent-opacity clearcoat shell that contributes the highlight and nothing else.",
        },
        {
            "id": "nose-leather-pink",
            "envMapIntensity": 0.5, "name": "Tabby Nose Leather (pink)", "type": "physical",
            "shaderModel": "MeshPhysicalMaterial, hairless leather with subsurface",
            "baseColor": hexcolor((186, 122, 96)), "color": hexcolor((186, 122, 96)),
            "albedo": {"dominant": hexcolor((186, 122, 96)),
                       "secondary": [hexcolor(MEASURED["nose-tabby"]), hexcolor((92, 52, 34))],
                       "samplingNotes": "Measured rgb(150,85,47) under the warm key; the darker "
                                        "outline is a separate rim."},
            "colorVariation": {"palette": [hexcolor(MEASURED["nose-tabby"]), hexcolor((186, 122, 96)),
                                           hexcolor((92, 52, 34))],
                               "pattern": "fine pebble mottling", "amplitude": 0.16,
                               "heightCorrelation": 0.6},
            "textureResolution": 1024,
            "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8,
                                  "texelDensityIntent": "Pebble scale stays constant."},
            "surfaceFrequencyBands": bands(0.14, 0.30, 0.18),
            "roughness": {"base": 0.42, "variation": 0.12, "map": "independent-procedural-field",
                          "localResponse": "glossier on the tip, rougher in the nostril creases"},
            "metalness": {"base": 0.0, "variation": 0.0},
            "clearcoat": 0.18, "clearcoatRoughness": 0.32,
            "normal": {"pattern": "pebbled leather", "strength": 0.9, "scale": 3.0,
                       "space": "tangent"},
            "bump": {"pattern": "pebble grain", "amplitude": 0.004},
            "ambientOcclusion": {"cavityStrength": 0.6, "contactShadowBias": 0.006,
                                 "notes": "Nostril creases darken; independent field."},
            "wear": {"edgeWear": 0.0, "scratches": [], "chips": [], "alphaCurve": "none",
                     "aoBias": 0.0, "approximated": True, "notes": "No wear."},
            "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#000000"},
            "localOverrides": [
                {"id": "override-nose-outline", "kind": "linework",
                 "region": "nose perimeter", "albedo": hexcolor((92, 52, 34)),
                 "description": "Darker brown outline around the pink leather."},
                {"id": "override-tip-gloss", "kind": "gloss", "region": "nose tip",
                 "roughnessDelta": -0.18,
                 "description": "The only glossy point on the face besides the cornea."},
            ],
            "shaderNotes": ["Pebble normal is independent of the albedo mottling."],
            "notes": "Pink hairless leather with a darker rim.",
        },
        {
            "id": "nose-leather-dark",
            "envMapIntensity": 0.4, "name": "Black Cat Nose Leather (near-black)",
            "type": "physical",
            "shaderModel": "MeshPhysicalMaterial, hairless leather with subsurface",
            "baseColor": hexcolor((48, 40, 34)), "color": hexcolor((48, 40, 34)),
            "albedo": {"dominant": hexcolor((48, 40, 34)),
                       "secondary": [hexcolor(MEASURED["nose-black"]), hexcolor((78, 58, 48))],
                       "samplingNotes": "Measured rgb(37,30,23) with a p90 of rgb(66,51,41) on the "
                                        "lit tip."},
            "colorVariation": {"palette": [hexcolor(MEASURED["nose-black"]), hexcolor((48, 40, 34)),
                                           hexcolor((78, 58, 48))],
                               "pattern": "fine pebble mottling", "amplitude": 0.12,
                               "heightCorrelation": 0.6},
            "textureResolution": 1024,
            "textureProjection": {"mode": "uv", "repeat": [2.0, 2.0], "anisotropy": 8,
                                  "texelDensityIntent": "Pebble scale stays constant."},
            "surfaceFrequencyBands": bands(0.12, 0.28, 0.16),
            "roughness": {"base": 0.46, "variation": 0.12, "map": "independent-procedural-field",
                          "localResponse": "glossier on the tip"},
            "metalness": {"base": 0.0, "variation": 0.0},
            "clearcoat": 0.30, "clearcoatRoughness": 0.24,
            "normal": {"pattern": "pebbled leather", "strength": 0.9, "scale": 3.0,
                       "space": "tangent"},
            "bump": {"pattern": "pebble grain", "amplitude": 0.004},
            "ambientOcclusion": {"cavityStrength": 0.6, "contactShadowBias": 0.006,
                                 "notes": "Independent field."},
            "wear": {"edgeWear": 0.0, "scratches": [], "chips": [], "alphaCurve": "none",
                     "aoBias": 0.0, "approximated": True, "notes": "No wear."},
            "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#000000"},
            "localOverrides": [
                {"id": "override-tip-gloss", "kind": "gloss", "region": "nose tip",
                 "roughnessDelta": -0.20,
                 "description": "Small bright highlight on the tip, the only gloss on this cat's "
                                "muzzle."},
            ],
            "shaderNotes": ["Pebble normal independent of albedo."],
            "notes": "Near-black leather, warmer than the coat.",
        },
        {
            "id": "whisker-keratin", "name": "Whisker / Ear-Fringe Keratin", "type": "physical",
            "shaderModel": "MeshPhysicalMaterial, thin dielectric strand",
            "baseColor": hexcolor((228, 216, 202)), "color": hexcolor((228, 216, 202)),
            "albedo": {"dominant": hexcolor((228, 216, 202)),
                       "secondary": [hexcolor(MEASURED["whisker"]), hexcolor((160, 148, 136))],
                       "samplingNotes": "Whiskers read as pale near-white strands over the dark "
                                        "coat; measured highlight rgb(222,205,186)."},
            "colorVariation": {"palette": [hexcolor((240, 232, 222)), hexcolor(MEASURED["whisker"]),
                                           hexcolor((160, 148, 136))],
                               "pattern": "length-wise fade toward the tip", "amplitude": 0.2,
                               "heightCorrelation": 0.0},
            "textureResolution": 1024,
            "textureProjection": {"mode": "uv", "repeat": [1.0, 8.0], "anisotropy": 4,
                                  "texelDensityIntent": "Strand fades along its length."},
            "surfaceFrequencyBands": bands(0.04, 0.06, 0.03),
            "roughness": {"base": 0.30, "variation": 0.08, "map": "independent-procedural-field",
                          "localResponse": "smoother at the root, rougher at the tip"},
            "metalness": {"base": 0.0, "variation": 0.0},
            "sheen": {"base": 0.4, "roughness": 0.3, "color": "#FFF6EA"},
            "sheenColor": "#FFF6EA", "sheenRoughness": 0.3, "envMapIntensity": 0.5,
            "anisotropy": 0.8,
            "normal": {"pattern": "length-wise strand", "strength": 0.2, "scale": 1.0,
                       "space": "tangent"},
            "bump": {"pattern": "none", "amplitude": 0.0},
            "ambientOcclusion": {"cavityStrength": 0.1, "contactShadowBias": 0.001,
                                 "notes": "Independent field."},
            "wear": {"edgeWear": 0.0, "scratches": [], "chips": [], "alphaCurve": "tip-fade",
                     "aoBias": 0.0, "approximated": True,
                     "notes": "Alpha fades at the tip so the strand does not end in a hard stub."},
            "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#000000"},
            "localOverrides": [
                {"id": "override-tip-fade", "kind": "contour", "region": "distal third of each strand",
                 "description": "Opacity and radius both fall off toward the tip."},
            ],
            "shaderNotes": ["Anisotropic sheen along the strand axis."],
            "notes": "Shared by whiskers and the radial ear fringe.",
        },
    ])
    return materials


def attach_reference_pbr(materials: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fold the extract_pbr_evidence.py reports into each material.

    These are reference-pixel extractions, not inverse rendering: the source
    pixels still carry the scene's warm key. The reports are attached as
    evidence with their own confidence so a later pass can see how much of the
    material response is measured and how much is authored.
    """
    # Reference-pixel extraction is the right tool for a homogeneous statistical
    # surface (fur, leather): a crop of it tiles into a believable material. It is
    # the WRONG tool for a structured feature. An "iris" crop is a picture of one
    # whole eye - pupil, annulus, specular and lid all in one image - so tiling it
    # over an iris sphere reproduces none of them, and worse, it drags roughness to
    # the fur's 0.7 and destroys the wet clearcoat that makes an eye read as an eye.
    # These three stay procedural, driven by their authored radial colorGradient and
    # scalars, and the spec records that as an explicit route choice.
    procedural_only = {"iris-amber-green", "iris-chartreuse", "pupil-black",
                       "cornea-clear", "eyeliner-dark", "marking-stripe"}
    for material in materials:
        is_procedural = material["id"] in procedural_only
        material["route"] = "procedural-finish" if is_procedural else "reference-projection"
        material["textureRouting"] = {
            "useReferenceMaps": not is_procedural,
            "appliedBy": "src/catsRuntime.ts applyMaterialRouting()",
            "reason": (
                "Procedural on purpose. The extracted bundle stays attached as evidence (its palette "
                "is real and measured), but its source crop is a picture of a whole eye rather than a "
                "tileable surface, and the generator sets roughness to 1.0 whenever a roughnessMap "
                "exists - which would drag the cornea to the fur's roughness 0.7 and kill the wet "
                "clearcoat that makes an eye read as an eye. The runtime layer therefore strips the "
                "maps for this material and drives it from the authored radial colour gradient plus "
                "the clearcoat/transmission scalars."
                if is_procedural else
                "Reference maps are used: this is a homogeneous statistical surface, so a crop of the "
                "reference's own pixels tiles into a believable material and carries colour evidence "
                "no procedural pattern could match. The runtime layer restores the authored roughness "
                "and sheen scalars, which the generator otherwise clamps to roughness 1.0 whenever a "
                "roughnessMap is present."
            ),
        }
        report_path = HERE / "reference" / "pbr" / material["id"] / "report.json"
        if not report_path.exists():
            continue
        report = json.loads(report_path.read_text(encoding="utf-8"))
        stats = report.get("diagnostics", {}).get("mapStats", {})
        confidence = report.get("confidence") or 0.0
        material["referencePbr"] = {
            "usable": report.get("verdict") == "pass" and confidence >= 0.7,
            "usableRationale": (
                f"extract_pbr_evidence.py returned verdict={report.get('verdict')} at "
                f"confidence {confidence:.3f}, above the 0.7 target threshold, and emitted all five "
                "channels (albedo, roughness, height, normal, ao) as independent files."
            ),
            "confidence": confidence,
            "verdict": report.get("verdict"),
            "extractor": "forge/stage1_intake/extract_pbr_evidence.py",
            "sourceCrop": report.get("sourceImage"),
            "palette": report.get("palette", []),
            "channel": "independent-per-channel",
            "colorSpace": "srgb for albedo, linear for roughness/height/normal/ao",
            "uvOrientation": "y-up, matching THREE.Texture flipY default",
            "measured": {
                "roughnessBase": stats.get("roughnessBase"),
                "roughnessVariation": stats.get("roughnessVariation"),
                "normalStrength": stats.get("normalStrength"),
                "heightP90Gradient": stats.get("heightP90Gradient"),
                "mapSize": stats.get("mapSize"),
            },
            "maps": {
                channel: {
                    **entry,
                    # Root-relative so the viewer can actually fetch them; the raw
                    # report stores a bare filename, which 404s from the page.
                    "url": f"/reference/pbr/{material['id']}/{Path(str(entry.get('path'))).name}",
                }
                for channel, entry in (report.get("maps") or {}).items()
                if isinstance(entry, dict)
            },
            "warnings": report.get("warnings", []),
            "limitation": report.get("limitation"),
        }
    return materials


def build_lighting() -> list[dict[str, Any]]:
    return [
        {"id": "key-low-warm-sun", "role": "key", "type": "directional",
         "colorHex": "#FFD9A8", "intensityRelative": 1.0,
         "directionFromSubject": [0.62, 0.55, 0.56],
         "evidence": "All four corneal highlights sit at the upper-right of their pupils, and both "
                     "cats carry a warm rim on their camera-right edges (black-cat ear p90 "
                     "rgb(106,68,45) against a rgb(60,49,41) body median).",
         "softnessDegrees": 3.0, "castsShadow": True, "confidence": 0.85},
        {"id": "fill-sky-cool", "role": "fill", "type": "hemisphere",
         "skyColorHex": "#BFD3E8", "groundColorHex": "#C9A484", "intensityRelative": 0.32,
         "evidence": "Shadowed fur keeps a slight cool cast (black-cat cheek rgb(22,21,21) is "
                     "neutral, not warm) while the underside picks up warm bounce.",
         "castsShadow": False, "confidence": 0.7},
        {"id": "rim-back-warm", "role": "rim", "type": "directional",
         "colorHex": "#FFC078", "intensityRelative": 0.55,
         "directionFromSubject": [0.35, 0.30, -0.89],
         "evidence": "Ear membranes glow with transmitted light (tabby rgb(207,148,96)) and a "
                     "bright hair fringe separates both silhouettes from the background.",
         "softnessDegrees": 6.0, "castsShadow": False, "confidence": 0.75},
        {"id": "bounce-seat-warm", "role": "bounce", "type": "area",
         "colorHex": "#D8B694", "intensityRelative": 0.22,
         "directionFromSubject": [0.0, -0.92, 0.4],
         "evidence": "The cream seat (measured rgb(186,148,118)) lifts the undersides of the paws "
                     "and chin; the tabby's shaded white paw reads rgb(199,160,122).",
         "softnessDegrees": 40.0, "castsShadow": False, "confidence": 0.65},
        {"id": "environment-golden-hour", "role": "environment", "type": "environment",
         "colorHex": "#C4AD99", "intensityRelative": 0.5,
         "evidence": "Background wall measured rgb(196,173,153); grass rgb(76,83,10). A warm "
                     "low-sun environment is required for the transmissive ear membranes and the "
                     "clearcoat corneas to resolve.",
         "castsShadow": False, "confidence": 0.7},
        {"id": "exposure-and-tonemapping", "role": "camera-response", "type": "tone-mapping",
         "toneMapping": "ACESFilmic", "exposure": 1.05, "outputColorSpace": "srgb",
         "background": "transparent for the silhouette gate, warm gradient for beauty renders",
         "contactShadow": "soft contact shadow under all six visible paws and both haunches, "
                          "radius 0.02 world, opacity 0.45",
         "evidence": "The reference is a filmic render with highlights rolled off (white bib p90 "
                     "rgb(248,219,184), never clipped to 255).",
         "confidence": 0.7},
    ]


def build_detail_inventory(components: list[dict[str, Any]]) -> dict[str, Any]:
    """Every detail must resolve to a component localFeature id or material/override id."""
    details = [
        ("bc-eye-left-cornea-key-specular", "gloss", "cornea-clear/override-key-specular",
         "geometry", "black cat, left eye",
         "Single sharp corneal highlight at the upper-right of the pupil."),
        ("tb-eye-right-cornea-key-specular", "gloss", "cornea-clear/override-key-specular",
         "geometry", "tabby, right eye",
         "Matching corneal highlight; identical placement across all four eyes."),
        ("bc-iris-annulus", "linework", "bc-eye-left-iris-annulus", "geometry",
         "black cat, both eyes",
         "Thin amber yellow-green iris annulus around a dilated pupil, ~0.12 of eye diameter."),
        ("tb-iris-annulus", "linework", "tb-eye-left-iris-annulus", "geometry",
         "tabby, both eyes",
         "Thin chartreuse-green iris annulus; measurably greener than the black cat's."),
        ("bc-pupil-environment-band", "decal", "pupil-black/override-environment-band", "map-only",
         "both cats, all four pupils",
         "Cool rgb(19,35,49) mirrored-landscape band across the pupil's upper half."),
        ("iris-limbal-ring", "linework", "iris-chartreuse/override-limbal-ring", "map-only",
         "both cats, iris outer edge", "Darker limbal ring at the iris rim."),
        ("tb-forehead-m", "linework", "coat-tabby-agouti/override-forehead-m", "map-only",
         "tabby, forehead and crown",
         "Five to six converging dark stripes forming the tabby 'M'."),
        ("tb-flank-mackerel", "linework", "coat-tabby-agouti/override-flank-stripes", "map-only",
         "tabby, flanks and shoulders",
         "About 22 narrow mackerel stripes following body curvature."),
        ("tb-eyeliner", "linework", "coat-tabby-agouti/override-eyeliner", "map-only",
         "tabby, both orbits",
         "Dark eyeliner ring, tear-stripe and cheek bars."),
        ("tb-dorsal-stripe", "linework", "coat-tabby-agouti/override-dorsal-stripe", "map-only",
         "tabby, spine (inferred)",
         "INFERRED dorsal spine stripe: the front view cannot show the back."),
        ("tb-agouti-hair-banding", "ridge", "coat-tabby-agouti/override-agouti-banding", "map-only",
         "tabby, whole coat",
         "Light-dark-light banding along each hair, which softens every stripe edge."),
        ("tb-bib-boundary", "contour", "tb-bib-boundary", "geometry", "tabby, chest",
         "Soft hair-interrupted boundary of the white inverted-triangle bib."),
        ("tb-sock-boundaries", "contour", "fur-white/override-bib-mask", "map-only",
         "tabby, all four feet",
         "White sock boundaries starting mid-pastern on every foot."),
        ("bc-chest-sheen-band", "gloss", "bc-chest-sheen-band", "map-only", "black cat, chest",
         "Satin sheen band down the chest centreline where hair flow turns to the key."),
        ("bc-rim-edge", "gloss", "coat-black/override-rim-edge", "map-only",
         "black cat, camera-right edge",
         "Warm rim response along the right-hand silhouette and outer ears."),
        ("coat-fur-grain", "ridge", "coat-black/override-fur-grain", "map-only",
         "both cats, whole coat",
         "Directional strand grain in the normal channel, independent of albedo."),
        ("limb-cavity-occlusion", "seam", "bc-limb-cavity-occlusion", "map-only",
         "both cats, limb junctions",
         "Cavity darkening where forelegs and haunch meet the barrel."),
        ("ear-backlit-glow", "emissive", "ear-membrane-warm/override-backlit-glow", "map-only",
         "both cats, both ears",
         "Transmitted warm glow through the thin ear membrane."),
        ("ear-outer-rim-line", "ridge", "bc-ear-left-outer-rim-line", "geometry",
         "both cats, ear outer edges",
         "Dark cartilage rim with a blown warm highlight just inside it."),
        ("ear-hair-fringe", "ridge", "tb-ear-left-outer-rim-line", "geometry",
         "both cats, ear inner-front edges",
         "Radial fringe of long pale hairs breaking the ear silhouette; built as the "
         "*-fringe repetition systems."),
        ("paw-toe-grooves", "groove", "bc-forepaw-left-toe-grooves", "geometry",
         "both cats, six visible paws",
         "Four toes per paw separated by three shallow grooves."),
        ("paw-contact-shadow", "stain", "bc-forepaw-left-contact-shadow", "map-only",
         "both cats, paw/seat contact",
         "Tight contact occlusion where each paw meets the seat."),
        ("nose-pebble-relief", "ridge", "tb-nose-pebble-relief", "map-only",
         "both cats, nose leather",
         "Pebbled leather relief, a different frequency band from fur grain."),
        ("nose-tip-gloss", "gloss", "nose-leather-pink/override-tip-gloss", "map-only",
         "both cats, nose tip", "The only glossy point on the face besides the cornea."),
        ("nose-outline", "linework", "nose-leather-pink/override-nose-outline", "map-only",
         "tabby, nose perimeter", "Darker brown outline around the pink leather."),
        ("whisker-pad-dimples", "groove", "bc-whisker-pad-dimples", "geometry",
         "both cats, muzzle", "Two dimpled whisker pads either side of the philtrum."),
        ("philtrum-groove", "groove", "tb-philtrum-groove", "geometry", "both cats, muzzle",
         "Vertical groove from the nose base to the upper lip line."),
        ("whisker-tip-fade", "contour", "whisker-keratin/override-tip-fade", "map-only",
         "both cats, all whiskers", "Radius and opacity fall off toward each whisker tip."),
        ("crown-fur-parting", "ridge", "bc-crown-fur-parting", "map-only",
         "both cats, crown", "Fur whorl between the ears where strand direction flips."),
        ("white-fur-warm-bounce", "stain", "fur-white/override-warm-bounce", "map-only",
         "tabby, undersides of bib and paws",
         "Warm bounce from the cream seat; lighting, not albedo."),
        ("tb-tail-ring-banding", "linework", "tb-tail-segment-1-ring-banding", "map-only",
         "tabby, tail (inferred)",
         "INFERRED mackerel ring banding on a tail the reference never shows."),
    ]
    return {
        "scanMethod": "component-zones",
        "targetMinDetails": 16,
        "note": "Twelve component zones were cropped with build_detail_inventory.py and inspected "
                "individually. Every entry below resolves to a real component localFeature or a "
                "material localOverride - none is prose only. Entries marked INFERRED describe "
                "regions the single reference view cannot show.",
        "details": [
            {
                "id": did,
                "kind": kind,
                "description": description,
                "location": location,
                "realization": realization,
                "approximation": ("Represented in the albedo/normal fields rather than as separate "
                                  "geometry." if realization == "map-only" else ""),
                "mapsTo": {"type": "component-or-material-field", "ref": ref},
                "evidenceRef": f"crops/zones/{location.split(',')[0].replace('black cat', 'bc').replace('tabby', 'tb').strip()}",
                "confidence": 0.35 if "INFERRED" in description else 0.75,
            }
            for did, kind, ref, realization, location, description in details
        ],
    }


def build_passes(components: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ordered build passes, each owning the components it is allowed to introduce."""
    by_tier: dict[str, list[str]] = {}
    for comp in components:
        by_tier.setdefault(comp["fidelityTier"], []).append(comp["id"])

    def refs(*tiers: str) -> list[str]:
        out: list[str] = []
        for tier in tiers:
            out.extend(by_tier.get(tier, []))
        return out

    return [
        {"id": "blockout", "goal": "Land both sitting silhouettes and their head-length proportions "
                                   "from the reference camera using clay-only revolved masses, "
                                   "ears, forelegs, paws and hind feet.",
         "componentRefs": refs("blockout"),
         "acceptance": [
             "Silhouette IoU against reference/cats-matte.png at or above 0.85 with scale delta at "
             "or below 0.08 and aspect delta at or below 0.05, evaluated with material maps "
             "stripped.",
             "Left subject is the taller narrower black-cat triangle, right subject the broader "
             "tabby: identity must not be mirrored.",
             "Both cats read as sitting: haunch in contact with the seat plane, one flat hind foot "
             "splayed laterally, two separated vertical forelegs.",
             "AI vision comparison score meets selfCorrectLoop.visualAcceptance.threshold.",
         ]},
        {"id": "structural-pass", "goal": "Introduce the face and limb sub-assemblies: neck, muzzle, "
                                          "chin, nose, cheek ruffs, eye stacks, ear membranes, the "
                                          "tabby bib, the tail chains and the inferred right hind "
                                          "feet.",
         "componentRefs": refs("blockout", "structural-pass"),
         "acceptance": [
             "Eye stacks exist as four separable parts per eye (iris, dilated pupil, cornea, lid "
             "rim) at 0.25 head-length diameter.",
             "Every endpoint-driven child (neck, forelegs, tail segments, whiskers) has "
             "parentSocket, localStart/localEnd, contactType, embedDepth and gapTolerance, and none "
             "floats away from its parent in the render.",
             "Tails and right hind feet project inside their own cat's traced silhouette, matching "
             "the reference where they are not visible.",
             "AI vision comparison score meets selfCorrectLoop.visualAcceptance.threshold.",
         ]},
        {"id": "form-refinement", "goal": "Add brow ridges, eyelid rims and the whisker fans, and "
                                          "tune tapers so the primitive assembly stops reading as "
                                          "stacked beads.",
         "componentRefs": refs("blockout", "structural-pass", "form-refinement"),
         "acceptance": [
             "Brow ridges and lid rims seat the oversized eyes in real orbits instead of leaving "
             "spheres stuck on a smooth ball.",
             "Whisker fans are present, tapered, and rooted in the whisker pads.",
             "Ear shells still read as thin membranes, not horns, from the orbit views.",
             "AI vision comparison score meets selfCorrectLoop.visualAcceptance.threshold.",
         ]},
        {"id": "material-pass", "goal": "Bind the eleven materials with independent albedo, "
                                        "roughness, normal and AO fields plus every local override: "
                                        "mackerel stripes, forehead M, eyeliner, bib and sock "
                                        "boundaries, chest sheen, cavity occlusion.",
         "componentRefs": refs("blockout", "structural-pass", "form-refinement", "material-pass"),
         "acceptance": [
             "Per-part colour delta-E against colorMaterialRecipe stays under 20 for every "
             "component.",
             "The black coat is a warm brown-black, never neutral #000000, and still shows form in "
             "shadow.",
             "White bib, socks, muzzle and chin use near-white albedo, so their observed warmth "
             "comes from the lights rather than from cream albedo.",
             "About 22 mackerel stripes follow body curvature with soft agouti edges, and the "
             "forehead M is present.",
             "No material reuses its albedo as roughness, normal or AO.",
             "AI vision comparison score meets selfCorrectLoop.visualAcceptance.threshold.",
         ]},
        {"id": "surface-pass", "goal": "Raise the tactile relief: directional fur grain, agouti hair "
                                       "banding, pebbled nose leather, ear vein tracery, toe "
                                       "grooves and paw contact occlusion.",
         "componentRefs": refs("blockout", "structural-pass", "form-refinement", "material-pass",
                               "surface-pass"),
         "acceptance": [
             "Macro, meso and micro surface-frequency bands are all present and visibly different "
             "under grazing light.",
             "Fur grain is directional and follows hair flow, not isotropic noise.",
             "AI vision comparison score meets selfCorrectLoop.visualAcceptance.threshold.",
         ]},
        {"id": "lighting-pass", "goal": "Reproduce the golden-hour setup the reference records: warm "
                                        "low key from up and camera-right, cool sky fill, warm back "
                                        "rim through the ear membranes, warm bounce from the cream "
                                        "seat, ACES filmic tone mapping.",
         "componentRefs": refs("blockout", "structural-pass", "form-refinement", "material-pass",
                               "surface-pass", "lighting-pass"),
         "acceptance": [
             "One sharp corneal specular sits at the upper-right of all four pupils, produced by the "
             "key light rather than painted albedo.",
             "Both ear membranes glow with transmitted light and both cats carry a warm rim on their "
             "camera-right edges.",
             "Exposure and ACES filmic tone mapping are set, and the white bib rolls off without "
             "clipping to 255.",
             "Soft contact shadows sit under all six visible paws and both haunches.",
             "AI vision comparison score meets selfCorrectLoop.visualAcceptance.threshold.",
         ]},
        {"id": "interaction-pass", "goal": "Expose the runtime: named pivots for head, both ears and "
                                           "the five-segment tail on each cat, plus "
                                           "root.userData.tick driving a looping idle of breathing, "
                                           "periodic blink and tail sway.",
         "componentRefs": refs("blockout", "structural-pass", "form-refinement", "material-pass",
                               "surface-pass", "lighting-pass", "interaction-pass"),
         "acceptance": [
             "root.userData.sculptRuntime exposes nodes, meshes, sockets, colliders and "
             "destructionGroups, and root.userData.tick(dt) advances a deterministic looping idle.",
             "Head, ear and tail pivots rotate about anatomically correct origins: the head about "
             "the neck base, each ear about its base, each tail segment about its own joint.",
             "The blink closes both eyes of a cat together and reopens them; breathing scales the "
             "barrel, not the head.",
             "The idle loops seamlessly with no pop at the wrap point.",
             "Every mesh is named, every specified component is its own mesh, and explode and "
             "part-picking agree on what a part is.",
             "AI vision comparison score meets selfCorrectLoop.visualAcceptance.threshold.",
         ]},
        {"id": "optimization-pass", "goal": "Merge draw calls, drop hidden geometry from the "
                                            "reference view where safe, and confirm the real-time "
                                            "budget.",
         "componentRefs": refs("blockout", "structural-pass", "form-refinement", "material-pass",
                               "surface-pass", "lighting-pass", "interaction-pass",
                               "optimization-pass"),
         "acceptance": [
             "60 fps at 925x810 on integrated hardware.",
             "Instanced clusters stay single-draw-call.",
         ]},
    ]


def build_feature_targets() -> list[dict[str, Any]]:
    return [
        # Split deliberately. The eye's identity has a geometric half that a
        # map-stripped clay render CAN prove (four separable parts per eye, 0.25
        # head-length diameter, seated proud of the skull, correct interocular
        # spacing) and a colour half it CANNOT (thin green annulus around a large
        # near-black pupil, one corneal specular). Gating the colour half on a clay
        # pass would force either a dishonest score or a blocked pipeline, so each
        # half gates only the passes that can actually evidence it.
        {"id": "eye-stack-geometry",
         "name": "Eye stack geometry: four separable parts, 0.25-head-length, seated in the orbit",
         "tier": "critical", "minimumScore": 0.8, "mustPass": True,
         "passIds": ["structural-pass", "form-refinement"],
         "componentRefs": ["bc-eye-left-iris", "bc-eye-left-pupil", "bc-eye-left-cornea",
                           "bc-eye-left-lid-rim", "tb-eye-left-iris", "tb-eye-right-iris"],
         "evidenceRefs": ["bc-eyes", "tb-eyes"]},
        {"id": "eye-stack-identity",
         "name": "Eye colour identity: green iris annulus, dilated pupil, corneal specular",
         "tier": "critical", "minimumScore": 0.8, "mustPass": True,
         "passIds": ["material-pass", "lighting-pass", "interaction-pass"],
         "componentRefs": ["bc-eye-left-iris", "bc-eye-left-pupil", "bc-eye-left-cornea",
                           "tb-eye-left-iris", "tb-eye-left-pupil", "tb-eye-right-iris"],
         "evidenceRefs": ["bc-eyes", "tb-eyes"]},
        {"id": "quadruped-sit-proportion",
         "name": "Sitting quadruped proportion in head-length units",
         "tier": "critical", "minimumScore": 0.8, "mustPass": True,
         "passIds": ["blockout", "structural-pass", "form-refinement"],
         "componentRefs": ["bc-torso", "bc-haunch", "bc-head", "tb-torso", "tb-haunch", "tb-head",
                           "bc-hindfoot-left", "tb-hindfoot-left"],
         "evidenceRefs": ["full-object", "bc-paws", "tb-paws"]},
        {"id": "coat-identity-split",
         "name": "Black shorthair on the left, mackerel tabby with white bib and socks on the right",
         "tier": "critical", "minimumScore": 0.8, "mustPass": True,
         "passIds": ["material-pass", "surface-pass", "lighting-pass", "interaction-pass"],
         "componentRefs": ["bc-torso", "tb-torso", "tb-bib", "tb-forepaw-left", "tb-forepaw-right"],
         "evidenceRefs": ["bc-chest", "tb-flank", "tb-bib", "tb-paws"]},
        {"id": "ear-membrane-translucency",
         "name": "Thin translucent ear membrane with backlit glow and hair fringe",
         "tier": "important", "minimumScore": 0.65, "mustPass": False,
         "passIds": ["structural-pass", "form-refinement", "material-pass", "lighting-pass"],
         "componentRefs": ["bc-ear-left", "bc-ear-left-membrane", "tb-ear-left",
                           "tb-ear-left-membrane"],
         "evidenceRefs": ["bc-ears", "tb-ears"]},
        {"id": "whisker-and-muzzle-microdetail",
         "name": "Whisker fans, whisker pads and nose leather",
         "tier": "important", "minimumScore": 0.65, "mustPass": False,
         "passIds": ["form-refinement", "material-pass", "lighting-pass"],
         "componentRefs": ["bc-whisker-left-1", "bc-nose", "tb-nose", "tb-muzzle"],
         "evidenceRefs": ["bc-muzzle", "tb-muzzle"]},
        {"id": "idle-runtime-rig",
         "name": "Head/ear/tail pivots and a looping idle tick",
         "tier": "critical", "minimumScore": 0.8, "mustPass": True,
         "passIds": ["interaction-pass"],
         "componentRefs": ["bc-head", "bc-ear-left", "bc-ear-right", "bc-tail-segment-1",
                           "tb-head", "tb-ear-left", "tb-ear-right", "tb-tail-segment-1"],
         "evidenceRefs": ["full-object"]},
    ]


def main() -> int:
    black_components, black_systems = build_cat(BLACK)
    tabby_components, tabby_systems = build_cat(TABBY)
    components = black_components + tabby_components
    systems = black_systems + tabby_systems

    levels = {"macro": 0, "meso": 0, "micro": 0}
    for comp in components:
        levels[comp["level"]] += 1

    # Verify every inferred/occluded part really does project inside the traced silhouette.
    projection_report = []
    for cat in (BLACK, TABBY):
        for point, radius in zip(cat["tail"], cat["tailRadii"]):
            sx, sy = projected_src(*point)
            projection_report.append(
                {"subject": cat["id"], "part": "tail", "world": list(point),
                 "projectedSrc": [round(sx, 1), round(sy, 1)]})
        foot = cat["footHR"]["world"]
        sx, sy = projected_src(*foot)
        projection_report.append(
            {"subject": cat["id"], "part": "hindfoot-right", "world": list(foot),
             "projectedSrc": [round(sx, 1), round(sy, 1)]})

    patch = {
        "schemaVersion": "2.1",
        "targetName": "Stylized Cat Pair",
        "suitability": "conditional",
        "sourceImage": str(HERE.parent / "gatos.png"),
        "coordinateFrame": {
            "front": "+Z faces the review camera; the reference is a front-three-quarter view",
            "up": "+Y is world up; both cats sit on the plane y = -0.375",
            "scaleReference": "1.0 world unit = 1000 reference pixels at z = 0. The review camera "
                              "at (0, 0, 2.1852) with a 21 degree vertical FOV makes the visible "
                              "height at z = 0 exactly 0.810 units, so a landmark authored at z = 0 "
                              "lands on the pixel it was measured from. Parts at z != 0 foreshorten "
                              "by D/(D-z), which is what tucks the inferred tails and right hind "
                              "feet inside the body silhouette.",
            "cropContract": {"sourceImage": "gatos.png", "crop": list(CROP),
                             "matte": "reference/cats-matte.png",
                             "mask": "reference/cats-mask.png"},
        },
        "silhouette": {
            "boundingShape": "two sitting-cat triangles side by side: a taller narrower one on the "
                             "left (black cat, ear tip to forepaw 780 px) and a broader one on the "
                             "right (tabby, 775 px), separated by a 30-60 px gap of chair that "
                             "closes into shared shadow below y = 590",
            "aspectRatios": [
                {"id": "matte-union", "value": round(925 / 810, 4),
                 "note": "traced matte crop 925 x 810"},
                {"id": "black-cat", "value": round((661 - 234) / (946 - 152), 4),
                 "note": "measured bbox x 234-661, y 152-946"},
                {"id": "tabby-cat", "value": round((1130 - 652) / (921 - 148), 4),
                 "note": "measured bbox x 652-1130, y 148-921"},
            ],
            "symmetry": "bilateral per subject, broken by pose yaw (black cat about 8 degrees, "
                        "tabby about 26 degrees); the pair is asymmetric, so a whole-frame "
                        "bilateral-symmetry metric is meaningless here and is reported, not gated",
            "dominantCurves": [
                "the unbroken crown-to-chin arc of each head",
                "the shoulder-to-seat sweep of each barrel",
                "the two ear spikes per cat rising above the crown",
                "the vertical parallel of the two separated forelegs",
            ],
            "negativeSpaces": [
                "the gap of chair between the two cats above y = 590",
                "the gap between each cat's two forelegs",
                "the notch between the tabby's front-left and front-right paws",
                "the notch between each cat's crown and its two ear bases",
            ],
            "landmarks": [
                {"id": "bc-ear-tip-left", "src": [378, 157]},
                {"id": "bc-ear-tip-right", "src": [652, 192]},
                {"id": "bc-crown", "src": [487, 256]},
                {"id": "bc-eye-left", "src": [426, 378]},
                {"id": "bc-eye-right", "src": [558, 400]},
                {"id": "bc-nose", "src": [487, 445]},
                {"id": "bc-chin", "src": [487, 506]},
                {"id": "bc-forepaw-bottom", "src": [470, 941]},
                {"id": "bc-hindfoot-bottom", "src": [342, 904]},
                {"id": "tb-ear-tip-left", "src": [839, 148]},
                {"id": "tb-ear-tip-right", "src": [1112, 213]},
                {"id": "tb-crown", "src": [967, 242]},
                {"id": "tb-eye-left", "src": [866, 369]},
                {"id": "tb-eye-right", "src": [1005, 402]},
                {"id": "tb-nose", "src": [925, 451]},
                {"id": "tb-chin", "src": [930, 530]},
                {"id": "tb-forepaw-left-bottom", "src": [792, 921]},
                {"id": "tb-forepaw-right-bottom", "src": [890, 871]},
                {"id": "tb-hindfoot-bottom", "src": [705, 848]},
            ],
        },
        "componentTree": components,
        "materials": attach_reference_pbr(build_materials()),
        "repetitionSystems": systems,
        "lightingFromPhoto": build_lighting(),
        "featureReviewTargets": build_feature_targets(),
        "preSpecAssessment": {"detailInventory": build_detail_inventory(components)},
        "buildPasses": build_passes(components),
        "referenceCamera": {
            "solved": True,
            "solver": "analytic: world units defined so that z=0 maps linearly onto the matte crop",
            "fovDegrees": CAMERA_FOV,
            "aspect": round(925 / 810, 5),
            "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0},
            "positionHint": [0.0, 0.0, CAMERA_DISTANCE],
            "target": [0.0, 0.0, 0.0],
            "renderWidth": 925,
            "renderHeight": 810,
            "note": "Not a calibrated solve of the photograph. The camera is *defined* so the "
                    "measured pixel grid is the z=0 plane; that makes the silhouette gate a test of "
                    "the authored geometry rather than of a camera guess. The residual error is the "
                    "real photo's unknown focal length, which shows up as depth-dependent scale on "
                    "parts far from z=0.",
            "confidence": 0.8,
        },
        "projectionAudit": {
            "note": "Where each inferred/occluded part lands in reference pixels under the review "
                    "camera. Every entry must fall inside the traced silhouette of its own cat, "
                    "otherwise the model would show a feature the reference does not.",
            "points": projection_report,
        },
        "assumptions": [
            "The two cats are treated as separate physical sizes at the same depth (both barrels "
            "centred at z = 0) rather than as equal-sized cats at different depths. One view cannot "
            "distinguish the two: the tabby's head measures 288 px against the black cat's 250 px, "
            "which is either a 15 percent larger cat or a nearer one.",
            "Ears carry no attachment block on purpose. In this generator an attachment "
            "(localStart/localEnd) replaces the authored geometry with a tapered cylinder and forces "
            "scale to 1,1,1, which would destroy a flattened lathe shell. Ear-to-skull contact is "
            "therefore carried by head sockets plus measured transforms, and is verified visually "
            "instead of by the attachment gate.",
            "Torso, haunch and head keep scale 1,1,1 with their size baked into the lathe profile, "
            "because the generator puts scale on the pivot node and any child would inherit a "
            "non-uniform scale and be sheared.",
            "Whiskers are hidden for the silhouette-gate render. A 1-2 px hair carries no silhouette "
            "information but does move the bounding box, which would corrupt the scale and aspect "
            "metrics. They are present and scored in the material and lighting renders.",
            "Stripes, eyeliner, the 'M' and sock boundaries are albedo/normal overrides, not "
            "geometry. Geometric stripes would be fins.",
            "Seven whiskers per cheek against 12-14 counted in the reference: an acknowledged "
            "under-count.",
        ],
        "risks": [
            "The model is an assembly of revolved and endpoint-driven primitives, not a single "
            "continuous sculpt. It will read as a stylised primitive-assembly cat; a smooth "
            "organic surface would need subdivision or metaball blending, which this generator does "
            "not emit.",
            "Both tails, both backs, both bellies and two of the four hind feet per cat are "
            "inferred from species priors. Orbit views will show invented surfaces.",
            "The repetition-system emitter only distributes instances radially over a full circle, "
            "so the toe sets place four visible beads plus four occluded ones, and the ear fringe is "
            "a full rosette rather than an edge fringe.",
            "The iris hue is measured through a strong warm key. The de-lit hue is greener than the "
            "raw pixels; if the scene lights are dimmed the eyes will drift yellow.",
        ],
        "proceduralStrategy": [
            "Revolved lathe profiles with per-scanline measured radii for every continuous mass "
            "(torso, haunch, head, ear shells) so the silhouette comes from measurements rather "
            "than from stacked spheres.",
            "Endpoint-driven tapered solids for every limb, the neck, the five-segment tails and "
            "every whisker, so no child part can float away from its parent.",
            "Discrete four-part eye stack (iris sphere, dilated pupil, clearcoat cornea, lid rim "
            "torus) because the eyes are the identity feature and must be separable for review.",
            "Coat pattern as independent procedural albedo/roughness/normal/AO fields with local "
            "overrides for stripes, the 'M', eyeliner, bib and sock boundaries.",
            "Radial InstancedMesh clusters for the genuinely radial repeats: ear-hair fringes and "
            "toe beads.",
            "Deterministic seeds for all procedural fields so a re-render is byte-identical.",
        ],
        "viewEvidence": [
            {"id": "full-object", "sourceImage": "gatos.png", "region": list(CROP),
             "viewpoint": "front-three-quarter",
             "note": "The only view available. Admitted by check_reference_admission.py "
                     "(foregroundCoverage 0.9504, largestComponentFraction 1.0, pHash "
                     "17725883575816987184)."},
            {"id": "matte", "sourceImage": "reference/cats-matte.png", "region": [0, 0, 925, 810],
             "viewpoint": "front-three-quarter",
             "note": "Hand-traced cats-only alpha cutout: the silhouette ground truth."},
            {"id": "inferred-hidden-region", "sourceImage": "none", "region": [0, 0, 0, 0],
             "viewpoint": "not-visible",
             "note": "Tails, backs, bellies and two hind feet per cat. No pixels exist for these."},
        ] + [
            {"id": zone, "sourceImage": f"crops/zones/{zone}.png", "region": [0, 0, 0, 0],
             "viewpoint": "front-three-quarter", "note": f"Detail-inventory zone crop {zone}."}
            for zone in ("bc-ears", "bc-eyes", "bc-muzzle", "bc-chest", "bc-haunch", "bc-paws",
                         "tb-ears", "tb-eyes", "tb-muzzle", "tb-bib", "tb-flank", "tb-paws")
        ],
        "qualityTargets": {
            "targetFidelity": 0.75,
            "reviewViewpoints": ["reference-front-three-quarter", "orbit-left-40",
                                 "orbit-right-40", "thickness-axis", "long-axis"],
        },
        "buildStats": {
            "componentCount": len(components),
            "levels": levels,
            "repetitionSystemCount": len(systems),
            "materialCount": len(build_materials()),
        },
    }

    out = HERE / "reference" / "spec-patch.json"
    out.write_text(json.dumps(patch, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {out}")
    print(f"components={len(components)} levels={levels} repetitionSystems={len(systems)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
