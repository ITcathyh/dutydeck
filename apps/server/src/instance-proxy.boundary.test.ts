import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { parsePeerInstances, registerInstanceProxy } from './instance-proxy.js';

const run = promisify(execFile);

const unsupportedUrls = ['https://127.0.0.1:443', 'ftp://127.0.0.1', 'file:///tmp/peer'];

it.each(unsupportedUrls)('rejects unsupported peer URL %s while parsing', url => {
  const peers = [{ id: 'peer', name: 'Peer', url }];
  expect(() => parsePeerInstances(JSON.stringify(peers))).toThrow();
});

it.each(unsupportedUrls)('rejects unsupported peer URL %s on direct registration', async url => {
  const peers = [{ id: 'peer', name: 'Peer', url }];
  const app = Fastify();
  try { await expect(registerInstanceProxy(app, peers, undefined)).rejects.toThrow(); }
  finally { await app.close(); }
});

it.each(['http', 'upgrade'])('contains synchronous %s upstream creation failure and remains healthy', async mode => {
  const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import { syncBuiltinESMExports } from 'node:module';
    import { connect } from 'node:net';
    import Fastify from ${JSON.stringify(new URL('../node_modules/fastify/fastify.js', import.meta.url).href)};
    import { registerInstanceProxy } from ${JSON.stringify(new URL('./instance-proxy.ts', import.meta.url).href)};

    const app = Fastify();
    app.get('/health', () => ({ ok: true }));
    await registerInstanceProxy(app, [{ id: 'peer', name: 'Peer', url: 'http://127.0.0.1:4311' }], undefined);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.server.address().port;
    const originalRequest = http.request;
    http.request = () => { throw new Error('upstream creation failed'); };
    syncBuiltinESMExports();
    let client;
    try {
      if (${JSON.stringify(mode)} === 'http') {
        const response = await fetch('http://127.0.0.1:' + port + '/api/instances/peer/sessions', { signal: AbortSignal.timeout(1_000) });
        assert.equal(response.status, 500);
        assert.match(await response.text(), /upstream creation failed/);
      } else {
        client = connect(port, '127.0.0.1');
        await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
        const response = new Promise((resolve, reject) => {
          let text = '';
          client.on('data', chunk => { text += chunk; });
          client.once('end', () => resolve(text));
          client.once('error', reject);
        });
        client.write([
          'GET /api/instances/peer/terminal/s1 HTTP/1.1', 'Host: localhost',
          'Upgrade: websocket', 'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', '',
        ].join('\\r\\n'));
        assert.ok((await response).startsWith('HTTP/1.1 502 Bad Gateway'));
      }
    } finally {
      http.request = originalRequest;
      syncBuiltinESMExports();
      client?.destroy();
    }
    const health = await fetch('http://127.0.0.1:' + port + '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    await app.close();
    console.log('contained failure, healthy server, clean shutdown');
  `], { timeout: 10_000 });
  expect(stdout.trim()).toBe('contained failure, healthy server, clean shutdown');
});
