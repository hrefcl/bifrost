# Landscape Scan: Integracion de CalDAV/CardDAV en Webmail

## Facet: CalDAV/CardDAV Calendar Integration

### Key Findings

- **tsdav es la libreria Node.js/TypeScript mas moderna y completa** para CalDAV/CardDAV: soporta WebDAV, CalDAV y CardDAV en navegador y Node.js, con autenticacion OAuth2 y basica integrada, tipado TypeScript nativo, y esta testeada con multiples proveedores cloud (iCloud, Google, Fastmail, Nextcloud, Baikal). Tiene ~113,580 descargas semanales en npm y se mantiene activamente [^190^].

- **La libreria `dav` original (de Mozilla)** fue el pilar historico pero lleva 7 anos sin actualizarse significativamente. Existen forks mantenidos como `@naimo84/dav` y `dav-request`, pero `tsdav` ha emergido como el reemplazo de facto [^195^].

- **ical.js de Mozilla** es la libreria estandar para parsing/generacion de iCalendar (RFC 5545) en JavaScript. Soporta jCal (RFC 7265), vCard (RFC 6350) y jCard (RFC 7095). Es la base para todo el ecosistema de calendarios web y no tiene dependencias [^197^].

- **node-ical** es un fork de ical.js con mejoras especificas para Node.js: expansion robusta de RRULE, manejo de zonas horarias, EXDATE y RECURRENCE-ID. Proporciona APIs sincronas y asincronas para parsing desde strings, archivos locales y URLs remotas [^189^].

- **RFC 4791** define los requisitos obligatorios para servidores CalDAV: soporte iCalendar como media type, WebDAV Class 1, WebDAV ACL (RFC 3744), transporte TLS, ETags, todos los calendaring reports (calendar-query, calendar-multiget, free-busy-query), y advertising via DAV:supported-report-set [^153^] [^159^].

- **FullCalendar** es el estandar de facto para componentes UI de calendario en JavaScript, con integracion nativa para Vue.js (via `@fullcalendar/vue3`), React y Angular. Desde v5.5 soporta feeds iCalendar, y existe un plugin comunitario (`escoand/fullcalendar-plugins`) que anade soporte CalDAV como eventSource con autenticacion OAuth2 y Nextcloud [^130^] [^133^] [^238^] [^242^].

- **SOGo** implementa tanto CalDAV como CardDAV y ofrece integracion completa con Thunderbird (via SOGo Connector/Integrator), Outlook (via CalDAV Synchronizer), Apple Calendar, y ActiveSync para dispositivos moviles. Es considerado el referente en interoperabilidad de estandares abiertos [^224^] [^225^].

- **JMAP** (JSON Meta Application Protocol) es el estandar emergente de la IETF como reemplazo moderno de CalDAV/CardDAV. Usa JSON sobre HTTPS en lugar de XML/WebDAV. Stalwart es el primer servidor de correo que implementa JMAP for Calendars, Contacts y Files. Fastmail esta trabajando en la implementacion [^221^] [^222^] [^71^].

- **Roundcube** integra calendario via el plugin Kolab calendar que soporta multiples backends: database, kolab, caldav y rounddav. Requiere los plugins companeros `libcalendaring` y `libkolab`. Existe un fork activo mantenido por `texxasrulez` que anade el driver `rounddav` para sincronizacion con Nextcloud [^131^] [^231^].

- **Nextcloud Groupware** integra Mail, Calendar, Contacts y Deck. El app Mail detecta automaticamente invitaciones de reunion (.ics) y permite aceptar/declinar directamente desde el email. Roundcube se fusiono con Nextcloud en 2023, fortaleciendo el ecosistema [^223^] [^224^] [^237^].

- **CalDAV auto-discovery** usa DNS SRV/TXT records (RFC 6764) seguido de well-known URLs (`/.well-known/caldav`) y PROPFIND commands para descubrir colecciones de calendario. Los clientes modernos implementan este flujo automaticamente [^232^].

- **Manejo de timezones** es uno de los mayores desafios: VTIMEZONE en ICS es notoriamente problematico entre clientes (especialmente Outlook). La recomendacion es usar IANA timezones y convertir a UTC cuando sea posible [^155^] [^156^].

- **Sincronizacion bidireccional** requiere manejo de conflictos. Las mejores practicas incluyen: resolucion a nivel de campo (no de item completo), uso de ETags para deteccion de cambios, sync-tokens para sincronizacion incremental, y establecer direccion de sync por campo para minimizar conflictos [^226^].

### Major Players & Sources

| Entidad | Rol/Relevancia |
|---------|---------------|
| **tsdav** | Libreria Node.js/TypeScript CalDAV/CardDAV mas moderna y activa (~113K descargas/semana) [^190^] |
| **ical.js (Mozilla/kewisch)** | Parser iCalendar/vCard estandar para JavaScript, base del ecosistema web [^197^] |
| **node-ical** | Fork de ical.js con RRULE expansion y timezone handling mejorados para Node.js [^189^] |
| **ts-caldav** | Cliente TypeScript ligero y promise-based para CalDAV [^191^] |
| **FullCalendar** | Libreria UI de calendario estandar en JS, soporte Vue/React/Angular [^130^] |
| **SOGo** | Servidor groupware open source con CalDAV/CardDAV/ActiveSync, referente de interoperabilidad [^224^] |
| **Nextcloud** | Plataforma groupware con Mail, Calendar, Contacts integrados; adquirio Roundcube [^237^] |
| **Roundcube** | Webmail open source; integra calendario via plugins Kolab/CalDAV [^131^] |
| **Radicale** | Servidor CalDAV/CardDAV ligero en Python, file-based, facil de desplegar [^229^] |
| **Stalwart** | Primer servidor de correo con implementacion JMAP for Calendars/Contacts/Files [^222^] |
| **Fastmail** | Pionero en JMAP; desarrollando soporte JMAP para calendarios y contactos [^221^] |
| **webdav-client** | Libreria WebDAV en TypeScript para Node.js/browser (PROPFIND, custom requests) [^196^] |
| **Python caldav** | Libreria cliente CalDAV madura para Python, referente de compliance RFC [^157^] |
| **webOS-ports** | Implementacion Node.js funcional de conector CardDAV/CalDAV con sync bidireccional [^132^] |

### Trends & Signals

- **JMAP como reemplazo de CalDAV/CardDAV**: La IETF esta redefiniendo como se sincronizan calendarios y contactos. JMAP usa JSON sobre HTTPS en lugar de XML/WebDAV, eliminando la verbosidad e inconsistencias de DAV. JSCalendar y JSContact son las evoluciones JSON de iCalendar y vCard [^222^] [^71^].

- **Consolidacion Roundcube + Nextcloud**: La fusion de 2023 entre Roundcube y Nextcloud fortalece el ecosistema de webmail open source, combinando el robusto cliente email de Roundcube con la plataforma groupware de Nextcloud [^237^].

- **TypeScript como estandar**: `tsdav` y `webdav-client` representan la nueva generacion de librerias DAV escritas en TypeScript con soporte ESM, reemplazando librerias JavaScript legacy como `dav` [^190^] [^196^].

- **FullCalendar como hub UI**: El ecosistema de plugins alrededor de FullCalendar (incluyendo el plugin CalDAV comunitario) lo posiciona como el componente UI de facto para aplicaciones de calendario web [^238^] [^130^].

- **Adopcion de OAuth2 para autenticacion DAV**: Proveedores como Google requieren OAuth2 para CalDAV/CardDAV. Librerias modernas como `tsdav` incluyen helpers OAuth2 integrados [^190^] [^193^].

- **Self-hosting como tendencia**: Radicale, Baikal y servidores CalDAV ligeros ganan popularidad entre usuarios que buscan privacidad y control de datos, especialmente como alternativa a Google Calendar y Outlook [^222^] [^135^].

### Controversies & Conflicting Claims

- **JMAP vs CalDAV/CardDAV - madurez vs modernidad**: Stalwart y la IETF promueven JMAP como "revolucionario", pero criticas notan que DAV es "robusto, ampliamente adoptado y battle-tested". La adopcion de JMAP es aun muy limitada comparada con CalDAV [^221^] [^223^].

- **Complejidad de CalDAV**: Varios desarrolladores describen CalDAV como "notoriamente verbose, inconsistente y dificil de implementar correctamente". La informacion se dispersa entre HTTP headers, XML payloads y datos iCalendar embebidos [^222^] [^231^].

- **Timezone hell**: El manejo de VTIMEZONE es fuente constante de bugs inter-cliente. Outlook en particular tiene problemas serios con ICS hand-coded. Atlassian Jira documento un bug donde eventos recurrentes se muestran en el dia incorrecto debido a definiciones VTIMEZONE [^155^] [^156^].

- **Plugins Roundcube CalDAV fragiles**: La experiencia de instalar plugins CalDAV en Roundcube es descrita como "painful". Los plugins del repositorio original estan rotos o unmaintained, y solo el plugin Kolab con parches funciona correctamente [^131^] [^225^].

- **Nextcloud Mail vs Exchange**: Nextcloud Mail no es un reemplazo directo de Exchange como servidor de correo, sino un cliente webmail IMAP. Carece de caracteristicas enterprise como buzones compartidos, delegate send-as y public folders [^223^].

### Recommended Deep-Dive Areas

| Area | Por que merece profundidad |
|------|---------------------------|
| **Implementacion sync bidireccional con `tsdav` + ical.js** | Es el stack tecnologico recomendado para Node.js. Requiere entender ETags, sync-tokens, manejo de conflictos, y flujo de two-way sync [^193^] |
| **Integracion FullCalendar + CalDAV** | FullCalendar es el estandar UI pero requiere un conector CalDAV. El plugin de `escoand` es comunitario y necesita evaluacion de estabilidad para produccion [^238^] |
| **JMAP for Calendars como apuesta a futuro** | Aunque con adopcion limitada, JMAP simplifica drasticamente la implementacion. Vale la pena evaluar soporte dual CalDAV+JMAP [^222^] [^231^] |
| **Manejo de RRULE + timezones** | La expansion de eventos recurrentes y el manejo de zonas horarias son las fuentes principales de bugs. Requiere estudio de `ical.js` con `ical.timezones.js` [^158^] [^197^] |
| **Arquitectura de auto-discovery** | El flujo DNS SRV + well-known URLs + PROPFIND es critico para UX. RFC 6764 define el mecanismo estandar [^232^] |
| **Integracion calendario-email (invitaciones .ics)** | Nextcloud Mail y Roundcube muestran patrones: detectar adjuntos .ics, parsear con ical.js, mostrar UI de aceptar/declinar, enviar respuesta iTip [^227^] [^231^] |
| **Seguridad: OAuth2 + TLS para DAV** | RFC 4791 requiere TLS. Proveedores modernos requieren OAuth2. Necesario entender flujos de autenticacion para iCloud, Google, Nextcloud [^152^] [^190^] |

---

## Stack Tecnologico Recomendado

Para integrar CalDAV/CardDAV en un webmail moderno con Node.js:

```
Backend/Cliente DAV:    tsdav (TypeScript, CalDAV+CardDAV+WebDAV)
Parsing iCalendar:      ical.js (Mozilla, RFC 5545) o node-ical (fork con RRULE)
UI Calendario:          FullCalendar (@fullcalendar/vue3 para Vue.js)
Servidor DAV (test):    Radicale o Nextcloud
Auto-discovery:         RFC 6764 (DNS SRV + well-known + PROPFIND)
Sync bidireccional:     ETags + sync-tokens + manejo de conflictos
Timezones:              ical.timezones.js (IANA tz database)
Auth:                   Basic/Digest + OAuth2 helpers (tsdav built-in)
```

## Fuentes Clave

- [^190^] tsdav - npm package (CalDAV/CardDAV/WebDAV client TypeScript)
- [^193^] tsdav GitHub - Documentacion de API y workflows
- [^194^] tsdav docs - Cloud provider support matrix
- [^195^] npm search "dav" - Ecosistema de librerias DAV
- [^196^] webdav-client - Libreria WebDAV TypeScript (PROPFIND)
- [^197^] ical.js - Parser iCalendar/vCard de Mozilla
- [^189^] node-ical - Fork de ical.js para Node.js
- [^130^] FullCalendar - Libreria JS calendario estandar
- [^133^] FullCalendar Vue component
- [^238^] Plugin CalDAV para FullCalendar
- [^224^] SOGo - Servidor groupware con CalDAV/CardDAV
- [^230^] SOGo webmail
- [^131^] Roundcube CalDAV integration guide
- [^225^] Roundcube Kolab Plugins
- [^231^] Roundcube calendar fork (texxasrulez)
- [^237^] Roundcube merges with Nextcloud
- [^223^] Nextcloud Mail capabilities
- [^224^] Nextcloud Groupware
- [^227^] Nextcloud Mail calendar integration
- [^222^] JMAP for Calendars in Stalwart
- [^221^] Hacker News discussion JMAP
- [^71^] Wikipedia JMAP
- [^229^] Radicale - Servidor CalDAV/CardDAV ligero
- [^153^] RFC 4791 requirements overview
- [^159^] RFC 4791 full specification
- [^152^] CalDAV security and authentication
- [^232^] CalDAV auto-discovery (RFC 6764)
- [^155^] ICS timezone handling problems
- [^156^] Atlassian timezone bug
- [^158^] RRULE best practices (Nylas)
- [^226^] Two-way sync conflict resolution
- [^132^] webOS-ports Node.js CardDAV/CalDAV service
- [^135^] Open source CalDAV servers comparison
- [^157^] Python caldav client library
- [^130^] JavaScript calendar libraries 2024
- [^242^] FullCalendar iCalendar feed support
- [^241^] Webmail and groupware comparison
