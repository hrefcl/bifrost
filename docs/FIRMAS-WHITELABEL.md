# Firmas white-label con templates + branding endurecido (diseño v2)

**Estado:** DISEÑO v2 — endurecido tras gate B/C/D (B 6.5 · C 7 · D 6, todos "arquitectura OK,
cerrar precisiones de seguridad"). Los HIGH/MED están incorporados en la sección **§Seguridad
(obligatorio)** al final. Alcance acordado con el PM (2026-07-02).

## Objetivo
Bifrost ofrece un catálogo de templates de firma. Cada template se rellena solo con el **branding
del admin** (logo, empresa, dominio, color) + los **datos personales** del usuario (cargo, teléfono,
foto). El admin controla qué templates existen y puede **bloquear** decisiones personales (color de
la app, template) para forzar coherencia de marca. Es la evolución white-label del generador
"un-solo-template" de referencia (Cleverty).

## Decisiones fijadas con el PM
1. **Render DINÁMICO**: se guarda `{templateId + datos}`, se rendiza al ENVIAR con el branding vigente.
   Si el admin cambia logo/URL/color → todas las firmas se actualizan solas (white-label real).
2. **Bloqueo de color = APP ENTERA + firma**: si el admin bloquea el color, se oculta el selector
   personal y toda la app usa el color de marca (no solo la firma).
3. **v1 = 4-5 templates sólidos**, el resto después.
4. **Datos personales en el User** (`jobTitle`, `phone`, `department`, `photoUrl`): sirven a la firma
   Y a la ficha del admin (Cargo/Departamento que quedó sin backend en el rediseño).

## Anclas en el código existente (no se reinventa nada)
- `services/branding.ts` — singleton `SystemConfig{key:'branding'}` white-label con RBAC `branding.manage`.
  **Se EXTIENDE** con campos nuevos (no se crea otro singleton para el branding).
- `drafts.ts:377-386` — punto ÚNICO donde la firma se inyecta server-side al enviar. **Acá se rendiza
  el template** dinámicamente (branding + datos del User) en vez de leer un HTML estático.
- `services/signature-images.ts` — externaliza `data:` → URL servida (Gmail bloquea `data:`). Reutilizado
  para el logo de marca dentro de la firma.
- Patrón SystemConfig singleton (KEY + DEFAULT + deep-merge + zod `.strict()` + endpoint con permiso) —
  usado para la nueva `signaturePolicy`.
- `stores/settings.ts` — el accent personal vive SOLO en localStorage y pisa el de marca. El bloqueo
  app-wide se implementa acá (respetar `lockAccentColor` del branding público).

## Modelo de datos

### Branding extendido (`BrandingConfig`, campos nuevos OPCIONALES)
```
domainUrl?: string        // https://aulion.app — CTA/URL de la firma
phone?: string            // teléfono corporativo
address?: string          // dirección (templates que la usen)
socialLinks?: { linkedin?, instagram?, x?, facebook?, youtube? }  // URLs
logoWidthPx?: number      // ancho del logo en la firma (default 120)
```
Los actuales (companyName, tagline, accentColor, logoDataUrl) se mantienen. Todos opcionales: cada
template usa lo que necesita y omite lo ausente. **`domainUrl` y cada `socialLinks[*]` se validan
http(s) en el schema (patrón `isSafeS3Endpoint`): no `javascript:`/`data:` (ver §Seguridad H1).**

### Política de firmas (`SystemConfig{key:'signaturePolicy'}`, singleton nuevo)
```
allowedTemplateIds: string[]   // SIEMPRE filtra lo que el usuario puede elegir. [] = todo el catálogo.
lockTemplate: boolean          // true → el usuario no elige, se usa allowedTemplateIds[0]
lockAccentColor: boolean       // true → oculta el picker personal; toda la app usa el color de marca
enforceSignature: boolean      // true → firma corporativa SIEMPRE (autoInclude forzado on)
allowCustomHtml: boolean       // false → prohíbe el 'source:custom' (HTML pegado)
```
**Invariantes (validadas en `setSignaturePolicy`, patrón XError→400):**
- Semántica explícita: `allowedTemplateIds` SIEMPRE filtra; NO hay "length 1 = forzado" implícito —
  forzar es SOLO `lockTemplate=true`.
- `lockTemplate=true` ⇒ `allowedTemplateIds` tiene ≥1 id VÁLIDO del catálogo (rechazar si no).
- todo id en `allowedTemplateIds` debe existir en el catálogo estático (se ignoran/rechazan stale).
Gate admin: reusa `branding.manage` (firmas = asunto de marca) — no se agrega permiso nuevo.

### Firma del usuario (`preferences.signature`, patrón $set dirigido del PATCH actual)
```
signature: {
  source: 'template' | 'custom'          // 'custom' = HTML pegado (legado, sigue soportado)
  templateId: string                     // cuál del catálogo
  fields: { includePhoto: boolean }      // overrides por-usuario acotados (el resto sale del User)
}
```
El `defaultSignature` HTML actual se mantiene para `source:'custom'`.

### Datos personales (User, campos nuevos OPCIONALES)
```
jobTitle?: string      // Cargo (cierra el gap de la ficha admin)
department?: string    // Departamento (idem)
phone?: string         // teléfono personal (fallback al corporativo del branding)
photoUrl?: string      // foto: SOLO URL interna /api/signature-images/:id (NUNCA URL remota — ver §Seguridad H2)
```
Editables por el usuario (Ajustes) y por el admin (ficha de usuario del rediseño), vía PATCH `.strict()`
con `$set` dirigido (anti mass-assign). Entran en la serialización de login/`/auth/me` (patrón campos
top-level). La FOTO se sube como data-url ráster (mismo regex+tamaño que el logo), se externaliza al
GUARDAR vía `signature-images` y se persiste ya como URL interna — nunca se acepta `http(s)` directo.

## Catálogo de templates (`lib/signature-templates.ts`, estático)
Patrón idéntico al catálogo de permisos F8: array cerrado, no editable en runtime.
```ts
interface SignatureTemplate { id: string; name: string; render(ctx: SignatureContext): string }
interface SignatureContext {
  // branding
  companyName?, tagline?, logoUrl?, domainUrl?, accentColor?, phone?, address?, socialLinks?, logoWidthPx?
  // persona (del User)
  displayName, jobTitle?, department?, personalPhone?, photoUrl?, email
}
```
Cada `render` devuelve HTML de **tabla con estilos inline** (email-safe). v1 (4-5 arquetipos):
1. **Horizontal clásico** — foto/logo izq · datos + acento a la der.
2. **Vertical minimal** — nombre/cargo/empresa apilados, barra de acento lateral.
3. **Con foto circular B/N** (estilo Cleverty) + datos + WhatsApp del teléfono.
4. **Corporativo con logo** — logo de marca arriba, datos + fila de redes.
5. **Minimal texto** — sin imágenes, una línea con acento (máx compatibilidad).

## Flujo de render (dinámico, al enviar)
En `drafts.ts` (send hook), reemplazar la lectura de `defaultSignature` por:
```
1. leer user.preferences.signature + user (datos personales) + getBranding() + getSignaturePolicy()
2. resolver template efectivo:
   - si policy.lockTemplate → allowedTemplateIds[0]
   - si no → signature.templateId (validado ∈ allowedTemplateIds; si stale/ausente → primer permitido)
   - si source==='custom' && policy.allowCustomHtml → usar defaultSignature crudo
3. render(ctx) → HTML  ← ESCAPA todo texto interpolado (escapeHtml) + valida esquema de toda URL
                          (http|https|mailto|tel). Ver §Seguridad H1.
4. externalizeDataImages(logo/foto) → sanitizeEmailHtml (BACKSTOP, no única capa) → append (sep RFC 3676)
5. autoInclude: forzado on si policy.enforceSignature
```
El branding se lee EN CADA envío → cambios de marca se reflejan sin tocar las firmas guardadas.
Costo: +2 `SystemConfig.findOne` indexados sobre colección diminuta + upserts idempotentes por hash
(dedup existente) → despreciable frente al SMTP+IMAP APPEND (confirmado B/C). Opcional cache TTL corto.

**Fail-open acotado (H/M — enforceSignature):** el render de templates estáticos es determinístico y no
debe fallar con datos bien formados. Si aun así el render lanza:
- `enforceSignature=false` → enviar SIN firma (no bloquear el correo).
- `enforceSignature=true`  → fallback determinístico a **firma mínima en TEXTO PLANO** (displayName +
  companyName + contacto), construida sin template ni imágenes → nunca se envía sin firma corporativa,
  nunca se bloquea el envío.
En ambos casos: `log/metric signature_render_failed` (causa raíz). NUNCA se bloquea el envío del correo.

## UX
- **Admin → "Marca de la empresa"** (ampliada): campos nuevos de branding + panel **"Firmas"**:
  galería de templates con preview, selección de habilitados, toggles (forzar 1, bloquear color,
  firma obligatoria, permitir custom).
- **Usuario → Ajustes → "Firma"** (rediseñada): galería de templates permitidos con **preview en vivo**
  (sus datos + branding real), elige uno, edita cargo/teléfono/foto/depto. Si `lockTemplate` → sin
  selector. Si `lockAccentColor` → sin swatches de color en Ajustes. Endpoint `GET /me/signature/preview`
  (o render client-side con el catálogo espejado) para el preview.
- **Bloqueo de color app-wide**: el branding público expone `lockAccentColor`; `stores/settings.ts`
  ignora el accent de localStorage y `SettingsView` oculta los swatches cuando está activo.

## Fases
- **F1 — Branding extendido**: campos en `BrandingConfig` + schema `.strict()` + UI admin + exposición
  pública (`/api/branding`). Aislado, bajo riesgo.
- **F2 — Catálogo + render engine**: `lib/signature-templates.ts` (4-5) + `SignatureContext` + función
  `renderSignature(ctx, templateId)`. Tests de render (snapshot HTML por template).
- **F3 — Datos personales del User**: campos en User + shared + `/auth/me` + PATCH self + wiring en la
  ficha admin (Cargo/Departamento).
- **F4 — Firma del usuario + UI**: `preferences.signature` + galería en Ajustes + preview en vivo.
- **F5 — Hook de envío dinámico**: modificar `drafts.ts` para rendizar el template (branding+datos) al
  enviar. Backward-compatible con `source:'custom'` / `defaultSignature` legado.
- **F6 — Política + enforcement**: singleton `signaturePolicy` + panel admin "Firmas" + aplicar locks
  en la UI de usuario (template/color) + bloqueo de accent app-wide en `stores/settings.ts`.

## Compatibilidad / migración
- Usuarios con `defaultSignature` HTML existente → quedan como `source:'custom'` (nada se rompe).
- `signaturePolicy` ausente → defaults permisivos (todos los templates, sin locks): comportamiento
  actual + opción de templates. Deep-merge defensivo (patrón calendarDefaults).
- Sin política configurada, la firma sigue siendo opcional y editable como hoy.

## §Seguridad (obligatorio — cierra el gate B/C/D)
Contexto OUTBOUND (correo a terceros): "escape en origen + sanitize de salida", nunca una sola capa.

- **H1 — Escape + validación de URL en el render (los 3 reviewers, HIGH).** `renderSignature` DEBE
  HTML-escapar TODO texto interpolado no confiable (`displayName`, `jobTitle`, `department`, `phone`,
  `companyName`, etc.) con `escapeHtml`/`escapeAttr` (ya existe: `lib/sanitizeHtml.ts`, usado en
  `services/scheduling/email.ts:76`), y validar el esquema de TODA URL en `href`/`src`
  (`http|https|mailto|tel`). `sanitizeEmailHtml` queda como BACKSTOP final, no como única defensa
  (el sanitizer actual permite `img` con URL remota arbitraria → sin escape hay inyección/mXSS).
- **H2 — `photoUrl` nunca remota (los 3, HIGH).** Se sube como data-url ráster (regex+tamaño del logo,
  `admin.ts:40-44` + `MAX_IMG_BYTES` de `signature-images.ts`), se externaliza al GUARDAR y se persiste
  como URL interna `/api/signature-images/:id`. NO se acepta `http(s)` directo (evita tracking-pixel /
  exfiltración del destinatario; el servicio actual sólo externaliza `data:`, no descarga URLs → sin SSRF).
- **Fail-open × `enforceSignature`**: resuelto en §Flujo de render (fallback a firma mínima texto plano si
  `enforceSignature=true`; log `signature_render_failed`; nunca bloquear el envío).
- **Invariantes de `signaturePolicy`**: en §Política (lockTemplate ⇒ ≥1 id válido; ids ∈ catálogo).
- **Bloqueo de color — contrato público**: `/api/branding` expone `lockAccentColor`; `stores/settings.ts`
  hace no-op de `applyAccent()` (usa el accent de marca) y `SettingsView` oculta los swatches cuando está
  activo. Es la única forma de "app entera morada" sin persistir accent por-usuario (hoy es localStorage).
- **Preview = MISMO pipeline que el envío (LOW pero importante)**: el endpoint `GET /me/signature/preview`
  corre render+escape+`sanitizeEmailHtml` (no HTML crudo) y el front lo muestra sin `v-html` sobre valores
  sin sanear → evita auto-XSS en el browser del remitente. Debounce client-side. Fuente única = backend.

## Estados vacíos / a11y / i18n (MED/LOW)
- Cada `render` maneja ausencias: sin foto → sin celda de foto; sin logo → fallback texto; branding
  incompleto → omite filas, no rompe.
- Nombres de templates vía claves i18n (es/en), no hardcode.
- Selector de templates = `role=radio`/radiogroup, navegable por teclado, estado seleccionado anunciado,
  `alt` en los previews.
- Límite de foto = `MAX_IMG_BYTES` (reuso). Límite de `allowedTemplateIds` = subconjunto del catálogo.
- Tests obligatorios: snapshot HTML por template, XSS por cada campo interpolado, fail-open con
  `enforceSignature`, invariantes de policy.

## Estado del gate
Arquitectura APROBADA por los 3 (render dinámico en punto único, singletons espejados, catálogo estático,
fail-open, preview server-side). Con §Seguridad + invariantes incorporadas (esta v2), C lo marca
"APPROVE condicionado" cumplido. Sugerido: breve re-check de D (el más estricto) sobre v2 antes de F1.
