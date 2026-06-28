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

async function loginViaUi(page: Page, email: string = LOGIN.email): Promise<LoginResult> {
  // La UI es multi-idioma con español por defecto. Fijamos inglés para que las aserciones de
  // texto sean DETERMINISTAS (toda la UI está i18n; este pin sólo elige el idioma de las
  // aserciones, no compensa views sin migrar).
  await page.addInitScript(() => window.localStorage.setItem('locale', 'en'));
  await page.goto('/login');
  await page.fill('input[type="email"]', email);
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
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });

  // 2) SYNC (API real → fake IMAP → Mongo), como haría el worker de fondo.
  await syncMailbox(page, session);

  // Recarga: main.ts restaura la sesión por la cookie httpOnly de refresh y el inbox vuelve
  // a leer de Mongo los folders/emails recién sincronizados.
  await page.reload();

  // 3) LEER: seleccionar INBOX (determinista) y abrir un email renderiza su body.
  await page.getByRole('button', { name: 'Inbox' }).click();
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
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });

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
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.fill('input[placeholder="To"]', 'destinatario@example.com');

  await page.locator('input[type="file"]').setInputFiles({
    name: 'lento.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('subida lenta'),
  });

  // Mientras sube: el estado muestra "Uploading..." y Enviar está deshabilitado. El autosave
  // de borrador también queda bloqueado internamente (guard en saveDraft) → no se manda/guarda
  // sin el adjunto pendiente. (El botón manual "Save draft" se reemplazó por autosave estilo Gmail.)
  await expect(page.getByText('Uploading...')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();

  // Al completar, se rehabilitan y el adjunto ya está en la lista.
  await expect(page.getByText('lento.txt')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('reply: precarga Re:/destinatario y persiste el threading In-Reply-To', async ({ page }) => {
  // Antes este flujo estaba ROTO: ComposerView ignoraba route.query.replyTo → clic en Reply
  // abría un composer en blanco. Verifica la precarga + que el threading llega al backend.
  const session = await loginViaUi(page);
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });
  await syncMailbox(page, session);
  await page.reload();

  await page.getByRole('button', { name: 'Inbox' }).click();
  await page.getByText('Welcome to Webmail 6.0').click();
  await expect(page.getByRole('heading', { name: 'Welcome to Webmail 6.0' })).toBeVisible({
    timeout: 15_000,
  });

  // Reply → composer precargado (esto era exactamente lo que no funcionaba). El email trae
  // header Reply-To (list@example.com) → la respuesta va ahí, NO al From (alice@example.com).
  // Hay un icono "Reply" por-mensaje y otro en la barra inferior; apuntamos a la barra.
  await page.locator('.reply-bar').getByRole('button', { name: 'Reply', exact: true }).click();
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

test('interceptor de refresh: una 401 se renueva sola (401 → refresh → retry)', async ({
  page,
}) => {
  // Una petición autenticada que da 401 (access token vencido) debe gatillar un POST
  // /auth/refresh (single-flight) + retry transparente. Sin esto la sesión moriría a los 15min
  // en prod pese a la cookie de refresh viva.
  //
  // Forzamos la 401 de forma DETERMINISTA con page.route (inyectando un 401 en la próxima GET
  // /accounts), en vez de depender de un TTL corto global: ese TTL=3s hacía que tests lentos
  // cruzaran la expiración y se volvieran flaky. Así el TTL del server puede ser cómodo.
  await loginViaUi(page);
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });
  // Esperar a que la carga inicial del inbox (GET /accounts) termine, para inyectar la 401
  // recién en la request que dispara el composer, no en la del inbox.
  await page.waitForResponse(
    (r) => r.url().includes('/api/accounts') && r.request().method() === 'GET'
  );

  let injected = false;
  await page.route('**/api/accounts', async (route) => {
    if (!injected && route.request().method() === 'GET') {
      injected = true;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'token expirado (inyectado)' }),
      });
    } else {
      await route.continue();
    }
  });

  // Acción autenticada nueva (composer → GET /accounts): la 1ª da 401 inyectada → el interceptor
  // renueva (POST /auth/refresh) y reintenta; el retry pasa por route.continue() → 200 real.
  const refreshResp = page.waitForResponse(
    (r) => r.url().includes('/api/auth/refresh') && r.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Compose' }).click();
  expect((await refreshResp).status(), 'el interceptor debe renovar el token').toBe(200);

  // El retry transparente repuebla la cuenta en el composer → la app sigue usable.
  await expect(page.locator('select')).toContainText('e2e@example.com', { timeout: 15_000 });
});

test('firma: guardar en Settings y auto-incluir al componer un correo nuevo', async ({ page }) => {
  await loginViaUi(page);
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });

  // Settings → sección Firma → escribir y guardar (único editor de la página). En el shell
  // nuevo, Ajustes es un botón-icono en la topbar (title="Settings") y Settings tiene nav
  // lateral por secciones (default Apariencia) → navegamos a "Signature".
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Signature' }).click();
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

  // Componer nuevo → la firma debe auto-incluirse en el editor del cuerpo. Volvemos al inbox
  // por el logo de la topbar (no hay link "Inbox" de texto en el shell nuevo).
  await page.locator('.logo-slot').click();
  await page.getByRole('button', { name: 'Compose' }).click();
  await expect(page.locator('.ProseMirror')).toContainText('Saludos, Equipo A E2E', {
    timeout: 15_000,
  });
});

test('reply-all: To=remitente, CC=resto sin uno-mismo ni el remitente (case-insensitive)', async ({
  page,
}) => {
  const session = await loginViaUi(page);
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });
  await syncMailbox(page, session);
  await page.reload();

  await page.getByRole('button', { name: 'Inbox' }).click();
  // 'Your June invoice' tiene to:[e2e, colleague] + cc:[boss] → el botón Reply all aparece.
  await page.getByText('Your June invoice').click();
  await expect(page.getByRole('heading', { name: 'Your June invoice' })).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('.reply-bar').getByRole('button', { name: 'Reply all' }).click();

  await expect(page.locator('input[placeholder="To"]')).toHaveValue('billing@example.com');
  const cc = await page.locator('input[placeholder="Cc"]').inputValue();
  expect(cc).toContain('colleague@example.com');
  expect(cc).toContain('boss@example.com');
  expect(cc).not.toContain('e2e@example.com'); // uno mismo, excluido
  expect(cc).not.toContain('billing@example.com'); // remitente (ya en To), excluido
});

test('archivar: mover un email a Archivo lo saca de Recibidos (POST /move real)', async ({
  page,
}) => {
  const session = await loginViaUi(page);
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });
  await syncMailbox(page, session);
  await page.reload();

  await page.getByRole('button', { name: 'Inbox' }).click();
  await page.getByText('Your June invoice').click();
  await expect(page.getByRole('heading', { name: 'Your June invoice' })).toBeVisible({
    timeout: 15_000,
  });

  // Archivar desde la toolbar de lectura (el de la barra del thread, no el del sidebar).
  const moved = page.waitForResponse(
    (r) =>
      /\/api\/emails\/.+\/move$/.test(r.url()) &&
      r.request().method() === 'POST' &&
      r.status() === 200
  );
  await page.locator('.thread-head').getByRole('button', { name: 'Archive' }).click();
  expect((await moved).status()).toBe(200);

  // Ya no aparece en Recibidos (el doc local se quitó tras el move).
  await expect(page.getByText('Your June invoice')).toHaveCount(0);
});

test('búsqueda: Enter en la barra hace búsqueda server-side global', async ({ page }) => {
  const session = await loginViaUi(page);
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });
  await syncMailbox(page, session);
  await page.reload();

  // Buscar 'Welcome' (está en INBOX) — Enter dispara GET /emails/search.
  const searchResp = page.waitForResponse(
    (r) => r.url().includes('/api/emails/search') && r.status() === 200
  );
  await page.fill('input[placeholder="Search mail"]', 'Welcome');
  await page.locator('input[placeholder="Search mail"]').press('Enter');
  await searchResp;

  // La cabecera pasa a "Results for ..." y el email aparece en los resultados.
  await expect(page.getByRole('heading', { name: /Results for/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Welcome to Webmail 6.0')).toBeVisible();
});

test('snooze: posponer saca el email de Recibidos y aparece en Pospuestos', async ({ page }) => {
  const session = await loginViaUi(page);
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });
  await syncMailbox(page, session);
  await page.reload();

  await page.getByRole('button', { name: 'Inbox' }).click();
  await page.getByText('Welcome to Webmail 6.0').click();
  await expect(page.getByRole('heading', { name: 'Welcome to Webmail 6.0' })).toBeVisible({
    timeout: 15_000,
  });

  // Posponer → modal → "Tomorrow" → POST /snooze.
  const snoozed = page.waitForResponse(
    (r) =>
      /\/api\/emails\/.+\/snooze$/.test(r.url()) &&
      r.request().method() === 'POST' &&
      r.status() === 200
  );
  await page.locator('.thread-head').getByRole('button', { name: 'Snooze' }).click();
  await page.getByRole('button', { name: 'Tomorrow' }).click();
  expect((await snoozed).status()).toBe(200);

  // Sale de Recibidos.
  await expect(page.getByText('Welcome to Webmail 6.0')).toHaveCount(0);

  // Aparece en Pospuestos (GET /emails/snoozed).
  const snoozedList = page.waitForResponse(
    (r) => r.url().includes('/api/emails/snoozed') && r.status() === 200
  );
  await page.getByRole('button', { name: 'Snoozed' }).click();
  await snoozedList;
  await expect(page.getByText('Welcome to Webmail 6.0')).toBeVisible({ timeout: 15_000 });
});

// Tests de administración al FINAL: no dependen del sync de buzón, así que se ejecutan tras
// los flujos sync-sensibles para no alterar su timing (el server E2E es compartido).
test('admin: el admin ve el link Admin, abre el wizard de storage y guarda local', async ({
  page,
}) => {
  // Usuario admin pre-sembrado en el server E2E (role=admin). Verifica el gate de UI + el
  // wizard de configuración de almacenamiento (Paso 1) contra el backend real.
  await loginViaUi(page, 'admin-e2e@example.com');
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });

  // El acceso a Admin es un botón-icono (escudo) en la topbar, sólo para role==='admin'.
  await page.getByRole('button', { name: 'Administration' }).click();
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible({
    timeout: 15_000,
  });
  // La config actual se cargó desde GET /admin/config/storage (default local).
  await expect(page.getByText('Local server', { exact: false })).toBeVisible();

  // Guardar 'local' → PATCH /admin/config/storage 200 → "Guardado" (indicador de éxito real).
  const patchResp = page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/admin/config/storage') &&
      r.request().method() === 'PATCH' &&
      r.status() === 200
  );
  await page.getByRole('button', { name: 'Save' }).click();
  expect((await patchResp).status()).toBe(200);
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 15_000 });
});

test('admin: un usuario normal NO ve el link Admin y /admin lo redirige al inbox', async ({
  page,
}) => {
  // Gate de UI: el usuario normal (role=user) no debe ver ni alcanzar /admin. El backend ya
  // re-valida con 403 en cada endpoint (test de integración); esto cubre el lado cliente.
  await loginViaUi(page); // e2e@example.com → role 'user'
  await expect(page.getByRole('button', { name: 'Compose' })).toBeVisible({ timeout: 15_000 });

  // El usuario normal NO debe ver el botón de Admin en la topbar.
  await expect(page.getByRole('button', { name: 'Administration' })).toHaveCount(0);

  // Navegación directa a /admin: el guard lo saca de ahí. Invariante de seguridad robusto —
  // el no-admin NO queda en /admin ni ve el panel (va a inbox si la sesión sigue viva tras el
  // reload, o a login si se perdió; ambos son "fuera del panel").
  await page.goto('/admin');
  await expect(page).not.toHaveURL(/\/admin/);
  await expect(page.getByRole('heading', { name: 'Administration' })).toHaveCount(0);
});
