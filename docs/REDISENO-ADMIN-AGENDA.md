# Rediseño UX/UI — Panel de Administración + Agenda

**Tipo de cambio:** FEATURE (rediseño UX/UI; +1 capacidad frontend menor: UI de Excepciones sobre API existente).
**Estado:** IN_REVIEW_DOC v2 (FASE 2).
**Rama:** `worktree-rediseno-admin-agenda`.

## 0. Resolución de condiciones de revisión (v1 → v2)

Revisión v1: **B (Codex) 7.5/10 APPROVE c/condiciones** (2 HIGH), **D (Kimi) 5/10 NOT APPROVE** (10 MEDIUM/LOW), C pendiente.
Todas las condiciones se incorporan a continuación:

| # | Condición (origen) | Resolución en v2 |
|---|---|---|
| B-HIGH-1 / D-002 | Dependencia Google Fonts vs CSP | **No depender de Public Sans ni añadir assets externos.** Se quita el `<link>` a `fonts.googleapis.com` de `index.html` (ya estaba bloqueado por CSP → la app ya usa el stack de sistema). Cero CDNs nuevos. Stack `-apple-system,…` es el look base. |
| B-HIGH-2 / D-001/D-003 | E2E concreto del booking + estrategia de slots | §10 lista casos E2E concretos + `data-testid` estables. Calendario mensual = carga de slots **por-día al click** (no bulk), reusando el guard `slotsReq` y la `Idempotency-Key` actuales. |
| B-MED / D-006 | Responsive sidebar | §3.1 spec: drawer off-canvas <900px, botón hamburguesa, cierre con Esc/click-outside, foco atrapado, sticky en desktop. |
| B-MED / D-010 | A11y | §3.4 checklist verificable: `<nav aria-label>`, `aria-current="page"`, botones reales, label en icon-only, `:focus-visible`, focus-trap en modales, calendario navegable por teclado. |
| B-MED | Excepciones = cambio funcional | PATCH es PARCIAL (`availabilityBody.partial()` + `$set` parcial, **verificado en schedule.ts**) → enviar sólo `{overrides}` NO pisa `weeklyRules`/`timezone`. Pruebas de persistencia en §10. |
| D-004 | `v-html` en AppIcon | `name` se tipa como unión cerrada `keyof typeof ICON_PATHS`; `ICON_PATHS` permanece literal estático del módulo. |
| D-005 | Dark mode sub-paneles | `ComplianceAdmin`/`AdminSchedulingPanel`: reemplazar colores hardcodeados por tokens `theme.css`. |
| D-007 | `v-html` con datos de usuario | Regla dura: en públicas SOLO `{{ }}` para `displayName/title/description/answers/brand`. Nunca `v-html` con dato de usuario/marca. |
| D-008 | UX de overrides | Validación cliente: sin fechas pasadas, sin fecha duplicada, intervalos `end>start`; `intervals:[]`=día no disponible; editar/borrar override existente. |
| D-009 | Estado feature deshabilitada (host) | Si `settings.enabled=false`, el host ve banner informativo; igual puede configurar (la página pública es la que se apaga). |
| B-LOW | Omitir Grupos/Roles/Meet | Sin items fantasma en el sidebar; sin copy que prometa lo inexistente. |
| B-LOW / Regresion Map | AppIcon keys | No renombrar keys existentes; validar iconos de Inbox/AppLayout tras el cambio. |

### 0.1 Condiciones de integridad (C, 8/10) — incorporadas

- **C-MUST-1 / B-HIGH (lost-update overrides):** PATCH era `$set` del array completo sin control de
  concurrencia → last-write-wins. **Resuelto con CAS atómico real** (no sólo chequeo en cliente):
  `PATCH /availability/:id` acepta un campo OPCIONAL `expectedUpdatedAt`; si se envía, el filtro de
  `findOneAndUpdate` exige `updatedAt === expectedUpdatedAt`. Como `timestamps:true` bumpea `updatedAt`
  en cada update, dos escrituras concurrentes sobre el mismo baseline → la 2ª no matchea → **409**.
  Backward-compatible (sin el campo, comportamiento idéntico al previo → no rompe contrato). El cliente
  (`saveOverrides`) hace fetch fresco, pre-chequea en cliente (early-exit UX) y manda `expectedUpdatedAt`;
  el 409 se mapea a `scheduling.excConflict`. Cubierto por test de no-clobber en `schedule.test.ts`.
- **C-MUST-2 (timezone del override):** el override se ancla a `schedule.timezone` (no a la tz del
  browser). El date-picker de Excepciones **renderiza/etiqueta en la tz del schedule**; toggle explícito
  **"No disponible todo el día" (`intervals:[]`) vs "Horario especial"** (intervalos) → nunca array vacío
  accidental. Apunta al `:id` del schedule activo (default o primero).
- **C-CONFIRM-3 (público):** se **conservan** `Idempotency-Key` y el guard `slotsReq`; el lock servidor
  con `isSlotBookable` es autoritativo (defense-in-depth). El calendario mensual no altera esto.

## 1. Problema / objetivo

Reemplazar el diseño de dos pantallas por uno moderno tipo SaaS, según maquetas entregadas
(`admin.html`, `scheduling.html`), manteniendo arquitectura, features y contratos actuales.

- `/admin` → consola estilo **Google Workspace Admin** (sidebar de secciones + área de contenido).
- `/scheduling` (host) → experiencia tipo Calendly limpia (Tipos / Disponibilidad+Excepciones / Reservas).
- Páginas públicas `/u/*` → perfil, flujo de reserva con calendario, gestión, 404 (alineadas a maqueta).

**NO es bug:** `/u/{slug}` daba 404 porque la Agenda estaba **desactivada en Admin** (`enabled:false`
por defecto, gate `enabled()` en `schedule-public.ts`). Es el gate funcionando. No se "arregla".

## 2. Fuente de verdad y decisiones de producto

- **El código es la verdad.** La maqueta admin muestra secciones SIN backend en `main` (Grupos, Roles,
  Preferencias de calendario, Salas/Meet-LiveKit). LiveKit/Meet vive en otra rama no mergeada.
  - **PRODUCT DECISION (A):** el rediseño implementa SOLO secciones con backend real:
    **Cuentas, Marca, Almacenamiento, Compliance, Agenda**. No se inventan secciones sin backend
    (evita UI muerta / promesas falsas). Trade-off: menos "completo" que la maqueta; se gana
    coherencia funcional y cero deuda. La rejilla del sidebar queda preparada para sumar secciones.
- Branding de la página pública = branding del admin de email (ya es así; PublicLayout usa `brand`).

## 3. Arquitectura del cambio

- Vue 3 `<script setup>`, Pinia, vue-i18n, CSS scoped con tokens en `assets/theme.css`
  (`--bg --surface --surface-dim --border --border-strong --hover --text-1/2/3 --accent --shadow-*`).
  **Todo el rediseño usa estos tokens** → dark mode y branding por color salen gratis.
- Iconos: `AppIcon.vue` (set lucide, `v-html` de literal estático). Se añadirán paths nuevos
  (palette, database, briefcase, calendarClock, copy, externalLink, edit, chevron…) al mismo mapa.
- **Admin shell**: AdminView mantiene `<AppLayout>` (topbar global: tema, avatar, volver a inbox,
  gates de auth/compliance intactos). Dentro, layout de 2 paneles:
  - **Sidebar** izquierda (sticky): branding mini + lista de secciones con icono/label + footer build/version.
  - **Content**: header de sección (breadcrumb + título + descripción + acción primaria) + cuerpo.
  - Las 5 secciones pasan de *tabs superiores* a *items de sidebar* (`tab` ref se mantiene; solo cambia
    la presentación). La lógica de cada sección NO cambia (mismos handlers, mismos endpoints).
  - `ComplianceAdmin.vue` y `AdminSchedulingPanel.vue` se hostean tal cual en el content (restyle ligero
    para encajar con el shell; sin tocar su lógica/endpoints).
- **Scheduling host**: `SchedulingView.vue` mantiene tabs (Tipos/Disponibilidad/Reservas), restyle a
  cards/listas de la maqueta. Se **añade UI de Excepciones** (overrides) en Disponibilidad — el backend
  ya soporta `AvailabilityOverride{date,intervals,note}` (`intervals:[]`=no disponible). Detalle de
  reserva en panel/modal. Modal de username/enlace público.
- **Públicas**: `PublicProfileView`, `PublicBookingView` (calendario mensual en vez de flechas de día),
  `PublicManageView`, y estado 404 — restyle sobre `PublicLayout`. Sin cambiar los endpoints ni el
  contrato de `api.get('/schedule/public/...')`.

## 4. Componentes nuevos / modificados

| Archivo | Acción | Nota |
|---|---|---|
| `views/AdminView.vue` | reescribe template+estilos | misma lógica/script; shell sidebar |
| `components/admin/AdminSidebar.vue` (nuevo, opcional) | extrae sidebar | o inline en AdminView |
| `components/admin/ComplianceAdmin.vue` | restyle ligero | sin tocar lógica |
| `components/admin/AdminSchedulingPanel.vue` | restyle ligero | sin tocar lógica |
| `views/SchedulingView.vue` | reescribe template+estilos | + UI Excepciones (overrides) |
| `views/public/PublicProfileView.vue` | restyle | mismo fetch/estado |
| `views/public/PublicBookingView.vue` | restyle + calendario mensual | mismo flujo/idempotencia |
| `views/public/PublicManageView.vue` | restyle | mismo flujo token |
| `components/AppIcon.vue` | + paths de iconos | literales estáticos |
| `i18n/locales/{es,en}.ts` | + claves nuevas | reusar claves existentes donde haya |

## 5. Regresion Map

| Componente | Dependencia | Riesgo | Cómo validar |
|---|---|---|---|
| AppLayout (topbar) | AdminView/SchedulingView se renderizan dentro | LOW | nav admin/scheduling sigue activa; volver a inbox |
| `tab` state admin | secciones mismas, distinta presentación | LOW | cada sección carga sus datos (Promise.all onMounted intacto) |
| Endpoints `/admin/*` | sin cambios de contrato | LOW | crear/editar/baja cuenta; guardar marca; storage test/save; compliance; scheduling settings/audit |
| `AppIcon` set | añadir paths, no renombrar existentes | LOW | iconos previos (inbox/star/…) siguen ok en Inbox/AppLayout |
| i18n | añadir claves, no borrar | MEDIUM | claves usadas en otras vistas intactas; en/es paridad |
| Scheduling overrides (nuevo) | PATCH /schedule/availability con `overrides` | MEDIUM | crear/editar/borrar excepción; backend valida fecha/intervalos |
| PublicBookingView slots | guard `slotsReq` anti out-of-order, idempotencyKey | HIGH | navegar meses rápido no pinta slots viejos; reservar; replay 409/503 |
| PublicProfileView estados | loading / 404 / serverError | MEDIUM | feature off→404; on→perfil; error→mensaje |
| CSP nginx | sin assets externos nuevos (sin CDN) | HIGH | NO fuentes/scripts externos; todo self; build sirve igual |
| Dark mode + branding | usar solo tokens CSS | MEDIUM | toggle tema; cambiar color de marca refleja en ambas pantallas |

## 6. Plan de implementación por fases

- **F1 — Admin shell**: AppIcon paths, AdminView sidebar+content, restyle sub-paneles, i18n. 
- **F2 — Scheduling host**: SchedulingView restyle + Excepciones UI + detalle reserva + modal enlace.
- **F3 — Públicas**: Profile + Booking (calendario) + Manage + 404.
- Cada fase: typecheck + build + unit/e2e afectados + revisión B/C/D del diff.

## 7. Testing
- `pnpm --filter @webmail6/web typecheck` y `build` limpios.
- Unit/E2E existentes de scheduling/admin no se rompen (Playwright e2e).
- Validación manual responsive (desktop/tablet) + dark mode + estados vacío/carga/error.

## 8. Rollback
- Cambios 100% frontend, backward-compatible. Rollback = revert del/los commits de la rama.
- Sin migraciones, sin cambios de datos, sin cambios de contrato de API.

## 9. Observabilidad
- No aplica backend nuevo. La auditoría de reservas (admin) y errores de red ya tienen manejo.

## 3.1 Responsive (sidebar admin)
- Desktop ≥900px: sidebar sticky 240px + contenido fluido.
- <900px (tablet vertical/móvil): sidebar como **drawer off-canvas**; botón hamburguesa en el header de
  sección lo abre; overlay semitransparente; cierra con **Esc**, click en overlay o al elegir sección.
  Foco atrapado mientras está abierto; al cerrar, foco vuelve al botón. No tapa la acción primaria.
- Scheduling host y públicas: grids con `auto-fill/minmax` → colapsan a 1 columna en angosto. Calendario
  mensual: celdas táctiles ≥40px.

## 3.4 Accesibilidad (checklist verificable)
- Sidebar admin: `<nav aria-label="Administración">`, items `<button>`/`<a>` reales, `aria-current="page"`
  en activo. Iconos `aria-hidden` (ya lo son) + texto visible o `aria-label` en icon-only.
- `:focus-visible` con anillo de acento en todos los interactivos.
- Modales (tipo evento, excepción, enlace público, detalle reserva): `role="dialog"`, `aria-modal`,
  focus-trap, Esc cierra, foco inicial al primer campo, retorno de foco al disparador.
- Calendario público: grid navegable por teclado (flechas + Enter), días deshabilitados con `aria-disabled`.
- Contraste: tokens actuales cumplen AA en claro/oscuro; texto sobre acento usa `#fff`.

## 10. Plan de testing concreto (E2E + unit)
**Unit/typecheck:** `pnpm --filter @webmail6/web typecheck` + `build` limpios.
**E2E Playwright (actualizar selectores al nuevo DOM; añadir `data-testid` estables):**
- `admin-sidebar`, `admin-section-<key>`, `admin-section-title`.
- `sched-tab-<types|availability|bookings>`, `sched-public-link`, `sched-exception-modal`.
- públicas: `pub-eventtype-<slug>`, `pub-calendar`, `pub-day-<iso>`, `pub-slot-<iso>`, `pub-book-submit`,
  `pub-confirmed`, `pub-notfound`.

Casos:
1. Admin: navegar las 5 secciones por el sidebar; cada una carga sus datos; volver a inbox por topbar.
2. Admin móvil (<900px): abrir/cerrar drawer; elegir sección lo cierra.
3. Scheduling host: crear/editar tipo; toggle activo; copiar enlace; crear/editar/borrar **excepción** y
   verificar que `weeklyRules` y `timezone` no cambian (persistencia: refetch).
4. Público feliz: perfil→tipo→calendario→elegir día (fetch slots)→elegir hora→datos→confirmar (201).
5. Público stale: navegar meses/días rápido NO pinta slots de un día previo (guard `slotsReq`).
6. Público idempotencia/errores: reintentar reserva (misma `Idempotency-Key`); 409 vuelve a paso hora;
   503 muestra "servicio ocupado".
7. Público 404: feature off o slug inexistente → pantalla "Página no encontrada".
8. Dark mode + branding: toggle tema y cambio de color de marca reflejan en admin, host y públicas.

## 6.bis Fase de testing
- **F4 — Validación**: actualizar/añadir E2E y `data-testid`, typecheck+build, recorrido manual responsive
  y dark mode, evidencias (capturas antes/después). Revisión final B/C/D del diff completo por fase.
