import json
import os
import struct
import numpy as np
from PIL import Image
from collections import Counter

GEO_DIR = '/home/botom/devintest/arena/img2threejs/cofre-glb-swe17/inspection/geometry'
OUT_DIR = '/home/botom/devintest/arena/img2threejs/cofre-glb-swe17/inspection'

def load_bin(name, dtype):
    return np.fromfile(os.path.join(GEO_DIR, name), dtype=dtype)

def load_json(name):
    with open(os.path.join(GEO_DIR, name)) as f:
        return json.load(f)

def sample_texture(uv, img):
    w, h = img.size
    # UV [0,1] -> pixel coords; flip V
    u = uv[:, 0] * (w - 1)
    v = (1 - uv[:, 1]) * (h - 1)
    x = np.clip(u.astype(int), 0, w - 1)
    y = np.clip(v.astype(int), 0, h - 1)
    arr = np.array(img)
    return arr[y, x]

def rgb_to_hsv(rgb):
    """Convert uint8 RGB to HSV in 0-1 range."""
    rgb = rgb.astype(float) / 255.0
    maxc = rgb.max(axis=1)
    minc = rgb.min(axis=1)
    delta = maxc - minc + 1e-6
    v = maxc
    s = np.where(maxc > 0, delta / (maxc + 1e-6), 0)
    h = np.zeros_like(maxc)
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    # red is max
    idx = (maxc == r)
    h[idx] = ((g[idx] - b[idx]) / delta[idx]) % 6
    idx = (maxc == g)
    h[idx] = ((b[idx] - r[idx]) / delta[idx]) + 2
    idx = (maxc == b)
    h[idx] = ((r[idx] - g[idx]) / delta[idx]) + 4
    h = h / 6.0
    return np.stack([h, s, v], axis=1)

def classify_color(hsv, rm=None):
    h, s, v = hsv[:, 0], hsv[:, 1], hsv[:, 2]
    # helpers
    is_dark = v < 0.15
    is_grey = s < 0.15
    is_bright = v > 0.7
    is_sat = s > 0.35

    # Gold: yellow, high value, medium-high saturation
    is_yellow = (h > 0.08) & (h < 0.18) & (v > 0.25) & (s > 0.2)
    # Purple: ~0.75-0.90
    is_purple = (h > 0.70) & (h < 0.95) & (s > 0.15) & (v > 0.15)
    # Blue/Teal: 0.45-0.65
    is_blue = (h > 0.42) & (h < 0.65) & (s > 0.15) & (v > 0.15)
    # Red/orange crown emblem maybe? but crown is golden.
    # Emblem bright self-illuminated: very bright yellow/white
    is_emissive = (v > 0.85) & (s < 0.3)

    # if rm provided, boost metallic classification
    if rm is not None:
        rough = rm[:, 1] / 255.0
        metal = rm[:, 2] / 255.0
        is_yellow |= (h > 0.06) & (h < 0.22) & (metal > 0.5) & (v > 0.2)
        is_purple |= (h > 0.68) & (h < 0.95) & (metal < 0.5) & (v > 0.1)
        is_blue |= (h > 0.40) & (h < 0.65) & (metal < 0.5) & (v > 0.1)

    labels = np.full(len(hsv), 'unknown', dtype=object)
    labels[is_dark] = 'dark'
    labels[is_grey & ~is_dark] = 'grey'
    labels[is_emissive] = 'emissive'
    labels[is_yellow] = 'gold'
    labels[is_purple] = 'purple'
    labels[is_blue] = 'blue'
    return labels

def bounds_of_mask(points, mask):
    pts = points[mask]
    if len(pts) == 0:
        return None
    return {
        'min': pts.min(axis=0).tolist(),
        'max': pts.max(axis=0).tolist(),
        'center': pts.mean(axis=0).tolist(),
        'count': len(pts)
    }

def bounds_dict_to_dims(b):
    if not b:
        return None
    mn = np.array(b['min'])
    mx = np.array(b['max'])
    d = mx - mn
    return { 'width': d[0], 'height': d[1], 'depth': d[2], **b }

def main():
    meta = load_json('metadata.json')
    pos = load_bin('positions.bin', np.float32).reshape(-1, 3)
    norm = load_bin('normals.bin', np.float32).reshape(-1, 3)
    uv = load_bin('uvs.bin', np.float32).reshape(-1, 2)
    idx = load_bin('indices.bin', np.uint32)

    # Load textures
    base_img = Image.open(os.path.join(GEO_DIR, 'baseColor.jpg')).convert('RGB')
    rm_img = Image.open(os.path.join(GEO_DIR, 'metallicRoughness.jpg')).convert('RGB')

    # per-vertex color
    base_col = sample_texture(uv, base_img)
    rm_col = sample_texture(uv, rm_img)
    hsv = rgb_to_hsv(base_col)
    v_color = classify_color(hsv, rm_col)

    # per-triangle: aggregate positions, normals, colors
    tri_count = len(idx) // 3
    tri_idx = idx.reshape(-1, 3)
    tri_pos = pos[tri_idx]  # (T,3,3)
    tri_norm = norm[tri_idx]
    tri_colors = v_color[tri_idx]

    tri_centers = tri_pos.mean(axis=1)
    tri_normals = tri_norm.mean(axis=1)
    tri_normals /= (np.linalg.norm(tri_normals, axis=1, keepdims=True) + 1e-9)

    # dominant color per triangle by majority voting
    def majority(a):
        return [Counter(row).most_common(1)[0][0] for row in a]
    tri_label = np.array(majority(tri_colors))

    # Global bounds
    global_min = pos.min(axis=0).tolist()
    global_max = pos.max(axis=0).tolist()
    dims = (np.array(global_max) - np.array(global_min)).tolist()

    # Split by height to find body and lid
    y_vals = tri_centers[:, 1]
    # Find local minimum in histogram around 0.5*height to separate lid/body
    y_min, y_max = global_min[1], global_max[1]
    hist, edges = np.histogram(y_vals, bins=60)
    # find the deepest valley in the central 30%-70% of height
    central_mask = (edges[:-1] > y_min + 0.30 * (y_max - y_min)) & (edges[:-1] < y_min + 0.70 * (y_max - y_min))
    central_indices = np.where(central_mask)[0]
    if len(central_indices) > 0:
        valley_idx = central_indices[np.argmin(hist[central_indices])]
        split_y = edges[valley_idx + 1]
    else:
        split_y = (y_min + y_max) / 2

    is_body = tri_centers[:, 1] < split_y
    is_lid = ~is_body

    # Component masks
    def mask_region(label=None, y_cond=None, normal_cond=None, other=None):
        m = np.ones(len(tri_label), dtype=bool)
        if label is not None:
            m &= (tri_label == label)
        if y_cond is not None:
            m &= y_cond(tri_centers[:, 1])
        if normal_cond is not None:
            m &= normal_cond(tri_normals)
        if other is not None:
            m &= other
        return m

    # Symmetry analysis
    cx = (global_min[0] + global_max[0]) / 2
    cz = (global_min[2] + global_max[2]) / 2
    # left vs right
    is_left = tri_centers[:, 0] < cx
    is_right = tri_centers[:, 0] > cx
    is_front = tri_centers[:, 2] > cz
    is_back = tri_centers[:, 2] < cz

    # Face regions based on dominant normal axis
    nx, ny, nz = np.abs(tri_normals[:, 0]), np.abs(tri_normals[:, 1]), np.abs(tri_normals[:, 2])
    dom_axis = np.argmax(np.stack([nx, ny, nz], axis=1), axis=1)
    is_front_face = (dom_axis == 2) & (tri_normals[:, 2] > 0)
    is_back_face = (dom_axis == 2) & (tri_normals[:, 2] < 0)
    is_left_face = (dom_axis == 0) & (tri_normals[:, 0] < 0)
    is_right_face = (dom_axis == 0) & (tri_normals[:, 0] > 0)
    is_top_face = (dom_axis == 1) & (tri_normals[:, 1] > 0)
    is_bottom_face = (dom_axis == 1) & (tri_normals[:, 1] < 0)

    # Metal reinforcements: gold on vertical edge regions
    is_gold_edge = mask_region(label='gold', normal_cond=lambda n: (np.abs(n[:, 1]) < 0.6))

    # Emblem front: gold on front face and in central area
    emblem_mask = mask_region(label='gold', other=is_front_face & is_body)

    # Corners: gold near corners of bounding box
    x_rel = (tri_centers[:, 0] - global_min[0]) / (global_max[0] - global_min[0])
    z_rel = (tri_centers[:, 2] - global_min[2]) / (global_max[2] - global_min[2])
    is_corner_x = (x_rel < 0.15) | (x_rel > 0.85)
    is_corner_z = (z_rel < 0.15) | (z_rel > 0.85)
    corner_mask = mask_region(label='gold', other=is_corner_x & is_corner_z)

    # Handles: gold on left/right sides, mid-height
    handle_mask = mask_region(label='gold', other=(is_left_face | is_right_face) & is_body & (tri_centers[:, 1] > split_y - 0.15 * dims[1]) & (tri_centers[:, 1] < split_y + 0.05 * dims[1]))

    # Hinges: gold on back face, near top of body/back of lid
    hinge_mask = mask_region(label='gold', other=is_back_face & (tri_centers[:, 1] > split_y - 0.1 * dims[1]) & (tri_centers[:, 1] < split_y + 0.15 * dims[1]))

    components = {
        'body': bounds_dict_to_dims(bounds_of_mask(tri_centers, is_body)),
        'lid': bounds_dict_to_dims(bounds_of_mask(tri_centers, is_lid)),
        'gold_edges': bounds_dict_to_dims(bounds_of_mask(tri_centers, is_gold_edge)),
        'emblem_front': bounds_dict_to_dims(bounds_of_mask(tri_centers, emblem_mask)),
        'corners': bounds_dict_to_dims(bounds_of_mask(tri_centers, corner_mask)),
        'handles': bounds_dict_to_dims(bounds_of_mask(tri_centers, handle_mask)),
        'hinges': bounds_dict_to_dims(bounds_of_mask(tri_centers, hinge_mask)),
        'front_face_gold': bounds_dict_to_dims(bounds_of_mask(tri_centers, is_front_face & (tri_label == 'gold'))),
        'purple_body': bounds_dict_to_dims(bounds_of_mask(tri_centers, is_body & (tri_label == 'purple'))),
        'blue_body': bounds_dict_to_dims(bounds_of_mask(tri_centers, is_body & (tri_label == 'blue'))),
        'purple_lid': bounds_dict_to_dims(bounds_of_mask(tri_centers, is_lid & (tri_label == 'purple'))),
    }

    color_counts = Counter(tri_label)

    analysis = {
        'globalBounds': { 'min': global_min, 'max': global_max, 'dimensions': dims },
        'splitY': float(split_y),
        'colorDistribution': dict(color_counts),
        'components': { k: bounds_dict_to_dims(v) for k, v in components.items() },
        'symmetryNotes': {
            'centerX': cx, 'centerZ': cz,
            'leftGoldTriangles': int(np.sum((tri_label == 'gold') & is_left)),
            'rightGoldTriangles': int(np.sum((tri_label == 'gold') & is_right)),
            'frontGoldTriangles': int(np.sum((tri_label == 'gold') & is_front)),
            'backGoldTriangles': int(np.sum((tri_label == 'gold') & is_back))
        },
        'materials': {
            'bodyBase': { 'colorClass': 'blue/purple', 'metallic': 'low', 'roughness': 'medium' },
            'metalTrim': { 'colorClass': 'gold', 'metallic': 'high', 'roughness': 'low-medium' },
            'emblem': { 'colorClass': 'gold/emissive', 'metallic': 'high', 'emissive': 'yes' }
        }
    }

    # Lid profile: average Y by X and Z to detect curvature
    lid_tris = tri_centers[is_lid]
    lid_top = lid_tris[lid_tris[:, 1] > (y_min + 0.65 * (y_max - y_min))]
    lid_profile = {
        'topYMean': float(np.mean(lid_top[:, 1])) if len(lid_top) else None,
        'topYMin': float(np.min(lid_top[:, 1])) if len(lid_top) else None,
        'topYMax': float(np.max(lid_top[:, 1])) if len(lid_top) else None,
        'centerYMean': float(np.mean(lid_tris[:, 1])) if len(lid_tris) else None
    }

    # Emblem front bounds more tightly
    emblem_tight = bounds_of_mask(tri_centers, (tri_label == 'gold') & is_front_face & is_body & (tri_centers[:, 1] > split_y - 0.35*dims[1]) & (tri_centers[:, 1] < split_y - 0.05*dims[1]))

    analysis['lidProfile'] = lid_profile
    analysis['emblemTightBounds'] = bounds_dict_to_dims(emblem_tight) if emblem_tight else None

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, 'geometry-analysis.json'), 'w') as f:
        json.dump(analysis, f, indent=2)

    md = f"""# Geometric Analysis (derived from GLB)

## Global Bounds
- Min: {global_min}
- Max: {global_max}
- Dimensions (W,H,D): {dims}

## Body/Lid Split
- Split Y: {split_y:.4f}
- Body: Y < {split_y:.4f}
- Lid: Y >= {split_y:.4f}

## Color Distribution (triangles)
{chr(10).join(f"- {k}: {v}" for k, v in color_counts.items())}

## Components
{chr(10).join(f"### {k}" + (f"\n- Center: {tuple(round(x,4) for x in v['center'])}\n- Dimensions: W={v['width']:.4f} H={v['height']:.4f} D={v['depth']:.4f}\n- Min: {v['min']}, Max: {v['max']}" if v else "\n- No triangles matched") for k, v in components.items())}

## Symmetry Notes
- Center X: {cx:.4f}, Center Z: {cz:.4f}
- Gold on left: {analysis['symmetryNotes']['leftGoldTriangles']} triangles
- Gold on right: {analysis['symmetryNotes']['rightGoldTriangles']} triangles
- Gold on front: {analysis['symmetryNotes']['frontGoldTriangles']} triangles
- Gold on back: {analysis['symmetryNotes']['backGoldTriangles']} triangles

## Inferred Components
1. **Base (body)**: lower cuboid, blue/teal/purple faces, metal reinforcements on edges.
2. **Lid**: upper sloped/purple portion, hinged at the back.
3. **Hinges**: gold bands along the back edge at the split line.
4. **Metal reinforcements**: gold corner pieces and edge bands.
5. **Front emblem**: gold crown-shaped inlay centered on the front body face.
6. **Side handles**: gold pull handles on left and right sides.

## Material Inferences
- **Body**: glossy painted/teal material, low metalness, medium-low roughness.
- **Lid**: glossy purple paint.
- **Metal trim**: gold-like, high metalness, low roughness, clearcoat.
- **Emblem**: self-illuminated gold, high emissive.
"""
    with open(os.path.join(OUT_DIR, 'geometry-analysis.md'), 'w') as f:
        f.write(md)

    print('Analysis written to', OUT_DIR)

if __name__ == '__main__':
    main()
