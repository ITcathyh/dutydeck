// Minimal loopback HTTP receiver. Dutydeck's event-pipeline POSTs the wrapped
// im.message.receive_v1 event here and requires a continue/stop receipt within
// its shared 2s deadline. We only do authenticated parse + one durable inbox
// transaction before responding; all downstream work is on the worker.

import { createServer } from 'node:http';
import { receiveEnvelope } from './handler.mjs';

export function createEventServer(deps) {
  // Response-completion promises, so shutdown can wait for every accepted
  // request to finish its durable inbox write and receipt before closing.
  const inflight = new Set();
  const server = createServer((req, res) => {
    // During shutdown the listening socket stays bound to keep exclusive ownership
    // of the fixed port, but new business is refused with an explicit retryable
    // verdict: Dutydeck/Feishu redelivers and the durable inbox collapses repeats.
    if (deps.stopping) {
      if (!res.headersSent) {
        res.writeHead(503, {
          'content-type': 'application/json',
          'retry-after': '1',
          connection: 'close',
        });
        res.end(JSON.stringify({ error: { code: 'shutting_down', retryable: true } }));
      } else {
        res.destroy();
      }
      return;
    }

    const finished = new Promise((resolve) => {
      res.once('finish', resolve);
      res.once('close', resolve);
    });
    inflight.add(finished);
    void finished.finally(() => inflight.delete(finished));

    void route(req, res, deps).catch((error) => {
      // Never leak secrets; log id-less message to stderr.
      process.stderr.write(`[rovetap-jobs] http error: ${error?.message ?? error}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'internal', message: 'handler failure' } }));
      } else {
        res.destroy();
      }
    });
  });
  server.drainInflight = () => Promise.allSettled(inflight);
  return server;
}

async function route(req, res, deps) {
  // The winner of the exclusive bind initializes the store and recovers
  // in-flight work after listen(); hold requests until that completes so
  // business never runs against half-ready dependencies.
  if (deps.ready) await deps.ready;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, plugin: 'rovetap-jobs' }));
    return;
  }

  if (req.method !== 'POST' || url.pathname !== deps.config.listen.path) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found' } }));
    return;
  }

  const body = await readJsonBody(req, deps.config.httpMaxBodyBytes);
  if (body === undefined) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'bad_json' } }));
    return;
  }
  if (body && body.__tooLarge) {
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'body_too_large' } }));
    return;
  }

  const result = await receiveEnvelope(
    { body, authorization: req.headers.authorization ?? '' },
    deps,
  );
  res.writeHead(result.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result.body));
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        req.destroy();
        resolve({ __tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve(undefined); }
    });
    req.on('error', () => resolve(undefined));
  });
}

/**
 * Start listening and persist a discovery file `service.json` with the actual
 * port (important when listen.port is 0 in isolated e2e).
 */
export function listenWithDiscovery(server, { host, port, handlerPath = '/lark/events' }, discoveryFile, writeJsonAtomic) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, async () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      if (discoveryFile && writeJsonAtomic) {
        await writeJsonAtomic(discoveryFile, {
          host, port: actualPort, path: handlerPath, pid: process.pid,
        }).catch(() => {});
      }
      resolve({ host, port: actualPort, path: handlerPath });
    });
  });
}
