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
    /**
     * Off, and this is the single most important line in this file.
     *
     * With it on, `dist/` carried a 3.4 MB `.map` beside the bundle holding
     * every one of the 48 source files with `sourcesContent` — the complete,
     * commented TypeScript. Anyone who could load the page could download the
     * whole project. Minified output can still be read by a determined person;
     * a source map does not need a determined person.
     *
     * Set to 'hidden' if you need maps for your own error reporting: it emits
     * the file but no `//# sourceMappingURL` comment, so browsers do not fetch
     * it — and then do not deploy the .map.
     */
    sourcemap: false,
  },
});
