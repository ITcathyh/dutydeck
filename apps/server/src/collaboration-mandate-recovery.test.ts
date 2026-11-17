import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { CollaborationService } from './collaboration-service.js';
import { MandateCards } from './collaboration-mandate-cards.js';

const scope = { appId: 'cli_recovery', chatId: 'oc_recovery' };
const now = new Date('2026-11-17T00:00:00.000Z');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const createBody = (id: string) => ({ id, goal: `目标 ${id}`, mode: 'notify', prompt: `执行 ${id}`, condition: 'always',
  trigger: { kind: 'interval', everySeconds: 3600, anchorAt: now.toISOString() }, timezone: 'UTC' });

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'mandate-recovery-'));
  const database = join(directory, 'test.db');
  let repos = createRepositories(database);
  await repos.secretRefs.create({ id: 'secret', kind: 'generic', provider: 'keychain', referenceKey: 'test', status: 'configured' });
  await repos.channelBots.create({ id: 'bot', channel: 'lark', externalAppId: scope.appId, displayName: 'Bot', brand: 'feishu', credentialRef: 'secret', state: 'staged' });
  const client = {
    send: vi.fn(async () => ({ messageId: 'om_card', chatId: scope.chatId })),
    reply: vi.fn(async () => ({ messageId: 'om_card', chatId: scope.chatId })),
    update: vi.fn(async () => ({ messageId: 'om_card', chatId: scope.chatId }))
  };
  const onChange = vi.fn(async () => {});
  let service: CollaborationService;
  let cards: MandateCards;
  const build = () => {
    service = new CollaborationService({ repositories: repos, authorize: async () => true, now: () => now,
      resolveScheduleScope: async () => ({ channelBotId: 'bot', identityRef: 'identity', secretRef: 'secret' }) });
    cards = new MandateCards({ service, config: repos.config, client: async () => client, canOperate: async () => false, onChange });
  };
  build();
  cleanups.push(async () => { repos.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    client, onChange,
    get repos() { return repos; }, get service() { return service; }, get cards() { return cards; },
    restart() { repos.close(); repos = createRepositories(database); build(); },
    click(action: 'confirm' | 'cancel', ref: string) {
      return cards.callback(scope.appId, { dutydeck_mandate: action, ref }, 'ou_alice', { messageId: 'om_card', chatId: scope.chatId });
    }
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;

async function pendingCreate(h: Harness, id: string) {
  const pending = await h.cards.request(scope, 'ou_alice', createBody(id), {}) as { confirmationId: string };
  const action = await h.repos.collaboration.getAction(scope, pending.confirmationId);
  const sending = await h.repos.collaboration.updateAction(scope, action!.id, { expectedRevision: action!.revision, status: 'sending' });
  return { pending, sending };
}
async function pendingUpdate(h: Harness, id: string, prompt = '卡片确认的修改') {
  const pending = await h.cards.requestUpdate(scope, 'ou_alice', id, { expectedRevision: 1, prompt }, {}) as { confirmationId: string };
  const action = await h.repos.collaboration.getAction(scope, pending.confirmationId);
  const sending = await h.repos.collaboration.updateAction(scope, action!.id, { expectedRevision: action!.revision, status: 'sending' });
  return { pending, sending };
}

describe('定时委托确认的真实持久化恢复', () => {
  it.each(['confirm', 'cancel'] as const)('创建前停在 sending，重开后%s按实际效果收尾', async action => {
    const h = await harness();
    const { pending } = await pendingCreate(h, `before-create-${action}`);
    h.restart();

    await expect(h.click(action, pending.confirmationId)).resolves.toContain(action === 'confirm' ? '已确认' : '已取消');
    const record = await h.repos.collaboration.getAction(scope, pending.confirmationId);
    const mandates = await h.repos.collaboration.listMandates(scope);
    expect(record?.status).toBe(action === 'confirm' ? 'succeeded' : 'suppressed');
    expect(mandates).toHaveLength(action === 'confirm' ? 1 : 0);
    await expect(h.click(action === 'confirm' ? 'cancel' : 'confirm', pending.confirmationId)).resolves.toContain(action === 'confirm' ? '已经确认过了' : '已经取消了');
    expect(await h.repos.collaboration.listMandates(scope)).toHaveLength(action === 'confirm' ? 1 : 0);
  });

  it.each(['confirm', 'cancel'] as const)('创建已提交但确认未收尾，重开后%s只核对一次既有效果', async action => {
    const h = await harness();
    const { pending, sending } = await pendingCreate(h, `after-create-${action}`);
    vi.spyOn(h.service, 'reconcileMandate').mockRejectedValue(new Error('crash before confirmation settlement'));
    await expect(h.service.createMandate(scope, 'ou_alice', sending.payload.input)).rejects.toThrow('crash before confirmation settlement');
    expect(await h.repos.collaboration.listMandates(scope)).toHaveLength(1);
    h.restart();

    await expect(h.click(action, pending.confirmationId)).resolves.toContain(action === 'confirm' ? '已确认' : '已经确认过了');
    const mandates = await h.repos.collaboration.listMandates(scope);
    expect(mandates).toHaveLength(1);
    expect(mandates[0]).toMatchObject({ revision: 1, status: 'active' });
    expect(await h.repos.scheduleDefinitions.get(mandates[0]!.scheduleDefinitionId)).toMatchObject({ state: 'enabled' });
    expect((await h.repos.collaboration.getAction(scope, pending.confirmationId))?.status).toBe('succeeded');
    await expect(h.click('confirm', pending.confirmationId)).resolves.toContain('已经确认过了');
    expect(await h.repos.collaboration.listMandates(scope)).toHaveLength(1);
  });

  it.each(['confirm', 'cancel'] as const)('修改前停在 sending，重开后%s不会越过原修订', async action => {
    const h = await harness();
    const { mandate } = await h.service.createMandate(scope, 'ou_alice', createBody(`before-update-${action}`));
    const { pending } = await pendingUpdate(h, mandate.id);
    h.restart();

    await expect(h.click(action, pending.confirmationId)).resolves.toContain(action === 'confirm' ? '已确认' : '已取消');
    const current = await h.repos.collaboration.getMandate(scope, mandate.id);
    expect(current).toMatchObject({ revision: action === 'confirm' ? 2 : 1, prompt: action === 'confirm' ? '卡片确认的修改' : `执行 ${mandate.id}` });
    expect((await h.repos.collaboration.getAction(scope, pending.confirmationId))?.status).toBe(action === 'confirm' ? 'succeeded' : 'suppressed');
  });

  it('修改准备状态已写入但委托未推进时禁止取消伪装未发生，确认后复用原输入收尾', async () => {
    const h = await harness();
    const { mandate } = await h.service.createMandate(scope, 'ou_alice', createBody('prepared-update'));
    const { pending, sending } = await pendingUpdate(h, mandate.id);
    vi.spyOn(h.repos.collaboration, 'updateMandate').mockRejectedValue(new Error('crash after schedule preparation'));
    await expect(h.service.updateMandate(scope, 'ou_alice', mandate.id, sending.payload.input)).rejects.toThrow('crash after schedule preparation');
    expect(await h.repos.collaboration.getMandate(scope, mandate.id)).toMatchObject({ revision: 1 });
    expect(await h.repos.scheduleDefinitions.get(mandate.scheduleDefinitionId)).toMatchObject({ state: 'disabled' });
    h.restart();

    await expect(h.click('cancel', pending.confirmationId)).rejects.toMatchObject({ code: 'MANDATE_CARD_RECOVERY_CONFLICT' });
    expect((await h.repos.collaboration.getAction(scope, pending.confirmationId))?.status).toBe('sending');
    await expect(h.click('confirm', pending.confirmationId)).resolves.toContain('已确认');
    expect(await h.repos.collaboration.getMandate(scope, mandate.id)).toMatchObject({ revision: 2, prompt: '卡片确认的修改' });
    expect((await h.repos.collaboration.getAction(scope, pending.confirmationId))?.status).toBe('succeeded');
  });

  it.each(['confirm', 'cancel'] as const)('修改已提交但确认未收尾，重开后%s保持目标修订而不重复修改', async action => {
    const h = await harness();
    const { mandate } = await h.service.createMandate(scope, 'ou_alice', createBody(`after-update-${action}`));
    const { pending, sending } = await pendingUpdate(h, mandate.id);
    vi.spyOn(h.service, 'reconcileMandate').mockRejectedValue(new Error('crash after mandate update'));
    await expect(h.service.updateMandate(scope, 'ou_alice', mandate.id, sending.payload.input)).rejects.toThrow('crash after mandate update');
    expect(await h.repos.collaboration.getMandate(scope, mandate.id)).toMatchObject({ revision: 2, prompt: '卡片确认的修改' });
    h.restart();

    await expect(h.click(action, pending.confirmationId)).resolves.toContain(action === 'confirm' ? '已确认' : '已经确认过了');
    expect(await h.repos.collaboration.getMandate(scope, mandate.id)).toMatchObject({ revision: 2, prompt: '卡片确认的修改' });
    expect((await h.repos.collaboration.getAction(scope, pending.confirmationId))?.status).toBe('succeeded');
    await expect(h.click('confirm', pending.confirmationId)).resolves.toContain('已经确认过了');
    expect(await h.repos.collaboration.getMandate(scope, mandate.id)).toMatchObject({ revision: 2 });
  });

  it.each(['changed', 'stopped'] as const)('旧确认恢复前委托已经%s时不复活旧输入', async outcome => {
    const h = await harness();
    const { mandate } = await h.service.createMandate(scope, 'ou_alice', createBody(`later-${outcome}`));
    const { pending, sending } = await pendingUpdate(h, mandate.id, '旧卡片修改');
    await h.service.updateMandate(scope, 'ou_alice', mandate.id, sending.payload.input);
    await h.service.updateMandate(scope, 'ou_alice', mandate.id, outcome === 'changed' ? { expectedRevision: 2, prompt: '更新的管理操作' } : { expectedRevision: 2, status: 'cancelled' });
    h.restart();

    await expect(h.click('confirm', pending.confirmationId)).rejects.toMatchObject({ code: 'COLLABORATION_REVISION_CONFLICT' });
    expect(await h.repos.collaboration.getMandate(scope, mandate.id)).toMatchObject({ revision: 3,
      prompt: outcome === 'changed' ? '更新的管理操作' : '旧卡片修改', status: outcome === 'stopped' ? 'cancelled' : 'active' });
    expect((await h.repos.collaboration.getAction(scope, pending.confirmationId))?.status).toBe('failed');
  });

  it('同一张卡的确认、重复确认和取消并发时只有一个线性结果和一个委托', async () => {
    const h = await harness();
    const pending = await h.cards.request(scope, 'ou_alice', createBody('concurrent'), {}) as { confirmationId: string };
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = h.service.createMandate.bind(h.service);
    const create = vi.spyOn(h.service, 'createMandate').mockImplementation(async (...args) => { enter(); await gate; return original(...args); });

    const first = h.click('confirm', pending.confirmationId);
    await entered;
    const duplicate = h.click('confirm', pending.confirmationId);
    const cancel = h.click('cancel', pending.confirmationId);
    release();
    await expect(Promise.all([first, duplicate, cancel])).resolves.toEqual([
      expect.stringContaining('已确认'), expect.stringContaining('已经确认过了'), expect.stringContaining('已经确认过了')
    ]);
    expect(create).toHaveBeenCalledOnce();
    expect(await h.repos.collaboration.listMandates(scope)).toHaveLength(1);
    expect((await h.repos.collaboration.getAction(scope, pending.confirmationId))?.status).toBe('succeeded');
  });
});
