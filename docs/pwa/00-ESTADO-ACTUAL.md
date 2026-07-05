# PWA — Estado actual del proyecto (Fase 1, antes de modificar)

**Fecha:** 2026-07-05 · **Worktree:** `feat/pwa-installable` · **Equipo A:** Claude Code
**Tipo de cambio:** FEATURE (frontend + build + nginx headers) · **Estado:** `IN_ANALYSIS`

## 1. Soporte PWA existente

**CONFIRMADO: cero soporte PWA.** `grep -riE 'manifest|service.?worker|workbox|vite-plugin-pwa|registerSW|apple-touch|standalone'` sobre `packages/web` (excluyendo `node_modules`) no devuelve nada.

- No hay `manifest.webmanifest`.
- No hay service worker ni registro de SW.
- `index.html` solo declara `<link rel="icon" ...favicon.svg>` + viewport. Sin meta Apple, sin theme-color.
- `public/` solo tiene `favicon.svg` (marca Bifrost) y `sig-icons/` (íconos de firmas).
- `vite.config.ts` usa solo `@vitejs/plugin-vue`. Sin plugin PWA.

## 2. Arquitectura relevante (CONFIRMADO)

| Componente | Detalle | Implicancia para PWA |
| --- | --- | --- |
| Frontend | Vue 3.5 + Vite 6 + Pinia + vue-router (`createWebHistory`) | SPA; SW con `navigateFallback` a `index.html`. |
| Build | `vue-tsc --noEmit && vite build` (Dockerfile.web) | El plugin PWA debe pasar typecheck (typings del virtual module). |
| Serving prod | nginx 1.27 sirve `dist/`; `try_files $uri $uri/ /index.html` | `/sw.js`, `/manifest.webmanifest`, `/pwa-*.png` se sirven como archivo real (no fallback SPA) si existen en `dist/`. |
| Cache headers | `/assets/` → `max-age=31536000, immutable`; `location /` (incl. `index.html`) → `no-cache, must-revalidate` | `sw.js` y `manifest` caen en `location /` → `no-cache` = correcto para el SW. |
| CSP | `default-src 'self'; script-src 'self'; ...; connect-src 'self'${MEET_CSP_CONNECT}` | **No hay `worker-src` ni `manifest-src`** → hacen fallback a `script-src`/`default-src` = `'self'`. SW + manifest **same-origin** ⇒ permitidos **sin tocar la CSP**. |

## 3. Seguridad de sesión (CONFIRMADO — clave para la estrategia de cache)

- **El access token vive SOLO en memoria** (`stores/auth.ts`: "Token SÓLO en memoria (no localStorage)"). Nada sensible en `localStorage`/`sessionStorage`.
- La sesión se restaura tras reload vía **cookie httpOnly de refresh** (`/auth/refresh`). Funciona igual en PWA standalone (mismo origen).
- `logout()` → `POST /auth/logout` (invalida cookie server-side) + `clearSession()` (borra token/usuario de memoria).
- Correos, adjuntos y datos privados se sirven por **`/api/*`** (adjuntos: `/api/attachments`). El proxy nginx `location /api` va al backend.

**Conclusión de seguridad:** basta con **precachear solo el app-shell estático** (JS/CSS/íconos/marca pública) y **nunca** runtime-cachear `/api/*`. Como el token no está en storage y `/api` no se cachea, no queda información privada en `Cache Storage`.

## 4. Rutas que NO se deben romper (CONFIRMADO — `router/index.ts`)

`/login`, `/` (inbox), `/settings`, `/contacts`, `/calendar`, `/scheduling`, `/meet`, `/admin`, `/compliance/accept`, y públicas `guestOk`: `/u/:userSlug`, `/meet/:slug`, `/u/:userSlug/:eventSlug`, `/booking/:token`. Guard `beforeEach` con `public`/`guestOk`/`requiresAdmin`/compliance.

El `navigateFallback` del SW debe **excluir `/api/`** para no interceptar el proxy del backend.

## 5. Branding

Accent default `#1b66ff` (azul Bifrost, `config/brand.ts`). Marca white-label pisada en runtime por `/api/branding`, pero **el manifest es estático** (build-time) → usa el default de Bifrost para `theme_color` y los íconos base. Fondo `#ffffff`.

## 6. Herramientas disponibles

ImageMagick (`convert`/`magick`) presente → íconos PNG se generan desde `favicon.svg`. No hay `sharp`/`rsvg` → no se depende de generador en build.

---

Este documento es la base de la Fase 2 (documento consolidado + regresion map) y la Fase 3 (implementación).
