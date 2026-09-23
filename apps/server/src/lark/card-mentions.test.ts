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
  it('按卡片 markdown 官方格式产出 at 串', () => {
    expect(renderGroupMention('ou_123')).toBe('<at id=ou_123></at>');
    expect(renderGroupMention('  ou_123  ')).toBe('<at id=ou_123></at>');
  });

  it('openId 含引号/空白等属性位非法字符时返回 undefined，杜绝属性注入', () => {
    expect(renderGroupMention('ou_1" onclick="x')).toBeUndefined();
    expect(renderGroupMention('ou 123')).toBeUndefined();
    expect(renderGroupMention('')).toBeUndefined();
    expect(renderGroupMention('   ')).toBeUndefined();
  });
});
