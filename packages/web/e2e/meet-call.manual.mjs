/**
 * E2E MANUAL de la llamada Bifrost Meet (LiveKit) — NO corre en la CI estándar (el e2e local no tiene
 * LiveKit). Se ejecuta a mano contra un box YA DEPLOYADO con Meet activo, para re-verificar el flujo de
 * llamada de 2 participantes tras cualquier cambio en MeetCallView/MeetJoinView (lifecycle frágil, ver
 * TD-MEET-CALL-E2E). Es un script node standalone (no un spec de Playwright) → el runner de la CI no lo toma.
 *
 * QUÉ VERIFICA (end-to-end real, media bidireccional):
 *   login admin → aceptar compliance → crear sala personal (API) → 2 browsers separados (fake media) joinean
 *   la misma sala → ambos llegan a status='connected' (sin quedar en "Conectando…") y renderizan ≥2 video
 *   tiles (su cámara + la del otro). Exit 0 si OK, 1 si falla.
 *
 * USO:
 *   BOX_URL=https://webmail.tudominio.app BOX_IP=1.2.3.4 \
 *   ADMIN_EMAIL=admin@tudominio.app ADMIN_PW='...' MAIL_HOST=mail.tudominio.app \
 *   node packages/web/e2e/meet-call.manual.mjs
 *
 * BOX_IP fuerza la resolución (host-resolver-rules) al box, así funciona aunque el DNS aún no propagó o el
 * cert Let's Encrypt sea nuevo (ignoreHTTPSErrors). Requiere @playwright/test instalado (ya está en el web).
 */
import { chromium } from '@playwright/test';

const BOX_URL = process.env.BOX_URL ?? 'https://webmail.aulion.app';
const BOX_IP = process.env.BOX_IP ?? '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@aulion.app';
const ADMIN_PW = process.env.ADMIN_PW ?? '';
const MAIL_HOST = process.env.MAIL_HOST ?? `mail.${new URL(BOX_URL).hostname.replace(/^webmail\./, '')}`;
const host = new URL(BOX_URL).hostname;
const meetHost = `meet.${host.replace(/^webmail\./, '')}`;

if (!ADMIN_PW) {
  console.error('Falta ADMIN_PW (clave del admin). Ver el header del script para el uso.');
  process.exit(2);
}

/** fetch contra el box por DNS real (BOX_URL). El cert se ignora vía NODE_TLS_REJECT_UNAUTHORIZED=0 (box de
 *  prueba con cert nuevo). El browser sí usa host-resolver-rules(BOX_IP) por si el DNS aún no propagó. */
async function api(path, { method = 'GET', token, body } = {}) {
  return fetch(`${BOX_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function main() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // cert nuevo/self-signed del box en pruebas
  // 1) login admin
  const loginRes = await api('/api/auth/login', {
    method: 'POST',
    body: {
      email: ADMIN_EMAIL,
      password: ADMIN_PW,
      imapHost: MAIL_HOST,
      imapPort: 993,
      imapSecure: true,
      smtpHost: MAIL_HOST,
      smtpPort: 465,
      smtpSecure: true,
    },
  });
  const login = await loginRes.json();
  const token = login.accessToken;
  if (!token) throw new Error(`login falló: ${JSON.stringify(login).slice(0, 200)}`);

  // 2) aceptar compliance (el gate bloquea acciones si no está aceptado en un box nuevo)
  for (const doc of ['terms-of-service', 'privacy-policy']) {
    await api('/api/compliance/accept', {
      method: 'POST',
      token,
      body: { documentKey: doc, version: 1, method: 'explicit_click' },
    }).catch(() => undefined);
  }

  // 3) crear sala personal
  const roomRes = await api('/api/meet/rooms', {
    method: 'POST',
    token,
    body: { name: 'e2e manual' },
  });
  const room = await roomRes.json();
  const slug = room?.room?.slug;
  if (!slug) throw new Error(`no se pudo crear la sala: ${JSON.stringify(room).slice(0, 200)}`);
  console.log(`sala creada: ${slug}`);

  // 4) 2 browsers SEPARADOS (fake device independiente c/u), ambos joinean
  const args = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    ...(BOX_IP ? [`--host-resolver-rules=MAP ${host} ${BOX_IP}, MAP ${meetHost} ${BOX_IP}`] : []),
  ];
  async function join(name) {
    const browser = await chromium.launch({ headless: true, args });
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      permissions: ['camera', 'microphone'],
    });
    const page = await ctx.newPage();
    await page.goto(`${BOX_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.fill('input[type=email]', ADMIN_EMAIL);
    await page.fill('input[type=password]', ADMIN_PW);
    await page.getByRole('button', { name: 'Acceder de forma segura' }).click();
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 30000 }).catch(() => undefined);
    await page.goto(`${BOX_URL}/meet/${slug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page
      .getByPlaceholder('Tu nombre')
      .fill(name)
      .catch(() => undefined);
    await page.getByRole('button', { name: 'Unirse ahora' }).click({ timeout: 15000 });
    return { browser, page };
  }
  const a = await join('Alice');
  const b = await join('Bob');
  await a.page.waitForTimeout(18000); // dar tiempo al ICE/DTLS + al render de los tiles remotos

  async function check(page, who) {
    const connecting = await page
      .getByText('Conectando…')
      .isVisible()
      .catch(() => false);
    const videos = await page.locator('video').count();
    console.log(`[${who}] status=${connecting ? 'connecting(✗)' : 'connected'} videos=${videos}`);
    return { connecting, videos };
  }
  const sa = await check(a.page, 'Alice');
  const sb = await check(b.page, 'Bob');
  await a.browser.close();
  await b.browser.close();

  const ok = !sa.connecting && !sb.connecting && sa.videos >= 2 && sb.videos >= 2;
  console.log(`\n=== LLAMADA 2-PARTES: ${ok ? 'OK ✅ ambos connected + video de ambos' : 'FALLO ✗'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
