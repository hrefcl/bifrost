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
