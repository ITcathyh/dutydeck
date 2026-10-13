import { describe, expect, it } from 'vitest';
import type { PermissionRequestData } from '@dutydeck/shared';
import { permissionIntent } from './permission-intent.js';

const request = (operation: Partial<NonNullable<PermissionRequestData['operation']>> | undefined, title = 'Agent 请求执行受控操作') =>
  ({ title, ...(operation ? { operation: { source: 'acp_tool_call' as const, ...operation } } : {}) });

describe('permissionIntent', () => {
  it('按工具类别拼出要做什么', () => {
    expect(permissionIntent(request({ kind: 'execute', command: 'pnpm test' }))).toBe('执行命令：pnpm test');
    expect(permissionIntent(request({ kind: 'edit', resource: 'src/a.ts', resourceCount: 3 }))).toBe('修改文件：src/a.ts 等 3 个');
    expect(permissionIntent(request({ kind: 'edit', resource: 'src/a.ts', resourceCount: 1 }))).toBe('修改文件：src/a.ts');
    expect(permissionIntent(request({ kind: 'delete', resource: 'dist' }))).toBe('删除文件：dist');
    expect(permissionIntent(request({ kind: 'move', resource: 'a.ts' }))).toBe('移动文件：a.ts');
    expect(permissionIntent(request({ kind: 'read', resource: '/etc/hosts' }))).toBe('读取：/etc/hosts');
    expect(permissionIntent(request({ kind: 'search', resource: 'src' }))).toBe('搜索：src');
    expect(permissionIntent(request({ kind: 'fetch', resource: 'https://example.com' }))).toBe('访问网络：https://example.com');
  });

  it('PTY hook 来源同样生效', () => {
    expect(permissionIntent({ title: 'Bash', operation: { source: 'claude_permission_hook', kind: 'execute', command: 'rm -rf node_modules' } }))
      .toBe('执行命令：rm -rf node_modules');
  });

  it('类别缺参数时回退到标题', () => {
    expect(permissionIntent(request({ kind: 'execute' }, '运行测试'))).toBe('执行命令：运行测试');
    expect(permissionIntent(request({ kind: 'read' }, 'Read config'))).toBe('读取：Read config');
  });

  it('缺 kind 时按命令、资源、标题依次回退', () => {
    expect(permissionIntent(request({ command: 'ls -la' }))).toBe('执行命令：ls -la');
    expect(permissionIntent(request({ resource: 'src/a.ts', resourceCount: 2 }))).toBe('操作：src/a.ts 等 2 个');
    expect(permissionIntent(request({ kind: 'other' }, 'mcp__docs__search'))).toBe('mcp__docs__search');
    expect(permissionIntent(request(undefined, '写入配置'))).toBe('写入配置');
    expect(permissionIntent(request(undefined, '  '))).toBe('Agent 请求执行受控操作');
  });

  it('摘要按卡片展示口径脱敏', () => {
    expect(permissionIntent(request({ kind: 'execute', command: 'deploy --token=synthetic-secret' }))).toBe('执行命令：deploy --token=[REDACTED]');
  });

  it('合并空白成一行并截断到 120 字', () => {
    expect(permissionIntent(request({ kind: 'execute', command: 'pnpm\n  test\t--run' }))).toBe('执行命令：pnpm test --run');
    const intent = permissionIntent(request({ kind: 'execute', command: 'x'.repeat(500) }));
    expect(intent).toHaveLength(120);
    expect(intent.endsWith('…')).toBe(true);
  });
});
