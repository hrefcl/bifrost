// Sirve dist/ con la CSP EXACTA de nginx (nginx.conf) para verificar que el SW/manifest/workbox
// registran bajo la política de producción — `vite preview` NO aplica CSP, así que el smoke test
// anterior no la ejercía. Uso: node scripts/serve-with-csp.mjs [puerto]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../dist');
const port = Number(process.argv[2] ?? 4188);

// CSP idéntica a nginx.conf (MEET_CSP_CONNECT vacío = Meet OFF, caso por defecto).
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self' data:; img-src 'self' data: https:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'self'";

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let filePath = resolve(root, '.' + urlPath);
  try {
    const s = await stat(filePath).catch(() => null);
    if (!s || s.isDirectory()) {
      // fallback SPA (como nginx try_files … /index.html) — salvo /api (no existe aquí).
      filePath = resolve(root, 'index.html');
    }
    const body = await readFile(filePath);
    const ext = extname(filePath);
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // sw.js e index.html no se cachean (como nginx location /).
    if (ext === '.html' || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(port, () => console.log(`CSP server on http://localhost:${String(port)}/`));
