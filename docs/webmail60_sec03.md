## 3. Stack Tecnológico Completo

El stack tecnológico de Webmail 6.0 se ha seleccionado bajo tres criterios estructurales: rendimiento cuantificable frente a alternativas, madurez de ecosistema para producción a plazo medio, y alineación con el ecosistema postalsys (imapflow, PostalMime, EmailEngine), que representa la única pila integrada y activamente mantenida para procesamiento de email en Node.js. A continuación se detallan las elecciones por capa, incluyendo justificaciones basadas en benchmarks y versiones específicas.

### 3.1 Frontend

#### 3.1.1 Vue 3.4 + Composition API + `<script setup>`

Vue 3.4 (lanzado enero 2024, última minor 3.4.31 en junio 2026) es el framework de UI seleccionado sobre React 18 y Svelte 4. La decisión se fundamenta en tres factores técnicos. Primero, el Composition API con `<script setup>` ofrece una densidad de código superior a los hooks de React, reduciendo la verbosidad de los componentes con estado —relevante para un webmail con docenas de componentes interactivos (lista de emails, panel de lectura, compositor, calendario). Segundo, el sistema de reactividad basado en Proxies de Vue 3 evita las limitaciones de los top-level arrays en React, facilitando la implementación de virtual scrolling sobre listas de emails mutables. Tercero, el tamaño de bundle en runtime de Vue 3 (~22 KB gzipped) es competitivo frente a React (~42 KB con react-dom), alineándose con el objetivo de rendimiento Lighthouse >95% heredado del análisis de SnappyMail [^67^].

#### 3.1.2 TypeScript 5 strict

TypeScript 5.5 (última release estable a junio 2026) se configura en modo strict (`strict: true`, `noImplicitAny: true`, `strictNullChecks: true`). La elección no es meramente de tipado estático: el modo strict habilita la inferencia de tipos narrowing en guards de nullabilidad, crítico para el manejo de emails donde campos como `inReplyTo`, `html` o `attachments` pueden ser undefined. Los tipos del ecosistema postalsys —imapflow y PostalMime proporcionan definiciones TypeScript nativas— eliminan la fricción de mantener `@types/` externos. El estricto chequeo de tipos previene una clase completa de errores en runtime relacionados con parsing de MIME y estructuras de email heterogéneas.

#### 3.1.3 Vite 5

Vite 5 (v5.4 en producción) reemplaza a Webpack como herramienta de build. Los benchmarks de tiempo de build muestran Vite 5 realizando HMR (Hot Module Replacement) en ~50ms frente a los 200-500ms de Webpack 5, lo que impacta directamente en la velocidad de desarrollo. Para producción, Vite utiliza Rollup internamente, generando bundles con tree-shaking agresivo que eliminan código muerto de dependencias como Tiptap, Headless UI y date-fns. La configuración de `vite.config.ts` incluye `splitVendorChunkPlugin()` para separar dependencias de terceros del código de aplicación, aprovechando el caché del navegador para actualizaciones incrementales.

#### 3.1.4 Pinia 2 — stores modulares por dominio

Pinia 2.1 (integrado oficialmente con Vue 3 desde febrero 2022) gestiona el estado global mediante stores modulares por dominio funcional: `useAuthStore`, `useMailboxStore`, `useThreadStore`, `useCalendarStore`, `useContactStore`, `useComposerStore`, `useSettingsStore`. Cada store define su propio state, getters y actions, eliminando la dispersión de lógica que caracteriza a Vuex 4. La API de composables de Pinia permite consumir estado reactivo directamente dentro de `<script setup>`, manteniendo el flujo de datos unidireccional sin el boilerplate de mappers. Para persistencia de estado, `pinia-plugin-persistedstate` almacena en `localStorage` configuraciones de usuario (tema, densidad de lista, columnas visibles) mientras que los datos de email (headers, cuerpos) se mantienen en memoria volátil para seguridad.

#### 3.1.5 Vue Router 4 con lazy loading

Vue Router 4.3 gestiona la navegación con lazy loading por ruta: `/inbox`, `/thread/:id`, `/compose`, `/calendar`, `/contacts`, `/settings`. Cada ruta se carga vía `defineAsyncComponent()` con `Suspense` para estados de carga, reduciendo el tamaño inicial del bundle JavaScript a lo estrictamente necesario para renderizar el layout principal. La navegación entre inbox y vista de thread utiliza transiciones de ~150ms con `router-view` envuelto en `<Transition name="fade">`, proporcionando fluidez perceptual sin penalización de rendimiento. El modo de historial `createWebHistory()` habilita URLs limpias sin hash, crítico para compartibilidad de enlaces a threads específicos.

#### 3.1.6 Tailwind CSS 3 + Headless UI

Tailwind CSS 3.4 proporciona el sistema de diseño utility-first, configurado con una paleta personalizada en `tailwind.config.js` que define tokens semánticos: `primary`, `surface`, `text-base`, `text-muted`, `border-subtle`. El enfoque utility-first elimina la necesidad de mantener hojas de estilo CSS modules, acelerando la iteración de componentes. Headless UI (v1.7 de Tailwind Labs) aporta componentes accesibles y sin estilos (`Dialog`, `Menu`, `Listbox`, `Popover`, `Combobox`, `Disclosure`, `Tabs`) que manejan automáticamente ARIA attributes, focus trapping y portales —requisitos críticos para un webmail donde la navegación por teclado (atajos tipo Gmail: G+C para compose, R para reply, F para forward) es una expectativa de usuario, no un feature opcional.

#### 3.1.7 Tiptap 2 (ProseMirror)

Tiptap 2.4, wrapper extensible del motor de edición ProseMirror, potencia el compositor de emails. ProseMirror proporciona el modelo de documento basado en un árbol de nodos inmutable, garantizando que el HTML generado esté siempre bien formado —una propiedad de seguridad relevante dado que el HTML malformado es vector de bypass en motores de sanitización. Tiptap añade extensiones declarativas: `StarterKit`, `Link`, `Image`, `Placeholder`, `Mention`, `Collaboration` (para edición concurrente de borradores), y `BubbleMenu` para formato inline. El compositor soporta los tres modos de contenido: texto plano, HTML enriquecido, y Markdown (vía `@tiptap/extension-markdown`), con conversión automática entre formatos según la configuración de la cuenta destino.

#### 3.1.8 Componentes UI: three-pane layout, virtual scrolling, drag-and-drop

Los componentes de interfaz críticos se implementan con las siguientes librerías especializadas:

| Componente | Librería | Versión | Justificación técnica |
|------------|----------|---------|----------------------|
| Virtual scrolling | `@vueuse/core` useVirtualList | 10.x | Renderizado de listas >10k items sin DOM overflow; reciclaje de nodos DOM |
| Drag-and-drop | `@vueuse/gesture` o SortableJS | 1.x / 1.15 | Reordenación de carpetas IMAP y arrastre de emails entre carpetas |
| Three-pane layout | CSS Grid + Pinia state | Nativo | Layout sidebar + lista + lectura; colapsable en viewports <1280px |
| Date formatting | `date-fns` | 3.x | 2 KB por locale; tree-shakeable; superior a moment.js |
| Iconografía | `lucide-vue-next` | 0.x | Iconos SVG stroke-based; tree-shakeable; ~1300 iconos |
| Notificaciones | `vue-sonner` | 1.x | Toasts para confirmaciones de envío y errores de sincronización |
| Selección múltiple | Ctrl/Cmd + Shift + click nativo | Nativo | Bulk actions: archive, delete, mark-as-read, mover a carpeta |

La combinación de estos componentes produce una interfaz que replica los patrones de interacción consolidados por Gmail —three-pane layout, selección múltiple con checkboxes, drag-and-drop de emails a carpetas, y virtual scrolling para inboxes de alto volumen— sin asumir la carga de una librería de componentes monolítica como Vuetify o Element Plus, cuyo tree-shaking es imperfecto y cuyos tamaños de bundle superan los 200 KB gzipped.

### 3.2 Backend

#### 3.2.1 Node.js 20 LTS

Node.js 20.15 LTS (codename "Iron", soporte hasta abril de 2026, extendido por el ciclo LTS hasta abril 2027) es la plataforma de ejecución. La versión 20 aporta mejoras relevantes: el permiso del modelo (`--experimental-permission`) para restringir acceso a sistema de archivos y redes, el stable test runner nativo (`node:test`), y el incremento de rendimiento del 10-15% en operaciones de stream y buffer comparado con Node.js 18, medido en benchmarks del equipo Node.js para cargas de I/O intensiva. Para un webmail que procesa streams MIME, buffers de adjuntos y conexiones IMAP persistentes, estas mejoras son materialmente significativas.

#### 3.2.2 Fastify 4 — 2-3x más rápido que Express

Fastify 4.28 es el framework HTTP seleccionado sobre Express 5 y NestJS 11. La decisión se fundamenta en benchmarks controlados: Express maneja ~6.150 req/s frente a ~14.460 req/s de Fastify bajo las mismas condiciones (100 conexiones concurrentes, 10 segundos, Autocannon) [^130^]. Otros benchmarks reportan Fastify procesando 70.000-80.000 req/s comparado con 20.000-30.000 de Express [^133^]. Dos características arquitectónicas de Fastify son determinantes para Webmail 6.0. Primero, `fast-json-stringify` serializa respuestas JSON hasta 2x más rápido que `JSON.stringify` nativo, mediante schemas de validación declarativos [^130^]. Segundo, el router `find-my-way` (basado en trie) es ~3x más rápido que el router regex-based de Express [^130^]. El sistema de plugins de Fastify ofrece encapsulación nativa: cada plugin (IMAP, SMTP, calendario, autenticación) posee su propio scope, evitando que decoradores y middlewares se filtren entre rutas [^128^]. Esta modularidad permite dividir la aplicación en microservicios sin refactorización mayor [^149^].

Una nota de cautela proviene de un estudio académico de la Universidad de Uppsala bajo carga extrema (10.000 VUs), donde NestJS demostró mayor estabilidad que Fastify en escenarios de saturación [^134^]. La resolución de este conflicto es contextual: Fastify gana en throughput normal; bajo saturación extrema, NestJS con adapter Fastify puede ofrecer mayor estabilidad. Para el perfil de carga de un webmail —bajo volumen de requests por usuario pero larga duración de sesiones— Fastify puro es la elección óptima.

| Framework | Throughput (req/s) | Latencia p50 | Serialización JSON | Sistema de plugins | Encapsulación |
|-----------|-------------------|--------------|-------------------|-------------------|---------------|
| Express 5 | ~6.150 [^130^] | ~16ms | JSON.stringify nativo | Middleware global | Ninguna |
| Fastify 4 | ~14.460 [^130^] | ~7ms | fast-json-stringify (2x) [^130^] | Encapsulado nativo | Por plugin [^128^] |
| NestJS 11+Fastify | ~15.000-18.000 [^131^] | ~6ms | class-transformer | Módulos DI | Por módulo |

La tabla compara las tres opciones evaluadas. Fastify 4 ofrece el mejor equilibrio entre rendimiento y simplicidad para un proyecto que no requiere la capa de abstracción adicional de NestJS. La serialización schema-based y la arquitectura de plugins encapsulados son ventajas arquitectónicas directamente aplicables a la modularidad del dominio de email (IMAP, SMTP, calendario, adjuntos).

#### 3.2.3 imapflow — única librería moderna IMAP para Node.js

imapflow (v1.0.164, junio 2026) es el cliente IMAP seleccionado. Es la única librería IMAP moderna y activamente mantenida para Node.js, proporcionando una API promise-based, soporte completo de TypeScript, y manejo automático de extensiones IMAP: CONDSTORE, QRESYNC, IDLE, COMPRESS, y extensiones propietarias de Gmail (X-GM-EXT-1 para labels) [^1^][^39^]. La alternativa histórica, `node-imap`, está en estado de mantenimiento inactivo: último commit hace más de 6 meses, 31 estrellas en GitHub, y sin soporte para las extensiones modernas que habilitan sincronización eficiente [^107^].

La configuración de imapflow expone parámetros críticos para el rendimiento de Webmail 6.0: `qresync` (habilitar QRESYNC para re-sincronización rápida), `disableAutoIdle`, `maxIdleTime` (reiniciar IDLE tras N milisegundos), y `missingIdleCommand` (comando fallback si IDLE no es soportado por el servidor) [^41^]. El manejo de mailbox locking integrado garantiza acceso concurrente seguro cuando múltiples workers de BullMQ acceden a la misma conexión IMAP [^1^].

#### 3.2.4 Nodemailer

Nodemailer (v6.9.14) mantiene su posición como la librería SMTP dominante para Node.js [^68^]. El transport SMTP soporta conexiones simples (STARTTLS), conexiones pooled (manteniendo conexiones abiertas para mejor rendimiento en envío masivo), y rate limiting configurable. Para Webmail 6.0, Nodemailer maneja: envío de emails nuevos, reenvíos con preservación de headers `In-Reply-To` y `References` (siguiendo el algoritmo JWZ para threading), y envío de invitaciones de calendario como multipart/alternative con componentes text/plain, text/html y text/calendar. El soporte OAuth2 para SMTP es obligatorio: Gmail requiere XOAUTH2 desde marzo de 2025, y Microsoft depreca Basic Auth en abril de 2026 [^58^][^59^].

#### 3.2.5 PostalMime

PostalMime (v2.3.2) reemplaza a `mailparser` como parser MIME. La recomendación proviene del propio equipo de Nodemailer: el README de mailparser señala explícitamente "For new projects, please consider using PostalMime" [^69^][^77^]. PostalMime ofrece ventajas decisivas: cero dependencias, soporte TypeScript nativo, compatibilidad con browser (Web Workers), Node.js y entornos serverless (Cloudflare Email Workers), y protecciones de seguridad integradas (`maxNestingDepth`, `maxHeadersSize`) que previenen ataques de exceso de anidamiento MIME [^99^]. Acepta input como string, ArrayBuffer, Blob, Buffer o ReadableStream, y devuelve un objeto estructurado con headers, from/to/cc, subject, html, text, attachments, messageId, inReplyTo y references [^101^]. Al ser desarrollado por el mismo equipo que mantiene imapflow (postalsys), la compatibilidad entre ambas librerías está garantizada —una propiedad que no existe al mezclar librerías de autores diferentes.

#### 3.2.6 DOMPurify + sanitize-html

La estrategia de sanitización HTML utiliza ambas librerías en capas diferentes, resolviendo el conflicto documentado en la investigación: DOMPurify atrapa más casos de borde en vectores XSS avanzados, mientras que sanitize-html ofrece mejor rendimiento para procesamiento masivo [^68^]. La arquitectura de Webmail 6.0 asigna DOMPurify al lado cliente (prevención de XSS en el browser del usuario, con configuración que permite solo un subset seguro de etiquetas: `p`, `br`, `strong`, `em`, `a` con `href` validado, `img` con `src` data-URI o http/https, `table`/`tr`/`td`, `ul`/`ol`/`li`) y sanitize-html al servidor (procesamiento bulk de emails entrantes antes de almacenar en MongoDB, con políticas estrictas de filtrado CSS y SVG). Esta dualidad de capas —cliente y servidor— constituye la defensa en profundidad que Roundcube no logró implementar, resultando en sus múltiples CVEs de XSS persistente [^68^].

#### 3.2.7 Juice

Juice (v10.0.4) inlinea CSS en el momento de envío de email, transformando reglas `<style>` en atributos `style` inline. Esta conversión es necesaria porque la mayoría de clientes de email de escritorio (Outlook, Apple Mail, Thunderbird) aplican filtros agresivos que eliminan etiquetas `<style>` o bloques `<style scoped>`, rompiendo el layout de emails HTML enriquecido. Juice procesa el HTML del compositor Tiptap, resuelve selectores CSS, y genera HTML con estilos inline que preservan la intención de diseño del remitente. La configuración incluye `preserveMediaQueries: true` para mantener `@media` queries en etiquetas `<style>` separadas, necesarias para layouts responsive en clientes móviles que sí las soportan.

### 3.3 Base de Datos y Caché

#### 3.3.1 MongoDB 7

MongoDB 7.0 es el almacén primario de metadata de email. El diseño de schema sigue la estrategia híbrida recomendada para sistemas de mensajería: documentos embebidos para datos estables (participantes de un thread, asunto, fecha) y referencias para datos que cambian frecuentemente (flags de lectura, labels, estado de draft) [^141^]. Cada mensaje se almacena como documento en la colección `emails` con estructura:

```
{ _id, userId, mailboxId, threadId, uid, flags, headers: {...}, 
  subject, from, to, cc, date, size, hasAttachments, bodyRef, createdAt }
```

El campo `threadId` —un hash del Message-ID del mensaje raíz— permite recuperar conversaciones completas en una sola query indexada [^184^]. La regla ESR (Equality → Sort → Range) gobierna la creación de índices compuestos: para la query de inbox (`mailbox = X`, ordenado por `date DESC`, rango por `uid`), el índice óptimo es `{mailboxId: 1, date: -1, uid: 1}` [^204^]. El límite de 16 MB por documento de MongoDB impone el límite técnico de embedding: los cuerpos de email y adjuntos se almacenan por referencia, no embebidos [^141^].

MongoDB Atlas Search (basado en Apache Lucene) cubre el 90% de los casos de búsqueda de email: full-text sobre asunto, cuerpo y remitente; filtrado por fecha y mailbox; autocomplete en barra de búsqueda; y fuzzy matching para typos [^129^][^132^]. Frente a Elasticsearch, Atlas Search elimina la complejidad operacional de sincronizar un cluster separado y ofrece una API integrada en el aggregation pipeline de MongoDB [^132^].

#### 3.3.2 Redis 7 — pub/sub, sessions, BullMQ 5

Redis 7.2 cumple cinco funciones en la arquitectura de Webmail 6.0. Primera, almacén de sesiones: la combinación de tokens de acceso en memoria del frontend con refresh tokens almacenados en Redis mediante `SETEX` con TTL de 7-14 días habilita la invalidación distribuida de sesiones y la rotación de tokens [^157^][^175^]. Segunda, caché de cuerpos de email: el patrón Cache-Aside (lazy loading) almacena en Redis los cuerpos de emails recientemente accedidos con TTL de 1 hora, reduciendo fetchs IMAP repetidos [^152^]. Tercera, pub/sub para notificaciones en tiempo real: cuando imapflow detecta un nuevo email vía IDLE, el backend publica un evento al canal Redis correspondiente; los servidores WebSocket suscritos distribuyen la notificación a los clientes conectados [^139^]. Cuarta, rate limiting: el algoritmo Sliding Window implementado con Sorted Sets (`ZADD`, `ZREMRANGEBYSCORE`, `ZCARD`) ofrece precisión de sub-segundo sin el efecto de burst de los límites de ventana fija [^156^][^158^]. Quinta, cola de trabajos: BullMQ 5 (estándar de facto en 2026, procesando billones de jobs diariamente) maneja tareas asíncronas —indexación de nuevo email en MongoDB, parsing MIME con PostalMime, extracción y almacenamiento de adjuntos, notificaciones push— con soporte para retries con backoff exponencial, dead letter queues, y OpenTelemetry tracing [^203^].

| Capacidad | MongoDB 7 | Redis 7 | Justificación conjunta |
|-----------|-----------|---------|----------------------|
| Metadata de email | Documentos `emails` con índices ESR | No aplica | Índice compuesto `{mailbox, date, uid}` para queries de inbox [^204^] |
| Full-text search | Atlas Search (Lucene integrado) | No aplica | Elimina Elasticsearch; cubre 90% de casos [^132^] |
| Sesiones de usuario | No aplica | `SETEX` con TTL 7d | Invalidación distribuida + rotación tokens [^157^] |
| Caché de cuerpos | No aplica | Cache-Aside, TTL 1h | Reduce fetchs IMAP repetidos [^152^] |
| Notificaciones push | No aplica | Pub/Sub a WebSocket servers | Fire-and-forget; <100ms latencia [^139^] |
| Rate limiting | No aplica | Sliding Window ZSET | Precisión sin boundary bursts [^156^] |
| Background jobs | Estado de jobs | BullMQ 5 colas + workers | Retry exponencial, dead letter, tracing [^203^] |

La tabla sintetiza la división de responsabilidades entre MongoDB y Redis. MongoDB actúa como fuente de verdad duradera para metadata de email y búsqueda; Redis como capa de velocidad para sesiones, caché, mensajería en tiempo real y orquestación de trabajos asíncronos. Esta separación es la configuración estándar de la industria para aplicaciones read-heavy como el email, donde la ratio de lecturas a escritiones supera 100:1 en inboxes típicos.

#### 3.3.3 SeaweedFS (alternativa MinIO)

Para almacenamiento de objetos (adjuntos de email, avatares de contactos, exports), SeaweedFS reemplaza a MinIO como opción por defecto. MinIO, tradicionalmente la opción más madura para object storage S3-compatible, tuvo su comunidad edition archivada en febrero de 2026 —el repositorio de GitHub es ahora read-only— y su licencia AGPL-3.0 genera riesgo legal para uso comercial sin licencia pagada [^177^][^179^]. SeaweedFS (licencia Apache 2.0) ofrece I/O muy alto y está especializado en el manejo de muchos archivos pequeños —exactamente el perfil de adjuntos de email, donde la mayoría de archivos son <5 MB [^177^]. Garage (Rust, optimizado para deployments distribuidos/edge) se mantiene como alternativa documentada para instalaciones edge o multi-región.

### 3.4 Infraestructura

#### 3.4.1 Nginx reverse proxy

Nginx 1.26 actúa como reverse proxy y terminador SSL/TLS. Su configuración incluye: upstream hacia el servidor Fastify (port 3000), servicio de archivos estáticos del frontend (build de Vite), compresión gzip/brotli para assets JavaScript y CSS, headers de seguridad (HSTS, X-Frame-Options, X-Content-Type-Options, CSP estricto), y rate limiting por IP a nivel de conexión (complementario al rate limiting de aplicación en Redis). Para conexiones WebSocket de notificaciones en tiempo real, Nginx configura `proxy_upgrade` y `proxy_connection` upgrade, manteniendo conexiones persistentes entre clientes y servidores Node.js.

#### 3.4.2 Docker + Docker Compose

El despliegue primario es Docker Compose multi-service. El archivo `docker-compose.yml` define los servicios: `web` (Nginx + assets estáticos), `api` (Fastify + Node.js 20), `worker` (procesos BullMQ), `mongo` (MongoDB 7), `redis` (Redis 7), y `seaweedfs` (almacén de objetos). Cada servicio incluye health checks, restart policies (`unless-stopped`), y límites de recursos (CPU/memoria). La imagen del servicio `api` utiliza multi-stage build: stage de build (`node:20-alpine` + dependencias + `npm run build`) y stage de producción (`node:20-alpine` + solo `node_modules` de producción + código compilado), reduciendo la imagen final a ~180 MB.

La elección de Docker Compose sobre Kubernetes es deliberada. Para el segmento objetivo de Webmail 6.0 —individuos, pequeñas organizaciones y hosting providers que necesitan un webmail funcional sin equipo de DevOps dedicado— Kubernetes añade complejidad operacional no justificada. Docker Compose con health checks, rotación de logs y gestión de secrets mediante variables de entorno proporciona una solución de despliegue completa. Kubernetes se documenta como alternativa para deployments enterprise, con manifiestos opcionales.

#### 3.4.3 Prometheus + Grafana

El stack de observabilidad comprende Prometheus 2.53 para recolección de métricas y Grafana 11 para visualización. Prometheus scrapea endpoints `/metrics` expuestos por la aplicación Fastify (vía `@fastify/metrics`), BullMQ (métricas de cola: jobs procesados, fallidos, en espera), y los exporters de MongoDB y Redis. Los dashboards de Grafana incluyen: throughput de API (requests/minuto, latencia p50/p95/p99), estado de conexiones IMAP (activas, en IDLE, reconexiones), profundidad de colas BullMQ, hit rate de caché Redis, y uso de almacenamiento de SeaweedFS. Las alertas configuradas (vía Alertmanager) disparan notificaciones cuando la latencia p95 del API supera 500ms, cuando la profundidad de una cola BullMQ excede 1.000 jobs, o cuando el ratio de errores de conexión IMAP supera el 5% en una ventana de 5 minutos.
