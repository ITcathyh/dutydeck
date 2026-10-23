import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);

it.each(['authorization', 'lookup'])('survives a TCP reset during terminal %s without leaking a stream', async phase => {
  // A child process proves an unhandled raw socket error cannot kill the daemon.
  const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { connect } from 'node:net';
    import { setImmediate } from 'node:timers/promises';
    import Fastify from ${JSON.stringify(new URL('../../node_modules/fastify/fastify.js', import.meta.url).href)};
    import { registerTerminalRoutes } from ${JSON.stringify(new URL('./terminal-ws.ts', import.meta.url).href)};

    const phase = ${JSON.stringify(phase)};
    let release, entered, socketClosed;
    const gate = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { entered = resolve; });
    const disconnected = new Promise(resolve => { socketClosed = resolve; });
    let lookups = 0, disposed = 0, subscriptions = 0;
    const app = Fastify();
    registerTerminalRoutes(app, {
      authorize: async (_request, _session, action) => {
        if (phase === 'authorization') { entered(); await gate; }
        return { allowed: true, action, code: 'allowed_owner', reason: 'test', source: 'owner' };
      },
      provider: { lookupTerminalStream: async () => {
        lookups++;
        if (phase === 'lookup') { entered(); await gate; }
        return { status: 'ready', handle: {
          stream: { onData() { subscriptions++; }, write() {}, resize() {}, dispose() { disposed++; } },
          onExit() { subscriptions++; },
        } };
      } },
    });
    app.server.on('upgrade', (_request, socket) => socket.once('close', socketClosed));
    await app.listen({ host: '127.0.0.1', port: 0 });
    const client = connect(app.server.address().port, '127.0.0.1');
    await new Promise(resolve => client.once('connect', resolve));
    client.write([
      'GET /api/terminal/session HTTP/1.1', 'Host: localhost',
      'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', '',
    ].join('\\r\\n'));
    await reached;
    client.resetAndDestroy();
    await disconnected;
    release();
    await setImmediate();
    assert.equal(lookups, phase === 'lookup' ? 1 : 0);
    assert.equal(disposed, phase === 'lookup' ? 1 : 0);
    assert.equal(subscriptions, 0);
    await app.close();
    assert.equal(disposed, phase === 'lookup' ? 1 : 0);
    console.log('survived without a stream leak');
  `], { timeout: 10_000 });
  expect(stdout.trim()).toBe('survived without a stream leak');
});
