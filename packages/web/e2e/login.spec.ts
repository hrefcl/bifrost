import { test, expect } from '@playwright/test';

test('login page loads', async ({ page }) => {
  // La UI es multi-idioma; el default es español. Fijamos inglés para que las aserciones de
  // texto sean deterministas y coincidan con los views aún no migrados a i18n.
  await page.addInitScript(() => window.localStorage.setItem('locale', 'en'));
  await page.goto('/login');
  // Marca parametrizable: el wordmark del logo es "Bifrost" (default), no "Webmail".
  await expect(page.locator('.wordmark')).toContainText('Bifrost');
  // Título del formulario (i18n, inglés fijado).
  await expect(page.locator('h1')).toContainText('Sign in');
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
});

test('server settings exponen el toggle TLS/STARTTLS (IMAP y SMTP)', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('locale', 'en'));
  await page.goto('/login');
  // El toggle de seguridad estaba oculto/hardcodeado; ahora se puede configurar (fix HIGH de B).
  await page.getByRole('button', { name: /server settings/i }).click();
  const tlsToggles = page.locator('.server-grid .secure input[type="checkbox"]');
  await expect(tlsToggles).toHaveCount(2); // uno para IMAP, uno para SMTP
  await expect(tlsToggles.first()).toBeChecked(); // default: SSL directo
});
