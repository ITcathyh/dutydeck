import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_REACTION_EMOJI,
  isFileResultDelivery,
  reactionDedupeKey,
  reactionEmojiForAcceptance,
  type ReactionRecord
} from './reaction-records.js';

describe('验收 emoji 短名常量', () => {
  it('accept / changes 均映射到非空短名', () => {
    expect(ACCEPTANCE_REACTION_EMOJI.accept).toBeTruthy();
    expect(ACCEPTANCE_REACTION_EMOJI.changes).toBeTruthy();
    expect(ACCEPTANCE_REACTION_EMOJI.accept).not.toBe(ACCEPTANCE_REACTION_EMOJI.changes);
  });

  it('短名与官方表情表一致（CheckMark=绿色对勾，Typing=敲键盘）', () => {
    expect(ACCEPTANCE_REACTION_EMOJI).toEqual({ accept: 'CheckMark', changes: 'Typing' });
  });

  it('reactionEmojiForAcceptance 取短名，未知 action 返回 undefined', () => {
    expect(reactionEmojiForAcceptance('accept')).toBe('CheckMark');
    expect(reactionEmojiForAcceptance('changes')).toBe('Typing');
    expect(reactionEmojiForAcceptance('reject')).toBeUndefined();
  });
});

describe('reactionDedupeKey', () => {
  it('按 lark.<域>.<appId>.<messageId>.<emojiType> 风格拼接', () => {
    expect(reactionDedupeKey('cli_app', 'om_abc', 'CheckMark'))
      .toBe('lark.reaction.cli_app.om_abc.CheckMark');
  });

  it('相同入参稳定生成同一 key（重启对账判重前提）', () => {
    const a = reactionDedupeKey('cli_app', 'om_abc', 'CheckMark');
    const b = reactionDedupeKey('cli_app', 'om_abc', 'CheckMark');
    expect(a).toBe(b);
  });

  it('任一维度不同则 key 不同：同消息两种验收态各记一笔、不同消息互不串', () => {
    const accept = reactionDedupeKey('cli_app', 'om_1', 'CheckMark');
    const changes = reactionDedupeKey('cli_app', 'om_1', 'Typing');
    const otherMessage = reactionDedupeKey('cli_app', 'om_2', 'CheckMark');
    const otherApp = reactionDedupeKey('cli_other', 'om_1', 'CheckMark');
    expect(new Set([accept, changes, otherMessage, otherApp]).size).toBe(4);
  });

  it('记录形状可 JSON 序列化落 kv', () => {
    const record: ReactionRecord = {
      messageId: 'om_1', emojiType: 'CheckMark', reactionId: 're_1', createdAt: '2026-09-13T00:00:00.000Z'
    };
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
  });
});

describe('isFileResultDelivery', () => {
  it('null/undefined 不是文件型交付', () => {
    expect(isFileResultDelivery(undefined)).toBe(false);
    expect(isFileResultDelivery(null)).toBe(false);
  });

  it('带 elements 数组是内联结果卡，不是文件型', () => {
    expect(isFileResultDelivery({ messageId: 'om_1', elements: [{ tag: 'markdown' }] })).toBe(false);
    // coordinator 落库的 finalElements 载体同理
    expect(isFileResultDelivery({ elements: [] as unknown[] })).toBe(false);
  });

  it('elements 显式 undefined 是转存「执行结果.md」的文件消息', () => {
    expect(isFileResultDelivery({ messageId: 'om_1', elements: undefined })).toBe(true);
  });

  it('空对象（artifact-delivery 的文件/图片消息返回形状）判为文件型', () => {
    expect(isFileResultDelivery({ messageId: 'om_1', chatId: 'oc_1', replayed: false })).toBe(true);
  });
});
