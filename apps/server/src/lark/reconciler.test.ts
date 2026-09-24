import { describe, expect, it, vi } from 'vitest';
import type { ChannelMapping, TaskRecord } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import type { StoredLarkConfig } from './config.js';
import type { PersistedLarkCardTask } from './coordinator.js';
import { performLarkCardReconcile } from './reconciler.js';
import { COMPLETION_REACTION_EMOJI } from './reaction-records.js';

const config: StoredLarkConfig = {
  appId: 'cli_test', appSecret: 'secret', workspace: '/workspace', defaultAgentId: 'codex',
  fullTrustConfirmed: true, listening: true, preInjectPrompt: '',
  groupToolsEnabled: false, groupToolsAllowSend: false,
  pushIntervalMs: 1_000, hideTraceOnComplete: false,
  allowedUsers: [], allowedEmails: [], highRiskAllowedUsers: [], highRiskAllowedEmails: [],
  highRiskPattern: 'rm\\b', riskControlMode: 'off'
};

const createMapping = (id: string, externalId: string, sessionId: string, task: Partial<PersistedLarkCardTask>): ChannelMapping => {
  const startedAt = Date.now() - 5_000;
  const persisted: PersistedLarkCardTask = {
    app_id: 'cli_test',
    chat_id: 'oc_test_chat',
    card_message_id: `om_card_${externalId}`,
    task_name: `Task ${externalId}`,
    prompt: `Prompt ${externalId}`,
    state: 'running',
    started_at: startedAt,
    ...task
  };
  return {
    id,
    channel: 'lark-card:cli_test',
    externalId,
    sessionId,
    createdAt: new Date(startedAt).toISOString(),
    extra: JSON.stringify(persisted)
  };
};

const createMemoryChannelMappingRepo = (initialMappings: ChannelMapping[] = []) => {
  const mappings = initialMappings.map(m => ({ ...m }));
  return {
    mappings,
    list: vi.fn(async () => mappings.map(m => ({ ...m }))),
    get: vi.fn(async (channel: string, externalId: string) => mappings.find(m => m.channel === channel && m.externalId === externalId)),
    save: vi.fn(async (saved: ChannelMapping) => {
      const idx = mappings.findIndex(m => m.id === saved.id);
      if (idx >= 0) mappings[idx] = { ...saved };
      else mappings.push({ ...saved });
    }),
    compareAndSetExtra: vi.fn(async (id: string, expectedExtra: string | null | undefined, extra: string) => {
      const row = mappings.find(m => m.id === id);
      if (!row) return false;
      const current = row.extra ?? null;
      const expected = expectedExtra ?? null;
      if (current === expected) {
        row.extra = extra;
        return true;
      }
      return false;
    })
  };
};

describe('performLarkCardReconcile 异常边界与可靠性', () => {
  it('第一条已交付结果回调抛错，后续需要补偿的健康条目仍被处理', async () => {
    const startedAt = Date.now() - 5_000;
    const mapping1 = createMapping('map-1', 'msg-1', 'ses-1', {
      state: 'completed',
      final_delivery_state: 'delivered',
      final_message_id: 'om_final_1',
      progress_frozen: false
    });

    const runtimeTask2: TaskRecord = {
      id: 'task-2',
      sessionId: 'ses-2',
      prompt: 'Prompt msg-2',
      status: 'completed',
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString()
    };
    const mapping2 = createMapping('map-2', 'msg-2', 'ses-2', {
      runtime_task_id: runtimeTask2.id,
      state: 'running',
      progress_frozen: false
    });

    const cardMappings = createMemoryChannelMappingRepo([mapping1, mapping2]);

    const runtime = {
      getTasks: vi.fn(async (sessionId: string) => sessionId === 'ses-2' ? [runtimeTask2] : []),
      getEvents: vi.fn(async () => [{ id: 1, type: 'text', data: { text: '结果内容 2' } }])
    };

    const service = {
      update: vi.fn(async () => ({ messageId: 'om_card_msg-2' })),
      send: vi.fn(async () => ({ messageId: 'om_final_2', elements: [] }))
    };

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    const resultElements = vi.fn(async (mapping: ChannelMapping, _saved: PersistedLarkCardTask, cardId: string) => {
      if (mapping.id === 'map-1') {
        throw new Error('workflow store CAS conflict on mapping 1');
      }
      return [];
    });

    const unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test',
      resultElements
    });

    // 第一条失败计入 unresolved，且记录了 session 与 mapping 标识
    expect(unresolved).toBeGreaterThanOrEqual(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'ses-1',
        externalId: 'msg-1',
        error: expect.any(Error)
      }),
      expect.stringMatching(/对账单条卡片映射处理异常|已交付卡片结果回调处理失败/)
    );

    // 第二条健康条目正常完成补偿，过程卡被更新，独立结果消息被发送
    expect(service.update).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'om_card_msg-2',
        state: 'completed',
        readOnly: true,
        cardKind: 'process'
      })
    );
    expect(service.send).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'completed',
        readOnly: true,
        cardKind: 'result'
      })
    );

    // 第二条 mapping 的持久化状态已更新为 delivered
    const savedMapping2 = JSON.parse(cardMappings.mappings[1]!.extra);
    expect(savedMapping2).toMatchObject({
      final_delivery_state: 'delivered',
      final_message_id: 'om_final_2',
      state: 'completed',
      progress_frozen: true
    });
  });

  it('单条 mapping getTasks 异常不饿死后续健康条目', async () => {
    const startedAt = Date.now() - 5_000;
    const runtimeTask1: TaskRecord = {
      id: 'task-1',
      sessionId: 'ses-1',
      prompt: 'Prompt msg-1',
      status: 'completed',
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString()
    };
    const mapping1 = createMapping('map-1', 'msg-1', 'ses-1', {
      runtime_task_id: runtimeTask1.id,
      state: 'running'
    });

    const runtimeTask2: TaskRecord = {
      id: 'task-2',
      sessionId: 'ses-2',
      prompt: 'Prompt msg-2',
      status: 'completed',
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString()
    };
    const mapping2 = createMapping('map-2', 'msg-2', 'ses-2', {
      runtime_task_id: runtimeTask2.id,
      state: 'running'
    });

    const cardMappings = createMemoryChannelMappingRepo([mapping1, mapping2]);

    const runtime = {
      getTasks: vi.fn(async (sessionId: string) => {
        if (sessionId === 'ses-1') throw new Error('runtime getTasks database locked');
        return [runtimeTask2];
      }),
      getEvents: vi.fn(async () => [{ id: 1, type: 'text', data: { text: '结果内容 2' } }])
    };

    const service = {
      update: vi.fn(async () => ({ messageId: 'om_card_msg-2' })),
      send: vi.fn(async () => ({ messageId: 'om_final_2', elements: [] }))
    };

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });

    expect(unresolved).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'ses-1',
        externalId: 'msg-1'
      }),
      expect.stringContaining('读取待补偿飞书任务失败')
    );

    // 第二条正常补偿
    expect(service.send).toHaveBeenCalledTimes(1);
    const savedMapping2 = JSON.parse(cardMappings.mappings[1]!.extra);
    expect(savedMapping2.final_delivery_state).toBe('delivered');
  });

  it('单条 mapping save 异常不饿死后续健康条目', async () => {
    const startedAt = Date.now() - 5_000;
    const runtimeTask1: TaskRecord = {
      id: 'task-1', sessionId: 'ses-1', prompt: 'Prompt msg-1', status: 'completed',
      createdAt: new Date(startedAt).toISOString(), updatedAt: new Date().toISOString()
    };
    const mapping1 = createMapping('map-1', 'msg-1', 'ses-1', {
      runtime_task_id: runtimeTask1.id, state: 'running'
    });

    const runtimeTask2: TaskRecord = {
      id: 'task-2', sessionId: 'ses-2', prompt: 'Prompt msg-2', status: 'completed',
      createdAt: new Date(startedAt).toISOString(), updatedAt: new Date().toISOString()
    };
    const mapping2 = createMapping('map-2', 'msg-2', 'ses-2', {
      runtime_task_id: runtimeTask2.id, state: 'running'
    });

    const cardMappings = createMemoryChannelMappingRepo([mapping1, mapping2]);
    const origCas = cardMappings.compareAndSetExtra;
    cardMappings.compareAndSetExtra = vi.fn(async (id: string, expectedExtra: string | null | undefined, extra: string) => {
      if (id === 'map-1') {
        throw new Error('SQLite disk I/O error on map-1');
      }
      return origCas(id, expectedExtra, extra);
    });

    const runtime = {
      getTasks: vi.fn(async (sessionId: string) => sessionId === 'ses-1' ? [runtimeTask1] : [runtimeTask2]),
      getEvents: vi.fn(async () => [{ id: 1, type: 'text', data: { text: '结果内容' } }])
    };

    const service = {
      update: vi.fn(async () => ({ messageId: 'om_card' })),
      send: vi.fn(async () => ({ messageId: 'om_final', elements: [] }))
    };

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });

    expect(unresolved).toBeGreaterThanOrEqual(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'ses-1',
        externalId: 'msg-1'
      }),
      expect.stringMatching(/保存卡片映射对账状态失败|对账单条卡片映射处理/)
    );

    // 第二条成功保存
    const savedMapping2 = JSON.parse(cardMappings.mappings[1]!.extra);
    expect(savedMapping2.final_delivery_state).toBe('delivered');
    expect(savedMapping2.final_message_id).toBe('om_final');
  });

  it('顶层 list 整体不可用仍应抛出错误', async () => {
    const cardMappings = {
      list: vi.fn(async () => {
        throw new Error('Database connection lost');
      }),
      get: vi.fn(),
      save: vi.fn(),
      compareAndSetExtra: vi.fn()
    };

    const runtime = {
      getTasks: vi.fn(async () => []),
      getEvents: vi.fn(async () => [])
    };

    const service = { update: vi.fn(), send: vi.fn() };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    })).rejects.toThrow('Database connection lost');
  });

  it('成功路径不会重复交付（已冻结且已送达的条目无额外 API 调用）', async () => {
    const mapping = createMapping('map-done', 'msg-done', 'ses-done', {
      state: 'completed',
      final_delivery_state: 'delivered',
      final_message_id: 'om_already_delivered',
      progress_frozen: true
    });

    const cardMappings = createMemoryChannelMappingRepo([mapping]);

    const runtime = {
      getTasks: vi.fn(async () => []),
      getEvents: vi.fn(async () => [])
    };

    const service = { update: vi.fn(), send: vi.fn() };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });

    expect(unresolved).toBe(0);
    expect(service.update).not.toHaveBeenCalled();
    expect(service.send).not.toHaveBeenCalled();
    expect(cardMappings.save).not.toHaveBeenCalled();
    expect(cardMappings.compareAndSetExtra).not.toHaveBeenCalled();
  });

  it('结果发送成功但 resultElements 失败时持久化 final_message_id，下一轮对账重试回调且不重复发送结果消息', async () => {
    const startedAt = Date.now() - 5_000;
    const runtimeTask: TaskRecord = {
      id: 'task-retry',
      sessionId: 'ses-retry',
      prompt: 'Prompt retry',
      status: 'completed',
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString()
    };
    const mapping = createMapping('map-retry', 'msg-retry', 'ses-retry', {
      runtime_task_id: runtimeTask.id,
      state: 'running',
      progress_frozen: false
    });

    const cardMappings = createMemoryChannelMappingRepo([mapping]);

    const runtime = {
      getTasks: vi.fn(async () => [runtimeTask]),
      getEvents: vi.fn(async () => [{ id: 1, type: 'text', data: { text: '完成内容' } }])
    };

    const service = {
      update: vi.fn(async () => ({ messageId: 'om_card_msg-retry' })),
      send: vi.fn(async () => ({ messageId: 'om_final_retry', elements: [] }))
    };

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    let firstFinalMessageAttempt = true;
    let callbackAttempts = 0;
    const resultElements = vi.fn(async (_m: ChannelMapping, _saved: PersistedLarkCardTask, cardId: string) => {
      callbackAttempts++;
      // 首次对账阶段，当给 finalMessageId 调用时抛出异常
      if (cardId === 'om_final_retry' && firstFinalMessageAttempt) {
        firstFinalMessageAttempt = false;
        throw new Error('database lock during workflow result callback');
      }
      return [];
    });

    // 第一轮对账：结果消息发送成功，但结果回调失败
    const round1Unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test',
      resultElements
    });

    // 回调失败应计入 unresolved
    expect(round1Unresolved).toBe(1);
    expect(service.send).toHaveBeenCalledTimes(1);

    // 但 mapping 中已持久化 final_message_id 与 delivered 状态，保障不重复发送
    const persistedAfterRound1 = JSON.parse(cardMappings.mappings[0]!.extra);
    expect(persistedAfterRound1.final_delivery_state).toBe('delivered');
    expect(persistedAfterRound1.final_message_id).toBe('om_final_retry');

    // 第二轮对账（补偿重试）：进入 alreadyDelivered 分支，重试回调
    const round2Unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test',
      resultElements
    });

    // 结果消息没有重复发送（仍为 1 次）
    expect(service.send).toHaveBeenCalledTimes(1);

    // 第二轮对账完全收敛
    expect(round2Unresolved).toBe(0);
    expect(callbackAttempts).toBeGreaterThanOrEqual(2);
  });

  it('连续两轮对账遇到 230031 错误只 PATCH 一次并持久冻结，不再重复重试', async () => {
    let patchCalls = 0;
    const mapping = createMapping('map-expired', 'msg-expired', 'ses-expired', {
      state: 'completed',
      final_delivery_state: 'delivered',
      final_message_id: 'om_result_delivered',
      progress_frozen: false
    });

    const cardMappings = createMemoryChannelMappingRepo([mapping]);

    const runtime = {
      getTasks: vi.fn(async () => []),
      getEvents: vi.fn(async () => [])
    };

    const { LarkServiceError } = await import('./service.js');
    const service = {
      update: vi.fn(async () => {
        patchCalls++;
        throw new LarkServiceError('LARK_OPENAPI_ERROR', 'message update expired', 502, { upstreamCode: 230031 });
      }),
      send: vi.fn()
    };

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // 第一轮对账：PATCH 返回 230031，应识别为 permanent 不可更新，就地持久冻结
    const round1Unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });

    expect(round1Unresolved).toBe(0);
    expect(patchCalls).toBe(1);
    expect(cardMappings.compareAndSetExtra).toHaveBeenCalledTimes(1);
    const persistedAfterRound1 = JSON.parse(cardMappings.mappings[0]!.extra);
    expect(persistedAfterRound1.progress_frozen).toBe(true);

    // 第二轮对账：已持久冻结，不得再次 PATCH
    const round2Unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });

    expect(round2Unresolved).toBe(0);
    expect(patchCalls).toBe(1); // 断言只 PATCH 一次
  });

  it('运行态连续多轮：running 首次 230031 -> 落库 freeze -> 下轮 running 不 PATCH -> runtime completed 只交付一次独立 result、随后不重发', async () => {
    let patchCalls = 0;
    let sendCalls = 0;
    const startedAt = Date.now() - 5_000;
    let runtimeTask: TaskRecord = {
      id: 'task-run-multi',
      sessionId: 'ses-run-multi',
      prompt: 'Prompt run-multi',
      status: 'running',
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString()
    };

    const mapping = createMapping('map-run-multi', 'msg-run-multi', 'ses-run-multi', {
      runtime_task_id: runtimeTask.id,
      state: 'running',
      progress_frozen: false
    });

    const cardMappings = createMemoryChannelMappingRepo([mapping]);

    const runtime = {
      getTasks: vi.fn(async () => [runtimeTask]),
      getEvents: vi.fn(async () => [{ id: 1, type: 'text', data: { text: '完成结果' } }])
    };

    const { LarkServiceError } = await import('./service.js');
    const service = {
      update: vi.fn(async () => {
        patchCalls++;
        throw new LarkServiceError('LARK_OPENAPI_ERROR', 'message update expired', 502, { upstreamCode: 230031 });
      }),
      send: vi.fn(async () => {
        sendCalls++;
        return { messageId: 'om_final_result' };
      })
    };

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // 轮次 1：runtimeTask 为 running，PATCH 过程卡返回 230031 -> 应当落库 freeze，且 unresolved=1 保持继续轮询
    const round1 = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });
    expect(round1).toBe(1);
    expect(patchCalls).toBe(1);
    expect(sendCalls).toBe(0);
    expect(JSON.parse(cardMappings.mappings[0]!.extra).progress_frozen).toBe(true);

    // 轮次 2：runtimeTask 仍为 running -> 不再 PATCH 过程卡，保持 unresolved=1 轮询
    const round2 = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });
    expect(round2).toBe(1);
    expect(patchCalls).toBe(1); // 未再发起 PATCH！
    expect(sendCalls).toBe(0);

    // 轮次 3：runtimeTask 变为 completed -> 终态对账：过程卡因为 progress_frozen 不再 PATCH，直接交付独立结果
    runtimeTask = { ...runtimeTask, status: 'completed', updatedAt: new Date().toISOString() };
    const round3 = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });
    expect(round3).toBe(0);
    expect(patchCalls).toBe(1); // 过程卡仍未被 PATCH
    expect(sendCalls).toBe(1); // 独立结果卡发送 1 次
    const extraAfterComplete = JSON.parse(cardMappings.mappings[0]!.extra);
    expect(extraAfterComplete.final_delivery_state).toBe('delivered');
    expect(extraAfterComplete.final_message_id).toBe('om_final_result');
    expect(extraAfterComplete.progress_frozen).toBe(true);

    // 轮次 4：后续例行对账 -> 过程卡不 PATCH，结果卡不重发，彻底收敛
    const round4 = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });
    expect(round4).toBe(0);
    expect(patchCalls).toBe(1);
    expect(sendCalls).toBe(1);
  });

  it('初始 mapping 已有 progress_frozen 但 runtime 仍 running 的重启入口：跳过过程卡 PATCH 但保持 unresolved 轮询', async () => {
    let patchCalls = 0;
    const startedAt = Date.now() - 5_000;
    const runtimeTask: TaskRecord = {
      id: 'task-frozen-running',
      sessionId: 'ses-frozen-running',
      prompt: 'Prompt frozen-running',
      status: 'running',
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString()
    };

    const mapping = createMapping('map-frozen-running', 'msg-frozen-running', 'ses-frozen-running', {
      runtime_task_id: runtimeTask.id,
      state: 'running',
      progress_frozen: true // 初始已冻结
    });

    const cardMappings = createMemoryChannelMappingRepo([mapping]);

    const runtime = {
      getTasks: vi.fn(async () => [runtimeTask]),
      getEvents: vi.fn(async () => [])
    };

    const service = {
      update: vi.fn(async () => {
        patchCalls++;
        return { messageId: 'om_card' };
      }),
      send: vi.fn()
    };

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });

    expect(unresolved).toBe(1); // 保持轮询状态，不全局跳过任务
    expect(patchCalls).toBe(0); // 过程卡绝不被 PATCH！
    expect(service.send).not.toHaveBeenCalled();
  });

  it('非终态对账写回冻结前做 CAS 与轮次检查：外部并发已修改时放弃写入旧 mapping', async () => {
    const startedAt = Date.now() - 5_000;
    let runtimeTask: TaskRecord = {
      id: 'task-cas',
      sessionId: 'ses-cas',
      prompt: 'Prompt cas',
      status: 'running',
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString()
    };

    const mapping = createMapping('map-cas', 'msg-cas', 'ses-cas', {
      runtime_task_id: runtimeTask.id,
      state: 'running',
      turn: 1,
      card_message_id: 'om_card_turn1',
      progress_frozen: false
    });

    // 模拟在 I/O 执行期间，新一轮 turn 已将 mapping 覆盖为 turn 2
    const currentNewTurnMapping: ChannelMapping = {
      ...mapping,
      extra: JSON.stringify({
        ...JSON.parse(mapping.extra),
        turn: 2,
        card_message_id: 'om_card_turn2',
        progress_frozen: false
      })
    };

    const cardMappings = createMemoryChannelMappingRepo([mapping]);

    const runtime = {
      getTasks: vi.fn(async () => [runtimeTask]),
      getEvents: vi.fn(async () => [])
    };

    const { LarkServiceError } = await import('./service.js');
    const service = {
      update: vi.fn(async () => {
        // 模拟在 PATCH 执行期间，外部并发将存储中的 mapping 更新为 turn 2
        cardMappings.mappings[0] = { ...currentNewTurnMapping };
        throw new LarkServiceError('LARK_OPENAPI_ERROR', 'message update expired', 502, { upstreamCode: 230031 });
      }),
      send: vi.fn(async () => ({ messageId: 'om_final_cas' }))
    };

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // 第一轮对账：PATCH 返回 230031，但写回前 CAS 发现已被修改为 turn 2
    const round1Unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });

    // 关键校验：因为存储中 extra 已经变更为 turn 2 / 新卡，旧的 230031 绝不能覆盖保存 mapping
    expect(cardMappings.mappings[0]!.extra).toBe(currentNewTurnMapping.extra);
    // 关键校验：即使 CAS 冲突放弃写回，仍保留 unresolved=1 保持对账轮询，绝不能提前停掉
    expect(round1Unresolved).toBe(1);

    // 完整生命周期闭环：下一轮 runtimeTask 变为 completed，基于当前最新 mapping 能够正常交付独立结果并收敛
    runtimeTask = { ...runtimeTask, status: 'completed', updatedAt: new Date().toISOString() };
    runtime.getTasks = vi.fn(async () => [runtimeTask]);
    runtime.getEvents = vi.fn(async () => [{ id: 1, type: 'text', data: { text: 'CAS 任务完成输出' } }]);
    service.update = vi.fn(async () => ({ messageId: 'om_card_turn2' }));

    const round2Unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });

    expect(round2Unresolved).toBe(0);
    expect(service.send).toHaveBeenCalledTimes(1);
    const finalExtra = JSON.parse(cardMappings.mappings[0]!.extra);
    expect(finalExtra).toMatchObject({
      turn: 2,
      final_delivery_state: 'delivered',
      final_message_id: 'om_final_cas',
      state: 'completed'
    });
  });

  it('非终态对账 PATCH 成功但写回时发现 CAS 变化：放弃写入但不漏掉 unresolved=1，后续终态正常交付', async () => {
    const startedAt = Date.now() - 5_000;
    let runtimeTask: TaskRecord = {
      id: 'task-cas-success',
      sessionId: 'ses-cas-success',
      prompt: 'Prompt cas success',
      status: 'running',
      createdAt: new Date(startedAt).toISOString(),
      updatedAt: new Date().toISOString()
    };

    const mapping = createMapping('map-cas-succ', 'msg-cas-succ', 'ses-cas-succ', {
      runtime_task_id: runtimeTask.id,
      state: 'running',
      turn: 1,
      card_message_id: 'om_card_turn1',
      progress_frozen: false
    });

    const currentModifiedMapping: ChannelMapping = {
      ...mapping,
      extra: JSON.stringify({
        ...JSON.parse(mapping.extra),
        retry_material_prompt: '并发更新的材料'
      })
    };

    const cardMappings = createMemoryChannelMappingRepo([mapping]);

    const runtime = {
      getTasks: vi.fn(async () => [runtimeTask]),
      getEvents: vi.fn(async () => [])
    };

    const service = {
      update: vi.fn(async () => {
        // 模拟在 PATCH 期间外部并发更新了 extra
        cardMappings.mappings[0] = { ...currentModifiedMapping };
        return { messageId: 'om_card_turn1' };
      }),
      send: vi.fn(async () => ({ messageId: 'om_final_succ' }))
    };

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const round1Unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });

    // PATCH 虽然成功，但写回前 CAS 发现 extra 已被修改，故放弃保存旧 mapping
    expect(service.update).toHaveBeenCalledTimes(1);
    expect(cardMappings.mappings[0]!.extra).toBe(currentModifiedMapping.extra);
    // 依然保留 unresolved=1 保持跟踪
    expect(round1Unresolved).toBe(1);

    // 下一轮 runtimeTask 变为 completed，交付独立结果并收敛
    runtimeTask = { ...runtimeTask, status: 'completed', updatedAt: new Date().toISOString() };
    runtime.getTasks = vi.fn(async () => [runtimeTask]);
    runtime.getEvents = vi.fn(async () => [{ id: 1, type: 'text', data: { text: '成功完成' } }]);

    const round2Unresolved = await performLarkCardReconcile({
      runtime: runtime as any,
      service: service as any,
      cardMappings: cardMappings as any,
      log: log as any,
      config,
      channel: 'lark-card:cli_test'
    });

    expect(round2Unresolved).toBe(0);
    expect(service.send).toHaveBeenCalledTimes(1);
    const finalExtra = JSON.parse(cardMappings.mappings[0]!.extra);
    expect(finalExtra).toMatchObject({
      retry_material_prompt: '并发更新的材料',
      final_delivery_state: 'delivered',
      final_message_id: 'om_final_succ',
      state: 'completed'
    });
  });

  it('真实 SQLite + 真实 performLarkCardReconcile 竞态回归：在快照读取后、条件更新前并发写入新 turn，原子 CAS 失败且不覆盖新 mapping', async () => {
    const repos = createRepositories(':memory:');
    try {
      const startedAt = Date.now() - 5_000;
      let runtimeTask: TaskRecord = {
        id: 'task-sqlite-race',
        sessionId: 'ses-sqlite-race',
        prompt: 'Prompt sqlite race',
        status: 'running',
        createdAt: new Date(startedAt).toISOString(),
        updatedAt: new Date().toISOString()
      };

      const turn1Mapping = createMapping('map-sqlite-race', 'msg-sqlite-race', 'ses-sqlite-race', {
        runtime_task_id: runtimeTask.id,
        state: 'running',
        turn: 1,
        card_message_id: 'om_card_turn1',
        progress_frozen: false
      });

      // 先在真实 SQLite 中 seed turn 1 初始数据
      await repos.channelMappings.save(turn1Mapping);

      const turn2Mapping: ChannelMapping = {
        ...turn1Mapping,
        extra: JSON.stringify({
          ...JSON.parse(turn1Mapping.extra),
          turn: 2,
          card_message_id: 'om_card_turn2',
          progress_frozen: false
        })
      };

      // 包装 repo.compareAndSetExtra：在首次调用时先并发保存 turn2Mapping，再执行真正的 SQLite CAS
      const origCompareAndSetExtra = repos.channelMappings.compareAndSetExtra.bind(repos.channelMappings);
      let casCallCount = 0;
      repos.channelMappings.compareAndSetExtra = vi.fn(async (id: string, expectedExtra: string | null | undefined, extra: string) => {
        casCallCount++;
        if (casCallCount === 1) {
          // 模拟在旧快照 list 之后、CAS 之前，外部并发事务先保存了 turn 2
          await repos.channelMappings.save(turn2Mapping);
        }
        return origCompareAndSetExtra(id, expectedExtra, extra);
      });

      const runtime = {
        getTasks: vi.fn(async () => [runtimeTask]),
        getEvents: vi.fn(async () => [{ id: 1, type: 'text', data: { text: '真实输出' } }])
      };

      const { LarkServiceError } = await import('./service.js');
      const service = {
        update: vi.fn(async () => {
          throw new LarkServiceError('LARK_OPENAPI_ERROR', 'message update expired', 502, { upstreamCode: 230031 });
        }),
        send: vi.fn(async () => ({ messageId: 'om_final_sqlite' }))
      };

      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

      // 第一轮对账：快照读到 turn 1，PATCH 报 230031，尝试 CAS 冻结；
      // 但在 CAS 执行前先并发写入了 turn 2，真实 SQLite CAS 必须返回 false
      const round1Unresolved = await performLarkCardReconcile({
        runtime: runtime as any,
        service: service as any,
        cardMappings: repos.channelMappings,
        log: log as any,
        config,
        channel: 'lark-card:cli_test'
      });

      // 1. 第一轮保持跟踪，unresolved > 0
      expect(round1Unresolved).toBeGreaterThan(0);

      // 2. 真实 SQLite 中的数据仍然是 turn 2，绝不能被旧的 turn 1 / progress_frozen 覆盖
      const persistedInDb = await repos.channelMappings.get('lark-card:cli_test', 'msg-sqlite-race');
      expect(persistedInDb).toBeDefined();
      const parsedDbExtra = JSON.parse(persistedInDb!.extra);
      expect(parsedDbExtra.turn).toBe(2);
      expect(parsedDbExtra.card_message_id).toBe('om_card_turn2');
      expect(parsedDbExtra.progress_frozen).toBe(false);

      // 3. 后续跟踪：runtimeTask 变为 completed，第二轮基于最新 turn 2 正常对账完成交付并收敛
      runtimeTask = { ...runtimeTask, status: 'completed', updatedAt: new Date().toISOString() };
      service.update = vi.fn(async () => ({ messageId: 'om_card_turn2' }));

      const round2Unresolved = await performLarkCardReconcile({
        runtime: runtime as any,
        service: service as any,
        cardMappings: repos.channelMappings,
        log: log as any,
        config,
        channel: 'lark-card:cli_test'
      });

      expect(round2Unresolved).toBe(0);
      expect(service.send).toHaveBeenCalledTimes(1);
      const finalInDb = await repos.channelMappings.get('lark-card:cli_test', 'msg-sqlite-race');
      const finalDbExtra = JSON.parse(finalInDb!.extra);
      expect(finalDbExtra.turn).toBe(2);
      expect(finalDbExtra.final_delivery_state).toBe('delivered');
      expect(finalDbExtra.final_message_id).toBe('om_final_sqlite');
      expect(finalDbExtra.progress_frozen).toBe(true);
    } finally {
      repos.close();
    }
  });
});

describe('performLarkCardReconcile 遵守群级呈现开关', () => {
  const completedTask = (sessionId: string): TaskRecord => ({
    id: `task-${sessionId}`, sessionId, prompt: `Prompt ${sessionId}`, status: 'completed',
    createdAt: new Date(Date.now() - 6_000).toISOString(), updatedAt: new Date().toISOString()
  });

  const reconcileHarness = (mappings: ChannelMapping[], tasks: Record<string, TaskRecord[]>) => {
    const cardMappings = createMemoryChannelMappingRepo(mappings);
    const runtime = {
      getTasks: vi.fn(async (sessionId: string) => tasks[sessionId] ?? []),
      getEvents: vi.fn(async () => [{ id: 1, type: 'text', data: { text: '结果内容' } }])
    };
    const service = {
      update: vi.fn(async (input: any) => ({ messageId: input.messageId })),
      send: vi.fn(async () => ({ messageId: 'om_final', elements: [] })),
      reply: vi.fn(async () => ({ messageId: 'om_final', elements: [] })),
      addReaction: vi.fn(async (messageId: string, emojiType: string) => ({ messageId, reactionId: `r_${emojiType}` }))
    };
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return { cardMappings, runtime, service, log };
  };

  it('completionReactionOnly 开启时，重启补发只贴表情，不补结果卡', async () => {
    const task = completedTask('ses-react');
    const mapping = createMapping('map-react', 'om_req_react', 'ses-react', { runtime_task_id: task.id, state: 'running', turn: 1 });
    const h = reconcileHarness([mapping], { 'ses-react': [task] });

    const unresolved = await performLarkCardReconcile({
      runtime: h.runtime as any, service: h.service as any, cardMappings: h.cardMappings as any, log: h.log as any,
      config, channel: 'lark-card:cli_test',
      resolveConfig: async () => ({ ...config, completionReactionOnly: true })
    });

    expect(unresolved).toBe(0);
    expect(h.service.send).not.toHaveBeenCalled();
    expect(h.service.reply).not.toHaveBeenCalled();
    expect(h.service.addReaction).toHaveBeenCalledWith('om_req_react', COMPLETION_REACTION_EMOJI);
    const saved = JSON.parse(h.cardMappings.mappings[0]!.extra!);
    expect(saved.final_delivery_state).toBe('reaction');
    expect(saved.final_message_id).toBeUndefined();
    // 过程卡仍然被冻结成终态，不会停在「执行中」。
    expect(h.service.update).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_card_om_req_react', state: 'completed' }));
  });

  it('completionReactionOnly 开启但终态是失败时，仍然补发结果卡', async () => {
    const task = { ...completedTask('ses-fail'), status: 'failed' as const };
    const mapping = createMapping('map-fail', 'om_req_fail', 'ses-fail', { runtime_task_id: task.id, state: 'running', turn: 1 });
    const h = reconcileHarness([mapping], { 'ses-fail': [task] });

    await performLarkCardReconcile({
      runtime: h.runtime as any, service: h.service as any, cardMappings: h.cardMappings as any, log: h.log as any,
      config, channel: 'lark-card:cli_test',
      resolveConfig: async () => ({ ...config, completionReactionOnly: true })
    });

    expect(h.service.addReaction).not.toHaveBeenCalled();
    expect(h.service.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.cardMappings.mappings[0]!.extra!).final_delivery_state).toBe('delivered');
  });

  it('只贴表情的已交付记录不会在下一轮对账里被再贴一次或补一张结果卡', async () => {
    const task = completedTask('ses-done');
    const mapping = createMapping('map-done', 'om_req_done', 'ses-done', {
      runtime_task_id: task.id, state: 'completed', turn: 1, final_delivery_state: 'reaction', progress_frozen: true
    });
    const h = reconcileHarness([mapping], { 'ses-done': [task] });

    const unresolved = await performLarkCardReconcile({
      runtime: h.runtime as any, service: h.service as any, cardMappings: h.cardMappings as any, log: h.log as any,
      config, channel: 'lark-card:cli_test',
      resolveConfig: async () => ({ ...config, completionReactionOnly: true })
    });

    expect(unresolved).toBe(0);
    expect(h.service.addReaction).not.toHaveBeenCalled();
    expect(h.service.send).not.toHaveBeenCalled();
    expect(h.service.update).not.toHaveBeenCalled();
  });

  it('静默轮次没有过程卡也照样补发结果：映射不被当成损坏记录丢掉', async () => {
    const task = completedTask('ses-silent');
    const mapping = createMapping('map-silent', 'om_req_silent', 'ses-silent', {
      runtime_task_id: task.id, state: 'running', turn: 1, card_message_id: undefined
    });
    const h = reconcileHarness([mapping], { 'ses-silent': [task] });

    const unresolved = await performLarkCardReconcile({
      runtime: h.runtime as any, service: h.service as any, cardMappings: h.cardMappings as any, log: h.log as any,
      config, channel: 'lark-card:cli_test',
      resolveConfig: async () => ({ ...config, silentProgress: true })
    });

    expect(unresolved).toBe(0);
    // 没有过程卡就不打任何 PATCH，但结果这条腿必须补上。
    expect(h.service.update).not.toHaveBeenCalled();
    expect(h.service.send).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(h.cardMappings.mappings[0]!.extra!);
    expect(saved.final_message_id).toBe('om_final');
    expect(saved.final_delivery_state).toBe('delivered');
  });

  it('两个开关都开的静默轮次补发只剩一枚表情，且不触碰任何卡片', async () => {
    const task = completedTask('ses-both');
    const mapping = createMapping('map-both', 'om_req_both', 'ses-both', {
      runtime_task_id: task.id, state: 'running', turn: 1, card_message_id: undefined
    });
    const h = reconcileHarness([mapping], { 'ses-both': [task] });

    const unresolved = await performLarkCardReconcile({
      runtime: h.runtime as any, service: h.service as any, cardMappings: h.cardMappings as any, log: h.log as any,
      config, channel: 'lark-card:cli_test',
      resolveConfig: async () => ({ ...config, silentProgress: true, completionReactionOnly: true })
    });

    expect(unresolved).toBe(0);
    expect(h.service.update).not.toHaveBeenCalled();
    expect(h.service.send).not.toHaveBeenCalled();
    expect(h.service.addReaction).toHaveBeenCalledWith('om_req_both', COMPLETION_REACTION_EMOJI);
    expect(JSON.parse(h.cardMappings.mappings[0]!.extra!).final_delivery_state).toBe('reaction');
  });

  it('补发结果卡的 @ 发起人按群覆盖后的开关决定', async () => {
    const groupTask = (sessionId: string) => ({ runtime_task_id: `task-${sessionId}`, state: 'running' as const, turn: 1,
      chat_type: 'group', sender_open_id: 'ou_alice', sender_type: 'user' });
    const sentElements = (h: ReturnType<typeof reconcileHarness>) =>
      JSON.stringify([...h.service.send.mock.calls, ...h.service.reply.mock.calls].map(call => (call as any[])[0]?.elements));
    for (const [bot, group, expected] of [[true, false, false], [false, true, true]] as const) {
      const sessionId = `ses-mention-${bot}-${group}`;
      const mapping = createMapping(`map-${sessionId}`, `om_req_${sessionId}`, sessionId, groupTask(sessionId));
      const h = reconcileHarness([mapping], { [sessionId]: [completedTask(sessionId)] });
      await performLarkCardReconcile({
        runtime: h.runtime as any, service: h.service as any, cardMappings: h.cardMappings as any, log: h.log as any,
        config: { ...config, groupCardMention: bot }, channel: 'lark-card:cli_test',
        resolveConfig: async () => ({ ...config, groupCardMention: group })
      });
      expect(sentElements(h).includes('<at id=ou_alice></at>'), `bot=${bot} group=${group}`).toBe(expected);
    }
  });

  it('不给 resolveConfig 时按 Bot 级配置补发，既有行为不变', async () => {
    const task = completedTask('ses-plain');
    const mapping = createMapping('map-plain', 'om_req_plain', 'ses-plain', { runtime_task_id: task.id, state: 'running', turn: 1 });
    const h = reconcileHarness([mapping], { 'ses-plain': [task] });

    await performLarkCardReconcile({
      runtime: h.runtime as any, service: h.service as any, cardMappings: h.cardMappings as any, log: h.log as any,
      config, channel: 'lark-card:cli_test'
    });

    expect(h.service.addReaction).not.toHaveBeenCalled();
    expect(h.service.send).toHaveBeenCalledTimes(1);
    expect(h.service.update).toHaveBeenCalled();
  });
});

describe('恢复异常通知与人工核验结果', () => {
  it.each(['silent', 'frozen', 'missing', 'unupdatable', 'writable'])('%s process card delivers only the required recovery notice and never a business final', async mode => {
    const repos = createRepositories(':memory:');
    try {
      const task = { id: 'recovery-task', sessionId: 'session', status: 'reconcile_required', prompt: 'prompt', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as TaskRecord;
      const mapping = createMapping('recovery-map', 'om_request', 'session', { runtime_task_id: task.id, turn: 2,
        reply_message_id: 'om_request', reply_in_thread: true, ...(mode === 'frozen' ? { progress_frozen: true } : {}),
        ...(mode === 'missing' ? { card_message_id: undefined } : {}) });
      const cardMappings = createMemoryChannelMappingRepo([mapping]);
      const runtime = { getTasks: vi.fn(async () => [task]), getEvents: vi.fn(async () => []),
        getTaskRecovery: vi.fn(async () => ({ status: task.status, blockers: [{ code: 'DRIVER_RESOURCE_UNSAFE' }] })) };
      const service = { update: vi.fn(async () => ({ messageId: 'om_card' })),
        reply: vi.fn(async () => ({ messageId: 'om_notice' })), send: vi.fn() };
      if (mode === 'unupdatable') {
        const { LarkServiceError } = await import('./service.js');
        service.update.mockRejectedValueOnce(new LarkServiceError('LARK_OPENAPI_ERROR', 'expired', 502, { upstreamCode: 230031 }));
      }
      const input = { runtime: runtime as any, service: service as any, cardMappings: cardMappings as any,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, config, channel: 'lark-card:cli_test', deliveryStore: repos.config,
        resolveConfig: async () => ({ ...config, silentProgress: mode === 'silent' }) };
      await performLarkCardReconcile(input);
      task.updatedAt = new Date(Date.now() + 1_000).toISOString();
      await performLarkCardReconcile({ ...input, runtime: { ...runtime } as any });
      expect(service.reply).toHaveBeenCalledTimes(mode === 'writable' ? 0 : 1);
      expect(service.update).toHaveBeenCalledTimes(['writable', 'unupdatable'].includes(mode) ? 1 : 0);
      expect(service.send).not.toHaveBeenCalled();
      const persisted = JSON.parse(cardMappings.mappings[0]!.extra!);
      expect(persisted.final_message_id).toBeUndefined();
      expect(persisted.final_delivery_state).toBeUndefined();
      if (mode !== 'writable') expect(service.reply.mock.calls[0]![0]).toMatchObject({ messageId: 'om_request', replyInThread: true, statusLabel: '需要核对' });
    } finally { repos.close(); }
  });

  it('retries a failed notice on a frozen card without patching or changing its original destination', async () => {
    const repos = createRepositories(':memory:');
    try {
      const mapping = createMapping('retry-recovery', 'om_request', 'session', { runtime_task_id: 'task', progress_frozen: true, reply_message_id: 'om_request' });
      const cardMappings = createMemoryChannelMappingRepo([mapping]);
      const task = { id: 'task', status: 'reconcile_required' };
      const service = { update: vi.fn(), reply: vi.fn(async () => ({ messageId: 'om_notice' })), send: vi.fn() };
      service.reply.mockRejectedValueOnce(new Error('network'));
      const input = { runtime: { getTasks: async () => [task], getEvents: async () => [] } as any,
        service: service as any, cardMappings: cardMappings as any, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, config,
        channel: 'lark-card:cli_test', deliveryStore: repos.config };
      await performLarkCardReconcile(input);
      await performLarkCardReconcile(input);
      await performLarkCardReconcile(input);
      expect(service.reply).toHaveBeenCalledTimes(2);
      expect(service.reply.mock.calls[0]).toEqual(service.reply.mock.calls[1]);
      expect(service.update).not.toHaveBeenCalled(); expect(service.send).not.toHaveBeenCalled();
    } finally { repos.close(); }
  });

  it.each([true, false])('only an authoritative verified completion can override historical open tools: %s', async verified => {
    const { createHash } = await import('node:crypto');
    const repos = createRepositories(':memory:');
    try {
      const mapping = createMapping('verified-map', 'om_request', 'session', { runtime_task_id: 'task', progress_frozen: true, reply_message_id: 'om_request' });
      const cardMappings = createMemoryChannelMappingRepo([mapping]);
      const text = '经原始记录核验的最终答案';
      const event = { id: 'verified', type: 'text', data: { text, recovery: { actor: 'installation_owner' } } };
      const runtime = { getTasks: async () => [{ id: 'task', status: 'completed', updatedAt: new Date().toISOString() }],
        getEvents: async () => [{ id: 'tool', type: 'tool_call', data: { id: 'open_tool', name: 'shell' } }, event],
        getTaskRecovery: async () => ({ status: 'completed', blockers: [], ...(verified ? { verifiedOutput: { eventId: 'verified', digest: createHash('sha256').update(text).digest('hex') } } : {}) }) };
      const service = { update: vi.fn(), reply: vi.fn(async (_input: any) => ({ messageId: 'om_result' })), send: vi.fn() };
      await performLarkCardReconcile({ runtime: runtime as any, service: service as any, cardMappings: cardMappings as any,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, config, channel: 'lark-card:cli_test', deliveryStore: repos.config });
      expect(service.reply.mock.calls[0]![0]).toMatchObject({ state: verified ? 'completed' : 'failed' });
      if (verified) {
        expect(JSON.stringify(service.reply.mock.calls[0])).toContain(text);
        expect(JSON.stringify(service.reply.mock.calls[0])).not.toContain('open_tool');
      }
    } finally { repos.close(); }
  });
});
