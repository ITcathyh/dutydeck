import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { canonicalExecutionJson, type AcceptedTaskInput, type TaskRequestV1 } from '@dutydeck/shared';
import { materializeLarkResources } from './lark/session-resolver.js';
import { LarkTaskInbox } from './lark/task-inbox.js';
import { larkResourceRoot, pruneLarkResourceDirectories, readLarkResourceReferences } from './resource-retention.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const bytes = Buffer.from('attachment retained across restart\0\u4e2d\u6587');
const hash = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');
const event = { messageId: 'om_attachment', chatId: 'oc_fixture', chatType: 'group' as const, messageType: 'file', content: '{"file_key":"file_fixture","file_name":"evidence.txt"}', mentions: [] };
const resource = { type: 'file' as const, key: 'file_fixture', fileName: 'evidence.txt', label: '附件' };
const old = new Date(Date.now() - 2 * 86_400_000);

async function fixture(existingDirectory?: string, filename = 'dutydeck.db') {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'dutydeck-resource-ledger-'));
  if (!existingDirectory) cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, filename);
  let repos = createRepositories(database);
  repos.execution.upgradeLegacy();
  let claim = repos.control.attachRuntime('attachment-test');
  cleanups.push(() => { claim.release(); repos.close(); });
  let execution = repos.execution.bind(claim);
  const fence = { sessionId: 'session', runId: 'run' };
  execution.createSession({ id: fence.sessionId, runId: fence.runId, agentId: 'fixture', cwd: directory, state: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  let inbox = new LarkTaskInbox(repos.config);
  const record = (await inbox.claim('cli_fixture', event))!;
  const root = larkResourceRoot(database);
  const service = {
    downloadMessageResource: vi.fn(),
    downloadMessageResourceToFile: vi.fn(async (_message: string, _key: string, destination: string) => {
      await writeFile(destination, bytes); return { contentType: 'text/plain' };
    })
  };
  const prompt = await materializeLarkResources(event.messageId, 'Read the evidence', [resource], service, undefined, {
    root, retain: directory => inbox.update(record, { resourceDirectories: [...(record.resourceDirectories ?? []), directory] })
  });
  await inbox.update(record, { sessionId: fence.sessionId, materials: { prompt, readMessageIds: [event.messageId] } });
  const content = { version: 2 as const, prompt: 'Read the evidence', executionOptions: { permissionMode: 'ask' as const }, executionContext: { agentPrompt: prompt }, contentSources: [] };
  const input: AcceptedTaskInput = { ...content, digest: hash(content) };
  const request: TaskRequestV1 = { version: 1, namespace: 'runtime', key: event.messageId, sessionId: fence.sessionId, actor: { kind: 'unspecified' }, prompt: content.prompt, mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: null };
  const task = execution.acceptTask(fence, request, input, 'back').task!;
  await inbox.update(record, { state: 'accepted', taskId: task.id });
  const path = prompt.match(/已下载到本地：(.+?)。/)![1]!;
  const bucket = dirname(path);
  await utimes(bucket, old, old);
  return {
    database, root, path, bucket, task, fence, record,
    get repos() { return repos; }, get inbox() { return inbox; }, get execution() { return execution; },
    sweep: () => pruneLarkResourceDirectories(root, { readProtectedDirectories: () => readLarkResourceReferences(repos.config, repos.tasks) }),
    reopen: () => {
      claim.release(); repos.close(); repos = createRepositories(database);
      claim = repos.control.attachRuntime('attachment-restart'); execution = repos.execution.bind(claim); inbox = new LarkTaskInbox(repos.config);
    }
  };
}

describe('persistent attachment retention', () => {
  it('keeps actual materialized inbox and accepted ledger bytes across TTL and database reopen, then collects the settled task', async () => {
    const h = await fixture();
    expect(await h.sweep()).toBe(0);
    h.reopen();
    expect(await h.sweep()).toBe(0);
    const recovered = await h.inbox.lookup('cli_fixture', event.messageId);
    expect(recovered?.materials?.prompt).toContain(h.path);
    expect((await h.repos.tasks.get!(h.task.id))?.executionContext?.agentPrompt).toContain(h.path);
    expect(await readFile(h.path)).toEqual(bytes);
    const attempt = h.execution.claimNext(h.fence)!.attempt!;
    h.execution.settleAttempt({ ...h.fence, taskId: h.task.id, attemptId: attempt.attemptId, expectedRevision: attempt.revision }, 'cancel-fixture', { kind: 'not_submitted', outcome: 'cancelled', reason: 'fixture complete' });
    // A result-feedback card is historical UI, not a future attachment reader.
    await h.repos.config.set('lark.interaction.cli_fixture.result', JSON.stringify({ appId: 'cli_fixture', event, kind: 'result', state: 'pending' }));
    expect(await h.sweep()).toBe(1);
    expect(existsSync(h.path)).toBe(false);
  });

  it('protects running, approval-held, and unknown attempts after reopening', async () => {
    const h = await fixture();
    const attempt = h.execution.claimNext(h.fence)!.attempt!;
    expect(await h.sweep()).toBe(0);
    const recovery = { kind: 'pty-jsonl-v1' as const, turnId: 'original-turn', transcript: { offset: 0 } };
    let remote = h.execution.beforeCreate(h.fence, { resourceId: 'remote', kind: 'remote' });
    remote = h.execution.spawned(h.fence, 'remote', remote.revision, { identityId: 'remote-id', kind: 'remote', locator: { session: 'remote-fixture' } });
    remote = h.execution.creationFinished(h.fence, 'remote', remote.revision, 'created');
    remote = h.execution.observed(h.fence, 'remote', remote.revision, { observationId: 'live', state: 'live', identityId: 'remote-id', evidenceRef: 'fixture-owned', observedAt: new Date().toISOString() });
    const active = h.execution.markSubmissionPending({ ...h.fence, taskId: h.task.id, attemptId: attempt.attemptId, expectedRevision: attempt.revision }, { submissionId: 'unknown-send', inputDigest: hash('input'), recovery, resourceRefs: [{ resourceId: 'remote', identityId: 'remote-id' }], authorizationRefs: [] }).attempt!;
    h.reopen();
    remote = h.execution.observed(h.fence, 'remote', remote.revision, { observationId: 'unknown', state: 'unknown', identityId: 'remote-id', evidenceRef: 'fixture-unreachable', observedAt: new Date().toISOString() });
    h.execution.recoverAttempt({ ...h.fence, taskId: h.task.id, attemptId: active.attemptId, expectedRevision: active.revision }, { kind: 'original_turn', decisionId: 'cannot-attach', submissionId: 'unknown-send', recovery, resources: [{ resourceId: 'remote', expectedRevision: remote.revision, observationId: 'unknown' }], attached: false });
    expect((await h.repos.tasks.get!(h.task.id))?.status).toBe('reconcile_required');
    expect(await h.sweep()).toBe(0);
    expect(await readFile(h.path)).toEqual(bytes);
  });

  it.each(['ask', 'plan'])('holds terminal task files for pending %s approval and the approved child, then releases them', async kind => {
    const h = await fixture();
    const attempt = h.execution.claimNext(h.fence)!.attempt!;
    h.execution.settleAttempt({ ...h.fence, taskId: h.task.id, attemptId: attempt.attemptId, expectedRevision: attempt.revision }, 'cancel-fixture', { kind: 'not_submitted', outcome: 'cancelled', reason: 'deferred fixture' });
    const interaction = { id: 'approval', appId: 'cli_fixture', sessionId: h.fence.sessionId, taskId: h.task.id, event, state: 'pending', kind, durable: { snapshot: { prompt: h.record.materials!.prompt } } };
    await h.repos.config.set('lark.interaction.cli_fixture.approval', JSON.stringify(interaction));
    expect(await h.sweep()).toBe(0);
    await h.inbox.seed('cli_fixture', { ...event, messageId: 'confirmation_approval' }, { prompt: h.record.materials!.prompt, scopeId: 'scope', resources: [] }, { sessionId: h.fence.sessionId, workflowRequestId: 'approval' });
    await h.repos.config.set('lark.interaction.cli_fixture.approval', JSON.stringify({ ...interaction, state: 'approved' }));
    expect(await h.sweep()).toBe(0);
    const child = (await h.inbox.claim('cli_fixture', { ...event, messageId: 'confirmation_approval' }))!;
    await h.inbox.update(child, { state: 'failed' });
    expect(await h.sweep()).toBe(1);
  });

  it('skips the entire sweep when any persistent protection read fails', async () => {
    const h = await fixture();
    const orphan = join(h.root, 'orphan'); await mkdir(orphan); await utimes(orphan, old, old);
    const store = { ...h.repos.config, list: async (prefix: string) => { if (prefix === 'lark.interaction.') throw new Error('database read failed'); return h.repos.config.list!(prefix); } };
    expect(await pruneLarkResourceDirectories(h.root, { readProtectedDirectories: () => readLarkResourceReferences(store, h.repos.tasks) })).toBe(0);
    expect(existsSync(orphan)).toBe(true);
    expect(await pruneLarkResourceDirectories(h.root, { readProtectedDirectories: () => readLarkResourceReferences(h.repos.config, { get: async () => { throw new Error('task read failed'); } }) })).toBe(0);
    expect(existsSync(orphan)).toBe(true);
    expect(await readFile(h.path)).toEqual(bytes);
  });

  it('skips a sweep when approval handoff changes the inbox while the protection snapshot is read', async () => {
    const h = await fixture();
    const attempt = h.execution.claimNext(h.fence)!.attempt!;
    h.execution.settleAttempt({ ...h.fence, taskId: h.task.id, attemptId: attempt.attemptId, expectedRevision: attempt.revision }, 'cancel-fixture', { kind: 'not_submitted', outcome: 'cancelled', reason: 'deferred fixture' });
    let handedOff = false;
    const store = { ...h.repos.config, list: async (prefix: string) => {
      if (prefix === 'lark.interaction.' && !handedOff) {
        handedOff = true;
        await h.inbox.seed('cli_fixture', { ...event, messageId: 'confirmation_handoff' }, { prompt: h.record.materials!.prompt, scopeId: 'scope', resources: [] }, { sessionId: h.fence.sessionId, workflowRequestId: 'handoff' });
        await h.repos.config.set('lark.interaction.cli_fixture.handoff', JSON.stringify({ id: 'handoff', appId: 'cli_fixture', event, kind: 'ask', state: 'answered' }));
      }
      return h.repos.config.list!(prefix);
    } };
    expect(await pruneLarkResourceDirectories(h.root, { readProtectedDirectories: () => readLarkResourceReferences(store, h.repos.tasks) })).toBe(0);
    expect(await h.sweep()).toBe(0);
    expect(await readFile(h.path)).toEqual(bytes);
    const child = (await h.inbox.claim('cli_fixture', { ...event, messageId: 'confirmation_handoff' }))!;
    await h.inbox.update(child, { state: 'failed' });
    expect(await h.sweep()).toBe(1);
  });

  it('does not download after losing the inbox claim and reclaims the empty orphan normally', async () => {
    const h = await fixture();
    let orphan = '';
    const download = vi.fn();
    await expect(materializeLarkResources('lost-claim', 'read', [resource], { downloadMessageResource: download, downloadMessageResourceToFile: download }, undefined, {
      root: h.root, retain: async directory => { orphan = directory; await h.inbox.update({ ...h.record, boot: 'lost-claim' }, { resourceDirectories: [directory] }); }
    })).rejects.toThrow('Lark inbox claim was lost');
    expect(download).not.toHaveBeenCalled();
    expect(await readdir(orphan)).toEqual([]);
    await utimes(orphan, old, old);
    expect(await h.sweep()).toBe(1);
    expect(await readFile(h.path)).toEqual(bytes);
  });

  it('isolates databases sharing the same TMPDIR and preserves the legacy shared root', async () => {
    const a = await fixture(), b = await fixture(dirname(a.database), 'other-instance.db');
    expect(a.root).not.toBe(b.root);
    expect(larkResourceRoot(':memory:')).not.toBe(larkResourceRoot(':memory:'));
    const legacy = join(dirname(a.database), 'legacy-tmp', 'dutydeck', 'lark-resources', 'unowned');
    await mkdir(legacy, { recursive: true }); await writeFile(join(legacy, 'file'), bytes); await utimes(legacy, old, old);
    expect(await a.sweep()).toBe(0);
    expect(await readFile(b.path)).toEqual(bytes);
    expect(await readFile(join(legacy, 'file'))).toEqual(bytes);
  });

  it('protects an aged in-flight directory even if cleanup read its snapshot before retention was published', async () => {
    const h = await fixture();
    let finish!: () => void, started!: () => void;
    const atDownload = new Promise<void>(resolve => { started = resolve; });
    const resume = new Promise<void>(resolve => { finish = resolve; });
    let directory = '';
    const pending = materializeLarkResources('same-message', 'read', [resource], {
      downloadMessageResource: vi.fn(), downloadMessageResourceToFile: async (_id, _key, destination) => {
        await writeFile(destination, bytes); await utimes(dirname(destination), old, old); started(); await resume; return {};
      }
    }, undefined, { root: h.root, retain: async path => { directory = path; } });
    await atDownload;
    expect(await pruneLarkResourceDirectories(h.root, { readProtectedDirectories: async () => new Set([h.bucket]) })).toBe(0);
    finish(); const result = await pending;
    expect(result).toContain(directory);
    expect(await readFile(result.match(/已下载到本地：(.+?)。/)![1]!)).toEqual(bytes);
    await utimes(directory, old, old);
    expect(await pruneLarkResourceDirectories(h.root, { readProtectedDirectories: async () => new Set([h.bucket]) })).toBe(1);
  });

  it('canonicalizes a configured database parent alias before choosing its owned namespace', async () => {
    const h = await fixture();
    const alias = join(dirname(h.database), 'data-alias');
    await symlink(dirname(h.database), alias);
    expect(larkResourceRoot(join(alias, 'dutydeck.db'))).toBe(h.root);
    expect(await h.sweep()).toBe(0);
    expect(await readFile(h.path)).toEqual(bytes);
  });

  it('refuses symlink roots and never follows symlink directory entries outside its bucket', async () => {
    const h = await fixture();
    const outside = join(dirname(h.database), 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), bytes); await utimes(outside, old, old);
    await symlink(outside, join(h.root, 'symlink-entry'));
    expect(await h.sweep()).toBe(0);
    const linkedRoot = join(dirname(h.database), 'linked'); await symlink(outside, linkedRoot);
    expect(await pruneLarkResourceDirectories(linkedRoot, { readProtectedDirectories: async () => new Set() })).toBe(0);
    const download = vi.fn();
    await expect(materializeLarkResources('escape', 'read', [resource], { downloadMessageResource: download, downloadMessageResourceToFile: download }, undefined, { root: linkedRoot, retain: async () => {} })).rejects.toThrow('Unsafe attachment resource root');
    expect(download).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual(['keep']);
    expect(await readFile(join(outside, 'keep'))).toEqual(bytes);
  });
});
