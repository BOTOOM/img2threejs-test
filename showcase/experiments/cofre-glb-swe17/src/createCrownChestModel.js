import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const GOLD = 0xffb300;
const PURPLE = 0x5d18a0;
const TEAL = 0x0b3c5a;
const TEAL_LIGHT = 0x145673;
const DARK_GOLD = 0xc48f00;

function createVerticalGradientTexture(colorTop, colorBottom, width = 128, height = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, 0, height);
  grd.addColorStop(0, colorTop);
  grd.addColorStop(1, colorBottom);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, width, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export function createCrownChestModel() {
  const root = new THREE.Group();
  root.name = 'crownChestRoot';

  // Dimensions derived from GLB bounds
  const W = 1.0;
  const H_BODY = 0.55;
  const D = 0.75;
  const H_LID = 0.235;
  const SPLIT_Y = 0.548;
  const SHELL_W = 0.88;
  const SHELL_D = 0.68;
  const CORNER_SIZE = 0.10;
  const BAND_THICK = 0.016;
  const BAND_WIDTH = 0.035;
  const TRIM_OUT = 0.003;

  // Materials
  const bodyMap = createVerticalGradientTexture('#0a7a9e', '#052a40');
  const bodyMat = new THREE.MeshStandardMaterial({
    name: 'bodyMaterial',
    color: 0xffffff,
    map: bodyMap,
    roughness: 0.22,
    metalness: 0.08,
    side: THREE.FrontSide
  });

  const lidMap = createVerticalGradientTexture('#9a4de0', '#3d0f6e');
  const lidMat = new THREE.MeshStandardMaterial({
    name: 'lidMaterial',
    color: 0xffffff,
    map: lidMap,
    roughness: 0.25,
    metalness: 0.06,
    side: THREE.FrontSide
  });

  const goldMat = new THREE.MeshPhysicalMaterial({
    name: 'goldMaterial',
    color: GOLD,
    roughness: 0.18,
    metalness: 0.92,
    clearcoat: 0.45,
    clearcoatRoughness: 0.15,
    polygonOffset: true,
    polygonOffsetFactor: -0.5,
    polygonOffsetUnits: -0.5,
    side: THREE.FrontSide
  });

  const darkGoldMat = new THREE.MeshPhysicalMaterial({
    name: 'darkGoldMaterial',
    color: DARK_GOLD,
    roughness: 0.18,
    metalness: 0.95,
    clearcoat: 0.5,
    clearcoatRoughness: 0.15,
    side: THREE.FrontSide
  });

  const emblemMat = new THREE.MeshPhysicalMaterial({
    name: 'emblemMaterial',
    color: 0xffd700,
    roughness: 0.08,
    metalness: 1.0,
    emissive: 0xffcc00,
    emissiveIntensity: 0.8,
    clearcoat: 0.8,
    clearcoatRoughness: 0.08,
    side: THREE.FrontSide
  });

  // Body pivot
  const bodyPivot = new THREE.Group();
  bodyPivot.name = 'bodyPivot';
  root.add(bodyPivot);

  const body = new THREE.Mesh(
    new RoundedBoxGeometry(SHELL_W, H_BODY, SHELL_D, 4, 0.012),
    bodyMat
  );
  body.name = 'body';
  body.position.y = H_BODY / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  bodyPivot.add(body);

  // Lid pivot
  const lidPivot = new THREE.Group();
  lidPivot.name = 'lidPivot';
  lidPivot.position.set(0, SPLIT_Y, -SHELL_D / 2);
  root.add(lidPivot);

  const lidGroup = new THREE.Group();
  lidGroup.name = 'lidGroup';
  lidGroup.position.set(0, H_LID / 2, SHELL_D / 2);
  lidPivot.add(lidGroup);

  const lidBase = SHELL_W + 0.02;
  const lidTop = SHELL_W - 0.12;
  const lidDepthBase = SHELL_D + 0.02;
  const lidDepthTop = SHELL_D - 0.10;
  // Approximate truncated square pyramid with a 4-sided cylinder
  const lidRadiusBase = Math.max(lidBase, lidDepthBase) / Math.sqrt(2);
  const lidRadiusTop = Math.max(lidTop, lidDepthTop) / Math.sqrt(2);
  const lid = new THREE.Mesh(
    new THREE.CylinderGeometry(lidRadiusTop, lidRadiusBase, H_LID, 4, 1, false, Math.PI / 4),
    lidMat
  );
  lid.name = 'lid';
  lid.castShadow = true;
  lid.receiveShadow = true;
  lidGroup.add(lid);

  // Component pivots
  const reinforcementsPivot = new THREE.Group();
  reinforcementsPivot.name = 'reinforcementsPivot';
  root.add(reinforcementsPivot);

  const cornersPivot = new THREE.Group();
  cornersPivot.name = 'cornersPivot';
  root.add(cornersPivot);

  const hingesPivot = new THREE.Group();
  hingesPivot.name = 'hingesPivot';
  root.add(hingesPivot);

  const handlesPivot = new THREE.Group();
  handlesPivot.name = 'handlesPivot';
  root.add(handlesPivot);

  const emblemPivot = new THREE.Group();
  emblemPivot.name = 'emblemPivot';
  root.add(emblemPivot);

  function addBand(w, h, d, x, y, z, material = goldMat, parent = reinforcementsPivot) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    band.position.set(x, y, z);
    band.castShadow = true;
    band.receiveShadow = true;
    parent.add(band);
    return band;
  }

  // Outer trim dimensions
  const outerW = SHELL_W + (TRIM_OUT * 2);
  const outerD = SHELL_D + (TRIM_OUT * 2);
  const bandX = outerW / 2 + BAND_WIDTH / 2;
  const bandZ = outerD / 2 + BAND_WIDTH / 2;

  // Vertical corner posts
  const postH = H_BODY + H_LID;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addBand(BAND_WIDTH, postH, BAND_WIDTH, sx * bandX, postH / 2, sz * bandZ);
    }
  }

  // Horizontal perimeter bands (body bottom, body top, lid top)
  const trimW = outerW + BAND_WIDTH + TRIM_OUT * 2;
  const trimD = outerD + BAND_WIDTH + TRIM_OUT * 2;

  // body bottom
  addBand(trimW, BAND_THICK, trimD, 0, BAND_THICK / 2, 0);
  // body top seam
  addBand(trimW, BAND_THICK, trimD, 0, H_BODY - BAND_THICK / 2, 0);
  // lid top
  addBand(trimW, BAND_THICK, trimD, 0, SPLIT_Y + H_LID - BAND_THICK / 2, 0);

  // Front and back mid-body rails
  addBand(trimW, BAND_WIDTH, BAND_THICK, 0, H_BODY * 0.50, outerD / 2 + BAND_THICK / 2 + TRIM_OUT);
  addBand(trimW, BAND_WIDTH, BAND_THICK, 0, H_BODY * 0.50, -(outerD / 2 + BAND_THICK / 2 + TRIM_OUT));

  // Corner guards at 8 vertices
  function addCorner(x, y, z) {
    const size = CORNER_SIZE;
    const corner = new THREE.Mesh(
      new RoundedBoxGeometry(size, size, size, 4, size * 0.30),
      goldMat
    );
    corner.position.set(x, y, z);
    corner.castShadow = true;
    corner.receiveShadow = true;
    cornersPivot.add(corner);
  }

  const cx = bandX + BAND_WIDTH / 2;
  const cz = bandZ + BAND_WIDTH / 2;
  const cyBodyTop = H_BODY;
  const cyBodyBottom = 0;
  const cyLidTop = SPLIT_Y + H_LID;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      addCorner(sx * cx, cyBodyBottom + CORNER_SIZE / 2, sz * cz);
      addCorner(sx * cx, cyBodyTop - CORNER_SIZE / 2, sz * cz);
      addCorner(sx * cx, cyLidTop - CORNER_SIZE / 2, sz * cz);
    }
  }

  // Hinges on the rear seam
  const hingeCount = 2;
  const hingeRadius = 0.022;
  const hingeLength = 0.16;
  const hingeY = SPLIT_Y + 0.018;
  for (let i = 0; i < hingeCount; i++) {
    const t = (i + 0.5) / hingeCount;
    const x = (t - 0.5) * (SHELL_W * 0.50);
    const hinge = new THREE.Mesh(
      new THREE.CylinderGeometry(hingeRadius, hingeRadius, hingeLength, 16),
      darkGoldMat
    );
    hinge.rotation.z = Math.PI / 2;
    hinge.position.set(x, hingeY, -outerD / 2 - hingeRadius);
    hinge.castShadow = true;
    hingesPivot.add(hinge);
  }

  // Side handles
  function createHandle() {
    const handleGroup = new THREE.Group();
    const mountH = 0.10;
    const mountW = 0.08;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(mountW, mountH, 0.012), goldMat);
    handleGroup.add(plate);

    const archRadius = 0.05;
    const tubeRadius = 0.016;
    const torus = new THREE.Mesh(
      new THREE.TorusGeometry(archRadius, tubeRadius, 12, 28, Math.PI),
      goldMat
    );
    // Open U shape facing outward
    torus.position.set(0, -archRadius + 0.01, 0);
    torus.rotation.y = Math.PI / 2;
    handleGroup.add(torus);
    return handleGroup;
  }

  const leftHandle = createHandle();
  leftHandle.position.set(-outerW / 2 - 0.02, H_BODY * 0.52, 0);
  leftHandle.rotation.y = -Math.PI / 2;
  handlesPivot.add(leftHandle);

  const rightHandle = createHandle();
  rightHandle.position.set(outerW / 2 + 0.02, H_BODY * 0.52, 0);
  rightHandle.rotation.y = Math.PI / 2;
  handlesPivot.add(rightHandle);

  // Front crown emblem
  const crownShape = new THREE.Shape();
  const cw = 0.26;
  const ch = 0.15;
  const baseY = -ch * 0.45;
  const points = 5;
  const step = cw / (points - 1);
  crownShape.moveTo(-cw / 2, baseY);
  for (let i = 0; i < points; i++) {
    const x = -cw / 2 + i * step;
    const peakH = (i % 2 === 0) ? ch * 0.6 : ch * 0.25;
    crownShape.lineTo(x, baseY + peakH);
  }
  crownShape.lineTo(cw / 2, baseY);
  crownShape.lineTo(cw / 2, baseY - ch * 0.2);
  crownShape.lineTo(-cw / 2, baseY - ch * 0.2);
  crownShape.lineTo(-cw / 2, baseY);

  const emblemGeo = new THREE.ExtrudeGeometry(crownShape, {
    depth: 0.012,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 3
  });
  emblemGeo.center();
  const emblem = new THREE.Mesh(emblemGeo, emblemMat);
  emblem.name = 'crownEmblem';
  emblem.position.set(0, H_BODY * 0.50, outerD / 2 + 0.012);
  emblem.castShadow = true;
  emblemPivot.add(emblem);

  // Runtime data
  root.bodyPivot = bodyPivot;
  root.lidPivot = lidPivot;
  root.userData = {
    sculptRuntime: {
      bodyPivot,
      lidPivot,
      reinforcementsPivot,
      cornersPivot,
      hingesPivot,
      handlesPivot,
      emblemPivot
    },
    openLid: (angle) => {
      lidPivot.rotation.x = -angle;
    }
  };

  return root;
}
