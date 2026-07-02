# Firmas white-label con templates + branding endurecido (diseño v1)

**Estado:** DISEÑO (pendiente gate B/C/D). Alcance acordado con el PM (2026-07-02).

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
template usa lo que necesita y omite lo ausente.

### Política de firmas (`SystemConfig{key:'signaturePolicy'}`, singleton nuevo)
```
allowedTemplateIds: string[]   // subconjunto del catálogo habilitado. [] = todos. length 1 = forzado.
lockTemplate: boolean          // true → el usuario no elige, se usa allowedTemplateIds[0]
lockAccentColor: boolean       // true → oculta el picker personal; toda la app usa el color de marca
enforceSignature: boolean      // true → firma corporativa SIEMPRE (autoInclude forzado on)
allowCustomHtml: boolean       // false → prohíbe el 'source:custom' (HTML pegado)
```
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
photoUrl?: string      // foto (círculo B/N como el de referencia; via signature-images)
```
Editables por el usuario (Ajustes) y por el admin (ficha de usuario del rediseño).

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
1. leer user.preferences.signature + user (datos personales) + getBranding() + signaturePolicy
2. resolver template efectivo:
   - si policy.lockTemplate → allowedTemplateIds[0]
   - si no → signature.templateId (validado ∈ allowedTemplateIds, si no fallback al primero permitido)
   - si source==='custom' && policy.allowCustomHtml → usar defaultSignature crudo
3. render(ctx) → HTML
4. externalizeDataImages(logo/foto) → sanitizeEmailHtml → append (separador RFC 3676 actual)
5. autoInclude: forzado on si policy.enforceSignature
```
El branding se lee EN CADA envío → cambios de marca se reflejan sin tocar las firmas guardadas.

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

## Riesgos / puntos a validar en B/C/D
- **Render en el send-hook**: no debe agregar latencia notable ni fallar el envío si el branding/logo
  falla (fail-open: si el render tira error, caer al `defaultSignature`/sin firma, nunca bloquear el envío).
- **Externalización del logo por-envío**: dedup por hash ya existe (no re-sube el mismo logo cada vez).
- **Sanitización**: el HTML de los templates es nuestro (estático), pero pasa igual por `sanitizeEmailHtml`.
- **Preview vs render real**: si el preview es client-side, el catálogo se espeja en web → riesgo de
  drift. Alternativa: endpoint `GET /me/signature/preview` que rendiza server-side (fuente única).
  Recomendado el endpoint para no duplicar los templates.
