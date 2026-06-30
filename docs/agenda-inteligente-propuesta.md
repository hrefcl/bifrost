# Propuesta — Agenda Inteligente (scheduling tipo Calendly nativo en Bifrost)

> Estado: **gate técnico Fase 2 APROBADO** (v3) — B (Codex, autoridad primaria) APPROVE **9/10**;
> D (Kimi, auditor) APPROVE **9/10**; C (z.ai GLM) `TEAM_UNAVAILABLE` (529 sostenido — sus 5 HIGH de v1
> resueltos en v2, valida v3 al recuperar, antes del merge). 0 HIGH abiertos. Pendiente: **aprobación del PM**
> (requisito del enunciado) antes de Fase 3.0.
> Historial de scores: v1 B7/C7/D5 (NOT APPROVE) → v2 B8/D0-HIGH/C n-a → v3 **B9/D9 APPROVE**.
> Tipo de cambio: **FEATURE** (proceso completo A/B/C/D).
> Equipo A: Claude Code · Cadena de autoridad: B → D (F excluido, REGLA 0.1).
> Rama: `worktree-calendar-scheduling` (worktree aislado del otro agente).

---

## 0. Resumen ejecutivo

Construir un sistema de **programación de reuniones** nativo de Bifrost, equivalente
funcional a Calendly, **sin depender de Google/Microsoft**. Cada usuario publica uno o
más enlaces públicos (`https://mail.midominio.com/u/francisco`) donde clientes externos
eligen un horario libre y reservan. La reserva se confirma por correo (vía el SMTP del
propio usuario → entregabilidad y branding propios), genera un evento en el calendario
interno de Bifrost, y se protege contra dobles reservas.

**Ventaja estructural sobre Calendly:** Calendly necesita *sincronizar* con calendarios
externos para evitar choques; Bifrost **es** el calendario, así que la detección de
conflictos lee directamente la única fuente de verdad (`CalendarEvent`). Desaparece toda
la complejidad y los bugs de sincronización bidireccional.

---

## 1. Investigación de Calendly (qué resuelve, no cómo)

Calendly resuelve el ida-y-vuelta de "¿qué hora te queda bien?". El anfitrión define su
disponibilidad **una vez**; el invitado ve solo huecos libres y reserva en un click.

Funcionalidades observadas (calendly.com/features + dominio):

- **Tipos de evento** (event types): plantillas de reunión (30-min 1:1, 45-min, etc.),
  cada una con su propio enlace, duración, ubicación y reglas.
- **Disponibilidad**: horas laborales por día de semana, *buffers* entre reuniones,
  límite de reuniones por día, anticipación mínima, ventana máxima a futuro.
- **Sincronización de calendarios** (Google/Outlook/Exchange) para no chocar →
  *en Bifrost esto es innecesario: leemos el calendario interno.*
- **Videollamada**: link único por reunión (Zoom/Meet/Teams) → en Bifrost v1 el link es
  un campo configurable por el anfitrión (sin integración con un proveedor todavía).
- **Página de reserva pública** personalizable + link compartible.
- **Preguntas personalizadas / routing forms**: pedir datos al invitado.
- **Recordatorios automáticos** (email/SMS) anti no-show.
- **Reagendar / cancelar** desde el correo de confirmación.
- **Tipos avanzados**: colectivos (varios anfitriones), round-robin (reparto entre equipo),
  group (varios invitados por slot), meeting polls.
- **Zona horaria**: el invitado ve los horarios en *su* zona; el anfitrión configura en la suya.
- **Branding / Analítica**.

---

## 2. Clasificación de funcionalidades

### 2.1 Imprescindibles (MVP — lo que el PM pidió como "alcance mínimo")

| # | Funcionalidad | Nota |
|---|---|---|
| 1 | Enlaces públicos de reunión por usuario (`/u/:slug`) | slug en `User` |
| 2 | Múltiples **tipos de reunión** por usuario | colección `EventType` |
| 3 | Duración configurable | `durationMinutes` |
| 4 | Horarios disponibles + días hábiles | `AvailabilitySchedule` (reglas semanales) |
| 5 | Zona horaria (anfitrión config / invitado visualiza) | IANA tz |
| 6 | Anticipación mínima (`minimumNotice`) | minutos |
| 7 | Ventana máxima para reservar (`dateRange`) | días a futuro |
| 8 | Buffer antes/después | minutos |
| 9 | Límite diario de reuniones | `dailyLimit` |
| 10 | Confirmación automática | MVP siempre auto-confirma |
| 11 | Cancelación y reprogramación | token de gestión |
| 12 | Página pública de reserva | ruta Vue `meta.public` |
| 13 | Confirmación por correo (+ ICS adjunto) | vía SMTP del anfitrión |
| 14 | Integración con el calendario interno (crea `CalendarEvent`) | fuente de verdad única |
| 15 | Evitar dobles reservas + detección de conflictos | **lock Redis + overlap query + índice único** |
| 16 | URL personalizada por usuario | `username` único |
| 17 | Parametrizable por cuenta | todo es config por usuario |
| 18 | Horarios de descanso, vacaciones, festivos | `overrides[]` en el schedule |
| 19 | Color, nombre público, descripción, lugar, link videollamada por tipo | campos en `EventType` |
| 20 | Política de cancelación/reprogramación | texto + anticipación mínima |
| 21 | Admin de empresa: activar/desactivar, defaults, branding, auditoría | `SchedulingSettings` singleton |

### 2.2 Recomendadas (post-MVP, mismo modelo de datos)

- Preguntas personalizadas por tipo de reunión (`customQuestions[]`) — *incluida ya en el modelo, UI en fase posterior*.
- Recordatorios automáticos por correo (T-24h / T-1h) vía job programado.
- Verificación de email del invitado (doble opt-in anti-spam).
- Auto-agregar al invitado como **Contacto** de Bifrost.
- Notificación in-app al anfitrión cuando reservan.
- Límites por plan (admin).

### 2.3 Futuras (requieren rediseño o integración externa)

- Round-robin / colectivos / group events (varios anfitriones o invitados).
- Integración con proveedor de videollamada (generación automática de links).
- SMS, Meeting polls, pagos (Stripe), analítica avanzada, routing forms condicionales.
- Sincronización con calendarios externos (CalDAV bidireccional ya existe parcialmente en `Account.caldav`).

---

## 3. Arquitectura técnica para Bifrost

Se integra **respetando los patrones existentes** (verificados en código):

- **API**: Fastify, rutas con prefix `/api/*`, registradas en `app.ts`. Auth por flag
  `config.requiresAuth` por-ruta (default `true`); los endpoints públicos lo ponen en `false`.
- **Persistencia**: MongoDB/Mongoose (modelos en `packages/api/src/models`), Redis
  (auth tokens + rate-limit; **lo reusamos para el lock de booking**).
- **Aislamiento multi-tenant**: todo lo de gestión va `owner-bound` por `userId`
  (patrón `requireOwnedAccount` / `findOne({_id, userId})` ya usado en `calendar.ts`).
- **Web**: Vue3 SPA, `vue-router` con `meta.public` para páginas sin auth (como `/login`),
  Pinia stores, `api` http lib, FullCalendar para vistas de calendario, i18n (es por defecto),
  branding parametrizable (`VITE_BRAND_*` / `brand.ts`).
- **Correo**: `services/mail-transport.ts` + `services/smtp.ts` (envío con credenciales
  SMTP del `Account` del anfitrión). Reutilizamos para la confirmación.
- **Shared**: DTOs en `packages/shared/src/types.ts`.

### 3.1 Diagrama de flujo (reserva pública)

```
Invitado externo                Bifrost API (público)              Mongo / Redis / SMTP
─────────────                   ─────────────────────              ────────────────────
GET /u/francisco           →    GET /api/schedule/public/francisco
                                 → lista EventTypes activos    →    Mongo
elige tipo + fecha         →    GET .../:eventSlug/slots?tz     →    calcula slots:
                                                                     Availability ∩ overrides
                                                                     − CalendarEvent busy
                                                                     − Bookings confirmadas
                                                                     − buffers/minNotice/limit
completa form + reserva    →    POST .../:eventSlug/book        →    LOCK Redis (userId)
                                                                     ├ re-check overlap
                                                                     ├ insert Booking (+índice único)
                                                                     ├ insert CalendarEvent (busy)
                                                                     └ UNLOCK
                                 ← 201 + managementToken         →    SMTP: confirma a invitado
                                                                          + a anfitrión (+ICS)
```

### 3.2 Decisión crítica de concurrencia (no-doble-booking)

**Problema:** dos invitados reservan el mismo hueco al mismo tiempo. No pueden ganar ambos.

**Restricción del entorno:** el Mongo del all-in-one es presumiblemente **single-node**
(sin replica set ⇒ **sin transacciones multi-documento**). [PROBABLE — a confirmar en deploy;
el diseño no debe *depender* de transacciones.]

**Solución propuesta (defensa en 3 capas):**

1. **Lock distribuido en Redis** por anfitrión: `SET lock:booking:<userId> <rnd> NX PX 5000`
   (patrón ya disponible; Redis es infra existente). Serializa el *check-and-insert* de un
   mismo anfitrión. Liberación segura con script Lua compare-and-del (no borrar lock ajeno).
   Reintento corto con backoff si está tomado; si no se obtiene en ~2s → 409/503.
2. **Re-validación de solapamiento dentro del lock**: query `CalendarEvent` + `Booking`
   confirmadas que solapen `[start−bufferBefore, end+bufferAfter]`. Si hay choque → 409.
3. **Índice único parcial** como backstop: `{ userId, startAt }` único sobre
   `status:'confirmed'`. Aunque fallara el lock (p.ej. Redis caído), dos reservas con el
   mismo `startAt` exacto no pueden coexistir. (No cubre solapamientos de distinta duración —
   eso lo cubre la capa 2; por eso son complementarias.)

> Si en el futuro hay replica set, se puede envolver 2+índice en una transacción y el lock
> pasa a optimización. El diseño queda correcto en ambos escenarios.

---

## 4. Modelo de datos

Cuatro colecciones nuevas + un campo en `User` + un singleton de settings.

### 4.1 `User.username` (campo nuevo)

```
username?: string   // slug público [a-z0-9-], 3..40, único (índice sparse+unique)
```
Migración: backfill opcional desde el prefijo del email (idempotente, sólo si está libre);
si colisiona, queda `null` y el usuario lo define en UI. La página pública sólo existe si
`username` está definido **y** scheduling habilitado.

### 4.2 `AvailabilitySchedule` (horario reutilizable)

```
userId: ObjectId (ref User, index)
name: string                       // "Horario laboral"
timezone: string                   // IANA, p.ej. "America/Santiago"
weeklyRules: [{ weekday: 0..6, intervals: [{ start:"HH:MM", end:"HH:MM" }] }]
overrides:  [{ date:"YYYY-MM-DD", intervals: [{start,end}] }]  // [] = no disponible (vacación/festivo)
isDefault: boolean
timestamps
```
Cubre: horario laboral, días disponibles, horarios de descanso (huecos entre intervalos),
vacaciones y festivos (override con `intervals:[]`).

### 4.3 `EventType` (tipo de reunión)

```
userId: ObjectId (ref User, index)
slug: string                       // único por usuario (índice {userId,slug} unique)
title: string
description?: string
durationMinutes: number            // 5..1440
color?: string
location: { type:'in_person'|'phone'|'video'|'custom', value?: string }  // value = dirección/teléfono/URL
bufferBeforeMin: number  (default 0)
bufferAfterMin:  number  (default 0)
minimumNoticeMin: number (default 0)     // anticipación mínima
dateRangeDays: number    (default 60)    // ventana máxima a futuro
slotIncrementMin?: number                // paso de la grilla (default = durationMinutes)
dailyLimit?: number                      // máx reservas/día (0/ausente = sin límite)
availabilityScheduleId: ObjectId (ref)   // qué horario aplica
autoConfirm: boolean (default true)
cancellationPolicyText?: string
reschedulePolicyText?: string
cancelMinNoticeMin?: number              // anticipación mínima para cancelar/reagendar
customQuestions: [{ id, label, type:'text'|'textarea'|'phone', required:boolean }]
active: boolean (default true)
timestamps
```

### 4.4 `Booking` (reserva)

```
eventTypeId: ObjectId (ref, index)
userId: ObjectId (host, index)
availabilitySnapshot: { timezone, durationMinutes }  // congela params al momento de reservar
startAt: Date (UTC, index)
endAt:   Date (UTC)
invitee: { name, email, timezone, phone? }
answers: [{ questionId, label, answer }]
status: 'confirmed'|'cancelled'|'rescheduled'   (index)
cancelReason?: string
cancelledBy?: 'invitee'|'host'
managementToken: string            // 32 bytes random base64url, único, NO es el _id
icsUid: string                     // UID estable para el ICS (idempotencia de re-envíos)
calendarEventId?: ObjectId (ref CalendarEvent)   // el bloque busy creado
rescheduledFromId?: ObjectId       // cadena de reprogramación
rescheduledToId?: ObjectId
source: 'public'
timestamps
```
Índices: `{ userId, startAt }` **único parcial** sobre `status:'confirmed'` (backstop
anti-doble-booking); `{ managementToken }` único; `{ userId, status, startAt }` (listado host);
`{ eventTypeId, startAt }`.

### 4.5 `SchedulingSettings` (singleton de empresa/deployment)

```
enabled: boolean (default false)          // gate global: la feature arranca apagada
publicLinksEnabled: boolean (default true)
defaults: { timezone, durationMinutes, dateRangeDays }
maxEventTypesPerUser?: number             // límite por plan
auditEnabled: boolean (default true)
timestamps
```
Singleton (un doc por deployment, patrón ya usado por config/branding). Editable por admin.

> **Branding de la página pública (decisión del PM):** la página pública de agenda y los correos de
> confirmación **NO tienen branding propio** — reutilizan el **branding del admin de email ya existente**
> (`SystemConfig key='branding'` vía `services/branding.ts`), servido sin auth por **`GET /api/branding`**
> (`toPublicBranding`: `name`, `accent`/color, `tagline`, `logoDataUrl`). El logo y la marca configurados en
> el admin de email aplican automáticamente a `/u/:slug`, al flujo de reserva y a los emails E1–E3. No se
> añade ningún campo de branding a `SchedulingSettings`.

### 4.6 Relación con `CalendarEvent` (existente)

La reserva confirmada **crea un `CalendarEvent`** (`status:'confirmed'`, `summary` = título +
invitado, `calendarName:'Reuniones'`, `calendarColor` del tipo, `description` con datos del
invitado, `attendees` = invitado). Así:
- aparece en el calendario del anfitrión sin lógica adicional (ya se renderiza);
- la detección de conflictos lee `CalendarEvent` → la agenda manual del anfitrión **también**
  bloquea slots (mejor que Calendly, que sólo mira el calendario sincronizado).

Se añade `CalendarEvent.bookingId?` (ref opcional) + `source?: 'manual'|'booking'` para
trazar y para borrar el bloque al cancelar. **No rompe** los eventos existentes (campos
opcionales, default `manual`).

---

## 5. APIs

### 5.1 Autenticadas (gestión del anfitrión) — prefix `/api/schedule`

```
GET    /event-types                 lista propios
POST   /event-types                 crea
GET    /event-types/:id             detalle (owner-bound)
PATCH  /event-types/:id             edita
DELETE /event-types/:id             elimina (¿qué pasa con bookings futuras? → ver §8)
GET    /availability                lista schedules propios
POST   /availability                crea
PATCH  /availability/:id            edita
DELETE /availability/:id            elimina (bloqueado si es el último/usado)
GET    /profile                     username + estado scheduling
PATCH  /profile                     setea username (valida unicidad + formato)
GET    /bookings?from&to&status     reservas del anfitrión
POST   /bookings/:id/cancel         cancela (como host) → borra CalendarEvent + email
```

### 5.2 Públicas (`config.requiresAuth:false`, rate-limit estricto) — `/api/schedule/public`

```
GET  /:userSlug                              perfil + EventTypes activos (404 genérico si no existe)
GET  /:userSlug/:eventSlug                   detalle del tipo
GET  /:userSlug/:eventSlug/slots?from&to&tz  slots disponibles (ventana acotada, IANA tz validada)
POST /:userSlug/:eventSlug/book              RESERVA (hot path: lock+overlap+CalendarEvent+email)
GET  /booking/:managementToken               detalle para la página de gestión
POST /booking/:managementToken/cancel        cancela (invitado)
POST /booking/:managementToken/reschedule    reagenda (cancela+crea, valida nuevo slot bajo lock)
```

### 5.3 Admin — `/api/admin/scheduling`

```
GET   /scheduling          settings actuales
PATCH /scheduling          activar/desactivar, defaults, límites, branding
GET   /scheduling/audit?from&to   auditoría de reservas (paginado, acotado)
```

### 5.4 Notas de seguridad (para B/D)

- **Rate limit reforzado** en públicas, en especial `book` y `slots` (por IP; configurable).
  El limiter global existe; añadir límite por-ruta más bajo en el hot path.
- **`managementToken`** = `crypto.randomBytes(32)` base64url. Nunca exponer `_id`. Cancelar/
  reagendar requieren el token (capability URL). 404 genérico si no matchea.
- **Anti header/HTML injection** en `invitee.name`/`answers` al construir el email
  (escape HTML; el nombre nunca va en headers crудos del correo).
- **Validación IANA tz** (lista válida) — un tz inválido no debe romper el cálculo de slots.
- **Enumeración**: `/u/:slug` revela existencia por diseño (es público); slug inexistente → 404 genérico.
- **DoS de cómputo de slots**: ventana `from..to` acotada (≤ `dateRangeDays`, máx p.ej. 62 días);
  resultados cacheables corto en Redis (opcional).
- **Gate global**: si `SchedulingSettings.enabled=false` → todas las públicas devuelven 404.

---

## 6. Interfaz de usuario

### 6.1 Host (autenticado)

Nueva vista **"Reuniones"** (o sección en Settings) con 3 pestañas:
1. **Tipos de reunión**: lista de cards (color, título, duración, link copiable), crear/editar
   en modal (mismo patrón que el modal de `CalendarView`), toggle activo.
2. **Disponibilidad**: editor de reglas semanales (intervalos por día) + tz + overrides
   (vacaciones/festivos con date-picker).
3. **Reservas**: tabla de próximas/pasadas, filtro por estado, cancelar.
   También se ven como eventos en el `CalendarView` existente (color "Reuniones").

Profile/username: campo en Settings ("Tu enlace público: mail.dominio.com/u/____").

### 6.2 Pública (sin auth) — rutas Vue `meta.public`

- `/u/:userSlug` → perfil + lista de tipos (branding parametrizable, i18n es/en).
- `/u/:userSlug/:eventSlug` → **flujo de reserva**: (1) calendario mensual marcando días con
  hueco; (2) lista de slots del día en la tz del invitado (selector de tz, autodetectada);
  (3) formulario (nombre, email, preguntas custom); (4) confirmación con resumen + "agregar a
  mi calendario" (descarga ICS) + links de cancelar/reagendar.
- `/meet/:userSlug` → alias de `/u/:userSlug`.
- `/booking/:managementToken` → página de gestión (cancelar / reagendar).

Componentes reutilizados: `AppLayout`/`AppIcon`/`AppLogo`/`brand.ts`/i18n. La página pública
usa un layout liviano propio (sin sidebar de inbox).

---

## 7. Mejoras sobre Calendly aprovechando integración nativa

1. **Cero sincronización**: conflictos contra el calendario real de Bifrost (manual + reservas),
   sin lag ni doble-booking por sync atrasado.
2. **Entregabilidad y branding propios**: el correo de confirmación sale del **dominio del
   propio usuario** (su SMTP) — no de `calendly.com`. Menos spam, más confianza, white-label real.
3. **Invitado → Contacto**: auto-alta en la libreta de contactos de Bifrost (CRM ligero gratis).
4. **Una sola identidad**: el anfitrión ya es usuario de correo; no hay cuenta/SSO aparte.
5. **Privacidad / soberanía de datos**: los datos de reservas viven en la infraestructura del
   cliente (alineado con la misión Bifrost + Ley 21.719). Calendly es un tercero en EE.UU.
6. **Costo**: incluido en el correo casi-gratis; Calendly cobra por usuario/mes.

---

## 8. Riesgos, decisiones de producto y preguntas abiertas

| Tema | Decisión propuesta (A) | Severidad si se equivoca |
|---|---|---|
| Concurrencia doble-booking | Lock Redis + overlap + índice único (§3.2) | **HIGH** — núcleo |
| Mongo sin transacciones | No depender de ellas; lock cubre | HIGH (mitigado) |
| Borrar EventType con bookings futuras | Soft: marcar `active:false`, conservar bookings; bloquear delete duro si hay futuras | MEDIUM |
| Zona horaria / DST | Cálculo de slots con lib tz robusta (evaluar `luxon` vs `Intl`); test exhaustivo de DST | HIGH (correctness) |
| Spam de reservas | Rate-limit + dailyLimit en MVP; verificación email = recomendada (fase post) | MEDIUM |
| Feature arranca apagada | `SchedulingSettings.enabled=false` por defecto | LOW |
| URL scheme | `/u/:userSlug` (perfil) + `/u/:userSlug/:eventSlug` + alias `/meet/:userSlug` | LOW |
| Reagendar = cancela+crea atómico | Bajo el mismo lock; cadena `rescheduledFrom/To` | MEDIUM |

**Dependencia nueva a evaluar:** una librería de fechas/tz para DST correcto. Candidatos:
`luxon` (robusto, ~70KB) o `Intl.DateTimeFormat` + helpers propios (cero deps, más código).
→ A propone evaluar en Fase 3.F2 y que B decida; preferencia inicial: **Intl + helpers
propios y testeados** para no sumar dependencia, salvo que B considere el riesgo DST demasiado
alto sin librería.

---

## 9. Plan de implementación por fases (Fase 3)

Cada fase: implementación pequeña → review B/C/D → score ≥9 y 0 HIGH → siguiente.

| Fase | Objetivo | Archivos (aprox.) | Riesgo | Validación |
|---|---|---|---|---|
| **3.1 Modelo de datos** | Schemas (`EventType`, `AvailabilitySchedule`, `Booking`, `SchedulingSettings`), `User.username`, `CalendarEvent.bookingId/source`, DTOs shared, índices | models/*, shared/types.ts | MED (migración username) | unit de modelos + índices; typecheck |
| **3.2 Motor de slots (puro)** | Funciones puras: resolución de disponibilidad, generación de slots, detección de conflictos, tz/DST. **Sin red, sin DB.** | services/scheduling/*.ts | **HIGH** (correctness DST) | unit exhaustivo (DST, buffers, overrides, minNotice, límites, tz) |
| **3.3 APIs host** | CRUD event-types/availability/profile + bookings list/cancel, authz owner-bound | routes/schedule.ts | MED | tests de ruta + authz/IDOR |
| **3.4 Booking público + concurrencia + email** | Endpoints públicos, lock Redis, overlap guard, crea `CalendarEvent`, email confirmación + ICS, cancel/reschedule | routes/schedule-public.ts, services | **HIGH** (concurrencia, email injection) | tests concurrentes (N reservas mismo slot → 1 gana), email mock |
| **3.5 UI host** | Vista Reuniones (tipos/disponibilidad/reservas) | web/views, stores, i18n | MED | e2e Playwright |
| **3.6 UI pública** | Rutas `meta.public`, picker de slots, form, confirmación, gestión | web/views/public/*, router | MED | e2e Playwright (reserva end-to-end) |
| **3.7 Admin/empresa** | enable/disable, defaults, límites, branding, auditoría | routes/admin.ts, AdminView | LOW | tests + e2e |

---

## 10. Regression Map (a validar por B antes de Fase 3.1)

| Componente | Dependencia | Riesgo | Cómo validar |
|---|---|---|---|
| `CalendarEvent` model/routes | se le añaden campos opcionales (`bookingId`,`source`) + lo crean bookings | MED | suite calendar.test.ts verde; GET /calendar sigue devolviendo eventos; nuevos campos default no rompen serialización |
| `User` model | nuevo `username` (sparse unique) + posible backfill | MED | unit; backfill idempotente; login/setup intactos |
| `app.ts` registro de rutas | nuevo grupo `/api/schedule` + públicas | LOW | health/rutas existentes intactas; 404 handler |
| Rate-limit global | públicas comparten limiter + límite por-ruta extra | MED | E2E no se estrangula; booking spam se frena |
| `mail-transport`/`smtp` | reuso para confirmación | MED | mock SMTP en test; no romper envío normal |
| `vue-router` | nuevas rutas `meta.public` + gate `beforeEach` | LOW | login redirect intacto; públicas no exigen auth |
| i18n / brand | nuevas claves + página pública branded | LOW | build; es por defecto |

---

## 11. Plan de rollback

- **Backward compatible**: todo es aditivo. Campos nuevos opcionales con default.
- Gate `SchedulingSettings.enabled=false` por defecto → la feature no se expone hasta activarla.
- Rollback = revert de los commits + (si se desea) drop de las 4 colecciones nuevas + unset de
  `User.username`/`CalendarEvent.bookingId`. Ningún dato existente se modifica destructivamente.
- Señal de falla temprana: errores 5xx en `/api/schedule/public/*`, lock contention alto,
  bookings con `calendarEventId` nulo (booking creada pero CalendarEvent falló).

## 12. Plan de observabilidad

- Métricas (`lib/metrics.ts`): `bookings_created`, `bookings_cancelled`, `bookings_rescheduled`,
  `booking_conflicts_rejected`, `booking_lock_timeouts`, `slot_compute_ms` (histograma).
- Logs estructurados en create/cancel/reschedule (sin PII sensible más allá de lo necesario).
- Alerta: ratio de `conflicts_rejected`/`created` alto = problema de UX o de cálculo de slots;
  `lock_timeouts` alto = contención o Redis degradado.

---

## 13. Definición de listo de la PROPUESTA (gate de Fase 2)

- [ ] B aprueba arquitectura + concurrencia + Regression Map (score ≥9, 0 HIGH) — **autoridad primaria**
- [ ] C aprueba lógica/integridad/datos (slots, idempotencia, tz, estados) (≥9, 0 HIGH)
- [ ] D aprueba auditoría independiente (correctness, edge cases, superficie de ataque) (≥9, 0 HIGH)
- [ ] PM aprueba la propuesta (requisito explícito del enunciado: "una vez aprobada la propuesta, comienza el desarrollo")

Sólo entonces se inicia Fase 3.1.

---

## Apéndice A — Hechos del entorno (CONFIRMADO en código)

Verificado directamente en el repo (no supuesto):

- **Mongo single-node** (`mongo:7` sin `--replSet` en `docker-compose.yml` y `docker-compose.prod.yml`)
  ⇒ **no hay transacciones multi-documento**. El diseño de concurrencia (§3.2) NO depende de
  ellas: lock Redis + overlap + índice único. [CONFIRMADO]
- **Redis disponible** (`redis:7-alpine`) con cliente exportado en `packages/api/src/config/redis.ts`
  (`ioredis`, con `ioredis-mock` para tests vía `REDIS_URL=mock`). El lock usa `SET key val PX 5000 NX`
  + Lua compare-and-del para liberar sólo el propio lock. [CONFIRMADO]
- **`Contact.source`** ya incluye el valor `'auto'` en el enum ⇒ el alta automática del invitado
  como contacto NO requiere migrar el modelo. [CONFIRMADO]
- **`nodemailer` ^9** presente; `mail-transport.ts` expone `createSmtpTransport(options)` y
  `smtp.ts` expone `sendDraft(...)`. La confirmación reutiliza el transporte SMTP del `Account`
  del anfitrión. [CONFIRMADO]
- **No hay librería de fechas/tz/ICS** (`luxon`/`date-fns`/`dayjs`/`rrule`/`ics` ausentes en los
  `package.json`) ⇒ cálculo de slots con `Intl.DateTimeFormat`/`Intl` + helpers propios testeados,
  e ICS generado a mano (formato simple VEVENT). Evita sumar dependencia salvo que B lo exija por
  riesgo DST. [CONFIRMADO]
- **Auth por flag** `config.requiresAuth` por-ruta (default true) en `plugins/auth.ts` ⇒ las rutas
  públicas se marcan `config:{requiresAuth:false}`. [CONFIRMADO]
- **Patrones reutilizables YA en el codebase** (verificado): lock distribuido `withAccountLock`
  (`services/account-sync.ts`: `SET NX EX` TTL 120s + heartbeat Lua `EXTEND`/`RELEASE` por token);
  idempotencia de envío (`routes/drafts.ts`: claim atómico `findOneAndUpdate` de transición de estado +
  short-circuit `alreadySent`); singleton de config `SystemConfig{key,value}`; `hashToken`/`randomToken`
  en `config/crypto.ts`; **BullMQ `^5.34.10` instalado y SIN usar** (cola lista para reconciler/email/
  recordatorios). [CONFIRMADO]
- **No existe sync CalDAV** que escriba `CalendarEvent` (sólo la ruta manual `POST /api/calendar` lo
  crea). El calendario interno cubre eventos manuales + (futuro) reservas. Importar calendarios CalDAV
  externos como "ocupado" NO está implementado hoy en el producto → limitación **preexistente**, no
  introducida por esta feature (queda en §2.3 Futuras). [CONFIRMADO]

---

# v2 — Resolución de hallazgos B/C/D (Fase 2, iteración v1→v2)

> Estado tras review: B 7/10 NOT APPROVE · C 7/10 NOT APPROVE · D 5/10 NOT APPROVE.
> Esta sección **supersede** las partes correspondientes de v1. Cada cambio cita el finding y, cuando
> aplica, el **patrón existente reutilizado** (REGLA: no reinventar — C señaló que el codebase ya los tiene).

## v2.1 — Concurrencia y lock (resuelve B-HIGH lock/concurrencia, C-H1/M4, D-001/002/021/023/026)

**Se descarta** el lock `PX 5000` ad-hoc. Se **reutiliza/generaliza `withAccountLock`** a un
`withLock(key, fn)` idéntico (TTL 120s + heartbeat que renueva mientras corre + release atómico Lua por
token). Clave del booking: `lock:booking:host:<userId>`.

- **Fail-closed estricto**: si `SET NX` no adquiere (otro en curso) → `409` con `Retry-After`. Si Redis
  está caído → el `SET` lanza/timeoutea → `503`. **Nunca** se degrada a "overlap+índice". El índice único
  parcial pasa a ser **defensa en profundidad** (cubre sólo `startAt` exacto), no garantía primaria.
- **Sección crítica MÍNIMA y acotada** (sólo DB, sin red lenta): (1) idempotencia (v2.3); (2) **re-validar
  el predicado COMPLETO** (v2.2); (3) insert `Booking(confirmed)`; (4) insert `CalendarEvent`; (5) set
  `Booking.calendarEventId`; con compensación (v2.4). **El email + ICS salen FUERA del lock**, encolados
  en **BullMQ** tras el commit (resuelve C-M3, D-021: SMTP síncrono en el hot path). El TTL de 120s con
  heartbeat hace irrelevante el riesgo de expiración a mitad de trabajo (C-M4, D-001).

## v2.2 — Re-validación del predicado completo bajo lock (resuelve C-H1 — el catch más afilado)

La sección crítica re-evalúa, contra el `start` solicitado, la **misma función pura de validez** que
genera los slots — no sólo overlap:
`isSlotBookable(start, eventTypeSnapshot, schedule, busyEvents, todaysConfirmedBookings, now)` que verifica:
**(a)** dentro de un intervalo de disponibilidad (un slot cabe ENTERO en un solo intervalo, no cruza
descansos — C-M6, D-005); **(b)** no solapa `CalendarEvent` ni `Booking` confirmadas expandidas por
buffers; **(c)** `minimumNotice` contra `now` en UTC; **(d)** dentro de `dateRange`; **(e)** `dailyLimit`
contado por **día-del-anfitrión** (tz host), sólo `confirmed` (C-M2, D-006). Así el escenario de C-H1
(la 6ª reserva que evade `dailyLimit` desde una página cacheada) se rechaza con `409`.

## v2.3 — Idempotencia de `POST /book` (resuelve C-H4, D-020/024)

Header `Idempotency-Key` (UUID del cliente). Dentro del lock: `GET idem:book:<key>` en Redis → si existe,
**replay** del `201` original (devuelve el `bookingId`/token guardados, no `409`). Si no, se procede y al
final se guarda `key→bookingId` (TTL 24h). Espeja el espíritu del claim atómico de `drafts.ts`. Cierra el
doble-click y el retry tras fallo de email (que ahora es async, v2.1).

## v2.4 — Atomicidad sin transacciones: compensación + reconciler (resuelve B-HIGH atomicidad, C-H2, D-003)

- **Fuente de verdad = `Booking` confirmada**. `CalendarEvent` = **proyección reparable** (bloque busy).
- Escritura ordenada en el lock: insert `Booking` → insert `CalendarEvent` → set `calendarEventId`. Si
  falla el `CalendarEvent` → **delete compensatorio** del `Booking` (o `status:'failed'`) → `503`. Si la
  instancia muere entre medio (lock expira) → lo repara el reconciler.
- **Reconciler** (job repetible BullMQ, idempotente): (i) `Booking confirmed` con `calendarEventId` faltante
  → recrea el `CalendarEvent`; (ii) `CalendarEvent` de booking cuya `Booking` está `cancelled/rescheduled`
  → lo marca `cancelled`. Reusa `withLock` del host para no pisar reservas en vuelo.
- **Cancelación NO destructiva** (resuelve D-003 + la inconsistencia §4.6/§5.1): cancelar setea
  `Booking.status='cancelled'` **y** `CalendarEvent.status='cancelled'` (el modelo ya soporta `cancelled`).
  El slot se libera porque el overlap-query sólo cuenta `confirmed`. Se conserva trazabilidad/auditoría.

## v2.5 — Reagendar sin pérdida de datos (resuelve C-H3, D-009)

Bajo el lock, **orden invertido**: validar+crear la **nueva** `Booking(confirmed)` con **nuevo**
`managementToken` PRIMERO; sólo si tiene éxito, marcar la **vieja** `rescheduled` (link `rescheduledToId`)
y `cancelled` su `CalendarEvent`. El overlap-check de la nueva **excluye la booking que se reagenda por
`_id`** (si no, su propio slot viejo la bloquearía). Si la nueva falla → la vieja queda intacta (`confirmed`).
El token viejo se invalida (la página de gestión redirige a la nueva).

## v2.6 — DST: se compromete `luxon` (resuelve B-HIGH DST, C-H5/M12, D-004)

Se **agrega `luxon`** como dependencia (el backend no tiene lib de fechas; B rechazó explícitamente
"Intl+helpers"; el off-by-one-hour es el bug nº1 de scheduling). Algoritmo cerrado:
- Wall-time de la regla semanal → UTC **calculado por fecha** en la tz del host
  (`DateTime.fromObject({year,month,day,hour,minute},{zone:hostTz})`), porque el offset cambia el día de
  transición DST.
- **Spring-forward** (hora local inexistente, p.ej. `02:30`): el slot **se omite** (luxon lo marca inválido).
- **Fall-back** (hora ambigua, ocurre dos veces): se toma la **primera** ocurrencia (offset previo), documentado.
- `minimumNotice` se compara en **instantes UTC**; `dailyLimit` agrupa por **día-calendario en tz host**.
- **ICS**: `DTSTART`/`DTEND` en **UTC (`Z`)** → se evita construir `VTIMEZONE` a mano (C-M12); `METHOD:REQUEST`
  al confirmar, `CANCEL` al cancelar; `UID` = `Booking.icsUid` estable; escape de `SUMMARY/DESCRIPTION/
  LOCATION` (`\` `,` `;` `\n` → escapados) + folding de líneas a 75 octetos.
- Tests obligatorios: `America/Santiago`, `America/New_York`, `Europe/Berlin` en días de transición.

## v2.7 — Seguridad de endpoints públicos (resuelve B-MED seguridad, C, D-005/013/016/017)

- **Rate-limit por-ruta reforzado** en `slots` y `book`: por **IP + slug + email del invitado** (no sólo IP).
  Declarado **single-instance** (el limiter actual es in-proceso; multi-instancia = §2.3 futura). Por-email
  frena abuso del SMTP del host.
- **`managementToken` hasheado** (resuelve B-MED, D-014): se guarda `hashToken(raw)` (patrón refresh token,
  `config/crypto.ts`); el `raw` sólo viaja en el link del email; lookup por hash; `404` genérico. Caducidad
  = fin del evento + gracia.
- **Anti-injection de correo**: `invitee.email` validado estricto (sin CRLF) e inyectado vía campos
  estructurados de nodemailer (no headers crudos) → header-injection inocua (resuelve D-016). Body HTML:
  escape de `name/answers/location`. ICS: escape propio (v2.6). `location.value` se renderiza escapado y,
  si es URL, sólo `https?:` (no `javascript:`) (D-017).
- **`slots`**: ventana dura `from<=to`, `≤ dateRangeDays` y `≤ 62 días` absolutos; `tz` validada IANA
  (`IANAZone.isValidZone` de luxon); cap de slots devueltos; **cache corto en Redis** (no opcional, anti-abuse).
- **Anti-spam MVP**: rate-limit + `dailyLimit` + por-email. Verificación de email del invitado (doble opt-in)
  y/o captcha = **Recomendada** (§2.2), con riesgo residual documentado. Se añade índice `{userId,endAt}`
  en `Booking` (análogo a `CalendarEvent`) para el overlap eficiente (B, C-L1).

## v2.8 — Correcciones de modelo (resuelve C-M1/M5/M7/M8/M9/M10, B-MED/LOW, D-007/008/010/012/022/023/025, L1/L3)

- **`snapshot` ampliado** (antes `availabilitySnapshot`): congela `timezone, durationMinutes, bufferBeforeMin,
  bufferAfterMin, minimumNoticeMin, title, location`. Así overlap-con-buffer y la página de gestión del
  invitado no dependen de un `EventType` que pudo editarse/borrarse (C-M1, D-022).
- **`User.username`**: índice `unique` **parcial** `partialFilterExpression:{username:{$type:'string'}}`
  (no `sparse+null`, B-MED). **NO** hay backfill desde email (evita slugs predecibles/enumeración, D-023);
  el usuario lo define en UI. Validación `[a-z0-9-]{3,40}` + **palabras reservadas** (`admin,api,booking,
  login,public,meet,u,assets,...`) + normalización (C-L3).
- **`SchedulingSettings` → `SystemConfig` key=`scheduling`** (B-LOW, D-020): `getSchedulingConfig()` devuelve
  **defaults** si el doc no existe (sin race en first-read); `upsert` al escribir. Gate `enabled=false` gatea
  **descubrimiento + nueva reserva** SOLAMENTE; **la gestión de reservas existentes** (cancel/reschedule por
  token) sigue operativa (C-M9).
- **Crear `CalendarEvent`** (C-M5): `accountId` = cuenta **primaria** del host (`isPrimary`);
  `calendarId='bifrost-scheduling'` constante, `calendarName='Reuniones'`; `uid=Booking.icsUid`. Satisface el
  índice unique `{accountId,calendarId,uid}`. Reagendar usa **nuevo `icsUid`** (evita colisión con el viejo
  aún no borrado). Nombres: `Booking.startAt/endAt` (UTC) → se mapean a `CalendarEvent.startDate/endDate` (L1).
- **`autoConfirm` se ELIMINA del MVP** (C-M8): siempre auto-confirma; estados `confirmed|cancelled|rescheduled`.
  Aprobación manual (estado `pending`) = §2.3 Futura.
- **`DELETE /event-types/:id` = soft** (desactivar `active:false`), **nunca** hard-delete (C-M7, D-010); las
  bookings conservan su `snapshot`. Toma el lock del host para no corromper una reserva concurrente.
- **`overrides` = REEMPLAZAN** las reglas semanales de esa fecha (resuelve C-M10, D-008): `intervals:[]` →
  no disponible (vacación/festivo); `intervals` no-vacíos → ESA es la disponibilidad del día (permite
  "trabajo este sábado"). Eventos `allDay` del host (OOO) bloquean (overlap los incluye).
- **`weeklyRules.intervals`**: `"HH:MM"` mismo día, `end>start`, rango `00:00–24:00`; cruces de medianoche
  **no soportados en MVP** (documentado, C-M6/D-005). Un slot debe caber entero en un intervalo.
- **Retención de `cancelled`**: política de purga/archivado = **Recomendada** (no MVP); el reconciler puede
  archivar (D-025). `source:'public'` se deja como enum extensible (futuro: `'host'`, `'api'`) (D-012).

## v2.9 — Regression Map ampliado (resuelve B-MED, completa §10)

Se añaden a §10: **`Account`** (qué cuenta primaria firma/crea el evento; SMTP disabled/error → la reserva
NO falla, el email se reintenta vía cola), **`SystemConfig`** (key scheduling), **reconciliación de
índices/migración** (`username` parcial, índices `Booking`), **Redis/readiness** (booking fail-closed si
Redis down), **router público** (`guestOnly` vs `public` — un usuario logueado debe poder previsualizar
`/u/:slug`, B-MED §6.2), **outbox/reconciler BullMQ**, **pruebas multiproceso/concurrencia** (N reservas
mismo slot → 1 gana), **all-day/OOO** del host en overlap.

## v2.10 — Trazabilidad de findings → resolución

| Finding (equipo) | Sev | Resolución v2 |
|---|---|---|
| Concurrencia/lock insuficiente (B, C-M4, D-001/002) | HIGH | v2.1 `withLock` reutilizado, fail-closed, email fuera del lock |
| Re-validar sólo overlap (C-H1) | HIGH | v2.2 predicado completo bajo lock |
| Atomicidad Booking↔CalendarEvent (B, C-H2, D-003) | HIGH | v2.4 compensación + reconciler + cancel no destructivo |
| Reagendar pierde datos (C-H3, D-009) | HIGH | v2.5 crear-nueva→retirar-vieja + self-exclusión |
| Idempotencia book (C-H4, D-020) | HIGH | v2.3 Idempotency-Key (patrón drafts) |
| DST sin definir (B, C-H5, D-004) | HIGH | v2.6 luxon + gap/overlap + ICS UTC |
| Spam/abuso SMTP público (D-005/013) | HIGH/MED | v2.7 rate-limit IP+slug+email, token hash, anti-injection |
| snapshot delgado (C-M1, D-022) | MED | v2.8 congela buffers/minNotice/title/location |
| CalendarEvent campos req. (C-M5) | MED | v2.8 primary account, calendarId fijo, uid=icsUid |
| dailyLimit tz/estado (C-M2, D-006) | MED | v2.2 día-host, sólo confirmed |
| DELETE EventType ambiguo (C-M7, D-010) | MED | v2.8 soft-only |
| autoConfirm sin estado (C-M8) | MED | v2.8 eliminado del MVP |
| gate apaga gestión (C-M9) | MED | v2.8 gate sólo discovery+nueva |
| overrides merge/replace (C-M10, D-008) | MED | v2.8 replace |
| managementToken en claro (B, D-014) | MED | v2.7 hashToken |
| email injection (D-016) | MED | v2.7 campos estructurados + validación |
| índices CalendarEvent/Booking (D-018) | MED | v2.7/v2.9 índice {userId,endAt} en Booking |
| CalDAV no incluido (D-019/027) | MED | Limitación preexistente documentada (no hay sync CalDAV hoy) |
| username sparse+null (B, D-023) | MED | v2.8 índice parcial $type:string, sin backfill |
| Regression Map incompleto (B) | MED | v2.9 ampliado |
| router public vs guestOnly (B-§6.2) | MED | v2.9 separar guestOnly |
| slots cap/validación (D-015/016) | MED/LOW | v2.7 ventana dura, tz IANA, cache |
| naming startAt/startDate (C-L1) | LOW | v2.8 mapeo documentado |
| slugs reservados (C-L3) | LOW | v2.8 lista reservada |
| location XSS (D-017/025) | LOW | v2.7 escape + sólo https |
| retención cancelled (D-025) | LOW | v2.8 Recomendada |

## v2.11 — Plan de fases actualizado (cambios sobre §9)

- **3.0 (nueva)** — Infra base reutilizable: generalizar `withLock`, primer **Worker/Queue BullMQ**
  (conexión propia `maxRetriesPerRequest:null`), helpers tz luxon. Tests de lock (contención/expiración).
- **3.2** ahora explícita: función pura `isSlotBookable` + generación de slots con luxon; el MISMO
  predicado se usa en display y en el re-check bajo lock.
- **3.4** ahora: público + `withLock` + idempotencia + compensación + **encolar** email/ICS (no síncrono)
  + reconciler. Tests de concurrencia (N→1), idempotencia (replay), compensación (fallo del 2º write).
- Resto de fases igual.

> Con v2, los 5 HIGH de C, los HIGH de B y los 6 HIGH de D tienen resolución concreta anclada en patrones
> existentes. Se reenvía a B/C/D para validar el gate (≥9, 0 HIGH) antes de pedir aprobación del PM.

---

# v3 — Resolución ronda 2 (cierre de los 3 HIGH residuales de B + MEDIUMs de B/D)

> Ronda 2: **B 8/10 NOT APPROVE** (3 HIGH de durabilidad/crash-safety) · **D 0 HIGH, 7/10** (3 MEDIUM) ·
> **C `TEAM_UNAVAILABLE`** (z.ai 529 sostenido — sus 5 HIGH de v1 quedaron resueltos en v2; valida al retomar).
> B condicionó: *"resolver DST explícito + idempotencia durable y scopeada + reschedule crash-safe/reconciliable
> → APPROVE 9/10"*. v3 cierra exactamente esos tres + los MEDIUM/LOW.

## v3.1 — DST: resolver explícito de wall-time (cierra B-HIGH#1)

Función `resolveWallTime(dateISO, "HH:MM", hostTz) → { utc: Date } | { skip: 'nonexistent' }`:
1. `dt = DateTime.fromObject({year,month,day,hour,minute}, { zone: hostTz })`.
2. **Gap (spring-forward, hora inexistente)**: round-trip de componentes —
   `if (!dt.isValid || dt.hour !== hour || dt.minute !== minute) → { skip:'nonexistent' }` (luxon "rebota" la
   hora inexistente a otra; el mismatch lo detecta). El candidato se **omite**.
3. **Ambigüedad (fall-back, hora doble)**: se computan las dos interpretaciones —
   `a = dt` (offset previo) y `b = dt.plus({hours:1})` re-anclado; se elige la de **menor instante UTC**
   (primera ocurrencia), documentado y determinista.
4. `minimumNotice`, overlap y `dailyLimit` operan siempre sobre el **instante UTC** resultante; `dailyLimit`
   agrupa por día-calendario `DateTime.fromObject(...,{zone:hostTz}).startOf('day')`.
5. **Tests obligatorios (gate de Fase 3.2)**: `America/Santiago` (DST sur, transición ~sep/abr),
   `America/New_York` (mar/nov), `Europe/Berlin` (mar/oct) — un slot en la hora del gap (omitido) y uno en la
   hora ambigua (primera ocurrencia), en ambas direcciones.

## v3.2 — Idempotencia DURABLE y scopeada (cierra B-HIGH#2)

Redis deja de ser fuente primaria de idempotencia (ventana de crash: Booking creada, respuesta no guardada,
retry → 409). Se hace **durable en Mongo**:
- `Booking` gana `idempotencyKeyHash?: string` (= `hashToken(Idempotency-Key)`) + **índice único parcial**
  `{ userId, eventTypeId, idempotencyKeyHash }` sobre `{ idempotencyKeyHash: { $type:'string' } }`.
- Flujo en la sección crítica: **lookup por keyHash ANTES del overlap-check** → si existe, replay del `201`
  original. Si no, se inserta la `Booking` con el `idempotencyKeyHash`; si el insert choca con el índice único
  (retry concurrente que ganó la carrera) → se relee y se hace replay. Redis (`idem:book:*`) queda como
  **cache opcional** de fast-path, no como garantía.
- Scope: la key se interpreta **por host+eventType** (un mismo invitado reservando dos tipos distintos con la
  misma key del cliente no colisiona indebidamente).

## v3.3 — Reagendar CRASH-SAFE + reconciler (cierra B-HIGH#3 y D-030)

El lock no cubre caída de proceso entre "crear nueva" y "retirar vieja". Se hace **durable + reconciliable**:
- La nueva `Booking` se crea con `rescheduledFromId = old._id` y `status:'confirmed'` PERO con
  `pendingReschedule:true`; en la misma sección crítica se marca la vieja `rescheduled` + se cancela su
  `CalendarEvent` + se invalida su token; al terminar se limpia `pendingReschedule`. El **email de
  reprogramación al invitado NO se encola hasta el estado terminal** (vieja `rescheduled`).
- **Regla de reconciler** (job BullMQ idempotente): "existe `B_new.confirmed` con `rescheduledFromId=X` y
  `X` aún `confirmed` ⇒ **completar**: `X.status='rescheduled'`, cancelar `CE` de X, invalidar token de X,
  limpiar `pendingReschedule`, y recién entonces encolar el email". Así una caída entre pasos converge a
  estado consistente y **nunca** quedan dos `confirmed` solapadas de forma estable.
- Self-exclusión: el overlap-check de la nueva excluye `X._id` (ya en v2.5).
- **Estado `pendingReschedule`**: la `Booking` con `pendingReschedule:true` se trata como **NO confirmada**
  a efectos de overlap/dailyLimit/listados (no bloquea slots ni cuenta) hasta que el flujo la confirma. En el
  camino normal todo ocurre dentro del lock (validar→crear B_new→retirar X→limpiar flag), así que la ventana es
  efímera. **Si el reconciler encuentra una `B_new` con `pendingReschedule` cuyo nuevo slot YA NO es válido**
  (la disponibilidad/overlap cambió en la ventana de crash) → **cancela `B_new`** (la elimina) y **deja `X`
  intacta en `confirmed`** (el invitado conserva su reunión original; no hay pérdida). Si el slot sigue válido
  → completa la confirmación y retira `X`.

## v3.4 — MEDIUMs de B

- **Mutaciones del host que afectan bookability** (`PATCH /event-types/:id`, `PATCH /availability/:id`,
  toggle `active`, `DELETE` soft) **toman el lock del host** (`lock:booking:host:<userId>`) — no sólo el
  delete (v2). Como las `Booking` ya congelan su `snapshot`, una reserva existente nunca se corrompe; el lock
  evita además el race lectura-vs-edición durante la validación de una reserva en vuelo. (B-MED #1)
- **Reconciler de `CalendarEvent` = upsert/dedupe por `uid`/`bookingId`**: si el `CE` ya existe pero
  `Booking.calendarEventId` falta → **linkea** (set del id), NO recrea (evita duplicar y respeta el índice
  unique `{accountId,calendarId,uid}`). (B-MED #2)
- **Cap global anti-abuso por host/ventana** independiente de `dailyLimit`: contador en Redis
  `book:cap:<userId>:<ventana>` con tope duro (p.ej. 60/host/hora) además del `dailyLimit` opcional del
  EventType. Frena el abuso aunque el tipo no defina `dailyLimit`. (B-MED #3, refuerza D-029)

## v3.5 — MEDIUMs/LOW de D + LOW de B

- **D-028 Operativa BullMQ**: en el all-in-one (single-container, single-instance), el **Worker corre
  in-proceso** en el boot de la API con **conexión Redis propia** (`maxRetriesPerRequest:null`, como ya
  anota `config/redis.ts`). Política: `attempts:5` + backoff exponencial; jobs `failed` se **retienen**
  (DLQ = el set `failed` de BullMQ) + métrica `scheduling_jobs_failed` para alerta; reconciler = **job
  repetible** cada 2 min. Documentado como requisito de Fase 3.0.
- **D-029 rate-limit single-instance** → **PRODUCT DECISION** (ver §v3.6): Bifrost all-in-one es
  **single-instance por diseño de la misión** (1 EC2 modesto por PYME) → el limiter in-proceso + el cap Redis
  (v3.4) son correctos. Multi-instancia (escala horizontal) = §2.3 Futuras, y entonces el limiter pasa a Redis.
- **D-033 host sin SMTP**: la página pública de un host **sólo se habilita si su cuenta primaria tiene SMTP
  utilizable** (sin medio de confirmar → no se permite agendar). Si el SMTP falla *después* (transitorio), la
  reserva NO se revierte y el email se reintenta por la cola (v3.5). (decisión de producto)
- **D-034 cache de slots**: `slots` es **read-only y fail-OPEN** — si Redis-cache no está, **recalcula** sin
  cache (no es ruta de seguridad). Sólo la **escritura** de booking es fail-CLOSED ante Redis caído (v2.1).
- **D-031 lock por host serializa**: aceptado para MVP (un host raramente tiene booking concurrency alto);
  granularidad por-slot = optimización futura documentada.
- **B-LOW managementToken**: TTL/gracia = **fin del evento + 7 días**; en reschedule el token viejo se
  **invalida** (lookup falla → 410 Gone con link a la nueva reserva).
- **B-LOW / C-M12 ICS**: requisito explícito **CRLF** (`\r\n`), folding por **75 octetos** (no caracteres),
  escape `\,;\n`, y **tests con caracteres multibyte** (acentos/emoji en nombre/notas).

## v3.6 — PRODUCT DECISIONS documentadas

```
PRODUCT DECISION: Despliegue single-instance (rate-limit in-proceso)
Razón: Bifrost all-in-one corre en 1 EC2 modesto por PYME (misión). No hay multi-instancia en v1.
Trade-off aceptado: el limiter por-IP/slug/email es in-proceso; en multi-instancia se evadiría.
                    Mitigado por el cap global en Redis (v3.4), que SÍ es distribuido.
Plan: multi-instancia → limiter Redis (§2.3 Futuras).
Aprobado por: Equipo A (alineado con [[bifrost-mision]]).

PRODUCT DECISION: Agendar requiere SMTP del host configurado
Razón: sin medio de confirmar, la reserva no tiene valor (el invitado no recibe nada).
Trade-off aceptado: un host sin SMTP no puede publicar página pública hasta configurarlo.
Aprobado por: Equipo A.

PRODUCT DECISION: MVP sin verificación de email del invitado / captcha
Razón: fricción vs. velocidad de MVP; mitigado por rate-limit + dailyLimit + cap global + SMTP propio.
Trade-off aceptado: riesgo residual de reservas spam; verificación doble opt-in = Recomendada (§2.2).
Aprobado por: Equipo A.
```

## v3.7 — Trazabilidad ronda 2

| Finding (equipo) | Sev | Resolución v3 |
|---|---|---|
| DST sin resolver explícito (B-HIGH#1) | HIGH | v3.1 resolver wall-time (gap/ambigüedad) + tests por zona |
| Idempotencia no durable (B-HIGH#2) | HIGH | v3.2 keyHash en Booking + índice único, Redis=cache |
| Reagendar no crash-safe (B-HIGH#3, D-030) | HIGH | v3.3 pendingReschedule + regla de reconciler |
| Host mutations sin lock (B-MED#1) | MED | v3.4 toman lock del host |
| Reconciler CE recrea vs linkea (B-MED#2) | MED | v3.4 upsert/dedupe por uid, linkea |
| Anti-abuso depende de dailyLimit (B-MED#3, D-029) | MED | v3.4 cap global Redis por host/ventana |
| Operativa BullMQ (D-028) | MED | v3.5 worker in-proceso, attempts/backoff/DLQ/métrica |
| Host sin SMTP (D-033) | LOW | v3.5 gate: requiere SMTP |
| slots cache fall (D-034) | LOW | v3.5 slots fail-open (recalcula) |
| lock por host (D-031) | LOW | v3.5 aceptado MVP |
| token TTL/old-token (B-LOW) | LOW | v3.5 fin+7d, viejo→410 |
| ICS CRLF/folding/multibyte (B-LOW) | LOW | v3.5 requisito + tests |

## v3.8 — Modelo: deltas de v3

- `Booking`: `+ idempotencyKeyHash?` (índice único parcial `{userId,eventTypeId,idempotencyKeyHash}`),
  `+ pendingReschedule?: boolean`.
- Fase **3.0** suma: worker BullMQ in-proceso + cola `scheduling` + reconciler repetible + cap global Redis +
  el resolver DST (`resolveWallTime`) con su suite de tests por zona.

> v3 cierra los 3 HIGH que B condicionó para APPROVE 9/10 y los 3 MEDIUM de D. Se reenvía a B y D para validar;
> C se revalida cuando z.ai recupere (sus HIGH de v1 ya resueltos en v2, sin findings nuevos pendientes).
```
