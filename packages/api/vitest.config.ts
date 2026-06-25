import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    hookTimeout: 120000,
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      // Gate de calidad: el build de CI (test:coverage) falla si baja de estos umbrales.
      // Cobertura actual (con los excludes de abajo): ~87% stmts / 78% branch / 90% funcs.
      thresholds: { statements: 75, branches: 65, functions: 80, lines: 75 },
      exclude: ['test/**', 'src/index.ts', '**/*.config.ts', 'dist/**'],
    },
  },
});
