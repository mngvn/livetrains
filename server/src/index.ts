import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { loadConfig } from './config.js';
import { log } from './log.js';
import { registerApi } from './routes/api.js';
import { TransitService } from './service.js';

/**
 * Headers every response carries.
 *
 * The page's own Content-Security-Policy travels in index.html, so the
 * static GitHub Pages build has one too; these are the parts only a server
 * can send. `frame-ancestors` keeps the app out of other sites' frames, where
 * a transparent overlay could steer taps meant for something else.
 */
function applySecurityHeaders(reply: { header: (name: string, value: string) => unknown }): void {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'strict-origin-when-cross-origin');
  reply.header('content-security-policy', "frame-ancestors 'self'");
  reply.header('x-frame-options', 'SAMEORIGIN');
  // Location is the only powerful feature the app uses, and only on itself.
  reply.header('permissions-policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=()');
}

async function main(): Promise<void> {
  const config = loadConfig();
  const service = new TransitService(config);

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'warn' },
    // Behind a proxy the client's real address is what rate limiting keys on,
    // so whose forwarded address to believe is the operator's call — and
    // nobody's by default. See `trustProxy` in config.ts.
    // A hop count is spelled as a function for Fastify's types; proxy-addr
    // reads the number the same way.
    trustProxy:
      typeof config.trustProxy === 'number'
        ? ((hops: number) => (_address: string, hop: number) => hop < hops)(config.trustProxy)
        : config.trustProxy,
    // The API only answers GETs; nothing it accepts has a body worth more.
    bodyLimit: 16 * 1024,
    // Live vehicle streams never go idle, so on shutdown they are cut rather
    // than waited on.
    forceCloseConnections: true,
  });

  // The API is public, read-only and cookie-free, so any origin may read it
  // unless the operator narrows it with CORS_ORIGINS.
  await app.register(cors, {
    origin: config.corsOrigins ?? true,
    methods: ['GET', 'HEAD', 'OPTIONS'],
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    applySecurityHeaders(reply);
    return payload;
  });
  await registerApi(app, service);

  if (config.serveStatic) {
    // Resolve relative to this module rather than the working directory: the
    // server gets started from the repo root, from server/, and from dist/ in
    // production, and cwd differs in each.
    const here = dirname(fileURLToPath(import.meta.url));
    const webRoot = [
      process.env.WEB_DIST,
      join(here, '..', '..', 'web', 'dist'),
      join(here, '..', '..', '..', 'web', 'dist'),
    ]
      .filter((candidate): candidate is string => Boolean(candidate))
      .map((candidate) => resolve(candidate))
      .find((candidate) => existsSync(candidate));

    if (webRoot) {
      await app.register(fastifyStatic, { root: webRoot });
      // The client is a single-page app: any non-API path is a client route and
      // must be served the app shell rather than a 404.
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith('/api/')) {
          return reply.status(404).send({ error: 'Not found' });
        }
        return reply.sendFile('index.html');
      });
      log.info(`server: serving web client from ${webRoot}`);
    } else {
      log.warn('server: SERVE_STATIC is on but no built web client was found — run "npm run build" first');
    }
  }

  // Start listening before the feed finishes loading so health checks and the
  // client shell come up immediately; API calls return 503 until it is ready.
  await app.listen({ port: config.port, host: config.host });
  log.info(`server: listening on http://${config.host}:${config.port}`);
  log.info(`server: agency "${config.agency.id}"${config.mock ? ' (mock mode)' : ''}`);

  try {
    await service.start();
    log.info('server: feed loaded and ready');
  } catch (err) {
    log.error('server: failed to load the transit feed', err);
    log.error(
      'server: the API will keep returning 503 until a feed loads. ' +
        'Set LIVETRAINS_MOCK=1 to run against the built-in demo feed instead.',
    );
  }

  const shutdown = (signal: string) => {
    log.info(`server: ${signal} received, shutting down`);
    service.stop();
    void app.close().then(() => process.exit(0));
    // Don't let a hung connection block exit indefinitely.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log.error('server: fatal startup error', err);
  process.exit(1);
});
