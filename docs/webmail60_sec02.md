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
