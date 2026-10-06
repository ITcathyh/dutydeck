import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  canonicalExecutionJson,
  type NativeContextIdentity,
  type RuntimeControlClaim,
  type StreamIdentity,
  type TaskAttempt,
  type TaskRequestV1,
} from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import { buildSessionMarker } from '@dutydeck/pty-driver';
import {
  INSIGHT_INSTANCE_ID_CONFIG_KEY,
  SessionInsightResolver,
  type CreateTranscriptSourceKeysFn,
  type ResolveSessionInsightSourcesResult,
} from './session-insight-resolver.js';

// 真实脱敏 fixture（tests/fixtures/session-insight/real-native）。
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const REAL_NATIVE = join(REPO_ROOT, 'tests/fixtures/session-insight/real-native');
const CLAUDE_MAIN_FIXTURE = join(REAL_NATIVE, 'claude-main.jsonl');
const CLAUDE_SUB_FIXTURE = join(REAL_NATIVE, 'claude-subagent.jsonl');
const CODEX_FIXTURE = join(REAL_NATIVE, 'codex.jsonl');
const TRAEX_FIXTURE = join(REAL_NATIVE, 'traex.jsonl');

const CLAUDE_NATIVE_ID = '0192e000-7a3b-7000-8000-000000000001';
const CLAUDE_SUB_AGENT = 'a01e15e2adc99f940';
const CODEX_NATIVE_ID = '01a0ffa7-270b-72f1-be55-21dde8e42935';
const TRAEX_NATIVE_ID = '01a0ffa6-a71d-79b3-9a87-d386f1808e41';
const FIXTURE_CWD = '/workspace/test-sandbox';
const CLAUDE_PROJECT_KEY = FIXTURE_CWD.replace(/[^A-Za-z0-9-]/g, '-');
const INSTANCE_ID = 'test-instance-stable';

/**
 * 测试替身：逐字实现 T3c 冻结的 hash 规范。
 */
const createTranscriptSourceKeys: CreateTranscriptSourceKeysFn = (
  instanceId,
  client,
  canonicalDataRoot,
  nativeSessionId,
  streamIdentity
) => {
  if (!nativeSessionId || nativeSessionId.trim() === '') return undefined;
  const stream: StreamIdentity = streamIdentity?.kind === 'subagent'
    ? { kind: 'subagent', nativeAgentId: streamIdentity.nativeAgentId }
    : { kind: 'main', nativeAgentId: null };
  const sessionPayload = JSON.stringify(['session-insight-v1', instanceId, client, canonicalDataRoot, nativeSessionId]);
  const sourceSessionKey = createHash('sha256').update(sessionPayload, 'utf8').digest('hex');
  const sourcePayload = JSON.stringify([sourceSessionKey, stream.kind, stream.nativeAgentId]);
  return { sourceSessionKey, sourceKey: createHash('sha256').update(sourcePayload, 'utf8').digest('hex') };
};

const MAIN: StreamIdentity = { kind: 'main', nativeAgentId: null };
const at = '2026-10-03T03:00:00.000Z';
const hash = (v: unknown) => createHash('sha256').update(canonicalExecutionJson(v)).digest('hex');

interface Harness {
  root: string;
  repos: ReturnType<typeof createRepositories>;
  claim: RuntimeControlClaim;
  x: ReturnType<ReturnType<typeof createRepositories>['execution']['bind']>;
  resolve: (
    sessionId: string,
    options?: {
      configuredRoots?: Array<{ client: 'codex' | 'claude' | 'traex'; path: string }>;
      signal?: AbortSignal;
      deadline?: number;
      instanceId?: string;
      limits?: Record<string, number>;
    }
  ) => Promise<ResolveSessionInsightSourcesResult>;
}

const dirs: string[] = [];
const handles: Array<{ repos: ReturnType<typeof createRepositories>; claim: RuntimeControlClaim }> = [];

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'insight-resolver-'));
  dirs.push(root);
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const claim = repos.control.attachRuntime('resolver-test');
  handles.push({ repos, claim });
  const x = repos.execution.bind(claim);
  const resolve: Harness['resolve'] = (sessionId, options = {}) => {
    const resolver = new SessionInsightResolver({
      repositories: {
        insight: repos.insight,
        sessions: repos.sessions,
        execution: repos.execution,
        config: repos.config,
        agents: repos.agents,
      },
      configuredRoots: options.configuredRoots,
      createTranscriptSourceKeys,
      ...(options.instanceId !== undefined ? { instanceId: options.instanceId } : { instanceId: INSTANCE_ID }),
      ...(options.limits ? { limits: options.limits as never } : {}),
    });
    return resolver.resolveSessionInsightSources(sessionId, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
    });
  };
  return { root, repos, claim, x, resolve };
}

afterEach(() => {
  for (const { repos, claim } of handles.splice(0)) {
    claim.release();
    repos.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function saveAgent(
  h: Harness,
  agent: { id: string; adapterId?: string; protocol?: string; env?: Record<string, string> }
): Promise<void> {
  await h.repos.agents.save({
    id: agent.id,
    name: agent.id,
    command: agent.id,
    args: [],
    protocol: (agent.protocol ?? 'pty-cli') as never,
    ...(agent.adapterId ? { adapterId: agent.adapterId } : {}),
    env: agent.env ?? {},
    permissionMode: 'ask',
    timeout: 600,
    capabilities: { pause: false, resume: true },
    builtin: false,
  });
}

function createSession(
  h: Harness,
  sessionId: string,
  agentId: string,
  cwd = FIXTURE_CWD,
  runId = `run_${sessionId}`
): void {
  h.x.createSession({
    id: sessionId,
    runId,
    agentId,
    cwd,
    state: 'idle',
    createdAt: at,
    updatedAt: at,
  });
}

function setupClaudeHome(root: string, files: Record<string, string>): string {
  const home = join(root, '.claude');
  const projectDir = join(home, 'projects', CLAUDE_PROJECT_KEY);
  mkdirSync(projectDir, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    cpSync(source, join(projectDir, name));
  }
  return home;
}

function setupCodexHome(root: string, files: Array<{ name: string; source: string; mtimeMs?: number }>): string {
  const home = join(root, '.codex');
  const dayDir = join(home, 'sessions', '2026', '10', '03');
  mkdirSync(dayDir, { recursive: true });
  for (const file of files) {
    cpSync(file.source, join(dayDir, file.name));
    if (file.mtimeMs !== undefined) utimesSync(join(dayDir, file.name), file.mtimeMs / 1000, file.mtimeMs / 1000);
  }
  return home;
}

function lifecycleDriver(h: Harness, sessionId: string, runId: string, driverInstanceId = 'driver-1'): void {
  const op = h.x.beforeControlledOperation({ sessionId, runId }, { resourceId: `factory_${driverInstanceId}`, driverInstanceId });
  h.x.creationFinished({ sessionId, runId }, op.resourceId, op.revision, 'created');
}

function localOnlyDriver(h: Harness, sessionId: string, runId: string, resourceId: string): void {
  // 与 LocalDriverLedger.begin/ready 真实序列一致：
  // 1) 先创建 pending operation 父资源；2) 创建 pending local_only 子资源；
  // 3) spawned 绑定 local_only 物理身份；4) 先 finish child 再 finish parent；
  // 5) observed(live) 确认身份。
  const parent = h.x.beforeCreate({ sessionId, runId }, { resourceId: `parent_${resourceId}`, kind: 'operation' });
  const child = h.x.beforeCreate({ sessionId, runId }, { resourceId, kind: 'local_only', parentResourceId: parent.resourceId });
  const spawned = h.x.spawned({ sessionId, runId }, child.resourceId, child.revision, {
    identityId: `ident_${resourceId}`,
    kind: 'local_only',
    locator: { owner: 'runtime-adapter' },
  });
  const finishedChild = h.x.creationFinished({ sessionId, runId }, spawned.resourceId, spawned.revision, 'created');
  h.x.creationFinished({ sessionId, runId }, parent.resourceId, parent.revision, 'created');
  h.x.observed({ sessionId, runId }, finishedChild.resourceId, finishedChild.revision, {
    observationId: `obs_live_${resourceId}`,
    identityId: `ident_${resourceId}`,
    state: 'live',
    evidenceRef: 'original-driver-start-finished',
    observedAt: at,
  });
}

function appendLaunchObserved(
  h: Harness,
  params: {
    sessionId: string;
    runId: string;
    client: 'codex' | 'claude' | 'traex';
    dataRoot: string;
    nativeSessionId: string;
    verifiedPath?: string;
    stream?: StreamIdentity;
    driverInstanceId?: string;
    cwd?: string | null;
  }
): void {
  const stream = params.stream ?? MAIN;
  const keys = createTranscriptSourceKeys(INSTANCE_ID, params.client, params.dataRoot, params.nativeSessionId, stream)!;
  h.repos.insight.bindSources(h.claim).appendObserved({
    observationId: `obs_${createHash('sha256').update(JSON.stringify([
      params.sessionId, params.client, params.nativeSessionId, params.verifiedPath ?? null, JSON.stringify(stream),
    ])).digest('hex').slice(0, 16)}`,
    sessionId: params.sessionId,
    activeRunId: params.runId,
    driverInstanceId: params.driverInstanceId ?? 'driver-1',
    client: params.client,
    launchKind: 'created',
    proofKind: 'launch_observed',
    capturedAt: at,
    dataRoot: params.dataRoot,
    ...(params.cwd !== undefined ? { cwd: params.cwd } : { cwd: FIXTURE_CWD }),
    nativeSessionId: params.nativeSessionId,
    ...(params.verifiedPath ? { verifiedPath: params.verifiedPath } : { verifiedPath: null }),
    identityProof: params.verifiedPath ? 'launch:path' : null,
    sourceSessionKey: keys.sourceSessionKey,
    streamIdentity: stream,
    sourceKey: keys.sourceKey,
  });
}

function codexRequest(sessionId: string, key = 'one'): TaskRequestV1 {
  return {
    version: 1, namespace: 'runtime', key, sessionId,
    actor: { kind: 'unspecified' }, prompt: 'hello', mode: 'queue',
    skills: [], options: {}, sources: [], sourcePayload: null,
  };
}

function codexContent() {
  const content = {
    version: 2 as const, prompt: 'hello',
    executionContext: { agentPrompt: 'hello' },
    executionOptions: { permissionMode: 'ask' as const },
    contentSources: [],
  };
  return { ...content, digest: hash(content) };
}

function claimTask(h: Harness, sessionId: string, runId: string) {
  h.x.acceptTask({ sessionId, runId }, codexRequest(sessionId), codexContent(), 'back');
  const attempt = h.x.claimNext({ sessionId, runId }).attempt as TaskAttempt;
  return {
    sessionId, runId,
    taskId: attempt.taskId,
    attemptId: attempt.attemptId,
    expectedRevision: attempt.revision,
  };
}

describe('session insight resolver — Claude 真实 fixture 主/子流', () => {
  it('用真实 main/subagent fixture 核验主流、显式父子证明的子流与角色', async () => {
    const h = harness();
    const sessionId = 'ses_claude_real';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'claude-code' });
    createSession(h, sessionId, 'claude-code', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = setupClaudeHome(h.root, {
      [`${CLAUDE_NATIVE_ID}.jsonl`]: CLAUDE_MAIN_FIXTURE,
      'subagent-worker.jsonl': CLAUDE_SUB_FIXTURE,
    });
    const mainPath = join(home, 'projects', CLAUDE_PROJECT_KEY, `${CLAUDE_NATIVE_ID}.jsonl`);
    appendLaunchObserved(h, {
      sessionId, runId, client: 'claude', dataRoot: home,
      nativeSessionId: CLAUDE_NATIVE_ID, verifiedPath: mainPath,
    });

    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'claude', path: home }] });

    const main = result.sources.find(s => s.expectedStream.kind === 'main')!;
    const sub = result.sources.find(s => s.expectedStream.kind === 'subagent')!;
    expect(main.status).toBe('matched');
    expect(main.role).toBe('primary');
    expect(main.proofKind).toBe('launch_observed');
    expect(main.expectedNativeSessionId).toBe(CLAUDE_NATIVE_ID);
    expect(sub.status).toBe('matched');
    expect(sub.role).toBe('subagent');
    expect(sub.expectedStream).toEqual({ kind: 'subagent', nativeAgentId: CLAUDE_SUB_AGENT });
    expect(sub.relationship.kind).toBe('child');
    expect(sub.relationship.parentNativeSessionId).toBe(CLAUDE_NATIVE_ID);
    expect(sub.relationship.evidenceRefs.some(ref => ref.includes('call_739645'))).toBe(true);
    expect(sub.relationship.evidenceRefs.some(ref => ref.includes('L4'))).toBe(true);
    expect(sub.relationship.evidenceRefs.some(ref => ref.includes('L5'))).toBe(true);
    expect(result.primarySourceKey).toBe(main.sourceKey);
    expect(main.sourceKey).not.toBe(sub.sourceKey);
  });

  it('支持 Claude 2.1.288 原生 nested subagents 布局，并能按 parentNativeSessionId 隔离同名 agentId', async () => {
    const h = harness();
    const sessionId = 'ses_claude_nested_real';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'claude-code' });
    createSession(h, sessionId, 'claude-code', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);

    const home = join(h.root, 'claude-nested-home');
    const projectDir = join(home, 'projects', CLAUDE_PROJECT_KEY);
    const subagentsDir = join(projectDir, CLAUDE_NATIVE_ID, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });

    // 主流放在 projects/<key>/<nativeId>.jsonl
    cpSync(CLAUDE_MAIN_FIXTURE, join(projectDir, `${CLAUDE_NATIVE_ID}.jsonl`));
    // 子流放在 projects/<key>/<nativeId>/subagents/agent-<agentId>.jsonl
    cpSync(CLAUDE_SUB_FIXTURE, join(subagentsDir, `agent-${CLAUDE_SUB_AGENT}.jsonl`));

    // 制造另一个会话目录的同名 agentId（不同 parent session）作为干扰项
    const otherParentDir = join(projectDir, '0192e000-7a3b-7000-8000-000000000009', 'subagents');
    mkdirSync(otherParentDir, { recursive: true });
    // 写入一个虽然带有同名 agentId，但内部 sessionId 不同的文件
    const decoyContent = readFileSync(CLAUDE_SUB_FIXTURE, 'utf8')
      .replaceAll(CLAUDE_NATIVE_ID, '0192e000-7a3b-7000-8000-000000000009');
    writeFileSync(join(otherParentDir, `agent-${CLAUDE_SUB_AGENT}.jsonl`), decoyContent);

    appendLaunchObserved(h, {
      sessionId, runId, client: 'claude', dataRoot: home,
      nativeSessionId: CLAUDE_NATIVE_ID,
      verifiedPath: join(projectDir, `${CLAUDE_NATIVE_ID}.jsonl`),
    });

    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'claude', path: home }] });
    const sub = result.sources.find(s => s.expectedStream.kind === 'subagent')!;
    expect(sub).toBeDefined();
    expect(sub.status).toBe('matched');
    expect(sub.role).toBe('subagent');
    expect(sub.verifiedPath).toBe(resolve(join(subagentsDir, `agent-${CLAUDE_SUB_AGENT}.jsonl`)));
    expect(sub.relationship.parentNativeSessionId).toBe(CLAUDE_NATIVE_ID);
    // 确保干扰项没有导致歧义
    expect(result.sources.filter(s => s.expectedStream.kind === 'subagent')).toHaveLength(1);
  });

  it('连续两次解析真实 nested 主子流来源完全稳定：child 始终 matched/subagent，revision 不重复递增', async () => {
    const h = harness();
    const sessionId = 'ses_claude_nested_twice';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'claude-code' });
    createSession(h, sessionId, 'claude-code', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);

    const home = join(h.root, 'claude-twice');
    const projectDir = join(home, 'projects', CLAUDE_PROJECT_KEY);
    const subagentsDir = join(projectDir, CLAUDE_NATIVE_ID, 'subagents');
    mkdirSync(subagentsDir, { recursive: true });
    // 无任何预置 observation：第一次靠首条 prompt marker + main 显式 parent proof 发现，
    // 第二次必须从持久 historical child observation 重新取证且结果完全一致。
    // 真实首次创建的会话其首条 prompt 携带 dutydeck marker（与 root integration probe 同口径）。
    const markerLine = JSON.stringify({
      type: 'user',
      sessionId: CLAUDE_NATIVE_ID,
      cwd: FIXTURE_CWD,
      timestamp: at,
      message: { role: 'user', content: buildSessionMarker(sessionId) },
    });
    writeFileSync(
      join(projectDir, `${CLAUDE_NATIVE_ID}.jsonl`),
      `${markerLine}\n${readFileSync(CLAUDE_MAIN_FIXTURE, 'utf8')}`
    );
    cpSync(CLAUDE_SUB_FIXTURE, join(subagentsDir, `agent-${CLAUDE_SUB_AGENT}.jsonl`));

    const opts = { configuredRoots: [{ client: 'claude' as const, path: home }] };
    const first = await h.resolve(sessionId, opts);
    const firstSub = first.sources.find(s => s.expectedStream.kind === 'subagent')!;
    expect(first.sources.find(s => s.expectedStream.kind === 'main')!.status).toBe('matched');
    expect(firstSub.status).toBe('matched');
    expect(firstSub.role).toBe('subagent');
    const revisionAfterFirst = h.repos.insight.getState(sessionId).bindingRevision;
    expect(revisionAfterFirst).toBeGreaterThan(0);
    const snapshotAfterFirst = JSON.stringify(first.sources.map(s => ({
      stream: s.expectedStream,
      status: s.status,
      role: s.role,
      sourceKey: s.sourceKey,
      verifiedPath: s.verifiedPath,
      relationship: s.relationship,
    })));
    const proofsAfterFirst = h.repos.insight.listSources(sessionId);

    const second = await h.resolve(sessionId, opts);
    const secondSub = second.sources.find(s => s.expectedStream.kind === 'subagent')!;
    expect(secondSub.status).toBe('matched');
    expect(secondSub.role).toBe('subagent');
    expect(second.primarySourceKey).toBe(first.primarySourceKey);
    const snapshotAfterSecond = JSON.stringify(second.sources.map(s => ({
      stream: s.expectedStream,
      status: s.status,
      role: s.role,
      sourceKey: s.sourceKey,
      verifiedPath: s.verifiedPath,
      relationship: s.relationship,
    })));
    expect(snapshotAfterSecond).toBe(snapshotAfterFirst);
    // 第二次不得重复追加 proof 或改变 revision。
    expect(h.repos.insight.getState(sessionId).bindingRevision).toBe(revisionAfterFirst);
    expect(h.repos.insight.listSources(sessionId)).toEqual(proofsAfterFirst);
  });

  it('主流缺 toolUseResult.agentId 时不把子文件判成子流，也不靠文件名猜父子', async () => {
    const h = harness();
    const sessionId = 'ses_no_proof';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'claude-code' });
    createSession(h, sessionId, 'claude-code', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = setupClaudeHome(h.root, { 'subagent-worker.jsonl': CLAUDE_SUB_FIXTURE });
    const projectDir = join(home, 'projects', CLAUDE_PROJECT_KEY);
    const { readFileSync, writeFileSync: writeFile } = await import('node:fs');
    const altered = readFileSync(CLAUDE_MAIN_FIXTURE, 'utf8')
      .split('\n')
      .filter(line => !line.includes('"toolUseResult"') || !line.includes('call_739645'))
      .join('\n');
    writeFile(join(projectDir, `${CLAUDE_NATIVE_ID}.jsonl`), altered);
    appendLaunchObserved(h, {
      sessionId, runId, client: 'claude', dataRoot: home,
      nativeSessionId: CLAUDE_NATIVE_ID,
      verifiedPath: join(projectDir, `${CLAUDE_NATIVE_ID}.jsonl`),
    });

    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'claude', path: home }] });
    expect(result.sources.some(s => s.expectedStream.kind === 'subagent' && s.status === 'matched')).toBe(false);
  });
});

describe('session insight resolver — 历史 HOME 切换 / 内容身份 / 越根', () => {
  it('历史观察指向旧 HOME，当前配置根是新 HOME，仍在旧根内核验成功', async () => {
    const h = harness();
    const sessionId = 'ses_home_switch';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const oldHome = setupCodexHome(h.root, [{
      name: `rollout-2026-10-03T02-45-40-${CODEX_NATIVE_ID}.jsonl`,
      source: CODEX_FIXTURE,
    }]);
    const newHome = join(h.root, '.codex-new');
    mkdirSync(newHome, { recursive: true });
    const rollout = join(oldHome, 'sessions/2026/10/03', `rollout-2026-10-03T02-45-40-${CODEX_NATIVE_ID}.jsonl`);
    const keys = createTranscriptSourceKeys(INSTANCE_ID, 'codex', oldHome, CODEX_NATIVE_ID, MAIN)!;
    h.repos.insight.appendHistoricalProof({
      observationId: 'hist_old_home',
      sessionId, activeRunId: runId, driverInstanceId: 'historical-resolver',
      client: 'codex', launchKind: 'attached', proofKind: 'historical_verified',
      capturedAt: at, dataRoot: oldHome, cwd: FIXTURE_CWD,
      nativeSessionId: CODEX_NATIVE_ID, verifiedPath: rollout,
      identityProof: 'content_native_id', sourceSessionKey: keys.sourceSessionKey,
      streamIdentity: MAIN, sourceKey: keys.sourceKey,
    });

    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'codex', path: newHome }] });
    const main = result.sources.find(s => s.expectedStream.kind === 'main')!;
    expect(main.status).toBe('matched');
    expect(main.approvedRoot).toBe(resolve(oldHome));
    expect(main.verifiedPath).toBe(resolve(rollout));
    expect(result.hostOnlyReason).toBeUndefined();
  });

  it('显式路径内容原生 ID 不匹配时返回 missing + 原因，不按 cwd/文件名认定', async () => {
    const h = harness();
    const sessionId = 'ses_id_mismatch';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = setupCodexHome(h.root, [{
      name: `rollout-x-${CODEX_NATIVE_ID}.jsonl`,
      source: TRAEX_FIXTURE,
    }]);
    const wrong = join(home, 'sessions/2026/10/03', `rollout-x-${CODEX_NATIVE_ID}.jsonl`);
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: home,
      nativeSessionId: CODEX_NATIVE_ID, verifiedPath: wrong,
    });

    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'codex', path: home }] });
    const main = result.sources.find(s => s.expectedStream.kind === 'main')!;
    expect(main.status).toBe('missing');
    expect(main.reason).toContain('content_native_id_mismatch');
    expect(result.sources.every(s => s.status !== 'matched')).toBe(true);
  });

  it('同一文件出现多个冲突互斥的 nativeSessionId 时拒绝认定为有效匹配', async () => {
    const h = harness();
    const sessionId = 'ses_conflict_ids';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'claude-code' });
    createSession(h, sessionId, 'claude-code', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = setupClaudeHome(h.root, {});
    const projectDir = join(home, 'projects', CLAUDE_PROJECT_KEY);
    // 构造一个包含两个不同 sessionId 的坏文件
    const line1 = JSON.stringify({ type: 'user', sessionId: CLAUDE_NATIVE_ID, message: { role: 'user', content: 'test' } });
    const line2 = JSON.stringify({ type: 'user', sessionId: '0192e000-7a3b-7000-8000-000000000002', message: { role: 'user', content: 'test' } });
    const targetFile = join(projectDir, `${CLAUDE_NATIVE_ID}.jsonl`);
    writeFileSync(targetFile, `${line1}\n${line2}\n`);

    appendLaunchObserved(h, {
      sessionId, runId, client: 'claude', dataRoot: home,
      nativeSessionId: CLAUDE_NATIVE_ID, verifiedPath: targetFile,
    });
    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'claude', path: home }] });
    expect(result.sources[0]!.status).toBe('missing');
    expect(result.sources[0]!.reason).toContain('content_session_id_conflict');
  });

  it('symlink 越出核准根拒绝；指向根内普通文件放行；目录拒绝', async () => {
    const h = harness();
    const sessionId = 'ses_symlink';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = setupCodexHome(h.root, [{
      name: `rollout-good-${CODEX_NATIVE_ID}.jsonl`,
      source: CODEX_FIXTURE,
    }]);
    const dayDir = join(home, 'sessions/2026/10/03');
    const outside = join(h.root, 'outside.jsonl');
    cpSync(CODEX_FIXTURE, outside);
    const escapeLink = join(dayDir, 'rollout-escape.jsonl');
    symlinkSync(outside, escapeLink);
    const insideLink = join(dayDir, 'rollout-inside-link.jsonl');
    symlinkSync(join(dayDir, `rollout-good-${CODEX_NATIVE_ID}.jsonl`), insideLink);
    mkdirSync(join(dayDir, 'rollout-dir.jsonl'));

    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: home,
      nativeSessionId: CODEX_NATIVE_ID, verifiedPath: escapeLink,
    });
    const rejected = await h.resolve(sessionId, { configuredRoots: [{ client: 'codex', path: home }] });
    const rejectedMain = rejected.sources.find(s => s.expectedStream.kind === 'main')!;
    expect(rejectedMain.status).toBe('missing');
    expect(rejectedMain.reason).toContain('path_outside_approved_root');

    const h2 = harness();
    const session2 = 'ses_symlink_ok';
    const run2 = `run_${session2}`;
    await saveAgent(h2, { id: 'codex' });
    createSession(h2, session2, 'codex', FIXTURE_CWD, run2);
    lifecycleDriver(h2, session2, run2);
    appendLaunchObserved(h2, {
      sessionId: session2, runId: run2, client: 'codex', dataRoot: home,
      nativeSessionId: CODEX_NATIVE_ID, verifiedPath: insideLink,
    });
    const accepted = await h2.resolve(session2, { configuredRoots: [{ client: 'codex', path: home }] });
    expect(accepted.sources[0]!.status).toBe('matched');

    const h3 = harness();
    const session3 = 'ses_dir';
    const run3 = `run_${session3}`;
    await saveAgent(h3, { id: 'codex' });
    createSession(h3, session3, 'codex', FIXTURE_CWD, run3);
    lifecycleDriver(h3, session3, run3);
    appendLaunchObserved(h3, {
      sessionId: session3, runId: run3, client: 'codex', dataRoot: home,
      nativeSessionId: CODEX_NATIVE_ID,
      verifiedPath: join(dayDir, 'rollout-dir.jsonl'),
    });
    const dirResult = await h3.resolve(session3, { configuredRoots: [{ client: 'codex', path: home }] });
    expect(dirResult.sources[0]!.reason).toContain('not_regular_file');
  });

  it('FIFO 特殊文件不会使身份读取挂起，路径在 lstat 后被替换为 FIFO 也保守拒绝', async () => {
    const h = harness();
    const sessionId = 'ses_fifo';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = setupCodexHome(h.root, []);
    const dayDir = join(home, 'sessions/2026/10/03');
    const fifoPath = join(dayDir, `rollout-fifo-${CODEX_NATIVE_ID}.jsonl`);
    // POSIX mkfifo（无 writer，普通阻塞 open 会永久挂起）。
    execFileSync('mkfifo', [fifoPath]);

    // 直接观察路径指向 FIFO：lstat 判定不是普通文件 → missing，快速返回不挂起。
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: home,
      nativeSessionId: CODEX_NATIVE_ID, verifiedPath: fifoPath,
    });
    const started = Date.now();
    const result = await h.resolve(sessionId, {
      configuredRoots: [{ client: 'codex', path: home }],
      deadline: Date.now() + 3000,
    });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.sources[0]!.status).toBe('missing');
    expect(result.sources[0]!.reason).toContain('not_regular_file');
  });

  it('已核验的普通文件路径被同路径替换/重命名后，dev/ino 核对失败，不错误绑定', async () => {
    const h = harness();
    const sessionId = 'ses_replace';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = setupCodexHome(h.root, [{
      name: `rollout-replace-${CODEX_NATIVE_ID}.jsonl`,
      source: CODEX_FIXTURE,
    }]);
    const dayDir = join(home, 'sessions/2026/10/03');
    const target = join(dayDir, `rollout-replace-${CODEX_NATIVE_ID}.jsonl`);
    const other = join(dayDir, 'rollout-other-native.jsonl');
    writeFileSync(other, JSON.stringify({
      timestamp: at, ordinal: 0, type: 'session_meta',
      payload: { id: '01a0ffa7-9999-72f1-be55-999999999999', session_id: '01a0ffa7-9999-72f1-be55-999999999999', cwd: FIXTURE_CWD },
    }) + '\n');

    // 先放正确文件（观察指向它），随后把另一 inode 重命名到同路径替换。
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: home,
      nativeSessionId: CODEX_NATIVE_ID, verifiedPath: target,
    });
    renameSync(other, target);

    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'codex', path: home }] });
    const main = result.sources.find(s => s.expectedStream.kind === 'main')!;
    // 替换后内容原生 ID 不再匹配预期 → missing，绝不绑定替换后的文件。
    expect(main.status).toBe('missing');
    expect(main.reason).toContain('content_native_id_mismatch');
  });
});

describe('session insight resolver — 歧义、发现限额与预算异常传播', () => {
  it('两个同 cwd、内容同 native ID 的候选返回 ambiguous，不选 mtime 最新', async () => {
    const h = harness();
    const sessionId = 'ses_ambiguous';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'claude' });
    createSession(h, sessionId, 'claude', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = setupClaudeHome(h.root, {
      'older.jsonl': CLAUDE_MAIN_FIXTURE,
      'newer.jsonl': CLAUDE_MAIN_FIXTURE,
    });
    const projectDir = join(home, 'projects', CLAUDE_PROJECT_KEY);
    const old = Date.now() / 1000 - 1000;
    const recent = Date.now() / 1000;
    utimesSync(join(projectDir, 'older.jsonl'), old, old);
    utimesSync(join(projectDir, 'newer.jsonl'), recent, recent);
    appendLaunchObserved(h, {
      sessionId, runId, client: 'claude', dataRoot: home,
      nativeSessionId: CLAUDE_NATIVE_ID,
    });

    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'claude', path: home }] });
    const main = result.sources.find(s => s.expectedStream.kind === 'main')!;
    expect(main.status).toBe('ambiguous');
    expect(main.reason).toBe('ambiguous_candidates');
    expect(result.primarySourceKey).toBeNull();
  });

  it('已有明确 expected native ID 时，即使文本出现 marker 也绝不能覆盖内容原生 ID 不匹配', async () => {
    const h = harness();
    const sessionId = 'ses_marker_cannot_override_id';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = join(h.root, '.codex');
    const dayDir = join(home, 'sessions/2026/10/03');
    mkdirSync(dayDir, { recursive: true });
    // 写入一个虽然包含 marker 文本但内部 session ID 不相符的文件
    const differentId = '01a0ffa7-0000-72f1-be55-000000000000';
    const marker = `<dutydeck_session_id>${sessionId}</dutydeck_session_id>`;
    writeFileSync(
      join(dayDir, 'rollout-marker-trap.jsonl'),
      JSON.stringify({
        timestamp: at, ordinal: 0, type: 'session_meta',
        payload: { id: differentId, session_id: differentId, cwd: FIXTURE_CWD },
      }) + '\n' +
      JSON.stringify({
        timestamp: at, ordinal: 1, type: 'event_msg',
        payload: { type: 'user_message', message: `Prompt carrying ${marker}` },
      }) + '\n'
    );
    // 观察期望的 ID 是 CODEX_NATIVE_ID
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: home,
      nativeSessionId: CODEX_NATIVE_ID,
    });

    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'codex', path: home }] });
    const main = result.sources.find(s => s.expectedStream.kind === 'main')!;
    expect(main.status).toBe('missing');
    expect(main.reason).toBe('no_matching_candidate');
  });

  it('仅有 marker 命中但文件内容缺失 session_meta 原生 ID 时不能认领，也不发明 ID', async () => {
    const h = harness();
    const sessionId = 'ses_marker_no_id';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = join(h.root, '.codex');
    const dayDir = join(home, 'sessions/2026/10/03');
    mkdirSync(dayDir, { recursive: true });
    // 只有用户 prompt 包含了 marker，但没有任何 session_meta 行
    const marker = `<dutydeck_session_id>${sessionId}</dutydeck_session_id>`;
    writeFileSync(
      join(dayDir, 'rollout-no-meta.jsonl'),
      JSON.stringify({
        timestamp: at, ordinal: 0, type: 'event_msg',
        payload: { type: 'user_message', message: `Prompt with ${marker}` },
      }) + '\n'
    );

    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'codex', path: home }] });
    // 无账本 ID 且文件内无原生 ID：不得发明 ID，必须返回 missing / unsupported
    expect(result.sources.every(s => s.status !== 'matched')).toBe(true);
  });

  it('无 native ID 依赖 marker 历史发现时，若扫描被截断（limited），不假定唯一，保持未匹配且不认领 primary', async () => {
    const h = harness();
    const sessionId = 'ses_truncated_marker';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = join(h.root, 'codex-truncated');
    const dayDir = join(home, 'sessions/2026/10/03');
    mkdirSync(dayDir, { recursive: true });

    // 写入 2 个同 Dutydeck marker 但 native ID 不同的 rollout
    for (let i = 0; i < 2; i++) {
      const p = join(dayDir, `rollout-${i}.jsonl`);
      writeFileSync(
        p,
        [
          { type: 'session_meta', timestamp: at, payload: { id: `native-${i}`, cwd: FIXTURE_CWD } },
          { type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: `<dutydeck_session_id>${sessionId}</dutydeck_session_id>` } },
        ].map(r => JSON.stringify(r)).join('\n') + '\n'
      );
      utimesSync(p, new Date(1000000 + i * 1000), new Date(1000000 + i * 1000));
    }

    // 限制单组只扫描 1 个文件，必然触发 limited 截断
    const result = await h.resolve(sessionId, {
      configuredRoots: [{ client: 'codex', path: home }],
      limits: { maxContentScansPerGroup: 1 },
    });

    expect(result.discoveryLimited).toBe(true);
    // 不能把截断扫到的唯一文件误认领为 primary！
    expect(result.primarySourceKey).toBeNull();
    expect(result.sources.every(s => s.status !== 'matched')).toBe(true);
  });

  it('明确 native ID 时内容扫描被截断且扫到 1 个匹配文件，也必须保守为 ambiguous，绝不选 latest 强绑', async () => {
    const h = harness();
    const sessionId = 'ses_truncated_explicit_id';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = join(h.root, 'codex-truncated-id');
    const dayDir = join(home, 'sessions/2026/10/03');
    mkdirSync(dayDir, { recursive: true });

    // 2 个相同目标 native ID 文件（潜在歧义），另加 1 个诱饵文件使扫描被截断在最新一个
    const meta = (id: string) => JSON.stringify({
      timestamp: at, ordinal: 0, type: 'session_meta',
      payload: { id, session_id: id, cwd: FIXTURE_CWD },
    }) + '\n';
    const decoy = join(dayDir, 'rollout-decoy.jsonl');
    writeFileSync(decoy, meta('decoy-native-id'));
    const a = join(dayDir, 'rollout-a.jsonl');
    writeFileSync(a, meta(CODEX_NATIVE_ID));
    const b = join(dayDir, 'rollout-b.jsonl');
    writeFileSync(b, meta(CODEX_NATIVE_ID));
    utimesSync(decoy, new Date(3_000_000), new Date(3_000_000));
    utimesSync(a, new Date(2_000_000), new Date(2_000_000));
    utimesSync(b, new Date(1_000_000), new Date(1_000_000));

    // 观察只给明确 native ID，不给路径；只允许扫描 2 个内容文件。
    // newest-first 顺序为 decoy(不匹配) → a(匹配)，扫描预算在看到 a 后耗尽，
    // b 未被检查，同 ID 唯一性从未被证实，必须保守 ambiguous。
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: home,
      nativeSessionId: CODEX_NATIVE_ID,
    });

    const result = await h.resolve(sessionId, {
      configuredRoots: [{ client: 'codex', path: home }],
      limits: { maxContentScansPerGroup: 2 },
    });
    expect(result.discoveryLimited).toBe(true);
    expect(result.primarySourceKey).toBeNull();
    const main = result.sources.find(s => s.expectedStream.kind === 'main')!;
    expect(main.status).toBe('ambiguous');
    expect(main.reason).toBe('truncated_discovery_unverified_uniqueness');
  });

  it('发现命中全 job 共享 metadata 上限时标 discoveryLimited 且传播', async () => {
    const h = harness();
    const sessionId = 'ses_limited_shared';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = setupCodexHome(h.root, []);
    const dayDir = join(home, 'sessions/2026/10/03');
    // 创建 5 个文件
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(dayDir, `rollout-decoy-${i}.jsonl`), JSON.stringify({
        timestamp: at, ordinal: 0, type: 'session_meta',
        payload: { id: `id-${i}`, session_id: `id-${i}`, cwd: FIXTURE_CWD },
      }) + '\n');
    }
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: home,
      nativeSessionId: CODEX_NATIVE_ID,
    });

    const result = await h.resolve(sessionId, {
      configuredRoots: [{ client: 'codex', path: home }],
      limits: { maxCandidateMetas: 2, maxContentScansPerGroup: 2 },
    });
    expect(result.discoveryLimited).toBe(true);
  });

  it('identityHeadBytes 读取时超出总预算立即向外传播 INSIGHT_INPUT_LIMIT，绝不吞没异常', async () => {
    const h = harness();
    const sessionId = 'ses_budget_exceeded';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = setupCodexHome(h.root, [{
      name: `rollout-budget-${CODEX_NATIVE_ID}.jsonl`,
      source: CODEX_FIXTURE,
    }]);
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: home,
      nativeSessionId: CODEX_NATIVE_ID,
      verifiedPath: join(home, 'sessions/2026/10/03', `rollout-budget-${CODEX_NATIVE_ID}.jsonl`),
    });

    // 将 maxIdentityReadBytes 设为极小的 10 字节，读取 fixture 时必然超限
    await expect(h.resolve(sessionId, {
      configuredRoots: [{ client: 'codex', path: home }],
      limits: { maxIdentityReadBytes: 10 },
    })).rejects.toMatchObject({ code: 'INSIGHT_INPUT_LIMIT' });
  });

  it('明确来源超过 32 个文件时 inputLimit=true，而不是截最近文件', async () => {
    const h = harness();
    const sessionId = 'ses_input_limit';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = join(h.root, '.codex-many');
    const dayDir = join(home, 'sessions/2026/10/03');
    mkdirSync(dayDir, { recursive: true });
    const count = 33;
    for (let i = 0; i < count; i += 1) {
      const id = `01a0ffa8-${String(i).padStart(4, '0')}-79b3-9a87-${String(i).padStart(12, 'a')}`;
      writeFileSync(join(dayDir, `rollout-${i}-${id}.jsonl`), JSON.stringify({
        timestamp: at, ordinal: 0, type: 'session_meta',
        payload: { id, session_id: id, cwd: FIXTURE_CWD },
      }) + '\n');
      const keys = createTranscriptSourceKeys(INSTANCE_ID, 'codex', home, id, MAIN)!;
      h.repos.insight.appendHistoricalProof({
        observationId: `hist_many_${i}`,
        sessionId, activeRunId: runId, driverInstanceId: 'historical-resolver',
        client: 'codex', launchKind: 'attached', proofKind: 'historical_verified',
        capturedAt: at, dataRoot: home, cwd: FIXTURE_CWD,
        nativeSessionId: id, verifiedPath: null, identityProof: null,
        sourceSessionKey: keys.sourceSessionKey, streamIdentity: MAIN, sourceKey: null,
      });
    }

    const result = await h.resolve(sessionId, {
      configuredRoots: [{ client: 'codex', path: home }],
      limits: { maxContentScansPerGroup: 200 },
    });
    expect(result.sources.filter(s => s.status === 'matched')).toHaveLength(33);
    expect(result.inputLimit).toBe(true);
  }, 30_000);
});

describe('session insight resolver — ACP / PTY checkpoint / 不支持驱动', () => {
  const nativeExpected = {
    nativeCreationId: 'native-create', sessionKey: 'key', agent: 'codex',
    command: ['codex'], cwd: FIXTURE_CWD, executionDomain: 'local',
  };
  const nativeIdentity: NativeContextIdentity = {
    ...nativeExpected,
    acpxRecordId: 'record-1',
    backendSessionId: 'backend-session-x',
    agentSessionId: CODEX_NATIVE_ID,
    defaults: { model: 'gpt-6-astra' },
  };

  it('ACP native 资源经真实 ledger 核验：agentSessionId 是日志身份，匹配当前 selection 成 primary', async () => {
    const h = harness();
    const sessionId = 'ses_acp';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex', protocol: 'acp' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    const root = h.x.beforeControlledOperation({ sessionId, runId }, { resourceId: 'factory', driverInstanceId: 'driver-1' });
    const reserved = h.x.reserveNativeContext({ sessionId, runId }, {
      resourceId: 'native', parentResourceId: root.resourceId, expected: nativeExpected,
    });
    const selected = h.x.confirmNativeContext(
      { sessionId, runId }, reserved.resourceId, reserved.revision, nativeIdentity
    );
    h.x.creationFinished({ sessionId, runId }, root.resourceId, root.revision, 'created');
    const f = claimTask(h, sessionId, runId);
    h.x.markSubmissionPending(f, {
      submissionId: 'sub-1', inputDigest: hash('hello'), resourceRefs: [], authorizationRefs: [],
      nativeContextRef: selected.context, contextProofId: 'native_creation:native', driverInstanceId: 'driver-1',
    });
    const home = setupCodexHome(h.root, [{
      name: `rollout-acp-${CODEX_NATIVE_ID}.jsonl`,
      source: CODEX_FIXTURE,
    }]);

    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'codex', path: home }] });
    const main = result.sources.find(s => s.expectedStream.kind === 'main')!;
    expect(main.status).toBe('matched');
    expect(main.role).toBe('primary');
    expect(main.expectedNativeSessionId).toBe(CODEX_NATIVE_ID);
    expect(main.nativeContextRef).toEqual(selected.context);
    expect(result.primarySourceKey).toBe(main.sourceKey);
  });

  it('ACP 只有 backendSessionId、无 agentSessionId 时不发明日志身份（无文件则 missing 类弱状态）', async () => {
    const h = harness();
    const sessionId = 'ses_acp_weak';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex', protocol: 'acp' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    const root = h.x.beforeControlledOperation({ sessionId, runId }, { resourceId: 'factory', driverInstanceId: 'driver-1' });
    const reserved = h.x.reserveNativeContext({ sessionId, runId }, {
      resourceId: 'native', parentResourceId: root.resourceId, expected: nativeExpected,
    });
    // strict schema 下，无 agentSessionId 时对象不能带 agentSessionId: undefined
    const { agentSessionId: _omitted, ...rest } = nativeIdentity;
    const weakIdentity: NativeContextIdentity = { ...rest, defaults: {} };
    const selected = h.x.confirmNativeContext(
      { sessionId, runId }, reserved.resourceId, reserved.revision, weakIdentity
    );
    h.x.creationFinished({ sessionId, runId }, root.resourceId, root.revision, 'created');
    const f = claimTask(h, sessionId, runId);
    h.x.markSubmissionPending(f, {
      submissionId: 'sub-1', inputDigest: hash('hello'), resourceRefs: [], authorizationRefs: [],
      nativeContextRef: selected.context, contextProofId: 'native_creation:native', driverInstanceId: 'driver-1',
    });
    const home = join(h.root, '.codex-empty');
    mkdirSync(home, { recursive: true });

    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'codex', path: home }] });
    const main = result.sources.find(s => s.expectedStream.kind === 'main')!;
    expect(main.status).toBe('missing');
    expect(main.reason).toBe('native_session_id_unverified');
    expect(main.expectedNativeSessionId).toBe('');
  });

  it('PTY checkpoint 经真实 recoverAttempt(original_turn) 进账本，按路径内容核验为历史来源', async () => {
    const h = harness();
    const sessionId = 'ses_checkpoint';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    h.x.acceptTask({ sessionId, runId }, codexRequest(sessionId), codexContent(), 'back');
    const attempt = h.x.claimNext({ sessionId, runId }).attempt as TaskAttempt;
    const fence = { sessionId, runId, taskId: attempt.taskId, attemptId: attempt.attemptId, expectedRevision: attempt.revision };
    const pending = h.x.beforeCreate({ sessionId, runId }, { resourceId: 'original', kind: 'tmux' });
    const bound = h.x.spawned({ sessionId, runId }, pending.resourceId, pending.revision, {
      identityId: 'tmux-original', kind: 'tmux', locator: { session: 'test' },
    });
    const created = h.x.creationFinished({ sessionId, runId }, bound.resourceId, bound.revision, 'created');
    const resource = h.x.observed({ sessionId, runId }, created.resourceId, created.revision, {
      observationId: 'live', state: 'live', identityId: 'tmux-original',
      evidenceRef: 'verified-original', observedAt: at,
    });
    const home = setupCodexHome(h.root, [{
      name: `rollout-ckpt-${CODEX_NATIVE_ID}.jsonl`,
      source: CODEX_FIXTURE,
    }]);
    const checkpointPath = join(home, 'sessions/2026/10/03', `rollout-ckpt-${CODEX_NATIVE_ID}.jsonl`);
    const recovery = { kind: 'pty-jsonl-v1' as const, turnId: 'original-turn', transcript: { offset: 0, path: checkpointPath } };
    const submitted = h.x.markSubmissionPending(fence, {
      submissionId: 'original-submit', inputDigest: hash('final'),
      resourceRefs: [{ resourceId: resource.resourceId, identityId: 'tmux-original' }],
      authorizationRefs: [], recovery,
    });
    h.claim.release();
    const claim2 = h.repos.control.attachRuntime('recovery-controller');
    const handle = handles.find(entry => entry.claim === h.claim);
    if (handle) handle.claim = claim2;
    const next = h.repos.execution.bind(claim2);
    next.recoverAttempt(
      { ...fence, expectedRevision: submitted.attempt!.revision },
      {
        kind: 'original_turn', decisionId: 'attach', submissionId: 'original-submit',
        recovery: recovery as never,
        resources: [{ resourceId: resource.resourceId, expectedRevision: resource.revision, observationId: 'live' }],
        attached: true,
      }
    );

    const result = await new SessionInsightResolver({
      repositories: {
        insight: h.repos.insight, sessions: h.repos.sessions, execution: h.repos.execution,
        config: h.repos.config, agents: h.repos.agents,
      },
      configuredRoots: [{ client: 'codex', path: home }],
      createTranscriptSourceKeys,
      instanceId: INSTANCE_ID,
    }).resolveSessionInsightSources(sessionId);
    const main = result.sources.find(s => s.expectedStream.kind === 'main')!;
    expect(main.status).toBe('matched');
    expect(main.proofKind).toBe('historical_verified');
    expect(main.expectedNativeSessionId).toBe(CODEX_NATIVE_ID);
    expect(main.evidenceRefs.some(ref => ref.includes('checkpoint'))).toBe(true);
  });

  it('不支持的驱动（jsonl/pipe/未知 adapter）返回 host-only unsupported_driver', async () => {
    const h = harness();
    const sessionId = 'ses_unsupported';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'gemini' });
    createSession(h, sessionId, 'gemini', FIXTURE_CWD, runId);

    const result = await h.resolve(sessionId);
    expect(result.sources).toEqual([]);
    expect(result.primarySourceKey).toBeNull();
    expect(result.hostOnlyReason).toBe('unsupported_driver');
  });
});

describe('session insight resolver — Codex/TraeX 父子/fork 关系', () => {
  function writeRelatedTraex(params: {
    dir: string;
    name: string;
    nativeId: string;
    parentId: string;
    mode: 'spawn' | 'fork';
  }): void {
    const sourceField = params.mode === 'fork'
      ? { subagent: { thread_fork: { parent_thread_id: params.parentId } } }
      : { subagent: { thread_spawn: { parent_thread_id: params.parentId } } };
    writeFileSync(join(params.dir, params.name), JSON.stringify({
      timestamp: at, ordinal: 0, type: 'session_meta',
      payload: {
        id: params.nativeId, session_id: params.nativeId, cwd: FIXTURE_CWD,
        model_provider: 'trae', source: sourceField,
      },
    }) + '\n');
  }

  it('parent_thread_id 只证明有父线程 → unknown；明确 fork 结构 → fork；都不靠时间补树', async () => {
    const h = harness();
    const sessionId = 'ses_traex_related';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'traex' });
    createSession(h, sessionId, 'traex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = join(h.root, '.trae');
    const dayDir = join(home, 'cli/sessions/2026/10/03');
    mkdirSync(dayDir, { recursive: true });
    cpSync(TRAEX_FIXTURE, join(dayDir, `rollout-main-${TRAEX_NATIVE_ID}.jsonl`));
    writeRelatedTraex({
      dir: dayDir, name: 'rollout-child-unknown.jsonl',
      nativeId: '01a0ffaa-0001-79b3-9a87-aaaaaaaaaaaa',
      parentId: TRAEX_NATIVE_ID, mode: 'spawn',
    });
    writeRelatedTraex({
      dir: dayDir, name: 'rollout-child-fork.jsonl',
      nativeId: '01a0ffaa-0002-79b3-9a87-bbbbbbbbbbbb',
      parentId: TRAEX_NATIVE_ID, mode: 'fork',
    });
    appendLaunchObserved(h, {
      sessionId, runId, client: 'traex', dataRoot: home,
      nativeSessionId: TRAEX_NATIVE_ID,
      verifiedPath: join(dayDir, `rollout-main-${TRAEX_NATIVE_ID}.jsonl`),
    });

    const result = await h.resolve(sessionId, {
      configuredRoots: [{ client: 'traex', path: home }],
      limits: { maxContentScansPerGroup: 50 },
    });
    const unknown = result.sources.find(s => s.expectedNativeSessionId === '01a0ffaa-0001-79b3-9a87-aaaaaaaaaaaa')!;
    const fork = result.sources.find(s => s.expectedNativeSessionId === '01a0ffaa-0002-79b3-9a87-bbbbbbbbbbbb')!;
    expect(unknown.status).toBe('matched');
    expect(unknown.relationship.kind).toBe('unknown');
    expect(fork.status).toBe('matched');
    expect(fork.relationship.kind).toBe('fork');
    expect(result.sources.filter(s => s.relationship.kind === 'child')).toHaveLength(0);
  });
});

describe('session insight resolver — 幂等、安全投影、取消、稳定 instance、角色权威', () => {
  it('初次写入使用真实当前时间，重复解析追加相同 historical proof 不递增 bindingRevision', async () => {
    const h = harness();
    const sessionId = 'ses_idempotent';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = setupCodexHome(h.root, [{
      name: `rollout-idem-${CODEX_NATIVE_ID}.jsonl`,
      source: CODEX_FIXTURE,
    }]);
    h.repos.insight.appendHistoricalProof({
      observationId: 'hist_identity_only',
      sessionId, activeRunId: runId, driverInstanceId: 'historical-resolver',
      client: 'codex', launchKind: 'attached', proofKind: 'historical_verified',
      capturedAt: at, dataRoot: home, cwd: FIXTURE_CWD,
      nativeSessionId: CODEX_NATIVE_ID, verifiedPath: null, identityProof: 'ledger_identity',
      sourceSessionKey: null, streamIdentity: MAIN, sourceKey: null,
    });
    const opts = { configuredRoots: [{ client: 'codex' as const, path: home }] };

    const startTime = Date.now();
    const first = await h.resolve(sessionId, opts);
    expect(first.sources[0]!.status).toBe('matched');
    const revisionAfterFirst = h.repos.insight.getState(sessionId).bindingRevision;
    expect(revisionAfterFirst).toBeGreaterThan(0);
    const proofsAfterFirst = h.repos.insight.listSources(sessionId);
    const newlyAppended = proofsAfterFirst.find(p => p.observationId !== 'hist_identity_only')!;
    expect(newlyAppended).toBeDefined();
    // 真实初次时间：必须是当前真实时间戳，绝不能是 1970 伪造时间
    const capturedMs = new Date(newlyAppended.capturedAt).getTime();
    expect(capturedMs).toBeGreaterThanOrEqual(startTime - 2000);

    const second = await h.resolve(sessionId, opts);
    const revisionAfterSecond = h.repos.insight.getState(sessionId).bindingRevision;
    expect(revisionAfterSecond).toBe(revisionAfterFirst);
    expect(h.repos.insight.listSources(sessionId)).toEqual(proofsAfterFirst);
    expect(second.sources.map(s => s.sourceKey)).toEqual(first.sources.map(s => s.sourceKey));
  });

  it('当前 run 的 launch_observed 权威胜过历史 run 的 launch_observed，历史来源保持 additional', async () => {
    const h = harness();
    const sessionId = 'ses_current_vs_old_run';
    const oldRunId = 'run_old';
    const currentRunId = 'run_current';
    await saveAgent(h, { id: 'codex' });
    // 先在旧 run 下创建 session 并产生旧 run 的 live 观察
    createSession(h, sessionId, 'codex', FIXTURE_CWD, oldRunId);
    lifecycleDriver(h, sessionId, oldRunId, 'driver-old');

    const homeOld = join(h.root, 'home-old');
    const homeCurrent = join(h.root, 'home-current');
    const dirOld = join(homeOld, 'sessions/2026/10/03');
    const dirCurrent = join(homeCurrent, 'sessions/2026/10/03');
    mkdirSync(dirOld, { recursive: true });
    mkdirSync(dirCurrent, { recursive: true });
    const idOld = '01a0ffa7-1111-72f1-be55-111111111111';
    const idCurrent = '01a0ffa7-2222-72f1-be55-222222222222';
    writeFileSync(join(dirOld, `rollout-${idOld}.jsonl`), JSON.stringify({
      timestamp: at, ordinal: 0, type: 'session_meta',
      payload: { id: idOld, session_id: idOld, cwd: FIXTURE_CWD },
    }) + '\n');
    writeFileSync(join(dirCurrent, `rollout-${idCurrent}.jsonl`), JSON.stringify({
      timestamp: at, ordinal: 0, type: 'session_meta',
      payload: { id: idCurrent, session_id: idCurrent, cwd: FIXTURE_CWD },
    }) + '\n');

    // 旧 run 时的合法 live 观察
    appendLaunchObserved(h, {
      sessionId, runId: oldRunId, client: 'codex', dataRoot: homeOld,
      nativeSessionId: idOld, verifiedPath: join(dirOld, `rollout-${idOld}.jsonl`),
      driverInstanceId: 'driver-old',
    });

    // 运行时代际更迭：切换到新 run
    h.x.replaceSessionRun({ sessionId, runId: oldRunId }, currentRunId, []);
    lifecycleDriver(h, sessionId, currentRunId, 'driver-current');

    // 当前 run 的 live 观察
    appendLaunchObserved(h, {
      sessionId, runId: currentRunId, client: 'codex', dataRoot: homeCurrent,
      nativeSessionId: idCurrent, verifiedPath: join(dirCurrent, `rollout-${idCurrent}.jsonl`),
      driverInstanceId: 'driver-current',
    });

    const result = await h.resolve(sessionId, {
      configuredRoots: [
        { client: 'codex', path: homeOld },
        { client: 'codex', path: homeCurrent },
      ],
    });
    const currentSource = result.sources.find(s => s.expectedNativeSessionId === idCurrent)!;
    const oldSource = result.sources.find(s => s.expectedNativeSessionId === idOld)!;
    expect(currentSource.status).toBe('matched');
    expect(currentSource.role).toBe('primary');
    expect(oldSource.status).toBe('matched');
    expect(oldSource.role).toBe('additional');
    expect(result.primarySourceKey).toBe(currentSource.sourceKey);
  });

  it('真实 PTY local_only (无 operationScope，driverInstanceId=resourceId) 同 run 替换 driver 时，当前权威 resource 成为 primary，旧 driver 观察为 additional', async () => {
    const h = harness();
    const sessionId = 'ses_pty_local_only_swap';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);

    // 模拟第一个 local-only PTY driver（创建父 operation + local_only 子资源，driverInstanceId 对应子资源 id 'pty_local_1'）
    localOnlyDriver(h, sessionId, runId, 'pty_local_1');

    const homeOld = join(h.root, 'pty-home-1');
    const homeCurrent = join(h.root, 'pty-home-2');
    const dirOld = join(homeOld, 'sessions/2026/10/03');
    const dirCurrent = join(homeCurrent, 'sessions/2026/10/03');
    mkdirSync(dirOld, { recursive: true });
    mkdirSync(dirCurrent, { recursive: true });
    const id1 = '01a0ffa7-3333-72f1-be55-333333333333';
    const id2 = '01a0ffa7-4444-72f1-be55-444444444444';
    writeFileSync(join(dirOld, `rollout-${id1}.jsonl`), JSON.stringify({
      timestamp: at, ordinal: 0, type: 'session_meta', payload: { id: id1, session_id: id1, cwd: FIXTURE_CWD },
    }) + '\n');
    writeFileSync(join(dirCurrent, `rollout-${id2}.jsonl`), JSON.stringify({
      timestamp: at, ordinal: 0, type: 'session_meta', payload: { id: id2, session_id: id2, cwd: FIXTURE_CWD },
    }) + '\n');

    // 第一个 driver 产生 live 观察
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: homeOld,
      nativeSessionId: id1, verifiedPath: join(dirOld, `rollout-${id1}.jsonl`),
      driverInstanceId: 'pty_local_1',
    });

    // 同 run 更换了第二个 local-only PTY driver（创建新的父 operation + local_only 子资源 'pty_local_2'）
    localOnlyDriver(h, sessionId, runId, 'pty_local_2');

    // 第二个 driver 产生 live 观察
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: homeCurrent,
      nativeSessionId: id2, verifiedPath: join(dirCurrent, `rollout-${id2}.jsonl`),
      driverInstanceId: 'pty_local_2',
    });

    const result = await h.resolve(sessionId, {
      configuredRoots: [
        { client: 'codex', path: homeOld },
        { client: 'codex', path: homeCurrent },
      ],
    });

    const currentSource = result.sources.find(s => s.expectedNativeSessionId === id2)!;
    const oldSource = result.sources.find(s => s.expectedNativeSessionId === id1)!;
    expect(currentSource.status).toBe('matched');
    expect(currentSource.role).toBe('primary');
    expect(oldSource.status).toBe('matched');
    expect(oldSource.role).toBe('additional');
    expect(result.primarySourceKey).toBe(currentSource.sourceKey);
  });

  it('相同 nativeSessionId 但属于不同 canonicalRoot 的观察分别保留独立来源，不被合并，不判歧义', async () => {
    const h = harness();
    const sessionId = 'ses_diff_roots_same_id';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId, 'driver-multi-root');

    const homeA = join(h.root, 'codex-root-a');
    const homeB = join(h.root, 'codex-root-b');
    const dirA = join(homeA, 'sessions/2026/10/03');
    const dirB = join(homeB, 'sessions/2026/10/03');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const sharedNativeId = '01a0ffa7-5555-72f1-be55-555555555555';
    writeFileSync(join(dirA, `rollout-${sharedNativeId}.jsonl`), JSON.stringify({
      timestamp: at, ordinal: 0, type: 'session_meta', payload: { id: sharedNativeId, session_id: sharedNativeId, cwd: FIXTURE_CWD },
    }) + '\n');
    writeFileSync(join(dirB, `rollout-${sharedNativeId}.jsonl`), JSON.stringify({
      timestamp: at, ordinal: 0, type: 'session_meta', payload: { id: sharedNativeId, session_id: sharedNativeId, cwd: FIXTURE_CWD },
    }) + '\n');

    // 观察明确分别来自 homeA 和 homeB
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: homeA,
      nativeSessionId: sharedNativeId, verifiedPath: join(dirA, `rollout-${sharedNativeId}.jsonl`),
      driverInstanceId: 'driver-multi-root',
    });
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: homeB,
      nativeSessionId: sharedNativeId, verifiedPath: join(dirB, `rollout-${sharedNativeId}.jsonl`),
      driverInstanceId: 'driver-multi-root',
    });

    const result = await h.resolve(sessionId, {
      configuredRoots: [
        { client: 'codex', path: homeA },
        { client: 'codex', path: homeB },
      ],
    });

    // 必须保留两个独立的 matched sources，各自的 sourceKey 和 sourceSessionKey 基于各自 root 区分
    const matched = result.sources.filter(s => s.status === 'matched');
    expect(matched).toHaveLength(2);
    expect(matched[0]!.sourceKey).not.toBe(matched[1]!.sourceKey);
    expect(matched[0]!.sourceSessionKey).not.toBe(matched[1]!.sourceSessionKey);
    expect(matched[0]!.approvedRoot).not.toBe(matched[1]!.approvedRoot);
    // 且都不被判为 ambiguous
    expect(result.sources.some(s => s.status === 'ambiguous')).toBe(false);
  });

  it('两个独立 Dutydeck session 共享同一份真实 Codex native 日志：两者均 matched、sourceKey 相同、observationId 隔离不冲突、重复解析 revision 不变', async () => {
    const h = harness();
    const s1 = 'ses_shared_one';
    const s2 = 'ses_shared_two';
    await saveAgent(h, { id: 'codex' });
    createSession(h, s1, 'codex', FIXTURE_CWD, `run_${s1}`);
    createSession(h, s2, 'codex', FIXTURE_CWD, `run_${s2}`);
    lifecycleDriver(h, s1, `run_${s1}`, 'driver-s1');
    lifecycleDriver(h, s2, `run_${s2}`, 'driver-s2');

    const home = join(h.root, 'codex-shared-fixture');
    const dayDir = join(home, 'sessions/2026/10/03');
    mkdirSync(dayDir, { recursive: true });

    // 同一份真实 Codex fixture，追加两个会话各自的 prompt marker
    const rawLines = readFileSync(CODEX_FIXTURE, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l));
    const nativeId = rawLines[0].payload.id;
    for (const sid of [s1, s2]) {
      rawLines.splice(1, 0, {
        type: 'event_msg',
        timestamp: at,
        payload: { type: 'user_message', message: buildSessionMarker(sid) },
      });
    }
    const rolloutPath = join(dayDir, `rollout-${nativeId}.jsonl`);
    writeFileSync(rolloutPath, rawLines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const opts = { configuredRoots: [{ client: 'codex' as const, path: home }] };

    // 第一次解析：s1 匹配并追加 historical proof
    const res1 = await h.resolve(s1, opts);
    expect(res1.sources).toHaveLength(1);
    expect(res1.sources[0]!.status).toBe('matched');
    expect(res1.sources[0]!.expectedNativeSessionId).toBe(nativeId);
    const rev1 = h.repos.insight.getState(s1).bindingRevision;
    expect(rev1).toBeGreaterThan(0);
    const obs1 = h.repos.insight.listSources(s1);
    expect(obs1).toHaveLength(1);

    // 第一次解析：s2 匹配同一份日志，绝不抛 INSIGHT_OBSERVATION_CONFLICT
    const res2 = await h.resolve(s2, opts);
    expect(res2.sources).toHaveLength(1);
    expect(res2.sources[0]!.status).toBe('matched');
    expect(res2.sources[0]!.expectedNativeSessionId).toBe(nativeId);
    const rev2 = h.repos.insight.getState(s2).bindingRevision;
    expect(rev2).toBeGreaterThan(0);
    const obs2 = h.repos.insight.listSources(s2);
    expect(obs2).toHaveLength(1);

    // 核心断言：
    // 1. 同一实例同 native 日志，两者 sourceKey / sourceSessionKey 必须完全相同（共享来源 sharedSource）
    expect(res1.sources[0]!.sourceKey).toBe(res2.sources[0]!.sourceKey);
    expect(res1.sources[0]!.sourceSessionKey).toBe(res2.sources[0]!.sourceSessionKey);
    // 2. 两个 session 在 insight_sources 表中的 observationId 必须不同（由 sessionId 隔离防全局主键冲突）
    expect(obs1[0]!.observationId).not.toBe(obs2[0]!.observationId);
    expect(obs1[0]!.sessionId).toBe(s1);
    expect(obs2[0]!.sessionId).toBe(s2);

    // 3. 两个 session 重复解析：revision 不变，不重复写 proof
    const res1Again = await h.resolve(s1, opts);
    expect(res1Again.sources[0]!.sourceKey).toBe(res1.sources[0]!.sourceKey);
    expect(h.repos.insight.getState(s1).bindingRevision).toBe(rev1);
    expect(h.repos.insight.listSources(s1)).toEqual(obs1);

    const res2Again = await h.resolve(s2, opts);
    expect(res2Again.sources[0]!.sourceKey).toBe(res2.sources[0]!.sourceKey);
    expect(h.repos.insight.getState(s2).bindingRevision).toBe(rev2);
    expect(h.repos.insight.listSources(s2)).toEqual(obs2);
  });

  it('safe manifest 投影不含任何 approvedRoot / verifiedPath / dataRoot', async () => {
    const h = harness();
    const sessionId = 'ses_safe';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const home = setupCodexHome(h.root, [{
      name: `rollout-safe-${CODEX_NATIVE_ID}.jsonl`,
      source: CODEX_FIXTURE,
    }]);
    const result = await h.resolve(sessionId, { configuredRoots: [{ client: 'codex', path: home }] });
    const safeJson = JSON.stringify(result.toSafeManifestEntries());
    expect(safeJson).not.toContain(home);
    expect(safeJson).not.toContain('verifiedPath');
    expect(safeJson).not.toContain('approvedRoot');
    expect(safeJson).not.toContain(h.root);
    for (const entry of result.toSafeManifestEntries()) {
      expect(Object.keys(entry).sort()).toEqual(['client', 'expectedStream', 'matchStatus', 'relationship', 'sourceKey', 'status']);
    }
  });

  it('signal 已中止 / deadline 已过时拒绝继续发现', async () => {
    const h = harness();
    const sessionId = 'ses_abort';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: h.root,
      nativeSessionId: CODEX_NATIVE_ID,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(h.resolve(sessionId, { signal: controller.signal })).rejects.toMatchObject({ code: 'INSIGHT_ABORTED' });
    await expect(h.resolve(sessionId, { deadline: Date.now() - 1 })).rejects.toMatchObject({ code: 'INSIGHT_ABORTED' });
  });

  it('生产默认路径从 config insight.instance_id 读取稳定 id，不用进程/时间派生', async () => {
    const h = harness();
    const sessionId = 'ses_instance_config';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const stableId = 'stable-from-config';
    await h.repos.config.set(INSIGHT_INSTANCE_ID_CONFIG_KEY, stableId);
    const home = setupCodexHome(h.root, [{
      name: `rollout-cfg-${CODEX_NATIVE_ID}.jsonl`,
      source: CODEX_FIXTURE,
    }]);
    h.repos.insight.appendHistoricalProof({
      observationId: 'hist_cfg_identity',
      sessionId, activeRunId: runId, driverInstanceId: 'historical-resolver',
      client: 'codex', launchKind: 'attached', proofKind: 'historical_verified',
      capturedAt: at, dataRoot: home, cwd: FIXTURE_CWD,
      nativeSessionId: CODEX_NATIVE_ID, verifiedPath: null, identityProof: 'ledger_identity',
      sourceSessionKey: null, streamIdentity: MAIN, sourceKey: null,
    });
    const resolver = new SessionInsightResolver({
      repositories: {
        insight: h.repos.insight, sessions: h.repos.sessions, execution: h.repos.execution,
        config: h.repos.config, agents: h.repos.agents,
      },
      configuredRoots: [{ client: 'codex', path: home }],
      createTranscriptSourceKeys,
    });
    const result = await resolver.resolveSessionInsightSources(sessionId);
    const expected = createTranscriptSourceKeys(stableId, 'codex', resolve(home), CODEX_NATIVE_ID, MAIN)!;
    expect(result.sources[0]!.sourceKey).toBe(expected.sourceKey);
  });

  it('多个不同历史 main 均核验通过且无当前权威时 primary=null，不随意取第一个', async () => {
    const h = harness();
    const sessionId = 'ses_two_mains';
    const runId = `run_${sessionId}`;
    await saveAgent(h, { id: 'codex' });
    createSession(h, sessionId, 'codex', FIXTURE_CWD, runId);
    lifecycleDriver(h, sessionId, runId);
    const homeA = join(h.root, 'home-a');
    const homeB = join(h.root, 'home-b');
    const dirA = join(homeA, 'sessions/2026/10/03');
    const dirB = join(homeB, 'sessions/2026/10/03');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const idA = '01a0ffa7-aaaa-72f1-be55-aaaaaaaaaaaa';
    const idB = '01a0ffa7-bbbb-72f1-be55-bbbbbbbbbbbb';
    const writeRollout = (dir: string, id: string, name: string) => {
      writeFileSync(join(dir, name), JSON.stringify({
        timestamp: at, ordinal: 0, type: 'session_meta',
        payload: { id, session_id: id, cwd: FIXTURE_CWD },
      }) + '\n');
    };
    writeRollout(dirA, idA, `rollout-a-${idA}.jsonl`);
    writeRollout(dirB, idB, `rollout-b-${idB}.jsonl`);
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: homeA, nativeSessionId: idA,
      verifiedPath: join(dirA, `rollout-a-${idA}.jsonl`),
    });
    appendLaunchObserved(h, {
      sessionId, runId, client: 'codex', dataRoot: homeB, nativeSessionId: idB,
      verifiedPath: join(dirB, `rollout-b-${idB}.jsonl`),
      driverInstanceId: 'driver-1',
    });

    const result = await h.resolve(sessionId, {
      configuredRoots: [
        { client: 'codex', path: homeA },
        { client: 'codex', path: homeB },
      ],
    });
    const mains = result.sources.filter(s => s.status === 'matched' && s.expectedStream.kind === 'main');
    expect(mains).toHaveLength(2);
    expect(result.primarySourceKey).toBeNull();
    expect(mains.every(m => m.role === 'additional')).toBe(true);
  });
});
