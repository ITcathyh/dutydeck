import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSqliteDriver, describeSqliteDriverFailure } from './sqlite-preflight.js';

describe('SQLite 驱动预检', () => {
  it('当前进程内：能打开 :memory: 时报告成功并带上本进程的版本与 ABI', () => {
    expect(checkSqliteDriver()).toEqual({ ok: true, execPath: process.execPath, nodeVersion: process.version, modules: process.versions.modules });
  });

  it('子进程：由目标解释器自己加载驱动，版本信息来自那个解释器', () => {
    const check = checkSqliteDriver({ execPath: process.execPath });
    expect(check).toEqual({ ok: true, execPath: process.execPath, nodeVersion: process.version, modules: process.versions.modules });
  });

  it('子进程：从入口脚本位置解析不到驱动时失败，仍报告解释器的版本与 ABI', () => {
    const empty = mkdtempSync(join(tmpdir(), 'sqlite-preflight-'));
    try {
      const check = checkSqliteDriver({ execPath: process.execPath, resolveFrom: join(empty, 'dist', 'cli.js') });
      expect(check).toMatchObject({ ok: false, execPath: process.execPath, nodeVersion: process.version, modules: process.versions.modules });
      expect(check.error).toContain('better-sqlite3');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('子进程：解释器不存在时失败，不伪造版本信息', () => {
    const check = checkSqliteDriver({ execPath: '/nonexistent/bin/node' });
    expect(check.ok).toBe(false);
    expect(check.nodeVersion).toBeUndefined();
    expect(check.modules).toBeUndefined();
    expect(check.error).toContain('ENOENT');
  });

  it('失败描述写明解释器路径、node 版本、modules 与底层错误', () => {
    const text = describeSqliteDriverFailure({ ok: false, execPath: '/usr/local/node-v26.5.0/bin/node', nodeVersion: 'v26.5.0', modules: '147', error: 'was compiled against a different Node.js version using NODE_MODULE_VERSION 127' });
    expect(text).toContain('/usr/local/node-v26.5.0/bin/node');
    expect(text).toContain('v26.5.0');
    expect(text).toContain('process.versions.modules=147');
    expect(text).toContain('NODE_MODULE_VERSION 127');
  });
});
