import * as THREE from 'three';
/**
 * Hand-written runtime layer over the generated factory.
 *
 * Why this file exists: generate_threejs_factory.py emits geometry, materials
 * and `userData.sculptRuntime`, but it does not emit `userData.tick` and it puts
 * every component's pivot at that component's own centre. Neither is good enough
 * for the requested idle:
 *
 *  - a head must rotate about the neck base, not about the middle of the skull;
 *  - an ear must rotate about its base, not about its midpoint;
 *  - a tail only reads as a tail if each segment inherits its parent's rotation,
 *    so a travelling wave can run down the chain.
 *
 * So this layer *re-parents* the generated nodes into anatomically correct pivot
 * groups and installs a deterministic looping idle. It never edits the generated
 * file, so a pass can be regenerated without losing the rig.
 *
 * The loop period is 12 s and every driver is an integer harmonic of it, which
 * is what makes the loop seamless: there is no pop at the wrap point because
 * every channel returns to exactly its starting value.
 */
const LOOP_SECONDS = 12;
const TWO_PI = Math.PI * 2;
function insertPivot(node, pivotOffset, name) {
    const parent = node.parent;
    const pivot = new THREE.Group();
    pivot.name = name;
    pivot.position.copy(node.position).add(pivotOffset);
    pivot.rotation.copy(node.rotation);
    pivot.scale.copy(node.scale);
    node.position.set(-pivotOffset.x, -pivotOffset.y, -pivotOffset.z);
    node.rotation.set(0, 0, 0);
    node.scale.set(1, 1, 1);
    (parent ?? node).add(pivot);
    pivot.add(node);
    return pivot;
}
/**
 * Group the three eye layers under one pivot so a blink can squash all of them
 * together. Without this the pupil would keep its full height while the iris
 * closed, which reads as a glitch rather than an eyelid.
 */
function groupEye(nodes, key, side) {
    const iris = nodes[`${key}-eye-${side}-iris`];
    if (!iris)
        return null;
    const layers = [
        iris,
        nodes[`${key}-eye-${side}-pupil`],
        nodes[`${key}-eye-${side}-cornea`],
    ].filter((layer) => Boolean(layer));
    const parent = iris.parent;
    if (!parent)
        return null;
    const group = new THREE.Group();
    group.name = `${key}-eye-${side}__blink`;
    group.position.copy(iris.position);
    parent.add(group);
    for (const layer of layers) {
        layer.position.sub(group.position);
        group.add(layer);
    }
    return group;
}
/**
 * Re-chain the tail. The generator already pivots each endpoint-driven segment at
 * its own joint (node.position = attachment.localStart), but all five segments are
 * siblings under the haunch, so rotating one would leave the rest behind. Chaining
 * them makes each segment's rotation compose down the tail.
 */
function chainTail(nodes, key) {
    const chain = [];
    for (let index = 1; index <= 5; index += 1) {
        const segment = nodes[`${key}-tail-segment-${index}`];
        if (!segment)
            break;
        chain.push(segment);
    }
    for (let index = chain.length - 1; index >= 1; index -= 1) {
        const child = chain[index];
        const parent = chain[index - 1];
        child.position.sub(parent.position);
        parent.add(child);
    }
    return chain;
}
function buildRig(model, key, blinkAt, flickAt) {
    const runtime = model.userData.sculptRuntime;
    const nodes = runtime.nodes;
    const head = nodes[`${key}-head`];
    // The head's own actionProfile puts its pivot at the neck base, 0.130 world
    // units below the skull centre for the black cat and 0.140 for the tabby -
    // measured as crown-to-chin over two, from the lathe profile.
    const neckDrop = key === 'bc' ? 0.13 : 0.14;
    const headPivot = head
        ? insertPivot(head, new THREE.Vector3(0, -neckDrop, 0), `${key}-head__anim`)
        : null;
    const ears = [];
    ['left', 'right'].forEach((side, sideIndex) => {
        const ear = nodes[`${key}-ear-${side}`];
        if (!ear)
            return;
        const component = ear.userData.sculptComponent;
        const local = component?.actionProfile?.pivot?.localPosition ?? [0, -0.06, 0];
        const rest = ear.rotation.clone();
        const pivot = insertPivot(ear, new THREE.Vector3(local[0], local[1], local[2]), `${key}-ear-${side}__anim`);
        ears.push({ pivot, restRotation: rest, flickAt: flickAt[sideIndex] ?? 4.0 });
    });
    const eyes = ['left', 'right']
        .map((side) => groupEye(nodes, key, side))
        .filter((group) => Boolean(group));
    return {
        key,
        torso: nodes[`${key}-torso`] ?? null,
        haunch: nodes[`${key}-haunch`] ?? null,
        headPivot,
        headRest: headPivot ? headPivot.rotation.clone() : new THREE.Euler(),
        ears,
        eyes,
        tail: chainTail(nodes, key),
        blinkAt,
    };
}
/** 0 while open, 1 at full closure. A short asymmetric close/open, not a sine. */
function blinkAmount(time, events) {
    const closeSeconds = 0.07;
    const openSeconds = 0.13;
    let amount = 0;
    for (const event of events) {
        // Evaluate against the wrapped loop so a blink that straddles the seam still
        // resolves identically on both sides of it.
        let delta = time - event;
        if (delta < -LOOP_SECONDS / 2)
            delta += LOOP_SECONDS;
        if (delta > LOOP_SECONDS / 2)
            delta -= LOOP_SECONDS;
        if (delta < 0 && delta > -closeSeconds) {
            amount = Math.max(amount, 1 + delta / closeSeconds);
        }
        else if (delta >= 0 && delta < openSeconds) {
            amount = Math.max(amount, 1 - delta / openSeconds);
        }
    }
    return amount;
}
function applyRig(rig, time) {
    const phase = (harmonic, offset = 0) => Math.sin((TWO_PI * harmonic * time) / LOOP_SECONDS + offset);
    const subjectOffset = rig.key === 'bc' ? 0 : 1.7;
    // Breathing: the barrel expands, the haunch follows at a third of the amount,
    // and the head does NOT scale - a head that inflates reads as a balloon.
    const breath = phase(4, subjectOffset);
    if (rig.torso) {
        rig.torso.scale.set(1 + breath * 0.011, 1 + breath * 0.006, 1 + breath * 0.013);
    }
    if (rig.haunch) {
        rig.haunch.scale.set(1 + breath * 0.004, 1, 1 + breath * 0.005);
    }
    // Head: a slow figure-of-eight, one cycle of yaw against two of pitch.
    if (rig.headPivot) {
        rig.headPivot.rotation.set(rig.headRest.x + phase(2, 1.1 + subjectOffset) * 0.018, rig.headRest.y + phase(1, subjectOffset) * 0.045, rig.headRest.z + phase(1, 0.6 + subjectOffset) * 0.012);
    }
    // Ears: a constant small drift plus a fast flick at a fixed moment in the loop.
    for (const ear of rig.ears) {
        const flick = blinkAmount(time, [ear.flickAt]);
        ear.pivot.rotation.set(ear.restRotation.x + phase(3, subjectOffset) * 0.02 - flick * 0.16, ear.restRotation.y + phase(2, 0.9 + subjectOffset) * 0.025, ear.restRotation.z + flick * 0.1);
    }
    // Blink: both eyes of a subject close together.
    const blink = blinkAmount(time, rig.blinkAt);
    for (const eye of rig.eyes) {
        eye.scale.set(1, Math.max(0.06, 1 - blink * 0.94), 1);
    }
    // Tail: a travelling wave, each segment lagging the one before it, so the sway
    // propagates from base to tip instead of the whole tail swinging as a bar.
    rig.tail.forEach((segment, index) => {
        const lag = index * 0.72;
        const amplitude = 0.055 + index * 0.022;
        segment.rotation.set(phase(2, 2.4 + lag + subjectOffset) * amplitude * 0.4, phase(2, lag + subjectOffset) * amplitude, phase(1, 1.2 + lag + subjectOffset) * amplitude * 0.5);
    });
}
/*
 * radialGradientTexture() was removed rather than left unused.
 *
 * The first attempt at the iris drew a radial gradient (measured stops: rgb(19,18,10)
 * pupil core -> rgb(188,190,96) annulus -> dark limbal ring) and applied it as the
 * iris albedo. It does not work: a UV sphere is mapped equirectangularly, so the
 * canvas centre lands on the sphere's equator, not on the pole facing the camera.
 * The render showed a flat pale disc with no ring at all. The annulus now comes from
 * geometry instead - a flat-albedo iris sphere with the dilated pupil sphere seated
 * 0.30 diameters proud of it, covering the middle - which is also how the reference
 * eye is actually built.
 */
/**
 * Reference-derived procedural mackerel stripes.
 *
 * The reference flank crop carries the real measured colours, and the skill's rule
 * is to prefer the reference's own pixels over an invented pattern. But tiling a
 * 240x280 photo crop across a revolved barrel produced hard UV seams and a
 * light/dark patchwork that read as wood veneer, not fur - the tiling artefact was
 * doing more damage than a clean pattern. So the palette stays measured
 * (base rgb(142,105,65) lit, rgb(70,47,27) shaded, stripe rgb(41,23,9)) and only the
 * *layout* becomes procedural: 22 vertical bands, soft agouti edges, deterministic
 * jitter. Roughness, normal and AO still come from the extracted reference maps.
 */
function mackerelStripeTexture(spec) {
    const width = 1024;
    const height = 512;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context)
        return new THREE.Texture();
    const palette = (spec.colorVariation?.palette) ?? [
        '#291709', '#462F1B', '#7C5A3F', '#A88460',
    ];
    const stripe = palette[0];
    const shaded = palette[1];
    const base = palette[2];
    const highlight = palette[palette.length - 1];
    // vertical value gradient: darker along the spine, lighter toward the belly
    const backdrop = context.createLinearGradient(0, 0, 0, height);
    backdrop.addColorStop(0, shaded);
    backdrop.addColorStop(0.45, base);
    backdrop.addColorStop(1, highlight);
    context.fillStyle = backdrop;
    context.fillRect(0, 0, width, height);
    // deterministic jitter so a re-render is byte-identical
    let seed = 0x9e3779b9;
    const random = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return ((seed >>> 0) % 10000) / 10000;
    };
    const count = 22;
    context.globalAlpha = 0.82;
    for (let index = 0; index < count; index += 1) {
        const centre = ((index + 0.5) / count) * width + (random() - 0.5) * 10;
        const thickness = width * (0.012 + random() * 0.010);
        const band = context.createLinearGradient(centre - thickness, 0, centre + thickness, 0);
        band.addColorStop(0, 'rgba(0,0,0,0)');
        band.addColorStop(0.5, stripe);
        band.addColorStop(1, 'rgba(0,0,0,0)');
        context.fillStyle = band;
        // stripes lean and break up rather than running as straight bars
        const lean = (random() - 0.5) * 22;
        context.beginPath();
        context.moveTo(centre - thickness, 0);
        context.lineTo(centre + thickness, 0);
        context.lineTo(centre + thickness + lean, height * 0.62);
        context.lineTo(centre - thickness + lean, height * 0.62);
        context.closePath();
        context.fill();
    }
    context.globalAlpha = 1;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    return texture;
}
/**
 * Flatten contrast AND re-tint an extracted albedo crop to its authored albedo.
 *
 * Two problems with using a reference crop directly as albedo, both measured:
 *
 *  1. Tiling a 240x280 fur crop across a revolved barrel leaves UV seams and a
 *     light/dark patchwork that reads as wood veneer. `mix` blends each pixel
 *     toward the crop's own mean to kill that.
 *  2. The crop still contains the photo's warm low-sun key, so using it as albedo
 *     and then lighting it warmly double-applies the lighting. The white bib is
 *     the clearest case: its crop palette runs #F6D7B2..#83582D, and the render
 *     came out rgb(211,169,115) - r-b of 96 - against the reference's
 *     rgb(240,207,169) with r-b of 71. Re-centring the crop's mean onto the
 *     authored de-lit albedo keeps the spatial detail and removes the baked key.
 */
function softenAlbedo(source, mix, target) {
    const image = source.image;
    if (!image?.width)
        return source;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context)
        return source;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = data.data;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    for (let index = 0; index < pixels.length; index += 4) {
        sumR += pixels[index];
        sumG += pixels[index + 1];
        sumB += pixels[index + 2];
    }
    const count = pixels.length / 4;
    const meanR = sumR / count;
    const meanG = sumG / count;
    const meanB = sumB / count;
    // Re-centre onto the authored albedo: scale each channel so the crop's mean
    // becomes the target. Guard the divisor so a near-black crop cannot blow up.
    const scaleR = target ? (target.r * 255) / Math.max(6, meanR) : 1;
    const scaleG = target ? (target.g * 255) / Math.max(6, meanG) : 1;
    const scaleB = target ? (target.b * 255) / Math.max(6, meanB) : 1;
    for (let index = 0; index < pixels.length; index += 4) {
        const r = pixels[index] * (1 - mix) + meanR * mix;
        const g = pixels[index + 1] * (1 - mix) + meanG * mix;
        const b = pixels[index + 2] * (1 - mix) + meanB * mix;
        pixels[index] = Math.min(255, r * scaleR);
        pixels[index + 1] = Math.min(255, g * scaleG);
        pixels[index + 2] = Math.min(255, b * scaleB);
    }
    context.putImageData(data, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = source.wrapS;
    texture.wrapT = source.wrapT;
    texture.repeat.copy(source.repeat);
    texture.anisotropy = source.anisotropy;
    texture.needsUpdate = true;
    return texture;
}
function readBase(value, fallback) {
    if (typeof value === 'number')
        return value;
    if (value && typeof value === 'object') {
        const record = value;
        if (typeof record.base === 'number')
            return record.base;
    }
    return fallback;
}
/**
 * Apply each material's declared `textureRouting` and restore the scalars the
 * generator clamps.
 *
 * Two generator behaviours have to be corrected here, and both are documented in
 * the spec rather than silently patched:
 *
 *  1. When a roughnessMap exists the generator sets `material.roughness = 1` and
 *     lets the map carry everything. That is right for fur and wrong for a cornea,
 *     so the authored roughness/clearcoat/transmission are re-applied.
 *  2. `sheenColor` and `sheenRoughness` are read from the top level of the material
 *     spec; anything nested is ignored and sheenColor silently defaults to WHITE.
 *     A white sheen at 0.55 lifted the near-black coat to rgb(98,78,59) - the
 *     "black cat" rendered beige. The spec now emits them top-level, and this
 *     re-asserts them in case a regenerated factory drops them again.
 */
export function applyMaterialRouting(model) {
    const report = [];
    const seen = new Set();
    model.traverse((object) => {
        const mesh = object;
        const material = mesh.material;
        if (!material || Array.isArray(material) || seen.has(material.uuid))
            return;
        seen.add(material.uuid);
        const spec = material.userData.sculptMaterial;
        if (!spec)
            return;
        const routing = spec.textureRouting;
        const useMaps = routing?.useReferenceMaps !== false;
        if (!useMaps) {
            material.map = null;
            material.roughnessMap = null;
            material.normalMap = null;
            material.aoMap = null;
            // A radial gradient on a UV sphere does NOT make concentric rings around the
            // front pole - the sphere's UV is equirectangular, so the canvas centre lands
            // on the equator. The iris annulus therefore comes from geometry (a flat-colour
            // iris sphere with the dilated pupil sphere covering its middle), not from a
            // gradient map. Flat measured albedo is the correct choice here.
            if (typeof spec.baseColor === 'string') {
                material.map = null;
                material.color.set(spec.baseColor);
            }
        }
        // Reference albedo crops carry the right colour but the wrong contrast once
        // tiled: a 240x280 fur crop repeated across a revolved barrel reads as wood
        // veneer. Blending each crop toward its own mean keeps the measured hue and
        // kills the plank look. This is a contrast reduction, not a colour change.
        if (useMaps && material.map?.image && /coat-|fur-white|membrane|nose-/.test(String(spec.id))) {
            const target = typeof spec.baseColor === 'string'
                ? new THREE.Color().setStyle(spec.baseColor).convertSRGBToLinear()
                : undefined;
            const authored = typeof spec.baseColor === 'string'
                ? new THREE.Color(spec.baseColor)
                : undefined;
            void target;
            material.map = softenAlbedo(material.map, 0.45, authored);
            material.color.set('#ffffff');
        }
        if (spec.id === 'coat-tabby-agouti') {
            material.map = mackerelStripeTexture(spec);
            material.color.set('#ffffff');
        }
        material.roughness = Math.min(1, Math.max(0.02, readBase(spec.roughness, material.roughness)));
        material.metalness = readBase(spec.metalness, 0);
        if (typeof spec.clearcoat !== 'undefined') {
            material.clearcoat = readBase(spec.clearcoat, 0);
            material.clearcoatRoughness = readBase(spec.clearcoatRoughness, 0.1);
        }
        if (typeof spec.transmission !== 'undefined') {
            material.transmission = readBase(spec.transmission, 0);
            material.thickness = readBase(spec.thickness, 0.01);
            material.ior = readBase(spec.ior, 1.5);
            if (typeof spec.attenuationColor === 'string') {
                material.attenuationColor.set(spec.attenuationColor);
            }
        }
        if (typeof spec.sheenColor === 'string') {
            material.sheen = readBase(spec.sheen, material.sheen);
            material.sheenColor.set(spec.sheenColor);
            material.sheenRoughness = typeof spec.sheenRoughness === 'number' ? spec.sheenRoughness : 0.4;
        }
        if (spec.transparent === true) {
            material.transparent = true;
            material.opacity = typeof spec.opacity === 'number' ? spec.opacity : 1;
            material.depthWrite = false;
        }
        if (typeof spec.envMapIntensity === 'number') {
            material.envMapIntensity = spec.envMapIntensity;
        }
        material.needsUpdate = true;
        report.push({
            id: spec.id,
            useReferenceMaps: useMaps,
            roughness: Number(material.roughness.toFixed(3)),
            sheen: Number((material.sheen ?? 0).toFixed(3)),
            sheenColor: `#${material.sheenColor?.getHexString() ?? ''}`,
            clearcoat: Number((material.clearcoat ?? 0).toFixed(3)),
            transmission: Number((material.transmission ?? 0).toFixed(3)),
            envMapIntensity: Number((material.envMapIntensity ?? 0).toFixed(3)),
            hasMap: Boolean(material.map),
        });
    });
    return report;
}
export function installCatsRuntime(model) {
    const rigs = [
        buildRig(model, 'bc', [3.1, 8.4], [6.2, 6.45]),
        buildRig(model, 'tb', [1.7, 7.05, 10.9], [2.8, 9.8]),
    ];
    const applyIdle = (time) => {
        const wrapped = ((time % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS;
        for (const rig of rigs)
            applyRig(rig, wrapped);
    };
    // Runtime contract for the host app: advance with a delta, or scrub with
    // setIdleTime for deterministic frame-by-frame capture.
    model.userData.idleTime = 0;
    model.userData.idleLoopSeconds = LOOP_SECONDS;
    model.userData.tick = (deltaSeconds) => {
        const previous = model.userData.idleTime ?? 0;
        const next = previous + (Number.isFinite(deltaSeconds) ? deltaSeconds : 0);
        model.userData.idleTime = next;
        applyIdle(next);
    };
    model.userData.setIdleTime = (time) => {
        model.userData.idleTime = time;
        applyIdle(time);
    };
    model.userData.idleChannels = [
        'breathing: torso and haunch scale, 4 cycles per 12 s loop; the head never scales',
        'head sway: 1 cycle of yaw against 2 of pitch about the neck base',
        'ear drift and flick: 3-cycle drift plus a fixed fast flick per ear',
        'blink: 2 events for the black cat, 3 for the tabby; both eyes of a subject together',
        'tail sway: travelling wave, each of the 5 segments lagging the previous by 0.72 rad',
    ];
    const rigNodes = {};
    for (const rig of rigs) {
        if (rig.headPivot)
            rigNodes[`${rig.key}-head-pivot`] = rig.headPivot;
        rig.ears.forEach((ear, index) => {
            rigNodes[`${rig.key}-ear-pivot-${index === 0 ? 'left' : 'right'}`] = ear.pivot;
        });
        rig.eyes.forEach((eye, index) => {
            rigNodes[`${rig.key}-eye-blink-${index === 0 ? 'left' : 'right'}`] = eye;
        });
        rig.tail.forEach((segment, index) => {
            rigNodes[`${rig.key}-tail-pivot-${index + 1}`] = segment;
        });
    }
    model.userData.animationPivots = rigNodes;
    applyIdle(0);
    return { rigs, applyIdle };
}
/**
 * Build the lighting rig from the spec's own lightingFromPhoto evidence.
 *
 * The generated look-dev rig puts its key at (-4.5, 7.5, 5.0) - up and to the
 * LEFT. The reference says otherwise, and says it four times: the corneal
 * specular sits at the upper-RIGHT of all four pupils, and both cats carry a warm
 * rim on their camera-right edges (black-cat ear p90 rgb(106,68,45) against a
 * rgb(60,49,41) body median). So the rig is rebuilt from the recorded direction
 * vectors instead of from a generic preset. `intensityRelative` is scaled by
 * KEY_WATTS so the relative weights in the spec survive an absolute-intensity
 * change in one place.
 */
export function installPhotoLighting(scene, lightsGroup, renderer) {
    const evidence = (lightsGroup.userData.lightingFromPhoto ?? []);
    const KEY_WATTS = 3.0;
    const DISTANCE = 4.2;
    lightsGroup.clear();
    const report = [];
    for (const entry of evidence) {
        const intensity = (entry.intensityRelative ?? 0) * KEY_WATTS;
        const direction = entry.directionFromSubject;
        if (entry.type === 'hemisphere') {
            const light = new THREE.HemisphereLight(new THREE.Color(entry.skyColorHex ?? '#ffffff'), new THREE.Color(entry.groundColorHex ?? '#404040'), intensity);
            light.name = entry.id;
            lightsGroup.add(light);
            report.push({ id: entry.id, role: entry.role, kind: 'hemisphere', intensity });
            continue;
        }
        if (entry.type === 'tone-mapping') {
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = entry.exposure ?? 1.0;
            renderer.outputColorSpace = THREE.SRGBColorSpace;
            report.push({
                id: entry.id, role: entry.role, kind: 'camera-response',
                toneMapping: 'ACESFilmic', exposure: renderer.toneMappingExposure,
            });
            continue;
        }
        if (!direction)
            continue;
        const light = new THREE.DirectionalLight(new THREE.Color(entry.colorHex ?? '#ffffff'), intensity);
        light.name = entry.id;
        const unit = new THREE.Vector3(direction[0], direction[1], direction[2]).normalize();
        light.position.copy(unit).multiplyScalar(DISTANCE);
        light.target.position.set(0, -0.1, 0);
        lightsGroup.add(light.target);
        // Only the key casts: a second shadow-caster would double the contact shadow
        // under every paw, and the reference shows one shadow direction.
        if (entry.role === 'key') {
            light.castShadow = true;
            light.shadow.mapSize.set(2048, 2048);
            light.shadow.bias = -0.0004;
            light.shadow.normalBias = 0.012;
            light.shadow.radius = 5;
            light.shadow.camera.near = 1.0;
            light.shadow.camera.far = 9.0;
            light.shadow.camera.left = -0.75;
            light.shadow.camera.right = 0.75;
            light.shadow.camera.top = 0.75;
            light.shadow.camera.bottom = -0.75;
            light.shadow.camera.updateProjectionMatrix();
        }
        lightsGroup.add(light);
        report.push({
            id: entry.id, role: entry.role, kind: 'directional', intensity,
            position: light.position.toArray().map((value) => Number(value.toFixed(3))),
            castShadow: light.castShadow,
        });
    }
    // Contact shadow receiver: the reference shows soft occlusion under all six
    // visible paws and both haunches. Without a receiver the cats float.
    const seat = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), new THREE.ShadowMaterial({ opacity: 0.45, color: 0x2a1d12 }));
    seat.name = 'contact-shadow-receiver';
    seat.rotation.x = -Math.PI / 2;
    seat.position.y = -0.393;
    seat.receiveShadow = true;
    lightsGroup.add(seat);
    report.push({ id: 'contact-shadow-receiver', role: 'contact-shadow', kind: 'shadow-plane',
        opacity: 0.45, y: -0.393 });
    scene.userData.lightingRig = report;
    return report;
}
//# sourceMappingURL=catsRuntime.js.map