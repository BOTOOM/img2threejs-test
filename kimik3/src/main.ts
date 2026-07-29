import * as THREE from 'three';
import { createDosGatosEstilizadosModel } from './createObjectModel';

// ---------------------------------------------------------------------------
// Review harness for the img2threejs staged pipeline.
// URL params (initial state): cam, t, explode, flat, stripped.
// Reconfiguration without navigation: window.__setView({cam,t,explode,flat,stripped})
// then window.__capture('name') -> POSTs the PNG to /save-shot.
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);

const WIDTH = 1402;
const HEIGHT = 1122;

type ViewOpts = {
  cam?: string;
  t?: number;
  explode?: number;
  flat?: boolean;
  stripped?: boolean;
};

const canvas = document.getElementById('app') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setSize(WIDTH, HEIGHT, false);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#cfc4b0');

const camera = new THREE.PerspectiveCamera(38, WIDTH / HEIGHT, 0.1, 100);
const CAMS: Record<string, { pos: [number, number, number]; look: [number, number, number] }> = {
  front: { pos: [0.10, 1.55, 5.00], look: [0, 1.20, 0] },
  tq: { pos: [3.30, 1.95, 3.20], look: [0, 1.25, 0] },
  side: { pos: [4.55, 1.60, 0.40], look: [0, 1.25, 0] },
  back: { pos: [-2.30, 2.05, -3.55], look: [0, 1.25, 0] },
};

// ------------------------------------------------------------- lighting rig
const hemi = new THREE.HemisphereLight('#cfd8e6', '#6b5f4e', 0.55);
scene.add(hemi);
const key = new THREE.DirectionalLight('#ffd9a8', 2.6);
key.position.set(-3.5, 5.0, 3.0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -4; key.shadow.camera.right = 4;
key.shadow.camera.top = 5; key.shadow.camera.bottom = -2;
key.shadow.camera.far = 15;
key.shadow.bias = -0.0005;
key.shadow.radius = 6;
scene.add(key);
const fill = new THREE.DirectionalLight('#b8c8e0', 0.5);
fill.position.set(3.0, 2.0, 2.5);
scene.add(fill);
const rim = new THREE.DirectionalLight('#ffc98f', 1.4);
rim.position.set(2.5, 3.5, -3.5);
scene.add(rim);

// ------------------------------------------------------------------- ground
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(7, 64),
  // Unlit and exactly scene.background's color: uniform corners keep the Tier-1
  // foreground mask honest (lit ground broke the corner-background sampler).
  new THREE.MeshBasicMaterial({ color: '#cfc4b0' }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.002;
ground.receiveShadow = true;
scene.add(ground);
const shadowCatcher = new THREE.Mesh(
  new THREE.CircleGeometry(7, 64),
  new THREE.ShadowMaterial({ opacity: 0.35 }),
);
shadowCatcher.rotation.x = -Math.PI / 2;
shadowCatcher.receiveShadow = true;
scene.add(shadowCatcher);

// --------------------------------------------------------------------- model
const model = createDosGatosEstilizadosModel({ textureSize: 1024 });
const originalMaterials = new Map<THREE.Mesh, THREE.Material>();
model.traverse((obj) => {
  if (obj instanceof THREE.Mesh) {
    obj.castShadow = true;
    originalMaterials.set(obj, obj.material as THREE.Material);
  }
});
const clay = new THREE.MeshStandardMaterial({ color: '#9a9a9a', roughness: 0.85, metalness: 0 });
scene.add(model);

const tick = model.userData.tick as ((t: number) => void) | undefined;
const setExplode = model.userData.setExplode as ((amount: number) => void) | undefined;

function applyView(opts: ViewOpts): void {
  const camCfg = CAMS[opts.cam ?? 'front'] ?? CAMS.front;
  camera.position.set(...camCfg.pos);
  camera.lookAt(...camCfg.look);
  const flat = opts.flat ?? false;
  hemi.intensity = flat ? 1.4 : 0.55;
  key.visible = !flat; fill.visible = !flat; rim.visible = !flat;
  const strip = opts.stripped ?? false;
  model.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.material = strip ? clay : originalMaterials.get(obj)!;
  });
  if (tick) tick(opts.t ?? 0);
  if (setExplode) setExplode(opts.explode ?? 0);
  renderer.render(scene, camera);
}

applyView({
  cam: params.get('cam') ?? 'front',
  t: parseFloat(params.get('t') ?? '0'),
  explode: parseFloat(params.get('explode') ?? '0'),
  flat: params.get('flat') === '1',
  stripped: params.get('stripped') === '1',
});
(window as unknown as { __renderReady: boolean }).__renderReady = true;

const dbg = window as unknown as {
  __scene: THREE.Scene; __model: THREE.Group; __camera: THREE.PerspectiveCamera;
  __THREE: typeof THREE; __setView: (o: ViewOpts) => void;
  __capture: (name: string) => Promise<unknown>;
};
dbg.__scene = scene; dbg.__model = model; dbg.__camera = camera; dbg.__THREE = THREE;
dbg.__setView = applyView;
dbg.__capture = async (name: string) => {
  renderer.render(scene, camera);
  const res = await fetch(`/save-shot?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    body: canvas.toDataURL('image/png'),
  });
  return res.json();
};

renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
});
