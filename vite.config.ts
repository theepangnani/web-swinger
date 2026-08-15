import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so `npm run build` output can also be opened from a plain
  // static file server (or a subdirectory) without rewriting asset paths.
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
