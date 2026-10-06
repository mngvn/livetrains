import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
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

/**
 * A Content-Security-Policy for the built page, written into index.html.
 *
 * GitHub Pages cannot send response headers, so the policy travels in a
 * `<meta>` tag, which every browser honours for everything but framing. It
 * is what stands between a bug that lets someone else's text be treated as
 * markup — an alert, a stop name, a credit line — and that text running as
 * code: scripts may only come from this site, plus the one inline script in
 * index.html, allowed by the hash of its exact contents.
 *
 * Network access stays broad on purpose (`https:` for fetches and images):
 * the feeds, tiles, walking router, aircraft relay and API server are all
 * configurable at build time or, for debugging, from the console, and
 * pinning them here would silently break every one of those switches.
 * Plain http is allowed only for a local server, and for any http address
 * the build itself was pointed at.
 *
 * Builds only: the dev server injects inline scripts of its own.
 */
function contentSecurityPolicy(): Plugin {
  const httpOrigins = new Set<string>(['http://localhost:*', 'http://127.0.0.1:*']);
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITE_') || !value) continue;
    for (const match of value.matchAll(/http:\/\/[^/\s,{}]+/g)) httpOrigins.add(match[0]);
  }
  return {
    name: 'livetrains-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
          (match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`,
        );
        const policy = [
          "default-src 'self'",
          `script-src 'self' ${inline.join(' ')}`.trim(),
          // MapLibre falls back to a blob: worker when its worker is cross-origin.
          "worker-src 'self' blob:",
          "child-src 'self' blob:",
          `connect-src 'self' https: ${[...httpOrigins].join(' ')}`,
          // Map tiles, the aerial imagery, aircraft photos; data: for icons in CSS.
          "img-src 'self' data: blob: https:",
          "style-src 'self'",
          "font-src 'self' data:",
          "manifest-src 'self'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; ');
        return html.replace(
          /(<meta charset="UTF-8" \/>)/,
          `$1\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
        );
      },
    },
  };
}

export default defineConfig({
  // Pages serves the app from /<repo>/, so the base path is set by the build.
  base: process.env.VITE_BASE ?? '/',
  plugins: [resolveTsFromJs, react(), contentSecurityPolicy()],
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
    rolldownOptions: {
      output: {
        // MapLibre is by far the largest dependency and changes rarely. Giving
        // it its own chunk lets the browser cache it across app deploys, and
        // lets the sheet render while the map engine is still arriving.
        // Rolldown has no object form of `manualChunks`; these groups are
        // its equivalent. They match script modules only, so styles stay in
        // one stylesheet and the `?worker&url` import of MapLibre's worker
        // stays with the code that imports it.
        codeSplitting: {
          groups: [
            { name: 'maplibre', test: /[\\/]node_modules[\\/]maplibre-gl[\\/][^?]*\.m?js$/ },
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/][^?]*\.js$/ },
          ],
        },
      },
    },
  },
});
