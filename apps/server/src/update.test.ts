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

  it('runs the foreground preflight before any npm call even with --force', async () => {
    const runNpm = vi.fn();
    const restart = vi.fn();
    const drain = vi.fn();
    const preflight = vi.fn(async () => { throw new Error('未登记前台无法接管'); });
    await expect(updateDutydeck('0.1.22', { version: '1.2.3', force: true }, { runNpm, restart, drain, preflight })).rejects.toThrow('未登记前台无法接管');
    expect(preflight).toHaveBeenCalledOnce();
    expect(runNpm).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
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

  it('installs an exact semver without resolving a dist-tag', async () => {
    const runNpm = vi.fn()
      .mockResolvedValueOnce('installed')
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { dutydeck: { version: '1.2.3-beta.1+build.5' } } }))
      .mockResolvedValueOnce('/opt/npm/lib/node_modules\n');
    const restart = vi.fn(async (_entrypoint: string) => {});
    const drain = vi.fn(async () => {});
    await expect(updateDutydeck('1.2.2', { version: '1.2.3-beta.1+build.5' }, { runNpm, restart, drain })).resolves.toEqual({
      action: 'update', packageName: 'dutydeck', previousVersion: '1.2.2',
      version: '1.2.3-beta.1+build.5', updated: true, restarted: true
    });
    expect(runNpm.mock.calls.map(([args]) => args)).toEqual([
      ['install', '--global', 'dutydeck@1.2.3-beta.1+build.5'],
      ['list', '--global', 'dutydeck', '--depth=0', '--json'],
      ['root', '--global']
    ]);
    expect(drain).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledWith('/opt/npm/lib/node_modules/dutydeck/dist/cli.js', { force: undefined, drainTimeout: undefined });
  });

  it('rejects a version combined with a dist-tag before invoking npm', async () => {
    const runNpm = vi.fn();
    await expect(updateDutydeck('1.2.2', { version: '1.2.3', distTag: 'next' }, { runNpm, restart: vi.fn() }))
      .rejects.toThrow('mutually exclusive');
    expect(runNpm).not.toHaveBeenCalled();
  });

  it.each(['1.2', '^1.2.3', '~1.2.3', 'latest', 'v1.2.3', '1.02.3', '1.2.3-01', '1.2.3 --force', '--registry=http://example.invalid', '1.2.3; reboot'])(
    'rejects non-exact or injectable version %s before invoking npm', async version => {
      const runNpm = vi.fn();
      await expect(updateDutydeck('1.2.2', { version }, { runNpm, restart: vi.fn() })).rejects.toThrow('Invalid exact Dutydeck version');
      expect(runNpm).not.toHaveBeenCalled();
    }
  );

  it('preserves the installation error prefix, code and cause while appending a package-specific rollback command', async () => {
    const cause = Object.assign(new Error('npm install failed: registry unavailable'), { code: 'EAI_AGAIN' });
    const runNpm = vi.fn().mockResolvedValueOnce('"1.2.3"').mockRejectedValueOnce(cause);
    const error = await updateDutydeck('1.2.2', {}, { runNpm, restart: vi.fn(), packageName: '@example/dutydeck' })
      .catch((caught: unknown) => caught as Error & { code?: string });
    expect(error.message).toMatch(/^npm install failed: registry unavailable/);
    expect(error.message).toContain('To roll back, run: npm install --global @example/dutydeck@1.2.2 && dutydeck restart');
    expect(error.code).toBe('EAI_AGAIN');
    expect(error.cause).toBe(cause);
  });

  it('preserves the verification error prefix, appends rollback guidance, and does not restart', async () => {
    const runNpm = vi.fn()
      .mockResolvedValueOnce('installed')
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { dutydeck: { version: '1.2.4' } } }));
    const restart = vi.fn();
    await expect(updateDutydeck('1.2.2', { version: '1.2.3' }, { runNpm, restart })).rejects.toThrow(
      /^Dutydeck update verification failed: 1\.2\.3 resolved to 1\.2\.3, but npm installed 1\.2\.4\. The service was not restarted\.[\s\S]*npm install --global dutydeck@1\.2\.2 && dutydeck restart/
    );
    expect(restart).not.toHaveBeenCalled();
  });

  it('preserves the restart error prefix and gives rollback guidance without internal paths or automatic rollback', async () => {
    const runNpm = vi.fn()
      .mockResolvedValueOnce('"1.2.3"')
      .mockResolvedValueOnce('installed')
      .mockResolvedValueOnce(JSON.stringify({ dependencies: { dutydeck: { version: '1.2.3' } } }))
      .mockResolvedValueOnce('/private/internal/npm\n');
    const restart = vi.fn(async () => { throw new Error('Dutydeck restart exited with code 1.'); });
    const attempt = updateDutydeck('1.2.2', {}, { runNpm, restart });
    await expect(attempt).rejects.toThrow(
      /^Dutydeck restart exited with code 1\.[\s\S]*To roll back, run: npm install --global dutydeck@1\.2\.2 && dutydeck restart/
    );
    const error = await attempt.catch((caught: unknown) => caught as Error);
    expect(runNpm).toHaveBeenCalledTimes(4);
    expect(error.message).not.toContain('/private/internal/npm');
  });

  it('states when a missing or unsafe previous version cannot produce a rollback command', async () => {
    for (const previousVersion of ['', 'not-a-version', '1.2.2; reboot']) {
      const runNpm = vi.fn().mockResolvedValueOnce('"1.2.3"').mockRejectedValueOnce(new Error('npm install failed'));
      const error = await updateDutydeck(previousVersion, {}, { runNpm, restart: vi.fn() }).catch((caught: unknown) => caught as Error);
      expect(error.message).toMatch(/^npm install failed/);
      expect(error.message).toContain('No safe rollback command can be generated because the previous version is missing or is not an exact semver.');
      expect(error.message).not.toContain('To roll back, run:');
      expect(error.message).not.toContain('npm install --global');
    }
  });
});
