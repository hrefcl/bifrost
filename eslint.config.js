import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  ...vue.configs['flat/recommended'],
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vue.parser,
      parserOptions: {
        parser: tseslint.parser,
        projectService: true,
        extraFileExtensions: ['.vue'],
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Tests, e2e harness y archivos de config viven FUERA del tsconfig de cada paquete
  // (excluidos de `include`), así que el project service type-aware no los encuentra.
  // Para ellos desactivamos las reglas con tipos: igual reciben las reglas sintácticas +
  // formateo (prettier en lint-staged), pero sin requerir estar en un tsconfig. El lint
  // type-checked estricto se mantiene en `src` (código de producción).
  {
    files: [
      '**/*.test.ts',
      '**/__tests__/**/*.ts',
      '**/test/**/*.ts',
      '**/e2e/**/*.ts',
      '**/demo/**/*.ts',
      '**/scripts/**/*.{js,cjs,mjs}',
      '**/*.config.{js,cjs,mjs,ts,mts,cts}',
      'eslint.config.js',
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Ergonomía de test/mocks: clases fake con métodos/constructores vacíos y aserciones
    // sobre datos de fixture conocidos. El formateo (prettier) se sigue aplicando igual.
    files: ['**/*.test.ts', '**/__tests__/**/*.ts', '**/test/**/*.ts', '**/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-useless-constructor': 'off',
      '@typescript-eslint/array-type': 'off',
    },
  },
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'maqueta/**'],
  }
);
