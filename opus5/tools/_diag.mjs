import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle','--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 1000, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await page.goto('http://127.0.0.1:8712/index.html?pass=interaction-pass&live=1', { waitUntil: 'load' });
await page.waitForFunction('window.harnessReady === true', null, { timeout: 120000 });
await page.waitForTimeout(2500);
const status = await page.textContent('#status');
// prove the idle is actually moving between two frames
const a = await page.evaluate(() => window.catsHarness.harness.model.userData.idleTime);
await page.waitForTimeout(1200);
const c = await page.evaluate(() => window.catsHarness.harness.model.userData.idleTime);
await page.screenshot({ path: 'renders/live-check.png', clip: { x: 8, y: 30, width: 925, height: 810 } });
console.log(JSON.stringify({ status, idleAdvanced: +(c - a).toFixed(2), errors: errs.slice(0, 3) }, null, 1));
await b.close();
