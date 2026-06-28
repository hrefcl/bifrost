# Pendientes — Punch-list del PM (A)

> Capturado: 2026-06-28. Origen: feedback directo del PM ("estamos mucho mejor… pero faltan cosas").
> Estado general del proyecto: F3.0–F3.9 APPROVED; `/health/ready` cerrado y commiteado.
>
> **Estado al 2026-06-28: PM-01..04 y N1..N5 RESUELTOS y commiteados (3 commits, gates verdes:
> api 191/191, web 20/20, typecheck+lint+build).** Detalle de cada uno abajo (marcados `hecho`).

## Leyenda

- **Prioridad:** P0 = bug que rompe uso, P1 = feature core faltante (Roundcube administrable), P2 = mejora.
- **Estado:** `pendiente` | `en-progreso` | `hecho`.

---

## PM-01 — Logout no funciona bien  · P0 · `hecho`

**Síntoma (PM):** "el logout no funciona bien OJO".

**Diagnóstico (ya investigado):** El flujo de datos está bien —
`stores/auth.ts:logout()` hace `POST /auth/logout` (backend revoca refresh token y
borra la cookie httpOnly, `routes/auth.ts:98`) y luego `clearSession()` (borra token en
memoria + header Authorization). **El bug es de navegación:** en
`layouts/AppLayout.vue:146` el botón es `@click="auth.logout()"` y **no redirige a
`login` después**. Resultado: se limpia la sesión pero el usuario queda en la vista
actual (inbox) con estado vacío/roto en vez de volver al login. El menú de avatar
tampoco se cierra.

**Fix propuesto:** handler `onLogout()` en AppLayout que haga
`await auth.logout()` y luego `router.push({ name: 'login' })` (y cerrar el dropdown).
Considerar `try/finally` para redirigir aunque el POST falle (la sesión local igual se
limpia). Verificar el guard del router (`router/index.ts`) por si requiere un replace.

**Archivos:** `packages/web/src/layouts/AppLayout.vue`, `packages/web/src/stores/auth.ts`.

---

## PM-02 — Modal de crear evento se ve mal (overflow)  · P0 · `hecho`

**Síntoma (PM):** "el modal de crear evento se ve mal [imagen] pero genera". La imagen
muestra el input "Fin" (`datetime-local`) desbordándose por el borde derecho del modal.
Funciona (crea el evento), pero el layout está roto.

**Diagnóstico:** `datetime-local` tiene un ancho intrínseco (min-content) que rompe las
columnas del grid `.grid2` (`grid-template-columns: 1fr 1fr`) salvo que se fuerce
`min-width: 0` en los items y `width: 100% / box-sizing: border-box` en los inputs.

**Fix propuesto:** en `CalendarView.vue`, CSS de `.grid2 > *` → `min-width: 0`; `.field`
(input) → `width: 100%; box-sizing: border-box; min-width: 0`. Revisar también padding
del modal.

**Archivos:** `packages/web/src/views/CalendarView.vue`.

---

## PM-03 — Admin no permite gestionar cuentas/cuotas  · P1 · `hecho`

**Síntoma (PM):** "admin@example.com … no me permite crear más cuentas ni administrar
cuenta existente ni cuota ni nada… faltan más opciones, recordemos que esto es un
Roundcube administrable".

**Estado actual:** `AdminView.vue` sólo tiene el wizard de almacenamiento (local/S3).
Falta TODO el panel de administración de usuarios/cuentas.

**Alcance propuesto (Roundcube administrable):**
- Listar usuarios/cuentas existentes.
- Crear cuenta nueva (alta de usuario + cuenta IMAP/SMTP).
- Editar cuenta existente (datos, reset, habilitar/deshabilitar → ya existe `Account.status` 'disabled').
- Cuotas (definir modelo de cuota por cuenta + enforcement; hoy no existe).
- (futuro) roles, suspensión, ver estado de sync por cuenta (ya tenemos los conteos en `/health/ready`).

**Archivos:** `packages/web/src/views/AdminView.vue`, `packages/api/src/routes/admin.ts`,
modelos `User`/`Account` (cuota nueva). Backend nuevo: endpoints CRUD de cuentas + cuota.

---

## PM-04 — Branding (nombre + logo de empresa) no configurable en UI  · P1 · `hecho`

**Síntoma (PM):** "no vi dónde puedo configurar el nombre de la empresa ni el logo de la
empresa". Es un webmail white-label (reemplazo de Roundcube brandeable por empresa).

**Estado actual:** el branding existe sólo vía env (`VITE_BRAND_*` en `config/brand.ts`,
default "Bifrost"). No es editable en runtime desde el admin (estaba registrado como
deuda LOW).

**Alcance propuesto:** guardar branding (nombre, logo, color de acento) en `SystemConfig`
(ya existe el modelo, hoy guarda config de storage), endpoint admin para leer/escribir,
servir el branding al frontend al boot, y sección en `AdminView.vue` para editarlo
(incluyendo upload del logo).

**Archivos:** `packages/api/src/models/SystemConfig.ts`, `packages/api/src/routes/admin.ts`,
`packages/web/src/config/brand.ts` (cargar de API), `packages/web/src/views/AdminView.vue`.

---

## Carryover — deuda técnica de producción (menor, ya registrada)

- Migrar sync IMAP de fondo a BullMQ (hoy loop auto-agendado con lock distribuido).
- Limpieza de índices muertos/redundantes; cap de `removedAt`; `snoozed $in`; índices de drafts.
- Gates abiertos previos: E2E completo y docker (verificar antes de cierre).

---

## Segunda tanda — Reading pane + TopBar (2026-06-28)  · todos `hecho`

- **N1 — Kebab (3 puntos) del reading pane** no abría menú → menú con Responder/Reenviar/
  Marcar como no leído (nuevo: PATCH `seen:false` + vuelve a la lista)/Imprimir/Eliminar.
- **N2 — Modal "Posponer hasta"** descuadrado → label arriba, fila input+botón abajo
  (`min-width:0`/`box-sizing`).
- **N3 — "Mover a"** casi siempre vacío/deshabilitado → `moveTargets` ahora son TODAS las
  carpetas salvo la actual, ordenadas estilo Gmail.
- **N4 — Embudo de filtro del TopBar** no hacía nada → popover de filtros (Todos/No leídos/
  Destacados/Con adjuntos) que controla el filtro de la lista vía `store ui` (compartido con el
  Inbox; `listFilter` movido al store). La barra de búsqueda ya estaba cableada (Enter →
  `/emails/search`, `$text`); si vuelve a fallar, hace falta un repro concreto.
- **N5 — Dropdown de filtro de la lista** se desbordaba a la derecha (`left:0` → `.right`
  `right:0`) y el kebab de la lista no hacía nada → menú "Marcar todas como leídas" + "Actualizar".

