import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Dev-only endpoint: POST /save-shot?name=<file> with a data-URL body writes the
// PNG into ./renders/ so headless captures stay inside this workspace.
function saveShotPlugin(): Plugin {
  return {
    name: 'save-shot',
    configureServer(server) {
      server.middlewares.use('/save-manifest', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('method'); return; }
        const url = new URL(req.url ?? '', 'http://localhost');
        const file = (url.searchParams.get('file') ?? 'manifest.json').replace(/[^a-zA-Z0-9_.-]/g, '');
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          writeFileSync(file, body);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ saved: file, bytes: body.length }));
        });
      });
      server.middlewares.use('/save-shot', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('method'); return; }
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = (url.searchParams.get('name') ?? 'shot').replace(/[^a-zA-Z0-9_-]/g, '');
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const match = /^data:image\/png;base64,(.+)$/.exec(body);
          if (!match) { res.statusCode = 400; res.end('bad data url'); return; }
          mkdirSync('renders', { recursive: true });
          const file = join('renders', `${name}.png`);
          writeFileSync(file, Buffer.from(match[1], 'base64'));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ saved: file, bytes: Buffer.byteLength(match[1], 'base64') }));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [saveShotPlugin()],
  server: { port: 5199, strictPort: true },
});
