import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalExecutionJson } from '@dutydeck/shared';
import { createRepositories } from './index.js';

it('adopts only the exact idle receipt under the current claim, keeping creation ownership immutable', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dd-idle-adoption-')), path = join(cwd, 'state.db');
  let repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  let claim = repos.control.attachRuntime('first');
  const f = { sessionId: 'session', runId: 'run' }, at = new Date().toISOString();
  try {
    let x = repos.execution.bind(claim);
    x.createSession({ id: f.sessionId, runId: f.runId, agentId: 'fixture', cwd, state: 'idle', protocol: 'pty-cli', terminalBackend: 'tmux', permissionMode: 'full-trust', createdAt: at, updatedAt: at });
    const parent = x.beforeCreate(f, { resourceId: 'parent', kind: 'operation' });
    let r = x.beforeCreate(f, { resourceId: 'pane', parentResourceId: parent.resourceId, kind: 'local_only' });
    r = x.spawned(f, r.resourceId, r.revision, { identityId: 'identity', kind: 'local_only', locator: { owner: 'runtime-adapter' } });
    r = x.creationFinished(f, r.resourceId, r.revision, 'created');
    x.creationFinished(f, parent.resourceId, parent.revision, 'created');
    const receipt = canonicalExecutionJson({ runId: f.runId, resourceId: r.resourceId, identityId: 'identity', options: { permissionMode: 'full-trust' }, identity: { kind: 'tmux', reason: 'unconfirmed_claude_source' } });
    await repos.config.set(`runtime_idle_terminal:${f.sessionId}`, receipt);
    const observation = { observationId: 'verified-live', identityId: 'identity', state: 'live' as const, observedAt: at, evidenceRef: 'idle-terminal:' + createHash('sha256').update(receipt).digest('hex') };
    const old = x;
    claim.release(); repos.close(); repos = createRepositories(path); claim = repos.control.attachRuntime('second'); x = repos.execution.bind(claim);
    const unchanged = () => expect(repos.execution.getResources(f.sessionId).find(value => value.resourceId === r.resourceId)).toEqual(r);
    expect(() => old.adoptIdleTmux(f, r.resourceId, r.revision, receipt, observation)).toThrow(); unchanged();
    expect(() => x.adoptIdleTmux(f, r.resourceId, r.revision - 1, receipt, observation)).toThrow(); unchanged();
    expect(() => x.adoptIdleTmux({ ...f, runId: 'stale' }, r.resourceId, r.revision, receipt, observation)).toThrow(); unchanged();
    expect(() => x.adoptIdleTmux(f, r.resourceId, r.revision, receipt + ' ', observation)).toThrow(); unchanged();
    expect(() => x.adoptIdleTmux(f, r.resourceId, r.revision, receipt, { ...observation, identityId: 'foreign' })).toThrow(); unchanged();
    await repos.artifacts.savePermission(f.sessionId, { id: 'pending', title: 'Pending approval', status: 'pending' });
    expect(() => x.adoptIdleTmux(f, r.resourceId, r.revision, receipt, observation)).toThrow(); unchanged();
    await repos.artifacts.savePermission(f.sessionId, { id: 'pending', title: 'Pending approval', status: 'denied' });
    const adopted = x.adoptIdleTmux(f, r.resourceId, r.revision, receipt, observation);
    expect(adopted.controller).toEqual(r.controller);
    expect(adopted.holder?.instanceId).toBe('second');
    expect(adopted.revision).toBe(r.revision + 1);
    expect(() => x.adoptIdleTmux(f, r.resourceId, r.revision, receipt, observation)).toThrow();
    const input = { version: 2 as const, prompt: 'next', executionOptions: { permissionMode: 'full-trust' as const }, executionContext: { agentPrompt: 'next' }, contentSources: [] };
    x.acceptTask(f, { version: 1, namespace: 'runtime', sessionId: f.sessionId, key: 'next', prompt: 'next', mode: 'queue', actor: { kind: 'unspecified' }, skills: [], options: {}, sources: [], sourcePayload: null },
      { ...input, digest: createHash('sha256').update(canonicalExecutionJson(input)).digest('hex') }, 'back');
    expect(x.claimNext(f, [{ resourceId: adopted.resourceId, expectedRevision: adopted.revision, observationId: observation.observationId }])?.attempt).toBeDefined();
    expect(() => x.adoptIdleTmux(f, adopted.resourceId, adopted.revision, receipt, { ...observation, observationId: 'active' })).toThrow();
    const stale = x; claim.release(); claim = repos.control.attachRuntime('third');
    expect(() => stale.adoptIdleTmux(f, adopted.resourceId, adopted.revision, receipt, observation)).toThrow(expect.objectContaining({ code: 'DATABASE_RUNTIME_CLAIM_REVOKED' }));
    expect(repos.execution.getResources(f.sessionId).find(value => value.resourceId === adopted.resourceId)).toEqual(adopted);
  } finally { claim.release(); repos.close(); rmSync(cwd, { recursive: true, force: true }); }
});
