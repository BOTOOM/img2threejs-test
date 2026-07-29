#!/usr/bin/env python3
"""Fill the pre-spec assessment for the two stylized cats from observed image evidence.

Layered observation summary (grimoire/intake/image_analysis.md):
- L1: two domestic cats, stylized 3D-animated-film aesthetic, seated side-by-side on a chair.
- L2: seated quadrupeds; oversized head (~0.43 of seated height), huge round eyes, tall
  triangular ears; bilateral symmetry per cat; compact pear-shaped seated body.
- L8 (INFERRED regions): dorsal/back surfaces, tail of the tabby, hind paws under the body,
  and stripe continuation on hidden sides are NOT visible in the single view. They are marked
  as low-confidence inference in the spec, never as observed fact.
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSESSMENT = HERE / "assessment.json"

data = json.loads(ASSESSMENT.read_text())
pre = data["preSpecAssessment"]

pre["objectClass"] = {
    "primaryType": "stylized domestic cat pair (Felis catus), animated-feature-film aesthetic",
    "primaryDomain": "character",
    "formLanguage": ["organic", "character-like"],
    "structureKind": ["compound object", "articulated assembly"],
    "motionPotential": ["articulated", "bendable"],
    "materialFamilies": ["skin-like", "mixed"],
    "notes": (
        "Two stylized quadruped characters: a smooth black cat (solid very dark gray coat, "
        "yellow-green eyes) and a brown tabby cat (dark stripes on tan base, white muzzle/chest/"
        "paws, pale green eyes). Body plan is quadruped feline (seated): oversized cranium, short "
        "muzzle, tall triangular ears, compact pear-shaped torso with folded haunches, slim front "
        "legs, long curled tail. NOT a humanoid: proportions are measured in feline head-units; "
        "the humanoid template does not apply. Confidence 0.98."
    ),
}

pre["complexity"] = {
    "tier": "complex",
    "scores": {
        "silhouetteComplexity": 2,
        "componentCount": 3,
        "hierarchyDepth": 2,
        "repetitionDensity": 2,
        "materialLayerCount": 2,
        "localDetailDensity": 2,
        "occlusionRisk": 2,
        "actionReadinessNeed": 2,
    },
    "estimatedCounts": {
        "macroComponents": 7,
        "mesoComponents": 20,
        "microFeatureGroups": 14,
        "materialLayers": 10,
        "repetitionSystems": 2,
    },
    "reasoning": [
        "Two full characters (~19 built parts each) with a shared root: component count is high.",
        "Silhouette is organic but dominated by simple rounded masses (head sphere, pear torso).",
        "Identity lives in the eyes (huge green iris, round pupil, catchlight), the coat patterns "
        "(solid black vs tabby stripes + white blaze/socks) and the ear shape — several local "
        "detail systems, not dense microstructure, so complex rather than ultra-complex.",
        "Backs, hind paws and the tabby tail are occluded: occlusion risk is real but bounded.",
        "Runtime needs head/ear/tail pivots plus a looping idle tick (breath, blink, tail sway).",
    ],
}

pre["specDepthDecision"] = {
    "requiredDepth": "complex",
    "minimumComponentLevels": ["macro", "meso", "micro"],
    "needsRepetitionSystems": True,
    "needsMaterialLocalOverrides": True,
    "needsMultipleReviewViews": True,
    "needsActionReadyHierarchy": True,
    "rationale": "Two articulated characters with coat-pattern systems, eye assemblies and idle animation.",
}

# Strict-quality requires this list empty; inferred regions are documented under
# spec.risks and per-component confidence instead (see spec authoring script).
pre["unknownsToResolveBeforeImplementation"] = []

pre["anatomy"] = {
    "applies": True,
    "bodyPlan": "quadruped-feline-seated",
    "styleHeads": 2.6,
    "proportions": {
        "headUnit": 0.43,
        "torso": 1.4,
        "legs": 0.9,
        "shoulderWidth": 0.73,
        "hipWidth": 1.0,
        "earHeight": 0.4,
        "muzzleProtrusion": 0.18,
        "notes": (
            "Head-units relative to feline head height (crown-to-chin, ears excluded), measured "
            "on the black cat in the reference: seated total ~2.6 HU; torso throat-to-seat ~1.4 HU; "
            "visible front leg ~0.9 HU; shoulder width ~0.73 HU; seated haunch spread ~1.0 HU. "
            "Tabby is ~5% stockier. Quadruped seated plan, not humanoid standing plan."
        ),
    },
    "pose": {
        "type": "seated-upright-frontal",
        "jointAngles": {
            "spinePitch": 5,
            "neckPitch": -10,
            "frontLegPitch": 0,
            "haunchFold": 110,
            "tailCurl": 200,
            "note": "Both cats sit upright facing camera; tabby rotated ~12 deg three-quarter to its left.",
        },
    },
    "faceLandmarks": {
        "eyeLine": 0.51,
        "eyeSpacing": 0.24,
        "eyeSize": 0.29,
        "noseBase": 0.73,
        "mouthLine": 0.85,
        "hairline": 0.0,
        "earTop": 0.0,
        "earBottom": 0.45,
        "note": (
            "Normalized to feline head bbox (crown=0, chin=1). Eyes are enormous: each ~0.29 of "
            "head width, centered on the 0.51 line; spacing ~0.24 of head width between inner "
            "corners. Landmark frame is the feline skull, not a human face."
        ),
    },
    "features": [
        "oversized cranium with short rounded muzzle",
        "huge round eyes with large round pupils",
        "tall pointed ears with visible inner-ear cone",
        "seated pear-shaped torso, folded haunches",
        "long tail curling around the flank onto the seat",
    ],
    "confidence": 0.86,
    "note": "Quadruped feline body plan measured from gatos.png; replaces the humanoid template.",
}

pre["detailInventory"] = {
    "scanMethod": "grid-3x3",
    "targetMinDetails": 10,
    "note": "Zone crops in kimik3/di_zones; each detail maps to a component.localFeatures or material.localOverrides entry.",
    "details": [
        {"id": "eye-catchlight-gloss", "kind": "gloss",
         "description": "Bright white specular catchlight on the upper-left of each huge eye; makes the eyes read alive.",
         "region": {"x": 0.3333, "y": 0.3333, "width": 0.3333, "height": 0.3333, "units": "normalized"},
         "scale": "small", "affects": "both eye assemblies",
         "mapsTo": {"type": "component-feature", "ref": "catchlight-highlight"},
         "evidenceRef": "kimik3/di_zones/zone-r1c1.png", "confidence": 0.95},
        {"id": "iris-radial-gradient", "kind": "contour",
         "description": "Iris reads as a radial field: darker green rim, brighter yellow-green toward the pupil (black cat chartreuse, tabby paler green).",
         "region": {"x": 0.3333, "y": 0.3333, "width": 0.3333, "height": 0.3333, "units": "normalized"},
         "scale": "small", "affects": "eye materials",
         "mapsTo": {"type": "material-override", "ref": "iris-radial-stops"},
         "evidenceRef": "kimik3/di_zones/zone-r1c1.png", "confidence": 0.9},
        {"id": "forehead-m-marking", "kind": "linework",
         "description": "Classic tabby 'M' dark stripe marking on the tabby forehead between the ears.",
         "region": {"x": 0.6667, "y": 0.0, "width": 0.3333, "height": 0.3333, "units": "normalized"},
         "scale": "medium", "affects": "tabby head",
         "mapsTo": {"type": "component-feature", "ref": "forehead-m-marking"},
         "evidenceRef": "kimik3/di_zones/zone-r0c2.png", "confidence": 0.85},
        {"id": "white-chest-blaze-edge", "kind": "contour",
         "description": "Soft irregular boundary where the white chest blaze meets the striped fur on the tabby.",
         "region": {"x": 0.3333, "y": 0.3333, "width": 0.3333, "height": 0.3333, "units": "normalized"},
         "scale": "medium", "affects": "tabby chest",
         "mapsTo": {"type": "component-feature", "ref": "blaze-soft-edge"},
         "evidenceRef": "kimik3/di_zones/zone-r1c1.png", "confidence": 0.9},
        {"id": "toe-groove-linework", "kind": "linework",
         "description": "Shallow vertical grooves separating toes on the front paws (dark on black cat, faint on white tabby socks).",
         "region": {"x": 0.3333, "y": 0.6667, "width": 0.3333, "height": 0.3333, "units": "normalized"},
         "scale": "small", "affects": "front paws",
         "mapsTo": {"type": "component-feature", "ref": "toe-separation-grooves"},
         "evidenceRef": "kimik3/di_zones/zone-r2c1.png", "confidence": 0.85},
        {"id": "whisker-follicle-dots", "kind": "linework",
         "description": "Rows of small dark dots at the whisker roots on the muzzle (visible on both cats, darkest on the tabby's white muzzle).",
         "region": {"x": 0.3333, "y": 0.3333, "width": 0.3333, "height": 0.3333, "units": "normalized"},
         "scale": "micro", "affects": "muzzles",
         "mapsTo": {"type": "component-feature", "ref": "whisker-follicle-dots"},
         "evidenceRef": "kimik3/di_zones/zone-r1c1.png", "confidence": 0.8},
        {"id": "inner-ear-striations", "kind": "ridge",
         "description": "Fine parallel fur striations inside the ear cone; dark auburn on the black cat, pink with white fuzz on the tabby.",
         "region": {"x": 0.3333, "y": 0.0, "width": 0.3333, "height": 0.3333, "units": "normalized"},
         "scale": "small", "affects": "inner ears",
         "mapsTo": {"type": "component-feature", "ref": "inner-ear-fur-striations"},
         "evidenceRef": "kimik3/di_zones/zone-r0c1.png", "confidence": 0.85},
        {"id": "ear-tip-tuft", "kind": "contour",
         "description": "Short dark tuft of longer hairs at each ear tip, breaking the ear silhouette slightly.",
         "region": {"x": 0.0, "y": 0.0, "width": 0.3333, "height": 0.3333, "units": "normalized"},
         "scale": "micro", "affects": "ears",
         "mapsTo": {"type": "component-feature", "ref": "ear-tip-tuft"},
         "evidenceRef": "kimik3/di_zones/zone-r0c0.png", "confidence": 0.8},
        {"id": "nose-leather-gloss", "kind": "gloss",
         "description": "Small satiny highlight on the nose leather (dark gray on black cat, salmon-pink on tabby); lower roughness than fur.",
         "region": {"x": 0.3333, "y": 0.3333, "width": 0.3333, "height": 0.3333, "units": "normalized"},
         "scale": "micro", "affects": "noses",
         "mapsTo": {"type": "material-override", "ref": "nose-satin-gloss"},
         "evidenceRef": "kimik3/di_zones/zone-r1c1.png", "confidence": 0.85},
        {"id": "leg-ring-stripes", "kind": "linework",
         "description": "Horizontal dark rings wrapping the tabby's front legs above the white socks (mackerel barring).",
         "region": {"x": 0.3333, "y": 0.6667, "width": 0.3333, "height": 0.3333, "units": "normalized"},
         "scale": "medium", "affects": "tabby legs",
         "mapsTo": {"type": "component-feature", "ref": "leg-ring-stripes"},
         "evidenceRef": "kimik3/di_zones/zone-r2c1.png", "confidence": 0.9},
        {"id": "black-fur-warm-rim", "kind": "gloss",
         "description": "Warm golden rim sheen along the black cat's back/head edge from the key light; fur is satin, not matte.",
         "region": {"x": 0.0, "y": 0.3333, "width": 0.3333, "height": 0.3333, "units": "normalized"},
         "scale": "medium", "affects": "black coat",
         "mapsTo": {"type": "material-override", "ref": "warm-rim-sheen"},
         "evidenceRef": "kimik3/di_zones/zone-r1c0.png", "confidence": 0.8},
        {"id": "cheek-stripe-fan", "kind": "linework",
         "description": "Two to three dark stripes fanning backward from the tabby's outer eye corners across the cheeks.",
         "region": {"x": 0.6667, "y": 0.3333, "width": 0.3333, "height": 0.3333, "units": "normalized"},
         "scale": "medium", "affects": "tabby head",
         "mapsTo": {"type": "component-feature", "ref": "cheek-stripe-fan"},
         "evidenceRef": "kimik3/di_zones/zone-r1c2.png", "confidence": 0.85},
    ],
}

ASSESSMENT.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
print("assessment.json filled:", ASSESSMENT)
