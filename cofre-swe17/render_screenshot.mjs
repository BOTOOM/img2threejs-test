import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 8123;
const OUT = path.join(__dirname, 'render.png');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function serve(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(serve);
await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`serving on http://localhost:${PORT}`);

const browser = await chromium.launch({
  headless: true,
  executablePath: '/usr/bin/google-chrome-stable',
});
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });

// Wait for WebGL to render a few frames.
await page.waitForTimeout(1200);

await page.screenshot({ path: OUT, type: 'png' });
console.log('render saved to', OUT);

await browser.close();
server.close();
