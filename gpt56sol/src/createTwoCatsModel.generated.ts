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
// Sculpt build pass: blockout
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
    {"id": "black-fur", "name": "Black Fur", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#11100f", "color": "#11100f", "colorVariation": {"palette": ["#11100f", "#11100f"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#11100f", "secondary": "#11100f", "map": "procedural-black-fur-albedo"}, "roughness": {"base": 0.78, "variation": 0.08, "map": "procedural-black-fur-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.18, "map": "procedural-black-fur-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-black-fur-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "black-coat-warm-rim", "region": "silhouette-facing normals", "baseColor": "#2a211b", "roughness": 0.7}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["tabby-fur"] = createSculptMaterial(
    "tabby-fur",
    {"id": "tabby-fur", "name": "Tabby Fur", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#8b603b", "color": "#8b603b", "colorVariation": {"palette": ["#8b603b", "#8b603b"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#8b603b", "secondary": "#8b603b", "map": "procedural-tabby-fur-albedo"}, "roughness": {"base": 0.76, "variation": 0.08, "map": "procedural-tabby-fur-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.2, "map": "procedural-tabby-fur-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-tabby-fur-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "tabby-warm-flank", "region": "visible shoulders and flank", "baseColor": "#a8794a", "roughness": 0.72}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["white-fur"] = createSculptMaterial(
    "white-fur",
    {"id": "white-fur", "name": "White Fur", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#e8d7bd", "color": "#e8d7bd", "colorVariation": {"palette": ["#e8d7bd", "#e8d7bd"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#e8d7bd", "secondary": "#e8d7bd", "map": "procedural-white-fur-albedo"}, "roughness": {"base": 0.82, "variation": 0.08, "map": "procedural-white-fur-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.16, "map": "procedural-white-fur-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-white-fur-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "cream-shadow", "region": "bib and paw cavities", "baseColor": "#c9b397", "roughness": 0.86}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
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
    {"id": "iris-green", "name": "Iris Green", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#a9b84f", "color": "#a9b84f", "colorVariation": {"palette": ["#a9b84f", "#a9b84f"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#a9b84f", "secondary": "#a9b84f", "map": "procedural-iris-green-albedo"}, "roughness": {"base": 0.26, "variation": 0.08, "map": "procedural-iris-green-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.03, "map": "procedural-iris-green-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-iris-green-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "olive-limbal-ring", "region": "iris perimeter", "baseColor": "#59612e", "roughness": 0.3}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["pupil"] = createSculptMaterial(
    "pupil",
    {"id": "pupil", "name": "Pupil", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#030504", "color": "#030504", "colorVariation": {"palette": ["#030504", "#030504"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#030504", "secondary": "#030504", "map": "procedural-pupil-albedo"}, "roughness": {"base": 0.18, "variation": 0.08, "map": "procedural-pupil-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.0, "map": "procedural-pupil-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-pupil-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["cornea"] = createSculptMaterial(
    "cornea",
    {"id": "cornea", "name": "Cornea", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#d8f1e5", "color": "#d8f1e5", "colorVariation": {"palette": ["#d8f1e5", "#d8f1e5"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#d8f1e5", "secondary": "#d8f1e5", "map": "procedural-cornea-albedo"}, "roughness": {"base": 0.06, "variation": 0.08, "map": "procedural-cornea-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.0, "map": "procedural-cornea-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-cornea-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.45, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "corneal-highlight", "region": "upper camera-facing quadrant", "baseColor": "#ffffff", "roughness": 0.03}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["black-nose"] = createSculptMaterial(
    "black-nose",
    {"id": "black-nose", "name": "Black Nose", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#29201d", "color": "#29201d", "colorVariation": {"palette": ["#29201d", "#29201d"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#29201d", "secondary": "#29201d", "map": "procedural-black-nose-albedo"}, "roughness": {"base": 0.32, "variation": 0.08, "map": "procedural-black-nose-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.04, "map": "procedural-black-nose-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-black-nose-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.45, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "black-nose-gloss", "region": "nose center", "baseColor": "#352825", "roughness": 0.18}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["tabby-nose"] = createSculptMaterial(
    "tabby-nose",
    {"id": "tabby-nose", "name": "Tabby Nose", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#9b5f4c", "color": "#9b5f4c", "colorVariation": {"palette": ["#9b5f4c", "#9b5f4c"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#9b5f4c", "secondary": "#9b5f4c", "map": "procedural-tabby-nose-albedo"}, "roughness": {"base": 0.3, "variation": 0.08, "map": "procedural-tabby-nose-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.04, "map": "procedural-tabby-nose-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-tabby-nose-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.45, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "tabby-nose-gloss", "region": "nose center", "baseColor": "#b6755e", "roughness": 0.16}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["whisker"] = createSculptMaterial(
    "whisker",
    {"id": "whisker", "name": "Whisker", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "utility", "baseColor": "#e7dfcf", "color": "#e7dfcf", "colorVariation": {"palette": ["#e7dfcf", "#e7dfcf"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#e7dfcf", "secondary": "#e7dfcf", "map": "procedural-whisker-albedo"}, "roughness": {"base": 0.46, "variation": 0.08, "map": "procedural-whisker-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.0, "map": "procedural-whisker-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-whisker-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
    options
  );
  materialMap["tabby-stripe"] = createSculptMaterial(
    "tabby-stripe",
    {"id": "tabby-stripe", "name": "Tabby Stripe", "type": "standard", "shaderModel": "MeshPhysicalMaterial metallic-roughness PBR", "qualityTier": "hero-procedural", "baseColor": "#2a211b", "color": "#2a211b", "colorVariation": {"palette": ["#2a211b", "#2a211b"], "pattern": "component-local deterministic variation", "amplitude": 0.04, "heightCorrelation": 0.0}, "albedo": {"primary": "#2a211b", "secondary": "#2a211b", "map": "procedural-tabby-stripe-albedo"}, "roughness": {"base": 0.8, "variation": 0.08, "map": "procedural-tabby-stripe-roughness"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"strength": 0.12, "map": "procedural-tabby-stripe-normal"}, "ambientOcclusion": {"strength": 0.35, "map": "procedural-tabby-stripe-ao"}, "opacity": {"base": 1.0}, "clearcoat": 0.0, "clearcoatRoughness": 0.08, "textureResolution": 1024, "textureProjection": {"mode": "object-space procedural", "repeat": [1.0, 1.0], "anisotropy": 4}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 0.35, "amplitude": 0.025}, {"id": "meso", "frequency": 3.5, "amplitude": 0.012}, {"id": "micro", "frequency": 42.0, "amplitude": 0.004}], "localOverrides": [{"id": "stripe-soft-edge", "region": "stripe boundaries", "baseColor": "#3a2a21", "roughness": 0.82}], "shaderNotes": ["Keep albedo, roughness, normal, and AO channels independent."]},
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
  node_black_torso_2.userData.sculptComponent = {"id": "black-torso", "name": "Black cat upright torso", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.92, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat upright torso is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-cat", "attachment": {"parentId": "black-cat", "parentSocket": "black-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.62, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.88, "height": 1.62, "depth": 0.72, "units": "world", "confidence": 0.92}, "transform": {"position": [-0.68, 1.42, -0.04], "rotation": [0.0, 0.0, 0.0], "scale": [0.88, 1.62, 0.72]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 16, 15, 1.0)", "secondaryAlbedo": "rgba(29, 26, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-coat-directional-flow"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
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
  mesh_black_torso_2.userData.sculptComponent = {"id": "black-torso", "name": "Black cat upright torso", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.92, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat upright torso is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-cat", "attachment": {"parentId": "black-cat", "parentSocket": "black-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.62, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.88, "height": 1.62, "depth": 0.72, "units": "world", "confidence": 0.92}, "transform": {"position": [-0.68, 1.42, -0.04], "rotation": [0.0, 0.0, 0.0], "scale": [0.88, 1.62, 0.72]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 16, 15, 1.0)", "secondaryAlbedo": "rgba(29, 26, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-coat-directional-flow"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
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
  node_black_rump_3.userData.sculptComponent = {"id": "black-rump", "name": "Black cat seated rump", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.72, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat seated rump is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-cat", "attachment": {"parentId": "black-cat", "parentSocket": "black-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 1.02, "height": 0.78, "depth": 0.82, "units": "world", "confidence": 0.72}, "transform": {"position": [-0.78, 0.75, -0.2], "rotation": [0.0, 0.0, 0.0], "scale": [1.02, 0.78, 0.82]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 16, 15, 1.0)", "secondaryAlbedo": "rgba(29, 26, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
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
  mesh_black_rump_3.userData.sculptComponent = {"id": "black-rump", "name": "Black cat seated rump", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.72, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat seated rump is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-cat", "attachment": {"parentId": "black-cat", "parentSocket": "black-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.78, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 1.02, "height": 0.78, "depth": 0.82, "units": "world", "confidence": 0.72}, "transform": {"position": [-0.78, 0.75, -0.2], "rotation": [0.0, 0.0, 0.0], "scale": [1.02, 0.78, 0.82]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 16, 15, 1.0)", "secondaryAlbedo": "rgba(29, 26, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_rump_3.add(mesh_black_rump_3);
  meshes["black-rump"] = mesh_black_rump_3;
  colliders["black-rump"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_rump_3);

  const attachment_black_neck_4 = {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.52, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]};
  const endpoint_black_neck_4 = makeAttachmentEndpoint(attachment_black_neck_4);
  const node_black_neck_4 = new THREE.Group();
  node_black_neck_4.name = "Black cat neck bridge__pivot";
  if (endpoint_black_neck_4) {
    node_black_neck_4.position.copy(endpoint_black_neck_4.start);
    node_black_neck_4.rotation.set(0, 0, 0);
    node_black_neck_4.scale.set(1, 1, 1);
  } else {
    node_black_neck_4.position.set(-0.68, 2.27, 0.1);
    node_black_neck_4.rotation.set(0.0, 0.0, 0.0);
    node_black_neck_4.scale.set(0.58, 0.52, 0.5);
  }
  node_black_neck_4.userData.sculptComponent = {"id": "black-neck", "name": "Black cat neck bridge", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.84, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat neck bridge is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-torso", "attachment": {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.52, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.58, "height": 0.52, "depth": 0.5, "units": "world", "confidence": 0.84}, "transform": {"position": [-0.68, 2.27, 0.1], "rotation": [0.0, 0.0, 0.0], "scale": [0.58, 0.52, 0.5]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 16, 15, 1.0)", "secondaryAlbedo": "rgba(29, 26, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_neck_4.userData.actionProfile = {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-torso"] ?? root).add(node_black_neck_4);
  nodes["black-neck"] = node_black_neck_4;
  const mesh_black_neck_4Geometry = endpoint_black_neck_4
    ? new THREE.CylinderGeometry(endpoint_black_neck_4.endRadius, endpoint_black_neck_4.baseRadius, endpoint_black_neck_4.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_neck_4 = new THREE.Mesh(
    mesh_black_neck_4Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_neck_4.name = "Black cat neck bridge";
  if (endpoint_black_neck_4) {
    mesh_black_neck_4.position.copy(endpoint_black_neck_4.midpoint);
    mesh_black_neck_4.quaternion.copy(endpoint_black_neck_4.quaternion);
  }
  mesh_black_neck_4.castShadow = options.castShadow ?? true;
  mesh_black_neck_4.receiveShadow = options.receiveShadow ?? true;
  mesh_black_neck_4.userData.sculptComponent = {"id": "black-neck", "name": "Black cat neck bridge", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.84, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat neck bridge is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-torso", "attachment": {"parentId": "black-torso", "parentSocket": "black-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.52, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-body"]}, "dimensions": {"width": 0.58, "height": 0.52, "depth": 0.5, "units": "world", "confidence": 0.84}, "transform": {"position": [-0.68, 2.27, 0.1], "rotation": [0.0, 0.0, 0.0], "scale": [0.58, 0.52, 0.5]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 16, 15, 1.0)", "secondaryAlbedo": "rgba(29, 26, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-body"]};
  node_black_neck_4.add(mesh_black_neck_4);
  meshes["black-neck"] = mesh_black_neck_4;
  colliders["black-neck"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_neck_4);

  const attachment_black_head_5 = {"parentId": "black-neck", "parentSocket": "black-neck-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.75, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]};
  const endpoint_black_head_5 = makeAttachmentEndpoint(attachment_black_head_5);
  const node_black_head_5 = new THREE.Group();
  node_black_head_5.name = "Black cat head pivot__pivot";
  if (endpoint_black_head_5) {
    node_black_head_5.position.copy(endpoint_black_head_5.start);
    node_black_head_5.rotation.set(0, 0, 0);
    node_black_head_5.scale.set(1, 1, 1);
  } else {
    node_black_head_5.position.set(-0.7, 2.88, 0.22);
    node_black_head_5.rotation.set(0.0, 0.0, 0.0);
    node_black_head_5.scale.set(0.72, 0.75, 0.62);
  }
  node_black_head_5.userData.sculptComponent = {"id": "black-head", "name": "Black cat head pivot", "level": "macro", "role": "head", "importance": 1.0, "confidence": 0.96, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat head pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-neck", "attachment": {"parentId": "black-neck", "parentSocket": "black-neck-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.75, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.72, "height": 0.75, "depth": 0.62, "units": "world", "confidence": 0.96}, "transform": {"position": [-0.7, 2.88, 0.22], "rotation": [0.0, 0.0, 0.0], "scale": [0.72, 0.75, 0.62]}, "actionProfile": {"animationRole": "head", "pivot": {"mode": "joint", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 16, 15, 1.0)", "secondaryAlbedo": "rgba(29, 26, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-eye-wetline", "black-round-pupil", "black-iris-ring"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_head_5.userData.actionProfile = {"animationRole": "head", "pivot": {"mode": "joint", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}};
  (nodes["black-neck"] ?? root).add(node_black_head_5);
  nodes["black-head"] = node_black_head_5;
  const mesh_black_head_5Geometry = endpoint_black_head_5
    ? new THREE.CylinderGeometry(endpoint_black_head_5.endRadius, endpoint_black_head_5.baseRadius, endpoint_black_head_5.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_black_head_5 = new THREE.Mesh(
    mesh_black_head_5Geometry,
    materialMap["black-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_black_head_5.name = "Black cat head pivot";
  if (endpoint_black_head_5) {
    mesh_black_head_5.position.copy(endpoint_black_head_5.midpoint);
    mesh_black_head_5.quaternion.copy(endpoint_black_head_5.quaternion);
  }
  mesh_black_head_5.castShadow = options.castShadow ?? true;
  mesh_black_head_5.receiveShadow = options.receiveShadow ?? true;
  mesh_black_head_5.userData.sculptComponent = {"id": "black-head", "name": "Black cat head pivot", "level": "macro", "role": "head", "importance": 1.0, "confidence": 0.96, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Black cat head pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in black-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "black-neck", "attachment": {"parentId": "black-neck", "parentSocket": "black-neck-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.75, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["black-face"]}, "dimensions": {"width": 0.72, "height": 0.75, "depth": 0.62, "units": "world", "confidence": 0.96}, "transform": {"position": [-0.7, 2.88, 0.22], "rotation": [0.0, 0.0, 0.0], "scale": [0.72, 0.75, 0.62]}, "actionProfile": {"animationRole": "head", "pivot": {"mode": "joint", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "black-fur"}}, "material": "black-fur", "materialLayers": ["black-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(17, 16, 15, 1.0)", "secondaryAlbedo": "rgba(29, 26, 23, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["black-eye-wetline", "black-round-pupil", "black-iris-ring"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["black-face"]};
  node_black_head_5.add(mesh_black_head_5);
  meshes["black-head"] = mesh_black_head_5;
  colliders["black-head"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_black_head_5);

  const attachment_tabby_cat_6 = {"parentId": "root", "parentSocket": "root-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.08, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_cat_6 = makeAttachmentEndpoint(attachment_tabby_cat_6);
  const node_tabby_cat_6 = new THREE.Group();
  node_tabby_cat_6.name = "Tabby cat quadruped root__pivot";
  if (endpoint_tabby_cat_6) {
    node_tabby_cat_6.position.copy(endpoint_tabby_cat_6.start);
    node_tabby_cat_6.rotation.set(0, 0, 0);
    node_tabby_cat_6.scale.set(1, 1, 1);
  } else {
    node_tabby_cat_6.position.set(0.7, 0.0, 0.08);
    node_tabby_cat_6.rotation.set(0.0, 0.0, 0.0);
    node_tabby_cat_6.scale.set(0.01, 0.01, 0.01);
  }
  node_tabby_cat_6.userData.sculptComponent = {"id": "tabby-cat", "name": "Tabby cat quadruped root", "level": "macro", "role": "cat-root", "importance": 1.0, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Tabby cat quadruped root is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.08, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.01, "height": 0.01, "depth": 0.01, "units": "world", "confidence": 0.9}, "transform": {"position": [0.7, 0.0, 0.08], "rotation": [0.0, 0.0, 0.0], "scale": [0.01, 0.01, 0.01]}, "actionProfile": {"animationRole": "cat-root", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 0, 0, 0.0)", "secondaryAlbedo": "rgba(12, 10, 8, 0.0)", "materialClass": "unknown", "materialClassConfidence": 1.0}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_cat_6.userData.actionProfile = {"animationRole": "cat-root", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}};
  (nodes["root"] ?? root).add(node_tabby_cat_6);
  nodes["tabby-cat"] = node_tabby_cat_6;
  const mesh_tabby_cat_6Geometry = endpoint_tabby_cat_6
    ? new THREE.CylinderGeometry(endpoint_tabby_cat_6.endRadius, endpoint_tabby_cat_6.baseRadius, endpoint_tabby_cat_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_tabby_cat_6 = new THREE.Mesh(
    mesh_tabby_cat_6Geometry,
    materialMap["hidden"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_cat_6.name = "Tabby cat quadruped root";
  if (endpoint_tabby_cat_6) {
    mesh_tabby_cat_6.position.copy(endpoint_tabby_cat_6.midpoint);
    mesh_tabby_cat_6.quaternion.copy(endpoint_tabby_cat_6.quaternion);
  }
  mesh_tabby_cat_6.castShadow = options.castShadow ?? true;
  mesh_tabby_cat_6.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_cat_6.userData.sculptComponent = {"id": "tabby-cat", "name": "Tabby cat quadruped root", "level": "macro", "role": "cat-root", "importance": 1.0, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Tabby cat quadruped root is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "separate procedural surface or assembled detail", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.08, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.01, "height": 0.01, "depth": 0.01, "units": "world", "confidence": 0.9}, "transform": {"position": [0.7, 0.0, 0.08], "rotation": [0.0, 0.0, 0.0], "scale": [0.01, 0.01, 0.01]}, "actionProfile": {"animationRole": "cat-root", "pivot": {"mode": "base", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "hidden"}}, "material": "hidden", "materialLayers": ["hidden"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 0, 0, 0.0)", "secondaryAlbedo": "rgba(12, 10, 8, 0.0)", "materialClass": "unknown", "materialClassConfidence": 1.0}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.004, "normalPattern": "dielectric-surface", "displacementPattern": "none", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_cat_6.add(mesh_tabby_cat_6);
  meshes["tabby-cat"] = mesh_tabby_cat_6;
  colliders["tabby-cat"] = {"type": "capsule", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_cat_6);

  const attachment_tabby_torso_7 = {"parentId": "tabby-cat", "parentSocket": "tabby-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.32, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_torso_7 = makeAttachmentEndpoint(attachment_tabby_torso_7);
  const node_tabby_torso_7 = new THREE.Group();
  node_tabby_torso_7.name = "Tabby cat broad torso__pivot";
  if (endpoint_tabby_torso_7) {
    node_tabby_torso_7.position.copy(endpoint_tabby_torso_7.start);
    node_tabby_torso_7.rotation.set(0, 0, 0);
    node_tabby_torso_7.scale.set(1, 1, 1);
  } else {
    node_tabby_torso_7.position.set(0.68, 1.36, -0.02);
    node_tabby_torso_7.rotation.set(0.0, 0.0, 0.0);
    node_tabby_torso_7.scale.set(1.02, 1.32, 0.82);
  }
  node_tabby_torso_7.userData.sculptComponent = {"id": "tabby-torso", "name": "Tabby cat broad torso", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.94, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat broad torso is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-cat", "attachment": {"parentId": "tabby-cat", "parentSocket": "tabby-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.32, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 1.02, "height": 1.32, "depth": 0.82, "units": "world", "confidence": 0.94}, "transform": {"position": [0.68, 1.36, -0.02], "rotation": [0.0, 0.0, 0.0], "scale": [1.02, 1.32, 0.82]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 96, 59, 1.0)", "secondaryAlbedo": "rgba(151, 106, 67, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-torso-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_torso_7.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-cat"] ?? root).add(node_tabby_torso_7);
  nodes["tabby-torso"] = node_tabby_torso_7;
  const mesh_tabby_torso_7Geometry = endpoint_tabby_torso_7
    ? new THREE.CylinderGeometry(endpoint_tabby_torso_7.endRadius, endpoint_tabby_torso_7.baseRadius, endpoint_tabby_torso_7.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_torso_7 = new THREE.Mesh(
    mesh_tabby_torso_7Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_torso_7.name = "Tabby cat broad torso";
  if (endpoint_tabby_torso_7) {
    mesh_tabby_torso_7.position.copy(endpoint_tabby_torso_7.midpoint);
    mesh_tabby_torso_7.quaternion.copy(endpoint_tabby_torso_7.quaternion);
  }
  mesh_tabby_torso_7.castShadow = options.castShadow ?? true;
  mesh_tabby_torso_7.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_torso_7.userData.sculptComponent = {"id": "tabby-torso", "name": "Tabby cat broad torso", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.94, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat broad torso is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-cat", "attachment": {"parentId": "tabby-cat", "parentSocket": "tabby-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 1.32, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 1.02, "height": 1.32, "depth": 0.82, "units": "world", "confidence": 0.94}, "transform": {"position": [0.68, 1.36, -0.02], "rotation": [0.0, 0.0, 0.0], "scale": [1.02, 1.32, 0.82]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 96, 59, 1.0)", "secondaryAlbedo": "rgba(151, 106, 67, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-torso-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_torso_7.add(mesh_tabby_torso_7);
  meshes["tabby-torso"] = mesh_tabby_torso_7;
  colliders["tabby-torso"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_torso_7);

  const attachment_tabby_rump_8 = {"parentId": "tabby-cat", "parentSocket": "tabby-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.9, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_rump_8 = makeAttachmentEndpoint(attachment_tabby_rump_8);
  const node_tabby_rump_8 = new THREE.Group();
  node_tabby_rump_8.name = "Tabby cat posterior rump__pivot";
  if (endpoint_tabby_rump_8) {
    node_tabby_rump_8.position.copy(endpoint_tabby_rump_8.start);
    node_tabby_rump_8.rotation.set(0, 0, 0);
    node_tabby_rump_8.scale.set(1, 1, 1);
  } else {
    node_tabby_rump_8.position.set(0.82, 1.0, -0.4);
    node_tabby_rump_8.rotation.set(0.0, 0.0, 0.0);
    node_tabby_rump_8.scale.set(1.08, 0.9, 0.9);
  }
  node_tabby_rump_8.userData.sculptComponent = {"id": "tabby-rump", "name": "Tabby cat posterior rump", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.5, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat posterior rump is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-cat", "attachment": {"parentId": "tabby-cat", "parentSocket": "tabby-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.9, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 1.08, "height": 0.9, "depth": 0.9, "units": "world", "confidence": 0.5}, "transform": {"position": [0.82, 1.0, -0.4], "rotation": [0.0, 0.0, 0.0], "scale": [1.08, 0.9, 0.9]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 96, 59, 1.0)", "secondaryAlbedo": "rgba(151, 106, 67, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_rump_8.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-cat"] ?? root).add(node_tabby_rump_8);
  nodes["tabby-rump"] = node_tabby_rump_8;
  const mesh_tabby_rump_8Geometry = endpoint_tabby_rump_8
    ? new THREE.CylinderGeometry(endpoint_tabby_rump_8.endRadius, endpoint_tabby_rump_8.baseRadius, endpoint_tabby_rump_8.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_rump_8 = new THREE.Mesh(
    mesh_tabby_rump_8Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_rump_8.name = "Tabby cat posterior rump";
  if (endpoint_tabby_rump_8) {
    mesh_tabby_rump_8.position.copy(endpoint_tabby_rump_8.midpoint);
    mesh_tabby_rump_8.quaternion.copy(endpoint_tabby_rump_8.quaternion);
  }
  mesh_tabby_rump_8.castShadow = options.castShadow ?? true;
  mesh_tabby_rump_8.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_rump_8.userData.sculptComponent = {"id": "tabby-rump", "name": "Tabby cat posterior rump", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.5, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat posterior rump is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-cat", "attachment": {"parentId": "tabby-cat", "parentSocket": "tabby-cat-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.9, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 1.08, "height": 0.9, "depth": 0.9, "units": "world", "confidence": 0.5}, "transform": {"position": [0.82, 1.0, -0.4], "rotation": [0.0, 0.0, 0.0], "scale": [1.08, 0.9, 0.9]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 96, 59, 1.0)", "secondaryAlbedo": "rgba(151, 106, 67, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_rump_8.add(mesh_tabby_rump_8);
  meshes["tabby-rump"] = mesh_tabby_rump_8;
  colliders["tabby-rump"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_rump_8);

  const attachment_tabby_neck_9 = {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.5, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]};
  const endpoint_tabby_neck_9 = makeAttachmentEndpoint(attachment_tabby_neck_9);
  const node_tabby_neck_9 = new THREE.Group();
  node_tabby_neck_9.name = "Tabby cat neck bridge__pivot";
  if (endpoint_tabby_neck_9) {
    node_tabby_neck_9.position.copy(endpoint_tabby_neck_9.start);
    node_tabby_neck_9.rotation.set(0, 0, 0);
    node_tabby_neck_9.scale.set(1, 1, 1);
  } else {
    node_tabby_neck_9.position.set(0.72, 2.23, 0.12);
    node_tabby_neck_9.rotation.set(0.0, 0.0, 0.0);
    node_tabby_neck_9.scale.set(0.65, 0.5, 0.52);
  }
  node_tabby_neck_9.userData.sculptComponent = {"id": "tabby-neck", "name": "Tabby cat neck bridge", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.86, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat neck bridge is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-torso", "attachment": {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.5, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.65, "height": 0.5, "depth": 0.52, "units": "world", "confidence": 0.86}, "transform": {"position": [0.72, 2.23, 0.12], "rotation": [0.0, 0.0, 0.0], "scale": [0.65, 0.5, 0.52]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 96, 59, 1.0)", "secondaryAlbedo": "rgba(151, 106, 67, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_neck_9.userData.actionProfile = {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-torso"] ?? root).add(node_tabby_neck_9);
  nodes["tabby-neck"] = node_tabby_neck_9;
  const mesh_tabby_neck_9Geometry = endpoint_tabby_neck_9
    ? new THREE.CylinderGeometry(endpoint_tabby_neck_9.endRadius, endpoint_tabby_neck_9.baseRadius, endpoint_tabby_neck_9.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_neck_9 = new THREE.Mesh(
    mesh_tabby_neck_9Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_neck_9.name = "Tabby cat neck bridge";
  if (endpoint_tabby_neck_9) {
    mesh_tabby_neck_9.position.copy(endpoint_tabby_neck_9.midpoint);
    mesh_tabby_neck_9.quaternion.copy(endpoint_tabby_neck_9.quaternion);
  }
  mesh_tabby_neck_9.castShadow = options.castShadow ?? true;
  mesh_tabby_neck_9.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_neck_9.userData.sculptComponent = {"id": "tabby-neck", "name": "Tabby cat neck bridge", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.86, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat neck bridge is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-body.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-torso", "attachment": {"parentId": "tabby-torso", "parentSocket": "tabby-torso-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.5, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-body"]}, "dimensions": {"width": 0.65, "height": 0.5, "depth": 0.52, "units": "world", "confidence": 0.86}, "transform": {"position": [0.72, 2.23, 0.12], "rotation": [0.0, 0.0, 0.0], "scale": [0.65, 0.5, 0.52]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": false, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 96, 59, 1.0)", "secondaryAlbedo": "rgba(151, 106, 67, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-body"]};
  node_tabby_neck_9.add(mesh_tabby_neck_9);
  meshes["tabby-neck"] = mesh_tabby_neck_9;
  colliders["tabby-neck"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_neck_9);

  const attachment_tabby_head_10 = {"parentId": "tabby-neck", "parentSocket": "tabby-neck-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.76, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]};
  const endpoint_tabby_head_10 = makeAttachmentEndpoint(attachment_tabby_head_10);
  const node_tabby_head_10 = new THREE.Group();
  node_tabby_head_10.name = "Tabby cat head pivot__pivot";
  if (endpoint_tabby_head_10) {
    node_tabby_head_10.position.copy(endpoint_tabby_head_10.start);
    node_tabby_head_10.rotation.set(0, 0, 0);
    node_tabby_head_10.scale.set(1, 1, 1);
  } else {
    node_tabby_head_10.position.set(0.78, 2.75, 0.32);
    node_tabby_head_10.rotation.set(0.0, 0.0, 0.0);
    node_tabby_head_10.scale.set(0.78, 0.76, 0.66);
  }
  node_tabby_head_10.userData.sculptComponent = {"id": "tabby-head", "name": "Tabby cat head pivot", "level": "macro", "role": "head", "importance": 1.0, "confidence": 0.97, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat head pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-neck", "attachment": {"parentId": "tabby-neck", "parentSocket": "tabby-neck-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.76, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.78, "height": 0.76, "depth": 0.66, "units": "world", "confidence": 0.97}, "transform": {"position": [0.78, 2.75, 0.32], "rotation": [0.0, 0.0, 0.0], "scale": [0.78, 0.76, 0.66]}, "actionProfile": {"animationRole": "head", "pivot": {"mode": "joint", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 96, 59, 1.0)", "secondaryAlbedo": "rgba(151, 106, 67, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-eye-wetline", "tabby-round-pupil", "tabby-iris-ring", "tabby-forehead-m", "tabby-cheek-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_head_10.userData.actionProfile = {"animationRole": "head", "pivot": {"mode": "joint", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}};
  (nodes["tabby-neck"] ?? root).add(node_tabby_head_10);
  nodes["tabby-head"] = node_tabby_head_10;
  const mesh_tabby_head_10Geometry = endpoint_tabby_head_10
    ? new THREE.CylinderGeometry(endpoint_tabby_head_10.endRadius, endpoint_tabby_head_10.baseRadius, endpoint_tabby_head_10.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_tabby_head_10 = new THREE.Mesh(
    mesh_tabby_head_10Geometry,
    materialMap["tabby-fur"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tabby_head_10.name = "Tabby cat head pivot";
  if (endpoint_tabby_head_10) {
    mesh_tabby_head_10.position.copy(endpoint_tabby_head_10.midpoint);
    mesh_tabby_head_10.quaternion.copy(endpoint_tabby_head_10.quaternion);
  }
  mesh_tabby_head_10.castShadow = options.castShadow ?? true;
  mesh_tabby_head_10.receiveShadow = options.receiveShadow ?? true;
  mesh_tabby_head_10.userData.sculptComponent = {"id": "tabby-head", "name": "Tabby cat head pivot", "level": "macro", "role": "head", "importance": 1.0, "confidence": 0.97, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Tabby cat head pivot is represented as a named volumetric or surface part because its visible boundary, overlap, or material region is separable in tabby-face.", "geometryDescriptor": {"topologyIntent": "soft rounded procedural volume with stable named pivot", "edgeTreatment": {"type": "rounded", "bevelRadius": 0.02, "segments": 3}, "deformationStack": ["elliptical scale", "reference-proportion adjustment"], "uvStrategy": "generated triplanar or local procedural coordinates", "normalStrategy": "vertex normals plus independent procedural micro-normal response"}, "parent": "tabby-neck", "attachment": {"parentId": "tabby-neck", "parentSocket": "tabby-neck-socket", "localStart": [0.0, 0.0, 0.0], "localEnd": [0.0, 0.76, 0.0], "contactType": "overlap", "embedDepth": 0.04, "gapTolerance": 0.01, "contactNormal": [0.0, 1.0, 0.0], "evidenceRefs": ["tabby-face"]}, "dimensions": {"width": 0.78, "height": 0.76, "depth": 0.66, "units": "world", "confidence": 0.97}, "transform": {"position": [0.78, 2.75, 0.32], "rotation": [0.0, 0.0, 0.0], "scale": [0.78, 0.76, 0.66]}, "actionProfile": {"animationRole": "head", "pivot": {"mode": "joint", "localPosition": [0.0, 0.0, 0.0], "axis": [0.0, 1.0, 0.0], "confidence": 0.9}, "transformChannels": {"translate": false, "rotate": true, "scale": true, "bend": false, "twist": true, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soft-body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "tabby-fur"}}, "material": "tabby-fur", "materialLayers": ["tabby-fur"], "colorMaterialRecipe": {"dominantAlbedo": "rgba(139, 96, 59, 1.0)", "secondaryAlbedo": "rgba(151, 106, 67, 1.0)", "materialClass": "skin", "materialClassConfidence": 0.9}, "deformations": [], "joints": [], "seams": [], "localFeatures": ["tabby-eye-wetline", "tabby-round-pupil", "tabby-iris-ring", "tabby-forehead-m", "tabby-cheek-stripes"], "surfaceDetail": {"macroRoughness": 0.08, "microRoughness": 0.04, "bumpAmplitude": 0.012, "normalPattern": "short-fur-flow", "displacementPattern": "sparse-silhouette-tufts", "occlusionPattern": "contact-and-fold-cavity", "edgeWearPattern": "none", "notes": "Procedural stylized surface; no albedo channel is reused as roughness, normal, or AO."}, "viewEvidenceRefs": ["tabby-face"]};
  node_tabby_head_10.add(mesh_tabby_head_10);
  meshes["tabby-head"] = mesh_tabby_head_10;
  colliders["tabby-head"] = {"type": "sphere", "offset": [0.0, 0.0, 0.0], "scale": [1.0, 1.0, 1.0], "isTrigger": false};
  destructionGroups["soft-body"] ??= [];
  destructionGroups["soft-body"].push(node_tabby_head_10);

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
