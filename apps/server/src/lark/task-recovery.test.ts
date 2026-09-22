import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { describeLarkTaskRecovery, notifyLarkTaskRecovery, verifiedLarkRecoveryOutput } from './task-recovery.js';

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
    const service = { reply, send: vi.fn() } as any;
    const input = { service, log: { warn: vi.fn() }, appId: 'app', sessionId: 'session', taskId: 'task', turn: 1,
      target: { chatId: 'chat', replyMessageId: 'om_original', replyInThread: true },
      recovery: { blocked: true, label: '需要核对', markdown: '原进程状态待核对' } };
    try {
      await expect(notifyLarkTaskRecovery({ ...input, store: repos.config })).rejects.toThrow('lost acknowledgement');
      expect(service.send).not.toHaveBeenCalled();
      repos.close(); repos = createRepositories(filename);
      await Promise.all([1, 2, 3].map(() => notifyLarkTaskRecovery({ ...input, store: repos.config,
        recovery: { ...input.recovery, markdown: '检查状态已变化' } })));
      expect(reply).toHaveBeenCalledTimes(2);
      expect(accepted.size).toBe(1);
      expect(reply.mock.calls[1]![0]).toEqual(reply.mock.calls[0]![0]);
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
      const input = { service, store: repos.config, log: { warn: vi.fn() }, appId: 'app', sessionId: 'session', taskId: 'task',
        target: { chatId: 'chat', replyMessageId: 'om_original' }, recovery: { blocked: true, label: '需要核对', markdown: '待检查' } };
      await expect(notifyLarkTaskRecovery(input)).rejects.toThrow('invalid delivery receipt');
      expect(service.send).not.toHaveBeenCalled();
      expect(await repos.config.list('lark.delivery.')).toHaveLength(0);
      await notifyLarkTaskRecovery({ ...input, recovery: { ...input.recovery, blocked: false } });
      expect(service.reply).toHaveBeenCalledOnce();
    } finally { repos.close(); }
  });

  it('distinguishes settled unknown outcomes from unresolved resources', async () => {
    const runtime = { getTaskRecovery: vi.fn(async () => ({ status: 'reconcile_required', resolvedUnknown: true, blockers: [] as Array<{ code: string }> })) } as any;
    const settled = await describeLarkTaskRecovery(runtime, 'session', 'task', 'reconcile_required');
    expect(settled).toMatchObject({ blocked: false, label: '已核对，结果未确认' });
    expect(settled.markdown).toContain('可以继续发送新请求');
    runtime.getTaskRecovery.mockResolvedValue({ resolvedUnknown: true, blockers: [{ code: 'DRIVER_RESOURCE_UNSAFE' }] });
    const blocked = await describeLarkTaskRecovery(runtime, 'session', 'task', 'reconcile_required');
    expect(blocked.blocked).toBe(true);
    expect(blocked.markdown).not.toContain('可以继续发送新请求');
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
