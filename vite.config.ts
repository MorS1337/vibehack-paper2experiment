import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
