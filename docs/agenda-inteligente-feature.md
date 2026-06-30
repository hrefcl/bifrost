# Agenda Inteligente — Sistema de agendamiento nativo (tipo Calendly)

> Feature completa de **reuniones agendables** para Bifrost Mail. El anfitrión publica un enlace
> público (`/u/su-usuario`); clientes externos eligen un hueco según la disponibilidad real del
> anfitrión y reservan **sin cuenta**. Todo es nativo: **no depende de Google/Microsoft**, el
> "calendario" es el propio `CalendarEvent` interno de Bifrost, y el correo de confirmación sale por
> el **SMTP del anfitrión**. La página pública y los correos usan la **marca configurada en el admin
> de email** (`/api/branding`), sin branding separado.

Documentos relacionados: [`agenda-inteligente-propuesta.md`](./agenda-inteligente-propuesta.md) (diseño
y decisiones de concurrencia), [`agenda-ui-funcional.md`](./agenda-ui-funcional.md) (mockups por
pantalla), [`deuda-tecnica.md`](./deuda-tecnica.md) (deuda LOW aceptada).

---

## 1. Qué resuelve y por qué es distinto a Calendly

| | Calendly | Agenda Bifrost |
|---|---|---|
| Fuente de disponibilidad | sincroniza con Google/MS (OAuth, cuotas, terceros) | el **calendario interno** del propio webmail — sin sincronización externa |
| Entregabilidad del correo | dominio de Calendly | **SMTP del propio anfitrión** (su dominio, su reputación) |
| Marca | white-label de pago | **gratis**, unificada con el branding del admin de email |
| Datos del cliente | en infra de Calendly | **en tu propia base** (soberanía / Ley 21.719) |

La "magia": sólo se muestran huecos **realmente libres**, calculados contra el calendario interno de
Bifrost en tiempo real. Sin doble-booking, sin depender de que nadie tenga cuenta de Google.

---

## 2. Modelo de datos (Mongo)

```
EventType            tipo de reunión (ej. "Charla 30 min"): duración, ubicación, buffers, preguntas,
                     límite diario, política de cancelación, referencia a un AvailabilitySchedule.
AvailabilitySchedule horario reutilizable: timezone (IANA) + reglas semanales (weekday→intervalos
                     "HH:MM") + excepciones por fecha (overrides). Un usuario puede tener varios.
Booking              la reserva. FUENTE DE VERDAD. Guarda un SNAPSHOT inmutable del tipo al momento de
                     reservar (timezone, duración, buffers, título, ubicación) + invitado + respuestas
                     + managementTokenHash + idempotencyKeyHash + icsUid + estado.
CalendarEvent        PROYECCIÓN de la reserva en el calendario interno (source:'booking', bookingId).
User.username        slug público único (índice parcial). User.defaultScheduleId = puntero atómico al
                     horario por defecto.
SystemConfig key='scheduling'  config de empresa (singleton): enabled, publicLinksEnabled, defaults,
                     maxEventTypesPerUser, auditEnabled.
```

**Por qué snapshot:** si el anfitrión cambia el tipo o lo borra después, la reserva conserva sus
condiciones originales (review C-M7). El `Booking` es la verdad; el `CalendarEvent` es una proyección
reconstruible.

---

## 3. Arquitectura de seguridad de concurrencia

Mongo es **single-node** (sin replica set → **sin transacciones multi-documento**). La integridad se
garantiza con varias capas, no con transacciones:

1. **Lock distribuido en Redis** (`lib/withLock.ts`, generalizado de `withAccountLock`): `SET NX EX`
   con token único + heartbeat (renueva el TTL mientras corre `fn`) + release vía Lua (sólo si el
   token coincide). El heartbeat `setInterval` se limpia siempre en `finally` (sin timer leak).
2. **Fail-closed**: si Redis está caído, `withLock` **lanza** → el endpoint responde **503** (nunca se
   degrada a reservar sin lock). Si el lock está ocupado por otro booking del mismo host → **409**.
3. **Idempotencia durable**: índice único `{userId,eventTypeId,idempotencyKeyHash}`. La clave viene del
   header `Idempotency-Key` (la UI genera un UUID estable por slot); si no hay header, se deriva un
   *fingerprint* `auto:${eventTypeId}:${startAt}:${email}`. Un reintento del mismo slot = **replay**,
   no una reserva nueva.
4. **Backstop de rango durable**: el índice único sólo cubre `startAt` EXACTO. Tras insertar, se
   re-verifica solape de rango (con buffers) contra otros bookings; si hay solape → se borra y 409
   (compensación). Cubre solapes parciales que el índice no ve.
5. **Atomicidad sin transacciones**: `Booking` = verdad, `CalendarEvent` = proyección. Si la
   proyección falla, se compensa (borrar). Un **reconciler** (job BullMQ repetible cada 60s, con 60s de
   grace) converge los estados parciales: bookings confirmadas sin CalendarEvent → re-linkea; bookings
   `rescheduled` a medias → completa/cancela; CalendarEvents huérfanos → cancela. Convergente bajo
   reintentos (CAS gateado por `modifiedCount`).

**DST** (`lib/scheduling/time.ts`, luxon): `resolveWallTime` resuelve "HH:MM en zona X" manejando el
gap de primavera (hora inexistente → se salta) y la ambigüedad de otoño (hora repetida → se toma la
primera). Los slots se generan en hora de pared del host y se entregan en **UTC**; el invitado los ve
en su zona. Los buffers expanden tanto el candidato como los ocupados.

---

## 4. Flujos

### 4.1 Anfitrión configura (autenticado, desde su webmail → "Reuniones")
1. Fija su **username** público (`PATCH /api/schedule/profile`).
2. Crea uno o más **horarios** (`/api/schedule/availability`): timezone + días/intervalos editables +
   excepciones. El primero se marca default (puntero atómico `User.defaultScheduleId`).
3. Crea **tipos de reunión** (`/api/schedule/event-types`): duración, ubicación (video/presencial/
   teléfono/custom), buffers, preguntas personalizadas, límite diario, política de cancelación.
4. Ve sus **reservas** y puede cancelarlas.

### 4.2 Invitado reserva (público, SIN sesión — `/u/:username`)
1. **Perfil** (`GET /api/schedule/public/:user`): lista los tipos activos. (Sólo existe si el host
   tiene cuenta primaria con SMTP **no deshabilitada** y la feature está activa.)
2. **Reserva** (`GET …/:event/slots` → elegir día/hora → datos → `POST …/:event/book`): flujo de 4
   pasos. El `book` responde **201** con la reserva + `managementToken` (en claro, sólo en creación);
   **409** si el hueco ya no está; **503** si Redis está caído.
3. **Confirmación**: la UI muestra el resumen y el enlace de gestión. El **correo de confirmación**
   (con adjunto **ICS**) sale async por el SMTP del host.

### 4.3 Invitado gestiona (por token — `/booking/:token`)
- **Ver / Cancelar / Reagendar** sin sesión, autenticado por el `managementToken` (hasheado en BD).
- Sigue operativo aunque la feature esté apagada (review C-M9), pero con **ventana de gestión**: no se
  puede reagendar una reunión **ya pasada** (→410) ni cancelar/reagendar fuera de la **anticipación
  mínima** del host (`cancelMinNoticeMin` → 409).
- Reagendar emite un `managementToken` **nuevo** (retira el viejo); la UI lo adopta y reescribe la URL.

### 4.4 Admin (rol admin → pestaña "Agenda")
- Activar la feature, links públicos, valores por defecto, límite de tipos por usuario, auditoría.
- **Auditoría** de reservas global (filtrable/paginada); gateada por `auditEnabled` (403 si off).

---

## 5. API (resumen)

**Host (autenticado, `/api/schedule`):**
`GET/POST/PATCH/DELETE /event-types[/:id]` · `GET/POST/PATCH/DELETE /availability[/:id]` ·
`GET/PATCH /profile` (username) · `GET /bookings` · `POST /bookings/:id/cancel`

**Público (sin auth, `/api/schedule/public`):** gateado por `enabled && publicLinksEnabled` salvo la
gestión por token.
`GET /:user` · `GET /:user/:event` · `GET /:user/:event/slots` · `POST /:user/:event/book`
(Idempotency-Key) · `GET /booking/:token` · `POST /booking/:token/(cancel|reschedule)` ·
`GET /booking/:token/slots`

**Admin (`/api/admin/scheduling`, rol admin):**
`GET/PATCH /settings` · `GET /summary` · `GET /bookings?status&from&to&userId&limit&skip`

**Privacidad:** el DTO público pre-reserva **no expone `location.value`** (URL de videollamada,
dirección, teléfono). El invitado lo recibe **después** de reservar (correo + snapshot por token).

---

## 6. Procesamiento async y observabilidad

- **Cola BullMQ** (`services/scheduling/queue.ts`): `send-email` (confirmación/cancelación/
  reprogramación + ICS, jobId determinista = idempotente) y `reconcile` (repetible). `attempts:5` +
  backoff; los fallidos se conservan (`removeOnFail:false` = **DLQ inspeccionable**). En test
  (`REDIS_URL=mock`) es no-op.
- **Observabilidad**: se loguea el fallo de encolado (`safeEnqueue`), el fallo/agotamiento de jobs
  (listeners `failed`/`error` → DLQ) y las **reparaciones del reconciler** (señal de crashes/races).
- El booking es **síncrono** (la reserva se crea en la request); sólo el correo es async. Si el correo
  falla permanentemente, queda en DLQ y se loguea (no se pierde silenciosamente).

---

## 7. Marca (branding)

La página pública (`PublicLayout.vue`) y los correos usan **el branding del admin de email**
(`/api/branding`, `SystemConfig key='branding'`): logo, nombre, color de acento. **No** hay branding
separado de agenda — decisión de producto (unificación).

---

## 8. Pruebas y verificación

- **API: 305 tests** (Vitest): motor de slots + DST, concurrencia (N invitados → 1 gana), idempotencia
  por fingerprint, compensación, reconciler convergente, gates, ventana de gestión, límites, privacidad.
- **E2E: 23 tests** (Playwright contra la API real del harness — Mongo memory + Redis mock + IMAP/SMTP
  fake). Incluye el **flujo público en navegador**: perfil → día/hora → datos → confirmación → gestión
  → cancelar. (No cubre el envío real de correo: el worker no corre con Redis mock — eso lo cubren los
  unit tests de `email.ts`/`ics.ts`.)
- Revisión multi-equipo: **B(Codex) 9.1 APPROVE, 0 HIGH** tras varias rondas + re-auditorías hostiles
  que destaparon y corrigieron bugs reales (concurrencia, privacidad, y un bug de producción donde un
  `null` persistido en settings bloqueaba toda creación de tipos).

---

## 9. Límites conocidos (deuda LOW documentada)

- **TD-SCHED-LIMIT-RACE**: el chequeo de `maxEventTypesPerUser` (count + create) no es atómico; dos
  POST concurrentes podrían exceder el límite por 1. Soft-limit de config, no invariante de seguridad.
- **TD-SCHED-SUMMARY-AUDIT**: `GET /admin/scheduling/summary` (agregados, admin-only) no está gateado
  por `auditEnabled` (sí lo está `/bookings`).
- **Importar calendarios externos** (CalDAV de ida) = futuro; hoy la disponibilidad se calcula sólo
  contra el `CalendarEvent` interno de Bifrost.

---

## 10. Stack

Backend: Fastify + zod, Mongoose, ioredis, **BullMQ**, **luxon** (DST), nodemailer (ICS).
Frontend: Vue 3 + vue-router (`meta.guestOk` para páginas públicas) + Pinia + vue-i18n + axios;
branding reactivo desde `/api/branding`. Implementado en 8 fases (3.0 infra → 3.7 admin).
