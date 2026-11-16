import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Public login bundle → dist/client/login, served at /_l/. Contains no app code.
export default defineConfig({
  root: resolve(__dirname, 'src/client/login'),
  base: '/_l/',
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist/client/login'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: 'es2022',
  },
});
