# PWA — Diseño consolidado + Regresion Map (Fase 2)

**Estado:** `PENDING_IMPLEMENTATION` · Tipo: FEATURE

## Decisiones de diseño

1. **`vite-plugin-pwa`** (Workbox) — estándar del ecosistema Vite, genera SW + manifest + precache manifest con revisión por hash. Evita escribir Workbox a mano.
2. **`registerType: 'prompt'`** (SIN `skipWaiting`/`clientsClaim`): el SW nuevo **espera** y el usuario decide actualizar con un toast (`applyUpdate` → `updateSW(true)` manda `SKIP_WAITING`). Así un deploy NO recarga ni cambia el shell bajo una sesión abierta. `index.html` = `no-cache` y `BUILD_NUMBER` horneado siguen detectando bundles viejos. _(Rev. B/D HIGH: `autoUpdate`+`skipWaiting` se descartaron.)_
3. **Estrategia de cache (segura):**
   - **Precache:** SOLO app-shell estático (`**/*.{js,css,html,svg,png,ico,woff2}`) del build.
   - **`/api/*`: NetworkOnly explícito** (regla Workbox, GET) + **denylist en `navigateFallback`**. Nunca se cachea correo, adjuntos, tokens ni HTML autenticado.
   - `navigateFallback: /index.html` con `navigateFallbackDenylist: [/^\/api(?:\/|$|\?)/, /^\/metrics(?:\/|$|\?)/]` (cubre `/api` exacto y `/api?…`, rev. B).
4. **Offline controlado:** el shell precacheado abre; la app detecta offline con `useOnline` (`@vueuse/core`, ya dependencia) y muestra un **banner claro** ("El correo requiere conexión") que empuja el contenido vía `--pwa-top-inset`. No se simula lectura offline (no se usa `offline.html`: el shell precacheado ES la experiencia offline).
5. **Instalación:** composable `usePwa()` captura `beforeinstallprompt` (Android/desktop) → banner propio. En **iOS Safari** (no standalone) → hint "Agregar a pantalla de inicio". Sólo se ofrecen **online**. Descartables, con memoria en `localStorage` (flag booleano no sensible).
6. **Apple/meta:** `apple-touch-icon` (180), `apple-mobile-web-app-capable=yes`, `apple-mobile-web-app-title`, `apple-mobile-web-app-status-bar-style=default`, `theme-color`.
7. **Íconos:** generados desde `favicon.svg` con **Playwright/Chromium** (`scripts/gen-pwa-icons.mjs`; el renderer interno de ImageMagick no dibuja los strokes del SVG) → `pwa-192.png`, `pwa-512.png`, `pwa-maskable-512.png` (full-bleed azul, safe-zone), `apple-touch-icon-180.png`. Versionados en `public/icons/`.
8. **CSP/nginx:** SW + manifest same-origin ⇒ **no requiere cambios de CSP**. `manifest.webmanifest` sirve con `no-cache` (location /) — aceptable. `sw.js` en `no-cache` — correcto.

## Regresion Map

| Componente | Dependencia | Riesgo | Cómo validar |
| --- | --- | --- | --- |
| `vite.config.ts` | build | MEDIUM | `pnpm --filter @webmail6/web build` OK; `dist/` contiene `sw.js`, `manifest.webmanifest`, íconos. |
| `index.html` | arranque SPA | LOW | App monta; título white-label sigue pisando (brand.ts). |
| `main.ts` (registro SW) | bootstrap | MEDIUM | Login/restore/compliance intactos; SW registra sin romper el flujo async existente. |
| Router `/api` proxy | webmail/adjuntos | HIGH | SW NO intercepta `/api/*`; adjuntos/correo siempre a red; logout limpia. |
| nginx | serving | LOW | `/manifest.webmanifest` y `/sw.js` responden 200 con MIME correcto; `/assets/` sigue immutable. |
| Cache Storage | privacidad | HIGH | Tras usar la app: `caches` NO contiene respuestas `/api`; logout no deja correo cacheado. |
| Rutas admin/scheduling/meet/públicas | navegación | MEDIUM | Todas cargan igual instaladas y en browser. |

## Plan de fases (implementación)

- **F1:** deps + `vite.config.ts` (VitePWA: manifest + workbox strategy) + typings virtual module.
- **F2:** íconos (ImageMagick) + `index.html` meta Apple/theme.
- **F3:** registro SW + manejo de update en `main.ts`/composable.
- **F4:** UX: overlay offline (`useOnline`) + `usePwaInstall()` + banner + hint iOS + `offline.html`.
- **F5:** typecheck + build + verificación de `dist/` + estrategia de cache.
- **F6:** QA doc + checklist + Lighthouse.

## Rollback

- Backward compatible: sin SW, la app funciona igual (el registro es aditivo). Revert = `git revert` del branch; ningún dato migrado.
- **Kill-switch:** si un SW quedara "pegado", `self.registration.unregister()` + `caches.delete` — se documenta en QA. `autoUpdate` + `clientsClaim` minimizan SW zombi.

## Observabilidad

- `console.info` en `onNeedRefresh`/`onOfflineReady` (dev). El admin ya ve `BUILD_NUMBER`; el SW se alinea a ese bundle.
