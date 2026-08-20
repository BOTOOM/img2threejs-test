import { chromium } from 'playwright';

const URL = 'http://localhost:8080';
const OUT = 'render-open.png';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.click('#open');
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT, fullPage: false });
  await browser.close();
  console.log('Screenshot saved to', OUT);
}
main().catch(e => { console.error(e); process.exit(1); });
