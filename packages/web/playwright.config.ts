import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Serial (workers:1): los specs comparten UNA API E2E con buzón fake global y access
  // tokens de TTL corto; correrlos en paralelo cruzaría estado/timing entre tests.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Dos servidores: (1) la API REAL E2E (Mongo memory + Redis mock + IMAP/SMTP fake) en
  // :3000, y (2) el dev server de la web en :5173, que proxya /api → :3000. Playwright los
  // arranca en paralelo y espera a que cada `url` responda antes de correr los specs.
  webServer: [
    {
      command: 'pnpm --filter @webmail6/api e2e:server',
      url: 'http://localhost:3000/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
