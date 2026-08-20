import { NodeIO } from '@gltf-transform/core';
import fs from 'fs';
import path from 'path';

const GLB_PATH = '/home/botom/devintest/arena/img2threejs/cofre.glb';
const OUT_DIR = '/home/botom/devintest/arena/img2threejs/cofre-glb-swe17/inspection/geometry';

function writeTypedArray(arr, file) {
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  fs.writeFileSync(file, buf);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const io = new NodeIO();
  const doc = await io.read(GLB_PATH);
  const root = doc.getRoot();

  const scene = root.listScenes()[0];
  const node = scene.listChildren()[0];
  const mesh = node.getMesh();
  const primitive = mesh.listPrimitives()[0];

  const posAcc = primitive.getAttribute('POSITION');
  const normAcc = primitive.getAttribute('NORMAL');
  const uvAcc = primitive.getAttribute('TEXCOORD_0');
  const idxAcc = primitive.getIndices();

  const metadata = {
    node: {
      name: node.getName(),
      translation: node.getTranslation(),
      rotation: node.getRotation(),
      scale: node.getScale()
    },
    positions: { file: 'positions.bin', count: posAcc.getCount(), componentType: posAcc.getComponentType(), type: posAcc.getType() },
    normals: normAcc ? { file: 'normals.bin', count: normAcc.getCount(), componentType: normAcc.getComponentType(), type: normAcc.getType() } : null,
    uvs: uvAcc ? { file: 'uvs.bin', count: uvAcc.getCount(), componentType: uvAcc.getComponentType(), type: uvAcc.getType() } : null,
    indices: idxAcc ? { file: 'indices.bin', count: idxAcc.getCount(), componentType: idxAcc.getComponentType(), type: idxAcc.getType() } : null
  };

  writeTypedArray(posAcc.getArray(), path.join(OUT_DIR, 'positions.bin'));
  if (normAcc) writeTypedArray(normAcc.getArray(), path.join(OUT_DIR, 'normals.bin'));
  if (uvAcc) writeTypedArray(uvAcc.getArray(), path.join(OUT_DIR, 'uvs.bin'));
  if (idxAcc) writeTypedArray(idxAcc.getArray(), path.join(OUT_DIR, 'indices.bin'));

  // Textures
  const mat = primitive.getMaterial();
  const textureSlots = [
    { name: 'baseColor', tex: mat.getBaseColorTexture() },
    { name: 'normal', tex: mat.getNormalTexture() },
    { name: 'metallicRoughness', tex: mat.getMetallicRoughnessTexture() }
  ];

  for (const { name, tex } of textureSlots) {
    if (!tex) continue;
    const img = tex.getImage();
    const mime = tex.getMimeType();
    const ext = mime === 'image/jpeg' ? 'jpg' : (mime === 'image/png' ? 'png' : 'bin');
    const fn = path.join(OUT_DIR, `${name}.${ext}`);
    fs.writeFileSync(fn, Buffer.from(img));
    metadata[name] = { file: `${name}.${ext}`, mime, width: null, height: null };
  }

  fs.writeFileSync(path.join(OUT_DIR, 'metadata.json'), JSON.stringify(metadata, null, 2));
  console.log('Geometry extracted to', OUT_DIR);
}

main().catch(e => { console.error(e); process.exit(1); });
