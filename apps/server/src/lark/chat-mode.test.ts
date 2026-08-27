import { beforeEach, describe, expect, it, vi } from 'vitest';

const { chatGetMock } = vi.hoisted(() => ({ chatGetMock: vi.fn() }));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { warn: 'warn' },
  Client: class {
    im = { chat: { get: chatGetMock } };
  }
}));

import { clearLarkChatModeCache, getCachedChatMode, getChatMode } from './chat-mode.js';

describe('getChatMode 群形态查询', () => {
  beforeEach(() => {
    chatGetMock.mockReset();
    clearLarkChatModeCache();
  });

  it('chat_mode=topic 判定为话题群', async () => {
    chatGetMock.mockResolvedValue({ code: 0, data: { chat_mode: 'topic' } });
    expect(await getChatMode('cli_a', 'secret', 'oc_1')).toBe('topic');
  });

  it('group_message_type=thread 判定为话题群（客户端转换的话题群）', async () => {
    chatGetMock.mockResolvedValue({ code: 0, data: { chat_mode: 'group', group_message_type: 'thread' } });
    expect(await getChatMode('cli_a', 'secret', 'oc_1')).toBe('topic');
  });

  it('chat_mode=p2p 判定为私聊', async () => {
    chatGetMock.mockResolvedValue({ code: 0, data: { chat_mode: 'p2p' } });
    expect(await getChatMode('cli_a', 'secret', 'oc_dm')).toBe('p2p');
  });

  it('普通群判定为 group', async () => {
    chatGetMock.mockResolvedValue({ code: 0, data: { chat_mode: 'group', group_message_type: 'chat' } });
    expect(await getChatMode('cli_a', 'secret', 'oc_2')).toBe('group');
  });

  it('未知枚举/空响应宽容降级为 group', async () => {
    chatGetMock.mockResolvedValue({ code: 0, data: {} });
    expect(await getChatMode('cli_a', 'secret', 'oc_3')).toBe('group');
    chatGetMock.mockResolvedValue({ code: 0, data: { chat_mode: 'future_mode' } });
    expect(await getChatMode('cli_a', 'secret', 'oc_4')).toBe('group');
  });

  it('API 报错/业务码非零/网络异常均宽容降级为 group，不抛出', async () => {
    chatGetMock.mockResolvedValue({ code: 99991663, msg: 'no permission' });
    expect(await getChatMode('cli_a', 'secret', 'oc_5')).toBe('group');
    chatGetMock.mockRejectedValue(new Error('network down'));
    expect(await getChatMode('cli_a', 'secret', 'oc_6')).toBe('group');
  });

  it('命中缓存时不重复请求，forceRefresh 强制刷新', async () => {
    chatGetMock.mockResolvedValue({ code: 0, data: { chat_mode: 'topic' } });
    await getChatMode('cli_a', 'secret', 'oc_cache');
    await getChatMode('cli_a', 'secret', 'oc_cache');
    expect(chatGetMock).toHaveBeenCalledTimes(1);
    expect(getCachedChatMode('cli_a', 'oc_cache')).toBe('topic');
    await getChatMode('cli_a', 'secret', 'oc_cache', { forceRefresh: true });
    expect(chatGetMock).toHaveBeenCalledTimes(2);
  });

  it('appSecret 轮换后重建 client（forceRefresh 绕过缓存验证）', async () => {
    chatGetMock.mockResolvedValue({ code: 0, data: { chat_mode: 'group' } });
    expect(await getChatMode('cli_b', 'old-secret', 'oc_7')).toBe('group');
    expect(await getChatMode('cli_b', 'new-secret', 'oc_7', { forceRefresh: true })).toBe('group');
    expect(chatGetMock).toHaveBeenCalledTimes(2);
  });
});
