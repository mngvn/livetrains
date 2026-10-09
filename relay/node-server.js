/**
 * livetrains aircraft relay, as a plain Node server.
 *
 * The same relay as planes-worker.js, for anywhere that runs Node: a free
 * web-service host, or a computer or Raspberry Pi at home (where nothing
 * counts requests at all, and a home connection is never mistaken for a
 * crowd of scrapers). No dependencies:
 *
 *   node relay/node-server.js            # listens on $PORT, or 8787
 *
 * Answers are gzipped when the browser accepts it, which takes each one from
 * about 15 KB to about 3 KB. Set ALLOWED_ORIGINS (e.g. https://mngvn.github.io)
 * to accept requests only from your own site.
 */
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import relay from './planes-worker.js';

const port = Number(process.env.PORT) || 8787;
const env = { ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? '' };

const server = http.createServer(async (req, res) => {
  try {
    const headers = req.headers.origin ? { origin: req.headers.origin } : {};
    const request = new Request(new URL(req.url ?? '/', 'http://relay.local'), { method: req.method, headers });
    const response = await relay.fetch(request, env);
    const out = Object.fromEntries(response.headers);
    let body = Buffer.from(await response.arrayBuffer());
    if (body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      body = gzipSync(body);
      out['content-encoding'] = 'gzip';
      out.vary = out.vary ? `${out.vary}, Accept-Encoding` : 'Accept-Encoding';
    }
    out['content-length'] = String(body.length);
    res.writeHead(response.status, out);
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('relay error');
    console.error(err);
  }
});

server.listen(port, () => console.log(`livetrains aircraft relay on port ${port}`));
