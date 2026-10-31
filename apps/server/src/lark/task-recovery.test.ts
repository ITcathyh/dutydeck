import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { describeLarkTaskRecovery, notifyLarkTaskRecovery, notifyLarkUnknownTask, urgeLarkUnknownTask, verifiedLarkRecoveryOutput } from './task-recovery.js';
import { LarkUrgentManager } from './workflow-urgent.js';
import { createLarkCardService } from './service.js';

const recoveryRuntime = (status = 'reconcile_required', code = 'DRIVER_RESOURCE_UNSAFE') => ({
  getTaskRecovery: vi.fn(async () => ({ status, blockers: code ? [{ code }] : [] }))
}) as any;

describe('durable task recovery notices', () => {
  it('retries a lost reply acknowledgement after reopening SQLite using the same destination, UUID and frozen payload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-recovery-'));
    const filename = join(directory, 'state.db');
    let repos = createRepositories(filename);
    const accepted = new Map<string, string>();
    let loseAcknowledgement = true;
    const reply = vi.fn(async (input: any) => {
      accepted.set(input.idempotencyKey, 'om_recovery');
      if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('lost acknowledgement'); }
      return { messageId: accepted.get(input.idempotencyKey)! };
    });
    const service = { reply, send: vi.fn(), update: vi.fn(async () => ({ messageId: 'om_recovery' })) } as any;
    const runtime = recoveryRuntime();
    const input = { runtime, status: 'reconcile_required', service, log: { warn: vi.fn() }, appId: 'app', sessionId: 'session', taskId: 'task', turn: 1,
      target: { chatId: 'chat', replyMessageId: 'om_original', replyInThread: true } };
    try {
      await expect(notifyLarkTaskRecovery({ ...input, store: repos.config })).rejects.toThrow('lost acknowledgement');
      expect(service.send).not.toHaveBeenCalled();
      repos.close(); repos = createRepositories(filename);
      runtime.getTaskRecovery.mockResolvedValue({ status: 'reconcile_required', blockers: [{ code: 'DRIVER_STOP_BLOCKED' }] });
      await Promise.all([1, 2, 3].map(() => notifyLarkTaskRecovery({ ...input, store: repos.config })));
      expect(reply).toHaveBeenCalledTimes(2);
      expect(accepted.size).toBe(1);
      const { beforeSend: _firstGuard, ...first } = reply.mock.calls[0]![0];
      const { beforeSend: _retryGuard, ...retry } = reply.mock.calls[1]![0];
      expect(retry).toEqual(first);
      expect(reply.mock.calls[1]![0]).toMatchObject({ messageId: 'om_original', replyInThread: true, readOnly: true });
      const rows = await repos.config.list('lark.');
      expect(rows.filter(row => row.key.startsWith('lark.recovery.'))).toHaveLength(1);
      expect(rows.filter(row => row.key.startsWith('lark.delivery.'))).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain('final_message_id');
      expect(JSON.stringify(rows)).not.toContain('explicit_final');
    } finally { repos.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('does not mark an invalid provider receipt as delivered, or fall back to another destination', async () => {
    const repos = createRepositories(':memory:');
    try {
      const service = { reply: vi.fn(async () => ({ messageId: '' })), send: vi.fn() } as any;
      const input = { runtime: recoveryRuntime(), status: 'reconcile_required', service, store: repos.config, log: { warn: vi.fn() }, appId: 'app', sessionId: 'session', taskId: 'task',
        target: { chatId: 'chat', replyMessageId: 'om_original' } };
      await expect(notifyLarkTaskRecovery(input)).rejects.toThrow('invalid delivery receipt');
      expect(service.send).not.toHaveBeenCalled();
      expect(await repos.config.list('lark.delivery.')).toHaveLength(0);
      await notifyLarkTaskRecovery({ ...input, taskId: 'unblocked-task', runtime: recoveryRuntime('running') });
      expect(service.reply).toHaveBeenCalledOnce();
    } finally { repos.close(); }
  });

  it.each(['running', 'completed', 'failed', 'cancelled'])('does not send a stale blocked snapshot when the task is now %s', async status => {
    const repos = createRepositories(':memory:');
    try {
      const service = { reply: vi.fn(async () => ({ messageId: 'om_notice' })), send: vi.fn(async () => ({ messageId: 'om_notice' })), update: vi.fn() } as any;
      const runtime = { getTaskRecovery: async () => ({ status, blockers: [{ code: 'DRIVER_RESOURCE_UNSAFE' }] }) } as any;
      await notifyLarkTaskRecovery({ runtime, status: 'queued', service, store: repos.config, log: { warn: vi.fn() },
        appId: 'app', sessionId: 'session', taskId: 'task', target: { chatId: 'chat' } });
      expect(service.send).not.toHaveBeenCalled();
      expect(service.reply).not.toHaveBeenCalled();
    } finally { repos.close(); }
  });

  it('rechecks before the provider write and closes a notice if execution starts while sending', async () => {
    const repos = createRepositories(':memory:');
    let status = 'queued';
    const runtime = { getTaskRecovery: async () => ({ status, blockers: status === 'queued' ? [{ code: 'DRIVER_STOP_BLOCKED' }] : [] }) } as any;
    try {
      const service = { send: vi.fn(async () => { status = 'completed'; return { messageId: 'om_notice' }; }),
        update: vi.fn(async () => ({ messageId: 'om_notice' })) } as any;
      await notifyLarkTaskRecovery({ runtime, status: 'queued', service, store: repos.config, log: { warn: vi.fn() },
        appId: 'app', sessionId: 'session', taskId: 'task', target: { chatId: 'chat' } });
      expect(service.send).toHaveBeenCalledOnce();
      expect(service.update).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_notice', state: 'completed', readOnly: true }));
      expect(JSON.stringify(service.update.mock.calls)).not.toContain('不会自动开始');
    } finally { repos.close(); }
  });

  it('keeps an ambiguous provider attempt recoverable when the real API gate retries after task completion', async () => {
    const repos = createRepositories(':memory:');
    let status = 'queued';
    const runtime = { getTaskRecovery: async () => ({ status, blockers: status === 'queued' ? [{ code: 'DRIVER_STOP_BLOCKED' }] : [] }) } as any;
    const sends: string[] = [];
    const patches: string[] = [];
    const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('tenant_access_token')) return response({ code: 0, tenant_access_token: 'token', expire: 7200 });
      if (init?.method === 'PATCH') patches.push(String(init.body));
      else {
        sends.push(String(init?.body));
        if (sends.length === 1) { status = 'completed'; throw new Error('accepted but acknowledgement lost'); }
      }
      return response({ code: 0, data: { message_id: 'om_notice' } });
    });
    const service = createLarkCardService({ LARK_APP_ID: 'recovery_retry', LARK_APP_SECRET: 'test',
      LARK_API_RETRY_BASE_MS: '1', LARK_API_RETRY_MAX_MS: '1', LARK_API_RETRY_MAX_ATTEMPTS: '1' }, fetcher as typeof fetch);
    try {
      const input = { runtime, status: 'queued', service, store: repos.config, log: { warn: vi.fn() },
        appId: 'recovery_retry', sessionId: 'session', taskId: 'task', target: { chatId: 'oc_test' }, beforeSend: vi.fn() };
      await notifyLarkTaskRecovery(input);
      expect(sends).toHaveLength(2);
      expect(sends[1]).toBe(sends[0]);
      expect(patches).toHaveLength(1);
      expect(patches[0]).toContain('本轮执行已结束');
      expect(patches[0]).not.toContain('不会自动开始');
      await notifyLarkTaskRecovery(input);
      expect(sends).toHaveLength(2);
      expect(await repos.config.list('lark.delivery.')).toHaveLength(1);
      expect(JSON.parse((await repos.config.list('lark.recovery.'))[0]!.value)).toHaveProperty('status_key');
    } finally { service.close(); repos.close(); }
  });

  it('cancels a new send when execution starts between the initial read and provider guard', async () => {
    const repos = createRepositories(':memory:');
    const getTaskRecovery = vi.fn().mockResolvedValueOnce({ status: 'queued', blockers: [{ code: 'DRIVER_STOP_BLOCKED' }] })
      .mockResolvedValue({ status: 'running', blockers: [] });
    const service = { send: vi.fn(), update: vi.fn() } as any;
    const input = { runtime: { getTaskRecovery } as any, status: 'queued', service, store: repos.config,
      log: { warn: vi.fn() }, appId: 'app', sessionId: 'session', taskId: 'task', target: { chatId: 'chat' } };
    try {
      await notifyLarkTaskRecovery(input);
      await notifyLarkTaskRecovery(input);
      expect(service.send).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
      expect(await repos.config.list('lark.delivery.')).toHaveLength(0);
    } finally { repos.close(); }
  });

  it('retries a transient PATCH, but stops after an unupdatable receipt without sending another notice', async () => {
    const repos = createRepositories(':memory:');
    const runtime = recoveryRuntime('queued', 'DRIVER_STOP_BLOCKED');
    const { LarkServiceError } = await import('./service.js');
    const service = { send: vi.fn(async () => ({ messageId: 'om_notice' })), update: vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new LarkServiceError('LARK_OPENAPI_ERROR', 'expired', 502, { upstreamCode: 230031 })) } as any;
    const input = { runtime, status: 'queued', service, store: repos.config, log: { warn: vi.fn() },
      appId: 'app', sessionId: 'session', taskId: 'task', target: { chatId: 'chat' } };
    try {
      await notifyLarkTaskRecovery(input);
      runtime.getTaskRecovery.mockResolvedValue({ status: 'completed', blockers: [] });
      await expect(notifyLarkTaskRecovery(input)).rejects.toThrow('network');
      await notifyLarkTaskRecovery(input);
      await notifyLarkTaskRecovery(input);
      expect(service.send).toHaveBeenCalledOnce();
      expect(service.update).toHaveBeenCalledTimes(2);
    } finally { repos.close(); }
  });

  it('reopens SQLite and updates the confirmed original notice through unblocked, running and completed without resending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lark-recovery-update-'));
    const filename = join(directory, 'state.db');
    let repos = createRepositories(filename);
    let status = 'queued';
    let blocked = true;
    const runtime = { getTaskRecovery: async () => ({ status, blockers: blocked ? [{ code: 'DRIVER_STOP_BLOCKED' }] : [] }) } as any;
    const service = { send: vi.fn(async () => ({ messageId: 'om_notice' })), update: vi.fn(async () => ({ messageId: 'om_notice' })) } as any;
    const input = { runtime, status: 'queued', service, log: { warn: vi.fn() }, appId: 'app', sessionId: 'session', taskId: 'task', turn: 1,
      target: { chatId: 'chat' } };
    try {
      await notifyLarkTaskRecovery({ ...input, store: repos.config });
      expect(JSON.stringify(service.send.mock.calls)).toContain('不会自动开始');
      repos.close(); repos = createRepositories(filename);
      blocked = false;
      await notifyLarkTaskRecovery({ ...input, store: repos.config });
      expect(service.update.mock.calls.at(-1)![0]).toMatchObject({ messageId: 'om_notice', state: 'queued', statusLabel: '排队中' });
      status = 'running';
      await notifyLarkTaskRecovery({ ...input, store: repos.config });
      status = 'completed';
      await Promise.all([1, 2, 3].map(() => notifyLarkTaskRecovery({ ...input, store: repos.config })));
      expect(service.send).toHaveBeenCalledOnce();
      expect(service.update).toHaveBeenCalledTimes(3);
      expect(service.update.mock.calls.at(-1)![0]).toMatchObject({ messageId: 'om_notice', state: 'completed' });
      expect(JSON.stringify(service.update.mock.calls)).not.toContain('不会自动开始');
    } finally { repos.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('distinguishes settled unknown outcomes from unresolved resources', async () => {
    const runtime = { getTaskRecovery: vi.fn(async () => ({ status: 'reconcile_required', resolvedUnknown: true, blockers: [] as Array<{ code: string }> })) } as any;
    const settled = await describeLarkTaskRecovery(runtime, 'session', 'task', 'reconcile_required');
    expect(settled).toMatchObject({ blocked: false, label: '已核对，结果未确认' });
    expect(settled.markdown).toContain('可以直接发新消息继续');
    runtime.getTaskRecovery.mockResolvedValue({ resolvedUnknown: true, blockers: [{ code: 'DRIVER_RESOURCE_UNSAFE' }] });
    const blocked = await describeLarkTaskRecovery(runtime, 'session', 'task', 'reconcile_required');
    expect(blocked.blocked).toBe(true);
    expect(blocked.markdown).not.toContain('可以直接发新消息继续');
  });

  it('offers the new-session buttons only when the card renders them and the task is stuck, without dead-end advice', async () => {
    const runtime = { getTaskRecovery: vi.fn(async () => ({ status: 'queued', blockers: [{ code: 'DRIVER_STOP_BLOCKED' }] as Array<{ code: string }> })) } as any;
    const offered = await describeLarkTaskRecovery(runtime, 'session', 'task', 'queued', undefined, { relaunch: true, webBaseUrl: 'https://dutydeck.example.com' });
    expect(offered).toMatchObject({ blocked: true, label: '排队受阻', relaunch: true });
    expect(offered.markdown).toContain('可以点「在新会话中执行」');
    expect(offered.markdown).toContain('原任务已保留，可在 Web 详情里核对。');
    expect(offered.markdown).toContain('/cancel');
    // 卡上没有按钮、也没有详情链接时，正文两者都不提。
    const plain = await describeLarkTaskRecovery(runtime, 'session', 'task', 'queued');
    expect(plain.relaunch).toBe(false);
    expect(plain.markdown).not.toContain('在新会话中');
    expect(plain.markdown).not.toContain('Web');
    expect(plain.markdown).toContain('原任务已保留，管理员可以用 `dutydeck recovery` 命令核对。');
    runtime.getTaskRecovery.mockResolvedValue({ status: 'reconcile_required', blockers: [{ code: 'DRIVER_RESOURCE_UNSAFE' }] });
    const review = await describeLarkTaskRecovery(runtime, 'session', 'task', 'reconcile_required', undefined, { relaunch: true });
    expect(review).toMatchObject({ blocked: true, label: '需要核对', relaunch: true });
    expect(review.markdown).toContain('可以点「在新会话中重新执行」');
    expect(review.markdown).toContain('原执行结果未确认，重新执行可能把已经做过的操作再做一次。');
    for (const recovery of [offered, plain, review]) {
      for (const phrase of ['请联系管理员', '请勿直接重试', '当前不能确认任务已停止']) expect(recovery.markdown).not.toContain(phrase);
    }
    // 没有卡住的任务不给按钮，声明了也不给。
    runtime.getTaskRecovery.mockResolvedValue({ status: 'queued', blockers: [] });
    const waiting = await describeLarkTaskRecovery(runtime, 'session', 'task', 'queued', undefined, { relaunch: true });
    expect(waiting).toMatchObject({ blocked: false, relaunch: false });
    expect(waiting.markdown).not.toContain('在新会话中');
  });

  it('trusts only the authoritative completed settlement event and verifies its digest', async () => {
    const event = { id: 'verified', type: 'text', data: { text: '已核验结果', recovery: { actor: 'installation_owner' } } } as any;
    const runtime = { getTaskRecovery: vi.fn(async () => ({})) } as any;
    expect(await verifiedLarkRecoveryOutput(runtime, 'session', 'task', [event])).toBeUndefined();
    runtime.getTaskRecovery.mockResolvedValue({ verifiedOutput: { eventId: event.id, digest: createHash('sha256').update(event.data.text).digest('hex') } });
    expect(await verifiedLarkRecoveryOutput(runtime, 'session', 'task', [event])).toBe(event);
    await expect(verifiedLarkRecoveryOutput(runtime, 'session', 'task', [{ ...event, data: { text: 'tampered' } }])).rejects.toThrow('does not match');
    await expect(verifiedLarkRecoveryOutput(runtime, 'session', 'task', [])).rejects.toThrow('unavailable');
  });
});

describe('结果未知提醒卡的 @ 与加急', () => {
  const facts = { actionable: true, target: 'attempt:task_1', kind: 'attempt', submission: 'acknowledged' } as any;
  const base = { appId: 'app', sessionId: 'session', runtimeTaskId: 'rt_1', facts, messageTaskId: 'task_1', turn: 1, taskName: '整理告警',
    target: { chatId: 'oc_group', replyMessageId: 'om_original', replyInThread: true } };

  it('@ 发起人的标签和正文一起冻结：卡首一个 @，重放不因配置变化而改变', async () => {
    const repos = createRepositories(':memory:');
    try {
      const reply = vi.fn()
        .mockRejectedValueOnce(new Error('lost acknowledgement'))
        .mockResolvedValue({ messageId: 'om_notice' });
      const input = { ...base, service: { reply, send: vi.fn() } as any, store: repos.config, log: { warn: vi.fn() } };
      await expect(notifyLarkUnknownTask({ ...input, mention: '<at id=ou_alice></at>' })).rejects.toThrow('lost acknowledgement');
      // 重放时配置已关闭 @：仍用第一次冻结的内容。
      expect(await notifyLarkUnknownTask(input)).toBe('om_notice');
      expect(reply.mock.calls[1]![0]).toEqual(reply.mock.calls[0]![0]);
      const elements = reply.mock.calls[1]![0].elements as Array<{ element_id: string; content: string }>;
      expect(elements.map(element => element.element_id)).toEqual(['group_mention', 'unknown_task_notice']);
      expect(elements[0]!.content).toBe('<at id=ou_alice></at>');
    } finally { repos.close(); }
  });

  it('不 @ 时卡面只有正文，和升级前一致', async () => {
    const repos = createRepositories(':memory:');
    try {
      const reply = vi.fn().mockResolvedValue({ messageId: 'om_notice' });
      await notifyLarkUnknownTask({ ...base, service: { reply, send: vi.fn() } as any, store: repos.config, log: { warn: vi.fn() } });
      expect((reply.mock.calls[0]![0].elements as Array<{ element_id: string }>).map(element => element.element_id)).toEqual(['unknown_task_notice']);
    } finally { repos.close(); }
  });

  it('任务恢复提醒同样把 @ 放在卡首并冻结', async () => {
    const repos = createRepositories(':memory:');
    try {
      const reply = vi.fn().mockResolvedValue({ messageId: 'om_recovery' });
      await notifyLarkTaskRecovery({ runtime: recoveryRuntime(), status: 'reconcile_required', service: { reply, send: vi.fn() } as any, store: repos.config, log: { warn: vi.fn() }, appId: 'app', sessionId: 'session',
        taskId: 'task', turn: 1, target: { chatId: 'oc_group', replyMessageId: 'om_original' },
        mention: '<at id=ou_alice></at>' });
      expect((reply.mock.calls[0]![0].elements as Array<{ element_id: string }>).map(element => element.element_id)).toEqual(['group_mention', 'task_recovery_notice']);
    } finally { repos.close(); }
  });

  it('提醒卡挂过阈值才加急发起人一次，免打扰时段内推迟到结束后，urgentAt 落库后重启也不重发', async () => {
    const repos = createRepositories(':memory:');
    const at = (hour: number, minute = 0, day = 13) => new Date(2026, 9, day, hour, minute, 0, 0).getTime();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(at(21, 50));
    try {
      const urgentApp = vi.fn().mockResolvedValue({ invalidUserIdList: [] });
      const reply = vi.fn().mockResolvedValue({ messageId: 'om_notice' });
      await notifyLarkUnknownTask({ ...base, service: { reply, send: vi.fn() } as any, store: repos.config, log: { warn: vi.fn() } });
      const urge = (manager: LarkUrgentManager, now: number) => urgeLarkUnknownTask({ store: repos.config, manager, appId: 'app', sessionId: 'session',
        runtimeTaskId: 'rt_1', target: 'attempt:task_1', chatId: 'oc_group', targetUserId: 'ou_alice', now });
      const manager = new LarkUrgentManager({ service: { urgentApp }, quietHours: '22:00-08:00', thresholdMs: 10 * 60_000 });

      expect(await urge(manager, at(21, 55))).toBe('not_due');
      expect(await urge(manager, at(22, 30))).toBe('quiet_hours');
      expect(urgentApp).not.toHaveBeenCalled();
      expect(await urge(manager, at(8, 0, 14))).toBe('urged');
      expect(urgentApp).toHaveBeenCalledOnce();
      expect(urgentApp).toHaveBeenCalledWith({ messageId: 'om_notice', userIdList: ['ou_alice'], userIdType: 'open_id' });

      // 对账每轮都会再走一遍，重启后换一个 manager 也一样。
      expect(await urge(manager, at(8, 5, 14))).toBe('already');
      expect(await urge(new LarkUrgentManager({ service: { urgentApp }, quietHours: '22:00-08:00' }), at(9, 0, 14))).toBe('already');
      expect(urgentApp).toHaveBeenCalledOnce();
    } finally { dateNow.mockRestore(); repos.close(); }
  });

  it('升级前发出、没有 sentAt 的提醒卡从第一次看到起算，不会一上来就加急', async () => {
    const repos = createRepositories(':memory:');
    try {
      const urgentApp = vi.fn().mockResolvedValue({ invalidUserIdList: [] });
      const reply = vi.fn().mockResolvedValue({ messageId: 'om_notice' });
      await notifyLarkUnknownTask({ ...base, service: { reply, send: vi.fn() } as any, store: repos.config, log: { warn: vi.fn() } });
      const key = (await repos.config.list('lark.unknown_task.'))[0]!.key;
      const legacy = JSON.parse((await repos.config.get(key))!);
      delete legacy.sentAt;
      await repos.config.set(key, JSON.stringify(legacy));
      const manager = new LarkUrgentManager({ service: { urgentApp }, thresholdMs: 10 * 60_000 });
      const input = { store: repos.config, manager, appId: 'app', sessionId: 'session', runtimeTaskId: 'rt_1', target: 'attempt:task_1', chatId: 'oc_group', targetUserId: 'ou_alice' };
      const first = Date.now();
      expect(await urgeLarkUnknownTask({ ...input, now: first })).toBeUndefined();
      expect(await urgeLarkUnknownTask({ ...input, now: first + 5 * 60_000 })).toBe('not_due');
      expect(await urgeLarkUnknownTask({ ...input, now: first + 11 * 60_000 })).toBe('urged');
    } finally { repos.close(); }
  });
});


it('offers no redundant replacement for foreign-only occupancy but retains actions for own or unscoped blockers', async () => {
  const foreign = { code: 'DRIVER_STOP_BLOCKED', external: true };
  const runtime = (blockers: Array<{ code: string; external?: boolean }>) => ({
    getTaskRecovery: async () => ({ status: 'queued', blockers })
  }) as any;
  expect(await describeLarkTaskRecovery(runtime([foreign]), 'session', 'task', 'queued', undefined, { relaunch: true }))
    .toMatchObject({ blocked: true, relaunch: false });
  for (const own of [{ code: 'DRIVER_STOP_BLOCKED' }, { code: 'DRIVER_STOP_BLOCKED', external: false }]) {
    expect(await describeLarkTaskRecovery(runtime([foreign, own]), 'session', 'task', 'queued', undefined, { relaunch: true }))
      .toMatchObject({ blocked: true, relaunch: true });
  }
});


it.each(['reconcile_required', 'legacy_unresolved'])('retains original unknown recovery actions despite foreign-only occupancy: %s', async status => {
  const runtime = { getTaskRecovery: async () => ({ status, blockers: [{ code: 'WORKSPACE_EXECUTION_BUSY', external: true }] }) } as any;
  expect(await describeLarkTaskRecovery(runtime, 'session', 'task', status, undefined, { relaunch: true }))
    .toMatchObject({ blocked: true, label: '需要核对', relaunch: true });
});
