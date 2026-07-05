# PWA de Bifrost Email — Documentación técnica

**Rama:** `feat/pwa-installable` · **Tipo:** FEATURE (frontend + build)

## Qué se implementó

Bifrost Email es ahora una **Progressive Web App instalable** en Android, iOS y escritorio, sin app nativa.

- **`vite-plugin-pwa`** (Workbox) genera el service worker y el `manifest.webmanifest` en el build.
- **Manifest** (`vite.config.ts`): `name` "Bifrost Email", `short_name` "Bifrost", `display: standalone`, `orientation: any`, `theme_color: #1b66ff`, `background_color: #ffffff`, `start_url/scope: /`, íconos 192/512/maskable, `lang: es`.
- **Íconos** (`public/icons/`): `pwa-192.png`, `pwa-512.png`, `pwa-maskable-512.png` (full-bleed, safe-zone), `apple-touch-icon-180.png`. Generados desde `public/favicon.svg` con `scripts/gen-pwa-icons.mjs` (Playmwright/Chromium — reproducible).
- **Soporte Apple** (`index.html`): `apple-touch-icon`, `apple-mobile-web-app-capable=yes`, `mobile-web-app-capable=yes`, `apple-mobile-web-app-title=Bifrost`, `apple-mobile-web-app-status-bar-style=default`, `theme-color`, `viewport-fit=cover`.
- **Service worker** (`registerType: 'prompt'`): registrado por `initPwa()` en `main.ts` (antes de montar, para no perder `beforeinstallprompt`). El composable `usePwa.ts` es un singleton reactivo.
- **UX** (`components/PwaUi.vue`, montado en `App.vue`): banner offline, toast "actualizar", banner de instalación (Android/desktop) y hint de iOS ("Agregar a pantalla de inicio"). Textos por i18n (`es`/`en`). Los CTA de instalación NO aparecen en páginas públicas de invitado (`guestOk`).

## Qué se cachea (Cache Storage)

**Sólo el app-shell estático** (precache Workbox, `globPatterns: **/*.{js,css,html,svg,png,ico,woff2}`):

- `index.html`, los bundles JS/CSS **hasheados**, `favicon.svg`, los íconos PWA y los `sig-icons/` (branding público de firmas).

## Qué NO se cachea (nunca en Cache Storage)

- **Todo `/api/*`**: correos, adjuntos (`/api/attachments`), `/auth/*`, `/branding`, y cualquier HTML/JSON autenticado. Regla Workbox **`NetworkOnly`** + `navigateFallbackDenylist: [/^\/api\//, /^\/metrics/]`.
- **Tokens**: el access token vive **sólo en memoria** (`stores/auth.ts`); nunca toca `localStorage`, `sessionStorage` ni cache. La sesión se restaura por la cookie **httpOnly** de refresh.

Consecuencia: aunque el dispositivo sea compartido, en `Cache Storage` no queda ningún dato privado de correo. Un `logout` no necesita purgar cache porque no hay nada privado cacheado (sólo el shell público). El token se borra de memoria y la cookie httpOnly la invalida el backend.

## Actualización de versión

`registerType: 'prompt'`: cuando hay un deploy nuevo, el SW nuevo **espera** y la app muestra un toast **"Actualizar"** (no recarga sola → no se pierde un correo a medio redactar). Como `/api` es NetworkOnly, un shell levemente viejo es inofensivo: el correo real siempre se pide a la red. `index.html` se sirve `no-cache` (nginx) y el precache se revisiona por hash.

## Offline (etapa 1)

Con el shell precacheado, la app **abre** sin conexión; un banner claro indica **"Sin conexión — el correo requiere conexión a internet"** (`useOnline` de `@vueuse/core`). **No** se simula lectura offline de correos (fuera de alcance de esta etapa).

## nginx / CSP

**No requiere cambios.** La CSP (`default-src 'self'`) no declara `worker-src`/`manifest-src` → hacen fallback a `'self'`; el SW y el manifest son **same-origin** ⇒ permitidos. `sw.js` y `manifest.webmanifest` caen en `location /` → `no-cache` (correcto para un SW). Los `/assets/` hasheados siguen `immutable`.

## Cómo probar la instalación

1. **Local:** `pnpm --filter @webmail6/shared build && pnpm --filter @webmail6/web build && pnpm --filter @webmail6/web preview` → abrir la URL.
2. **Chrome Android:** menú ⋮ → "Instalar aplicación" (o el banner propio).
3. **Chrome/Edge desktop:** ícono de instalar en la barra de direcciones.
4. **iOS Safari:** Compartir → "Agregar a pantalla de inicio" (seguir el hint in-app).
5. **Lighthouse:** DevTools → Lighthouse → categoría *Progressive Web App* / *Installable*.
6. **Regenerar íconos** (si cambia la marca base): `node packages/web/scripts/gen-pwa-icons.mjs`.

## Limitaciones conocidas

- **Sin lectura offline de correo** (por diseño, etapa 1). Offline sólo abre el shell + aviso.
- **iOS**: Safari no tiene prompt automático de instalación → se guía manualmente. Almacenamiento de iOS puede evictar datos tras ~7 días de no uso (limitación de WebKit): si la cookie de refresh se evicta, el usuario deberá reloguear. La cookie httpOnly la controla el backend (fuera del alcance de la PWA).
- **White-label de la PWA (build-time):** el manifest (`name`, `short_name`, `theme_color`) y las metas Apple honran `VITE_BRAND_NAME`/`VITE_BRAND_ACCENT` — la PWA instalada usa la marca del tenant. Los **íconos** son binarios pre-generados (marca base Bifrost); un tenant regenera los suyos con `node scripts/gen-pwa-icons.mjs` tras reemplazar `public/favicon.svg`. El white-label **runtime** del admin (`/api/branding`) no afecta al manifest (es estático por diseño; el shell/CSS sí lo aplican).
- **Recarga de actualización**: el usuario debe tocar "Actualizar" (o recargar) para tomar el shell nuevo; el correo real nunca queda viejo (no se cachea `/api`). No hay chequeo periódico de actualización dentro de una sesión SPA larga (se detecta al recargar; `index.html` es `no-cache`).
- **Sin kill-switch remoto del SW**: para forzar la baja del SW en todos los clientes (incidente), desplegar un `sw.js` que se auto-desregistre o instruir `caches` + `unregister` (ver QA). El diseño `prompt` sin `clientsClaim` evita SW zombies bajo sesión abierta.

## Archivos

| Archivo | Rol |
| --- | --- |
| `packages/web/vite.config.ts` | Config `VitePWA` (manifest + estrategia Workbox). |
| `packages/web/index.html` | Meta Apple/theme-color/viewport-fit. |
| `packages/web/src/main.ts` | `initPwa()` temprano. |
| `packages/web/src/composables/usePwa.ts` | Estado PWA (install/update/online), listeners, registro SW. |
| `packages/web/src/components/PwaUi.vue` | UI offline/update/install/iOS. |
| `packages/web/src/App.vue` | Monta `PwaUi`. |
| `packages/web/src/i18n/locales/{es,en}.ts` | Textos `pwa.*`. |
| `packages/web/src/lib/icons.ts` | Íconos `wifiSlash`, `share`. |
| `packages/web/public/icons/*` | Íconos PWA. |
| `packages/web/scripts/gen-pwa-icons.mjs` | Generador de íconos. |
| `packages/web/scripts/pwa-smoke.mjs`, `pwa-offline.mjs` | Pruebas Playwright (SW/manifest/offline). |
