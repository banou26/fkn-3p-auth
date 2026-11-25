import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: { semi: false, singleQuote: true },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    } as const,
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ['tests/**', '**/*.spec.ts', '**/*.test.ts'],
        rules: {
          'no-floating-promises': 'off',
          'no-unused-vars': 'off',
          'no-unused-expressions': 'off',
        } as const,
      },
    ],
  },
  build: {
    outDir: 'build',
    target: 'esnext',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: {
        index: 'src/index.ts',
        google: 'src/google.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: (id) => id === '@fkn/lib' || id.startsWith('@fkn/lib/'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        },
      },
    ],
  },
})
