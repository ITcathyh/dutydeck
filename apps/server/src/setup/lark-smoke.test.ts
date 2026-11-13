import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredLarkConfig } from '@dutydeck/shared';
import { offerLarkSetupSmoke, type LarkSmokeEvent } from './lark-smoke.js';
import type { Prompter } from './prompts.js';

const daemonProbe = vi.hoisted(() => ({ statuses: ['stale'] as string[], calls: 0 }));
vi.mock('../daemon/command.js', () => ({
  daemonStatus: () => {
    const status = daemonProbe.statuses[Math.min(daemonProbe.calls, daemonProbe.statuses.length - 1)] ?? 'stale';
    daemonProbe.calls += 1;
    return { processStatus: status };
  }
}));

const bot = { appId: 'cli_smoke', appSecret: 'secret_fixture', listening: true } as StoredLarkConfig;
const ownerEvent: LarkSmokeEvent = {
  eventId: 'event_owner', messageId: 'message_owner', chatId: 'oc_dm', chatType: 'p2p',
  parentId: 'om_test_card', senderOpenId: 'ou_owner', senderType: 'user', content: '{"text":"done"}'
};

function prompter(answer = true): Prompter {
  return {
    interactive: true,
    ask: vi.fn(),
    choose: vi.fn(),
    confirm: vi.fn(async () => answer),
    secret: vi.fn(),
    close: vi.fn()
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    database: '/tmp/synthetic-smoke.db', appId: bot.appId, ownerOpenId: 'ou_owner',
    interactive: true, prompter: prompter(), timeoutMs: 60_000,
    ...overrides
  };
}

beforeEach(() => {
  daemonProbe.statuses = ['stale'];
  daemonProbe.calls = 0;
});

afterEach(() => { vi.useRealTimers(); });

describe('offerLarkSetupSmoke', () => {
  it('defaults to No and does not start listening or send after refusal', async () => {
    const startListener = vi.fn(async () => vi.fn());
    const sendCard = vi.fn();
    const prompt = prompter(false);
    const result = await offerLarkSetupSmoke(options({ prompter: prompt }), {
      loadBot: async () => bot, startListener, sendCard
    });
    expect(result.status).toBe('skipped');
    expect(prompt.confirm).toHaveBeenCalledWith(expect.objectContaining({ defaultValue: false, dangerous: true }));
    expect(startListener).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it.each([
    ['--yes', { interactive: true, assumeYes: true }],
    ['non-interactive', { interactive: false }],
    ['JSON', { interactive: false, json: true }]
  ])('does not prompt or send for %s', async (_name, override) => {
    const prompt = prompter();
    const loadBot = vi.fn(async () => bot);
    const sendCard = vi.fn();
    const result = await offerLarkSetupSmoke(options({ ...override, prompter: prompt }), { loadBot, sendCard });
    expect(result.status).toBe('skipped');
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(loadBot).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it.each(['verified', 'unverifiable'])('fails closed before prompting when daemon status is %s', async status => {
    vi.useFakeTimers();
    daemonProbe.statuses = [status];
    const prompt = prompter();
    const startListener = vi.fn(async () => vi.fn());
    const sendCard = vi.fn();
    const pending = offerLarkSetupSmoke(options({ prompter: prompt }), {
      loadBot: async () => bot, startListener, sendCard
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('分流正常消息');
    expect(result.message).toContain('停止该实例后再试');
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(startListener).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it('rechecks after confirmation and refuses a daemon that appears before listener startup', async () => {
    vi.useFakeTimers();
    daemonProbe.statuses = ['stale', 'verified'];
    const prompt = prompter();
    const startListener = vi.fn(async () => vi.fn());
    const sendCard = vi.fn();
    const pending = offerLarkSetupSmoke(options({ prompter: prompt }), {
      loadBot: async () => bot, startListener, sendCard
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.status).toBe('unavailable');
    expect(daemonProbe.calls).toBe(2);
    expect(prompt.confirm).toHaveBeenCalledOnce();
    expect(startListener).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it('does not offer the smoke when the owner open ID cannot be established', async () => {
    const prompt = prompter();
    const sendCard = vi.fn();
    const startListener = vi.fn(async () => vi.fn());
    const result = await offerLarkSetupSmoke(options({ ownerOpenId: undefined, prompter: prompt }), {
      loadBot: async () => bot, startListener, sendCard
    });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('所有者');
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(startListener).not.toHaveBeenCalled();
    expect(sendCard).not.toHaveBeenCalled();
  });

  it('does not offer the smoke without a usable saved bot', async () => {
    const prompt = prompter();
    const result = await offerLarkSetupSmoke(options({ prompter: prompt }), {
      loadBot: async () => undefined, sendCard: vi.fn()
    });
    expect(result.status).toBe('unavailable');
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it('starts listening before sending one UUID card and verifies the owner p2p reply', async () => {
    const order: string[] = [];
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const stop = vi.fn(() => { order.push('stop'); });
    const sendCard = vi.fn(async (_bot, input: { uuid: string; ownerOpenId: string }) => {
      order.push('send');
      expect(input.uuid).toBe('uuid_fixed');
      expect(input.ownerOpenId).toBe('ou_owner');
      onEvent?.(ownerEvent);
      return { messageId: 'om_test_card', chatId: 'oc_dm' };
    });
    const result = await offerLarkSetupSmoke(options(), {
      loadBot: async () => bot,
      startListener: async (_bot, receive) => {
        order.push('start');
        onEvent = receive;
        return stop;
      },
      sendCard,
      uuid: () => 'uuid_fixed'
    });
    expect(result.status).toBe('verified');
    expect(result.message).toContain('端到端');
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['start', 'send', 'stop']);
  });

  it('reports send failure without claiming inbound or end-to-end verification', async () => {
    const stop = vi.fn();
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const result = await offerLarkSetupSmoke(options(), {
      loadBot: async () => bot,
      startListener: async (_bot, receive) => { onEvent = receive; return stop; },
      sendCard: async () => { onEvent?.(ownerEvent); throw new Error('synthetic send failure'); }
    });
    expect(result.status).toBe('send_failed');
    expect(result.message).toContain('发送');
    expect(result.message).toContain('入站未验证');
    expect(result.message).not.toContain('端到端通过');
    expect(stop).toHaveBeenCalledOnce();
  });

  it('marks a successful send without a reply as inbound unverified after the bounded wait', async () => {
    vi.useFakeTimers();
    const stop = vi.fn();
    const pending = offerLarkSetupSmoke(options(), {
      loadBot: async () => bot,
      startListener: async () => stop,
      sendCard: async () => ({ messageId: 'om_test_card', chatId: 'oc_dm' })
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.status).toBe('inbound_unverified');
    expect(result.message).toContain('入站未验证');
    expect(result.message).not.toContain('端到端通过');
    expect(stop).toHaveBeenCalledOnce();
  });

  it('does not verify an unrelated owner private message', async () => {
    vi.useFakeTimers();
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const pending = offerLarkSetupSmoke(options(), {
      loadBot: async () => bot,
      startListener: async (_bot, receive) => { onEvent = receive; return vi.fn(); },
      sendCard: async () => {
        onEvent?.({ ...ownerEvent, eventId: 'old_owner', messageId: 'old_owner', parentId: 'om_old', content: '{"text":"unrelated"}' });
        return { messageId: 'om_test_card', chatId: 'oc_dm' };
      }
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).status).toBe('inbound_unverified');
  });

  it('verifies a UUID-bearing owner reply delivered while send is completing', async () => {
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const result = await offerLarkSetupSmoke(options(), {
      loadBot: async () => bot,
      startListener: async (_bot, receive) => { onEvent = receive; return vi.fn(); },
      sendCard: async () => {
        onEvent?.({ ...ownerEvent, parentId: undefined, rootId: undefined, content: '{"text":"reply uuid_fixed"}' });
        return { messageId: 'om_test_card', chatId: 'oc_dm' };
      },
      uuid: () => 'uuid_fixed'
    });
    expect(result.status).toBe('verified');
  });

  it('ignores another user, a group message and a bot sender', async () => {
    vi.useFakeTimers();
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const pending = offerLarkSetupSmoke(options(), {
      loadBot: async () => bot,
      startListener: async (_bot, receive) => { onEvent = receive; return vi.fn(); },
      sendCard: async () => {
        onEvent?.({ ...ownerEvent, eventId: 'other_user', messageId: 'other_user', senderOpenId: 'ou_other' });
        onEvent?.({ ...ownerEvent, eventId: 'group', messageId: 'group', chatType: 'group' });
        onEvent?.({ ...ownerEvent, eventId: 'bot', messageId: 'bot', senderType: 'app' });
        return { messageId: 'om_test_card', chatId: 'oc_dm' };
      }
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).status).toBe('inbound_unverified');
  });

  it('accepts the owner after another user and settles duplicate deliveries only once', async () => {
    let onEvent: ((event: LarkSmokeEvent) => void) | undefined;
    const stop = vi.fn();
    const sendCard = vi.fn(async () => {
      onEvent?.({ ...ownerEvent, eventId: 'other', messageId: 'other', senderOpenId: 'ou_other' });
      onEvent?.(ownerEvent);
      onEvent?.(ownerEvent);
      onEvent?.({ ...ownerEvent, eventId: 'same_message_redelivered' });
      return { messageId: 'om_test_card', chatId: 'oc_dm' };
    });
    const result = await offerLarkSetupSmoke(options(), {
      loadBot: async () => bot,
      startListener: async (_bot, receive) => { onEvent = receive; return stop; },
      sendCard
    });
    expect(result.status).toBe('verified');
    expect(sendCard).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('cleans up and does not send if the listener cannot start', async () => {
    const sendCard = vi.fn();
    const result = await offerLarkSetupSmoke(options(), {
      loadBot: async () => bot,
      startListener: async () => { throw new Error('synthetic listener failure'); },
      sendCard
    });
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('监听');
    expect(sendCard).not.toHaveBeenCalled();
  });
});
