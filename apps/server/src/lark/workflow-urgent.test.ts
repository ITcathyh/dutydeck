import { describe, expect, it, vi } from 'vitest';
import { LarkUrgentManager, type LarkUrgentNotice } from './workflow-urgent.js';
import type { LarkCardService } from './service.js';
import type { LarkInteraction } from './workflow-interactions.js';

function mockInteraction(overrides: Partial<LarkInteraction> = {}): LarkInteraction {
  return {
    appId: 'cli_test',
    sessionId: 'ses_1',
    taskId: 'task_1',
    turn: 1,
    id: 'req_1',
    boot: 'boot_1',
    kind: 'ask',
    nativeId: 'native_1',
    question: 'Please confirm',
    state: 'pending',
    cardId: 'om_card_1',
    updatedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 mins ago
    event: {
      messageId: 'om_trigger_1',
      chatId: 'oc_group_1',
      chatType: 'group',
      messageType: 'text',
      content: 'hi',
      senderOpenId: 'ou_target_person',
      mentions: []
    },
    ...overrides
  };
}

describe('LarkUrgentManager', () => {
  it('urges pending ask and permission cards that exceed the threshold', async () => {
    const service: Pick<LarkCardService, 'urgentApp'> = {
      urgentApp: vi.fn().mockResolvedValue({ invalidUserIdList: [] })
    };
    const manager = new LarkUrgentManager({ service });

    const askCard = mockInteraction({ id: 'ask_1', kind: 'ask', cardId: 'om_ask' });
    const permissionCard = mockInteraction({ id: 'perm_1', kind: 'permission', cardId: 'om_perm' });

    const result = await manager.checkAndUrge([askCard, permissionCard]);
    expect(result.urged).toEqual(['ask_1', 'perm_1']);
    expect(service.urgentApp).toHaveBeenCalledTimes(2);
    expect(service.urgentApp).toHaveBeenCalledWith({
      messageId: 'om_ask',
      userIdList: ['ou_target_person'],
      userIdType: 'open_id'
    });
    expect(service.urgentApp).toHaveBeenCalledWith({
      messageId: 'om_perm',
      userIdList: ['ou_target_person'],
      userIdType: 'open_id'
    });
  });

  it('ignores cards that are not pending or not ask/permission', async () => {
    const service: Pick<LarkCardService, 'urgentApp'> = {
      urgentApp: vi.fn()
    };
    const manager = new LarkUrgentManager({ service });

    const resultCard = mockInteraction({ id: 'res_1', kind: 'result', state: 'pending' });
    const answeredCard = mockInteraction({ id: 'ans_1', kind: 'ask', state: 'answered' });
    const approvedCard = mockInteraction({ id: 'app_1', kind: 'permission', state: 'approved' });
    const expiredCard = mockInteraction({ id: 'exp_1', kind: 'ask', state: 'expired' });
    const noCardId = mockInteraction({ id: 'no_card', kind: 'ask', state: 'pending', cardId: undefined });

    const result = await manager.checkAndUrge([resultCard, answeredCard, approvedCard, expiredCard, noCardId]);
    expect(result.urged).toEqual([]);
    expect(service.urgentApp).not.toHaveBeenCalled();
  });

  it('skips cards that have not reached the threshold (default 10 minutes)', async () => {
    const service: Pick<LarkCardService, 'urgentApp'> = {
      urgentApp: vi.fn()
    };
    const manager = new LarkUrgentManager({ service, thresholdMs: 10 * 60 * 1000 });

    const recentCard = mockInteraction({
      id: 'recent_1',
      updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() // 5 mins ago
    });

    const result = await manager.checkAndUrge([recentCard]);
    expect(result.urged).toEqual([]);
    expect(service.urgentApp).not.toHaveBeenCalled();
  });

  it('never urges the same card more than once (single urge per card)', async () => {
    const service: Pick<LarkCardService, 'urgentApp'> = {
      urgentApp: vi.fn().mockResolvedValue({ invalidUserIdList: [] })
    };
    const manager = new LarkUrgentManager({ service });

    const card = mockInteraction({ id: 'single_1', cardId: 'om_single' });

    // First check: should urge
    const first = await manager.checkAndUrge([card]);
    expect(first.urged).toEqual(['single_1']);
    expect(service.urgentApp).toHaveBeenCalledTimes(1);

    // Second check on the same card: must skip!
    const second = await manager.checkAndUrge([card]);
    expect(second.urged).toEqual([]);
    expect(service.urgentApp).toHaveBeenCalledTimes(1);

    // If card already has urgentAt set from previous run: must skip!
    const persistedUrgedCard = mockInteraction({
      id: 'persisted_1',
      urgentAt: new Date().toISOString()
    });
    const third = await manager.checkAndUrge([persistedUrgedCard]);
    expect(third.urged).toEqual([]);
    expect(service.urgentApp).toHaveBeenCalledTimes(1);
  });

  it('enforces per-chat hourly limit (default 3) and skips excess without throwing', async () => {
    const service: Pick<LarkCardService, 'urgentApp'> = {
      urgentApp: vi.fn().mockResolvedValue({ invalidUserIdList: [] })
    };
    const warn = vi.fn();
    const manager = new LarkUrgentManager({
      service,
      maxPerHourPerChat: 3,
      log: { warn }
    });

    const chatCards = [
      mockInteraction({ id: 'c1', cardId: 'om_1', event: { ...mockInteraction().event, chatId: 'oc_crowded' } }),
      mockInteraction({ id: 'c2', cardId: 'om_2', event: { ...mockInteraction().event, chatId: 'oc_crowded' } }),
      mockInteraction({ id: 'c3', cardId: 'om_3', event: { ...mockInteraction().event, chatId: 'oc_crowded' } }),
      mockInteraction({ id: 'c4', cardId: 'om_4', event: { ...mockInteraction().event, chatId: 'oc_crowded' } }),
      mockInteraction({ id: 'c5', cardId: 'om_5', event: { ...mockInteraction().event, chatId: 'oc_crowded' } })
    ];

    const result = await manager.checkAndUrge(chatCards);
    // First 3 should succeed
    expect(result.urged).toEqual(['c1', 'c2', 'c3']);
    // 4th and 5th should be rate-limited
    expect(result.skippedRateLimited).toEqual(['c4', 'c5']);
    expect(service.urgentApp).toHaveBeenCalledTimes(3);
    // Warn log should record rate limit hit
    expect(warn).toHaveBeenCalled();
  });

  it('constrains hourly rate limit after restart when historical interactions with urgentAt within 1 hour are provided', async () => {
    const service: Pick<LarkCardService, 'urgentApp'> = {
      urgentApp: vi.fn().mockResolvedValue({ invalidUserIdList: [] })
    };
    const warn = vi.fn();
    // Fresh manager with empty in-memory state (simulating process restart)
    const manager = new LarkUrgentManager({
      service,
      maxPerHourPerChat: 3,
      log: { warn }
    });

    const now = Date.now();
    // 3 historical interactions urged 20 minutes ago in the same chat
    const historicalCards = [
      mockInteraction({
        id: 'hist_1',
        cardId: 'om_h1',
        urgentAt: new Date(now - 20 * 60 * 1000).toISOString(),
        event: { ...mockInteraction().event, chatId: 'oc_restart_chat' }
      }),
      mockInteraction({
        id: 'hist_2',
        cardId: 'om_h2',
        urgentAt: new Date(now - 15 * 60 * 1000).toISOString(),
        event: { ...mockInteraction().event, chatId: 'oc_restart_chat' }
      }),
      mockInteraction({
        id: 'hist_3',
        cardId: 'om_h3',
        urgentAt: new Date(now - 10 * 60 * 1000).toISOString(),
        event: { ...mockInteraction().event, chatId: 'oc_restart_chat' }
      })
    ];

    // 2 new pending cards that exceed 10-minute threshold in the same chat
    const newPendingCards = [
      mockInteraction({
        id: 'new_1',
        cardId: 'om_n1',
        updatedAt: new Date(now - 12 * 60 * 1000).toISOString(),
        event: { ...mockInteraction().event, chatId: 'oc_restart_chat' }
      }),
      mockInteraction({
        id: 'new_2',
        cardId: 'om_n2',
        updatedAt: new Date(now - 12 * 60 * 1000).toISOString(),
        event: { ...mockInteraction().event, chatId: 'oc_restart_chat' }
      })
    ];

    // Passing historical + new cards:
    // Window should be rebuilt from the 3 historical urgentAt timestamps,
    // so the 2 new pending cards must be rate-limited and NOT urged!
    const result = await manager.checkAndUrge([...historicalCards, ...newPendingCards], now);
    expect(result.urged).toEqual([]);
    expect(result.skippedRateLimited).toEqual(['new_1', 'new_2']);
    expect(service.urgentApp).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    // Partial capacity scenario: if only 2 historical cards were urged within 1 hour,
    // exactly 1 new card is allowed and the 2nd is rate-limited.
    const service2: Pick<LarkCardService, 'urgentApp'> = {
      urgentApp: vi.fn().mockResolvedValue({ invalidUserIdList: [] })
    };
    const manager2 = new LarkUrgentManager({
      service: service2,
      maxPerHourPerChat: 3
    });

    const pendingForPartial = [
      mockInteraction({
        id: 'new_p1',
        cardId: 'om_np1',
        updatedAt: new Date(now - 12 * 60 * 1000).toISOString(),
        event: { ...mockInteraction().event, chatId: 'oc_restart_chat' }
      }),
      mockInteraction({
        id: 'new_p2',
        cardId: 'om_np2',
        updatedAt: new Date(now - 12 * 60 * 1000).toISOString(),
        event: { ...mockInteraction().event, chatId: 'oc_restart_chat' }
      })
    ];

    const resultPartial = await manager2.checkAndUrge([historicalCards[0]!, historicalCards[1]!, ...pendingForPartial], now);
    expect(resultPartial.urged).toEqual(['new_p1']);
    expect(resultPartial.skippedRateLimited).toEqual(['new_p2']);
    expect(service2.urgentApp).toHaveBeenCalledTimes(1);

    // Old history scenario: historical cards older than 1 hour do not occupy the window
    const service3: Pick<LarkCardService, 'urgentApp'> = {
      urgentApp: vi.fn().mockResolvedValue({ invalidUserIdList: [] })
    };
    const manager3 = new LarkUrgentManager({
      service: service3,
      maxPerHourPerChat: 3
    });
    const expiredHistoryCards = [
      mockInteraction({
        id: 'old_1',
        cardId: 'om_old1',
        urgentAt: new Date(now - 70 * 60 * 1000).toISOString(), // 70 mins ago (> 1 hour)
        event: { ...mockInteraction().event, chatId: 'oc_restart_chat' }
      }),
      mockInteraction({
        id: 'old_2',
        cardId: 'om_old2',
        urgentAt: new Date(now - 80 * 60 * 1000).toISOString(), // 80 mins ago
        event: { ...mockInteraction().event, chatId: 'oc_restart_chat' }
      }),
      mockInteraction({
        id: 'old_3',
        cardId: 'om_old3',
        urgentAt: new Date(now - 90 * 60 * 1000).toISOString(), // 90 mins ago
        event: { ...mockInteraction().event, chatId: 'oc_restart_chat' }
      })
    ];

    const pendingForExpired = [
      mockInteraction({
        id: 'new_e1',
        cardId: 'om_ne1',
        updatedAt: new Date(now - 12 * 60 * 1000).toISOString(),
        event: { ...mockInteraction().event, chatId: 'oc_restart_chat' }
      }),
      mockInteraction({
        id: 'new_e2',
        cardId: 'om_ne2',
        updatedAt: new Date(now - 12 * 60 * 1000).toISOString(),
        event: { ...mockInteraction().event, chatId: 'oc_restart_chat' }
      })
    ];

    const resultExpired = await manager3.checkAndUrge([...expiredHistoryCards, ...pendingForExpired], now);
    expect(resultExpired.urged).toEqual(['new_e1', 'new_e2']);
    expect(resultExpired.skippedRateLimited).toEqual([]);
    expect(service3.urgentApp).toHaveBeenCalledTimes(2);
  });

  it('targets only the specific person who needs to answer, not everyone', async () => {
    const service: Pick<LarkCardService, 'urgentApp'> = {
      urgentApp: vi.fn().mockResolvedValue({ invalidUserIdList: [] })
    };
    const manager = new LarkUrgentManager({ service });

    const card = mockInteraction({
      id: 'targeted_1',
      cardId: 'om_card',
      event: {
        ...mockInteraction().event,
        senderOpenId: 'ou_requester_only'
      }
    });

    await manager.checkAndUrge([card]);
    expect(service.urgentApp).toHaveBeenCalledWith(expect.objectContaining({
      userIdList: ['ou_requester_only']
    }));

    // If senderOpenId is missing, should not urge anyone
    const cardWithoutUser = mockInteraction({
      id: 'no_user_1',
      event: {
        ...mockInteraction().event,
        senderOpenId: undefined
      }
    });
    const resultNoUser = await manager.checkAndUrge([cardWithoutUser]);
    expect(resultNoUser.urged).toEqual([]);
  });

  it('fails safely without throwing when urgentApp API call fails', async () => {
    const service: Pick<LarkCardService, 'urgentApp'> = {
      urgentApp: vi.fn().mockRejectedValue(new Error('upstream 502 Bad Gateway'))
    };
    const warn = vi.fn();
    const manager = new LarkUrgentManager({ service, log: { warn } });

    const card = mockInteraction({ id: 'failing_1', cardId: 'om_fail' });

    // Must not throw
    const result = await manager.checkAndUrge([card]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.id).toBe('failing_1');
    expect(result.urged).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe('并发加急预占', () => {
  const now = Date.UTC(2026, 9, 22, 4);
  const pending = (id = 'ask_1', chatId = 'oc_group_1') => mockInteraction({
    id, cardId: `om_${id}`, cardCreatedAt: new Date(now - 120_000).toISOString(),
    event: { ...mockInteraction().event, chatId }
  });
  const notice = (id = 'notice_1', chatId = 'oc_group_1'): LarkUrgentNotice => ({
    id, chatId, messageId: `om_${id}`, targetUserId: 'ou_target_person', since: now - 120_000
  });
  const setup = () => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const urgentApp = vi.fn().mockResolvedValue({ invalidUserIdList: [] }).mockImplementationOnce(async () => {
      await gate;
      return { invalidUserIdList: [] };
    });
    const manager = new LarkUrgentManager({ service: { urgentApp }, thresholdMs: 60_000, maxPerHourPerChat: 1 });
    return { manager, urgentApp, resolve, reject };
  };

  it('同卡独立副本在响应前只出站一次，成功后旧副本仍不能重发', async () => {
    const { manager, urgentApp, resolve } = setup();
    const card = pending();
    const first = manager.checkAndUrge([structuredClone(card)], now);
    const second = manager.checkAndUrge([structuredClone(card)], now);
    const outboundBeforeResponse = urgentApp.mock.calls.length;
    resolve();
    const [sent, skipped] = await Promise.all([first, second]);
    expect(outboundBeforeResponse).toBe(1);
    expect(sent.urged).toEqual([card.id]);
    expect(skipped.skippedNotEligible).toEqual([card.id]);
    expect((await manager.checkAndUrge([structuredClone(card)], now)).skippedNotEligible).toEqual([card.id]);
    expect(urgentApp).toHaveBeenCalledOnce();
  });

  it('同群不同卡共享在途名额，另一轮清理历史后成功记录仍占频控', async () => {
    const { manager, urgentApp, resolve } = setup();
    const first = manager.checkAndUrge([pending()], now);
    const second = manager.checkAndUrge([pending('ask_2')], now);
    await manager.checkAndUrge([], now);
    const outboundBeforeResponse = urgentApp.mock.calls.length;
    resolve();
    const [sent, limited] = await Promise.all([first, second]);
    expect(outboundBeforeResponse).toBe(1);
    expect(sent.urged).toEqual(['ask_1']);
    expect(limited.skippedRateLimited).toEqual(['ask_2']);
    expect((await manager.checkAndUrge([pending('ask_3')], now)).skippedRateLimited).toEqual(['ask_3']);
    expect(urgentApp).toHaveBeenCalledOnce();
  });

  it('不同群的加急不等待另一群的远程响应', async () => {
    const { manager, urgentApp, resolve } = setup();
    const first = manager.checkAndUrge([pending()], now);
    const other = await manager.checkAndUrge([pending('ask_2', 'oc_other')], now);
    const outboundBeforeResponse = urgentApp.mock.calls.length;
    resolve();
    await first;
    expect(other.urged).toEqual(['ask_2']);
    expect(outboundBeforeResponse).toBe(2);
  });

  it('失败释放卡片和群名额，同卡旧副本能重试', async () => {
    const { manager, urgentApp, reject } = setup();
    const card = pending();
    const first = manager.checkAndUrge([structuredClone(card)], now);
    const skipped = manager.checkAndUrge([structuredClone(card)], now);
    reject(new Error('temporary failure'));
    const [failed, duplicate] = await Promise.all([first, skipped]);
    expect(failed.failed.map(item => item.id)).toEqual([card.id]);
    expect(duplicate.skippedNotEligible).toEqual([card.id]);
    expect(card.urgentAt).toBeUndefined();
    expect((await manager.checkAndUrge([structuredClone(card)], now)).urged).toEqual([card.id]);
    expect(urgentApp).toHaveBeenCalledTimes(2);
  });

  it.each(['interaction', 'notice'] as const)('%s 先出站时，两种 API 共享同群在途和成功名额', async firstApi => {
    const { manager, urgentApp, resolve } = setup();
    const first = firstApi === 'interaction'
      ? manager.checkAndUrge([pending()], now)
      : manager.urgeNotice(notice(), 'unknown_task_notice', now);
    const second = firstApi === 'interaction'
      ? manager.urgeNotice(notice(), 'unknown_task_notice', now)
      : manager.checkAndUrge([pending()], now);
    const outboundBeforeResponse = urgentApp.mock.calls.length;
    resolve();
    const [, limited] = await Promise.all([first, second]);
    expect(outboundBeforeResponse).toBe(1);
    if (typeof limited === 'string') expect(limited).toBe('rate_limited');
    else expect(limited.skippedRateLimited).toEqual(['ask_1']);
    expect((await manager.checkAndUrge([pending('ask_2')], now)).skippedRateLimited).toEqual(['ask_2']);
    expect(await manager.urgeNotice(notice('notice_2'), 'unknown_task_notice', now)).toBe('rate_limited');
    expect(urgentApp).toHaveBeenCalledOnce();
  });

  it('提醒卡独立副本在途与成功后均去重，并保留被扫描清理过的群历史', async () => {
    const { manager, urgentApp, resolve } = setup();
    const first = manager.urgeNotice(notice(), 'unknown_task_notice', now);
    const second = manager.urgeNotice(notice(), 'unknown_task_notice', now);
    await manager.checkAndUrge([], now);
    const outboundBeforeResponse = urgentApp.mock.calls.length;
    resolve();
    expect(await Promise.all([first, second])).toEqual(['urged', 'already']);
    expect(outboundBeforeResponse).toBe(1);
    expect(await manager.urgeNotice(notice(), 'unknown_task_notice', now)).toBe('already');
    expect(await manager.urgeNotice(notice('notice_2'), 'unknown_task_notice', now)).toBe('rate_limited');
    expect(urgentApp).toHaveBeenCalledOnce();
  });

  it('提醒卡失败释放预占，旧副本重试成功后占用共享群名额', async () => {
    const { manager, urgentApp, reject } = setup();
    const first = manager.urgeNotice(notice(), 'unknown_task_notice', now);
    reject(new Error('temporary failure'));
    expect(await first).toBe('failed');
    expect(await manager.urgeNotice(notice(), 'unknown_task_notice', now)).toBe('urged');
    expect((await manager.checkAndUrge([pending()], now)).skippedRateLimited).toEqual(['ask_1']);
    expect(urgentApp).toHaveBeenCalledTimes(2);
  });

  it('重启后两种 API 从持久历史恢复共享频控，过期后释放名额但不重发旧卡', async () => {
    const urgentApp = vi.fn().mockResolvedValue({ invalidUserIdList: [] });
    const options = { service: { urgentApp }, thresholdMs: 60_000, maxPerHourPerChat: 1 };
    const persisted = { ...pending(), urgentAt: new Date(now - 60_000).toISOString() };
    const fromInteraction = new LarkUrgentManager(options);
    await fromInteraction.checkAndUrge([structuredClone(persisted)], now);
    await fromInteraction.checkAndUrge([structuredClone(persisted)], now);
    expect(await fromInteraction.urgeNotice(notice(), 'unknown_task_notice', now)).toBe('rate_limited');
    const later = now + 3600_000;
    expect((await fromInteraction.checkAndUrge([structuredClone(persisted), pending('ask_2')], later)).urged).toEqual(['ask_2']);
    const fromNotice = new LarkUrgentManager(options);
    const persistedNotice = { ...notice(), urgentAt: new Date(now - 60_000).toISOString() };
    expect(await fromNotice.urgeNotice(persistedNotice, 'unknown_task_notice', now)).toBe('already');
    expect((await fromNotice.checkAndUrge([pending()], now)).skippedRateLimited).toEqual(['ask_1']);
    expect(urgentApp).toHaveBeenCalledOnce();
  });
});

describe('LarkUrgentManager 时间戳不可解析时的方向', () => {
  it('卡片时间无法解析时按跳过处理，绝不绕过超时阈值直接发强提醒', async () => {
    const service: Pick<LarkCardService, 'urgentApp'> = {
      urgentApp: vi.fn().mockResolvedValue({ invalidUserIdList: [] })
    };
    const manager = new LarkUrgentManager({ service });

    // cardCreatedAt / updatedAt 都不可解析：无法证明这张卡已经超过阈值，
    // 就不能发加急——加急是飞书里的强提醒横幅，判据不成立时必须让路。
    const unparsable = mockInteraction({ id: 'bad_time_1', cardId: 'om_bad_time', cardCreatedAt: 'not-a-date', updatedAt: 'not-a-date' });
    const result = await manager.checkAndUrge([unparsable]);
    expect(result.urged).toEqual([]);
    expect(result.skippedNotEligible).toEqual(['bad_time_1']);
    expect(service.urgentApp).not.toHaveBeenCalled();
  });

  it('时间戳为空串时同样跳过，不回落成立即加急', async () => {
    const service: Pick<LarkCardService, 'urgentApp'> = {
      urgentApp: vi.fn().mockResolvedValue({ invalidUserIdList: [] })
    };
    const manager = new LarkUrgentManager({ service });
    const broken = mockInteraction({ id: 'bad_time_2', cardId: 'om_bad_time_2', cardCreatedAt: '', updatedAt: '' });
    const result = await manager.checkAndUrge([broken]);
    expect(result.urged).toEqual([]);
    expect(service.urgentApp).not.toHaveBeenCalled();
  });
});

describe('免打扰时段内的加急', () => {
  /** 本地时区的时刻；免打扰时段按 daemon 本地时区判定。 */
  const at = (hour: number, minute = 0, day = 13) => new Date(2026, 9, day, hour, minute, 0, 0).getTime();
  const pending = (createdAt: number, overrides: Partial<LarkInteraction> = {}) =>
    mockInteraction({ cardCreatedAt: new Date(createdAt).toISOString(), ...overrides });
  const service = () => ({ urgentApp: vi.fn().mockResolvedValue({ invalidUserIdList: [] }) }) as Pick<LarkCardService, 'urgentApp'> & { urgentApp: ReturnType<typeof vi.fn> };

  it('时段内超时的卡不加急、不消耗频控，时段结束后的第一次检查补发，只发一次', async () => {
    const svc = service();
    const manager = new LarkUrgentManager({ service: svc, quietHours: '22:00-08:00', maxPerHourPerChat: 1 });
    const ask = pending(at(22, 30), { id: 'ask_night', kind: 'ask', cardId: 'om_ask' });

    for (const when of [at(23, 0), at(3, 0, 14), at(7, 59, 14)]) {
      const result = await manager.checkAndUrge([ask], when);
      expect(result.skippedQuietHours).toEqual(['ask_night']);
      expect(result.urged).toEqual([]);
    }
    expect(svc.urgentApp).not.toHaveBeenCalled();
    expect(ask.urgentAt).toBeUndefined();

    const resumed = await manager.checkAndUrge([ask], at(8, 0, 14));
    expect(resumed.urged).toEqual(['ask_night']);
    expect(resumed.skippedQuietHours).toEqual([]);
    expect(svc.urgentApp).toHaveBeenCalledOnce();
    expect(ask.urgentAt).toBe(new Date(at(8, 0, 14)).toISOString());

    const again = await manager.checkAndUrge([ask], at(8, 5, 14));
    expect(again.urged).toEqual([]);
    expect(svc.urgentApp).toHaveBeenCalledOnce();
  });

  it('审批卡同样推迟；时段外超时照常立刻加急', async () => {
    const svc = service();
    const manager = new LarkUrgentManager({ service: svc, quietHours: '22:00-08:00' });
    const permission = pending(at(21, 0), { id: 'perm_1', kind: 'permission', cardId: 'om_perm' });
    expect((await manager.checkAndUrge([permission], at(22, 10))).skippedQuietHours).toEqual(['perm_1']);

    const day = pending(at(10, 0), { id: 'perm_day', kind: 'permission', cardId: 'om_day' });
    expect((await manager.checkAndUrge([day], at(10, 30))).urged).toEqual(['perm_day']);
    expect(svc.urgentApp).toHaveBeenCalledOnce();
  });

  it('未配置免打扰时段时夜里照常加急', async () => {
    const svc = service();
    const manager = new LarkUrgentManager({ service: svc });
    const result = await manager.checkAndUrge([pending(at(22, 30), { id: 'ask_1', cardId: 'om_ask' })], at(23, 0));
    expect(result.urged).toEqual(['ask_1']);
    expect(result.skippedQuietHours).toEqual([]);
  });

  it('urgeNotice：阈值、免打扰、每张卡一次、持久化的 urgentAt、每群频控', async () => {
    const svc = service();
    const manager = new LarkUrgentManager({ service: svc, quietHours: '22:00-08:00', thresholdMs: 10 * 60_000, maxPerHourPerChat: 1 });
    const notice = { id: 'unknown_1', chatId: 'oc_group_1', messageId: 'om_notice', targetUserId: 'ou_target_person', since: at(21, 50) };

    expect(await manager.urgeNotice(notice, 'unknown_task_notice', at(21, 55))).toBe('not_due');
    expect(await manager.urgeNotice(notice, 'unknown_task_notice', at(22, 30))).toBe('quiet_hours');
    expect(await manager.urgeNotice(notice, 'result', at(9, 0, 14))).toBe('not_eligible');
    expect(svc.urgentApp).not.toHaveBeenCalled();

    expect(await manager.urgeNotice(notice, 'unknown_task_notice', at(8, 0, 14))).toBe('urged');
    expect(svc.urgentApp).toHaveBeenCalledWith({ messageId: 'om_notice', userIdList: ['ou_target_person'], userIdType: 'open_id' });
    expect(await manager.urgeNotice(notice, 'unknown_task_notice', at(8, 1, 14))).toBe('already');

    // 同一小时内同群再来一张：频控挡住；重启后带着持久化的 urgentAt 回来也不会重发。
    expect(await manager.urgeNotice({ ...notice, id: 'unknown_2', messageId: 'om_notice_2' }, 'unknown_task_notice', at(8, 2, 14))).toBe('rate_limited');
    const restarted = new LarkUrgentManager({ service: svc, quietHours: '22:00-08:00' });
    expect(await restarted.urgeNotice({ ...notice, urgentAt: new Date(at(8, 0, 14)).toISOString() }, 'unknown_task_notice', at(9, 0, 14))).toBe('already');
    expect(svc.urgentApp).toHaveBeenCalledOnce();

    svc.urgentApp.mockRejectedValueOnce(new Error('boom'));
    expect(await new LarkUrgentManager({ service: svc }).urgeNotice({ ...notice, id: 'unknown_3' }, 'unknown_task_notice', at(22, 30))).toBe('failed');
  });
});
