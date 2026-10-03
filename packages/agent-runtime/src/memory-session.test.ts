import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentConfigSchema } from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from './index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
it('admits one stable background session, checks immutable scope and never restarts terminal history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-background-'));
  const repos = createRepositories(join(directory, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const start = vi.fn(async () => {}), stop = vi.fn(async () => {}), authorize = vi.fn(async () => {});
  const runtime = new DutydeckRuntime(repos, {
    workspaceRoot: join(directory, 'workspaces'), cleanupIntervalMs: 0,
    probe: (() => ({ available: true, protocol: 'acp', acp: true })) as any,
    driverFactory: () => ({ start, stop, isStopped: async () => true, send: async () => {}, interrupt: async () => {} })
  });
  cleanups.push(async () => { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  await runtime.initialize([agentConfigSchema.parse({ id: 'agent', name: 'Agent', command: 'fake', protocol: 'acp', cwd: directory, permissionMode: 'ask' })]);
  const id = 'ses_memory_' + 'a'.repeat(64);
  const input = { agentId: 'agent', cwd: directory, source: 'lark-memory', sourceId: 'app:groups:memory', permissionMode: 'ask' as const };
  const first = await runtime.startMemorySession(input, id, authorize);
  expect((await runtime.startMemorySession(input, id, authorize)).id).toBe(first.id);
  expect(start).toHaveBeenCalledTimes(1);
  for (const patch of [{ sourceId: 'app:other:memory' }, { permissionMode: 'full-trust' as const }, { model: 'changed' }, { cwd: '/other' }, { reasoningEffort: 'high' }]) {
    await expect(runtime.startMemorySession({ ...input, ...patch }, id, authorize)).rejects.toMatchObject({ code: 'MEMORY_SESSION_CONFLICT' });
  }
  await runtime.stop(id, { kind: 'installation_owner', id: 'installation_owner' });
  expect((await runtime.startMemorySession(input, id, authorize)).state).toBe('stopped');
  expect(start).toHaveBeenCalledTimes(1);
  await expect(runtime.startMemorySession(input, 'ses_memory_' + 'b'.repeat(64), async () => { throw new Error('revoked'); })).rejects.toThrow('revoked');
  expect(await repos.sessions.get('ses_memory_' + 'b'.repeat(64))).toBeUndefined();
});
it.each(['acp','pty-cli'] as const)('resolves auto to %s before freezing memory permission mode', async protocol => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-capability-'));
  const repos = createRepositories(join(directory,'state.db'),{ newDatabaseAuthority:'ledger_v1' });
  const probe = vi.fn(() => ({ available:true,protocol,acp:protocol === 'acp' }));
  const start = vi.fn(async () => {});
  const runtime = new DutydeckRuntime(repos,{ workspaceRoot:join(directory,'work'),cleanupIntervalMs:0,probe:probe as any,driverFactory:() => ({ start,stop:async () => {},isStopped:async () => true,send:async () => {},interrupt:async () => {} }) });
  cleanups.push(async () => { await runtime.shutdown();repos.close();await rm(directory,{ recursive:true,force:true }); });
  await runtime.initialize([agentConfigSchema.parse({ id:'agent',name:'Agent',command:'fake',protocol:'auto',cwd:directory,model:'fixed',reasoningEffort:'high' })]);
  const resolved = await runtime.resolveMemorySessionInput({ agentId:'agent',source:'lark-memory',sourceId:'app:groups:memory' });
  expect(resolved).toMatchObject({ cwd:directory,model:'fixed',reasoningEffort:'high',permissionMode:protocol === 'acp' ? 'deny-all' : 'ask' });
  const session = await runtime.startMemorySession(resolved,'ses_memory_'+'c'.repeat(64),async () => {});
  expect(session.protocol).toBe(protocol);
  expect(session.permissionMode).toBe(resolved.permissionMode);
  expect(start).toHaveBeenCalledTimes(1);
});
