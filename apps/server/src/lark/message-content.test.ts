import { describe, expect, it, vi } from 'vitest';
import { parseLarkMessageContent } from './message-content.js';

describe('parseLarkMessageContent', () => {
  it('converts a Feishu post into readable text without leaking protocol JSON', async () => {
    const content = JSON.stringify({
      title: '',
      content: [[{ tag: 'text', text: '旧格式内容' }]],
      content_v2: [[
        { tag: 'text', text: '切到 ' },
        { tag: 'text', text: 'feat/dockmux-migration' },
        { tag: 'text', text: ' 并 push 当前代码' }
      ]]
    });
    expect(await parseLarkMessageContent('post', content)).toEqual({
      text: '切到 feat/dockmux-migration 并 push 当前代码',
      resources: []
    });
  });

  it('supports localized posts, links, images, and files', async () => {
    const content = JSON.stringify({ zh_cn: { title: '需求', content: [
      [{ tag: 'text', text: '参考 ' }, { tag: 'a', text: '说明', href: 'https://example.com' }],
      [{ tag: 'img', image_key: 'img_1' }, { tag: 'file', file_key: 'file_1', file_name: 'spec.pdf' }]
    ] } });
    expect(await parseLarkMessageContent('post', content)).toEqual({
      text: '需求\n\n参考 说明 (https://example.com)\n\n[图片][文件「spec.pdf」]',
      resources: [
        { key: 'img_1', type: 'image', label: '图片' },
        { key: 'file_1', type: 'file', label: '文件「spec.pdf」', fileName: 'spec.pdf' }
      ]
    });
  });

  it('extracts standalone image and file resources without exposing JSON', async () => {
    expect((await parseLarkMessageContent('image', '{"image_key":"img_1"}')).text).toBe('[图片]');
    expect(await parseLarkMessageContent('file', '{"file_key":"file_1","file_name":"brief.docx"}')).toMatchObject({
      text: '[文件「brief.docx」]', resources: [{ key: 'file_1', type: 'file', fileName: 'brief.docx' }]
    });
  });

  it('extracts readable Agent output from Card JSON 2.0 messages', async () => {
    const content = JSON.stringify({
      schema: '2.0', header: { title: { tag: 'plain_text', content: '✅ Peer Agent 已完成' }, subtitle: { tag: 'plain_text', content: '接口检查' } },
      body: { elements: [{ tag: 'markdown', content: '**结论：** 接口正常。' }] }
    });
    expect(await parseLarkMessageContent('interactive', content)).toEqual({
      text: '✅ Peer Agent 已完成\n\n接口检查\n\n**结论：** 接口正常。', resources: []
    });
  });

  it('extracts readable text from the raw_card_content wrapper returned by the message list API', async () => {
    const jsonCard = JSON.stringify({
      schema: '2.0',
      header: { property: {
        title: { tag: 'plain_text', property: { content: '✅ Peer Agent 已完成' } },
        subtitle: { tag: 'plain_text', property: { content: '协作回复' } }
      } },
      body: { property: { elements: [
        { tag: 'markdown', property: { elements: [
          { tag: 'plain_text', property: { content: 'pong' } },
          { tag: 'br', property: {} },
          { tag: 'link', property: { content: '详情', url: { url: 'https://example.com/task' } } }
        ] } }
      ] } }
    });
    const content = JSON.stringify({ json_card: jsonCard, card_schema: 2 });

    expect(await parseLarkMessageContent('interactive', content)).toEqual({
      text: '✅ Peer Agent 已完成\n\n协作回复\n\npong\n详情 (https://example.com/task)',
      resources: []
    });
  });

  it('expands merge_forward messages by fetching and parsing forwarded children', async () => {
    const fetchMessageItems = vi.fn(async () => [
      { messageId: 'om_parent', messageType: 'merge_forward', content: '"Merged and Forwarded Message"' },
      { messageId: 'om_child1', messageType: 'text', content: JSON.stringify({ text: '第一条转发内容' }), sender: { name: '张三' } },
      { messageId: 'om_child2', messageType: 'text', content: JSON.stringify({ text: '第二条转发内容' }), sender: { name: '李四' } }
    ]);
    const result = await parseLarkMessageContent('merge_forward', '"Merged and Forwarded Message"', {
      messageId: 'om_parent',
      fetchMessageItems
    });
    expect(fetchMessageItems).toHaveBeenCalledWith('om_parent');
    expect(result.text).toBe('张三: 第一条转发内容\n\n李四: 第二条转发内容');
    expect(result.resources).toEqual([]);
  });

  it('falls back gracefully when merge_forward has no fetcher or messageId', async () => {
    const withoutFetcher = await parseLarkMessageContent('merge_forward', '"Merged and Forwarded Message"');
    expect(withoutFetcher.text).toContain('合并转发');
    const withoutMessageId = await parseLarkMessageContent('merge_forward', '"Merged and Forwarded Message"', { fetchMessageItems: async () => [] });
    expect(withoutMessageId.text).toContain('合并转发');
  });
});
