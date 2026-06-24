## Facet: Backend Architecture & Stack para Webmail Moderno

**Fecha de investigacion:** 2026-07-15
**Búsquedas realizadas:** 14 queries web
**Fuentes citadas:** 35+

---

### Key Findings

#### 1. Fastify vs Express: Performance y Arquitectura

- **Fastify 4 es 2-3x más rápido que Express** en benchmarks controlados. Un benchmark con Autocannon mostró Express manejando ~6,150 req/s vs Fastify con ~14,460 req/s bajo las mismas condiciones (100 conexiones concurrentes, 10 segundos) [^130^]. Otros benchmarks reportan Fastify manejando 70,000-80,000 req/s comparado con 20,000-30,000 de Express [^133^].

- **Fastify usa serialización basada en schema** (fast-json-stringify) que puede ser hasta 2x más rápida que JSON.stringify de Express [^130^]. El router `find-my-way` (trie-based) es ~3x más rápido que el router de Express [^130^].

- **El sistema de plugins de Fastify** ofrece encapsulación nativa — cada plugin tiene su propio scope, evitando que decoradores y middlewares se filtren entre rutas [^128^]. Esto contrasta con Express donde el middleware corre en una cadena global [^128^]. Fastify fue diseñado desde cero para ser modular, permitiendo dividir una aplicación en múltiples microservicios sin refactorización completa [^149^].

- En 2026, **NestJS v11 usa Express v5 como adapter por defecto**, pero puede cambiarse a Fastify vía `@nestjs/platform-fastify` para ganar ~15,000-18,000 req/s vs 10,000-12,000 con Express [^131^].

- **Nota importante sobre benchmarks académicos:** Un estudio de Uppsala University en entornos serverless mostró resultados contradictorios bajo carga extrema (10,000 VUs), donde NestJS demostró mayor estabilidad que Fastify en escenarios de saturación [^134^]. Esto sugiere que "hello world benchmarks" no reflejan completamente el comportamiento en producción [^131^].

#### 2. MongoDB: Schema Design e Indexing para Email

- **MongoDB es inherentamente read-heavy para email**, por lo que la estrategia recomendada es denormalizar datos y usar embedded documents para reducir joins [^148^]. Para un sistema de email threading, la estructura híbrida — embed datos estables y referencia datos que cambian frecuentemente — es el enfoque óptimo [^141^].

- **Para conversaciones threadeadas en MongoDB**, se recomienda almacenar un `threadId` (posiblemente un hash del Message-ID original) junto con arrays ordenados de participantes para facilitar búsqueda de conversaciones completas en una sola query [^184^]. El límite de 16MB por documento debe considerarse para evitar over-embedding [^141^].

- **La regla ESR (Equality → Sort → Range)** es crítica para diseñar compound indexes en MongoDB [^204^]. Para queries de email (filtro por `mailbox`, sort por `date`, range por `uid`), el índice óptimo sería: `{mailbox: 1, date: -1, uid: 1}` [^204^].

- **MongoDB Atlas Search** (basado en Apache Lucene) ofrece full-text search integrado sin infraestructura adicional, con sincronización automática de datos y una sola API/driver [^132^]. Comparado con Elasticsearch: Atlas Search elimina la carga operacional de un cluster separado y cubre la mayoría de casos de búsqueda [^129^]. Elasticsearch ofrece más opciones avanzadas de tuning de relevancia (learning-to-rank, function score complejo) [^129^].

- **Wildcard indexes** (`$**`) son útiles para campos de metadata impredecibles pero tienen tradeoffs: mayor tamaño, writes más lentos, y no ayudan en queries compuestos [^150^]. Para email metadata con campos conocidos (from, to, subject, date), indexes targeted compuestos son preferibles [^150^].

#### 3. Redis: Pub/Sub, Sessions, Caché y Background Jobs

- **Redis Pub/Sub es fire-and-forget**: mensajes se evaporan si no hay suscriptores activos en el momento de publicación [^138^]. Para notificaciones en tiempo real de webmail (nuevos emails), esto es adecuado si los WebSocket servers están siempre conectados como suscriptores [^142^].

- **Arquitectura típica para notificaciones realtime**: WebSocket server (Node.js + ws/Socket.IO) se suscribe a canales Redis; backend services publican eventos a esos canales; Redis distribuye a todos los WebSocket servers conectados [^139^]. Un load balancer (NGINX/ALB) distribuye conexiones WebSocket y un autoscaler (Kubernetes) ajusta instancias dinámicamente [^139^].

- **Para durabilidad de eventos** (garantizar que no se pierdan mensajes de email), **Redis Streams** es preferible sobre Pub/Sub puro, ya que ofrece persistencia, acknowledgment y replay de mensajes [^142^].

- **Redis como session store**: La combinación `connect-redis` + `express-session` (o equivalente para Fastify) proporciona sesiones persistentes con TTL automático, crítico para webmail donde múltiples instancias del API necesitan compartir estado de autenticación [^175^][^176^]. Redis maneja millones de sesiones simultáneas gracias a su arquitectura in-memory [^176^].

- **Patrones de caché recomendados para webmail**:
  - **Cache-Aside (Lazy Loading)**: La app lee del caché primero; en miss, fetchea de MongoDB y almacena en Redis con TTL [^152^].
  - **Write-Through/Write-Behind**: Writes van al caché (y DB) sincrónica o asíncronamente [^147^].
  - **TTL-based eviction**: Expirar keys automáticamente para evitar stale data — esencial para lista de emails que cambian frecuentemente [^151^].

- **BullMQ 5** es el estándar de facto para job queues en Node.js en 2026, procesando billones de jobs diariamente [^203^]. Soporta retries con exponential backoff, dead letter queues, flow producers para dependencias DAG, y OpenTelemetry tracing [^203^]. Ideal para procesamiento asíncrono de emails (indexación, parsing, notificaciones).

#### 4. Rate Limiting con Redis y Fastify

- **El algoritmo Sliding Window con Redis Sorted Sets (ZSET)** ofrece la mejor precisión para rate limiting de APIs [^156^]. Cada request se agrega a un sorted set con timestamp como score; `ZREMRANGEBYSCORE` elimina timestamps viejos; `ZCARD` cuenta requests en la ventana actual [^156^].

- **Tres algoritmos core** para rate limiting con Redis [^158^]:
  - **Fixed Window**: Simple (INCR + EXPIRE) pero sufre "burst effect" en los bordes.
  - **Sliding Window**: Preciso, sin boundary bursts, usa ZSET — **recomendado como default**.
  - **Token Bucket**: Permite bursts controlados mientras mantiene rate promedio.

#### 5. WebSocket: ws vs Socket.IO para Notificaciones

- **ws (WebSocket nativo para Node.js)**: ~45,493 msg/s throughput, 18.75ms RTT con 1,000 clientes. Es la opción más performante para escenarios punto-a-punto [^155^].

- **Socket.IO**: ~27,152 msg/s, 31.23ms RTT con 1,000 clientes [^155^]. Más overhead por abstracciones y framing custom, pero incluye: auto-reconexión, fallback a HTTP long-polling, y rooms para broadcasting [^162^].

- **Para un webmail**: Si la compatibilidad cross-browser es importante y se necesitan features como rooms (notificaciones por usuario), Socket.IO es preferible a pesar del overhead. Si la performance cruda es prioridad y se maneja la reconexión manualmente, `ws` es superior [^162^]. Ambos pueden escalar horizontalmente con Redis pub/sub para sincronización entre instancias [^155^].

#### 6. JWT Authentication y Refresh Token Rotation

- **Patrón recomendado para webmail** [^157^][^160^]:
  - **Access Token**: Short-lived (15-30 min), almacenado en memoria (estado local del frontend), enviado en header `Authorization`.
  - **Refresh Token**: Long-lived (7-14 días), almacenado server-side en Redis, entregado vía HTTP-only cookie con `secure` y `sameSite: strict`.
  - **Token Rotation**: Cada vez que se usa un refresh token, se emite uno nuevo y se invalida el anterior.

- **Prevención de token reuse** [^157^]: Implementar un `tokenRegistry` que trackee el estado de cada token (Token ID, Family ID, Previous Token hash, Revocation Status). Si se detecta reúso, revocar toda la familia de tokens y forzar re-autenticación.

- **Redis es ideal para almacenar refresh tokens** gracias a su soporte nativo de expiración (SETEX con TTL) [^157^].

#### 7. MinIO y S3-Compatible Storage para Attachments

- **MinIO es la opción más madura** para object storage self-hosted compatible con S3, pero **su comunidad edition fue archivada en febrero 2026** — el repo de GitHub es ahora read-only [^177^][^179^]. La licencia AGPL-3.0 genera riesgo legal para uso comercial sin licencia paga.

- **Alternativas activas a MinIO en 2026** [^177^]:
  - **SeaweedFS**: Apache 2.0, muy alto I/O, especializado en muchos archivos pequeños.
  - **Garage**: Rust, ligero, optimizado para deployments distribuidos/edge.
  - **RustFS**: Apache 2.0, en Alpha — aún no para producción pero prometedor.
  - **Ceph + RadosGW**: Enterprise-grade, petabyte scale, operación compleja.

- **Para attachments de email** (muchas lecturas/escrituras de archivos binarios medianos), SeaweedFS o Garage son las mejores opciones para nuevos proyectos, evitando la incertidumbre de MinIO.

#### 8. IMAP Connection Pooling

- **ImapFlow** es la librería IMAP moderna recomendada para Node.js: promise-based API, manejo automático de extensiones IMAP (CONDSTORE, QRESYNC, IDLE, COMPRESS), soporte TypeScript, y streaming vía async iterators [^1^][^3^].

- **Para evitar límites de conexiones IMAP** (especialmente con Office365/Gmail que imponen límites estrictos), se recomienda un pool manager con pattern Singleton [^137^]:
  ```typescript
  class ImapConnectionPool {
    private static instance: ImapClient | null = null;
    private static lastUsed: number = 0;
    private static timeout = 5 * 60 * 1000; // 5 min
    static async getConnection(credentials) { /* reuse o crea */ }
  }
  ```

- **Mejores prácticas**: Reusar conexiones dentro de una ventana de tiempo; batch operaciones (abrir → múltiples operaciones → cerrar); respetar límites del provider IMAP [^137^]. ImapFlow incluye mailbox locking integrado para acceso concurrente seguro [^1^].

#### 9. Mongoose Encryption para Campos Sensibles

- **mongoose-aes-encryption** proporciona encriptación transparente a nivel de campo usando AES-256-GCM [^154^]. La aplicación lee y escribe valores en plain text mientras solo ciphertext toca la base de datos.

- El plugin se aplica al schema y especifica qué campos encriptar:
  ```javascript
  const createAESPlugin = require('mongoose-aes-encryption');
  const plugin = createAESPlugin({ key: process.env.ENCRYPTION_KEY });
  schema.plugin(plugin, { fields: ['email', 'phoneNumbers'], sensitive: true });
  ```

- **Es crítico para webmail** donde los contenidos de email (saludos, PII en headers) deben protegerse incluso si la base de datos se ve comprometida [^154^].

#### 10. MongoDB Atlas Search vs Elasticsearch para Búsqueda de Email

- **MongoDB Atlas Search** es el punto de partida obvio para proyectos greenfield en Atlas: cero infra adicional, sincronización automática, queries integradas en aggregation pipeline con `$search`, highlighting, fuzzy search, autocomplete, y synonyms [^129^][^132^].

- **Elasticsearch** es preferible cuando se necesita el tuning de relevancia más avanzado (learning-to-rank, function score complejo), analytics del stack ELK, o el equipo tiene expertise dedicado en search engineering [^129^].

- Para un webmail moderno, **Atlas Search cubre el 90% de los casos**: búsqueda full-text sobre asunto, cuerpo, remitente; filtrado por fecha/mailbox; autocomplete en búsqueda [^132^].

---

### Major Players & Sources

| Entidad | Rol/Relevancia |
|---------|---------------|
| **Fastify** | Framework HTTP Node.js performance-first, 2-3x más rápido que Express, plugin architecture con encapsulación nativa [^128^][^130^] |
| **Express.js** | Framework incumbent con mayor ecosistema, adecuado para apps no críticas en performance, v5 default en NestJS 11 [^131^] |
| **MongoDB** | Document store NoSQL para metadata de email, soporta índices compuestos, TTL, sharding horizontal, Atlas Search integrado [^132^][^148^] |
| **Redis** | In-memory store multi-propósito: sesiones, caché, pub/sub realtime, streams durable, colas de jobs (BullMQ), rate limiting [^138^][^158^] |
| **ImapFlow** | Cliente IMAP moderno para Node.js, promise-based, TypeScript, streaming, production-ready (base de EmailEngine) [^1^][^3^] |
| **BullMQ 5** | Job queue sobre Redis, estándar de facto en 2026 para background processing en Node.js [^203^][^210^] |
| **MinIO** | Object storage S3-compatible, community edition archivada en 2026, AGPL-3.0, alternativas: SeaweedFS, Garage [^177^][^179^] |
| **Socket.IO** | Librería WebSocket con fallback, rooms, auto-reconexión; ~27k msg/s [^155^][^162^] |
| **ws (nodejs)** | WebSocket minimalista para Node.js; ~45k msg/s, máximo rendimiento [^155^] |
| **mongoose-aes-encryption** | Plugin de Mongoose para encriptación AES-256-GCM a nivel de campo [^154^] |
| **SeaweedFS** | Alternativa S3-compatible Apache 2.0, alto I/O para archivos pequeños [^177^] |
| **Garage** | Alternativa S3-compatible ligera en Rust, optimizada para distributed/edge [^177^] |
| **Redis.io** | Autoridad oficial para patrones de rate limiting y pub/sub [^138^][^158^] |
| **MongoDB Inc.** | Comparativa oficial Atlas Search vs Elasticsearch [^132^] |

---

### Trends & Signals

- **Fastify está ganando terreno** sobre Express para proyectos nuevos en 2025-2026, especialmente en microservicios y APIs de alta frecuencia [^133^][^146^]. Muchos equipos usan NestJS con adapter Fastify para combinar estructura + velocidad [^131^].

- **MinIO ha abandonado el open source activo** (repo archivado feb 2026) [^177^][^179^], impulsando adopción de alternativas como SeaweedFS y Garage con licencias más permisivas (Apache 2.0).

- **MongoDB Atlas Search está reemplazando a Elasticsearch** como motor de búsqueda para aplicaciones que ya usan MongoDB, reportando 30-50% mejora en time-to-market [^132^]. La integración de Lucene directamente en Atlas elimina el pipeline de sincronización [^129^].

- **Redis sigue siendo el "duct tape" del backend**: sesiones, caché, pub/sub, streams, rate limiting, y job queues — todo en una sola tecnología [^139^][^156^][^175^][^203^]. La aparición de BullMQ 5 con soporte OpenTelemetry refuerza su posición central [^203^].

- **WebSockets + Redis Pub/Sub** es el patrón dominante para notificaciones en tiempo real (email push notifications), reemplazando el polling tradicional [^139^][^142^].

- **La encriptación a nivel de campo** en MongoDB (vía plugins como mongoose-aes-encryption) está ganando tracción como requisito de compliance para aplicaciones que manejan PII [^154^].

- **Sliding window rate limiting** se está convirtiendo en el estándar para APIs de producción, reemplazando el fixed window por su mayor precisión [^158^].

- **BullMQ con workers separados del API server** es el patrón arquitectónico recomendado para procesamiento de background jobs en 2026, con Docker Compose/Kubernetes para scaling independiente [^203^].

---

### Controversies & Conflicting Claims

| Conflicto | Perspectiva A | Perspectiva B | Resolución |
|-----------|--------------|--------------|------------|
| **Fastify vs Express performance real** | Benchmarks "hello world" muestran Fastify 2-4x más rápido [^130^][^133^] | Benchmark académico bajo 10,000 VUs muestra NestJS > Fastify en estabilidad [^134^] | Fastify gana en throughput normal; bajo saturación extrema, NestJS puede ser más estable. La elección depende del perfil de carga esperado [^131^] |
| **MongoDB Atlas Search vs Elasticsearch** | Atlas Search elimina complejidad operacional y sincronización [^132^] | Elasticsearch ofrece tuning de relevancia más avanzado y analytics [^129^] | Atlas Search para greenfield y equipos sin expertise search; Elasticsearch para casos de ranking complejo |
| **Redis Pub/Sub vs Streams** | Pub/Sub es más simple y de menor latencia para notificaciones [^142^] | Streams ofrecen durabilidad y garantía de entrega [^142^] | Usar Pub/Sub para notificaciones realtime fire-and-forget; Streams para eventos críticos que no pueden perderse |
| **ws vs Socket.IO** | ws es más rápido (45k vs 27k msg/s) [^155^] | Socket.IO tiene más features (rooms, fallback, reconexión) [^162^] | ws para máxima performance; Socket.IO para developer velocity y features built-in |
| **MinIO como opción self-hosted** | MinIO es el más maduro y compatible con S3 [^173^][^188^] | Community edition archivada, licencia AGPL riesgosa [^177^][^179^] | Para nuevos proyectos, evaluar SeaweedFS (Apache 2.0) o Garage antes de MinIO |
| **Cache-Aside vs Write-Through** | Cache-Aside es más simple y flexible [^152^] | Write-Through evita stale data en writes frecuentes [^147^] | Para webmail (más reads que writes): Cache-Aside para inbox listing; Write-Through para marca de leído |

---

### Recommended Deep-Dive Areas

| Área | Por qué merece profundidad |
|------|---------------------------|
| **Fastify plugin system + Dependency Injection** | La encapsulación nativa de Fastify permite construir módulos de email (IMAP, SMTP, search, attachments) como plugins independientes con sus propios scopes. Un análisis de cómo estructurar un webmail como composición de plugins sería valioso [^149^][^140^]. |
| **Redis Streams para event sourcing de email** | Dado que Pub/Sub es fire-and-forget, para garantizar que ningún evento de email nuevo se pierda, Redis Streams con consumer groups ofrecería durabilidad + replay. Esto es crítico para un webmail donde perder una notificación de email nuevo es inaceptable [^142^]. |
| **ImapFlow connection pool a producción** | El snippet de pool manager [^137^] es básico. Un deep-dive sobre: límites específicos por provider (Gmail: 250 conexiones simultáneas; Outlook: 20), estrategia de reintentos, handling de IDLE vs polling, y health checks de conexiones IMAP sería esencial para escabilidad. |
| **Sharding strategy para MongoDB en escala de email** | Con millones de usuarios y billones de mensajes, un solo cluster MongoDB puede no ser suficiente. Estrategias de sharding por `userId` o `mailboxId`, y cómo esto afecta queries de búsqueda cross-mailbox, merecen análisis [^148^]. |
| **Mongoose discriminators para tipos de email** | Diferentes tipos de email (regular, draft, template, scheduled) pueden beneficiarse de discriminadores de Mongoose para schemas variantes bajo una misma collection, optimizando índices y queries. |
| **BullMQ job flows para procesamiento de email** | Un email entrante requiere múltiples pasos: IMAP fetch → parse → virus scan → index en MongoDB → extract attachments → store en S3 → notify user. BullMQ FlowProducer permite modelar esto como un DAG con dependencias [^203^]. |
| **WebSocket scaling con Redis + sticky sessions** | Para notificaciones push de email nuevo en tiempo real, el scaling horizontal de WebSocket servers con Redis pub/sub requiere decisiones sobre: sticky sessions vs stateless, reconexión graceful, y delivery guarantees [^139^][^155^]. |
| **Encryption-at-rest para email body + attachments** | El plugin mongoose-aes-encryption cubre campos del schema [^154^], pero para contenido completo de emails (que puede ser grande), una estrategia de encriptación por chunks + almacenamiento en object storage requiere diseño específico. |
| **Observability con OpenTelemetry + BullMQ 5** | La integración de tracing distribuido para todo el pipeline de email (API → job queue → IMAP → MongoDB → S3) usando BullMQ 5 + OpenTelemetry es un área emergente que merece exploración [^203^]. |

---

### Referencias

[^1^]: imapflow npm package. "Modern and easy-to-use IMAP client library for Node.js." https://www.npmjs.com/package/imapflow

[^3^]: ImapFlow official site. "Modern IMAP Client for Node.js." https://imapflow.com/

[^128^]: Algoroq. "Express vs Fastify: A Detailed Comparison for System Design." 2026-04-25. https://algoroq.io/compare-tech/express-vs-fastify

[^129^]: OneUptime. "MongoDB Atlas Search vs Elasticsearch: Full-Text Search Comparison." 2026-03-31. https://oneuptime.com/blog/post/2026-03-31-mongodb-atlas-search-vs-elasticsearch-full-text/view

[^130^]: Michael Guay. "Express vs Fastify: A Performance Benchmark Comparison." 2026-03-21. https://michaelguay.dev/express-vs-fastify-a-performance-benchmark-comparison/

[^131^]: Meduzzen. "NestJS vs Fastify vs Express: which backend wins in 2026." 2026-05-28. https://meduzzen.com/blog/nestjs-vs-fastify-vs-express-backend-2026/

[^132^]: MongoDB Inc. "MongoDB Atlas Search vs. Elastic Elasticsearch." 2025-11-05. https://www.mongodb.com/resources/compare/mongodb-atlas-search-vs-elastic-elasticsearch

[^133^]: CodeToDeploy. "Express or Fastify in 2025: What's the Right Node.js Framework for You?" 2025-08-07. https://medium.com/codetodeploy/express-or-fastify-in-2025-6ea247141a86

[^134^]: Uppsala University. "Evaluating the performance of the Node.js frameworks." Diva Portal. https://www.diva-portal.org/smash/get/diva2:1968504/FULLTEXT01.pdf

[^135^]: Logz.io. "Open Source Comparison: Elasticsearch vs. MongoDB." 2025-07-25. https://logz.io/blog/elasticsearch-vs-mongodb/

[^137^]: n8n Community. "Reusing an existing IMAP connection in a custom node to avoid connection limits." 2026-01-09. https://community.n8n.io/t/reusing-an-existing-imap-connection-in-a-custom-node-to-avoid-connection-limits/247619

[^138^]: Redis.io. "Understanding pub/sub in distributed systems." 2025-05-28. https://redis.io/glossary/pub-sub/

[^139^]: Ably. "Scaling Pub/Sub with WebSockets and Redis." 2024-12-19. https://ably.com/blog/scaling-pub-sub-with-websockets-and-redis

[^140^]: BalevDev. "Back to Fastify's Plugin System." 2024-04-19. https://balevdev.medium.com/back-to-fastifys-plugin-system

[^141^]: DragonflyDB. "3 Practical MongoDB Schema Examples (for 2024 & Beyond)." 2024-01-10. https://www.dragonflydb.io/databases/schema/mongodb

[^142^]: Firman Brilian. "Building Event-Driven Architectures with Redis Pub/Sub." 2025-09-03. https://medium.com/@firmanbrilian/building-event-driven-architectures-with-redis-pub-sub-d2b9ef64ea71

[^143^]: InfoQ. "Reactive Real-Time Notifications with SSE, Spring Boot, and Redis Pub/Sub." 2024-11-21. https://www.infoq.com/articles/reactive-notification-system-server-sent-events/

[^144^]: DbSchema. "MongoDB Schema Design Best Practices for 2026." 2025-10-16. https://dbschema.com/blog/mongodb/mongodb-schema-design-2026/

[^145^]: Scribd. "MongoDB Schema Design Best Practices PDF." https://www.scribd.com/document/920333478/23-MongoDb

[^146^]: WAYF Digital. "Fastify Development Agency." 2026-04-29. https://wayfdigital.com/technologies-tools/fastify/

[^147^]: Khushali Vasani. "Redis in Action: Designing Efficient Caching for High-Scale Systems." 2025-10-04. https://khushalivasani-ict19.medium.com/redis-in-action-designing-efficient-caching-for-high-scale-systems-f0b87d1f0214

[^148^]: PeerIslands. "MongoDB Schema Design: Guidelines." 2023-02-13. https://engineering.peerislands.io/mongodb-schema-design-aaecb48e0e4c

[^149^]: Fastify.io. "The hitchhiker's guide to plugins." https://fastify.io/docs/latest/Guides/Plugins-Guide/

[^150^]: Finny Collins. "7 MongoDB indexing strategies to speed up your queries." 2026-02-27. https://dev.to/finny_collins/7-mongodb-indexing-strategies-to-speed-up-your-queries-528b

[^151^]: Microsoft Azure. "Caching Guidance - Azure Architecture Center." 2026-03-25. https://learn.microsoft.com/en-us/azure/architecture/best-practices/caching

[^152^]: OneUptime. "How to Build Redis Caching Patterns." 2026-01-26. https://oneuptime.com/blog/post/2026-01-26-redis-caching-patterns/view

[^153^]: Velt. "Best Node.js WebSocket Libraries Compared." 2026-05-07. https://velt.dev/blog/best-nodejs-websocket-libraries

[^154^]: TSMX. "Field-level AES-GCM encryption for Mongoose with mongoose-aes-encryption-plugin." 2026-04-27. https://tsmx.net/field-level-aes-gcm-encryption-for-mongoose-with-mongoose-aes-encryption-plugin/

[^155^]: Grokipedia. "Comparison of WebSocket implementations." 2026-01-15. https://grokipedia.com/page/Comparison_of_WebSocket_implementations

[^156^]: Dev.to/ansman58. "Stopping API Abuse: Building a High-Performance Rate Limiter with Redis & Fastify." 2026-03-28. https://dev.to/ansman58/stopping-api-abuse-building-a-high-performance-rate-limiter-with-redis-fastify-44e5

[^157^]: Serverion. "Refresh Token Rotation: Best Practices for Developers." 2025-12-05. https://www.serverion.com/uncategorized/refresh-token-rotation-best-practices-for-developers/

[^158^]: Redis.io. "Build 5 Rate Limiters with Redis: Algorithm Comparison Guide." 2025-11-18. https://redis.io/tutorials/howtos/ratelimiting/

[^159^]: Dev.to/ajitforger97. "Building Refreshing JWT Tokens in Node.js." 2025-09-12. https://dev.to/ajitforger97/building-refreshing-jwt-tokens-in-nodejs-a-complete-guide-3g8g

[^160^]: JS Devlok. "Production-Ready JWT Authentication in Node.js with Access & Refresh Tokens (and Redis)." 2025-09-08. https://medium.com/js-devlok/production-ready-authentication-with-short-lived-jwts-and-long-lived-refresh-tokens-part-1-848dbeb7ba40

[^161^]: Reddit r/node. "WebSocket vs Ws vs Socket.io?" 2026-02-24. https://www.reddit.com/r/node/comments/18vx421/websocket_vs_ws_vs_socketio/

[^162^]: Ably. "Socket.IO vs WebSocket Performance Tradeoffs." https://ably.com/topic/socketio-vs-websocket

[^163^]: Jurnal Sinkron. "Comparative Performance Benchmarking of WebSocket." https://jurnal.polgan.ac.id/index.php/sinkron/article/download/15266/3537/25169

[^173^]: Tenbyte. "MinIO: Self-Hosted S3 Storage and 1-Click Installer." 2025-10-27. https://tenbyte.de/blog/minio-self-hosted-s3-storage-1-click-installer

[^174^]: Dev.to/alanwest. "How to Replace Cloud Object Storage With a Self-Hosted S3-Compatible Setup." 2026-04-18. https://dev.to/alanwest/how-to-replace-cloud-object-storage-with-a-self-hosted-s3-compatible-setup-mim

[^175^]: OneUptime. "How to Build a Session Store in Node.js with Redis." 2026-03-31. https://oneuptime.com/blog/post/2026-03-31-redis-how-to-build-a-session-store-in-nodejs-with-redis/view

[^176^]: Fenil Sonani. "Building a Session Management System with Redis and Node.js." 2024-03-15. https://fenilsonani.com/articles/database/building-a-session-management-system-with-redis-and-node-js

[^177^]: Lowcloud. "Best S3-Compatible Object Storage Providers (2026 Comparison)." 2026-04-10. https://lowcloud.io/en/blog/s3-compatible-object-storage

[^179^]: 45HomeLab (YouTube). "MinIO Is Done With Open Source, What Are Your Options?" 2026-05-12. https://www.youtube.com/watch?v=79IJqB2-BzA

[^183^]: Code-Garage. "Interagir avec une boîte mail en Node.js avec ImapFlow et MailParser." 2026-06-15. https://code-garage.com/blog/interagir-avec-une%20boite-mail-en-nodejs-avec-imapflow-et-mailparser

[^184^]: StackOverflow. "MongoDB / Mongoose Schema for Threaded Messages (Efficiently)." https://stackoverflow.com/questions/24903597/mongodb-mongoose-schema-for-threaded-messages-efficiently

[^187^]: Medium. "Getting Email Content Out of ImapFlow Using Node.js." 2024-08-24. https://medium.com/@python-javascript-php-html-css/retrieving-email-content-with-node-js-using-imapflow-b8444159dd80

[^188^]: MassiveGRID. "Self-Host MinIO on Ubuntu VPS." 2026-02-28. https://www.massivegrid.com/blog/self-host-minio-ubuntu-vps/

[^203^]: 1xAPI. "BullMQ 5 Background Jobs in Node.js (2026 Guide)." 2026-03-23. https://1xapi.com/blog/bullmq-5-background-job-queues-nodejs-2026-guide

[^204^]: Delbridge Solutions. "A Practical Guide to MongoDB Index Optimization." 2026-05-12. https://delbridge.solutions/guide-mongodb-index-optimization/

[^210^]: BullMQ.io. "Background Jobs and Message Queue for Node.js, Python, Elixir & more." https://bullmq.io/
