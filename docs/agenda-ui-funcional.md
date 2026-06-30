# Agenda Inteligente — Documento funcional de UI (pantalla por pantalla)

> Complemento de `agenda-inteligente-propuesta.md` (diseño técnico aprobado B9/D9).
> **Propósito:** especificar **cada pantalla, modal y sección** ANTES de construirla, para tener contra
> qué revisar (humano + B/C/D). Cada bloque define: acceso, propósito, **mockup**, elementos, estados,
> interacciones, validaciones, datos (API), i18n/brand y criterios de aceptación.
> Lenguaje visual = el de Bifrost (vars `--surface/--border/--accent/--text-1..3`, modales `border-radius:14`
> con borde-color superior, segmented controls, sidebar con `AppIcon`, Public Sans, **i18n es por defecto**,
> **branding parametrizable** `brand.ts`). Todos los textos son claves i18n (es/en).

---

## TL;DR — cómo queda pensado

```
                         ┌──────────────────────────── BIFROST (host, autenticado) ───────────────────────────┐
   Sidebar  ▸ Reuniones ─┤  [Tipos de reunión]   [Disponibilidad]   [Reservas]          Settings ▸ Enlace      │
                         │   H1 cards+link         H3 horario+tz       H5 lista+filtros   H7 username público   │
                         │   H2 modal tipo         H4 modal override   H6 modal detalle                         │
                         └───────────────────────────────────┬───────────────────────────────────────────────┘
                                                              │ publica
                                                              ▼
                         ┌──────────────────────── PÚBLICO (invitado, sin login) ───────────────────────────┐
   mail.dominio/u/ana ──▶│  P1 Perfil: lista de tipos  →  P2 Reservar: [fecha]→[hora,tz]→[datos]→[✓ listo]   │
   .../u/ana/30min ─────▶│  P3 Gestionar reserva (/booking/:token): ver · cancelar · reagendar              │
                         └───────────────────────────────────┬───────────────────────────────────────────────┘
                                                              │ confirma
                                       ┌──────────────────────┴───────────────┐
                                       ▼ E1 email invitado (+ICS)   E2 email host   E3 cancel/reagenda
                         ┌──────────────────────── ADMIN (empresa) ───────────────────────────┐
   Admin ▸ Agenda ──────▶│  A1 activar/defaults/límites/branding     A2 auditoría de reservas │
                         └───────────────────────────────────────────────────────────────────┘
```

**Flujo invitado (lo esencial):** abre `/u/ana` → elige "Reunión 30 min" → ve un **calendario** con los días
que tienen hueco → elige día → ve **horas libres en SU zona horaria** → completa **nombre, email, preguntas**
→ **confirma** → pantalla de éxito + correo con ICS + links para cancelar/reagendar. Sin cuenta, sin fricción.

**Inventario de pantallas:** Host H1–H8 · Público P1–P4 · Admin A1–A2 · Correos E1–E3. (18 artefactos.)

---

# HOST (autenticado)

## H0 · Acceso / navegación

- **Acceso:** nuevo ítem en el sidebar de `AppLayout`, icono `calendar-clock` (o `users`), etiqueta
  i18n `nav.scheduling` ("Reuniones"). Visible sólo si `SchedulingSettings.enabled` y el usuario tiene
  cuenta con SMTP (si no, el ítem lleva a un *empty state* que explica cómo habilitarlo).
- Ruta `/scheduling` (SPA, requiere auth). Sub-tabs internos (no rutas separadas, igual que un segmented control).

```
┌─ Sidebar ───────┐
│ ✉  Bandeja       │
│ 📇 Contactos     │
│ 📅 Calendario    │
│ 🗓️  Reuniones  ◀ │  ← nuevo
│ ⚙  Ajustes       │
└─────────────────┘
```

---

## H1 · Tipos de reunión (lista)  — pantalla principal de "Reuniones"

- **Propósito:** ver/crear/activar los tipos de reunión y copiar su enlace público.
- **Datos:** `GET /api/schedule/event-types`.

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│  Reuniones        [ Tipos ]  Disponibilidad   Reservas                  [+ Nuevo tipo]│
├───────────────────────────────────────────────────────────────────────────────────┤
│  Tu enlace público:  mail.tudominio.com/u/ana          [Copiar]  [Ver página ↗]      │
│                                                                                       │
│  ┌──────────────────────────┐  ┌──────────────────────────┐                          │
│  │▎Reunión 30 min      ● on │  │▎Asesoría 1 h        ○ off │   ▎ = barra color tipo   │
│  │ 30 min · Videollamada    │  │ 60 min · Presencial      │                          │
│  │ /u/ana/30min   [Copiar]  │  │ /u/ana/asesoria [Copiar] │                          │
│  │ [Editar]   [⋯]           │  │ [Editar]   [⋯]           │                          │
│  └──────────────────────────┘  └──────────────────────────┘                          │
└───────────────────────────────────────────────────────────────────────────────────┘
```

- **Elementos:** barra de tabs (segmented), banner del enlace público (con `[Copiar]` y `[Ver página]`),
  grid de cards (color, título, duración, ubicación, slug, toggle activo `●/○`, `[Editar]`, menú `⋯` =
  Duplicar/Desactivar/Eliminar(soft)). Botón `[+ Nuevo tipo]` abre **H2**.
- **Estados:** *loading* (skeleton de 2 cards) · *empty* ("Aún no tienes tipos de reunión. Crea el primero
  para compartir tu enlace.") + CTA · *sin username* (banner: "Primero define tu enlace público en Ajustes" →
  link a **H7**) · *error* (toast).
- **Interacciones:** toggle activo → `PATCH /event-types/:id {active}` (optimista); Copiar → clipboard +
  toast "Enlace copiado"; ⋯→Eliminar → confirm → `DELETE` (soft, desactiva).
- **Criterios de aceptación:** la card muestra color/duración/ubicación reales; el toggle refleja `active`;
  el enlace copiado abre la página pública correcta; sin username, no se puede activar (CTA a H7).

---

## H2 · Modal: Crear / Editar tipo de reunión

- **Acceso:** `[+ Nuevo tipo]` o `[Editar]`. Modal centrado (estilo `CalendarView`, borde-color superior).
- **Datos:** `POST` / `PATCH /api/schedule/event-types`; lista de schedules para el selector de disponibilidad.

```
┌───────────────── Nuevo tipo de reunión ─────────────────[x]┐
│ Nombre        [ Reunión 30 min                          ]   │
│ Enlace (slug) /u/ana/[ 30min            ]  (auto desde nombre)│
│ Descripción   [ Charla rápida para…                     ]   │
│ Duración      [ 30 ] min     Color [● ▾]                    │
│ Ubicación     (•) Videollamada [ https://meet…         ]    │
│               ( ) Presencial   ( ) Teléfono  ( ) Personal.  │
│ ─ Reglas ────────────────────────────────────────────────  │
│ Buffer antes [10]m   después [10]m    Anticip. mínima [4]h  │
│ Reservable hasta [60] días    Límite diario [ 8 ] (0=∞)     │
│ Disponibilidad [ Horario laboral ▾ ]                        │
│ ─ Preguntas al invitado (opcional) ──────────────────────  │
│ • Teléfono            [obligatorio ▢]   [+ Añadir pregunta] │
│ ─ Políticas ─────────────────────────────────────────────  │
│ Cancelación/reagenda hasta [2]h antes                       │
│                                       [Cancelar] [Guardar]  │
└────────────────────────────────────────────────────────────┘
```

- **Validaciones (cliente + servidor):** nombre 1..120; slug `[a-z0-9-]{1,40}` único por usuario y **no
  reservado** (admin/api/booking/login/meet/u…); duración 5..1440; buffers/anticipación ≥0; `dateRangeDays`
  1..365; límite ≥0; URL de videollamada sólo `https?:`; al menos una disponibilidad seleccionada.
- **Estados:** *creando/guardando* (botón spinner, campos disabled) · *error de validación* (mensaje bajo el
  campo) · *slug en uso* ("Ese enlace ya existe, prueba otro").
- **Criterios:** un tipo recién creado aparece en H1 y su enlace `/u/slug/eventSlug` resuelve en P2.

---

## H3 · Disponibilidad (horario semanal + zona horaria)

- **Propósito:** definir cuándo se puede reservar. **Datos:** `GET/PATCH /api/schedule/availability`.

```
┌───────────────────────────────────────────────────────────────────────┐
│  Reuniones    Tipos   [ Disponibilidad ]   Reservas      [+ Excepción]  │
├───────────────────────────────────────────────────────────────────────┤
│  Zona horaria [ America/Santiago ▾ ]   Horario [ Horario laboral ▾ ]    │
│                                                                         │
│  Lun  ●  [09:00]–[13:00]  [14:00]–[18:00]                [+ intervalo]  │
│  Mar  ●  [09:00]–[18:00]                                  [+ intervalo]  │
│  Mié  ●  [09:00]–[18:00]                                  [+ intervalo]  │
│  Jue  ●  [09:00]–[18:00]                                  [+ intervalo]  │
│  Vie  ●  [09:00]–[15:00]                                  [+ intervalo]  │
│  Sáb  ○  No disponible                                                   │
│  Dom  ○  No disponible                                                   │
│  ─ Excepciones (vacaciones / festivos / días especiales) ────────────── │
│  📅 18 sep 2026   No disponible (Fiestas Patrias)            [editar]   │
│  📅 27 jun 2026   10:00–14:00 (jornada especial)             [editar]   │
└───────────────────────────────────────────────────────────────────────┘
```

- **Elementos:** selector de tz (IANA, default = `user.preferences.timezone`), toggle por día, intervalos
  `HH:MM–HH:MM` (varios por día → permite pausas de descanso), `[+ intervalo]`, lista de excepciones,
  `[+ Excepción]` abre **H4**.
- **Validaciones:** `end>start` por intervalo; intervalos del mismo día no se solapan; tz IANA válida;
  cruces de medianoche **no permitidos** (mensaje claro). Cambios → `PATCH` (con confirm si afecta tipos
  activos: "Esto afecta tu disponibilidad pública").
- **Estados:** loading skeleton · guardando · error.
- **Criterios:** un día en `○` no ofrece slots en P2; un intervalo 09–13 + 14–18 deja 13–14 sin slots.

---

## H4 · Modal: Excepción de fecha (vacación / festivo / día especial)

```
┌──────────── Excepción de disponibilidad ───────────[x]┐
│ Fecha     [ 18/09/2026 ]                               │
│ (•) No disponible todo el día  (vacación/festivo)      │
│ ( ) Horario especial   [10:00]–[14:00]  [+ intervalo]  │
│ Nota (opcional) [ Fiestas Patrias                   ]   │
│                                  [Eliminar][Cancelar][Guardar]│
└────────────────────────────────────────────────────────┘
```

- **Semántica (clave):** la excepción **REEMPLAZA** las reglas semanales de esa fecha (vacío = no
  disponible; con intervalos = ESA es la disponibilidad → permite "trabajo este sábado").
- **Criterios:** una excepción "no disponible" oculta el día en P2 aunque la regla semanal lo permita.

---

## H5 · Reservas (lista)

- **Propósito:** ver reservas entrantes, próximas y pasadas; cancelar como host.
- **Datos:** `GET /api/schedule/bookings?from&to&status`.

```
┌───────────────────────────────────────────────────────────────────────┐
│  Reuniones   Tipos  Disponibilidad  [ Reservas ]   [Próximas▾][Buscar] │
├───────────────────────────────────────────────────────────────────────┤
│  HOY                                                                    │
│  ▎10:00–10:30  Reunión 30 min · Juan Pérez (juan@cliente.cl)  [Detalle] │
│  ▎15:00–16:00  Asesoría 1 h   · María Soto (maria@x.com)      [Detalle] │
│  MAÑANA                                                                  │
│  ▎11:00–11:30  Reunión 30 min · Pedro Lillo  [cancelada]      [Detalle] │
│  …                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

- **Elementos:** filtro estado (Próximas/Pasadas/Todas/Canceladas), búsqueda por invitado, filas agrupadas
  por día con color del tipo, badge de estado. Click → **H6**.
- **Estados:** loading · empty ("No tienes reservas en este rango.") · error.
- **Criterios:** las reservas también aparecen como eventos en `CalendarView` (H8); una cancelada se marca
  y libera el slot.

---

## H6 · Modal: Detalle de reserva (host)

```
┌──────────── Reunión 30 min ───────────────────────[x]┐
│ 🕑 Hoy · 10:00–10:30 (America/Santiago)               │
│ 👤 Juan Pérez · juan@cliente.cl                        │
│ 📍 Videollamada: https://meet…            [Unirse]     │
│ 💬 Teléfono: +56 9 1234 5678                           │
│ ─────────────────────────────────────────────────────│
│ Creada 27 jun 18:04 · vía enlace público              │
│              [Cancelar reunión]   [Cerrar]            │
└───────────────────────────────────────────────────────┘
```

- **Interacciones:** `[Cancelar reunión]` → confirm con motivo opcional → `POST /bookings/:id/cancel`
  (no destructivo: `status=cancelled` + CalendarEvent cancelado + email E3 al invitado).
- **Criterios:** cancelar libera el slot y envía E3; el detalle muestra respuestas a preguntas custom.

---

## H7 · Ajustes → Enlace público (username)

- **Acceso:** sección en `SettingsView`. **Datos:** `GET/PATCH /api/schedule/profile`.

```
┌─ Ajustes ▸ Enlace público ───────────────────────────┐
│ Tu enlace para agendar:                                │
│   mail.tudominio.com/u/[ ana            ]   [Guardar]  │
│   ✓ disponible            (3–40, a–z 0–9 -)            │
│ Vista previa: mail.tudominio.com/u/ana   [Abrir ↗]     │
│ ⚠ Necesitas una cuenta con SMTP para recibir reservas.│
└───────────────────────────────────────────────────────┘
```

- **Validaciones:** formato + unicidad (chequeo en vivo "✓ disponible / ✗ en uso") + palabras reservadas.
- **Criterios:** sin username no hay página pública; al fijarlo, `/u/<slug>` resuelve P1.

## H8 · Integración con el Calendario existente

- Las reservas confirmadas se ven como eventos en `CalendarView` (color "Reuniones", calendario
  `bifrost-scheduling`). Sólo lectura desde ahí (editar/cancelar se hace en H5/H6). Sin cambios de layout.

---

# PÚBLICO (invitado, sin login) — rutas `meta.public`/`guestOnly`

> Layout liviano propio (sin sidebar de inbox), **branded con la marca del admin de email** (no una
> propia): **logo, nombre, color de acento y tagline vienen de `GET /api/branding`** (el mismo branding que
> el admin configura para todo el webmail; `SystemConfig key='branding'`). Así, si la empresa subió su logo
> y color en el admin, la página pública de agenda los usa automáticamente (white-label real). Se muestran
> DOS identidades: (a) la **plataforma** (logo+color+footer del admin branding) y (b) la **persona** que
> agenda (avatar + nombre del host). i18n: idioma del navegador, conmutable.

## P1 · Perfil público  `/u/:userSlug`  (y alias `/meet/:userSlug`)

```
┌──────────────────────────────────────────────┐
│ [LOGO empresa]                  ← admin branding│
│            [avatar]  Ana Pérez                 │
│            Agenda una reunión conmigo          │
│ ┌────────────────────────────────────────────┐│
│ │▎ Reunión 30 min        30 min · Videollam. →││  ▎/botones usan el
│ ├────────────────────────────────────────────┤│  color de acento del
│ │▎ Asesoría 1 h          60 min · Presencial →││  admin branding
│ └────────────────────────────────────────────┘│
│        🌐 Español ▾     <Tagline/marca admin>  │
└──────────────────────────────────────────────┘
   Logo + nombre + acento + tagline = GET /api/branding (admin de email)
```

- **Datos:** `GET /api/schedule/public/:userSlug` (perfil + tipos activos). Sólo tipos `active`.
- **Estados:** *cargando* · *slug inexistente / feature off* → **P4** (404 genérico) · *sin tipos activos*
  ("Esta persona no tiene reuniones disponibles por ahora.").
- **Criterios:** cada card lleva a **P2**; nunca revela tipos inactivos ni datos privados del host.

## P2 · Flujo de reserva  `/u/:userSlug/:eventSlug`  (4 pasos en una vista)

```
PASO 1: fecha                         PASO 2: hora (tz invitado)
┌──────────────┬───────────────┐      ┌──────────────┬───────────────┐
│ Reunión 30min│   Junio 2026  │      │ Reunión 30min │  Jue 25 jun    │
│ 30 min       │ L M M J V S D │      │ 30 min        │  Zona [GMT-4 ▾]│
│ 📍 Videollam.│ ..  3  4 ●5 ●6│      │ 📍 Videollam. │  ┌───────────┐ │
│ Ana Pérez    │ ●9 ●10 11 ●12 │ ───▶ │ Ana Pérez     │  │  09:00     │ │
│              │ (● = con hueco)│      │  ‹ volver     │  │  09:30     │ │
└──────────────┴───────────────┘      └──────────────┴──│  10:00     │─┘
                                                          └───────────┘
PASO 3: datos                          PASO 4: confirmado
┌────────────────────────────┐        ┌────────────────────────────┐
│ Jue 25 jun · 10:00 (GMT-4) │        │   ✓ ¡Reunión agendada!      │
│ Nombre  [ Juan Pérez      ]│        │ Reunión 30 min con Ana      │
│ Email   [ juan@cliente.cl ]│  ───▶  │ Jue 25 jun · 10:00 (GMT-4)  │
│ Teléfono[ +56 9 …         ]│        │ Te enviamos un correo.       │
│ Notas   [                 ]│        │ [Añadir a mi calendario .ics]│
│  ‹ volver       [Agendar]  │        │ [Cancelar] [Reagendar]       │
└────────────────────────────┘        └────────────────────────────┘
```

- **Datos:** `GET …/:eventSlug` (detalle) · `GET …/:eventSlug/slots?from&to&tz` (huecos) ·
  `POST …/:eventSlug/book` (con header `Idempotency-Key`).
- **Lógica visible:** sólo días/horas con hueco real (servidor calcula con tz/DST/buffers/minNotice/límite);
  el invitado elige su zona horaria (autodetectada). El botón **Agendar** se deshabilita tras el primer click
  (anti doble-submit; la idempotencia lo respalda).
- **Validaciones:** email válido; campos `required` de preguntas; el slot debe seguir libre al confirmar
  (si otro lo tomó → mensaje "Ese horario ya no está disponible, elige otro" y refresco de slots — esto es el
  re-check bajo lock devolviendo 409).
- **Estados:** *sin huecos en el rango* ("No hay horarios disponibles, prueba otro mes") · *enviando* ·
  *conflicto 409* (vuelve a paso 2 con aviso) · *feature off / host sin SMTP* → P4 · *error de red* (reintento
  seguro por idempotencia).
- **Criterios:** dos invitados no pueden reservar el mismo hueco; la confirmación muestra hora en la tz del
  invitado; el `.ics` abre en cualquier cliente de calendario.

## P3 · Gestionar reserva  `/booking/:managementToken`

```
┌──────────────────────────────────────────────┐
│  Reunión 30 min con Ana Pérez                  │
│  Jue 25 jun · 10:00–10:30 (GMT-4)              │
│  Estado: Confirmada                            │
│        [ Reagendar ]      [ Cancelar ]         │
└──────────────────────────────────────────────┘
   Reagendar → reusa P2 (paso 2) excluyendo este slot
   Cancelar  → confirm + motivo → email a ambas partes
```

- **Datos:** `GET/POST /api/schedule/public/booking/:token/(cancel|reschedule)`. Token = capability URL.
- **Estados:** *token inválido/expirado* → "Este enlace ya no es válido" · *ya cancelada* (sólo lectura) ·
  *reagendada* (token viejo → 410, link a la nueva) · *fuera de la política* ("Sólo puedes cancelar hasta 2h
  antes").
- **Criterios:** cancelar/reagendar respeta `cancelMinNotice`; reagendar nunca pierde la reserva original si
  el nuevo slot falla (crash-safe, v3.3).

## P4 · Estados públicos de error / vacío

- **Slug inexistente / feature desactivada:** 404 genérico ("Página no encontrada") — sin revelar si el
  usuario existe.
- **Sin disponibilidad:** mensaje amable + sugerencia de otro mes.
- **Branding:** logo/nombre/color/tagline desde el **admin de email** (`GET /api/branding`), igual que P1/P2.
  Sin branding propio de agenda.

---

# ADMIN (empresa)

## A1 · Admin ▸ Agenda (configuración global)

- **Acceso:** `AdminView`, nueva sección. **Datos:** `GET/PATCH /api/admin/scheduling`.

```
┌─ Admin ▸ Agenda ──────────────────────────────────────┐
│ Función de agendamiento     [ ● Activada ]             │
│ Enlaces públicos            [ ● Activados ]             │
│ ─ Valores por defecto ─────────────────────────────── │
│ Zona horaria por defecto    [ America/Santiago ▾ ]     │
│ Duración por defecto        [ 30 ] min                  │
│ Reservable hasta            [ 60 ] días                 │
│ Máx. tipos por usuario      [ 10 ]  (límite de plan)    │
│ ─ Auditoría ──────────────────────────────────────────│
│ Registrar reservas          [ ● Sí ]    [Ver auditoría]│
│                                            [Guardar]   │
│ ⓘ El logo y la marca de la página pública se configuran │
│   en Admin ▸ Marca (branding de email). Se aplican solos.│
└───────────────────────────────────────────────────────┘
```

> **No hay branding propio aquí**: el logo/color/nombre de `/u/:slug` y de los correos salen del
> **branding del admin de email existente** (`Admin ▸ Marca`, `GET /api/branding`). A1 solo gestiona la
> lógica de agenda (activar, defaults, límites, auditoría).

- **Criterios (clave):** `Activada=off` → desactiva **descubrimiento + nueva reserva** (P1/P2 → 404) **pero
  NO** la gestión de reservas existentes (P3 cancel/reschedule sigue operando). Sólo `role:'admin'`.

## A2 · Admin ▸ Auditoría de reservas

```
┌─ Auditoría de reservas ───────────────────────[rango▾]┐
│ Fecha/hora      Host    Invitado        Tipo     Estado│
│ 27/06 18:04     ana     juan@cliente.cl 30min    conf. │
│ 27/06 17:12     ana     maria@x.com     asesoría canc. │
│ …                                       [Exportar CSV] │
└───────────────────────────────────────────────────────┘
```

- **Datos:** `GET /api/admin/scheduling/audit?from&to` (paginado, acotado). Sólo admin.

---

# CORREOS (también son "pantallas" del invitado/host)

> Salen por el SMTP del host (E1/E3 al invitado, E2 al host). HTML **branded con la marca del admin de
> email** (logo + color de acento + nombre desde `GET /api/branding`) + texto plano + **ICS adjunto**.
> Escape estricto (anti header/HTML injection); ICS con CRLF/folding/UTC. El logo va embebido (data-URL del
> branding admin) o como `cid:` para evitar bloqueo de imágenes remotas.

## E1 · Confirmación al invitado (+ ICS)

```
Asunto: Confirmada: Reunión 30 min con Ana Pérez — jue 25 jun 10:00
─────────────────────────────────────────────
✓ Tu reunión está agendada
Reunión 30 min con Ana Pérez
🕑 Jueves 25 jun 2026, 10:00–10:30 (GMT-4)
📍 Videollamada: https://meet…
[ Añadir a tu calendario ]  (ICS adjunto)
¿Cambió tu plan?  [Reagendar]   [Cancelar]
─────────────────────────────────────────────
   <logo + nombre de la empresa>   ← admin branding (GET /api/branding)
```

## E2 · Notificación al host
```
Asunto: Nueva reserva: Juan Pérez — Reunión 30 min, jue 25 jun 10:00
Juan Pérez (juan@cliente.cl) reservó "Reunión 30 min".
🕑 jue 25 jun 10:00 (America/Santiago) · 💬 Teléfono: +56 9…  [Ver en Reuniones]
```

## E3 · Cancelación / reprogramación
```
Asunto: Cancelada: Reunión 30 min — jue 25 jun 10:00
Tu reunión con Ana Pérez fue cancelada.  [Agendar otra]   (ICS METHOD:CANCEL adjunto)
```

---

# Mapa pantalla → endpoints (para revisar contra el back)

| Pantalla | Endpoint(s) |
|---|---|
| H1 lista tipos | `GET /event-types` · `PATCH /event-types/:id` (toggle) · `DELETE` (soft) |
| H2 modal tipo | `POST` / `PATCH /event-types/:id` |
| H3 disponibilidad | `GET/PATCH /availability` |
| H4 excepción | `PATCH /availability/:id` (overrides) |
| H5 reservas | `GET /bookings?from&to&status` |
| H6 detalle | `POST /bookings/:id/cancel` |
| H7 username | `GET/PATCH /profile` |
| P1 perfil | `GET /public/:userSlug` |
| P2 reservar | `GET /public/:userSlug/:eventSlug` · `…/slots` · `POST …/book` |
| P3 gestionar | `GET/POST /public/booking/:token(/cancel|/reschedule)` |
| A1 config | `GET/PATCH /admin/scheduling` |
| A2 auditoría | `GET /admin/scheduling/audit` |
| E1–E3 correos | worker BullMQ (post-commit) |

---

# Orden de construcción de UI (alineado con las fases técnicas)

- **Fase 3.5 (UI host):** H7 (username) → H3/H4 (disponibilidad) → H1/H2 (tipos) → H5/H6 (reservas).
- **Fase 3.6 (UI pública):** P1 → P2 (los 4 pasos) → P3 → P4 + correos E1–E3.
- **Fase 3.7 (admin):** A1 → A2.
- Cada pantalla se construye **contra su bloque de este documento** y se valida (Playwright + review B/C/D).

> Este documento es el contrato visual/funcional. Si la implementación se desvía de un mockup, se actualiza
> aquí primero y se re-revisa.
