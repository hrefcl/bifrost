import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

/**
 * E2E full-stack del Compliance Framework (Fase 3 P6): un admin crea/publica/activa una política
 * `block_full` (vía API con su token), un usuario hace login y es FORZADO a la pantalla de aceptación,
 * lee + acepta, y entra al sistema. Recorre la UI real del gate + el enforcement real del backend.
 *
 * Self-cleaning (suite serial compartida, ver admin-branding.spec): al final desactiva el enforcement
 * (`none`) para no bloquear a los logins de specs posteriores.
 */

const PASS = 'irrelevant-the-imap-is-faked';
const ADMIN = 'admin-e2e@example.com';
const USER = 'compliance-user-e2e@example.com';
const KEY = 'e2e-terms';

async function login(page: Page, email: string): Promise<string> {
  await page.addInitScript(() => window.localStorage.setItem('locale', 'en'));
  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASS);
  const resp = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: /sign in/i }).click();
  const r = await resp;
  expect(r.status(), 'login should succeed (fake IMAP)').toBe(200);
  const data = (await r.json()) as { accessToken: string };
  return data.accessToken;
}

function auth(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

async function setupBlockingDoc(req: APIRequestContext, token: string): Promise<void> {
  // Find-or-create (idempotente ante retries/reruns: el índice único (tenantId,key) impediría re-crear
  // un doc que un run previo dejó — incluso soft-deleted ocupa la key, B P6 MEDIUM).
  const existing = await req.get('/api/compliance/admin/documents', auth(token));
  const docs = ((await existing.json()) as { documents: { _id: string; key: string }[] }).documents;
  let docId = docs.find((d) => d.key === KEY)?._id;
  if (!docId) {
    const create = await req.post('/api/compliance/admin/documents', {
      ...auth(token),
      data: {
        key: KEY,
        title: 'E2E Terms',
        category: 'legal',
        enforcement: 'soft',
        audience: 'role:user',
      },
    });
    expect(create.ok()).toBeTruthy();
    docId = ((await create.json()) as { document: { _id: string } }).document._id;
  } else {
    // Reactivar si un run previo lo dejó inactivo.
    await req.patch(`/api/compliance/admin/documents/${docId}`, {
      ...auth(token),
      data: { active: true },
    });
  }

  const ver = await req.post(`/api/compliance/admin/documents/${docId}/versions`, {
    ...auth(token),
    data: {
      contents: [
        { locale: 'en', title: 'E2E Terms', bodyMarkdown: '# E2E Terms\n\nPlease accept.' },
      ],
      effectiveAt: new Date(Date.now() - 86_400_000).toISOString(),
      requiresReacceptance: true,
    },
  });
  expect(ver.ok()).toBeTruthy();
  const versionId = ((await ver.json()) as { version: { _id: string } }).version._id;

  expect(
    (await req.post(`/api/compliance/admin/versions/${versionId}/publish`, auth(token))).ok()
  ).toBeTruthy();
  expect(
    (
      await req.patch(`/api/compliance/admin/documents/${docId}`, {
        ...auth(token),
        data: { enforcement: 'block_full' },
      })
    ).ok()
  ).toBeTruthy();
}

async function teardownDoc(req: APIRequestContext, token: string): Promise<void> {
  const list = await req.get('/api/compliance/admin/documents', auth(token));
  const docs = ((await list.json()) as { documents: { _id: string; key: string }[] }).documents;
  const d = docs.find((x) => x.key === KEY);
  if (d)
    await req.patch(`/api/compliance/admin/documents/${d._id}`, {
      ...auth(token),
      data: { enforcement: 'none', active: false },
    });
}

test.describe.serial('Compliance gate E2E', () => {
  test('admin publica block_full → el usuario es forzado a aceptar y luego entra', async ({
    page,
  }) => {
    // 1) Admin configura una política block_full (audience role:user → el admin no se bloquea a sí mismo).
    const adminToken = await login(page, ADMIN);
    await setupBlockingDoc(page.request, adminToken);

    try {
      // 2) Un usuario inicia sesión → debe ser redirigido a la pantalla de aceptación.
      await page.context().clearCookies();
      const page2 = await page.context().newPage();
      const userToken = await login(page2, USER);

      // 2b) Aserción del ENFORCEMENT del backend (no sólo el guard del SPA): una ruta de negocio
      // devuelve 403 COMPLIANCE_REQUIRED antes de aceptar (B P6 LOW).
      const gated = await page2.request.get('/api/accounts/', auth(userToken));
      expect(gated.status()).toBe(403);
      expect(((await gated.json()) as { code?: string }).code).toBe('COMPLIANCE_REQUIRED');

      await expect(page2).toHaveURL(/\/compliance\/accept/, { timeout: 10_000 });

      // 3) El documento es corto (no desborda) → "I accept" se habilita; aceptar.
      const acceptBtn = page2.getByRole('button', { name: /I accept/i });
      await expect(acceptBtn).toBeEnabled({ timeout: 10_000 });
      const acceptResp = page2.waitForResponse(
        (r) => r.url().includes('/api/compliance/accept') && r.request().method() === 'POST'
      );
      await acceptBtn.click();
      expect((await acceptResp).status(), 'POST /accept debe registrar la evidencia (200)').toBe(
        200
      ); // D-003

      // 4) Tras aceptar: sale del gate Y una ruta de negocio YA NO bloquea (el gate del backend pasa) — D-002.
      await expect(page2).not.toHaveURL(/\/compliance\/accept/, { timeout: 10_000 });
      const after = await page2.request.get('/api/accounts/', auth(userToken));
      expect(after.status(), 'la ruta de negocio se permite tras aceptar').toBe(200);
      await page2.close();
    } finally {
      // 5) Limpieza: desactiva el enforcement para no bloquear specs posteriores.
      await teardownDoc(page.request, adminToken);
    }
  });
});
