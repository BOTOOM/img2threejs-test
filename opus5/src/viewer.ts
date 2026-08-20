import * as THREE from 'three';
import { applyMaterialRouting, installCatsRuntime, installPhotoLighting } from './catsRuntime.js';

/**
 * Review harness for the Stylized Cat Pair reconstruction.
 *
 * Two jobs, deliberately separated:
 *
 *  1. EVALUATION renders. A plain WebGLRenderer at exactly 925x810 with a
 *     transparent background, using the analytic reference camera. The world
 *     units were defined so that z = 0 maps linearly onto the traced matte
 *     crop, so this camera reproduces the reference pixel grid rather than
 *     guessing at it. No composer, no bloom, no DOF - those would corrupt the
 *     deterministic IoU / edge / blowout signals the gates read.
 *
 *  2. PRESENTATION renders. Same camera, full materials, scene lights, warm
 *     background - for the side-by-side sheet a human (or the agent's vision)
 *     actually judges.
 *
 * `clay` mode strips every material down to one mid-grey MeshStandardMaterial,
 * which is the map-stripped evidence the blockout gate requires: it proves the
 * silhouette comes from geometry and not from a texture.
 */

const REFERENCE = {
  width: 925,
  height: 810,
  fovDegrees: 21,
  distance: 2.1852,
} as const;

type RenderMode = 'clay' | 'beauty';

type CaptureRequest = {
  name: string;
  mode?: RenderMode;
  view?: string;
  hideWhiskers?: boolean;
  transparent?: boolean;
};

type FactoryModule = {
  createStylizedCatPairModel: (options?: Record<string, unknown>) => THREE.Group;
  createStylizedCatPairLookDevLights: (mode?: 'neutral' | 'grazing' | 'reference') => THREE.Group;
  createStylizedCatPairEnvironment: (renderer: THREE.WebGLRenderer) => THREE.Texture;
  configureStylizedCatPairRenderer: (renderer: THREE.WebGLRenderer) => void;
};

const clayMaterial = new THREE.MeshStandardMaterial({
  color: 0x9a9a9a,
  roughness: 0.85,
  metalness: 0.0,
});

const clayLightMaterial = new THREE.MeshStandardMaterial({
  color: 0xdcdcdc,
  roughness: 0.8,
  metalness: 0.0,
});

export class CatsHarness {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly model: THREE.Group;
  readonly lights: THREE.Group;

  private readonly originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private readonly pivotCenter = new THREE.Vector3();
  private readonly orbitRadius: number;
  private environment: THREE.Texture | null = null;
  materialRoutingReport: Array<Record<string, unknown>> = [];
  lightingReport: Array<Record<string, unknown>> = [];
  private lightingInstalled = false;

  constructor(
    canvas: HTMLCanvasElement,
    factory: FactoryModule,
    passId: string,
    qualityPriority: 'reference-fidelity' | 'balanced' = 'reference-fidelity',
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(REFERENCE.width, REFERENCE.height, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    factory.configureStylizedCatPairRenderer(this.renderer);
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      REFERENCE.fovDegrees,
      REFERENCE.width / REFERENCE.height,
      0.05,
      40,
    );

    this.model = factory.createStylizedCatPairModel({
      castShadow: true,
      receiveShadow: true,
      qualityPriority,
      textureSize: qualityPriority === 'balanced' ? 512 : undefined,
      textureAnisotropy: qualityPriority === 'balanced' ? 2 : undefined,
    });
    this.scene.add(this.model);

    this.lights = factory.createStylizedCatPairLookDevLights('reference');
    this.scene.add(this.lights);

    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) this.originalMaterials.set(mesh, mesh.material);
    });

    const box = new THREE.Box3().setFromObject(this.model);
    box.getCenter(this.pivotCenter);
    this.orbitRadius = new THREE.Vector3(0, 0, REFERENCE.distance).distanceTo(this.pivotCenter);

    (window as unknown as Record<string, unknown>).harnessPass = passId;
  }

  /** The analytic reference camera: this is the framing the gates compare against. */
  useReferenceCamera(): void {
    this.camera.fov = REFERENCE.fovDegrees;
    this.camera.aspect = REFERENCE.width / REFERENCE.height;
    this.camera.position.set(0, 0, REFERENCE.distance);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Orbit views keep the same pivot and the same radius as the reference camera,
   * so a silhouette-area comparison across angles is measuring the form and not
   * a change in framing. That is what makes `degenerate-view` meaningful: a flat
   * card faking a volume collapses in area when orbited, a real solid does not.
   */
  useOrbitCamera(azimuthDegrees: number, elevationDegrees = 0): void {
    const azimuth = (azimuthDegrees * Math.PI) / 180;
    const elevation = (elevationDegrees * Math.PI) / 180;
    const direction = new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    );
    this.camera.fov = REFERENCE.fovDegrees;
    this.camera.aspect = REFERENCE.width / REFERENCE.height;
    this.camera.position.copy(this.pivotCenter).addScaledVector(direction, this.orbitRadius);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.pivotCenter);
    this.camera.updateProjectionMatrix();
  }

  setView(view: string): void {
    switch (view) {
      case 'orbit-left-40':
        this.useOrbitCamera(-40);
        break;
      case 'orbit-right-40':
        this.useOrbitCamera(40);
        break;
      case 'thickness-axis':
        this.useOrbitCamera(90);
        break;
      case 'orbit-back':
        this.useOrbitCamera(180);
        break;
      case 'orbit-high':
        this.useOrbitCamera(-25, 30);
        break;
      case 'long-axis':
      case 'reference':
      default:
        this.useReferenceCamera();
        break;
    }
  }

  setMode(mode: RenderMode): void {
    if (mode === 'clay') {
      // Two clay tones only: the light one marks the parts the reference shows as
      // white fur, so the clay render still proves left/right identity without
      // smuggling any texture in.
      this.model.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        const isWhite = /Bib|Forepaw|Hind Foot|Whisker|Fringe/i.test(mesh.name)
          && /Tabby/i.test(mesh.name);
        mesh.material = isWhite ? clayLightMaterial : clayMaterial;
      });
      this.scene.environment = null;
      return;
    }
    for (const [mesh, material] of this.originalMaterials) mesh.material = material;
    this.materialRoutingReport = applyMaterialRouting(this.model);
    if (!this.lightingInstalled) {
      this.lightingReport = installPhotoLighting(this.scene, this.lights, this.renderer);
      this.lightingInstalled = true;
    }
    if (!this.environment) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const environmentScene = new THREE.Scene();
      // Warm low-sun surround derived from the reference background measurements:
      // wall rgb(196,173,153), grass rgb(76,83,10), cream seat rgb(186,148,118).
      const sky = new THREE.Mesh(
        new THREE.SphereGeometry(6, 32, 16),
        new THREE.MeshBasicMaterial({ color: 0xc4ad99, side: THREE.BackSide }),
      );
      const ground = new THREE.Mesh(
        new THREE.CircleGeometry(6, 32),
        new THREE.MeshBasicMaterial({ color: 0x8c7a52 }),
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.5;
      const sun = new THREE.Mesh(
        new THREE.SphereGeometry(1.1, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xfff0d0 }),
      );
      sun.position.set(3.4, 3.0, 3.1);
      environmentScene.add(sky, ground, sun);
      this.environment = pmrem.fromScene(environmentScene, 0.04).texture;
      pmrem.dispose();
    }
    this.scene.environment = this.environment;
  }

  /**
   * Micro hair (whiskers, ear fringe) is hidden for silhouette work. A 1-2 px
   * strand carries no silhouette information but does move the bounding box,
   * which would corrupt the bbox-derived scale and aspect metrics. It is present
   * and scored on the material and lighting renders instead.
   */
  setWhiskersVisible(visible: boolean): void {
    this.model.traverse((object) => {
      if (/whisker|fringe/i.test(object.name)) object.visible = visible;
    });
  }

  setBackground(transparent: boolean): void {
    // The contact-shadow receiver is a ShadowMaterial plane. It is correct for a
    // beauty render - without a surface to fall on, the cats float - but it must be
    // hidden for the silhouette gates: its shadowed area joins the foreground mask
    // and inflates the bounding box. It cost 0.043 IoU and 0.024 scale delta before
    // being excluded.
    const receiver = this.lights.getObjectByName('contact-shadow-receiver');
    if (receiver) receiver.visible = !transparent;
    if (transparent) {
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
      return;
    }
    this.renderer.setClearColor(0xc4ad99, 1);
    this.scene.background = new THREE.Color(0xc4ad99);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Block until every reference-PBR map has actually decoded.
   *
   * THREE.TextureLoader().load() returns an empty texture immediately and fills
   * it in later. Capturing one frame right after boot therefore photographed
   * white 1x1 placeholder textures against material.color = #ffffff, which is
   * why the black cat rendered as light tan: the render was of the loader, not
   * of the material.
   */
  async waitForTextures(timeoutMs = 20000): Promise<{ total: number; loaded: number }> {
    const maps: THREE.Texture[] = [];
    const seen = new Set<string>();
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.MeshPhysicalMaterial | undefined;
      if (!material || Array.isArray(material) || seen.has(material.uuid)) return;
      seen.add(material.uuid);
      for (const key of ['map', 'roughnessMap', 'normalMap', 'aoMap'] as const) {
        const texture = material[key];
        if (texture) maps.push(texture);
      }
    });
    const deadline = Date.now() + timeoutMs;
    const decoded = (texture: THREE.Texture): boolean => {
      const image = texture.image as { width?: number } | null | undefined;
      return Boolean(image && typeof image.width === 'number' && image.width > 0);
    };
    const ready = () => maps.filter(decoded).length;
    while (ready() < maps.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const texture of maps) texture.needsUpdate = true;
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.Material | undefined;
      if (material && !Array.isArray(material)) material.needsUpdate = true;
    });
    return { total: maps.length, loaded: ready() };
  }

  /** Walk the built model and describe it the way check_part_coverage.py reads it. */
  partManifest(): Record<string, unknown> {
    const parts: Array<Record<string, unknown>> = [];
    let unnamedMeshes = 0;
    let integralMeshes = 0;
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry as THREE.BufferGeometry;
      const index = geometry.getIndex();
      const position = geometry.getAttribute('position');
      const triangles = index
        ? index.count / 3
        : position
          ? position.count / 3
          : 0;
      if (!mesh.name) {
        unnamedMeshes += 1;
        return;
      }
      const component = mesh.userData.sculptComponent as Record<string, unknown> | undefined;
      if (mesh.userData.explodeWithParent) integralMeshes += 1;
      parts.push({
        name: mesh.name,
        kind: 'part',
        module: (component?.id as string) ?? mesh.name,
        level: (component?.level as string) ?? 'unknown',
        triangles: Math.round(triangles),
      });
    });
    const instanced: Array<Record<string, unknown>> = [];
    this.model.traverse((object) => {
      const cluster = object as THREE.InstancedMesh;
      if (cluster.isInstancedMesh) {
        instanced.push({ name: cluster.name, count: cluster.count });
      }
    });
    return {
      model: this.model.name,
      pass: (window as unknown as Record<string, unknown>).harnessPass,
      parts,
      instancedClusters: instanced,
      unnamedMeshes,
      integralMeshes,
      runtime: {
        nodes: Object.keys(
          (this.model.userData.sculptRuntime as { nodes: Record<string, unknown> }).nodes,
        ).length,
        meshes: Object.keys(
          (this.model.userData.sculptRuntime as { meshes: Record<string, unknown> }).meshes,
        ).length,
        sockets: Object.keys(
          (this.model.userData.sculptRuntime as { sockets: Record<string, unknown> }).sockets,
        ).length,
        hasTick: typeof this.model.userData.tick === 'function',
      },
    };
  }
}

async function post(path: string, body: BlobPart, type: string): Promise<void> {
  await fetch(`/__save/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: new Blob([body], { type }),
  });
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

export async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const passId = params.get('pass') ?? 'blockout';
  const liveMode = params.get('live') === '1';
  const fastPass = ['blockout', 'structural', 'form-refinement'].includes(passId);
  const qualityPriority = liveMode && fastPass ? 'balanced' : 'reference-fidelity';
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const status = document.getElementById('status') as HTMLElement;

  const factoryPassId = {
    material: 'material-pass',
    surface: 'surface-pass',
    structural: 'structural-pass',
    lighting: 'lighting-pass',
  }[passId] ?? passId;
  const factory = (await import(`./generated/catsFactory.${factoryPassId}.js`)) as FactoryModule;
  const harness = new CatsHarness(canvas, factory, passId, qualityPriority);

  const runtime = installCatsRuntime(harness.model);

  const api = {
    harness,
    runtime,
    async capture(request: CaptureRequest): Promise<string> {
      harness.setMode(request.mode ?? 'clay');
      if ((request.mode ?? 'clay') === 'beauty') await harness.waitForTextures();
      harness.setWhiskersVisible(request.hideWhiskers === false);
      harness.setBackground(request.transparent !== false);
      harness.setView(request.view ?? 'reference');
      harness.render();
      const blob = await canvasToPng(canvas);
      await post(`renders/${request.name}.png`, blob, 'image/png');
      status.textContent = `captured ${request.name}`;
      return request.name;
    },
    async captureAll(requests: CaptureRequest[]): Promise<string[]> {
      const done: string[] = [];
      for (const request of requests) done.push(await api.capture(request));
      return done;
    },
    async saveManifest(name: string): Promise<void> {
      harness.setMode('beauty');
      await harness.waitForTextures();
      const manifest = JSON.stringify(
        {
          ...harness.partManifest(),
          materialRouting: harness.materialRoutingReport,
          lightingRig: harness.lightingReport,
        },
        null,
        2,
      );
      await post(`review/${name}.json`, manifest, 'application/json');
      status.textContent = `saved manifest ${name}`;
    },
    setIdleTime(time: number): void {
      const tick = harness.model.userData.tick as ((dt: number) => void) | undefined;
      if (typeof tick === 'function') {
        harness.model.userData.idleTime = 0;
        tick(time);
      }
    },
  };

  (window as unknown as Record<string, unknown>).catsHarness = api;
  harness.setMode('beauty');
  const textureState = await harness.waitForTextures();

  // ?live=1 turns the review harness into something a human can actually look at:
  // full materials, opaque background, orbit controls, and the idle loop running.
  // The default (no query param) stays a single deterministic frame, because that
  // is what the capture driver and the gates need.
  if (liveMode) {
    const { OrbitControls } = await import(
      'three/examples/jsm/controls/OrbitControls.js'
    ) as { OrbitControls: new (camera: THREE.Camera, dom: HTMLElement) => {
      target: THREE.Vector3; enableDamping: boolean; minDistance: number;
      maxDistance: number; update: () => void;
    } };
    harness.setBackground(false);
    harness.setWhiskersVisible(true);
    harness.useReferenceCamera();
    const controls = new OrbitControls(harness.camera, harness.renderer.domElement);
    controls.target.set(0.02, -0.03, 0);
    controls.enableDamping = true;
    controls.minDistance = 0.6;
    controls.maxDistance = 6.0;
    const clock = new THREE.Clock();
    const tick = harness.model.userData.tick as ((dt: number) => void) | undefined;
    const loop = (): void => {
      const delta = clock.getDelta();
      if (typeof tick === 'function') tick(delta);
      controls.update();
      harness.render();
      requestAnimationFrame(loop);
    };
    loop();
    status.textContent = `live pass=${passId} quality=${qualityPriority} — drag to orbit, scroll to zoom `
      + `(idle loop ${harness.model.userData.idleLoopSeconds}s, `
      + `${Object.keys(harness.model.userData.animationPivots ?? {}).length} pivots)`;
    (window as unknown as Record<string, unknown>).harnessReady = true;
    return;
  }

  harness.setMode('clay');
  harness.setBackground(true);
  harness.useReferenceCamera();
  harness.render();
  status.textContent = `ready pass=${passId} textures=${textureState.loaded}/${textureState.total}`;
  (window as unknown as Record<string, unknown>).harnessTextures = textureState;
  (window as unknown as Record<string, unknown>).harnessReady = true;
}

void boot();
