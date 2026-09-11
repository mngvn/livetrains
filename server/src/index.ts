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

async function main(): Promise<void> {
  const config = loadConfig();
  const service = new TransitService(config);

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'warn' },
    // Behind a proxy the client's real address matters for rate limiting and
    // for building absolute URLs in logs.
    trustProxy: true,
  });

  await app.register(cors, { origin: true });
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
