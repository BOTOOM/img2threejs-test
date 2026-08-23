import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const [red, green, blue] = hexToRgb(source);
  return new THREE.Color(red / 255, green / 255, blue / 255);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  const textures = makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Stylized Loot Chest
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createStylizedLootChestModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Stylized Loot Chest";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 26.0, "aspect": 1.0, "orientation": {"yaw": -26.0, "pitch": -11.0, "roll": 0.0}, "positionHint": [-2.02, 0.92, 4.14], "note": "Yaw solved from the grid measurement of the projected front face (11.6 cells) against the left face (3.3 cells) at depth/width 0.66, giving about 23 degrees; elevation estimated from the visible top face. Not solved with solve_camera_pose.py, so it is a review-camera hint rather than evidence."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["shell-lacquer"] = createSculptMaterial(
    "shell-lacquer",
    {"id": "shell-lacquer", "name": "Chest shell lacquer", "type": "physical", "shaderModel": "MeshPhysicalMaterial / PBR", "baseColor": "#025f74", "color": "#025f74", "albedo": {"dominant": "#025f74", "secondary": ["#03917d", "#062f66", "#4b2a7a"], "samplingNotes": "Colours sampled from the reference crops, not averaged over the whole image.", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/shell-lacquer/shell-lacquer_albedo.png", "url": "/pbr/shell-lacquer/shell-lacquer_albedo.png", "channel": "albedo", "source": "reference-sampled two-stop ramp (crop end medians)"}}, "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "colorVariation": {"palette": ["#025f74", "#03917d", "#062f66", "#4b2a7a"], "pattern": "gradient-plus-fine-breakup", "amplitude": 0.1, "heightCorrelation": 0.25}, "textureResolution": 2048, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "One gradient sweep per part; no tiling across a face."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.3, "role": "broad panel-scale height and colour breakup"}, {"id": "meso", "frequency": 11.0, "amplitude": 0.16, "role": "machining and casting grain visible at prop distance"}, {"id": "micro", "frequency": 46.0, "amplitude": 0.06, "role": "highlight breakup under grazing light"}], "roughness": {"base": 0.15, "variation": 0.1, "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/shell-lacquer/shell-lacquer_roughness.png", "url": "/pbr/shell-lacquer/shell-lacquer_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "rougher in grooves and seams, sharper on chamfers"}, "metalness": {"base": 0.25, "variation": 0.05}, "clearcoat": {"base": 0.88}, "clearcoatRoughness": {"base": 0.05}, "emissive": "#000000", "emissiveIntensity": {"base": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.22, "scale": 22.0, "space": "tangent", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/shell-lacquer/shell-lacquer_normal.png", "url": "/pbr/shell-lacquer/shell-lacquer_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.35, "contactShadowBias": 0.35, "notes": "Darken panel grooves, part seams and the underside of every cap.", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/shell-lacquer/shell-lacquer_ao.png", "url": "/pbr/shell-lacquer/shell-lacquer_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.2, "color": "#1a1730"}, "localOverrides": [{"id": "front-face-sheen", "target": "front wall and front-left chamfer", "roughness": 0.1, "clearcoat": 0.9, "description": "Broad soft highlight across the front wall plus a hard specular line down the front-left chamfer.", "evidenceRefs": ["front-face", "full-object"]}, {"id": "hue-zone-gradient", "target": "whole shell", "description": "Violet at the upper left, blue through the middle, teal toward the lower right; laterals fall into dark navy.", "evidenceRefs": ["full-object"]}, {"id": "base-contact-wear", "target": "plinth bottom edge", "roughness": 0.45, "description": "Bottom edge of the plinth reads slightly worn and darkened where it meets the ground.", "evidenceRefs": ["plinth-base"]}], "shaderNotes": ["Independent albedo/roughness/height/normal/AO fields; albedo is never reused as another channel."], "evidenceRefs": ["full-object", "front-face"], "referencePbr": {"version": "1.0", "sourceImage": "/home/ubuntu/repos/cofre3d/reconstruction/evidence/material_regions/shell-lacquer.png", "sourceRect": {"x0": 96, "y0": 128, "x1": 116, "y1": 226}, "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.791, "estimatedFidelity": 0.791, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/shell-lacquer/shell-lacquer_albedo.png", "url": "/pbr/shell-lacquer/shell-lacquer_albedo.png", "channel": "albedo", "source": "reference-sampled two-stop ramp (crop end medians)"}, "roughness": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/shell-lacquer/shell-lacquer_roughness.png", "url": "/pbr/shell-lacquer/shell-lacquer_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/shell-lacquer/shell-lacquer_height.png", "url": "/pbr/shell-lacquer/shell-lacquer_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/shell-lacquer/shell-lacquer_normal.png", "url": "/pbr/shell-lacquer/shell-lacquer_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/shell-lacquer/shell-lacquer_ao.png", "url": "/pbr/shell-lacquer/shell-lacquer_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "albedoRampStops": ["#012D50", "#02776A"], "palette": ["#09726A", "#052E50", "#0B555A", "#C4A21D", "#614F18"]}, "heightMap": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/shell-lacquer/shell-lacquer_height.png", "url": "/pbr/shell-lacquer/shell-lacquer_height.png", "channel": "height", "source": "reference-pixel-extraction"}},
    options
  );
  materialMap["lid-lacquer"] = createSculptMaterial(
    "lid-lacquer",
    {"id": "lid-lacquer", "name": "Lid lacquer", "type": "physical", "shaderModel": "MeshPhysicalMaterial / PBR", "baseColor": "#6c2fa4", "color": "#6c2fa4", "albedo": {"dominant": "#6c2fa4", "secondary": ["#8c4bc4", "#4a1f80", "#1d0760"], "samplingNotes": "Colours sampled from the reference crops, not averaged over the whole image.", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/lid-lacquer/lid-lacquer_albedo.png", "url": "/pbr/lid-lacquer/lid-lacquer_albedo.png", "channel": "albedo", "source": "reference-sampled two-stop ramp (crop end medians)"}}, "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "colorVariation": {"palette": ["#6c2fa4", "#8c4bc4", "#4a1f80", "#1d0760"], "pattern": "gradient-plus-fine-breakup", "amplitude": 0.1, "heightCorrelation": 0.25}, "textureResolution": 2048, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "One gradient sweep per part; no tiling across a face."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.3, "role": "broad panel-scale height and colour breakup"}, {"id": "meso", "frequency": 11.0, "amplitude": 0.16, "role": "machining and casting grain visible at prop distance"}, {"id": "micro", "frequency": 46.0, "amplitude": 0.06, "role": "highlight breakup under grazing light"}], "roughness": {"base": 0.16, "variation": 0.09, "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/lid-lacquer/lid-lacquer_roughness.png", "url": "/pbr/lid-lacquer/lid-lacquer_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "rougher in grooves and seams, sharper on chamfers"}, "metalness": {"base": 0.28, "variation": 0.05}, "clearcoat": {"base": 0.8}, "clearcoatRoughness": {"base": 0.05}, "emissive": "#000000", "emissiveIntensity": {"base": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.2, "scale": 22.0, "space": "tangent", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/lid-lacquer/lid-lacquer_normal.png", "url": "/pbr/lid-lacquer/lid-lacquer_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.32, "contactShadowBias": 0.35, "notes": "Darken panel grooves, part seams and the underside of every cap.", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/lid-lacquer/lid-lacquer_ao.png", "url": "/pbr/lid-lacquer/lid-lacquer_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.2, "color": "#1a1730"}, "localOverrides": [{"id": "lid-top-sheen", "target": "lid top panel and front facet", "roughness": 0.08, "clearcoat": 0.92, "description": "The lid carries the brightest, softest highlight of the whole prop, with a cool blue bounce on the right facet.", "evidenceRefs": ["lid-taper"]}, {"id": "lid-facet-value-split", "target": "four sloped facets", "description": "Each facet holds a distinctly different value, which is what sells the frustum.", "evidenceRefs": ["lid-taper"]}], "shaderNotes": ["Independent albedo/roughness/height/normal/AO fields; albedo is never reused as another channel."], "evidenceRefs": ["lid-taper", "full-object"], "referencePbr": {"version": "1.0", "sourceImage": "/home/ubuntu/repos/cofre3d/reconstruction/evidence/material_regions/lid-lacquer.png", "sourceRect": {"x0": 66, "y0": 56, "x1": 200, "y1": 114}, "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/lid-lacquer/lid-lacquer_albedo.png", "url": "/pbr/lid-lacquer/lid-lacquer_albedo.png", "channel": "albedo", "source": "reference-sampled two-stop ramp (crop end medians)"}, "roughness": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/lid-lacquer/lid-lacquer_roughness.png", "url": "/pbr/lid-lacquer/lid-lacquer_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/lid-lacquer/lid-lacquer_height.png", "url": "/pbr/lid-lacquer/lid-lacquer_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/lid-lacquer/lid-lacquer_normal.png", "url": "/pbr/lid-lacquer/lid-lacquer_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/lid-lacquer/lid-lacquer_ao.png", "url": "/pbr/lid-lacquer/lid-lacquer_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "albedoRampStops": ["#CB88F1", "#451468"], "palette": ["#CD8EE2", "#170653", "#8A66A6", "#AB7213", "#562382"]}, "heightMap": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/lid-lacquer/lid-lacquer_height.png", "url": "/pbr/lid-lacquer/lid-lacquer_height.png", "channel": "height", "source": "reference-pixel-extraction"}},
    options
  );
  materialMap["gold-trim"] = createSculptMaterial(
    "gold-trim",
    {"id": "gold-trim", "name": "Cast gold trim", "type": "physical", "shaderModel": "MeshPhysicalMaterial / PBR", "baseColor": "#c7a426", "color": "#c7a426", "albedo": {"dominant": "#c7a426", "secondary": ["#dbbd41", "#b38c0b", "#83662c"], "samplingNotes": "Colours sampled from the reference crops, not averaged over the whole image.", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/gold-trim/gold-trim_albedo.png", "url": "/pbr/gold-trim/gold-trim_albedo.png", "channel": "albedo", "source": "reference-sampled two-stop ramp (crop end medians)"}}, "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "colorVariation": {"palette": ["#c7a426", "#dbbd41", "#b38c0b", "#83662c"], "pattern": "gradient-plus-fine-breakup", "amplitude": 0.1, "heightCorrelation": 0.25}, "textureResolution": 2048, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "One gradient sweep per part; no tiling across a face."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.3, "role": "broad panel-scale height and colour breakup"}, {"id": "meso", "frequency": 11.0, "amplitude": 0.16, "role": "machining and casting grain visible at prop distance"}, {"id": "micro", "frequency": 46.0, "amplitude": 0.06, "role": "highlight breakup under grazing light"}], "roughness": {"base": 0.18, "variation": 0.14, "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/gold-trim/gold-trim_roughness.png", "url": "/pbr/gold-trim/gold-trim_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "rougher in grooves and seams, sharper on chamfers"}, "metalness": {"base": 1.0, "variation": 0.05}, "clearcoat": {"base": 0.1}, "clearcoatRoughness": {"base": 0.2}, "emissive": "#000000", "emissiveIntensity": {"base": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.35, "scale": 22.0, "space": "tangent", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/gold-trim/gold-trim_normal.png", "url": "/pbr/gold-trim/gold-trim_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.4, "contactShadowBias": 0.35, "notes": "Darken panel grooves, part seams and the underside of every cap.", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/gold-trim/gold-trim_ao.png", "url": "/pbr/gold-trim/gold-trim_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.2, "color": "#1a1730"}, "localOverrides": [{"id": "crown-frame-highlight", "target": "crown ring upper bevel", "roughness": 0.08, "description": "Hard near-white specular along the upper bevel of the crown ring.", "evidenceRefs": ["crown-emblem"]}, {"id": "cap-facet-shadow", "target": "cap diagonal facets", "roughness": 0.26, "description": "Orange-brown shadow side on every cap facet away from the key light.", "evidenceRefs": ["corner-hardware"]}], "shaderNotes": ["Independent albedo/roughness/height/normal/AO fields; albedo is never reused as another channel."], "evidenceRefs": ["corner-hardware", "side-handle"], "referencePbr": {"version": "1.0", "sourceImage": "/home/ubuntu/repos/cofre3d/reconstruction/evidence/material_regions/gold-trim.png", "sourceRect": {"x0": 46, "y0": 212, "x1": 80, "y1": 231}, "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.736, "estimatedFidelity": 0.736, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/gold-trim/gold-trim_albedo.png", "url": "/pbr/gold-trim/gold-trim_albedo.png", "channel": "albedo", "source": "reference-sampled two-stop ramp (crop end medians)"}, "roughness": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/gold-trim/gold-trim_roughness.png", "url": "/pbr/gold-trim/gold-trim_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/gold-trim/gold-trim_height.png", "url": "/pbr/gold-trim/gold-trim_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/gold-trim/gold-trim_normal.png", "url": "/pbr/gold-trim/gold-trim_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/gold-trim/gold-trim_ao.png", "url": "/pbr/gold-trim/gold-trim_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "albedoRampStops": ["#B38C0B", "#DBBD41"], "palette": ["#B8900A", "#DDC151", "#432D42", "#6C5019", "#9D876C"]}, "heightMap": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/gold-trim/gold-trim_height.png", "url": "/pbr/gold-trim/gold-trim_height.png", "channel": "height", "source": "reference-pixel-extraction"}},
    options
  );
  materialMap["rivet-iron"] = createSculptMaterial(
    "rivet-iron",
    {"id": "rivet-iron", "name": "Oxidised iron rivet", "type": "physical", "shaderModel": "MeshPhysicalMaterial / PBR", "baseColor": "#26201e", "color": "#26201e", "albedo": {"dominant": "#26201e", "secondary": ["#4a423c", "#141110"], "samplingNotes": "Colours sampled from the reference crops, not averaged over the whole image.", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/rivet-iron/rivet-iron_albedo.png", "url": "/pbr/rivet-iron/rivet-iron_albedo.png", "channel": "albedo", "source": "reference-sampled two-stop ramp (crop end medians)"}}, "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "colorVariation": {"palette": ["#26201e", "#4a423c", "#141110"], "pattern": "gradient-plus-fine-breakup", "amplitude": 0.1, "heightCorrelation": 0.25}, "textureResolution": 2048, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "One gradient sweep per part; no tiling across a face."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.3, "role": "broad panel-scale height and colour breakup"}, {"id": "meso", "frequency": 11.0, "amplitude": 0.16, "role": "machining and casting grain visible at prop distance"}, {"id": "micro", "frequency": 46.0, "amplitude": 0.06, "role": "highlight breakup under grazing light"}], "roughness": {"base": 0.55, "variation": 0.18, "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/rivet-iron/rivet-iron_roughness.png", "url": "/pbr/rivet-iron/rivet-iron_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "rougher in grooves and seams, sharper on chamfers"}, "metalness": {"base": 0.85, "variation": 0.05}, "clearcoat": {"base": 0.0}, "clearcoatRoughness": {"base": 0.1}, "emissive": "#000000", "emissiveIntensity": {"base": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.4, "scale": 22.0, "space": "tangent", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/rivet-iron/rivet-iron_normal.png", "url": "/pbr/rivet-iron/rivet-iron_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.5, "contactShadowBias": 0.35, "notes": "Darken panel grooves, part seams and the underside of every cap.", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/rivet-iron/rivet-iron_ao.png", "url": "/pbr/rivet-iron/rivet-iron_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.2, "color": "#1a1730"}, "localOverrides": [{"id": "rivet-cavity-ao", "target": "rivet seating ring", "description": "Dark contact ring where each rivet sinks into the gold.", "evidenceRefs": ["corner-hardware"]}], "shaderNotes": ["Independent albedo/roughness/height/normal/AO fields; albedo is never reused as another channel."], "evidenceRefs": ["corner-hardware"], "referencePbr": {"version": "1.0", "sourceImage": "/home/ubuntu/repos/cofre3d/reconstruction/evidence/material_regions/rivet-iron.png", "sourceRect": {"x0": 26, "y0": 162, "x1": 34, "y1": 170}, "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.749, "estimatedFidelity": 0.749, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/rivet-iron/rivet-iron_albedo.png", "url": "/pbr/rivet-iron/rivet-iron_albedo.png", "channel": "albedo", "source": "reference-sampled two-stop ramp (crop end medians)"}, "roughness": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/rivet-iron/rivet-iron_roughness.png", "url": "/pbr/rivet-iron/rivet-iron_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/rivet-iron/rivet-iron_height.png", "url": "/pbr/rivet-iron/rivet-iron_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/rivet-iron/rivet-iron_normal.png", "url": "/pbr/rivet-iron/rivet-iron_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/rivet-iron/rivet-iron_ao.png", "url": "/pbr/rivet-iron/rivet-iron_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "albedoRampStops": ["#1E052E", "#3F2326"], "palette": ["#1D0833", "#2A0A1D", "#986E25", "#B18B3B", "#563423"]}, "heightMap": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/rivet-iron/rivet-iron_height.png", "url": "/pbr/rivet-iron/rivet-iron_height.png", "channel": "height", "source": "reference-pixel-extraction"}},
    options
  );
  materialMap["emblem-glow"] = createSculptMaterial(
    "emblem-glow",
    {"id": "emblem-glow", "name": "Crown emblem emission", "type": "physical", "shaderModel": "MeshPhysicalMaterial / PBR", "baseColor": "#fffadc", "color": "#fffadc", "albedo": {"dominant": "#fffadc", "secondary": ["#ffd660", "#ffb02e"], "samplingNotes": "Colours sampled from the reference crops, not averaged over the whole image.", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/emblem-glow/emblem-glow_albedo.png", "url": "/pbr/emblem-glow/emblem-glow_albedo.png", "channel": "albedo", "source": "reference-sampled two-stop ramp (crop end medians)"}}, "colorGradient": {"type": "radial", "axis": [0.5, 0.55], "stops": [{"offset": 0.0, "color": "rgba(255, 250, 220, 1.0)"}, {"offset": 1.0, "color": "rgba(255, 214, 96, 1.0)"}]}, "colorVariation": {"palette": ["#fffadc", "#ffd660", "#ffb02e"], "pattern": "gradient-plus-fine-breakup", "amplitude": 0.1, "heightCorrelation": 0.25}, "textureResolution": 2048, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "One gradient sweep per part; no tiling across a face."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.5, "amplitude": 0.1, "role": "broad panel-scale height and colour breakup"}, {"id": "meso", "frequency": 8.0, "amplitude": 0.05, "role": "machining and casting grain visible at prop distance"}, {"id": "micro", "frequency": 30.0, "amplitude": 0.02, "role": "highlight breakup under grazing light"}], "roughness": {"base": 0.35, "variation": 0.06, "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/emblem-glow/emblem-glow_roughness.png", "url": "/pbr/emblem-glow/emblem-glow_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "rougher in grooves and seams, sharper on chamfers"}, "metalness": {"base": 0.0, "variation": 0.05}, "clearcoat": {"base": 0.0}, "clearcoatRoughness": {"base": 0.1}, "emissive": "#ffe9a8", "emissiveIntensity": {"base": 0.34}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.1, "scale": 22.0, "space": "tangent", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/emblem-glow/emblem-glow_normal.png", "url": "/pbr/emblem-glow/emblem-glow_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.1, "contactShadowBias": 0.35, "notes": "Darken panel grooves, part seams and the underside of every cap.", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/emblem-glow/emblem-glow_ao.png", "url": "/pbr/emblem-glow/emblem-glow_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.2, "color": "#1a1730"}, "localOverrides": [{"id": "emblem-core-falloff", "target": "crown core face", "description": "Near-white centre falling off to saturated yellow at the rim, spilling light onto the gold ring.", "evidenceRefs": ["crown-emblem"]}], "shaderNotes": ["Independent albedo/roughness/height/normal/AO fields; albedo is never reused as another channel."], "evidenceRefs": ["crown-emblem"], "referencePbr": {"version": "1.0", "sourceImage": "/home/ubuntu/repos/cofre3d/reconstruction/evidence/material_regions/emblem-glow.png", "sourceRect": {"x0": 136, "y0": 150, "x1": 198, "y1": 192}, "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.86, "estimatedFidelity": 0.86, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/emblem-glow/emblem-glow_albedo.png", "url": "/pbr/emblem-glow/emblem-glow_albedo.png", "channel": "albedo", "source": "reference-sampled two-stop ramp (crop end medians)"}, "roughness": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/emblem-glow/emblem-glow_roughness.png", "url": "/pbr/emblem-glow/emblem-glow_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/emblem-glow/emblem-glow_height.png", "url": "/pbr/emblem-glow/emblem-glow_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/emblem-glow/emblem-glow_normal.png", "url": "/pbr/emblem-glow/emblem-glow_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/emblem-glow/emblem-glow_ao.png", "url": "/pbr/emblem-glow/emblem-glow_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "albedoRampStops": ["#FEFFF3", "#FFF9AE"], "palette": ["#EAC53B", "#27404E", "#D3A522", "#FAEB7C", "#906B16"]}, "heightMap": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/emblem-glow/emblem-glow_height.png", "url": "/pbr/emblem-glow/emblem-glow_height.png", "channel": "height", "source": "reference-pixel-extraction"}},
    options
  );
  materialMap["seam-shadow"] = createSculptMaterial(
    "seam-shadow",
    {"id": "seam-shadow", "name": "Lid seam shadow", "type": "physical", "shaderModel": "MeshPhysicalMaterial / PBR", "baseColor": "#161428", "color": "#161428", "albedo": {"dominant": "#161428", "secondary": ["#2e2a4a", "#0d0c18"], "samplingNotes": "Colours sampled from the reference crops, not averaged over the whole image.", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/seam-shadow/seam-shadow_albedo.png", "url": "/pbr/seam-shadow/seam-shadow_albedo.png", "channel": "albedo", "source": "reference-sampled two-stop ramp (crop end medians)"}}, "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "colorVariation": {"palette": ["#161428", "#2e2a4a", "#0d0c18"], "pattern": "gradient-plus-fine-breakup", "amplitude": 0.1, "heightCorrelation": 0.25}, "textureResolution": 2048, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "One gradient sweep per part; no tiling across a face."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.3, "role": "broad panel-scale height and colour breakup"}, {"id": "meso", "frequency": 11.0, "amplitude": 0.16, "role": "machining and casting grain visible at prop distance"}, {"id": "micro", "frequency": 46.0, "amplitude": 0.06, "role": "highlight breakup under grazing light"}], "roughness": {"base": 0.85, "variation": 0.1, "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/seam-shadow/seam-shadow_roughness.png", "url": "/pbr/seam-shadow/seam-shadow_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "rougher in grooves and seams, sharper on chamfers"}, "metalness": {"base": 0.2, "variation": 0.05}, "clearcoat": {"base": 0.0}, "clearcoatRoughness": {"base": 0.1}, "emissive": "#000000", "emissiveIntensity": {"base": 0.0}, "normal": {"pattern": "derived-from-independent-height-field", "strength": 0.15, "scale": 22.0, "space": "tangent", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/seam-shadow/seam-shadow_normal.png", "url": "/pbr/seam-shadow/seam-shadow_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}}, "bump": {"pattern": "none", "amplitude": 0.0, "scale": 1.0}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.6, "contactShadowBias": 0.35, "notes": "Darken panel grooves, part seams and the underside of every cap.", "map": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/seam-shadow/seam-shadow_ao.png", "url": "/pbr/seam-shadow/seam-shadow_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "wear": {"edgeWear": 0.05, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.2, "color": "#1a1730"}, "localOverrides": [{"id": "seam-shadow-gradient", "target": "seam band", "description": "Seam band is darkest at the front and lifts slightly where the lid overhang thins out.", "evidenceRefs": ["full-object"]}], "shaderNotes": ["Independent albedo/roughness/height/normal/AO fields; albedo is never reused as another channel."], "evidenceRefs": ["full-object"], "referencePbr": {"version": "1.0", "sourceImage": "/home/ubuntu/repos/cofre3d/reconstruction/evidence/material_regions/seam-shadow.png", "sourceRect": {"x0": 230, "y0": 110, "x1": 240, "y1": 120}, "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.775, "estimatedFidelity": 0.775, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/seam-shadow/seam-shadow_albedo.png", "url": "/pbr/seam-shadow/seam-shadow_albedo.png", "channel": "albedo", "source": "reference-sampled two-stop ramp (crop end medians)"}, "roughness": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/seam-shadow/seam-shadow_roughness.png", "url": "/pbr/seam-shadow/seam-shadow_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/seam-shadow/seam-shadow_height.png", "url": "/pbr/seam-shadow/seam-shadow_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/seam-shadow/seam-shadow_normal.png", "url": "/pbr/seam-shadow/seam-shadow_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/seam-shadow/seam-shadow_ao.png", "url": "/pbr/seam-shadow/seam-shadow_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "albedoRampStops": ["#15083D", "#020030"], "palette": ["#030330", "#0D0538", "#736199", "#3E2D64", "#06021F"]}, "heightMap": {"path": "/home/ubuntu/repos/cofre3d/reconstruction/pbr/seam-shadow/seam-shadow_height.png", "url": "/pbr/seam-shadow/seam-shadow_height.png", "channel": "height", "source": "reference-pixel-extraction"}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_body_shell_0 = null;
  const endpoint_body_shell_0 = makeAttachmentEndpoint(attachment_body_shell_0);
  const node_body_shell_0 = new THREE.Group();
  node_body_shell_0.name = "Chest body shell__pivot";
  node_body_shell_0.scale.set(1, 1, 1);
  if (endpoint_body_shell_0) {
    node_body_shell_0.position.copy(endpoint_body_shell_0.start);
    node_body_shell_0.rotation.set(-1.570796, 0.0, -0.0);
  } else {
    node_body_shell_0.position.set(0.0, 0.0, 0.0);
    node_body_shell_0.rotation.set(-1.570796, 0.0, -0.0);
  }
  node_body_shell_0.userData.sculptComponent = {"id": "body-shell", "name": "Chest body shell", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Four flat painted walls meeting at narrow bright chamfers; the reference shows a crisp vertical bevel strip on the front-left corner, not a smooth blend.", "geometryDescriptor": {"topologyIntent": "hard-surface chamfered box, flat faces with narrow bevels", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 1}, "profile2D": {"points": [[-0.4475, -0.3525], [0.4475, -0.3525], [0.4825, -0.3175], [0.4825, 0.3175], [0.4475, 0.3525], [-0.4475, 0.3525], [-0.4825, 0.3175], [-0.4825, -0.3175]], "depth": 0.522}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs, gradient mapped along the vertical axis", "normalStrategy": "flat faces with hard chamfer creases"}, "parent": null, "attachment": null, "dimensions": {"width": 0.965, "height": 0.522, "depth": 0.705, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [-1.570796, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-base", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "plinth-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "front-panel-mount", "localPosition": [0.0, -0.3525, 0.24], "localRotation": [0.0, 0.0, 0.0]}, {"id": "rear-panel-mount", "localPosition": [0.0, 0.3525, 0.24], "localRotation": [0.0, 0.0, 0.0]}, {"id": "left-panel-mount", "localPosition": [-0.4825, 0.0, 0.24], "localRotation": [0.0, 0.0, 0.0]}, {"id": "right-panel-mount", "localPosition": [0.4825, 0.0, 0.24], "localRotation": [0.0, 0.0, 0.0]}, {"id": "rail-mount", "localPosition": [0.0, 0.0, 0.531], "localRotation": [0.0, 0.0, 0.0]}, {"id": "handle-mount", "localPosition": [-0.4825, 0.0, 0.3], "localRotation": [0.0, 0.0, 0.0]}, {"id": "hinge-mount", "localPosition": [0.0, 0.37, 0.593], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0.23, 0], "scale": [1.0, 0.46, 0.66], "isTrigger": false, "notes": "Single box proxy for the whole chest body."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body-shell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "corner-chamfer-strip", "kind": "bevel", "description": "Narrow bright chamfer down each vertical corner of the body wall.", "evidenceRefs": ["full-object"]}, {"id": "wall-gloss-sweep", "kind": "gloss", "description": "Broad soft specular sweep across the front wall.", "evidenceRefs": ["front-face"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object", "front-face"], "details": [], "fidelityTier": "blockout"};
  node_body_shell_0.userData.actionProfile = {"animationRole": "static-base", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "plinth-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "front-panel-mount", "localPosition": [0.0, -0.3525, 0.24], "localRotation": [0.0, 0.0, 0.0]}, {"id": "rear-panel-mount", "localPosition": [0.0, 0.3525, 0.24], "localRotation": [0.0, 0.0, 0.0]}, {"id": "left-panel-mount", "localPosition": [-0.4825, 0.0, 0.24], "localRotation": [0.0, 0.0, 0.0]}, {"id": "right-panel-mount", "localPosition": [0.4825, 0.0, 0.24], "localRotation": [0.0, 0.0, 0.0]}, {"id": "rail-mount", "localPosition": [0.0, 0.0, 0.531], "localRotation": [0.0, 0.0, 0.0]}, {"id": "handle-mount", "localPosition": [-0.4825, 0.0, 0.3], "localRotation": [0.0, 0.0, 0.0]}, {"id": "hinge-mount", "localPosition": [0.0, 0.37, 0.593], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0.23, 0], "scale": [1.0, 0.46, 0.66], "isTrigger": false, "notes": "Single box proxy for the whole chest body."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body-shell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_body_shell_0);
  nodes["body-shell"] = node_body_shell_0;
  const mesh_body_shell_0Geometry = endpoint_body_shell_0
    ? new THREE.CylinderGeometry(endpoint_body_shell_0.endRadius, endpoint_body_shell_0.baseRadius, endpoint_body_shell_0.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.4475, -0.3525], [0.4475, -0.3525], [0.4825, -0.3175], [0.4825, 0.3175], [0.4475, 0.3525], [-0.4475, 0.3525], [-0.4825, 0.3175], [-0.4825, -0.3175]], "depth": 0.522});
  if (!endpoint_body_shell_0) {
    mesh_body_shell_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_body_shell_0 = new THREE.Mesh(
    mesh_body_shell_0Geometry,
    materialMap["shell-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_shell_0.name = "Chest body shell";
  if (endpoint_body_shell_0) {
    mesh_body_shell_0.position.copy(endpoint_body_shell_0.midpoint);
    mesh_body_shell_0.quaternion.copy(endpoint_body_shell_0.quaternion);
  }
  mesh_body_shell_0.castShadow = options.castShadow ?? true;
  mesh_body_shell_0.receiveShadow = options.receiveShadow ?? true;
  mesh_body_shell_0.userData.sculptComponent = {"id": "body-shell", "name": "Chest body shell", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Four flat painted walls meeting at narrow bright chamfers; the reference shows a crisp vertical bevel strip on the front-left corner, not a smooth blend.", "geometryDescriptor": {"topologyIntent": "hard-surface chamfered box, flat faces with narrow bevels", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 1}, "profile2D": {"points": [[-0.4475, -0.3525], [0.4475, -0.3525], [0.4825, -0.3175], [0.4825, 0.3175], [0.4475, 0.3525], [-0.4475, 0.3525], [-0.4825, 0.3175], [-0.4825, -0.3175]], "depth": 0.522}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs, gradient mapped along the vertical axis", "normalStrategy": "flat faces with hard chamfer creases"}, "parent": null, "attachment": null, "dimensions": {"width": 0.965, "height": 0.522, "depth": 0.705, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [-1.570796, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-base", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "plinth-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "front-panel-mount", "localPosition": [0.0, -0.3525, 0.24], "localRotation": [0.0, 0.0, 0.0]}, {"id": "rear-panel-mount", "localPosition": [0.0, 0.3525, 0.24], "localRotation": [0.0, 0.0, 0.0]}, {"id": "left-panel-mount", "localPosition": [-0.4825, 0.0, 0.24], "localRotation": [0.0, 0.0, 0.0]}, {"id": "right-panel-mount", "localPosition": [0.4825, 0.0, 0.24], "localRotation": [0.0, 0.0, 0.0]}, {"id": "rail-mount", "localPosition": [0.0, 0.0, 0.531], "localRotation": [0.0, 0.0, 0.0]}, {"id": "handle-mount", "localPosition": [-0.4825, 0.0, 0.3], "localRotation": [0.0, 0.0, 0.0]}, {"id": "hinge-mount", "localPosition": [0.0, 0.37, 0.593], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0.23, 0], "scale": [1.0, 0.46, 0.66], "isTrigger": false, "notes": "Single box proxy for the whole chest body."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body-shell", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "corner-chamfer-strip", "kind": "bevel", "description": "Narrow bright chamfer down each vertical corner of the body wall.", "evidenceRefs": ["full-object"]}, {"id": "wall-gloss-sweep", "kind": "gloss", "description": "Broad soft specular sweep across the front wall.", "evidenceRefs": ["front-face"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object", "front-face"], "details": [], "fidelityTier": "blockout"};
  node_body_shell_0.add(mesh_body_shell_0);
  meshes["body-shell"] = mesh_body_shell_0;
  colliders["body-shell"] = {"type": "box", "offset": [0, 0.23, 0], "scale": [1.0, 0.46, 0.66], "isTrigger": false, "notes": "Single box proxy for the whole chest body."};
  destructionGroups["body-shell"] ??= [];
  destructionGroups["body-shell"].push(node_body_shell_0);
  const socket_body_shell_plinth_mount_0 = new THREE.Object3D();
  socket_body_shell_plinth_mount_0.name = "plinth-mount";
  socket_body_shell_plinth_mount_0.position.set(0.0, 0.0, 0.0);
  socket_body_shell_plinth_mount_0.rotation.set(0.0, 0.0, 0.0);
  socket_body_shell_plinth_mount_0.userData.socket = {"id": "plinth-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_body_shell_0.add(socket_body_shell_plinth_mount_0);
  sockets["body-shell:plinth-mount"] = socket_body_shell_plinth_mount_0;
  const socket_body_shell_front_panel_mount_1 = new THREE.Object3D();
  socket_body_shell_front_panel_mount_1.name = "front-panel-mount";
  socket_body_shell_front_panel_mount_1.position.set(0.0, -0.3525, 0.24);
  socket_body_shell_front_panel_mount_1.rotation.set(0.0, 0.0, 0.0);
  socket_body_shell_front_panel_mount_1.userData.socket = {"id": "front-panel-mount", "localPosition": [0.0, -0.3525, 0.24], "localRotation": [0.0, 0.0, 0.0]};
  node_body_shell_0.add(socket_body_shell_front_panel_mount_1);
  sockets["body-shell:front-panel-mount"] = socket_body_shell_front_panel_mount_1;
  const socket_body_shell_rear_panel_mount_2 = new THREE.Object3D();
  socket_body_shell_rear_panel_mount_2.name = "rear-panel-mount";
  socket_body_shell_rear_panel_mount_2.position.set(0.0, 0.3525, 0.24);
  socket_body_shell_rear_panel_mount_2.rotation.set(0.0, 0.0, 0.0);
  socket_body_shell_rear_panel_mount_2.userData.socket = {"id": "rear-panel-mount", "localPosition": [0.0, 0.3525, 0.24], "localRotation": [0.0, 0.0, 0.0]};
  node_body_shell_0.add(socket_body_shell_rear_panel_mount_2);
  sockets["body-shell:rear-panel-mount"] = socket_body_shell_rear_panel_mount_2;
  const socket_body_shell_left_panel_mount_3 = new THREE.Object3D();
  socket_body_shell_left_panel_mount_3.name = "left-panel-mount";
  socket_body_shell_left_panel_mount_3.position.set(-0.4825, 0.0, 0.24);
  socket_body_shell_left_panel_mount_3.rotation.set(0.0, 0.0, 0.0);
  socket_body_shell_left_panel_mount_3.userData.socket = {"id": "left-panel-mount", "localPosition": [-0.4825, 0.0, 0.24], "localRotation": [0.0, 0.0, 0.0]};
  node_body_shell_0.add(socket_body_shell_left_panel_mount_3);
  sockets["body-shell:left-panel-mount"] = socket_body_shell_left_panel_mount_3;
  const socket_body_shell_right_panel_mount_4 = new THREE.Object3D();
  socket_body_shell_right_panel_mount_4.name = "right-panel-mount";
  socket_body_shell_right_panel_mount_4.position.set(0.4825, 0.0, 0.24);
  socket_body_shell_right_panel_mount_4.rotation.set(0.0, 0.0, 0.0);
  socket_body_shell_right_panel_mount_4.userData.socket = {"id": "right-panel-mount", "localPosition": [0.4825, 0.0, 0.24], "localRotation": [0.0, 0.0, 0.0]};
  node_body_shell_0.add(socket_body_shell_right_panel_mount_4);
  sockets["body-shell:right-panel-mount"] = socket_body_shell_right_panel_mount_4;
  const socket_body_shell_rail_mount_5 = new THREE.Object3D();
  socket_body_shell_rail_mount_5.name = "rail-mount";
  socket_body_shell_rail_mount_5.position.set(0.0, 0.0, 0.531);
  socket_body_shell_rail_mount_5.rotation.set(0.0, 0.0, 0.0);
  socket_body_shell_rail_mount_5.userData.socket = {"id": "rail-mount", "localPosition": [0.0, 0.0, 0.531], "localRotation": [0.0, 0.0, 0.0]};
  node_body_shell_0.add(socket_body_shell_rail_mount_5);
  sockets["body-shell:rail-mount"] = socket_body_shell_rail_mount_5;
  const socket_body_shell_handle_mount_6 = new THREE.Object3D();
  socket_body_shell_handle_mount_6.name = "handle-mount";
  socket_body_shell_handle_mount_6.position.set(-0.4825, 0.0, 0.3);
  socket_body_shell_handle_mount_6.rotation.set(0.0, 0.0, 0.0);
  socket_body_shell_handle_mount_6.userData.socket = {"id": "handle-mount", "localPosition": [-0.4825, 0.0, 0.3], "localRotation": [0.0, 0.0, 0.0]};
  node_body_shell_0.add(socket_body_shell_handle_mount_6);
  sockets["body-shell:handle-mount"] = socket_body_shell_handle_mount_6;
  const socket_body_shell_hinge_mount_7 = new THREE.Object3D();
  socket_body_shell_hinge_mount_7.name = "hinge-mount";
  socket_body_shell_hinge_mount_7.position.set(0.0, 0.37, 0.593);
  socket_body_shell_hinge_mount_7.rotation.set(0.0, 0.0, 0.0);
  socket_body_shell_hinge_mount_7.userData.socket = {"id": "hinge-mount", "localPosition": [0.0, 0.37, 0.593], "localRotation": [0.0, 0.0, 0.0]};
  node_body_shell_0.add(socket_body_shell_hinge_mount_7);
  sockets["body-shell:hinge-mount"] = socket_body_shell_hinge_mount_7;

  const attachment_lid_shell_1 = null;
  const endpoint_lid_shell_1 = makeAttachmentEndpoint(attachment_lid_shell_1);
  const node_lid_shell_1 = new THREE.Group();
  node_lid_shell_1.name = "Lid rim band__pivot";
  node_lid_shell_1.scale.set(1, 1, 1);
  if (endpoint_lid_shell_1) {
    node_lid_shell_1.position.copy(endpoint_lid_shell_1.start);
    node_lid_shell_1.rotation.set(-1.570796, 0.0, -0.0);
  } else {
    node_lid_shell_1.position.set(0.0, 0.593, -0.418);
    node_lid_shell_1.rotation.set(-1.570796, 0.0, -0.0);
  }
  node_lid_shell_1.userData.sculptComponent = {"id": "lid-shell", "name": "Lid rim band", "level": "macro", "role": "lid", "importance": 0.95, "confidence": 0.75, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid overhangs the body as a straight lip below the taper; its rear edge is the hinge axis, so this band is the lid group's pivot node.", "geometryDescriptor": {"topologyIntent": "straight chamfered band forming the lid lip and the hinge pivot node", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 1}, "profile2D": {"points": [[-0.518, -0.836], [0.518, -0.836], [0.548, -0.806], [0.548, -0.03], [0.518, 0.0], [-0.518, 0.0], [-0.548, -0.03], [-0.548, -0.806]], "depth": 0.045}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "flat faces with hard chamfer creases"}, "parent": null, "attachment": null, "dimensions": {"width": 1.096, "height": 0.045, "depth": 0.836, "units": "relative", "confidence": 0.7}, "transform": {"position": [0.0, 0.593, -0.418], "rotation": [-1.570796, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "hinge-lid", "pivot": {"mode": "rear-hinge-axis", "localPosition": [0.0, 0.0, 0.0], "axis": [1, 0, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "slope-front-mount", "localPosition": [0.0, -0.836, 0.067], "localRotation": [0.0, 0.0, 0.0]}, {"id": "slope-rear-mount", "localPosition": [0.0, 0.0, 0.067], "localRotation": [0.0, 0.0, 0.0]}, {"id": "slope-left-mount", "localPosition": [-0.548, -0.418, 0.067], "localRotation": [0.0, 0.0, 0.0]}, {"id": "slope-right-mount", "localPosition": [0.548, -0.418, 0.067], "localRotation": [0.0, 0.0, 0.0]}, {"id": "cap-front-left-mount", "localPosition": [-0.548, -0.836, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "cap-front-right-mount", "localPosition": [0.548, -0.836, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "cap-rear-left-mount", "localPosition": [-0.548, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "cap-rear-right-mount", "localPosition": [0.548, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "hinge-barrel-mount", "localPosition": [0.0, 0.0, 0.02], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0.14, 0.33], "scale": [1.0, 0.28, 0.66], "isTrigger": false, "notes": "Box proxy covering rim, slopes and top panel."}, "constraints": [{"id": "lid-hinge-limit", "type": "hinge", "axis": [1, 0, 0], "minDegrees": 0.0, "maxDegrees": 105.0, "restDegrees": 0.0, "notes": "Closed at 0; 105 degrees clears the rear hinge barrel before the lid caps would collide with the rear wall. The open pose is inferred: the reference only shows the chest closed."}], "destruction": {"breakable": true, "fractureGroup": "lid-shell", "seamRefs": ["lid-body-seam"], "detachableFragments": ["lid-top-panel", "lid-slope-front", "lid-slope-rear", "lid-slope-left", "lid-slope-right"], "breakImpulse": 6.5, "debrisMaterial": "lid-lacquer"}}, "material": "lid-lacquer", "materialLayers": ["lid-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 39, 143, 1.0)", "secondaryAlbedo": "rgba(168, 98, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer, brighter violet than the body shell", "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["lid-taper", "full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rim-overhang-shadow", "kind": "contour", "description": "Lid lip overhangs the body and casts the dark seam line.", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["lid-taper", "full-object"], "details": [], "fidelityTier": "blockout"};
  node_lid_shell_1.userData.actionProfile = {"animationRole": "hinge-lid", "pivot": {"mode": "rear-hinge-axis", "localPosition": [0.0, 0.0, 0.0], "axis": [1, 0, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "slope-front-mount", "localPosition": [0.0, -0.836, 0.067], "localRotation": [0.0, 0.0, 0.0]}, {"id": "slope-rear-mount", "localPosition": [0.0, 0.0, 0.067], "localRotation": [0.0, 0.0, 0.0]}, {"id": "slope-left-mount", "localPosition": [-0.548, -0.418, 0.067], "localRotation": [0.0, 0.0, 0.0]}, {"id": "slope-right-mount", "localPosition": [0.548, -0.418, 0.067], "localRotation": [0.0, 0.0, 0.0]}, {"id": "cap-front-left-mount", "localPosition": [-0.548, -0.836, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "cap-front-right-mount", "localPosition": [0.548, -0.836, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "cap-rear-left-mount", "localPosition": [-0.548, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "cap-rear-right-mount", "localPosition": [0.548, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "hinge-barrel-mount", "localPosition": [0.0, 0.0, 0.02], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0.14, 0.33], "scale": [1.0, 0.28, 0.66], "isTrigger": false, "notes": "Box proxy covering rim, slopes and top panel."}, "constraints": [{"id": "lid-hinge-limit", "type": "hinge", "axis": [1, 0, 0], "minDegrees": 0.0, "maxDegrees": 105.0, "restDegrees": 0.0, "notes": "Closed at 0; 105 degrees clears the rear hinge barrel before the lid caps would collide with the rear wall. The open pose is inferred: the reference only shows the chest closed."}], "destruction": {"breakable": true, "fractureGroup": "lid-shell", "seamRefs": ["lid-body-seam"], "detachableFragments": ["lid-top-panel", "lid-slope-front", "lid-slope-rear", "lid-slope-left", "lid-slope-right"], "breakImpulse": 6.5, "debrisMaterial": "lid-lacquer"}};
  (nodes["root"] ?? root).add(node_lid_shell_1);
  nodes["lid-shell"] = node_lid_shell_1;
  const mesh_lid_shell_1Geometry = endpoint_lid_shell_1
    ? new THREE.CylinderGeometry(endpoint_lid_shell_1.endRadius, endpoint_lid_shell_1.baseRadius, endpoint_lid_shell_1.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.518, -0.836], [0.518, -0.836], [0.548, -0.806], [0.548, -0.03], [0.518, 0.0], [-0.518, 0.0], [-0.548, -0.03], [-0.548, -0.806]], "depth": 0.045});
  if (!endpoint_lid_shell_1) {
    mesh_lid_shell_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lid_shell_1 = new THREE.Mesh(
    mesh_lid_shell_1Geometry,
    materialMap["lid-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lid_shell_1.name = "Lid rim band";
  if (endpoint_lid_shell_1) {
    mesh_lid_shell_1.position.copy(endpoint_lid_shell_1.midpoint);
    mesh_lid_shell_1.quaternion.copy(endpoint_lid_shell_1.quaternion);
  }
  mesh_lid_shell_1.castShadow = options.castShadow ?? true;
  mesh_lid_shell_1.receiveShadow = options.receiveShadow ?? true;
  mesh_lid_shell_1.userData.sculptComponent = {"id": "lid-shell", "name": "Lid rim band", "level": "macro", "role": "lid", "importance": 0.95, "confidence": 0.75, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid overhangs the body as a straight lip below the taper; its rear edge is the hinge axis, so this band is the lid group's pivot node.", "geometryDescriptor": {"topologyIntent": "straight chamfered band forming the lid lip and the hinge pivot node", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 1}, "profile2D": {"points": [[-0.518, -0.836], [0.518, -0.836], [0.548, -0.806], [0.548, -0.03], [0.518, 0.0], [-0.518, 0.0], [-0.548, -0.03], [-0.548, -0.806]], "depth": 0.045}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "flat faces with hard chamfer creases"}, "parent": null, "attachment": null, "dimensions": {"width": 1.096, "height": 0.045, "depth": 0.836, "units": "relative", "confidence": 0.7}, "transform": {"position": [0.0, 0.593, -0.418], "rotation": [-1.570796, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "hinge-lid", "pivot": {"mode": "rear-hinge-axis", "localPosition": [0.0, 0.0, 0.0], "axis": [1, 0, 0], "confidence": 0.7}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "slope-front-mount", "localPosition": [0.0, -0.836, 0.067], "localRotation": [0.0, 0.0, 0.0]}, {"id": "slope-rear-mount", "localPosition": [0.0, 0.0, 0.067], "localRotation": [0.0, 0.0, 0.0]}, {"id": "slope-left-mount", "localPosition": [-0.548, -0.418, 0.067], "localRotation": [0.0, 0.0, 0.0]}, {"id": "slope-right-mount", "localPosition": [0.548, -0.418, 0.067], "localRotation": [0.0, 0.0, 0.0]}, {"id": "cap-front-left-mount", "localPosition": [-0.548, -0.836, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "cap-front-right-mount", "localPosition": [0.548, -0.836, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "cap-rear-left-mount", "localPosition": [-0.548, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "cap-rear-right-mount", "localPosition": [0.548, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}, {"id": "hinge-barrel-mount", "localPosition": [0.0, 0.0, 0.02], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0.14, 0.33], "scale": [1.0, 0.28, 0.66], "isTrigger": false, "notes": "Box proxy covering rim, slopes and top panel."}, "constraints": [{"id": "lid-hinge-limit", "type": "hinge", "axis": [1, 0, 0], "minDegrees": 0.0, "maxDegrees": 105.0, "restDegrees": 0.0, "notes": "Closed at 0; 105 degrees clears the rear hinge barrel before the lid caps would collide with the rear wall. The open pose is inferred: the reference only shows the chest closed."}], "destruction": {"breakable": true, "fractureGroup": "lid-shell", "seamRefs": ["lid-body-seam"], "detachableFragments": ["lid-top-panel", "lid-slope-front", "lid-slope-rear", "lid-slope-left", "lid-slope-right"], "breakImpulse": 6.5, "debrisMaterial": "lid-lacquer"}}, "material": "lid-lacquer", "materialLayers": ["lid-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 39, 143, 1.0)", "secondaryAlbedo": "rgba(168, 98, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer, brighter violet than the body shell", "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["lid-taper", "full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rim-overhang-shadow", "kind": "contour", "description": "Lid lip overhangs the body and casts the dark seam line.", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["lid-taper", "full-object"], "details": [], "fidelityTier": "blockout"};
  node_lid_shell_1.add(mesh_lid_shell_1);
  meshes["lid-shell"] = mesh_lid_shell_1;
  colliders["lid-shell"] = {"type": "box", "offset": [0, 0.14, 0.33], "scale": [1.0, 0.28, 0.66], "isTrigger": false, "notes": "Box proxy covering rim, slopes and top panel."};
  destructionGroups["lid-shell"] ??= [];
  destructionGroups["lid-shell"].push(node_lid_shell_1);
  const socket_lid_shell_slope_front_mount_0 = new THREE.Object3D();
  socket_lid_shell_slope_front_mount_0.name = "slope-front-mount";
  socket_lid_shell_slope_front_mount_0.position.set(0.0, -0.836, 0.067);
  socket_lid_shell_slope_front_mount_0.rotation.set(0.0, 0.0, 0.0);
  socket_lid_shell_slope_front_mount_0.userData.socket = {"id": "slope-front-mount", "localPosition": [0.0, -0.836, 0.067], "localRotation": [0.0, 0.0, 0.0]};
  node_lid_shell_1.add(socket_lid_shell_slope_front_mount_0);
  sockets["lid-shell:slope-front-mount"] = socket_lid_shell_slope_front_mount_0;
  const socket_lid_shell_slope_rear_mount_1 = new THREE.Object3D();
  socket_lid_shell_slope_rear_mount_1.name = "slope-rear-mount";
  socket_lid_shell_slope_rear_mount_1.position.set(0.0, 0.0, 0.067);
  socket_lid_shell_slope_rear_mount_1.rotation.set(0.0, 0.0, 0.0);
  socket_lid_shell_slope_rear_mount_1.userData.socket = {"id": "slope-rear-mount", "localPosition": [0.0, 0.0, 0.067], "localRotation": [0.0, 0.0, 0.0]};
  node_lid_shell_1.add(socket_lid_shell_slope_rear_mount_1);
  sockets["lid-shell:slope-rear-mount"] = socket_lid_shell_slope_rear_mount_1;
  const socket_lid_shell_slope_left_mount_2 = new THREE.Object3D();
  socket_lid_shell_slope_left_mount_2.name = "slope-left-mount";
  socket_lid_shell_slope_left_mount_2.position.set(-0.548, -0.418, 0.067);
  socket_lid_shell_slope_left_mount_2.rotation.set(0.0, 0.0, 0.0);
  socket_lid_shell_slope_left_mount_2.userData.socket = {"id": "slope-left-mount", "localPosition": [-0.548, -0.418, 0.067], "localRotation": [0.0, 0.0, 0.0]};
  node_lid_shell_1.add(socket_lid_shell_slope_left_mount_2);
  sockets["lid-shell:slope-left-mount"] = socket_lid_shell_slope_left_mount_2;
  const socket_lid_shell_slope_right_mount_3 = new THREE.Object3D();
  socket_lid_shell_slope_right_mount_3.name = "slope-right-mount";
  socket_lid_shell_slope_right_mount_3.position.set(0.548, -0.418, 0.067);
  socket_lid_shell_slope_right_mount_3.rotation.set(0.0, 0.0, 0.0);
  socket_lid_shell_slope_right_mount_3.userData.socket = {"id": "slope-right-mount", "localPosition": [0.548, -0.418, 0.067], "localRotation": [0.0, 0.0, 0.0]};
  node_lid_shell_1.add(socket_lid_shell_slope_right_mount_3);
  sockets["lid-shell:slope-right-mount"] = socket_lid_shell_slope_right_mount_3;
  const socket_lid_shell_cap_front_left_mount_4 = new THREE.Object3D();
  socket_lid_shell_cap_front_left_mount_4.name = "cap-front-left-mount";
  socket_lid_shell_cap_front_left_mount_4.position.set(-0.548, -0.836, 0.0);
  socket_lid_shell_cap_front_left_mount_4.rotation.set(0.0, 0.0, 0.0);
  socket_lid_shell_cap_front_left_mount_4.userData.socket = {"id": "cap-front-left-mount", "localPosition": [-0.548, -0.836, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_lid_shell_1.add(socket_lid_shell_cap_front_left_mount_4);
  sockets["lid-shell:cap-front-left-mount"] = socket_lid_shell_cap_front_left_mount_4;
  const socket_lid_shell_cap_front_right_mount_5 = new THREE.Object3D();
  socket_lid_shell_cap_front_right_mount_5.name = "cap-front-right-mount";
  socket_lid_shell_cap_front_right_mount_5.position.set(0.548, -0.836, 0.0);
  socket_lid_shell_cap_front_right_mount_5.rotation.set(0.0, 0.0, 0.0);
  socket_lid_shell_cap_front_right_mount_5.userData.socket = {"id": "cap-front-right-mount", "localPosition": [0.548, -0.836, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_lid_shell_1.add(socket_lid_shell_cap_front_right_mount_5);
  sockets["lid-shell:cap-front-right-mount"] = socket_lid_shell_cap_front_right_mount_5;
  const socket_lid_shell_cap_rear_left_mount_6 = new THREE.Object3D();
  socket_lid_shell_cap_rear_left_mount_6.name = "cap-rear-left-mount";
  socket_lid_shell_cap_rear_left_mount_6.position.set(-0.548, 0.0, 0.0);
  socket_lid_shell_cap_rear_left_mount_6.rotation.set(0.0, 0.0, 0.0);
  socket_lid_shell_cap_rear_left_mount_6.userData.socket = {"id": "cap-rear-left-mount", "localPosition": [-0.548, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_lid_shell_1.add(socket_lid_shell_cap_rear_left_mount_6);
  sockets["lid-shell:cap-rear-left-mount"] = socket_lid_shell_cap_rear_left_mount_6;
  const socket_lid_shell_cap_rear_right_mount_7 = new THREE.Object3D();
  socket_lid_shell_cap_rear_right_mount_7.name = "cap-rear-right-mount";
  socket_lid_shell_cap_rear_right_mount_7.position.set(0.548, 0.0, 0.0);
  socket_lid_shell_cap_rear_right_mount_7.rotation.set(0.0, 0.0, 0.0);
  socket_lid_shell_cap_rear_right_mount_7.userData.socket = {"id": "cap-rear-right-mount", "localPosition": [0.548, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_lid_shell_1.add(socket_lid_shell_cap_rear_right_mount_7);
  sockets["lid-shell:cap-rear-right-mount"] = socket_lid_shell_cap_rear_right_mount_7;
  const socket_lid_shell_hinge_barrel_mount_8 = new THREE.Object3D();
  socket_lid_shell_hinge_barrel_mount_8.name = "hinge-barrel-mount";
  socket_lid_shell_hinge_barrel_mount_8.position.set(0.0, 0.0, 0.02);
  socket_lid_shell_hinge_barrel_mount_8.rotation.set(0.0, 0.0, 0.0);
  socket_lid_shell_hinge_barrel_mount_8.userData.socket = {"id": "hinge-barrel-mount", "localPosition": [0.0, 0.0, 0.02], "localRotation": [0.0, 0.0, 0.0]};
  node_lid_shell_1.add(socket_lid_shell_hinge_barrel_mount_8);
  sockets["lid-shell:hinge-barrel-mount"] = socket_lid_shell_hinge_barrel_mount_8;

  const attachment_lid_slope_front_2 = {"parentId": "lid-shell", "parentSocket": "slope-front-mount", "contactType": "surface-mount", "localStart": [0.0, -0.836, 0.045], "localEnd": [0.0, -0.836, 0.045], "contactNormal": [0.0, 0.49858, 0.86685], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Facet plate seats on the rim top edge and is capped by the top panel.", "evidenceRefs": ["full-object"]};
  const endpoint_lid_slope_front_2 = makeAttachmentEndpoint(attachment_lid_slope_front_2);
  const node_lid_slope_front_2 = new THREE.Group();
  node_lid_slope_front_2.name = "Lid front sloped face__pivot";
  node_lid_slope_front_2.scale.set(1, 1, 1);
  if (endpoint_lid_slope_front_2) {
    node_lid_slope_front_2.position.copy(endpoint_lid_slope_front_2.start);
    node_lid_slope_front_2.rotation.set(1.048839, 0.0, -0.0);
  } else {
    node_lid_slope_front_2.position.set(0.0, -0.792658, 0.020071);
    node_lid_slope_front_2.rotation.set(1.048839, 0.0, -0.0);
  }
  node_lid_slope_front_2.userData.sculptComponent = {"id": "lid-slope-front", "name": "Lid front sloped face", "level": "macro", "role": "lid-facet", "importance": 0.9, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid is a rectangular frustum: the front face is one flat plane tilted 29.9 degrees off vertical, creased against its neighbours at the corners.", "geometryDescriptor": {"topologyIntent": "flat trapezoidal facet of the lid frustum", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "profile2D": {"points": [[-0.5633, -0.025], [0.5633, -0.025], [0.4247, 0.2015], [-0.4247, 0.2015]], "depth": 0.05}, "deformationStack": [], "uvStrategy": "extrude cap UVs along the slope direction", "normalStrategy": "single flat facet normal, hard crease at the corners"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "slope-front-mount", "contactType": "surface-mount", "localStart": [0.0, -0.836, 0.045], "localEnd": [0.0, -0.836, 0.045], "contactNormal": [0.0, 0.49858, 0.86685], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Facet plate seats on the rim top edge and is capped by the top panel.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.096, "height": 0.1765, "depth": 0.05, "units": "relative", "confidence": 0.65}, "transform": {"position": [0.0, -0.792658, 0.020071], "rotation": [1.048839, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "lid-lacquer", "materialLayers": ["lid-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 39, 143, 1.0)", "secondaryAlbedo": "rgba(168, 98, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer, brighter violet than the body shell", "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["lid-taper", "full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "lid-taper-crease", "kind": "ridge", "description": "Hard crease where this facet meets the neighbouring lid facet.", "evidenceRefs": ["lid-taper"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["lid-taper", "full-object"], "details": [], "fidelityTier": "blockout"};
  node_lid_slope_front_2.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["lid-shell"] ?? root).add(node_lid_slope_front_2);
  nodes["lid-slope-front"] = node_lid_slope_front_2;
  const mesh_lid_slope_front_2Geometry = endpoint_lid_slope_front_2
    ? new THREE.CylinderGeometry(endpoint_lid_slope_front_2.endRadius, endpoint_lid_slope_front_2.baseRadius, endpoint_lid_slope_front_2.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.5633, -0.025], [0.5633, -0.025], [0.4247, 0.2015], [-0.4247, 0.2015]], "depth": 0.05});
  if (!endpoint_lid_slope_front_2) {
    mesh_lid_slope_front_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lid_slope_front_2 = new THREE.Mesh(
    mesh_lid_slope_front_2Geometry,
    materialMap["lid-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lid_slope_front_2.name = "Lid front sloped face";
  if (endpoint_lid_slope_front_2) {
    mesh_lid_slope_front_2.position.copy(endpoint_lid_slope_front_2.midpoint);
    mesh_lid_slope_front_2.quaternion.copy(endpoint_lid_slope_front_2.quaternion);
  }
  mesh_lid_slope_front_2.castShadow = options.castShadow ?? true;
  mesh_lid_slope_front_2.receiveShadow = options.receiveShadow ?? true;
  mesh_lid_slope_front_2.userData.sculptComponent = {"id": "lid-slope-front", "name": "Lid front sloped face", "level": "macro", "role": "lid-facet", "importance": 0.9, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid is a rectangular frustum: the front face is one flat plane tilted 29.9 degrees off vertical, creased against its neighbours at the corners.", "geometryDescriptor": {"topologyIntent": "flat trapezoidal facet of the lid frustum", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "profile2D": {"points": [[-0.5633, -0.025], [0.5633, -0.025], [0.4247, 0.2015], [-0.4247, 0.2015]], "depth": 0.05}, "deformationStack": [], "uvStrategy": "extrude cap UVs along the slope direction", "normalStrategy": "single flat facet normal, hard crease at the corners"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "slope-front-mount", "contactType": "surface-mount", "localStart": [0.0, -0.836, 0.045], "localEnd": [0.0, -0.836, 0.045], "contactNormal": [0.0, 0.49858, 0.86685], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Facet plate seats on the rim top edge and is capped by the top panel.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.096, "height": 0.1765, "depth": 0.05, "units": "relative", "confidence": 0.65}, "transform": {"position": [0.0, -0.792658, 0.020071], "rotation": [1.048839, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "lid-lacquer", "materialLayers": ["lid-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 39, 143, 1.0)", "secondaryAlbedo": "rgba(168, 98, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer, brighter violet than the body shell", "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["lid-taper", "full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "lid-taper-crease", "kind": "ridge", "description": "Hard crease where this facet meets the neighbouring lid facet.", "evidenceRefs": ["lid-taper"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["lid-taper", "full-object"], "details": [], "fidelityTier": "blockout"};
  node_lid_slope_front_2.add(mesh_lid_slope_front_2);
  meshes["lid-slope-front"] = mesh_lid_slope_front_2;
  colliders["lid-slope-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-lid-facet"] ??= [];
  destructionGroups["chest-lid-facet"].push(node_lid_slope_front_2);

  const attachment_lid_slope_rear_3 = {"parentId": "lid-shell", "parentSocket": "slope-rear-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.045], "localEnd": [0.0, 0.0, 0.045], "contactNormal": [0.0, 0.49858, -0.86685], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Facet plate seats on the rim top edge and is capped by the top panel.", "evidenceRefs": ["full-object"]};
  const endpoint_lid_slope_rear_3 = makeAttachmentEndpoint(attachment_lid_slope_rear_3);
  const node_lid_slope_rear_3 = new THREE.Group();
  node_lid_slope_rear_3.name = "Lid rear sloped face__pivot";
  node_lid_slope_rear_3.scale.set(1, 1, 1);
  if (endpoint_lid_slope_rear_3) {
    node_lid_slope_rear_3.position.copy(endpoint_lid_slope_rear_3.start);
    node_lid_slope_rear_3.rotation.set(-1.048839, 0.0, -3.141593);
  } else {
    node_lid_slope_rear_3.position.set(0.0, -0.043342, 0.020071);
    node_lid_slope_rear_3.rotation.set(-1.048839, 0.0, -3.141593);
  }
  node_lid_slope_rear_3.userData.sculptComponent = {"id": "lid-slope-rear", "name": "Lid rear sloped face", "level": "macro", "role": "lid-facet", "importance": 0.9, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid is a rectangular frustum: the rear face is one flat plane tilted 29.9 degrees off vertical, creased against its neighbours at the corners.", "geometryDescriptor": {"topologyIntent": "flat trapezoidal facet of the lid frustum", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "profile2D": {"points": [[-0.5633, -0.025], [0.5633, -0.025], [0.4247, 0.2015], [-0.4247, 0.2015]], "depth": 0.05}, "deformationStack": [], "uvStrategy": "extrude cap UVs along the slope direction", "normalStrategy": "single flat facet normal, hard crease at the corners"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "slope-rear-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.045], "localEnd": [0.0, 0.0, 0.045], "contactNormal": [0.0, 0.49858, -0.86685], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Facet plate seats on the rim top edge and is capped by the top panel.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.096, "height": 0.1765, "depth": 0.05, "units": "relative", "confidence": 0.65}, "transform": {"position": [0.0, -0.043342, 0.020071], "rotation": [-1.048839, 0.0, -3.141593], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "lid-lacquer", "materialLayers": ["lid-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 39, 143, 1.0)", "secondaryAlbedo": "rgba(168, 98, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer, brighter violet than the body shell", "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["lid-taper", "full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["lid-taper", "full-object"], "details": [], "fidelityTier": "blockout"};
  node_lid_slope_rear_3.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["lid-shell"] ?? root).add(node_lid_slope_rear_3);
  nodes["lid-slope-rear"] = node_lid_slope_rear_3;
  const mesh_lid_slope_rear_3Geometry = endpoint_lid_slope_rear_3
    ? new THREE.CylinderGeometry(endpoint_lid_slope_rear_3.endRadius, endpoint_lid_slope_rear_3.baseRadius, endpoint_lid_slope_rear_3.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.5633, -0.025], [0.5633, -0.025], [0.4247, 0.2015], [-0.4247, 0.2015]], "depth": 0.05});
  if (!endpoint_lid_slope_rear_3) {
    mesh_lid_slope_rear_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lid_slope_rear_3 = new THREE.Mesh(
    mesh_lid_slope_rear_3Geometry,
    materialMap["lid-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lid_slope_rear_3.name = "Lid rear sloped face";
  if (endpoint_lid_slope_rear_3) {
    mesh_lid_slope_rear_3.position.copy(endpoint_lid_slope_rear_3.midpoint);
    mesh_lid_slope_rear_3.quaternion.copy(endpoint_lid_slope_rear_3.quaternion);
  }
  mesh_lid_slope_rear_3.castShadow = options.castShadow ?? true;
  mesh_lid_slope_rear_3.receiveShadow = options.receiveShadow ?? true;
  mesh_lid_slope_rear_3.userData.sculptComponent = {"id": "lid-slope-rear", "name": "Lid rear sloped face", "level": "macro", "role": "lid-facet", "importance": 0.9, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid is a rectangular frustum: the rear face is one flat plane tilted 29.9 degrees off vertical, creased against its neighbours at the corners.", "geometryDescriptor": {"topologyIntent": "flat trapezoidal facet of the lid frustum", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "profile2D": {"points": [[-0.5633, -0.025], [0.5633, -0.025], [0.4247, 0.2015], [-0.4247, 0.2015]], "depth": 0.05}, "deformationStack": [], "uvStrategy": "extrude cap UVs along the slope direction", "normalStrategy": "single flat facet normal, hard crease at the corners"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "slope-rear-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.045], "localEnd": [0.0, 0.0, 0.045], "contactNormal": [0.0, 0.49858, -0.86685], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Facet plate seats on the rim top edge and is capped by the top panel.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.096, "height": 0.1765, "depth": 0.05, "units": "relative", "confidence": 0.65}, "transform": {"position": [0.0, -0.043342, 0.020071], "rotation": [-1.048839, 0.0, -3.141593], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "lid-lacquer", "materialLayers": ["lid-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 39, 143, 1.0)", "secondaryAlbedo": "rgba(168, 98, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer, brighter violet than the body shell", "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["lid-taper", "full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["lid-taper", "full-object"], "details": [], "fidelityTier": "blockout"};
  node_lid_slope_rear_3.add(mesh_lid_slope_rear_3);
  meshes["lid-slope-rear"] = mesh_lid_slope_rear_3;
  colliders["lid-slope-rear"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-lid-facet"] ??= [];
  destructionGroups["chest-lid-facet"].push(node_lid_slope_rear_3);

  const attachment_lid_slope_left_4 = {"parentId": "lid-shell", "parentSocket": "slope-left-mount", "contactType": "surface-mount", "localStart": [-0.548, -0.418, 0.045], "localEnd": [-0.548, -0.418, 0.045], "contactNormal": [-0.81697, 0.57668, 0.0], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Facet plate seats on the rim top edge and is capped by the top panel.", "evidenceRefs": ["full-object"]};
  const endpoint_lid_slope_left_4 = makeAttachmentEndpoint(attachment_lid_slope_left_4);
  const node_lid_slope_left_4 = new THREE.Group();
  node_lid_slope_left_4.name = "Lid left sloped face__pivot";
  node_lid_slope_left_4.scale.set(1, 1, 1);
  if (endpoint_lid_slope_left_4) {
    node_lid_slope_left_4.position.copy(endpoint_lid_slope_left_4.start);
    node_lid_slope_left_4.rotation.set(-0.0, -0.956133, -1.570796);
  } else {
    node_lid_slope_left_4.position.set(-0.507152, -0.418, 0.016166);
    node_lid_slope_left_4.rotation.set(-0.0, -0.956133, -1.570796);
  }
  node_lid_slope_left_4.userData.sculptComponent = {"id": "lid-slope-left", "name": "Lid left sloped face", "level": "macro", "role": "lid-facet", "importance": 0.9, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid is a rectangular frustum: the left face is one flat plane tilted 35.2 degrees off vertical, creased against its neighbours at the corners.", "geometryDescriptor": {"topologyIntent": "flat trapezoidal facet of the lid frustum", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "profile2D": {"points": [[-0.42975, -0.025], [0.42975, -0.025], [0.31825, 0.21228], [-0.31825, 0.21228]], "depth": 0.05}, "deformationStack": [], "uvStrategy": "extrude cap UVs along the slope direction", "normalStrategy": "single flat facet normal, hard crease at the corners"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "slope-left-mount", "contactType": "surface-mount", "localStart": [-0.548, -0.418, 0.045], "localEnd": [-0.548, -0.418, 0.045], "contactNormal": [-0.81697, 0.57668, 0.0], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Facet plate seats on the rim top edge and is capped by the top panel.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.836, "height": 0.1873, "depth": 0.05, "units": "relative", "confidence": 0.65}, "transform": {"position": [-0.507152, -0.418, 0.016166], "rotation": [-0.0, -0.956133, -1.570796], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "lid-lacquer", "materialLayers": ["lid-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 39, 143, 1.0)", "secondaryAlbedo": "rgba(168, 98, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer, brighter violet than the body shell", "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["lid-taper", "full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["lid-taper", "full-object"], "details": [], "fidelityTier": "blockout"};
  node_lid_slope_left_4.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["lid-shell"] ?? root).add(node_lid_slope_left_4);
  nodes["lid-slope-left"] = node_lid_slope_left_4;
  const mesh_lid_slope_left_4Geometry = endpoint_lid_slope_left_4
    ? new THREE.CylinderGeometry(endpoint_lid_slope_left_4.endRadius, endpoint_lid_slope_left_4.baseRadius, endpoint_lid_slope_left_4.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.42975, -0.025], [0.42975, -0.025], [0.31825, 0.21228], [-0.31825, 0.21228]], "depth": 0.05});
  if (!endpoint_lid_slope_left_4) {
    mesh_lid_slope_left_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lid_slope_left_4 = new THREE.Mesh(
    mesh_lid_slope_left_4Geometry,
    materialMap["lid-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lid_slope_left_4.name = "Lid left sloped face";
  if (endpoint_lid_slope_left_4) {
    mesh_lid_slope_left_4.position.copy(endpoint_lid_slope_left_4.midpoint);
    mesh_lid_slope_left_4.quaternion.copy(endpoint_lid_slope_left_4.quaternion);
  }
  mesh_lid_slope_left_4.castShadow = options.castShadow ?? true;
  mesh_lid_slope_left_4.receiveShadow = options.receiveShadow ?? true;
  mesh_lid_slope_left_4.userData.sculptComponent = {"id": "lid-slope-left", "name": "Lid left sloped face", "level": "macro", "role": "lid-facet", "importance": 0.9, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid is a rectangular frustum: the left face is one flat plane tilted 35.2 degrees off vertical, creased against its neighbours at the corners.", "geometryDescriptor": {"topologyIntent": "flat trapezoidal facet of the lid frustum", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "profile2D": {"points": [[-0.42975, -0.025], [0.42975, -0.025], [0.31825, 0.21228], [-0.31825, 0.21228]], "depth": 0.05}, "deformationStack": [], "uvStrategy": "extrude cap UVs along the slope direction", "normalStrategy": "single flat facet normal, hard crease at the corners"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "slope-left-mount", "contactType": "surface-mount", "localStart": [-0.548, -0.418, 0.045], "localEnd": [-0.548, -0.418, 0.045], "contactNormal": [-0.81697, 0.57668, 0.0], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Facet plate seats on the rim top edge and is capped by the top panel.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.836, "height": 0.1873, "depth": 0.05, "units": "relative", "confidence": 0.65}, "transform": {"position": [-0.507152, -0.418, 0.016166], "rotation": [-0.0, -0.956133, -1.570796], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "lid-lacquer", "materialLayers": ["lid-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 39, 143, 1.0)", "secondaryAlbedo": "rgba(168, 98, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer, brighter violet than the body shell", "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["lid-taper", "full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["lid-taper", "full-object"], "details": [], "fidelityTier": "blockout"};
  node_lid_slope_left_4.add(mesh_lid_slope_left_4);
  meshes["lid-slope-left"] = mesh_lid_slope_left_4;
  colliders["lid-slope-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-lid-facet"] ??= [];
  destructionGroups["chest-lid-facet"].push(node_lid_slope_left_4);

  const attachment_lid_slope_right_5 = {"parentId": "lid-shell", "parentSocket": "slope-right-mount", "contactType": "surface-mount", "localStart": [0.548, -0.418, 0.045], "localEnd": [0.548, -0.418, 0.045], "contactNormal": [0.81697, 0.57668, 0.0], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Facet plate seats on the rim top edge and is capped by the top panel.", "evidenceRefs": ["full-object"]};
  const endpoint_lid_slope_right_5 = makeAttachmentEndpoint(attachment_lid_slope_right_5);
  const node_lid_slope_right_5 = new THREE.Group();
  node_lid_slope_right_5.name = "Lid right sloped face__pivot";
  node_lid_slope_right_5.scale.set(1, 1, 1);
  if (endpoint_lid_slope_right_5) {
    node_lid_slope_right_5.position.copy(endpoint_lid_slope_right_5.start);
    node_lid_slope_right_5.rotation.set(-0.0, 0.956133, 1.570796);
  } else {
    node_lid_slope_right_5.position.set(0.507152, -0.418, 0.016166);
    node_lid_slope_right_5.rotation.set(-0.0, 0.956133, 1.570796);
  }
  node_lid_slope_right_5.userData.sculptComponent = {"id": "lid-slope-right", "name": "Lid right sloped face", "level": "macro", "role": "lid-facet", "importance": 0.9, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid is a rectangular frustum: the right face is one flat plane tilted 35.2 degrees off vertical, creased against its neighbours at the corners.", "geometryDescriptor": {"topologyIntent": "flat trapezoidal facet of the lid frustum", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "profile2D": {"points": [[-0.42975, -0.025], [0.42975, -0.025], [0.31825, 0.21228], [-0.31825, 0.21228]], "depth": 0.05}, "deformationStack": [], "uvStrategy": "extrude cap UVs along the slope direction", "normalStrategy": "single flat facet normal, hard crease at the corners"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "slope-right-mount", "contactType": "surface-mount", "localStart": [0.548, -0.418, 0.045], "localEnd": [0.548, -0.418, 0.045], "contactNormal": [0.81697, 0.57668, 0.0], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Facet plate seats on the rim top edge and is capped by the top panel.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.836, "height": 0.1873, "depth": 0.05, "units": "relative", "confidence": 0.65}, "transform": {"position": [0.507152, -0.418, 0.016166], "rotation": [-0.0, 0.956133, 1.570796], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "lid-lacquer", "materialLayers": ["lid-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 39, 143, 1.0)", "secondaryAlbedo": "rgba(168, 98, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer, brighter violet than the body shell", "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["lid-taper", "full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["lid-taper", "full-object"], "details": [], "fidelityTier": "blockout"};
  node_lid_slope_right_5.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["lid-shell"] ?? root).add(node_lid_slope_right_5);
  nodes["lid-slope-right"] = node_lid_slope_right_5;
  const mesh_lid_slope_right_5Geometry = endpoint_lid_slope_right_5
    ? new THREE.CylinderGeometry(endpoint_lid_slope_right_5.endRadius, endpoint_lid_slope_right_5.baseRadius, endpoint_lid_slope_right_5.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.42975, -0.025], [0.42975, -0.025], [0.31825, 0.21228], [-0.31825, 0.21228]], "depth": 0.05});
  if (!endpoint_lid_slope_right_5) {
    mesh_lid_slope_right_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lid_slope_right_5 = new THREE.Mesh(
    mesh_lid_slope_right_5Geometry,
    materialMap["lid-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lid_slope_right_5.name = "Lid right sloped face";
  if (endpoint_lid_slope_right_5) {
    mesh_lid_slope_right_5.position.copy(endpoint_lid_slope_right_5.midpoint);
    mesh_lid_slope_right_5.quaternion.copy(endpoint_lid_slope_right_5.quaternion);
  }
  mesh_lid_slope_right_5.castShadow = options.castShadow ?? true;
  mesh_lid_slope_right_5.receiveShadow = options.receiveShadow ?? true;
  mesh_lid_slope_right_5.userData.sculptComponent = {"id": "lid-slope-right", "name": "Lid right sloped face", "level": "macro", "role": "lid-facet", "importance": 0.9, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid is a rectangular frustum: the right face is one flat plane tilted 35.2 degrees off vertical, creased against its neighbours at the corners.", "geometryDescriptor": {"topologyIntent": "flat trapezoidal facet of the lid frustum", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "profile2D": {"points": [[-0.42975, -0.025], [0.42975, -0.025], [0.31825, 0.21228], [-0.31825, 0.21228]], "depth": 0.05}, "deformationStack": [], "uvStrategy": "extrude cap UVs along the slope direction", "normalStrategy": "single flat facet normal, hard crease at the corners"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "slope-right-mount", "contactType": "surface-mount", "localStart": [0.548, -0.418, 0.045], "localEnd": [0.548, -0.418, 0.045], "contactNormal": [0.81697, 0.57668, 0.0], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Facet plate seats on the rim top edge and is capped by the top panel.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.836, "height": 0.1873, "depth": 0.05, "units": "relative", "confidence": 0.65}, "transform": {"position": [0.507152, -0.418, 0.016166], "rotation": [-0.0, 0.956133, 1.570796], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "lid-lacquer", "materialLayers": ["lid-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 39, 143, 1.0)", "secondaryAlbedo": "rgba(168, 98, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer, brighter violet than the body shell", "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["lid-taper", "full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["lid-taper", "full-object"], "details": [], "fidelityTier": "blockout"};
  node_lid_slope_right_5.add(mesh_lid_slope_right_5);
  meshes["lid-slope-right"] = mesh_lid_slope_right_5;
  colliders["lid-slope-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-lid-facet"] ??= [];
  destructionGroups["chest-lid-facet"].push(node_lid_slope_right_5);

  const attachment_lid_top_panel_6 = {"parentId": "lid-shell", "parentSocket": "slope-front-mount", "contactType": "surface-mount", "localStart": [0.0, -0.418, 0.173], "localEnd": [0.0, -0.418, 0.173], "contactNormal": [0.0, 1.0, 0.0], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Top panel overlaps the upper edge of all four facets.", "evidenceRefs": ["full-object"]};
  const endpoint_lid_top_panel_6 = makeAttachmentEndpoint(attachment_lid_top_panel_6);
  const node_lid_top_panel_6 = new THREE.Group();
  node_lid_top_panel_6.name = "Lid top panel__pivot";
  node_lid_top_panel_6.scale.set(1, 1, 1);
  if (endpoint_lid_top_panel_6) {
    node_lid_top_panel_6.position.copy(endpoint_lid_top_panel_6.start);
    node_lid_top_panel_6.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_lid_top_panel_6.position.set(0.0, -0.418, 0.173);
    node_lid_top_panel_6.rotation.set(-0.0, 0.0, -0.0);
  }
  node_lid_top_panel_6.userData.sculptComponent = {"id": "lid-top-panel", "name": "Lid top panel", "level": "macro", "role": "lid-facet", "importance": 0.85, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The top of the lid is a flat quad noticeably smaller than the footprint, ringed by a bright narrow chamfer where the sloped facets meet it.", "geometryDescriptor": {"topologyIntent": "flat top plate closing the frustum with a bright top chamfer", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 1}, "profile2D": {"points": [[-0.41, -0.33], [0.41, -0.33], [0.44, -0.3], [0.44, 0.3], [0.41, 0.33], [-0.41, 0.33], [-0.44, 0.3], [-0.44, -0.3]], "depth": 0.057}, "deformationStack": [], "uvStrategy": "extrude cap UVs", "normalStrategy": "flat top face, chamfered rim"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "slope-front-mount", "contactType": "surface-mount", "localStart": [0.0, -0.418, 0.173], "localEnd": [0.0, -0.418, 0.173], "contactNormal": [0.0, 1.0, 0.0], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Top panel overlaps the upper edge of all four facets.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.88, "height": 0.057, "depth": 0.66, "units": "relative", "confidence": 0.65}, "transform": {"position": [0.0, -0.418, 0.173], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "lid-lacquer", "materialLayers": ["lid-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 39, 143, 1.0)", "secondaryAlbedo": "rgba(168, 98, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer, brighter violet than the body shell", "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["lid-taper", "full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "lid-top-chamfer", "kind": "bevel", "description": "Bright narrow chamfer band around the top face.", "evidenceRefs": ["lid-taper"]}, {"id": "lid-top-gloss", "kind": "gloss", "description": "Large soft highlight on the top face, brightest of the painted surfaces.", "evidenceRefs": ["lid-taper"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["lid-taper"], "details": [], "fidelityTier": "blockout"};
  node_lid_top_panel_6.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["lid-shell"] ?? root).add(node_lid_top_panel_6);
  nodes["lid-top-panel"] = node_lid_top_panel_6;
  const mesh_lid_top_panel_6Geometry = endpoint_lid_top_panel_6
    ? new THREE.CylinderGeometry(endpoint_lid_top_panel_6.endRadius, endpoint_lid_top_panel_6.baseRadius, endpoint_lid_top_panel_6.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.41, -0.33], [0.41, -0.33], [0.44, -0.3], [0.44, 0.3], [0.41, 0.33], [-0.41, 0.33], [-0.44, 0.3], [-0.44, -0.3]], "depth": 0.057});
  if (!endpoint_lid_top_panel_6) {
    mesh_lid_top_panel_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lid_top_panel_6 = new THREE.Mesh(
    mesh_lid_top_panel_6Geometry,
    materialMap["lid-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lid_top_panel_6.name = "Lid top panel";
  if (endpoint_lid_top_panel_6) {
    mesh_lid_top_panel_6.position.copy(endpoint_lid_top_panel_6.midpoint);
    mesh_lid_top_panel_6.quaternion.copy(endpoint_lid_top_panel_6.quaternion);
  }
  mesh_lid_top_panel_6.castShadow = options.castShadow ?? true;
  mesh_lid_top_panel_6.receiveShadow = options.receiveShadow ?? true;
  mesh_lid_top_panel_6.userData.sculptComponent = {"id": "lid-top-panel", "name": "Lid top panel", "level": "macro", "role": "lid-facet", "importance": 0.85, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The top of the lid is a flat quad noticeably smaller than the footprint, ringed by a bright narrow chamfer where the sloped facets meet it.", "geometryDescriptor": {"topologyIntent": "flat top plate closing the frustum with a bright top chamfer", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 1}, "profile2D": {"points": [[-0.41, -0.33], [0.41, -0.33], [0.44, -0.3], [0.44, 0.3], [0.41, 0.33], [-0.41, 0.33], [-0.44, 0.3], [-0.44, -0.3]], "depth": 0.057}, "deformationStack": [], "uvStrategy": "extrude cap UVs", "normalStrategy": "flat top face, chamfered rim"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "slope-front-mount", "contactType": "surface-mount", "localStart": [0.0, -0.418, 0.173], "localEnd": [0.0, -0.418, 0.173], "contactNormal": [0.0, 1.0, 0.0], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Top panel overlaps the upper edge of all four facets.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.88, "height": 0.057, "depth": 0.66, "units": "relative", "confidence": 0.65}, "transform": {"position": [0.0, -0.418, 0.173], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-lid-facet", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "lid-lacquer", "materialLayers": ["lid-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(85, 39, 143, 1.0)", "secondaryAlbedo": "rgba(168, 98, 220, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer, brighter violet than the body shell", "colorGradient": {"type": "linear", "axis": [0.3, -0.95], "stops": [{"offset": 0.0, "color": "rgba(168, 98, 220, 1.0)"}, {"offset": 0.34, "color": "rgba(123, 63, 176, 1.0)"}, {"offset": 0.7, "color": "rgba(85, 39, 143, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["lid-taper", "full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "lid-top-chamfer", "kind": "bevel", "description": "Bright narrow chamfer band around the top face.", "evidenceRefs": ["lid-taper"]}, {"id": "lid-top-gloss", "kind": "gloss", "description": "Large soft highlight on the top face, brightest of the painted surfaces.", "evidenceRefs": ["lid-taper"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["lid-taper"], "details": [], "fidelityTier": "blockout"};
  node_lid_top_panel_6.add(mesh_lid_top_panel_6);
  meshes["lid-top-panel"] = mesh_lid_top_panel_6;
  colliders["lid-top-panel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-lid-facet"] ??= [];
  destructionGroups["chest-lid-facet"].push(node_lid_top_panel_6);

  const attachment_body_plinth_7 = {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.0, 0.0], "contactNormal": [0.0, -1.0, 0.0], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Plinth band wraps the bottom of the wall with 0.025 overlap.", "evidenceRefs": ["full-object"]};
  const endpoint_body_plinth_7 = makeAttachmentEndpoint(attachment_body_plinth_7);
  const node_body_plinth_7 = new THREE.Group();
  node_body_plinth_7.name = "Base plinth band__pivot";
  node_body_plinth_7.scale.set(1, 1, 1);
  if (endpoint_body_plinth_7) {
    node_body_plinth_7.position.copy(endpoint_body_plinth_7.start);
    node_body_plinth_7.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_body_plinth_7.position.set(0.0, 0.0, 0.0);
    node_body_plinth_7.rotation.set(-0.0, 0.0, -0.0);
  }
  node_body_plinth_7.userData.sculptComponent = {"id": "body-plinth", "name": "Base plinth band", "level": "meso", "role": "plinth", "importance": 0.6, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A wider band stands proud at the bottom of the body and reads as a plinth, separated from the wall by a horizontal groove.", "geometryDescriptor": {"topologyIntent": "wider chamfered base band with a groove above it", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 1}, "profile2D": {"points": [[-0.47, -0.37], [0.47, -0.37], [0.5, -0.34], [0.5, 0.34], [0.47, 0.37], [-0.47, 0.37], [-0.5, 0.34], [-0.5, -0.34]], "depth": 0.1}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "flat faces, hard chamfer creases"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.0, 0.0], "contactNormal": [0.0, -1.0, 0.0], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Plinth band wraps the bottom of the wall with 0.025 overlap.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 0.1, "depth": 0.74, "units": "relative", "confidence": 0.7}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-plinth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "plinth-step-groove", "kind": "groove", "description": "Horizontal groove where the plinth band steps back into the wall.", "evidenceRefs": ["plinth-base"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["plinth-base", "full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_body_plinth_7.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-plinth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_body_plinth_7);
  nodes["body-plinth"] = node_body_plinth_7;
  const mesh_body_plinth_7Geometry = endpoint_body_plinth_7
    ? new THREE.CylinderGeometry(endpoint_body_plinth_7.endRadius, endpoint_body_plinth_7.baseRadius, endpoint_body_plinth_7.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.47, -0.37], [0.47, -0.37], [0.5, -0.34], [0.5, 0.34], [0.47, 0.37], [-0.47, 0.37], [-0.5, 0.34], [-0.5, -0.34]], "depth": 0.1});
  if (!endpoint_body_plinth_7) {
    mesh_body_plinth_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_body_plinth_7 = new THREE.Mesh(
    mesh_body_plinth_7Geometry,
    materialMap["shell-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_plinth_7.name = "Base plinth band";
  if (endpoint_body_plinth_7) {
    mesh_body_plinth_7.position.copy(endpoint_body_plinth_7.midpoint);
    mesh_body_plinth_7.quaternion.copy(endpoint_body_plinth_7.quaternion);
  }
  mesh_body_plinth_7.castShadow = options.castShadow ?? true;
  mesh_body_plinth_7.receiveShadow = options.receiveShadow ?? true;
  mesh_body_plinth_7.userData.sculptComponent = {"id": "body-plinth", "name": "Base plinth band", "level": "meso", "role": "plinth", "importance": 0.6, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A wider band stands proud at the bottom of the body and reads as a plinth, separated from the wall by a horizontal groove.", "geometryDescriptor": {"topologyIntent": "wider chamfered base band with a groove above it", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.03, "segments": 1}, "profile2D": {"points": [[-0.47, -0.37], [0.47, -0.37], [0.5, -0.34], [0.5, 0.34], [0.47, 0.37], [-0.47, 0.37], [-0.5, 0.34], [-0.5, -0.34]], "depth": 0.1}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "flat faces, hard chamfer creases"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.0, 0.0], "contactNormal": [0.0, -1.0, 0.0], "embedDepth": 0.025, "gapTolerance": 0.0, "note": "Plinth band wraps the bottom of the wall with 0.025 overlap.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 0.1, "depth": 0.74, "units": "relative", "confidence": 0.7}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-plinth", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "plinth-step-groove", "kind": "groove", "description": "Horizontal groove where the plinth band steps back into the wall.", "evidenceRefs": ["plinth-base"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["plinth-base", "full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_body_plinth_7.add(mesh_body_plinth_7);
  meshes["body-plinth"] = mesh_body_plinth_7;
  colliders["body-plinth"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-plinth"] ??= [];
  destructionGroups["chest-plinth"].push(node_body_plinth_7);

  const attachment_body_top_rail_8 = {"parentId": "body-shell", "parentSocket": "rail-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.531], "localEnd": [0.0, 0.0, 0.531], "contactNormal": [0.0, 1.0, 0.0], "embedDepth": 0.02, "gapTolerance": 0.0, "note": "Rail overlaps the wall top by 0.02.", "evidenceRefs": ["full-object"]};
  const endpoint_body_top_rail_8 = makeAttachmentEndpoint(attachment_body_top_rail_8);
  const node_body_top_rail_8 = new THREE.Group();
  node_body_top_rail_8.name = "Body top rail__pivot";
  node_body_top_rail_8.scale.set(1, 1, 1);
  if (endpoint_body_top_rail_8) {
    node_body_top_rail_8.position.copy(endpoint_body_top_rail_8.start);
    node_body_top_rail_8.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_body_top_rail_8.position.set(0.0, 0.0, 0.531);
    node_body_top_rail_8.rotation.set(-0.0, 0.0, -0.0);
  }
  node_body_top_rail_8.userData.sculptComponent = {"id": "body-top-rail", "name": "Body top rail", "level": "meso", "role": "rail", "importance": 0.55, "confidence": 0.65, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A slightly proud band runs around the top of the body wall, visible as a horizontal groove-and-step just below the lid seam.", "geometryDescriptor": {"topologyIntent": "chamfered rail closing the top of the body under the lid seam", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.028, "segments": 1}, "profile2D": {"points": [[-0.4695, -0.3675], [0.4695, -0.3675], [0.4975, -0.3395], [0.4975, 0.3395], [0.4695, 0.3675], [-0.4695, 0.3675], [-0.4975, 0.3395], [-0.4975, -0.3395]], "depth": 0.062}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "flat faces, hard chamfer creases"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "rail-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.531], "localEnd": [0.0, 0.0, 0.531], "contactNormal": [0.0, 1.0, 0.0], "embedDepth": 0.02, "gapTolerance": 0.0, "note": "Rail overlaps the wall top by 0.02.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.995, "height": 0.062, "depth": 0.735, "units": "relative", "confidence": 0.65}, "transform": {"position": [0.0, 0.0, 0.531], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-rail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rail-step-groove", "kind": "groove", "description": "Groove between wall and top rail.", "evidenceRefs": ["front-face"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["front-face", "full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_body_top_rail_8.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-rail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_body_top_rail_8);
  nodes["body-top-rail"] = node_body_top_rail_8;
  const mesh_body_top_rail_8Geometry = endpoint_body_top_rail_8
    ? new THREE.CylinderGeometry(endpoint_body_top_rail_8.endRadius, endpoint_body_top_rail_8.baseRadius, endpoint_body_top_rail_8.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.4695, -0.3675], [0.4695, -0.3675], [0.4975, -0.3395], [0.4975, 0.3395], [0.4695, 0.3675], [-0.4695, 0.3675], [-0.4975, 0.3395], [-0.4975, -0.3395]], "depth": 0.062});
  if (!endpoint_body_top_rail_8) {
    mesh_body_top_rail_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_body_top_rail_8 = new THREE.Mesh(
    mesh_body_top_rail_8Geometry,
    materialMap["shell-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_top_rail_8.name = "Body top rail";
  if (endpoint_body_top_rail_8) {
    mesh_body_top_rail_8.position.copy(endpoint_body_top_rail_8.midpoint);
    mesh_body_top_rail_8.quaternion.copy(endpoint_body_top_rail_8.quaternion);
  }
  mesh_body_top_rail_8.castShadow = options.castShadow ?? true;
  mesh_body_top_rail_8.receiveShadow = options.receiveShadow ?? true;
  mesh_body_top_rail_8.userData.sculptComponent = {"id": "body-top-rail", "name": "Body top rail", "level": "meso", "role": "rail", "importance": 0.55, "confidence": 0.65, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A slightly proud band runs around the top of the body wall, visible as a horizontal groove-and-step just below the lid seam.", "geometryDescriptor": {"topologyIntent": "chamfered rail closing the top of the body under the lid seam", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.028, "segments": 1}, "profile2D": {"points": [[-0.4695, -0.3675], [0.4695, -0.3675], [0.4975, -0.3395], [0.4975, 0.3395], [0.4695, 0.3675], [-0.4695, 0.3675], [-0.4975, 0.3395], [-0.4975, -0.3395]], "depth": 0.062}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "flat faces, hard chamfer creases"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "rail-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.531], "localEnd": [0.0, 0.0, 0.531], "contactNormal": [0.0, 1.0, 0.0], "embedDepth": 0.02, "gapTolerance": 0.0, "note": "Rail overlaps the wall top by 0.02.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.995, "height": 0.062, "depth": 0.735, "units": "relative", "confidence": 0.65}, "transform": {"position": [0.0, 0.0, 0.531], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-rail", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rail-step-groove", "kind": "groove", "description": "Groove between wall and top rail.", "evidenceRefs": ["front-face"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["front-face", "full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_body_top_rail_8.add(mesh_body_top_rail_8);
  meshes["body-top-rail"] = mesh_body_top_rail_8;
  colliders["body-top-rail"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-rail"] ??= [];
  destructionGroups["chest-rail"].push(node_body_top_rail_8);

  const attachment_seam_shim_9 = {"parentId": "body-shell", "parentSocket": "rail-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.593], "localEnd": [0.0, 0.0, 0.593], "contactNormal": [0.0, 1.0, 0.0], "embedDepth": 0.02, "gapTolerance": 0.0, "note": "Shim is inset behind the rail so only its shadowed band is visible.", "evidenceRefs": ["full-object"]};
  const endpoint_seam_shim_9 = makeAttachmentEndpoint(attachment_seam_shim_9);
  const node_seam_shim_9 = new THREE.Group();
  node_seam_shim_9.name = "Lid seam shadow shim__pivot";
  node_seam_shim_9.scale.set(1, 1, 1);
  if (endpoint_seam_shim_9) {
    node_seam_shim_9.position.copy(endpoint_seam_shim_9.start);
    node_seam_shim_9.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_seam_shim_9.position.set(0.0, 0.0, 0.589);
    node_seam_shim_9.rotation.set(-0.0, 0.0, -0.0);
  }
  node_seam_shim_9.userData.sculptComponent = {"id": "seam-shim", "name": "Lid seam shadow shim", "level": "meso", "role": "seam", "importance": 0.5, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The gap between lid and body reads as an unlit recessed band; a thin inset dark solid reproduces it without faking a shadow in albedo.", "geometryDescriptor": {"topologyIntent": "thin dark band filling the gap between body rail and lid rim", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "profile2D": {"points": [[-0.4525, -0.3425], [0.4525, -0.3425], [0.4725, -0.3225], [0.4725, 0.3225], [0.4525, 0.3425], [-0.4525, 0.3425], [-0.4725, 0.3225], [-0.4725, -0.3225]], "depth": 0.01}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "flat faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "rail-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.593], "localEnd": [0.0, 0.0, 0.593], "contactNormal": [0.0, 1.0, 0.0], "embedDepth": 0.02, "gapTolerance": 0.0, "note": "Shim is inset behind the rail so only its shadowed band is visible.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.945, "height": 0.01, "depth": 0.685, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.0, 0.0, 0.589], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-seam", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "seam-shadow", "materialLayers": ["seam-shadow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(22, 20, 40, 1.0)", "secondaryAlbedo": "rgba(46, 42, 74, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.5, "finish": "unlit gap between lid and body, reads as pure shadow", "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "evidenceRefs": ["full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "seam-shadow-line", "kind": "seam", "description": "Dark recessed line separating lid from body along the whole perimeter.", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_seam_shim_9.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-seam", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_seam_shim_9);
  nodes["seam-shim"] = node_seam_shim_9;
  const mesh_seam_shim_9Geometry = endpoint_seam_shim_9
    ? new THREE.CylinderGeometry(endpoint_seam_shim_9.endRadius, endpoint_seam_shim_9.baseRadius, endpoint_seam_shim_9.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.4525, -0.3425], [0.4525, -0.3425], [0.4725, -0.3225], [0.4725, 0.3225], [0.4525, 0.3425], [-0.4525, 0.3425], [-0.4725, 0.3225], [-0.4725, -0.3225]], "depth": 0.01});
  if (!endpoint_seam_shim_9) {
    mesh_seam_shim_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_seam_shim_9 = new THREE.Mesh(
    mesh_seam_shim_9Geometry,
    materialMap["seam-shadow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_seam_shim_9.name = "Lid seam shadow shim";
  if (endpoint_seam_shim_9) {
    mesh_seam_shim_9.position.copy(endpoint_seam_shim_9.midpoint);
    mesh_seam_shim_9.quaternion.copy(endpoint_seam_shim_9.quaternion);
  }
  mesh_seam_shim_9.castShadow = options.castShadow ?? true;
  mesh_seam_shim_9.receiveShadow = options.receiveShadow ?? true;
  mesh_seam_shim_9.userData.sculptComponent = {"id": "seam-shim", "name": "Lid seam shadow shim", "level": "meso", "role": "seam", "importance": 0.5, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The gap between lid and body reads as an unlit recessed band; a thin inset dark solid reproduces it without faking a shadow in albedo.", "geometryDescriptor": {"topologyIntent": "thin dark band filling the gap between body rail and lid rim", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "profile2D": {"points": [[-0.4525, -0.3425], [0.4525, -0.3425], [0.4725, -0.3225], [0.4725, 0.3225], [0.4525, 0.3425], [-0.4525, 0.3425], [-0.4725, 0.3225], [-0.4725, -0.3225]], "depth": 0.01}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "flat faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "rail-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.593], "localEnd": [0.0, 0.0, 0.593], "contactNormal": [0.0, 1.0, 0.0], "embedDepth": 0.02, "gapTolerance": 0.0, "note": "Shim is inset behind the rail so only its shadowed band is visible.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.945, "height": 0.01, "depth": 0.685, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.0, 0.0, 0.589], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-seam", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "seam-shadow", "materialLayers": ["seam-shadow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(22, 20, 40, 1.0)", "secondaryAlbedo": "rgba(46, 42, 74, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.5, "finish": "unlit gap between lid and body, reads as pure shadow", "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "evidenceRefs": ["full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "seam-shadow-line", "kind": "seam", "description": "Dark recessed line separating lid from body along the whole perimeter.", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_seam_shim_9.add(mesh_seam_shim_9);
  meshes["seam-shim"] = mesh_seam_shim_9;
  colliders["seam-shim"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-seam"] ??= [];
  destructionGroups["chest-seam"].push(node_seam_shim_9);

  const attachment_body_front_panel_10 = {"parentId": "body-shell", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, -0.3575, 0.335], "localEnd": [0.0, -0.3575, 0.335], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.013, "gapTolerance": 0.0, "note": "Plate is embedded 0.013 into the wall so no gap can open at the border.", "evidenceRefs": ["full-object"]};
  const endpoint_body_front_panel_10 = makeAttachmentEndpoint(attachment_body_front_panel_10);
  const node_body_front_panel_10 = new THREE.Group();
  node_body_front_panel_10.name = "Body front panel plate__pivot";
  node_body_front_panel_10.scale.set(1, 1, 1);
  if (endpoint_body_front_panel_10) {
    node_body_front_panel_10.position.copy(endpoint_body_front_panel_10.start);
    node_body_front_panel_10.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_body_front_panel_10.position.set(0.0, -0.3575, 0.335);
    node_body_front_panel_10.rotation.set(1.570796, 0.0, -0.0);
  }
  node_body_front_panel_10.userData.sculptComponent = {"id": "body-front-panel", "name": "Body front panel plate", "level": "meso", "role": "panel", "importance": 0.65, "confidence": 0.6, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Each wall carries a rectangular plate inset from the corners, read from the groove lines that frame the front face and the pilaster strips at its sides.", "geometryDescriptor": {"topologyIntent": "shallow proud plate framed by grooves", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.008, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat plate faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, -0.3575, 0.335], "localEnd": [0.0, -0.3575, 0.335], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.013, "gapTolerance": 0.0, "note": "Plate is embedded 0.013 into the wall so no gap can open at the border.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.78, "height": 0.4, "depth": 0.026, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.0, -0.3575, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "front-panel-inset-groove", "kind": "groove", "description": "Groove framing the central plate on the front wall.", "evidenceRefs": ["front-face"]}, {"id": "panel-edge-bevel", "kind": "bevel", "description": "Bright bevel along the plate border.", "evidenceRefs": ["front-face"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["front-face"], "details": [], "fidelityTier": "form-refinement"};
  node_body_front_panel_10.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_body_front_panel_10);
  nodes["body-front-panel"] = node_body_front_panel_10;
  const mesh_body_front_panel_10Geometry = endpoint_body_front_panel_10
    ? new THREE.CylinderGeometry(endpoint_body_front_panel_10.endRadius, endpoint_body_front_panel_10.baseRadius, endpoint_body_front_panel_10.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_body_front_panel_10) {
    mesh_body_front_panel_10Geometry.scale(0.78, 0.4, 0.026);
  }
  const mesh_body_front_panel_10 = new THREE.Mesh(
    mesh_body_front_panel_10Geometry,
    materialMap["shell-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_front_panel_10.name = "Body front panel plate";
  if (endpoint_body_front_panel_10) {
    mesh_body_front_panel_10.position.copy(endpoint_body_front_panel_10.midpoint);
    mesh_body_front_panel_10.quaternion.copy(endpoint_body_front_panel_10.quaternion);
  }
  mesh_body_front_panel_10.castShadow = options.castShadow ?? true;
  mesh_body_front_panel_10.receiveShadow = options.receiveShadow ?? true;
  mesh_body_front_panel_10.userData.sculptComponent = {"id": "body-front-panel", "name": "Body front panel plate", "level": "meso", "role": "panel", "importance": 0.65, "confidence": 0.6, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Each wall carries a rectangular plate inset from the corners, read from the groove lines that frame the front face and the pilaster strips at its sides.", "geometryDescriptor": {"topologyIntent": "shallow proud plate framed by grooves", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.008, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat plate faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, -0.3575, 0.335], "localEnd": [0.0, -0.3575, 0.335], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.013, "gapTolerance": 0.0, "note": "Plate is embedded 0.013 into the wall so no gap can open at the border.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.78, "height": 0.4, "depth": 0.026, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.0, -0.3575, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "front-panel-inset-groove", "kind": "groove", "description": "Groove framing the central plate on the front wall.", "evidenceRefs": ["front-face"]}, {"id": "panel-edge-bevel", "kind": "bevel", "description": "Bright bevel along the plate border.", "evidenceRefs": ["front-face"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["front-face"], "details": [], "fidelityTier": "form-refinement"};
  node_body_front_panel_10.add(mesh_body_front_panel_10);
  meshes["body-front-panel"] = mesh_body_front_panel_10;
  colliders["body-front-panel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-panel"] ??= [];
  destructionGroups["chest-panel"].push(node_body_front_panel_10);

  const attachment_body_rear_panel_11 = {"parentId": "body-shell", "parentSocket": "rear-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.3575, 0.335], "localEnd": [0.0, 0.3575, 0.335], "contactNormal": [0.0, 0.0, -1.0], "embedDepth": 0.013, "gapTolerance": 0.0, "note": "Plate is embedded 0.013 into the wall so no gap can open at the border.", "evidenceRefs": ["full-object"]};
  const endpoint_body_rear_panel_11 = makeAttachmentEndpoint(attachment_body_rear_panel_11);
  const node_body_rear_panel_11 = new THREE.Group();
  node_body_rear_panel_11.name = "Body rear panel plate__pivot";
  node_body_rear_panel_11.scale.set(1, 1, 1);
  if (endpoint_body_rear_panel_11) {
    node_body_rear_panel_11.position.copy(endpoint_body_rear_panel_11.start);
    node_body_rear_panel_11.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_body_rear_panel_11.position.set(0.0, 0.3575, 0.335);
    node_body_rear_panel_11.rotation.set(1.570796, 0.0, -0.0);
  }
  node_body_rear_panel_11.userData.sculptComponent = {"id": "body-rear-panel", "name": "Body rear panel plate", "level": "meso", "role": "panel", "importance": 0.4, "confidence": 0.45, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Each wall carries a rectangular plate inset from the corners, read from the groove lines that frame the front face and the pilaster strips at its sides.", "geometryDescriptor": {"topologyIntent": "shallow proud plate framed by grooves", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.008, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat plate faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "rear-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.3575, 0.335], "localEnd": [0.0, 0.3575, 0.335], "contactNormal": [0.0, 0.0, -1.0], "embedDepth": 0.013, "gapTolerance": 0.0, "note": "Plate is embedded 0.013 into the wall so no gap can open at the border.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.78, "height": 0.4, "depth": 0.026, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.0, 0.3575, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_body_rear_panel_11.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_body_rear_panel_11);
  nodes["body-rear-panel"] = node_body_rear_panel_11;
  const mesh_body_rear_panel_11Geometry = endpoint_body_rear_panel_11
    ? new THREE.CylinderGeometry(endpoint_body_rear_panel_11.endRadius, endpoint_body_rear_panel_11.baseRadius, endpoint_body_rear_panel_11.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_body_rear_panel_11) {
    mesh_body_rear_panel_11Geometry.scale(0.78, 0.4, 0.026);
  }
  const mesh_body_rear_panel_11 = new THREE.Mesh(
    mesh_body_rear_panel_11Geometry,
    materialMap["shell-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_rear_panel_11.name = "Body rear panel plate";
  if (endpoint_body_rear_panel_11) {
    mesh_body_rear_panel_11.position.copy(endpoint_body_rear_panel_11.midpoint);
    mesh_body_rear_panel_11.quaternion.copy(endpoint_body_rear_panel_11.quaternion);
  }
  mesh_body_rear_panel_11.castShadow = options.castShadow ?? true;
  mesh_body_rear_panel_11.receiveShadow = options.receiveShadow ?? true;
  mesh_body_rear_panel_11.userData.sculptComponent = {"id": "body-rear-panel", "name": "Body rear panel plate", "level": "meso", "role": "panel", "importance": 0.4, "confidence": 0.45, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Each wall carries a rectangular plate inset from the corners, read from the groove lines that frame the front face and the pilaster strips at its sides.", "geometryDescriptor": {"topologyIntent": "shallow proud plate framed by grooves", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.008, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat plate faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "rear-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.3575, 0.335], "localEnd": [0.0, 0.3575, 0.335], "contactNormal": [0.0, 0.0, -1.0], "embedDepth": 0.013, "gapTolerance": 0.0, "note": "Plate is embedded 0.013 into the wall so no gap can open at the border.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.78, "height": 0.4, "depth": 0.026, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.0, 0.3575, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_body_rear_panel_11.add(mesh_body_rear_panel_11);
  meshes["body-rear-panel"] = mesh_body_rear_panel_11;
  colliders["body-rear-panel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-panel"] ??= [];
  destructionGroups["chest-panel"].push(node_body_rear_panel_11);

  const attachment_body_left_panel_12 = {"parentId": "body-shell", "parentSocket": "left-panel-mount", "contactType": "surface-mount", "localStart": [-0.4875, 0.0, 0.335], "localEnd": [-0.4875, 0.0, 0.335], "contactNormal": [-1.0, 0.0, 0.0], "embedDepth": 0.013, "gapTolerance": 0.0, "note": "Plate is embedded 0.013 into the wall so no gap can open at the border.", "evidenceRefs": ["full-object"]};
  const endpoint_body_left_panel_12 = makeAttachmentEndpoint(attachment_body_left_panel_12);
  const node_body_left_panel_12 = new THREE.Group();
  node_body_left_panel_12.name = "Body left panel plate__pivot";
  node_body_left_panel_12.scale.set(1, 1, 1);
  if (endpoint_body_left_panel_12) {
    node_body_left_panel_12.position.copy(endpoint_body_left_panel_12.start);
    node_body_left_panel_12.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_body_left_panel_12.position.set(-0.4875, 0.0, 0.335);
    node_body_left_panel_12.rotation.set(1.570796, 0.0, -0.0);
  }
  node_body_left_panel_12.userData.sculptComponent = {"id": "body-left-panel", "name": "Body left panel plate", "level": "meso", "role": "panel", "importance": 0.4, "confidence": 0.45, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Each wall carries a rectangular plate inset from the corners, read from the groove lines that frame the front face and the pilaster strips at its sides.", "geometryDescriptor": {"topologyIntent": "shallow proud plate framed by grooves", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.008, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat plate faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "left-panel-mount", "contactType": "surface-mount", "localStart": [-0.4875, 0.0, 0.335], "localEnd": [-0.4875, 0.0, 0.335], "contactNormal": [-1.0, 0.0, 0.0], "embedDepth": 0.013, "gapTolerance": 0.0, "note": "Plate is embedded 0.013 into the wall so no gap can open at the border.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.026, "height": 0.4, "depth": 0.5, "units": "relative", "confidence": 0.6}, "transform": {"position": [-0.4875, 0.0, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_body_left_panel_12.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_body_left_panel_12);
  nodes["body-left-panel"] = node_body_left_panel_12;
  const mesh_body_left_panel_12Geometry = endpoint_body_left_panel_12
    ? new THREE.CylinderGeometry(endpoint_body_left_panel_12.endRadius, endpoint_body_left_panel_12.baseRadius, endpoint_body_left_panel_12.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_body_left_panel_12) {
    mesh_body_left_panel_12Geometry.scale(0.026, 0.4, 0.5);
  }
  const mesh_body_left_panel_12 = new THREE.Mesh(
    mesh_body_left_panel_12Geometry,
    materialMap["shell-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_left_panel_12.name = "Body left panel plate";
  if (endpoint_body_left_panel_12) {
    mesh_body_left_panel_12.position.copy(endpoint_body_left_panel_12.midpoint);
    mesh_body_left_panel_12.quaternion.copy(endpoint_body_left_panel_12.quaternion);
  }
  mesh_body_left_panel_12.castShadow = options.castShadow ?? true;
  mesh_body_left_panel_12.receiveShadow = options.receiveShadow ?? true;
  mesh_body_left_panel_12.userData.sculptComponent = {"id": "body-left-panel", "name": "Body left panel plate", "level": "meso", "role": "panel", "importance": 0.4, "confidence": 0.45, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Each wall carries a rectangular plate inset from the corners, read from the groove lines that frame the front face and the pilaster strips at its sides.", "geometryDescriptor": {"topologyIntent": "shallow proud plate framed by grooves", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.008, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat plate faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "left-panel-mount", "contactType": "surface-mount", "localStart": [-0.4875, 0.0, 0.335], "localEnd": [-0.4875, 0.0, 0.335], "contactNormal": [-1.0, 0.0, 0.0], "embedDepth": 0.013, "gapTolerance": 0.0, "note": "Plate is embedded 0.013 into the wall so no gap can open at the border.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.026, "height": 0.4, "depth": 0.5, "units": "relative", "confidence": 0.6}, "transform": {"position": [-0.4875, 0.0, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_body_left_panel_12.add(mesh_body_left_panel_12);
  meshes["body-left-panel"] = mesh_body_left_panel_12;
  colliders["body-left-panel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-panel"] ??= [];
  destructionGroups["chest-panel"].push(node_body_left_panel_12);

  const attachment_body_right_panel_13 = {"parentId": "body-shell", "parentSocket": "right-panel-mount", "contactType": "surface-mount", "localStart": [0.4875, 0.0, 0.335], "localEnd": [0.4875, 0.0, 0.335], "contactNormal": [1.0, 0.0, 0.0], "embedDepth": 0.013, "gapTolerance": 0.0, "note": "Plate is embedded 0.013 into the wall so no gap can open at the border.", "evidenceRefs": ["full-object"]};
  const endpoint_body_right_panel_13 = makeAttachmentEndpoint(attachment_body_right_panel_13);
  const node_body_right_panel_13 = new THREE.Group();
  node_body_right_panel_13.name = "Body right panel plate__pivot";
  node_body_right_panel_13.scale.set(1, 1, 1);
  if (endpoint_body_right_panel_13) {
    node_body_right_panel_13.position.copy(endpoint_body_right_panel_13.start);
    node_body_right_panel_13.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_body_right_panel_13.position.set(0.4875, 0.0, 0.335);
    node_body_right_panel_13.rotation.set(1.570796, 0.0, -0.0);
  }
  node_body_right_panel_13.userData.sculptComponent = {"id": "body-right-panel", "name": "Body right panel plate", "level": "meso", "role": "panel", "importance": 0.4, "confidence": 0.45, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Each wall carries a rectangular plate inset from the corners, read from the groove lines that frame the front face and the pilaster strips at its sides.", "geometryDescriptor": {"topologyIntent": "shallow proud plate framed by grooves", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.008, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat plate faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "right-panel-mount", "contactType": "surface-mount", "localStart": [0.4875, 0.0, 0.335], "localEnd": [0.4875, 0.0, 0.335], "contactNormal": [1.0, 0.0, 0.0], "embedDepth": 0.013, "gapTolerance": 0.0, "note": "Plate is embedded 0.013 into the wall so no gap can open at the border.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.026, "height": 0.4, "depth": 0.5, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.4875, 0.0, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_body_right_panel_13.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_body_right_panel_13);
  nodes["body-right-panel"] = node_body_right_panel_13;
  const mesh_body_right_panel_13Geometry = endpoint_body_right_panel_13
    ? new THREE.CylinderGeometry(endpoint_body_right_panel_13.endRadius, endpoint_body_right_panel_13.baseRadius, endpoint_body_right_panel_13.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_body_right_panel_13) {
    mesh_body_right_panel_13Geometry.scale(0.026, 0.4, 0.5);
  }
  const mesh_body_right_panel_13 = new THREE.Mesh(
    mesh_body_right_panel_13Geometry,
    materialMap["shell-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_body_right_panel_13.name = "Body right panel plate";
  if (endpoint_body_right_panel_13) {
    mesh_body_right_panel_13.position.copy(endpoint_body_right_panel_13.midpoint);
    mesh_body_right_panel_13.quaternion.copy(endpoint_body_right_panel_13.quaternion);
  }
  mesh_body_right_panel_13.castShadow = options.castShadow ?? true;
  mesh_body_right_panel_13.receiveShadow = options.receiveShadow ?? true;
  mesh_body_right_panel_13.userData.sculptComponent = {"id": "body-right-panel", "name": "Body right panel plate", "level": "meso", "role": "panel", "importance": 0.4, "confidence": 0.45, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Each wall carries a rectangular plate inset from the corners, read from the groove lines that frame the front face and the pilaster strips at its sides.", "geometryDescriptor": {"topologyIntent": "shallow proud plate framed by grooves", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.008, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat plate faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "right-panel-mount", "contactType": "surface-mount", "localStart": [0.4875, 0.0, 0.335], "localEnd": [0.4875, 0.0, 0.335], "contactNormal": [1.0, 0.0, 0.0], "embedDepth": 0.013, "gapTolerance": 0.0, "note": "Plate is embedded 0.013 into the wall so no gap can open at the border.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.026, "height": 0.4, "depth": 0.5, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.4875, 0.0, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-panel", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "shell-lacquer", "materialLayers": ["shell-lacquer"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(1, 45, 80, 1.0)", "secondaryAlbedo": "rgba(2, 119, 106, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.6, "finish": "glossy lacquer over metal, clearcoat highlight", "colorGradient": {"type": "linear", "axis": [0.55, -0.84], "stops": [{"offset": 0.0, "color": "rgba(72, 45, 102, 1.0)"}, {"offset": 0.42, "color": "rgba(1, 45, 80, 1.0)"}, {"offset": 0.78, "color": "rgba(2, 119, 106, 1.0)"}, {"offset": 1.0, "color": "rgba(6, 14, 44, 1.0)"}]}, "evidenceRefs": ["full-object", "front-face"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_body_right_panel_13.add(mesh_body_right_panel_13);
  meshes["body-right-panel"] = mesh_body_right_panel_13;
  colliders["body-right-panel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-panel"] ??= [];
  destructionGroups["chest-panel"].push(node_body_right_panel_13);

  const attachment_panel_groove_front_14 = {"parentId": "body-shell", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, -0.3535, 0.335], "localEnd": [0.0, -0.3535, 0.335], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Mat is embedded into the wall and only its border ring stays visible.", "evidenceRefs": ["full-object"]};
  const endpoint_panel_groove_front_14 = makeAttachmentEndpoint(attachment_panel_groove_front_14);
  const node_panel_groove_front_14 = new THREE.Group();
  node_panel_groove_front_14.name = "Front panel groove mat__pivot";
  node_panel_groove_front_14.scale.set(1, 1, 1);
  if (endpoint_panel_groove_front_14) {
    node_panel_groove_front_14.position.copy(endpoint_panel_groove_front_14.start);
    node_panel_groove_front_14.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_panel_groove_front_14.position.set(0.0, -0.3535, 0.335);
    node_panel_groove_front_14.rotation.set(1.570796, 0.0, -0.0);
  }
  node_panel_groove_front_14.userData.sculptComponent = {"id": "panel-groove-front", "name": "Front panel groove mat", "level": "micro", "role": "groove", "importance": 0.35, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The reference frames each plate with a dark line; a slightly oversized dark mat behind the plate produces that line from geometry rather than from lighting.", "geometryDescriptor": {"topologyIntent": "thin dark mat framing the panel plate to draw the groove line", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, -0.3535, 0.335], "localEnd": [0.0, -0.3535, 0.335], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Mat is embedded into the wall and only its border ring stays visible.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.842, "height": 0.452, "depth": 0.018, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.3535, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "seam-shadow", "materialLayers": ["seam-shadow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(22, 20, 40, 1.0)", "secondaryAlbedo": "rgba(46, 42, 74, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.5, "finish": "unlit gap between lid and body, reads as pure shadow", "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "evidenceRefs": ["full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "front-panel-groove-line", "kind": "groove", "description": "Dark recessed line around the panel plate.", "evidenceRefs": ["front-face"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["front-face"], "details": [], "fidelityTier": "surface-pass"};
  node_panel_groove_front_14.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_panel_groove_front_14);
  nodes["panel-groove-front"] = node_panel_groove_front_14;
  const mesh_panel_groove_front_14Geometry = endpoint_panel_groove_front_14
    ? new THREE.CylinderGeometry(endpoint_panel_groove_front_14.endRadius, endpoint_panel_groove_front_14.baseRadius, endpoint_panel_groove_front_14.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_panel_groove_front_14) {
    mesh_panel_groove_front_14Geometry.scale(0.842, 0.452, 0.018);
  }
  const mesh_panel_groove_front_14 = new THREE.Mesh(
    mesh_panel_groove_front_14Geometry,
    materialMap["seam-shadow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_panel_groove_front_14.name = "Front panel groove mat";
  if (endpoint_panel_groove_front_14) {
    mesh_panel_groove_front_14.position.copy(endpoint_panel_groove_front_14.midpoint);
    mesh_panel_groove_front_14.quaternion.copy(endpoint_panel_groove_front_14.quaternion);
  }
  mesh_panel_groove_front_14.castShadow = options.castShadow ?? true;
  mesh_panel_groove_front_14.receiveShadow = options.receiveShadow ?? true;
  mesh_panel_groove_front_14.userData.sculptComponent = {"id": "panel-groove-front", "name": "Front panel groove mat", "level": "micro", "role": "groove", "importance": 0.35, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The reference frames each plate with a dark line; a slightly oversized dark mat behind the plate produces that line from geometry rather than from lighting.", "geometryDescriptor": {"topologyIntent": "thin dark mat framing the panel plate to draw the groove line", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, -0.3535, 0.335], "localEnd": [0.0, -0.3535, 0.335], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Mat is embedded into the wall and only its border ring stays visible.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.842, "height": 0.452, "depth": 0.018, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, -0.3535, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "seam-shadow", "materialLayers": ["seam-shadow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(22, 20, 40, 1.0)", "secondaryAlbedo": "rgba(46, 42, 74, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.5, "finish": "unlit gap between lid and body, reads as pure shadow", "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "evidenceRefs": ["full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "front-panel-groove-line", "kind": "groove", "description": "Dark recessed line around the panel plate.", "evidenceRefs": ["front-face"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["front-face"], "details": [], "fidelityTier": "surface-pass"};
  node_panel_groove_front_14.add(mesh_panel_groove_front_14);
  meshes["panel-groove-front"] = mesh_panel_groove_front_14;
  colliders["panel-groove-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-groove"] ??= [];
  destructionGroups["chest-groove"].push(node_panel_groove_front_14);

  const attachment_panel_groove_rear_15 = {"parentId": "body-shell", "parentSocket": "rear-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.3535, 0.335], "localEnd": [0.0, 0.3535, 0.335], "contactNormal": [0.0, 0.0, -1.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Mat is embedded into the wall and only its border ring stays visible.", "evidenceRefs": ["full-object"]};
  const endpoint_panel_groove_rear_15 = makeAttachmentEndpoint(attachment_panel_groove_rear_15);
  const node_panel_groove_rear_15 = new THREE.Group();
  node_panel_groove_rear_15.name = "Rear panel groove mat__pivot";
  node_panel_groove_rear_15.scale.set(1, 1, 1);
  if (endpoint_panel_groove_rear_15) {
    node_panel_groove_rear_15.position.copy(endpoint_panel_groove_rear_15.start);
    node_panel_groove_rear_15.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_panel_groove_rear_15.position.set(0.0, 0.3535, 0.335);
    node_panel_groove_rear_15.rotation.set(1.570796, 0.0, -0.0);
  }
  node_panel_groove_rear_15.userData.sculptComponent = {"id": "panel-groove-rear", "name": "Rear panel groove mat", "level": "micro", "role": "groove", "importance": 0.35, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The reference frames each plate with a dark line; a slightly oversized dark mat behind the plate produces that line from geometry rather than from lighting.", "geometryDescriptor": {"topologyIntent": "thin dark mat framing the panel plate to draw the groove line", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "rear-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.3535, 0.335], "localEnd": [0.0, 0.3535, 0.335], "contactNormal": [0.0, 0.0, -1.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Mat is embedded into the wall and only its border ring stays visible.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.842, "height": 0.452, "depth": 0.018, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.3535, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "seam-shadow", "materialLayers": ["seam-shadow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(22, 20, 40, 1.0)", "secondaryAlbedo": "rgba(46, 42, 74, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.5, "finish": "unlit gap between lid and body, reads as pure shadow", "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "evidenceRefs": ["full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rear-panel-groove-line", "kind": "groove", "description": "Dark recessed line around the panel plate.", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "surface-pass"};
  node_panel_groove_rear_15.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_panel_groove_rear_15);
  nodes["panel-groove-rear"] = node_panel_groove_rear_15;
  const mesh_panel_groove_rear_15Geometry = endpoint_panel_groove_rear_15
    ? new THREE.CylinderGeometry(endpoint_panel_groove_rear_15.endRadius, endpoint_panel_groove_rear_15.baseRadius, endpoint_panel_groove_rear_15.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_panel_groove_rear_15) {
    mesh_panel_groove_rear_15Geometry.scale(0.842, 0.452, 0.018);
  }
  const mesh_panel_groove_rear_15 = new THREE.Mesh(
    mesh_panel_groove_rear_15Geometry,
    materialMap["seam-shadow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_panel_groove_rear_15.name = "Rear panel groove mat";
  if (endpoint_panel_groove_rear_15) {
    mesh_panel_groove_rear_15.position.copy(endpoint_panel_groove_rear_15.midpoint);
    mesh_panel_groove_rear_15.quaternion.copy(endpoint_panel_groove_rear_15.quaternion);
  }
  mesh_panel_groove_rear_15.castShadow = options.castShadow ?? true;
  mesh_panel_groove_rear_15.receiveShadow = options.receiveShadow ?? true;
  mesh_panel_groove_rear_15.userData.sculptComponent = {"id": "panel-groove-rear", "name": "Rear panel groove mat", "level": "micro", "role": "groove", "importance": 0.35, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The reference frames each plate with a dark line; a slightly oversized dark mat behind the plate produces that line from geometry rather than from lighting.", "geometryDescriptor": {"topologyIntent": "thin dark mat framing the panel plate to draw the groove line", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "rear-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.3535, 0.335], "localEnd": [0.0, 0.3535, 0.335], "contactNormal": [0.0, 0.0, -1.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Mat is embedded into the wall and only its border ring stays visible.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.842, "height": 0.452, "depth": 0.018, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.0, 0.3535, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "seam-shadow", "materialLayers": ["seam-shadow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(22, 20, 40, 1.0)", "secondaryAlbedo": "rgba(46, 42, 74, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.5, "finish": "unlit gap between lid and body, reads as pure shadow", "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "evidenceRefs": ["full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rear-panel-groove-line", "kind": "groove", "description": "Dark recessed line around the panel plate.", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "surface-pass"};
  node_panel_groove_rear_15.add(mesh_panel_groove_rear_15);
  meshes["panel-groove-rear"] = mesh_panel_groove_rear_15;
  colliders["panel-groove-rear"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-groove"] ??= [];
  destructionGroups["chest-groove"].push(node_panel_groove_rear_15);

  const attachment_panel_groove_left_16 = {"parentId": "body-shell", "parentSocket": "left-panel-mount", "contactType": "surface-mount", "localStart": [-0.4835, 0.0, 0.335], "localEnd": [-0.4835, 0.0, 0.335], "contactNormal": [-1.0, 0.0, 0.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Mat is embedded into the wall and only its border ring stays visible.", "evidenceRefs": ["full-object"]};
  const endpoint_panel_groove_left_16 = makeAttachmentEndpoint(attachment_panel_groove_left_16);
  const node_panel_groove_left_16 = new THREE.Group();
  node_panel_groove_left_16.name = "Left panel groove mat__pivot";
  node_panel_groove_left_16.scale.set(1, 1, 1);
  if (endpoint_panel_groove_left_16) {
    node_panel_groove_left_16.position.copy(endpoint_panel_groove_left_16.start);
    node_panel_groove_left_16.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_panel_groove_left_16.position.set(-0.4835, 0.0, 0.335);
    node_panel_groove_left_16.rotation.set(1.570796, 0.0, -0.0);
  }
  node_panel_groove_left_16.userData.sculptComponent = {"id": "panel-groove-left", "name": "Left panel groove mat", "level": "micro", "role": "groove", "importance": 0.35, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The reference frames each plate with a dark line; a slightly oversized dark mat behind the plate produces that line from geometry rather than from lighting.", "geometryDescriptor": {"topologyIntent": "thin dark mat framing the panel plate to draw the groove line", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "left-panel-mount", "contactType": "surface-mount", "localStart": [-0.4835, 0.0, 0.335], "localEnd": [-0.4835, 0.0, 0.335], "contactNormal": [-1.0, 0.0, 0.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Mat is embedded into the wall and only its border ring stays visible.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.018, "height": 0.452, "depth": 0.548, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.4835, 0.0, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "seam-shadow", "materialLayers": ["seam-shadow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(22, 20, 40, 1.0)", "secondaryAlbedo": "rgba(46, 42, 74, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.5, "finish": "unlit gap between lid and body, reads as pure shadow", "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "evidenceRefs": ["full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "left-panel-groove-line", "kind": "groove", "description": "Dark recessed line around the panel plate.", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "surface-pass"};
  node_panel_groove_left_16.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_panel_groove_left_16);
  nodes["panel-groove-left"] = node_panel_groove_left_16;
  const mesh_panel_groove_left_16Geometry = endpoint_panel_groove_left_16
    ? new THREE.CylinderGeometry(endpoint_panel_groove_left_16.endRadius, endpoint_panel_groove_left_16.baseRadius, endpoint_panel_groove_left_16.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_panel_groove_left_16) {
    mesh_panel_groove_left_16Geometry.scale(0.018, 0.452, 0.548);
  }
  const mesh_panel_groove_left_16 = new THREE.Mesh(
    mesh_panel_groove_left_16Geometry,
    materialMap["seam-shadow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_panel_groove_left_16.name = "Left panel groove mat";
  if (endpoint_panel_groove_left_16) {
    mesh_panel_groove_left_16.position.copy(endpoint_panel_groove_left_16.midpoint);
    mesh_panel_groove_left_16.quaternion.copy(endpoint_panel_groove_left_16.quaternion);
  }
  mesh_panel_groove_left_16.castShadow = options.castShadow ?? true;
  mesh_panel_groove_left_16.receiveShadow = options.receiveShadow ?? true;
  mesh_panel_groove_left_16.userData.sculptComponent = {"id": "panel-groove-left", "name": "Left panel groove mat", "level": "micro", "role": "groove", "importance": 0.35, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The reference frames each plate with a dark line; a slightly oversized dark mat behind the plate produces that line from geometry rather than from lighting.", "geometryDescriptor": {"topologyIntent": "thin dark mat framing the panel plate to draw the groove line", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "left-panel-mount", "contactType": "surface-mount", "localStart": [-0.4835, 0.0, 0.335], "localEnd": [-0.4835, 0.0, 0.335], "contactNormal": [-1.0, 0.0, 0.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Mat is embedded into the wall and only its border ring stays visible.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.018, "height": 0.452, "depth": 0.548, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.4835, 0.0, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "seam-shadow", "materialLayers": ["seam-shadow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(22, 20, 40, 1.0)", "secondaryAlbedo": "rgba(46, 42, 74, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.5, "finish": "unlit gap between lid and body, reads as pure shadow", "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "evidenceRefs": ["full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "left-panel-groove-line", "kind": "groove", "description": "Dark recessed line around the panel plate.", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "surface-pass"};
  node_panel_groove_left_16.add(mesh_panel_groove_left_16);
  meshes["panel-groove-left"] = mesh_panel_groove_left_16;
  colliders["panel-groove-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-groove"] ??= [];
  destructionGroups["chest-groove"].push(node_panel_groove_left_16);

  const attachment_panel_groove_right_17 = {"parentId": "body-shell", "parentSocket": "right-panel-mount", "contactType": "surface-mount", "localStart": [0.4835, 0.0, 0.335], "localEnd": [0.4835, 0.0, 0.335], "contactNormal": [1.0, 0.0, 0.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Mat is embedded into the wall and only its border ring stays visible.", "evidenceRefs": ["full-object"]};
  const endpoint_panel_groove_right_17 = makeAttachmentEndpoint(attachment_panel_groove_right_17);
  const node_panel_groove_right_17 = new THREE.Group();
  node_panel_groove_right_17.name = "Right panel groove mat__pivot";
  node_panel_groove_right_17.scale.set(1, 1, 1);
  if (endpoint_panel_groove_right_17) {
    node_panel_groove_right_17.position.copy(endpoint_panel_groove_right_17.start);
    node_panel_groove_right_17.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_panel_groove_right_17.position.set(0.4835, 0.0, 0.335);
    node_panel_groove_right_17.rotation.set(1.570796, 0.0, -0.0);
  }
  node_panel_groove_right_17.userData.sculptComponent = {"id": "panel-groove-right", "name": "Right panel groove mat", "level": "micro", "role": "groove", "importance": 0.35, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The reference frames each plate with a dark line; a slightly oversized dark mat behind the plate produces that line from geometry rather than from lighting.", "geometryDescriptor": {"topologyIntent": "thin dark mat framing the panel plate to draw the groove line", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "right-panel-mount", "contactType": "surface-mount", "localStart": [0.4835, 0.0, 0.335], "localEnd": [0.4835, 0.0, 0.335], "contactNormal": [1.0, 0.0, 0.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Mat is embedded into the wall and only its border ring stays visible.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.018, "height": 0.452, "depth": 0.548, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.4835, 0.0, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "seam-shadow", "materialLayers": ["seam-shadow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(22, 20, 40, 1.0)", "secondaryAlbedo": "rgba(46, 42, 74, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.5, "finish": "unlit gap between lid and body, reads as pure shadow", "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "evidenceRefs": ["full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "right-panel-groove-line", "kind": "groove", "description": "Dark recessed line around the panel plate.", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "surface-pass"};
  node_panel_groove_right_17.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_panel_groove_right_17);
  nodes["panel-groove-right"] = node_panel_groove_right_17;
  const mesh_panel_groove_right_17Geometry = endpoint_panel_groove_right_17
    ? new THREE.CylinderGeometry(endpoint_panel_groove_right_17.endRadius, endpoint_panel_groove_right_17.baseRadius, endpoint_panel_groove_right_17.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_panel_groove_right_17) {
    mesh_panel_groove_right_17Geometry.scale(0.018, 0.452, 0.548);
  }
  const mesh_panel_groove_right_17 = new THREE.Mesh(
    mesh_panel_groove_right_17Geometry,
    materialMap["seam-shadow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_panel_groove_right_17.name = "Right panel groove mat";
  if (endpoint_panel_groove_right_17) {
    mesh_panel_groove_right_17.position.copy(endpoint_panel_groove_right_17.midpoint);
    mesh_panel_groove_right_17.quaternion.copy(endpoint_panel_groove_right_17.quaternion);
  }
  mesh_panel_groove_right_17.castShadow = options.castShadow ?? true;
  mesh_panel_groove_right_17.receiveShadow = options.receiveShadow ?? true;
  mesh_panel_groove_right_17.userData.sculptComponent = {"id": "panel-groove-right", "name": "Right panel groove mat", "level": "micro", "role": "groove", "importance": 0.35, "confidence": 0.55, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The reference frames each plate with a dark line; a slightly oversized dark mat behind the plate produces that line from geometry rather than from lighting.", "geometryDescriptor": {"topologyIntent": "thin dark mat framing the panel plate to draw the groove line", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat faces"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "right-panel-mount", "contactType": "surface-mount", "localStart": [0.4835, 0.0, 0.335], "localEnd": [0.4835, 0.0, 0.335], "contactNormal": [1.0, 0.0, 0.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Mat is embedded into the wall and only its border ring stays visible.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.018, "height": 0.452, "depth": 0.548, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.4835, 0.0, 0.335], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-groove", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "seam-shadow", "materialLayers": ["seam-shadow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(22, 20, 40, 1.0)", "secondaryAlbedo": "rgba(46, 42, 74, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.5, "finish": "unlit gap between lid and body, reads as pure shadow", "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "evidenceRefs": ["full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "right-panel-groove-line", "kind": "groove", "description": "Dark recessed line around the panel plate.", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "surface-pass"};
  node_panel_groove_right_17.add(mesh_panel_groove_right_17);
  meshes["panel-groove-right"] = mesh_panel_groove_right_17;
  colliders["panel-groove-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-groove"] ??= [];
  destructionGroups["chest-groove"].push(node_panel_groove_right_17);

  const attachment_cap_base_front_left_18 = {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [-0.3875, -0.27, 0.0], "localEnd": [-0.3875, -0.27, 0.0], "contactNormal": [-1.0, 0.0, 1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Cap wraps the corner and is embedded 0.03 into both walls.", "evidenceRefs": ["full-object"]};
  const endpoint_cap_base_front_left_18 = makeAttachmentEndpoint(attachment_cap_base_front_left_18);
  const node_cap_base_front_left_18 = new THREE.Group();
  node_cap_base_front_left_18.name = "Base corner cap front left__pivot";
  node_cap_base_front_left_18.scale.set(1, 1, 1);
  if (endpoint_cap_base_front_left_18) {
    node_cap_base_front_left_18.position.copy(endpoint_cap_base_front_left_18.start);
    node_cap_base_front_left_18.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_cap_base_front_left_18.position.set(-0.3875, -0.27, 0.0);
    node_cap_base_front_left_18.rotation.set(-0.0, 0.0, -0.0);
  }
  node_cap_base_front_left_18.userData.sculptComponent = {"id": "cap-base-front-left", "name": "Base corner cap front left", "level": "meso", "role": "cap", "importance": 0.7, "confidence": 0.65, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Cast gold corner piece wrapping two walls with a wide diagonal facet across the corner, standing proud of the paint.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement with a wide diagonal facet", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.014, "segments": 1}, "profile2D": {"points": [[-0.0175, -0.11], [0.1085, -0.11], [0.1225, -0.096], [0.1225, 0.096], [0.1085, 0.11], [-0.1085, 0.11], [-0.1225, 0.096], [-0.1225, -0.005]], "depth": 0.255}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [-0.3875, -0.27, 0.0], "localEnd": [-0.3875, -0.27, 0.0], "contactNormal": [-1.0, 0.0, 1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Cap wraps the corner and is embedded 0.03 into both walls.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.245, "height": 0.255, "depth": 0.22, "units": "relative", "confidence": 0.6}, "transform": {"position": [-0.3875, -0.27, 0.0], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-base-front-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-left", "seamRefs": [], "detachableFragments": ["rivet-base-front-left-x", "rivet-base-front-left-z"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cap-corner-facet", "kind": "bevel", "description": "Wide diagonal facet cutting the outer corner of the cap.", "evidenceRefs": ["corner-hardware"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "plinth-base"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_base_front_left_18.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-base-front-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-left", "seamRefs": [], "detachableFragments": ["rivet-base-front-left-x", "rivet-base-front-left-z"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}};
  (nodes["body-shell"] ?? root).add(node_cap_base_front_left_18);
  nodes["cap-base-front-left"] = node_cap_base_front_left_18;
  const mesh_cap_base_front_left_18Geometry = endpoint_cap_base_front_left_18
    ? new THREE.CylinderGeometry(endpoint_cap_base_front_left_18.endRadius, endpoint_cap_base_front_left_18.baseRadius, endpoint_cap_base_front_left_18.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.0175, -0.11], [0.1085, -0.11], [0.1225, -0.096], [0.1225, 0.096], [0.1085, 0.11], [-0.1085, 0.11], [-0.1225, 0.096], [-0.1225, -0.005]], "depth": 0.255});
  if (!endpoint_cap_base_front_left_18) {
    mesh_cap_base_front_left_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_base_front_left_18 = new THREE.Mesh(
    mesh_cap_base_front_left_18Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_base_front_left_18.name = "Base corner cap front left";
  if (endpoint_cap_base_front_left_18) {
    mesh_cap_base_front_left_18.position.copy(endpoint_cap_base_front_left_18.midpoint);
    mesh_cap_base_front_left_18.quaternion.copy(endpoint_cap_base_front_left_18.quaternion);
  }
  mesh_cap_base_front_left_18.castShadow = options.castShadow ?? true;
  mesh_cap_base_front_left_18.receiveShadow = options.receiveShadow ?? true;
  mesh_cap_base_front_left_18.userData.sculptComponent = {"id": "cap-base-front-left", "name": "Base corner cap front left", "level": "meso", "role": "cap", "importance": 0.7, "confidence": 0.65, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Cast gold corner piece wrapping two walls with a wide diagonal facet across the corner, standing proud of the paint.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement with a wide diagonal facet", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.014, "segments": 1}, "profile2D": {"points": [[-0.0175, -0.11], [0.1085, -0.11], [0.1225, -0.096], [0.1225, 0.096], [0.1085, 0.11], [-0.1085, 0.11], [-0.1225, 0.096], [-0.1225, -0.005]], "depth": 0.255}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [-0.3875, -0.27, 0.0], "localEnd": [-0.3875, -0.27, 0.0], "contactNormal": [-1.0, 0.0, 1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Cap wraps the corner and is embedded 0.03 into both walls.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.245, "height": 0.255, "depth": 0.22, "units": "relative", "confidence": 0.6}, "transform": {"position": [-0.3875, -0.27, 0.0], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-base-front-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-left", "seamRefs": [], "detachableFragments": ["rivet-base-front-left-x", "rivet-base-front-left-z"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cap-corner-facet", "kind": "bevel", "description": "Wide diagonal facet cutting the outer corner of the cap.", "evidenceRefs": ["corner-hardware"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "plinth-base"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_base_front_left_18.add(mesh_cap_base_front_left_18);
  meshes["cap-base-front-left"] = mesh_cap_base_front_left_18;
  colliders["cap-base-front-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["corner-hardware-base-front-left"] ??= [];
  destructionGroups["corner-hardware-base-front-left"].push(node_cap_base_front_left_18);
  const socket_cap_base_front_left_cap_base_front_left_rivet_mount_0 = new THREE.Object3D();
  socket_cap_base_front_left_cap_base_front_left_rivet_mount_0.name = "cap-base-front-left-rivet-mount";
  socket_cap_base_front_left_cap_base_front_left_rivet_mount_0.position.set(0.0, 0.0, 0.0);
  socket_cap_base_front_left_cap_base_front_left_rivet_mount_0.rotation.set(0.0, 0.0, 0.0);
  socket_cap_base_front_left_cap_base_front_left_rivet_mount_0.userData.socket = {"id": "cap-base-front-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_cap_base_front_left_18.add(socket_cap_base_front_left_cap_base_front_left_rivet_mount_0);
  sockets["cap-base-front-left:cap-base-front-left-rivet-mount"] = socket_cap_base_front_left_cap_base_front_left_rivet_mount_0;

  const attachment_cap_lid_front_left_19 = {"parentId": "lid-shell", "parentSocket": "cap-front-left-mount", "contactType": "surface-mount", "localStart": [-0.435, -0.7355, -0.048], "localEnd": [-0.435, -0.7355, -0.048], "contactNormal": [-1.0, 0.0, 1.0], "embedDepth": 0.035, "gapTolerance": 0.0, "note": "Cap wraps the lid corner, embedded into rim and both sloped facets.", "evidenceRefs": ["full-object"]};
  const endpoint_cap_lid_front_left_19 = makeAttachmentEndpoint(attachment_cap_lid_front_left_19);
  const node_cap_lid_front_left_19 = new THREE.Group();
  node_cap_lid_front_left_19.name = "Lid corner cap front left__pivot";
  node_cap_lid_front_left_19.scale.set(1, 1, 1);
  if (endpoint_cap_lid_front_left_19) {
    node_cap_lid_front_left_19.position.copy(endpoint_cap_lid_front_left_19.start);
    node_cap_lid_front_left_19.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_cap_lid_front_left_19.position.set(-0.435, -0.7355, -0.048);
    node_cap_lid_front_left_19.rotation.set(-0.0, 0.0, -0.0);
  }
  node_cap_lid_front_left_19.userData.sculptComponent = {"id": "cap-lid-front-left", "name": "Lid corner cap front left", "level": "meso", "role": "cap", "importance": 0.75, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid corners carry the largest gold pieces; they stand proud of the sloped facets and define the widest points of the upper silhouette.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement wrapping the lid taper", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.016, "segments": 1}, "profile2D": {"points": [[-0.013, -0.1125], [0.111, -0.1125], [0.125, -0.0985], [0.125, 0.0985], [0.111, 0.1125], [-0.111, 0.1125], [-0.125, 0.0985], [-0.125, -0.0005]], "depth": 0.093}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "cap-front-left-mount", "contactType": "surface-mount", "localStart": [-0.435, -0.7355, -0.048], "localEnd": [-0.435, -0.7355, -0.048], "contactNormal": [-1.0, 0.0, 1.0], "embedDepth": 0.035, "gapTolerance": 0.0, "note": "Cap wraps the lid corner, embedded into rim and both sloped facets.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.093, "depth": 0.225, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.435, -0.7355, -0.048], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-lid-front-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-left", "seamRefs": [], "detachableFragments": ["rivet-lid-front-left-x", "rivet-lid-front-left-z", "rivet-lid-front-left-top"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cap-top-facet", "kind": "bevel", "description": "Angled top facet where the cap meets the lid top plane.", "evidenceRefs": ["corner-hardware"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "lid-taper"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_lid_front_left_19.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-lid-front-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-left", "seamRefs": [], "detachableFragments": ["rivet-lid-front-left-x", "rivet-lid-front-left-z", "rivet-lid-front-left-top"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}};
  (nodes["lid-shell"] ?? root).add(node_cap_lid_front_left_19);
  nodes["cap-lid-front-left"] = node_cap_lid_front_left_19;
  const mesh_cap_lid_front_left_19Geometry = endpoint_cap_lid_front_left_19
    ? new THREE.CylinderGeometry(endpoint_cap_lid_front_left_19.endRadius, endpoint_cap_lid_front_left_19.baseRadius, endpoint_cap_lid_front_left_19.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.013, -0.1125], [0.111, -0.1125], [0.125, -0.0985], [0.125, 0.0985], [0.111, 0.1125], [-0.111, 0.1125], [-0.125, 0.0985], [-0.125, -0.0005]], "depth": 0.093});
  if (!endpoint_cap_lid_front_left_19) {
    mesh_cap_lid_front_left_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_lid_front_left_19 = new THREE.Mesh(
    mesh_cap_lid_front_left_19Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_lid_front_left_19.name = "Lid corner cap front left";
  if (endpoint_cap_lid_front_left_19) {
    mesh_cap_lid_front_left_19.position.copy(endpoint_cap_lid_front_left_19.midpoint);
    mesh_cap_lid_front_left_19.quaternion.copy(endpoint_cap_lid_front_left_19.quaternion);
  }
  mesh_cap_lid_front_left_19.castShadow = options.castShadow ?? true;
  mesh_cap_lid_front_left_19.receiveShadow = options.receiveShadow ?? true;
  mesh_cap_lid_front_left_19.userData.sculptComponent = {"id": "cap-lid-front-left", "name": "Lid corner cap front left", "level": "meso", "role": "cap", "importance": 0.75, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid corners carry the largest gold pieces; they stand proud of the sloped facets and define the widest points of the upper silhouette.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement wrapping the lid taper", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.016, "segments": 1}, "profile2D": {"points": [[-0.013, -0.1125], [0.111, -0.1125], [0.125, -0.0985], [0.125, 0.0985], [0.111, 0.1125], [-0.111, 0.1125], [-0.125, 0.0985], [-0.125, -0.0005]], "depth": 0.093}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "cap-front-left-mount", "contactType": "surface-mount", "localStart": [-0.435, -0.7355, -0.048], "localEnd": [-0.435, -0.7355, -0.048], "contactNormal": [-1.0, 0.0, 1.0], "embedDepth": 0.035, "gapTolerance": 0.0, "note": "Cap wraps the lid corner, embedded into rim and both sloped facets.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.093, "depth": 0.225, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.435, -0.7355, -0.048], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-lid-front-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-left", "seamRefs": [], "detachableFragments": ["rivet-lid-front-left-x", "rivet-lid-front-left-z", "rivet-lid-front-left-top"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cap-top-facet", "kind": "bevel", "description": "Angled top facet where the cap meets the lid top plane.", "evidenceRefs": ["corner-hardware"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "lid-taper"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_lid_front_left_19.add(mesh_cap_lid_front_left_19);
  meshes["cap-lid-front-left"] = mesh_cap_lid_front_left_19;
  colliders["cap-lid-front-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["corner-hardware-lid-front-left"] ??= [];
  destructionGroups["corner-hardware-lid-front-left"].push(node_cap_lid_front_left_19);
  const socket_cap_lid_front_left_cap_lid_front_left_rivet_mount_0 = new THREE.Object3D();
  socket_cap_lid_front_left_cap_lid_front_left_rivet_mount_0.name = "cap-lid-front-left-rivet-mount";
  socket_cap_lid_front_left_cap_lid_front_left_rivet_mount_0.position.set(0.0, 0.0, 0.0);
  socket_cap_lid_front_left_cap_lid_front_left_rivet_mount_0.rotation.set(0.0, 0.0, 0.0);
  socket_cap_lid_front_left_cap_lid_front_left_rivet_mount_0.userData.socket = {"id": "cap-lid-front-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_cap_lid_front_left_19.add(socket_cap_lid_front_left_cap_lid_front_left_rivet_mount_0);
  sockets["cap-lid-front-left:cap-lid-front-left-rivet-mount"] = socket_cap_lid_front_left_cap_lid_front_left_rivet_mount_0;

  const attachment_cap_base_rear_left_20 = {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [-0.3875, 0.27, -0.0], "localEnd": [-0.3875, 0.27, -0.0], "contactNormal": [-1.0, 0.0, -1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Cap wraps the corner and is embedded 0.03 into both walls.", "evidenceRefs": ["full-object"]};
  const endpoint_cap_base_rear_left_20 = makeAttachmentEndpoint(attachment_cap_base_rear_left_20);
  const node_cap_base_rear_left_20 = new THREE.Group();
  node_cap_base_rear_left_20.name = "Base corner cap rear left__pivot";
  node_cap_base_rear_left_20.scale.set(1, 1, 1);
  if (endpoint_cap_base_rear_left_20) {
    node_cap_base_rear_left_20.position.copy(endpoint_cap_base_rear_left_20.start);
    node_cap_base_rear_left_20.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_cap_base_rear_left_20.position.set(-0.3875, 0.27, -0.0);
    node_cap_base_rear_left_20.rotation.set(-0.0, 0.0, -0.0);
  }
  node_cap_base_rear_left_20.userData.sculptComponent = {"id": "cap-base-rear-left", "name": "Base corner cap rear left", "level": "meso", "role": "cap", "importance": 0.7, "confidence": 0.65, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Cast gold corner piece wrapping two walls with a wide diagonal facet across the corner, standing proud of the paint.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement with a wide diagonal facet", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.014, "segments": 1}, "profile2D": {"points": [[-0.1085, -0.11], [0.1085, -0.11], [0.1225, -0.096], [0.1225, 0.096], [0.1085, 0.11], [-0.0175, 0.11], [-0.1225, 0.005], [-0.1225, -0.096]], "depth": 0.255}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [-0.3875, 0.27, -0.0], "localEnd": [-0.3875, 0.27, -0.0], "contactNormal": [-1.0, 0.0, -1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Cap wraps the corner and is embedded 0.03 into both walls.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.245, "height": 0.255, "depth": 0.22, "units": "relative", "confidence": 0.6}, "transform": {"position": [-0.3875, 0.27, -0.0], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-base-rear-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-left", "seamRefs": [], "detachableFragments": ["rivet-base-rear-left-x", "rivet-base-rear-left-z"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "plinth-base"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_base_rear_left_20.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-base-rear-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-left", "seamRefs": [], "detachableFragments": ["rivet-base-rear-left-x", "rivet-base-rear-left-z"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}};
  (nodes["body-shell"] ?? root).add(node_cap_base_rear_left_20);
  nodes["cap-base-rear-left"] = node_cap_base_rear_left_20;
  const mesh_cap_base_rear_left_20Geometry = endpoint_cap_base_rear_left_20
    ? new THREE.CylinderGeometry(endpoint_cap_base_rear_left_20.endRadius, endpoint_cap_base_rear_left_20.baseRadius, endpoint_cap_base_rear_left_20.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.1085, -0.11], [0.1085, -0.11], [0.1225, -0.096], [0.1225, 0.096], [0.1085, 0.11], [-0.0175, 0.11], [-0.1225, 0.005], [-0.1225, -0.096]], "depth": 0.255});
  if (!endpoint_cap_base_rear_left_20) {
    mesh_cap_base_rear_left_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_base_rear_left_20 = new THREE.Mesh(
    mesh_cap_base_rear_left_20Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_base_rear_left_20.name = "Base corner cap rear left";
  if (endpoint_cap_base_rear_left_20) {
    mesh_cap_base_rear_left_20.position.copy(endpoint_cap_base_rear_left_20.midpoint);
    mesh_cap_base_rear_left_20.quaternion.copy(endpoint_cap_base_rear_left_20.quaternion);
  }
  mesh_cap_base_rear_left_20.castShadow = options.castShadow ?? true;
  mesh_cap_base_rear_left_20.receiveShadow = options.receiveShadow ?? true;
  mesh_cap_base_rear_left_20.userData.sculptComponent = {"id": "cap-base-rear-left", "name": "Base corner cap rear left", "level": "meso", "role": "cap", "importance": 0.7, "confidence": 0.65, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Cast gold corner piece wrapping two walls with a wide diagonal facet across the corner, standing proud of the paint.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement with a wide diagonal facet", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.014, "segments": 1}, "profile2D": {"points": [[-0.1085, -0.11], [0.1085, -0.11], [0.1225, -0.096], [0.1225, 0.096], [0.1085, 0.11], [-0.0175, 0.11], [-0.1225, 0.005], [-0.1225, -0.096]], "depth": 0.255}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [-0.3875, 0.27, -0.0], "localEnd": [-0.3875, 0.27, -0.0], "contactNormal": [-1.0, 0.0, -1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Cap wraps the corner and is embedded 0.03 into both walls.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.245, "height": 0.255, "depth": 0.22, "units": "relative", "confidence": 0.6}, "transform": {"position": [-0.3875, 0.27, -0.0], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-base-rear-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-left", "seamRefs": [], "detachableFragments": ["rivet-base-rear-left-x", "rivet-base-rear-left-z"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "plinth-base"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_base_rear_left_20.add(mesh_cap_base_rear_left_20);
  meshes["cap-base-rear-left"] = mesh_cap_base_rear_left_20;
  colliders["cap-base-rear-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["corner-hardware-base-rear-left"] ??= [];
  destructionGroups["corner-hardware-base-rear-left"].push(node_cap_base_rear_left_20);
  const socket_cap_base_rear_left_cap_base_rear_left_rivet_mount_0 = new THREE.Object3D();
  socket_cap_base_rear_left_cap_base_rear_left_rivet_mount_0.name = "cap-base-rear-left-rivet-mount";
  socket_cap_base_rear_left_cap_base_rear_left_rivet_mount_0.position.set(0.0, 0.0, 0.0);
  socket_cap_base_rear_left_cap_base_rear_left_rivet_mount_0.rotation.set(0.0, 0.0, 0.0);
  socket_cap_base_rear_left_cap_base_rear_left_rivet_mount_0.userData.socket = {"id": "cap-base-rear-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_cap_base_rear_left_20.add(socket_cap_base_rear_left_cap_base_rear_left_rivet_mount_0);
  sockets["cap-base-rear-left:cap-base-rear-left-rivet-mount"] = socket_cap_base_rear_left_cap_base_rear_left_rivet_mount_0;

  const attachment_cap_lid_rear_left_21 = {"parentId": "lid-shell", "parentSocket": "cap-rear-left-mount", "contactType": "surface-mount", "localStart": [-0.435, -0.1005, -0.048], "localEnd": [-0.435, -0.1005, -0.048], "contactNormal": [-1.0, 0.0, -1.0], "embedDepth": 0.035, "gapTolerance": 0.0, "note": "Cap wraps the lid corner, embedded into rim and both sloped facets.", "evidenceRefs": ["full-object"]};
  const endpoint_cap_lid_rear_left_21 = makeAttachmentEndpoint(attachment_cap_lid_rear_left_21);
  const node_cap_lid_rear_left_21 = new THREE.Group();
  node_cap_lid_rear_left_21.name = "Lid corner cap rear left__pivot";
  node_cap_lid_rear_left_21.scale.set(1, 1, 1);
  if (endpoint_cap_lid_rear_left_21) {
    node_cap_lid_rear_left_21.position.copy(endpoint_cap_lid_rear_left_21.start);
    node_cap_lid_rear_left_21.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_cap_lid_rear_left_21.position.set(-0.435, -0.1005, -0.048);
    node_cap_lid_rear_left_21.rotation.set(-0.0, 0.0, -0.0);
  }
  node_cap_lid_rear_left_21.userData.sculptComponent = {"id": "cap-lid-rear-left", "name": "Lid corner cap rear left", "level": "meso", "role": "cap", "importance": 0.75, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid corners carry the largest gold pieces; they stand proud of the sloped facets and define the widest points of the upper silhouette.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement wrapping the lid taper", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.016, "segments": 1}, "profile2D": {"points": [[-0.111, -0.1125], [0.111, -0.1125], [0.125, -0.0985], [0.125, 0.0985], [0.111, 0.1125], [-0.013, 0.1125], [-0.125, 0.0005], [-0.125, -0.0985]], "depth": 0.093}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "cap-rear-left-mount", "contactType": "surface-mount", "localStart": [-0.435, -0.1005, -0.048], "localEnd": [-0.435, -0.1005, -0.048], "contactNormal": [-1.0, 0.0, -1.0], "embedDepth": 0.035, "gapTolerance": 0.0, "note": "Cap wraps the lid corner, embedded into rim and both sloped facets.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.093, "depth": 0.225, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.435, -0.1005, -0.048], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-lid-rear-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-left", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-left-x", "rivet-lid-rear-left-z", "rivet-lid-rear-left-top"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "lid-taper"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_lid_rear_left_21.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-lid-rear-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-left", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-left-x", "rivet-lid-rear-left-z", "rivet-lid-rear-left-top"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}};
  (nodes["lid-shell"] ?? root).add(node_cap_lid_rear_left_21);
  nodes["cap-lid-rear-left"] = node_cap_lid_rear_left_21;
  const mesh_cap_lid_rear_left_21Geometry = endpoint_cap_lid_rear_left_21
    ? new THREE.CylinderGeometry(endpoint_cap_lid_rear_left_21.endRadius, endpoint_cap_lid_rear_left_21.baseRadius, endpoint_cap_lid_rear_left_21.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.111, -0.1125], [0.111, -0.1125], [0.125, -0.0985], [0.125, 0.0985], [0.111, 0.1125], [-0.013, 0.1125], [-0.125, 0.0005], [-0.125, -0.0985]], "depth": 0.093});
  if (!endpoint_cap_lid_rear_left_21) {
    mesh_cap_lid_rear_left_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_lid_rear_left_21 = new THREE.Mesh(
    mesh_cap_lid_rear_left_21Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_lid_rear_left_21.name = "Lid corner cap rear left";
  if (endpoint_cap_lid_rear_left_21) {
    mesh_cap_lid_rear_left_21.position.copy(endpoint_cap_lid_rear_left_21.midpoint);
    mesh_cap_lid_rear_left_21.quaternion.copy(endpoint_cap_lid_rear_left_21.quaternion);
  }
  mesh_cap_lid_rear_left_21.castShadow = options.castShadow ?? true;
  mesh_cap_lid_rear_left_21.receiveShadow = options.receiveShadow ?? true;
  mesh_cap_lid_rear_left_21.userData.sculptComponent = {"id": "cap-lid-rear-left", "name": "Lid corner cap rear left", "level": "meso", "role": "cap", "importance": 0.75, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid corners carry the largest gold pieces; they stand proud of the sloped facets and define the widest points of the upper silhouette.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement wrapping the lid taper", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.016, "segments": 1}, "profile2D": {"points": [[-0.111, -0.1125], [0.111, -0.1125], [0.125, -0.0985], [0.125, 0.0985], [0.111, 0.1125], [-0.013, 0.1125], [-0.125, 0.0005], [-0.125, -0.0985]], "depth": 0.093}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "cap-rear-left-mount", "contactType": "surface-mount", "localStart": [-0.435, -0.1005, -0.048], "localEnd": [-0.435, -0.1005, -0.048], "contactNormal": [-1.0, 0.0, -1.0], "embedDepth": 0.035, "gapTolerance": 0.0, "note": "Cap wraps the lid corner, embedded into rim and both sloped facets.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.093, "depth": 0.225, "units": "relative", "confidence": 0.55}, "transform": {"position": [-0.435, -0.1005, -0.048], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-lid-rear-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-left", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-left-x", "rivet-lid-rear-left-z", "rivet-lid-rear-left-top"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "lid-taper"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_lid_rear_left_21.add(mesh_cap_lid_rear_left_21);
  meshes["cap-lid-rear-left"] = mesh_cap_lid_rear_left_21;
  colliders["cap-lid-rear-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["corner-hardware-lid-rear-left"] ??= [];
  destructionGroups["corner-hardware-lid-rear-left"].push(node_cap_lid_rear_left_21);
  const socket_cap_lid_rear_left_cap_lid_rear_left_rivet_mount_0 = new THREE.Object3D();
  socket_cap_lid_rear_left_cap_lid_rear_left_rivet_mount_0.name = "cap-lid-rear-left-rivet-mount";
  socket_cap_lid_rear_left_cap_lid_rear_left_rivet_mount_0.position.set(0.0, 0.0, 0.0);
  socket_cap_lid_rear_left_cap_lid_rear_left_rivet_mount_0.rotation.set(0.0, 0.0, 0.0);
  socket_cap_lid_rear_left_cap_lid_rear_left_rivet_mount_0.userData.socket = {"id": "cap-lid-rear-left-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_cap_lid_rear_left_21.add(socket_cap_lid_rear_left_cap_lid_rear_left_rivet_mount_0);
  sockets["cap-lid-rear-left:cap-lid-rear-left-rivet-mount"] = socket_cap_lid_rear_left_cap_lid_rear_left_rivet_mount_0;

  const attachment_cap_base_front_right_22 = {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [0.3875, -0.27, 0.0], "localEnd": [0.3875, -0.27, 0.0], "contactNormal": [1.0, 0.0, 1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Cap wraps the corner and is embedded 0.03 into both walls.", "evidenceRefs": ["full-object"]};
  const endpoint_cap_base_front_right_22 = makeAttachmentEndpoint(attachment_cap_base_front_right_22);
  const node_cap_base_front_right_22 = new THREE.Group();
  node_cap_base_front_right_22.name = "Base corner cap front right__pivot";
  node_cap_base_front_right_22.scale.set(1, 1, 1);
  if (endpoint_cap_base_front_right_22) {
    node_cap_base_front_right_22.position.copy(endpoint_cap_base_front_right_22.start);
    node_cap_base_front_right_22.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_cap_base_front_right_22.position.set(0.3875, -0.27, 0.0);
    node_cap_base_front_right_22.rotation.set(-0.0, 0.0, -0.0);
  }
  node_cap_base_front_right_22.userData.sculptComponent = {"id": "cap-base-front-right", "name": "Base corner cap front right", "level": "meso", "role": "cap", "importance": 0.7, "confidence": 0.65, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Cast gold corner piece wrapping two walls with a wide diagonal facet across the corner, standing proud of the paint.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement with a wide diagonal facet", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.014, "segments": 1}, "profile2D": {"points": [[-0.1085, -0.11], [0.0175, -0.11], [0.1225, -0.005], [0.1225, 0.096], [0.1085, 0.11], [-0.1085, 0.11], [-0.1225, 0.096], [-0.1225, -0.096]], "depth": 0.255}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [0.3875, -0.27, 0.0], "localEnd": [0.3875, -0.27, 0.0], "contactNormal": [1.0, 0.0, 1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Cap wraps the corner and is embedded 0.03 into both walls.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.245, "height": 0.255, "depth": 0.22, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.3875, -0.27, 0.0], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-base-front-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-right", "seamRefs": [], "detachableFragments": ["rivet-base-front-right-x", "rivet-base-front-right-z"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "plinth-base"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_base_front_right_22.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-base-front-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-right", "seamRefs": [], "detachableFragments": ["rivet-base-front-right-x", "rivet-base-front-right-z"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}};
  (nodes["body-shell"] ?? root).add(node_cap_base_front_right_22);
  nodes["cap-base-front-right"] = node_cap_base_front_right_22;
  const mesh_cap_base_front_right_22Geometry = endpoint_cap_base_front_right_22
    ? new THREE.CylinderGeometry(endpoint_cap_base_front_right_22.endRadius, endpoint_cap_base_front_right_22.baseRadius, endpoint_cap_base_front_right_22.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.1085, -0.11], [0.0175, -0.11], [0.1225, -0.005], [0.1225, 0.096], [0.1085, 0.11], [-0.1085, 0.11], [-0.1225, 0.096], [-0.1225, -0.096]], "depth": 0.255});
  if (!endpoint_cap_base_front_right_22) {
    mesh_cap_base_front_right_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_base_front_right_22 = new THREE.Mesh(
    mesh_cap_base_front_right_22Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_base_front_right_22.name = "Base corner cap front right";
  if (endpoint_cap_base_front_right_22) {
    mesh_cap_base_front_right_22.position.copy(endpoint_cap_base_front_right_22.midpoint);
    mesh_cap_base_front_right_22.quaternion.copy(endpoint_cap_base_front_right_22.quaternion);
  }
  mesh_cap_base_front_right_22.castShadow = options.castShadow ?? true;
  mesh_cap_base_front_right_22.receiveShadow = options.receiveShadow ?? true;
  mesh_cap_base_front_right_22.userData.sculptComponent = {"id": "cap-base-front-right", "name": "Base corner cap front right", "level": "meso", "role": "cap", "importance": 0.7, "confidence": 0.65, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Cast gold corner piece wrapping two walls with a wide diagonal facet across the corner, standing proud of the paint.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement with a wide diagonal facet", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.014, "segments": 1}, "profile2D": {"points": [[-0.1085, -0.11], [0.0175, -0.11], [0.1225, -0.005], [0.1225, 0.096], [0.1085, 0.11], [-0.1085, 0.11], [-0.1225, 0.096], [-0.1225, -0.096]], "depth": 0.255}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [0.3875, -0.27, 0.0], "localEnd": [0.3875, -0.27, 0.0], "contactNormal": [1.0, 0.0, 1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Cap wraps the corner and is embedded 0.03 into both walls.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.245, "height": 0.255, "depth": 0.22, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.3875, -0.27, 0.0], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-base-front-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-right", "seamRefs": [], "detachableFragments": ["rivet-base-front-right-x", "rivet-base-front-right-z"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "plinth-base"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_base_front_right_22.add(mesh_cap_base_front_right_22);
  meshes["cap-base-front-right"] = mesh_cap_base_front_right_22;
  colliders["cap-base-front-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["corner-hardware-base-front-right"] ??= [];
  destructionGroups["corner-hardware-base-front-right"].push(node_cap_base_front_right_22);
  const socket_cap_base_front_right_cap_base_front_right_rivet_mount_0 = new THREE.Object3D();
  socket_cap_base_front_right_cap_base_front_right_rivet_mount_0.name = "cap-base-front-right-rivet-mount";
  socket_cap_base_front_right_cap_base_front_right_rivet_mount_0.position.set(0.0, 0.0, 0.0);
  socket_cap_base_front_right_cap_base_front_right_rivet_mount_0.rotation.set(0.0, 0.0, 0.0);
  socket_cap_base_front_right_cap_base_front_right_rivet_mount_0.userData.socket = {"id": "cap-base-front-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_cap_base_front_right_22.add(socket_cap_base_front_right_cap_base_front_right_rivet_mount_0);
  sockets["cap-base-front-right:cap-base-front-right-rivet-mount"] = socket_cap_base_front_right_cap_base_front_right_rivet_mount_0;

  const attachment_cap_lid_front_right_23 = {"parentId": "lid-shell", "parentSocket": "cap-front-right-mount", "contactType": "surface-mount", "localStart": [0.435, -0.7355, -0.048], "localEnd": [0.435, -0.7355, -0.048], "contactNormal": [1.0, 0.0, 1.0], "embedDepth": 0.035, "gapTolerance": 0.0, "note": "Cap wraps the lid corner, embedded into rim and both sloped facets.", "evidenceRefs": ["full-object"]};
  const endpoint_cap_lid_front_right_23 = makeAttachmentEndpoint(attachment_cap_lid_front_right_23);
  const node_cap_lid_front_right_23 = new THREE.Group();
  node_cap_lid_front_right_23.name = "Lid corner cap front right__pivot";
  node_cap_lid_front_right_23.scale.set(1, 1, 1);
  if (endpoint_cap_lid_front_right_23) {
    node_cap_lid_front_right_23.position.copy(endpoint_cap_lid_front_right_23.start);
    node_cap_lid_front_right_23.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_cap_lid_front_right_23.position.set(0.435, -0.7355, -0.048);
    node_cap_lid_front_right_23.rotation.set(-0.0, 0.0, -0.0);
  }
  node_cap_lid_front_right_23.userData.sculptComponent = {"id": "cap-lid-front-right", "name": "Lid corner cap front right", "level": "meso", "role": "cap", "importance": 0.75, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid corners carry the largest gold pieces; they stand proud of the sloped facets and define the widest points of the upper silhouette.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement wrapping the lid taper", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.016, "segments": 1}, "profile2D": {"points": [[-0.111, -0.1125], [0.013, -0.1125], [0.125, -0.0005], [0.125, 0.0985], [0.111, 0.1125], [-0.111, 0.1125], [-0.125, 0.0985], [-0.125, -0.0985]], "depth": 0.093}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "cap-front-right-mount", "contactType": "surface-mount", "localStart": [0.435, -0.7355, -0.048], "localEnd": [0.435, -0.7355, -0.048], "contactNormal": [1.0, 0.0, 1.0], "embedDepth": 0.035, "gapTolerance": 0.0, "note": "Cap wraps the lid corner, embedded into rim and both sloped facets.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.093, "depth": 0.225, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.435, -0.7355, -0.048], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-lid-front-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-right", "seamRefs": [], "detachableFragments": ["rivet-lid-front-right-x", "rivet-lid-front-right-z", "rivet-lid-front-right-top"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "lid-taper"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_lid_front_right_23.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-lid-front-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-right", "seamRefs": [], "detachableFragments": ["rivet-lid-front-right-x", "rivet-lid-front-right-z", "rivet-lid-front-right-top"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}};
  (nodes["lid-shell"] ?? root).add(node_cap_lid_front_right_23);
  nodes["cap-lid-front-right"] = node_cap_lid_front_right_23;
  const mesh_cap_lid_front_right_23Geometry = endpoint_cap_lid_front_right_23
    ? new THREE.CylinderGeometry(endpoint_cap_lid_front_right_23.endRadius, endpoint_cap_lid_front_right_23.baseRadius, endpoint_cap_lid_front_right_23.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.111, -0.1125], [0.013, -0.1125], [0.125, -0.0005], [0.125, 0.0985], [0.111, 0.1125], [-0.111, 0.1125], [-0.125, 0.0985], [-0.125, -0.0985]], "depth": 0.093});
  if (!endpoint_cap_lid_front_right_23) {
    mesh_cap_lid_front_right_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_lid_front_right_23 = new THREE.Mesh(
    mesh_cap_lid_front_right_23Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_lid_front_right_23.name = "Lid corner cap front right";
  if (endpoint_cap_lid_front_right_23) {
    mesh_cap_lid_front_right_23.position.copy(endpoint_cap_lid_front_right_23.midpoint);
    mesh_cap_lid_front_right_23.quaternion.copy(endpoint_cap_lid_front_right_23.quaternion);
  }
  mesh_cap_lid_front_right_23.castShadow = options.castShadow ?? true;
  mesh_cap_lid_front_right_23.receiveShadow = options.receiveShadow ?? true;
  mesh_cap_lid_front_right_23.userData.sculptComponent = {"id": "cap-lid-front-right", "name": "Lid corner cap front right", "level": "meso", "role": "cap", "importance": 0.75, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid corners carry the largest gold pieces; they stand proud of the sloped facets and define the widest points of the upper silhouette.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement wrapping the lid taper", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.016, "segments": 1}, "profile2D": {"points": [[-0.111, -0.1125], [0.013, -0.1125], [0.125, -0.0005], [0.125, 0.0985], [0.111, 0.1125], [-0.111, 0.1125], [-0.125, 0.0985], [-0.125, -0.0985]], "depth": 0.093}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "cap-front-right-mount", "contactType": "surface-mount", "localStart": [0.435, -0.7355, -0.048], "localEnd": [0.435, -0.7355, -0.048], "contactNormal": [1.0, 0.0, 1.0], "embedDepth": 0.035, "gapTolerance": 0.0, "note": "Cap wraps the lid corner, embedded into rim and both sloped facets.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.093, "depth": 0.225, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.435, -0.7355, -0.048], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-lid-front-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-right", "seamRefs": [], "detachableFragments": ["rivet-lid-front-right-x", "rivet-lid-front-right-z", "rivet-lid-front-right-top"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "lid-taper"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_lid_front_right_23.add(mesh_cap_lid_front_right_23);
  meshes["cap-lid-front-right"] = mesh_cap_lid_front_right_23;
  colliders["cap-lid-front-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["corner-hardware-lid-front-right"] ??= [];
  destructionGroups["corner-hardware-lid-front-right"].push(node_cap_lid_front_right_23);
  const socket_cap_lid_front_right_cap_lid_front_right_rivet_mount_0 = new THREE.Object3D();
  socket_cap_lid_front_right_cap_lid_front_right_rivet_mount_0.name = "cap-lid-front-right-rivet-mount";
  socket_cap_lid_front_right_cap_lid_front_right_rivet_mount_0.position.set(0.0, 0.0, 0.0);
  socket_cap_lid_front_right_cap_lid_front_right_rivet_mount_0.rotation.set(0.0, 0.0, 0.0);
  socket_cap_lid_front_right_cap_lid_front_right_rivet_mount_0.userData.socket = {"id": "cap-lid-front-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_cap_lid_front_right_23.add(socket_cap_lid_front_right_cap_lid_front_right_rivet_mount_0);
  sockets["cap-lid-front-right:cap-lid-front-right-rivet-mount"] = socket_cap_lid_front_right_cap_lid_front_right_rivet_mount_0;

  const attachment_cap_base_rear_right_24 = {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [0.3875, 0.27, -0.0], "localEnd": [0.3875, 0.27, -0.0], "contactNormal": [1.0, 0.0, -1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Cap wraps the corner and is embedded 0.03 into both walls.", "evidenceRefs": ["full-object"]};
  const endpoint_cap_base_rear_right_24 = makeAttachmentEndpoint(attachment_cap_base_rear_right_24);
  const node_cap_base_rear_right_24 = new THREE.Group();
  node_cap_base_rear_right_24.name = "Base corner cap rear right__pivot";
  node_cap_base_rear_right_24.scale.set(1, 1, 1);
  if (endpoint_cap_base_rear_right_24) {
    node_cap_base_rear_right_24.position.copy(endpoint_cap_base_rear_right_24.start);
    node_cap_base_rear_right_24.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_cap_base_rear_right_24.position.set(0.3875, 0.27, -0.0);
    node_cap_base_rear_right_24.rotation.set(-0.0, 0.0, -0.0);
  }
  node_cap_base_rear_right_24.userData.sculptComponent = {"id": "cap-base-rear-right", "name": "Base corner cap rear right", "level": "meso", "role": "cap", "importance": 0.7, "confidence": 0.65, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Cast gold corner piece wrapping two walls with a wide diagonal facet across the corner, standing proud of the paint.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement with a wide diagonal facet", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.014, "segments": 1}, "profile2D": {"points": [[-0.1085, -0.11], [0.1085, -0.11], [0.1225, -0.096], [0.1225, 0.005], [0.0175, 0.11], [-0.1085, 0.11], [-0.1225, 0.096], [-0.1225, -0.096]], "depth": 0.255}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [0.3875, 0.27, -0.0], "localEnd": [0.3875, 0.27, -0.0], "contactNormal": [1.0, 0.0, -1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Cap wraps the corner and is embedded 0.03 into both walls.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.245, "height": 0.255, "depth": 0.22, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.3875, 0.27, -0.0], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-base-rear-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-right", "seamRefs": [], "detachableFragments": ["rivet-base-rear-right-x", "rivet-base-rear-right-z"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "plinth-base"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_base_rear_right_24.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-base-rear-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-right", "seamRefs": [], "detachableFragments": ["rivet-base-rear-right-x", "rivet-base-rear-right-z"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}};
  (nodes["body-shell"] ?? root).add(node_cap_base_rear_right_24);
  nodes["cap-base-rear-right"] = node_cap_base_rear_right_24;
  const mesh_cap_base_rear_right_24Geometry = endpoint_cap_base_rear_right_24
    ? new THREE.CylinderGeometry(endpoint_cap_base_rear_right_24.endRadius, endpoint_cap_base_rear_right_24.baseRadius, endpoint_cap_base_rear_right_24.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.1085, -0.11], [0.1085, -0.11], [0.1225, -0.096], [0.1225, 0.005], [0.0175, 0.11], [-0.1085, 0.11], [-0.1225, 0.096], [-0.1225, -0.096]], "depth": 0.255});
  if (!endpoint_cap_base_rear_right_24) {
    mesh_cap_base_rear_right_24Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_base_rear_right_24 = new THREE.Mesh(
    mesh_cap_base_rear_right_24Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_base_rear_right_24.name = "Base corner cap rear right";
  if (endpoint_cap_base_rear_right_24) {
    mesh_cap_base_rear_right_24.position.copy(endpoint_cap_base_rear_right_24.midpoint);
    mesh_cap_base_rear_right_24.quaternion.copy(endpoint_cap_base_rear_right_24.quaternion);
  }
  mesh_cap_base_rear_right_24.castShadow = options.castShadow ?? true;
  mesh_cap_base_rear_right_24.receiveShadow = options.receiveShadow ?? true;
  mesh_cap_base_rear_right_24.userData.sculptComponent = {"id": "cap-base-rear-right", "name": "Base corner cap rear right", "level": "meso", "role": "cap", "importance": 0.7, "confidence": 0.65, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Cast gold corner piece wrapping two walls with a wide diagonal facet across the corner, standing proud of the paint.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement with a wide diagonal facet", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.014, "segments": 1}, "profile2D": {"points": [[-0.1085, -0.11], [0.1085, -0.11], [0.1225, -0.096], [0.1225, 0.005], [0.0175, 0.11], [-0.1085, 0.11], [-0.1225, 0.096], [-0.1225, -0.096]], "depth": 0.255}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "plinth-mount", "contactType": "surface-mount", "localStart": [0.3875, 0.27, -0.0], "localEnd": [0.3875, 0.27, -0.0], "contactNormal": [1.0, 0.0, -1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Cap wraps the corner and is embedded 0.03 into both walls.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.245, "height": 0.255, "depth": 0.22, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.3875, 0.27, -0.0], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-base-rear-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-right", "seamRefs": [], "detachableFragments": ["rivet-base-rear-right-x", "rivet-base-rear-right-z"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "plinth-base"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_base_rear_right_24.add(mesh_cap_base_rear_right_24);
  meshes["cap-base-rear-right"] = mesh_cap_base_rear_right_24;
  colliders["cap-base-rear-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["corner-hardware-base-rear-right"] ??= [];
  destructionGroups["corner-hardware-base-rear-right"].push(node_cap_base_rear_right_24);
  const socket_cap_base_rear_right_cap_base_rear_right_rivet_mount_0 = new THREE.Object3D();
  socket_cap_base_rear_right_cap_base_rear_right_rivet_mount_0.name = "cap-base-rear-right-rivet-mount";
  socket_cap_base_rear_right_cap_base_rear_right_rivet_mount_0.position.set(0.0, 0.0, 0.0);
  socket_cap_base_rear_right_cap_base_rear_right_rivet_mount_0.rotation.set(0.0, 0.0, 0.0);
  socket_cap_base_rear_right_cap_base_rear_right_rivet_mount_0.userData.socket = {"id": "cap-base-rear-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_cap_base_rear_right_24.add(socket_cap_base_rear_right_cap_base_rear_right_rivet_mount_0);
  sockets["cap-base-rear-right:cap-base-rear-right-rivet-mount"] = socket_cap_base_rear_right_cap_base_rear_right_rivet_mount_0;

  const attachment_cap_lid_rear_right_25 = {"parentId": "lid-shell", "parentSocket": "cap-rear-right-mount", "contactType": "surface-mount", "localStart": [0.435, -0.1005, -0.048], "localEnd": [0.435, -0.1005, -0.048], "contactNormal": [1.0, 0.0, -1.0], "embedDepth": 0.035, "gapTolerance": 0.0, "note": "Cap wraps the lid corner, embedded into rim and both sloped facets.", "evidenceRefs": ["full-object"]};
  const endpoint_cap_lid_rear_right_25 = makeAttachmentEndpoint(attachment_cap_lid_rear_right_25);
  const node_cap_lid_rear_right_25 = new THREE.Group();
  node_cap_lid_rear_right_25.name = "Lid corner cap rear right__pivot";
  node_cap_lid_rear_right_25.scale.set(1, 1, 1);
  if (endpoint_cap_lid_rear_right_25) {
    node_cap_lid_rear_right_25.position.copy(endpoint_cap_lid_rear_right_25.start);
    node_cap_lid_rear_right_25.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_cap_lid_rear_right_25.position.set(0.435, -0.1005, -0.048);
    node_cap_lid_rear_right_25.rotation.set(-0.0, 0.0, -0.0);
  }
  node_cap_lid_rear_right_25.userData.sculptComponent = {"id": "cap-lid-rear-right", "name": "Lid corner cap rear right", "level": "meso", "role": "cap", "importance": 0.75, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid corners carry the largest gold pieces; they stand proud of the sloped facets and define the widest points of the upper silhouette.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement wrapping the lid taper", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.016, "segments": 1}, "profile2D": {"points": [[-0.111, -0.1125], [0.111, -0.1125], [0.125, -0.0985], [0.125, 0.0005], [0.013, 0.1125], [-0.111, 0.1125], [-0.125, 0.0985], [-0.125, -0.0985]], "depth": 0.093}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "cap-rear-right-mount", "contactType": "surface-mount", "localStart": [0.435, -0.1005, -0.048], "localEnd": [0.435, -0.1005, -0.048], "contactNormal": [1.0, 0.0, -1.0], "embedDepth": 0.035, "gapTolerance": 0.0, "note": "Cap wraps the lid corner, embedded into rim and both sloped facets.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.093, "depth": 0.225, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.435, -0.1005, -0.048], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-lid-rear-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-right", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-right-x", "rivet-lid-rear-right-z", "rivet-lid-rear-right-top"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "lid-taper"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_lid_rear_right_25.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-lid-rear-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-right", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-right-x", "rivet-lid-rear-right-z", "rivet-lid-rear-right-top"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}};
  (nodes["lid-shell"] ?? root).add(node_cap_lid_rear_right_25);
  nodes["cap-lid-rear-right"] = node_cap_lid_rear_right_25;
  const mesh_cap_lid_rear_right_25Geometry = endpoint_cap_lid_rear_right_25
    ? new THREE.CylinderGeometry(endpoint_cap_lid_rear_right_25.endRadius, endpoint_cap_lid_rear_right_25.baseRadius, endpoint_cap_lid_rear_right_25.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.111, -0.1125], [0.111, -0.1125], [0.125, -0.0985], [0.125, 0.0005], [0.013, 0.1125], [-0.111, 0.1125], [-0.125, 0.0985], [-0.125, -0.0985]], "depth": 0.093});
  if (!endpoint_cap_lid_rear_right_25) {
    mesh_cap_lid_rear_right_25Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cap_lid_rear_right_25 = new THREE.Mesh(
    mesh_cap_lid_rear_right_25Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_cap_lid_rear_right_25.name = "Lid corner cap rear right";
  if (endpoint_cap_lid_rear_right_25) {
    mesh_cap_lid_rear_right_25.position.copy(endpoint_cap_lid_rear_right_25.midpoint);
    mesh_cap_lid_rear_right_25.quaternion.copy(endpoint_cap_lid_rear_right_25.quaternion);
  }
  mesh_cap_lid_rear_right_25.castShadow = options.castShadow ?? true;
  mesh_cap_lid_rear_right_25.receiveShadow = options.receiveShadow ?? true;
  mesh_cap_lid_rear_right_25.userData.sculptComponent = {"id": "cap-lid-rear-right", "name": "Lid corner cap rear right", "level": "meso", "role": "cap", "importance": 0.75, "confidence": 0.6, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The lid corners carry the largest gold pieces; they stand proud of the sloped facets and define the widest points of the upper silhouette.", "geometryDescriptor": {"topologyIntent": "chunky gold corner reinforcement wrapping the lid taper", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.016, "segments": 1}, "profile2D": {"points": [[-0.111, -0.1125], [0.111, -0.1125], [0.125, -0.0985], [0.125, 0.0005], [0.013, 0.1125], [-0.111, 0.1125], [-0.125, 0.0985], [-0.125, -0.0985]], "depth": 0.093}, "deformationStack": [], "uvStrategy": "extrude cap/side UVs", "normalStrategy": "faceted, hard creases between facets"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "cap-rear-right-mount", "contactType": "surface-mount", "localStart": [0.435, -0.1005, -0.048], "localEnd": [0.435, -0.1005, -0.048], "contactNormal": [1.0, 0.0, -1.0], "embedDepth": 0.035, "gapTolerance": 0.0, "note": "Cap wraps the lid corner, embedded into rim and both sloped facets.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.25, "height": 0.093, "depth": 0.225, "units": "relative", "confidence": 0.55}, "transform": {"position": [0.435, -0.1005, -0.048], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [{"id": "cap-lid-rear-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]}], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-right", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-right-x", "rivet-lid-rear-right-z", "rivet-lid-rear-right-top"], "breakImpulse": 4.5, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware", "lid-taper"], "details": [], "fidelityTier": "form-refinement"};
  node_cap_lid_rear_right_25.add(mesh_cap_lid_rear_right_25);
  meshes["cap-lid-rear-right"] = mesh_cap_lid_rear_right_25;
  colliders["cap-lid-rear-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["corner-hardware-lid-rear-right"] ??= [];
  destructionGroups["corner-hardware-lid-rear-right"].push(node_cap_lid_rear_right_25);
  const socket_cap_lid_rear_right_cap_lid_rear_right_rivet_mount_0 = new THREE.Object3D();
  socket_cap_lid_rear_right_cap_lid_rear_right_rivet_mount_0.name = "cap-lid-rear-right-rivet-mount";
  socket_cap_lid_rear_right_cap_lid_rear_right_rivet_mount_0.position.set(0.0, 0.0, 0.0);
  socket_cap_lid_rear_right_cap_lid_rear_right_rivet_mount_0.rotation.set(0.0, 0.0, 0.0);
  socket_cap_lid_rear_right_cap_lid_rear_right_rivet_mount_0.userData.socket = {"id": "cap-lid-rear-right-rivet-mount", "localPosition": [0.0, 0.0, 0.0], "localRotation": [0.0, 0.0, 0.0]};
  node_cap_lid_rear_right_25.add(socket_cap_lid_rear_right_cap_lid_rear_right_rivet_mount_0);
  sockets["cap-lid-rear-right:cap-lid-rear-right-rivet-mount"] = socket_cap_lid_rear_right_cap_lid_rear_right_rivet_mount_0;

  const attachment_emblem_plaque_26 = {"parentId": "body-front-panel", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, -0.036], "localEnd": [0.0, 0.0, -0.036], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.02, "gapTolerance": 0.0, "note": "Plaque is embedded 0.020 into the front plate and carries the crown ring.", "evidenceRefs": ["full-object"]};
  const endpoint_emblem_plaque_26 = makeAttachmentEndpoint(attachment_emblem_plaque_26);
  const node_emblem_plaque_26 = new THREE.Group();
  node_emblem_plaque_26.name = "Crown emblem plaque__pivot";
  node_emblem_plaque_26.scale.set(1, 1, 1);
  if (endpoint_emblem_plaque_26) {
    node_emblem_plaque_26.position.copy(endpoint_emblem_plaque_26.start);
    node_emblem_plaque_26.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_emblem_plaque_26.position.set(0.0, -0.005, -0.023);
    node_emblem_plaque_26.rotation.set(-0.0, 0.0, -0.0);
  }
  node_emblem_plaque_26.userData.sculptComponent = {"id": "emblem-plaque", "name": "Crown emblem plaque", "level": "meso", "role": "plaque", "importance": 0.6, "confidence": 0.6, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "In the reference the crown is not painted straight onto the lacquer: it sits inside a dark rounded field that separates the gold rim from the teal wall and catches the glow bleed.", "geometryDescriptor": {"topologyIntent": "dark rounded plaque the crown ring is mounted on, reading as a recess", "edgeTreatment": {"type": "fillet", "bevelRadius": 0.03, "segments": 3}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat face with filleted border"}, "parent": "body-front-panel", "attachment": {"parentId": "body-front-panel", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, -0.036], "localEnd": [0.0, 0.0, -0.036], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.02, "gapTolerance": 0.0, "note": "Plaque is embedded 0.020 into the front plate and carries the crown ring.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.462, "height": 0.266, "depth": 0.03, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.0, -0.005, -0.023], "rotation": [-0.0, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-plaque", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "seam-shadow", "materialLayers": ["seam-shadow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(22, 20, 40, 1.0)", "secondaryAlbedo": "rgba(46, 42, 74, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.5, "finish": "unlit gap between lid and body, reads as pure shadow", "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "evidenceRefs": ["full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "plaque-recess-border", "kind": "groove", "description": "Dark rounded border framing the crown emblem.", "evidenceRefs": ["crown-emblem"]}, {"id": "plaque-glow-bleed", "kind": "gradient", "description": "Warm bleed from the emblem core across the plaque face.", "evidenceRefs": ["crown-emblem"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["crown-emblem", "front-face"], "details": [], "fidelityTier": "surface-pass"};
  node_emblem_plaque_26.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-plaque", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-front-panel"] ?? root).add(node_emblem_plaque_26);
  nodes["emblem-plaque"] = node_emblem_plaque_26;
  const mesh_emblem_plaque_26Geometry = endpoint_emblem_plaque_26
    ? new THREE.CylinderGeometry(endpoint_emblem_plaque_26.endRadius, endpoint_emblem_plaque_26.baseRadius, endpoint_emblem_plaque_26.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_emblem_plaque_26) {
    mesh_emblem_plaque_26Geometry.scale(0.462, 0.266, 0.03);
  }
  const mesh_emblem_plaque_26 = new THREE.Mesh(
    mesh_emblem_plaque_26Geometry,
    materialMap["seam-shadow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_emblem_plaque_26.name = "Crown emblem plaque";
  if (endpoint_emblem_plaque_26) {
    mesh_emblem_plaque_26.position.copy(endpoint_emblem_plaque_26.midpoint);
    mesh_emblem_plaque_26.quaternion.copy(endpoint_emblem_plaque_26.quaternion);
  }
  mesh_emblem_plaque_26.castShadow = options.castShadow ?? true;
  mesh_emblem_plaque_26.receiveShadow = options.receiveShadow ?? true;
  mesh_emblem_plaque_26.userData.sculptComponent = {"id": "emblem-plaque", "name": "Crown emblem plaque", "level": "meso", "role": "plaque", "importance": 0.6, "confidence": 0.6, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "In the reference the crown is not painted straight onto the lacquer: it sits inside a dark rounded field that separates the gold rim from the teal wall and catches the glow bleed.", "geometryDescriptor": {"topologyIntent": "dark rounded plaque the crown ring is mounted on, reading as a recess", "edgeTreatment": {"type": "fillet", "bevelRadius": 0.03, "segments": 3}, "deformationStack": [], "uvStrategy": "box UVs", "normalStrategy": "flat face with filleted border"}, "parent": "body-front-panel", "attachment": {"parentId": "body-front-panel", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, -0.036], "localEnd": [0.0, 0.0, -0.036], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.02, "gapTolerance": 0.0, "note": "Plaque is embedded 0.020 into the front plate and carries the crown ring.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.462, "height": 0.266, "depth": 0.03, "units": "relative", "confidence": 0.6}, "transform": {"position": [0.0, -0.005, -0.023], "rotation": [-0.0, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-plaque", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "seam-shadow", "materialLayers": ["seam-shadow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(22, 20, 40, 1.0)", "secondaryAlbedo": "rgba(46, 42, 74, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.5, "finish": "unlit gap between lid and body, reads as pure shadow", "colorGradient": {"type": "linear", "axis": [0.0, -1.0], "stops": [{"offset": 0.0, "color": "rgba(46, 42, 74, 1.0)"}, {"offset": 1.0, "color": "rgba(22, 20, 40, 1.0)"}]}, "evidenceRefs": ["full-object"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "plaque-recess-border", "kind": "groove", "description": "Dark rounded border framing the crown emblem.", "evidenceRefs": ["crown-emblem"]}, {"id": "plaque-glow-bleed", "kind": "gradient", "description": "Warm bleed from the emblem core across the plaque face.", "evidenceRefs": ["crown-emblem"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["crown-emblem", "front-face"], "details": [], "fidelityTier": "surface-pass"};
  node_emblem_plaque_26.add(mesh_emblem_plaque_26);
  meshes["emblem-plaque"] = mesh_emblem_plaque_26;
  colliders["emblem-plaque"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-plaque"] ??= [];
  destructionGroups["chest-plaque"].push(node_emblem_plaque_26);

  const attachment_crown_frame_27 = {"parentId": "body-front-panel", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, -0.028], "localEnd": [0.0, 0.0, -0.028], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.028, "gapTolerance": 0.0, "note": "Emblem ring is embedded into the front plate by 0.028.", "evidenceRefs": ["full-object"]};
  const endpoint_crown_frame_27 = makeAttachmentEndpoint(attachment_crown_frame_27);
  const node_crown_frame_27 = new THREE.Group();
  node_crown_frame_27.name = "Crown emblem frame__pivot";
  node_crown_frame_27.scale.set(1, 1, 1);
  if (endpoint_crown_frame_27) {
    node_crown_frame_27.position.copy(endpoint_crown_frame_27.start);
    node_crown_frame_27.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_crown_frame_27.position.set(0.0, -0.005, -0.015);
    node_crown_frame_27.rotation.set(-0.0, 0.0, -0.0);
  }
  node_crown_frame_27.userData.sculptComponent = {"id": "crown-frame", "name": "Crown emblem frame", "level": "macro", "role": "emblem", "importance": 0.95, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The emblem is a rounded-rectangle gold frame standing proud of the front panel; its constant-width rim borders the lit field that the crown badge sits in.", "geometryDescriptor": {"topologyIntent": "extruded rounded-rectangle gold ring of constant rim width; the lit field fills its aperture", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.008, "segments": 1}, "profile2D": {"points": [[0.215, 0.072], [0.2115, 0.0896], [0.20153, 0.10453], [0.1866, 0.1145], [0.169, 0.118], [-0.169, 0.118], [-0.1866, 0.1145], [-0.20153, 0.10453], [-0.2115, 0.0896], [-0.215, 0.072], [-0.215, -0.072], [-0.2115, -0.0896], [-0.20153, -0.10453], [-0.1866, -0.1145], [-0.169, -0.118], [0.169, -0.118], [0.1866, -0.1145], [0.20153, -0.10453], [0.2115, -0.0896], [0.215, -0.072]], "holes": [[[0.183, 0.056], [0.18072, 0.06748], [0.17421, 0.07721], [0.16448, 0.08372], [0.153, 0.086], [-0.153, 0.086], [-0.16448, 0.08372], [-0.17421, 0.07721], [-0.18072, 0.06748], [-0.183, 0.056], [-0.183, -0.056], [-0.18072, -0.06748], [-0.17421, -0.07721], [-0.16448, -0.08372], [-0.153, -0.086], [0.153, -0.086], [0.16448, -0.08372], [0.17421, -0.07721], [0.18072, -0.06748], [0.183, -0.056]]], "depth": 0.055}, "deformationStack": [], "uvStrategy": "extrude cap UVs around the frame ring", "normalStrategy": "flat front face with hard side walls"}, "parent": "body-front-panel", "attachment": {"parentId": "body-front-panel", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, -0.028], "localEnd": [0.0, 0.0, -0.028], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.028, "gapTolerance": 0.0, "note": "Emblem ring is embedded into the front plate by 0.028.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.43, "height": 0.236, "depth": 0.055, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, -0.005, -0.015], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-emblem", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "crown-frame-bevel", "kind": "bevel", "description": "Hard specular bevel along the upper edge of the gold frame.", "evidenceRefs": ["crown-emblem"]}, {"id": "crown-frame-linework", "kind": "linework", "description": "Rounded-rectangle border with generous corner radii.", "evidenceRefs": ["crown-emblem"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["crown-emblem", "front-face"], "details": [], "fidelityTier": "form-refinement"};
  node_crown_frame_27.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-emblem", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-front-panel"] ?? root).add(node_crown_frame_27);
  nodes["crown-frame"] = node_crown_frame_27;
  const mesh_crown_frame_27Geometry = endpoint_crown_frame_27
    ? new THREE.CylinderGeometry(endpoint_crown_frame_27.endRadius, endpoint_crown_frame_27.baseRadius, endpoint_crown_frame_27.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.215, 0.072], [0.2115, 0.0896], [0.20153, 0.10453], [0.1866, 0.1145], [0.169, 0.118], [-0.169, 0.118], [-0.1866, 0.1145], [-0.20153, 0.10453], [-0.2115, 0.0896], [-0.215, 0.072], [-0.215, -0.072], [-0.2115, -0.0896], [-0.20153, -0.10453], [-0.1866, -0.1145], [-0.169, -0.118], [0.169, -0.118], [0.1866, -0.1145], [0.20153, -0.10453], [0.2115, -0.0896], [0.215, -0.072]], "holes": [[[0.183, 0.056], [0.18072, 0.06748], [0.17421, 0.07721], [0.16448, 0.08372], [0.153, 0.086], [-0.153, 0.086], [-0.16448, 0.08372], [-0.17421, 0.07721], [-0.18072, 0.06748], [-0.183, 0.056], [-0.183, -0.056], [-0.18072, -0.06748], [-0.17421, -0.07721], [-0.16448, -0.08372], [-0.153, -0.086], [0.153, -0.086], [0.16448, -0.08372], [0.17421, -0.07721], [0.18072, -0.06748], [0.183, -0.056]]], "depth": 0.055});
  if (!endpoint_crown_frame_27) {
    mesh_crown_frame_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_crown_frame_27 = new THREE.Mesh(
    mesh_crown_frame_27Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crown_frame_27.name = "Crown emblem frame";
  if (endpoint_crown_frame_27) {
    mesh_crown_frame_27.position.copy(endpoint_crown_frame_27.midpoint);
    mesh_crown_frame_27.quaternion.copy(endpoint_crown_frame_27.quaternion);
  }
  mesh_crown_frame_27.castShadow = options.castShadow ?? true;
  mesh_crown_frame_27.receiveShadow = options.receiveShadow ?? true;
  mesh_crown_frame_27.userData.sculptComponent = {"id": "crown-frame", "name": "Crown emblem frame", "level": "macro", "role": "emblem", "importance": 0.95, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The emblem is a rounded-rectangle gold frame standing proud of the front panel; its constant-width rim borders the lit field that the crown badge sits in.", "geometryDescriptor": {"topologyIntent": "extruded rounded-rectangle gold ring of constant rim width; the lit field fills its aperture", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.008, "segments": 1}, "profile2D": {"points": [[0.215, 0.072], [0.2115, 0.0896], [0.20153, 0.10453], [0.1866, 0.1145], [0.169, 0.118], [-0.169, 0.118], [-0.1866, 0.1145], [-0.20153, 0.10453], [-0.2115, 0.0896], [-0.215, 0.072], [-0.215, -0.072], [-0.2115, -0.0896], [-0.20153, -0.10453], [-0.1866, -0.1145], [-0.169, -0.118], [0.169, -0.118], [0.1866, -0.1145], [0.20153, -0.10453], [0.2115, -0.0896], [0.215, -0.072]], "holes": [[[0.183, 0.056], [0.18072, 0.06748], [0.17421, 0.07721], [0.16448, 0.08372], [0.153, 0.086], [-0.153, 0.086], [-0.16448, 0.08372], [-0.17421, 0.07721], [-0.18072, 0.06748], [-0.183, 0.056], [-0.183, -0.056], [-0.18072, -0.06748], [-0.17421, -0.07721], [-0.16448, -0.08372], [-0.153, -0.086], [0.153, -0.086], [0.16448, -0.08372], [0.17421, -0.07721], [0.18072, -0.06748], [0.183, -0.056]]], "depth": 0.055}, "deformationStack": [], "uvStrategy": "extrude cap UVs around the frame ring", "normalStrategy": "flat front face with hard side walls"}, "parent": "body-front-panel", "attachment": {"parentId": "body-front-panel", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, -0.028], "localEnd": [0.0, 0.0, -0.028], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.028, "gapTolerance": 0.0, "note": "Emblem ring is embedded into the front plate by 0.028.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.43, "height": 0.236, "depth": 0.055, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, -0.005, -0.015], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-emblem", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "crown-frame-bevel", "kind": "bevel", "description": "Hard specular bevel along the upper edge of the gold frame.", "evidenceRefs": ["crown-emblem"]}, {"id": "crown-frame-linework", "kind": "linework", "description": "Rounded-rectangle border with generous corner radii.", "evidenceRefs": ["crown-emblem"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["crown-emblem", "front-face"], "details": [], "fidelityTier": "form-refinement"};
  node_crown_frame_27.add(mesh_crown_frame_27);
  meshes["crown-frame"] = mesh_crown_frame_27;
  colliders["crown-frame"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-emblem"] ??= [];
  destructionGroups["chest-emblem"].push(node_crown_frame_27);

  const attachment_crown_glow_28 = {"parentId": "crown-frame", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, -0.002], "localEnd": [0.0, 0.0, -0.002], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Lit field fills the frame aperture, inset by the rim width.", "evidenceRefs": ["full-object"]};
  const endpoint_crown_glow_28 = makeAttachmentEndpoint(attachment_crown_glow_28);
  const node_crown_glow_28 = new THREE.Group();
  node_crown_glow_28.name = "Crown emblem lit core__pivot";
  node_crown_glow_28.scale.set(1, 1, 1);
  if (endpoint_crown_glow_28) {
    node_crown_glow_28.position.copy(endpoint_crown_glow_28.start);
    node_crown_glow_28.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_crown_glow_28.position.set(0.0, 0.0, -0.004);
    node_crown_glow_28.rotation.set(-0.0, 0.0, -0.0);
  }
  node_crown_glow_28.userData.sculptComponent = {"id": "crown-glow", "name": "Crown emblem lit core", "level": "meso", "role": "emblem-core", "importance": 0.9, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Inside the gold frame sits a flat near-white field that reads as self-lit; it sits a hair behind the frame's front plane so the rim stays the brightest edge.", "geometryDescriptor": {"topologyIntent": "extruded rounded-rectangle field inside the frame aperture, self-lit", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "profile2D": {"points": [[0.183, 0.056], [0.18072, 0.06748], [0.17421, 0.07721], [0.16448, 0.08372], [0.153, 0.086], [-0.153, 0.086], [-0.16448, 0.08372], [-0.17421, 0.07721], [-0.18072, 0.06748], [-0.183, 0.056], [-0.183, -0.056], [-0.18072, -0.06748], [-0.17421, -0.07721], [-0.16448, -0.08372], [-0.153, -0.086], [0.153, -0.086], [0.16448, -0.08372], [0.17421, -0.07721], [0.18072, -0.06748], [0.183, -0.056]], "depth": 0.04}, "deformationStack": [], "uvStrategy": "extrude cap UVs", "normalStrategy": "flat emissive face"}, "parent": "crown-frame", "attachment": {"parentId": "crown-frame", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, -0.002], "localEnd": [0.0, 0.0, -0.002], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Lit field fills the frame aperture, inset by the rim width.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.366, "height": 0.172, "depth": 0.04, "units": "relative", "confidence": 0.7}, "transform": {"position": [0.0, 0.0, -0.004], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "state-emissive", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.25, 1.25, 0.4], "isTrigger": true, "notes": "Trigger volume in front of the emblem: this is where a runtime would detect the interact/open gesture."}, "constraints": [{"id": "emblem-state-machine", "type": "material-state", "states": ["dormant", "charging", "lit"], "restState": "lit", "notes": "The reference only documents the lit state; dormant/charging are inferred states a loot chest needs and drive emissiveIntensity, not geometry."}], "destruction": {"breakable": false, "fractureGroup": "emblem", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "emblem-glow", "materialLayers": ["emblem-glow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 250, 220, 1.0)", "secondaryAlbedo": "rgba(255, 214, 96, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.45, "finish": "self-lit warm core reading as light spilling out of the emblem", "colorGradient": {"type": "radial", "axis": [0.5, 0.55], "stops": [{"offset": 0.0, "color": "rgba(255, 250, 220, 1.0)"}, {"offset": 1.0, "color": "rgba(255, 214, 96, 1.0)"}]}, "evidenceRefs": ["crown-emblem"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "emblem-core-emission", "kind": "emissive", "description": "Warm near-white self-lit field with a yellow falloff toward the frame.", "evidenceRefs": ["crown-emblem"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["crown-emblem"], "details": [], "fidelityTier": "form-refinement"};
  node_crown_glow_28.userData.actionProfile = {"animationRole": "state-emissive", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.25, 1.25, 0.4], "isTrigger": true, "notes": "Trigger volume in front of the emblem: this is where a runtime would detect the interact/open gesture."}, "constraints": [{"id": "emblem-state-machine", "type": "material-state", "states": ["dormant", "charging", "lit"], "restState": "lit", "notes": "The reference only documents the lit state; dormant/charging are inferred states a loot chest needs and drive emissiveIntensity, not geometry."}], "destruction": {"breakable": false, "fractureGroup": "emblem", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["crown-frame"] ?? root).add(node_crown_glow_28);
  nodes["crown-glow"] = node_crown_glow_28;
  const mesh_crown_glow_28Geometry = endpoint_crown_glow_28
    ? new THREE.CylinderGeometry(endpoint_crown_glow_28.endRadius, endpoint_crown_glow_28.baseRadius, endpoint_crown_glow_28.length, 16, 6)
    : buildExtrudeGeometry({"points": [[0.183, 0.056], [0.18072, 0.06748], [0.17421, 0.07721], [0.16448, 0.08372], [0.153, 0.086], [-0.153, 0.086], [-0.16448, 0.08372], [-0.17421, 0.07721], [-0.18072, 0.06748], [-0.183, 0.056], [-0.183, -0.056], [-0.18072, -0.06748], [-0.17421, -0.07721], [-0.16448, -0.08372], [-0.153, -0.086], [0.153, -0.086], [0.16448, -0.08372], [0.17421, -0.07721], [0.18072, -0.06748], [0.183, -0.056]], "depth": 0.04});
  if (!endpoint_crown_glow_28) {
    mesh_crown_glow_28Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_crown_glow_28 = new THREE.Mesh(
    mesh_crown_glow_28Geometry,
    materialMap["emblem-glow"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crown_glow_28.name = "Crown emblem lit core";
  if (endpoint_crown_glow_28) {
    mesh_crown_glow_28.position.copy(endpoint_crown_glow_28.midpoint);
    mesh_crown_glow_28.quaternion.copy(endpoint_crown_glow_28.quaternion);
  }
  mesh_crown_glow_28.castShadow = options.castShadow ?? true;
  mesh_crown_glow_28.receiveShadow = options.receiveShadow ?? true;
  mesh_crown_glow_28.userData.sculptComponent = {"id": "crown-glow", "name": "Crown emblem lit core", "level": "meso", "role": "emblem-core", "importance": 0.9, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Inside the gold frame sits a flat near-white field that reads as self-lit; it sits a hair behind the frame's front plane so the rim stays the brightest edge.", "geometryDescriptor": {"topologyIntent": "extruded rounded-rectangle field inside the frame aperture, self-lit", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "profile2D": {"points": [[0.183, 0.056], [0.18072, 0.06748], [0.17421, 0.07721], [0.16448, 0.08372], [0.153, 0.086], [-0.153, 0.086], [-0.16448, 0.08372], [-0.17421, 0.07721], [-0.18072, 0.06748], [-0.183, 0.056], [-0.183, -0.056], [-0.18072, -0.06748], [-0.17421, -0.07721], [-0.16448, -0.08372], [-0.153, -0.086], [0.153, -0.086], [0.16448, -0.08372], [0.17421, -0.07721], [0.18072, -0.06748], [0.183, -0.056]], "depth": 0.04}, "deformationStack": [], "uvStrategy": "extrude cap UVs", "normalStrategy": "flat emissive face"}, "parent": "crown-frame", "attachment": {"parentId": "crown-frame", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, -0.002], "localEnd": [0.0, 0.0, -0.002], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.03, "gapTolerance": 0.0, "note": "Lit field fills the frame aperture, inset by the rim width.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.366, "height": 0.172, "depth": 0.04, "units": "relative", "confidence": 0.7}, "transform": {"position": [0.0, 0.0, -0.004], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "state-emissive", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": false, "rotate": false, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1.25, 1.25, 0.4], "isTrigger": true, "notes": "Trigger volume in front of the emblem: this is where a runtime would detect the interact/open gesture."}, "constraints": [{"id": "emblem-state-machine", "type": "material-state", "states": ["dormant", "charging", "lit"], "restState": "lit", "notes": "The reference only documents the lit state; dormant/charging are inferred states a loot chest needs and drive emissiveIntensity, not geometry."}], "destruction": {"breakable": false, "fractureGroup": "emblem", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "emblem-glow", "materialLayers": ["emblem-glow"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 250, 220, 1.0)", "secondaryAlbedo": "rgba(255, 214, 96, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.45, "finish": "self-lit warm core reading as light spilling out of the emblem", "colorGradient": {"type": "radial", "axis": [0.5, 0.55], "stops": [{"offset": 0.0, "color": "rgba(255, 250, 220, 1.0)"}, {"offset": 1.0, "color": "rgba(255, 214, 96, 1.0)"}]}, "evidenceRefs": ["crown-emblem"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "emblem-core-emission", "kind": "emissive", "description": "Warm near-white self-lit field with a yellow falloff toward the frame.", "evidenceRefs": ["crown-emblem"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["crown-emblem"], "details": [], "fidelityTier": "form-refinement"};
  node_crown_glow_28.add(mesh_crown_glow_28);
  meshes["crown-glow"] = mesh_crown_glow_28;
  colliders["crown-glow"] = {"type": "box", "offset": [0, 0, 0], "scale": [1.25, 1.25, 0.4], "isTrigger": true, "notes": "Trigger volume in front of the emblem: this is where a runtime would detect the interact/open gesture."};
  destructionGroups["emblem"] ??= [];
  destructionGroups["emblem"].push(node_crown_glow_28);

  const attachment_crown_badge_29 = {"parentId": "crown-frame", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.016], "localEnd": [0.0, 0.0, 0.016], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Badge stands 0.014 proud of the lit field inside the frame aperture.", "evidenceRefs": ["full-object"]};
  const endpoint_crown_badge_29 = makeAttachmentEndpoint(attachment_crown_badge_29);
  const node_crown_badge_29 = new THREE.Group();
  node_crown_badge_29.name = "Crown badge__pivot";
  node_crown_badge_29.scale.set(1, 1, 1);
  if (endpoint_crown_badge_29) {
    node_crown_badge_29.position.copy(endpoint_crown_badge_29.start);
    node_crown_badge_29.rotation.set(-0.0, 0.0, -0.0);
  } else {
    node_crown_badge_29.position.set(0.0, -0.002, 0.016);
    node_crown_badge_29.rotation.set(-0.0, 0.0, -0.0);
  }
  node_crown_badge_29.userData.sculptComponent = {"id": "crown-badge", "name": "Crown badge", "level": "meso", "role": "emblem-badge", "importance": 0.9, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The crown itself is a solid gold badge floating on the lit field, three peaks over a wide base, backlit by the glow so its lower edge stays dark.", "geometryDescriptor": {"topologyIntent": "solid extruded crown silhouette reading dark-to-bright gold against the lit field", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.006, "segments": 1}, "profile2D": {"points": [[-0.12625, -0.05525], [-0.10352, -0.07013], [0.0, -0.0765], [0.10352, -0.07013], [0.12625, -0.05525], [0.14392, 0.07863], [0.05555, -0.01912], [0.0, 0.08925], [-0.05555, -0.01912], [-0.14392, 0.07863]], "depth": 0.026}, "deformationStack": [], "uvStrategy": "extrude cap UVs across the crown silhouette", "normalStrategy": "flat front face with hard side walls"}, "parent": "crown-frame", "attachment": {"parentId": "crown-frame", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.016], "localEnd": [0.0, 0.0, 0.016], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Badge stands 0.014 proud of the lit field inside the frame aperture.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2626, "height": 0.1351, "depth": 0.026, "units": "relative", "confidence": 0.7}, "transform": {"position": [0.0, -0.002, 0.016], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-emblem-badge", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "crown-badge-linework", "kind": "linework", "description": "Three peaks over a wide base with a notch between each peak.", "evidenceRefs": ["crown-emblem"]}, {"id": "crown-badge-backlight", "kind": "gradient", "description": "The glow behind the badge rims its silhouette and keeps its face darker than the frame.", "evidenceRefs": ["crown-emblem"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["crown-emblem", "front-face"], "details": [], "fidelityTier": "form-refinement"};
  node_crown_badge_29.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-emblem-badge", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["crown-frame"] ?? root).add(node_crown_badge_29);
  nodes["crown-badge"] = node_crown_badge_29;
  const mesh_crown_badge_29Geometry = endpoint_crown_badge_29
    ? new THREE.CylinderGeometry(endpoint_crown_badge_29.endRadius, endpoint_crown_badge_29.baseRadius, endpoint_crown_badge_29.length, 16, 6)
    : buildExtrudeGeometry({"points": [[-0.12625, -0.05525], [-0.10352, -0.07013], [0.0, -0.0765], [0.10352, -0.07013], [0.12625, -0.05525], [0.14392, 0.07863], [0.05555, -0.01912], [0.0, 0.08925], [-0.05555, -0.01912], [-0.14392, 0.07863]], "depth": 0.026});
  if (!endpoint_crown_badge_29) {
    mesh_crown_badge_29Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_crown_badge_29 = new THREE.Mesh(
    mesh_crown_badge_29Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crown_badge_29.name = "Crown badge";
  if (endpoint_crown_badge_29) {
    mesh_crown_badge_29.position.copy(endpoint_crown_badge_29.midpoint);
    mesh_crown_badge_29.quaternion.copy(endpoint_crown_badge_29.quaternion);
  }
  mesh_crown_badge_29.castShadow = options.castShadow ?? true;
  mesh_crown_badge_29.receiveShadow = options.receiveShadow ?? true;
  mesh_crown_badge_29.userData.sculptComponent = {"id": "crown-badge", "name": "Crown badge", "level": "meso", "role": "emblem-badge", "importance": 0.9, "confidence": 0.7, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The crown itself is a solid gold badge floating on the lit field, three peaks over a wide base, backlit by the glow so its lower edge stays dark.", "geometryDescriptor": {"topologyIntent": "solid extruded crown silhouette reading dark-to-bright gold against the lit field", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.006, "segments": 1}, "profile2D": {"points": [[-0.12625, -0.05525], [-0.10352, -0.07013], [0.0, -0.0765], [0.10352, -0.07013], [0.12625, -0.05525], [0.14392, 0.07863], [0.05555, -0.01912], [0.0, 0.08925], [-0.05555, -0.01912], [-0.14392, 0.07863]], "depth": 0.026}, "deformationStack": [], "uvStrategy": "extrude cap UVs across the crown silhouette", "normalStrategy": "flat front face with hard side walls"}, "parent": "crown-frame", "attachment": {"parentId": "crown-frame", "parentSocket": "front-panel-mount", "contactType": "surface-mount", "localStart": [0.0, 0.0, 0.016], "localEnd": [0.0, 0.0, 0.016], "contactNormal": [0.0, 0.0, 1.0], "embedDepth": 0.012, "gapTolerance": 0.0, "note": "Badge stands 0.014 proud of the lit field inside the frame aperture.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2626, "height": 0.1351, "depth": 0.026, "units": "relative", "confidence": 0.7}, "transform": {"position": [0.0, -0.002, 0.016], "rotation": [-0.0, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-emblem-badge", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "crown-badge-linework", "kind": "linework", "description": "Three peaks over a wide base with a notch between each peak.", "evidenceRefs": ["crown-emblem"]}, {"id": "crown-badge-backlight", "kind": "gradient", "description": "The glow behind the badge rims its silhouette and keeps its face darker than the frame.", "evidenceRefs": ["crown-emblem"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["crown-emblem", "front-face"], "details": [], "fidelityTier": "form-refinement"};
  node_crown_badge_29.add(mesh_crown_badge_29);
  meshes["crown-badge"] = mesh_crown_badge_29;
  colliders["crown-badge"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-emblem-badge"] ??= [];
  destructionGroups["chest-emblem-badge"].push(node_crown_badge_29);

  const attachment_grip_boss_front_30 = {"parentId": "body-shell", "parentSocket": "handle-mount", "contactType": "embedded-socket", "localStart": [-0.4775, -0.105, 0.3], "localEnd": [-0.5205, -0.105, 0.3], "contactNormal": [-1, 0, 0], "embedDepth": 0.012, "gapTolerance": 0.0, "baseRadius": 0.03, "endRadius": 0.03, "evidenceRefs": ["side-handle"]};
  const endpoint_grip_boss_front_30 = makeAttachmentEndpoint(attachment_grip_boss_front_30);
  const node_grip_boss_front_30 = new THREE.Group();
  node_grip_boss_front_30.name = "Handle boss front__pivot";
  node_grip_boss_front_30.scale.set(1, 1, 1);
  if (endpoint_grip_boss_front_30) {
    node_grip_boss_front_30.position.copy(endpoint_grip_boss_front_30.start);
    node_grip_boss_front_30.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_grip_boss_front_30.position.set(-0.4775, -0.105, 0.3);
    node_grip_boss_front_30.rotation.set(1.570796, 0.0, -0.0);
  }
  node_grip_boss_front_30.userData.sculptComponent = {"id": "grip-boss-front", "name": "Handle boss front", "level": "micro", "role": "connector", "importance": 0.5, "confidence": 0.5, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Two short round mounts stand proud of the left wall and carry the hanging grip; they are axial parts, so their solid is built between the measured endpoints.", "geometryDescriptor": {"topologyIntent": "short faceted cylindrical boss carrying the grip bar", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "cylinder UVs", "normalStrategy": "radial normals with a chamfered rim"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "handle-mount", "contactType": "embedded-socket", "localStart": [-0.4775, -0.105, 0.3], "localEnd": [-0.5205, -0.105, 0.3], "contactNormal": [-1, 0, 0], "embedDepth": 0.012, "gapTolerance": 0.0, "baseRadius": 0.03, "endRadius": 0.03, "evidenceRefs": ["side-handle"]}, "dimensions": {"radius": 0.03, "height": 0.043, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.4775, -0.105, 0.3], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "boss-rim-bevel", "kind": "bevel", "description": "Bright chamfer around the outer rim of the boss.", "evidenceRefs": ["side-handle"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["side-handle"], "details": [], "fidelityTier": "form-refinement"};
  node_grip_boss_front_30.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_grip_boss_front_30);
  nodes["grip-boss-front"] = node_grip_boss_front_30;
  const mesh_grip_boss_front_30Geometry = endpoint_grip_boss_front_30
    ? new THREE.CylinderGeometry(endpoint_grip_boss_front_30.endRadius, endpoint_grip_boss_front_30.baseRadius, endpoint_grip_boss_front_30.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_grip_boss_front_30) {
    mesh_grip_boss_front_30Geometry.scale(0.06, 0.043, 0.06);
  }
  const mesh_grip_boss_front_30 = new THREE.Mesh(
    mesh_grip_boss_front_30Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_boss_front_30.name = "Handle boss front";
  if (endpoint_grip_boss_front_30) {
    mesh_grip_boss_front_30.position.copy(endpoint_grip_boss_front_30.midpoint);
    mesh_grip_boss_front_30.quaternion.copy(endpoint_grip_boss_front_30.quaternion);
  }
  mesh_grip_boss_front_30.castShadow = options.castShadow ?? true;
  mesh_grip_boss_front_30.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_boss_front_30.userData.sculptComponent = {"id": "grip-boss-front", "name": "Handle boss front", "level": "micro", "role": "connector", "importance": 0.5, "confidence": 0.5, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Two short round mounts stand proud of the left wall and carry the hanging grip; they are axial parts, so their solid is built between the measured endpoints.", "geometryDescriptor": {"topologyIntent": "short faceted cylindrical boss carrying the grip bar", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "cylinder UVs", "normalStrategy": "radial normals with a chamfered rim"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "handle-mount", "contactType": "embedded-socket", "localStart": [-0.4775, -0.105, 0.3], "localEnd": [-0.5205, -0.105, 0.3], "contactNormal": [-1, 0, 0], "embedDepth": 0.012, "gapTolerance": 0.0, "baseRadius": 0.03, "endRadius": 0.03, "evidenceRefs": ["side-handle"]}, "dimensions": {"radius": 0.03, "height": 0.043, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.4775, -0.105, 0.3], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "boss-rim-bevel", "kind": "bevel", "description": "Bright chamfer around the outer rim of the boss.", "evidenceRefs": ["side-handle"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["side-handle"], "details": [], "fidelityTier": "form-refinement"};
  node_grip_boss_front_30.add(mesh_grip_boss_front_30);
  meshes["grip-boss-front"] = mesh_grip_boss_front_30;
  colliders["grip-boss-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-connector"] ??= [];
  destructionGroups["chest-connector"].push(node_grip_boss_front_30);

  const attachment_grip_boss_rear_31 = {"parentId": "body-shell", "parentSocket": "handle-mount", "contactType": "embedded-socket", "localStart": [-0.4775, 0.105, 0.3], "localEnd": [-0.5205, 0.105, 0.3], "contactNormal": [-1, 0, 0], "embedDepth": 0.012, "gapTolerance": 0.0, "baseRadius": 0.03, "endRadius": 0.03, "evidenceRefs": ["side-handle"]};
  const endpoint_grip_boss_rear_31 = makeAttachmentEndpoint(attachment_grip_boss_rear_31);
  const node_grip_boss_rear_31 = new THREE.Group();
  node_grip_boss_rear_31.name = "Handle boss rear__pivot";
  node_grip_boss_rear_31.scale.set(1, 1, 1);
  if (endpoint_grip_boss_rear_31) {
    node_grip_boss_rear_31.position.copy(endpoint_grip_boss_rear_31.start);
    node_grip_boss_rear_31.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_grip_boss_rear_31.position.set(-0.4775, 0.105, 0.3);
    node_grip_boss_rear_31.rotation.set(1.570796, 0.0, -0.0);
  }
  node_grip_boss_rear_31.userData.sculptComponent = {"id": "grip-boss-rear", "name": "Handle boss rear", "level": "micro", "role": "connector", "importance": 0.5, "confidence": 0.5, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Two short round mounts stand proud of the left wall and carry the hanging grip; they are axial parts, so their solid is built between the measured endpoints.", "geometryDescriptor": {"topologyIntent": "short faceted cylindrical boss carrying the grip bar", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "cylinder UVs", "normalStrategy": "radial normals with a chamfered rim"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "handle-mount", "contactType": "embedded-socket", "localStart": [-0.4775, 0.105, 0.3], "localEnd": [-0.5205, 0.105, 0.3], "contactNormal": [-1, 0, 0], "embedDepth": 0.012, "gapTolerance": 0.0, "baseRadius": 0.03, "endRadius": 0.03, "evidenceRefs": ["side-handle"]}, "dimensions": {"radius": 0.03, "height": 0.043, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.4775, 0.105, 0.3], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["side-handle"], "details": [], "fidelityTier": "form-refinement"};
  node_grip_boss_rear_31.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["body-shell"] ?? root).add(node_grip_boss_rear_31);
  nodes["grip-boss-rear"] = node_grip_boss_rear_31;
  const mesh_grip_boss_rear_31Geometry = endpoint_grip_boss_rear_31
    ? new THREE.CylinderGeometry(endpoint_grip_boss_rear_31.endRadius, endpoint_grip_boss_rear_31.baseRadius, endpoint_grip_boss_rear_31.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_grip_boss_rear_31) {
    mesh_grip_boss_rear_31Geometry.scale(0.06, 0.043, 0.06);
  }
  const mesh_grip_boss_rear_31 = new THREE.Mesh(
    mesh_grip_boss_rear_31Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_boss_rear_31.name = "Handle boss rear";
  if (endpoint_grip_boss_rear_31) {
    mesh_grip_boss_rear_31.position.copy(endpoint_grip_boss_rear_31.midpoint);
    mesh_grip_boss_rear_31.quaternion.copy(endpoint_grip_boss_rear_31.quaternion);
  }
  mesh_grip_boss_rear_31.castShadow = options.castShadow ?? true;
  mesh_grip_boss_rear_31.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_boss_rear_31.userData.sculptComponent = {"id": "grip-boss-rear", "name": "Handle boss rear", "level": "micro", "role": "connector", "importance": 0.5, "confidence": 0.5, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Two short round mounts stand proud of the left wall and carry the hanging grip; they are axial parts, so their solid is built between the measured endpoints.", "geometryDescriptor": {"topologyIntent": "short faceted cylindrical boss carrying the grip bar", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "cylinder UVs", "normalStrategy": "radial normals with a chamfered rim"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "handle-mount", "contactType": "embedded-socket", "localStart": [-0.4775, 0.105, 0.3], "localEnd": [-0.5205, 0.105, 0.3], "contactNormal": [-1, 0, 0], "embedDepth": 0.012, "gapTolerance": 0.0, "baseRadius": 0.03, "endRadius": 0.03, "evidenceRefs": ["side-handle"]}, "dimensions": {"radius": 0.03, "height": 0.043, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.4775, 0.105, 0.3], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["side-handle"], "details": [], "fidelityTier": "form-refinement"};
  node_grip_boss_rear_31.add(mesh_grip_boss_rear_31);
  meshes["grip-boss-rear"] = mesh_grip_boss_rear_31;
  colliders["grip-boss-rear"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-connector"] ??= [];
  destructionGroups["chest-connector"].push(node_grip_boss_rear_31);

  const attachment_grip_bar_32 = {"parentId": "body-shell", "parentSocket": "handle-mount", "contactType": "surface-mount", "localStart": [-0.5125, -0.105, 0.3], "localEnd": [-0.5125, -0.105, 0.3], "contactNormal": [-1.0, 0.0, 0.0], "embedDepth": 0.015, "gapTolerance": 0.0, "note": "Bar ends socket into both bosses. Coincident localStart/localEnd on purpose: distinct endpoints would replace the authored 3D sweep with a straight cylinder.", "evidenceRefs": ["full-object"]};
  const endpoint_grip_bar_32 = makeAttachmentEndpoint(attachment_grip_bar_32);
  const node_grip_bar_32 = new THREE.Group();
  node_grip_bar_32.name = "Side grip bar__pivot";
  node_grip_bar_32.scale.set(1, 1, 1);
  if (endpoint_grip_bar_32) {
    node_grip_bar_32.position.copy(endpoint_grip_bar_32.start);
    node_grip_bar_32.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_grip_bar_32.position.set(0.0, 0.0, 0.0);
    node_grip_bar_32.rotation.set(1.570796, 0.0, -0.0);
  }
  node_grip_bar_32.userData.sculptComponent = {"id": "grip-bar", "name": "Side grip bar", "level": "meso", "role": "handle", "importance": 0.6, "confidence": 0.5, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "A single round bar swept along a hanging U path; a flat extrude would only read correctly from the reference angle, so the path is authored in 3D.", "geometryDescriptor": {"topologyIntent": "round gold bar hanging in a squared U between the two bosses", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "tubePath": {"points": [[-0.5125, 0.3, 0.105], [-0.5345, 0.285, 0.112], [-0.5345, 0.205, 0.1], [-0.5345, 0.186, 0.0], [-0.5345, 0.205, -0.1], [-0.5345, 0.285, -0.112], [-0.5125, 0.3, -0.105]], "radius": 0.019, "closed": false}, "deformationStack": [], "uvStrategy": "tube UVs along the sweep", "normalStrategy": "swept radial normals"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "handle-mount", "contactType": "surface-mount", "localStart": [-0.5125, -0.105, 0.3], "localEnd": [-0.5125, -0.105, 0.3], "contactNormal": [-1.0, 0.0, 0.0], "embedDepth": 0.015, "gapTolerance": 0.0, "note": "Bar ends socket into both bosses. Coincident localStart/localEnd on purpose: distinct endpoints would replace the authored 3D sweep with a straight cylinder.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.06, "height": 0.12, "depth": 0.24, "units": "relative", "confidence": 0.45}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [1.570796, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "swing-handle", "pivot": {"mode": "boss-axis", "localPosition": [-0.5125, 0.3, 0.0], "axis": [0, 0, 1], "confidence": 0.55}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [-0.5345, 0.235, 0.0], "scale": [0.038, 0.038, 0.235], "isTrigger": false, "notes": "Capsule along the bar sweep; the visual tube is too dense for physics."}, "constraints": [{"id": "grip-swing-limit", "type": "hinge", "axis": [0, 0, 1], "minDegrees": -8.0, "maxDegrees": 42.0, "restDegrees": 0.0, "notes": "The bar hangs from the two bosses; it can be lifted towards the lid but the wall blocks it going the other way. Range inferred from the boss spacing."}], "destruction": {"breakable": true, "fractureGroup": "side-grip", "seamRefs": [], "detachableFragments": ["grip-bar"], "breakImpulse": 3.0, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "grip-bar-gloss", "kind": "gloss", "description": "Sharp moving highlight along the top of the round bar.", "evidenceRefs": ["side-handle"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["side-handle"], "details": [], "fidelityTier": "form-refinement"};
  node_grip_bar_32.userData.actionProfile = {"animationRole": "swing-handle", "pivot": {"mode": "boss-axis", "localPosition": [-0.5125, 0.3, 0.0], "axis": [0, 0, 1], "confidence": 0.55}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [-0.5345, 0.235, 0.0], "scale": [0.038, 0.038, 0.235], "isTrigger": false, "notes": "Capsule along the bar sweep; the visual tube is too dense for physics."}, "constraints": [{"id": "grip-swing-limit", "type": "hinge", "axis": [0, 0, 1], "minDegrees": -8.0, "maxDegrees": 42.0, "restDegrees": 0.0, "notes": "The bar hangs from the two bosses; it can be lifted towards the lid but the wall blocks it going the other way. Range inferred from the boss spacing."}], "destruction": {"breakable": true, "fractureGroup": "side-grip", "seamRefs": [], "detachableFragments": ["grip-bar"], "breakImpulse": 3.0, "debrisMaterial": "gold-trim"}};
  (nodes["body-shell"] ?? root).add(node_grip_bar_32);
  nodes["grip-bar"] = node_grip_bar_32;
  const mesh_grip_bar_32Geometry = endpoint_grip_bar_32
    ? new THREE.CylinderGeometry(endpoint_grip_bar_32.endRadius, endpoint_grip_bar_32.baseRadius, endpoint_grip_bar_32.length, 16, 6)
    : buildTubeGeometry({"points": [[-0.5125, 0.3, 0.105], [-0.5345, 0.285, 0.112], [-0.5345, 0.205, 0.1], [-0.5345, 0.186, 0.0], [-0.5345, 0.205, -0.1], [-0.5345, 0.285, -0.112], [-0.5125, 0.3, -0.105]], "radius": 0.019, "closed": false});
  if (!endpoint_grip_bar_32) {
    mesh_grip_bar_32Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_grip_bar_32 = new THREE.Mesh(
    mesh_grip_bar_32Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_grip_bar_32.name = "Side grip bar";
  if (endpoint_grip_bar_32) {
    mesh_grip_bar_32.position.copy(endpoint_grip_bar_32.midpoint);
    mesh_grip_bar_32.quaternion.copy(endpoint_grip_bar_32.quaternion);
  }
  mesh_grip_bar_32.castShadow = options.castShadow ?? true;
  mesh_grip_bar_32.receiveShadow = options.receiveShadow ?? true;
  mesh_grip_bar_32.userData.sculptComponent = {"id": "grip-bar", "name": "Side grip bar", "level": "meso", "role": "handle", "importance": 0.6, "confidence": 0.5, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "A single round bar swept along a hanging U path; a flat extrude would only read correctly from the reference angle, so the path is authored in 3D.", "geometryDescriptor": {"topologyIntent": "round gold bar hanging in a squared U between the two bosses", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "tubePath": {"points": [[-0.5125, 0.3, 0.105], [-0.5345, 0.285, 0.112], [-0.5345, 0.205, 0.1], [-0.5345, 0.186, 0.0], [-0.5345, 0.205, -0.1], [-0.5345, 0.285, -0.112], [-0.5125, 0.3, -0.105]], "radius": 0.019, "closed": false}, "deformationStack": [], "uvStrategy": "tube UVs along the sweep", "normalStrategy": "swept radial normals"}, "parent": "body-shell", "attachment": {"parentId": "body-shell", "parentSocket": "handle-mount", "contactType": "surface-mount", "localStart": [-0.5125, -0.105, 0.3], "localEnd": [-0.5125, -0.105, 0.3], "contactNormal": [-1.0, 0.0, 0.0], "embedDepth": 0.015, "gapTolerance": 0.0, "note": "Bar ends socket into both bosses. Coincident localStart/localEnd on purpose: distinct endpoints would replace the authored 3D sweep with a straight cylinder.", "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.06, "height": 0.12, "depth": 0.24, "units": "relative", "confidence": 0.45}, "transform": {"position": [0.0, 0.0, 0.0], "rotation": [1.570796, 0.0, -0.0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "swing-handle", "pivot": {"mode": "boss-axis", "localPosition": [-0.5125, 0.3, 0.0], "axis": [0, 0, 1], "confidence": 0.55}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [-0.5345, 0.235, 0.0], "scale": [0.038, 0.038, 0.235], "isTrigger": false, "notes": "Capsule along the bar sweep; the visual tube is too dense for physics."}, "constraints": [{"id": "grip-swing-limit", "type": "hinge", "axis": [0, 0, 1], "minDegrees": -8.0, "maxDegrees": 42.0, "restDegrees": 0.0, "notes": "The bar hangs from the two bosses; it can be lifted towards the lid but the wall blocks it going the other way. Range inferred from the boss spacing."}], "destruction": {"breakable": true, "fractureGroup": "side-grip", "seamRefs": [], "detachableFragments": ["grip-bar"], "breakImpulse": 3.0, "debrisMaterial": "gold-trim"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "grip-bar-gloss", "kind": "gloss", "description": "Sharp moving highlight along the top of the round bar.", "evidenceRefs": ["side-handle"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["side-handle"], "details": [], "fidelityTier": "form-refinement"};
  node_grip_bar_32.add(mesh_grip_bar_32);
  meshes["grip-bar"] = mesh_grip_bar_32;
  colliders["grip-bar"] = {"type": "capsule", "offset": [-0.5345, 0.235, 0.0], "scale": [0.038, 0.038, 0.235], "isTrigger": false, "notes": "Capsule along the bar sweep; the visual tube is too dense for physics."};
  destructionGroups["side-grip"] ??= [];
  destructionGroups["side-grip"].push(node_grip_bar_32);

  const attachment_hinge_barrel_33 = {"parentId": "lid-shell", "parentSocket": "hinge-barrel-mount", "contactType": "hinge-axis", "localStart": [-0.075, -0.103, 0.153], "localEnd": [0.075, -0.103, 0.153], "contactNormal": [0, 0, -1], "embedDepth": 0.02, "gapTolerance": 0.0, "baseRadius": 0.024, "endRadius": 0.024, "evidenceRefs": ["full-object"]};
  const endpoint_hinge_barrel_33 = makeAttachmentEndpoint(attachment_hinge_barrel_33);
  const node_hinge_barrel_33 = new THREE.Group();
  node_hinge_barrel_33.name = "Rear hinge barrel__pivot";
  node_hinge_barrel_33.scale.set(1, 1, 1);
  if (endpoint_hinge_barrel_33) {
    node_hinge_barrel_33.position.copy(endpoint_hinge_barrel_33.start);
    node_hinge_barrel_33.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_hinge_barrel_33.position.set(-0.075, -0.103, 0.153);
    node_hinge_barrel_33.rotation.set(1.570796, 0.0, -0.0);
  }
  node_hinge_barrel_33.userData.sculptComponent = {"id": "hinge-barrel", "name": "Rear hinge barrel", "level": "micro", "role": "hinge", "importance": 0.4, "confidence": 0.4, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A small gold fitting crosses the rear top edge of the lid; modelled as the hinge barrel it lands on the same axis the lid rotates about.", "geometryDescriptor": {"topologyIntent": "short gold barrel straddling the rear top edge", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "cylinder UVs", "normalStrategy": "radial normals"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "hinge-barrel-mount", "contactType": "hinge-axis", "localStart": [-0.075, -0.103, 0.153], "localEnd": [0.075, -0.103, 0.153], "contactNormal": [0, 0, -1], "embedDepth": 0.02, "gapTolerance": 0.0, "baseRadius": 0.024, "endRadius": 0.024, "evidenceRefs": ["full-object"]}, "dimensions": {"radius": 0.024, "height": 0.15, "units": "relative", "confidence": 0.4}, "transform": {"position": [-0.075, -0.103, 0.153], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-hinge", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "strap-edge-linework", "kind": "linework", "description": "Bright gold notch visible above the rear lid edge.", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_hinge_barrel_33.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-hinge", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["lid-shell"] ?? root).add(node_hinge_barrel_33);
  nodes["hinge-barrel"] = node_hinge_barrel_33;
  const mesh_hinge_barrel_33Geometry = endpoint_hinge_barrel_33
    ? new THREE.CylinderGeometry(endpoint_hinge_barrel_33.endRadius, endpoint_hinge_barrel_33.baseRadius, endpoint_hinge_barrel_33.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_hinge_barrel_33) {
    mesh_hinge_barrel_33Geometry.scale(0.048, 0.15, 0.048);
  }
  const mesh_hinge_barrel_33 = new THREE.Mesh(
    mesh_hinge_barrel_33Geometry,
    materialMap["gold-trim"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_hinge_barrel_33.name = "Rear hinge barrel";
  if (endpoint_hinge_barrel_33) {
    mesh_hinge_barrel_33.position.copy(endpoint_hinge_barrel_33.midpoint);
    mesh_hinge_barrel_33.quaternion.copy(endpoint_hinge_barrel_33.quaternion);
  }
  mesh_hinge_barrel_33.castShadow = options.castShadow ?? true;
  mesh_hinge_barrel_33.receiveShadow = options.receiveShadow ?? true;
  mesh_hinge_barrel_33.userData.sculptComponent = {"id": "hinge-barrel", "name": "Rear hinge barrel", "level": "micro", "role": "hinge", "importance": 0.4, "confidence": 0.4, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A small gold fitting crosses the rear top edge of the lid; modelled as the hinge barrel it lands on the same axis the lid rotates about.", "geometryDescriptor": {"topologyIntent": "short gold barrel straddling the rear top edge", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.004, "segments": 1}, "deformationStack": [], "uvStrategy": "cylinder UVs", "normalStrategy": "radial normals"}, "parent": "lid-shell", "attachment": {"parentId": "lid-shell", "parentSocket": "hinge-barrel-mount", "contactType": "hinge-axis", "localStart": [-0.075, -0.103, 0.153], "localEnd": [0.075, -0.103, 0.153], "contactNormal": [0, 0, -1], "embedDepth": 0.02, "gapTolerance": 0.0, "baseRadius": 0.024, "endRadius": 0.024, "evidenceRefs": ["full-object"]}, "dimensions": {"radius": 0.024, "height": 0.15, "units": "relative", "confidence": 0.4}, "transform": {"position": [-0.075, -0.103, 0.153], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "chest-hinge", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gold-trim", "materialLayers": ["gold-trim"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(219, 189, 65, 1.0)", "secondaryAlbedo": "rgba(179, 140, 11, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.9, "finish": "polished cast gold, hard specular bevel highlights", "colorGradient": {"type": "linear", "axis": [0.2, -0.98], "stops": [{"offset": 0.0, "color": "rgba(219, 189, 65, 1.0)"}, {"offset": 1.0, "color": "rgba(179, 140, 11, 1.0)"}]}, "evidenceRefs": ["corner-hardware", "side-handle"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "strap-edge-linework", "kind": "linework", "description": "Bright gold notch visible above the rear lid edge.", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "form-refinement"};
  node_hinge_barrel_33.add(mesh_hinge_barrel_33);
  meshes["hinge-barrel"] = mesh_hinge_barrel_33;
  colliders["hinge-barrel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Box proxy is adequate for this chamfered hard-surface part."};
  destructionGroups["chest-hinge"] ??= [];
  destructionGroups["chest-hinge"].push(node_hinge_barrel_33);

  const attachment_rivet_base_front_left_x_34 = null;
  const endpoint_rivet_base_front_left_x_34 = makeAttachmentEndpoint(attachment_rivet_base_front_left_x_34);
  const node_rivet_base_front_left_x_34 = new THREE.Group();
  node_rivet_base_front_left_x_34.name = "Rivet base-front-left-x__pivot";
  node_rivet_base_front_left_x_34.scale.set(1, 1, 1);
  if (endpoint_rivet_base_front_left_x_34) {
    node_rivet_base_front_left_x_34.position.copy(endpoint_rivet_base_front_left_x_34.start);
    node_rivet_base_front_left_x_34.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_base_front_left_x_34.position.set(-0.1185, -0.012, 0.108);
    node_rivet_base_front_left_x_34.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_base_front_left_x_34.userData.sculptComponent = {"id": "rivet-base-front-left-x", "name": "Rivet base-front-left-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-front-left", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.1185, -0.012, 0.108], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-left", "seamRefs": [], "detachableFragments": ["rivet-base-front-left-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rivet-heads", "kind": "fastener", "description": "Dark rivet heads sunk two-to-three per gold cap.", "evidenceRefs": ["corner-hardware"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_front_left_x_34.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-left", "seamRefs": [], "detachableFragments": ["rivet-base-front-left-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-base-front-left"] ?? root).add(node_rivet_base_front_left_x_34);
  nodes["rivet-base-front-left-x"] = node_rivet_base_front_left_x_34;
  const mesh_rivet_base_front_left_x_34Geometry = endpoint_rivet_base_front_left_x_34
    ? new THREE.CylinderGeometry(endpoint_rivet_base_front_left_x_34.endRadius, endpoint_rivet_base_front_left_x_34.baseRadius, endpoint_rivet_base_front_left_x_34.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_base_front_left_x_34) {
    mesh_rivet_base_front_left_x_34Geometry.scale(0.012, 0.034, 0.034);
  }
  const mesh_rivet_base_front_left_x_34 = new THREE.Mesh(
    mesh_rivet_base_front_left_x_34Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_base_front_left_x_34.name = "Rivet base-front-left-x";
  if (endpoint_rivet_base_front_left_x_34) {
    mesh_rivet_base_front_left_x_34.position.copy(endpoint_rivet_base_front_left_x_34.midpoint);
    mesh_rivet_base_front_left_x_34.quaternion.copy(endpoint_rivet_base_front_left_x_34.quaternion);
  }
  mesh_rivet_base_front_left_x_34.castShadow = options.castShadow ?? true;
  mesh_rivet_base_front_left_x_34.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_base_front_left_x_34.userData.sculptComponent = {"id": "rivet-base-front-left-x", "name": "Rivet base-front-left-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-front-left", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.1185, -0.012, 0.108], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-left", "seamRefs": [], "detachableFragments": ["rivet-base-front-left-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rivet-heads", "kind": "fastener", "description": "Dark rivet heads sunk two-to-three per gold cap.", "evidenceRefs": ["corner-hardware"]}], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_front_left_x_34.add(mesh_rivet_base_front_left_x_34);
  meshes["rivet-base-front-left-x"] = mesh_rivet_base_front_left_x_34;
  colliders["rivet-base-front-left-x"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-base-front-left"] ??= [];
  destructionGroups["corner-hardware-base-front-left"].push(node_rivet_base_front_left_x_34);

  const attachment_rivet_base_front_left_z_35 = null;
  const endpoint_rivet_base_front_left_z_35 = makeAttachmentEndpoint(attachment_rivet_base_front_left_z_35);
  const node_rivet_base_front_left_z_35 = new THREE.Group();
  node_rivet_base_front_left_z_35.name = "Rivet base-front-left-z__pivot";
  node_rivet_base_front_left_z_35.scale.set(1, 1, 1);
  if (endpoint_rivet_base_front_left_z_35) {
    node_rivet_base_front_left_z_35.position.copy(endpoint_rivet_base_front_left_z_35.start);
    node_rivet_base_front_left_z_35.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_base_front_left_z_35.position.set(-0.014, -0.106, 0.058);
    node_rivet_base_front_left_z_35.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_base_front_left_z_35.userData.sculptComponent = {"id": "rivet-base-front-left-z", "name": "Rivet base-front-left-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-front-left", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.014, -0.106, 0.058], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-left", "seamRefs": [], "detachableFragments": ["rivet-base-front-left-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_front_left_z_35.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-left", "seamRefs": [], "detachableFragments": ["rivet-base-front-left-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-base-front-left"] ?? root).add(node_rivet_base_front_left_z_35);
  nodes["rivet-base-front-left-z"] = node_rivet_base_front_left_z_35;
  const mesh_rivet_base_front_left_z_35Geometry = endpoint_rivet_base_front_left_z_35
    ? new THREE.CylinderGeometry(endpoint_rivet_base_front_left_z_35.endRadius, endpoint_rivet_base_front_left_z_35.baseRadius, endpoint_rivet_base_front_left_z_35.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_base_front_left_z_35) {
    mesh_rivet_base_front_left_z_35Geometry.scale(0.034, 0.034, 0.012);
  }
  const mesh_rivet_base_front_left_z_35 = new THREE.Mesh(
    mesh_rivet_base_front_left_z_35Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_base_front_left_z_35.name = "Rivet base-front-left-z";
  if (endpoint_rivet_base_front_left_z_35) {
    mesh_rivet_base_front_left_z_35.position.copy(endpoint_rivet_base_front_left_z_35.midpoint);
    mesh_rivet_base_front_left_z_35.quaternion.copy(endpoint_rivet_base_front_left_z_35.quaternion);
  }
  mesh_rivet_base_front_left_z_35.castShadow = options.castShadow ?? true;
  mesh_rivet_base_front_left_z_35.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_base_front_left_z_35.userData.sculptComponent = {"id": "rivet-base-front-left-z", "name": "Rivet base-front-left-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-front-left", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.014, -0.106, 0.058], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-left", "seamRefs": [], "detachableFragments": ["rivet-base-front-left-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_front_left_z_35.add(mesh_rivet_base_front_left_z_35);
  meshes["rivet-base-front-left-z"] = mesh_rivet_base_front_left_z_35;
  colliders["rivet-base-front-left-z"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-base-front-left"] ??= [];
  destructionGroups["corner-hardware-base-front-left"].push(node_rivet_base_front_left_z_35);

  const attachment_rivet_lid_front_left_x_36 = null;
  const endpoint_rivet_lid_front_left_x_36 = makeAttachmentEndpoint(attachment_rivet_lid_front_left_x_36);
  const node_rivet_lid_front_left_x_36 = new THREE.Group();
  node_rivet_lid_front_left_x_36.name = "Rivet lid-front-left-x__pivot";
  node_rivet_lid_front_left_x_36.scale.set(1, 1, 1);
  if (endpoint_rivet_lid_front_left_x_36) {
    node_rivet_lid_front_left_x_36.position.copy(endpoint_rivet_lid_front_left_x_36.start);
    node_rivet_lid_front_left_x_36.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_lid_front_left_x_36.position.set(-0.121, -0.014, 0.04);
    node_rivet_lid_front_left_x_36.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_lid_front_left_x_36.userData.sculptComponent = {"id": "rivet-lid-front-left-x", "name": "Rivet lid-front-left-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-front-left", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.121, -0.014, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-left", "seamRefs": [], "detachableFragments": ["rivet-lid-front-left-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_front_left_x_36.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-left", "seamRefs": [], "detachableFragments": ["rivet-lid-front-left-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-lid-front-left"] ?? root).add(node_rivet_lid_front_left_x_36);
  nodes["rivet-lid-front-left-x"] = node_rivet_lid_front_left_x_36;
  const mesh_rivet_lid_front_left_x_36Geometry = endpoint_rivet_lid_front_left_x_36
    ? new THREE.CylinderGeometry(endpoint_rivet_lid_front_left_x_36.endRadius, endpoint_rivet_lid_front_left_x_36.baseRadius, endpoint_rivet_lid_front_left_x_36.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_lid_front_left_x_36) {
    mesh_rivet_lid_front_left_x_36Geometry.scale(0.012, 0.034, 0.034);
  }
  const mesh_rivet_lid_front_left_x_36 = new THREE.Mesh(
    mesh_rivet_lid_front_left_x_36Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_lid_front_left_x_36.name = "Rivet lid-front-left-x";
  if (endpoint_rivet_lid_front_left_x_36) {
    mesh_rivet_lid_front_left_x_36.position.copy(endpoint_rivet_lid_front_left_x_36.midpoint);
    mesh_rivet_lid_front_left_x_36.quaternion.copy(endpoint_rivet_lid_front_left_x_36.quaternion);
  }
  mesh_rivet_lid_front_left_x_36.castShadow = options.castShadow ?? true;
  mesh_rivet_lid_front_left_x_36.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_lid_front_left_x_36.userData.sculptComponent = {"id": "rivet-lid-front-left-x", "name": "Rivet lid-front-left-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-front-left", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.121, -0.014, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-left", "seamRefs": [], "detachableFragments": ["rivet-lid-front-left-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_front_left_x_36.add(mesh_rivet_lid_front_left_x_36);
  meshes["rivet-lid-front-left-x"] = mesh_rivet_lid_front_left_x_36;
  colliders["rivet-lid-front-left-x"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-lid-front-left"] ??= [];
  destructionGroups["corner-hardware-lid-front-left"].push(node_rivet_lid_front_left_x_36);

  const attachment_rivet_lid_front_left_z_37 = null;
  const endpoint_rivet_lid_front_left_z_37 = makeAttachmentEndpoint(attachment_rivet_lid_front_left_z_37);
  const node_rivet_lid_front_left_z_37 = new THREE.Group();
  node_rivet_lid_front_left_z_37.name = "Rivet lid-front-left-z__pivot";
  node_rivet_lid_front_left_z_37.scale.set(1, 1, 1);
  if (endpoint_rivet_lid_front_left_z_37) {
    node_rivet_lid_front_left_z_37.position.copy(endpoint_rivet_lid_front_left_z_37.start);
    node_rivet_lid_front_left_z_37.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_lid_front_left_z_37.position.set(-0.016, -0.1085, 0.04);
    node_rivet_lid_front_left_z_37.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_lid_front_left_z_37.userData.sculptComponent = {"id": "rivet-lid-front-left-z", "name": "Rivet lid-front-left-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-front-left", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.016, -0.1085, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-left", "seamRefs": [], "detachableFragments": ["rivet-lid-front-left-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_front_left_z_37.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-left", "seamRefs": [], "detachableFragments": ["rivet-lid-front-left-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-lid-front-left"] ?? root).add(node_rivet_lid_front_left_z_37);
  nodes["rivet-lid-front-left-z"] = node_rivet_lid_front_left_z_37;
  const mesh_rivet_lid_front_left_z_37Geometry = endpoint_rivet_lid_front_left_z_37
    ? new THREE.CylinderGeometry(endpoint_rivet_lid_front_left_z_37.endRadius, endpoint_rivet_lid_front_left_z_37.baseRadius, endpoint_rivet_lid_front_left_z_37.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_lid_front_left_z_37) {
    mesh_rivet_lid_front_left_z_37Geometry.scale(0.034, 0.034, 0.012);
  }
  const mesh_rivet_lid_front_left_z_37 = new THREE.Mesh(
    mesh_rivet_lid_front_left_z_37Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_lid_front_left_z_37.name = "Rivet lid-front-left-z";
  if (endpoint_rivet_lid_front_left_z_37) {
    mesh_rivet_lid_front_left_z_37.position.copy(endpoint_rivet_lid_front_left_z_37.midpoint);
    mesh_rivet_lid_front_left_z_37.quaternion.copy(endpoint_rivet_lid_front_left_z_37.quaternion);
  }
  mesh_rivet_lid_front_left_z_37.castShadow = options.castShadow ?? true;
  mesh_rivet_lid_front_left_z_37.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_lid_front_left_z_37.userData.sculptComponent = {"id": "rivet-lid-front-left-z", "name": "Rivet lid-front-left-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-front-left", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.016, -0.1085, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-left", "seamRefs": [], "detachableFragments": ["rivet-lid-front-left-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_front_left_z_37.add(mesh_rivet_lid_front_left_z_37);
  meshes["rivet-lid-front-left-z"] = mesh_rivet_lid_front_left_z_37;
  colliders["rivet-lid-front-left-z"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-lid-front-left"] ??= [];
  destructionGroups["corner-hardware-lid-front-left"].push(node_rivet_lid_front_left_z_37);

  const attachment_rivet_lid_front_left_top_38 = null;
  const endpoint_rivet_lid_front_left_top_38 = makeAttachmentEndpoint(attachment_rivet_lid_front_left_top_38);
  const node_rivet_lid_front_left_top_38 = new THREE.Group();
  node_rivet_lid_front_left_top_38.name = "Rivet lid-front-left-top__pivot";
  node_rivet_lid_front_left_top_38.scale.set(1, 1, 1);
  if (endpoint_rivet_lid_front_left_top_38) {
    node_rivet_lid_front_left_top_38.position.copy(endpoint_rivet_lid_front_left_top_38.start);
    node_rivet_lid_front_left_top_38.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_lid_front_left_top_38.position.set(-0.03, -0.03, 0.155);
    node_rivet_lid_front_left_top_38.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_lid_front_left_top_38.userData.sculptComponent = {"id": "rivet-lid-front-left-top", "name": "Rivet lid-front-left-top", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-front-left", "attachment": null, "dimensions": {"width": 0.034, "height": 0.012, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.03, -0.03, 0.155], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-left", "seamRefs": [], "detachableFragments": ["rivet-lid-front-left-top"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_front_left_top_38.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-left", "seamRefs": [], "detachableFragments": ["rivet-lid-front-left-top"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-lid-front-left"] ?? root).add(node_rivet_lid_front_left_top_38);
  nodes["rivet-lid-front-left-top"] = node_rivet_lid_front_left_top_38;
  const mesh_rivet_lid_front_left_top_38Geometry = endpoint_rivet_lid_front_left_top_38
    ? new THREE.CylinderGeometry(endpoint_rivet_lid_front_left_top_38.endRadius, endpoint_rivet_lid_front_left_top_38.baseRadius, endpoint_rivet_lid_front_left_top_38.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_lid_front_left_top_38) {
    mesh_rivet_lid_front_left_top_38Geometry.scale(0.034, 0.012, 0.034);
  }
  const mesh_rivet_lid_front_left_top_38 = new THREE.Mesh(
    mesh_rivet_lid_front_left_top_38Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_lid_front_left_top_38.name = "Rivet lid-front-left-top";
  if (endpoint_rivet_lid_front_left_top_38) {
    mesh_rivet_lid_front_left_top_38.position.copy(endpoint_rivet_lid_front_left_top_38.midpoint);
    mesh_rivet_lid_front_left_top_38.quaternion.copy(endpoint_rivet_lid_front_left_top_38.quaternion);
  }
  mesh_rivet_lid_front_left_top_38.castShadow = options.castShadow ?? true;
  mesh_rivet_lid_front_left_top_38.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_lid_front_left_top_38.userData.sculptComponent = {"id": "rivet-lid-front-left-top", "name": "Rivet lid-front-left-top", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-front-left", "attachment": null, "dimensions": {"width": 0.034, "height": 0.012, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.03, -0.03, 0.155], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-left", "seamRefs": [], "detachableFragments": ["rivet-lid-front-left-top"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_front_left_top_38.add(mesh_rivet_lid_front_left_top_38);
  meshes["rivet-lid-front-left-top"] = mesh_rivet_lid_front_left_top_38;
  colliders["rivet-lid-front-left-top"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-lid-front-left"] ??= [];
  destructionGroups["corner-hardware-lid-front-left"].push(node_rivet_lid_front_left_top_38);

  const attachment_rivet_base_rear_left_x_39 = null;
  const endpoint_rivet_base_rear_left_x_39 = makeAttachmentEndpoint(attachment_rivet_base_rear_left_x_39);
  const node_rivet_base_rear_left_x_39 = new THREE.Group();
  node_rivet_base_rear_left_x_39.name = "Rivet base-rear-left-x__pivot";
  node_rivet_base_rear_left_x_39.scale.set(1, 1, 1);
  if (endpoint_rivet_base_rear_left_x_39) {
    node_rivet_base_rear_left_x_39.position.copy(endpoint_rivet_base_rear_left_x_39.start);
    node_rivet_base_rear_left_x_39.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_base_rear_left_x_39.position.set(-0.1185, 0.012, 0.108);
    node_rivet_base_rear_left_x_39.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_base_rear_left_x_39.userData.sculptComponent = {"id": "rivet-base-rear-left-x", "name": "Rivet base-rear-left-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-rear-left", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.1185, 0.012, 0.108], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-left", "seamRefs": [], "detachableFragments": ["rivet-base-rear-left-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_rear_left_x_39.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-left", "seamRefs": [], "detachableFragments": ["rivet-base-rear-left-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-base-rear-left"] ?? root).add(node_rivet_base_rear_left_x_39);
  nodes["rivet-base-rear-left-x"] = node_rivet_base_rear_left_x_39;
  const mesh_rivet_base_rear_left_x_39Geometry = endpoint_rivet_base_rear_left_x_39
    ? new THREE.CylinderGeometry(endpoint_rivet_base_rear_left_x_39.endRadius, endpoint_rivet_base_rear_left_x_39.baseRadius, endpoint_rivet_base_rear_left_x_39.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_base_rear_left_x_39) {
    mesh_rivet_base_rear_left_x_39Geometry.scale(0.012, 0.034, 0.034);
  }
  const mesh_rivet_base_rear_left_x_39 = new THREE.Mesh(
    mesh_rivet_base_rear_left_x_39Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_base_rear_left_x_39.name = "Rivet base-rear-left-x";
  if (endpoint_rivet_base_rear_left_x_39) {
    mesh_rivet_base_rear_left_x_39.position.copy(endpoint_rivet_base_rear_left_x_39.midpoint);
    mesh_rivet_base_rear_left_x_39.quaternion.copy(endpoint_rivet_base_rear_left_x_39.quaternion);
  }
  mesh_rivet_base_rear_left_x_39.castShadow = options.castShadow ?? true;
  mesh_rivet_base_rear_left_x_39.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_base_rear_left_x_39.userData.sculptComponent = {"id": "rivet-base-rear-left-x", "name": "Rivet base-rear-left-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-rear-left", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.1185, 0.012, 0.108], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-left", "seamRefs": [], "detachableFragments": ["rivet-base-rear-left-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_rear_left_x_39.add(mesh_rivet_base_rear_left_x_39);
  meshes["rivet-base-rear-left-x"] = mesh_rivet_base_rear_left_x_39;
  colliders["rivet-base-rear-left-x"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-base-rear-left"] ??= [];
  destructionGroups["corner-hardware-base-rear-left"].push(node_rivet_base_rear_left_x_39);

  const attachment_rivet_base_rear_left_z_40 = null;
  const endpoint_rivet_base_rear_left_z_40 = makeAttachmentEndpoint(attachment_rivet_base_rear_left_z_40);
  const node_rivet_base_rear_left_z_40 = new THREE.Group();
  node_rivet_base_rear_left_z_40.name = "Rivet base-rear-left-z__pivot";
  node_rivet_base_rear_left_z_40.scale.set(1, 1, 1);
  if (endpoint_rivet_base_rear_left_z_40) {
    node_rivet_base_rear_left_z_40.position.copy(endpoint_rivet_base_rear_left_z_40.start);
    node_rivet_base_rear_left_z_40.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_base_rear_left_z_40.position.set(-0.014, 0.106, 0.058);
    node_rivet_base_rear_left_z_40.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_base_rear_left_z_40.userData.sculptComponent = {"id": "rivet-base-rear-left-z", "name": "Rivet base-rear-left-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-rear-left", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.014, 0.106, 0.058], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-left", "seamRefs": [], "detachableFragments": ["rivet-base-rear-left-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_rear_left_z_40.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-left", "seamRefs": [], "detachableFragments": ["rivet-base-rear-left-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-base-rear-left"] ?? root).add(node_rivet_base_rear_left_z_40);
  nodes["rivet-base-rear-left-z"] = node_rivet_base_rear_left_z_40;
  const mesh_rivet_base_rear_left_z_40Geometry = endpoint_rivet_base_rear_left_z_40
    ? new THREE.CylinderGeometry(endpoint_rivet_base_rear_left_z_40.endRadius, endpoint_rivet_base_rear_left_z_40.baseRadius, endpoint_rivet_base_rear_left_z_40.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_base_rear_left_z_40) {
    mesh_rivet_base_rear_left_z_40Geometry.scale(0.034, 0.034, 0.012);
  }
  const mesh_rivet_base_rear_left_z_40 = new THREE.Mesh(
    mesh_rivet_base_rear_left_z_40Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_base_rear_left_z_40.name = "Rivet base-rear-left-z";
  if (endpoint_rivet_base_rear_left_z_40) {
    mesh_rivet_base_rear_left_z_40.position.copy(endpoint_rivet_base_rear_left_z_40.midpoint);
    mesh_rivet_base_rear_left_z_40.quaternion.copy(endpoint_rivet_base_rear_left_z_40.quaternion);
  }
  mesh_rivet_base_rear_left_z_40.castShadow = options.castShadow ?? true;
  mesh_rivet_base_rear_left_z_40.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_base_rear_left_z_40.userData.sculptComponent = {"id": "rivet-base-rear-left-z", "name": "Rivet base-rear-left-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-rear-left", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.014, 0.106, 0.058], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-left", "seamRefs": [], "detachableFragments": ["rivet-base-rear-left-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_rear_left_z_40.add(mesh_rivet_base_rear_left_z_40);
  meshes["rivet-base-rear-left-z"] = mesh_rivet_base_rear_left_z_40;
  colliders["rivet-base-rear-left-z"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-base-rear-left"] ??= [];
  destructionGroups["corner-hardware-base-rear-left"].push(node_rivet_base_rear_left_z_40);

  const attachment_rivet_lid_rear_left_x_41 = null;
  const endpoint_rivet_lid_rear_left_x_41 = makeAttachmentEndpoint(attachment_rivet_lid_rear_left_x_41);
  const node_rivet_lid_rear_left_x_41 = new THREE.Group();
  node_rivet_lid_rear_left_x_41.name = "Rivet lid-rear-left-x__pivot";
  node_rivet_lid_rear_left_x_41.scale.set(1, 1, 1);
  if (endpoint_rivet_lid_rear_left_x_41) {
    node_rivet_lid_rear_left_x_41.position.copy(endpoint_rivet_lid_rear_left_x_41.start);
    node_rivet_lid_rear_left_x_41.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_lid_rear_left_x_41.position.set(-0.121, 0.014, 0.04);
    node_rivet_lid_rear_left_x_41.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_lid_rear_left_x_41.userData.sculptComponent = {"id": "rivet-lid-rear-left-x", "name": "Rivet lid-rear-left-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-rear-left", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.121, 0.014, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-left", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-left-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_rear_left_x_41.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-left", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-left-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-lid-rear-left"] ?? root).add(node_rivet_lid_rear_left_x_41);
  nodes["rivet-lid-rear-left-x"] = node_rivet_lid_rear_left_x_41;
  const mesh_rivet_lid_rear_left_x_41Geometry = endpoint_rivet_lid_rear_left_x_41
    ? new THREE.CylinderGeometry(endpoint_rivet_lid_rear_left_x_41.endRadius, endpoint_rivet_lid_rear_left_x_41.baseRadius, endpoint_rivet_lid_rear_left_x_41.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_lid_rear_left_x_41) {
    mesh_rivet_lid_rear_left_x_41Geometry.scale(0.012, 0.034, 0.034);
  }
  const mesh_rivet_lid_rear_left_x_41 = new THREE.Mesh(
    mesh_rivet_lid_rear_left_x_41Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_lid_rear_left_x_41.name = "Rivet lid-rear-left-x";
  if (endpoint_rivet_lid_rear_left_x_41) {
    mesh_rivet_lid_rear_left_x_41.position.copy(endpoint_rivet_lid_rear_left_x_41.midpoint);
    mesh_rivet_lid_rear_left_x_41.quaternion.copy(endpoint_rivet_lid_rear_left_x_41.quaternion);
  }
  mesh_rivet_lid_rear_left_x_41.castShadow = options.castShadow ?? true;
  mesh_rivet_lid_rear_left_x_41.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_lid_rear_left_x_41.userData.sculptComponent = {"id": "rivet-lid-rear-left-x", "name": "Rivet lid-rear-left-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-rear-left", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.121, 0.014, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-left", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-left-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_rear_left_x_41.add(mesh_rivet_lid_rear_left_x_41);
  meshes["rivet-lid-rear-left-x"] = mesh_rivet_lid_rear_left_x_41;
  colliders["rivet-lid-rear-left-x"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-lid-rear-left"] ??= [];
  destructionGroups["corner-hardware-lid-rear-left"].push(node_rivet_lid_rear_left_x_41);

  const attachment_rivet_lid_rear_left_z_42 = null;
  const endpoint_rivet_lid_rear_left_z_42 = makeAttachmentEndpoint(attachment_rivet_lid_rear_left_z_42);
  const node_rivet_lid_rear_left_z_42 = new THREE.Group();
  node_rivet_lid_rear_left_z_42.name = "Rivet lid-rear-left-z__pivot";
  node_rivet_lid_rear_left_z_42.scale.set(1, 1, 1);
  if (endpoint_rivet_lid_rear_left_z_42) {
    node_rivet_lid_rear_left_z_42.position.copy(endpoint_rivet_lid_rear_left_z_42.start);
    node_rivet_lid_rear_left_z_42.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_lid_rear_left_z_42.position.set(-0.016, 0.1085, 0.04);
    node_rivet_lid_rear_left_z_42.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_lid_rear_left_z_42.userData.sculptComponent = {"id": "rivet-lid-rear-left-z", "name": "Rivet lid-rear-left-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-rear-left", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.016, 0.1085, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-left", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-left-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_rear_left_z_42.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-left", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-left-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-lid-rear-left"] ?? root).add(node_rivet_lid_rear_left_z_42);
  nodes["rivet-lid-rear-left-z"] = node_rivet_lid_rear_left_z_42;
  const mesh_rivet_lid_rear_left_z_42Geometry = endpoint_rivet_lid_rear_left_z_42
    ? new THREE.CylinderGeometry(endpoint_rivet_lid_rear_left_z_42.endRadius, endpoint_rivet_lid_rear_left_z_42.baseRadius, endpoint_rivet_lid_rear_left_z_42.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_lid_rear_left_z_42) {
    mesh_rivet_lid_rear_left_z_42Geometry.scale(0.034, 0.034, 0.012);
  }
  const mesh_rivet_lid_rear_left_z_42 = new THREE.Mesh(
    mesh_rivet_lid_rear_left_z_42Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_lid_rear_left_z_42.name = "Rivet lid-rear-left-z";
  if (endpoint_rivet_lid_rear_left_z_42) {
    mesh_rivet_lid_rear_left_z_42.position.copy(endpoint_rivet_lid_rear_left_z_42.midpoint);
    mesh_rivet_lid_rear_left_z_42.quaternion.copy(endpoint_rivet_lid_rear_left_z_42.quaternion);
  }
  mesh_rivet_lid_rear_left_z_42.castShadow = options.castShadow ?? true;
  mesh_rivet_lid_rear_left_z_42.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_lid_rear_left_z_42.userData.sculptComponent = {"id": "rivet-lid-rear-left-z", "name": "Rivet lid-rear-left-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-rear-left", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.016, 0.1085, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-left", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-left-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_rear_left_z_42.add(mesh_rivet_lid_rear_left_z_42);
  meshes["rivet-lid-rear-left-z"] = mesh_rivet_lid_rear_left_z_42;
  colliders["rivet-lid-rear-left-z"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-lid-rear-left"] ??= [];
  destructionGroups["corner-hardware-lid-rear-left"].push(node_rivet_lid_rear_left_z_42);

  const attachment_rivet_lid_rear_left_top_43 = null;
  const endpoint_rivet_lid_rear_left_top_43 = makeAttachmentEndpoint(attachment_rivet_lid_rear_left_top_43);
  const node_rivet_lid_rear_left_top_43 = new THREE.Group();
  node_rivet_lid_rear_left_top_43.name = "Rivet lid-rear-left-top__pivot";
  node_rivet_lid_rear_left_top_43.scale.set(1, 1, 1);
  if (endpoint_rivet_lid_rear_left_top_43) {
    node_rivet_lid_rear_left_top_43.position.copy(endpoint_rivet_lid_rear_left_top_43.start);
    node_rivet_lid_rear_left_top_43.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_lid_rear_left_top_43.position.set(-0.03, 0.03, 0.155);
    node_rivet_lid_rear_left_top_43.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_lid_rear_left_top_43.userData.sculptComponent = {"id": "rivet-lid-rear-left-top", "name": "Rivet lid-rear-left-top", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-rear-left", "attachment": null, "dimensions": {"width": 0.034, "height": 0.012, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.03, 0.03, 0.155], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-left", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-left-top"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_rear_left_top_43.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-left", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-left-top"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-lid-rear-left"] ?? root).add(node_rivet_lid_rear_left_top_43);
  nodes["rivet-lid-rear-left-top"] = node_rivet_lid_rear_left_top_43;
  const mesh_rivet_lid_rear_left_top_43Geometry = endpoint_rivet_lid_rear_left_top_43
    ? new THREE.CylinderGeometry(endpoint_rivet_lid_rear_left_top_43.endRadius, endpoint_rivet_lid_rear_left_top_43.baseRadius, endpoint_rivet_lid_rear_left_top_43.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_lid_rear_left_top_43) {
    mesh_rivet_lid_rear_left_top_43Geometry.scale(0.034, 0.012, 0.034);
  }
  const mesh_rivet_lid_rear_left_top_43 = new THREE.Mesh(
    mesh_rivet_lid_rear_left_top_43Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_lid_rear_left_top_43.name = "Rivet lid-rear-left-top";
  if (endpoint_rivet_lid_rear_left_top_43) {
    mesh_rivet_lid_rear_left_top_43.position.copy(endpoint_rivet_lid_rear_left_top_43.midpoint);
    mesh_rivet_lid_rear_left_top_43.quaternion.copy(endpoint_rivet_lid_rear_left_top_43.quaternion);
  }
  mesh_rivet_lid_rear_left_top_43.castShadow = options.castShadow ?? true;
  mesh_rivet_lid_rear_left_top_43.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_lid_rear_left_top_43.userData.sculptComponent = {"id": "rivet-lid-rear-left-top", "name": "Rivet lid-rear-left-top", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-rear-left", "attachment": null, "dimensions": {"width": 0.034, "height": 0.012, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [-0.03, 0.03, 0.155], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-left", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-left-top"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_rear_left_top_43.add(mesh_rivet_lid_rear_left_top_43);
  meshes["rivet-lid-rear-left-top"] = mesh_rivet_lid_rear_left_top_43;
  colliders["rivet-lid-rear-left-top"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-lid-rear-left"] ??= [];
  destructionGroups["corner-hardware-lid-rear-left"].push(node_rivet_lid_rear_left_top_43);

  const attachment_rivet_base_front_right_x_44 = null;
  const endpoint_rivet_base_front_right_x_44 = makeAttachmentEndpoint(attachment_rivet_base_front_right_x_44);
  const node_rivet_base_front_right_x_44 = new THREE.Group();
  node_rivet_base_front_right_x_44.name = "Rivet base-front-right-x__pivot";
  node_rivet_base_front_right_x_44.scale.set(1, 1, 1);
  if (endpoint_rivet_base_front_right_x_44) {
    node_rivet_base_front_right_x_44.position.copy(endpoint_rivet_base_front_right_x_44.start);
    node_rivet_base_front_right_x_44.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_base_front_right_x_44.position.set(0.1185, -0.012, 0.108);
    node_rivet_base_front_right_x_44.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_base_front_right_x_44.userData.sculptComponent = {"id": "rivet-base-front-right-x", "name": "Rivet base-front-right-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-front-right", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.1185, -0.012, 0.108], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-right", "seamRefs": [], "detachableFragments": ["rivet-base-front-right-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_front_right_x_44.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-right", "seamRefs": [], "detachableFragments": ["rivet-base-front-right-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-base-front-right"] ?? root).add(node_rivet_base_front_right_x_44);
  nodes["rivet-base-front-right-x"] = node_rivet_base_front_right_x_44;
  const mesh_rivet_base_front_right_x_44Geometry = endpoint_rivet_base_front_right_x_44
    ? new THREE.CylinderGeometry(endpoint_rivet_base_front_right_x_44.endRadius, endpoint_rivet_base_front_right_x_44.baseRadius, endpoint_rivet_base_front_right_x_44.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_base_front_right_x_44) {
    mesh_rivet_base_front_right_x_44Geometry.scale(0.012, 0.034, 0.034);
  }
  const mesh_rivet_base_front_right_x_44 = new THREE.Mesh(
    mesh_rivet_base_front_right_x_44Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_base_front_right_x_44.name = "Rivet base-front-right-x";
  if (endpoint_rivet_base_front_right_x_44) {
    mesh_rivet_base_front_right_x_44.position.copy(endpoint_rivet_base_front_right_x_44.midpoint);
    mesh_rivet_base_front_right_x_44.quaternion.copy(endpoint_rivet_base_front_right_x_44.quaternion);
  }
  mesh_rivet_base_front_right_x_44.castShadow = options.castShadow ?? true;
  mesh_rivet_base_front_right_x_44.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_base_front_right_x_44.userData.sculptComponent = {"id": "rivet-base-front-right-x", "name": "Rivet base-front-right-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-front-right", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.1185, -0.012, 0.108], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-right", "seamRefs": [], "detachableFragments": ["rivet-base-front-right-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_front_right_x_44.add(mesh_rivet_base_front_right_x_44);
  meshes["rivet-base-front-right-x"] = mesh_rivet_base_front_right_x_44;
  colliders["rivet-base-front-right-x"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-base-front-right"] ??= [];
  destructionGroups["corner-hardware-base-front-right"].push(node_rivet_base_front_right_x_44);

  const attachment_rivet_base_front_right_z_45 = null;
  const endpoint_rivet_base_front_right_z_45 = makeAttachmentEndpoint(attachment_rivet_base_front_right_z_45);
  const node_rivet_base_front_right_z_45 = new THREE.Group();
  node_rivet_base_front_right_z_45.name = "Rivet base-front-right-z__pivot";
  node_rivet_base_front_right_z_45.scale.set(1, 1, 1);
  if (endpoint_rivet_base_front_right_z_45) {
    node_rivet_base_front_right_z_45.position.copy(endpoint_rivet_base_front_right_z_45.start);
    node_rivet_base_front_right_z_45.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_base_front_right_z_45.position.set(0.014, -0.106, 0.058);
    node_rivet_base_front_right_z_45.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_base_front_right_z_45.userData.sculptComponent = {"id": "rivet-base-front-right-z", "name": "Rivet base-front-right-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-front-right", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.014, -0.106, 0.058], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-right", "seamRefs": [], "detachableFragments": ["rivet-base-front-right-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_front_right_z_45.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-right", "seamRefs": [], "detachableFragments": ["rivet-base-front-right-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-base-front-right"] ?? root).add(node_rivet_base_front_right_z_45);
  nodes["rivet-base-front-right-z"] = node_rivet_base_front_right_z_45;
  const mesh_rivet_base_front_right_z_45Geometry = endpoint_rivet_base_front_right_z_45
    ? new THREE.CylinderGeometry(endpoint_rivet_base_front_right_z_45.endRadius, endpoint_rivet_base_front_right_z_45.baseRadius, endpoint_rivet_base_front_right_z_45.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_base_front_right_z_45) {
    mesh_rivet_base_front_right_z_45Geometry.scale(0.034, 0.034, 0.012);
  }
  const mesh_rivet_base_front_right_z_45 = new THREE.Mesh(
    mesh_rivet_base_front_right_z_45Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_base_front_right_z_45.name = "Rivet base-front-right-z";
  if (endpoint_rivet_base_front_right_z_45) {
    mesh_rivet_base_front_right_z_45.position.copy(endpoint_rivet_base_front_right_z_45.midpoint);
    mesh_rivet_base_front_right_z_45.quaternion.copy(endpoint_rivet_base_front_right_z_45.quaternion);
  }
  mesh_rivet_base_front_right_z_45.castShadow = options.castShadow ?? true;
  mesh_rivet_base_front_right_z_45.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_base_front_right_z_45.userData.sculptComponent = {"id": "rivet-base-front-right-z", "name": "Rivet base-front-right-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-front-right", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.014, -0.106, 0.058], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-front-right", "seamRefs": [], "detachableFragments": ["rivet-base-front-right-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_front_right_z_45.add(mesh_rivet_base_front_right_z_45);
  meshes["rivet-base-front-right-z"] = mesh_rivet_base_front_right_z_45;
  colliders["rivet-base-front-right-z"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-base-front-right"] ??= [];
  destructionGroups["corner-hardware-base-front-right"].push(node_rivet_base_front_right_z_45);

  const attachment_rivet_lid_front_right_x_46 = null;
  const endpoint_rivet_lid_front_right_x_46 = makeAttachmentEndpoint(attachment_rivet_lid_front_right_x_46);
  const node_rivet_lid_front_right_x_46 = new THREE.Group();
  node_rivet_lid_front_right_x_46.name = "Rivet lid-front-right-x__pivot";
  node_rivet_lid_front_right_x_46.scale.set(1, 1, 1);
  if (endpoint_rivet_lid_front_right_x_46) {
    node_rivet_lid_front_right_x_46.position.copy(endpoint_rivet_lid_front_right_x_46.start);
    node_rivet_lid_front_right_x_46.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_lid_front_right_x_46.position.set(0.121, -0.014, 0.04);
    node_rivet_lid_front_right_x_46.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_lid_front_right_x_46.userData.sculptComponent = {"id": "rivet-lid-front-right-x", "name": "Rivet lid-front-right-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-front-right", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.121, -0.014, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-right", "seamRefs": [], "detachableFragments": ["rivet-lid-front-right-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_front_right_x_46.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-right", "seamRefs": [], "detachableFragments": ["rivet-lid-front-right-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-lid-front-right"] ?? root).add(node_rivet_lid_front_right_x_46);
  nodes["rivet-lid-front-right-x"] = node_rivet_lid_front_right_x_46;
  const mesh_rivet_lid_front_right_x_46Geometry = endpoint_rivet_lid_front_right_x_46
    ? new THREE.CylinderGeometry(endpoint_rivet_lid_front_right_x_46.endRadius, endpoint_rivet_lid_front_right_x_46.baseRadius, endpoint_rivet_lid_front_right_x_46.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_lid_front_right_x_46) {
    mesh_rivet_lid_front_right_x_46Geometry.scale(0.012, 0.034, 0.034);
  }
  const mesh_rivet_lid_front_right_x_46 = new THREE.Mesh(
    mesh_rivet_lid_front_right_x_46Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_lid_front_right_x_46.name = "Rivet lid-front-right-x";
  if (endpoint_rivet_lid_front_right_x_46) {
    mesh_rivet_lid_front_right_x_46.position.copy(endpoint_rivet_lid_front_right_x_46.midpoint);
    mesh_rivet_lid_front_right_x_46.quaternion.copy(endpoint_rivet_lid_front_right_x_46.quaternion);
  }
  mesh_rivet_lid_front_right_x_46.castShadow = options.castShadow ?? true;
  mesh_rivet_lid_front_right_x_46.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_lid_front_right_x_46.userData.sculptComponent = {"id": "rivet-lid-front-right-x", "name": "Rivet lid-front-right-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-front-right", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.121, -0.014, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-right", "seamRefs": [], "detachableFragments": ["rivet-lid-front-right-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_front_right_x_46.add(mesh_rivet_lid_front_right_x_46);
  meshes["rivet-lid-front-right-x"] = mesh_rivet_lid_front_right_x_46;
  colliders["rivet-lid-front-right-x"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-lid-front-right"] ??= [];
  destructionGroups["corner-hardware-lid-front-right"].push(node_rivet_lid_front_right_x_46);

  const attachment_rivet_lid_front_right_z_47 = null;
  const endpoint_rivet_lid_front_right_z_47 = makeAttachmentEndpoint(attachment_rivet_lid_front_right_z_47);
  const node_rivet_lid_front_right_z_47 = new THREE.Group();
  node_rivet_lid_front_right_z_47.name = "Rivet lid-front-right-z__pivot";
  node_rivet_lid_front_right_z_47.scale.set(1, 1, 1);
  if (endpoint_rivet_lid_front_right_z_47) {
    node_rivet_lid_front_right_z_47.position.copy(endpoint_rivet_lid_front_right_z_47.start);
    node_rivet_lid_front_right_z_47.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_lid_front_right_z_47.position.set(0.016, -0.1085, 0.04);
    node_rivet_lid_front_right_z_47.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_lid_front_right_z_47.userData.sculptComponent = {"id": "rivet-lid-front-right-z", "name": "Rivet lid-front-right-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-front-right", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.016, -0.1085, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-right", "seamRefs": [], "detachableFragments": ["rivet-lid-front-right-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_front_right_z_47.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-right", "seamRefs": [], "detachableFragments": ["rivet-lid-front-right-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-lid-front-right"] ?? root).add(node_rivet_lid_front_right_z_47);
  nodes["rivet-lid-front-right-z"] = node_rivet_lid_front_right_z_47;
  const mesh_rivet_lid_front_right_z_47Geometry = endpoint_rivet_lid_front_right_z_47
    ? new THREE.CylinderGeometry(endpoint_rivet_lid_front_right_z_47.endRadius, endpoint_rivet_lid_front_right_z_47.baseRadius, endpoint_rivet_lid_front_right_z_47.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_lid_front_right_z_47) {
    mesh_rivet_lid_front_right_z_47Geometry.scale(0.034, 0.034, 0.012);
  }
  const mesh_rivet_lid_front_right_z_47 = new THREE.Mesh(
    mesh_rivet_lid_front_right_z_47Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_lid_front_right_z_47.name = "Rivet lid-front-right-z";
  if (endpoint_rivet_lid_front_right_z_47) {
    mesh_rivet_lid_front_right_z_47.position.copy(endpoint_rivet_lid_front_right_z_47.midpoint);
    mesh_rivet_lid_front_right_z_47.quaternion.copy(endpoint_rivet_lid_front_right_z_47.quaternion);
  }
  mesh_rivet_lid_front_right_z_47.castShadow = options.castShadow ?? true;
  mesh_rivet_lid_front_right_z_47.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_lid_front_right_z_47.userData.sculptComponent = {"id": "rivet-lid-front-right-z", "name": "Rivet lid-front-right-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-front-right", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.016, -0.1085, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-right", "seamRefs": [], "detachableFragments": ["rivet-lid-front-right-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_front_right_z_47.add(mesh_rivet_lid_front_right_z_47);
  meshes["rivet-lid-front-right-z"] = mesh_rivet_lid_front_right_z_47;
  colliders["rivet-lid-front-right-z"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-lid-front-right"] ??= [];
  destructionGroups["corner-hardware-lid-front-right"].push(node_rivet_lid_front_right_z_47);

  const attachment_rivet_lid_front_right_top_48 = null;
  const endpoint_rivet_lid_front_right_top_48 = makeAttachmentEndpoint(attachment_rivet_lid_front_right_top_48);
  const node_rivet_lid_front_right_top_48 = new THREE.Group();
  node_rivet_lid_front_right_top_48.name = "Rivet lid-front-right-top__pivot";
  node_rivet_lid_front_right_top_48.scale.set(1, 1, 1);
  if (endpoint_rivet_lid_front_right_top_48) {
    node_rivet_lid_front_right_top_48.position.copy(endpoint_rivet_lid_front_right_top_48.start);
    node_rivet_lid_front_right_top_48.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_lid_front_right_top_48.position.set(0.03, -0.03, 0.155);
    node_rivet_lid_front_right_top_48.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_lid_front_right_top_48.userData.sculptComponent = {"id": "rivet-lid-front-right-top", "name": "Rivet lid-front-right-top", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-front-right", "attachment": null, "dimensions": {"width": 0.034, "height": 0.012, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.03, -0.03, 0.155], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-right", "seamRefs": [], "detachableFragments": ["rivet-lid-front-right-top"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_front_right_top_48.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-right", "seamRefs": [], "detachableFragments": ["rivet-lid-front-right-top"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-lid-front-right"] ?? root).add(node_rivet_lid_front_right_top_48);
  nodes["rivet-lid-front-right-top"] = node_rivet_lid_front_right_top_48;
  const mesh_rivet_lid_front_right_top_48Geometry = endpoint_rivet_lid_front_right_top_48
    ? new THREE.CylinderGeometry(endpoint_rivet_lid_front_right_top_48.endRadius, endpoint_rivet_lid_front_right_top_48.baseRadius, endpoint_rivet_lid_front_right_top_48.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_lid_front_right_top_48) {
    mesh_rivet_lid_front_right_top_48Geometry.scale(0.034, 0.012, 0.034);
  }
  const mesh_rivet_lid_front_right_top_48 = new THREE.Mesh(
    mesh_rivet_lid_front_right_top_48Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_lid_front_right_top_48.name = "Rivet lid-front-right-top";
  if (endpoint_rivet_lid_front_right_top_48) {
    mesh_rivet_lid_front_right_top_48.position.copy(endpoint_rivet_lid_front_right_top_48.midpoint);
    mesh_rivet_lid_front_right_top_48.quaternion.copy(endpoint_rivet_lid_front_right_top_48.quaternion);
  }
  mesh_rivet_lid_front_right_top_48.castShadow = options.castShadow ?? true;
  mesh_rivet_lid_front_right_top_48.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_lid_front_right_top_48.userData.sculptComponent = {"id": "rivet-lid-front-right-top", "name": "Rivet lid-front-right-top", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-front-right", "attachment": null, "dimensions": {"width": 0.034, "height": 0.012, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.03, -0.03, 0.155], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-front-right", "seamRefs": [], "detachableFragments": ["rivet-lid-front-right-top"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_front_right_top_48.add(mesh_rivet_lid_front_right_top_48);
  meshes["rivet-lid-front-right-top"] = mesh_rivet_lid_front_right_top_48;
  colliders["rivet-lid-front-right-top"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-lid-front-right"] ??= [];
  destructionGroups["corner-hardware-lid-front-right"].push(node_rivet_lid_front_right_top_48);

  const attachment_rivet_base_rear_right_x_49 = null;
  const endpoint_rivet_base_rear_right_x_49 = makeAttachmentEndpoint(attachment_rivet_base_rear_right_x_49);
  const node_rivet_base_rear_right_x_49 = new THREE.Group();
  node_rivet_base_rear_right_x_49.name = "Rivet base-rear-right-x__pivot";
  node_rivet_base_rear_right_x_49.scale.set(1, 1, 1);
  if (endpoint_rivet_base_rear_right_x_49) {
    node_rivet_base_rear_right_x_49.position.copy(endpoint_rivet_base_rear_right_x_49.start);
    node_rivet_base_rear_right_x_49.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_base_rear_right_x_49.position.set(0.1185, 0.012, 0.108);
    node_rivet_base_rear_right_x_49.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_base_rear_right_x_49.userData.sculptComponent = {"id": "rivet-base-rear-right-x", "name": "Rivet base-rear-right-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-rear-right", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.1185, 0.012, 0.108], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-right", "seamRefs": [], "detachableFragments": ["rivet-base-rear-right-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_rear_right_x_49.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-right", "seamRefs": [], "detachableFragments": ["rivet-base-rear-right-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-base-rear-right"] ?? root).add(node_rivet_base_rear_right_x_49);
  nodes["rivet-base-rear-right-x"] = node_rivet_base_rear_right_x_49;
  const mesh_rivet_base_rear_right_x_49Geometry = endpoint_rivet_base_rear_right_x_49
    ? new THREE.CylinderGeometry(endpoint_rivet_base_rear_right_x_49.endRadius, endpoint_rivet_base_rear_right_x_49.baseRadius, endpoint_rivet_base_rear_right_x_49.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_base_rear_right_x_49) {
    mesh_rivet_base_rear_right_x_49Geometry.scale(0.012, 0.034, 0.034);
  }
  const mesh_rivet_base_rear_right_x_49 = new THREE.Mesh(
    mesh_rivet_base_rear_right_x_49Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_base_rear_right_x_49.name = "Rivet base-rear-right-x";
  if (endpoint_rivet_base_rear_right_x_49) {
    mesh_rivet_base_rear_right_x_49.position.copy(endpoint_rivet_base_rear_right_x_49.midpoint);
    mesh_rivet_base_rear_right_x_49.quaternion.copy(endpoint_rivet_base_rear_right_x_49.quaternion);
  }
  mesh_rivet_base_rear_right_x_49.castShadow = options.castShadow ?? true;
  mesh_rivet_base_rear_right_x_49.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_base_rear_right_x_49.userData.sculptComponent = {"id": "rivet-base-rear-right-x", "name": "Rivet base-rear-right-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-rear-right", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.1185, 0.012, 0.108], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-right", "seamRefs": [], "detachableFragments": ["rivet-base-rear-right-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_rear_right_x_49.add(mesh_rivet_base_rear_right_x_49);
  meshes["rivet-base-rear-right-x"] = mesh_rivet_base_rear_right_x_49;
  colliders["rivet-base-rear-right-x"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-base-rear-right"] ??= [];
  destructionGroups["corner-hardware-base-rear-right"].push(node_rivet_base_rear_right_x_49);

  const attachment_rivet_base_rear_right_z_50 = null;
  const endpoint_rivet_base_rear_right_z_50 = makeAttachmentEndpoint(attachment_rivet_base_rear_right_z_50);
  const node_rivet_base_rear_right_z_50 = new THREE.Group();
  node_rivet_base_rear_right_z_50.name = "Rivet base-rear-right-z__pivot";
  node_rivet_base_rear_right_z_50.scale.set(1, 1, 1);
  if (endpoint_rivet_base_rear_right_z_50) {
    node_rivet_base_rear_right_z_50.position.copy(endpoint_rivet_base_rear_right_z_50.start);
    node_rivet_base_rear_right_z_50.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_base_rear_right_z_50.position.set(0.014, 0.106, 0.058);
    node_rivet_base_rear_right_z_50.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_base_rear_right_z_50.userData.sculptComponent = {"id": "rivet-base-rear-right-z", "name": "Rivet base-rear-right-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-rear-right", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.014, 0.106, 0.058], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-right", "seamRefs": [], "detachableFragments": ["rivet-base-rear-right-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_rear_right_z_50.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-right", "seamRefs": [], "detachableFragments": ["rivet-base-rear-right-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-base-rear-right"] ?? root).add(node_rivet_base_rear_right_z_50);
  nodes["rivet-base-rear-right-z"] = node_rivet_base_rear_right_z_50;
  const mesh_rivet_base_rear_right_z_50Geometry = endpoint_rivet_base_rear_right_z_50
    ? new THREE.CylinderGeometry(endpoint_rivet_base_rear_right_z_50.endRadius, endpoint_rivet_base_rear_right_z_50.baseRadius, endpoint_rivet_base_rear_right_z_50.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_base_rear_right_z_50) {
    mesh_rivet_base_rear_right_z_50Geometry.scale(0.034, 0.034, 0.012);
  }
  const mesh_rivet_base_rear_right_z_50 = new THREE.Mesh(
    mesh_rivet_base_rear_right_z_50Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_base_rear_right_z_50.name = "Rivet base-rear-right-z";
  if (endpoint_rivet_base_rear_right_z_50) {
    mesh_rivet_base_rear_right_z_50.position.copy(endpoint_rivet_base_rear_right_z_50.midpoint);
    mesh_rivet_base_rear_right_z_50.quaternion.copy(endpoint_rivet_base_rear_right_z_50.quaternion);
  }
  mesh_rivet_base_rear_right_z_50.castShadow = options.castShadow ?? true;
  mesh_rivet_base_rear_right_z_50.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_base_rear_right_z_50.userData.sculptComponent = {"id": "rivet-base-rear-right-z", "name": "Rivet base-rear-right-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-base-rear-right", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.014, 0.106, 0.058], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-base-rear-right", "seamRefs": [], "detachableFragments": ["rivet-base-rear-right-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_base_rear_right_z_50.add(mesh_rivet_base_rear_right_z_50);
  meshes["rivet-base-rear-right-z"] = mesh_rivet_base_rear_right_z_50;
  colliders["rivet-base-rear-right-z"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-base-rear-right"] ??= [];
  destructionGroups["corner-hardware-base-rear-right"].push(node_rivet_base_rear_right_z_50);

  const attachment_rivet_lid_rear_right_x_51 = null;
  const endpoint_rivet_lid_rear_right_x_51 = makeAttachmentEndpoint(attachment_rivet_lid_rear_right_x_51);
  const node_rivet_lid_rear_right_x_51 = new THREE.Group();
  node_rivet_lid_rear_right_x_51.name = "Rivet lid-rear-right-x__pivot";
  node_rivet_lid_rear_right_x_51.scale.set(1, 1, 1);
  if (endpoint_rivet_lid_rear_right_x_51) {
    node_rivet_lid_rear_right_x_51.position.copy(endpoint_rivet_lid_rear_right_x_51.start);
    node_rivet_lid_rear_right_x_51.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_lid_rear_right_x_51.position.set(0.121, 0.014, 0.04);
    node_rivet_lid_rear_right_x_51.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_lid_rear_right_x_51.userData.sculptComponent = {"id": "rivet-lid-rear-right-x", "name": "Rivet lid-rear-right-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-rear-right", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.121, 0.014, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-right", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-right-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_rear_right_x_51.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-right", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-right-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-lid-rear-right"] ?? root).add(node_rivet_lid_rear_right_x_51);
  nodes["rivet-lid-rear-right-x"] = node_rivet_lid_rear_right_x_51;
  const mesh_rivet_lid_rear_right_x_51Geometry = endpoint_rivet_lid_rear_right_x_51
    ? new THREE.CylinderGeometry(endpoint_rivet_lid_rear_right_x_51.endRadius, endpoint_rivet_lid_rear_right_x_51.baseRadius, endpoint_rivet_lid_rear_right_x_51.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_lid_rear_right_x_51) {
    mesh_rivet_lid_rear_right_x_51Geometry.scale(0.012, 0.034, 0.034);
  }
  const mesh_rivet_lid_rear_right_x_51 = new THREE.Mesh(
    mesh_rivet_lid_rear_right_x_51Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_lid_rear_right_x_51.name = "Rivet lid-rear-right-x";
  if (endpoint_rivet_lid_rear_right_x_51) {
    mesh_rivet_lid_rear_right_x_51.position.copy(endpoint_rivet_lid_rear_right_x_51.midpoint);
    mesh_rivet_lid_rear_right_x_51.quaternion.copy(endpoint_rivet_lid_rear_right_x_51.quaternion);
  }
  mesh_rivet_lid_rear_right_x_51.castShadow = options.castShadow ?? true;
  mesh_rivet_lid_rear_right_x_51.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_lid_rear_right_x_51.userData.sculptComponent = {"id": "rivet-lid-rear-right-x", "name": "Rivet lid-rear-right-x", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-rear-right", "attachment": null, "dimensions": {"width": 0.012, "height": 0.034, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.121, 0.014, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-right", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-right-x"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_rear_right_x_51.add(mesh_rivet_lid_rear_right_x_51);
  meshes["rivet-lid-rear-right-x"] = mesh_rivet_lid_rear_right_x_51;
  colliders["rivet-lid-rear-right-x"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-lid-rear-right"] ??= [];
  destructionGroups["corner-hardware-lid-rear-right"].push(node_rivet_lid_rear_right_x_51);

  const attachment_rivet_lid_rear_right_z_52 = null;
  const endpoint_rivet_lid_rear_right_z_52 = makeAttachmentEndpoint(attachment_rivet_lid_rear_right_z_52);
  const node_rivet_lid_rear_right_z_52 = new THREE.Group();
  node_rivet_lid_rear_right_z_52.name = "Rivet lid-rear-right-z__pivot";
  node_rivet_lid_rear_right_z_52.scale.set(1, 1, 1);
  if (endpoint_rivet_lid_rear_right_z_52) {
    node_rivet_lid_rear_right_z_52.position.copy(endpoint_rivet_lid_rear_right_z_52.start);
    node_rivet_lid_rear_right_z_52.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_lid_rear_right_z_52.position.set(0.016, 0.1085, 0.04);
    node_rivet_lid_rear_right_z_52.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_lid_rear_right_z_52.userData.sculptComponent = {"id": "rivet-lid-rear-right-z", "name": "Rivet lid-rear-right-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-rear-right", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.016, 0.1085, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-right", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-right-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_rear_right_z_52.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-right", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-right-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-lid-rear-right"] ?? root).add(node_rivet_lid_rear_right_z_52);
  nodes["rivet-lid-rear-right-z"] = node_rivet_lid_rear_right_z_52;
  const mesh_rivet_lid_rear_right_z_52Geometry = endpoint_rivet_lid_rear_right_z_52
    ? new THREE.CylinderGeometry(endpoint_rivet_lid_rear_right_z_52.endRadius, endpoint_rivet_lid_rear_right_z_52.baseRadius, endpoint_rivet_lid_rear_right_z_52.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_lid_rear_right_z_52) {
    mesh_rivet_lid_rear_right_z_52Geometry.scale(0.034, 0.034, 0.012);
  }
  const mesh_rivet_lid_rear_right_z_52 = new THREE.Mesh(
    mesh_rivet_lid_rear_right_z_52Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_lid_rear_right_z_52.name = "Rivet lid-rear-right-z";
  if (endpoint_rivet_lid_rear_right_z_52) {
    mesh_rivet_lid_rear_right_z_52.position.copy(endpoint_rivet_lid_rear_right_z_52.midpoint);
    mesh_rivet_lid_rear_right_z_52.quaternion.copy(endpoint_rivet_lid_rear_right_z_52.quaternion);
  }
  mesh_rivet_lid_rear_right_z_52.castShadow = options.castShadow ?? true;
  mesh_rivet_lid_rear_right_z_52.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_lid_rear_right_z_52.userData.sculptComponent = {"id": "rivet-lid-rear-right-z", "name": "Rivet lid-rear-right-z", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-rear-right", "attachment": null, "dimensions": {"width": 0.034, "height": 0.034, "depth": 0.012, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.016, 0.1085, 0.04], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-right", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-right-z"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_rear_right_z_52.add(mesh_rivet_lid_rear_right_z_52);
  meshes["rivet-lid-rear-right-z"] = mesh_rivet_lid_rear_right_z_52;
  colliders["rivet-lid-rear-right-z"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-lid-rear-right"] ??= [];
  destructionGroups["corner-hardware-lid-rear-right"].push(node_rivet_lid_rear_right_z_52);

  const attachment_rivet_lid_rear_right_top_53 = null;
  const endpoint_rivet_lid_rear_right_top_53 = makeAttachmentEndpoint(attachment_rivet_lid_rear_right_top_53);
  const node_rivet_lid_rear_right_top_53 = new THREE.Group();
  node_rivet_lid_rear_right_top_53.name = "Rivet lid-rear-right-top__pivot";
  node_rivet_lid_rear_right_top_53.scale.set(1, 1, 1);
  if (endpoint_rivet_lid_rear_right_top_53) {
    node_rivet_lid_rear_right_top_53.position.copy(endpoint_rivet_lid_rear_right_top_53.start);
    node_rivet_lid_rear_right_top_53.rotation.set(1.570796, 0.0, -0.0);
  } else {
    node_rivet_lid_rear_right_top_53.position.set(0.03, 0.03, 0.155);
    node_rivet_lid_rear_right_top_53.rotation.set(1.570796, 0.0, -0.0);
  }
  node_rivet_lid_rear_right_top_53.userData.sculptComponent = {"id": "rivet-lid-rear-right-top", "name": "Rivet lid-rear-right-top", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-rear-right", "attachment": null, "dimensions": {"width": 0.034, "height": 0.012, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.03, 0.03, 0.155], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-right", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-right-top"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_rear_right_top_53.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-right", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-right-top"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}};
  (nodes["cap-lid-rear-right"] ?? root).add(node_rivet_lid_rear_right_top_53);
  nodes["rivet-lid-rear-right-top"] = node_rivet_lid_rear_right_top_53;
  const mesh_rivet_lid_rear_right_top_53Geometry = endpoint_rivet_lid_rear_right_top_53
    ? new THREE.CylinderGeometry(endpoint_rivet_lid_rear_right_top_53.endRadius, endpoint_rivet_lid_rear_right_top_53.baseRadius, endpoint_rivet_lid_rear_right_top_53.length, 16, 6)
    : new THREE.SphereGeometry(0.5, 32, 20);
  if (!endpoint_rivet_lid_rear_right_top_53) {
    mesh_rivet_lid_rear_right_top_53Geometry.scale(0.034, 0.012, 0.034);
  }
  const mesh_rivet_lid_rear_right_top_53 = new THREE.Mesh(
    mesh_rivet_lid_rear_right_top_53Geometry,
    materialMap["rivet-iron"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rivet_lid_rear_right_top_53.name = "Rivet lid-rear-right-top";
  if (endpoint_rivet_lid_rear_right_top_53) {
    mesh_rivet_lid_rear_right_top_53.position.copy(endpoint_rivet_lid_rear_right_top_53.midpoint);
    mesh_rivet_lid_rear_right_top_53.quaternion.copy(endpoint_rivet_lid_rear_right_top_53.quaternion);
  }
  mesh_rivet_lid_rear_right_top_53.castShadow = options.castShadow ?? true;
  mesh_rivet_lid_rear_right_top_53.receiveShadow = options.receiveShadow ?? true;
  mesh_rivet_lid_rear_right_top_53.userData.sculptComponent = {"id": "rivet-lid-rear-right-top", "name": "Rivet lid-rear-right-top", "level": "micro", "role": "fastener", "importance": 0.3, "confidence": 0.5, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Small dark dome sunk into the gold cap face; a dome, not a painted dot, because it catches its own highlight and shadow.", "geometryDescriptor": {"topologyIntent": "flattened dome rivet head sunk into the gold cap", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "sphere UVs", "normalStrategy": "dome normals"}, "parent": "cap-lid-rear-right", "attachment": null, "dimensions": {"width": 0.034, "height": 0.012, "depth": 0.034, "units": "relative", "confidence": 0.5}, "transform": {"position": [0.03, 0.03, 0.155], "rotation": [1.570796, 0.0, -0.0]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "authored-origin", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": false, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."}, "constraints": [], "destruction": {"breakable": true, "fractureGroup": "corner-hardware-lid-rear-right", "seamRefs": [], "detachableFragments": ["rivet-lid-rear-right-top"], "breakImpulse": 1.2, "debrisMaterial": "rivet-iron"}}, "material": "rivet-iron", "materialLayers": ["rivet-iron"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(38, 32, 30, 1.0)", "secondaryAlbedo": "rgba(74, 66, 60, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.8, "finish": "dark oxidised iron rivet head", "colorGradient": {"type": "radial", "axis": [0.5, 0.5], "stops": [{"offset": 0.0, "color": "rgba(74, 66, 60, 1.0)"}, {"offset": 1.0, "color": "rgba(38, 32, 30, 1.0)"}]}, "evidenceRefs": ["corner-hardware"]}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.18, "microRoughness": 0.08, "bumpAmplitude": 0.004, "normalPattern": "fine machined lacquer breakup", "displacementPattern": "none", "occlusionPattern": "darken panel grooves and part seams", "edgeWearPattern": "narrow brighter specular band along chamfers", "notes": "Stylised prop: relief stays subtle so the glossy read survives."}, "evidenceRefs": ["corner-hardware"], "details": [], "fidelityTier": "surface-pass"};
  node_rivet_lid_rear_right_top_53.add(mesh_rivet_lid_rear_right_top_53);
  meshes["rivet-lid-rear-right-top"] = mesh_rivet_lid_rear_right_top_53;
  colliders["rivet-lid-rear-right-top"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Rivet domes ride the cap collider; the sphere proxy only matters if the cap is fractured."};
  destructionGroups["corner-hardware-lid-rear-right"] ??= [];
  destructionGroups["corner-hardware-lid-rear-right"].push(node_rivet_lid_rear_right_top_53);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createStylizedLootChestLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Stylized Loot Chest look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"id": "key-light", "role": "key", "type": "directional", "directionFromSubject": [-0.55, 0.62, 0.56], "azimuthDegrees": -44.0, "elevationDegrees": 38.0, "color": "#fff4e2", "intensity": 2.6, "softness": 0.35, "evidence": "Brightest value sits on the lid top panel and the front-left cap facets; cast shadow of the lid falls to the lower right of the seam.", "evidenceRefs": ["full-object", "lid-taper"]}, {"id": "fill-light", "role": "fill", "type": "hemisphere", "directionFromSubject": [0.4, 0.25, -0.5], "azimuthDegrees": 140.0, "elevationDegrees": 12.0, "color": "#4a5fd0", "groundColor": "#241a44", "intensity": 0.3, "softness": 0.9, "evidence": "Shadow side of the left wall never goes black; it keeps a cool blue-violet floor value.", "evidenceRefs": ["side-handle", "front-face"]}, {"id": "rim-light", "role": "rim", "type": "directional", "directionFromSubject": [0.72, 0.35, -0.6], "azimuthDegrees": 128.0, "elevationDegrees": 22.0, "color": "#8fd8ff", "intensity": 1.1, "softness": 0.2, "evidence": "A cool highlight edges the right lid facet and the right-hand caps, separating the prop from the background.", "evidenceRefs": ["full-object", "corner-hardware"]}, {"id": "emblem-spill", "role": "practical", "type": "point", "positionFromSubject": [0.0, 0.26, 0.42], "color": "#ffd77a", "intensity": 0.35, "distance": 0.9, "decay": 2.0, "evidence": "The lit crown core brightens the gold ring around it and washes the paint immediately outside the frame.", "evidenceRefs": ["crown-emblem"]}, {"id": "environment", "role": "environment", "type": "studio-gradient", "color": "#2a2450", "groundColor": "#0b0a16", "intensity": 0.22, "probeIntensity": 0.26, "evidence": "Background is empty; reflections on the lacquer read as a soft dark studio gradient rather than a real environment. Probe intensity is held low on purpose: at full strength the room probe washes the lacquer to pastel and hides the albedo.", "evidenceRefs": ["full-object"]}, {"id": "exposure-and-tone-mapping", "role": "response", "toneMapping": "ACESFilmic", "exposure": 0.9, "outputColorSpace": "sRGB", "physicallyCorrectLights": true, "bloom": {"enabled": true, "threshold": 0.92, "strength": 0.085, "radius": 0.45, "note": "Preview-only post effect so the crown core blooms the way it does in the reference; 0.07 read as almost no glow, while 0.18 inflated the silhouette IoU loss to 0.83; 0.085 keeps the halo visible at IoU 0.89."}, "lightingChecks": [{"id": "reference-matched", "query": "", "purpose": "scored against the reference; warm key, cool rim, emblem spill, weak bloom"}, {"id": "neutral", "query": "lighting=neutral", "purpose": "even white studio, no rim/spill/bloom, so albedo errors cannot hide behind the warm key"}, {"id": "grazing", "query": "lighting=grazing", "purpose": "single low raking key so normal/height errors and geometry gaps show up"}], "evidence": "The reference clips to near-white only inside the crown core while the lacquer keeps its midtones, which matches an ACES filmic response at roughly neutral exposure.", "evidenceRefs": ["full-object", "crown-emblem"]}, {"id": "contact-and-ground-shadow", "role": "shadow", "contactShadow": {"enabled": true, "strength": 0.65, "radius": 0.14, "note": "Ground shadow directly under the plinth and the four base caps; the reference has no floor, so this is kept tight and only used in the turntable review renders."}, "castShadows": ["lid over the seam band", "caps over the paint", "grip bar over the left wall"], "ambientOcclusion": {"mode": "baked-per-material plus screen-space in preview", "strength": 0.55, "note": "AO carries the panel grooves, the seam recess and the rivet seating rings."}, "evidence": "Seam band, panel grooves and the undersides of the caps are all darker than any diffuse falloff would explain, so occlusion has to be explicit.", "evidenceRefs": ["full-object", "corner-hardware", "plinth-base"]}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createStylizedLootChestEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameStylizedLootChestCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createStylizedLootChestPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureStylizedLootChestRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createStylizedLootChestInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
