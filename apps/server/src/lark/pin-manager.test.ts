import { describe, expect, it, vi } from 'vitest';
import { LarkPinManager } from './pin-manager.js';
import type { LarkCardService } from './service.js';

describe('LarkPinManager', () => {
  it('pins and unpins message successfully', async () => {
    const service: Pick<LarkCardService, 'pin' | 'unpin'> = {
      pin: vi.fn().mockResolvedValue({ messageId: 'om_card', chatId: 'oc_group' }),
      unpin: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new LarkPinManager(service);

    expect(manager.isPinned('om_card')).toBe(false);
    const pinSuccess = await manager.pin('om_card');
    expect(pinSuccess).toBe(true);
    expect(manager.isPinned('om_card')).toBe(true);
    expect(service.pin).toHaveBeenCalledWith('om_card');

    // Duplicate pin call should be idempotent and not call service again
    const dupePin = await manager.pin('om_card');
    expect(dupePin).toBe(true);
    expect(service.pin).toHaveBeenCalledTimes(1);

    const unpinSuccess = await manager.unpin('om_card');
    expect(unpinSuccess).toBe(true);
    expect(manager.isPinned('om_card')).toBe(false);
    expect(service.unpin).toHaveBeenCalledWith('om_card');
  });

  it('fails safely without throwing when pin or unpin fails', async () => {
    const service: Pick<LarkCardService, 'pin' | 'unpin'> = {
      pin: vi.fn().mockRejectedValue(new Error('pin network error')),
      unpin: vi.fn().mockRejectedValue(new Error('unpin forbidden'))
    };
    const warn = vi.fn();
    const manager = new LarkPinManager(service, { warn });

    // Pin failure must not throw and returns false
    await expect(manager.pin('om_broken')).resolves.toBe(false);
    expect(manager.isPinned('om_broken')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain('置顶');

    warn.mockClear();
    // Unpin failure must not throw and returns false
    await expect(manager.unpin('om_broken')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain('取消置顶');
  });

  it('ignores empty messageId', async () => {
    const service: Pick<LarkCardService, 'pin' | 'unpin'> = {
      pin: vi.fn(),
      unpin: vi.fn()
    };
    const manager = new LarkPinManager(service);

    expect(await manager.pin('')).toBe(false);
    expect(await manager.unpin('')).toBe(false);
    expect(service.pin).not.toHaveBeenCalled();
    expect(service.unpin).not.toHaveBeenCalled();
  });

  it('persists pin state to store and updates status on unpin', async () => {
    const service: Pick<LarkCardService, 'pin' | 'unpin'> = {
      pin: vi.fn().mockResolvedValue({ messageId: 'om_card' }),
      unpin: vi.fn().mockResolvedValue(undefined)
    };
    const map = new Map<string, string>();
    const store = {
      get: vi.fn(async (key: string) => map.get(key)),
      set: vi.fn(async (key: string, value: string) => { map.set(key, value); }),
      list: vi.fn(async (prefix: string) => Array.from(map.entries()).filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })))
    };
    const manager = new LarkPinManager(service, { store });

    await manager.pin('om_card', { appId: 'app_test', taskId: 'task_1', chatId: 'oc_group' });
    expect(map.has('lark.pin.app_test.om_card')).toBe(true);
    const saved = JSON.parse(map.get('lark.pin.app_test.om_card')!);
    expect(saved).toMatchObject({
      messageId: 'om_card',
      appId: 'app_test',
      taskId: 'task_1',
      chatId: 'oc_group',
      status: 'pinned'
    });

    await manager.unpin('om_card', { appId: 'app_test' });
    const afterUnpin = JSON.parse(map.get('lark.pin.app_test.om_card')!);
    expect(afterUnpin.status).toBe('unpinned');
    expect(afterUnpin.unpinnedAt).toBeDefined();
  });

  it('reconciles zombie pins after restart, unpinning dead tasks and retaining active ones', async () => {
    const service: Pick<LarkCardService, 'pin' | 'unpin'> = {
      pin: vi.fn().mockResolvedValue({ messageId: 'om_card' }),
      unpin: vi.fn().mockResolvedValue(undefined)
    };
    const map = new Map<string, string>();
    // Pre-populate store with pins from a previous run before restart:
    map.set('lark.pin.app_test.om_zombie', JSON.stringify({
      messageId: 'om_zombie',
      appId: 'app_test',
      taskId: 'task_dead',
      status: 'pinned',
      pinnedAt: new Date(Date.now() - 3600000).toISOString()
    }));
    map.set('lark.pin.app_test.om_active', JSON.stringify({
      messageId: 'om_active',
      appId: 'app_test',
      taskId: 'task_running',
      status: 'pinned',
      pinnedAt: new Date(Date.now() - 60000).toISOString()
    }));
    map.set('lark.pin.app_test.om_already_done', JSON.stringify({
      messageId: 'om_already_done',
      appId: 'app_test',
      taskId: 'task_old',
      status: 'unpinned',
      pinnedAt: new Date(Date.now() - 7200000).toISOString(),
      unpinnedAt: new Date(Date.now() - 7100000).toISOString()
    }));

    const store = {
      get: vi.fn(async (key: string) => map.get(key)),
      set: vi.fn(async (key: string, value: string) => { map.set(key, value); }),
      list: vi.fn(async (prefix: string) => Array.from(map.entries()).filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })))
    };

    // Simulate restart: fresh in-memory manager
    const manager = new LarkPinManager(service, { store });
    expect(manager.isPinned('om_zombie')).toBe(false);
    expect(manager.isPinned('om_active')).toBe(false);

    // Reconcile with active task IDs
    const result = await manager.reconcile({
      appId: 'app_test',
      activeTaskIds: ['task_running']
    });

    expect(result.unpinned).toEqual(['om_zombie']);
    expect(result.retained).toEqual(['om_active']);

    // Dead task's card must be unpinned via service
    expect(service.unpin).toHaveBeenCalledWith('om_zombie');
    expect(service.unpin).not.toHaveBeenCalledWith('om_active');
    expect(service.unpin).not.toHaveBeenCalledWith('om_already_done');

    // In-memory set should restore active pin and not track zombie
    expect(manager.isPinned('om_active')).toBe(true);
    expect(manager.isPinned('om_zombie')).toBe(false);

    // Store should update status to unpinned for the zombie
    const zombieRecord = JSON.parse(map.get('lark.pin.app_test.om_zombie')!);
    expect(zombieRecord.status).toBe('unpinned');
    expect(zombieRecord.unpinnedAt).toBeDefined();
  });

  it('reconciles safely without throwing when unpin throws an error', async () => {
    const service: Pick<LarkCardService, 'pin' | 'unpin'> = {
      pin: vi.fn(),
      unpin: vi.fn().mockRejectedValue(new Error('Lark API timeout'))
    };
    const map = new Map<string, string>();
    map.set('lark.pin.app_test.om_fail', JSON.stringify({
      messageId: 'om_fail',
      appId: 'app_test',
      taskId: 'task_crashed',
      status: 'pinned',
      pinnedAt: new Date().toISOString()
    }));
    const store = {
      get: vi.fn(async (key: string) => map.get(key)),
      set: vi.fn(async (key: string, value: string) => { map.set(key, value); }),
      list: vi.fn(async (prefix: string) => Array.from(map.entries()).filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })))
    };
    const warn = vi.fn();
    const manager = new LarkPinManager(service, { store, log: { warn } });

    // Must not throw
    const result = await manager.reconcile({ appId: 'app_test', activeTaskIds: [] });
    expect(result.unpinned).toEqual(['om_fail']);
    expect(warn).toHaveBeenCalled();
  });
});
