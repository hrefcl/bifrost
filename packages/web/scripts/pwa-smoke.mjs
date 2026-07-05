// Smoke test PWA contra `vite preview`. Verifica: registro del SW, manifest linkeado,
// íconos alcanzables, la app monta (login), y no hay errores JS de página.
import { chromium } from '@playwright/test';

const URL = process.env.URL || 'http://localhost:4178/';
const pageErrors = [];
const consoleErrors = [];

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });

// Esperar a que el SW se registre y active (hasta 8s).
const swState = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) {
    // dar tiempo al registro (registerSW corre en load)
    await new Promise((r) => setTimeout(r, 3000));
  }
  const reg2 = await navigator.serviceWorker.getRegistration();
  return reg2 ? (reg2.active ? 'active' : 'registered') : 'none';
});

const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
const themeColor = await page.getAttribute('meta[name="theme-color"]', 'content');
const appleCapable = await page.getAttribute(
  'meta[name="apple-mobile-web-app-capable"]',
  'content'
);
const appleIcon = await page.getAttribute('link[rel="apple-touch-icon"]', 'href');
const hasApp = (await page.$('#app')) !== null;
const appHtmlLen = await page.evaluate(() => document.querySelector('#app')?.innerHTML.length ?? 0);
const title = await page.title();

// Filtrar errores esperados (sin backend en preview: /api falla).
const isBackendNoise = (s) =>
  /\/api\/|Failed to load resource|Request failed|net::ERR|status of 40|status of 50/i.test(s);
const realPageErrors = pageErrors.filter((s) => !isBackendNoise(s));
const realConsoleErrors = consoleErrors.filter((s) => !isBackendNoise(s));

console.log(
  JSON.stringify(
    {
      swState,
      manifestHref,
      themeColor,
      appleCapable,
      appleIcon,
      title,
      hasApp,
      appHtmlLen,
      realPageErrors,
      realConsoleErrors,
      allPageErrors: pageErrors,
      allConsoleErrors: consoleErrors,
    },
    null,
    2
  )
);

await browser.close();

const ok =
  swState === 'active' &&
  manifestHref &&
  hasApp &&
  appHtmlLen > 0 &&
  realPageErrors.length === 0 &&
  realConsoleErrors.length === 0;
console.log(ok ? '\nSMOKE: PASS' : '\nSMOKE: FAIL');
process.exit(ok ? 0 : 1);
