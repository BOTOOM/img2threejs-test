// Projection audit: where does every named mesh actually land in reference pixels?
//
// A visual "looks wrong" is not debuggable. This projects each mesh's world
// bounding box through the review camera and prints it back in gatos.png source
// pixel coordinates, so an error can be traced to one component instead of
// being guessed at from a render.

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  options[args[index].replace(/^--/, '')] = args[index + 1];
}
const passId = options.pass ?? 'blockout';
const port = options.port ?? '8712';
const filter = options.filter ? new RegExp(options.filter, 'i') : null;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
await page.goto(`http://127.0.0.1:${port}/index.html?pass=${passId}`, { waitUntil: 'load' });
await page.waitForFunction('window.harnessReady === true', null, { timeout: 120000 });

const report = await page.evaluate(() => {
  const THREE = window.catsHarness.harness.renderer.constructor;
  void THREE;
  const harness = window.catsHarness.harness;
  harness.useReferenceCamera();
  harness.harnessUpdate?.();
  harness.model.updateWorldMatrix(true, true);
  const camera = harness.camera;
  camera.updateMatrixWorld(true);

  // crop origin of the traced matte inside gatos.png
  const CROP_X = 225;
  const CROP_Y = 140;
  const W = 925;
  const H = 810;

  const rows = [];
  const globalBox = { minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9 };
  harness.model.traverse((object) => {
    if (!object.isMesh && !object.isInstancedMesh) return;
    const geometry = object.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    let minX = 1e9; let minY = 1e9; let maxX = -1e9; let maxY = -1e9;
    let minZ = 1e9;
    for (let corner = 0; corner < 8; corner += 1) {
      const point = {
        x: corner & 1 ? box.max.x : box.min.x,
        y: corner & 2 ? box.max.y : box.min.y,
        z: corner & 4 ? box.max.z : box.min.z,
      };
      const vector = new object.position.constructor(point.x, point.y, point.z);
      vector.applyMatrix4(object.matrixWorld);
      minZ = Math.min(minZ, vector.z);
      vector.project(camera);
      const px = ((vector.x + 1) / 2) * W + CROP_X;
      const py = ((1 - vector.y) / 2) * H + CROP_Y;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    globalBox.minX = Math.min(globalBox.minX, minX);
    globalBox.maxX = Math.max(globalBox.maxX, maxX);
    globalBox.minY = Math.min(globalBox.minY, minY);
    globalBox.maxY = Math.max(globalBox.maxY, maxY);
    rows.push({
      name: object.name || '(unnamed)',
      src: [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)],
      widthPx: Math.round(maxX - minX),
      heightPx: Math.round(maxY - minY),
      frontZ: Number(minZ.toFixed(3)),
      visible: object.visible,
    });
  });
  return {
    rows,
    unionSrc: [
      Math.round(globalBox.minX), Math.round(globalBox.minY),
      Math.round(globalBox.maxX), Math.round(globalBox.maxY),
    ],
    cameraFov: camera.fov,
    cameraPosition: camera.position.toArray().map((v) => Number(v.toFixed(4))),
  };
});

const rows = filter ? report.rows.filter((row) => filter.test(row.name)) : report.rows;
console.log(`camera fov=${report.cameraFov} pos=${JSON.stringify(report.cameraPosition)}`);
console.log(`union src bbox = ${JSON.stringify(report.unionSrc)}  (matte union is [234,148,1130,946])`);
console.log('');
console.log('name'.padEnd(42) + 'src x0,y0,x1,y1'.padEnd(26) + 'w'.padStart(5) + 'h'.padStart(5) + '  frontZ');
for (const row of rows) {
  console.log(
    row.name.padEnd(42)
    + row.src.join(',').padEnd(26)
    + String(row.widthPx).padStart(5)
    + String(row.heightPx).padStart(5)
    + '  ' + String(row.frontZ).padStart(7),
  );
}
console.log(`\n${rows.length} meshes shown of ${report.rows.length}`);
await browser.close();
