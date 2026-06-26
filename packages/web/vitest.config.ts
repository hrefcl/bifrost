import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  // Alias `@` → src: sin esto, los tests no podían importar stores/utilidades que usan
  // `@/...` (fallaban al resolver el módulo). Habilita testear código real del frontend.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    globals: true,
    environment: 'node',
    exclude: ['node_modules', 'dist', 'e2e'],
  },
});
