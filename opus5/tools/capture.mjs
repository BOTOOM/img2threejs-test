// Deterministic capture driver.
//
// Loads the viewer for a given build pass, waits for the harness to report ready,
// then asks the page to render each requested view and POST the PNG back to
// tools/shotserver.py. Rendering happens inside the page so the evaluation
// renderer, camera and material-strip logic live in one place (src/viewer.ts)
// rather than being duplicated here.
//
//   node tools/capture.mjs --pass blockout --set gate
//   node tools/capture.mjs --pass material-pass --set full --idle 0,3,6,9

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  options[args[index].replace(/^--/, '')] = args[index + 1];
}
const passId = options.pass ?? 'blockout';
const set = options.set ?? 'gate';
const port = options.port ?? '8712';

// `clay` strips every material to one mid-grey: this is the map-stripped evidence
// the silhouette gates require, so IoU can only come from geometry.
// Whiskers are hidden for silhouette work: a 1-2px hair carries no silhouette
// information but does move the bounding box, corrupting scale/aspect metrics.
const SETS = {
  gate: [
    { name: `${passId}-reference-clay`, mode: 'clay', view: 'reference', hideWhiskers: true },
    { name: `${passId}-orbit-left-40`, mode: 'clay', view: 'orbit-left-40', hideWhiskers: true },
    { name: `${passId}-orbit-right-40`, mode: 'clay', view: 'orbit-right-40', hideWhiskers: true },
    { name: `${passId}-thickness-axis`, mode: 'clay', view: 'thickness-axis', hideWhiskers: true },
  ],
  full: [
    { name: `${passId}-reference-clay`, mode: 'clay', view: 'reference', hideWhiskers: true },
    { name: `${passId}-reference`, mode: 'beauty', view: 'reference', hideWhiskers: true },
    { name: `${passId}-reference-whiskers`, mode: 'beauty', view: 'reference', hideWhiskers: false },
    { name: `${passId}-beauty-opaque`, mode: 'beauty', view: 'reference', hideWhiskers: false,
      transparent: false },
    { name: `${passId}-orbit-left-40`, mode: 'beauty', view: 'orbit-left-40', hideWhiskers: false },
    { name: `${passId}-orbit-right-40`, mode: 'beauty', view: 'orbit-right-40', hideWhiskers: false },
    { name: `${passId}-thickness-axis`, mode: 'beauty', view: 'thickness-axis', hideWhiskers: false },
    { name: `${passId}-orbit-back`, mode: 'beauty', view: 'orbit-back', hideWhiskers: false },
    { name: `${passId}-orbit-high`, mode: 'beauty', view: 'orbit-high', hideWhiskers: false },
  ],
  orbit: [
    { name: `${passId}-orbit-left-40`, mode: 'clay', view: 'orbit-left-40', hideWhiskers: true },
    { name: `${passId}-orbit-right-40`, mode: 'clay', view: 'orbit-right-40', hideWhiskers: true },
    { name: `${passId}-thickness-axis`, mode: 'clay', view: 'thickness-axis', hideWhiskers: true },
    { name: `${passId}-orbit-back`, mode: 'clay', view: 'orbit-back', hideWhiskers: true },
  ],
};

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
  ],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

await page.goto(`http://127.0.0.1:${port}/index.html?pass=${passId}`, {
  waitUntil: 'load',
  timeout: 90000,
});
await page.waitForFunction('window.harnessReady === true', null, { timeout: 120000 });

const requests = SETS[set];
if (!requests) throw new Error(`unknown capture set ${set}`);
const captured = await page.evaluate(
  async (list) => window.catsHarness.captureAll(list),
  requests,
);
await page.evaluate(async (name) => window.catsHarness.saveManifest(name), `parts-${passId}`);

// Idle scrub frames prove the loop actually moves and that it wraps cleanly.
if (options.idle) {
  const times = options.idle.split(',').map(Number);
  for (const time of times) {
    await page.evaluate((t) => window.catsHarness.setIdleTime(t), time);
    await page.evaluate(
      async (name) => window.catsHarness.capture({
        name, mode: 'beauty', view: 'reference', hideWhiskers: false, transparent: false,
      }),
      `${passId}-idle-t${String(time).replace('.', '_')}`,
    );
  }
  await page.evaluate(() => window.catsHarness.setIdleTime(0));
}

const runtime = await page.evaluate(() => {
  const model = window.catsHarness.harness.model;
  return {
    hasTick: typeof model.userData.tick === 'function',
    idleLoopSeconds: model.userData.idleLoopSeconds ?? null,
    animationPivots: Object.keys(model.userData.animationPivots ?? {}),
    idleChannels: model.userData.idleChannels ?? [],
  };
});

console.log(JSON.stringify({ passId, set, captured, runtime, problems }, null, 2));
await browser.close();
if (problems.length) process.exitCode = 1;
