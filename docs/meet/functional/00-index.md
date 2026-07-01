# Bifrost Meet — Documentación Funcional (Fase 0)

Contrato funcional **previo a implementación** (mandato PM). Fuente de verdad de comportamiento/APIs/datos: [`../DESIGN.md`](../DESIGN.md) (v2.3). Cada documento sigue la plantilla completa: información general · diseño funcional · componentes · botones · formularios · UX/UI · reglas de negocio · casos de uso · APIs · modelo de datos · auditoría · checklist QA.

## Pantallas

| # | Doc | Pantalla | Tipo de usuario | Ruta |
|---|-----|----------|-----------------|------|
| 01 | [01-meet-join.md](01-meet-join.md) | **MeetJoin** — pre-join (nombre, preview cam/mic, dispositivos) | Público (guest + interno) | `/meet/:slug` |
| 02 | [02-meet-call.md](02-meet-call.md) | **MeetCall** — in-call estilo Google Meet (grilla oscura, spotlight, **screen share**, barra mic/cam/compartir/salir) | Público (guest + interno) | `/meet/:slug` (in-call) |
| 03 | [03-calendar-meet.md](03-calendar-meet.md) | **Calendario** — checkbox "Agregar Bifrost Meet" + link en detalle | Autenticado | `/calendar` |
| 04 | [04-scheduling-eventtype-meet.md](04-scheduling-eventtype-meet.md) | **Tipo de evento (agenda)** — toggle "Incluir Bifrost Meet" | Host autenticado | `/scheduling` |
| 05 | [05-public-booking-meet.md](05-public-booking-meet.md) | **Reserva pública** — link de reunión en confirmación | Público (guest) | `/u/:userSlug/:eventSlug` |
| 06 | [06-settings-meet.md](06-settings-meet.md) | **Settings/Reuniones** — prefs por usuario | Autenticado | `/settings` (sección meet) |
| 07 | [07-admin-meet.md](07-admin-meet.md) | **Admin/Meet** — config global (master gate) | Admin | `/admin` (tab meet) |

## Notas transversales (aplican a todas)
- **Gate maestro**: toda la UI Meet se condiciona a `meetEnabled` (de `MeetSettings.enabled` + presencia de `LIVEKIT_*`), expuesto al SPA por `GET /api/config/public`. Con Meet OFF, ninguna pantalla muestra elementos Meet.
- **Seguridad**: token siempre emitido en backend (nunca en frontend); identidad de invitado opaca; slug aleatorio 128-bit no enumerable; gate de ventana temporal (`startAt−15m ≤ now ≤ endAt+30m`) y backlink en el endpoint público de token; multitenant por `userId`.
- **Privacidad**: el link de reunión es secreto **post-reserva** (nunca se expone pre-booking).
- **Integridad del link**: el slug se hornea en el snapshot inmutable del booking → el link no cambia; reschedule lo preserva; cancel cierra la sala.
- **i18n**: namespace `meet:` en `es.ts`/`en.ts`.
- **Screen share** está en MVP (UI estilo Google Meet); habilitado por el grant `canPublish`.

> Sincronización código↔doc: cualquier cambio funcional durante F3 debe reflejarse en el doc de la pantalla correspondiente. La verdad operativa final es el código; el objetivo es mantener esta documentación alineada para QA, auditoría y evolución.
