// Verifica el comportamiento OFFLINE: con el SW activo, una recarga sin red debe seguir sirviendo
// el app-shell (precache) y la app debe mostrar el banner "sin conexión". Captura evidencia.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const URL = process.env.URL || 'http://localhost:4178/';
const outDir = '/tmp/pwa-evidence';
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); // iPhone-ish
const page = await ctx.newPage();

// 1) Carga online → registra + precachea el shell.
await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${outDir}/01-online-login.png` });

// 2) Cortar la red y recargar: el shell debe venir del SW (no "no internet" del browser).
await ctx.setOffline(true);
const resp = await page
  .goto(URL, { waitUntil: 'domcontentloaded' })
  .catch((e) => ({ error: String(e) }));
await page.waitForTimeout(1200);
const shellServed =
  (await page.$('#app')) !== null &&
  (await page.evaluate(() => (document.querySelector('#app')?.innerHTML.length ?? 0) > 0));
// El banner offline (role=status con el texto de i18n).
const offlineBannerVisible = await page.evaluate(() => {
  const el = [...document.querySelectorAll('[role="status"]')].find((n) =>
    /sin conexión|no connection/i.test(n.textContent || '')
  );
  return !!el;
});
await page.screenshot({ path: `${outDir}/02-offline-shell.png` });

console.log(
  JSON.stringify(
    {
      offlineNavStatus: resp && 'status' in resp ? resp.status() : (resp?.error ?? 'ok'),
      shellServedOffline: shellServed,
      offlineBannerVisible,
    },
    null,
    2
  )
);

await browser.close();
const ok = shellServed && offlineBannerVisible;
console.log(ok ? '\nOFFLINE: PASS' : '\nOFFLINE: FAIL');
process.exit(ok ? 0 : 1);
