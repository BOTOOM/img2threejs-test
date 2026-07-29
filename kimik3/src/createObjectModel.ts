import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Two stylized cats — procedural Three.js reconstruction (img2threejs pipeline)
// Hand-refined factory implementing kimik3/object-sculpt-spec.json (schema 2.1).
// Units: feline head-units (1 = black-cat crown-to-chin). Seat plane y=0, +Z front.
// Quadruped body plan: oversized cranium, pear torso, slim legs, curled tail.
// ---------------------------------------------------------------------------

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

// ---------------------------------------------------------------- utilities

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexCss(hex: string): string {
  return hex.startsWith('#') ? hex : `#${hex}`;
}

function shade(hex: string, factor: number): string {
  const h = hex.replace('#', '');
  const r = Math.min(255, Math.max(0, Math.round(parseInt(h.slice(0, 2), 16) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(parseInt(h.slice(2, 4), 16) * factor)));
  const b = Math.min(255, Math.max(0, Math.round(parseInt(h.slice(4, 6), 16) * factor)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return [canvas, ctx];
}

function toTexture(canvas: HTMLCanvasElement, srgb: boolean, anisotropy: number): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Short-fur mottle: soft blotches + fine directional strokes over the base tone.
function furCanvas(base: string, secondary: string[], seed: number, size: number): HTMLCanvasElement {
  const rnd = mulberry32(seed);
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = hexCss(base);
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 260; i += 1) {
    const c = secondary[Math.floor(rnd() * secondary.length)];
    ctx.fillStyle = c;
    ctx.globalAlpha = 0.05 + rnd() * 0.07;
    const r = size * (0.02 + rnd() * 0.09);
    ctx.beginPath();
    ctx.ellipse(rnd() * size, rnd() * size, r, r * (0.5 + rnd()), rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 0.10;
  ctx.strokeStyle = shade(base, 1.25);
  ctx.lineWidth = Math.max(1, size / 512);
  for (let i = 0; i < 900; i += 1) {
    const x = rnd() * size; const y = rnd() * size;
    const len = size * (0.008 + rnd() * 0.02);
    const a = Math.PI / 2 + (rnd() - 0.5) * 0.9;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return canvas;
}

// Independent roughness field (value noise) — never derived from the albedo map.
function roughnessCanvas(mean: number, spread: number, seed: number, size: number): HTMLCanvasElement {
  const rnd = mulberry32(seed);
  const [canvas, ctx] = makeCanvas(size);
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i += 1) {
    const v = Math.min(255, Math.max(0, Math.round(255 * (mean + (rnd() - 0.5) * spread))));
    image.data[i * 4] = v; image.data[i * 4 + 1] = v; image.data[i * 4 + 2] = v; image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

// Tabby stripe field. orientation: 'flank' bands vary with u (vertical bars),
// 'rings' bands vary with v (horizontal hoops), 'head' clusters them top-center.
function tabbyStripeCanvas(base: string, stripe: string, belly: string, seed: number, size: number,
                           orientation: 'flank' | 'rings' | 'head'): HTMLCanvasElement {
  const rnd = mulberry32(seed);
  const canvas = furCanvas(base, [shade(base, 1.1), belly, shade(base, 0.9)], seed, size);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = hexCss(stripe);
  const bands = orientation === 'rings' ? 10 : 18;
  for (let b = 0; b < bands; b += 1) {
    const t = (b + 0.5) / bands;
    const w = size * (0.011 + rnd() * 0.012);
    ctx.globalAlpha = 0.62 + rnd() * 0.26;
    ctx.beginPath();
    if (orientation === 'rings') {
      const y = t * size + (rnd() - 0.5) * size * 0.02;
      ctx.ellipse(size / 2, y, size * 0.75, w * 1.4, 0, 0, Math.PI * 2);
    } else if (orientation === 'flank') {
      const x = t * size + (rnd() - 0.5) * size * 0.02;
      ctx.ellipse(x, size / 2, w, size * (0.14 + rnd() * 0.10), (rnd() - 0.5) * 0.5, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  if (orientation === 'head') {
    // forehead: three thin vertical bars between the ears (the 'M' core)
    ctx.globalAlpha = 0.65;
    for (let s = -2; s <= 2; s += 1) {
      ctx.beginPath();
      ctx.ellipse(size / 2 + s * size * 0.055, size * 0.075, size * 0.011, size * 0.075, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // cheek fans: two angled bars sweeping back from each eye corner
    for (const side of [-1, 1]) {
      for (let f = 0; f < 2; f += 1) {
        ctx.beginPath();
        ctx.ellipse(size / 2 + side * size * (0.20 + f * 0.09), size * (0.16 + f * 0.10),
                    size * 0.010, size * 0.10, side * 0.65, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;
  return canvas;
}

// Radial iris field for the spherical cap (pole at texture top edge):
// bright ring near the pupil, mid green, darker limbal edge, radial striations.
function irisCanvas(mid: string, bright: string, limbal: string, seed: number, size: number): HTMLCanvasElement {
  const rnd = mulberry32(seed);
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = hexCss(mid);
  ctx.fillRect(0, 0, size, size);
  const band = size * 0.306; // cap half-angle 55 deg -> v in [0.694, 1]
  const grad = ctx.createLinearGradient(0, 0, 0, band);
  grad.addColorStop(0.0, hexCss(bright));
  grad.addColorStop(0.45, hexCss(mid));
  grad.addColorStop(0.85, hexCss(limbal));
  grad.addColorStop(1.0, shade(limbal, 0.7));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, band);
  ctx.strokeStyle = shade(limbal, 0.85);
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = Math.max(1, size / 256);
  for (let i = 0; i < 130; i += 1) {
    const x = rnd() * size;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + (rnd() - 0.5) * size * 0.03, band);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return canvas;
}

// ---------------------------------------------------------------- materials

type FurSpec = {
  base: string; secondary: string[]; roughness: number; clearcoat: number;
  seed: number; stripe?: 'flank' | 'rings' | 'head'; stripeColor?: string; belly?: string;
};

function furMaterial(spec: FurSpec, texSize: number, aniso: number): THREE.MeshPhysicalMaterial {
  const albedo = spec.stripe
    ? tabbyStripeCanvas(spec.base, spec.stripeColor ?? '#463426', spec.belly ?? spec.base, spec.seed, texSize, spec.stripe)
    : furCanvas(spec.base, spec.secondary, spec.seed, texSize);
  const material = new THREE.MeshPhysicalMaterial({
    map: toTexture(albedo, true, aniso),
    roughnessMap: toTexture(roughnessCanvas(spec.roughness, 0.18, spec.seed + 7, 256), false, aniso),
    roughness: 1.0,
    metalness: 0.0,
    clearcoat: spec.clearcoat,
    clearcoatRoughness: 0.55,
  });
  material.userData.proceduralMapsIndependent = true;
  return material;
}

function glossMaterial(color: string, roughness: number, clearcoat: number, seed: number,
                       texSize: number, aniso: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: hexCss(color),
    roughnessMap: toTexture(roughnessCanvas(roughness, 0.08, seed, 128), false, aniso),
    roughness: 1.0,
    metalness: 0.0,
    clearcoat,
    clearcoatRoughness: 0.2,
  });
}

// ---------------------------------------------------------------- geometry

const TORSO_PROFILE: [number, number][] = [
  [0.02, 0.0], [0.38, 0.02], [0.43, 0.25], [0.37, 0.55], [0.30, 0.89],
  [0.27, 1.10], [0.24, 1.30], [0.17, 1.46], [0.02, 1.54],
];

function torsoGeometry(): THREE.LatheGeometry {
  const pts = TORSO_PROFILE.map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, 48);
}

function earGeometry(width: number, height: number, depth: number): THREE.ExtrudeGeometry {
  const w = width / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-w, 0);
  shape.quadraticCurveTo(-w * 1.02, height * 0.45, -w * 0.52, height * 0.78);
  shape.quadraticCurveTo(-w * 0.30, height * 0.98, 0, height);
  shape.quadraticCurveTo(w * 0.30, height * 0.98, w * 0.52, height * 0.78);
  shape.quadraticCurveTo(w * 1.02, height * 0.45, w, 0);
  shape.quadraticCurveTo(0, -height * 0.10, -w, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: depth * 0.35, bevelSize: width * 0.04, bevelSegments: 3, curveSegments: 24 });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

function tailGeometry(spine: [number, number][] | [number, number, number][], segments = 40): THREE.TubeGeometry {
  const pts = (spine as [number, number, number][]).map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
  return new THREE.TubeGeometry(curve, segments, 0.052, 12, false);
}

function whiskerGeometry(root: THREE.Vector3, mid: THREE.Vector3, tip: THREE.Vector3): THREE.TubeGeometry {
  const curve = new THREE.CatmullRomCurve3([root, mid, tip], false, 'centripetal', 0.5);
  return new THREE.TubeGeometry(curve, 10, 0.0038, 5, false);
}

// ------------------------------------------------------------------- config

type CatConfig = {
  prefix: 'bc' | 'tc';
  name: string;
  position: [number, number, number];
  yaw: number;
  scale: number;
  fur: FurSpec;
  legFur: FurSpec;
  eye: { mid: string; bright: string; limbal: string };
  noseColor: string;
  innerEarColor: string;
  muzzleWhite: boolean;
  tabby: boolean;
  tailSpine: [number, number, number][];
  tailConfidence: number;
  phase: number;
};

const TAIL_BC: [number, number, number][] = [
  [0.10, 0.30, -0.38], [-0.20, 0.15, -0.40], [-0.42, 0.09, -0.22],
  [-0.50, 0.07, 0.05], [-0.44, 0.065, 0.30], [-0.24, 0.06, 0.44], [-0.05, 0.06, 0.42],
];
const TAIL_TC: [number, number, number][] = TAIL_BC.map(([x, y, z]) => [-x, y, z] as [number, number, number]);

const CATS: CatConfig[] = [
  {
    prefix: 'bc', name: 'blackCat', position: [-0.62, 0, 0.02], yaw: 0.09, scale: 1.0,
    fur: { base: '#26242c', secondary: ['#302e36', '#1c1b21', '#3c3a44'], roughness: 0.66, clearcoat: 0.12, seed: 101 },
    legFur: { base: '#26242c', secondary: ['#302e36', '#1c1b21'], roughness: 0.66, clearcoat: 0.12, seed: 102 },
    eye: { mid: '#b7c448', bright: '#d3dd7a', limbal: '#3a4518' },
    noseColor: '#241d1a', innerEarColor: '#4a332c', muzzleWhite: false, tabby: false,
    tailSpine: TAIL_BC, tailConfidence: 0.8, phase: 0.0,
  },
  {
    prefix: 'tc', name: 'tabbyCat', position: [0.62, 0, -0.04], yaw: -0.45, scale: 1.06,
    fur: { base: '#8f7154', secondary: ['#6b5238', '#a98a68'], roughness: 0.72, clearcoat: 0.05, seed: 201,
           stripe: 'flank', stripeColor: '#463426', belly: '#a98a68' },
    legFur: { base: '#8f7154', secondary: ['#6b5238', '#a98a68'], roughness: 0.72, clearcoat: 0.05, seed: 202,
              stripe: 'rings', stripeColor: '#463426' },
    eye: { mid: '#a5c783', bright: '#cfe3a8', limbal: '#3f5230' },
    noseColor: '#b9746a', innerEarColor: '#c98d76', muzzleWhite: true, tabby: true,
    tailSpine: TAIL_TC, tailConfidence: 0.35, phase: 1.7,
  },
];

// ------------------------------------------------------------------ builder

type BuiltPart = { node: THREE.Object3D; mesh: THREE.Mesh | null };

function tag(mesh: THREE.Mesh, componentId: string, integral: boolean): void {
  mesh.userData.componentId = componentId;
  if (integral) mesh.userData.explodeWithParent = true;
}

function makePartNode(id: string, nodes: Record<string, THREE.Object3D>, parent: THREE.Object3D): THREE.Group {
  const node = new THREE.Group();
  node.name = id;
  parent.add(node);
  nodes[id] = node;
  return node;
}

function addMesh(part: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material,
                 meshes: Record<string, THREE.Mesh>, id: string, integral = false): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = integral ? `${id}.${meshes[`${id}#count`] ? 'x' : 'mesh'}` : id;
  tag(mesh, id, integral);
  part.add(mesh);
  if (!integral) meshes[id] = mesh;
  return mesh;
}

function addSocket(nodes: Record<string, THREE.Object3D>, sockets: Record<string, THREE.Object3D>,
                   ownerId: string, socketId: string, pos: [number, number, number]): void {
  const s = new THREE.Object3D();
  s.name = `${ownerId}/${socketId}`;
  s.position.set(pos[0], pos[1], pos[2]);
  s.userData.socket = { id: socketId };
  (nodes[ownerId] ?? nodes.root).add(s);
  sockets[s.name] = s;
}

type AnimHandles = {
  torso: THREE.Object3D; headPivot: THREE.Object3D; tailPivot: THREE.Object3D;
  earL: THREE.Object3D; earR: THREE.Object3D;
  lidL: THREE.Object3D; lidR: THREE.Object3D;
  baseEarLz: number; baseEarRz: number;
  baseLidLx: number; baseLidRx: number;
  phase: number;
  explodeChildren: { node: THREE.Object3D; base: THREE.Vector3 }[];
};

function buildCat(cfg: CatConfig, parent: THREE.Object3D, nodes: Record<string, THREE.Object3D>,
                  meshes: Record<string, THREE.Mesh>, sockets: Record<string, THREE.Object3D>,
                  texSize: number, aniso: number): AnimHandles {
  const p = cfg.prefix;
  const group = makePartNode(cfg.name, nodes, parent);
  group.position.set(...cfg.position);
  group.rotation.y = cfg.yaw;
  group.scale.setScalar(cfg.scale);

  const furMat = furMaterial(cfg.fur, texSize, aniso);
  const legFurMat = cfg.legFur === cfg.fur ? furMat : furMaterial(cfg.legFur, texSize, aniso);
  const whiteMat = furMaterial({ base: '#f4efe4', secondary: ['#e2dacb', '#fbf8f0'], roughness: 0.72, clearcoat: 0.0, seed: 303 }, texSize, aniso);
  const innerEarMat = furMaterial({ base: cfg.innerEarColor, secondary: [shade(cfg.innerEarColor, 1.2), shade(cfg.innerEarColor, 0.75)], roughness: 0.6, clearcoat: 0.0, seed: 304 }, texSize, aniso);
  const noseMat = glossMaterial(cfg.noseColor, 0.3, 0.5, 305, texSize, aniso);
  const pupilMat = glossMaterial('#0b0b0d', 0.15, 0.6, 306, texSize, aniso);
  const irisMat = new THREE.MeshPhysicalMaterial({
    map: toTexture(irisCanvas(cfg.eye.mid, cfg.eye.bright, cfg.eye.limbal, 307, texSize), true, aniso),
    roughness: 0.1, metalness: 0, clearcoat: 1.0, clearcoatRoughness: 0.08,
  });
  const eyeballMat = glossMaterial(cfg.eye.limbal, 0.1, 1.0, 308, texSize, aniso);
  const catchMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const whiskerMat = new THREE.MeshStandardMaterial({ color: '#f2efe8', roughness: 0.5, metalness: 0 });
  const grooveMat = new THREE.MeshStandardMaterial({ color: shade(cfg.tabby ? '#8a7a66' : '#141216', 0.8), roughness: 0.9 });

  // ---- torso (macro)
  const torsoNode = makePartNode(`${p}-torso`, nodes, group);
  const torso = addMesh(torsoNode, torsoGeometry(), furMat, meshes, `${p}-torso`);
  torso.scale.set(1, 1, 1.08);
  addSocket(nodes, sockets, `${p}-torso`, 'neckSocket', [0, 1.42, 0.02]);
  addSocket(nodes, sockets, `${p}-torso`, 'tailSocket', [cfg.tabby ? -0.10 : 0.10, 0.30, -0.38]);
  addSocket(nodes, sockets, `${p}-torso`, 'legSocketFL', [0.135, 0.95, 0.18]);
  addSocket(nodes, sockets, `${p}-torso`, 'legSocketFR', [-0.135, 0.95, 0.18]);
  addSocket(nodes, sockets, `${p}-torso`, 'haunchSocketL', [0.30, 0.50, -0.05]);
  addSocket(nodes, sockets, `${p}-torso`, 'haunchSocketR', [-0.30, 0.50, -0.05]);
  addSocket(nodes, sockets, `${p}-torso`, 'chestSocket', [0, 0.98, 0.28]);

  // ---- head pivot at the neck joint; head subtree hangs below it
  const headPivot = new THREE.Group();
  headPivot.name = `${p}-headPivot`;
  headPivot.position.set(0, 1.52, 0.02);
  group.add(headPivot);

  const headNode = makePartNode(`${p}-head`, nodes, headPivot);
  headNode.position.set(0, 0.33, 0.03); // head centre at cat-local y=1.85
  headNode.scale.setScalar(0.88); // reference head is ~0.37 of seated height, not chibi 0.43
  if (cfg.tabby) headPivot.rotation.z = 0.06; // reference tabby leans its head toward the black cat
  const headMat = cfg.tabby
    ? furMaterial({ ...cfg.fur, stripe: 'head', seed: 203 }, texSize, aniso)
    : furMat;
  const head = addMesh(headNode, new THREE.SphereGeometry(0.5, 48, 32), headMat, meshes, `${p}-head`);
  head.scale.set(1.07, 0.98, 0.92);
  addSocket(nodes, sockets, `${p}-head`, 'eyeSocketL', [0.205, 0.08, 0.35]);
  addSocket(nodes, sockets, `${p}-head`, 'eyeSocketR', [-0.205, 0.08, 0.35]);
  addSocket(nodes, sockets, `${p}-head`, 'earSocketL', [0.30, 0.30, -0.02]);
  addSocket(nodes, sockets, `${p}-head`, 'earSocketR', [-0.30, 0.30, -0.02]);
  addSocket(nodes, sockets, `${p}-head`, 'muzzleSocket', [0, -0.16, 0.46]);
  addSocket(nodes, sockets, `${p}-head`, 'noseSocket', [0, -0.08, 0.50]);

  // ---- muzzle + nose + mouth + whiskers
  const muzzleNode = makePartNode(`${p}-muzzle`, nodes, headNode);
  muzzleNode.position.set(0, -0.19, 0.42);
  const muzzle = addMesh(muzzleNode, new THREE.SphereGeometry(0.5, 32, 24), cfg.muzzleWhite ? whiteMat : furMat, meshes, `${p}-muzzle`);
  muzzle.scale.set(0.36, 0.21, 0.26);

  const noseNode = makePartNode(`${p}-nose`, nodes, headNode);
  noseNode.position.set(0, -0.11, 0.50);
  const nose = addMesh(noseNode, new THREE.SphereGeometry(0.5, 24, 16), noseMat, meshes, `${p}-nose`);
  nose.scale.set(0.085, 0.05, 0.05);

  const mouthNode = makePartNode(`${p}-mouth`, nodes, headNode);
  mouthNode.position.set(0, -0.155, 0.53);
  {
    const pts = [new THREE.Vector3(-0.045, 0, 0), new THREE.Vector3(0, -0.022, 0.012), new THREE.Vector3(0.045, 0, 0)];
    const mouth = addMesh(mouthNode, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.007, 6, false), noseMat, meshes, `${p}-mouth`);
    mouth.scale.set(1, 1, 1);
  }

  const whiskerNode = makePartNode(`${p}-whiskers`, nodes, headNode);
  whiskerNode.position.set(0, -0.17, 0.42);
  {
    const rnd = mulberry32(400 + (cfg.tabby ? 1 : 0));
    for (const side of [1, -1]) {
      for (let i = 0; i < 4; i += 1) {
        const dy = (i - 1.5) * 0.028;
        const root = new THREE.Vector3(side * 0.10, -0.02 + dy, 0.03);
        const mid = new THREE.Vector3(side * (0.24 + rnd() * 0.04), -0.03 + dy * 1.6, 0.13);
        const tip = new THREE.Vector3(side * (0.34 + rnd() * 0.06), -0.12 + dy * 2.0, 0.15 - rnd() * 0.04);
        const strand = addMesh(whiskerNode, whiskerGeometry(root, mid, tip), whiskerMat, meshes, `${p}-whiskers`, true);
        strand.name = `${p}-whiskers.strand${side > 0 ? 'L' : 'R'}${i}`;
      }
    }
  }

  // ---- eyes (assembly per side)
  const lids: THREE.Object3D[] = [];
  const lidBaseX: number[] = [];
  for (const [side, sx] of [['l', 0.19], ['r', -0.19]] as const) {
    const eyeNode = makePartNode(`${p}-eye-${side}`, nodes, headNode);
    eyeNode.position.set(sx, 0.09, 0.35);
    const ball = addMesh(eyeNode, new THREE.SphereGeometry(0.15, 40, 28), eyeballMat, meshes, `${p}-eye-${side}`);
    ball.scale.set(1, 1, 0.88);
    // iris cap: pole rotated to face +Z, radial texture
    const capGeo = new THREE.SphereGeometry(0.151, 40, 20, 0, Math.PI * 2, 0, THREE.MathUtils.degToRad(55));
    capGeo.rotateX(Math.PI / 2);
    addMesh(eyeNode, capGeo, irisMat, meshes, `${p}-eye-${side}`, true).name = `${p}-eye-${side}.iris`;

    const pupilNode = makePartNode(`${p}-pupil-${side}`, nodes, eyeNode);
    pupilNode.position.set(0, 0, 0.128);
    const pupil = addMesh(pupilNode, new THREE.SphereGeometry(0.075, 24, 16), pupilMat, meshes, `${p}-pupil-${side}`);
    pupil.scale.set(1, 1, 0.35);

    const limbalNode = makePartNode(`${p}-limbal-${side}`, nodes, eyeNode);
    limbalNode.position.set(0, 0, 0.124);
    addMesh(limbalNode, new THREE.TorusGeometry(0.142, 0.004, 8, 48), pupilMat, meshes, `${p}-limbal-${side}`);

    const catchNode = makePartNode(`${p}-catchlight-${side}`, nodes, eyeNode);
    catchNode.position.set(-0.046, 0.055, 0.128);
    addMesh(catchNode, new THREE.SphereGeometry(0.021, 12, 8), catchMat, meshes, `${p}-catchlight-${side}`);

    // eyelid: fur cap parked open above the eye, rotates down on blink
    const lidNode = makePartNode(`${p}-eyelid-${side}`, nodes, eyeNode);
    const lidGeo = new THREE.SphereGeometry(0.163, 32, 16, 0, Math.PI * 2, 0, THREE.MathUtils.degToRad(62));
    lidGeo.rotateX(Math.PI / 2);
    const lid = addMesh(lidNode, lidGeo, furMat, meshes, `${p}-eyelid-${side}`);
    lid.position.set(0, 0, 0.012);
    lidNode.rotation.x = -2.05; // parked open (cap up/back)
    lids.push(lidNode);
    lidBaseX.push(-2.05);
  }

  // ---- ears + inner ears
  const earNodes: THREE.Object3D[] = [];
  const earBaseZ: number[] = [];
  for (const [side, sx, tilt] of [['l', 0.265, -0.16], ['r', -0.265, 0.16]] as const) {
    const earNode = makePartNode(`${p}-ear-${side}`, nodes, headNode);
    earNode.position.set(sx, 0.40, -0.03);
    earNode.rotation.set(-0.10, 0, tilt);
    addMesh(earNode, earGeometry(0.33, cfg.tabby ? 0.48 : 0.50, 0.06), furMat, meshes, `${p}-ear-${side}`);

    const innerNode = makePartNode(`${p}-inner-ear-${side}`, nodes, earNode);
    innerNode.position.set(0, 0.03, 0.048);
    innerNode.scale.set(0.62, 0.72, 0.5);
    addMesh(innerNode, earGeometry(0.30, 0.42, 0.02), innerEarMat, meshes, `${p}-inner-ear-${side}`);
    earNodes.push(earNode);
    earBaseZ.push(tilt);
  }

  // ---- legs + paws
  for (const [side, sx] of [['fl', 0.155], ['fr', -0.155]] as const) {
    const legNode = makePartNode(`${p}-leg-${side}`, nodes, group);
    legNode.position.set(sx, 0.52, 0.36);
    addMesh(legNode, new THREE.CapsuleGeometry(0.062, 0.84, 8, 24), legFurMat, meshes, `${p}-leg-${side}`);

    const pawNode = makePartNode(`${p}-paw-${side}`, nodes, group);
    pawNode.position.set(sx, 0.07, 0.47);
    const paw = addMesh(pawNode, new THREE.SphereGeometry(0.5, 24, 16), cfg.tabby ? whiteMat : furMat, meshes, `${p}-paw-${side}`);
    paw.scale.set(0.19, 0.11, 0.26);
    for (let g = 0; g < 2; g += 1) {
      const groove = addMesh(pawNode, new THREE.TorusGeometry(0.055 + g * 0.035, 0.005, 6, 16, Math.PI * 0.75), grooveMat, meshes, `${p}-paw-${side}`, true);
      groove.name = `${p}-paw-${side}.groove${g}`;
      groove.position.set(0, 0.045, 0.10);
      groove.rotation.set(-1.15, 0, Math.PI * 0.62 - g * 0.35);
    }
  }

  // ---- haunches (folded hind legs; volumes inferred from the seated pose)
  for (const [side, sx] of [['l', 0.33], ['r', -0.33]] as const) {
    const hNode = makePartNode(`${p}-haunch-${side}`, nodes, group);
    hNode.position.set(sx, 0.30, -0.02);
    const h = addMesh(hNode, new THREE.SphereGeometry(0.5, 32, 24), cfg.tabby ? legFurMat : furMat, meshes, `${p}-haunch-${side}`);
    h.scale.set(0.36, 0.52, 0.55);
    h.rotation.y = -sx * 0.4;
  }

  // ---- tail (black cat: observed curl; tabby: inferred mirror)
  const tailPivot = new THREE.Group();
  tailPivot.name = `${p}-tailPivot`;
  tailPivot.position.set(...cfg.tailSpine[0]);
  group.add(tailPivot);
  const tailNode = makePartNode(`${p}-tail`, nodes, tailPivot);
  {
    const localSpine = cfg.tailSpine.map(([x, y, z]) => [x - cfg.tailSpine[0][0], y - cfg.tailSpine[0][1], z - cfg.tailSpine[0][2]] as [number, number, number]);
    const tailMat = cfg.tabby
      ? furMaterial({ ...cfg.legFur, stripe: 'rings', seed: 204 }, texSize, aniso)
      : furMat;
    addMesh(tailNode, tailGeometry(localSpine), tailMat, meshes, `${p}-tail`);
    const tip = addMesh(tailNode, new THREE.SphereGeometry(0.05, 16, 12), tailMat, meshes, `${p}-tail`, true);
    tip.name = `${p}-tail.tip`;
    tip.position.set(...localSpine[localSpine.length - 1]);
  }

  // ---- white chest blaze (tabby only)
  if (cfg.tabby) {
    const chestNode = makePartNode(`${p}-chest`, nodes, group);
    chestNode.position.set(0, 1.05, 0.23);
    const chest = addMesh(chestNode, new THREE.SphereGeometry(0.5, 32, 24), whiteMat, meshes, `${p}-chest`);
    chest.scale.set(0.38, 0.72, 0.17);
  }

  const explodeChildren = group.children
    .filter((c) => c !== headPivot && c !== tailPivot)
    .map((c) => ({ node: c, base: c.position.clone() }));

  return {
    torso: torsoNode, headPivot, tailPivot,
    earL: earNodes[0], earR: earNodes[1], lidL: lids[0], lidR: lids[1],
    baseEarLz: earBaseZ[0], baseEarRz: earBaseZ[1],
    baseLidLx: lidBaseX[0], baseLidRx: lidBaseX[1],
    phase: cfg.phase,
    explodeChildren,
  };
}

// -------------------------------------------------------------------- root

export function createDosGatosEstilizadosModel(options: ProceduralModelOptions = {}): THREE.Group {
  const texSize = options.textureSize ?? 1024;
  const aniso = options.textureAnisotropy ?? 8;
  const nodes: Record<string, THREE.Object3D> = {};
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};

  const root = new THREE.Group();
  root.name = 'root';
  nodes.root = root;

  const handles = CATS.map((cfg) => buildCat(cfg, root, nodes, meshes, sockets, texSize, aniso));

  for (const id of Object.keys(nodes)) {
    colliders[id] = { type: 'capsule', node: id, isTrigger: false };
  }

  root.userData.sculptRuntime = {
    nodes, meshes, sockets, colliders,
    destructionGroups: {},
  } satisfies ProceduralModelRuntime;
  root.userData.note = 'Quadruped two-cat reconstruction; pivots: headPivot/tailPivot/ears/eyelids per cat.';

  root.userData.reconstructionEvidence = {
    sourceImage: 'gatos.png',
    route: 'procedural-stylized',
    inferredRegions: [
      'dorsal/back surfaces of both cats (stripe continuation inferred, confidence ~0.4)',
      'tabby tail: not visible in reference, mirrored seat-curl (confidence 0.35)',
      'hind paws folded under the bodies (confidence 0.55)',
    ],
  };

  // ------------------------------------------------------------- idle loop
  const breatheHz = 0.25;
  const tick = (t: number): void => {
    for (const h of handles) {
      const ph = h.phase;
      // breathing: gentle torso swell, slightly out of phase between cats
      const breath = Math.sin(2 * Math.PI * breatheHz * t + ph);
      h.torso.scale.set(1 + 0.006 * breath, 1 + 0.016 * breath, 1 + 0.010 * breath);
      h.headPivot.position.y = 1.52 + 0.006 * breath;
      h.headPivot.rotation.x = 0.022 * Math.sin(2 * Math.PI * 0.21 * t + ph + 1.0);
      h.headPivot.rotation.y = 0.018 * Math.sin(2 * Math.PI * 0.11 * t + ph);

      // blink: short envelope every ~4.6 s (staggered per cat)
      const period = 4.6 + ph * 0.9;
      const x = ((t + ph * 1.3) % period) / period;
      const blink = x < 0.055 ? Math.sin((x / 0.055) * Math.PI) : 0;
      const lidTarget = -2.05 + 1.72 * blink;
      h.lidL.rotation.x = lidTarget;
      h.lidR.rotation.x = lidTarget;

      // tail sway around the rump pivot
      h.tailPivot.rotation.y = 0.10 * Math.sin(2 * Math.PI * 0.15 * t + ph);
      h.tailPivot.rotation.x = 0.04 * Math.sin(2 * Math.PI * 0.09 * t + ph + 2.0);

      // ear twitch: rare, one ear at a time
      const ep = 7.3 + ph;
      const ex = ((t + ph * 2.1) % ep) / ep;
      const pulse = ex < 0.045 ? Math.sin((ex / 0.045) * Math.PI) : 0;
      const which = Math.floor((t + ph * 2.1) / ep) % 2 === 0;
      h.earL.rotation.z = h.baseEarLz + (which ? 0.13 * pulse : 0);
      h.earR.rotation.z = h.baseEarRz - (which ? 0 : 0.13 * pulse);
    }
  };
  root.userData.tick = tick;

  // ------------------------------------------------------ explode + picking
  const catGroups = handles.map((h, i) => ({
    group: nodes[CATS[i].name],
    base: nodes[CATS[i].name].position.clone(),
  }));
  root.userData.setExplode = (amount: number): void => {
    const a = THREE.MathUtils.clamp(amount, 0, 1);
    for (const cg of catGroups) {
      cg.group.position.copy(cg.base).multiplyScalar(1 + 0.55 * a);
    }
    for (const h of handles) {
      for (const { node, base } of h.explodeChildren) {
        node.position.copy(base).multiplyScalar(1 + 0.35 * a);
      }
      h.headPivot.position.set(0, 1.52 * (1 + 0.45 * a), 0.02);
      h.tailPivot.position.copy(new THREE.Vector3().fromArray(CATS[handles.indexOf(h)].tailSpine[0])).multiplyScalar(1 + 0.35 * a);
    }
  };
  root.userData.pick = (raycaster: THREE.Raycaster): string | null => {
    const hits = raycaster.intersectObjects(Object.values(meshes), false);
    if (hits.length === 0) return null;
    return (hits[0].object.userData.componentId as string) ?? null;
  };

  return root;
}
