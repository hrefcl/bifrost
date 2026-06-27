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
