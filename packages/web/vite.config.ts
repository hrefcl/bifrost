import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';

// `version` semántico desde el package.json raíz (Webmail 6.0). El `build` es el contador que GitHub
// Actions incrementa SOLO en cada corrida (GITHUB_RUN_NUMBER, pasado como BUILD_NUMBER por Docker) →
// cambia en CADA deploy, así el admin detecta si estás viendo un bundle viejo cacheado. `sha`/`time`
// trazan el commit/momento exacto. En dev local quedan 'dev'/'local'/ahora.
const rootPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
) as { version: string };
const BUILD_NUMBER = process.env.BUILD_NUMBER ?? process.env.GITHUB_RUN_NUMBER ?? 'dev';
const BUILD_SHA = (process.env.BUILD_SHA ?? process.env.GITHUB_SHA ?? 'local').slice(0, 7);
const BUILD_TIME = process.env.BUILD_TIME ?? new Date().toISOString();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
    __BUILD_NUMBER__: JSON.stringify(String(BUILD_NUMBER)),
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [
    vue(),
    // ── PWA (instalable en Android / iOS / desktop) ──────────────────────────────────────────────
    // Estrategia de cache SEGURA para un webmail: sólo se precachea el APP-SHELL estático (JS/CSS/
    // íconos/marca pública del build). `/api/*` (correos, adjuntos, tokens, HTML autenticado) es
    // NetworkOnly + está fuera del navigateFallback → NUNCA queda en Cache Storage. El access token
    // vive sólo en memoria (stores/auth.ts), así que no hay nada sensible que pueda filtrarse por cache.
    VitePWA({
      // `prompt`: NO se recarga solo (evita perder un correo a medio redactar en un deploy). El SW
      // nuevo espera y la app muestra un toast "Actualizar" (usePwa → onNeedRefresh). Como /api nunca
      // se cachea, un shell levemente viejo es inofensivo: el correo real siempre se pide a la red.
      registerType: 'prompt',
      // El registro lo hace `usePwa` (composable) con el virtual module, no la auto-inyección.
      injectRegister: false,
      // Íconos/otros assets de public/ a precachear que no vienen referenciados por el bundle.
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon-180.png'],
      manifest: {
        name: 'Bifrost Email',
        short_name: 'Bifrost',
        description: 'Correo propio de tu empresa: bandeja, calendario, contactos y reuniones.',
        lang: 'es',
        // Bifrost por defecto (marca base). El white-label del admin es runtime (theme.css / brand.ts);
        // el manifest es estático (build-time) → usa el acento base de Bifrost.
        theme_color: '#1b66ff',
        background_color: '#ffffff',
        display: 'standalone',
        // `any`: no forzamos portrait (la app es responsive y en tablet/desktop se usa landscape). (D-006)
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/pwa-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Sólo shell estático. NO se listan mapas de correo ni nada de /api.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // SPA: navegaciones caen al shell precacheado (permite abrir la app offline)…
        navigateFallback: '/index.html',
        // …pero JAMÁS para /api ni /metrics: esas navegaciones/redirects deben ir a la red real.
        // `(?:\/|$)` cubre también el path EXACTO `/api` y `/api?…`, no sólo `/api/…` (review B).
        navigateFallbackDenylist: [/^\/api(?:\/|$|\?)/i, /^\/metrics(?:\/|$|\?)/i],
        // Defensa explícita: los GET a /api son NetworkOnly (nunca se cachean). Workbox sólo cachea
        // GET por defecto, así que POST/PUT/DELETE ya van a la red igualmente — esta regla lo hace
        // explícito para lecturas (correo/adjuntos). (review D)
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname === '/api' || url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
            method: 'GET',
          },
        ],
        cleanupOutdatedCaches: true,
        // SIN `skipWaiting`/`clientsClaim`: con `registerType:'prompt'` la activación del SW nuevo la
        // decide el usuario tocando "Actualizar" (usePwa.applyUpdate → updateSW(true) manda SKIP_WAITING).
        // Así un deploy NO recarga ni cambia el shell bajo los pies de una sesión abierta (review B/D HIGH).
      },
      devOptions: {
        // El SW NO corre en `vite dev` (evita cache fantasma mientras se desarrolla). Se prueba con
        // `pnpm build && pnpm preview` o en el contenedor nginx.
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // El backend registra sus rutas bajo /api → forward sin reescritura
      // (alinea dev con prod/nginx, que también pasa /api intacto).
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
