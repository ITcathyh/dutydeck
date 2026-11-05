import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import type { PermissionRequestData } from '@dutydeck/shared';
import { WorkspaceApprovals, registerWorkspaceApprovalRoutes } from './workspace-approvals.js';
import { buildApp } from './app.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

const request = (command: string, exact = true, cwd = '/agent/reported'): PermissionRequestData =>
  ({ id: 'perm', title: '运行命令', status: 'pending', operation: { source: 'acp_tool_call', kind: 'execute', cwd, command, ...(exact ? { commandExact: true as const } : {}) } });

async function setup(session: Record<string, unknown> = {}, requester: string | null = 'ou_alice') {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-workspace-rules-'));
  const repos = createRepositories(':memory:');
  cleanup.push(() => rm(directory, { recursive: true, force: true }), () => repos.close());
  const link = join(directory, 'link');
  await symlink(directory, link);
  const sessions = new Map([['ses', { id: 'ses', source: 'lark', permissionMode: 'ask', cwd: link, ...session }]]);
  const approvals = new WorkspaceApprovals({ rules: repos.workspaceApprovalRules!, getSession: async id => sessions.get(id) as any, humanRequester: () => requester ?? undefined });
  return { approvals, repos, directory, link, workspace: await realpath(directory) };
}
const scope = { appId: 'cli_a', sessionId: 'ses', taskId: 'task', requester: 'ou_alice' };

describe('WorkspaceApprovals', () => {
  it('keys rules by the real path of the session directory, never by the Agent-reported cwd', async () => {
    const h = await setup();
    expect(await h.approvals.candidate(scope, request('pnpm test --filter x'))).toEqual({ workspace: h.workspace, pattern: 'pnpm test' });
    await h.approvals.remember({ appId: 'cli_a', workspace: h.workspace, pattern: 'pnpm test' }, 'ou_alice');
    expect(await h.approvals.match(scope, request('pnpm test --filter x', true, '/somewhere/else'))).toBe('pnpm test');
    expect(await h.approvals.list({ workspace: h.link })).toEqual([expect.objectContaining({ appId: 'cli_a', workspace: h.workspace, pattern: 'pnpm test', createdBy: 'ou_alice' })]);
    expect(await h.approvals.list({ workspace: join(h.directory, 'missing') })).toEqual([]);
    // 规则按机器人隔离：另一个机器人在同一目录里照常弹卡，也能建自己的规则。
    expect(await h.approvals.match({ ...scope, appId: 'cli_b' }, request('pnpm test'))).toBeUndefined();
    expect(await h.approvals.candidate({ ...scope, appId: 'cli_b' }, request('pnpm test'))).toEqual({ workspace: h.workspace, pattern: 'pnpm test' });
  });

  it('only acts on unredacted string commands in Lark sessions that are not full-trust and were started by this requester', async () => {
    const h = await setup();
    h.repos.workspaceApprovalRules!.add({ appId: 'cli_a', workspace: h.workspace, pattern: 'pnpm test', createdBy: 'ou_alice' });
    expect(await h.approvals.match(scope, request('pnpm test', false))).toBeUndefined();
    expect(await h.approvals.candidate(scope, request('pnpm test', false))).toBeUndefined();
    expect(await h.approvals.match({ ...scope, requester: 'ou_bob' }, request('pnpm test'))).toBeUndefined();
    for (const [session, requester] of [[{ source: 'web' }, 'ou_alice'], [{ permissionMode: 'full-trust' }, 'ou_alice'], [{}, null]] as const) {
      const other = await setup(session, requester);
      other.repos.workspaceApprovalRules!.add({ appId: 'cli_a', workspace: other.workspace, pattern: 'pnpm test', createdBy: 'ou_alice' });
      expect(await other.approvals.match(scope, request('pnpm test'))).toBeUndefined();
      expect(await other.approvals.candidate(scope, request('pnpm test'))).toBeUndefined();
    }
  });

  it('refuses to save a rule it could not have derived', async () => {
    const h = await setup();
    await expect(h.approvals.remember({ appId: 'cli_a', workspace: h.workspace, pattern: 'bash -c' }, 'ou_alice')).rejects.toThrow(/not derivable/);
    await expect(h.approvals.remember({ appId: 'cli_a', workspace: h.workspace, pattern: 'pnpm' }, 'ou_alice')).rejects.toThrow(/not derivable/);
    expect(h.repos.workspaceApprovalRules!.list()).toEqual([]);
  });

  it('never uses the home directory or the filesystem root as a workspace', async () => {
    for (const cwd of [homedir(), '/']) {
      const h = await setup({ cwd });
      expect(await h.approvals.candidate(scope, request('pnpm test')), cwd).toBeUndefined();
      h.repos.workspaceApprovalRules!.add({ appId: 'cli_a', workspace: await realpath(cwd), pattern: 'pnpm test', createdBy: 'ou_alice' });
      expect(await h.approvals.match(scope, request('pnpm test')), cwd).toBeUndefined();
      await expect(h.approvals.remember({ appId: 'cli_a', workspace: await realpath(cwd), pattern: 'git status' }, 'ou_alice')).rejects.toThrow(/home directory or the filesystem root/);
    }
  });
});

describe('workspace approval rule routes', () => {
  it('lists and revokes rules for the installation owner only', async () => {
    const h = await setup();
    const app = Fastify();
    cleanup.push(() => app.close());
    let authorized = false;
    registerWorkspaceApprovalRoutes(app, { service: h.approvals, authorize: () => authorized });
    const rule = h.repos.workspaceApprovalRules!.add({ appId: 'cli_a', workspace: h.workspace, pattern: 'pnpm test', createdBy: 'ou_alice' });
    h.repos.workspaceApprovalRules!.add({ appId: 'cli_a', workspace: '/other', pattern: 'git status', createdBy: 'ou_alice' });
    expect((await app.inject('/api/workspace-approval-rules')).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/workspace-approval-rules/${rule.id}` })).statusCode).toBe(403);
    authorized = true;
    expect((await app.inject('/api/workspace-approval-rules')).json().rules).toHaveLength(2);
    const filtered = await app.inject(`/api/workspace-approval-rules?workspace=${encodeURIComponent(h.link)}`);
    expect(filtered.json()).toEqual({ rules: [rule] });
    expect((await app.inject('/api/workspace-approval-rules?app=cli_a')).json().rules).toHaveLength(2);
    expect((await app.inject('/api/workspace-approval-rules?app=cli_b')).json().rules).toEqual([]);
    const removed = await app.inject({ method: 'DELETE', url: `/api/workspace-approval-rules/${rule.id}` });
    expect(removed.json()).toEqual({ removed: rule.id });
    expect((await app.inject({ method: 'DELETE', url: `/api/workspace-approval-rules/${rule.id}` })).statusCode).toBe(404);
    expect((await app.inject('/api/workspace-approval-rules')).json().rules.map((item: { pattern: string }) => item.pattern)).toEqual(['git status']);
  });

  it('is registered by buildApp only when the service is wired', async () => {
    const h = await setup();
    const runtime = { listSessions: async () => [] };
    const wired = await buildApp(runtime as any, { workspaceApprovals: { service: h.approvals, authorize: () => true } });
    const bare = await buildApp(runtime as any, {});
    cleanup.push(() => wired.close(), () => bare.close());
    expect((await wired.inject('/api/workspace-approval-rules')).json()).toEqual({ rules: [] });
    expect((await bare.inject('/api/workspace-approval-rules')).statusCode).toBe(404);
  });
});
