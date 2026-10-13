import { createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Session, TaskRecord } from '@dutydeck/shared';
import { createRepositories, executionTaskId } from '@dutydeck/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CiProviderRegistry } from '../../../apps/server/src/ci-providers.js';
import { CiWebhookService, type CiNotice } from '../../../apps/server/src/ci-webhook.js';
import { createCodebaseProvider, parseCodebaseEvent, repositoryFromRemote, verifyCodebaseWebhook } from '../provider.mjs';

const run = promisify(execFile);
const secret = 'hook-secret-for-tests';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('Codebase webhook 校验', () => {
  const request = (headers: Record<string, string>, body = '{"type":"codebase.pipeline"}', token?: string) => ({ rawBody: Buffer.from(body), headers, ...(token ? { query: { token } } : {}) });

  it('令牌可放在专用头、Bearer 或 URL 参数里，错误或缺失都拒绝', () => {
    expect(verifyCodebaseWebhook(secret, request({ 'x-dutydeck-token': secret }))).toEqual({ ok: true });
    expect(verifyCodebaseWebhook(secret, request({ authorization: `Bearer ${secret}` }))).toEqual({ ok: true });
    expect(verifyCodebaseWebhook(secret, request({}, '{}', secret))).toEqual({ ok: true });
    expect(verifyCodebaseWebhook(secret, request({ 'x-dutydeck-token': `${secret}x` }))).toMatchObject({ ok: false, statusCode: 401, code: 'WEBHOOK_TOKEN_INVALID' });
    expect(verifyCodebaseWebhook(secret, request({}))).toMatchObject({ ok: false, statusCode: 401 });
  });

  it('签名覆盖时间戳和原始请求体，改动任一处都失败', () => {
    const body = '{"type":"codebase.pipeline","status":"failed"}';
    const stamp = '1790323200';
    const signature = `sha256=${createHmac('sha256', secret).update(`${stamp}.${body}`).digest('hex')}`;
    expect(verifyCodebaseWebhook(secret, request({ 'x-dutydeck-signature': signature, 'x-dutydeck-timestamp': stamp }, body))).toEqual({ ok: true, signedAt: 1_790_323_200_000 });
    expect(verifyCodebaseWebhook(secret, request({ 'x-dutydeck-signature': signature, 'x-dutydeck-timestamp': stamp }, body.replace('failed', 'success')))).toMatchObject({ ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' });
    expect(verifyCodebaseWebhook(secret, request({ 'x-dutydeck-signature': signature, 'x-dutydeck-timestamp': '1790323201' }, body))).toMatchObject({ ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' });
    expect(verifyCodebaseWebhook(secret, request({ 'x-dutydeck-signature': signature }, body))).toMatchObject({ ok: false, statusCode: 400, code: 'WEBHOOK_TIMESTAMP_MISSING' });
  });

  it('只认 code.byted.org 的仓库地址', () => {
    expect(repositoryFromRemote('git@code.byted.org:group/repo.git')?.slug).toBe('group/repo');
    expect(repositoryFromRemote('https://code.byted.org/group/sub/repo')).toEqual({ owner: 'group/sub', name: 'repo', slug: 'group/sub/repo' });
    expect(repositoryFromRemote('git@github.com:octo/repo.git')).toBeUndefined();
    expect(repositoryFromRemote('https://code.byted.org/../etc')).toBeUndefined();
  });

  it('没有配置 webhook_secret 时不提供 webhook', () => {
    expect(createCodebaseProvider().webhook).toBeUndefined();
    expect(createCodebaseProvider({ webhookSecret: secret })).toMatchObject({ id: 'codebase', displayName: 'Codebase 流水线' });
    expect(createCodebaseProvider().changeRequestLabel!(12)).toBe('MR !12');
  });

  it('GitLab 风格载荷用 object_attributes 里的完成时间校验，并识别失败任务', () => {
    const event = parseCodebaseEvent({
      object_kind: 'pipeline', project: { path_with_namespace: 'group/repo' }, user: { username: 'bob' },
      object_attributes: { id: 7, ref: 'feat/ci', sha: 'a'.repeat(40), status: 'failed', finished_at: '2026-09-25 08:00:00 UTC' },
      builds: [{ name: 'unit', stage: 'test', status: 'failed', failure_reason: 'script_failure' }, { name: 'lint', stage: 'test', status: 'success' }]
    });
    expect(event).toMatchObject({ kind: 'pipeline', repository: 'group/repo', branch: 'feat/ci', state: 'failed', operator: 'bob', occurredAt: Date.parse('2026-09-25T08:00:00Z') });
    expect(event?.failures).toEqual([{ job: 'unit', stage: 'test', reason: 'script_failure', log: undefined }]);
  });

  it('信封载荷映射成宿主的事件形状；X-Dutydeck-Event-Id 优先作为事件 id；坏 JSON 抛 400', () => {
    const provider = createCodebaseProvider({ webhookSecret: secret });
    const body = { id: 'evt-body', type: 'codebase.merge_request', repository: 'group/repo', branch: 'refs/heads/feat/ci', mr: '12', action: 'merged' };
    expect(provider.webhook!.parse({ rawBody: Buffer.from(JSON.stringify(body)), headers: { 'x-dutydeck-event-id': 'evt-header' } }))
      .toMatchObject({ kind: 'pull_request', branch: 'feat/ci', pullRequest: 12, state: 'merge', eventId: 'evt-header' });
    expect(provider.webhook!.parse({ rawBody: Buffer.from(JSON.stringify(body)), headers: {} })).toMatchObject({ eventId: 'evt-body' });
    expect(() => provider.webhook!.parse({ rawBody: Buffer.from('{'), headers: {} })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

/** 工作区 origin 写成 Codebase 地址，推送经 pushInsteadOf 落到本地裸仓库。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dutydeck-codebase-ci-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const cwd = join(root, 'work');
  const git = async (...args: string[]) => (await run('git', ['-C', cwd, ...args])).stdout.trim();
  await run('git', ['init', '-q', '--bare', remote]);
  await run('git', ['init', '-q', cwd]);
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await git('checkout', '-q', '-b', 'feat/ci');
  await writeFile(join(cwd, 'app.ts'), 'export const value = 1;\n');
  await git('add', '.');
  await git('commit', '-qm', 'initial');
  await git('remote', 'add', 'origin', 'git@code.byted.org:group/repo.git');
  await git('config', `url.${remote}.pushInsteadOf`, 'git@code.byted.org:group/repo.git');
  await git('push', '-q', 'origin', 'HEAD:feat/ci');

  const now = { value: Date.parse('2026-09-25T08:00:00.000Z') };
  const session: Session = { id: 'ses_ci', agentId: 'codex', state: 'idle', cwd, runId: 'run_1', source: 'lark', sourceId: 'cli_app:oc_chat:group', createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z' };
  const tasks = new Map<string, TaskRecord>();
  const dispatches: Array<{ prompt: string }> = [];
  const runtime = {
    getSession: vi.fn(async (id: string) => id === session.id ? session : undefined),
    dispatch: vi.fn(async (sessionId: string, prompt: string, _mode: 'queue', _agentPrompt: string, _risk: undefined, _actorId?: string, key?: string) => {
      const id = executionTaskId('runtime', sessionId, key!);
      if (!tasks.has(id)) {
        tasks.set(id, { id, sessionId, prompt, status: 'queued', createdAt: new Date(now.value).toISOString(), updatedAt: new Date(now.value).toISOString() });
        dispatches.push({ prompt });
      }
      return { id, status: tasks.get(id)!.status };
    })
  };
  const notices: CiNotice[] = [];
  const database = createRepositories(':memory:');
  cleanups.push(async () => database.close());
  const providers = new CiProviderRegistry();
  providers.register('codebase', createCodebaseProvider({ webhookSecret: secret }));
  const service = new CiWebhookService({
    repositories: { config: database.config, ciWebhook: database.ciWebhook, tasks: { get: async (id: string) => tasks.get(id), save: async () => {}, listBySession: async () => [] }, execution: { getTaskExecution: () => undefined, getAttemptEvents: () => [] } as any },
    runtime, providers, notify: async (_sessionId, _id, notice) => { notices.push(notice); return `om_card_${notices.length}`; }, clock: () => new Date(now.value)
  });
  cleanups.push(() => service.close());
  const subscription = (await service.subscribe(session.id, { autoFix: true }, 'ou_owner'))!;
  const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) => service.receive('codebase', {
    rawBody: Buffer.from(JSON.stringify(body)),
    headers: { 'x-dutydeck-token': secret, 'x-dutydeck-timestamp': String(Math.floor(now.value / 1_000)), ...headers }
  });
  const pipeline = (sha: string, status: string, failures: Array<Record<string, unknown>> = [], id = randomUUID()) => ({
    id, type: 'codebase.pipeline', repository: 'group/repo', branch: 'feat/ci', sha, status,
    pipeline: { id: '42', url: 'https://code.byted.org/group/repo/pipelines/42' }, operator: 'alice', failures
  });
  return { now, tasks, dispatches, notices, service, subscription, post, pipeline, head: () => git('rev-parse', 'HEAD') };
}

const unitFailure = [{ job: 'unit-test', stage: 'test', reason: 'script_failure', log: 'FAIL src/math.test.ts > adds\nAssertionError: expected 3 to be 4' }];

describe('Codebase 插件接入宿主的 CI webhook', () => {
  it('订阅结果带上提供方名字', async () => {
    const f = await fixture();
    expect(f.subscription).toMatchObject({ provider: 'codebase', providerName: 'Codebase 流水线', repository: 'group/repo', branch: 'feat/ci' });
  });

  it('时间戳超出 5 分钟窗口按重放拒绝；签名请求缺时间戳直接拒绝；都不触发任务', async () => {
    const f = await fixture();
    const sha = await f.head();
    const stamp = Math.floor(f.now.value / 1_000) - 301;
    const stale = await f.post(f.pipeline(sha, 'failed', unitFailure), { 'x-dutydeck-timestamp': String(stamp) });
    expect(stale).toMatchObject({ statusCode: 401, body: { error: { code: 'WEBHOOK_TIMESTAMP_EXPIRED' } } });
    const staleBody = await f.service.receive('codebase', { rawBody: Buffer.from(JSON.stringify({ ...f.pipeline(sha, 'failed', unitFailure), timestamp: stamp })), headers: { 'x-dutydeck-token': secret } });
    expect(staleBody).toMatchObject({ statusCode: 401, body: { error: { code: 'WEBHOOK_TIMESTAMP_EXPIRED' } } });
    const rawBody = Buffer.from(JSON.stringify(f.pipeline(sha, 'failed', unitFailure)));
    const unsigned = await f.service.receive('codebase', { rawBody, headers: { 'x-dutydeck-signature': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}` } });
    expect(unsigned).toMatchObject({ statusCode: 400, body: { error: { code: 'WEBHOOK_TIMESTAMP_MISSING' } } });
    expect(f.dispatches).toHaveLength(0);
  });

  it('令牌模式可以不带时间戳：照常处理，只靠 event-id 去重', async () => {
    const f = await fixture();
    const send = (body: Record<string, unknown>) => f.service.receive('codebase', { rawBody: Buffer.from(JSON.stringify(body)), headers: { 'x-dutydeck-token': secret } });
    const event = f.pipeline(await f.head(), 'failed', unitFailure, 'evt-no-time');
    expect(await send(event)).toMatchObject({ statusCode: 202, body: { accepted: true, matched: 1 } });
    expect(await send(event)).toMatchObject({ statusCode: 200, body: { duplicate: true } });
    expect(f.dispatches).toHaveLength(1);
    expect(f.dispatches[0]!.prompt).toContain('Codebase 流水线失败，请按下面的规则修复（第 1/3 轮）');
  });

  it('流水线通过时投递续作任务；MR 合入后停止等待', async () => {
    const f = await fixture();
    await f.post(f.pipeline(await f.head(), 'success'));
    expect(f.dispatches[0]?.prompt).toContain('Codebase 流水线已通过');
    await f.post({ id: 'evt-mr', type: 'codebase.merge_request', repository: 'group/repo', branch: 'feat/ci', mr: 12, action: 'merge', operator: 'bob' });
    expect(await f.service.get(f.subscription.id)).toMatchObject({ mrIid: 12, mrClosed: 'merge', reason: expect.stringContaining('MR !12 已合入') });
  });
});
