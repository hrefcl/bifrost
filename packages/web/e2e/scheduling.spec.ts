import { test, expect, type Page, type APIResponse } from '@playwright/test';

/**
 * E2E full-stack del flujo PÚBLICO de la Agenda Inteligente (Fase 3.6), contra la API REAL del
 * harness (Mongo memory + Redis mock + IMAP/SMTP fake, ver packages/api/e2e/server.ts).
 *
 * Cubre el hueco que la review B/D señaló: el backend tiene 304 tests, pero el flujo de reserva del
 * INVITADO no tenía verificación ejecutable en navegador. Aquí:
 *   - setup del host (cuenta primaria + horario + tipo + username) y enable de la feature → vía API
 *     (como haría un admin/host real; no es lo que queremos *verificar*).
 *   - el flujo del invitado (perfil → elegir día/hora → datos → confirmación → gestión/cancelar) →
 *     recorre la UI pública REAL en un contexto SIN sesión (invitado de verdad).
 *
 * Las páginas públicas usan texto español fijo (no i18n), así que las aserciones son deterministas.
 * Corre al final del orden serial (s > m,l,c,a); deja la feature apagada al terminar (hygiene).
 */

const PASS = 'irrelevant-the-imap-is-faked';
const HOST_EMAIL = 'host-sched-e2e@example.com';
const ADMIN_EMAIL = 'admin-e2e@example.com'; // pre-sembrado como admin en e2e/server.ts
const USERNAME = 'hoste2e';

interface LoginResult {
  accessToken: string;
}

/**
 * Login por API (auto-registra al primer login con cuenta primaria; el fake IMAP/SMTP acepta cualquier
 * host). El payload de servidor replica los defaults del LoginView (webmail nativo del dominio).
 */
async function apiLogin(page: Page, email: string): Promise<LoginResult> {
  const resp = await page.request.post('/api/auth/login', {
    data: {
      email,
      password: PASS,
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpSecure: true,
    },
  });
  expect(resp.ok(), `login ${email} (${resp.status()})`).toBeTruthy();
  const data = (await resp.json()) as { accessToken: string };
  return { accessToken: data.accessToken };
}

const okJson = async (resp: APIResponse): Promise<unknown> => {
  expect(resp.ok(), `${resp.url()} → ${resp.status()}: ${await resp.text()}`).toBeTruthy();
  return resp.json();
};

test('agenda pública: invitado reserva, ve confirmación y cancela por token', async ({
  page,
  browser,
}) => {
  // ───────── 1) Setup del host vía API ─────────
  const host = await apiLogin(page, HOST_EMAIL);
  const H = { Authorization: `Bearer ${host.accessToken}` };

  await okJson(
    await page.request.patch('/api/schedule/profile', { headers: H, data: { username: USERNAME } })
  );

  // Disponibilidad los 7 días 09:00–17:00 (hora del host) → "mañana" siempre tiene huecos,
  // sin importar la hora actual ni la zona del runner.
  const weeklyRules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    intervals: [{ start: '09:00', end: '17:00' }],
  }));
  const sched = (await okJson(
    await page.request.post('/api/schedule/availability', {
      headers: H,
      data: { name: 'Laboral', timezone: 'America/Santiago', weeklyRules, overrides: [] },
    })
  )) as { id: string };

  await okJson(
    await page.request.post('/api/schedule/event-types', {
      headers: H,
      data: {
        slug: '30min',
        title: 'Charla 30 min',
        durationMinutes: 30,
        location: { type: 'video' },
        availabilityScheduleId: sched.id,
      },
    })
  );

  // ───────── 2) Admin habilita la feature ─────────
  const admin = await apiLogin(page, ADMIN_EMAIL);
  await okJson(
    await page.request.patch('/api/admin/scheduling/settings', {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
      data: { enabled: true, publicLinksEnabled: true },
    })
  );

  // ───────── 3) Invitado (contexto SIN sesión) recorre la UI pública ─────────
  const guestCtx = await browser.newContext();
  const g = await guestCtx.newPage();
  try {
    // 3a) Perfil público → lista el tipo de reunión (el título es un botón, no un heading; el <h1>
    // del perfil es el displayName del host).
    await g.goto(`/u/${USERNAME}`);
    const typeButton = g.getByRole('button', { name: /Charla 30 min/ });
    await expect(typeButton).toBeVisible({ timeout: 15_000 });
    await typeButton.click();

    // 3b) Vista de reserva: navegar a "mañana" (garantiza huecos) y elegir el primero.
    await expect(g.getByRole('heading', { name: 'Charla 30 min' })).toBeVisible();
    await g.getByRole('button', { name: '›' }).click();
    const firstSlot = g.locator('.slot').first();
    await expect(firstSlot).toBeVisible({ timeout: 15_000 });
    await firstSlot.click();

    // 3c) Datos del invitado → confirmar.
    await g.locator('.formstep input[type="text"]').first().fill('Invitado E2E');
    await g.locator('.formstep input[type="email"]').fill('invitado-e2e@example.com');
    await g.getByRole('button', { name: /Confirmar reunión/ }).click();

    // 3d) Confirmación + enlace de gestión.
    await expect(g.getByRole('heading', { name: /Reunión confirmada/ })).toBeVisible({
      timeout: 15_000,
    });
    const manageLink = g.getByRole('link', { name: /Gestionar reserva/ });
    await expect(manageLink).toBeVisible();
    const manageHref = await manageLink.getAttribute('href');
    expect(manageHref).toMatch(/\/booking\/.+/);

    // 3e) Gestión por token → ver y cancelar.
    await g.goto(manageHref!);
    await expect(g.getByText('Charla 30 min')).toBeVisible({ timeout: 15_000 });
    await expect(g.getByText('Invitado E2E')).toBeVisible();
    g.once('dialog', (d) => void d.accept()); // confirm() nativo de cancelar
    await g.getByRole('button', { name: 'Cancelar' }).click();
    await expect(g.getByText('Reunión cancelada.')).toBeVisible({ timeout: 15_000 });
  } finally {
    await guestCtx.close();
    // Hygiene: apagar la feature para no contaminar el estado global del harness serial.
    await page.request.patch('/api/admin/scheduling/settings', {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
      data: { enabled: false },
    });
  }
});
