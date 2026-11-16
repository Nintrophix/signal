import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Authenticated app bundle → dist/client/app (served only behind the auth gate).
export default defineConfig({
  root: resolve(__dirname, 'src/client/app'),
  base: '/',
  publicDir: false,
  build: {
    outDir: resolve(__dirname, 'dist/client/app'),
    emptyOutDir: true,
    assetsInlineLimit: 0, // strict CSP: no data: fonts/scripts
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: 'es2022',
  },
});
