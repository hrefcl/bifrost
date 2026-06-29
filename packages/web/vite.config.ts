import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
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
  plugins: [vue()],
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
