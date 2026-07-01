import { test, expect, type Page, type APIResponse } from '@playwright/test';

/**
 * E2E full-stack del flujo PÚBLICO de la Agenda Inteligente (Fase 3.6), contra la API REAL del
 * harness (Mongo memory + Redis mock + IMAP/SMTP fake, ver packages/api/e2e/server.ts).
 *
 * Cubre el hueco que la review B/D señaló: el backend tiene 304 tests, pero el flujo de reserva del
 * INVITADO no tenía verificación ejecutable en navegador. Aquí:
 *   - setup del host (cuenta primaria + horario + tipo + username) y enable de la feature → vía API.
 *   - el flujo del invitado (perfil → elegir día/hora → datos → confirmación → gestión/cancelar) →
 *     recorre la UI pública REAL en un contexto SIN sesión (invitado de verdad).
 *
 * COBERTURA — qué NO prueba (honestidad, review B):
 *   - El servidor E2E usa buildApp() y con REDIS_URL=mock BullMQ es no-op: NO arranca el worker.
 *     Por tanto el ENVÍO de correo/ICS (async) NO se ejercita aquí — está cubierto por unit tests de
 *     email.ts/ics.ts. Este E2E NO es evidencia de que el correo se envíe.
 *   - Tampoco cubre reschedule, concurrencia, ni el setup por la UI host (se hace por API).
 *
 * Robustez (review B): zona horaria del invitado fijada (= host) para que "mañana" sea determinista;
 * ids únicos por corrida para sobrevivir a retries de CI; se asertan las responses (no sólo texto);
 * el finally restaura los settings previos. Corre último en el orden serial.
 */

const PASS = 'irrelevant-the-imap-is-faked';
const ADMIN_EMAIL = 'admin-e2e@example.com'; // pre-sembrado como admin en e2e/server.ts
const HOST_TZ = 'America/Santiago';

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

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

test('agenda pública: invitado reserva, ve confirmación y cancela por token', async ({
  page,
  browser,
}) => {
  // Ids ÚNICOS por corrida (incl. retries de CI): un host nuevo evita choques de username (índice
  // único global) y de slug (único por usuario) — review B "estado/retries".
  const uniq = `${Date.now().toString(36)}${test.info().workerIndex}`;
  const HOST_EMAIL = `host-sched-${uniq}@example.com`;
  const USERNAME = `hoste2e${uniq}`;

  // ───────── 1) Setup del host vía API ─────────
  const host = await apiLogin(page, HOST_EMAIL);
  const H = bearer(host.accessToken);

  await okJson(
    await page.request.patch('/api/schedule/profile', { headers: H, data: { username: USERNAME } })
  );

  // Disponibilidad los 7 días 09:00–17:00 (hora del host) → "mañana" siempre tiene huecos.
  const weeklyRules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    intervals: [{ start: '09:00', end: '17:00' }],
  }));
  const sched = (await okJson(
    await page.request.post('/api/schedule/availability', {
      headers: H,
      data: { name: 'Laboral', timezone: HOST_TZ, weeklyRules, overrides: [] },
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

  // ───────── 2) Admin: capturar settings previos y habilitar la feature ─────────
  const admin = await apiLogin(page, ADMIN_EMAIL);
  const A = bearer(admin.accessToken);
  const prevSettings = (await okJson(
    await page.request.get('/api/admin/scheduling/settings', { headers: A })
  )) as { enabled: boolean; publicLinksEnabled: boolean };
  await okJson(
    await page.request.patch('/api/admin/scheduling/settings', {
      headers: A,
      data: { enabled: true, publicLinksEnabled: true },
    })
  );

  // ───────── 3) Invitado (contexto SIN sesión, tz = host para "mañana" determinista) ─────────
  const guestCtx = await browser.newContext({ timezoneId: HOST_TZ });
  const g = await guestCtx.newPage();
  try {
    // 3a) Perfil público → lista el tipo de reunión (el título es un botón; el <h1> es el displayName).
    await g.goto(`/u/${USERNAME}`);
    const typeButton = g.getByRole('button', { name: /Charla 30 min/ });
    await expect(typeButton).toBeVisible({ timeout: 15_000 });
    await typeButton.click();

    // 3b) Vista de reserva (rediseño: calendario mensual). Elegir "mañana" en la tz del host
    // (determinista) por su data-testid; la carga de slots es por-día al hacer click. Si "mañana"
    // cae en el mes siguiente al visible, avanzar el calendario primero.
    await expect(g.getByRole('heading', { name: 'Charla 30 min' })).toBeVisible({
      timeout: 15_000,
    });
    const isoFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: HOST_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const monthFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: HOST_TZ,
      year: 'numeric',
      month: '2-digit',
    });
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const tomorrowIso = isoFmt.format(tomorrow); // YYYY-MM-DD en tz del host
    if (monthFmt.format(tomorrow) !== monthFmt.format(new Date())) {
      await g.getByRole('button', { name: 'Mes siguiente' }).click();
    }
    const slotsResp = g.waitForResponse(
      (r) => r.url().includes('/slots') && r.request().method() === 'GET'
    );
    await g.locator(`[data-testid="pub-day-${tomorrowIso}"]`).click();
    const slotsData = (await (await slotsResp).json()) as { slots: { start: string }[] };
    expect(slotsData.slots.length, 'mañana debe tener huecos').toBeGreaterThan(0);
    const firstSlot = g.locator('.slot').first();
    await expect(firstSlot).toBeVisible({ timeout: 15_000 });
    await firstSlot.click();

    // 3c) Datos del invitado → confirmar, asertando la response 201 del POST /book.
    await g.getByLabel('Nombre').fill('Invitado E2E');
    await g.getByLabel('Email').fill('invitado-e2e@example.com');
    const bookResp = g.waitForResponse(
      (r) => r.url().includes('/book') && r.request().method() === 'POST'
    );
    await g.getByRole('button', { name: /Confirmar reunión/ }).click();
    const booked = await bookResp;
    expect(booked.status(), 'POST /book → 201').toBe(201);
    const bookedBody = (await booked.json()) as {
      booking: { status: string; invitee: { email: string }; snapshot: { title: string } };
      managementToken: string;
    };
    expect(bookedBody.booking.status).toBe('confirmed');
    expect(bookedBody.booking.invitee.email).toBe('invitado-e2e@example.com');
    expect(bookedBody.booking.snapshot.title).toBe('Charla 30 min');
    expect(bookedBody.managementToken, 'token de gestión presente en creación').toBeTruthy();

    // 3d) Confirmación + enlace de gestión.
    await expect(g.getByRole('heading', { name: /Reunión confirmada/ })).toBeVisible({
      timeout: 15_000,
    });
    const manageLink = g.getByRole('link', { name: /Gestionar reserva/ });
    await expect(manageLink).toBeVisible();
    const manageHref = await manageLink.getAttribute('href');
    expect(manageHref, 'href de gestión').toBeTruthy();
    if (!manageHref) throw new Error('sin enlace de gestión');
    expect(manageHref).toContain(`/booking/${bookedBody.managementToken}`);

    // 3e) Gestión por token → ver y cancelar, asertando la response del cancel y el estado final.
    await g.goto(manageHref);
    await expect(g.getByText('Charla 30 min')).toBeVisible({ timeout: 15_000 });
    await expect(g.getByText('Invitado E2E')).toBeVisible();
    const cancelResp = g.waitForResponse(
      (r) => r.url().includes('/cancel') && r.request().method() === 'POST'
    );
    g.once('dialog', (d) => void d.accept()); // confirm() nativo de cancelar
    await g.getByRole('button', { name: 'Cancelar' }).click();
    const cancelled = await cancelResp;
    expect(cancelled.status(), 'POST /cancel → 200').toBe(200);
    expect((JSON.parse(await cancelled.text()) as { status: string }).status).toBe('cancelled');
    // La UI refleja el estado: mensaje + badge "Cancelada" + ya no se ofrece cancelar.
    await expect(g.getByText('Reunión cancelada.')).toBeVisible({ timeout: 15_000 });
    await expect(g.locator('.badge.cancelled')).toBeVisible();
    await expect(g.getByRole('button', { name: 'Cancelar' })).toHaveCount(0);
  } finally {
    await guestCtx.close();
    // Restaura los settings PREVIOS (re-login admin por si el token de 60s expiró) — review B.
    const adminAgain = await apiLogin(page, ADMIN_EMAIL);
    await page.request.patch('/api/admin/scheduling/settings', {
      headers: bearer(adminAgain.accessToken),
      data: { enabled: prevSettings.enabled, publicLinksEnabled: prevSettings.publicLinksEnabled },
    });
  }
});
