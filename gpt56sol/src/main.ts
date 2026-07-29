import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createTwoCatsModel, type SculptPass } from './createTwoCatsModel';

declare global {
  interface Window {
    __ready: boolean;
    __interactive: boolean;
    __model: THREE.Group;
    __setView: (name: string) => void;
    __runtimeReport?: Record<string, unknown>;
  }
}

const sculptPasses: readonly SculptPass[] = [
  'blockout',
  'structural-pass',
  'form-refinement',
  'material-pass',
  'lighting-pass',
  'interaction-pass',
  'optimization-pass',
];

function isSculptPass(value: string | null): value is SculptPass {
  return value !== null && sculptPasses.some((pass) => pass === value);
}

const params = new URLSearchParams(location.search);
const requestedPass = params.get('pass');
const pass: SculptPass = isSculptPass(requestedPass) ? requestedPass : 'optimization-pass';
const view = params.get('view') ?? 'reference-match';
const animate = params.get('animate') === '1';
const app = document.querySelector<HTMLDivElement>('#app');
const label = document.querySelector<HTMLDivElement>('#label');
if (!app || !label) throw new Error('Viewer mount points are missing.');
label.textContent = `${pass} · ${view}`;
if (params.get('palette') === '1') {
  const palette = document.createElement('div');
  palette.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:90px;display:grid;grid-template-columns:repeat(5,1fr);z-index:3';
  for (const color of ['#1b1815', '#a06f43', '#dec9a9', '#c0c96a', '#c4785f']) {
    const swatch = document.createElement('div');
    swatch.style.background = color;
    palette.appendChild(swatch);
  }
  document.body.appendChild(palette);
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcfb9a7);
scene.fog = new THREE.Fog(0xcfb9a7, 10, 18);

const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.05, 50);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
window.__interactive = false;
controls.addEventListener('start', () => {
  window.__interactive = true;
});

const model = createTwoCatsModel({ pass, seed: 5602 });
scene.add(model);
window.__model = model;
if (params.get('runtime') === '1') {
  const runtime = model.userData.sculptRuntime as Record<string, any>;
  const requiredPivots = ['black-head', 'black-ear-l', 'black-ear-r', 'black-tail', 'tabby-head', 'tabby-ear-l', 'tabby-ear-r', 'tabby-tail'];
  const before = (runtime.pivots['black-head'] as THREE.Group).rotation.clone();
  model.userData.tick(1, 1 / 60);
  const once = (runtime.pivots['black-head'] as THREE.Group).rotation.clone();
  model.userData.tick(1, 1 / 60);
  const twice = (runtime.pivots['black-head'] as THREE.Group).rotation.clone();
  const firstMesh = Object.values(runtime.meshes)[0] as THREE.Mesh;
  const picked = runtime.pickPart(firstMesh) as THREE.Group | null;
  const firstPart = Object.values(runtime.parts)[1] as THREE.Group;
  const basePosition = firstPart.position.clone();
  runtime.setExplode(0.25);
  const explodedDistance = firstPart.position.distanceTo(basePosition);
  const report = {
    bodyPlan: runtime.bodyPlan,
    partCount: Object.keys(runtime.parts).length,
    meshCount: Object.keys(runtime.meshes).length,
    socketCount: Object.keys(runtime.sockets).length,
    colliderCount: Object.keys(runtime.colliders).length,
    requiredPivotsPresent: requiredPivots.every((id) => Boolean(runtime.pivots[id])),
    tickChangesPose: new THREE.Vector3(once.x, once.y, once.z).distanceTo(new THREE.Vector3(before.x, before.y, before.z)) > 0.0001,
    tickIsIdempotent: new THREE.Vector3(once.x, once.y, once.z).distanceTo(new THREE.Vector3(twice.x, twice.y, twice.z)) < 1e-9,
    explodeChangesLayout: explodedDistance > 0.0001,
    pickingSharesPartDefinition: picked?.userData.partId === firstMesh.userData.partId,
  };
  window.__runtimeReport = report;
  const output = document.createElement('pre');
  output.id = 'runtime-report';
  output.textContent = JSON.stringify(report);
  output.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:4;max-width:calc(100% - 28px);padding:10px;background:rgba(20,16,13,.82);color:#efffc8;font:12px/1.4 monospace;white-space:pre-wrap';
  document.body.appendChild(output);
  runtime.setExplode(0);
  model.userData.tick(0, 0);
}

const seat = new THREE.Mesh(
  new RoundedBoxGeometry(3.75, 0.18, 1.8, 8, 0.18),
  new THREE.MeshPhysicalMaterial({ color: 0xbda38e, roughness: 0.93, metalness: 0 }),
);
seat.name = 'review-seat';
seat.position.set(0, -0.08, 0.02);
seat.receiveShadow = true;
scene.add(seat);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0x9f896f, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.18;
ground.receiveShadow = true;
scene.add(ground);

scene.add(new THREE.HemisphereLight(0xffead6, 0x665746, 1.75));
const key = new THREE.DirectionalLight(0xffd6aa, 2.3);
key.position.set(4.5, 7.2, 5.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -4;
key.shadow.camera.right = 4;
key.shadow.camera.top = 5;
key.shadow.camera.bottom = -1;
key.shadow.bias = -0.0004;
scene.add(key);
const fill = new THREE.DirectionalLight(0xc9dcff, 0.95);
fill.position.set(-4, 3, 4);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffc48e, 0.9);
rim.position.set(-3.5, 5, -4);
scene.add(rim);

const views: Record<string, { position: THREE.Vector3Tuple; target: THREE.Vector3Tuple }> = {
  'reference-match': { position: [0, 2.08, 9.3], target: [0, 1.88, 0.15] },
  front: { position: [0, 2.0, 8.5], target: [0, 1.85, 0.1] },
  'left-orbit': { position: [-5.8, 2.8, 6.5], target: [0, 1.75, 0] },
  'right-orbit': { position: [5.8, 2.8, 6.5], target: [0, 1.75, 0] },
  'eye-close-up': { position: [0.15, 2.8, 5.1], target: [0.05, 2.83, 0.55] },
};

window.__setView = (name: string) => {
  const selected = views[name] ?? views['reference-match'];
  camera.position.set(...selected.position);
  controls.target.set(...selected.target);
  camera.lookAt(...selected.target);
  camera.updateProjectionMatrix();
};
window.__setView(view);

const clock = new THREE.Clock();
function render(): void {
  requestAnimationFrame(render);
  const elapsed = clock.getElapsedTime();
  if (animate) model.userData.tick?.(elapsed, clock.getDelta());
  if (window.__interactive) controls.update();
  renderer.render(scene, camera);
  window.__ready = true;
}
window.__ready = false;
render();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
