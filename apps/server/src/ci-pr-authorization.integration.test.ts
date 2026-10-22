import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { AgentDriver, NormalizedDriverEvent } from '@dutydeck/shared';
import { createRepositories, executionTaskId } from '@dutydeck/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CiProviderRegistry } from './ci-providers.js';
import { CiWebhookService } from './ci-webhook.js';
import { PullRequestService, type PullRequestRecord } from './pull-requests.js';

const run = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe.each(['CI', 'PR'] as const)('%s 最终提交授权', kind => {
  it.each(['cancel', 'metadata', 'contention'] as const)('检查期间并发 %s 后，真实 runtime 只提交仍获授权的任务', async mutation => {
    const root = await mkdtemp(join(tmpdir(), 'dutydeck-authorization-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const remote = join(root, 'remote.git');
    const cwd = join(root, 'work');
    await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await run('git', ['clone', '-q', remote, cwd]);
    const git = async (...args: string[]) => (await run('git', ['-C', cwd, ...args])).stdout.trim();
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await writeFile(join(cwd, 'app.ts'), 'export const a = 1;\n');
    await git('add', '.');
    await git('commit', '-qm', 'initial');
    const headSha = await git('rev-parse', 'HEAD');
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    cleanups.push(async () => repos.close());
    let emit!: (event: NormalizedDriverEvent) => void;
    const driver: AgentDriver = {
      start: async () => {}, send: vi.fn(async () => { emit({ type: 'text', data: { text: 'fixed' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); }),
      stop: async () => {}, isStopped: async () => true, interrupt: async () => {}, resume: async () => {}, resolvePermission: async () => true, setModel: async () => {}
    };
    let phaseNow = '';
    let service!: CiWebhookService | PullRequestService;
    const runtime = new DutydeckRuntime(repos, {
      workspaceRoot: join(root, 'workspaces'), cleanupIntervalMs: 0, driverIdleTimeoutMs: 0,
      probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
      driverFactory: (_config, _protocol, onEvent) => { emit = onEvent; return driver; },
      authorizeTask: async (_session, task, phase) => { phaseNow = phase; await service.authorizeTask(task, phase); }
    });
    cleanups.push(() => runtime.shutdown());
    await runtime.initialize([{
      id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'ask', timeout: 10,
      capabilities: { pause: false, resume: true }, builtin: false
    }]);
    const session = await runtime.start({ agentId: 'mock', cwd });
    const providers = new CiProviderRegistry();
    providers.register('fake-plugin', {
      id: 'fake', displayName: 'Fake',
      matchRepository: url => url === remote ? { owner: 'group', name: 'repo', slug: 'group/repo' } : undefined,
      webhook: { verify: () => ({ ok: true }), parse: () => undefined }
    });
    const options = { repositories: repos, runtime, providers };
    service = kind === 'CI' ? new CiWebhookService(options) : new PullRequestService(options);
    const id = 'authorization_race';
    const key = 'authorization-fix';
    const taskId = executionTaskId('runtime', session.id, key);
    const stamp = new Date().toISOString();
    const common = {
      schemaVersion: 1 as const, id, revision: 1, sessionId: session.id, provider: 'fake', branch: 'main', headSha,
      task: { id: taskId, key, round: 1, baseSha: headSha, prompt: 'fix' },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: stamp, updatedAt: stamp
    };
    const recordKey = kind === 'CI' ? `ci_webhook/subscription/${id}` : `pull_request/record/${id}`;
    const record = kind === 'CI'
      ? { ...common, repository: 'group/repo', autoFix: true, status: 'running', rounds: 1, fingerprints: {}, task: { ...common.task, kind: 'fix' } }
      : {
        ...common, repository: { owner: 'group', name: 'repo', slug: 'group/repo' }, status: 'open', title: 'Fix', body: '', target: 'main', baseSha: headSha,
        files: [], excluded: [], commits: [], contents: [], paths: ['app.ts'], ciRounds: 1, reviewRounds: 0, fingerprints: {}, handledComments: [], ownComments: [], questions: [],
        task: { ...common.task, kind: 'ci', comments: [] }
      } satisfies PullRequestRecord;
    await repos.config.set(recordKey, JSON.stringify(record));
    if (kind === 'CI') repos.ciWebhook.bindTask(taskId, id, Date.now());
    else await repos.config.set(`pull_request/task/${taskId}`, id);
    let entered!: () => void;
    const checking = new Promise<void>(resolve => entered = resolve);
    let release!: () => void;
    const paused = new Promise<void>(resolve => release = resolve);
    // 在真实 Git/快照核对后暂停，确定取消发生在旧记录的最终条件写回之前。
    const internals = service as unknown as Record<string, (...args: any[]) => Promise<unknown>>;
    const method = kind === 'CI' ? 'head' : 'workspaceDivergence';
    const original = internals[method]!.bind(service);
    let checks = 0;
    internals[method] = async (...args) => {
      checks += 1;
      const result = await original(...args);
      if (phaseNow === 'submit') { entered(); await paused; }
      return result;
    };
    const task = await runtime.dispatch(session.id, 'fix', 'queue', 'fix', undefined, undefined, key);
    await checking;
    expect(driver.send).not.toHaveBeenCalled();
    expect((await service.get(id))?.task?.startedAt).toBeUndefined();
    if (mutation === 'cancel') await service.cancel(session.id, id);
    else {
      const raw = (await repos.config.get(recordKey))!;
      expect(await repos.config.compareAndSet!(recordKey, raw, JSON.stringify({ ...JSON.parse(raw), revision: 2, reason: 'concurrent metadata' }))).toBe(true);
    }
    if (mutation === 'contention') {
      const compareAndSet = repos.config.compareAndSet!.bind(repos.config);
      vi.spyOn(repos.config, 'compareAndSet').mockImplementation((key, expected, value) => key === recordKey ? Promise.resolve(false) : compareAndSet(key, expected, value));
    }
    release();
    await vi.waitFor(async () => expect((await repos.tasks.get!(task.id))?.status).toBe(mutation === 'metadata' ? 'completed' : 'failed'));
    if (mutation !== 'metadata') {
      expect(driver.send).not.toHaveBeenCalled();
      expect(repos.execution.getTaskExecution(task.id)?.attempts[0]?.submissionState).toBe('not_submitted');
      expect(await service.get(id)).toMatchObject({ status: mutation === 'cancel' ? (kind === 'CI' ? 'cancelled' : 'stopped') : (kind === 'CI' ? 'running' : 'open') });
      if (mutation === 'contention') expect(checks).toBe(6);
    } else {
      expect(driver.send).toHaveBeenCalledTimes(1);
      expect(JSON.parse((await repos.config.get(recordKey))!)).toMatchObject({ reason: 'concurrent metadata', task: { startedAt: expect.any(String) } });
      // 已开始的任务不因随后工作区改变重新走开工检查。
      const before = checks;
      await writeFile(join(cwd, 'app.ts'), 'export const a = 2;\n');
      await git('add', '.');
      await git('commit', '-qm', 'already started');
      await expect(service.authorizeTask((await repos.tasks.get!(task.id))!, 'submit')).resolves.toBeUndefined();
      expect(checks).toBe(before);
    }
  });
});
