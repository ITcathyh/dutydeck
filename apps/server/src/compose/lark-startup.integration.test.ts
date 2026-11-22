import { expect, it, vi } from 'vitest';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import type { LarkCardService } from '../lark/service.js';
import Fastify from 'fastify';
import { registerLarkRoutes } from '../lark/routes.js';
import { buildApp } from '../app.js';

it('serves a message once over HTTP while the initial Lark handshake is pending', async () => {
  let finishHandshake!: () => void;
  const handshake = new Promise<void>(resolve => { finishHandshake = resolve; });
  const sync = vi.fn(() => handshake);
  const send = vi.fn(async (_message: unknown) => ({ messageId: 'om_receipt' }));
  const app = await buildApp({} as DutydeckRuntime, {
    lark: {
      env: {}, listener: { listening: false, activeAppIds: [], sync, stop() {} },
      service: { send } as unknown as LarkCardService,
    },
  });
  try {
    await app.ready();
    expect(sync).not.toHaveBeenCalled();
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));

    const readiness = async () => (await fetch(origin + '/health/ready')).json();
    expect(await readiness()).toEqual({ ok: true, ready: false, pending: ['飞书长连接还在建立'] });
    const message = { receiveId: 'oc_example', markdown: 'first message' };
    const response = await fetch(origin + '/api/lark/send', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messageId: 'om_receipt' });
    finishHandshake();
    await vi.waitFor(async () => expect(await readiness()).toEqual({ ok: true, ready: true, pending: [] }));
    expect(send.mock.calls).toEqual([[message]]);
  } finally {
    finishHandshake();
    await app.close();
  }
});

it('lets the host own listener startup independently of route registration', async () => {
  const sync = vi.fn(async () => {});
  const stop = vi.fn();
  const app = Fastify();
  const options = { env: {}, listener: { listening: false, activeAppIds: [], sync, stop } };
  const services = await registerLarkRoutes(app, options);
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    expect((await fetch(origin + '/api/lark/status')).status).toBe(200);
    expect(sync).not.toHaveBeenCalled();
    services.start();
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    await app.close();
    expect(stop).not.toHaveBeenCalled();
  } finally {
    services.closeHttp();
    await services.stop();
    await app.close();
  }
});
