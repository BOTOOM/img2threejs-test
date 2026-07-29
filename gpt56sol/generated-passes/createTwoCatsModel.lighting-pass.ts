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

// Plan 1.3 F.6 — sweep a thin 2D cross-section along a 3D spine so a curved
// form (hooked blade, handle) reads correctly from EVERY camera angle, not just
// the reference angle a flat extrude happens to match. Uses ExtrudeGeometry's
// native extrudePath; bevelEnabled: false keeps sharp tips (same rule as F.5).
function buildCurveSweepGeometry(
  sweep: { spine: [number, number, number][]; crossSection: { points: [number, number][] }; closed?: boolean },
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  const cs = sweep.crossSection.points;
  if (cs.length > 0) {
    shape.moveTo(cs[0][0], cs[0][1]);
    for (let i = 1; i < cs.length; i += 1) shape.lineTo(cs[i][0], cs[i][1]);
    shape.closePath();
  }
  const spine = sweep.spine.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const path = new THREE.CatmullRomCurve3(spine, sweep.closed ?? false);
  return new THREE.ExtrudeGeometry(shape, {
    extrudePath: path,
    steps: Math.max(24, spine.length * 8),
    bevelEnabled: false,
  });
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
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
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
  return [Number(match[1]), Number(match[2]), Number(match[3])];
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

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions): THREE.MeshPhysicalMaterial {
  const textures = makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : new THREE.Color(typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F'),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clamp01(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: Math.max(1, readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: Math.max(1, readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clamp01(readLayerNumber(spec.specularIntensity, ['base'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    if (bumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = bumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    if (displacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = displacementScale;
      material.displacementBias = -displacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
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

// Generated from ObjectSculptSpec target: Two Stylized Quadruped Cats
// Sculpt build pass: lighting-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createTwoStylizedQuadrupedCatsModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Two Stylized Quadruped Cats";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": true, "fovDegrees": 34.0, "aspect": 1.249554367201426, "orientation": {"yaw": -0.03, "pitch": -0.015, "roll": 0.0}, "positionHint": [0.0, 2.05, 8.2], "target": [0.0, 1.8, 0.1], "confidence": 0.72, "note": "Manual single-view camera estimate for silhouette review; no hidden-side geometry is implied."}, "approximationNotes": []};

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["hidden"] = createSculptMaterial(
    "hidden",
    {"id": "hidden", "name": "Hidden", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "utility", "baseColor": "#000000", "color": "#000000", "colorVariation": {"palette": ["#000000", "#000000"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#000000", "secondary": "#000000", "map": "procedural-hidden-albedo"}, "roughness": {"base": 1.0, "variation": 0.08, "map": "procedural-hidden-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.0, "map": "procedural-hidden-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-hidden-ao"}, "opacity": {"base": 0.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["black-fur"] = createSculptMaterial(
    "black-fur",
    {"id": "black-fur", "name": "Black Fur", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#1b1815", "color": "#1b1815", "colorVariation": {"palette": ["#1b1815", "#1b1815"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#1b1815", "secondary": "#11100f", "map": "procedural-black-fur-albedo"}, "roughness": {"base": 0.92, "variation": 0.08, "map": "procedural-black-fur-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.18, "map": "procedural-black-fur-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-black-fur-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "black-coat-warm-rim", "region": "silhouette-facing normals", "baseColor": "#2a211b", "roughness": 0.7}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["tabby-fur"] = createSculptMaterial(
    "tabby-fur",
    {"id": "tabby-fur", "name": "Tabby Fur", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#a06f43", "color": "#a06f43", "colorVariation": {"palette": ["#a06f43", "#a06f43"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#a06f43", "secondary": "#8b603b", "map": "procedural-tabby-fur-albedo"}, "roughness": {"base": 0.88, "variation": 0.08, "map": "procedural-tabby-fur-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.2, "map": "procedural-tabby-fur-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-tabby-fur-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "tabby-warm-flank", "region": "visible shoulders and flank", "baseColor": "#a8794a", "roughness": 0.72}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["white-fur"] = createSculptMaterial(
    "white-fur",
    {"id": "white-fur", "name": "White Fur", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#dec9a9", "color": "#dec9a9", "colorVariation": {"palette": ["#dec9a9", "#dec9a9"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#dec9a9", "secondary": "#e8d7bd", "map": "procedural-white-fur-albedo"}, "roughness": {"base": 0.9, "variation": 0.08, "map": "procedural-white-fur-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.16, "map": "procedural-white-fur-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-white-fur-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "cream-shadow", "region": "bib and paw cavities", "baseColor": "#c9b397", "roughness": 0.86}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["black-inner-ear"] = createSculptMaterial(
    "black-inner-ear",
    {"id": "black-inner-ear", "name": "Black Inner Ear", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#4a2c25", "color": "#4a2c25", "colorVariation": {"palette": ["#4a2c25", "#4a2c25"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#4a2c25", "secondary": "#4a2c25", "map": "procedural-black-inner-ear-albedo"}, "roughness": {"base": 0.72, "variation": 0.08, "map": "procedural-black-inner-ear-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.08, "map": "procedural-black-inner-ear-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-black-inner-ear-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["tabby-inner-ear"] = createSculptMaterial(
    "tabby-inner-ear",
    {"id": "tabby-inner-ear", "name": "Tabby Inner Ear", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#b97962", "color": "#b97962", "colorVariation": {"palette": ["#b97962", "#b97962"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#b97962", "secondary": "#b97962", "map": "procedural-tabby-inner-ear-albedo"}, "roughness": {"base": 0.68, "variation": 0.08, "map": "procedural-tabby-inner-ear-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.08, "map": "procedural-tabby-inner-ear-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-tabby-inner-ear-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["iris-green"] = createSculptMaterial(
    "iris-green",
    {"id": "iris-green", "name": "Iris Green", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#c0c96a", "color": "#c0c96a", "colorVariation": {"palette": ["#c0c96a", "#c0c96a"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#c0c96a", "secondary": "#a9b84f", "map": "procedural-iris-green-albedo"}, "roughness": {"base": 0.26, "variation": 0.08, "map": "procedural-iris-green-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.03, "map": "procedural-iris-green-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-iris-green-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "olive-limbal-ring", "region": "iris perimeter", "baseColor": "#59612e", "roughness": 0.3}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["pupil"] = createSculptMaterial(
    "pupil",
    {"id": "pupil", "name": "Pupil", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#020403", "color": "#020403", "colorVariation": {"palette": ["#020403", "#020403"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#020403", "secondary": "#030504", "map": "procedural-pupil-albedo"}, "roughness": {"base": 0.18, "variation": 0.08, "map": "procedural-pupil-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.0, "map": "procedural-pupil-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-pupil-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["cornea"] = createSculptMaterial(
    "cornea",
    {"id": "cornea", "name": "Cornea", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#c0c96a", "color": "#c0c96a", "colorVariation": {"palette": ["#c0c96a", "#c0c96a"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#c0c96a", "secondary": "#d8f1e5", "map": "procedural-cornea-albedo"}, "roughness": {"base": 0.06, "variation": 0.08, "map": "procedural-cornea-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.0, "map": "procedural-cornea-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-cornea-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.45, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "corneal-highlight", "region": "upper camera-facing quadrant", "baseColor": "#ffffff", "roughness": 0.03}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["black-nose"] = createSculptMaterial(
    "black-nose",
    {"id": "black-nose", "name": "Black Nose", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#29201d", "color": "#29201d", "colorVariation": {"palette": ["#29201d", "#29201d"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#29201d", "secondary": "#29201d", "map": "procedural-black-nose-albedo"}, "roughness": {"base": 0.32, "variation": 0.08, "map": "procedural-black-nose-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.04, "map": "procedural-black-nose-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-black-nose-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.45, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "black-nose-gloss", "region": "nose center", "baseColor": "#352825", "roughness": 0.18}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["tabby-nose"] = createSculptMaterial(
    "tabby-nose",
    {"id": "tabby-nose", "name": "Tabby Nose", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#c4785f", "color": "#c4785f", "colorVariation": {"palette": ["#c4785f", "#c4785f"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#c4785f", "secondary": "#9b5f4c", "map": "procedural-tabby-nose-albedo"}, "roughness": {"base": 0.3, "variation": 0.08, "map": "procedural-tabby-nose-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.04, "map": "procedural-tabby-nose-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-tabby-nose-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.45, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "tabby-nose-gloss", "region": "nose center", "baseColor": "#b6755e", "roughness": 0.16}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["whisker"] = createSculptMaterial(
    "whisker",
    {"id": "whisker", "name": "Whisker", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "utility", "baseColor": "#eadfce", "color": "#eadfce", "colorVariation": {"palette": ["#eadfce", "#eadfce"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#eadfce", "secondary": "#e7dfcf", "map": "procedural-whisker-albedo"}, "roughness": {"base": 0.46, "variation": 0.08, "map": "procedural-whisker-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.0, "map": "procedural-whisker-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-whisker-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["tabby-stripe"] = createSculptMaterial(
    "tabby-stripe",
    {"id": "tabby-stripe", "name": "Tabby Stripe", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#2f2118", "color": "#2f2118", "colorVariation": {"palette": ["#2f2118", "#2f2118"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#2f2118", "secondary": "#2a211b", "map": "procedural-tabby-stripe-albedo"}, "roughness": {"base": 0.8, "variation": 0.08, "map": "procedural-tabby-stripe-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.12, "map": "procedural-tabby-stripe-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-tabby-stripe-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "stripe-soft-edge", "region": "stripe boundaries", "baseColor": "#3a2a21", "roughness": 0.82}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_root_0 = null;
  const endpoint_root_0 = makeAttachmentEndpoint(attachment_root_0);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Paired cats root__pivot";
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0, 0, 0);
    node_root_0.scale.set(1, 1, 1);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
    node_root_0.scale.set(0.01, 0.01, 0.01);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Paired cats root", "level": "macro", "role": "root", "importance": 1.0, "confidence": 1.0, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Paired cats root is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in full-object.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": null, "attachment": null, "dimensions": {"width": 0.01, "height": 0.01, "depth": 0.01, "units": "world", "confidence": 1.0}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.0], "scale": [0.01, 0.01, 0.01]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 0, 0, 0.0)", "secondaryAlbedo": "rgba(12, 10, 8, 0.0)", "materialClass": "unknown", "materialClassConfidence": 1.0}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["full-object"]};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Paired cats root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Paired cats root", "level": "macro", "role": "root", "importance": 1.0, "confidence": 1.0, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Paired cats root is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in full-object.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": null, "attachment": null, "dimensions": {"width": 0.01, "height": 0.01, "depth": 0.01, "units": "world", "confidence": 1.0}, "transform": {"position": [0, 0, 0], "rotation": [0.0, 0.0, 0.0], "scale": [0.01, 0.01, 0.01]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 0, 0, 0.0)", "secondaryAlbedo": "rgba(12, 10, 8, 0.0)", "materialClass": "unknown", "materialClassConfidence": 1.0}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["full-object"]};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_root_0);

  const attachment_black_cat_1 = {"parentId": "root", "parentSocket": "root-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.08, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]};
  const endpoint_black_cat_1 = makeAttachmentEndpoint(attachment_black_cat_1);
  const node_black_cat_1 = new THREE.Group();
  node_black_cat_1.name = "Black cat quadruped root__pivot";
  if (endpoint_black_cat_1) {
    node_black_cat_1.position.copy(endpoint_black_cat_1.start);
    node_black_cat_1.rotation.set(0, 0, 0);
    node_black_cat_1.scale.set(1, 1, 1);
  } else {
    node_black_cat_1.position.set(-0.68, 0.0, 0.0);
    node_black_cat_1.rotation.set(0.0, 0.0, 0.0);
    node_black_cat_1.scale.set(0.01, 0.01, 0.01);
  }
  node_black_cat_1.userData.sculptComponent = {"id": "black-cat", "name": "Black cat quadruped root", "level": "macro", "role": "cat-root", "importance": 1.0, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Black cat quadruped root is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.08, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.01, "height": 0.01, "depth": 0.01, "units": "world", "confidence": 0.9}, "transform": {"position": [-0.68, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.01, 0.01, 0.01]}, "actionProfile": {"animationRole": "cat-root", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 0, 0, 0.0)", "secondaryAlbedo": "rgba(12, 10, 8, 0.0)", "materialClass": "unknown", "materialClassConfidence": 1.0}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_cat_1.userData.actionProfile = {"animationRole": "cat-root", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}};
  (nodes["root"] ?? root).add(node_black_cat_1);
  nodes["black-cat"] = node_black_cat_1;
  const mesh_black_cat_1Geometry = endpoint_black_cat_1
    ? new THREE.CylinderGeometry(endpoint_black_cat_1.endRadius, endpoint_black_cat_1.baseRadius, endpoint_black_cat_1.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_black_cat_1 = new THREE.Mesh(
    mesh_black_cat_1Geometry,
    materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_cat_1.name = "Black cat quadruped root";
  if (endpoint_black_cat_1) {
    mesh_black_cat_1.position.copy(endpoint_black_cat_1.midpoint);
    mesh_black_cat_1.quaternion.copy(endpoint_black_cat_1.quaternion);
  }
  mesh_black_cat_1.castShadow = options.castShadow ?? true;
  mesh_black_cat_1.receiveShadow = options.receiveShadow ?? true;
  mesh_black_cat_1.userData.sculptComponent = {"id": "black-cat", "name": "Black cat quadruped root", "level": "macro", "role": "cat-root", "importance": 1.0, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Black cat quadruped root is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.08, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.01, "height": 0.01, "depth": 0.01, "units": "world", "confidence": 0.9}, "transform": {"position": [-0.68, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.01, 0.01, 0.01]}, "actionProfile": {"animationRole": "cat-root", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 0, 0, 0.0)", "secondaryAlbedo": "rgba(12, 10, 8, 0.0)", "materialClass": "unknown", "materialClassConfidence": 1.0}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_cat_1.add(mesh_black_cat_1);
  meshes["black-cat"] = mesh_black_cat_1;
  colliders["black-cat"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_cat_1);

  const attachment_black_torso_2 = {"parentId": "black-cat", "parentSocket": "black-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.62, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]};
  const endpoint_black_torso_2 = makeAttachmentEndpoint(attachment_black_torso_2);
  const node_black_torso_2 = new THREE.Group();
  node_black_torso_2.name = "Black cat upright torso__pivot";
  if (endpoint_black_torso_2) {
    node_black_torso_2.position.copy(endpoint_black_torso_2.start);
    node_black_torso_2.rotation.set(0, 0, 0);
    node_black_torso_2.scale.set(1, 1, 1);
  } else {
    node_black_torso_2.position.set(-0.68, 1.42, -0.04);
    node_black_torso_2.rotation.set(0.0, 0.0, 0.0);
    node_black_torso_2.scale.set(0.88, 1.62, 0.72);
  }
  node_black_torso_2.userData.sculptComponent = {"id": "black-torso", "name": "Black cat upright torso", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.92, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat upright torso is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-cat", "attachment": {"parentId": "black-cat", "parentSocket": "black-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.62, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.88, "height": 1.62, "depth": 0.72, "units": "world", "confidence": 0.92}, "transform": {"position": [-0.68, 1.42, -0.04], "rotation": [0.0, 0.0, 0.0], "scale": [0.88, 1.62, 0.72]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-coat-directional-flow"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_torso_2.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-cat"] ?? root).add(node_black_torso_2);
  nodes["black-torso"] = node_black_torso_2;
  const mesh_black_torso_2Geometry = endpoint_black_torso_2
    ? new THREE.CylinderGeometry(endpoint_black_torso_2.endRadius, endpoint_black_torso_2.baseRadius, endpoint_black_torso_2.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_torso_2 = new THREE.Mesh(
    mesh_black_torso_2Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_torso_2.name = "Black cat upright torso";
  if (endpoint_black_torso_2) {
    mesh_black_torso_2.position.copy(endpoint_black_torso_2.midpoint);
    mesh_black_torso_2.quaternion.copy(endpoint_black_torso_2.quaternion);
  }
  mesh_black_torso_2.castShadow = options.castShadow ?? true;
  mesh_black_torso_2.receiveShadow = options.receiveShadow ?? true;
  mesh_black_torso_2.userData.sculptComponent = {"id": "black-torso", "name": "Black cat upright torso", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.92, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat upright torso is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-cat", "attachment": {"parentId": "black-cat", "parentSocket": "black-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.62, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.88, "height": 1.62, "depth": 0.72, "units": "world", "confidence": 0.92}, "transform": {"position": [-0.68, 1.42, -0.04], "rotation": [0.0, 0.0, 0.0], "scale": [0.88, 1.62, 0.72]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-coat-directional-flow"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_torso_2.add(mesh_black_torso_2);
  meshes["black-torso"] = mesh_black_torso_2;
  colliders["black-torso"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_torso_2);

  const attachment_black_rump_3 = {"parentId": "black-cat", "parentSocket": "black-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]};
  const endpoint_black_rump_3 = makeAttachmentEndpoint(attachment_black_rump_3);
  const node_black_rump_3 = new THREE.Group();
  node_black_rump_3.name = "Black cat seated rump__pivot";
  if (endpoint_black_rump_3) {
    node_black_rump_3.position.copy(endpoint_black_rump_3.start);
    node_black_rump_3.rotation.set(0, 0, 0);
    node_black_rump_3.scale.set(1, 1, 1);
  } else {
    node_black_rump_3.position.set(-0.78, 0.75, -0.2);
    node_black_rump_3.rotation.set(0.0, 0.0, 0.0);
    node_black_rump_3.scale.set(1.02, 0.78, 0.82);
  }
  node_black_rump_3.userData.sculptComponent = {"id": "black-rump", "name": "Black cat seated rump", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.72, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat seated rump is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-cat", "attachment": {"parentId": "black-cat", "parentSocket": "black-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 1.02, "height": 0.78, "depth": 0.82, "units": "world", "confidence": 0.72}, "transform": {"position": [-0.78, 0.75, -0.2], "rotation": [0.0, 0.0, 0.0], "scale": [1.02, 0.78, 0.82]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_rump_3.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-cat"] ?? root).add(node_black_rump_3);
  nodes["black-rump"] = node_black_rump_3;
  const mesh_black_rump_3Geometry = endpoint_black_rump_3
    ? new THREE.CylinderGeometry(endpoint_black_rump_3.endRadius, endpoint_black_rump_3.baseRadius, endpoint_black_rump_3.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_rump_3 = new THREE.Mesh(
    mesh_black_rump_3Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_rump_3.name = "Black cat seated rump";
  if (endpoint_black_rump_3) {
    mesh_black_rump_3.position.copy(endpoint_black_rump_3.midpoint);
    mesh_black_rump_3.quaternion.copy(endpoint_black_rump_3.quaternion);
  }
  mesh_black_rump_3.castShadow = options.castShadow ?? true;
  mesh_black_rump_3.receiveShadow = options.receiveShadow ?? true;
  mesh_black_rump_3.userData.sculptComponent = {"id": "black-rump", "name": "Black cat seated rump", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.72, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat seated rump is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-cat", "attachment": {"parentId": "black-cat", "parentSocket": "black-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 1.02, "height": 0.78, "depth": 0.82, "units": "world", "confidence": 0.72}, "transform": {"position": [-0.78, 0.75, -0.2], "rotation": [0.0, 0.0, 0.0], "scale": [1.02, 0.78, 0.82]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_rump_3.add(mesh_black_rump_3);
  meshes["black-rump"] = mesh_black_rump_3;
  colliders["black-rump"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_rump_3);

  const attachment_black_chest_4 = {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.18, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]};
  const endpoint_black_chest_4 = makeAttachmentEndpoint(attachment_black_chest_4);
  const node_black_chest_4 = new THREE.Group();
  node_black_chest_4.name = "Black cat tapered chest__pivot";
  if (endpoint_black_chest_4) {
    node_black_chest_4.position.copy(endpoint_black_chest_4.start);
    node_black_chest_4.rotation.set(0, 0, 0);
    node_black_chest_4.scale.set(1, 1, 1);
  } else {
    node_black_chest_4.position.set(-0.68, 1.48, 0.28);
    node_black_chest_4.rotation.set(0.0, 0.0, 0.0);
    node_black_chest_4.scale.set(0.72, 1.18, 0.42);
  }
  node_black_chest_4.userData.sculptComponent = {"id": "black-chest", "name": "Black cat tapered chest", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.9, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat tapered chest is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-torso", "attachment": {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.18, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.72, "height": 1.18, "depth": 0.42, "units": "world", "confidence": 0.9}, "transform": {"position": [-0.68, 1.48, 0.28], "rotation": [0.0, 0.0, 0.0], "scale": [0.72, 1.18, 0.42]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-coat-warm-rim"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_chest_4.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-torso"] ?? root).add(node_black_chest_4);
  nodes["black-chest"] = node_black_chest_4;
  const mesh_black_chest_4Geometry = endpoint_black_chest_4
    ? new THREE.CylinderGeometry(endpoint_black_chest_4.endRadius, endpoint_black_chest_4.baseRadius, endpoint_black_chest_4.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_chest_4 = new THREE.Mesh(
    mesh_black_chest_4Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_chest_4.name = "Black cat tapered chest";
  if (endpoint_black_chest_4) {
    mesh_black_chest_4.position.copy(endpoint_black_chest_4.midpoint);
    mesh_black_chest_4.quaternion.copy(endpoint_black_chest_4.quaternion);
  }
  mesh_black_chest_4.castShadow = options.castShadow ?? true;
  mesh_black_chest_4.receiveShadow = options.receiveShadow ?? true;
  mesh_black_chest_4.userData.sculptComponent = {"id": "black-chest", "name": "Black cat tapered chest", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.9, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat tapered chest is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-torso", "attachment": {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.18, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.72, "height": 1.18, "depth": 0.42, "units": "world", "confidence": 0.9}, "transform": {"position": [-0.68, 1.48, 0.28], "rotation": [0.0, 0.0, 0.0], "scale": [0.72, 1.18, 0.42]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-coat-warm-rim"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_chest_4.add(mesh_black_chest_4);
  meshes["black-chest"] = mesh_black_chest_4;
  colliders["black-chest"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_chest_4);

  const attachment_black_neck_5 = {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.52, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]};
  const endpoint_black_neck_5 = makeAttachmentEndpoint(attachment_black_neck_5);
  const node_black_neck_5 = new THREE.Group();
  node_black_neck_5.name = "Black cat neck bridge__pivot";
  if (endpoint_black_neck_5) {
    node_black_neck_5.position.copy(endpoint_black_neck_5.start);
    node_black_neck_5.rotation.set(0, 0, 0);
    node_black_neck_5.scale.set(1, 1, 1);
  } else {
    node_black_neck_5.position.set(-0.68, 2.27, 0.1);
    node_black_neck_5.rotation.set(0.0, 0.0, 0.0);
    node_black_neck_5.scale.set(0.58, 0.52, 0.5);
  }
  node_black_neck_5.userData.sculptComponent = {"id": "black-neck", "name": "Black cat neck bridge", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.84, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat neck bridge is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-torso", "attachment": {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.52, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.58, "height": 0.52, "depth": 0.5, "units": "world", "confidence": 0.84}, "transform": {"position": [-0.68, 2.27, 0.1], "rotation": [0.0, 0.0, 0.0], "scale": [0.58, 0.52, 0.5]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_neck_5.userData.actionProfile = {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-torso"] ?? root).add(node_black_neck_5);
  nodes["black-neck"] = node_black_neck_5;
  const mesh_black_neck_5Geometry = endpoint_black_neck_5
    ? new THREE.CylinderGeometry(endpoint_black_neck_5.endRadius, endpoint_black_neck_5.baseRadius, endpoint_black_neck_5.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_neck_5 = new THREE.Mesh(
    mesh_black_neck_5Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_neck_5.name = "Black cat neck bridge";
  if (endpoint_black_neck_5) {
    mesh_black_neck_5.position.copy(endpoint_black_neck_5.midpoint);
    mesh_black_neck_5.quaternion.copy(endpoint_black_neck_5.quaternion);
  }
  mesh_black_neck_5.castShadow = options.castShadow ?? true;
  mesh_black_neck_5.receiveShadow = options.receiveShadow ?? true;
  mesh_black_neck_5.userData.sculptComponent = {"id": "black-neck", "name": "Black cat neck bridge", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.84, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat neck bridge is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-torso", "attachment": {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.52, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.58, "height": 0.52, "depth": 0.5, "units": "world", "confidence": 0.84}, "transform": {"position": [-0.68, 2.27, 0.1], "rotation": [0.0, 0.0, 0.0], "scale": [0.58, 0.52, 0.5]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_neck_5.add(mesh_black_neck_5);
  meshes["black-neck"] = mesh_black_neck_5;
  colliders["black-neck"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_neck_5);

  const attachment_black_head_6 = {"parentId": "black-neck", "parentSocket": "black-neck-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.75, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_head_6 = makeAttachmentEndpoint(attachment_black_head_6);
  const node_black_head_6 = new THREE.Group();
  node_black_head_6.name = "Black cat head pivot__pivot";
  if (endpoint_black_head_6) {
    node_black_head_6.position.copy(endpoint_black_head_6.start);
    node_black_head_6.rotation.set(0, 0, 0);
    node_black_head_6.scale.set(1, 1, 1);
  } else {
    node_black_head_6.position.set(-0.7, 2.88, 0.22);
    node_black_head_6.rotation.set(0.0, 0.0, 0.0);
    node_black_head_6.scale.set(0.72, 0.75, 0.62);
  }
  node_black_head_6.userData.sculptComponent = {"id": "black-head", "name": "Black cat head pivot", "level": "macro", "role": "head", "importance": 1.0, "confidence": 0.96, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat head pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-neck", "attachment": {"parentId": "black-neck", "parentSocket": "black-neck-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.75, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.72, "height": 0.75, "depth": 0.62, "units": "world", "confidence": 0.96}, "transform": {"position": [-0.7, 2.88, 0.22], "rotation": [0.0, 0.0, 0.0], "scale": [0.72, 0.75, 0.62]}, "actionProfile": {"animationRole": "head", "pivot": {"mode": "joint", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-eye-wetline", "black-round-pupil", "black-iris-ring"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_head_6.userData.actionProfile = {"animationRole": "head", "pivot": {"mode": "joint", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-neck"] ?? root).add(node_black_head_6);
  nodes["black-head"] = node_black_head_6;
  const mesh_black_head_6Geometry = endpoint_black_head_6
    ? new THREE.CylinderGeometry(endpoint_black_head_6.endRadius, endpoint_black_head_6.baseRadius, endpoint_black_head_6.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_head_6 = new THREE.Mesh(
    mesh_black_head_6Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_head_6.name = "Black cat head pivot";
  if (endpoint_black_head_6) {
    mesh_black_head_6.position.copy(endpoint_black_head_6.midpoint);
    mesh_black_head_6.quaternion.copy(endpoint_black_head_6.quaternion);
  }
  mesh_black_head_6.castShadow = options.castShadow ?? true;
  mesh_black_head_6.receiveShadow = options.receiveShadow ?? true;
  mesh_black_head_6.userData.sculptComponent = {"id": "black-head", "name": "Black cat head pivot", "level": "macro", "role": "head", "importance": 1.0, "confidence": 0.96, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat head pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-neck", "attachment": {"parentId": "black-neck", "parentSocket": "black-neck-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.75, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.72, "height": 0.75, "depth": 0.62, "units": "world", "confidence": 0.96}, "transform": {"position": [-0.7, 2.88, 0.22], "rotation": [0.0, 0.0, 0.0], "scale": [0.72, 0.75, 0.62]}, "actionProfile": {"animationRole": "head", "pivot": {"mode": "joint", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-eye-wetline", "black-round-pupil", "black-iris-ring"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_head_6.add(mesh_black_head_6);
  meshes["black-head"] = mesh_black_head_6;
  colliders["black-head"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_head_6);

  const attachment_black_ear_l_7 = {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]};
  const endpoint_black_ear_l_7 = makeAttachmentEndpoint(attachment_black_ear_l_7);
  const node_black_ear_l_7 = new THREE.Group();
  node_black_ear_l_7.name = "Black cat l ear pivot__pivot";
  if (endpoint_black_ear_l_7) {
    node_black_ear_l_7.position.copy(endpoint_black_ear_l_7.start);
    node_black_ear_l_7.rotation.set(0, 0, 0);
    node_black_ear_l_7.scale.set(1, 1, 1);
  } else {
    node_black_ear_l_7.position.set(-1.0899999999999999, 3.58, 0.19);
    node_black_ear_l_7.rotation.set(0.0, 0.0, 0.12);
    node_black_ear_l_7.scale.set(0.43, 0.78, 0.2);
  }
  node_black_ear_l_7.userData.sculptComponent = {"id": "black-ear-l", "name": "Black cat l ear pivot", "level": "meso", "role": "ear", "importance": 0.8, "confidence": 0.94, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Black cat l ear pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.43, "height": 0.78, "depth": 0.2, "units": "world", "confidence": 0.94}, "transform": {"position": [-1.0899999999999999, 3.58, 0.19], "rotation": [0.0, 0.0, 0.12], "scale": [0.43, 0.78, 0.2]}, "actionProfile": {"animationRole": "ear", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-inner-ear-ridges"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_black_ear_l_7.userData.actionProfile = {"animationRole": "ear", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-head"] ?? root).add(node_black_ear_l_7);
  nodes["black-ear-l"] = node_black_ear_l_7;
  const mesh_black_ear_l_7Geometry = endpoint_black_ear_l_7
    ? new THREE.CylinderGeometry(endpoint_black_ear_l_7.endRadius, endpoint_black_ear_l_7.baseRadius, endpoint_black_ear_l_7.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 16);
  const mesh_black_ear_l_7 = new THREE.Mesh(
    mesh_black_ear_l_7Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_ear_l_7.name = "Black cat l ear pivot";
  if (endpoint_black_ear_l_7) {
    mesh_black_ear_l_7.position.copy(endpoint_black_ear_l_7.midpoint);
    mesh_black_ear_l_7.quaternion.copy(endpoint_black_ear_l_7.quaternion);
  }
  mesh_black_ear_l_7.castShadow = options.castShadow ?? true;
  mesh_black_ear_l_7.receiveShadow = options.receiveShadow ?? true;
  mesh_black_ear_l_7.userData.sculptComponent = {"id": "black-ear-l", "name": "Black cat l ear pivot", "level": "meso", "role": "ear", "importance": 0.8, "confidence": 0.94, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Black cat l ear pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.43, "height": 0.78, "depth": 0.2, "units": "world", "confidence": 0.94}, "transform": {"position": [-1.0899999999999999, 3.58, 0.19], "rotation": [0.0, 0.0, 0.12], "scale": [0.43, 0.78, 0.2]}, "actionProfile": {"animationRole": "ear", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-inner-ear-ridges"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_black_ear_l_7.add(mesh_black_ear_l_7);
  meshes["black-ear-l"] = mesh_black_ear_l_7;
  colliders["black-ear-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_ear_l_7);

  const attachment_black_inner_ear_l_8 = {"parentId": "black-ear-l", "parentSocket": "black-ear-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.54, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]};
  const endpoint_black_inner_ear_l_8 = makeAttachmentEndpoint(attachment_black_inner_ear_l_8);
  const node_black_inner_ear_l_8 = new THREE.Group();
  node_black_inner_ear_l_8.name = "Black cat l inner ear__pivot";
  if (endpoint_black_inner_ear_l_8) {
    node_black_inner_ear_l_8.position.copy(endpoint_black_inner_ear_l_8.start);
    node_black_inner_ear_l_8.rotation.set(0, 0, 0);
    node_black_inner_ear_l_8.scale.set(1, 1, 1);
  } else {
    node_black_inner_ear_l_8.position.set(-1.0899999999999999, 3.55, 0.35);
    node_black_inner_ear_l_8.rotation.set(0.0, 0.0, 0.0);
    node_black_inner_ear_l_8.scale.set(0.26, 0.54, 0.06);
  }
  node_black_inner_ear_l_8.userData.sculptComponent = {"id": "black-inner-ear-l", "name": "Black cat l inner ear", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.88, "primitive": "cone", "topologyClass": "surface-relief", "topologyRationale": "Black cat l inner ear is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-ear-l", "attachment": {"parentId": "black-ear-l", "parentSocket": "black-ear-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.54, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.26, "height": 0.54, "depth": 0.06, "units": "world", "confidence": 0.88}, "transform": {"position": [-1.0899999999999999, 3.55, 0.35], "rotation": [0.0, 0.0, 0.0], "scale": [0.26, 0.54, 0.06]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-inner-ear"}}, "material": "black-inner-ear", "materialLayers": ["black-inner-ear"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 44, 37, 1.0)", "secondaryAlbedo": "rgba(86, 54, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_black_inner_ear_l_8.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-inner-ear"}};
  (nodes["black-ear-l"] ?? root).add(node_black_inner_ear_l_8);
  nodes["black-inner-ear-l"] = node_black_inner_ear_l_8;
  const mesh_black_inner_ear_l_8Geometry = endpoint_black_inner_ear_l_8
    ? new THREE.CylinderGeometry(endpoint_black_inner_ear_l_8.endRadius, endpoint_black_inner_ear_l_8.baseRadius, endpoint_black_inner_ear_l_8.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 16);
  const mesh_black_inner_ear_l_8 = new THREE.Mesh(
    mesh_black_inner_ear_l_8Geometry,
    materialMap["black-inner-ear"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_inner_ear_l_8.name = "Black cat l inner ear";
  if (endpoint_black_inner_ear_l_8) {
    mesh_black_inner_ear_l_8.position.copy(endpoint_black_inner_ear_l_8.midpoint);
    mesh_black_inner_ear_l_8.quaternion.copy(endpoint_black_inner_ear_l_8.quaternion);
  }
  mesh_black_inner_ear_l_8.castShadow = options.castShadow ?? true;
  mesh_black_inner_ear_l_8.receiveShadow = options.receiveShadow ?? true;
  mesh_black_inner_ear_l_8.userData.sculptComponent = {"id": "black-inner-ear-l", "name": "Black cat l inner ear", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.88, "primitive": "cone", "topologyClass": "surface-relief", "topologyRationale": "Black cat l inner ear is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-ear-l", "attachment": {"parentId": "black-ear-l", "parentSocket": "black-ear-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.54, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.26, "height": 0.54, "depth": 0.06, "units": "world", "confidence": 0.88}, "transform": {"position": [-1.0899999999999999, 3.55, 0.35], "rotation": [0.0, 0.0, 0.0], "scale": [0.26, 0.54, 0.06]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-inner-ear"}}, "material": "black-inner-ear", "materialLayers": ["black-inner-ear"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 44, 37, 1.0)", "secondaryAlbedo": "rgba(86, 54, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_black_inner_ear_l_8.add(mesh_black_inner_ear_l_8);
  meshes["black-inner-ear-l"] = mesh_black_inner_ear_l_8;
  colliders["black-inner-ear-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_inner_ear_l_8);

  const attachment_black_ear_r_9 = {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]};
  const endpoint_black_ear_r_9 = makeAttachmentEndpoint(attachment_black_ear_r_9);
  const node_black_ear_r_9 = new THREE.Group();
  node_black_ear_r_9.name = "Black cat r ear pivot__pivot";
  if (endpoint_black_ear_r_9) {
    node_black_ear_r_9.position.copy(endpoint_black_ear_r_9.start);
    node_black_ear_r_9.rotation.set(0, 0, 0);
    node_black_ear_r_9.scale.set(1, 1, 1);
  } else {
    node_black_ear_r_9.position.set(-0.30999999999999994, 3.58, 0.19);
    node_black_ear_r_9.rotation.set(0.0, 0.0, -0.12);
    node_black_ear_r_9.scale.set(0.43, 0.78, 0.2);
  }
  node_black_ear_r_9.userData.sculptComponent = {"id": "black-ear-r", "name": "Black cat r ear pivot", "level": "meso", "role": "ear", "importance": 0.8, "confidence": 0.94, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Black cat r ear pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.43, "height": 0.78, "depth": 0.2, "units": "world", "confidence": 0.94}, "transform": {"position": [-0.30999999999999994, 3.58, 0.19], "rotation": [0.0, 0.0, -0.12], "scale": [0.43, 0.78, 0.2]}, "actionProfile": {"animationRole": "ear", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_black_ear_r_9.userData.actionProfile = {"animationRole": "ear", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-head"] ?? root).add(node_black_ear_r_9);
  nodes["black-ear-r"] = node_black_ear_r_9;
  const mesh_black_ear_r_9Geometry = endpoint_black_ear_r_9
    ? new THREE.CylinderGeometry(endpoint_black_ear_r_9.endRadius, endpoint_black_ear_r_9.baseRadius, endpoint_black_ear_r_9.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 16);
  const mesh_black_ear_r_9 = new THREE.Mesh(
    mesh_black_ear_r_9Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_ear_r_9.name = "Black cat r ear pivot";
  if (endpoint_black_ear_r_9) {
    mesh_black_ear_r_9.position.copy(endpoint_black_ear_r_9.midpoint);
    mesh_black_ear_r_9.quaternion.copy(endpoint_black_ear_r_9.quaternion);
  }
  mesh_black_ear_r_9.castShadow = options.castShadow ?? true;
  mesh_black_ear_r_9.receiveShadow = options.receiveShadow ?? true;
  mesh_black_ear_r_9.userData.sculptComponent = {"id": "black-ear-r", "name": "Black cat r ear pivot", "level": "meso", "role": "ear", "importance": 0.8, "confidence": 0.94, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Black cat r ear pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.43, "height": 0.78, "depth": 0.2, "units": "world", "confidence": 0.94}, "transform": {"position": [-0.30999999999999994, 3.58, 0.19], "rotation": [0.0, 0.0, -0.12], "scale": [0.43, 0.78, 0.2]}, "actionProfile": {"animationRole": "ear", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_black_ear_r_9.add(mesh_black_ear_r_9);
  meshes["black-ear-r"] = mesh_black_ear_r_9;
  colliders["black-ear-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_ear_r_9);

  const attachment_black_inner_ear_r_10 = {"parentId": "black-ear-r", "parentSocket": "black-ear-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.54, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]};
  const endpoint_black_inner_ear_r_10 = makeAttachmentEndpoint(attachment_black_inner_ear_r_10);
  const node_black_inner_ear_r_10 = new THREE.Group();
  node_black_inner_ear_r_10.name = "Black cat r inner ear__pivot";
  if (endpoint_black_inner_ear_r_10) {
    node_black_inner_ear_r_10.position.copy(endpoint_black_inner_ear_r_10.start);
    node_black_inner_ear_r_10.rotation.set(0, 0, 0);
    node_black_inner_ear_r_10.scale.set(1, 1, 1);
  } else {
    node_black_inner_ear_r_10.position.set(-0.30999999999999994, 3.55, 0.35);
    node_black_inner_ear_r_10.rotation.set(0.0, 0.0, 0.0);
    node_black_inner_ear_r_10.scale.set(0.26, 0.54, 0.06);
  }
  node_black_inner_ear_r_10.userData.sculptComponent = {"id": "black-inner-ear-r", "name": "Black cat r inner ear", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.88, "primitive": "cone", "topologyClass": "surface-relief", "topologyRationale": "Black cat r inner ear is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-ear-r", "attachment": {"parentId": "black-ear-r", "parentSocket": "black-ear-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.54, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.26, "height": 0.54, "depth": 0.06, "units": "world", "confidence": 0.88}, "transform": {"position": [-0.30999999999999994, 3.55, 0.35], "rotation": [0.0, 0.0, 0.0], "scale": [0.26, 0.54, 0.06]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-inner-ear"}}, "material": "black-inner-ear", "materialLayers": ["black-inner-ear"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 44, 37, 1.0)", "secondaryAlbedo": "rgba(86, 54, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_black_inner_ear_r_10.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-inner-ear"}};
  (nodes["black-ear-r"] ?? root).add(node_black_inner_ear_r_10);
  nodes["black-inner-ear-r"] = node_black_inner_ear_r_10;
  const mesh_black_inner_ear_r_10Geometry = endpoint_black_inner_ear_r_10
    ? new THREE.CylinderGeometry(endpoint_black_inner_ear_r_10.endRadius, endpoint_black_inner_ear_r_10.baseRadius, endpoint_black_inner_ear_r_10.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 16);
  const mesh_black_inner_ear_r_10 = new THREE.Mesh(
    mesh_black_inner_ear_r_10Geometry,
    materialMap["black-inner-ear"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_inner_ear_r_10.name = "Black cat r inner ear";
  if (endpoint_black_inner_ear_r_10) {
    mesh_black_inner_ear_r_10.position.copy(endpoint_black_inner_ear_r_10.midpoint);
    mesh_black_inner_ear_r_10.quaternion.copy(endpoint_black_inner_ear_r_10.quaternion);
  }
  mesh_black_inner_ear_r_10.castShadow = options.castShadow ?? true;
  mesh_black_inner_ear_r_10.receiveShadow = options.receiveShadow ?? true;
  mesh_black_inner_ear_r_10.userData.sculptComponent = {"id": "black-inner-ear-r", "name": "Black cat r inner ear", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.88, "primitive": "cone", "topologyClass": "surface-relief", "topologyRationale": "Black cat r inner ear is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-ear-r", "attachment": {"parentId": "black-ear-r", "parentSocket": "black-ear-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.54, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.26, "height": 0.54, "depth": 0.06, "units": "world", "confidence": 0.88}, "transform": {"position": [-0.30999999999999994, 3.55, 0.35], "rotation": [0.0, 0.0, 0.0], "scale": [0.26, 0.54, 0.06]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-inner-ear"}}, "material": "black-inner-ear", "materialLayers": ["black-inner-ear"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(74, 44, 37, 1.0)", "secondaryAlbedo": "rgba(86, 54, 45, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_black_inner_ear_r_10.add(mesh_black_inner_ear_r_10);
  meshes["black-inner-ear-r"] = mesh_black_inner_ear_r_10;
  colliders["black-inner-ear-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_inner_ear_r_10);

  const attachment_black_eye_l_11 = {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.27, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_eye_l_11 = makeAttachmentEndpoint(attachment_black_eye_l_11);
  const node_black_eye_l_11 = new THREE.Group();
  node_black_eye_l_11.name = "Black cat l eyeball__pivot";
  if (endpoint_black_eye_l_11) {
    node_black_eye_l_11.position.copy(endpoint_black_eye_l_11.start);
    node_black_eye_l_11.rotation.set(0, 0, 0);
    node_black_eye_l_11.scale.set(1, 1, 1);
  } else {
    node_black_eye_l_11.position.set(-0.95, 2.99, 0.72);
    node_black_eye_l_11.rotation.set(0.0, 0.0, 0.0);
    node_black_eye_l_11.scale.set(0.25, 0.27, 0.16);
  }
  node_black_eye_l_11.userData.sculptComponent = {"id": "black-eye-l", "name": "Black cat l eyeball", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.98, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l eyeball is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.27, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.25, "height": 0.27, "depth": 0.16, "units": "world", "confidence": 0.98}, "transform": {"position": [-0.95, 2.99, 0.72], "rotation": [0.0, 0.0, 0.0], "scale": [0.25, 0.27, 0.16]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_eye_l_11.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}};
  (nodes["black-head"] ?? root).add(node_black_eye_l_11);
  nodes["black-eye-l"] = node_black_eye_l_11;
  const mesh_black_eye_l_11Geometry = endpoint_black_eye_l_11
    ? new THREE.CylinderGeometry(endpoint_black_eye_l_11.endRadius, endpoint_black_eye_l_11.baseRadius, endpoint_black_eye_l_11.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_eye_l_11 = new THREE.Mesh(
    mesh_black_eye_l_11Geometry,
    materialMap["iris-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_eye_l_11.name = "Black cat l eyeball";
  if (endpoint_black_eye_l_11) {
    mesh_black_eye_l_11.position.copy(endpoint_black_eye_l_11.midpoint);
    mesh_black_eye_l_11.quaternion.copy(endpoint_black_eye_l_11.quaternion);
  }
  mesh_black_eye_l_11.castShadow = options.castShadow ?? true;
  mesh_black_eye_l_11.receiveShadow = options.receiveShadow ?? true;
  mesh_black_eye_l_11.userData.sculptComponent = {"id": "black-eye-l", "name": "Black cat l eyeball", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.98, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l eyeball is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.27, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.25, "height": 0.27, "depth": 0.16, "units": "world", "confidence": 0.98}, "transform": {"position": [-0.95, 2.99, 0.72], "rotation": [0.0, 0.0, 0.0], "scale": [0.25, 0.27, 0.16]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_eye_l_11.add(mesh_black_eye_l_11);
  meshes["black-eye-l"] = mesh_black_eye_l_11;
  colliders["black-eye-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_eye_l_11);

  const attachment_black_iris_l_12 = {"parentId": "black-eye-l", "parentSocket": "black-eye-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.22, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_iris_l_12 = makeAttachmentEndpoint(attachment_black_iris_l_12);
  const node_black_iris_l_12 = new THREE.Group();
  node_black_iris_l_12.name = "Black cat l iris ring__pivot";
  if (endpoint_black_iris_l_12) {
    node_black_iris_l_12.position.copy(endpoint_black_iris_l_12.start);
    node_black_iris_l_12.rotation.set(0, 0, 0);
    node_black_iris_l_12.scale.set(1, 1, 1);
  } else {
    node_black_iris_l_12.position.set(-0.95, 2.99, 0.825);
    node_black_iris_l_12.rotation.set(0.0, 0.0, 0.0);
    node_black_iris_l_12.scale.set(0.205, 0.22, 0.035);
  }
  node_black_iris_l_12.userData.sculptComponent = {"id": "black-iris-l", "name": "Black cat l iris ring", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.97, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l iris ring is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-eye-l", "attachment": {"parentId": "black-eye-l", "parentSocket": "black-eye-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.22, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.205, "height": 0.22, "depth": 0.035, "units": "world", "confidence": 0.97}, "transform": {"position": [-0.95, 2.99, 0.825], "rotation": [0.0, 0.0, 0.0], "scale": [0.205, 0.22, 0.035]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_iris_l_12.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}};
  (nodes["black-eye-l"] ?? root).add(node_black_iris_l_12);
  nodes["black-iris-l"] = node_black_iris_l_12;
  const mesh_black_iris_l_12Geometry = endpoint_black_iris_l_12
    ? new THREE.CylinderGeometry(endpoint_black_iris_l_12.endRadius, endpoint_black_iris_l_12.baseRadius, endpoint_black_iris_l_12.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_iris_l_12 = new THREE.Mesh(
    mesh_black_iris_l_12Geometry,
    materialMap["iris-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_iris_l_12.name = "Black cat l iris ring";
  if (endpoint_black_iris_l_12) {
    mesh_black_iris_l_12.position.copy(endpoint_black_iris_l_12.midpoint);
    mesh_black_iris_l_12.quaternion.copy(endpoint_black_iris_l_12.quaternion);
  }
  mesh_black_iris_l_12.castShadow = options.castShadow ?? true;
  mesh_black_iris_l_12.receiveShadow = options.receiveShadow ?? true;
  mesh_black_iris_l_12.userData.sculptComponent = {"id": "black-iris-l", "name": "Black cat l iris ring", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.97, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l iris ring is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-eye-l", "attachment": {"parentId": "black-eye-l", "parentSocket": "black-eye-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.22, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.205, "height": 0.22, "depth": 0.035, "units": "world", "confidence": 0.97}, "transform": {"position": [-0.95, 2.99, 0.825], "rotation": [0.0, 0.0, 0.0], "scale": [0.205, 0.22, 0.035]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_iris_l_12.add(mesh_black_iris_l_12);
  meshes["black-iris-l"] = mesh_black_iris_l_12;
  colliders["black-iris-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_iris_l_12);

  const attachment_black_pupil_l_13 = {"parentId": "black-iris-l", "parentSocket": "black-iris-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.145, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_pupil_l_13 = makeAttachmentEndpoint(attachment_black_pupil_l_13);
  const node_black_pupil_l_13 = new THREE.Group();
  node_black_pupil_l_13.name = "Black cat l round pupil__pivot";
  if (endpoint_black_pupil_l_13) {
    node_black_pupil_l_13.position.copy(endpoint_black_pupil_l_13.start);
    node_black_pupil_l_13.rotation.set(0, 0, 0);
    node_black_pupil_l_13.scale.set(1, 1, 1);
  } else {
    node_black_pupil_l_13.position.set(-0.95, 2.99, 0.855);
    node_black_pupil_l_13.rotation.set(0.0, 0.0, 0.0);
    node_black_pupil_l_13.scale.set(0.13, 0.145, 0.022);
  }
  node_black_pupil_l_13.userData.sculptComponent = {"id": "black-pupil-l", "name": "Black cat l round pupil", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.99, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l round pupil is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-iris-l", "attachment": {"parentId": "black-iris-l", "parentSocket": "black-iris-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.145, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.13, "height": 0.145, "depth": 0.022, "units": "world", "confidence": 0.99}, "transform": {"position": [-0.95, 2.99, 0.855], "rotation": [0.0, 0.0, 0.0], "scale": [0.13, 0.145, 0.022]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pupil"}}, "material": "pupil", "materialLayers": ["pupil"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(2, 4, 3, 1.0)", "secondaryAlbedo": "rgba(14, 14, 11, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_pupil_l_13.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pupil"}};
  (nodes["black-iris-l"] ?? root).add(node_black_pupil_l_13);
  nodes["black-pupil-l"] = node_black_pupil_l_13;
  const mesh_black_pupil_l_13Geometry = endpoint_black_pupil_l_13
    ? new THREE.CylinderGeometry(endpoint_black_pupil_l_13.endRadius, endpoint_black_pupil_l_13.baseRadius, endpoint_black_pupil_l_13.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_pupil_l_13 = new THREE.Mesh(
    mesh_black_pupil_l_13Geometry,
    materialMap["pupil"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_pupil_l_13.name = "Black cat l round pupil";
  if (endpoint_black_pupil_l_13) {
    mesh_black_pupil_l_13.position.copy(endpoint_black_pupil_l_13.midpoint);
    mesh_black_pupil_l_13.quaternion.copy(endpoint_black_pupil_l_13.quaternion);
  }
  mesh_black_pupil_l_13.castShadow = options.castShadow ?? true;
  mesh_black_pupil_l_13.receiveShadow = options.receiveShadow ?? true;
  mesh_black_pupil_l_13.userData.sculptComponent = {"id": "black-pupil-l", "name": "Black cat l round pupil", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.99, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l round pupil is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-iris-l", "attachment": {"parentId": "black-iris-l", "parentSocket": "black-iris-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.145, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.13, "height": 0.145, "depth": 0.022, "units": "world", "confidence": 0.99}, "transform": {"position": [-0.95, 2.99, 0.855], "rotation": [0.0, 0.0, 0.0], "scale": [0.13, 0.145, 0.022]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pupil"}}, "material": "pupil", "materialLayers": ["pupil"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(2, 4, 3, 1.0)", "secondaryAlbedo": "rgba(14, 14, 11, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_pupil_l_13.add(mesh_black_pupil_l_13);
  meshes["black-pupil-l"] = mesh_black_pupil_l_13;
  colliders["black-pupil-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_pupil_l_13);

  const attachment_black_cornea_l_14 = {"parentId": "black-eye-l", "parentSocket": "black-eye-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_cornea_l_14 = makeAttachmentEndpoint(attachment_black_cornea_l_14);
  const node_black_cornea_l_14 = new THREE.Group();
  node_black_cornea_l_14.name = "Black cat l convex cornea__pivot";
  if (endpoint_black_cornea_l_14) {
    node_black_cornea_l_14.position.copy(endpoint_black_cornea_l_14.start);
    node_black_cornea_l_14.rotation.set(0, 0, 0);
    node_black_cornea_l_14.scale.set(1, 1, 1);
  } else {
    node_black_cornea_l_14.position.set(-0.95, 2.99, 0.87);
    node_black_cornea_l_14.rotation.set(0.0, 0.0, 0.0);
    node_black_cornea_l_14.scale.set(0.225, 0.24, 0.05);
  }
  node_black_cornea_l_14.userData.sculptComponent = {"id": "black-cornea-l", "name": "Black cat l convex cornea", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.96, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l convex cornea is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-eye-l", "attachment": {"parentId": "black-eye-l", "parentSocket": "black-eye-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.225, "height": 0.24, "depth": 0.05, "units": "world", "confidence": 0.96}, "transform": {"position": [-0.95, 2.99, 0.87], "rotation": [0.0, 0.0, 0.0], "scale": [0.225, 0.24, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cornea"}}, "material": "cornea", "materialLayers": ["cornea"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 0.24)", "secondaryAlbedo": "rgba(255, 255, 255, 0.24)", "materialClass": "glass", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_cornea_l_14.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cornea"}};
  (nodes["black-eye-l"] ?? root).add(node_black_cornea_l_14);
  nodes["black-cornea-l"] = node_black_cornea_l_14;
  const mesh_black_cornea_l_14Geometry = endpoint_black_cornea_l_14
    ? new THREE.CylinderGeometry(endpoint_black_cornea_l_14.endRadius, endpoint_black_cornea_l_14.baseRadius, endpoint_black_cornea_l_14.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_cornea_l_14 = new THREE.Mesh(
    mesh_black_cornea_l_14Geometry,
    materialMap["cornea"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_cornea_l_14.name = "Black cat l convex cornea";
  if (endpoint_black_cornea_l_14) {
    mesh_black_cornea_l_14.position.copy(endpoint_black_cornea_l_14.midpoint);
    mesh_black_cornea_l_14.quaternion.copy(endpoint_black_cornea_l_14.quaternion);
  }
  mesh_black_cornea_l_14.castShadow = options.castShadow ?? true;
  mesh_black_cornea_l_14.receiveShadow = options.receiveShadow ?? true;
  mesh_black_cornea_l_14.userData.sculptComponent = {"id": "black-cornea-l", "name": "Black cat l convex cornea", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.96, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l convex cornea is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-eye-l", "attachment": {"parentId": "black-eye-l", "parentSocket": "black-eye-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.225, "height": 0.24, "depth": 0.05, "units": "world", "confidence": 0.96}, "transform": {"position": [-0.95, 2.99, 0.87], "rotation": [0.0, 0.0, 0.0], "scale": [0.225, 0.24, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cornea"}}, "material": "cornea", "materialLayers": ["cornea"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 0.24)", "secondaryAlbedo": "rgba(255, 255, 255, 0.24)", "materialClass": "glass", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_cornea_l_14.add(mesh_black_cornea_l_14);
  meshes["black-cornea-l"] = mesh_black_cornea_l_14;
  colliders["black-cornea-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_cornea_l_14);

  const attachment_black_eye_r_15 = {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.27, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_eye_r_15 = makeAttachmentEndpoint(attachment_black_eye_r_15);
  const node_black_eye_r_15 = new THREE.Group();
  node_black_eye_r_15.name = "Black cat r eyeball__pivot";
  if (endpoint_black_eye_r_15) {
    node_black_eye_r_15.position.copy(endpoint_black_eye_r_15.start);
    node_black_eye_r_15.rotation.set(0, 0, 0);
    node_black_eye_r_15.scale.set(1, 1, 1);
  } else {
    node_black_eye_r_15.position.set(-0.44999999999999996, 2.99, 0.72);
    node_black_eye_r_15.rotation.set(0.0, 0.0, 0.0);
    node_black_eye_r_15.scale.set(0.25, 0.27, 0.16);
  }
  node_black_eye_r_15.userData.sculptComponent = {"id": "black-eye-r", "name": "Black cat r eyeball", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.98, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r eyeball is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.27, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.25, "height": 0.27, "depth": 0.16, "units": "world", "confidence": 0.98}, "transform": {"position": [-0.44999999999999996, 2.99, 0.72], "rotation": [0.0, 0.0, 0.0], "scale": [0.25, 0.27, 0.16]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_eye_r_15.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}};
  (nodes["black-head"] ?? root).add(node_black_eye_r_15);
  nodes["black-eye-r"] = node_black_eye_r_15;
  const mesh_black_eye_r_15Geometry = endpoint_black_eye_r_15
    ? new THREE.CylinderGeometry(endpoint_black_eye_r_15.endRadius, endpoint_black_eye_r_15.baseRadius, endpoint_black_eye_r_15.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_eye_r_15 = new THREE.Mesh(
    mesh_black_eye_r_15Geometry,
    materialMap["iris-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_eye_r_15.name = "Black cat r eyeball";
  if (endpoint_black_eye_r_15) {
    mesh_black_eye_r_15.position.copy(endpoint_black_eye_r_15.midpoint);
    mesh_black_eye_r_15.quaternion.copy(endpoint_black_eye_r_15.quaternion);
  }
  mesh_black_eye_r_15.castShadow = options.castShadow ?? true;
  mesh_black_eye_r_15.receiveShadow = options.receiveShadow ?? true;
  mesh_black_eye_r_15.userData.sculptComponent = {"id": "black-eye-r", "name": "Black cat r eyeball", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.98, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r eyeball is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.27, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.25, "height": 0.27, "depth": 0.16, "units": "world", "confidence": 0.98}, "transform": {"position": [-0.44999999999999996, 2.99, 0.72], "rotation": [0.0, 0.0, 0.0], "scale": [0.25, 0.27, 0.16]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_eye_r_15.add(mesh_black_eye_r_15);
  meshes["black-eye-r"] = mesh_black_eye_r_15;
  colliders["black-eye-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_eye_r_15);

  const attachment_black_iris_r_16 = {"parentId": "black-eye-r", "parentSocket": "black-eye-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.22, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_iris_r_16 = makeAttachmentEndpoint(attachment_black_iris_r_16);
  const node_black_iris_r_16 = new THREE.Group();
  node_black_iris_r_16.name = "Black cat r iris ring__pivot";
  if (endpoint_black_iris_r_16) {
    node_black_iris_r_16.position.copy(endpoint_black_iris_r_16.start);
    node_black_iris_r_16.rotation.set(0, 0, 0);
    node_black_iris_r_16.scale.set(1, 1, 1);
  } else {
    node_black_iris_r_16.position.set(-0.44999999999999996, 2.99, 0.825);
    node_black_iris_r_16.rotation.set(0.0, 0.0, 0.0);
    node_black_iris_r_16.scale.set(0.205, 0.22, 0.035);
  }
  node_black_iris_r_16.userData.sculptComponent = {"id": "black-iris-r", "name": "Black cat r iris ring", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.97, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r iris ring is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-eye-r", "attachment": {"parentId": "black-eye-r", "parentSocket": "black-eye-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.22, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.205, "height": 0.22, "depth": 0.035, "units": "world", "confidence": 0.97}, "transform": {"position": [-0.44999999999999996, 2.99, 0.825], "rotation": [0.0, 0.0, 0.0], "scale": [0.205, 0.22, 0.035]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_iris_r_16.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}};
  (nodes["black-eye-r"] ?? root).add(node_black_iris_r_16);
  nodes["black-iris-r"] = node_black_iris_r_16;
  const mesh_black_iris_r_16Geometry = endpoint_black_iris_r_16
    ? new THREE.CylinderGeometry(endpoint_black_iris_r_16.endRadius, endpoint_black_iris_r_16.baseRadius, endpoint_black_iris_r_16.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_iris_r_16 = new THREE.Mesh(
    mesh_black_iris_r_16Geometry,
    materialMap["iris-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_iris_r_16.name = "Black cat r iris ring";
  if (endpoint_black_iris_r_16) {
    mesh_black_iris_r_16.position.copy(endpoint_black_iris_r_16.midpoint);
    mesh_black_iris_r_16.quaternion.copy(endpoint_black_iris_r_16.quaternion);
  }
  mesh_black_iris_r_16.castShadow = options.castShadow ?? true;
  mesh_black_iris_r_16.receiveShadow = options.receiveShadow ?? true;
  mesh_black_iris_r_16.userData.sculptComponent = {"id": "black-iris-r", "name": "Black cat r iris ring", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.97, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r iris ring is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-eye-r", "attachment": {"parentId": "black-eye-r", "parentSocket": "black-eye-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.22, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.205, "height": 0.22, "depth": 0.035, "units": "world", "confidence": 0.97}, "transform": {"position": [-0.44999999999999996, 2.99, 0.825], "rotation": [0.0, 0.0, 0.0], "scale": [0.205, 0.22, 0.035]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_iris_r_16.add(mesh_black_iris_r_16);
  meshes["black-iris-r"] = mesh_black_iris_r_16;
  colliders["black-iris-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_iris_r_16);

  const attachment_black_pupil_r_17 = {"parentId": "black-iris-r", "parentSocket": "black-iris-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.145, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_pupil_r_17 = makeAttachmentEndpoint(attachment_black_pupil_r_17);
  const node_black_pupil_r_17 = new THREE.Group();
  node_black_pupil_r_17.name = "Black cat r round pupil__pivot";
  if (endpoint_black_pupil_r_17) {
    node_black_pupil_r_17.position.copy(endpoint_black_pupil_r_17.start);
    node_black_pupil_r_17.rotation.set(0, 0, 0);
    node_black_pupil_r_17.scale.set(1, 1, 1);
  } else {
    node_black_pupil_r_17.position.set(-0.44999999999999996, 2.99, 0.855);
    node_black_pupil_r_17.rotation.set(0.0, 0.0, 0.0);
    node_black_pupil_r_17.scale.set(0.13, 0.145, 0.022);
  }
  node_black_pupil_r_17.userData.sculptComponent = {"id": "black-pupil-r", "name": "Black cat r round pupil", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.99, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r round pupil is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-iris-r", "attachment": {"parentId": "black-iris-r", "parentSocket": "black-iris-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.145, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.13, "height": 0.145, "depth": 0.022, "units": "world", "confidence": 0.99}, "transform": {"position": [-0.44999999999999996, 2.99, 0.855], "rotation": [0.0, 0.0, 0.0], "scale": [0.13, 0.145, 0.022]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pupil"}}, "material": "pupil", "materialLayers": ["pupil"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(2, 4, 3, 1.0)", "secondaryAlbedo": "rgba(14, 14, 11, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_pupil_r_17.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pupil"}};
  (nodes["black-iris-r"] ?? root).add(node_black_pupil_r_17);
  nodes["black-pupil-r"] = node_black_pupil_r_17;
  const mesh_black_pupil_r_17Geometry = endpoint_black_pupil_r_17
    ? new THREE.CylinderGeometry(endpoint_black_pupil_r_17.endRadius, endpoint_black_pupil_r_17.baseRadius, endpoint_black_pupil_r_17.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_pupil_r_17 = new THREE.Mesh(
    mesh_black_pupil_r_17Geometry,
    materialMap["pupil"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_pupil_r_17.name = "Black cat r round pupil";
  if (endpoint_black_pupil_r_17) {
    mesh_black_pupil_r_17.position.copy(endpoint_black_pupil_r_17.midpoint);
    mesh_black_pupil_r_17.quaternion.copy(endpoint_black_pupil_r_17.quaternion);
  }
  mesh_black_pupil_r_17.castShadow = options.castShadow ?? true;
  mesh_black_pupil_r_17.receiveShadow = options.receiveShadow ?? true;
  mesh_black_pupil_r_17.userData.sculptComponent = {"id": "black-pupil-r", "name": "Black cat r round pupil", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.99, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r round pupil is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-iris-r", "attachment": {"parentId": "black-iris-r", "parentSocket": "black-iris-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.145, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.13, "height": 0.145, "depth": 0.022, "units": "world", "confidence": 0.99}, "transform": {"position": [-0.44999999999999996, 2.99, 0.855], "rotation": [0.0, 0.0, 0.0], "scale": [0.13, 0.145, 0.022]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pupil"}}, "material": "pupil", "materialLayers": ["pupil"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(2, 4, 3, 1.0)", "secondaryAlbedo": "rgba(14, 14, 11, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_pupil_r_17.add(mesh_black_pupil_r_17);
  meshes["black-pupil-r"] = mesh_black_pupil_r_17;
  colliders["black-pupil-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_pupil_r_17);

  const attachment_black_cornea_r_18 = {"parentId": "black-eye-r", "parentSocket": "black-eye-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_cornea_r_18 = makeAttachmentEndpoint(attachment_black_cornea_r_18);
  const node_black_cornea_r_18 = new THREE.Group();
  node_black_cornea_r_18.name = "Black cat r convex cornea__pivot";
  if (endpoint_black_cornea_r_18) {
    node_black_cornea_r_18.position.copy(endpoint_black_cornea_r_18.start);
    node_black_cornea_r_18.rotation.set(0, 0, 0);
    node_black_cornea_r_18.scale.set(1, 1, 1);
  } else {
    node_black_cornea_r_18.position.set(-0.44999999999999996, 2.99, 0.87);
    node_black_cornea_r_18.rotation.set(0.0, 0.0, 0.0);
    node_black_cornea_r_18.scale.set(0.225, 0.24, 0.05);
  }
  node_black_cornea_r_18.userData.sculptComponent = {"id": "black-cornea-r", "name": "Black cat r convex cornea", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.96, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r convex cornea is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-eye-r", "attachment": {"parentId": "black-eye-r", "parentSocket": "black-eye-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.225, "height": 0.24, "depth": 0.05, "units": "world", "confidence": 0.96}, "transform": {"position": [-0.44999999999999996, 2.99, 0.87], "rotation": [0.0, 0.0, 0.0], "scale": [0.225, 0.24, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cornea"}}, "material": "cornea", "materialLayers": ["cornea"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 0.24)", "secondaryAlbedo": "rgba(255, 255, 255, 0.24)", "materialClass": "glass", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_cornea_r_18.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cornea"}};
  (nodes["black-eye-r"] ?? root).add(node_black_cornea_r_18);
  nodes["black-cornea-r"] = node_black_cornea_r_18;
  const mesh_black_cornea_r_18Geometry = endpoint_black_cornea_r_18
    ? new THREE.CylinderGeometry(endpoint_black_cornea_r_18.endRadius, endpoint_black_cornea_r_18.baseRadius, endpoint_black_cornea_r_18.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_cornea_r_18 = new THREE.Mesh(
    mesh_black_cornea_r_18Geometry,
    materialMap["cornea"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_cornea_r_18.name = "Black cat r convex cornea";
  if (endpoint_black_cornea_r_18) {
    mesh_black_cornea_r_18.position.copy(endpoint_black_cornea_r_18.midpoint);
    mesh_black_cornea_r_18.quaternion.copy(endpoint_black_cornea_r_18.quaternion);
  }
  mesh_black_cornea_r_18.castShadow = options.castShadow ?? true;
  mesh_black_cornea_r_18.receiveShadow = options.receiveShadow ?? true;
  mesh_black_cornea_r_18.userData.sculptComponent = {"id": "black-cornea-r", "name": "Black cat r convex cornea", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.96, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r convex cornea is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-eye-r", "attachment": {"parentId": "black-eye-r", "parentSocket": "black-eye-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.225, "height": 0.24, "depth": 0.05, "units": "world", "confidence": 0.96}, "transform": {"position": [-0.44999999999999996, 2.99, 0.87], "rotation": [0.0, 0.0, 0.0], "scale": [0.225, 0.24, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cornea"}}, "material": "cornea", "materialLayers": ["cornea"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 0.24)", "secondaryAlbedo": "rgba(255, 255, 255, 0.24)", "materialClass": "glass", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_cornea_r_18.add(mesh_black_cornea_r_18);
  meshes["black-cornea-r"] = mesh_black_cornea_r_18;
  colliders["black-cornea-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_cornea_r_18);

  const attachment_black_muzzle_l_19 = {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.22, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_muzzle_l_19 = makeAttachmentEndpoint(attachment_black_muzzle_l_19);
  const node_black_muzzle_l_19 = new THREE.Group();
  node_black_muzzle_l_19.name = "Black cat l muzzle pad__pivot";
  if (endpoint_black_muzzle_l_19) {
    node_black_muzzle_l_19.position.copy(endpoint_black_muzzle_l_19.start);
    node_black_muzzle_l_19.rotation.set(0, 0, 0);
    node_black_muzzle_l_19.scale.set(1, 1, 1);
  } else {
    node_black_muzzle_l_19.position.set(-0.8799999999999999, 2.66, 0.7);
    node_black_muzzle_l_19.rotation.set(0.0, 0.0, 0.0);
    node_black_muzzle_l_19.scale.set(0.27, 0.22, 0.2);
  }
  node_black_muzzle_l_19.userData.sculptComponent = {"id": "black-muzzle-l", "name": "Black cat l muzzle pad", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.92, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l muzzle pad is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.22, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.27, "height": 0.22, "depth": 0.2, "units": "world", "confidence": 0.92}, "transform": {"position": [-0.8799999999999999, 2.66, 0.7], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 0.22, 0.2]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_muzzle_l_19.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-head"] ?? root).add(node_black_muzzle_l_19);
  nodes["black-muzzle-l"] = node_black_muzzle_l_19;
  const mesh_black_muzzle_l_19Geometry = endpoint_black_muzzle_l_19
    ? new THREE.CylinderGeometry(endpoint_black_muzzle_l_19.endRadius, endpoint_black_muzzle_l_19.baseRadius, endpoint_black_muzzle_l_19.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_muzzle_l_19 = new THREE.Mesh(
    mesh_black_muzzle_l_19Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_muzzle_l_19.name = "Black cat l muzzle pad";
  if (endpoint_black_muzzle_l_19) {
    mesh_black_muzzle_l_19.position.copy(endpoint_black_muzzle_l_19.midpoint);
    mesh_black_muzzle_l_19.quaternion.copy(endpoint_black_muzzle_l_19.quaternion);
  }
  mesh_black_muzzle_l_19.castShadow = options.castShadow ?? true;
  mesh_black_muzzle_l_19.receiveShadow = options.receiveShadow ?? true;
  mesh_black_muzzle_l_19.userData.sculptComponent = {"id": "black-muzzle-l", "name": "Black cat l muzzle pad", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.92, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l muzzle pad is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.22, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.27, "height": 0.22, "depth": 0.2, "units": "world", "confidence": 0.92}, "transform": {"position": [-0.8799999999999999, 2.66, 0.7], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 0.22, 0.2]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_muzzle_l_19.add(mesh_black_muzzle_l_19);
  meshes["black-muzzle-l"] = mesh_black_muzzle_l_19;
  colliders["black-muzzle-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_muzzle_l_19);

  const attachment_black_whiskers_l_20 = {"parentId": "black-muzzle-l", "parentSocket": "black-muzzle-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.34, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_whiskers_l_20 = makeAttachmentEndpoint(attachment_black_whiskers_l_20);
  const node_black_whiskers_l_20 = new THREE.Group();
  node_black_whiskers_l_20.name = "Black cat l whisker fan__pivot";
  if (endpoint_black_whiskers_l_20) {
    node_black_whiskers_l_20.position.copy(endpoint_black_whiskers_l_20.start);
    node_black_whiskers_l_20.rotation.set(0, 0, 0);
    node_black_whiskers_l_20.scale.set(1, 1, 1);
  } else {
    node_black_whiskers_l_20.position.set(-0.98, 2.67, 0.83);
    node_black_whiskers_l_20.rotation.set(0.0, 0.0, 0.0);
    node_black_whiskers_l_20.scale.set(0.72, 0.34, 0.05);
  }
  node_black_whiskers_l_20.userData.sculptComponent = {"id": "black-whiskers-l", "name": "Black cat l whisker fan", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.93, "primitive": "instanced-cluster", "topologyClass": "fiber-strand", "topologyRationale": "Black cat l whisker fan is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-muzzle-l", "attachment": {"parentId": "black-muzzle-l", "parentSocket": "black-muzzle-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.34, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.72, "height": 0.34, "depth": 0.05, "units": "world", "confidence": 0.93}, "transform": {"position": [-0.98, 2.67, 0.83], "rotation": [0.0, 0.0, 0.0], "scale": [0.72, 0.34, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "whisker"}}, "material": "whisker", "materialLayers": ["whisker"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 223, 206, 1.0)", "secondaryAlbedo": "rgba(246, 233, 214, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-whisker-fan"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_whiskers_l_20.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "whisker"}};
  (nodes["black-muzzle-l"] ?? root).add(node_black_whiskers_l_20);
  nodes["black-whiskers-l"] = node_black_whiskers_l_20;
  const mesh_black_whiskers_l_20Geometry = endpoint_black_whiskers_l_20
    ? new THREE.CylinderGeometry(endpoint_black_whiskers_l_20.endRadius, endpoint_black_whiskers_l_20.baseRadius, endpoint_black_whiskers_l_20.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_black_whiskers_l_20 = new THREE.Mesh(
    mesh_black_whiskers_l_20Geometry,
    materialMap["whisker"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_whiskers_l_20.name = "Black cat l whisker fan";
  if (endpoint_black_whiskers_l_20) {
    mesh_black_whiskers_l_20.position.copy(endpoint_black_whiskers_l_20.midpoint);
    mesh_black_whiskers_l_20.quaternion.copy(endpoint_black_whiskers_l_20.quaternion);
  }
  mesh_black_whiskers_l_20.castShadow = options.castShadow ?? true;
  mesh_black_whiskers_l_20.receiveShadow = options.receiveShadow ?? true;
  mesh_black_whiskers_l_20.userData.sculptComponent = {"id": "black-whiskers-l", "name": "Black cat l whisker fan", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.93, "primitive": "instanced-cluster", "topologyClass": "fiber-strand", "topologyRationale": "Black cat l whisker fan is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-muzzle-l", "attachment": {"parentId": "black-muzzle-l", "parentSocket": "black-muzzle-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.34, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.72, "height": 0.34, "depth": 0.05, "units": "world", "confidence": 0.93}, "transform": {"position": [-0.98, 2.67, 0.83], "rotation": [0.0, 0.0, 0.0], "scale": [0.72, 0.34, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "whisker"}}, "material": "whisker", "materialLayers": ["whisker"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 223, 206, 1.0)", "secondaryAlbedo": "rgba(246, 233, 214, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-whisker-fan"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_whiskers_l_20.add(mesh_black_whiskers_l_20);
  meshes["black-whiskers-l"] = mesh_black_whiskers_l_20;
  colliders["black-whiskers-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_whiskers_l_20);

  const attachment_black_muzzle_r_21 = {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.22, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_muzzle_r_21 = makeAttachmentEndpoint(attachment_black_muzzle_r_21);
  const node_black_muzzle_r_21 = new THREE.Group();
  node_black_muzzle_r_21.name = "Black cat r muzzle pad__pivot";
  if (endpoint_black_muzzle_r_21) {
    node_black_muzzle_r_21.position.copy(endpoint_black_muzzle_r_21.start);
    node_black_muzzle_r_21.rotation.set(0, 0, 0);
    node_black_muzzle_r_21.scale.set(1, 1, 1);
  } else {
    node_black_muzzle_r_21.position.set(-0.52, 2.66, 0.7);
    node_black_muzzle_r_21.rotation.set(0.0, 0.0, 0.0);
    node_black_muzzle_r_21.scale.set(0.27, 0.22, 0.2);
  }
  node_black_muzzle_r_21.userData.sculptComponent = {"id": "black-muzzle-r", "name": "Black cat r muzzle pad", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.92, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r muzzle pad is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.22, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.27, "height": 0.22, "depth": 0.2, "units": "world", "confidence": 0.92}, "transform": {"position": [-0.52, 2.66, 0.7], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 0.22, 0.2]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_muzzle_r_21.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-head"] ?? root).add(node_black_muzzle_r_21);
  nodes["black-muzzle-r"] = node_black_muzzle_r_21;
  const mesh_black_muzzle_r_21Geometry = endpoint_black_muzzle_r_21
    ? new THREE.CylinderGeometry(endpoint_black_muzzle_r_21.endRadius, endpoint_black_muzzle_r_21.baseRadius, endpoint_black_muzzle_r_21.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_muzzle_r_21 = new THREE.Mesh(
    mesh_black_muzzle_r_21Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_muzzle_r_21.name = "Black cat r muzzle pad";
  if (endpoint_black_muzzle_r_21) {
    mesh_black_muzzle_r_21.position.copy(endpoint_black_muzzle_r_21.midpoint);
    mesh_black_muzzle_r_21.quaternion.copy(endpoint_black_muzzle_r_21.quaternion);
  }
  mesh_black_muzzle_r_21.castShadow = options.castShadow ?? true;
  mesh_black_muzzle_r_21.receiveShadow = options.receiveShadow ?? true;
  mesh_black_muzzle_r_21.userData.sculptComponent = {"id": "black-muzzle-r", "name": "Black cat r muzzle pad", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.92, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r muzzle pad is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.22, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.27, "height": 0.22, "depth": 0.2, "units": "world", "confidence": 0.92}, "transform": {"position": [-0.52, 2.66, 0.7], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 0.22, 0.2]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_muzzle_r_21.add(mesh_black_muzzle_r_21);
  meshes["black-muzzle-r"] = mesh_black_muzzle_r_21;
  colliders["black-muzzle-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_muzzle_r_21);

  const attachment_black_whiskers_r_22 = {"parentId": "black-muzzle-r", "parentSocket": "black-muzzle-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.34, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_whiskers_r_22 = makeAttachmentEndpoint(attachment_black_whiskers_r_22);
  const node_black_whiskers_r_22 = new THREE.Group();
  node_black_whiskers_r_22.name = "Black cat r whisker fan__pivot";
  if (endpoint_black_whiskers_r_22) {
    node_black_whiskers_r_22.position.copy(endpoint_black_whiskers_r_22.start);
    node_black_whiskers_r_22.rotation.set(0, 0, 0);
    node_black_whiskers_r_22.scale.set(1, 1, 1);
  } else {
    node_black_whiskers_r_22.position.set(-0.41999999999999993, 2.67, 0.83);
    node_black_whiskers_r_22.rotation.set(0.0, 0.0, 0.0);
    node_black_whiskers_r_22.scale.set(0.72, 0.34, 0.05);
  }
  node_black_whiskers_r_22.userData.sculptComponent = {"id": "black-whiskers-r", "name": "Black cat r whisker fan", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.93, "primitive": "instanced-cluster", "topologyClass": "fiber-strand", "topologyRationale": "Black cat r whisker fan is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-muzzle-r", "attachment": {"parentId": "black-muzzle-r", "parentSocket": "black-muzzle-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.34, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.72, "height": 0.34, "depth": 0.05, "units": "world", "confidence": 0.93}, "transform": {"position": [-0.41999999999999993, 2.67, 0.83], "rotation": [0.0, 0.0, 0.0], "scale": [0.72, 0.34, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "whisker"}}, "material": "whisker", "materialLayers": ["whisker"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 223, 206, 1.0)", "secondaryAlbedo": "rgba(246, 233, 214, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-whisker-fan"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_whiskers_r_22.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "whisker"}};
  (nodes["black-muzzle-r"] ?? root).add(node_black_whiskers_r_22);
  nodes["black-whiskers-r"] = node_black_whiskers_r_22;
  const mesh_black_whiskers_r_22Geometry = endpoint_black_whiskers_r_22
    ? new THREE.CylinderGeometry(endpoint_black_whiskers_r_22.endRadius, endpoint_black_whiskers_r_22.baseRadius, endpoint_black_whiskers_r_22.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_black_whiskers_r_22 = new THREE.Mesh(
    mesh_black_whiskers_r_22Geometry,
    materialMap["whisker"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_whiskers_r_22.name = "Black cat r whisker fan";
  if (endpoint_black_whiskers_r_22) {
    mesh_black_whiskers_r_22.position.copy(endpoint_black_whiskers_r_22.midpoint);
    mesh_black_whiskers_r_22.quaternion.copy(endpoint_black_whiskers_r_22.quaternion);
  }
  mesh_black_whiskers_r_22.castShadow = options.castShadow ?? true;
  mesh_black_whiskers_r_22.receiveShadow = options.receiveShadow ?? true;
  mesh_black_whiskers_r_22.userData.sculptComponent = {"id": "black-whiskers-r", "name": "Black cat r whisker fan", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.93, "primitive": "instanced-cluster", "topologyClass": "fiber-strand", "topologyRationale": "Black cat r whisker fan is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-muzzle-r", "attachment": {"parentId": "black-muzzle-r", "parentSocket": "black-muzzle-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.34, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.72, "height": 0.34, "depth": 0.05, "units": "world", "confidence": 0.93}, "transform": {"position": [-0.41999999999999993, 2.67, 0.83], "rotation": [0.0, 0.0, 0.0], "scale": [0.72, 0.34, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "whisker"}}, "material": "whisker", "materialLayers": ["whisker"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 223, 206, 1.0)", "secondaryAlbedo": "rgba(246, 233, 214, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-whisker-fan"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_whiskers_r_22.add(mesh_black_whiskers_r_22);
  meshes["black-whiskers-r"] = mesh_black_whiskers_r_22;
  colliders["black-whiskers-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_whiskers_r_22);

  const attachment_black_nose_23 = {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.14, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_nose_23 = makeAttachmentEndpoint(attachment_black_nose_23);
  const node_black_nose_23 = new THREE.Group();
  node_black_nose_23.name = "Black cat triangular nose__pivot";
  if (endpoint_black_nose_23) {
    node_black_nose_23.position.copy(endpoint_black_nose_23.start);
    node_black_nose_23.rotation.set(0, 0, 0);
    node_black_nose_23.scale.set(1, 1, 1);
  } else {
    node_black_nose_23.position.set(-0.7, 2.72, 0.87);
    node_black_nose_23.rotation.set(0.0, 0.0, 0.0);
    node_black_nose_23.scale.set(0.17, 0.14, 0.1);
  }
  node_black_nose_23.userData.sculptComponent = {"id": "black-nose", "name": "Black cat triangular nose", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.94, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Black cat triangular nose is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.14, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.17, "height": 0.14, "depth": 0.1, "units": "world", "confidence": 0.94}, "transform": {"position": [-0.7, 2.72, 0.87], "rotation": [0.0, 0.0, 0.0], "scale": [0.17, 0.14, 0.1]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-nose"}}, "material": "black-nose", "materialLayers": ["black-nose"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(41, 32, 29, 1.0)", "secondaryAlbedo": "rgba(53, 42, 37, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_nose_23.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-nose"}};
  (nodes["black-head"] ?? root).add(node_black_nose_23);
  nodes["black-nose"] = node_black_nose_23;
  const mesh_black_nose_23Geometry = endpoint_black_nose_23
    ? new THREE.CylinderGeometry(endpoint_black_nose_23.endRadius, endpoint_black_nose_23.baseRadius, endpoint_black_nose_23.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 16);
  const mesh_black_nose_23 = new THREE.Mesh(
    mesh_black_nose_23Geometry,
    materialMap["black-nose"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_nose_23.name = "Black cat triangular nose";
  if (endpoint_black_nose_23) {
    mesh_black_nose_23.position.copy(endpoint_black_nose_23.midpoint);
    mesh_black_nose_23.quaternion.copy(endpoint_black_nose_23.quaternion);
  }
  mesh_black_nose_23.castShadow = options.castShadow ?? true;
  mesh_black_nose_23.receiveShadow = options.receiveShadow ?? true;
  mesh_black_nose_23.userData.sculptComponent = {"id": "black-nose", "name": "Black cat triangular nose", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.94, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Black cat triangular nose is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.14, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.17, "height": 0.14, "depth": 0.1, "units": "world", "confidence": 0.94}, "transform": {"position": [-0.7, 2.72, 0.87], "rotation": [0.0, 0.0, 0.0], "scale": [0.17, 0.14, 0.1]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-nose"}}, "material": "black-nose", "materialLayers": ["black-nose"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(41, 32, 29, 1.0)", "secondaryAlbedo": "rgba(53, 42, 37, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_nose_23.add(mesh_black_nose_23);
  meshes["black-nose"] = mesh_black_nose_23;
  colliders["black-nose"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_nose_23);

  const attachment_black_chin_24 = {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.15, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_chin_24 = makeAttachmentEndpoint(attachment_black_chin_24);
  const node_black_chin_24 = new THREE.Group();
  node_black_chin_24.name = "Black cat chin__pivot";
  if (endpoint_black_chin_24) {
    node_black_chin_24.position.copy(endpoint_black_chin_24.start);
    node_black_chin_24.rotation.set(0, 0, 0);
    node_black_chin_24.scale.set(1, 1, 1);
  } else {
    node_black_chin_24.position.set(-0.7, 2.52, 0.66);
    node_black_chin_24.rotation.set(0.0, 0.0, 0.0);
    node_black_chin_24.scale.set(0.26, 0.15, 0.16);
  }
  node_black_chin_24.userData.sculptComponent = {"id": "black-chin", "name": "Black cat chin", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat chin is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.15, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.26, "height": 0.15, "depth": 0.16, "units": "world", "confidence": 0.82}, "transform": {"position": [-0.7, 2.52, 0.66], "rotation": [0.0, 0.0, 0.0], "scale": [0.26, 0.15, 0.16]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_chin_24.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-head"] ?? root).add(node_black_chin_24);
  nodes["black-chin"] = node_black_chin_24;
  const mesh_black_chin_24Geometry = endpoint_black_chin_24
    ? new THREE.CylinderGeometry(endpoint_black_chin_24.endRadius, endpoint_black_chin_24.baseRadius, endpoint_black_chin_24.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_chin_24 = new THREE.Mesh(
    mesh_black_chin_24Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_chin_24.name = "Black cat chin";
  if (endpoint_black_chin_24) {
    mesh_black_chin_24.position.copy(endpoint_black_chin_24.midpoint);
    mesh_black_chin_24.quaternion.copy(endpoint_black_chin_24.quaternion);
  }
  mesh_black_chin_24.castShadow = options.castShadow ?? true;
  mesh_black_chin_24.receiveShadow = options.receiveShadow ?? true;
  mesh_black_chin_24.userData.sculptComponent = {"id": "black-chin", "name": "Black cat chin", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.82, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat chin is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-head", "attachment": {"parentId": "black-head", "parentSocket": "black-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.15, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.26, "height": 0.15, "depth": 0.16, "units": "world", "confidence": 0.82}, "transform": {"position": [-0.7, 2.52, 0.66], "rotation": [0.0, 0.0, 0.0], "scale": [0.26, 0.15, 0.16]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_chin_24.add(mesh_black_chin_24);
  meshes["black-chin"] = mesh_black_chin_24;
  colliders["black-chin"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_chin_24);

  const attachment_black_front_leg_l_25 = {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.18, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]};
  const endpoint_black_front_leg_l_25 = makeAttachmentEndpoint(attachment_black_front_leg_l_25);
  const node_black_front_leg_l_25 = new THREE.Group();
  node_black_front_leg_l_25.name = "Black cat l front leg__pivot";
  if (endpoint_black_front_leg_l_25) {
    node_black_front_leg_l_25.position.copy(endpoint_black_front_leg_l_25.start);
    node_black_front_leg_l_25.rotation.set(0, 0, 0);
    node_black_front_leg_l_25.scale.set(1, 1, 1);
  } else {
    node_black_front_leg_l_25.position.set(-0.92, 0.72, 0.28);
    node_black_front_leg_l_25.rotation.set(0.0, 0.0, 0.0);
    node_black_front_leg_l_25.scale.set(0.27, 1.18, 0.29);
  }
  node_black_front_leg_l_25.userData.sculptComponent = {"id": "black-front-leg-l", "name": "Black cat l front leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.9, "primitive": "capsule", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l front leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-torso", "attachment": {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.18, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.27, "height": 1.18, "depth": 0.29, "units": "world", "confidence": 0.9}, "transform": {"position": [-0.92, 0.72, 0.28], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 1.18, 0.29]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_front_leg_l_25.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-torso"] ?? root).add(node_black_front_leg_l_25);
  nodes["black-front-leg-l"] = node_black_front_leg_l_25;
  const mesh_black_front_leg_l_25Geometry = endpoint_black_front_leg_l_25
    ? new THREE.CylinderGeometry(endpoint_black_front_leg_l_25.endRadius, endpoint_black_front_leg_l_25.baseRadius, endpoint_black_front_leg_l_25.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_black_front_leg_l_25 = new THREE.Mesh(
    mesh_black_front_leg_l_25Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_front_leg_l_25.name = "Black cat l front leg";
  if (endpoint_black_front_leg_l_25) {
    mesh_black_front_leg_l_25.position.copy(endpoint_black_front_leg_l_25.midpoint);
    mesh_black_front_leg_l_25.quaternion.copy(endpoint_black_front_leg_l_25.quaternion);
  }
  mesh_black_front_leg_l_25.castShadow = options.castShadow ?? true;
  mesh_black_front_leg_l_25.receiveShadow = options.receiveShadow ?? true;
  mesh_black_front_leg_l_25.userData.sculptComponent = {"id": "black-front-leg-l", "name": "Black cat l front leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.9, "primitive": "capsule", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l front leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-torso", "attachment": {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.18, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.27, "height": 1.18, "depth": 0.29, "units": "world", "confidence": 0.9}, "transform": {"position": [-0.92, 0.72, 0.28], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 1.18, 0.29]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_front_leg_l_25.add(mesh_black_front_leg_l_25);
  meshes["black-front-leg-l"] = mesh_black_front_leg_l_25;
  colliders["black-front-leg-l"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_front_leg_l_25);

  const attachment_black_front_paw_l_26 = {"parentId": "black-front-leg-l", "parentSocket": "black-front-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.23, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-paws"]};
  const endpoint_black_front_paw_l_26 = makeAttachmentEndpoint(attachment_black_front_paw_l_26);
  const node_black_front_paw_l_26 = new THREE.Group();
  node_black_front_paw_l_26.name = "Black cat l front paw__pivot";
  if (endpoint_black_front_paw_l_26) {
    node_black_front_paw_l_26.position.copy(endpoint_black_front_paw_l_26.start);
    node_black_front_paw_l_26.rotation.set(0, 0, 0);
    node_black_front_paw_l_26.scale.set(1, 1, 1);
  } else {
    node_black_front_paw_l_26.position.set(-0.92, 0.16, 0.45);
    node_black_front_paw_l_26.rotation.set(0.0, 0.0, 0.0);
    node_black_front_paw_l_26.scale.set(0.36, 0.23, 0.48);
  }
  node_black_front_paw_l_26.userData.sculptComponent = {"id": "black-front-paw-l", "name": "Black cat l front paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.94, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l front paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-front-leg-l", "attachment": {"parentId": "black-front-leg-l", "parentSocket": "black-front-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.23, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-paws"]}, "dimensions": {"width": 0.36, "height": 0.23, "depth": 0.48, "units": "world", "confidence": 0.94}, "transform": {"position": [-0.92, 0.16, 0.45], "rotation": [0.0, 0.0, 0.0], "scale": [0.36, 0.23, 0.48]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-paw-toe-grooves"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-paws"]};
  node_black_front_paw_l_26.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-front-leg-l"] ?? root).add(node_black_front_paw_l_26);
  nodes["black-front-paw-l"] = node_black_front_paw_l_26;
  const mesh_black_front_paw_l_26Geometry = endpoint_black_front_paw_l_26
    ? new THREE.CylinderGeometry(endpoint_black_front_paw_l_26.endRadius, endpoint_black_front_paw_l_26.baseRadius, endpoint_black_front_paw_l_26.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_front_paw_l_26 = new THREE.Mesh(
    mesh_black_front_paw_l_26Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_front_paw_l_26.name = "Black cat l front paw";
  if (endpoint_black_front_paw_l_26) {
    mesh_black_front_paw_l_26.position.copy(endpoint_black_front_paw_l_26.midpoint);
    mesh_black_front_paw_l_26.quaternion.copy(endpoint_black_front_paw_l_26.quaternion);
  }
  mesh_black_front_paw_l_26.castShadow = options.castShadow ?? true;
  mesh_black_front_paw_l_26.receiveShadow = options.receiveShadow ?? true;
  mesh_black_front_paw_l_26.userData.sculptComponent = {"id": "black-front-paw-l", "name": "Black cat l front paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.94, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l front paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-front-leg-l", "attachment": {"parentId": "black-front-leg-l", "parentSocket": "black-front-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.23, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-paws"]}, "dimensions": {"width": 0.36, "height": 0.23, "depth": 0.48, "units": "world", "confidence": 0.94}, "transform": {"position": [-0.92, 0.16, 0.45], "rotation": [0.0, 0.0, 0.0], "scale": [0.36, 0.23, 0.48]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-paw-toe-grooves"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-paws"]};
  node_black_front_paw_l_26.add(mesh_black_front_paw_l_26);
  meshes["black-front-paw-l"] = mesh_black_front_paw_l_26;
  colliders["black-front-paw-l"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_front_paw_l_26);

  const attachment_black_hind_leg_l_27 = {"parentId": "black-rump", "parentSocket": "black-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.6, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]};
  const endpoint_black_hind_leg_l_27 = makeAttachmentEndpoint(attachment_black_hind_leg_l_27);
  const node_black_hind_leg_l_27 = new THREE.Group();
  node_black_hind_leg_l_27.name = "Black cat l folded hind leg__pivot";
  if (endpoint_black_hind_leg_l_27) {
    node_black_hind_leg_l_27.position.copy(endpoint_black_hind_leg_l_27.start);
    node_black_hind_leg_l_27.rotation.set(0, 0, 0);
    node_black_hind_leg_l_27.scale.set(1, 1, 1);
  } else {
    node_black_hind_leg_l_27.position.set(-1.1600000000000001, 0.45, -0.02);
    node_black_hind_leg_l_27.rotation.set(0.0, 0.0, 0.0);
    node_black_hind_leg_l_27.scale.set(0.52, 0.6, 0.6);
  }
  node_black_hind_leg_l_27.userData.sculptComponent = {"id": "black-hind-leg-l", "name": "Black cat l folded hind leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.52, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l folded hind leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-rump", "attachment": {"parentId": "black-rump", "parentSocket": "black-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.6, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.52, "height": 0.6, "depth": 0.6, "units": "world", "confidence": 0.52}, "transform": {"position": [-1.1600000000000001, 0.45, -0.02], "rotation": [0.0, 0.0, 0.0], "scale": [0.52, 0.6, 0.6]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_hind_leg_l_27.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-rump"] ?? root).add(node_black_hind_leg_l_27);
  nodes["black-hind-leg-l"] = node_black_hind_leg_l_27;
  const mesh_black_hind_leg_l_27Geometry = endpoint_black_hind_leg_l_27
    ? new THREE.CylinderGeometry(endpoint_black_hind_leg_l_27.endRadius, endpoint_black_hind_leg_l_27.baseRadius, endpoint_black_hind_leg_l_27.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_hind_leg_l_27 = new THREE.Mesh(
    mesh_black_hind_leg_l_27Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_hind_leg_l_27.name = "Black cat l folded hind leg";
  if (endpoint_black_hind_leg_l_27) {
    mesh_black_hind_leg_l_27.position.copy(endpoint_black_hind_leg_l_27.midpoint);
    mesh_black_hind_leg_l_27.quaternion.copy(endpoint_black_hind_leg_l_27.quaternion);
  }
  mesh_black_hind_leg_l_27.castShadow = options.castShadow ?? true;
  mesh_black_hind_leg_l_27.receiveShadow = options.receiveShadow ?? true;
  mesh_black_hind_leg_l_27.userData.sculptComponent = {"id": "black-hind-leg-l", "name": "Black cat l folded hind leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.52, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l folded hind leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-rump", "attachment": {"parentId": "black-rump", "parentSocket": "black-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.6, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.52, "height": 0.6, "depth": 0.6, "units": "world", "confidence": 0.52}, "transform": {"position": [-1.1600000000000001, 0.45, -0.02], "rotation": [0.0, 0.0, 0.0], "scale": [0.52, 0.6, 0.6]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_hind_leg_l_27.add(mesh_black_hind_leg_l_27);
  meshes["black-hind-leg-l"] = mesh_black_hind_leg_l_27;
  colliders["black-hind-leg-l"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_hind_leg_l_27);

  const attachment_black_hind_paw_l_28 = {"parentId": "black-hind-leg-l", "parentSocket": "black-hind-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-paws"]};
  const endpoint_black_hind_paw_l_28 = makeAttachmentEndpoint(attachment_black_hind_paw_l_28);
  const node_black_hind_paw_l_28 = new THREE.Group();
  node_black_hind_paw_l_28.name = "Black cat l hind paw__pivot";
  if (endpoint_black_hind_paw_l_28) {
    node_black_hind_paw_l_28.position.copy(endpoint_black_hind_paw_l_28.start);
    node_black_hind_paw_l_28.rotation.set(0, 0, 0);
    node_black_hind_paw_l_28.scale.set(1, 1, 1);
  } else {
    node_black_hind_paw_l_28.position.set(-1.1600000000000001, 0.16, 0.24);
    node_black_hind_paw_l_28.rotation.set(0.0, 0.0, 0.0);
    node_black_hind_paw_l_28.scale.set(0.48, 0.24, 0.52);
  }
  node_black_hind_paw_l_28.userData.sculptComponent = {"id": "black-hind-paw-l", "name": "Black cat l hind paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.58, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l hind paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-hind-leg-l", "attachment": {"parentId": "black-hind-leg-l", "parentSocket": "black-hind-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-paws"]}, "dimensions": {"width": 0.48, "height": 0.24, "depth": 0.52, "units": "world", "confidence": 0.58}, "transform": {"position": [-1.1600000000000001, 0.16, 0.24], "rotation": [0.0, 0.0, 0.0], "scale": [0.48, 0.24, 0.52]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-paws"]};
  node_black_hind_paw_l_28.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-hind-leg-l"] ?? root).add(node_black_hind_paw_l_28);
  nodes["black-hind-paw-l"] = node_black_hind_paw_l_28;
  const mesh_black_hind_paw_l_28Geometry = endpoint_black_hind_paw_l_28
    ? new THREE.CylinderGeometry(endpoint_black_hind_paw_l_28.endRadius, endpoint_black_hind_paw_l_28.baseRadius, endpoint_black_hind_paw_l_28.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_hind_paw_l_28 = new THREE.Mesh(
    mesh_black_hind_paw_l_28Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_hind_paw_l_28.name = "Black cat l hind paw";
  if (endpoint_black_hind_paw_l_28) {
    mesh_black_hind_paw_l_28.position.copy(endpoint_black_hind_paw_l_28.midpoint);
    mesh_black_hind_paw_l_28.quaternion.copy(endpoint_black_hind_paw_l_28.quaternion);
  }
  mesh_black_hind_paw_l_28.castShadow = options.castShadow ?? true;
  mesh_black_hind_paw_l_28.receiveShadow = options.receiveShadow ?? true;
  mesh_black_hind_paw_l_28.userData.sculptComponent = {"id": "black-hind-paw-l", "name": "Black cat l hind paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.58, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat l hind paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-hind-leg-l", "attachment": {"parentId": "black-hind-leg-l", "parentSocket": "black-hind-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-paws"]}, "dimensions": {"width": 0.48, "height": 0.24, "depth": 0.52, "units": "world", "confidence": 0.58}, "transform": {"position": [-1.1600000000000001, 0.16, 0.24], "rotation": [0.0, 0.0, 0.0], "scale": [0.48, 0.24, 0.52]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-paws"]};
  node_black_hind_paw_l_28.add(mesh_black_hind_paw_l_28);
  meshes["black-hind-paw-l"] = mesh_black_hind_paw_l_28;
  colliders["black-hind-paw-l"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_hind_paw_l_28);

  const attachment_black_front_leg_r_29 = {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.18, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]};
  const endpoint_black_front_leg_r_29 = makeAttachmentEndpoint(attachment_black_front_leg_r_29);
  const node_black_front_leg_r_29 = new THREE.Group();
  node_black_front_leg_r_29.name = "Black cat r front leg__pivot";
  if (endpoint_black_front_leg_r_29) {
    node_black_front_leg_r_29.position.copy(endpoint_black_front_leg_r_29.start);
    node_black_front_leg_r_29.rotation.set(0, 0, 0);
    node_black_front_leg_r_29.scale.set(1, 1, 1);
  } else {
    node_black_front_leg_r_29.position.set(-0.44000000000000006, 0.72, 0.28);
    node_black_front_leg_r_29.rotation.set(0.0, 0.0, 0.0);
    node_black_front_leg_r_29.scale.set(0.27, 1.18, 0.29);
  }
  node_black_front_leg_r_29.userData.sculptComponent = {"id": "black-front-leg-r", "name": "Black cat r front leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.9, "primitive": "capsule", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r front leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-torso", "attachment": {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.18, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.27, "height": 1.18, "depth": 0.29, "units": "world", "confidence": 0.9}, "transform": {"position": [-0.44000000000000006, 0.72, 0.28], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 1.18, 0.29]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_front_leg_r_29.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-torso"] ?? root).add(node_black_front_leg_r_29);
  nodes["black-front-leg-r"] = node_black_front_leg_r_29;
  const mesh_black_front_leg_r_29Geometry = endpoint_black_front_leg_r_29
    ? new THREE.CylinderGeometry(endpoint_black_front_leg_r_29.endRadius, endpoint_black_front_leg_r_29.baseRadius, endpoint_black_front_leg_r_29.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_black_front_leg_r_29 = new THREE.Mesh(
    mesh_black_front_leg_r_29Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_front_leg_r_29.name = "Black cat r front leg";
  if (endpoint_black_front_leg_r_29) {
    mesh_black_front_leg_r_29.position.copy(endpoint_black_front_leg_r_29.midpoint);
    mesh_black_front_leg_r_29.quaternion.copy(endpoint_black_front_leg_r_29.quaternion);
  }
  mesh_black_front_leg_r_29.castShadow = options.castShadow ?? true;
  mesh_black_front_leg_r_29.receiveShadow = options.receiveShadow ?? true;
  mesh_black_front_leg_r_29.userData.sculptComponent = {"id": "black-front-leg-r", "name": "Black cat r front leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.9, "primitive": "capsule", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r front leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-torso", "attachment": {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.18, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.27, "height": 1.18, "depth": 0.29, "units": "world", "confidence": 0.9}, "transform": {"position": [-0.44000000000000006, 0.72, 0.28], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 1.18, 0.29]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_front_leg_r_29.add(mesh_black_front_leg_r_29);
  meshes["black-front-leg-r"] = mesh_black_front_leg_r_29;
  colliders["black-front-leg-r"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_front_leg_r_29);

  const attachment_black_front_paw_r_30 = {"parentId": "black-front-leg-r", "parentSocket": "black-front-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.23, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-paws"]};
  const endpoint_black_front_paw_r_30 = makeAttachmentEndpoint(attachment_black_front_paw_r_30);
  const node_black_front_paw_r_30 = new THREE.Group();
  node_black_front_paw_r_30.name = "Black cat r front paw__pivot";
  if (endpoint_black_front_paw_r_30) {
    node_black_front_paw_r_30.position.copy(endpoint_black_front_paw_r_30.start);
    node_black_front_paw_r_30.rotation.set(0, 0, 0);
    node_black_front_paw_r_30.scale.set(1, 1, 1);
  } else {
    node_black_front_paw_r_30.position.set(-0.44000000000000006, 0.16, 0.45);
    node_black_front_paw_r_30.rotation.set(0.0, 0.0, 0.0);
    node_black_front_paw_r_30.scale.set(0.36, 0.23, 0.48);
  }
  node_black_front_paw_r_30.userData.sculptComponent = {"id": "black-front-paw-r", "name": "Black cat r front paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.94, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r front paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-front-leg-r", "attachment": {"parentId": "black-front-leg-r", "parentSocket": "black-front-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.23, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-paws"]}, "dimensions": {"width": 0.36, "height": 0.23, "depth": 0.48, "units": "world", "confidence": 0.94}, "transform": {"position": [-0.44000000000000006, 0.16, 0.45], "rotation": [0.0, 0.0, 0.0], "scale": [0.36, 0.23, 0.48]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-paws"]};
  node_black_front_paw_r_30.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-front-leg-r"] ?? root).add(node_black_front_paw_r_30);
  nodes["black-front-paw-r"] = node_black_front_paw_r_30;
  const mesh_black_front_paw_r_30Geometry = endpoint_black_front_paw_r_30
    ? new THREE.CylinderGeometry(endpoint_black_front_paw_r_30.endRadius, endpoint_black_front_paw_r_30.baseRadius, endpoint_black_front_paw_r_30.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_front_paw_r_30 = new THREE.Mesh(
    mesh_black_front_paw_r_30Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_front_paw_r_30.name = "Black cat r front paw";
  if (endpoint_black_front_paw_r_30) {
    mesh_black_front_paw_r_30.position.copy(endpoint_black_front_paw_r_30.midpoint);
    mesh_black_front_paw_r_30.quaternion.copy(endpoint_black_front_paw_r_30.quaternion);
  }
  mesh_black_front_paw_r_30.castShadow = options.castShadow ?? true;
  mesh_black_front_paw_r_30.receiveShadow = options.receiveShadow ?? true;
  mesh_black_front_paw_r_30.userData.sculptComponent = {"id": "black-front-paw-r", "name": "Black cat r front paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.94, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r front paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-front-leg-r", "attachment": {"parentId": "black-front-leg-r", "parentSocket": "black-front-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.23, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-paws"]}, "dimensions": {"width": 0.36, "height": 0.23, "depth": 0.48, "units": "world", "confidence": 0.94}, "transform": {"position": [-0.44000000000000006, 0.16, 0.45], "rotation": [0.0, 0.0, 0.0], "scale": [0.36, 0.23, 0.48]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-paws"]};
  node_black_front_paw_r_30.add(mesh_black_front_paw_r_30);
  meshes["black-front-paw-r"] = mesh_black_front_paw_r_30;
  colliders["black-front-paw-r"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_front_paw_r_30);

  const attachment_black_hind_leg_r_31 = {"parentId": "black-rump", "parentSocket": "black-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.6, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]};
  const endpoint_black_hind_leg_r_31 = makeAttachmentEndpoint(attachment_black_hind_leg_r_31);
  const node_black_hind_leg_r_31 = new THREE.Group();
  node_black_hind_leg_r_31.name = "Black cat r folded hind leg__pivot";
  if (endpoint_black_hind_leg_r_31) {
    node_black_hind_leg_r_31.position.copy(endpoint_black_hind_leg_r_31.start);
    node_black_hind_leg_r_31.rotation.set(0, 0, 0);
    node_black_hind_leg_r_31.scale.set(1, 1, 1);
  } else {
    node_black_hind_leg_r_31.position.set(-0.20000000000000007, 0.45, -0.02);
    node_black_hind_leg_r_31.rotation.set(0.0, 0.0, 0.0);
    node_black_hind_leg_r_31.scale.set(0.52, 0.6, 0.6);
  }
  node_black_hind_leg_r_31.userData.sculptComponent = {"id": "black-hind-leg-r", "name": "Black cat r folded hind leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.52, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r folded hind leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-rump", "attachment": {"parentId": "black-rump", "parentSocket": "black-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.6, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.52, "height": 0.6, "depth": 0.6, "units": "world", "confidence": 0.52}, "transform": {"position": [-0.20000000000000007, 0.45, -0.02], "rotation": [0.0, 0.0, 0.0], "scale": [0.52, 0.6, 0.6]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_hind_leg_r_31.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-rump"] ?? root).add(node_black_hind_leg_r_31);
  nodes["black-hind-leg-r"] = node_black_hind_leg_r_31;
  const mesh_black_hind_leg_r_31Geometry = endpoint_black_hind_leg_r_31
    ? new THREE.CylinderGeometry(endpoint_black_hind_leg_r_31.endRadius, endpoint_black_hind_leg_r_31.baseRadius, endpoint_black_hind_leg_r_31.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_hind_leg_r_31 = new THREE.Mesh(
    mesh_black_hind_leg_r_31Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_hind_leg_r_31.name = "Black cat r folded hind leg";
  if (endpoint_black_hind_leg_r_31) {
    mesh_black_hind_leg_r_31.position.copy(endpoint_black_hind_leg_r_31.midpoint);
    mesh_black_hind_leg_r_31.quaternion.copy(endpoint_black_hind_leg_r_31.quaternion);
  }
  mesh_black_hind_leg_r_31.castShadow = options.castShadow ?? true;
  mesh_black_hind_leg_r_31.receiveShadow = options.receiveShadow ?? true;
  mesh_black_hind_leg_r_31.userData.sculptComponent = {"id": "black-hind-leg-r", "name": "Black cat r folded hind leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.52, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r folded hind leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-rump", "attachment": {"parentId": "black-rump", "parentSocket": "black-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.6, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.52, "height": 0.6, "depth": 0.6, "units": "world", "confidence": 0.52}, "transform": {"position": [-0.20000000000000007, 0.45, -0.02], "rotation": [0.0, 0.0, 0.0], "scale": [0.52, 0.6, 0.6]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_hind_leg_r_31.add(mesh_black_hind_leg_r_31);
  meshes["black-hind-leg-r"] = mesh_black_hind_leg_r_31;
  colliders["black-hind-leg-r"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_hind_leg_r_31);

  const attachment_black_hind_paw_r_32 = {"parentId": "black-hind-leg-r", "parentSocket": "black-hind-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-paws"]};
  const endpoint_black_hind_paw_r_32 = makeAttachmentEndpoint(attachment_black_hind_paw_r_32);
  const node_black_hind_paw_r_32 = new THREE.Group();
  node_black_hind_paw_r_32.name = "Black cat r hind paw__pivot";
  if (endpoint_black_hind_paw_r_32) {
    node_black_hind_paw_r_32.position.copy(endpoint_black_hind_paw_r_32.start);
    node_black_hind_paw_r_32.rotation.set(0, 0, 0);
    node_black_hind_paw_r_32.scale.set(1, 1, 1);
  } else {
    node_black_hind_paw_r_32.position.set(-0.20000000000000007, 0.16, 0.24);
    node_black_hind_paw_r_32.rotation.set(0.0, 0.0, 0.0);
    node_black_hind_paw_r_32.scale.set(0.48, 0.24, 0.52);
  }
  node_black_hind_paw_r_32.userData.sculptComponent = {"id": "black-hind-paw-r", "name": "Black cat r hind paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.58, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r hind paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-hind-leg-r", "attachment": {"parentId": "black-hind-leg-r", "parentSocket": "black-hind-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-paws"]}, "dimensions": {"width": 0.48, "height": 0.24, "depth": 0.52, "units": "world", "confidence": 0.58}, "transform": {"position": [-0.20000000000000007, 0.16, 0.24], "rotation": [0.0, 0.0, 0.0], "scale": [0.48, 0.24, 0.52]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-paws"]};
  node_black_hind_paw_r_32.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-hind-leg-r"] ?? root).add(node_black_hind_paw_r_32);
  nodes["black-hind-paw-r"] = node_black_hind_paw_r_32;
  const mesh_black_hind_paw_r_32Geometry = endpoint_black_hind_paw_r_32
    ? new THREE.CylinderGeometry(endpoint_black_hind_paw_r_32.endRadius, endpoint_black_hind_paw_r_32.baseRadius, endpoint_black_hind_paw_r_32.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_hind_paw_r_32 = new THREE.Mesh(
    mesh_black_hind_paw_r_32Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_hind_paw_r_32.name = "Black cat r hind paw";
  if (endpoint_black_hind_paw_r_32) {
    mesh_black_hind_paw_r_32.position.copy(endpoint_black_hind_paw_r_32.midpoint);
    mesh_black_hind_paw_r_32.quaternion.copy(endpoint_black_hind_paw_r_32.quaternion);
  }
  mesh_black_hind_paw_r_32.castShadow = options.castShadow ?? true;
  mesh_black_hind_paw_r_32.receiveShadow = options.receiveShadow ?? true;
  mesh_black_hind_paw_r_32.userData.sculptComponent = {"id": "black-hind-paw-r", "name": "Black cat r hind paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.58, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat r hind paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-hind-leg-r", "attachment": {"parentId": "black-hind-leg-r", "parentSocket": "black-hind-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-paws"]}, "dimensions": {"width": 0.48, "height": 0.24, "depth": 0.52, "units": "world", "confidence": 0.58}, "transform": {"position": [-0.20000000000000007, 0.16, 0.24], "rotation": [0.0, 0.0, 0.0], "scale": [0.48, 0.24, 0.52]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-paws"]};
  node_black_hind_paw_r_32.add(mesh_black_hind_paw_r_32);
  meshes["black-hind-paw-r"] = mesh_black_hind_paw_r_32;
  colliders["black-hind-paw-r"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_hind_paw_r_32);

  const attachment_black_tail_33 = {"parentId": "black-rump", "parentSocket": "black-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.55, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["hidden-posterior"]};
  const endpoint_black_tail_33 = makeAttachmentEndpoint(attachment_black_tail_33);
  const node_black_tail_33 = new THREE.Group();
  node_black_tail_33.name = "Black cat inferred curled tail pivot__pivot";
  if (endpoint_black_tail_33) {
    node_black_tail_33.position.copy(endpoint_black_tail_33.start);
    node_black_tail_33.rotation.set(0, 0, 0);
    node_black_tail_33.scale.set(1, 1, 1);
  } else {
    node_black_tail_33.position.set(-1.15, 0.4, -0.26);
    node_black_tail_33.rotation.set(0.0, 0.0, 0.0);
    node_black_tail_33.scale.set(0.25, 1.55, 0.25);
  }
  node_black_tail_33.userData.sculptComponent = {"id": "black-tail", "name": "Black cat inferred curled tail pivot", "level": "meso", "role": "tail", "importance": 0.8, "confidence": 0.3, "primitive": "curve-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat inferred curled tail pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in hidden-posterior.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-rump", "attachment": {"parentId": "black-rump", "parentSocket": "black-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.55, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["hidden-posterior"]}, "dimensions": {"width": 0.25, "height": 1.55, "depth": 0.25, "units": "world", "confidence": 0.3}, "transform": {"position": [-1.15, 0.4, -0.26], "rotation": [0.0, 0.0, 0.0], "scale": [0.25, 1.55, 0.25]}, "actionProfile": {"animationRole": "tail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["inferred-curled-tail"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["hidden-posterior"]};
  node_black_tail_33.userData.actionProfile = {"animationRole": "tail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-rump"] ?? root).add(node_black_tail_33);
  nodes["black-tail"] = node_black_tail_33;
  const mesh_black_tail_33Geometry = endpoint_black_tail_33
    ? new THREE.CylinderGeometry(endpoint_black_tail_33.endRadius, endpoint_black_tail_33.baseRadius, endpoint_black_tail_33.length, 32, 12)
    : buildCurveSweepGeometry({"spine": [[-0.5, -0.4, 0.0], [-0.1, 0.1, 0.0], [0.3, 0.2, 0.0], [0.6, -0.1, 0.0]], "crossSection": {"points": [[-0.04, -0.02], [0.04, -0.02], [0.04, 0.02], [-0.04, 0.02]]}, "closed": false});
  const mesh_black_tail_33 = new THREE.Mesh(
    mesh_black_tail_33Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_tail_33.name = "Black cat inferred curled tail pivot";
  if (endpoint_black_tail_33) {
    mesh_black_tail_33.position.copy(endpoint_black_tail_33.midpoint);
    mesh_black_tail_33.quaternion.copy(endpoint_black_tail_33.quaternion);
  }
  mesh_black_tail_33.castShadow = options.castShadow ?? true;
  mesh_black_tail_33.receiveShadow = options.receiveShadow ?? true;
  mesh_black_tail_33.userData.sculptComponent = {"id": "black-tail", "name": "Black cat inferred curled tail pivot", "level": "meso", "role": "tail", "importance": 0.8, "confidence": 0.3, "primitive": "curve-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat inferred curled tail pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in hidden-posterior.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-rump", "attachment": {"parentId": "black-rump", "parentSocket": "black-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.55, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["hidden-posterior"]}, "dimensions": {"width": 0.25, "height": 1.55, "depth": 0.25, "units": "world", "confidence": 0.3}, "transform": {"position": [-1.15, 0.4, -0.26], "rotation": [0.0, 0.0, 0.0], "scale": [0.25, 1.55, 0.25]}, "actionProfile": {"animationRole": "tail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(27, 24, 21, 1.0)", "secondaryAlbedo": "rgba(39, 34, 29, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["inferred-curled-tail"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["hidden-posterior"]};
  node_black_tail_33.add(mesh_black_tail_33);
  meshes["black-tail"] = mesh_black_tail_33;
  colliders["black-tail"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_tail_33);

  const attachment_tabby_cat_34 = {"parentId": "root", "parentSocket": "root-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.08, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_cat_34 = makeAttachmentEndpoint(attachment_tabby_cat_34);
  const node_tabby_cat_34 = new THREE.Group();
  node_tabby_cat_34.name = "Tabby cat quadruped root__pivot";
  if (endpoint_tabby_cat_34) {
    node_tabby_cat_34.position.copy(endpoint_tabby_cat_34.start);
    node_tabby_cat_34.rotation.set(0, 0, 0);
    node_tabby_cat_34.scale.set(1, 1, 1);
  } else {
    node_tabby_cat_34.position.set(0.7, 0.0, 0.08);
    node_tabby_cat_34.rotation.set(0.0, 0.0, 0.0);
    node_tabby_cat_34.scale.set(0.01, 0.01, 0.01);
  }
  node_tabby_cat_34.userData.sculptComponent = {"id": "tabby-cat", "name": "Tabby cat quadruped root", "level": "macro", "role": "cat-root", "importance": 1.0, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Tabby cat quadruped root is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.08, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.01, "height": 0.01, "depth": 0.01, "units": "world", "confidence": 0.9}, "transform": {"position": [0.7, 0.0, 0.08], "rotation": [0.0, 0.0, 0.0], "scale": [0.01, 0.01, 0.01]}, "actionProfile": {"animationRole": "cat-root", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 0, 0, 0.0)", "secondaryAlbedo": "rgba(12, 10, 8, 0.0)", "materialClass": "unknown", "materialClassConfidence": 1.0}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_cat_34.userData.actionProfile = {"animationRole": "cat-root", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}};
  (nodes["root"] ?? root).add(node_tabby_cat_34);
  nodes["tabby-cat"] = node_tabby_cat_34;
  const mesh_tabby_cat_34Geometry = endpoint_tabby_cat_34
    ? new THREE.CylinderGeometry(endpoint_tabby_cat_34.endRadius, endpoint_tabby_cat_34.baseRadius, endpoint_tabby_cat_34.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tabby_cat_34 = new THREE.Mesh(
    mesh_tabby_cat_34Geometry,
    materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_cat_34.name = "Tabby cat quadruped root";
  if (endpoint_tabby_cat_34) {
    mesh_tabby_cat_34.position.copy(endpoint_tabby_cat_34.midpoint);
    mesh_tabby_cat_34.quaternion.copy(endpoint_tabby_cat_34.quaternion);
  }
  mesh_tabby_cat_34.castShadow = options.castShadow ?? true;
  mesh_tabby_cat_34.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_cat_34.userData.sculptComponent = {"id": "tabby-cat", "name": "Tabby cat quadruped root", "level": "macro", "role": "cat-root", "importance": 1.0, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Tabby cat quadruped root is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.08, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.01, "height": 0.01, "depth": 0.01, "units": "world", "confidence": 0.9}, "transform": {"position": [0.7, 0.0, 0.08], "rotation": [0.0, 0.0, 0.0], "scale": [0.01, 0.01, 0.01]}, "actionProfile": {"animationRole": "cat-root", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 0, 0, 0.0)", "secondaryAlbedo": "rgba(12, 10, 8, 0.0)", "materialClass": "unknown", "materialClassConfidence": 1.0}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_cat_34.add(mesh_tabby_cat_34);
  meshes["tabby-cat"] = mesh_tabby_cat_34;
  colliders["tabby-cat"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_cat_34);

  const attachment_tabby_torso_35 = {"parentId": "tabby-cat", "parentSocket": "tabby-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.32, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_torso_35 = makeAttachmentEndpoint(attachment_tabby_torso_35);
  const node_tabby_torso_35 = new THREE.Group();
  node_tabby_torso_35.name = "Tabby cat broad torso__pivot";
  if (endpoint_tabby_torso_35) {
    node_tabby_torso_35.position.copy(endpoint_tabby_torso_35.start);
    node_tabby_torso_35.rotation.set(0, 0, 0);
    node_tabby_torso_35.scale.set(1, 1, 1);
  } else {
    node_tabby_torso_35.position.set(0.68, 1.36, -0.02);
    node_tabby_torso_35.rotation.set(0.0, 0.0, 0.0);
    node_tabby_torso_35.scale.set(1.02, 1.32, 0.82);
  }
  node_tabby_torso_35.userData.sculptComponent = {"id": "tabby-torso", "name": "Tabby cat broad torso", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.94, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat broad torso is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-cat", "attachment": {"parentId": "tabby-cat", "parentSocket": "tabby-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.32, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 1.02, "height": 1.32, "depth": 0.82, "units": "world", "confidence": 0.94}, "transform": {"position": [0.68, 1.36, -0.02], "rotation": [0.0, 0.0, 0.0], "scale": [1.02, 1.32, 0.82]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-torso-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_torso_35.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-cat"] ?? root).add(node_tabby_torso_35);
  nodes["tabby-torso"] = node_tabby_torso_35;
  const mesh_tabby_torso_35Geometry = endpoint_tabby_torso_35
    ? new THREE.CylinderGeometry(endpoint_tabby_torso_35.endRadius, endpoint_tabby_torso_35.baseRadius, endpoint_tabby_torso_35.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_torso_35 = new THREE.Mesh(
    mesh_tabby_torso_35Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_torso_35.name = "Tabby cat broad torso";
  if (endpoint_tabby_torso_35) {
    mesh_tabby_torso_35.position.copy(endpoint_tabby_torso_35.midpoint);
    mesh_tabby_torso_35.quaternion.copy(endpoint_tabby_torso_35.quaternion);
  }
  mesh_tabby_torso_35.castShadow = options.castShadow ?? true;
  mesh_tabby_torso_35.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_torso_35.userData.sculptComponent = {"id": "tabby-torso", "name": "Tabby cat broad torso", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.94, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat broad torso is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-cat", "attachment": {"parentId": "tabby-cat", "parentSocket": "tabby-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.32, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 1.02, "height": 1.32, "depth": 0.82, "units": "world", "confidence": 0.94}, "transform": {"position": [0.68, 1.36, -0.02], "rotation": [0.0, 0.0, 0.0], "scale": [1.02, 1.32, 0.82]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-torso-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_torso_35.add(mesh_tabby_torso_35);
  meshes["tabby-torso"] = mesh_tabby_torso_35;
  colliders["tabby-torso"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_torso_35);

  const attachment_tabby_rump_36 = {"parentId": "tabby-cat", "parentSocket": "tabby-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.9, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_rump_36 = makeAttachmentEndpoint(attachment_tabby_rump_36);
  const node_tabby_rump_36 = new THREE.Group();
  node_tabby_rump_36.name = "Tabby cat posterior rump__pivot";
  if (endpoint_tabby_rump_36) {
    node_tabby_rump_36.position.copy(endpoint_tabby_rump_36.start);
    node_tabby_rump_36.rotation.set(0, 0, 0);
    node_tabby_rump_36.scale.set(1, 1, 1);
  } else {
    node_tabby_rump_36.position.set(0.82, 1.0, -0.4);
    node_tabby_rump_36.rotation.set(0.0, 0.0, 0.0);
    node_tabby_rump_36.scale.set(1.08, 0.9, 0.9);
  }
  node_tabby_rump_36.userData.sculptComponent = {"id": "tabby-rump", "name": "Tabby cat posterior rump", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.5, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat posterior rump is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-cat", "attachment": {"parentId": "tabby-cat", "parentSocket": "tabby-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.9, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 1.08, "height": 0.9, "depth": 0.9, "units": "world", "confidence": 0.5}, "transform": {"position": [0.82, 1.0, -0.4], "rotation": [0.0, 0.0, 0.0], "scale": [1.08, 0.9, 0.9]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_rump_36.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-cat"] ?? root).add(node_tabby_rump_36);
  nodes["tabby-rump"] = node_tabby_rump_36;
  const mesh_tabby_rump_36Geometry = endpoint_tabby_rump_36
    ? new THREE.CylinderGeometry(endpoint_tabby_rump_36.endRadius, endpoint_tabby_rump_36.baseRadius, endpoint_tabby_rump_36.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_rump_36 = new THREE.Mesh(
    mesh_tabby_rump_36Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_rump_36.name = "Tabby cat posterior rump";
  if (endpoint_tabby_rump_36) {
    mesh_tabby_rump_36.position.copy(endpoint_tabby_rump_36.midpoint);
    mesh_tabby_rump_36.quaternion.copy(endpoint_tabby_rump_36.quaternion);
  }
  mesh_tabby_rump_36.castShadow = options.castShadow ?? true;
  mesh_tabby_rump_36.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_rump_36.userData.sculptComponent = {"id": "tabby-rump", "name": "Tabby cat posterior rump", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.5, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat posterior rump is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-cat", "attachment": {"parentId": "tabby-cat", "parentSocket": "tabby-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.9, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 1.08, "height": 0.9, "depth": 0.9, "units": "world", "confidence": 0.5}, "transform": {"position": [0.82, 1.0, -0.4], "rotation": [0.0, 0.0, 0.0], "scale": [1.08, 0.9, 0.9]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_rump_36.add(mesh_tabby_rump_36);
  meshes["tabby-rump"] = mesh_tabby_rump_36;
  colliders["tabby-rump"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_rump_36);

  const attachment_tabby_chest_37 = {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.0, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_chest_37 = makeAttachmentEndpoint(attachment_tabby_chest_37);
  const node_tabby_chest_37 = new THREE.Group();
  node_tabby_chest_37.name = "Tabby cat chest volume__pivot";
  if (endpoint_tabby_chest_37) {
    node_tabby_chest_37.position.copy(endpoint_tabby_chest_37.start);
    node_tabby_chest_37.rotation.set(0, 0, 0);
    node_tabby_chest_37.scale.set(1, 1, 1);
  } else {
    node_tabby_chest_37.position.set(0.7, 1.43, 0.35);
    node_tabby_chest_37.rotation.set(0.0, 0.0, 0.0);
    node_tabby_chest_37.scale.set(0.82, 1.0, 0.46);
  }
  node_tabby_chest_37.userData.sculptComponent = {"id": "tabby-chest", "name": "Tabby cat chest volume", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.92, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat chest volume is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-torso", "attachment": {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.0, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.82, "height": 1.0, "depth": 0.46, "units": "world", "confidence": 0.92}, "transform": {"position": [0.7, 1.43, 0.35], "rotation": [0.0, 0.0, 0.0], "scale": [0.82, 1.0, 0.46]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_chest_37.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-torso"] ?? root).add(node_tabby_chest_37);
  nodes["tabby-chest"] = node_tabby_chest_37;
  const mesh_tabby_chest_37Geometry = endpoint_tabby_chest_37
    ? new THREE.CylinderGeometry(endpoint_tabby_chest_37.endRadius, endpoint_tabby_chest_37.baseRadius, endpoint_tabby_chest_37.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_chest_37 = new THREE.Mesh(
    mesh_tabby_chest_37Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_chest_37.name = "Tabby cat chest volume";
  if (endpoint_tabby_chest_37) {
    mesh_tabby_chest_37.position.copy(endpoint_tabby_chest_37.midpoint);
    mesh_tabby_chest_37.quaternion.copy(endpoint_tabby_chest_37.quaternion);
  }
  mesh_tabby_chest_37.castShadow = options.castShadow ?? true;
  mesh_tabby_chest_37.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_chest_37.userData.sculptComponent = {"id": "tabby-chest", "name": "Tabby cat chest volume", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.92, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat chest volume is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-torso", "attachment": {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.0, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.82, "height": 1.0, "depth": 0.46, "units": "world", "confidence": 0.92}, "transform": {"position": [0.7, 1.43, 0.35], "rotation": [0.0, 0.0, 0.0], "scale": [0.82, 1.0, 0.46]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_chest_37.add(mesh_tabby_chest_37);
  meshes["tabby-chest"] = mesh_tabby_chest_37;
  colliders["tabby-chest"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_chest_37);

  const attachment_tabby_bib_38 = {"parentId": "tabby-chest", "parentSocket": "tabby-chest-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_bib_38 = makeAttachmentEndpoint(attachment_tabby_bib_38);
  const node_tabby_bib_38 = new THREE.Group();
  node_tabby_bib_38.name = "Tabby cat white chest bib__pivot";
  if (endpoint_tabby_bib_38) {
    node_tabby_bib_38.position.copy(endpoint_tabby_bib_38.start);
    node_tabby_bib_38.rotation.set(0, 0, 0);
    node_tabby_bib_38.scale.set(1, 1, 1);
  } else {
    node_tabby_bib_38.position.set(0.7, 1.66, 0.68);
    node_tabby_bib_38.rotation.set(0.0, 0.0, 0.0);
    node_tabby_bib_38.scale.set(0.62, 0.78, 0.08);
  }
  node_tabby_bib_38.userData.sculptComponent = {"id": "tabby-bib", "name": "Tabby cat white chest bib", "level": "meso", "role": "panel", "importance": 0.8, "confidence": 0.97, "primitive": "ellipsoid", "topologyClass": "conforming-shell", "topologyRationale": "Tabby cat white chest bib is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-chest", "attachment": {"parentId": "tabby-chest", "parentSocket": "tabby-chest-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.62, "height": 0.78, "depth": 0.08, "units": "world", "confidence": 0.97}, "transform": {"position": [0.7, 1.66, 0.68], "rotation": [0.0, 0.0, 0.0], "scale": [0.62, 0.78, 0.08]}, "actionProfile": {"animationRole": "panel", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-white-bib"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_bib_38.userData.actionProfile = {"animationRole": "panel", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}};
  (nodes["tabby-chest"] ?? root).add(node_tabby_bib_38);
  nodes["tabby-bib"] = node_tabby_bib_38;
  const mesh_tabby_bib_38Geometry = endpoint_tabby_bib_38
    ? new THREE.CylinderGeometry(endpoint_tabby_bib_38.endRadius, endpoint_tabby_bib_38.baseRadius, endpoint_tabby_bib_38.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_bib_38 = new THREE.Mesh(
    mesh_tabby_bib_38Geometry,
    materialMap["white-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_bib_38.name = "Tabby cat white chest bib";
  if (endpoint_tabby_bib_38) {
    mesh_tabby_bib_38.position.copy(endpoint_tabby_bib_38.midpoint);
    mesh_tabby_bib_38.quaternion.copy(endpoint_tabby_bib_38.quaternion);
  }
  mesh_tabby_bib_38.castShadow = options.castShadow ?? true;
  mesh_tabby_bib_38.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_bib_38.userData.sculptComponent = {"id": "tabby-bib", "name": "Tabby cat white chest bib", "level": "meso", "role": "panel", "importance": 0.8, "confidence": 0.97, "primitive": "ellipsoid", "topologyClass": "conforming-shell", "topologyRationale": "Tabby cat white chest bib is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-chest", "attachment": {"parentId": "tabby-chest", "parentSocket": "tabby-chest-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.62, "height": 0.78, "depth": 0.08, "units": "world", "confidence": 0.97}, "transform": {"position": [0.7, 1.66, 0.68], "rotation": [0.0, 0.0, 0.0], "scale": [0.62, 0.78, 0.08]}, "actionProfile": {"animationRole": "panel", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-white-bib"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_bib_38.add(mesh_tabby_bib_38);
  meshes["tabby-bib"] = mesh_tabby_bib_38;
  colliders["tabby-bib"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_bib_38);

  const attachment_tabby_neck_39 = {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.5, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_neck_39 = makeAttachmentEndpoint(attachment_tabby_neck_39);
  const node_tabby_neck_39 = new THREE.Group();
  node_tabby_neck_39.name = "Tabby cat neck bridge__pivot";
  if (endpoint_tabby_neck_39) {
    node_tabby_neck_39.position.copy(endpoint_tabby_neck_39.start);
    node_tabby_neck_39.rotation.set(0, 0, 0);
    node_tabby_neck_39.scale.set(1, 1, 1);
  } else {
    node_tabby_neck_39.position.set(0.72, 2.23, 0.12);
    node_tabby_neck_39.rotation.set(0.0, 0.0, 0.0);
    node_tabby_neck_39.scale.set(0.65, 0.5, 0.52);
  }
  node_tabby_neck_39.userData.sculptComponent = {"id": "tabby-neck", "name": "Tabby cat neck bridge", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.86, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat neck bridge is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-torso", "attachment": {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.5, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.65, "height": 0.5, "depth": 0.52, "units": "world", "confidence": 0.86}, "transform": {"position": [0.72, 2.23, 0.12], "rotation": [0.0, 0.0, 0.0], "scale": [0.65, 0.5, 0.52]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_neck_39.userData.actionProfile = {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-torso"] ?? root).add(node_tabby_neck_39);
  nodes["tabby-neck"] = node_tabby_neck_39;
  const mesh_tabby_neck_39Geometry = endpoint_tabby_neck_39
    ? new THREE.CylinderGeometry(endpoint_tabby_neck_39.endRadius, endpoint_tabby_neck_39.baseRadius, endpoint_tabby_neck_39.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_neck_39 = new THREE.Mesh(
    mesh_tabby_neck_39Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_neck_39.name = "Tabby cat neck bridge";
  if (endpoint_tabby_neck_39) {
    mesh_tabby_neck_39.position.copy(endpoint_tabby_neck_39.midpoint);
    mesh_tabby_neck_39.quaternion.copy(endpoint_tabby_neck_39.quaternion);
  }
  mesh_tabby_neck_39.castShadow = options.castShadow ?? true;
  mesh_tabby_neck_39.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_neck_39.userData.sculptComponent = {"id": "tabby-neck", "name": "Tabby cat neck bridge", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.86, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat neck bridge is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-torso", "attachment": {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.5, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.65, "height": 0.5, "depth": 0.52, "units": "world", "confidence": 0.86}, "transform": {"position": [0.72, 2.23, 0.12], "rotation": [0.0, 0.0, 0.0], "scale": [0.65, 0.5, 0.52]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_neck_39.add(mesh_tabby_neck_39);
  meshes["tabby-neck"] = mesh_tabby_neck_39;
  colliders["tabby-neck"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_neck_39);

  const attachment_tabby_head_40 = {"parentId": "tabby-neck", "parentSocket": "tabby-neck-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.76, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_head_40 = makeAttachmentEndpoint(attachment_tabby_head_40);
  const node_tabby_head_40 = new THREE.Group();
  node_tabby_head_40.name = "Tabby cat head pivot__pivot";
  if (endpoint_tabby_head_40) {
    node_tabby_head_40.position.copy(endpoint_tabby_head_40.start);
    node_tabby_head_40.rotation.set(0, 0, 0);
    node_tabby_head_40.scale.set(1, 1, 1);
  } else {
    node_tabby_head_40.position.set(0.78, 2.75, 0.32);
    node_tabby_head_40.rotation.set(0.0, 0.0, 0.0);
    node_tabby_head_40.scale.set(0.78, 0.76, 0.66);
  }
  node_tabby_head_40.userData.sculptComponent = {"id": "tabby-head", "name": "Tabby cat head pivot", "level": "macro", "role": "head", "importance": 1.0, "confidence": 0.97, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat head pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-neck", "attachment": {"parentId": "tabby-neck", "parentSocket": "tabby-neck-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.76, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.78, "height": 0.76, "depth": 0.66, "units": "world", "confidence": 0.97}, "transform": {"position": [0.78, 2.75, 0.32], "rotation": [0.0, 0.0, 0.0], "scale": [0.78, 0.76, 0.66]}, "actionProfile": {"animationRole": "head", "pivot": {"mode": "joint", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-eye-wetline", "tabby-round-pupil", "tabby-iris-ring", "tabby-forehead-m", "tabby-cheek-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_head_40.userData.actionProfile = {"animationRole": "head", "pivot": {"mode": "joint", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-neck"] ?? root).add(node_tabby_head_40);
  nodes["tabby-head"] = node_tabby_head_40;
  const mesh_tabby_head_40Geometry = endpoint_tabby_head_40
    ? new THREE.CylinderGeometry(endpoint_tabby_head_40.endRadius, endpoint_tabby_head_40.baseRadius, endpoint_tabby_head_40.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_head_40 = new THREE.Mesh(
    mesh_tabby_head_40Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_head_40.name = "Tabby cat head pivot";
  if (endpoint_tabby_head_40) {
    mesh_tabby_head_40.position.copy(endpoint_tabby_head_40.midpoint);
    mesh_tabby_head_40.quaternion.copy(endpoint_tabby_head_40.quaternion);
  }
  mesh_tabby_head_40.castShadow = options.castShadow ?? true;
  mesh_tabby_head_40.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_head_40.userData.sculptComponent = {"id": "tabby-head", "name": "Tabby cat head pivot", "level": "macro", "role": "head", "importance": 1.0, "confidence": 0.97, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat head pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-neck", "attachment": {"parentId": "tabby-neck", "parentSocket": "tabby-neck-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.76, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.78, "height": 0.76, "depth": 0.66, "units": "world", "confidence": 0.97}, "transform": {"position": [0.78, 2.75, 0.32], "rotation": [0.0, 0.0, 0.0], "scale": [0.78, 0.76, 0.66]}, "actionProfile": {"animationRole": "head", "pivot": {"mode": "joint", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-eye-wetline", "tabby-round-pupil", "tabby-iris-ring", "tabby-forehead-m", "tabby-cheek-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_head_40.add(mesh_tabby_head_40);
  meshes["tabby-head"] = mesh_tabby_head_40;
  colliders["tabby-head"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_head_40);

  const attachment_tabby_ear_l_41 = {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.79, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]};
  const endpoint_tabby_ear_l_41 = makeAttachmentEndpoint(attachment_tabby_ear_l_41);
  const node_tabby_ear_l_41 = new THREE.Group();
  node_tabby_ear_l_41.name = "Tabby cat l ear pivot__pivot";
  if (endpoint_tabby_ear_l_41) {
    node_tabby_ear_l_41.position.copy(endpoint_tabby_ear_l_41.start);
    node_tabby_ear_l_41.rotation.set(0, 0, 0);
    node_tabby_ear_l_41.scale.set(1, 1, 1);
  } else {
    node_tabby_ear_l_41.position.set(0.36000000000000004, 3.47, 0.28);
    node_tabby_ear_l_41.rotation.set(0.0, 0.0, 0.1);
    node_tabby_ear_l_41.scale.set(0.45, 0.79, 0.21);
  }
  node_tabby_ear_l_41.userData.sculptComponent = {"id": "tabby-ear-l", "name": "Tabby cat l ear pivot", "level": "meso", "role": "ear", "importance": 0.8, "confidence": 0.95, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Tabby cat l ear pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.79, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.45, "height": 0.79, "depth": 0.21, "units": "world", "confidence": 0.95}, "transform": {"position": [0.36000000000000004, 3.47, 0.28], "rotation": [0.0, 0.0, 0.1], "scale": [0.45, 0.79, 0.21]}, "actionProfile": {"animationRole": "ear", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-inner-ear-ridges"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_tabby_ear_l_41.userData.actionProfile = {"animationRole": "ear", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-head"] ?? root).add(node_tabby_ear_l_41);
  nodes["tabby-ear-l"] = node_tabby_ear_l_41;
  const mesh_tabby_ear_l_41Geometry = endpoint_tabby_ear_l_41
    ? new THREE.CylinderGeometry(endpoint_tabby_ear_l_41.endRadius, endpoint_tabby_ear_l_41.baseRadius, endpoint_tabby_ear_l_41.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 16);
  const mesh_tabby_ear_l_41 = new THREE.Mesh(
    mesh_tabby_ear_l_41Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_ear_l_41.name = "Tabby cat l ear pivot";
  if (endpoint_tabby_ear_l_41) {
    mesh_tabby_ear_l_41.position.copy(endpoint_tabby_ear_l_41.midpoint);
    mesh_tabby_ear_l_41.quaternion.copy(endpoint_tabby_ear_l_41.quaternion);
  }
  mesh_tabby_ear_l_41.castShadow = options.castShadow ?? true;
  mesh_tabby_ear_l_41.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_ear_l_41.userData.sculptComponent = {"id": "tabby-ear-l", "name": "Tabby cat l ear pivot", "level": "meso", "role": "ear", "importance": 0.8, "confidence": 0.95, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Tabby cat l ear pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.79, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.45, "height": 0.79, "depth": 0.21, "units": "world", "confidence": 0.95}, "transform": {"position": [0.36000000000000004, 3.47, 0.28], "rotation": [0.0, 0.0, 0.1], "scale": [0.45, 0.79, 0.21]}, "actionProfile": {"animationRole": "ear", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-inner-ear-ridges"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_tabby_ear_l_41.add(mesh_tabby_ear_l_41);
  meshes["tabby-ear-l"] = mesh_tabby_ear_l_41;
  colliders["tabby-ear-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_ear_l_41);

  const attachment_tabby_inner_ear_l_42 = {"parentId": "tabby-ear-l", "parentSocket": "tabby-ear-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.56, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]};
  const endpoint_tabby_inner_ear_l_42 = makeAttachmentEndpoint(attachment_tabby_inner_ear_l_42);
  const node_tabby_inner_ear_l_42 = new THREE.Group();
  node_tabby_inner_ear_l_42.name = "Tabby cat l inner ear__pivot";
  if (endpoint_tabby_inner_ear_l_42) {
    node_tabby_inner_ear_l_42.position.copy(endpoint_tabby_inner_ear_l_42.start);
    node_tabby_inner_ear_l_42.rotation.set(0, 0, 0);
    node_tabby_inner_ear_l_42.scale.set(1, 1, 1);
  } else {
    node_tabby_inner_ear_l_42.position.set(0.36000000000000004, 3.43, 0.45);
    node_tabby_inner_ear_l_42.rotation.set(0.0, 0.0, 0.0);
    node_tabby_inner_ear_l_42.scale.set(0.28, 0.56, 0.06);
  }
  node_tabby_inner_ear_l_42.userData.sculptComponent = {"id": "tabby-inner-ear-l", "name": "Tabby cat l inner ear", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.92, "primitive": "cone", "topologyClass": "surface-relief", "topologyRationale": "Tabby cat l inner ear is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-ear-l", "attachment": {"parentId": "tabby-ear-l", "parentSocket": "tabby-ear-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.56, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.28, "height": 0.56, "depth": 0.06, "units": "world", "confidence": 0.92}, "transform": {"position": [0.36000000000000004, 3.43, 0.45], "rotation": [0.0, 0.0, 0.0], "scale": [0.28, 0.56, 0.06]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-inner-ear"}}, "material": "tabby-inner-ear", "materialLayers": ["tabby-inner-ear"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 121, 98, 1.0)", "secondaryAlbedo": "rgba(197, 131, 106, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_tabby_inner_ear_l_42.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-inner-ear"}};
  (nodes["tabby-ear-l"] ?? root).add(node_tabby_inner_ear_l_42);
  nodes["tabby-inner-ear-l"] = node_tabby_inner_ear_l_42;
  const mesh_tabby_inner_ear_l_42Geometry = endpoint_tabby_inner_ear_l_42
    ? new THREE.CylinderGeometry(endpoint_tabby_inner_ear_l_42.endRadius, endpoint_tabby_inner_ear_l_42.baseRadius, endpoint_tabby_inner_ear_l_42.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 16);
  const mesh_tabby_inner_ear_l_42 = new THREE.Mesh(
    mesh_tabby_inner_ear_l_42Geometry,
    materialMap["tabby-inner-ear"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_inner_ear_l_42.name = "Tabby cat l inner ear";
  if (endpoint_tabby_inner_ear_l_42) {
    mesh_tabby_inner_ear_l_42.position.copy(endpoint_tabby_inner_ear_l_42.midpoint);
    mesh_tabby_inner_ear_l_42.quaternion.copy(endpoint_tabby_inner_ear_l_42.quaternion);
  }
  mesh_tabby_inner_ear_l_42.castShadow = options.castShadow ?? true;
  mesh_tabby_inner_ear_l_42.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_inner_ear_l_42.userData.sculptComponent = {"id": "tabby-inner-ear-l", "name": "Tabby cat l inner ear", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.92, "primitive": "cone", "topologyClass": "surface-relief", "topologyRationale": "Tabby cat l inner ear is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-ear-l", "attachment": {"parentId": "tabby-ear-l", "parentSocket": "tabby-ear-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.56, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.28, "height": 0.56, "depth": 0.06, "units": "world", "confidence": 0.92}, "transform": {"position": [0.36000000000000004, 3.43, 0.45], "rotation": [0.0, 0.0, 0.0], "scale": [0.28, 0.56, 0.06]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-inner-ear"}}, "material": "tabby-inner-ear", "materialLayers": ["tabby-inner-ear"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 121, 98, 1.0)", "secondaryAlbedo": "rgba(197, 131, 106, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_tabby_inner_ear_l_42.add(mesh_tabby_inner_ear_l_42);
  meshes["tabby-inner-ear-l"] = mesh_tabby_inner_ear_l_42;
  colliders["tabby-inner-ear-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_inner_ear_l_42);

  const attachment_tabby_ear_r_43 = {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.79, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]};
  const endpoint_tabby_ear_r_43 = makeAttachmentEndpoint(attachment_tabby_ear_r_43);
  const node_tabby_ear_r_43 = new THREE.Group();
  node_tabby_ear_r_43.name = "Tabby cat r ear pivot__pivot";
  if (endpoint_tabby_ear_r_43) {
    node_tabby_ear_r_43.position.copy(endpoint_tabby_ear_r_43.start);
    node_tabby_ear_r_43.rotation.set(0, 0, 0);
    node_tabby_ear_r_43.scale.set(1, 1, 1);
  } else {
    node_tabby_ear_r_43.position.set(1.2, 3.47, 0.28);
    node_tabby_ear_r_43.rotation.set(0.0, 0.0, -0.16);
    node_tabby_ear_r_43.scale.set(0.45, 0.79, 0.21);
  }
  node_tabby_ear_r_43.userData.sculptComponent = {"id": "tabby-ear-r", "name": "Tabby cat r ear pivot", "level": "meso", "role": "ear", "importance": 0.8, "confidence": 0.95, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Tabby cat r ear pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.79, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.45, "height": 0.79, "depth": 0.21, "units": "world", "confidence": 0.95}, "transform": {"position": [1.2, 3.47, 0.28], "rotation": [0.0, 0.0, -0.16], "scale": [0.45, 0.79, 0.21]}, "actionProfile": {"animationRole": "ear", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_tabby_ear_r_43.userData.actionProfile = {"animationRole": "ear", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-head"] ?? root).add(node_tabby_ear_r_43);
  nodes["tabby-ear-r"] = node_tabby_ear_r_43;
  const mesh_tabby_ear_r_43Geometry = endpoint_tabby_ear_r_43
    ? new THREE.CylinderGeometry(endpoint_tabby_ear_r_43.endRadius, endpoint_tabby_ear_r_43.baseRadius, endpoint_tabby_ear_r_43.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 16);
  const mesh_tabby_ear_r_43 = new THREE.Mesh(
    mesh_tabby_ear_r_43Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_ear_r_43.name = "Tabby cat r ear pivot";
  if (endpoint_tabby_ear_r_43) {
    mesh_tabby_ear_r_43.position.copy(endpoint_tabby_ear_r_43.midpoint);
    mesh_tabby_ear_r_43.quaternion.copy(endpoint_tabby_ear_r_43.quaternion);
  }
  mesh_tabby_ear_r_43.castShadow = options.castShadow ?? true;
  mesh_tabby_ear_r_43.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_ear_r_43.userData.sculptComponent = {"id": "tabby-ear-r", "name": "Tabby cat r ear pivot", "level": "meso", "role": "ear", "importance": 0.8, "confidence": 0.95, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Tabby cat r ear pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.79, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.45, "height": 0.79, "depth": 0.21, "units": "world", "confidence": 0.95}, "transform": {"position": [1.2, 3.47, 0.28], "rotation": [0.0, 0.0, -0.16], "scale": [0.45, 0.79, 0.21]}, "actionProfile": {"animationRole": "ear", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_tabby_ear_r_43.add(mesh_tabby_ear_r_43);
  meshes["tabby-ear-r"] = mesh_tabby_ear_r_43;
  colliders["tabby-ear-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_ear_r_43);

  const attachment_tabby_inner_ear_r_44 = {"parentId": "tabby-ear-r", "parentSocket": "tabby-ear-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.56, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]};
  const endpoint_tabby_inner_ear_r_44 = makeAttachmentEndpoint(attachment_tabby_inner_ear_r_44);
  const node_tabby_inner_ear_r_44 = new THREE.Group();
  node_tabby_inner_ear_r_44.name = "Tabby cat r inner ear__pivot";
  if (endpoint_tabby_inner_ear_r_44) {
    node_tabby_inner_ear_r_44.position.copy(endpoint_tabby_inner_ear_r_44.start);
    node_tabby_inner_ear_r_44.rotation.set(0, 0, 0);
    node_tabby_inner_ear_r_44.scale.set(1, 1, 1);
  } else {
    node_tabby_inner_ear_r_44.position.set(1.2, 3.43, 0.45);
    node_tabby_inner_ear_r_44.rotation.set(0.0, 0.0, 0.0);
    node_tabby_inner_ear_r_44.scale.set(0.28, 0.56, 0.06);
  }
  node_tabby_inner_ear_r_44.userData.sculptComponent = {"id": "tabby-inner-ear-r", "name": "Tabby cat r inner ear", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.92, "primitive": "cone", "topologyClass": "surface-relief", "topologyRationale": "Tabby cat r inner ear is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-ear-r", "attachment": {"parentId": "tabby-ear-r", "parentSocket": "tabby-ear-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.56, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.28, "height": 0.56, "depth": 0.06, "units": "world", "confidence": 0.92}, "transform": {"position": [1.2, 3.43, 0.45], "rotation": [0.0, 0.0, 0.0], "scale": [0.28, 0.56, 0.06]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-inner-ear"}}, "material": "tabby-inner-ear", "materialLayers": ["tabby-inner-ear"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 121, 98, 1.0)", "secondaryAlbedo": "rgba(197, 131, 106, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_tabby_inner_ear_r_44.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-inner-ear"}};
  (nodes["tabby-ear-r"] ?? root).add(node_tabby_inner_ear_r_44);
  nodes["tabby-inner-ear-r"] = node_tabby_inner_ear_r_44;
  const mesh_tabby_inner_ear_r_44Geometry = endpoint_tabby_inner_ear_r_44
    ? new THREE.CylinderGeometry(endpoint_tabby_inner_ear_r_44.endRadius, endpoint_tabby_inner_ear_r_44.baseRadius, endpoint_tabby_inner_ear_r_44.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 16);
  const mesh_tabby_inner_ear_r_44 = new THREE.Mesh(
    mesh_tabby_inner_ear_r_44Geometry,
    materialMap["tabby-inner-ear"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_inner_ear_r_44.name = "Tabby cat r inner ear";
  if (endpoint_tabby_inner_ear_r_44) {
    mesh_tabby_inner_ear_r_44.position.copy(endpoint_tabby_inner_ear_r_44.midpoint);
    mesh_tabby_inner_ear_r_44.quaternion.copy(endpoint_tabby_inner_ear_r_44.quaternion);
  }
  mesh_tabby_inner_ear_r_44.castShadow = options.castShadow ?? true;
  mesh_tabby_inner_ear_r_44.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_inner_ear_r_44.userData.sculptComponent = {"id": "tabby-inner-ear-r", "name": "Tabby cat r inner ear", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.92, "primitive": "cone", "topologyClass": "surface-relief", "topologyRationale": "Tabby cat r inner ear is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in ear-region.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-ear-r", "attachment": {"parentId": "tabby-ear-r", "parentSocket": "tabby-ear-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.56, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["ear-region"]}, "dimensions": {"width": 0.28, "height": 0.56, "depth": 0.06, "units": "world", "confidence": 0.92}, "transform": {"position": [1.2, 3.43, 0.45], "rotation": [0.0, 0.0, 0.0], "scale": [0.28, 0.56, 0.06]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-inner-ear"}}, "material": "tabby-inner-ear", "materialLayers": ["tabby-inner-ear"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 121, 98, 1.0)", "secondaryAlbedo": "rgba(197, 131, 106, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["ear-region"]};
  node_tabby_inner_ear_r_44.add(mesh_tabby_inner_ear_r_44);
  meshes["tabby-inner-ear-r"] = mesh_tabby_inner_ear_r_44;
  colliders["tabby-inner-ear-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_inner_ear_r_44);

  const attachment_tabby_eye_l_45 = {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.29, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_eye_l_45 = makeAttachmentEndpoint(attachment_tabby_eye_l_45);
  const node_tabby_eye_l_45 = new THREE.Group();
  node_tabby_eye_l_45.name = "Tabby cat l eyeball__pivot";
  if (endpoint_tabby_eye_l_45) {
    node_tabby_eye_l_45.position.copy(endpoint_tabby_eye_l_45.start);
    node_tabby_eye_l_45.rotation.set(0, 0, 0);
    node_tabby_eye_l_45.scale.set(1, 1, 1);
  } else {
    node_tabby_eye_l_45.position.set(0.51, 2.88, 0.84);
    node_tabby_eye_l_45.rotation.set(0.0, 0.0, 0.0);
    node_tabby_eye_l_45.scale.set(0.27, 0.29, 0.17);
  }
  node_tabby_eye_l_45.userData.sculptComponent = {"id": "tabby-eye-l", "name": "Tabby cat l eyeball", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.99, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l eyeball is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.29, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.27, "height": 0.29, "depth": 0.17, "units": "world", "confidence": 0.99}, "transform": {"position": [0.51, 2.88, 0.84], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 0.29, 0.17]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_eye_l_45.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}};
  (nodes["tabby-head"] ?? root).add(node_tabby_eye_l_45);
  nodes["tabby-eye-l"] = node_tabby_eye_l_45;
  const mesh_tabby_eye_l_45Geometry = endpoint_tabby_eye_l_45
    ? new THREE.CylinderGeometry(endpoint_tabby_eye_l_45.endRadius, endpoint_tabby_eye_l_45.baseRadius, endpoint_tabby_eye_l_45.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_eye_l_45 = new THREE.Mesh(
    mesh_tabby_eye_l_45Geometry,
    materialMap["iris-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_eye_l_45.name = "Tabby cat l eyeball";
  if (endpoint_tabby_eye_l_45) {
    mesh_tabby_eye_l_45.position.copy(endpoint_tabby_eye_l_45.midpoint);
    mesh_tabby_eye_l_45.quaternion.copy(endpoint_tabby_eye_l_45.quaternion);
  }
  mesh_tabby_eye_l_45.castShadow = options.castShadow ?? true;
  mesh_tabby_eye_l_45.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_eye_l_45.userData.sculptComponent = {"id": "tabby-eye-l", "name": "Tabby cat l eyeball", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.99, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l eyeball is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.29, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.27, "height": 0.29, "depth": 0.17, "units": "world", "confidence": 0.99}, "transform": {"position": [0.51, 2.88, 0.84], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 0.29, 0.17]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_eye_l_45.add(mesh_tabby_eye_l_45);
  meshes["tabby-eye-l"] = mesh_tabby_eye_l_45;
  colliders["tabby-eye-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_eye_l_45);

  const attachment_tabby_iris_l_46 = {"parentId": "tabby-eye-l", "parentSocket": "tabby-eye-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_iris_l_46 = makeAttachmentEndpoint(attachment_tabby_iris_l_46);
  const node_tabby_iris_l_46 = new THREE.Group();
  node_tabby_iris_l_46.name = "Tabby cat l iris ring__pivot";
  if (endpoint_tabby_iris_l_46) {
    node_tabby_iris_l_46.position.copy(endpoint_tabby_iris_l_46.start);
    node_tabby_iris_l_46.rotation.set(0, 0, 0);
    node_tabby_iris_l_46.scale.set(1, 1, 1);
  } else {
    node_tabby_iris_l_46.position.set(0.51, 2.88, 0.955);
    node_tabby_iris_l_46.rotation.set(0.0, 0.0, 0.0);
    node_tabby_iris_l_46.scale.set(0.22, 0.24, 0.04);
  }
  node_tabby_iris_l_46.userData.sculptComponent = {"id": "tabby-iris-l", "name": "Tabby cat l iris ring", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.98, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l iris ring is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-eye-l", "attachment": {"parentId": "tabby-eye-l", "parentSocket": "tabby-eye-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.22, "height": 0.24, "depth": 0.04, "units": "world", "confidence": 0.98}, "transform": {"position": [0.51, 2.88, 0.955], "rotation": [0.0, 0.0, 0.0], "scale": [0.22, 0.24, 0.04]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_iris_l_46.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}};
  (nodes["tabby-eye-l"] ?? root).add(node_tabby_iris_l_46);
  nodes["tabby-iris-l"] = node_tabby_iris_l_46;
  const mesh_tabby_iris_l_46Geometry = endpoint_tabby_iris_l_46
    ? new THREE.CylinderGeometry(endpoint_tabby_iris_l_46.endRadius, endpoint_tabby_iris_l_46.baseRadius, endpoint_tabby_iris_l_46.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_iris_l_46 = new THREE.Mesh(
    mesh_tabby_iris_l_46Geometry,
    materialMap["iris-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_iris_l_46.name = "Tabby cat l iris ring";
  if (endpoint_tabby_iris_l_46) {
    mesh_tabby_iris_l_46.position.copy(endpoint_tabby_iris_l_46.midpoint);
    mesh_tabby_iris_l_46.quaternion.copy(endpoint_tabby_iris_l_46.quaternion);
  }
  mesh_tabby_iris_l_46.castShadow = options.castShadow ?? true;
  mesh_tabby_iris_l_46.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_iris_l_46.userData.sculptComponent = {"id": "tabby-iris-l", "name": "Tabby cat l iris ring", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.98, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l iris ring is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-eye-l", "attachment": {"parentId": "tabby-eye-l", "parentSocket": "tabby-eye-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.22, "height": 0.24, "depth": 0.04, "units": "world", "confidence": 0.98}, "transform": {"position": [0.51, 2.88, 0.955], "rotation": [0.0, 0.0, 0.0], "scale": [0.22, 0.24, 0.04]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_iris_l_46.add(mesh_tabby_iris_l_46);
  meshes["tabby-iris-l"] = mesh_tabby_iris_l_46;
  colliders["tabby-iris-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_iris_l_46);

  const attachment_tabby_pupil_l_47 = {"parentId": "tabby-iris-l", "parentSocket": "tabby-iris-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.16, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_pupil_l_47 = makeAttachmentEndpoint(attachment_tabby_pupil_l_47);
  const node_tabby_pupil_l_47 = new THREE.Group();
  node_tabby_pupil_l_47.name = "Tabby cat l round pupil__pivot";
  if (endpoint_tabby_pupil_l_47) {
    node_tabby_pupil_l_47.position.copy(endpoint_tabby_pupil_l_47.start);
    node_tabby_pupil_l_47.rotation.set(0, 0, 0);
    node_tabby_pupil_l_47.scale.set(1, 1, 1);
  } else {
    node_tabby_pupil_l_47.position.set(0.51, 2.88, 0.985);
    node_tabby_pupil_l_47.rotation.set(0.0, 0.0, 0.0);
    node_tabby_pupil_l_47.scale.set(0.145, 0.16, 0.024);
  }
  node_tabby_pupil_l_47.userData.sculptComponent = {"id": "tabby-pupil-l", "name": "Tabby cat l round pupil", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.99, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l round pupil is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-iris-l", "attachment": {"parentId": "tabby-iris-l", "parentSocket": "tabby-iris-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.16, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.145, "height": 0.16, "depth": 0.024, "units": "world", "confidence": 0.99}, "transform": {"position": [0.51, 2.88, 0.985], "rotation": [0.0, 0.0, 0.0], "scale": [0.145, 0.16, 0.024]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pupil"}}, "material": "pupil", "materialLayers": ["pupil"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(2, 4, 3, 1.0)", "secondaryAlbedo": "rgba(14, 14, 11, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_pupil_l_47.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pupil"}};
  (nodes["tabby-iris-l"] ?? root).add(node_tabby_pupil_l_47);
  nodes["tabby-pupil-l"] = node_tabby_pupil_l_47;
  const mesh_tabby_pupil_l_47Geometry = endpoint_tabby_pupil_l_47
    ? new THREE.CylinderGeometry(endpoint_tabby_pupil_l_47.endRadius, endpoint_tabby_pupil_l_47.baseRadius, endpoint_tabby_pupil_l_47.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_pupil_l_47 = new THREE.Mesh(
    mesh_tabby_pupil_l_47Geometry,
    materialMap["pupil"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_pupil_l_47.name = "Tabby cat l round pupil";
  if (endpoint_tabby_pupil_l_47) {
    mesh_tabby_pupil_l_47.position.copy(endpoint_tabby_pupil_l_47.midpoint);
    mesh_tabby_pupil_l_47.quaternion.copy(endpoint_tabby_pupil_l_47.quaternion);
  }
  mesh_tabby_pupil_l_47.castShadow = options.castShadow ?? true;
  mesh_tabby_pupil_l_47.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_pupil_l_47.userData.sculptComponent = {"id": "tabby-pupil-l", "name": "Tabby cat l round pupil", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.99, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l round pupil is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-iris-l", "attachment": {"parentId": "tabby-iris-l", "parentSocket": "tabby-iris-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.16, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.145, "height": 0.16, "depth": 0.024, "units": "world", "confidence": 0.99}, "transform": {"position": [0.51, 2.88, 0.985], "rotation": [0.0, 0.0, 0.0], "scale": [0.145, 0.16, 0.024]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pupil"}}, "material": "pupil", "materialLayers": ["pupil"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(2, 4, 3, 1.0)", "secondaryAlbedo": "rgba(14, 14, 11, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_pupil_l_47.add(mesh_tabby_pupil_l_47);
  meshes["tabby-pupil-l"] = mesh_tabby_pupil_l_47;
  colliders["tabby-pupil-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_pupil_l_47);

  const attachment_tabby_cornea_l_48 = {"parentId": "tabby-eye-l", "parentSocket": "tabby-eye-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.26, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_cornea_l_48 = makeAttachmentEndpoint(attachment_tabby_cornea_l_48);
  const node_tabby_cornea_l_48 = new THREE.Group();
  node_tabby_cornea_l_48.name = "Tabby cat l convex cornea__pivot";
  if (endpoint_tabby_cornea_l_48) {
    node_tabby_cornea_l_48.position.copy(endpoint_tabby_cornea_l_48.start);
    node_tabby_cornea_l_48.rotation.set(0, 0, 0);
    node_tabby_cornea_l_48.scale.set(1, 1, 1);
  } else {
    node_tabby_cornea_l_48.position.set(0.51, 2.88, 1.0);
    node_tabby_cornea_l_48.rotation.set(0.0, 0.0, 0.0);
    node_tabby_cornea_l_48.scale.set(0.245, 0.26, 0.052);
  }
  node_tabby_cornea_l_48.userData.sculptComponent = {"id": "tabby-cornea-l", "name": "Tabby cat l convex cornea", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.97, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l convex cornea is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-eye-l", "attachment": {"parentId": "tabby-eye-l", "parentSocket": "tabby-eye-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.26, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.245, "height": 0.26, "depth": 0.052, "units": "world", "confidence": 0.97}, "transform": {"position": [0.51, 2.88, 1.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.245, 0.26, 0.052]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cornea"}}, "material": "cornea", "materialLayers": ["cornea"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 0.24)", "secondaryAlbedo": "rgba(255, 255, 255, 0.24)", "materialClass": "glass", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_cornea_l_48.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cornea"}};
  (nodes["tabby-eye-l"] ?? root).add(node_tabby_cornea_l_48);
  nodes["tabby-cornea-l"] = node_tabby_cornea_l_48;
  const mesh_tabby_cornea_l_48Geometry = endpoint_tabby_cornea_l_48
    ? new THREE.CylinderGeometry(endpoint_tabby_cornea_l_48.endRadius, endpoint_tabby_cornea_l_48.baseRadius, endpoint_tabby_cornea_l_48.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_cornea_l_48 = new THREE.Mesh(
    mesh_tabby_cornea_l_48Geometry,
    materialMap["cornea"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_cornea_l_48.name = "Tabby cat l convex cornea";
  if (endpoint_tabby_cornea_l_48) {
    mesh_tabby_cornea_l_48.position.copy(endpoint_tabby_cornea_l_48.midpoint);
    mesh_tabby_cornea_l_48.quaternion.copy(endpoint_tabby_cornea_l_48.quaternion);
  }
  mesh_tabby_cornea_l_48.castShadow = options.castShadow ?? true;
  mesh_tabby_cornea_l_48.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_cornea_l_48.userData.sculptComponent = {"id": "tabby-cornea-l", "name": "Tabby cat l convex cornea", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.97, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l convex cornea is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-eye-l", "attachment": {"parentId": "tabby-eye-l", "parentSocket": "tabby-eye-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.26, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.245, "height": 0.26, "depth": 0.052, "units": "world", "confidence": 0.97}, "transform": {"position": [0.51, 2.88, 1.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.245, 0.26, 0.052]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cornea"}}, "material": "cornea", "materialLayers": ["cornea"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 0.24)", "secondaryAlbedo": "rgba(255, 255, 255, 0.24)", "materialClass": "glass", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_cornea_l_48.add(mesh_tabby_cornea_l_48);
  meshes["tabby-cornea-l"] = mesh_tabby_cornea_l_48;
  colliders["tabby-cornea-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_cornea_l_48);

  const attachment_tabby_eye_r_49 = {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.29, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_eye_r_49 = makeAttachmentEndpoint(attachment_tabby_eye_r_49);
  const node_tabby_eye_r_49 = new THREE.Group();
  node_tabby_eye_r_49.name = "Tabby cat r eyeball__pivot";
  if (endpoint_tabby_eye_r_49) {
    node_tabby_eye_r_49.position.copy(endpoint_tabby_eye_r_49.start);
    node_tabby_eye_r_49.rotation.set(0, 0, 0);
    node_tabby_eye_r_49.scale.set(1, 1, 1);
  } else {
    node_tabby_eye_r_49.position.set(1.05, 2.88, 0.84);
    node_tabby_eye_r_49.rotation.set(0.0, 0.0, 0.0);
    node_tabby_eye_r_49.scale.set(0.27, 0.29, 0.17);
  }
  node_tabby_eye_r_49.userData.sculptComponent = {"id": "tabby-eye-r", "name": "Tabby cat r eyeball", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.99, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r eyeball is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.29, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.27, "height": 0.29, "depth": 0.17, "units": "world", "confidence": 0.99}, "transform": {"position": [1.05, 2.88, 0.84], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 0.29, 0.17]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_eye_r_49.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}};
  (nodes["tabby-head"] ?? root).add(node_tabby_eye_r_49);
  nodes["tabby-eye-r"] = node_tabby_eye_r_49;
  const mesh_tabby_eye_r_49Geometry = endpoint_tabby_eye_r_49
    ? new THREE.CylinderGeometry(endpoint_tabby_eye_r_49.endRadius, endpoint_tabby_eye_r_49.baseRadius, endpoint_tabby_eye_r_49.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_eye_r_49 = new THREE.Mesh(
    mesh_tabby_eye_r_49Geometry,
    materialMap["iris-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_eye_r_49.name = "Tabby cat r eyeball";
  if (endpoint_tabby_eye_r_49) {
    mesh_tabby_eye_r_49.position.copy(endpoint_tabby_eye_r_49.midpoint);
    mesh_tabby_eye_r_49.quaternion.copy(endpoint_tabby_eye_r_49.quaternion);
  }
  mesh_tabby_eye_r_49.castShadow = options.castShadow ?? true;
  mesh_tabby_eye_r_49.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_eye_r_49.userData.sculptComponent = {"id": "tabby-eye-r", "name": "Tabby cat r eyeball", "level": "meso", "role": "detail", "importance": 0.8, "confidence": 0.99, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r eyeball is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.29, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.27, "height": 0.29, "depth": 0.17, "units": "world", "confidence": 0.99}, "transform": {"position": [1.05, 2.88, 0.84], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 0.29, 0.17]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_eye_r_49.add(mesh_tabby_eye_r_49);
  meshes["tabby-eye-r"] = mesh_tabby_eye_r_49;
  colliders["tabby-eye-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_eye_r_49);

  const attachment_tabby_iris_r_50 = {"parentId": "tabby-eye-r", "parentSocket": "tabby-eye-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_iris_r_50 = makeAttachmentEndpoint(attachment_tabby_iris_r_50);
  const node_tabby_iris_r_50 = new THREE.Group();
  node_tabby_iris_r_50.name = "Tabby cat r iris ring__pivot";
  if (endpoint_tabby_iris_r_50) {
    node_tabby_iris_r_50.position.copy(endpoint_tabby_iris_r_50.start);
    node_tabby_iris_r_50.rotation.set(0, 0, 0);
    node_tabby_iris_r_50.scale.set(1, 1, 1);
  } else {
    node_tabby_iris_r_50.position.set(1.05, 2.88, 0.955);
    node_tabby_iris_r_50.rotation.set(0.0, 0.0, 0.0);
    node_tabby_iris_r_50.scale.set(0.22, 0.24, 0.04);
  }
  node_tabby_iris_r_50.userData.sculptComponent = {"id": "tabby-iris-r", "name": "Tabby cat r iris ring", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.98, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r iris ring is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-eye-r", "attachment": {"parentId": "tabby-eye-r", "parentSocket": "tabby-eye-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.22, "height": 0.24, "depth": 0.04, "units": "world", "confidence": 0.98}, "transform": {"position": [1.05, 2.88, 0.955], "rotation": [0.0, 0.0, 0.0], "scale": [0.22, 0.24, 0.04]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_iris_r_50.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}};
  (nodes["tabby-eye-r"] ?? root).add(node_tabby_iris_r_50);
  nodes["tabby-iris-r"] = node_tabby_iris_r_50;
  const mesh_tabby_iris_r_50Geometry = endpoint_tabby_iris_r_50
    ? new THREE.CylinderGeometry(endpoint_tabby_iris_r_50.endRadius, endpoint_tabby_iris_r_50.baseRadius, endpoint_tabby_iris_r_50.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_iris_r_50 = new THREE.Mesh(
    mesh_tabby_iris_r_50Geometry,
    materialMap["iris-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_iris_r_50.name = "Tabby cat r iris ring";
  if (endpoint_tabby_iris_r_50) {
    mesh_tabby_iris_r_50.position.copy(endpoint_tabby_iris_r_50.midpoint);
    mesh_tabby_iris_r_50.quaternion.copy(endpoint_tabby_iris_r_50.quaternion);
  }
  mesh_tabby_iris_r_50.castShadow = options.castShadow ?? true;
  mesh_tabby_iris_r_50.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_iris_r_50.userData.sculptComponent = {"id": "tabby-iris-r", "name": "Tabby cat r iris ring", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.98, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r iris ring is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-eye-r", "attachment": {"parentId": "tabby-eye-r", "parentSocket": "tabby-eye-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.22, "height": 0.24, "depth": 0.04, "units": "world", "confidence": 0.98}, "transform": {"position": [1.05, 2.88, 0.955], "rotation": [0.0, 0.0, 0.0], "scale": [0.22, 0.24, 0.04]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "iris-green"}}, "material": "iris-green", "materialLayers": ["iris-green"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 1.0)", "secondaryAlbedo": "rgba(204, 211, 114, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_iris_r_50.add(mesh_tabby_iris_r_50);
  meshes["tabby-iris-r"] = mesh_tabby_iris_r_50;
  colliders["tabby-iris-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_iris_r_50);

  const attachment_tabby_pupil_r_51 = {"parentId": "tabby-iris-r", "parentSocket": "tabby-iris-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.16, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_pupil_r_51 = makeAttachmentEndpoint(attachment_tabby_pupil_r_51);
  const node_tabby_pupil_r_51 = new THREE.Group();
  node_tabby_pupil_r_51.name = "Tabby cat r round pupil__pivot";
  if (endpoint_tabby_pupil_r_51) {
    node_tabby_pupil_r_51.position.copy(endpoint_tabby_pupil_r_51.start);
    node_tabby_pupil_r_51.rotation.set(0, 0, 0);
    node_tabby_pupil_r_51.scale.set(1, 1, 1);
  } else {
    node_tabby_pupil_r_51.position.set(1.05, 2.88, 0.985);
    node_tabby_pupil_r_51.rotation.set(0.0, 0.0, 0.0);
    node_tabby_pupil_r_51.scale.set(0.145, 0.16, 0.024);
  }
  node_tabby_pupil_r_51.userData.sculptComponent = {"id": "tabby-pupil-r", "name": "Tabby cat r round pupil", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.99, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r round pupil is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-iris-r", "attachment": {"parentId": "tabby-iris-r", "parentSocket": "tabby-iris-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.16, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.145, "height": 0.16, "depth": 0.024, "units": "world", "confidence": 0.99}, "transform": {"position": [1.05, 2.88, 0.985], "rotation": [0.0, 0.0, 0.0], "scale": [0.145, 0.16, 0.024]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pupil"}}, "material": "pupil", "materialLayers": ["pupil"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(2, 4, 3, 1.0)", "secondaryAlbedo": "rgba(14, 14, 11, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_pupil_r_51.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pupil"}};
  (nodes["tabby-iris-r"] ?? root).add(node_tabby_pupil_r_51);
  nodes["tabby-pupil-r"] = node_tabby_pupil_r_51;
  const mesh_tabby_pupil_r_51Geometry = endpoint_tabby_pupil_r_51
    ? new THREE.CylinderGeometry(endpoint_tabby_pupil_r_51.endRadius, endpoint_tabby_pupil_r_51.baseRadius, endpoint_tabby_pupil_r_51.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_pupil_r_51 = new THREE.Mesh(
    mesh_tabby_pupil_r_51Geometry,
    materialMap["pupil"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_pupil_r_51.name = "Tabby cat r round pupil";
  if (endpoint_tabby_pupil_r_51) {
    mesh_tabby_pupil_r_51.position.copy(endpoint_tabby_pupil_r_51.midpoint);
    mesh_tabby_pupil_r_51.quaternion.copy(endpoint_tabby_pupil_r_51.quaternion);
  }
  mesh_tabby_pupil_r_51.castShadow = options.castShadow ?? true;
  mesh_tabby_pupil_r_51.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_pupil_r_51.userData.sculptComponent = {"id": "tabby-pupil-r", "name": "Tabby cat r round pupil", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.99, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r round pupil is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-iris-r", "attachment": {"parentId": "tabby-iris-r", "parentSocket": "tabby-iris-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.16, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.145, "height": 0.16, "depth": 0.024, "units": "world", "confidence": 0.99}, "transform": {"position": [1.05, 2.88, 0.985], "rotation": [0.0, 0.0, 0.0], "scale": [0.145, 0.16, 0.024]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "pupil"}}, "material": "pupil", "materialLayers": ["pupil"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(2, 4, 3, 1.0)", "secondaryAlbedo": "rgba(14, 14, 11, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_pupil_r_51.add(mesh_tabby_pupil_r_51);
  meshes["tabby-pupil-r"] = mesh_tabby_pupil_r_51;
  colliders["tabby-pupil-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_pupil_r_51);

  const attachment_tabby_cornea_r_52 = {"parentId": "tabby-eye-r", "parentSocket": "tabby-eye-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.26, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_cornea_r_52 = makeAttachmentEndpoint(attachment_tabby_cornea_r_52);
  const node_tabby_cornea_r_52 = new THREE.Group();
  node_tabby_cornea_r_52.name = "Tabby cat r convex cornea__pivot";
  if (endpoint_tabby_cornea_r_52) {
    node_tabby_cornea_r_52.position.copy(endpoint_tabby_cornea_r_52.start);
    node_tabby_cornea_r_52.rotation.set(0, 0, 0);
    node_tabby_cornea_r_52.scale.set(1, 1, 1);
  } else {
    node_tabby_cornea_r_52.position.set(1.05, 2.88, 1.0);
    node_tabby_cornea_r_52.rotation.set(0.0, 0.0, 0.0);
    node_tabby_cornea_r_52.scale.set(0.245, 0.26, 0.052);
  }
  node_tabby_cornea_r_52.userData.sculptComponent = {"id": "tabby-cornea-r", "name": "Tabby cat r convex cornea", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.97, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r convex cornea is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-eye-r", "attachment": {"parentId": "tabby-eye-r", "parentSocket": "tabby-eye-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.26, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.245, "height": 0.26, "depth": 0.052, "units": "world", "confidence": 0.97}, "transform": {"position": [1.05, 2.88, 1.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.245, 0.26, 0.052]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cornea"}}, "material": "cornea", "materialLayers": ["cornea"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 0.24)", "secondaryAlbedo": "rgba(255, 255, 255, 0.24)", "materialClass": "glass", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_cornea_r_52.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cornea"}};
  (nodes["tabby-eye-r"] ?? root).add(node_tabby_cornea_r_52);
  nodes["tabby-cornea-r"] = node_tabby_cornea_r_52;
  const mesh_tabby_cornea_r_52Geometry = endpoint_tabby_cornea_r_52
    ? new THREE.CylinderGeometry(endpoint_tabby_cornea_r_52.endRadius, endpoint_tabby_cornea_r_52.baseRadius, endpoint_tabby_cornea_r_52.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_cornea_r_52 = new THREE.Mesh(
    mesh_tabby_cornea_r_52Geometry,
    materialMap["cornea"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_cornea_r_52.name = "Tabby cat r convex cornea";
  if (endpoint_tabby_cornea_r_52) {
    mesh_tabby_cornea_r_52.position.copy(endpoint_tabby_cornea_r_52.midpoint);
    mesh_tabby_cornea_r_52.quaternion.copy(endpoint_tabby_cornea_r_52.quaternion);
  }
  mesh_tabby_cornea_r_52.castShadow = options.castShadow ?? true;
  mesh_tabby_cornea_r_52.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_cornea_r_52.userData.sculptComponent = {"id": "tabby-cornea-r", "name": "Tabby cat r convex cornea", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.97, "primitive": "sphere", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r convex cornea is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-eye-r", "attachment": {"parentId": "tabby-eye-r", "parentSocket": "tabby-eye-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.26, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.245, "height": 0.26, "depth": 0.052, "units": "world", "confidence": 0.97}, "transform": {"position": [1.05, 2.88, 1.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.245, 0.26, 0.052]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "cornea"}}, "material": "cornea", "materialLayers": ["cornea"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(192, 201, 106, 0.24)", "secondaryAlbedo": "rgba(255, 255, 255, 0.24)", "materialClass": "glass", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_cornea_r_52.add(mesh_tabby_cornea_r_52);
  meshes["tabby-cornea-r"] = mesh_tabby_cornea_r_52;
  colliders["tabby-cornea-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_cornea_r_52);

  const attachment_tabby_muzzle_l_53 = {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.23, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_muzzle_l_53 = makeAttachmentEndpoint(attachment_tabby_muzzle_l_53);
  const node_tabby_muzzle_l_53 = new THREE.Group();
  node_tabby_muzzle_l_53.name = "Tabby cat l white muzzle pad__pivot";
  if (endpoint_tabby_muzzle_l_53) {
    node_tabby_muzzle_l_53.position.copy(endpoint_tabby_muzzle_l_53.start);
    node_tabby_muzzle_l_53.rotation.set(0, 0, 0);
    node_tabby_muzzle_l_53.scale.set(1, 1, 1);
  } else {
    node_tabby_muzzle_l_53.position.set(0.5900000000000001, 2.53, 0.82);
    node_tabby_muzzle_l_53.rotation.set(0.0, 0.0, 0.0);
    node_tabby_muzzle_l_53.scale.set(0.29, 0.23, 0.21);
  }
  node_tabby_muzzle_l_53.userData.sculptComponent = {"id": "tabby-muzzle-l", "name": "Tabby cat l white muzzle pad", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.96, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l white muzzle pad is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.23, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.29, "height": 0.23, "depth": 0.21, "units": "world", "confidence": 0.96}, "transform": {"position": [0.5900000000000001, 2.53, 0.82], "rotation": [0.0, 0.0, 0.0], "scale": [0.29, 0.23, 0.21]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_muzzle_l_53.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}};
  (nodes["tabby-head"] ?? root).add(node_tabby_muzzle_l_53);
  nodes["tabby-muzzle-l"] = node_tabby_muzzle_l_53;
  const mesh_tabby_muzzle_l_53Geometry = endpoint_tabby_muzzle_l_53
    ? new THREE.CylinderGeometry(endpoint_tabby_muzzle_l_53.endRadius, endpoint_tabby_muzzle_l_53.baseRadius, endpoint_tabby_muzzle_l_53.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_muzzle_l_53 = new THREE.Mesh(
    mesh_tabby_muzzle_l_53Geometry,
    materialMap["white-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_muzzle_l_53.name = "Tabby cat l white muzzle pad";
  if (endpoint_tabby_muzzle_l_53) {
    mesh_tabby_muzzle_l_53.position.copy(endpoint_tabby_muzzle_l_53.midpoint);
    mesh_tabby_muzzle_l_53.quaternion.copy(endpoint_tabby_muzzle_l_53.quaternion);
  }
  mesh_tabby_muzzle_l_53.castShadow = options.castShadow ?? true;
  mesh_tabby_muzzle_l_53.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_muzzle_l_53.userData.sculptComponent = {"id": "tabby-muzzle-l", "name": "Tabby cat l white muzzle pad", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.96, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l white muzzle pad is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.23, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.29, "height": 0.23, "depth": 0.21, "units": "world", "confidence": 0.96}, "transform": {"position": [0.5900000000000001, 2.53, 0.82], "rotation": [0.0, 0.0, 0.0], "scale": [0.29, 0.23, 0.21]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_muzzle_l_53.add(mesh_tabby_muzzle_l_53);
  meshes["tabby-muzzle-l"] = mesh_tabby_muzzle_l_53;
  colliders["tabby-muzzle-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_muzzle_l_53);

  const attachment_tabby_whiskers_l_54 = {"parentId": "tabby-muzzle-l", "parentSocket": "tabby-muzzle-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.38, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_whiskers_l_54 = makeAttachmentEndpoint(attachment_tabby_whiskers_l_54);
  const node_tabby_whiskers_l_54 = new THREE.Group();
  node_tabby_whiskers_l_54.name = "Tabby cat l whisker fan__pivot";
  if (endpoint_tabby_whiskers_l_54) {
    node_tabby_whiskers_l_54.position.copy(endpoint_tabby_whiskers_l_54.start);
    node_tabby_whiskers_l_54.rotation.set(0, 0, 0);
    node_tabby_whiskers_l_54.scale.set(1, 1, 1);
  } else {
    node_tabby_whiskers_l_54.position.set(0.47000000000000003, 2.55, 0.95);
    node_tabby_whiskers_l_54.rotation.set(0.0, 0.0, 0.0);
    node_tabby_whiskers_l_54.scale.set(0.78, 0.38, 0.05);
  }
  node_tabby_whiskers_l_54.userData.sculptComponent = {"id": "tabby-whiskers-l", "name": "Tabby cat l whisker fan", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.96, "primitive": "instanced-cluster", "topologyClass": "fiber-strand", "topologyRationale": "Tabby cat l whisker fan is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-muzzle-l", "attachment": {"parentId": "tabby-muzzle-l", "parentSocket": "tabby-muzzle-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.38, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.78, "height": 0.38, "depth": 0.05, "units": "world", "confidence": 0.96}, "transform": {"position": [0.47000000000000003, 2.55, 0.95], "rotation": [0.0, 0.0, 0.0], "scale": [0.78, 0.38, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "whisker"}}, "material": "whisker", "materialLayers": ["whisker"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 223, 206, 1.0)", "secondaryAlbedo": "rgba(246, 233, 214, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-whisker-fan"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_whiskers_l_54.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "whisker"}};
  (nodes["tabby-muzzle-l"] ?? root).add(node_tabby_whiskers_l_54);
  nodes["tabby-whiskers-l"] = node_tabby_whiskers_l_54;
  const mesh_tabby_whiskers_l_54Geometry = endpoint_tabby_whiskers_l_54
    ? new THREE.CylinderGeometry(endpoint_tabby_whiskers_l_54.endRadius, endpoint_tabby_whiskers_l_54.baseRadius, endpoint_tabby_whiskers_l_54.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tabby_whiskers_l_54 = new THREE.Mesh(
    mesh_tabby_whiskers_l_54Geometry,
    materialMap["whisker"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_whiskers_l_54.name = "Tabby cat l whisker fan";
  if (endpoint_tabby_whiskers_l_54) {
    mesh_tabby_whiskers_l_54.position.copy(endpoint_tabby_whiskers_l_54.midpoint);
    mesh_tabby_whiskers_l_54.quaternion.copy(endpoint_tabby_whiskers_l_54.quaternion);
  }
  mesh_tabby_whiskers_l_54.castShadow = options.castShadow ?? true;
  mesh_tabby_whiskers_l_54.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_whiskers_l_54.userData.sculptComponent = {"id": "tabby-whiskers-l", "name": "Tabby cat l whisker fan", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.96, "primitive": "instanced-cluster", "topologyClass": "fiber-strand", "topologyRationale": "Tabby cat l whisker fan is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-muzzle-l", "attachment": {"parentId": "tabby-muzzle-l", "parentSocket": "tabby-muzzle-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.38, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.78, "height": 0.38, "depth": 0.05, "units": "world", "confidence": 0.96}, "transform": {"position": [0.47000000000000003, 2.55, 0.95], "rotation": [0.0, 0.0, 0.0], "scale": [0.78, 0.38, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "whisker"}}, "material": "whisker", "materialLayers": ["whisker"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 223, 206, 1.0)", "secondaryAlbedo": "rgba(246, 233, 214, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-whisker-fan"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_whiskers_l_54.add(mesh_tabby_whiskers_l_54);
  meshes["tabby-whiskers-l"] = mesh_tabby_whiskers_l_54;
  colliders["tabby-whiskers-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_whiskers_l_54);

  const attachment_tabby_muzzle_r_55 = {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.23, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_muzzle_r_55 = makeAttachmentEndpoint(attachment_tabby_muzzle_r_55);
  const node_tabby_muzzle_r_55 = new THREE.Group();
  node_tabby_muzzle_r_55.name = "Tabby cat r white muzzle pad__pivot";
  if (endpoint_tabby_muzzle_r_55) {
    node_tabby_muzzle_r_55.position.copy(endpoint_tabby_muzzle_r_55.start);
    node_tabby_muzzle_r_55.rotation.set(0, 0, 0);
    node_tabby_muzzle_r_55.scale.set(1, 1, 1);
  } else {
    node_tabby_muzzle_r_55.position.set(0.97, 2.53, 0.82);
    node_tabby_muzzle_r_55.rotation.set(0.0, 0.0, 0.0);
    node_tabby_muzzle_r_55.scale.set(0.29, 0.23, 0.21);
  }
  node_tabby_muzzle_r_55.userData.sculptComponent = {"id": "tabby-muzzle-r", "name": "Tabby cat r white muzzle pad", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.96, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r white muzzle pad is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.23, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.29, "height": 0.23, "depth": 0.21, "units": "world", "confidence": 0.96}, "transform": {"position": [0.97, 2.53, 0.82], "rotation": [0.0, 0.0, 0.0], "scale": [0.29, 0.23, 0.21]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_muzzle_r_55.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}};
  (nodes["tabby-head"] ?? root).add(node_tabby_muzzle_r_55);
  nodes["tabby-muzzle-r"] = node_tabby_muzzle_r_55;
  const mesh_tabby_muzzle_r_55Geometry = endpoint_tabby_muzzle_r_55
    ? new THREE.CylinderGeometry(endpoint_tabby_muzzle_r_55.endRadius, endpoint_tabby_muzzle_r_55.baseRadius, endpoint_tabby_muzzle_r_55.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_muzzle_r_55 = new THREE.Mesh(
    mesh_tabby_muzzle_r_55Geometry,
    materialMap["white-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_muzzle_r_55.name = "Tabby cat r white muzzle pad";
  if (endpoint_tabby_muzzle_r_55) {
    mesh_tabby_muzzle_r_55.position.copy(endpoint_tabby_muzzle_r_55.midpoint);
    mesh_tabby_muzzle_r_55.quaternion.copy(endpoint_tabby_muzzle_r_55.quaternion);
  }
  mesh_tabby_muzzle_r_55.castShadow = options.castShadow ?? true;
  mesh_tabby_muzzle_r_55.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_muzzle_r_55.userData.sculptComponent = {"id": "tabby-muzzle-r", "name": "Tabby cat r white muzzle pad", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.96, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r white muzzle pad is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.23, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.29, "height": 0.23, "depth": 0.21, "units": "world", "confidence": 0.96}, "transform": {"position": [0.97, 2.53, 0.82], "rotation": [0.0, 0.0, 0.0], "scale": [0.29, 0.23, 0.21]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_muzzle_r_55.add(mesh_tabby_muzzle_r_55);
  meshes["tabby-muzzle-r"] = mesh_tabby_muzzle_r_55;
  colliders["tabby-muzzle-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_muzzle_r_55);

  const attachment_tabby_whiskers_r_56 = {"parentId": "tabby-muzzle-r", "parentSocket": "tabby-muzzle-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.38, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_whiskers_r_56 = makeAttachmentEndpoint(attachment_tabby_whiskers_r_56);
  const node_tabby_whiskers_r_56 = new THREE.Group();
  node_tabby_whiskers_r_56.name = "Tabby cat r whisker fan__pivot";
  if (endpoint_tabby_whiskers_r_56) {
    node_tabby_whiskers_r_56.position.copy(endpoint_tabby_whiskers_r_56.start);
    node_tabby_whiskers_r_56.rotation.set(0, 0, 0);
    node_tabby_whiskers_r_56.scale.set(1, 1, 1);
  } else {
    node_tabby_whiskers_r_56.position.set(1.09, 2.55, 0.95);
    node_tabby_whiskers_r_56.rotation.set(0.0, 0.0, 0.0);
    node_tabby_whiskers_r_56.scale.set(0.78, 0.38, 0.05);
  }
  node_tabby_whiskers_r_56.userData.sculptComponent = {"id": "tabby-whiskers-r", "name": "Tabby cat r whisker fan", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.96, "primitive": "instanced-cluster", "topologyClass": "fiber-strand", "topologyRationale": "Tabby cat r whisker fan is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-muzzle-r", "attachment": {"parentId": "tabby-muzzle-r", "parentSocket": "tabby-muzzle-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.38, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.78, "height": 0.38, "depth": 0.05, "units": "world", "confidence": 0.96}, "transform": {"position": [1.09, 2.55, 0.95], "rotation": [0.0, 0.0, 0.0], "scale": [0.78, 0.38, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "whisker"}}, "material": "whisker", "materialLayers": ["whisker"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 223, 206, 1.0)", "secondaryAlbedo": "rgba(246, 233, 214, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-whisker-fan"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_whiskers_r_56.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "whisker"}};
  (nodes["tabby-muzzle-r"] ?? root).add(node_tabby_whiskers_r_56);
  nodes["tabby-whiskers-r"] = node_tabby_whiskers_r_56;
  const mesh_tabby_whiskers_r_56Geometry = endpoint_tabby_whiskers_r_56
    ? new THREE.CylinderGeometry(endpoint_tabby_whiskers_r_56.endRadius, endpoint_tabby_whiskers_r_56.baseRadius, endpoint_tabby_whiskers_r_56.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tabby_whiskers_r_56 = new THREE.Mesh(
    mesh_tabby_whiskers_r_56Geometry,
    materialMap["whisker"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_whiskers_r_56.name = "Tabby cat r whisker fan";
  if (endpoint_tabby_whiskers_r_56) {
    mesh_tabby_whiskers_r_56.position.copy(endpoint_tabby_whiskers_r_56.midpoint);
    mesh_tabby_whiskers_r_56.quaternion.copy(endpoint_tabby_whiskers_r_56.quaternion);
  }
  mesh_tabby_whiskers_r_56.castShadow = options.castShadow ?? true;
  mesh_tabby_whiskers_r_56.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_whiskers_r_56.userData.sculptComponent = {"id": "tabby-whiskers-r", "name": "Tabby cat r whisker fan", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.96, "primitive": "instanced-cluster", "topologyClass": "fiber-strand", "topologyRationale": "Tabby cat r whisker fan is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-muzzle-r", "attachment": {"parentId": "tabby-muzzle-r", "parentSocket": "tabby-muzzle-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.38, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.78, "height": 0.38, "depth": 0.05, "units": "world", "confidence": 0.96}, "transform": {"position": [1.09, 2.55, 0.95], "rotation": [0.0, 0.0, 0.0], "scale": [0.78, 0.38, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "whisker"}}, "material": "whisker", "materialLayers": ["whisker"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(234, 223, 206, 1.0)", "secondaryAlbedo": "rgba(246, 233, 214, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-whisker-fan"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_whiskers_r_56.add(mesh_tabby_whiskers_r_56);
  meshes["tabby-whiskers-r"] = mesh_tabby_whiskers_r_56;
  colliders["tabby-whiskers-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_whiskers_r_56);

  const attachment_tabby_nose_57 = {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.15, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_nose_57 = makeAttachmentEndpoint(attachment_tabby_nose_57);
  const node_tabby_nose_57 = new THREE.Group();
  node_tabby_nose_57.name = "Tabby cat triangular nose__pivot";
  if (endpoint_tabby_nose_57) {
    node_tabby_nose_57.position.copy(endpoint_tabby_nose_57.start);
    node_tabby_nose_57.rotation.set(0, 0, 0);
    node_tabby_nose_57.scale.set(1, 1, 1);
  } else {
    node_tabby_nose_57.position.set(0.78, 2.61, 1.0);
    node_tabby_nose_57.rotation.set(0.0, 0.0, 0.0);
    node_tabby_nose_57.scale.set(0.18, 0.15, 0.1);
  }
  node_tabby_nose_57.userData.sculptComponent = {"id": "tabby-nose", "name": "Tabby cat triangular nose", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.96, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Tabby cat triangular nose is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.15, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.18, "height": 0.15, "depth": 0.1, "units": "world", "confidence": 0.96}, "transform": {"position": [0.78, 2.61, 1.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.18, 0.15, 0.1]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-nose"}}, "material": "tabby-nose", "materialLayers": ["tabby-nose"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(196, 120, 95, 1.0)", "secondaryAlbedo": "rgba(208, 130, 103, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_nose_57.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-nose"}};
  (nodes["tabby-head"] ?? root).add(node_tabby_nose_57);
  nodes["tabby-nose"] = node_tabby_nose_57;
  const mesh_tabby_nose_57Geometry = endpoint_tabby_nose_57
    ? new THREE.CylinderGeometry(endpoint_tabby_nose_57.endRadius, endpoint_tabby_nose_57.baseRadius, endpoint_tabby_nose_57.length, 32, 12)
    : new THREE.ConeGeometry(0.5, 1, 48, 16);
  const mesh_tabby_nose_57 = new THREE.Mesh(
    mesh_tabby_nose_57Geometry,
    materialMap["tabby-nose"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_nose_57.name = "Tabby cat triangular nose";
  if (endpoint_tabby_nose_57) {
    mesh_tabby_nose_57.position.copy(endpoint_tabby_nose_57.midpoint);
    mesh_tabby_nose_57.quaternion.copy(endpoint_tabby_nose_57.quaternion);
  }
  mesh_tabby_nose_57.castShadow = options.castShadow ?? true;
  mesh_tabby_nose_57.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_nose_57.userData.sculptComponent = {"id": "tabby-nose", "name": "Tabby cat triangular nose", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.96, "primitive": "cone", "topologyClass": "assembled-solid", "topologyRationale": "Tabby cat triangular nose is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.15, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.18, "height": 0.15, "depth": 0.1, "units": "world", "confidence": 0.96}, "transform": {"position": [0.78, 2.61, 1.0], "rotation": [0.0, 0.0, 0.0], "scale": [0.18, 0.15, 0.1]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-nose"}}, "material": "tabby-nose", "materialLayers": ["tabby-nose"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(196, 120, 95, 1.0)", "secondaryAlbedo": "rgba(208, 130, 103, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_nose_57.add(mesh_tabby_nose_57);
  meshes["tabby-nose"] = mesh_tabby_nose_57;
  colliders["tabby-nose"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_nose_57);

  const attachment_tabby_chin_58 = {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.16, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_chin_58 = makeAttachmentEndpoint(attachment_tabby_chin_58);
  const node_tabby_chin_58 = new THREE.Group();
  node_tabby_chin_58.name = "Tabby cat white chin__pivot";
  if (endpoint_tabby_chin_58) {
    node_tabby_chin_58.position.copy(endpoint_tabby_chin_58.start);
    node_tabby_chin_58.rotation.set(0, 0, 0);
    node_tabby_chin_58.scale.set(1, 1, 1);
  } else {
    node_tabby_chin_58.position.set(0.78, 2.4, 0.79);
    node_tabby_chin_58.rotation.set(0.0, 0.0, 0.0);
    node_tabby_chin_58.scale.set(0.3, 0.16, 0.17);
  }
  node_tabby_chin_58.userData.sculptComponent = {"id": "tabby-chin", "name": "Tabby cat white chin", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.9, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat white chin is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.16, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.3, "height": 0.16, "depth": 0.17, "units": "world", "confidence": 0.9}, "transform": {"position": [0.78, 2.4, 0.79], "rotation": [0.0, 0.0, 0.0], "scale": [0.3, 0.16, 0.17]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_chin_58.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}};
  (nodes["tabby-head"] ?? root).add(node_tabby_chin_58);
  nodes["tabby-chin"] = node_tabby_chin_58;
  const mesh_tabby_chin_58Geometry = endpoint_tabby_chin_58
    ? new THREE.CylinderGeometry(endpoint_tabby_chin_58.endRadius, endpoint_tabby_chin_58.baseRadius, endpoint_tabby_chin_58.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_chin_58 = new THREE.Mesh(
    mesh_tabby_chin_58Geometry,
    materialMap["white-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_chin_58.name = "Tabby cat white chin";
  if (endpoint_tabby_chin_58) {
    mesh_tabby_chin_58.position.copy(endpoint_tabby_chin_58.midpoint);
    mesh_tabby_chin_58.quaternion.copy(endpoint_tabby_chin_58.quaternion);
  }
  mesh_tabby_chin_58.castShadow = options.castShadow ?? true;
  mesh_tabby_chin_58.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_chin_58.userData.sculptComponent = {"id": "tabby-chin", "name": "Tabby cat white chin", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.9, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat white chin is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.16, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.3, "height": 0.16, "depth": 0.17, "units": "world", "confidence": 0.9}, "transform": {"position": [0.78, 2.4, 0.79], "rotation": [0.0, 0.0, 0.0], "scale": [0.3, 0.16, 0.17]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_chin_58.add(mesh_tabby_chin_58);
  meshes["tabby-chin"] = mesh_tabby_chin_58;
  colliders["tabby-chin"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_chin_58);

  const attachment_tabby_front_leg_l_59 = {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.0, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_front_leg_l_59 = makeAttachmentEndpoint(attachment_tabby_front_leg_l_59);
  const node_tabby_front_leg_l_59 = new THREE.Group();
  node_tabby_front_leg_l_59.name = "Tabby cat l front leg__pivot";
  if (endpoint_tabby_front_leg_l_59) {
    node_tabby_front_leg_l_59.position.copy(endpoint_tabby_front_leg_l_59.start);
    node_tabby_front_leg_l_59.rotation.set(0, 0, 0);
    node_tabby_front_leg_l_59.scale.set(1, 1, 1);
  } else {
    node_tabby_front_leg_l_59.position.set(0.39999999999999997, 0.72, 0.34);
    node_tabby_front_leg_l_59.rotation.set(0.0, 0.0, 0.0);
    node_tabby_front_leg_l_59.scale.set(0.31, 1.0, 0.33);
  }
  node_tabby_front_leg_l_59.userData.sculptComponent = {"id": "tabby-front-leg-l", "name": "Tabby cat l front leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.95, "primitive": "capsule", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l front leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-torso", "attachment": {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.0, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.31, "height": 1.0, "depth": 0.33, "units": "world", "confidence": 0.95}, "transform": {"position": [0.39999999999999997, 0.72, 0.34], "rotation": [0.0, 0.0, 0.0], "scale": [0.31, 1.0, 0.33]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-leg-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_front_leg_l_59.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-torso"] ?? root).add(node_tabby_front_leg_l_59);
  nodes["tabby-front-leg-l"] = node_tabby_front_leg_l_59;
  const mesh_tabby_front_leg_l_59Geometry = endpoint_tabby_front_leg_l_59
    ? new THREE.CylinderGeometry(endpoint_tabby_front_leg_l_59.endRadius, endpoint_tabby_front_leg_l_59.baseRadius, endpoint_tabby_front_leg_l_59.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_tabby_front_leg_l_59 = new THREE.Mesh(
    mesh_tabby_front_leg_l_59Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_front_leg_l_59.name = "Tabby cat l front leg";
  if (endpoint_tabby_front_leg_l_59) {
    mesh_tabby_front_leg_l_59.position.copy(endpoint_tabby_front_leg_l_59.midpoint);
    mesh_tabby_front_leg_l_59.quaternion.copy(endpoint_tabby_front_leg_l_59.quaternion);
  }
  mesh_tabby_front_leg_l_59.castShadow = options.castShadow ?? true;
  mesh_tabby_front_leg_l_59.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_front_leg_l_59.userData.sculptComponent = {"id": "tabby-front-leg-l", "name": "Tabby cat l front leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.95, "primitive": "capsule", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l front leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-torso", "attachment": {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.0, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.31, "height": 1.0, "depth": 0.33, "units": "world", "confidence": 0.95}, "transform": {"position": [0.39999999999999997, 0.72, 0.34], "rotation": [0.0, 0.0, 0.0], "scale": [0.31, 1.0, 0.33]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-leg-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_front_leg_l_59.add(mesh_tabby_front_leg_l_59);
  meshes["tabby-front-leg-l"] = mesh_tabby_front_leg_l_59;
  colliders["tabby-front-leg-l"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_front_leg_l_59);

  const attachment_tabby_front_paw_l_60 = {"parentId": "tabby-front-leg-l", "parentSocket": "tabby-front-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.25, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-paws"]};
  const endpoint_tabby_front_paw_l_60 = makeAttachmentEndpoint(attachment_tabby_front_paw_l_60);
  const node_tabby_front_paw_l_60 = new THREE.Group();
  node_tabby_front_paw_l_60.name = "Tabby cat l white front paw__pivot";
  if (endpoint_tabby_front_paw_l_60) {
    node_tabby_front_paw_l_60.position.copy(endpoint_tabby_front_paw_l_60.start);
    node_tabby_front_paw_l_60.rotation.set(0, 0, 0);
    node_tabby_front_paw_l_60.scale.set(1, 1, 1);
  } else {
    node_tabby_front_paw_l_60.position.set(0.39999999999999997, 0.17, 0.54);
    node_tabby_front_paw_l_60.rotation.set(0.0, 0.0, 0.0);
    node_tabby_front_paw_l_60.scale.set(0.4, 0.25, 0.52);
  }
  node_tabby_front_paw_l_60.userData.sculptComponent = {"id": "tabby-front-paw-l", "name": "Tabby cat l white front paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.97, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l white front paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-front-leg-l", "attachment": {"parentId": "tabby-front-leg-l", "parentSocket": "tabby-front-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.25, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-paws"]}, "dimensions": {"width": 0.4, "height": 0.25, "depth": 0.52, "units": "world", "confidence": 0.97}, "transform": {"position": [0.39999999999999997, 0.17, 0.54], "rotation": [0.0, 0.0, 0.0], "scale": [0.4, 0.25, 0.52]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-white-paws", "tabby-paw-toe-grooves"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-paws"]};
  node_tabby_front_paw_l_60.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}};
  (nodes["tabby-front-leg-l"] ?? root).add(node_tabby_front_paw_l_60);
  nodes["tabby-front-paw-l"] = node_tabby_front_paw_l_60;
  const mesh_tabby_front_paw_l_60Geometry = endpoint_tabby_front_paw_l_60
    ? new THREE.CylinderGeometry(endpoint_tabby_front_paw_l_60.endRadius, endpoint_tabby_front_paw_l_60.baseRadius, endpoint_tabby_front_paw_l_60.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_front_paw_l_60 = new THREE.Mesh(
    mesh_tabby_front_paw_l_60Geometry,
    materialMap["white-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_front_paw_l_60.name = "Tabby cat l white front paw";
  if (endpoint_tabby_front_paw_l_60) {
    mesh_tabby_front_paw_l_60.position.copy(endpoint_tabby_front_paw_l_60.midpoint);
    mesh_tabby_front_paw_l_60.quaternion.copy(endpoint_tabby_front_paw_l_60.quaternion);
  }
  mesh_tabby_front_paw_l_60.castShadow = options.castShadow ?? true;
  mesh_tabby_front_paw_l_60.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_front_paw_l_60.userData.sculptComponent = {"id": "tabby-front-paw-l", "name": "Tabby cat l white front paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.97, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l white front paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-front-leg-l", "attachment": {"parentId": "tabby-front-leg-l", "parentSocket": "tabby-front-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.25, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-paws"]}, "dimensions": {"width": 0.4, "height": 0.25, "depth": 0.52, "units": "world", "confidence": 0.97}, "transform": {"position": [0.39999999999999997, 0.17, 0.54], "rotation": [0.0, 0.0, 0.0], "scale": [0.4, 0.25, 0.52]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-white-paws", "tabby-paw-toe-grooves"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-paws"]};
  node_tabby_front_paw_l_60.add(mesh_tabby_front_paw_l_60);
  meshes["tabby-front-paw-l"] = mesh_tabby_front_paw_l_60;
  colliders["tabby-front-paw-l"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_front_paw_l_60);

  const attachment_tabby_hind_leg_l_61 = {"parentId": "tabby-rump", "parentSocket": "tabby-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.86, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_hind_leg_l_61 = makeAttachmentEndpoint(attachment_tabby_hind_leg_l_61);
  const node_tabby_hind_leg_l_61 = new THREE.Group();
  node_tabby_hind_leg_l_61.name = "Tabby cat l hind leg__pivot";
  if (endpoint_tabby_hind_leg_l_61) {
    node_tabby_hind_leg_l_61.position.copy(endpoint_tabby_hind_leg_l_61.start);
    node_tabby_hind_leg_l_61.rotation.set(0, 0, 0);
    node_tabby_hind_leg_l_61.scale.set(1, 1, 1);
  } else {
    node_tabby_hind_leg_l_61.position.set(0.33, 0.74, -0.1);
    node_tabby_hind_leg_l_61.rotation.set(0.0, 0.0, 0.0);
    node_tabby_hind_leg_l_61.scale.set(0.38, 0.86, 0.42);
  }
  node_tabby_hind_leg_l_61.userData.sculptComponent = {"id": "tabby-hind-leg-l", "name": "Tabby cat l hind leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.55, "primitive": "capsule", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l hind leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-rump", "attachment": {"parentId": "tabby-rump", "parentSocket": "tabby-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.86, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.38, "height": 0.86, "depth": 0.42, "units": "world", "confidence": 0.55}, "transform": {"position": [0.33, 0.74, -0.1], "rotation": [0.0, 0.0, 0.0], "scale": [0.38, 0.86, 0.42]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_hind_leg_l_61.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-rump"] ?? root).add(node_tabby_hind_leg_l_61);
  nodes["tabby-hind-leg-l"] = node_tabby_hind_leg_l_61;
  const mesh_tabby_hind_leg_l_61Geometry = endpoint_tabby_hind_leg_l_61
    ? new THREE.CylinderGeometry(endpoint_tabby_hind_leg_l_61.endRadius, endpoint_tabby_hind_leg_l_61.baseRadius, endpoint_tabby_hind_leg_l_61.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_tabby_hind_leg_l_61 = new THREE.Mesh(
    mesh_tabby_hind_leg_l_61Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_hind_leg_l_61.name = "Tabby cat l hind leg";
  if (endpoint_tabby_hind_leg_l_61) {
    mesh_tabby_hind_leg_l_61.position.copy(endpoint_tabby_hind_leg_l_61.midpoint);
    mesh_tabby_hind_leg_l_61.quaternion.copy(endpoint_tabby_hind_leg_l_61.quaternion);
  }
  mesh_tabby_hind_leg_l_61.castShadow = options.castShadow ?? true;
  mesh_tabby_hind_leg_l_61.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_hind_leg_l_61.userData.sculptComponent = {"id": "tabby-hind-leg-l", "name": "Tabby cat l hind leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.55, "primitive": "capsule", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l hind leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-rump", "attachment": {"parentId": "tabby-rump", "parentSocket": "tabby-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.86, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.38, "height": 0.86, "depth": 0.42, "units": "world", "confidence": 0.55}, "transform": {"position": [0.33, 0.74, -0.1], "rotation": [0.0, 0.0, 0.0], "scale": [0.38, 0.86, 0.42]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_hind_leg_l_61.add(mesh_tabby_hind_leg_l_61);
  meshes["tabby-hind-leg-l"] = mesh_tabby_hind_leg_l_61;
  colliders["tabby-hind-leg-l"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_hind_leg_l_61);

  const attachment_tabby_hind_paw_l_62 = {"parentId": "tabby-hind-leg-l", "parentSocket": "tabby-hind-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-paws"]};
  const endpoint_tabby_hind_paw_l_62 = makeAttachmentEndpoint(attachment_tabby_hind_paw_l_62);
  const node_tabby_hind_paw_l_62 = new THREE.Group();
  node_tabby_hind_paw_l_62.name = "Tabby cat l white hind paw__pivot";
  if (endpoint_tabby_hind_paw_l_62) {
    node_tabby_hind_paw_l_62.position.copy(endpoint_tabby_hind_paw_l_62.start);
    node_tabby_hind_paw_l_62.rotation.set(0, 0, 0);
    node_tabby_hind_paw_l_62.scale.set(1, 1, 1);
  } else {
    node_tabby_hind_paw_l_62.position.set(0.33, 0.18, 0.16);
    node_tabby_hind_paw_l_62.rotation.set(0.0, 0.0, 0.0);
    node_tabby_hind_paw_l_62.scale.set(0.42, 0.24, 0.52);
  }
  node_tabby_hind_paw_l_62.userData.sculptComponent = {"id": "tabby-hind-paw-l", "name": "Tabby cat l white hind paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.62, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l white hind paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-hind-leg-l", "attachment": {"parentId": "tabby-hind-leg-l", "parentSocket": "tabby-hind-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-paws"]}, "dimensions": {"width": 0.42, "height": 0.24, "depth": 0.52, "units": "world", "confidence": 0.62}, "transform": {"position": [0.33, 0.18, 0.16], "rotation": [0.0, 0.0, 0.0], "scale": [0.42, 0.24, 0.52]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-paws"]};
  node_tabby_hind_paw_l_62.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}};
  (nodes["tabby-hind-leg-l"] ?? root).add(node_tabby_hind_paw_l_62);
  nodes["tabby-hind-paw-l"] = node_tabby_hind_paw_l_62;
  const mesh_tabby_hind_paw_l_62Geometry = endpoint_tabby_hind_paw_l_62
    ? new THREE.CylinderGeometry(endpoint_tabby_hind_paw_l_62.endRadius, endpoint_tabby_hind_paw_l_62.baseRadius, endpoint_tabby_hind_paw_l_62.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_hind_paw_l_62 = new THREE.Mesh(
    mesh_tabby_hind_paw_l_62Geometry,
    materialMap["white-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_hind_paw_l_62.name = "Tabby cat l white hind paw";
  if (endpoint_tabby_hind_paw_l_62) {
    mesh_tabby_hind_paw_l_62.position.copy(endpoint_tabby_hind_paw_l_62.midpoint);
    mesh_tabby_hind_paw_l_62.quaternion.copy(endpoint_tabby_hind_paw_l_62.quaternion);
  }
  mesh_tabby_hind_paw_l_62.castShadow = options.castShadow ?? true;
  mesh_tabby_hind_paw_l_62.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_hind_paw_l_62.userData.sculptComponent = {"id": "tabby-hind-paw-l", "name": "Tabby cat l white hind paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.62, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat l white hind paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-hind-leg-l", "attachment": {"parentId": "tabby-hind-leg-l", "parentSocket": "tabby-hind-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-paws"]}, "dimensions": {"width": 0.42, "height": 0.24, "depth": 0.52, "units": "world", "confidence": 0.62}, "transform": {"position": [0.33, 0.18, 0.16], "rotation": [0.0, 0.0, 0.0], "scale": [0.42, 0.24, 0.52]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-paws"]};
  node_tabby_hind_paw_l_62.add(mesh_tabby_hind_paw_l_62);
  meshes["tabby-hind-paw-l"] = mesh_tabby_hind_paw_l_62;
  colliders["tabby-hind-paw-l"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_hind_paw_l_62);

  const attachment_tabby_front_leg_r_63 = {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.0, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_front_leg_r_63 = makeAttachmentEndpoint(attachment_tabby_front_leg_r_63);
  const node_tabby_front_leg_r_63 = new THREE.Group();
  node_tabby_front_leg_r_63.name = "Tabby cat r front leg__pivot";
  if (endpoint_tabby_front_leg_r_63) {
    node_tabby_front_leg_r_63.position.copy(endpoint_tabby_front_leg_r_63.start);
    node_tabby_front_leg_r_63.rotation.set(0, 0, 0);
    node_tabby_front_leg_r_63.scale.set(1, 1, 1);
  } else {
    node_tabby_front_leg_r_63.position.set(1.0, 0.72, 0.34);
    node_tabby_front_leg_r_63.rotation.set(0.0, 0.0, 0.0);
    node_tabby_front_leg_r_63.scale.set(0.31, 1.0, 0.33);
  }
  node_tabby_front_leg_r_63.userData.sculptComponent = {"id": "tabby-front-leg-r", "name": "Tabby cat r front leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.95, "primitive": "capsule", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r front leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-torso", "attachment": {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.0, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.31, "height": 1.0, "depth": 0.33, "units": "world", "confidence": 0.95}, "transform": {"position": [1.0, 0.72, 0.34], "rotation": [0.0, 0.0, 0.0], "scale": [0.31, 1.0, 0.33]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_front_leg_r_63.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-torso"] ?? root).add(node_tabby_front_leg_r_63);
  nodes["tabby-front-leg-r"] = node_tabby_front_leg_r_63;
  const mesh_tabby_front_leg_r_63Geometry = endpoint_tabby_front_leg_r_63
    ? new THREE.CylinderGeometry(endpoint_tabby_front_leg_r_63.endRadius, endpoint_tabby_front_leg_r_63.baseRadius, endpoint_tabby_front_leg_r_63.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_tabby_front_leg_r_63 = new THREE.Mesh(
    mesh_tabby_front_leg_r_63Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_front_leg_r_63.name = "Tabby cat r front leg";
  if (endpoint_tabby_front_leg_r_63) {
    mesh_tabby_front_leg_r_63.position.copy(endpoint_tabby_front_leg_r_63.midpoint);
    mesh_tabby_front_leg_r_63.quaternion.copy(endpoint_tabby_front_leg_r_63.quaternion);
  }
  mesh_tabby_front_leg_r_63.castShadow = options.castShadow ?? true;
  mesh_tabby_front_leg_r_63.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_front_leg_r_63.userData.sculptComponent = {"id": "tabby-front-leg-r", "name": "Tabby cat r front leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.95, "primitive": "capsule", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r front leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-torso", "attachment": {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.0, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.31, "height": 1.0, "depth": 0.33, "units": "world", "confidence": 0.95}, "transform": {"position": [1.0, 0.72, 0.34], "rotation": [0.0, 0.0, 0.0], "scale": [0.31, 1.0, 0.33]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_front_leg_r_63.add(mesh_tabby_front_leg_r_63);
  meshes["tabby-front-leg-r"] = mesh_tabby_front_leg_r_63;
  colliders["tabby-front-leg-r"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_front_leg_r_63);

  const attachment_tabby_front_paw_r_64 = {"parentId": "tabby-front-leg-r", "parentSocket": "tabby-front-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.25, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-paws"]};
  const endpoint_tabby_front_paw_r_64 = makeAttachmentEndpoint(attachment_tabby_front_paw_r_64);
  const node_tabby_front_paw_r_64 = new THREE.Group();
  node_tabby_front_paw_r_64.name = "Tabby cat r white front paw__pivot";
  if (endpoint_tabby_front_paw_r_64) {
    node_tabby_front_paw_r_64.position.copy(endpoint_tabby_front_paw_r_64.start);
    node_tabby_front_paw_r_64.rotation.set(0, 0, 0);
    node_tabby_front_paw_r_64.scale.set(1, 1, 1);
  } else {
    node_tabby_front_paw_r_64.position.set(1.0, 0.17, 0.54);
    node_tabby_front_paw_r_64.rotation.set(0.0, 0.0, 0.0);
    node_tabby_front_paw_r_64.scale.set(0.4, 0.25, 0.52);
  }
  node_tabby_front_paw_r_64.userData.sculptComponent = {"id": "tabby-front-paw-r", "name": "Tabby cat r white front paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.97, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r white front paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-front-leg-r", "attachment": {"parentId": "tabby-front-leg-r", "parentSocket": "tabby-front-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.25, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-paws"]}, "dimensions": {"width": 0.4, "height": 0.25, "depth": 0.52, "units": "world", "confidence": 0.97}, "transform": {"position": [1.0, 0.17, 0.54], "rotation": [0.0, 0.0, 0.0], "scale": [0.4, 0.25, 0.52]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-paws"]};
  node_tabby_front_paw_r_64.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}};
  (nodes["tabby-front-leg-r"] ?? root).add(node_tabby_front_paw_r_64);
  nodes["tabby-front-paw-r"] = node_tabby_front_paw_r_64;
  const mesh_tabby_front_paw_r_64Geometry = endpoint_tabby_front_paw_r_64
    ? new THREE.CylinderGeometry(endpoint_tabby_front_paw_r_64.endRadius, endpoint_tabby_front_paw_r_64.baseRadius, endpoint_tabby_front_paw_r_64.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_front_paw_r_64 = new THREE.Mesh(
    mesh_tabby_front_paw_r_64Geometry,
    materialMap["white-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_front_paw_r_64.name = "Tabby cat r white front paw";
  if (endpoint_tabby_front_paw_r_64) {
    mesh_tabby_front_paw_r_64.position.copy(endpoint_tabby_front_paw_r_64.midpoint);
    mesh_tabby_front_paw_r_64.quaternion.copy(endpoint_tabby_front_paw_r_64.quaternion);
  }
  mesh_tabby_front_paw_r_64.castShadow = options.castShadow ?? true;
  mesh_tabby_front_paw_r_64.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_front_paw_r_64.userData.sculptComponent = {"id": "tabby-front-paw-r", "name": "Tabby cat r white front paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.97, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r white front paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-front-leg-r", "attachment": {"parentId": "tabby-front-leg-r", "parentSocket": "tabby-front-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.25, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-paws"]}, "dimensions": {"width": 0.4, "height": 0.25, "depth": 0.52, "units": "world", "confidence": 0.97}, "transform": {"position": [1.0, 0.17, 0.54], "rotation": [0.0, 0.0, 0.0], "scale": [0.4, 0.25, 0.52]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-paws"]};
  node_tabby_front_paw_r_64.add(mesh_tabby_front_paw_r_64);
  meshes["tabby-front-paw-r"] = mesh_tabby_front_paw_r_64;
  colliders["tabby-front-paw-r"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_front_paw_r_64);

  const attachment_tabby_hind_leg_r_65 = {"parentId": "tabby-rump", "parentSocket": "tabby-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.86, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_hind_leg_r_65 = makeAttachmentEndpoint(attachment_tabby_hind_leg_r_65);
  const node_tabby_hind_leg_r_65 = new THREE.Group();
  node_tabby_hind_leg_r_65.name = "Tabby cat r hind leg__pivot";
  if (endpoint_tabby_hind_leg_r_65) {
    node_tabby_hind_leg_r_65.position.copy(endpoint_tabby_hind_leg_r_65.start);
    node_tabby_hind_leg_r_65.rotation.set(0, 0, 0);
    node_tabby_hind_leg_r_65.scale.set(1, 1, 1);
  } else {
    node_tabby_hind_leg_r_65.position.set(1.19, 0.74, -0.1);
    node_tabby_hind_leg_r_65.rotation.set(0.0, 0.0, 0.0);
    node_tabby_hind_leg_r_65.scale.set(0.38, 0.86, 0.42);
  }
  node_tabby_hind_leg_r_65.userData.sculptComponent = {"id": "tabby-hind-leg-r", "name": "Tabby cat r hind leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.55, "primitive": "capsule", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r hind leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-rump", "attachment": {"parentId": "tabby-rump", "parentSocket": "tabby-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.86, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.38, "height": 0.86, "depth": 0.42, "units": "world", "confidence": 0.55}, "transform": {"position": [1.19, 0.74, -0.1], "rotation": [0.0, 0.0, 0.0], "scale": [0.38, 0.86, 0.42]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_hind_leg_r_65.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-rump"] ?? root).add(node_tabby_hind_leg_r_65);
  nodes["tabby-hind-leg-r"] = node_tabby_hind_leg_r_65;
  const mesh_tabby_hind_leg_r_65Geometry = endpoint_tabby_hind_leg_r_65
    ? new THREE.CylinderGeometry(endpoint_tabby_hind_leg_r_65.endRadius, endpoint_tabby_hind_leg_r_65.baseRadius, endpoint_tabby_hind_leg_r_65.length, 32, 12)
    : new THREE.CapsuleGeometry(0.35, 0.7, 16, 32);
  const mesh_tabby_hind_leg_r_65 = new THREE.Mesh(
    mesh_tabby_hind_leg_r_65Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_hind_leg_r_65.name = "Tabby cat r hind leg";
  if (endpoint_tabby_hind_leg_r_65) {
    mesh_tabby_hind_leg_r_65.position.copy(endpoint_tabby_hind_leg_r_65.midpoint);
    mesh_tabby_hind_leg_r_65.quaternion.copy(endpoint_tabby_hind_leg_r_65.quaternion);
  }
  mesh_tabby_hind_leg_r_65.castShadow = options.castShadow ?? true;
  mesh_tabby_hind_leg_r_65.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_hind_leg_r_65.userData.sculptComponent = {"id": "tabby-hind-leg-r", "name": "Tabby cat r hind leg", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.55, "primitive": "capsule", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r hind leg is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-rump", "attachment": {"parentId": "tabby-rump", "parentSocket": "tabby-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.86, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.38, "height": 0.86, "depth": 0.42, "units": "world", "confidence": 0.55}, "transform": {"position": [1.19, 0.74, -0.1], "rotation": [0.0, 0.0, 0.0], "scale": [0.38, 0.86, 0.42]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_hind_leg_r_65.add(mesh_tabby_hind_leg_r_65);
  meshes["tabby-hind-leg-r"] = mesh_tabby_hind_leg_r_65;
  colliders["tabby-hind-leg-r"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_hind_leg_r_65);

  const attachment_tabby_hind_paw_r_66 = {"parentId": "tabby-hind-leg-r", "parentSocket": "tabby-hind-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-paws"]};
  const endpoint_tabby_hind_paw_r_66 = makeAttachmentEndpoint(attachment_tabby_hind_paw_r_66);
  const node_tabby_hind_paw_r_66 = new THREE.Group();
  node_tabby_hind_paw_r_66.name = "Tabby cat r white hind paw__pivot";
  if (endpoint_tabby_hind_paw_r_66) {
    node_tabby_hind_paw_r_66.position.copy(endpoint_tabby_hind_paw_r_66.start);
    node_tabby_hind_paw_r_66.rotation.set(0, 0, 0);
    node_tabby_hind_paw_r_66.scale.set(1, 1, 1);
  } else {
    node_tabby_hind_paw_r_66.position.set(1.19, 0.18, 0.16);
    node_tabby_hind_paw_r_66.rotation.set(0.0, 0.0, 0.0);
    node_tabby_hind_paw_r_66.scale.set(0.42, 0.24, 0.52);
  }
  node_tabby_hind_paw_r_66.userData.sculptComponent = {"id": "tabby-hind-paw-r", "name": "Tabby cat r white hind paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.62, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r white hind paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-hind-leg-r", "attachment": {"parentId": "tabby-hind-leg-r", "parentSocket": "tabby-hind-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-paws"]}, "dimensions": {"width": 0.42, "height": 0.24, "depth": 0.52, "units": "world", "confidence": 0.62}, "transform": {"position": [1.19, 0.18, 0.16], "rotation": [0.0, 0.0, 0.0], "scale": [0.42, 0.24, 0.52]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-paws"]};
  node_tabby_hind_paw_r_66.userData.actionProfile = {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}};
  (nodes["tabby-hind-leg-r"] ?? root).add(node_tabby_hind_paw_r_66);
  nodes["tabby-hind-paw-r"] = node_tabby_hind_paw_r_66;
  const mesh_tabby_hind_paw_r_66Geometry = endpoint_tabby_hind_paw_r_66
    ? new THREE.CylinderGeometry(endpoint_tabby_hind_paw_r_66.endRadius, endpoint_tabby_hind_paw_r_66.baseRadius, endpoint_tabby_hind_paw_r_66.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_hind_paw_r_66 = new THREE.Mesh(
    mesh_tabby_hind_paw_r_66Geometry,
    materialMap["white-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_hind_paw_r_66.name = "Tabby cat r white hind paw";
  if (endpoint_tabby_hind_paw_r_66) {
    mesh_tabby_hind_paw_r_66.position.copy(endpoint_tabby_hind_paw_r_66.midpoint);
    mesh_tabby_hind_paw_r_66.quaternion.copy(endpoint_tabby_hind_paw_r_66.quaternion);
  }
  mesh_tabby_hind_paw_r_66.castShadow = options.castShadow ?? true;
  mesh_tabby_hind_paw_r_66.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_hind_paw_r_66.userData.sculptComponent = {"id": "tabby-hind-paw-r", "name": "Tabby cat r white hind paw", "level": "meso", "role": "limb", "importance": 0.8, "confidence": 0.62, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat r white hind paw is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-paws.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-hind-leg-r", "attachment": {"parentId": "tabby-hind-leg-r", "parentSocket": "tabby-hind-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.24, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-paws"]}, "dimensions": {"width": 0.42, "height": 0.24, "depth": 0.52, "units": "world", "confidence": 0.62}, "transform": {"position": [1.19, 0.18, 0.16], "rotation": [0.0, 0.0, 0.0], "scale": [0.42, 0.24, 0.52]}, "actionProfile": {"animationRole": "limb", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "white-fur"}}, "material": "white-fur", "materialLayers": ["white-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(222, 201, 169, 1.0)", "secondaryAlbedo": "rgba(234, 211, 177, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-paws"]};
  node_tabby_hind_paw_r_66.add(mesh_tabby_hind_paw_r_66);
  meshes["tabby-hind-paw-r"] = mesh_tabby_hind_paw_r_66;
  colliders["tabby-hind-paw-r"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_hind_paw_r_66);

  const attachment_tabby_tail_67 = {"parentId": "tabby-rump", "parentSocket": "tabby-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.7, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["hidden-posterior"]};
  const endpoint_tabby_tail_67 = makeAttachmentEndpoint(attachment_tabby_tail_67);
  const node_tabby_tail_67 = new THREE.Group();
  node_tabby_tail_67.name = "Tabby cat inferred resting tail pivot__pivot";
  if (endpoint_tabby_tail_67) {
    node_tabby_tail_67.position.copy(endpoint_tabby_tail_67.start);
    node_tabby_tail_67.rotation.set(0, 0, 0);
    node_tabby_tail_67.scale.set(1, 1, 1);
  } else {
    node_tabby_tail_67.position.set(1.2, 0.7, -0.48);
    node_tabby_tail_67.rotation.set(0.0, 0.0, 0.0);
    node_tabby_tail_67.scale.set(0.27, 1.7, 0.27);
  }
  node_tabby_tail_67.userData.sculptComponent = {"id": "tabby-tail", "name": "Tabby cat inferred resting tail pivot", "level": "meso", "role": "tail", "importance": 0.8, "confidence": 0.3, "primitive": "curve-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat inferred resting tail pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in hidden-posterior.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-rump", "attachment": {"parentId": "tabby-rump", "parentSocket": "tabby-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.7, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["hidden-posterior"]}, "dimensions": {"width": 0.27, "height": 1.7, "depth": 0.27, "units": "world", "confidence": 0.3}, "transform": {"position": [1.2, 0.7, -0.48], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 1.7, 0.27]}, "actionProfile": {"animationRole": "tail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["inferred-striped-tail"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["hidden-posterior"]};
  node_tabby_tail_67.userData.actionProfile = {"animationRole": "tail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-rump"] ?? root).add(node_tabby_tail_67);
  nodes["tabby-tail"] = node_tabby_tail_67;
  const mesh_tabby_tail_67Geometry = endpoint_tabby_tail_67
    ? new THREE.CylinderGeometry(endpoint_tabby_tail_67.endRadius, endpoint_tabby_tail_67.baseRadius, endpoint_tabby_tail_67.length, 32, 12)
    : buildCurveSweepGeometry({"spine": [[-0.5, -0.4, 0.0], [-0.1, 0.1, 0.0], [0.3, 0.2, 0.0], [0.6, -0.1, 0.0]], "crossSection": {"points": [[-0.04, -0.02], [0.04, -0.02], [0.04, 0.02], [-0.04, 0.02]]}, "closed": false});
  const mesh_tabby_tail_67 = new THREE.Mesh(
    mesh_tabby_tail_67Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_tail_67.name = "Tabby cat inferred resting tail pivot";
  if (endpoint_tabby_tail_67) {
    mesh_tabby_tail_67.position.copy(endpoint_tabby_tail_67.midpoint);
    mesh_tabby_tail_67.quaternion.copy(endpoint_tabby_tail_67.quaternion);
  }
  mesh_tabby_tail_67.castShadow = options.castShadow ?? true;
  mesh_tabby_tail_67.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_tail_67.userData.sculptComponent = {"id": "tabby-tail", "name": "Tabby cat inferred resting tail pivot", "level": "meso", "role": "tail", "importance": 0.8, "confidence": 0.3, "primitive": "curve-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat inferred resting tail pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in hidden-posterior.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-rump", "attachment": {"parentId": "tabby-rump", "parentSocket": "tabby-rump-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.7, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["hidden-posterior"]}, "dimensions": {"width": 0.27, "height": 1.7, "depth": 0.27, "units": "world", "confidence": 0.3}, "transform": {"position": [1.2, 0.7, -0.48], "rotation": [0.0, 0.0, 0.0], "scale": [0.27, 1.7, 0.27]}, "actionProfile": {"animationRole": "tail", "pivot": {"mode": "root", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": true, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(160, 111, 67, 1.0)", "secondaryAlbedo": "rgba(172, 121, 75, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["inferred-striped-tail"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["hidden-posterior"]};
  node_tabby_tail_67.add(mesh_tabby_tail_67);
  meshes["tabby-tail"] = mesh_tabby_tail_67;
  colliders["tabby-tail"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_tail_67);

  const attachment_tabby_forehead_stripes_68 = {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.42, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_forehead_stripes_68 = makeAttachmentEndpoint(attachment_tabby_forehead_stripes_68);
  const node_tabby_forehead_stripes_68 = new THREE.Group();
  node_tabby_forehead_stripes_68.name = "Tabby forehead M stripe relief__pivot";
  if (endpoint_tabby_forehead_stripes_68) {
    node_tabby_forehead_stripes_68.position.copy(endpoint_tabby_forehead_stripes_68.start);
    node_tabby_forehead_stripes_68.rotation.set(0, 0, 0);
    node_tabby_forehead_stripes_68.scale.set(1, 1, 1);
  } else {
    node_tabby_forehead_stripes_68.position.set(0.78, 3.14, 0.95);
    node_tabby_forehead_stripes_68.rotation.set(0.0, 0.0, 0.0);
    node_tabby_forehead_stripes_68.scale.set(0.48, 0.42, 0.03);
  }
  node_tabby_forehead_stripes_68.userData.sculptComponent = {"id": "tabby-forehead-stripes", "name": "Tabby forehead M stripe relief", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.96, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "Tabby forehead M stripe relief is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.42, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.48, "height": 0.42, "depth": 0.03, "units": "world", "confidence": 0.96}, "transform": {"position": [0.78, 3.14, 0.95], "rotation": [0.0, 0.0, 0.0], "scale": [0.48, 0.42, 0.03]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}}, "material": "tabby-stripe", "materialLayers": ["tabby-stripe"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(47, 33, 24, 1.0)", "secondaryAlbedo": "rgba(59, 43, 32, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-forehead-m"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_forehead_stripes_68.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}};
  (nodes["tabby-head"] ?? root).add(node_tabby_forehead_stripes_68);
  nodes["tabby-forehead-stripes"] = node_tabby_forehead_stripes_68;
  const mesh_tabby_forehead_stripes_68Geometry = endpoint_tabby_forehead_stripes_68
    ? new THREE.CylinderGeometry(endpoint_tabby_forehead_stripes_68.endRadius, endpoint_tabby_forehead_stripes_68.baseRadius, endpoint_tabby_forehead_stripes_68.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  const mesh_tabby_forehead_stripes_68 = new THREE.Mesh(
    mesh_tabby_forehead_stripes_68Geometry,
    materialMap["tabby-stripe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_forehead_stripes_68.name = "Tabby forehead M stripe relief";
  if (endpoint_tabby_forehead_stripes_68) {
    mesh_tabby_forehead_stripes_68.position.copy(endpoint_tabby_forehead_stripes_68.midpoint);
    mesh_tabby_forehead_stripes_68.quaternion.copy(endpoint_tabby_forehead_stripes_68.quaternion);
  }
  mesh_tabby_forehead_stripes_68.castShadow = options.castShadow ?? true;
  mesh_tabby_forehead_stripes_68.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_forehead_stripes_68.userData.sculptComponent = {"id": "tabby-forehead-stripes", "name": "Tabby forehead M stripe relief", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.96, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "Tabby forehead M stripe relief is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.42, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.48, "height": 0.42, "depth": 0.03, "units": "world", "confidence": 0.96}, "transform": {"position": [0.78, 3.14, 0.95], "rotation": [0.0, 0.0, 0.0], "scale": [0.48, 0.42, 0.03]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}}, "material": "tabby-stripe", "materialLayers": ["tabby-stripe"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(47, 33, 24, 1.0)", "secondaryAlbedo": "rgba(59, 43, 32, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-forehead-m"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_forehead_stripes_68.add(mesh_tabby_forehead_stripes_68);
  meshes["tabby-forehead-stripes"] = mesh_tabby_forehead_stripes_68;
  colliders["tabby-forehead-stripes"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_forehead_stripes_68);

  const attachment_tabby_cheek_stripes_l_69 = {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.27, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_cheek_stripes_l_69 = makeAttachmentEndpoint(attachment_tabby_cheek_stripes_l_69);
  const node_tabby_cheek_stripes_l_69 = new THREE.Group();
  node_tabby_cheek_stripes_l_69.name = "Tabby left cheek stripe set__pivot";
  if (endpoint_tabby_cheek_stripes_l_69) {
    node_tabby_cheek_stripes_l_69.position.copy(endpoint_tabby_cheek_stripes_l_69.start);
    node_tabby_cheek_stripes_l_69.rotation.set(0, 0, 0);
    node_tabby_cheek_stripes_l_69.scale.set(1, 1, 1);
  } else {
    node_tabby_cheek_stripes_l_69.position.set(0.38, 2.59, 0.89);
    node_tabby_cheek_stripes_l_69.rotation.set(0.0, 0.0, 0.0);
    node_tabby_cheek_stripes_l_69.scale.set(0.36, 0.27, 0.04);
  }
  node_tabby_cheek_stripes_l_69.userData.sculptComponent = {"id": "tabby-cheek-stripes-l", "name": "Tabby left cheek stripe set", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.91, "primitive": "instanced-cluster", "topologyClass": "surface-relief", "topologyRationale": "Tabby left cheek stripe set is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.27, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.36, "height": 0.27, "depth": 0.04, "units": "world", "confidence": 0.91}, "transform": {"position": [0.38, 2.59, 0.89], "rotation": [0.0, 0.0, 0.0], "scale": [0.36, 0.27, 0.04]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}}, "material": "tabby-stripe", "materialLayers": ["tabby-stripe"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(47, 33, 24, 1.0)", "secondaryAlbedo": "rgba(59, 43, 32, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-cheek-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_cheek_stripes_l_69.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}};
  (nodes["tabby-head"] ?? root).add(node_tabby_cheek_stripes_l_69);
  nodes["tabby-cheek-stripes-l"] = node_tabby_cheek_stripes_l_69;
  const mesh_tabby_cheek_stripes_l_69Geometry = endpoint_tabby_cheek_stripes_l_69
    ? new THREE.CylinderGeometry(endpoint_tabby_cheek_stripes_l_69.endRadius, endpoint_tabby_cheek_stripes_l_69.baseRadius, endpoint_tabby_cheek_stripes_l_69.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tabby_cheek_stripes_l_69 = new THREE.Mesh(
    mesh_tabby_cheek_stripes_l_69Geometry,
    materialMap["tabby-stripe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_cheek_stripes_l_69.name = "Tabby left cheek stripe set";
  if (endpoint_tabby_cheek_stripes_l_69) {
    mesh_tabby_cheek_stripes_l_69.position.copy(endpoint_tabby_cheek_stripes_l_69.midpoint);
    mesh_tabby_cheek_stripes_l_69.quaternion.copy(endpoint_tabby_cheek_stripes_l_69.quaternion);
  }
  mesh_tabby_cheek_stripes_l_69.castShadow = options.castShadow ?? true;
  mesh_tabby_cheek_stripes_l_69.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_cheek_stripes_l_69.userData.sculptComponent = {"id": "tabby-cheek-stripes-l", "name": "Tabby left cheek stripe set", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.91, "primitive": "instanced-cluster", "topologyClass": "surface-relief", "topologyRationale": "Tabby left cheek stripe set is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.27, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.36, "height": 0.27, "depth": 0.04, "units": "world", "confidence": 0.91}, "transform": {"position": [0.38, 2.59, 0.89], "rotation": [0.0, 0.0, 0.0], "scale": [0.36, 0.27, 0.04]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}}, "material": "tabby-stripe", "materialLayers": ["tabby-stripe"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(47, 33, 24, 1.0)", "secondaryAlbedo": "rgba(59, 43, 32, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-cheek-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_cheek_stripes_l_69.add(mesh_tabby_cheek_stripes_l_69);
  meshes["tabby-cheek-stripes-l"] = mesh_tabby_cheek_stripes_l_69;
  colliders["tabby-cheek-stripes-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_cheek_stripes_l_69);

  const attachment_tabby_cheek_stripes_r_70 = {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.27, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_cheek_stripes_r_70 = makeAttachmentEndpoint(attachment_tabby_cheek_stripes_r_70);
  const node_tabby_cheek_stripes_r_70 = new THREE.Group();
  node_tabby_cheek_stripes_r_70.name = "Tabby right cheek stripe set__pivot";
  if (endpoint_tabby_cheek_stripes_r_70) {
    node_tabby_cheek_stripes_r_70.position.copy(endpoint_tabby_cheek_stripes_r_70.start);
    node_tabby_cheek_stripes_r_70.rotation.set(0, 0, 0);
    node_tabby_cheek_stripes_r_70.scale.set(1, 1, 1);
  } else {
    node_tabby_cheek_stripes_r_70.position.set(1.18, 2.59, 0.89);
    node_tabby_cheek_stripes_r_70.rotation.set(0.0, 0.0, 0.0);
    node_tabby_cheek_stripes_r_70.scale.set(0.36, 0.27, 0.04);
  }
  node_tabby_cheek_stripes_r_70.userData.sculptComponent = {"id": "tabby-cheek-stripes-r", "name": "Tabby right cheek stripe set", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.91, "primitive": "instanced-cluster", "topologyClass": "surface-relief", "topologyRationale": "Tabby right cheek stripe set is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.27, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.36, "height": 0.27, "depth": 0.04, "units": "world", "confidence": 0.91}, "transform": {"position": [1.18, 2.59, 0.89], "rotation": [0.0, 0.0, 0.0], "scale": [0.36, 0.27, 0.04]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}}, "material": "tabby-stripe", "materialLayers": ["tabby-stripe"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(47, 33, 24, 1.0)", "secondaryAlbedo": "rgba(59, 43, 32, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_cheek_stripes_r_70.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}};
  (nodes["tabby-head"] ?? root).add(node_tabby_cheek_stripes_r_70);
  nodes["tabby-cheek-stripes-r"] = node_tabby_cheek_stripes_r_70;
  const mesh_tabby_cheek_stripes_r_70Geometry = endpoint_tabby_cheek_stripes_r_70
    ? new THREE.CylinderGeometry(endpoint_tabby_cheek_stripes_r_70.endRadius, endpoint_tabby_cheek_stripes_r_70.baseRadius, endpoint_tabby_cheek_stripes_r_70.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tabby_cheek_stripes_r_70 = new THREE.Mesh(
    mesh_tabby_cheek_stripes_r_70Geometry,
    materialMap["tabby-stripe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_cheek_stripes_r_70.name = "Tabby right cheek stripe set";
  if (endpoint_tabby_cheek_stripes_r_70) {
    mesh_tabby_cheek_stripes_r_70.position.copy(endpoint_tabby_cheek_stripes_r_70.midpoint);
    mesh_tabby_cheek_stripes_r_70.quaternion.copy(endpoint_tabby_cheek_stripes_r_70.quaternion);
  }
  mesh_tabby_cheek_stripes_r_70.castShadow = options.castShadow ?? true;
  mesh_tabby_cheek_stripes_r_70.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_cheek_stripes_r_70.userData.sculptComponent = {"id": "tabby-cheek-stripes-r", "name": "Tabby right cheek stripe set", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.91, "primitive": "instanced-cluster", "topologyClass": "surface-relief", "topologyRationale": "Tabby right cheek stripe set is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-head", "attachment": {"parentId": "tabby-head", "parentSocket": "tabby-head-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.27, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.36, "height": 0.27, "depth": 0.04, "units": "world", "confidence": 0.91}, "transform": {"position": [1.18, 2.59, 0.89], "rotation": [0.0, 0.0, 0.0], "scale": [0.36, 0.27, 0.04]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}}, "material": "tabby-stripe", "materialLayers": ["tabby-stripe"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(47, 33, 24, 1.0)", "secondaryAlbedo": "rgba(59, 43, 32, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_cheek_stripes_r_70.add(mesh_tabby_cheek_stripes_r_70);
  meshes["tabby-cheek-stripes-r"] = mesh_tabby_cheek_stripes_r_70;
  colliders["tabby-cheek-stripes-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_cheek_stripes_r_70);

  const attachment_tabby_torso_stripe_system_71 = {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.9, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_torso_stripe_system_71 = makeAttachmentEndpoint(attachment_tabby_torso_stripe_system_71);
  const node_tabby_torso_stripe_system_71 = new THREE.Group();
  node_tabby_torso_stripe_system_71.name = "Tabby torso curved stripe system__pivot";
  if (endpoint_tabby_torso_stripe_system_71) {
    node_tabby_torso_stripe_system_71.position.copy(endpoint_tabby_torso_stripe_system_71.start);
    node_tabby_torso_stripe_system_71.rotation.set(0, 0, 0);
    node_tabby_torso_stripe_system_71.scale.set(1, 1, 1);
  } else {
    node_tabby_torso_stripe_system_71.position.set(0.68, 1.42, 0.73);
    node_tabby_torso_stripe_system_71.rotation.set(0.0, 0.0, 0.0);
    node_tabby_torso_stripe_system_71.scale.set(0.92, 0.9, 0.05);
  }
  node_tabby_torso_stripe_system_71.userData.sculptComponent = {"id": "tabby-torso-stripe-system", "name": "Tabby torso curved stripe system", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.9, "primitive": "instanced-cluster", "topologyClass": "surface-relief", "topologyRationale": "Tabby torso curved stripe system is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-torso", "attachment": {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.9, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.92, "height": 0.9, "depth": 0.05, "units": "world", "confidence": 0.9}, "transform": {"position": [0.68, 1.42, 0.73], "rotation": [0.0, 0.0, 0.0], "scale": [0.92, 0.9, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}}, "material": "tabby-stripe", "materialLayers": ["tabby-stripe"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(47, 33, 24, 1.0)", "secondaryAlbedo": "rgba(59, 43, 32, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-torso-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_torso_stripe_system_71.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}};
  (nodes["tabby-torso"] ?? root).add(node_tabby_torso_stripe_system_71);
  nodes["tabby-torso-stripe-system"] = node_tabby_torso_stripe_system_71;
  const mesh_tabby_torso_stripe_system_71Geometry = endpoint_tabby_torso_stripe_system_71
    ? new THREE.CylinderGeometry(endpoint_tabby_torso_stripe_system_71.endRadius, endpoint_tabby_torso_stripe_system_71.baseRadius, endpoint_tabby_torso_stripe_system_71.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tabby_torso_stripe_system_71 = new THREE.Mesh(
    mesh_tabby_torso_stripe_system_71Geometry,
    materialMap["tabby-stripe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_torso_stripe_system_71.name = "Tabby torso curved stripe system";
  if (endpoint_tabby_torso_stripe_system_71) {
    mesh_tabby_torso_stripe_system_71.position.copy(endpoint_tabby_torso_stripe_system_71.midpoint);
    mesh_tabby_torso_stripe_system_71.quaternion.copy(endpoint_tabby_torso_stripe_system_71.quaternion);
  }
  mesh_tabby_torso_stripe_system_71.castShadow = options.castShadow ?? true;
  mesh_tabby_torso_stripe_system_71.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_torso_stripe_system_71.userData.sculptComponent = {"id": "tabby-torso-stripe-system", "name": "Tabby torso curved stripe system", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.9, "primitive": "instanced-cluster", "topologyClass": "surface-relief", "topologyRationale": "Tabby torso curved stripe system is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-torso", "attachment": {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.9, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.92, "height": 0.9, "depth": 0.05, "units": "world", "confidence": 0.9}, "transform": {"position": [0.68, 1.42, 0.73], "rotation": [0.0, 0.0, 0.0], "scale": [0.92, 0.9, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}}, "material": "tabby-stripe", "materialLayers": ["tabby-stripe"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(47, 33, 24, 1.0)", "secondaryAlbedo": "rgba(59, 43, 32, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-torso-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_torso_stripe_system_71.add(mesh_tabby_torso_stripe_system_71);
  meshes["tabby-torso-stripe-system"] = mesh_tabby_torso_stripe_system_71;
  colliders["tabby-torso-stripe-system"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_torso_stripe_system_71);

  const attachment_tabby_leg_stripe_system_l_72 = {"parentId": "tabby-front-leg-l", "parentSocket": "tabby-front-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.62, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_leg_stripe_system_l_72 = makeAttachmentEndpoint(attachment_tabby_leg_stripe_system_l_72);
  const node_tabby_leg_stripe_system_l_72 = new THREE.Group();
  node_tabby_leg_stripe_system_l_72.name = "Tabby left leg stripe rings__pivot";
  if (endpoint_tabby_leg_stripe_system_l_72) {
    node_tabby_leg_stripe_system_l_72.position.copy(endpoint_tabby_leg_stripe_system_l_72.start);
    node_tabby_leg_stripe_system_l_72.rotation.set(0, 0, 0);
    node_tabby_leg_stripe_system_l_72.scale.set(1, 1, 1);
  } else {
    node_tabby_leg_stripe_system_l_72.position.set(0.4, 0.8, 0.64);
    node_tabby_leg_stripe_system_l_72.rotation.set(0.0, 0.0, 0.0);
    node_tabby_leg_stripe_system_l_72.scale.set(0.34, 0.62, 0.05);
  }
  node_tabby_leg_stripe_system_l_72.userData.sculptComponent = {"id": "tabby-leg-stripe-system-l", "name": "Tabby left leg stripe rings", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.95, "primitive": "instanced-cluster", "topologyClass": "surface-relief", "topologyRationale": "Tabby left leg stripe rings is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-front-leg-l", "attachment": {"parentId": "tabby-front-leg-l", "parentSocket": "tabby-front-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.62, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.34, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.95}, "transform": {"position": [0.4, 0.8, 0.64], "rotation": [0.0, 0.0, 0.0], "scale": [0.34, 0.62, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}}, "material": "tabby-stripe", "materialLayers": ["tabby-stripe"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(47, 33, 24, 1.0)", "secondaryAlbedo": "rgba(59, 43, 32, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-leg-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_leg_stripe_system_l_72.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}};
  (nodes["tabby-front-leg-l"] ?? root).add(node_tabby_leg_stripe_system_l_72);
  nodes["tabby-leg-stripe-system-l"] = node_tabby_leg_stripe_system_l_72;
  const mesh_tabby_leg_stripe_system_l_72Geometry = endpoint_tabby_leg_stripe_system_l_72
    ? new THREE.CylinderGeometry(endpoint_tabby_leg_stripe_system_l_72.endRadius, endpoint_tabby_leg_stripe_system_l_72.baseRadius, endpoint_tabby_leg_stripe_system_l_72.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tabby_leg_stripe_system_l_72 = new THREE.Mesh(
    mesh_tabby_leg_stripe_system_l_72Geometry,
    materialMap["tabby-stripe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_leg_stripe_system_l_72.name = "Tabby left leg stripe rings";
  if (endpoint_tabby_leg_stripe_system_l_72) {
    mesh_tabby_leg_stripe_system_l_72.position.copy(endpoint_tabby_leg_stripe_system_l_72.midpoint);
    mesh_tabby_leg_stripe_system_l_72.quaternion.copy(endpoint_tabby_leg_stripe_system_l_72.quaternion);
  }
  mesh_tabby_leg_stripe_system_l_72.castShadow = options.castShadow ?? true;
  mesh_tabby_leg_stripe_system_l_72.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_leg_stripe_system_l_72.userData.sculptComponent = {"id": "tabby-leg-stripe-system-l", "name": "Tabby left leg stripe rings", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.95, "primitive": "instanced-cluster", "topologyClass": "surface-relief", "topologyRationale": "Tabby left leg stripe rings is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-front-leg-l", "attachment": {"parentId": "tabby-front-leg-l", "parentSocket": "tabby-front-leg-l-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.62, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.34, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.95}, "transform": {"position": [0.4, 0.8, 0.64], "rotation": [0.0, 0.0, 0.0], "scale": [0.34, 0.62, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}}, "material": "tabby-stripe", "materialLayers": ["tabby-stripe"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(47, 33, 24, 1.0)", "secondaryAlbedo": "rgba(59, 43, 32, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-leg-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_leg_stripe_system_l_72.add(mesh_tabby_leg_stripe_system_l_72);
  meshes["tabby-leg-stripe-system-l"] = mesh_tabby_leg_stripe_system_l_72;
  colliders["tabby-leg-stripe-system-l"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_leg_stripe_system_l_72);

  const attachment_tabby_leg_stripe_system_r_73 = {"parentId": "tabby-front-leg-r", "parentSocket": "tabby-front-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.62, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_leg_stripe_system_r_73 = makeAttachmentEndpoint(attachment_tabby_leg_stripe_system_r_73);
  const node_tabby_leg_stripe_system_r_73 = new THREE.Group();
  node_tabby_leg_stripe_system_r_73.name = "Tabby right leg stripe rings__pivot";
  if (endpoint_tabby_leg_stripe_system_r_73) {
    node_tabby_leg_stripe_system_r_73.position.copy(endpoint_tabby_leg_stripe_system_r_73.start);
    node_tabby_leg_stripe_system_r_73.rotation.set(0, 0, 0);
    node_tabby_leg_stripe_system_r_73.scale.set(1, 1, 1);
  } else {
    node_tabby_leg_stripe_system_r_73.position.set(1.0, 0.8, 0.64);
    node_tabby_leg_stripe_system_r_73.rotation.set(0.0, 0.0, 0.0);
    node_tabby_leg_stripe_system_r_73.scale.set(0.34, 0.62, 0.05);
  }
  node_tabby_leg_stripe_system_r_73.userData.sculptComponent = {"id": "tabby-leg-stripe-system-r", "name": "Tabby right leg stripe rings", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.95, "primitive": "instanced-cluster", "topologyClass": "surface-relief", "topologyRationale": "Tabby right leg stripe rings is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-front-leg-r", "attachment": {"parentId": "tabby-front-leg-r", "parentSocket": "tabby-front-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.62, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.34, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.95}, "transform": {"position": [1.0, 0.8, 0.64], "rotation": [0.0, 0.0, 0.0], "scale": [0.34, 0.62, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}}, "material": "tabby-stripe", "materialLayers": ["tabby-stripe"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(47, 33, 24, 1.0)", "secondaryAlbedo": "rgba(59, 43, 32, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_leg_stripe_system_r_73.userData.actionProfile = {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}};
  (nodes["tabby-front-leg-r"] ?? root).add(node_tabby_leg_stripe_system_r_73);
  nodes["tabby-leg-stripe-system-r"] = node_tabby_leg_stripe_system_r_73;
  const mesh_tabby_leg_stripe_system_r_73Geometry = endpoint_tabby_leg_stripe_system_r_73
    ? new THREE.CylinderGeometry(endpoint_tabby_leg_stripe_system_r_73.endRadius, endpoint_tabby_leg_stripe_system_r_73.baseRadius, endpoint_tabby_leg_stripe_system_r_73.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tabby_leg_stripe_system_r_73 = new THREE.Mesh(
    mesh_tabby_leg_stripe_system_r_73Geometry,
    materialMap["tabby-stripe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_leg_stripe_system_r_73.name = "Tabby right leg stripe rings";
  if (endpoint_tabby_leg_stripe_system_r_73) {
    mesh_tabby_leg_stripe_system_r_73.position.copy(endpoint_tabby_leg_stripe_system_r_73.midpoint);
    mesh_tabby_leg_stripe_system_r_73.quaternion.copy(endpoint_tabby_leg_stripe_system_r_73.quaternion);
  }
  mesh_tabby_leg_stripe_system_r_73.castShadow = options.castShadow ?? true;
  mesh_tabby_leg_stripe_system_r_73.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_leg_stripe_system_r_73.userData.sculptComponent = {"id": "tabby-leg-stripe-system-r", "name": "Tabby right leg stripe rings", "level": "micro", "role": "detail", "importance": 0.6, "confidence": 0.95, "primitive": "instanced-cluster", "topologyClass": "surface-relief", "topologyRationale": "Tabby right leg stripe rings is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-front-leg-r", "attachment": {"parentId": "tabby-front-leg-r", "parentSocket": "tabby-front-leg-r-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.62, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.34, "height": 0.62, "depth": 0.05, "units": "world", "confidence": 0.95}, "transform": {"position": [1.0, 0.8, 0.64], "rotation": [0.0, 0.0, 0.0], "scale": [0.34, 0.62, 0.05]}, "actionProfile": {"animationRole": "detail", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-stripe"}}, "material": "tabby-stripe", "materialLayers": ["tabby-stripe"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(47, 33, 24, 1.0)", "secondaryAlbedo": "rgba(59, 43, 32, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_leg_stripe_system_r_73.add(mesh_tabby_leg_stripe_system_r_73);
  meshes["tabby-leg-stripe-system-r"] = mesh_tabby_leg_stripe_system_r_73;
  colliders["tabby-leg-stripe-system-r"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_leg_stripe_system_r_73);

  // repetition system: paired-eye-system (InstancedMesh, radial, count=4, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 4);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 4; i++) {
      const ang = ((0.0) + (i * 360) / 4) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "paired-eye-system";
    parent.add(cluster);
  }

  // repetition system: whisker-fan-system (InstancedMesh, radial, count=24, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 24);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 24; i++) {
      const ang = ((0.0) + (i * 360) / 24) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "whisker-fan-system";
    parent.add(cluster);
  }

  // repetition system: paw-toe-system (InstancedMesh, radial, count=12, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 12);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 12; i++) {
      const ang = ((0.0) + (i * 360) / 12) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "paw-toe-system";
    parent.add(cluster);
  }

  // repetition system: tabby-stripe-system (InstancedMesh, radial, count=23, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 23);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 23; i++) {
      const ang = ((0.0) + (i * 360) / 23) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "tabby-stripe-system";
    parent.add(cluster);
  }

  // repetition system: inner-ear-ridge-system (InstancedMesh, radial, count=20, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    const scl = [0.1, 0.1, 0.1];
    const axis = new THREE.Vector3(0.0, 0.0, 1.0).normalize();
    const radius = 0.0;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 20);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 20; i++) {
      const ang = ((0.0) + (i * 360) / 20) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "inner-ear-ridge-system";
    parent.add(cluster);
  }

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "procedural-stylized", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createTwoStylizedQuadrupedCatsLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Two Stylized Quadruped Cats look-dev lights";
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
  lights.userData.lightingFromPhoto = ["Warm 4200K directional key from upper camera-right at intensity 3.2; preserve visible fur-normal gradients.", "Soft neutral hemisphere and frontal fill at combined intensity 1.5; exposure 1.08 with ACES filmic tone mapping.", "Warm rim and large-area contact shadow lighting; ambient occlusion at paw/support contacts and under chins."];
  lights.userData.lookDevTargets = {"qualityPriority": "procedural-stylized", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createTwoStylizedQuadrupedCatsEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameTwoStylizedQuadrupedCatsCamera(
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
export function createTwoStylizedQuadrupedCatsPresentationComposer(
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

export function configureTwoStylizedQuadrupedCatsRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createTwoStylizedQuadrupedCatsInspectControls(
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
