import { test, expect, type Page } from '@playwright/test';

/**
 * E2E full-stack (TD-E2E): login → sync → leer → enviar contra la API REAL
 * (Mongo memory-server + Redis mock + IMAP/SMTP fake, ver packages/api/e2e/server.ts).
 *
 * El frontend no dispara sync por sí mismo todavía (deuda: auto-sync/SSE), así que el
 * test cumple ese rol llamando los endpoints de sync con el access token del login —
 * exactamente como lo haría el worker de fondo. Todo lo demás (render del inbox, lectura
 * del body, composición y envío) recorre la UI real.
 */

const LOGIN = {
  email: 'e2e@example.com',
  password: 'irrelevant-the-imap-is-faked',
};

interface LoginResult {
  accessToken: string;
  accountId: string;
}

async function loginViaUi(page: Page): Promise<LoginResult> {
  await page.goto('/login');
  await page.fill('input[type="email"]', LOGIN.email);
  await page.fill('input[type="password"]', LOGIN.password);

  const loginResp = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: /sign in/i }).click();
  const resp = await loginResp;
  expect(resp.status(), 'login should succeed (fake IMAP accepts)').toBe(200);

  const data = (await resp.json()) as {
    accessToken: string;
    accounts: { id: string }[];
  };
  expect(data.accounts.length).toBeGreaterThan(0);
  return { accessToken: data.accessToken, accountId: data.accounts[0].id };
}

/** Dispara el sync (folders + cada folder) vía API, como haría el worker de fondo. */
async function syncMailbox(page: Page, { accessToken, accountId }: LoginResult): Promise<void> {
  const headers = { Authorization: `Bearer ${accessToken}` };

  const folderSync = await page.request.post(`/api/accounts/${accountId}/sync/folders`, {
    headers,
  });
  expect(folderSync.ok(), 'folder list sync').toBeTruthy();

  const foldersResp = await page.request.get(`/api/accounts/${accountId}/folders`, { headers });
  expect(foldersResp.ok(), 'list folders').toBeTruthy();
  const folders = (await foldersResp.json()) as { id: string }[];
  expect(folders.length).toBeGreaterThan(0);

  for (const folder of folders) {
    const headerSync = await page.request.post(
      `/api/accounts/${accountId}/folders/${folder.id}/sync`,
      { headers }
    );
    expect(headerSync.ok(), `header sync of folder ${folder.id}`).toBeTruthy();
  }
}

test('full flow: login → sync → read email body → compose & send', async ({ page }) => {
  // 1) LOGIN (UI real). Tras login el inbox monta y carga cuentas (aún sin folders).
  const session = await loginViaUi(page);
  await expect(page.getByRole('heading', { name: 'Folders' })).toBeVisible({ timeout: 15_000 });

  // 2) SYNC (API real → fake IMAP → Mongo), como haría el worker de fondo.
  await syncMailbox(page, session);

  // Recarga: main.ts restaura la sesión por la cookie httpOnly de refresh y el inbox vuelve
  // a leer de Mongo los folders/emails recién sincronizados.
  await page.reload();

  // 3) LEER: seleccionar INBOX (determinista) y abrir un email renderiza su body.
  await page.getByText('INBOX', { exact: true }).click();
  await expect(page.getByText('Welcome to Webmail 6.0')).toBeVisible({ timeout: 15_000 });

  // Abrir el email dispara GET /body (parse+sanitize reales) y, como estaba no-leído,
  // un PATCH /flags {seen:true} — verificamos ese efecto secundario sobre el backend.
  // Filtra status 200: con el TTL corto del server E2E, una request podría dar 401→retry;
  // queremos el resultado final exitoso, no el 401 intermedio que el interceptor rescata.
  const flagsResp = page.waitForResponse(
    (r) =>
      /\/api\/emails\/.+\/flags$/.test(r.url()) &&
      r.request().method() === 'PATCH' &&
      r.status() === 200
  );
  await page.getByText('Welcome to Webmail 6.0').click();

  // El detalle renderiza el HTML saneado por el backend (postal-mime + sanitize-html).
  await expect(page.getByRole('heading', { name: 'Welcome to Webmail 6.0' })).toBeVisible();
  await expect(page.getByText('Hello from the', { exact: false })).toBeVisible({ timeout: 15_000 });
  expect((await flagsResp).status(), 'marcar como leído debe persistir (PATCH /flags)').toBe(200);

  // 4) ENVIAR: componer un correo nuevo y enviarlo (API real → fake SMTP + APPEND a Sent).
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.fill('input[placeholder="To"]', 'destinatario@example.com');
  await page.fill('input[placeholder="Subject"]', 'Hola desde el E2E');
  // Cuerpo: editor enriquecido TipTap (contenteditable .ProseMirror), no un textarea.
  await page.locator('.ProseMirror').click();
  await page.locator('.ProseMirror').fill('Cuerpo de prueba E2E.');

  const sendResp = page.waitForResponse(
    (r) =>
      /\/api\/drafts\/.+\/send$/.test(r.url()) &&
      r.request().method() === 'POST' &&
      r.status() === 200
  );
  await page.getByRole('button', { name: 'Send' }).click();
  await sendResp; // 200 garantizado por el predicado (envío real → fake SMTP)

  // El composer navega de vuelta al inbox sólo si el envío fue exitoso.
  await expect(page).toHaveURL(/\/$|\/#?$/);
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible();
});

test('adjuntos: subir un archivo en el composer y enviarlo (upload UI → send real)', async ({
  page,
}) => {
  await loginViaUi(page);
  await expect(page.getByRole('heading', { name: 'Folders' })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Compose' }).click();
  await page.fill('input[placeholder="To"]', 'destinatario@example.com');
  await page.fill('input[placeholder="Subject"]', 'Con adjunto E2E');
  await page.locator('.ProseMirror').click();
  await page.locator('.ProseMirror').fill('Mirá el adjunto.');

  // Adjuntar un archivo: el input está oculto tras el label "Attach files". setInputFiles
  // dispara el change → POST /api/attachments (storage real local) → blobId.
  const uploadResp = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/attachments') && r.request().method() === 'POST' && r.status() === 200
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: 'reporte-e2e.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('contenido del adjunto e2e'),
  });
  await uploadResp;

  // El adjunto aparece en la lista del composer.
  await expect(page.getByText('reporte-e2e.txt')).toBeVisible({ timeout: 15_000 });

  // Quitar el adjunto lo saca de la lista (y por tanto del payload attachmentIds)...
  await page.getByRole('button', { name: 'Remove reporte-e2e.txt' }).click();
  await expect(page.getByText('reporte-e2e.txt')).toHaveCount(0);

  // ...y re-adjuntar el MISMO archivo vuelve a funcionar (el input se resetea en finally).
  const reupload = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/attachments') && r.request().method() === 'POST' && r.status() === 200
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: 'reporte-e2e.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('contenido del adjunto e2e'),
  });
  const reuploadResp = await reupload;
  const { id: blobId } = (await reuploadResp.json()) as { id: string };
  await expect(page.getByText('reporte-e2e.txt')).toBeVisible({ timeout: 15_000 });

  // Enviar. Verificamos explícitamente que el blobId subido viaja en attachmentIds al crear
  // el draft (POST /drafts): sin esto el test pasaría aunque el wiring se rompiera, porque el
  // backend puede enviar un correo sin adjuntos.
  const createResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/drafts') && r.request().method() === 'POST' && r.status() === 200
  );
  const sendResp = page.waitForResponse(
    (r) =>
      /\/api\/drafts\/.+\/send$/.test(r.url()) &&
      r.request().method() === 'POST' &&
      r.status() === 200
  );
  await page.getByRole('button', { name: 'Send' }).click();

  const createReq = (await createResp).request();
  const createBody = createReq.postDataJSON() as { attachmentIds?: string[] };
  expect(createBody.attachmentIds, 'el draft creado debe llevar el blobId subido').toContain(
    blobId
  );
  await sendResp;

  await expect(page).toHaveURL(/\/$|\/#?$/);
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible();
});

test('adjuntos: Send/Save quedan deshabilitados mientras un upload está en curso (anti pérdida silenciosa)', async ({
  page,
}) => {
  // Regresión del HIGH que marcó B: enviar con un upload pendiente mandaría el correo SIN ese
  // adjunto. Demoramos el POST /attachments para atrapar la ventana "Uploading...".
  await page.route('**/api/attachments', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  await loginViaUi(page);
  await expect(page.getByRole('heading', { name: 'Folders' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.fill('input[placeholder="To"]', 'destinatario@example.com');

  await page.locator('input[type="file"]').setInputFiles({
    name: 'lento.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('subida lenta'),
  });

  // Mientras sube: el label muestra "Uploading..." y AMBOS botones están deshabilitados.
  await expect(page.getByText('Uploading...')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();

  // Al completar, se rehabilitan y el adjunto ya está en la lista.
  await expect(page.getByText('lento.txt')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('reply: precarga Re:/destinatario y persiste el threading In-Reply-To', async ({ page }) => {
  // Antes este flujo estaba ROTO: ComposerView ignoraba route.query.replyTo → clic en Reply
  // abría un composer en blanco. Verifica la precarga + que el threading llega al backend.
  const session = await loginViaUi(page);
  await expect(page.getByRole('heading', { name: 'Folders' })).toBeVisible({ timeout: 15_000 });
  await syncMailbox(page, session);
  await page.reload();

  await page.getByText('INBOX', { exact: true }).click();
  await page.getByText('Welcome to Webmail 6.0').click();
  await expect(page.getByRole('heading', { name: 'Welcome to Webmail 6.0' })).toBeVisible({
    timeout: 15_000,
  });

  // Reply → composer precargado (esto era exactamente lo que no funcionaba). El email trae
  // header Reply-To (list@example.com) → la respuesta va ahí, NO al From (alice@example.com).
  await page.getByRole('button', { name: 'Reply' }).click();
  await expect(page.locator('input[placeholder="To"]')).toHaveValue('list@example.com');
  await expect(page.locator('input[placeholder="Subject"]')).toHaveValue(
    'Re: Welcome to Webmail 6.0'
  );
  // El cuerpo original citado debe RENDERIZARSE en el editor TipTap (path watch→setContent):
  // sin esto un reply saldría con cuerpo vacío y nadie lo notaría.
  await expect(page.locator('.ProseMirror')).toContainText('Hello from the');

  // Al enviar, el front crea el draft (POST /drafts) con el threading. Interceptamos esa
  // respuesta: prueba que replyToMessageId llegó al backend y se persistió (el backend pondrá
  // In-Reply-To/References al enviar). Verificamos en el create porque /drafts no lista enviados.
  const createResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/drafts') && r.request().method() === 'POST' && r.status() === 200
  );
  const sendResp = page.waitForResponse(
    (r) =>
      /\/api\/drafts\/.+\/send$/.test(r.url()) &&
      r.request().method() === 'POST' &&
      r.status() === 200
  );
  await page.getByRole('button', { name: 'Send' }).click();

  const created = (await (await createResp).json()) as { replyTo?: { messageId?: string } };
  expect(created.replyTo?.messageId, 'el draft de respuesta debe enlazar al mensaje original').toBe(
    '<seed-1@example.com>'
  );
  await sendResp;
});

test('interceptor de refresh: access token vencido se renueva solo (401 → refresh → retry)', async ({
  page,
}) => {
  // El server E2E emite access tokens con TTL corto (JWT_ACCESS_TTL=3s). Tras vencer, la
  // PRIMERA petición autenticada da 401 y el interceptor de axios debe renovar con la
  // cookie (single-flight) y reintentar de forma transparente. Sin esto la sesión moriría
  // a los 15min en producción pese a la cookie de refresh viva.
  await loginViaUi(page);
  await expect(page.getByRole('heading', { name: 'Folders' })).toBeVisible({ timeout: 15_000 });

  // Dejar vencer el access token (TTL=3s).
  await page.waitForTimeout(3_500);

  // Acción autenticada nueva (composer → GET /accounts). Su 1ª request vence con 401 y el
  // interceptor la rescata con un POST /auth/refresh + retry.
  const refreshAfterExpiry = page.waitForResponse(
    (r) => r.url().includes('/api/auth/refresh') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Compose' }).click();
  expect((await refreshAfterExpiry).status(), 'el interceptor debe renovar el token').toBe(200);

  // El retry transparente repuebla la cuenta en el composer → la app sigue usable.
  await expect(page.locator('select')).toContainText('e2e@example.com', { timeout: 15_000 });
});

test('firma: guardar en Settings y auto-incluir al componer un correo nuevo', async ({ page }) => {
  await loginViaUi(page);
  await expect(page.getByRole('heading', { name: 'Folders' })).toBeVisible({ timeout: 15_000 });

  // Settings → escribir y guardar la firma (único editor de la página).
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Signature' })).toBeVisible({ timeout: 15_000 });
  await page.locator('.ProseMirror').click();
  await page.locator('.ProseMirror').fill('Saludos, Equipo A E2E');
  const patch = page.waitForResponse(
    (r) =>
      r.url().includes('/api/auth/me/preferences') &&
      r.request().method() === 'PATCH' &&
      r.status() === 200
  );
  await page.getByRole('button', { name: 'Save signature' }).click();
  await patch;
  await expect(page.getByText('Saved')).toBeVisible();

  // Componer nuevo → la firma debe auto-incluirse en el editor del cuerpo.
  await page.getByRole('link', { name: 'Inbox' }).click();
  await page.getByRole('button', { name: 'Compose' }).click();
  await expect(page.locator('.ProseMirror')).toContainText('Saludos, Equipo A E2E', {
    timeout: 15_000,
  });
});

test('reply-all: To=remitente, CC=resto sin uno-mismo ni el remitente (case-insensitive)', async ({
  page,
}) => {
  const session = await loginViaUi(page);
  await expect(page.getByRole('heading', { name: 'Folders' })).toBeVisible({ timeout: 15_000 });
  await syncMailbox(page, session);
  await page.reload();

  await page.getByText('INBOX', { exact: true }).click();
  // 'Your June invoice' tiene to:[e2e, colleague] + cc:[boss] → el botón Reply all aparece.
  await page.getByText('Your June invoice').click();
  await expect(page.getByRole('heading', { name: 'Your June invoice' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Reply all' }).click();

  await expect(page.locator('input[placeholder="To"]')).toHaveValue('billing@example.com');
  const cc = await page.locator('input[placeholder="Cc"]').inputValue();
  expect(cc).toContain('colleague@example.com');
  expect(cc).toContain('boss@example.com');
  expect(cc).not.toContain('e2e@example.com'); // uno mismo, excluido
  expect(cc).not.toContain('billing@example.com'); // remitente (ya en To), excluido
});
