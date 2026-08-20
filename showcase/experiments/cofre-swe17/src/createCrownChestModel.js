import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const _v1 = new THREE.Vector3();
const _c1 = new THREE.Color();

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Apply a world-space vertical gradient to a geometry's vertex colors.
 * Each vertex is colored by its world-space y coordinate, allowing the
 * body and lid to share a single continuous enamel gradient.
 */
function applyVerticalGradient(geometry, meshY, stops, yMin, yMax) {
  const position = geometry.attributes.position;
  const count = position.count;
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    _v1.fromBufferAttribute(position, i);
    const worldY = _v1.y + meshY;
    const t = Math.max(0, Math.min(1, (worldY - yMin) / (yMax - yMin)));

    let r = 0;
    let g = 0;
    let b = 0;

    for (let s = 0; s < stops.length - 1; s++) {
      const a = stops[s];
      const bStop = stops[s + 1];
      if (t >= a.t && t <= bStop.t) {
        const localT = (t - a.t) / (bStop.t - a.t);
        _c1.set(a.color);
        const cA = _c1;
        _c1.set(bStop.color);
        const cB = _c1;
        r = THREE.MathUtils.lerp(cA.r, cB.r, localT);
        g = THREE.MathUtils.lerp(cA.g, cB.g, localT);
        b = THREE.MathUtils.lerp(cA.b, cB.b, localT);
        break;
      }
    }

    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Build the base 2D crown shape.
 */
function createCrownShape(wScale = 1) {
  const w = 0.43 * wScale;
  const h = 0.15 * wScale;
  const peak = 0.32 * wScale;
  const sidePeak = 0.22 * wScale;
  const mid = 0.025 * wScale;

  const shape = new THREE.Shape();
  shape.moveTo(-w, -h);
  shape.lineTo(-w, mid);

  // Left side peak.
  shape.quadraticCurveTo(-w * 0.60, sidePeak, -w * 0.30, sidePeak);
  shape.quadraticCurveTo(-w * 0.18, mid + 0.03 * wScale, -w * 0.10, mid);

  // Central peak.
  shape.quadraticCurveTo(-w * 0.07, mid + 0.10 * wScale, 0, peak);
  shape.quadraticCurveTo(w * 0.07, mid + 0.10 * wScale, w * 0.10, mid);

  // Right side peak.
  shape.quadraticCurveTo(w * 0.18, mid + 0.03 * wScale, w * 0.30, sidePeak);
  shape.quadraticCurveTo(w * 0.60, sidePeak, w, mid);

  shape.lineTo(w, -h);
  shape.quadraticCurveTo(0, -h - 0.04 * wScale, -w, -h);

  return shape;
}

/**
 * Build the procedural Crown Chest model.
 *
 * Exposed runtime:
 *   - root.userData.sculptRuntime.nodes.bodyPivot
 *   - root.userData.sculptRuntime.nodes.lidPivot
 *   - root.userData.setLidOpen(angle)  // angle in radians, negative opens upward
 */
export function createCrownChestModel(options = {}) {
  const root = new THREE.Group();
  root.name = 'Crown Chest';

  const castShadow = options.castShadow ?? true;
  const receiveShadow = options.receiveShadow ?? true;

  // Enamel gradient shared by body and lid. Top is purple, lower body is teal.
  const gradientStops = [
    { t: 0.00, color: 0x001f2a }, // very dark teal at bottom
    { t: 0.25, color: 0x004f59 }, // deep teal
    { t: 0.55, color: 0x00838f }, // bright teal across the body
    { t: 0.68, color: 0x1a0640 }, // dark purple just below the seam
    { t: 0.85, color: 0x421282 }, // purple
    { t: 1.00, color: 0x6d28c8 }, // bright purple at top
  ];
  const worldYMin = -0.70;
  const worldYMax = 0.42;

  // Materials
  const enamelMaterial = new THREE.MeshPhysicalMaterial({
    name: 'enamel',
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.22,
    metalness: 0.10,
    clearcoat: 1.0,
    clearcoatRoughness: 0.10,
    envMapIntensity: 1.6,
  });

  const goldMaterial = new THREE.MeshPhysicalMaterial({
    name: 'gold',
    color: 0xffd54f,
    metalness: 1.0,
    roughness: 0.25,
    clearcoat: 0.5,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.6,
  });

  const rivetMaterial = new THREE.MeshPhysicalMaterial({
    name: 'rivet',
    color: 0x4a3b18,
    metalness: 0.8,
    roughness: 0.5,
    clearcoat: 0.2,
  });

  const crownFillMaterial = new THREE.MeshBasicMaterial({
    name: 'crownFill',
    color: 0xffea00,
  });

  const crownGoldMaterial = new THREE.MeshPhysicalMaterial({
    name: 'crownGold',
    color: 0xd4a428,
    metalness: 0.0,
    roughness: 0.35,
    clearcoat: 0.6,
    clearcoatRoughness: 0.12,
    envMapIntensity: 0.6,
  });

  // Runtime registry
  const nodes = {};
  const meshes = {};
  const sockets = {};
  const colliders = {};
  const destructionGroups = {};

  // Body pivot: the non-moving lower half and its attached hardware.
  const bodyPivot = new THREE.Group();
  bodyPivot.name = 'bodyPivot';
  root.add(bodyPivot);
  nodes.bodyPivot = bodyPivot;

  // Base (body) - rounded, chunky box.
  const baseWidth = 1.5;
  const baseHeight = 0.65;
  const baseDepth = 0.95;
  const baseRadius = 0.08;
  const baseGeo = new RoundedBoxGeometry(baseWidth, baseHeight, baseDepth, 4, baseRadius);
  applyVerticalGradient(baseGeo, -baseHeight / 2, gradientStops, worldYMin, worldYMax);

  const baseMesh = new THREE.Mesh(baseGeo, enamelMaterial);
  baseMesh.name = 'base';
  baseMesh.position.set(0, -baseHeight / 2, 0);
  baseMesh.castShadow = castShadow;
  baseMesh.receiveShadow = receiveShadow;
  bodyPivot.add(baseMesh);
  meshes.base = baseMesh;
  colliders.base = { type: 'box', offset: [0, -0.325, 0], scale: [baseWidth, baseHeight, baseDepth] };
  (destructionGroups.body ??= []).push(baseMesh);

  // Lid pivot: placed at the back top edge of the body, so rotation opens the chest.
  const lidPivot = new THREE.Group();
  lidPivot.name = 'lidPivot';
  lidPivot.position.set(0, 0, -baseDepth / 2);
  root.add(lidPivot);
  nodes.lidPivot = lidPivot;

  // Lid - sits flush on the base.
  const lidWidth = 1.50;
  const lidHeight = 0.40;
  const lidDepth = 0.95;
  const lidRadius = 0.10;
  const lidGeo = new RoundedBoxGeometry(lidWidth, lidHeight, lidDepth, 4, lidRadius);
  applyVerticalGradient(lidGeo, 0, gradientStops, worldYMin, worldYMax);

  const lidMesh = new THREE.Mesh(lidGeo, enamelMaterial);
  lidMesh.name = 'lid';
  // Offset so the lid's bottom-back corner sits on the pivot origin.
  lidMesh.position.set(0, lidHeight / 2, lidDepth / 2);
  lidMesh.castShadow = castShadow;
  lidMesh.receiveShadow = receiveShadow;
  lidPivot.add(lidMesh);
  meshes.lid = lidMesh;
  // Lid collider at its mesh position inside the pivot.
  colliders.lid = { type: 'box', offset: [0, lidHeight / 2, lidDepth / 2], scale: [lidWidth, lidHeight, lidDepth] };
  (destructionGroups.lid ??= []).push(lidMesh);

  // Helper: build a chunky, chamfered corner bracket with rivets on each face.
  function createCornerBracket(name) {
    const group = new THREE.Group();
    group.name = name;

    const size = 0.20;
    const height = 0.24;
    const radius = 0.02;
    const bracket = new THREE.Mesh(
      new RoundedBoxGeometry(size, height, size, 2, radius),
      goldMaterial,
    );
    bracket.name = `${name}_body`;
    bracket.castShadow = castShadow;
    bracket.receiveShadow = receiveShadow;
    group.add(bracket);

    const rivetGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.018, 12);

    const rivetFront = new THREE.Mesh(rivetGeo, rivetMaterial);
    rivetFront.name = `${name}_rivetFront`;
    rivetFront.rotation.x = Math.PI / 2;
    rivetFront.position.set(0, 0, size / 2 + 0.003);
    group.add(rivetFront);

    const rivetSide = new THREE.Mesh(rivetGeo, rivetMaterial);
    rivetSide.name = `${name}_rivetSide`;
    rivetSide.rotation.z = Math.PI / 2;
    rivetSide.position.set(size / 2 + 0.003, 0, 0);
    group.add(rivetSide);

    const rivetTop = new THREE.Mesh(rivetGeo, rivetMaterial);
    rivetTop.name = `${name}_rivetTop`;
    rivetTop.position.set(0, height / 2 + 0.003, 0);
    group.add(rivetTop);

    return group;
  }

  const baseBrackets = [
    { x: -0.74, y: -0.58, z: 0.49 },
    { x: 0.74, y: -0.58, z: 0.49 },
    { x: -0.74, y: -0.58, z: -0.49 },
    { x: 0.74, y: -0.58, z: -0.49 },
  ];
  const lidBrackets = [
    { x: -0.74, y: 0.42, z: 0.0 },
    { x: 0.74, y: 0.42, z: 0.0 },
    { x: -0.74, y: 0.42, z: 0.95 },
    { x: 0.74, y: 0.42, z: 0.95 },
  ];

  for (let i = 0; i < baseBrackets.length; i++) {
    const pos = baseBrackets[i];
    const bracket = createCornerBracket(`baseBracket${i}`);
    bracket.position.set(pos.x, pos.y, pos.z);
    bodyPivot.add(bracket);
    meshes[`baseBracket${i}`] = bracket;
    (destructionGroups.body ??= []).push(bracket);
  }

  for (let i = 0; i < lidBrackets.length; i++) {
    const pos = lidBrackets[i];
    const bracket = createCornerBracket(`lidBracket${i}`);
    bracket.position.set(pos.x, pos.y, pos.z);
    lidPivot.add(bracket);
    meshes[`lidBracket${i}`] = bracket;
    (destructionGroups.lid ??= []).push(bracket);
  }

  // Rear hinges: fixed to the body, decorative barrel around the lid pivot axis.
  const hingeGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.32, 16, 1, false, 0, Math.PI);
  const hingePositions = [-0.38, 0.38];
  for (let i = 0; i < hingePositions.length; i++) {
    const hinge = new THREE.Mesh(hingeGeo, goldMaterial);
    hinge.name = `hinge${i}`;
    hinge.position.set(hingePositions[i], 0.0, -0.52);
    hinge.rotation.set(0, 0, Math.PI / 2);
    hinge.castShadow = castShadow;
    hinge.receiveShadow = receiveShadow;
    bodyPivot.add(hinge);
    meshes[`hinge${i}`] = hinge;
    (destructionGroups.body ??= []).push(hinge);
  }

  // Front crown emblem - golden rim with bright fill.
  const crownShellShape = createCrownShape(1.0);
  const crownHoleShape = createCrownShape(0.65);
  crownShellShape.holes.push(crownHoleShape);

  const shellExtrudeOptions = {
    depth: 0.08,
    bevelEnabled: true,
    bevelThickness: 0.02,
    bevelSize: 0.02,
    bevelSegments: 4,
  };
  const fillExtrudeOptions = {
    depth: 0.085,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.012,
    bevelSegments: 3,
  };

  const crownShellGeo = new THREE.ExtrudeGeometry(crownShellShape, shellExtrudeOptions);
  crownShellGeo.center();

  const crownFillGeo = new THREE.ExtrudeGeometry(crownHoleShape, fillExtrudeOptions);
  crownFillGeo.center();

  const crownShell = new THREE.Mesh(crownShellGeo, crownGoldMaterial);
  crownShell.name = 'crownShell';
  crownShell.position.set(0, -0.24, baseDepth / 2 + 0.04);
  crownShell.scale.set(1.15, 1.15, 1.0);
  crownShell.castShadow = false;
  crownShell.receiveShadow = false;
  bodyPivot.add(crownShell);
  meshes.crownShell = crownShell;

  const crownFill = new THREE.Mesh(crownFillGeo, crownFillMaterial);
  crownFill.name = 'crownFill';
  crownFill.position.set(0, -0.24, baseDepth / 2 + 0.05);
  crownFill.scale.set(1.20, 1.24, 1.0);
  crownFill.castShadow = false;
  crownFill.receiveShadow = false;
  bodyPivot.add(crownFill);
  meshes.crownFill = crownFill;

  // Subtle point light in front of the crown to suggest an emissive glow on the body.
  const crownLight = new THREE.PointLight(0xfff0b0, 1.0, 1.2);
  crownLight.position.set(0, -0.24, baseDepth / 2 + 0.20);
  crownLight.name = 'crownLight';
  bodyPivot.add(crownLight);

  // Side handle on the left face (inferred from the reference; only visible from the left).
  const handleGroup = new THREE.Group();
  handleGroup.name = 'sideHandle';
  handleGroup.position.set(-baseWidth / 2 - 0.04, -0.08, 0.0);
  bodyPivot.add(handleGroup);
  nodes.sideHandle = handleGroup;

  // Build a smaller, more elegant rectangular handle.
  const handleBar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.22, 12), goldMaterial);
  handleBar.name = 'handleBar';
  handleBar.rotation.z = Math.PI / 2;
  handleBar.position.y = 0.12;
  handleBar.castShadow = castShadow;
  handleBar.receiveShadow = receiveShadow;
  handleGroup.add(handleBar);
  meshes.handleBar = handleBar;

  const handleArmGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.12, 12);
  for (const z of [-0.11, 0.11]) {
    const arm = new THREE.Mesh(handleArmGeo, goldMaterial);
    arm.name = 'handleArm';
    arm.position.set(0, 0.05, z);
    arm.castShadow = castShadow;
    arm.receiveShadow = receiveShadow;
    handleGroup.add(arm);
    (destructionGroups.body ??= []).push(arm);
  }

  const mountGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.05, 12);
  for (const z of [-0.11, 0.11]) {
    const mount = new THREE.Mesh(mountGeo, goldMaterial);
    mount.name = 'handleMount';
    mount.position.set(0, 0, z);
    mount.rotation.set(Math.PI / 2, 0, 0);
    mount.castShadow = castShadow;
    mount.receiveShadow = receiveShadow;
    handleGroup.add(mount);
    (destructionGroups.body ??= []).push(mount);
  }

  // Sockets for future attachments or animation rigging.
  const lidSocket = new THREE.Object3D();
  lidSocket.name = 'lidSocket';
  lidSocket.position.set(0, lidHeight / 2, 0);
  lidPivot.add(lidSocket);
  sockets['lid:lidSocket'] = lidSocket;

  const bodySocket = new THREE.Object3D();
  bodySocket.name = 'bodySocket';
  bodySocket.position.set(0, 0, -baseDepth / 2);
  bodyPivot.add(bodySocket);
  sockets['body:bodySocket'] = bodySocket;

  // Runtime data and helper for opening the lid.
  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups };
  root.userData.setLidOpen = (angle) => {
    lidPivot.rotation.x = -Math.max(0, Math.min(Math.PI / 2, angle));
  };
  root.userData.getLidOpen = () => -lidPivot.rotation.x;

  return root;
}
