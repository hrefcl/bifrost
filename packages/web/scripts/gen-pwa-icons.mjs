// Generador de íconos PWA — rasteriza la marca Bifrost (favicon.svg) con Playwright/Chromium.
// (ImageMagick sin librsvg no dibuja los strokes del SVG → se usa un motor real.)
// Uso: node scripts/gen-pwa-icons.mjs   (desde packages/web)
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../public/icons');

const ACCENT = '#1b66ff';
// Grupo del sobre (mismas coordenadas que public/favicon.svg, viewBox 100x100).
const envelope = `
  <rect x="30" y="38" width="40" height="28" rx="5" fill="none" stroke="#fff" stroke-width="3.5"/>
  <path d="M31 41 L50 55 L69 41" fill="none" stroke="#fff" stroke-width="3.5"
        stroke-linecap="round" stroke-linejoin="round"/>`;

// Ícono "any": marca completa (rect redondeado azul + sobre), esquinas transparentes.
const anySvg = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" rx="22" fill="${ACCENT}"/>${envelope}
</svg>`;

// Ícono full-bleed (maskable / apple): cuadrado azul opaco + sobre centrado en la safe-zone.
const bleedSvg = (scale) => `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" fill="${ACCENT}"/>
  <g transform="translate(50 50) scale(${scale}) translate(-50 -52)">${envelope}</g>
</svg>`;

const specs = [
  { file: 'pwa-192.png', size: 192, svg: anySvg, transparent: true },
  { file: 'pwa-512.png', size: 512, svg: anySvg, transparent: true },
  { file: 'pwa-maskable-512.png', size: 512, svg: bleedSvg(0.62), transparent: false },
  { file: 'apple-touch-icon-180.png', size: 180, svg: bleedSvg(0.7), transparent: false },
];

const html = (svg, size) => `<!doctype html><meta charset="utf-8">
<style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px}
svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;

const browser = await chromium.launch();
try {
  await mkdir(outDir, { recursive: true });
  for (const s of specs) {
    const page = await browser.newPage({
      viewport: { width: s.size, height: s.size },
      deviceScaleFactor: 1,
    });
    await page.setContent(html(s.svg, s.size), { waitUntil: 'networkidle' });
    const el = await page.$('svg');
    const buf = await el.screenshot({ omitBackground: s.transparent });
    await writeFile(resolve(outDir, s.file), buf);
    await page.close();
    console.log('✓', s.file, `${s.size}x${s.size}`);
  }
} finally {
  await browser.close();
}
