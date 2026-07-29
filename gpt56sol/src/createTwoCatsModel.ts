import * as THREE from 'three';

export type SculptPass =
  | 'blockout'
  | 'structural-pass'
  | 'form-refinement'
  | 'material-pass'
  | 'lighting-pass'
  | 'interaction-pass'
  | 'optimization-pass';

export interface TwoCatsModelOptions {
  pass?: SculptPass;
  seed?: number;
}

type MaterialSet = {
  hidden: THREE.MeshPhysicalMaterial;
  blackFur: THREE.MeshPhysicalMaterial;
  tabbyFur: THREE.MeshPhysicalMaterial;
  whiteFur: THREE.MeshPhysicalMaterial;
  blackInnerEar: THREE.MeshPhysicalMaterial;
  tabbyInnerEar: THREE.MeshPhysicalMaterial;
  iris: THREE.MeshPhysicalMaterial;
  pupil: THREE.MeshPhysicalMaterial;
  cornea: THREE.MeshPhysicalMaterial;
  blackNose: THREE.MeshPhysicalMaterial;
  tabbyNose: THREE.MeshPhysicalMaterial;
  whisker: THREE.MeshPhysicalMaterial;
  stripe: THREE.MeshPhysicalMaterial;
  clayDark: THREE.MeshPhysicalMaterial;
  clayLight: THREE.MeshPhysicalMaterial;
  clayDetail: THREE.MeshPhysicalMaterial;
};

type RuntimeRegistry = {
  nodes: Record<string, THREE.Group>;
  meshes: Record<string, THREE.Mesh>;
  parts: Record<string, THREE.Group>;
  pivots: Record<string, THREE.Group>;
  colliders: Record<string, { type: string; size: THREE.Vector3 }>;
  sockets: Record<string, THREE.Object3D>;
  destructionGroups: Record<string, string[]>;
};

const PASS_RANK: Record<SculptPass, number> = {
  blockout: 0,
  'structural-pass': 1,
  'form-refinement': 2,
  'material-pass': 3,
  'lighting-pass': 4,
  'interaction-pass': 5,
  'optimization-pass': 6,
};

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function createTextureSet(seed: number, base: THREE.Color, accent: THREE.Color): {
  albedo: THREE.CanvasTexture;
  roughness: THREE.DataTexture;
  bump: THREE.DataTexture;
  ao: THREE.DataTexture;
} {
  const size = 256;
  const random = seededRandom(seed);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable.');
  const image = context.createImageData(size, size);
  const roughnessData = new Uint8Array(size * size);
  const bumpData = new Uint8Array(size * size);
  const aoData = new Uint8Array(size * size);
  const color = new THREE.Color();
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      const directional = 0.5 + 0.25 * Math.sin(y * 0.29 + Math.sin(x * 0.07) * 2.2);
      const grain = random() * 0.42 + directional * 0.58;
      color.copy(base).lerp(accent, grain * 0.28);
      const pixel = index * 4;
      image.data[pixel] = Math.round(color.r * 255);
      image.data[pixel + 1] = Math.round(color.g * 255);
      image.data[pixel + 2] = Math.round(color.b * 255);
      image.data[pixel + 3] = 255;
      roughnessData[index] = Math.round(178 + grain * 55);
      bumpData[index] = Math.round(92 + grain * 100);
      aoData[index] = Math.round(205 + directional * 42);
    }
  }
  context.putImageData(image, 0, 0);
  const albedo = new THREE.CanvasTexture(canvas);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  albedo.repeat.set(2.5, 3.5);
  const makeDataTexture = (data: Uint8Array): THREE.DataTexture => {
    const texture = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2.5, 3.5);
    texture.needsUpdate = true;
    return texture;
  };
  return {
    albedo,
    roughness: makeDataTexture(roughnessData),
    bump: makeDataTexture(bumpData),
    ao: makeDataTexture(aoData),
  };
}

function createMaterials(seed: number): MaterialSet {
  const physical = (parameters: THREE.MeshPhysicalMaterialParameters): THREE.MeshPhysicalMaterial =>
    new THREE.MeshPhysicalMaterial({ metalness: 0, ...parameters });
  const blackMaps = createTextureSet(seed + 1, new THREE.Color(0x1b1815), new THREE.Color(0x4a382c));
  const tabbyMaps = createTextureSet(seed + 2, new THREE.Color(0xa06f43), new THREE.Color(0xd0a06c));
  const whiteMaps = createTextureSet(seed + 3, new THREE.Color(0xdec9a9), new THREE.Color(0xf2e3ca));
  return {
    hidden: physical({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false }),
    blackFur: physical({ color: 0xffffff, map: blackMaps.albedo, roughness: 0.92, roughnessMap: blackMaps.roughness, bumpMap: blackMaps.bump, bumpScale: 0.018, aoMap: blackMaps.ao, aoMapIntensity: 0.35, sheen: 0.08, sheenColor: 0x392a21, sheenRoughness: 1 }),
    tabbyFur: physical({ color: 0xffffff, map: tabbyMaps.albedo, roughness: 0.88, roughnessMap: tabbyMaps.roughness, bumpMap: tabbyMaps.bump, bumpScale: 0.018, aoMap: tabbyMaps.ao, aoMapIntensity: 0.35, sheen: 0.06, sheenColor: 0xc4915f, sheenRoughness: 1 }),
    whiteFur: physical({ color: 0xffffff, map: whiteMaps.albedo, roughness: 0.9, roughnessMap: whiteMaps.roughness, bumpMap: whiteMaps.bump, bumpScale: 0.014, aoMap: whiteMaps.ao, aoMapIntensity: 0.3, sheen: 0.05, sheenColor: 0xffead0, sheenRoughness: 1 }),
    blackInnerEar: physical({ color: 0x4a2c25, roughness: 0.7, sheen: 0.16, sheenColor: 0x8d5b4f }),
    tabbyInnerEar: physical({ color: 0xb97962, roughness: 0.66, sheen: 0.18, sheenColor: 0xf0b09a }),
    iris: physical({ color: 0xc0c96a, roughness: 0.23, clearcoat: 0.28, clearcoatRoughness: 0.12, emissive: 0x101800, emissiveIntensity: 0.03 }),
    pupil: physical({ color: 0x020403, roughness: 0.12, clearcoat: 0.4, clearcoatRoughness: 0.05 }),
    cornea: physical({ color: 0xe2fff1, roughness: 0.03, transmission: 0.35, transparent: true, opacity: 0.24, clearcoat: 1, clearcoatRoughness: 0.02, ior: 1.38, depthWrite: false }),
    blackNose: physical({ color: 0x29201d, roughness: 0.26, clearcoat: 0.42, clearcoatRoughness: 0.08 }),
    tabbyNose: physical({ color: 0xc4785f, roughness: 0.28, clearcoat: 0.38, clearcoatRoughness: 0.08 }),
    whisker: physical({ color: 0xeadfce, roughness: 0.42 }),
    stripe: physical({ color: 0x2f2118, roughness: 0.92, sheen: 0.04, sheenColor: 0x533b2c, sheenRoughness: 1 }),
    clayDark: physical({ color: 0x6c625b, roughness: 0.88 }),
    clayLight: physical({ color: 0x93877d, roughness: 0.88 }),
    clayDetail: physical({ color: 0x776c63, roughness: 0.84 }),
  };
}

function createRegistry(): RuntimeRegistry {
  return { nodes: {}, meshes: {}, parts: {}, pivots: {}, colliders: {}, sockets: {}, destructionGroups: { 'soft-body': [] } };
}

function createPart(parent: THREE.Object3D, id: string, position: THREE.Vector3Tuple, registry: RuntimeRegistry, pivot = false): THREE.Group {
  const group = new THREE.Group();
  group.name = id;
  group.position.set(...position);
  group.userData.partId = id;
  parent.add(group);
  registry.nodes[id] = group;
  registry.parts[id] = group;
  registry.destructionGroups['soft-body'].push(id);
  if (pivot) registry.pivots[id] = group;
  const socket = new THREE.Object3D();
  socket.name = `${id}-socket`;
  group.add(socket);
  registry.sockets[socket.name] = socket;
  return group;
}

function addMesh(part: THREE.Group, id: string, geometry: THREE.BufferGeometry, material: THREE.Material, registry: RuntimeRegistry, scale: THREE.Vector3Tuple = [1, 1, 1], position: THREE.Vector3Tuple = [0, 0, 0]): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `${id}-mesh`;
  mesh.scale.set(...scale);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.partId = part.userData.partId;
  mesh.userData.explodeWithParent = true;
  part.add(mesh);
  registry.meshes[mesh.name] = mesh;
  registry.colliders[id] = { type: 'ellipsoid', size: new THREE.Vector3(...scale) };
  return mesh;
}

function ellipsoid(part: THREE.Group, id: string, scale: THREE.Vector3Tuple, material: THREE.Material, registry: RuntimeRegistry, position: THREE.Vector3Tuple = [0, 0, 0], segments = 32): THREE.Mesh {
  return addMesh(part, id, new THREE.SphereGeometry(1, segments, Math.max(16, segments / 2)), material, registry, scale, position);
}

function capsule(part: THREE.Group, id: string, radius: number, length: number, material: THREE.Material, registry: RuntimeRegistry, scale: THREE.Vector3Tuple = [1, 1, 1]): THREE.Mesh {
  return addMesh(part, id, new THREE.CapsuleGeometry(radius, length, 8, 18), material, registry, scale);
}

function triangularEar(part: THREE.Group, id: string, material: THREE.Material, registry: RuntimeRegistry, scale: THREE.Vector3Tuple): THREE.Mesh {
  const mesh = addMesh(part, id, new THREE.ConeGeometry(0.5, 1, 3, 1), material, registry, scale);
  mesh.geometry.rotateY(Math.PI / 2);
  return mesh;
}

function tube(parent: THREE.Group, id: string, points: THREE.Vector3[], radius: number, material: THREE.Material, registry: RuntimeRegistry, segments = 24): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points);
  return addMesh(parent, id, new THREE.TubeGeometry(curve, segments, radius, 6, false), material, registry);
}

function addInnerEarRidges(parent: THREE.Group, prefix: string, material: THREE.Material, registry: RuntimeRegistry): void {
  for (let index = 0; index < 5; index += 1) {
    const width = 0.07 + index * 0.012;
    const y = -0.11 + index * 0.055;
    tube(parent, `${prefix}-ridge-${index}`, [new THREE.Vector3(-width, y, 0.035), new THREE.Vector3(0, y + 0.045, 0.052), new THREE.Vector3(width, y, 0.035)], 0.006, material, registry, 12);
  }
}

function addWhiskerFan(parent: THREE.Group, prefix: string, side: -1 | 1, material: THREE.Material, registry: RuntimeRegistry, spread: number): void {
  for (let index = 0; index < 6; index += 1) {
    const vertical = (index - 2.5) * 0.055;
    const length = 0.55 + index * 0.035;
    tube(parent, `${prefix}-${index}`, [
      new THREE.Vector3(side * 0.13, vertical * 0.2, 0.02),
      new THREE.Vector3(side * (0.32 + index * 0.018), vertical, 0.08),
      new THREE.Vector3(side * length * spread, vertical + (index - 2.5) * 0.025, -0.02),
    ], 0.006, material, registry, 18);
  }
}

function addToeLobes(paw: THREE.Group, prefix: string, material: THREE.Material, registry: RuntimeRegistry, scale = 1): void {
  for (let index = 0; index < 3; index += 1) {
    const toe = new THREE.Mesh(new THREE.SphereGeometry(0.09 * scale, 18, 10), material);
    toe.name = `${prefix}-toe-${index}-mesh`;
    toe.position.set((index - 1) * 0.105 * scale, -0.015, 0.19 * scale + (index === 1 ? 0.025 : 0));
    toe.scale.set(1, 0.72, 1.22);
    toe.castShadow = true;
    toe.userData.partId = paw.userData.partId;
    toe.userData.explodeWithParent = true;
    paw.add(toe);
    registry.meshes[toe.name] = toe;
  }
}

function addEye(head: THREE.Group, cat: 'black' | 'tabby', side: 'l' | 'r', position: THREE.Vector3Tuple, size: number, materials: MaterialSet, registry: RuntimeRegistry, rank: number): THREE.Group {
  const eyeId = `${cat}-eye-${side}`;
  const irisId = `${cat}-iris-${side}`;
  const pupilId = `${cat}-pupil-${side}`;
  const corneaId = `${cat}-cornea-${side}`;
  const eye = createPart(head, eyeId, position, registry);
  const baseMaterial = rank >= 3 ? materials.iris : materials.clayDetail;
  ellipsoid(eye, eyeId, [size, size * 1.06, size * 0.62], baseMaterial, registry);
  if (rank >= 2) {
    const iris = createPart(eye, irisId, [0, 0, size * 0.54], registry);
    ellipsoid(iris, irisId, [size * 0.84, size * 0.88, size * 0.17], rank >= 3 ? materials.iris : materials.clayDetail, registry, [0, 0, 0], 24);
    const pupil = createPart(iris, pupilId, [0, 0, size * 0.15], registry);
    ellipsoid(pupil, pupilId, [size * 0.55, size * 0.59, size * 0.08], rank >= 3 ? materials.pupil : materials.clayDark, registry, [0, 0, 0], 24);
    const cornea = createPart(eye, corneaId, [0, 0, size * 0.63], registry);
    ellipsoid(cornea, corneaId, [size * 0.92, size * 0.96, size * 0.19], materials.cornea, registry, [0, 0, 0], 24);
    if (rank >= 3) {
      const highlight = new THREE.Mesh(new THREE.SphereGeometry(size * 0.12, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      highlight.name = `${cat}-eye-${side}-highlight-mesh`;
      highlight.position.set(-size * 0.28, size * 0.31, size * 0.8);
      highlight.userData.partId = eye.userData.partId;
      highlight.userData.explodeWithParent = true;
      eye.add(highlight);
      registry.meshes[highlight.name] = highlight;
    }
  }
  return eye;
}

function addStripeCurve(parent: THREE.Group, id: string, points: THREE.Vector3[], material: THREE.Material, registry: RuntimeRegistry, radius = 0.022): THREE.Mesh {
  const stripe = tube(parent, id, points, radius, material, registry, 20);
  stripe.castShadow = false;
  return stripe;
}

function addTabbyStripes(cat: THREE.Group, head: THREE.Group, legs: [THREE.Group, THREE.Group], materials: MaterialSet, registry: RuntimeRegistry): void {
  const forehead = createPart(head, 'tabby-forehead-stripes', [0, 0, 0], registry);
  addStripeCurve(forehead, 'tabby-forehead-m-left', [new THREE.Vector3(-0.24, 0.46, 0.58), new THREE.Vector3(-0.15, 0.28, 0.64), new THREE.Vector3(-0.05, 0.42, 0.65), new THREE.Vector3(0, 0.18, 0.67)], materials.stripe, registry, 0.012);
  addStripeCurve(forehead, 'tabby-forehead-m-right', [new THREE.Vector3(0.24, 0.46, 0.58), new THREE.Vector3(0.15, 0.28, 0.64), new THREE.Vector3(0.05, 0.42, 0.65), new THREE.Vector3(0, 0.18, 0.67)], materials.stripe, registry, 0.012);
  for (const side of [-1, 1] as const) {
    const cheek = createPart(head, `tabby-cheek-stripes-${side < 0 ? 'l' : 'r'}`, [0, 0, 0], registry);
    for (let index = 0; index < 3; index += 1) {
      addStripeCurve(cheek, `tabby-cheek-${side}-${index}`, [
        new THREE.Vector3(side * 0.46, 0.08 - index * 0.1, 0.53),
        new THREE.Vector3(side * 0.55, 0.03 - index * 0.105, 0.46),
        new THREE.Vector3(side * 0.62, -0.01 - index * 0.11, 0.34),
      ], materials.stripe, registry, 0.009);
    }
  }
  const torsoStripes = createPart(cat, 'tabby-torso-stripe-system', [0, 1.38, 0], registry);
  for (let index = 0; index < 6; index += 1) {
    const y = 0.43 - index * 0.16;
    for (const side of [-1, 1] as const) {
      addStripeCurve(torsoStripes, `tabby-torso-stripe-${side}-${index}`, [
        new THREE.Vector3(side * 0.5, y, 0.36),
        new THREE.Vector3(side * 0.42, y - 0.03, 0.6),
        new THREE.Vector3(side * 0.22, y - 0.055, 0.73),
      ], materials.stripe, registry, 0.011);
    }
  }
  legs.forEach((leg, sideIndex) => {
    const stripePart = createPart(leg, `tabby-leg-stripe-system-${sideIndex === 0 ? 'l' : 'r'}`, [0, 0, 0], registry);
    for (let index = 0; index < 3; index += 1) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.012, 6, 28), materials.stripe);
      ring.name = `tabby-leg-${sideIndex}-stripe-${index}-mesh`;
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.26 - index * 0.19;
      ring.scale.z = 1.12;
      ring.castShadow = false;
      ring.userData.partId = stripePart.userData.partId;
      ring.userData.explodeWithParent = true;
      stripePart.add(ring);
      registry.meshes[ring.name] = ring;
    }
  });
}

function buildBlackCat(root: THREE.Group, materials: MaterialSet, registry: RuntimeRegistry, rank: number): { torso: THREE.Group; head: THREE.Group; eyes: THREE.Group[]; ears: THREE.Group[]; tail?: THREE.Group } {
  const cat = createPart(root, 'black-cat', [-0.68, 0, 0], registry, true);
  const fur = rank >= 3 ? materials.blackFur : materials.clayDark;
  const detail = rank >= 3 ? materials.blackFur : materials.clayDetail;
  const torso = createPart(cat, 'black-torso', [0, 1.42, -0.04], registry);
  ellipsoid(torso, 'black-torso', [0.44, 0.88, 0.36], fur, registry);
  const rump = createPart(cat, 'black-rump', [-0.1, 0.75, -0.2], registry);
  ellipsoid(rump, 'black-rump', [0.51, 0.39, 0.41], fur, registry);
  const chest = createPart(cat, 'black-chest', [0, 1.48, 0.23], registry);
  ellipsoid(chest, 'black-chest', [0.36, 0.59, 0.23], fur, registry);
  const neck = createPart(cat, 'black-neck', [0, 2.24, 0.1], registry);
  ellipsoid(neck, 'black-neck', [0.34, 0.36, 0.3], fur, registry);
  const head = createPart(cat, 'black-head', [-0.02, 2.88, 0.22], registry, true);
  ellipsoid(head, 'black-head', [0.58, 0.59, 0.49], fur, registry);
  const ears: THREE.Group[] = [];
  for (const [side, x, rotation] of [['l', -0.39, 0.12], ['r', 0.39, -0.12]] as const) {
    const ear = createPart(head, `black-ear-${side}`, [x, 0.61, -0.02], registry, true);
    ear.rotation.z = rotation;
    triangularEar(ear, `black-ear-${side}`, fur, registry, [0.62, 0.78, 0.52]);
    ears.push(ear);
    if (rank >= 2) {
      const inner = createPart(ear, `black-inner-ear-${side}`, [0, -0.02, 0.19], registry);
      triangularEar(inner, `black-inner-ear-${side}`, rank >= 3 ? materials.blackInnerEar : materials.clayDetail, registry, [0.4, 0.55, 0.12]);
      addInnerEarRidges(inner, `black-inner-ear-${side}`, rank >= 3 ? materials.whisker : materials.clayLight, registry);
    }
  }
  const eyes = rank >= 1 ? [
    addEye(head, 'black', 'l', [-0.22, 0.1, 0.48], 0.15, materials, registry, rank),
    addEye(head, 'black', 'r', [0.22, 0.1, 0.48], 0.15, materials, registry, rank),
  ] : [];
  if (rank >= 1) {
    for (const [side, x] of [['l', -0.18], ['r', 0.18]] as const) {
      const muzzle = createPart(head, `black-muzzle-${side}`, [x * 0.72, -0.2, 0.51], registry);
      ellipsoid(muzzle, `black-muzzle-${side}`, [0.15, 0.1, 0.14], detail, registry);
      if (rank >= 2) {
        const whiskers = createPart(muzzle, `black-whiskers-${side}`, [0, 0, 0.13], registry);
        addWhiskerFan(whiskers, `black-whiskers-${side}`, side === 'l' ? -1 : 1, rank >= 3 ? materials.whisker : materials.clayLight, registry, 1.12);
      }
    }
    const nose = createPart(head, 'black-nose', [0, -0.16, 0.68], registry);
    const noseMesh = addMesh(nose, 'black-nose', new THREE.CircleGeometry(1, 3), rank >= 3 ? materials.blackNose : materials.clayDetail, registry, [0.14, 0.11, 1]);
    noseMesh.rotation.z = Math.PI / 2;
    const chin = createPart(head, 'black-chin', [0, -0.34, 0.46], registry);
    ellipsoid(chin, 'black-chin', [0.17, 0.08, 0.12], detail, registry);
  }
  for (const [side, x] of [['l', -0.24], ['r', 0.24]] as const) {
    const leg = createPart(cat, `black-front-leg-${side}`, [x, 0.72, 0.28], registry);
    capsule(leg, `black-front-leg-${side}`, 0.15, 0.82, fur, registry, [0.9, 1.12, 0.95]);
    const paw = createPart(cat, `black-front-paw-${side}`, [x, 0.16, 0.45], registry);
    ellipsoid(paw, `black-front-paw-${side}`, [0.25, 0.16, 0.32], fur, registry);
    if (rank >= 2) addToeLobes(paw, `black-front-paw-${side}`, fur, registry, 0.92);
    if (rank >= 1) {
      const hindLeg = createPart(cat, `black-hind-leg-${side}`, [x * 1.9, 0.44, -0.06], registry);
      ellipsoid(hindLeg, `black-hind-leg-${side}`, [0.25, 0.3, 0.3], fur, registry);
      const hindPaw = createPart(cat, `black-hind-paw-${side}`, [x * 1.65, 0.2, -0.08], registry);
      ellipsoid(hindPaw, `black-hind-paw-${side}`, [0.24, 0.13, 0.28], fur, registry);
    }
  }
  let tail: THREE.Group | undefined;
  if (rank >= 1) {
    tail = createPart(cat, 'black-tail', [-0.35, 0.52, -0.52], registry, true);
    tube(tail, 'black-tail', [new THREE.Vector3(0, 0.15, 0), new THREE.Vector3(-0.28, 0, -0.04), new THREE.Vector3(-0.4, -0.16, 0.02), new THREE.Vector3(-0.18, -0.24, 0.14)], 0.1, fur, registry, 36);
  }
  return { torso, head, eyes, ears, tail };
}

function buildTabbyCat(root: THREE.Group, materials: MaterialSet, registry: RuntimeRegistry, rank: number): { torso: THREE.Group; head: THREE.Group; eyes: THREE.Group[]; ears: THREE.Group[]; tail?: THREE.Group } {
  const cat = createPart(root, 'tabby-cat', [0.7, 0, 0.08], registry, true);
  const fur = rank >= 3 ? materials.tabbyFur : materials.clayLight;
  const white = rank >= 3 ? materials.whiteFur : materials.clayDetail;
  const torso = createPart(cat, 'tabby-torso', [-0.02, 1.36, -0.02], registry);
  ellipsoid(torso, 'tabby-torso', [0.52, 0.73, 0.42], fur, registry);
  const rump = createPart(cat, 'tabby-rump', [0.12, 1.0, -0.4], registry);
  ellipsoid(rump, 'tabby-rump', [0.54, 0.45, 0.45], fur, registry);
  const chest = createPart(cat, 'tabby-chest', [0, 1.43, 0.32], registry);
  ellipsoid(chest, 'tabby-chest', [0.41, 0.5, 0.26], fur, registry);
  const neck = createPart(cat, 'tabby-neck', [0.02, 2.2, 0.12], registry);
  ellipsoid(neck, 'tabby-neck', [0.37, 0.34, 0.31], fur, registry);
  if (rank >= 2) {
    const bib = createPart(chest, 'tabby-bib', [0, 0.13, 0.25], registry);
    ellipsoid(bib, 'tabby-bib', [0.23, 0.39, 0.065], white, registry);
  }
  const head = createPart(cat, 'tabby-head', [0.08, 2.75, 0.32], registry, true);
  ellipsoid(head, 'tabby-head', [0.64, 0.61, 0.53], fur, registry);
  const ears: THREE.Group[] = [];
  for (const [side, x, rotation] of [['l', -0.42, 0.1], ['r', 0.42, -0.16]] as const) {
    const ear = createPart(head, `tabby-ear-${side}`, [x, 0.59, -0.03], registry, true);
    ear.rotation.z = rotation;
    triangularEar(ear, `tabby-ear-${side}`, fur, registry, [0.64, 0.79, 0.54]);
    ears.push(ear);
    if (rank >= 2) {
      const inner = createPart(ear, `tabby-inner-ear-${side}`, [0, -0.02, 0.2], registry);
      triangularEar(inner, `tabby-inner-ear-${side}`, rank >= 3 ? materials.tabbyInnerEar : materials.clayDetail, registry, [0.42, 0.56, 0.12]);
      addInnerEarRidges(inner, `tabby-inner-ear-${side}`, rank >= 3 ? materials.whisker : materials.clayLight, registry);
    }
  }
  const eyes = rank >= 1 ? [
    addEye(head, 'tabby', 'l', [-0.24, 0.11, 0.52], 0.17, materials, registry, rank),
    addEye(head, 'tabby', 'r', [0.24, 0.11, 0.52], 0.17, materials, registry, rank),
  ] : [];
  if (rank >= 1) {
    for (const [side, x] of [['l', -0.19], ['r', 0.19]] as const) {
      const muzzle = createPart(head, `tabby-muzzle-${side}`, [x * 0.75, -0.2, 0.56], registry);
      ellipsoid(muzzle, `tabby-muzzle-${side}`, [0.17, 0.12, 0.15], white, registry);
      if (rank >= 2) {
        const whiskers = createPart(muzzle, `tabby-whiskers-${side}`, [0, 0, 0.14], registry);
        addWhiskerFan(whiskers, `tabby-whiskers-${side}`, side === 'l' ? -1 : 1, rank >= 3 ? materials.whisker : materials.clayLight, registry, 1.18);
      }
    }
    const nose = createPart(head, 'tabby-nose', [0, -0.15, 0.73], registry);
    const noseMesh = addMesh(nose, 'tabby-nose', new THREE.CircleGeometry(1, 3), rank >= 3 ? materials.tabbyNose : materials.clayDetail, registry, [0.15, 0.12, 1]);
    noseMesh.rotation.z = Math.PI / 2;
    const chin = createPart(head, 'tabby-chin', [0, -0.35, 0.51], registry);
    ellipsoid(chin, 'tabby-chin', [0.19, 0.09, 0.13], white, registry);
  }
  const frontLegs: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  for (const [index, side, x] of [[0, 'l', -0.3], [1, 'r', 0.3]] as const) {
    const leg = createPart(cat, `tabby-front-leg-${side}`, [x, 0.72, 0.34], registry);
    frontLegs[index] = leg;
    capsule(leg, `tabby-front-leg-${side}`, 0.17, 0.67, fur, registry, [0.95, 1.05, 1]);
    const paw = createPart(cat, `tabby-front-paw-${side}`, [x, 0.17, 0.54], registry);
    ellipsoid(paw, `tabby-front-paw-${side}`, [0.28, 0.17, 0.35], white, registry);
    if (rank >= 2) addToeLobes(paw, `tabby-front-paw-${side}`, white, registry, 1.05);
    if (rank >= 1) {
      const hindLeg = createPart(cat, `tabby-hind-leg-${side}`, [x * 1.45, 0.68, -0.2], registry);
      capsule(hindLeg, `tabby-hind-leg-${side}`, 0.16, 0.42, fur, registry, [1, 1, 1.05]);
      const hindPaw = createPart(cat, `tabby-hind-paw-${side}`, [x * 1.25, 0.2, -0.16], registry);
      ellipsoid(hindPaw, `tabby-hind-paw-${side}`, [0.23, 0.13, 0.27], white, registry);
    }
  }
  let tail: THREE.Group | undefined;
  if (rank >= 1) {
    tail = createPart(cat, 'tabby-tail', [0.38, 0.72, -0.72], registry, true);
    tube(tail, 'tabby-tail', [new THREE.Vector3(0, 0.18, 0), new THREE.Vector3(0.28, 0.04, -0.1), new THREE.Vector3(0.4, -0.14, -0.02), new THREE.Vector3(0.23, -0.22, 0.12)], 0.1, fur, registry, 36);
  }
  if (rank >= 2) addTabbyStripes(cat, head, frontLegs, materials, registry);
  return { torso, head, eyes, ears, tail };
}

function configureExplode(root: THREE.Group, registry: RuntimeRegistry): (amount: number) => void {
  root.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  const entries = Object.values(registry.parts).map((part) => {
    const world = part.getWorldPosition(new THREE.Vector3());
    let depth = 0;
    let current: THREE.Object3D | null = part.parent;
    while (current && current !== root) {
      depth += 1;
      current = current.parent;
    }
    return { part, world, depth };
  }).sort((a, b) => a.depth - b.depth);
  return (amount: number): void => {
    const factor = 1 + Math.max(0, amount);
    for (const entry of entries) {
      const targetWorld = center.clone().add(entry.world.clone().sub(center).multiplyScalar(factor));
      const parent = entry.part.parent;
      if (!parent) continue;
      parent.updateMatrixWorld(true);
      entry.part.position.copy(parent.worldToLocal(targetWorld));
      entry.part.updateMatrixWorld(true);
    }
  };
}

function pickPart(registry: RuntimeRegistry, object: THREE.Object3D | null): THREE.Group | null {
  let current = object;
  while (current) {
    const partId = current.userData.partId as string | undefined;
    if (partId && registry.parts[partId]) return registry.parts[partId];
    current = current.parent;
  }
  return null;
}

export function createTwoCatsModel(options: TwoCatsModelOptions = {}): THREE.Group {
  const pass = options.pass ?? 'optimization-pass';
  const rank = PASS_RANK[pass];
  const materials = createMaterials(options.seed ?? 5602);
  const registry = createRegistry();
  const root = createPart(new THREE.Group(), 'root', [0, 0, 0], registry, true);
  root.name = 'two-stylized-quadruped-cats';
  root.scale.x = 1.45;
  const black = buildBlackCat(root, materials, registry, rank);
  const tabby = buildTabbyCat(root, materials, registry, rank);
  root.updateMatrixWorld(true);
  const explode = configureExplode(root, registry);
  const base = {
    blackTorsoScale: black.torso.scale.clone(),
    tabbyTorsoScale: tabby.torso.scale.clone(),
    blackHeadRotation: black.head.rotation.clone(),
    tabbyHeadRotation: tabby.head.rotation.clone(),
    blackEarRotations: black.ears.map((ear) => ear.rotation.clone()),
    tabbyEarRotations: tabby.ears.map((ear) => ear.rotation.clone()),
    blackTailRotation: black.tail?.rotation.clone(),
    tabbyTailRotation: tabby.tail?.rotation.clone(),
  };
  const tick = (elapsedSeconds: number): void => {
    const breath = Math.sin(elapsedSeconds * Math.PI * 0.5);
    black.torso.scale.set(base.blackTorsoScale.x * (1 + breath * 0.012), base.blackTorsoScale.y * (1 + breath * 0.018), base.blackTorsoScale.z * (1 + breath * 0.028));
    tabby.torso.scale.set(base.tabbyTorsoScale.x * (1 + breath * 0.014), base.tabbyTorsoScale.y * (1 + breath * 0.017), base.tabbyTorsoScale.z * (1 + breath * 0.03));
    black.head.rotation.set(base.blackHeadRotation.x + Math.sin(elapsedSeconds * 0.55) * 0.012, base.blackHeadRotation.y + Math.sin(elapsedSeconds * 0.42) * 0.022, base.blackHeadRotation.z);
    tabby.head.rotation.set(base.tabbyHeadRotation.x + Math.sin(elapsedSeconds * 0.48 + 0.8) * 0.014, base.tabbyHeadRotation.y + Math.sin(elapsedSeconds * 0.37 + 1.1) * 0.024, base.tabbyHeadRotation.z);
    const blinkClosure = (offset: number): number => {
      const phase = (elapsedSeconds + offset) % 5.6;
      return phase < 0.18 ? Math.sin((phase / 0.18) * Math.PI) ** 4 : 0;
    };
    const blackBlink = 1 - blinkClosure(0) * 0.9;
    const tabbyBlink = 1 - blinkClosure(1.9) * 0.9;
    black.eyes.forEach((eye) => eye.scale.set(1, blackBlink, 1));
    tabby.eyes.forEach((eye) => eye.scale.set(1, tabbyBlink, 1));
    black.ears.forEach((ear, index) => {
      const initial = base.blackEarRotations[index];
      ear.rotation.set(initial.x, initial.y + Math.sin(elapsedSeconds * 0.9 + index) * 0.015, initial.z + Math.sin(elapsedSeconds * 0.7 + index) * 0.012);
    });
    tabby.ears.forEach((ear, index) => {
      const initial = base.tabbyEarRotations[index];
      ear.rotation.set(initial.x, initial.y + Math.sin(elapsedSeconds * 0.82 + index + 0.4) * 0.017, initial.z + Math.sin(elapsedSeconds * 0.65 + index) * 0.012);
    });
    if (black.tail && base.blackTailRotation) black.tail.rotation.set(base.blackTailRotation.x, base.blackTailRotation.y + Math.sin(elapsedSeconds * 0.72) * 0.11, base.blackTailRotation.z + Math.sin(elapsedSeconds * 0.54) * 0.045);
    if (tabby.tail && base.tabbyTailRotation) tabby.tail.rotation.set(base.tabbyTailRotation.x, base.tabbyTailRotation.y + Math.sin(elapsedSeconds * 0.65 + 1.2) * 0.13, base.tabbyTailRotation.z + Math.sin(elapsedSeconds * 0.49 + 0.5) * 0.05);
  };
  root.userData.tick = tick;
  root.userData.sculptRuntime = {
    pass,
    bodyPlan: 'quadruped',
    deterministicSeed: options.seed ?? 5602,
    nodes: registry.nodes,
    meshes: registry.meshes,
    parts: registry.parts,
    pivots: registry.pivots,
    sockets: registry.sockets,
    colliders: registry.colliders,
    destructionGroups: registry.destructionGroups,
    setExplode: explode,
    pickPart: (object: THREE.Object3D | null) => pickPart(registry, object),
    inferredRegions: {
      blackPosterior: 0.45,
      blackTail: 0.3,
      tabbyPosterior: 0.45,
      tabbyTail: 0.3,
    },
  };
  tick(0);
  return root;
}
