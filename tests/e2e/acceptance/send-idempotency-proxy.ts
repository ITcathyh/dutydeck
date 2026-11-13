import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export type SendExchange = {
  request: Record<string, unknown>;
  responseStatus: number;
  responseBody: any;
  dropped: boolean;
};

/** Buffer only send responses; all other responses (including SSE) stream normally. */
export async function startAcceptedResponseLossProxy(targetPort: number) {
  const exchanges: SendExchange[] = [];
  const sockets = new Set<net.Socket>();
  let dropNextSend = true;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('error', () => response.destroy());
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = request.url ?? '/';
      const isSend = request.method === 'POST' && /^\/api\/sessions\/[^/]+\/send(?:\?.*)?$/.test(path);
      let parsedRequest: Record<string, unknown> | undefined;
      if (isSend) {
        try { parsedRequest = JSON.parse(body.toString('utf8')) as Record<string, unknown>; }
        catch { request.socket.destroy(); return; }
      }
      const shouldDrop = isSend && dropNextSend;
      if (shouldDrop) dropNextSend = false;
      const upstream = http.request({
        hostname: '127.0.0.1',
        port: targetPort,
        path,
        method: request.method,
        headers: request.headers
      }, upstreamResponse => {
        const headers = { ...upstreamResponse.headers };
        delete headers.connection;
        delete headers['keep-alive'];
        if (!isSend) {
          response.writeHead(upstreamResponse.statusCode ?? 502, headers);
          upstreamResponse.pipe(response);
          return;
        }
        const responseChunks: Buffer[] = [];
        upstreamResponse.on('data', chunk => responseChunks.push(Buffer.from(chunk)));
        upstreamResponse.on('end', () => {
          const responseBody = Buffer.concat(responseChunks);
          let parsedResponse: any;
          try { parsedResponse = JSON.parse(responseBody.toString('utf8')); } catch {}
          const exchange: SendExchange = {
            request: parsedRequest!,
            responseStatus: upstreamResponse.statusCode ?? 502,
            responseBody: parsedResponse,
            dropped: false
          };
          exchanges.push(exchange);
          if (shouldDrop && exchange.responseStatus === 202 && parsedResponse?.accepted === true && parsedResponse.task?.id) {
            exchange.dropped = true;
            // Once response bytes arrive Chromium does not transparently replay POST. A truncated JSON body
            // still leaves the Web mutation outcome unknown, while a bare TCP reset can trigger a network retry.
            response.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'transfer-encoding': 'chunked' });
            response.write('{', () => response.socket?.destroy());
            upstreamResponse.destroy();
            return;
          }
          delete headers['transfer-encoding'];
          response.writeHead(exchange.responseStatus, headers);
          response.end(responseBody);
        });
      });
      upstream.on('error', () => {
        if (response.destroyed) return;
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'TEST_PROXY_UPSTREAM_ERROR' } }));
      });
      response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    exchanges,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}
