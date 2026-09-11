import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

/**
 * Server modules import each other with `.js` extensions, as Node ESM requires,
 * but only the `.ts` sources exist on disk. The web build shares those modules
 * verbatim — the GTFS parser, RAPTOR, the realtime decoders all run unchanged
 * in the browser — so map one extension to the other at resolve time rather
 * than maintaining a second copy of the code.
 */
const resolveTsFromJs = {
  name: 'resolve-ts-from-js',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
    const candidate = resolve(dirname(importer), source.replace(/\.js$/, '.ts'));
    return existsSync(candidate) ? candidate : null;
  },
};

export default defineConfig({
  // Pages serves the app from /<repo>/, so the base path is set by the build.
  base: process.env.VITE_BASE ?? '/',
  plugins: [resolveTsFromJs, react()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../server/src/shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // The shared server modules live outside this package's root.
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
    proxy: {
      // Dev server talks to the API server; in production one process serves both.
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:8080',
        changeOrigin: true,
        // Server-Sent Events must not be buffered by the proxy.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  worker: {
    // The transit engine worker must be a module worker so it can share the
    // same ES modules the app uses.
    format: 'es',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // MapLibre is by far the largest dependency and changes rarely. Giving
        // it its own chunk lets the browser cache it across app deploys, and
        // lets the sheet render while the map engine is still arriving.
        manualChunks: {
          maplibre: ['maplibre-gl'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
