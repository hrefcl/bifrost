import { test, expect, type Page } from '@playwright/test';

/**
 * E2E de Contacts y Calendar (cobertura que la review B+D marcó como faltante). El flujo de
 * Calendar es además la REGRESIÓN del bug "crear evento estaba 100% roto": el `<input
 * datetime-local>` da "2026-06-25T10:00" y la API valida ISO 8601 → sin la conversión a ISO el
 * POST daba 400 y nunca se creaba el evento. Acá se asegura POST 200 + render en la agenda.
 *
 * La UI es multi-idioma (es por defecto); fijamos inglés para aserciones deterministas.
 */
async function login(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem('locale', 'en'));
  await page.goto('/login');
  await page.fill('input[type="email"]', 'e2e@example.com');
  await page.fill('input[type="password"]', 'irrelevant-the-imap-is-faked');
  const resp = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: /sign in/i }).click();
  expect((await resp).status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });
}

test('contactos: crear y eliminar (CRUD real vía UI)', async ({ page }) => {
  await login(page);

  await page.getByRole('button', { name: 'Contacts' }).click();
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'New contact' }).click();
  await page.fill('input[placeholder="Full name"]', 'Elena Ruiz');
  await page.fill('input[placeholder="Email"]', 'elena.ruiz@bifrost.io');
  await page.fill('input[placeholder="Organization"]', 'Bifrost');

  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/contacts') && r.request().method() === 'POST' && r.status() === 200
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await created;

  // El contacto aparece en la lista (cableado real al store + API).
  await expect(page.getByText('Elena Ruiz')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('elena.ruiz@bifrost.io', { exact: false })).toBeVisible();

  // Eliminar lo saca de la lista.
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Elena Ruiz')).toHaveCount(0);
});

test('calendario: crear evento desde la UI aparece en la agenda (regresión datetime→ISO)', async ({
  page,
}) => {
  await login(page);

  await page.getByRole('button', { name: 'Calendar' }).click();
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Create' }).click();
  await page.fill('input[placeholder="Event title"]', 'Sprint review E2E');
  // datetime-local: hora LOCAL; la vista la convierte a ISO antes del POST (el fix del bug).
  await page.fill('input[type="datetime-local"] >> nth=0', '2026-06-25T10:00');
  await page.fill('input[type="datetime-local"] >> nth=1', '2026-06-25T11:00');

  // El POST debe ser 200 (antes daba 400 por el formato de fecha → evento nunca creado).
  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/calendar') && r.request().method() === 'POST' && r.status() === 200
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect((await created).status()).toBe(200);

  // El evento se renderiza en la agenda.
  await expect(page.getByText('Sprint review E2E')).toBeVisible({ timeout: 15_000 });
});
