import { describe, expect, it } from 'vitest';
import { larkNotice, larkQuietHoursEndAt, parseLarkQuietHours, type LarkNoticeKind, type LarkNoticeTier } from './notify-tier.js';

const group = { chatType: 'group', senderOpenId: 'ou_alice', senderType: 'user' };
const on = { groupCardMention: true };
/** 本地时区的时刻，免打扰时段按 daemon 本地时区判定，测试不依赖机器时区。 */
const at = (hour: number, minute = 0, day = 13) => new Date(2026, 9, day, hour, minute, 0, 0).getTime();

describe('出站消息分档', () => {
  const expected: Record<LarkNoticeKind, LarkNoticeTier> = {
    permission_card: 'action', ask_card: 'action', unknown_task_notice: 'action', task_recovery_notice: 'action',
    result: 'done', failure_receipt: 'done',
    progress: 'info', status: 'info'
  };

  it.each(Object.entries(expected))('%s 落在 %s 档', (kind, tier) => {
    expect(larkNotice(kind as LarkNoticeKind, on, group).tier).toBe(tier);
  });

  it('默认配置：需要你操作与完成两档 @ 发起人，信息档不 @；只有需要你操作的可加急', () => {
    expect(larkNotice('permission_card', on, group)).toMatchObject({ mention: '<at id=ou_alice></at>', mentionAllowed: true, urgent: true });
    expect(larkNotice('ask_card', on, group)).toMatchObject({ mention: '<at id=ou_alice></at>', urgent: true });
    expect(larkNotice('unknown_task_notice', on, group)).toMatchObject({ mention: '<at id=ou_alice></at>', urgent: true });
    expect(larkNotice('result', on, group)).toMatchObject({ mention: '<at id=ou_alice></at>', urgent: false });
    expect(larkNotice('failure_receipt', on, group)).toMatchObject({ mention: '<at id=ou_alice></at>', urgent: false });
    expect(larkNotice('progress', on, group)).toMatchObject({ mentionAllowed: false, urgent: false });
    expect(larkNotice('status', on, group).mention).toBeUndefined();
  });

  it('两档开关各管各的，总开关关闭则全部不 @', () => {
    const noDone = { ...on, notifyMentionDone: false };
    expect(larkNotice('result', noDone, group).mention).toBeUndefined();
    expect(larkNotice('permission_card', noDone, group).mention).toBeDefined();
    const noAction = { ...on, notifyMentionAction: false };
    expect(larkNotice('permission_card', noAction, group).mention).toBeUndefined();
    expect(larkNotice('unknown_task_notice', noAction, group).mention).toBeUndefined();
    expect(larkNotice('result', noAction, group).mention).toBeDefined();
    // 关掉 @ 不影响加急：加急走自己的开关。
    expect(larkNotice('permission_card', noAction, group).urgent).toBe(true);
    expect(larkNotice('result', { groupCardMention: false }, group).mention).toBeUndefined();
    expect(larkNotice('permission_card', {}, group).mention).toBeUndefined();
  });

  it('私聊、机器人发起人、非法 open_id 不 @', () => {
    expect(larkNotice('result', on, { ...group, chatType: 'p2p' }).mention).toBeUndefined();
    expect(larkNotice('permission_card', on, { ...group, chatType: 'p2p' }).mentionAllowed).toBe(false);
    expect(larkNotice('result', on, { ...group, senderType: 'app' }).mention).toBeUndefined();
    expect(larkNotice('result', on, { ...group, senderOpenId: 'ou_x"><at id=all>' }).mention).toBeUndefined();
    expect(larkNotice('result', on).mention).toBeUndefined();
  });
});

describe('免打扰时段', () => {
  it('解析 HH:MM-HH:MM，起止相同或格式不对视为无效', () => {
    expect(parseLarkQuietHours('22:00-08:00')).toEqual({ start: 1320, end: 480 });
    expect(parseLarkQuietHours(' 09:30-18:00 ')).toEqual({ start: 570, end: 1080 });
    for (const bad of ['22:00-22:00', '24:00-08:00', '22:60-08:00', '8:00-9:00', '22:00', '22:00~08:00', '', undefined]) expect(parseLarkQuietHours(bad)).toBeUndefined();
  });

  it('跨零点：起点含、终点不含，结束时刻落在次日或当天', () => {
    const quiet = '22:00-08:00';
    expect(larkQuietHoursEndAt(quiet, at(21, 59))).toBeUndefined();
    expect(larkQuietHoursEndAt(quiet, at(22, 0))).toBe(at(8, 0, 14));
    expect(larkQuietHoursEndAt(quiet, at(23, 30))).toBe(at(8, 0, 14));
    expect(larkQuietHoursEndAt(quiet, at(0, 0))).toBe(at(8, 0, 13));
    expect(larkQuietHoursEndAt(quiet, at(7, 59))).toBe(at(8, 0, 13));
    expect(larkQuietHoursEndAt(quiet, at(8, 0))).toBeUndefined();
  });

  it('不跨零点的时段同样成立，未配置时永不免打扰', () => {
    expect(larkQuietHoursEndAt('12:00-14:00', at(13, 0))).toBe(at(14, 0));
    expect(larkQuietHoursEndAt('12:00-14:00', at(14, 0))).toBeUndefined();
    expect(larkQuietHoursEndAt(undefined, at(3, 0))).toBeUndefined();
  });

  it('时段内只有需要你操作仍 @，完成档不 @，加急推迟到时段结束；时段外一切照旧', () => {
    const settings = { ...on, notifyQuietHours: '22:00-08:00' };
    const night = at(23, 0);
    expect(larkNotice('permission_card', settings, group, night)).toMatchObject({ mention: '<at id=ou_alice></at>', urgent: true, urgentNotBefore: at(8, 0, 14) });
    expect(larkNotice('unknown_task_notice', settings, group, night).mention).toBeDefined();
    expect(larkNotice('result', settings, group, night)).toMatchObject({ mentionAllowed: false });
    expect(larkNotice('result', settings, group, night).mention).toBeUndefined();
    expect(larkNotice('failure_receipt', settings, group, night).mention).toBeUndefined();
    expect(larkNotice('progress', settings, group, night).mention).toBeUndefined();
    expect(larkNotice('result', settings, group, night).urgentNotBefore).toBeUndefined();

    const day = at(10, 0);
    expect(larkNotice('result', settings, group, day).mention).toBeDefined();
    expect(larkNotice('permission_card', settings, group, day).urgentNotBefore).toBeUndefined();
  });
});
