import { describe, expect, it, vi } from 'vitest';
import { buildEditedMessageEvent, unwrapEditedTextContent } from './edited-message.js';
import type { LarkChatMessage } from './service.js';

const baseDetail = (patch: Partial<LarkChatMessage> = {}): LarkChatMessage => ({
  messageId: 'om_edit',
  chatId: 'oc_group',
  messageType: 'text',
  createTime: '1700000000000',
  sender: { id: 'ou_human', idType: 'open_id', type: 'user' },
  rawContent: '{"text":"@_user_1 执行任务"}',
  mentions: [{ id: 'ou_bot', idType: 'open_id', key: '@_user_1', name: 'Dutydeck' }],
  deleted: false,
  updated: true,
  ...patch
});

const resolveGroup = vi.fn(async () => 'group' as const);

describe('unwrapEditedTextContent', () => {
  it('还原单段与多段 <p> 包裹，多段按真实换行连接', () => {
    expect(JSON.parse(unwrapEditedTextContent('{"text":"<p>正文</p>"}')).text).toBe('正文');
    expect(JSON.parse(unwrapEditedTextContent('{"text":"<p>第一段</p><p>第二段</p>"}')).text).toBe('第一段\n第二段');
  });

  it('保留段内真实换行与其它 JSON 字段', () => {
    const result = JSON.parse(unwrapEditedTextContent(String.raw`{"text":"<p>第一行\n第二行</p>","other":1}`));
    expect(result.text).toBe('第一行\n第二行');
    expect(result.other).toBe(1);
  });

  it('正文里本就含 <p> 字样（去标签后有残留）时绝不误伤', () => {
    const raw = '{"text":"<p>正文</p> 多余文字"}';
    expect(unwrapEditedTextContent(raw)).toBe(raw);
  });

  it('非 JSON 或不含 <p> 时原样返回', () => {
    expect(unwrapEditedTextContent('not-json')).toBe('not-json');
    expect(unwrapEditedTextContent('{"text":"普通正文"}')).toBe('{"text":"普通正文"}');
  });

  it('仅在整段包装内解码必要实体与换行，不清洗其它标签或重复解码', () => {
    const raw = JSON.stringify({ text: '<p>a &lt; b &amp; c<br/>第二行 &quot;x&quot; &#39;y&#39;&nbsp;&amp;lt;</p><p><code>keep</code></p>' });
    expect(JSON.parse(unwrapEditedTextContent(raw)).text).toBe('a < b & c\n第二行 "x" \'y\' &lt;\n<code>keep</code>');
    const plain = JSON.stringify({ text: 'literal &lt;example&gt;<br/>' });
    expect(unwrapEditedTextContent(plain)).toBe(plain);
  });
});

describe('buildEditedMessageEvent', () => {
  it('mixed mention 身份域仅把 open_id 映射为 openId，保留其他人的文本信息', async () => {
    const event = await buildEditedMessageEvent({ eventMessageId: 'om_edit', detail: baseDetail({ mentions: [
      { id: 'ou_bot', idType: 'open_id', key: '@_user_1', name: 'Dutydeck' },
      { id: 'user_2', idType: 'user_id', key: '@_user_2', name: 'User' },
      { id: 'union_3', idType: 'union_id', key: '@_user_3', name: 'Union' }
    ] }), botOpenId: 'ou_bot', resolveChatType: resolveGroup, appId: 'cli_test' });
    expect(event?.mentions).toEqual([
      { key: '@_user_1', name: 'Dutydeck', openId: 'ou_bot' },
      { key: '@_user_2', name: 'User' },
      { key: '@_user_3', name: 'Union' }
    ]);
  });
  it('以详情原作者/正文/mentions 构造与 receive 同构的事件，不采信任何编辑操作者', async () => {
    const event = await buildEditedMessageEvent({
      eventMessageId: 'om_edit', detail: baseDetail(), botOpenId: 'ou_bot', resolveChatType: resolveGroup, appId: 'cli_test'
    });
    expect(event).toMatchObject({
      messageId: 'om_edit', chatId: 'oc_group', chatType: 'group',
      messageType: 'text', senderOpenId: 'ou_human', senderType: 'user',
      content: '{"text":"@_user_1 执行任务"}',
      mentions: [{ key: '@_user_1', name: 'Dutydeck', openId: 'ou_bot' }]
    });
  });

  it('透传 thread/root/parent 三个相互独立的字段', async () => {
    const event = await buildEditedMessageEvent({
      eventMessageId: 'om_edit',
      detail: baseDetail({ threadId: 'omt_thread', rootId: 'om_root' }),
      botOpenId: 'ou_bot', resolveChatType: resolveGroup, appId: 'cli_test'
    });
    expect(event).toMatchObject({ threadId: 'omt_thread', rootId: 'om_root' });
    expect(event?.parentId).toBeUndefined();

    const withParent = await buildEditedMessageEvent({
      eventMessageId: 'om_edit',
      detail: baseDetail({ parentId: 'om_parent', rootId: 'om_root' }),
      botOpenId: 'ou_bot', resolveChatType: resolveGroup, appId: 'cli_test'
    });
    expect(withParent).toMatchObject({ parentId: 'om_parent', rootId: 'om_root' });
    expect(withParent?.threadId).toBeUndefined();
  });

  it('rich post 正文原样保留，不做 <p> 解包', async () => {
    const postContent = JSON.stringify({ zh_cn: { title: 't', content: [[{ tag: 'text', text: '<p>x</p>' }]] } });
    const event = await buildEditedMessageEvent({
      eventMessageId: 'om_edit',
      detail: baseDetail({ messageType: 'post', rawContent: postContent }),
      botOpenId: 'ou_bot', resolveChatType: resolveGroup, appId: 'cli_test'
    });
    expect(event?.content).toBe(postContent);
    expect(event?.messageType).toBe('post');
  });

  it('附件消息（image/file）保留原 content 与类型', async () => {
    const imageContent = '{"image_key":"img_v2_abc"}';
    const event = await buildEditedMessageEvent({
      eventMessageId: 'om_edit',
      detail: baseDetail({ messageType: 'image', rawContent: imageContent }),
      botOpenId: 'ou_bot', resolveChatType: resolveGroup, appId: 'cli_test'
    });
    expect(event).toMatchObject({ messageType: 'image', content: imageContent });
  });

  it('text 编辑的 <p> 包装只在 text 入口解包', async () => {
    const event = await buildEditedMessageEvent({
      eventMessageId: 'om_edit',
      detail: baseDetail({ rawContent: '{"text":"<p>@_user_1 执行任务</p>"}' }),
      botOpenId: 'ou_bot', resolveChatType: resolveGroup, appId: 'cli_test'
    });
    expect(JSON.parse(event!.content).text).toBe('@_user_1 执行任务');
  });

  it('topic 群映射为 group，p2p 映射为 p2p', async () => {
    const topic = await buildEditedMessageEvent({
      eventMessageId: 'om_edit', detail: baseDetail(), botOpenId: 'ou_bot',
      resolveChatType: vi.fn(async () => 'topic' as const), appId: 'cli_test'
    });
    expect(topic?.chatType).toBe('group');
    const p2p = await buildEditedMessageEvent({
      eventMessageId: 'om_edit',
      detail: baseDetail({ chatId: 'oc_p2p' }), botOpenId: 'ou_bot',
      resolveChatType: vi.fn(async () => 'p2p' as const), appId: 'cli_test'
    });
    expect(p2p?.chatType).toBe('p2p');
  });

  it.each([
    ['请求/响应 message ID 不一致', baseDetail({ messageId: 'om_other' })],
    ['消息已删除', baseDetail({ deleted: true })],
    ['缺少 chat ID', baseDetail({ chatId: undefined })],
    ['原作者是机器人(sender.type=app)', baseDetail({ sender: { id: 'ou_botpeer', idType: 'open_id', type: 'app' } })],
    ['sender 身份域不是 open_id', baseDetail({ sender: { id: 'cli_peer', idType: 'app_id', type: 'user' } })],
    ['sender 缺少 id', baseDetail({ sender: { idType: 'open_id', type: 'user' } })],
  ])('拒绝触发：%s', async (_name, detail) => {
    await expect(buildEditedMessageEvent({
      eventMessageId: 'om_edit', detail, botOpenId: 'ou_bot', resolveChatType: resolveGroup, appId: 'cli_test'
    })).resolves.toBeUndefined();
  });

  it('没有显式 @ 当前 bot 时拒绝（@ 别人或 mention 身份域非 open_id 都不算）', async () => {
    const mentionOther = baseDetail({ mentions: [{ id: 'ou_other', idType: 'open_id', key: '@_user_1', name: 'Other' }] });
    await expect(buildEditedMessageEvent({
      eventMessageId: 'om_edit', detail: mentionOther, botOpenId: 'ou_bot', resolveChatType: resolveGroup, appId: 'cli_test'
    })).resolves.toBeUndefined();
    const mentionUserIdDomain = baseDetail({ mentions: [{ id: 'ou_bot', idType: 'user_id', key: '@_user_1', name: 'Dutydeck' }] });
    await expect(buildEditedMessageEvent({
      eventMessageId: 'om_edit', detail: mentionUserIdDomain, botOpenId: 'ou_bot', resolveChatType: resolveGroup, appId: 'cli_test'
    })).resolves.toBeUndefined();
  });

  it('群形态查询失败时抛错，由调用方决定不触发（绝不猜测 chatType）', async () => {
    await expect(buildEditedMessageEvent({
      eventMessageId: 'om_edit', detail: baseDetail(), botOpenId: 'ou_bot',
      resolveChatType: vi.fn(async () => { throw new Error('chat get denied'); }), appId: 'cli_test'
    })).rejects.toThrow('chat get denied');
  });
});
