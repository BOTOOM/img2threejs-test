# Inference Notes

## What the GLB provides (source of truth)
- A single triangulated mesh (`tripo_mesh_*`) with 318,439 vertices, 500,528 triangles, and one material.
- Bounding box: W≈1.0, H≈0.783, D≈0.747.
- A single root node at (0,0,0) with no authored hierarchy, pivots, or named components.
- Three JPEG textures: baseColor, normal, roughness/metallic.

## Inferred from spatial + texture analysis
- Body/lid split inferred from a Y-height histogram valley at Y≈0.548.
- Body color zone inferred from blue/teal texels; lid color zone from purple texels.
- Metal/gold trim inferred from yellow/high-saturation texels combined with the roughness/metallic map.
- Front/back/left/right/top face orientation inferred from vertex normals.
- Symmetry center at X≈0, Z≈0.

## Inferred from the visual reference
- Gold metal finish, glossy purple lid, glossy teal/blue body.
- Crown emblem is self-illuminated gold.
- Corner guards are chamfered gold blocks.
- Hinges are gold cylinders along the rear seam.
- Handles are U-shaped gold bars on the left/right sides.
- Lid shape: reference shows a truncated-pyramid / beveled roof; the GLB bounding box alone does not reveal this, so the roof form is inferred from the reference image.
- Missing geometry: the GLB has no interior; the lid opens as a solid rigid shell.

## Design choices
- Used `BoxGeometry`/`RoundedBoxGeometry` for the body and trim.
- Used a 4-sided `CylinderGeometry` for the lid to approximate the reference's truncated roof.
- Used `ExtrudeGeometry` + `Shape` for the crown emblem.
- Used `TorusGeometry` for the side handles.
- Each major part is a separate `Object3D` under the root, with `bodyPivot` and `lidPivot` exposed for animation.
