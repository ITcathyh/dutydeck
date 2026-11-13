import { describe, expect, it, vi } from 'vitest';
import type { StoredLarkConfig } from '@dutydeck/shared';

const state = vi.hoisted(() => ({
  configs: [] as StoredLarkConfig[], stops: 0, options: [] as unknown[],
  stopOptions: [] as Array<{ force?: boolean } | undefined>, startError: undefined as Error | undefined
}));
vi.mock('../lark/listener.js', () => ({
  LarkLongConnectionListener: class {
    constructor(_log: unknown, options?: unknown) { state.options.push(options); }
    async start(config: StoredLarkConfig) {
      state.configs.push(config);
      if (state.startError) throw state.startError;
    }
    stop(options?: { force?: boolean }) { state.stops += 1; state.stopOptions.push(options); }
  }
}));

import { startLarkSmokeListener } from './lark-smoke-listener.js';

describe('startLarkSmokeListener', () => {
  it('forwards only the authenticated loopback message event and closes all resources', async () => {
    state.configs.length = 0;
    state.options.length = 0;
    state.stopOptions.length = 0;
    state.stops = 0;
    const received: unknown[] = [];
    const stop = await startLarkSmokeListener(
      { appId: 'cli_smoke', appSecret: 'secret_fixture' } as StoredLarkConfig,
      event => received.push(event)
    );
    expect(state.configs).toHaveLength(1);
    expect(state.options).toEqual([expect.objectContaining({ forceCloseOnStop: true })]);
    const config = state.configs[0]!;
    expect(config.welcomeEnabled).toBe(false);
    expect(config.cardActionForwarding).toBeUndefined();
    const handler = config.eventHandlers?.[0]!;
    expect(new URL(handler.url).hostname).toBe('127.0.0.1');

    const other = new URL(handler.url);
    other.pathname = '/other';
    const otherResponse = await fetch(other, { method: 'POST' });
    expect(otherResponse.status).toBe(404);
    expect(received).toHaveLength(0);

    const response = await fetch(handler.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${handler.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1, app_id: 'cli_smoke', handler_id: 'setup_smoke', event_type: 'im.message.receive_v1',
        event: {
          event_id: 'event_1', sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
          message: { message_id: 'message_1', chat_id: 'oc_dm', chat_type: 'p2p', parent_id: 'om_card', root_id: 'om_root', content: '{"text":"reply"}' }
        }
      })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ event_id: 'event_1', decision: 'stop' });
    expect(received).toEqual([{
      eventId: 'event_1', messageId: 'message_1', chatId: 'oc_dm', chatType: 'p2p',
      parentId: 'om_card', rootId: 'om_root', content: '{"text":"reply"}', senderOpenId: 'ou_owner', senderType: 'user'
    }]);

    await stop();
    expect(state.stops).toBe(1);
    expect(state.stopOptions).toEqual([{ force: true }]);
    await expect(fetch(handler.url)).rejects.toThrow();
  });

  it('forces the first cleanup and closes loopback when listener startup fails', async () => {
    state.configs.length = 0;
    state.options.length = 0;
    state.stopOptions.length = 0;
    state.stops = 0;
    state.startError = new Error('synthetic startup failure');
    try {
      await expect(startLarkSmokeListener(
        { appId: 'cli_smoke', appSecret: 'secret_fixture' } as StoredLarkConfig,
        () => {}
      )).rejects.toThrow('synthetic startup failure');
      expect(state.stopOptions).toEqual([{ force: true }]);
      const handler = state.configs[0]!.eventHandlers![0]!;
      await expect(fetch(handler.url)).rejects.toThrow();
    } finally { state.startError = undefined; }
  });
});
