import { describe, expect, it } from 'vitest';
import {
  collectWorkspaceGroups,
  emptyWorkspaceOrganization,
  normalizeWorkspaceDirectoryInput,
  normalizeWorkspaceGroupName,
  normalizeWorkspacePath,
  parseWorkspaceOrganization,
  resolveWorkspaceGroupId,
  sessionWorkspaceDirectory,
  workspaceName,
  type WorkspaceOrganization,
  type WorkspaceOrganizationSession
} from './workspace-organization.js';

const session = (id: string, cwd: string, workspaceSourceCwd?: string): WorkspaceOrganizationSession => ({ id, cwd, workspaceSourceCwd });

describe('workspace path helpers', () => {
  it('trims and strips trailing separators while keeping root', () => {
    expect(normalizeWorkspacePath('  /repo/proj// ')).toBe('/repo/proj');
    expect(normalizeWorkspacePath('/')).toBe('/');
    expect(normalizeWorkspacePath('C:\\repo\\proj\\\\')).toBe('C:\\repo\\proj');
  });

  it('keeps Windows drive roots with one separator and canonicalizes both slash styles', () => {
    // 盘根不能被去尾分隔符退化成 C:，否则会被误判为相对路径
    expect(normalizeWorkspacePath('C:\\')).toBe('C:\\');
    expect(normalizeWorkspacePath('C:/')).toBe('C:\\');
    expect(normalizeWorkspacePath('  d:\\\\\\  ')).toBe('d:\\');
    expect(normalizeWorkspacePath('C:\\repo\\\\')).toBe('C:\\repo');
  });

  it('accepts Windows drive roots as absolute directories', () => {
    expect(normalizeWorkspaceDirectoryInput('C:\\')).toBe('C:\\');
    expect(normalizeWorkspaceDirectoryInput('C:/')).toBe('C:\\');
    expect(normalizeWorkspaceDirectoryInput('d:\\\\\\')).toBe('d:\\');
    // 无分隔符的裸盘符仍然不是合法绝对路径（跨平台文本解析，不依赖本机 path.isAbsolute）
    expect(() => normalizeWorkspaceDirectoryInput('C:')).toThrow();
    expect(normalizeWorkspaceDirectoryInput('C:\\abs\\path\\')).toBe('C:\\abs\\path');
  });

  it('canonicalizes drive-root sessions and directory rules to the same key', () => {
    // session 源目录写 C:/ 、目录规则写 C:\，规范后必须命中同一规则
    const org: WorkspaceOrganization = {
      groups: [{ id: 'wg_root', name: '盘根组' }],
      directoryGroups: { 'C:\\': 'wg_root' },
      sessionGroups: {}
    };
    expect(resolveWorkspaceGroupId(session('s1', 'C:/'), org)).toBe('wg_root');
    // worktree 源目录是另一块盘，不应命中 C 盘规则
    expect(resolveWorkspaceGroupId(session('s2', 'C:\\', 'D:/'), org)).toBeUndefined();
    const slashRule: WorkspaceOrganization = {
      groups: [{ id: 'wg_root', name: '盘根组' }],
      directoryGroups: { [normalizeWorkspacePath('D:/')]: 'wg_root' },
      sessionGroups: {}
    };
    expect(slashRule.directoryGroups).toEqual({ 'D:\\': 'wg_root' });
    expect(resolveWorkspaceGroupId(session('s3', 'D:\\'), slashRule)).toBe('wg_root');
  });

  it('derives the last path segment as the name', () => {
    expect(workspaceName('/srv/repo/dutydeck')).toBe('dutydeck');
    expect(workspaceName('/')).toBe('/');
  });

  it('prefers workspaceSourceCwd over cwd', () => {
    expect(sessionWorkspaceDirectory(session('s1', '/data/.worktrees/abc', '/data/repo'))).toBe('/data/repo');
    expect(sessionWorkspaceDirectory(session('s2', '/data/repo'))).toBe('/data/repo');
    expect(sessionWorkspaceDirectory(session('s3', '/data/.worktrees/abc', '  '))).toBe('/data/.worktrees/abc');
  });

  it('validates names and absolute directories', () => {
    expect(normalizeWorkspaceGroupName('  中文组名 ')).toBe('中文组名');
    expect(() => normalizeWorkspaceGroupName('   ')).toThrow();
    expect(() => normalizeWorkspaceGroupName('x'.repeat(81))).toThrow();
    expect(normalizeWorkspaceDirectoryInput('/abs/path/')).toBe('/abs/path');
    expect(normalizeWorkspaceDirectoryInput('C:\\abs\\path')).toBe('C:\\abs\\path');
    expect(() => normalizeWorkspaceDirectoryInput('relative/path')).toThrow();
  });
});

describe('collectWorkspaceGroups', () => {
  const sessionsList = [
    session('s1', '/data/repo-a'),
    session('s2', '/data/repo-a'),
    session('s3', '/data/repo-b'),
    session('s4', '/data/worktrees/wt4', '/data/repo-a')
  ];

  it('groups unconfigured sessions by full normalized source directory, merging worktrees', () => {
    const groups = collectWorkspaceGroups(sessionsList);
    const a = groups.find(group => group.id === '/data/repo-a');
    expect(a).toBeDefined();
    expect(a!.custom).toBe(false);
    expect(a!.name).toBe('repo-a');
    expect(a!.sessionIds).toEqual(['s1', 's2', 's4']);
    expect(a!.directories).toEqual(['/data/repo-a']);
    expect(groups.find(group => group.id === '/data/repo-b')!.sessionIds).toEqual(['s3']);
  });

  it('lists every custom group including empty ones', () => {
    const org: WorkspaceOrganization = {
      ...emptyWorkspaceOrganization(),
      groups: [{ id: 'wg_empty', name: '空组' }]
    };
    const groups = collectWorkspaceGroups(sessionsList, org);
    const empty = groups.find(group => group.id === 'wg_empty');
    expect(empty).toMatchObject({ custom: true, name: '空组', directories: [], sessionIds: [] });
  });

  it('applies directory rules and keeps the rule directory visible for empty groups', () => {
    const org: WorkspaceOrganization = {
      groups: [{ id: 'wg_a', name: 'A 组' }],
      directoryGroups: { '/data/repo-a': 'wg_a' },
      sessionGroups: {}
    };
    const groups = collectWorkspaceGroups(sessionsList, org);
    const a = groups.find(group => group.id === 'wg_a');
    expect(a!.sessionIds).toEqual(['s1', 's2', 's4']);
    // 目录规则对未来任务继承：即使当前没有成员，规则目录仍在 directories 中。
    const emptyRuleOrg: WorkspaceOrganization = {
      groups: [{ id: 'wg_future', name: '预留' }],
      directoryGroups: { '/data/future-repo': 'wg_future' },
      sessionGroups: {}
    };
    const future = collectWorkspaceGroups(sessionsList, emptyRuleOrg).find(group => group.id === 'wg_future');
    expect(future!.directories).toEqual(['/data/future-repo']);
    expect(future!.sessionIds).toEqual([]);
  });

  it('lets a session override win over its directory rule', () => {
    const org: WorkspaceOrganization = {
      groups: [{ id: 'wg_a', name: 'A' }, { id: 'wg_b', name: 'B' }],
      directoryGroups: { '/data/repo-a': 'wg_a' },
      sessionGroups: { s1: 'wg_b' }
    };
    const groups = collectWorkspaceGroups(sessionsList, org);
    expect(groups.find(group => group.id === 'wg_b')!.sessionIds).toEqual(['s1']);
    expect(groups.find(group => group.id === 'wg_a')!.sessionIds).toEqual(['s2', 's4']);
    // 覆盖任务的实际源目录也出现在目标组 directories 中。
    expect(groups.find(group => group.id === 'wg_b')!.directories).toEqual(['/data/repo-a']);
    // 重置单任务覆盖后回到目录规则。
    const reset: WorkspaceOrganization = { ...org, sessionGroups: {} };
    expect(resolveWorkspaceGroupId(sessionsList[0], reset)).toBe('wg_a');
    expect(resolveWorkspaceGroupId(sessionsList[0], org)).toBe('wg_b');
  });

  it('ignores mappings pointing at deleted groups', () => {
    const org: WorkspaceOrganization = {
      groups: [],
      directoryGroups: { '/data/repo-a': 'wg_gone' },
      sessionGroups: { s1: 'wg_gone' }
    };
    const groups = collectWorkspaceGroups(sessionsList, org);
    expect(groups.find(group => group.id === '/data/repo-a')!.sessionIds).toContain('s1');
  });
});

describe('parseWorkspaceOrganization', () => {
  it('returns empty config for missing or malformed JSON', () => {
    expect(parseWorkspaceOrganization(undefined)).toEqual(emptyWorkspaceOrganization());
    expect(parseWorkspaceOrganization('not json')).toEqual(emptyWorkspaceOrganization());
    expect(parseWorkspaceOrganization('{"groups":[]}')).toEqual(emptyWorkspaceOrganization());
  });

  it('drops dangling mappings and keeps valid ones', () => {
    const parsed = parseWorkspaceOrganization(JSON.stringify({
      groups: [{ id: 'wg_1', name: '组' }],
      directoryGroups: { '/repo': 'wg_1', '/other': 'wg_missing' },
      sessionGroups: { s1: 'wg_1', s2: 'wg_missing' }
    }));
    expect(parsed.directoryGroups).toEqual({ '/repo': 'wg_1' });
    expect(parsed.sessionGroups).toEqual({ s1: 'wg_1' });
  });
});
