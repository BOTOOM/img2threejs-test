# Quality Review

## Render vs reference
- Reference: `crown-chest.png`
- Render: `render.png`
- Comparison sheet: `comparison.png`

## Overall assessment
The procedural reconstruction reproduces the macro silhouette, color zones, material gloss, and component hierarchy of the GLB-derived and image-validated chest.

## Layer scores (qualitative)
- Silhouette / proportions: 0.80 — overall width/height/depth match the GLB; lid-to-body ratio matches the split at Y≈0.548.
- Component structure: 0.85 — body, lid, hinges, corner guards, reinforcements, handles, and emblem are present and independently addressable.
- Form detail: 0.70 — lid is a truncated pyramid approximating the reference; corner guards are rounded boxes. The exact chamfered metal corner shape and small rivets from the reference are approximated.
- Material / surface: 0.80 — teal body, purple lid, gold trim, and glowing emblem are visually close; roughness and metalness are tuned from the image.
- Lighting / camera: 0.75 — three-quarter view and key/fill/rim lighting are set up to match the reference; some highlight blowout remains on the lid.

## What matches
- Two-tone color scheme (teal base, purple lid, gold trim).
- Crown emblem centered on the front of the body.
- Symmetric corner guards and edge reinforcements.
- Side handles and rear hinges.
- Glossy, metallic-looking surfaces.
- Openable lid pivot at the rear.

## What differs
- The reference has more rounded/chamfered corner guards and visible rivets; the procedural version uses simple rounded boxes.
- The reference lid has a softer, more beveled roof and a continuous gold rim; the procedural lid is a 4-sided truncated pyramid with separate trim.
- The emblem in the reference has a stronger glow and a wider, more stylized crown; our emblem is a 5-peak extruded shape.
- Color gradients and reflections are approximate; the image is a painted source while the model uses canvas gradient textures and environment reflections.

## Decision
- **Action:** `continue`
- The model meets the strict-quality threshold for a procedural reconstruction: geometry and proportions derived from the GLB, colors and materials validated against the image, and the hierarchy is animation-ready with `bodyPivot` and `lidPivot` exposed.
