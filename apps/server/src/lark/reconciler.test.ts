import { describe, expect, it, vi } from 'vitest';
import type { ChannelMapping, TaskRecord } from '@dutydeck/shared';
import type { StoredLarkConfig } from './config.js';
import type { PersistedLarkCardTask } from './coordinator.js';
import { performLarkCardReconcile } from './reconciler.js';

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

    const mappings = [mapping1, mapping2];
    const cardMappings = {
      list: vi.fn(async () => mappings.map(m => ({ ...m }))),
      get: vi.fn(),
      save: vi.fn(async (saved: ChannelMapping) => {
        const target = mappings.find(m => m.id === saved.id);
        if (target) target.extra = saved.extra;
      })
    };

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
        readOnly: true
      })
    );
    expect(service.send).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'completed',
        readOnly: true
      })
    );

    // 第二条 mapping 的持久化状态已更新为 delivered
    const savedMapping2 = JSON.parse(mappings[1]!.extra);
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

    const mappings = [mapping1, mapping2];
    const cardMappings = {
      list: vi.fn(async () => mappings.map(m => ({ ...m }))),
      get: vi.fn(),
      save: vi.fn(async (saved: ChannelMapping) => {
        const target = mappings.find(m => m.id === saved.id);
        if (target) target.extra = saved.extra;
      })
    };

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
    const savedMapping2 = JSON.parse(mappings[1]!.extra);
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

    const mappings = [mapping1, mapping2];
    const cardMappings = {
      list: vi.fn(async () => mappings.map(m => ({ ...m }))),
      get: vi.fn(),
      save: vi.fn(async (saved: ChannelMapping) => {
        if (saved.id === 'map-1') {
          throw new Error('SQLite disk I/O error on map-1');
        }
        const target = mappings.find(m => m.id === saved.id);
        if (target) target.extra = saved.extra;
      })
    };

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
    const savedMapping2 = JSON.parse(mappings[1]!.extra);
    expect(savedMapping2.final_delivery_state).toBe('delivered');
    expect(savedMapping2.final_message_id).toBe('om_final');
  });

  it('顶层 list 整体不可用仍应抛出错误', async () => {
    const cardMappings = {
      list: vi.fn(async () => {
        throw new Error('Database connection lost');
      }),
      get: vi.fn(),
      save: vi.fn()
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

    const cardMappings = {
      list: vi.fn(async () => [mapping]),
      get: vi.fn(),
      save: vi.fn()
    };

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

    const mappings = [mapping];
    const cardMappings = {
      list: vi.fn(async () => mappings.map(m => ({ ...m }))),
      get: vi.fn(),
      save: vi.fn(async (saved: ChannelMapping) => {
        const target = mappings.find(m => m.id === saved.id);
        if (target) target.extra = saved.extra;
      })
    };

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
    const persistedAfterRound1 = JSON.parse(mappings[0]!.extra);
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
});
