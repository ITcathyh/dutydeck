import { afterEach, describe, expect, it, vi } from 'vitest';
import { LarkCoordinatorInbound } from './coordinator-inbound.js';
import { runOpenPlatformRepair, type OpenPlatformRepairResult } from './repair.js';

vi.mock('./repair.js', async importOriginal => ({ ...await importOriginal<typeof import('./repair.js')>(), runOpenPlatformRepair: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

async function flight(result: OpenPlatformRepairResult) {
  vi.mocked(runOpenPlatformRepair).mockResolvedValue(result);
  const coordinator = Object.create(LarkCoordinatorInbound.prototype) as any;
  const update = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('card PATCH temporarily unavailable')).mockResolvedValueOnce({});
  coordinator.service = { update };
  coordinator.log = { warn: vi.fn() };
  await coordinator.executeRepairFlight({ appId: 'cli_sample', permissionMode: 'ask' }, 'cli_sample', 'om_card');
  return { update, log: coordinator.log };
}

describe('/repair result delivery', () => {
  it.each(['repaired', 'pending_review'] as const)('does not rewrite a known %s result as unpublished when the result card fails', async status => {
    const { update, log } = await flight({ status, appId: 'cli_sample', versionId: 'published-version', steps: [{ step: 'publish_commit', detail: { versionId: 'published-version' } }] });
    expect(runOpenPlatformRepair).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]![0]).toMatchObject({ taskName: status === 'repaired' ? '/repair 修复完成' : '/repair 已提交，等待审核', state: 'completed' });
    expect(JSON.stringify(update.mock.calls)).not.toContain('本次未完成发布');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ status, versionId: 'published-version' }), '/repair 执行结果已产生，但结果卡投递失败');
  });

  it('keeps publication unknown and does not retry publication when delivery fails', async () => {
    const { update } = await flight({ status: 'failed', appId: 'cli_sample', code: 'session_expired', reason: '回读失败', hint: '发布结果待确认', publishAttempted: true,
      steps: [{ step: 'publish_commit', detail: { versionId: 'submitted-version' } }] });
    expect(runOpenPlatformRepair).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]![0]).toMatchObject({ taskName: '/repair 发布结果待确认', state: 'failed', markdown: expect.stringContaining('发布结果尚未确认') });
    expect(JSON.stringify(update.mock.calls)).not.toContain('本次未完成发布');
  });

  it('retains the execution-failure receipt only when repair itself fails before returning a result', async () => {
    vi.mocked(runOpenPlatformRepair).mockRejectedValue(new Error('before publication'));
    const coordinator = Object.create(LarkCoordinatorInbound.prototype) as any;
    const update = vi.fn(async () => ({}));
    coordinator.service = { update };
    coordinator.log = { warn: vi.fn() };
    await coordinator.executeRepairFlight({ appId: 'cli_sample', permissionMode: 'ask' }, 'cli_sample', 'om_card');
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]![0]).toMatchObject({ taskName: '/repair 修复失败', markdown: '修复执行失败，请稍后重试；本次未完成发布。' });
  });
});
