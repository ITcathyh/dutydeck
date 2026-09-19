import { describe, expect, it, vi } from 'vitest';
import { LarkUrgentManager } from './workflow-urgent.js';
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
