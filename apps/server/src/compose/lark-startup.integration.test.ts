import { expect, it, vi } from 'vitest';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import type { LarkCardService } from '../lark/service.js';
import { buildApp } from '../app.js';

it('serves a message once over HTTP while the initial Lark handshake is pending', async () => {
  const handshake = Promise.withResolvers<void>();
  const sync = vi.fn(() => handshake.promise);
  const send = vi.fn(async () => ({ messageId: 'om_receipt' }));
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
    handshake.resolve();
    await vi.waitFor(async () => expect(await readiness()).toEqual({ ok: true, ready: true, pending: [] }));
    expect(send.mock.calls).toEqual([[message]]);
  } finally {
    handshake.resolve();
    await app.close();
  }
});
