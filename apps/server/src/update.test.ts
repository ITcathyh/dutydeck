import { describe, expect, it, vi } from 'vitest';
import { normalizeDistTag, updateDutydeck } from './update.js';

describe('Dutydeck updater', () => {
  it('installs and verifies the selected dist-tag before restarting', async () => {
    const runNpm = vi.fn()
      .mockResolvedValueOnce('"0.1.23-fix.1"\n')
      .mockResolvedValueOnce('installed')
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { 'dutydeck': { version: '0.1.23-fix.1' } } }))
      .mockResolvedValueOnce('/opt/npm/lib/node_modules\n');
    const restart = vi.fn(async (_entrypoint: string) => {});
    const drain = vi.fn(async (_options?: { drainTimeout?: string }) => {});
    await expect(updateDutydeck('0.1.22-fix.3', { distTag: 'fix' }, { runNpm, restart, drain })).resolves.toEqual({
      action: 'update', packageName: 'dutydeck', distTag: 'fix',
      previousVersion: '0.1.22-fix.3', version: '0.1.23-fix.1', updated: true, restarted: true
    });
    expect(runNpm).toHaveBeenNthCalledWith(1, ['view', 'dutydeck@fix', 'version', '--json']);
    expect(runNpm).toHaveBeenNthCalledWith(2, ['install', '--global', 'dutydeck@fix']);
    expect(runNpm).toHaveBeenNthCalledWith(3, ['list', '--global', 'dutydeck', '--depth=0', '--json']);
    expect(runNpm).toHaveBeenNthCalledWith(4, ['root', '--global']);
    expect(restart).toHaveBeenCalledWith('/opt/npm/lib/node_modules/dutydeck/dist/cli.js', { force: undefined, drainTimeout: undefined });
    // 安装前先 drain，且 drain 发生在只读的 view 之后、写盘的 install 之前。
    expect(drain).toHaveBeenCalledWith({ drainTimeout: undefined });
    expect(drain.mock.invocationCallOrder[0]).toBeGreaterThan(runNpm.mock.invocationCallOrder[0]!);
    expect(drain.mock.invocationCallOrder[0]).toBeLessThan(runNpm.mock.invocationCallOrder[1]!);
  });

  it('aborts without installing or restarting when the pre-install drain times out', async () => {
    const runNpm = vi.fn().mockResolvedValueOnce('"0.1.23"\n'); // 只有只读的 view 被允许
    const restart = vi.fn();
    const drain = vi.fn(async () => { throw new Error('等待正在执行的任务结束超时（900 秒），旧服务仍在运行（当前仍有 2 个任务正在执行）。用 dutydeck restart --force 强制重启。'); });
    await expect(updateDutydeck('0.1.22', {}, { runNpm, restart, drain })).rejects.toThrow('超时');
    // 只做了只读 view；install/list/root 一次都没调用，磁盘不会被换成新版。
    expect(runNpm).toHaveBeenCalledTimes(1);
    expect(runNpm).toHaveBeenCalledWith(['view', 'dutydeck@latest', 'version', '--json']);
    expect(restart).not.toHaveBeenCalled();
  });

  it('skips the pre-install drain with --force but still installs and restarts', async () => {
    const runNpm = vi.fn()
      .mockResolvedValueOnce('"0.1.23"')
      .mockResolvedValueOnce('installed')
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { 'dutydeck': { version: '0.1.23' } } }))
      .mockResolvedValueOnce('/opt/npm/lib/node_modules\n');
    const restart = vi.fn(async (_entrypoint: string, _options?: { force?: boolean; drainTimeout?: string }) => {});
    const drain = vi.fn();
    await updateDutydeck('0.1.22', { distTag: 'latest', force: true, drainTimeout: '60' }, { runNpm, restart, drain });
    expect(drain).not.toHaveBeenCalled();
    expect(runNpm).toHaveBeenCalledWith(['install', '--global', 'dutydeck@latest']);
    expect(restart).toHaveBeenCalledWith('/opt/npm/lib/node_modules/dutydeck/dist/cli.js', { force: true, drainTimeout: '60' });
  });

  it('passes --force and --drain-timeout through to the restart step', async () => {
    const runNpm = vi.fn()
      .mockResolvedValueOnce('"0.1.23"')
      .mockResolvedValueOnce('installed')
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { 'dutydeck': { version: '0.1.23' } } }))
      .mockResolvedValueOnce('/opt/npm/lib/node_modules\n');
    const restart = vi.fn(async (_entrypoint: string, _options?: { force?: boolean; drainTimeout?: string }) => {});
    const drain = vi.fn(async (_options?: { drainTimeout?: string }) => {});
    await updateDutydeck('0.1.22', { distTag: 'latest', force: false, drainTimeout: '60' }, { runNpm, restart, drain });
    expect(drain).toHaveBeenCalledWith({ drainTimeout: '60' });
    expect(restart).toHaveBeenCalledWith('/opt/npm/lib/node_modules/dutydeck/dist/cli.js', { force: false, drainTimeout: '60' });
  });

  it('defaults to latest and never restarts when installation verification fails', async () => {
    const runNpm = vi.fn()
      .mockResolvedValueOnce('"0.1.23"')
      .mockResolvedValueOnce('installed')
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { 'dutydeck': { version: '0.1.22' } } }));
    const restart = vi.fn(async (_entrypoint: string) => {});
    const drain = vi.fn(async () => {});
    await expect(updateDutydeck('0.1.22', {}, { runNpm, restart, drain })).rejects.toThrow('service was not restarted');
    expect(runNpm).toHaveBeenCalledWith(['view', 'dutydeck@latest', 'version', '--json']);
    expect(restart).not.toHaveBeenCalled();
  });

  it('rejects unsafe or version-like dist-tags before invoking npm', async () => {
    expect(normalizeDistTag(' fix ')).toBe('fix');
    expect(() => normalizeDistTag('0.1.23')).toThrow('Invalid npm dist-tag');
    expect(() => normalizeDistTag('fix; reboot')).toThrow('Invalid npm dist-tag');
  });
});
