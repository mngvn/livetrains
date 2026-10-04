// TEMPORARY: runs the Cloudflare Worker relay under plain Node for the live
// check, so the static build reads real aircraft through the real relay code.
import http from 'node:http';
import worker from '../relay/planes-worker.js';

http
  .createServer(async (req, res) => {
    const headers = req.headers.origin ? { origin: req.headers.origin } : {};
    const response = await worker.fetch(new Request(`http://127.0.0.1:8787${req.url}`, { method: req.method, headers }), {}, { waitUntil() {} });
    console.log(new Date().toISOString().slice(11, 19), req.method, req.url, response.status);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  })
  .listen(8787, '127.0.0.1');
