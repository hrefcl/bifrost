import { test, expect } from '@playwright/test';

/**
 * Gate de completar-perfil: una cuenta creada sin nombre real / sin teléfono (como las que crea la API
 * de provisioning) es FORZADA a completar nombre + teléfono antes de poder usar el webmail, para que las
 * firmas corporativas salgan completas. Usa un email propio (no sembrado) que se auto-registra
 * incompleto al primer login.
 */
const PASS = 'irrelevant-the-imap-is-faked';

test('gate de perfil: cuenta incompleta debe completar nombre+teléfono antes del inbox', async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem('locale', 'en'));
  await page.goto('/login');
  await page.fill('input[type="email"]', 'gate-e2e@example.com');
  await page.fill('input[type="password"]', PASS);
  const loginResp = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: /sign in/i }).click();
  expect((await loginResp).status()).toBe(200);

  // Perfil incompleto (displayName = prefijo del email, sin teléfono) → el guard fuerza el gate.
  await expect(page).toHaveURL(/\/complete-profile$/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: /Compose/ })).toHaveCount(0); // no llegó al inbox

  // El nombre "gate-e2e" (= prefijo) NO es válido: el botón guarda deshabilitado hasta poner nombre real.
  const save = page.getByRole('button', { name: /Save and continue/i });

  // Completar con nombre real + teléfono.
  await page.fill('input[autocomplete="name"]', 'Gate Tester');
  await page.fill('input[autocomplete="tel"]', '+56 9 8888 7777');
  const patchResp = page.waitForResponse(
    (r) => r.url().includes('/api/auth/me/profile') && r.request().method() === 'PATCH'
  );
  await save.click();
  expect((await patchResp).status()).toBe(200);

  // Ya completo → llega al inbox.
  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: /Compose/ })).toBeVisible({ timeout: 15_000 });

  // Recargar NO vuelve a mostrar el gate (el backend recalculó needsProfileCompletion=false).
  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: /Compose/ })).toBeVisible({ timeout: 15_000 });
});
