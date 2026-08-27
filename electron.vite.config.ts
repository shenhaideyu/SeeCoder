import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve(projectRoot, 'apps/desktop/src/main/main.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve(projectRoot, 'apps/desktop/src/preload/preload.ts') } },
  },
  renderer: {
    root: resolve(projectRoot, 'apps/desktop/src/renderer'),
    plugins: [react()],
    build: { rollupOptions: { input: resolve(projectRoot, 'apps/desktop/src/renderer/index.html') } },
  },
});
