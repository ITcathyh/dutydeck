import { describe, expect, it } from 'vitest';
import { isGroupChat, renderGroupMention } from './card-mentions.js';

describe('isGroupChat', () => {
  it('chat_type=group 判定为群聊', () => {
    expect(isGroupChat('group')).toBe(true);
  });

  it('p2p / undefined / 其他字面量均不判定为群聊', () => {
    expect(isGroupChat('p2p')).toBe(false);
    expect(isGroupChat(undefined)).toBe(false);
    // 话题群在 chat_type 上仍是 group；'topic_group' 是群形态查询字段，不会出现在这里
    expect(isGroupChat('topic_group')).toBe(false);
    expect(isGroupChat('')).toBe(false);
  });
});

describe('renderGroupMention', () => {
  it('按文本消息同款格式产出 at 串', () => {
    expect(renderGroupMention('ou_123', '张三')).toBe('<at user_id="ou_123">张三</at>');
  });

  it('名字缺省给安全占位', () => {
    expect(renderGroupMention('ou_123')).toBe('<at user_id="ou_123">成员</at>');
    expect(renderGroupMention('ou_123', '   ')).toBe('<at user_id="ou_123">成员</at>');
  });

  it('名字首尾空白被裁剪', () => {
    expect(renderGroupMention('ou_123', '  张三  ')).toBe('<at user_id="ou_123">张三</at>');
  });

  it('名字中的 < > & 做实体转义，防止注入伪 at 标签', () => {
    expect(renderGroupMention('ou_1', '<at user_id="ou_2">x</at>'))
      .toBe('<at user_id="ou_1">&lt;at user_id="ou_2"&gt;x&lt;/at&gt;</at>');
  });

  it('名字含尖括号时不出现第二个原始 <at 标签', () => {
    const rendered = renderGroupMention('ou_1', '<script>alert(1)</script>');
    expect(rendered).toBe('<at user_id="ou_1">&lt;script&gt;alert(1)&lt;/script&gt;</at>');
    expect(rendered!.match(/<at /g)).toHaveLength(1);
  });

  it('openId 含引号/空白等属性位非法字符时返回 undefined，杜绝属性注入', () => {
    expect(renderGroupMention('ou_1" onclick="x')).toBeUndefined();
    expect(renderGroupMention('ou 123')).toBeUndefined();
    expect(renderGroupMention('')).toBeUndefined();
    expect(renderGroupMention('   ')).toBeUndefined();
  });
});
