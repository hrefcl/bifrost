import { test, expect, type Page } from '@playwright/test';

/**
 * E2E de las dos tandas del punch-list del PM (sesión 6): logout-redirect, panel admin de
 * cuentas (alta/baja real), branding white-label y embudo de filtro del TopBar. Corre contra la
 * API REAL del harness (Mongo memory + Redis mock + IMAP/SMTP fake) — el fake IMAP acepta
 * cualquier credencial, así que el alta de cuenta (que verifica IMAP) tiene éxito.
 *
 * Va PRIMERO en orden alfabético; deja el estado limpio (borra la cuenta creada, resetea el
 * branding a default) para no contaminar a los specs siguientes (login.spec asume wordmark Bifrost).
 */

const ADMIN = 'admin-e2e@example.com';
const USER = 'e2e@example.com';
const PASS = 'irrelevant-the-imap-is-faked';

async function login(page: Page, email: string): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem('locale', 'en'));
  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASS);
  const resp = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: /sign in/i }).click();
  expect((await resp).status(), 'login should succeed (fake IMAP accepts)').toBe(200);
  await expect(page).toHaveURL(/\/$/); // guard redirige a inbox
}

test.describe('punch-list PM (sesión 6)', () => {
  test('PM-01: logout redirige a /login y limpia la sesión', async ({ page }) => {
    await login(page, USER);
    await page.locator('.avatar-btn').click();
    await expect(page.locator('.menu')).toBeVisible();
    const logoutResp = page.waitForResponse((r) => r.url().includes('/api/auth/logout'));
    await page.locator('.menu-item.danger').click();
    await logoutResp;
    await expect(page, 'tras logout vuelve al login').toHaveURL(/\/login$/);
    // La sesión quedó limpia: navegar a una ruta protegida re-redirige a login (guard).
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('PM-03: admin crea, deshabilita y elimina una cuenta', async ({ page }) => {
    const newEmail = 'creada-e2e@empresa.com';
    await login(page, ADMIN);
    await page.goto('/admin');
    await expect(page.locator('[data-testid="admin-section-title"]')).toBeVisible();

    // Alta (rediseño: botón "+ New user", form en .create-card).
    await page.getByRole('button', { name: '+ New user' }).click();
    await page.getByPlaceholder('user@empresa.com').fill(newEmail);
    await page.locator('.create-card input[type="password"]').fill('pw-e2e');
    await page.getByPlaceholder('imap.empresa.com').fill('imap.test');
    await page.getByPlaceholder('smtp.empresa.com').fill('smtp.test');
    const createResp = page.waitForResponse(
      (r) => r.url().includes('/api/admin/accounts') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Create account' }).click();
    expect((await createResp).status(), 'alta 201').toBe(201);

    // Aparece en la lista (rediseño: cada fila es un botón .user-row con .uemail).
    const row = page.locator('.user-row', { has: page.locator('.uemail', { hasText: newEmail }) });
    await expect(row).toBeVisible();

    // Deshabilitar: abrir la ficha (click en la fila) y usar "Disable" del panel Perfil.
    await row.click();
    await expect(page.locator('[data-testid="user-detail"]')).toBeVisible();
    const patchResp = page.waitForResponse(
      (r) => r.url().includes('/api/admin/accounts/') && r.request().method() === 'PATCH'
    );
    await page.getByRole('button', { name: 'Disable' }).click();
    await patchResp;
    // El estado se refleja en la hero card de la ficha.
    await expect(page.locator('.user-hero .status-dot')).toHaveText(/Disabled/);

    // Eliminar (confirm) desde la ficha → se cierra y la cuenta desaparece de la lista.
    page.once('dialog', (d) => void d.accept());
    const delResp = page.waitForResponse(
      (r) => r.url().includes('/api/admin/accounts/') && r.request().method() === 'DELETE'
    );
    await page.getByRole('button', { name: 'Delete' }).click();
    expect((await delResp).status(), 'delete 200').toBe(200);
    await expect(page.locator('.uemail', { hasText: newEmail })).toHaveCount(0);
  });

  test('PM-04: branding white-label aplica el nombre de empresa y se puede limpiar', async ({
    page,
  }) => {
    await login(page, ADMIN);
    await page.goto('/admin');
    await page.getByRole('button', { name: 'Branding' }).click();

    const nameInput = page.getByPlaceholder('Bifrost');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('ACME E2E');
    const putResp = page.waitForResponse(
      (r) => r.url().includes('/api/admin/config/branding') && r.request().method() === 'PUT'
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await putResp).status()).toBe(200);
    // Aplicación EN VIVO: el wordmark del TopBar refleja el nombre nuevo sin recargar.
    await expect(page.locator('.wordmark')).toContainText('ACME E2E');

    // Reset a default (no contaminar a login.spec, que asume "Bifrost").
    await nameInput.fill('');
    const putReset = page.waitForResponse(
      (r) => r.url().includes('/api/admin/config/branding') && r.request().method() === 'PUT'
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await putReset;
    await expect(page.locator('.wordmark')).toContainText('Bifrost');
  });

  test('N4: el embudo del TopBar abre el filtro y marca el filtro activo', async ({ page }) => {
    await login(page, USER);
    await page.locator('.filter-wrap .icon-btn').click();
    await expect(page.locator('.filter-menu')).toBeVisible();
    await page.locator('.filter-item', { hasText: 'Unread' }).click();
    await expect(page.locator('.filter-wrap .icon-btn')).toHaveClass(/on/);
  });
});
