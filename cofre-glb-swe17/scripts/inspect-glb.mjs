import { NodeIO, getBounds } from '@gltf-transform/core';
import fs from 'fs';
import path from 'path';

const GLB_PATH = '/home/botom/devintest/arena/img2threejs/cofre.glb';
const OUT_DIR = '/home/botom/devintest/arena/img2threejs/cofre-glb-swe17/inspection';

function mat4Identity() {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}

function multiplyMat4(a, b) {
  const out = new Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] =
        a[i * 4 + 0] * b[0 * 4 + j] +
        a[i * 4 + 1] * b[1 * 4 + j] +
        a[i * 4 + 2] * b[2 * 4 + j] +
        a[i * 4 + 3] * b[3 * 4 + j];
    }
  }
  return out;
}

function quatToMat4([qx, qy, qz, qw]) {
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1
  ];
}

function trsToMat4(t, r, s) {
  const T = [
    1,0,0,0,
    0,1,0,0,
    0,0,1,0,
    t[0]||0, t[1]||0, t[2]||0, 1
  ];
  const R = quatToMat4(r);
  const S = [
    s[0]||1,0,0,0,
    0,s[1]||1,0,0,
    0,0,s[2]||1,0,
    0,0,0,1
  ];
  return multiplyMat4(multiplyMat4(T, R), S);
}

function transformPoint(m, v) {
  const x = v[0], y = v[1], z = v[2], w = 1;
  const tx = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  const ty = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  const tz = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  const tw = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  return [tx / tw, ty / tw, tz / tw];
}

function formatVec(v) {
  return v.map(n => Number(n.toFixed(6))).join(', ');
}

function dimFromBounds(b) {
  if (!b) return null;
  const [min, max] = [b.min, b.max];
  return {
    width: max[0] - min[0],
    height: max[1] - min[1],
    depth: max[2] - min[2],
    min: min.map(n => Number(n.toFixed(6))),
    max: max.map(n => Number(n.toFixed(6)))
  };
}

function getMeshLocalBounds(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const arr = pos.getArray();
    for (let i = 0; i < arr.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = arr[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  if (!min.every(isFinite)) return null;
  return { min, max };
}

function boundsCorners(bounds) {
  const { min, max } = bounds;
  return [
    [min[0], min[1], min[2]],
    [min[0], min[1], max[2]],
    [min[0], max[1], min[2]],
    [min[0], max[1], max[2]],
    [max[0], min[1], min[2]],
    [max[0], min[1], max[2]],
    [max[0], max[1], min[2]],
    [max[0], max[1], max[2]]
  ];
}

async function main() {
  const io = new NodeIO();
  const doc = await io.read(GLB_PATH);
  const root = doc.getRoot();

  const scene = root.listScenes()[0];

  const nodes = [];
  const materials = [];
  const meshes = [];

  const matMap = new Map();
  const meshMap = new Map();
  const sceneMin = [Infinity, Infinity, Infinity];
  const sceneMax = [-Infinity, -Infinity, -Infinity];

  function visit(node, parentMat, depth) {
    const t = node.getTranslation() || [0,0,0];
    const r = node.getRotation() || [0,0,0,1];
    const s = node.getScale() || [1,1,1];
    const localMat = trsToMat4(t, r, s);
    const worldMat = multiplyMat4(parentMat, localMat);

    const nInfo = {
      name: node.getName(),
      depth,
      translation: t.map(n => Number(n.toFixed(6))),
      rotation: r.map(n => Number(n.toFixed(6))),
      scale: s.map(n => Number(n.toFixed(6))),
      childrenCount: node.listChildren().length,
      meshName: null,
      worldBounds: null,
      localBounds: null
    };

    const mesh = node.getMesh();
    if (mesh) {
      nInfo.meshName = mesh.getName();
      if (!meshMap.has(mesh)) {
        const primitives = [];
        for (const prim of mesh.listPrimitives()) {
          const mat = prim.getMaterial();
          const pInfo = {
            mode: prim.getMode(),
            indices: prim.getIndices() ? prim.getIndices().getCount() : null,
            positions: prim.getAttribute('POSITION') ? prim.getAttribute('POSITION').getCount() : null,
            materialName: mat ? mat.getName() : null
          };
          if (mat && !matMap.has(mat)) {
            matMap.set(mat, {
              name: mat.getName(),
              baseColorFactor: mat.getBaseColorFactor?.() || null,
              roughnessFactor: mat.getRoughnessFactor?.() || null,
              metallicFactor: mat.getMetallicFactor?.() || null,
              emissiveFactor: mat.getEmissiveFactor?.() || null,
              alphaMode: mat.getAlphaMode?.() || null,
              doubleSided: mat.getDoubleSided?.() || null
            });
          }
          primitives.push(pInfo);
        }
        const localBounds = getMeshLocalBounds(mesh);
        meshMap.set(mesh, {
          name: mesh.getName(),
          primitiveCount: mesh.listPrimitives().length,
          primitives,
          localBounds: dimFromBounds(localBounds)
        });
      }
      const lb = meshMap.get(mesh).localBounds;
      if (lb) {
        const corners = boundsCorners({ min: lb.min, max: lb.max }).map(c => transformPoint(worldMat, c));
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (const c of corners) {
          for (let i = 0; i < 3; i++) {
            if (c[i] < min[i]) min[i] = c[i];
            if (c[i] > max[i]) max[i] = c[i];
            if (c[i] < sceneMin[i]) sceneMin[i] = c[i];
            if (c[i] > sceneMax[i]) sceneMax[i] = c[i];
          }
        }
        nInfo.worldBounds = { min: min.map(n => Number(n.toFixed(6))), max: max.map(n => Number(n.toFixed(6))) };
        nInfo.localBounds = lb;
      }
    }

    nodes.push(nInfo);

    for (const child of node.listChildren()) {
      visit(child, worldMat, depth + 1);
    }
  }

  for (const child of scene.listChildren()) {
    visit(child, mat4Identity(), 0);
  }

  const analysis = {
    sceneBounds: dimFromBounds({ min: sceneMin, max: sceneMax }),
    nodeCount: nodes.length,
    meshCount: meshMap.size,
    materialCount: matMap.size,
    nodes,
    meshes: Array.from(meshMap.values()),
    materials: Array.from(matMap.values())
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'glb-analysis.json'), JSON.stringify(analysis, null, 2));

  // Markdown hierarchy report
  let md = `# GLB Inspection: cofre.glb\n\n`;
  md += `## Scene Bounds\n`;
  md += `- Min: (${analysis.sceneBounds.min.join(', ')})\n`;
  md += `- Max: (${analysis.sceneBounds.max.join(', ')})\n`;
  md += `- Dimensions: W=${analysis.sceneBounds.width.toFixed(6)} H=${analysis.sceneBounds.height.toFixed(6)} D=${analysis.sceneBounds.depth.toFixed(6)}\n\n`;
  md += `## Summary\n`;
  md += `- Nodes: ${analysis.nodeCount}\n`;
  md += `- Meshes: ${analysis.meshCount}\n`;
  md += `- Materials: ${analysis.materialCount}\n\n`;

  md += `## Hierarchy\n\n`;
  for (const n of nodes) {
    const indent = '  '.repeat(n.depth);
    md += `${indent}- **${n.name || '(unnamed)'}**  \n`;
    md += `${indent}  - T: (${n.translation.join(', ')})  \n`;
    md += `${indent}  - R: (${n.rotation.join(', ')})  \n`;
    md += `${indent}  - S: (${n.scale.join(', ')})  \n`;
    if (n.meshName) {
      md += `${indent}  - Mesh: \`${n.meshName}\`  \n`;
      if (n.localBounds) {
        md += `${indent}  - Local bounds: min(${n.localBounds.min.join(', ')}) max(${n.localBounds.max.join(', ')})  \n`;
      }
      if (n.worldBounds) {
        md += `${indent}  - World bounds: min(${n.worldBounds.min.join(', ')}) max(${n.worldBounds.max.join(', ')})  \n`;
      }
    }
  }

  md += `\n## Meshes\n\n`;
  for (const m of analysis.meshes) {
    md += `### ${m.name || '(unnamed)'}\n`;
    md += `- Primitives: ${m.primitiveCount}\n`;
    if (m.localBounds) {
      md += `- Local bounds: min(${m.localBounds.min.join(', ')}) max(${m.localBounds.max.join(', ')})  \n`;
      md += `- Dimensions: W=${m.localBounds.width.toFixed(6)} H=${m.localBounds.height.toFixed(6)} D=${m.localBounds.depth.toFixed(6)}\n`;
    }
    for (const p of m.primitives) {
      md += `- Primitive: mode=${p.mode}, indices=${p.indices}, positions=${p.positions}, material=${p.materialName || 'none'}\n`;
    }
    md += '\n';
  }

  md += `\n## Materials\n\n`;
  for (const mat of analysis.materials) {
    md += `### ${mat.name || '(unnamed)'}\n`;
    md += `- Base color: ${JSON.stringify(mat.baseColorFactor)}\n`;
    md += `- Metallic: ${mat.metallicFactor}, Roughness: ${mat.roughnessFactor}\n`;
    md += `- Emissive: ${JSON.stringify(mat.emissiveFactor)}\n`;
    md += `- Alpha mode: ${mat.alphaMode}, Double sided: ${mat.doubleSided}\n\n`;
  }

  fs.writeFileSync(path.join(OUT_DIR, 'glb-inspection.md'), md);
  console.log(`Wrote ${path.join(OUT_DIR, 'glb-analysis.json')} and glb-inspection.md`);
}

main().catch(e => { console.error(e); process.exit(1); });
