# Webmail 6.0 — Documento Funcional y Arquitectura Técnica

## 1. Resumen Ejecutivo

### 1.1 Propósito del Documento

Este documento constituye la especificación funcional y técnica completa para **Webmail 6.0**, un cliente de correo web moderno diseñado para reemplazar de forma transparente a Roundcube en entornos de hosting y auto-alojados. El documento integra investigación de mercado, arquitectura de sistema, modelos de datos, diseño de interfaz, estrategias de seguridad, planes de implementación paso a paso, testing y CI/CD — todo lo necesario para que un equipo de desarrollo o un agente swarm pueda construir el producto completo.

La audiencia principal son arquitectos de software, equipos de desarrollo full-stack, y agentes de IA encargados de implementar sistemas de email. El documento asume familiaridad con TypeScript, Vue.js, Node.js, MongoDB y protocolos de email (IMAP/SMTP), pero proporciona contexto suficiente para que equipos multidisciplinarios puedan alinearse sobre decisiones técnicas críticas.

### 1.2 Visión de Webmail 6.0

Webmail 6.0 nace de una constatación: los clientes de correo web open source existentes en 2026 son, en su mayoría, soluciones diseñadas hace más de una década con arquitecturas que no satisfacen las expectativas modernas de rendimiento, seguridad y experiencia de usuario. Roundcube, el líder indiscutible por número de despliegues (7.100+ estrellas en GitHub, miles de proveedores de hosting), acumuló 15+ CVEs solo en el primer semestre de 2026, incluyendo vulnerabilidades XSS explotadas activamente por grupos vinculados a estados-nación [^55^][^56^]. SnappyMail ofrece mejor rendimiento (99% Lighthouse) pero con un riesgo de mantenimiento crítico (bus factor de aproximadamente 1, gap de 8 meses sin commits) [^98^][^127^]. Ninguna solución existente combina una interfaz tipo Gmail, un stack TypeScript moderno, soporte dual IMAP/JMAP, calendario integrado y despliegue simple con Docker.

La filosofía arquitectónica de Webmail 6.0 se resume en tres principios:

**Headers primero, body bajo demanda.** El servidor IMAP sigue siendo la fuente de verdad. MongoDB actúa exclusivamente como caché de metadatos e índice de búsqueda local. Solo los headers se indexan en MongoDB; el cuerpo completo de los emails se recupera de IMAP solo cuando el usuario lo abre, se sanitiza con DOMPurify en el servidor, y se cachea en Redis por una hora. Esta estrategia reduce drásticamente el ancho de banda y permite que un inbox con decenas de miles de emails cargue en menos de un segundo.

**Seguridad como prioridad arquitectónica, no como parche.** La historia de vulnerabilidades de Roundcube demuestra que la sanitización HTML no puede ser un afterthought. Webmail 6.0 implementa una defensa en capas: DOMPurify server-side antes de cualquier renderizado, Content Security Policy estricto con nonces, sandboxed iframes para preview de HTML, encriptación AES-256-GCM de credenciales IMAP en reposo, y autenticación BFF con tokens de acceso de 15 minutos en memoria y refresh tokens en cookies HttpOnly [^44^][^69^].

**Dual protocolo: IMAP para compatibilidad, JMAP para el futuro.** IMAP sigue siendo el protocolo universalmente soportado, pero JMAP (RFC 8620) ofrece sincronización 3-5x más rápida, 80-90% menos ancho de banda y push nativo vía WebSocket [^31^]. Webmail 6.0 abstrae ambos protocolos bajo una API interna unificada, permitiendo que los usuarios con servidores modernos (Stalwart, Cyrus, Fastmail) se beneficien de JMAP mientras los usuarios con servidores tradicionales (Dovecot, Exchange, cPanel) continúan usando IMAP sin fricción.

### 1.3 Alcance y Fases

El desarrollo se organiza en tres fases secuenciales de aproximadamente 16 semanas en total:

**Fase 1 — MVP (Semanas 1-7):** Autenticación multi-cuenta IMAP/SMTP con JWT, sincronización de headers, inbox con vista de tres paneles tipo Gmail, compositor con auto-save de borradores cada 10 segundos, adjuntos con upload/descarga/preview (imágenes/PDF), HTML sanitizado con modo texto plano, contactos básicos, búsqueda local sobre MongoDB, calendario CalDAV con integración de invitaciones .ics, y stack Docker Compose funcional para desarrollo y producción.

**Fase 2 — Polish (Semanas 8-11):** Threading de conversaciones con algoritmo JWZ, búsqueda avanzada con MongoDB Atlas Search (fuzzy, autocomplete, filtros por fecha), keyboard shortcuts estilo Gmail, dark mode completo con Tailwind CSS, drag-and-drop de emails entre carpetas, firmas configurables por cuenta, y notificaciones push en tiempo real vía WebSocket.

**Fase 3 — Enterprise (Semanas 12-16):** Calendario CalDAV completo con RRULE, filtros/rules automáticos de email, soporte PGP/SMIME, panel de administración, métricas y monitoreo con Prometheus/Grafana, y soporte multi-lenguaje.

Fuera del alcance de la Fase 1: videollamadas, WebOS, sistema de plugins extensible, y PGP nativo (aunque la arquitectura debe permitir su adición en Fase 3 sin refactorización mayor).

El stack tecnológico seleccionado — Vue 3.4 + TypeScript 5 + Fastify 4 + MongoDB 7 + Redis 7 + imapflow — representa un equilibrio óptimo entre madurez, rendimiento y facilidad de despliegue. Fastify procesa ~14.460 req/s comparado con ~6.150 de Express [^130^]. imapflow es la única librería IMAP moderna y activamente mantenida para Node.js, con soporte nativo para TypeScript, CONDSTORE, QRESYNC, IDLE y OAuth2 [^1^]. MongoDB Atlas Search elimina la necesidad de un cluster Elasticsearch separado para el 90% de los casos de búsqueda [^132^].

El documento que sigue detalla cada una de estas decisiones con el rigor técnico necesario para que un agente swarm pueda ejecutar la implementación completa.
