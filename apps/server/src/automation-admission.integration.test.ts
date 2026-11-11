import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import { agentConfigSchema, type CiProvider, type RepositoryBundle, type Session, type WorkItem } from '@dutydeck/shared';
import { CiProviderRegistry } from './ci-providers.js';
import { CiWebhookService } from './ci-webhook.js';
import { PullRequestService } from './pull-requests.js';
import { SessionAutomationService } from './session-automation.js';
import { WorkItemService, workItemId, readWorkItemStatus } from './work-items.js';
import { LeaderModeService } from './leader-mode.js';

const run = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

async function continuation(kind: 'ci' | 'pr', missing: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-admission-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'), remote = join(root, 'remote.git');
  const git = async (...args: string[]) => (await run('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  })).stdout.trim();
  await run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await run('git', ['init', '-q', '-b', 'main', cwd]);
  await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.com');
  await writeFile(join(cwd, 'app.ts'), 'export const value = 1;\n');
  await git('add', '.'); await git('commit', '-qm', 'seed'); await git('remote', 'add', 'origin', remote);
  await git('push', '-q', 'origin', 'main'); await git('checkout', '-qb', 'feature');
  await writeFile(join(cwd, 'app.ts'), 'export const value = 2;\n');
  await git('commit', '-qam', 'feature'); await git('push', '-q', 'origin', 'feature');
  const sha = await git('rev-parse', 'HEAD');
  const repositories = createRepositories(join(root, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  cleanups.push(() => repositories.close());
  let service!: CiWebhookService | PullRequestService;
  let sends = 0;
  const makeRuntime = () => new DutydeckRuntime(repositories, {
    workspaceRoot: join(root, 'workspaces'), cleanupIntervalMs: 0,
    probe: () => ({ available: true, protocol: 'acp', pause: false, resume: true }),
    authorizeTask: (_session, task, phase) => service.authorizeTask(task, phase),
    driverFactory: (_agent, _probe, onEvent) => ({
      start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {},
      isStopped: async () => true, isIdle: () => true, hasBackgroundWork: () => false,
      send: async () => { sends++; onEvent({ type: 'text', data: { text: 'Done' } }); onEvent({ type: 'completed', data: { stopReason: 'end_turn' } }); }
    })
  });
  let runtime = makeRuntime();
  cleanups.push(() => runtime.shutdown());
  const providers = new CiProviderRegistry();
  const provider: CiProvider = {
    id: 'fake', displayName: 'Fake CI', matchRepository: url => url === remote ? { owner: 'example', name: 'repo', slug: 'example/repo' } : undefined,
    webhook: { verify: () => true, parse: request => JSON.parse(request.rawBody.toString()) },
    getPullRequest: async () => ({ state: 'open', headSha: sha, headBranch: 'feature', baseBranch: 'main', headRepository: 'example/repo', title: 'Example PR', url: 'https://example.com/pr/7' }),
    getPipelineStatus: async () => ({ state: 'failed', runs: [{ id: 1, name: 'test', attempt: 1, headSha: sha, status: 'completed', result: 'failed', url: '' }] })
  };
  providers.register('fake-plugin', provider);
  let now = new Date('2026-09-25T08:00:00Z');
  const make = () => kind === 'ci'
    ? new CiWebhookService({ repositories, runtime, providers, clock: () => now })
    : new PullRequestService({ repositories, runtime, providers, clock: () => now });
  service = make();
  cleanups.push(() => service.close());
  runtime.setQueueHeld(true);
  const agents = [agentConfigSchema.parse({ id: 'alpha', name: 'Alpha', command: 'fake', protocol: 'acp', cwd, permissionMode: 'ask' })];
  await runtime.initialize(agents);
  const session = await runtime.start({ agentId: 'alpha', cwd, source: 'web', permissionMode: 'ask' });
  const bind = repositories.ciWebhook.bindTask, cas = repositories.config.compareAndSet!;
  let faults = 0;
  if (missing) {
    repositories.ciWebhook.bindTask = () => { faults++; throw new Error('Crash before binding'); };
    repositories.config.compareAndSet = async (key, expected, value) => {
      if (key.startsWith('pull_request/task/')) { faults++; throw new Error('Crash before binding'); }
      return cas(key, expected, value);
    };
  }
  let id: string;
  try {
    if (service instanceof CiWebhookService) {
      id = (await service.subscribe(session.id, { autoFix: false }, 'installation_owner'))!.id;
      const received = service.receive('fake', { headers: {}, rawBody: Buffer.from(JSON.stringify({ kind: 'pipeline', repository: 'example/repo', branch: 'feature', headSha: sha, state: 'success', eventId: 'evt-1' })) });
      expect(await received).toMatchObject({ statusCode: 202, body: { accepted: true, matched: missing ? 0 : 1 } });
    } else {
      id = (await service.follow(session.id, { pullRequest: '7' }, 'installation_owner')).id;
      await service.idle();
    }
  } finally {
    repositories.ciWebhook.bindTask = bind; repositories.config.compareAndSet = cas;
  }
  expect(faults).toBe(missing ? 1 : 0);
  const saved = (await service.get(id!))!;
  const task = saved.task!;
  expect(task).toBeDefined();
  const binding = () => kind === 'ci' ? Promise.resolve(repositories.ciWebhook.taskSubscription(task.id)) : repositories.config.get(`pull_request/task/${task.id}`);
  expect(await binding()).toBe(missing ? undefined : id!);
  if (missing) expect(await repositories.tasks.get!(task.id)).toBeUndefined();
  await service.close(); service = make(); now = new Date(now.getTime() + 121_000);
  const restart = async () => { await service.close(); service = make(); };
  const restartRuntime = async () => {
    await service.close(); await runtime.shutdown();
    runtime = makeRuntime(); service = make();
    await runtime.initialize(agents);
  };
  return { repositories, get runtime() { return runtime; }, task, id: id!, session, binding, restart, restartRuntime, get service() { return service; }, sends: () => sends };
}

describe('CI and PR durable task binding recovery', () => {
  it.each([['ci', true, false], ['pr', true, false], ['ci', false, false], ['pr', false, false], ['ci', true, true], ['pr', true, true], ['ci', false, true], ['pr', false, true]] as const)('%s authorizes an old unbound queue before any tick, cancelled=%s startup=%s', async (kind, cancelled, startup) => {
    const f = await continuation(kind, true);
    // This is exactly the old redispatch request: real Runtime acceptance, no binding.
    await f.runtime.dispatch(f.session.id, f.task.prompt, 'queue', f.task.prompt, undefined, f.task.actorId, f.task.key);
    expect((await f.repositories.tasks.get!(f.task.id))?.status).toBe('queued');
    expect(await f.binding()).toBeUndefined();
    if (cancelled) await f.service.cancel(f.session.id, f.id);
    if (startup) await f.restartRuntime(); else await f.restart();
    // No business tick runs before Runtime execution authorization.
    f.runtime.setQueueHeld(false);
    await vi.waitFor(async () => expect((await f.repositories.tasks.get!(f.task.id))!.status).toBe(cancelled ? 'failed' : 'completed'));
    expect(f.sends()).toBe(cancelled ? 0 : 1);
    expect(await f.binding()).toBe(cancelled ? undefined : f.id);
    if (cancelled) expect((await f.service.get(f.id))?.status).toBe(kind === 'ci' ? 'cancelled' : 'stopped');
  });

  it.each([['ci', 'ordinary'], ['pr', 'ordinary'], ['ci', 'similar-key'], ['pr', 'similar-key'], ['ci', 'missing-source'], ['pr', 'missing-source'], ['ci', 'internal-prompt'], ['pr', 'internal-prompt'], ['ci', 'namespace'], ['pr', 'namespace'], ['ci', 'other-session'], ['pr', 'other-session']] as const)('%s leaves an ordinary %s request unbound and executable', async (kind, variant) => {
    const f = await continuation(kind, true);
    await f.service.cancel(f.session.id, f.id);
    const key = variant === 'ordinary' ? 'ordinary-request' : variant === 'similar-key' ? `${f.task.key}:suffix` : variant === 'missing-source' ? f.task.key.replace(f.id, 'unrelated-source') : f.task.key;
    const prompt = 'An ordinary user request';
    const sessionId = variant === 'other-session' ? (await f.runtime.start({ agentId: 'alpha', cwd: f.session.cwd, source: 'web', permissionMode: 'ask' })).id : f.session.id;
    const accepted = variant === 'namespace'
      ? await f.runtime.dispatchRequest({ version: 1, namespace: 'automation', sessionId, key, actor: { kind: 'installation_owner', id: 'installation_owner' }, prompt, mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: { agentPrompt: prompt, skills: [] } })
      : await f.runtime.dispatch(sessionId, prompt, 'queue', variant === 'internal-prompt' ? 'Separate user context' : prompt, undefined, 'installation_owner', key);
    await f.restart();
    f.runtime.setQueueHeld(false);
    await vi.waitFor(async () => expect((await f.repositories.tasks.get!(accepted.id))!.status).toBe('completed'));
    expect(f.sends()).toBe(1);
    expect(kind === 'ci' ? f.repositories.ciWebhook.taskSubscription(accepted.id) : await f.repositories.config.get(`pull_request/task/${accepted.id}`)).toBeUndefined();
  });

  it.each([
    ['ci', true, true], ['ci', false, true], ['ci', true, false], ['ci', false, false],
    ['pr', true, true], ['pr', false, true], ['pr', true, false], ['pr', false, false]
  ] as const)('%s missing=%s cancelled=%s preserves admission and cancellation', async (kind, missing, cancel) => {
    const f = await continuation(kind, missing);
    await f.service.tick();
    expect(await f.binding()).toBe(f.id);
    const queued = (await f.repositories.tasks.get!(f.task.id))!;
    expect(queued.status).toBe('queued'); expect(f.sends()).toBe(0);
    if (cancel) {
      await f.service.cancel(f.session.id, f.id);
      await expect(f.service.authorizeTask(queued, 'submit')).rejects.toMatchObject({ code: kind === 'ci' ? 'CI_WEBHOOK_TASK_REVOKED' : 'PR_TASK_REVOKED' });
    }
    f.runtime.setQueueHeld(false);
    await vi.waitFor(async () => expect((await f.repositories.tasks.get!(f.task.id))!.status).toBe(cancel ? 'failed' : 'completed'));
    expect(f.sends()).toBe(cancel ? 0 : 1);
  });

  it.each([['ci', 'binding'], ['pr', 'binding'], ['ci', 'task'], ['pr', 'task'], ['ci', 'context'], ['pr', 'context'], ['ci', 'actor'], ['pr', 'actor']] as const)('%s never claims a conflicting %s during recovery', async (kind, conflict) => {
    const f = await continuation(kind, true);
    if (conflict === 'binding') {
      if (kind === 'ci') f.repositories.ciWebhook.bindTask(f.task.id, 'another-subscription', Date.now());
      else await f.repositories.config.compareAndSet!(`pull_request/task/${f.task.id}`, undefined, 'another-subscription');
    } else {
      // The deterministic key alone does not prove prompt, context or actor ownership.
      const prompt = conflict === 'task' ? 'Unrelated task' : f.task.prompt;
      await f.runtime.dispatch(f.session.id, prompt, 'queue', conflict === 'context' ? 'Different internal prompt' : prompt, undefined, conflict === 'actor' ? undefined : 'installation_owner', f.task.key);
    }
    if (kind === 'ci') await expect(f.service.tick()).rejects.toMatchObject({ code: 'CI_WEBHOOK_TASK_CONFLICT' });
    else await f.service.tick(); // PR isolates a broken record so other follow-ups can still poll.
    expect(await f.binding()).toBe(conflict === 'binding' ? 'another-subscription' : undefined);
    expect((await f.repositories.tasks.get!(f.task.id))?.prompt).toBe(conflict === 'binding' ? undefined : conflict === 'task' ? 'Unrelated task' : f.task.prompt);
    expect(f.sends()).toBe(0);
  });

  it.each(['ci', 'pr'] as const)('%s repairs the binding of an already accepted matching task', async kind => {
    const f = await continuation(kind, true);
    await f.runtime.dispatch(f.session.id, f.task.prompt, 'queue', f.task.prompt, undefined, f.task.actorId, f.task.key);
    await f.service.tick();
    expect(await f.binding()).toBe(f.id);
    await f.service.cancel(f.session.id, f.id);
    f.runtime.setQueueHeld(false);
    await vi.waitFor(async () => expect((await f.repositories.tasks.get!(f.task.id))!.status).toBe('failed'));
    expect(f.sends()).toBe(0);
  });
});

it.each(['normal', 'rename', 'schedule-authorization', 'template-lookup', 'creation'] as const)('coordinates first template creation with schedule changes at %s', async phase => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-template-admission-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repositories = createRepositories(join(root, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  cleanups.push(() => repositories.close());
  const claim = repositories.control.attachRuntime('template-test'); cleanups.push(() => claim.release());
  const timestamp = '2026-09-12T00:00:00.000Z';
  const session: Session = { id: 'ses_parent', runId: 'run_parent', agentId: 'alpha', state: 'idle', cwd: root, source: 'lark', sourceId: 'cli_app:oc_chat:group', permissionMode: 'ask', createdAt: timestamp, updatedAt: timestamp };
  repositories.execution.bind(claim).createSession(session);
  await repositories.agents.save(agentConfigSchema.parse({ id: 'alpha', name: 'Alpha', command: 'fake', protocol: 'acp', cwd: root, permissionMode: 'ask' }));
  const runtime = { getSession: (id: string) => repositories.sessions.get(id), getActiveTaskContext: () => undefined, dispatchRequest: async () => { throw new Error('Template must not dispatch a turn'); } };
  const entered = deferred(), release = deferred();
  let hold = false;
  const gate = async () => { if (hold) { hold = false; entered.resolve(); await release.promise; } };
  const work = new WorkItemService({ repositories, runtime: runtime as any, authorize: async () => { if (phase === 'template-lookup') await gate(); return true; }, prepareDelivery: async () => { if (phase === 'creation' || phase === 'rename') await gate(); } });
  cleanups.push(() => work.close());
  let now = new Date(timestamp);
  const automation = new SessionAutomationService({ repositories, runtime, clock: () => now,
    authorize: async () => { if (phase === 'schedule-authorization') await gate(); return true; },
    workTemplates: { list: (id, actor) => work.listTemplates(id, actor), run: (id, template, version, goal, key, actor, checks) => work.runTemplate(id, template, version, goal, key, actor, undefined, true, checks),
      progress: async id => await work.exists(id) ? readWorkItemStatus(repositories.config, id) ?? 'unknown' : undefined }
  });
  cleanups.push(async () => { release.resolve(); await automation.close(); });
  const seed = await work.create(session.id, { goal: 'Seed', idempotencyKey: 'seed', plan: { title: 'Plan', steps: [{ id: 'one', title: 'One', kind: 'agent', agentId: 'alpha', instruction: 'Do one thing', dependsOn: [] }], outputStepId: 'one' } }, 'ou_owner');
  const template = await work.saveTemplate(session.id, seed.id, 'Template', 'ou_owner');
  const schedule = await automation.createSchedule(session.id, { name: 'Template schedule', prompt: 'Scheduled goal', trigger: { kind: 'interval', everySeconds: 60, anchorAt: timestamp }, timezone: 'UTC', dstPolicy: { gap: 'skip', overlap: 'first' }, condition: { kind: 'always' }, workTemplate: { id: template.id, version: template.version } }, 'ou_owner');
  await automation.updateSchedule(session.id, schedule.id, { expectedRevision: schedule.revision, enabled: true }, 'ou_owner');
  hold = phase !== 'normal'; now = new Date('2026-09-12T00:01:01.000Z');
  const tick = automation.tick();
  if (phase === 'normal') {
    await tick;
    const occurrence = (await automation.listBySession(session.id, 'ou_owner')).occurrences[0]!;
    expect(occurrence.runStatus).toBe('completed');
    expect((await work.get(session.id, occurrence.workItemId!, 'ou_owner')).status).toBe('running');
    return;
  }
  await entered.promise;
  const occurrence = (await automation.listBySession(session.id, 'ou_owner')).occurrences[0]!;
  const id = workItemId(session.id, 'ou_owner', `schedule:${occurrence.id}`);
  expect(occurrence.taskId).toBeUndefined(); expect(occurrence.workItemId).toBeUndefined(); expect(await work.exists(id)).toBe(false);
  const latest = await automation.getScheduleDefinition(session.id, schedule.id);
  if (phase === 'rename') {
    await automation.updateSchedule(session.id, schedule.id, { expectedRevision: latest.revision, name: 'Renamed schedule' }, 'ou_owner');
    release.resolve(); await tick;
    expect(await work.exists(id)).toBe(false);
    expect((await automation.listBySession(session.id, 'ou_owner')).occurrences[0]).toMatchObject({ id: occurrence.id, runStatus: 'pending' });
    await automation.tick();
    expect((await work.get(session.id, id, 'ou_owner')).status).toBe('running');
    expect((await automation.listBySession(session.id, 'ou_owner')).occurrences[0]).toMatchObject({ id: occurrence.id, runStatus: 'completed', workItemId: id });
    return;
  }
  expect((await automation.deleteSchedule(session.id, schedule.id, { expectedRevision: latest.revision }, 'ou_owner')).deletedAt).toBeDefined();
  expect(await work.exists(id)).toBe(false);
  release.resolve(); await tick;
  expect(await work.exists(id)).toBe(false);
  expect((await automation.listBySession(session.id, 'ou_owner')).occurrences[0]).toMatchObject({ runStatus: 'invalidated' });
});

it.each(['start', 'stop'] as const)('holds arbitration slots until pending %s and cleanup really finish', async phase => {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-arbitration-admission-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const data = new Map<string, string>();
  const items = Array.from({ length: 6 }, (_, i) => ({ id: `work_${i}`, status: 'running', goal: 'Review', plan: { steps: [{ id: 'worker', title: 'Worker', instruction: '' }] } }) as WorkItem);
  for (const item of items) data.set(`leader_mode:${item.id}`, JSON.stringify({ workId: item.id, delegationId: item.id, parentSessionId: 'parent', actorId: 'actor', parentTaskId: 'parent_task', answers: [], rulings: [], runs: 0 }));
  const requests = new Map(items.map(item => [item.id, [{ sessionId: `session_${item.id}`, requestId: `request_${item.id}`, stepId: 'worker', taskId: `task_${item.id}`, kind: 'question', text: 'Which implementation?' }]]));
  const release = deferred();
  let starts = 0, stops = 0;
  const repositories = { config: { get: async (key: string) => data.get(key), getSync: (key: string) => data.get(key), compareAndSet: async (key: string, old: string | undefined, next: string) => { if (data.get(key) !== old) return false; data.set(key, next); return true; } }, tasks: { listBySession: async () => [] }, execution: {} };
  const runtime = { getSession: async () => ({ cwd: root }), start: async () => { const id = `leader_${++starts}`; if (phase === 'start') await release.promise; return { id }; },
    subscribe: () => () => {}, dispatch: async () => ({ id: 'decision' }), stop: async () => { stops++; if (phase === 'stop') await release.promise; } };
  const service = new LeaderModeService({ repositories: repositories as unknown as RepositoryBundle, runtime: runtime as any, work: () => ({ peek: async (id: string) => items.find(item => item.id === id) }), interactions: () => ({ requests: (item: WorkItem) => requests.get(item.id) ?? [] }), workspaceRoot: root, timeoutMs: 100 } as any);
  // Isolate roster validation; run the real scheduler, deadline and readonly cleanup path.
  vi.spyOn(service as any, 'team').mockResolvedValue({ parent: { cwd: root }, config: {}, leader: { id: 'fixture', protocol: 'acp' } });
  cleanups.push(async () => { release.resolve(); await service.close(); });
  items.forEach(item => service.observe(item));
  await vi.waitFor(() => expect(starts).toBe(3));
  await vi.waitFor(() => expect(items.slice(0, 3).every(item => JSON.parse(data.get(`leader_mode:${item.id}`)!).rulings.length === 1)).toBe(true));
  expect(starts).toBe(3);
  // Queue entry 4 remains blocked even though the first three deadlines have reported.
  expect(items.slice(3).every(item => JSON.parse(data.get(`leader_mode:${item.id}`)!).runs === 0)).toBe(true);
  release.resolve();
  await vi.waitFor(() => expect(starts).toBe(6));
  await vi.waitFor(() => expect(stops).toBe(6));
});
