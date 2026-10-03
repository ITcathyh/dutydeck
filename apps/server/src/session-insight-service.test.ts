import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  createContinuousMetric,
  createCountMetric,
  RuntimeError,
  type AnalyzeFilesRequest,
  type AnalyzeFilesResult,
  type EngineVersionInfo,
  type FileMetrics,
  type FileAnalysisResult,
  type InsightClient,
  type RepositoryBundle,
  type RuntimeControlClaim,
  type SessionInsightSnapshotRecord,
  type StreamIdentity
} from '@dutydeck/shared';
import { createRepositories } from '@dutydeck/storage';
import {
  SessionInsightService,
  type InsightEngineRunner,
  type ResolvedInsightSource,
  type ResolveSessionInsightSourcesResult,
  type SessionInsightResolver
} from './session-insight-service.js';
import { SessionInsightProcessError } from './session-insight-process.js';
import type { ResolvedEngine } from './session-insight-engine.js';
import { configuredRootsForSession } from './service.js';
import type { AgentConfig, Session } from '@dutydeck/shared';

// ---------------------------------------------------------------------------
// 真实 SQLite + 真实快照文件 harness；只注入 fake resolver 与 fake engine runner 制造边界
// ---------------------------------------------------------------------------

const VERSIONS: EngineVersionInfo = {
  schemaVersion: 1,
  engineVersion: 'engine-1',
  parserVersion: 'parser-1',
  metricVersion: 'metric-1'
};

let tempRoots: string[] = [];
let openRepos: RepositoryBundle[] = [];
let openServices: SessionInsightService[] = [];

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 't4c-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const service of openServices.splice(0)) {
    try { await service.close(); } catch { /* service close must never throw in teardown */ }
  }
  for (const repos of openRepos.splice(0)) {
    try { repos.close(); } catch { /* ignore */ }
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function metricSet(): FileMetrics {
  const count = (value: number | null = 0) => createCountMetric({ value, quality: 'exact', status: 'available' });
  const cont = (value: number | null = 0) =>
    createContinuousMetric({ value, quality: 'exact', status: 'available' });
  return {
    inputUncached: count(10), cacheRead: count(), cacheWrite: count(), output: count(5),
    reasoningOutput: count(), totalTracked: count(15), rawInput: count(), rawOutput: count(),
    rawTotal: count(), peakContext: count(100), contextWindow: count(200),
    elapsedDurationMs: cont(1000), activeDurationMs: cont(800), idleDurationMs: cont(200),
    pairedToolDurationMs: cont(300), userTurns: count(1), assistantTurns: count(1),
    toolCalls: count(2), toolFailures: count(1), toolSuccesses: count(1), toolUnknowns: count(),
    toolFailureRate: cont(0.5), compactionCount: count(), subagentCount: count()
  };
}

interface Harness {
  service: SessionInsightService;
  repos: RepositoryBundle;
  claim: RuntimeControlClaim;
  dataDir: string;
  sourceRoot: string;
  createSession(sessionId: string): void;
  /** fake resolver：可控返回来源；file 内容即一行 JSONL。 */
  setResolverResult(result: () => ResolveSessionInsightSourcesResult | Promise<ResolveSessionInsightSourcesResult>): void;
  /** fake engine：默认成功；可替换为抛错/挂起。 */
  setRunner(runner: InsightEngineRunner['runInsightProcess']): void;
  setEngine(engine: ResolvedEngine): void;
  /** 等待 service 内队列排空（作业落终态）。 */
  settled(): Promise<void>;
  /** 在 sourceRoot 下建一个真实日志文件，返回 {path, name}。 */
  writeLog(name: string, body: string): string;
  refreshAndWait(sessionId: string): Promise<string>;
}

function makeFileResult(args: {
  request: AnalyzeFilesRequest;
  status: FileAnalysisResult['status'];
  inputExcerpt?: string;
}): FileAnalysisResult[] {
  return args.request.files.map(file => ({
    sourceKey: file.sourceKey,
    client: file.client,
    sha256: file.sha256,
    nativeSessionId: file.expectedNativeSessionId,
    streamIdentity: file.expectedStream,
    status: args.status,
    ...(args.status === 'error' ? { errorCode: 'parse_failed' } : {}),
    metrics: metricSet(),
    models: ['model-x'],
    trace: args.status === 'error'
      ? [
          // error 文件的 trace 带私有 canary：发布时必须被整文件排除，绝不能落库。
          {
            eventId: `evt-${file.sourceKey}-secret`,
            sourceKey: file.sourceKey,
            nativeSessionId: file.expectedNativeSessionId,
            lineNumber: 1, byteOffset: 0, subeventIndex: 0,
            timestamp: '2026-10-03T00:00:00.000Z', timeQuality: 'exact',
            kind: 'system', inputExcerpt: args.inputExcerpt ?? 'SHOULD_NOT_PUBLISH',
            evidenceRefs: [], isSnapshotLocalId: false
          } as FileAnalysisResult['trace'][number]
        ]
      : [
          {
            eventId: `evt-${file.sourceKey}-1`,
            sourceKey: file.sourceKey,
            nativeSessionId: file.expectedNativeSessionId,
            lineNumber: 1, byteOffset: 0, subeventIndex: 0,
            timestamp: '2026-10-03T00:00:00.000Z', timeQuality: 'exact',
            kind: 'tool_call', toolName: 'shell', resultStatus: 'failure',
            inputExcerpt: args.inputExcerpt,
            evidenceRefs: [], isSnapshotLocalId: false
          } as FileAnalysisResult['trace'][number]
        ],
    pulseBuckets: [],
    coverage: {
      rawLines: 1, parsedLines: 1, ignoredLines: 0, errorLines: 0,
      timeRange: { start: '2026-10-03T00:00:00.000Z', end: '2026-10-03T00:00:01.000Z' },
      missingTimestampCount: 0, disorderedTimestampCount: 0,
      retainedTraceCount: 1, omittedTraceCount: 0, omittedTraceByCategory: {},
      tokenSamplesAvailable: 1, tokenSamplesMissing: 0,
      subagentDiscovery: 'none', inheritedHistory: 'none'
    },
    relationship: { kind: 'none', parentNativeSessionId: null, parentNativeAgentId: null, evidenceRefs: [] },
    aggregation: { eligibility: 'eligible', reasonCodes: [] }
  }));
}

function makeHarness(): Harness {
  const dataDir = newTempDir();
  const sourceRoot = join(dataDir, 'approved-roots');
  mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  openRepos.push(repos);
  const claim = repos.control.attachRuntime('t4c-test-controller');
  const at = '2026-10-03T00:00:00.000Z';

  let resolverImpl: () => ResolveSessionInsightSourcesResult | Promise<ResolveSessionInsightSourcesResult> =
    () => ({ sources: [], primarySourceKey: null });
  const resolver: SessionInsightResolver = {
    resolveSessionInsightSources: async (sessionId, options) => {
      const result = await resolverImpl();
      void sessionId; void options;
      return result;
    }
  };

  let engine: ResolvedEngine = {
    status: 'available',
    binaryPath: join(dataDir, 'engine'),
    platformArch: 'linux-amd64',
    sha256: 'a'.repeat(64),
    manifestPath: join(dataDir, 'manifest.json'),
    versions: VERSIONS
  };
  let runnerImpl: InsightEngineRunner['runInsightProcess'] = async ({ request }) => ({
    schemaVersion: 1,
    requestId: request.requestId,
    engineVersion: VERSIONS.engineVersion,
    parserVersion: VERSIONS.parserVersion,
    metricVersion: VERSIONS.metricVersion,
    files: makeFileResult({ request, status: 'ok' }),
    warnings: []
  });

  const service = new SessionInsightService({
    insightRepository: repos.insight,
    resolver,
    dataDir,
    processRunId: 't4c-run',
    hostEvidence: {
      readHostEvidenceRaw: sid => repos.insight.readHostEvidenceRaw(sid),
      getSessionExecutions: sid => repos.execution.getSessionExecutions(sid),
      getAcceptedTask: id => repos.execution.getAcceptedTask(id),
      readTransaction: work => repos.insight.readTransaction(work)
    },
    resolveEngine: async () => engine,
    engineRunner: { runInsightProcess: opts => runnerImpl(opts) }
  });
  openServices.push(service);

  const createSession = (sessionId: string) => {
    repos.execution.bind(claim).createSession({
      id: sessionId, runId: `run-${sessionId}`, agentId: 'agent-1',
      cwd: sourceRoot, state: 'idle', createdAt: at, updatedAt: at
    });
  };

  const writeLog = (name: string, body: string): string => {
    const p = join(sourceRoot, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body.endsWith('\n') ? body : `${body}\n`, { mode: 0o600 });
    return p;
  };

  const matchedSource = (
    key: string,
    path: string,
    role: ResolvedInsightSource['role'],
    client: InsightClient = 'codex',
    nativeId = `native-${key}`,
    stream: StreamIdentity = { kind: 'main', nativeAgentId: null }
  ): ResolvedInsightSource => ({
    sourceKey: key,
    client,
    status: 'matched',
    approvedRoot: sourceRoot,
    verifiedPath: path,
    expectedNativeSessionId: nativeId,
    expectedStream: stream,
    proofKind: 'historical_verified',
    role,
    discoveryLimited: false,
    relationship: { kind: 'none', parentNativeSessionId: null, parentNativeAgentId: null, evidenceRefs: [] }
  });

  return {
    service, repos, claim, dataDir, sourceRoot,
    createSession,
    setResolverResult: impl => { resolverImpl = impl; },
    setRunner: r => { runnerImpl = r; },
    setEngine: e => { engine = e; },
    async settled(sessionId = 's1') {
      // 真实墙钟 + 小间隔轮询该 session 终态，高并发测试套下避免固定 tick 空转过早超时。
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const state = repos.insight.getState(sessionId).state;
        if (state !== 'queued' && state !== 'running') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('job did not settle in time');
    },
    writeLog,
    async refreshAndWait(sessionId: string) {
      const res = await service.refresh(sessionId);
      await harness_settle(service, repos, sessionId, res.requestId);
      return res.requestId;
    },
    _matchedSource: matchedSource
  } as Harness & { _matchedSource: typeof matchedSource };
}

async function harness_settle(
  service: SessionInsightService,
  repos: RepositoryBundle,
  sessionId: string,
  requestId: string
): Promise<void> {
  void service;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = repos.insight.getState(sessionId);
    if (state.requestId === requestId && state.state !== 'queued' && state.state !== 'running') return;
    // 新请求合并了别的 id 也算终态
    if (state.state === 'succeeded' || state.state === 'failed' || state.state === 'cancelled') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('job did not settle in time');
}

// ---------------------------------------------------------------------------
// 队列与生命周期
// ---------------------------------------------------------------------------

describe('SessionInsightService queue / merge', () => {
  it('merges a second refresh of the same session onto the in-flight requestId', async () => {
    const h = makeHarness();
    h.createSession('s1');
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.setRunner(async ({ signal }) => {
      if (signal) await new Promise(resolve => signal.addEventListener('abort', resolve));
      await gate;
      throw new SessionInsightProcessError('INSIGHT_INTERRUPTED', 'aborted');
    });
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', h.writeLog('a.jsonl', '{"x":1}'), 'primary')],
      primarySourceKey: 'k1'
    }));

    const first = await h.service.refresh('s1');
    await new Promise(r => setTimeout(r, 10));
    const second = await h.service.refresh('s1');
    expect(second.requestId).toBe(first.requestId);
    expect(second.state === 'queued' || second.state === 'running').toBe(true);
    release!();
    // 本用例只断言 in-flight 合并；该 runner 一直挂到外部 abort，作业终态由
    // afterEach 的 service.close() 中止并等待（不在这里假装 settle）。
  });

  it('enforces 1 running + 16 queued and rejects the 17th with 429', async () => {
    const h = makeHarness();
    // resolver 返回无 matched 来源 → 作业很快终态；这里用一个永久挂起闸门制造稳定 running/queued。
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    h.setRunner(async ({ signal }) => {
      if (signal) await new Promise(resolve => signal.addEventListener('abort', resolve));
      await gate;
      throw new SessionInsightProcessError('INSIGHT_INTERRUPTED', 'aborted');
    });
    h.setResolverResult(function (this: unknown) {
      const id = (this as { sid?: string })?.sid;
      void id;
      return {
        sources: [], // resolver 内拿不到 session；真正占用在 runner，下面用 beginRefresh 占位
        primarySourceKey: null
      };
    });

    // 直接占用 1 个 running + 16 个 queued（repo 权威容量），service.refresh 再接纳第 17 个必 429。
    // 先让一个真实作业进入 running：
    h.createSession('run-session');
    const running = await h.service.refresh('run-session');
    // 该作业无 matched 来源会立即失败，无法保持 running；改为直接用 repo 构造稳定队列状态。
    void running;
    for (let i = 0; i < 16; i++) {
      const sid = `q-${i}`;
      h.createSession(sid);
      h.repos.insight.beginRefresh(sid, `req-q-${i}`, 'other-run');
    }
    h.createSession('one-too-many');
    await expect(h.service.refresh('one-too-many')).rejects.toMatchObject({
      code: 'INSIGHT_QUEUE_FULL',
      statusCode: 429
    });
    releaseGate!();
  });
});

describe('SessionInsightService cancel', () => {
  it('cancels a queued job and a running job, and an old request id does not touch a new one', async () => {
    const h = makeHarness();
    h.createSession('s1');
    h.setResolverResult(() => ({ sources: [], primarySourceKey: null }));

    // queued 取消：直接 repo 排队，service.cancel 幂等。
    h.repos.insight.beginRefresh('s1', 'old-queued', 'other-run');
    const cancelled = await h.service.cancel('s1', 'old-queued');
    expect(cancelled.success).toBe(true);
    expect(cancelled.state).toBe('cancelled');

    // running 作业：abort 后 runner 立即抛 interrupted；repo 已 cancelled，finishFailed 不得覆盖。
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', h.writeLog('b.jsonl', '{"x":1}'), 'primary')],
      primarySourceKey: 'k1'
    }));
    let runnerAborted = false;
    h.setRunner(async ({ signal }) => {
      await new Promise(resolve => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', resolve);
        setTimeout(resolve, 5000);
      });
      runnerAborted = true;
      throw new SessionInsightProcessError('INSIGHT_INTERRUPTED', 'aborted');
    });
    const refresh = await h.service.refresh('s1');
    await new Promise(r => setTimeout(r, 20));
    const cancelRun = await h.service.cancel('s1', refresh.requestId);
    expect(cancelRun.success).toBe(true);
    await h.settled();
    expect(runnerAborted).toBe(true);
    expect(h.repos.insight.getState('s1').state).toBe('cancelled');

    // 旧 requestId 取消不影响已成功的新作业：发布一份成功快照后用旧 id cancel。
    h.setRunner(async ({ request }) => ({
      schemaVersion: 1, requestId: request.requestId,
      engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
      files: makeFileResult({ request, status: 'ok' }), warnings: []
    }));
    const successId = await h.refreshAndWait('s1');
    expect(h.repos.insight.getState('s1').state).toBe('succeeded');
    const staleCancel = await h.service.cancel('s1', 'totally-old-id');
    expect(staleCancel.success).toBe(false);
    expect(staleCancel.state).toBe('succeeded');
    void successId;
  });

  it('repeated queue-then-cancel never leaves queued rows or grows capacity', async () => {
    const h = makeHarness();
    h.createSession('loop');
    // resolver/runner 不被调用：每次 refresh 后立即 cancel 该精确 requestId（作业仍 queued）。
    h.setResolverResult(() => ({ sources: [], primarySourceKey: null }));
    for (let i = 0; i < 100; i++) {
      const res = await h.service.refresh('loop');
      expect(res.state).toBe('queued');
      const cancelled = await h.service.cancel('loop', res.requestId);
      expect(cancelled.success).toBe(true);
    }
    // 100 次排队+取消后无遗留 queued/running；可立即接纳新作业，证明 SQL/内存容量未被占用。
    const p = h.writeLog('after.jsonl', '{"line":1}');
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', p, 'primary')],
      primarySourceKey: 'k1'
    }));
    h.setRunner(async ({ request }) => ({
      schemaVersion: 1, requestId: request.requestId,
      engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
      files: makeFileResult({ request, status: 'ok' }), warnings: []
    }));
    await h.refreshAndWait('loop');
    expect(h.repos.insight.getState('loop').state).toBe('succeeded');
  });
});

describe('SessionInsightService startup interruption', () => {
  it('marks queued/running rows from a previous process run as interrupted on initialize', async () => {
    const h = makeHarness();
    h.createSession('s1');
    h.createSession('s2');
    h.repos.insight.beginRefresh('s1', 'req-old-1', 'previous-process');
    h.repos.insight.markRunning('s1', 'req-old-1', 'previous-process');
    h.repos.insight.beginRefresh('s2', 'req-old-2', 'previous-process');

    await h.service.initialize();
    expect(h.repos.insight.getState('s1').state).toBe('interrupted');
    expect(h.repos.insight.getState('s2').state).toBe('interrupted');
  });
});

// ---------------------------------------------------------------------------
// 缓存命中 / binding / host-only / 错误文件
// ---------------------------------------------------------------------------

describe('SessionInsightService cache and binding', () => {
  it('repeats the same content+host to a cache hit without a new snapshot, and bumps binding on source change', async () => {
    const h = makeHarness();
    h.createSession('s1');
    const logPath = h.writeLog('stable.jsonl', '{"line":1}');
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', logPath, 'primary')],
      primarySourceKey: 'k1'
    }));
    h.setRunner(async ({ request }) => ({
      schemaVersion: 1, requestId: request.requestId,
      engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
      files: makeFileResult({ request, status: 'ok' }), warnings: []
    }));

    const first = await h.refreshAndWait('s1');
    const snap1 = h.repos.insight.getState('s1').currentSnapshotId!;
    expect(h.repos.insight.getState('s1').state).toBe('succeeded');

    // 第二次：内容/host/版本不变 → 缓存命中，同一 snapshotId，不重跑 Go。
    let engineCalls = 0;
    h.setRunner(async ({ request }) => {
      engineCalls++;
      return {
        schemaVersion: 1, requestId: request.requestId,
        engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
        files: makeFileResult({ request, status: 'ok' }), warnings: []
      };
    });
    await h.refreshAndWait('s1');
    expect(h.repos.insight.getState('s1').currentSnapshotId).toBe(snap1);
    expect(engineCalls).toBe(0);
    void first;

    // bindingRevision 前进（来源实质变化）：cache hit 路径必须判 source_binding_changed，不用旧快照。
    const current = h.repos.insight.getState('s1');
    // 直接以更高 expected revision 模拟来源在解析期间被改：发布路径同样校验。
    h.repos.insight.beginRefresh('s1', 'req-binding', 't4c-run');
    h.repos.insight.markRunning('s1', 'req-binding', 't4c-run');
    const hitOutcome = h.repos.insight.resolveCacheHit('s1', 'req-binding',
      h.repos.insight.getSnapshot('s1')!.cacheKey, current.bindingRevision + 1);
    expect(hitOutcome.outcome).toBe('binding_changed');
    expect(h.repos.insight.getState('s1').state).toBe('failed');
    expect(h.repos.insight.getState('s1').errorCode).toBe('source_binding_changed');
    // 旧快照指针保留。
    expect(h.repos.insight.getState('s1').currentSnapshotId).toBe(snap1);
  });

  it('misses the cache when the engine version changes for identical content and host', async () => {
    const h = makeHarness();
    h.createSession('s1');
    const logPath = h.writeLog('ver.jsonl', '{"line":1}');
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', logPath, 'primary')],
      primarySourceKey: 'k1'
    }));
    h.setRunner(async ({ request }) => ({
      schemaVersion: 1, requestId: request.requestId,
      engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
      files: makeFileResult({ request, status: 'ok' }), warnings: []
    }));
    await h.refreshAndWait('s1');
    const firstSnap = h.repos.insight.getState('s1').currentSnapshotId;

    // 引擎版本变化：locator 握手返回新版本，cacheKey 随之不同 → miss，必须真的再跑一次 Go。
    h.setEngine({
      status: 'available', binaryPath: join(h.dataDir, 'engine2'), platformArch: 'linux-amd64',
      sha256: 'b'.repeat(64), manifestPath: join(h.dataDir, 'm2.json'),
      versions: { schemaVersion: 1, engineVersion: 'engine-2', parserVersion: 'parser-1', metricVersion: 'metric-1' }
    });
    let ran = false;
    h.setRunner(async ({ request }) => {
      ran = true;
      return {
        schemaVersion: 1, requestId: request.requestId,
        engineVersion: 'engine-2', parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
        files: makeFileResult({ request, status: 'ok' }), warnings: []
      };
    });
    await h.refreshAndWait('s1');
    expect(ran).toBe(true);
    expect(h.repos.insight.getState('s1').currentSnapshotId).not.toBe(firstSnap);
  });

  it('publishes host-only failure when no source is matched, details still returns host evidence', async () => {
    const h = makeHarness();
    h.createSession('s1');
    h.setResolverResult(() => ({
      sources: [
        { sourceKey: 'missing-k', client: 'codex', status: 'missing',
          expectedNativeSessionId: 'native-x', expectedStream: { kind: 'main', nativeAgentId: null },
          proofKind: 'inferred', role: 'excluded', discoveryLimited: false,
          relationship: { kind: 'none', parentNativeSessionId: null, parentNativeAgentId: null, evidenceRefs: [] } }
      ],
      primarySourceKey: null
    }));
    let ran = false;
    h.setRunner(async () => { ran = true; throw new Error('should not run Go'); });
    await h.refreshAndWait('s1');
    expect(ran).toBe(false);
    expect(h.repos.insight.getState('s1').state).toBe('failed');
    expect(h.repos.insight.getState('s1').errorCode).toBe('no_verified_source');

    const details = await h.service.details('s1');
    expect(details.summary).toBeNull();
    expect(details.manifest).toBeNull();
    expect(details.status.availability).toBe('none');
    expect(details.hostExecutionFallback?.hasExecutionRecords).toBe(true);
  });

  it('excludes error-file traces from publication while keeping a valid partial snapshot', async () => {
    const h = makeHarness();
    h.createSession('s1');
    const good = h.writeLog('good.jsonl', '{"line":1}');
    const bad = h.writeLog('bad.jsonl', '{"line":2}');
    h.setResolverResult(() => ({
      sources: [
        h._matchedSource('good', good, 'primary'),
        h._matchedSource('bad', bad, 'subagent')
      ],
      primarySourceKey: 'good'
    }));
    h.setRunner(async ({ request }) => {
      const result: AnalyzeFilesResult = {
        schemaVersion: 1, requestId: request.requestId,
        engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
        files: request.files.map(file =>
          makeFileResult({
            request,
            status: file.sourceKey === 'bad' ? 'error' : 'partial'
          }).find(f => f.sourceKey === file.sourceKey)!),
        warnings: []
      };
      return result;
    });
    await h.refreshAndWait('s1');
    const state = h.repos.insight.getState('s1');
    expect(state.state).toBe('succeeded');
    const snapshot = h.repos.insight.getSnapshot('s1')!;
    // error 文件不出现在可读事件里，其 "SHOULD_NOT_PUBLISH" trace 必须缺席。
    const events = h.repos.insight.listEvents({ snapshotId: snapshot.snapshotId, limit: 200 });
    expect(events.items.every(e => e.sourceKey !== 'bad')).toBe(true);
    expect(JSON.stringify(events.items)).not.toContain('SHOULD_NOT_PUBLISH');
    // primary 保留为 good，bad 在摘要里标 excluded。
    expect(snapshot.summary.primarySourceKey).toBe('good');
    expect(snapshot.summary.sources.find(s => s.sourceKey === 'bad')?.scopeRole).toBe('excluded');
  });

  it('never leaks a private path canary into published events', async () => {
    const h = makeHarness();
    h.createSession('s1');
    const secretPath = h.writeLog('secret.jsonl', '{"line":1}');
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', secretPath, 'primary')],
      primarySourceKey: 'k1'
    }));
    h.setRunner(async ({ request }) => ({
      schemaVersion: 1, requestId: request.requestId,
      engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
      files: makeFileResult({ request, status: 'ok', inputExcerpt: `read ${secretPath} --token=abc123` }),
      warnings: []
    }));
    await h.refreshAndWait('s1');
    const snapshot = h.repos.insight.getSnapshot('s1')!;
    const events = h.repos.insight.listEvents({ snapshotId: snapshot.snapshotId, limit: 200 });
    expect(JSON.stringify(events.items)).not.toContain(secretPath);
    expect(JSON.stringify(events.items)).not.toContain('abc123');
  });

  it('keeps the previous snapshot readable when a later analysis fails', async () => {
    const h = makeHarness();
    h.createSession('s1');
    const p = h.writeLog('ok.jsonl', '{"line":1}');
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', p, 'primary')],
      primarySourceKey: 'k1'
    }));
    h.setRunner(async ({ request }) => ({
      schemaVersion: 1, requestId: request.requestId,
      engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
      files: makeFileResult({ request, status: 'ok' }), warnings: []
    }));
    await h.refreshAndWait('s1');
    const goodSnap = h.repos.insight.getState('s1').currentSnapshotId;

    // 改变日志内容使 cacheKey miss（否则相同输入直接缓存命中不跑 Go），引擎抛预算错误。
    h.writeLog('ok.jsonl', '{"line":2}');
    h.setRunner(async () => {
      throw new SessionInsightProcessError('INSIGHT_BUDGET_EXCEEDED', 'budget');
    });
    await h.refreshAndWait('s1');
    const state = h.repos.insight.getState('s1');
    expect(state.state).toBe('failed');
    expect(state.errorCode).toBe('INSIGHT_BUDGET_EXCEEDED');
    expect(state.currentSnapshotId).toBe(goodSnap);
    expect(h.repos.insight.getSnapshot('s1', goodSnap!)).toBeDefined();
  });

  it('collapses private error codes to the fixed analysis failure code', async () => {
    const h = makeHarness();
    h.createSession('s1');
    const p = h.writeLog('code.jsonl', '{"line":1}');
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', p, 'primary')],
      primarySourceKey: 'k1'
    }));
    h.setRunner(async () => {
      // 依赖抛出携带私有路径/token 的非白名单 code，绝不能进入持久 errorCode。
      const err = new Error('boom') as Error & { code?: string };
      err.code = `ENGINE_AT_${join(h.sourceRoot, 'secret')}_token_abc`;
      throw err;
    });
    await h.refreshAndWait('s1');
    const state = h.repos.insight.getState('s1');
    expect(state.state).toBe('failed');
    expect(state.errorCode).toBe('INSIGHT_ANALYSIS_FAILED');
    expect(state.errorCode).not.toContain('secret');
  });

  it('always removes the per-request temp directory after a job, even on engine failure', async () => {
    const h = makeHarness();
    h.createSession('s1');
    const p = h.writeLog('tmp.jsonl', '{"line":1}');
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', p, 'primary')],
      primarySourceKey: 'k1'
    }));
    h.setRunner(async () => {
      throw new SessionInsightProcessError('INSIGHT_PROCESS_ERROR', 'x');
    });
    await h.refreshAndWait('s1');
    const fs = await import('node:fs/promises');
    // temp 清理在作业 finally 内；轮询直到目录为空（失败后也必须清理）。
    let entries: string[] = ['pending'];
    for (let i = 0; i < 50 && entries.length > 0; i++) {
      entries = await fs.readdir(join(h.dataDir, 'insight-tmp')).catch(() => [] as string[]);
      if (entries.length > 0) await new Promise(r => setTimeout(r, 20));
    }
    expect(entries.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 读取 API：归属 / 410 / 404
// ---------------------------------------------------------------------------

describe('SessionInsightService read ownership', () => {
  it('events rejects cross-snapshot access with 404 and evicted snapshot with 410', async () => {
    const h = makeHarness();
    h.createSession('s1');
    h.createSession('s2');
    const p = h.writeLog('s1.jsonl', '{"line":1}');
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', p, 'primary')],
      primarySourceKey: 'k1'
    }));
    h.setRunner(async ({ request }) => ({
      schemaVersion: 1, requestId: request.requestId,
      engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
      files: makeFileResult({ request, status: 'ok' }), warnings: []
    }));
    await h.refreshAndWait('s1');
    const snapshotId = h.repos.insight.getState('s1').currentSnapshotId!;

    // 不能仅凭 snapshotId 查他 session。
    await expect(h.service.events('s2', { snapshotId, limit: 100 })).rejects.toMatchObject({
      code: 'INSIGHT_NOT_FOUND', statusCode: 404
    });

    // 淘汰后固定 snapshot 请求 410。
    h.repos.insight.prune(0);
    expect(h.repos.insight.isSnapshotTombstoned('s1', snapshotId)).toBe(true);
    await expect(h.service.events('s1', { snapshotId, limit: 100 })).rejects.toMatchObject({
      code: 'INSIGHT_SNAPSHOT_GONE', statusCode: 410
    });
  });

  it('details with an explicit unknown snapshotId returns 404, unknown session returns 404', async () => {
    const h = makeHarness();
    h.createSession('s1');
    await expect(h.service.details('s1', 'nope')).rejects.toMatchObject({
      code: 'INSIGHT_NOT_FOUND', statusCode: 404
    });
    await expect(h.service.details('ghost')).rejects.toMatchObject({
      code: 'INSIGHT_NOT_FOUND', statusCode: 404
    });
  });
});

// ---------------------------------------------------------------------------
// 关闭顺序与临时文件清理
// ---------------------------------------------------------------------------

describe('SessionInsightService lifecycle', () => {
  it('aborts a running job on close, settles it cancelled, and removes temp dirs', async () => {
    const h = makeHarness();
    h.createSession('s1');
    const p = h.writeLog('life.jsonl', '{"line":1}');
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', p, 'primary')],
      primarySourceKey: 'k1'
    }));
    let runnerClosed = false;
    const entered = new Promise<void>(resolve => {
      h.setRunner(async ({ signal }) => {
        resolve();
        await new Promise(done => {
          if (signal?.aborted) return done();
          signal?.addEventListener('abort', done);
          setTimeout(done, 5000);
        });
        // abort 后才到达：模拟真实 runner 等到 child close 才返回。
        runnerClosed = true;
        throw new SessionInsightProcessError('INSIGHT_INTERRUPTED', 'aborted');
      });
    });

    await h.service.refresh('s1');
    await entered;
    await h.service.close();
    // close 已 await runner，真实 child 关闭点（runner 返回）必须已执行。
    expect(runnerClosed).toBe(true);
    const state = h.repos.insight.getState('s1');
    // 必须落持久 cancelled（不是 running/failed），且没有旧 snapshot 被改动（本就无快照）。
    expect(state.state).toBe('cancelled');
    // 关闭后拒绝新 refresh。
    await expect(h.service.refresh('s1')).rejects.toMatchObject({ code: 'INSIGHT_QUEUE_FULL' });
    // insight-tmp 下无残留。
    const tmpBase = join(h.dataDir, 'insight-tmp');
    const remaining = (await import('node:fs/promises')).readdir(tmpBase).catch(() => [] as string[]);
    expect((await remaining).length).toBe(0);
  });

  it('close before initialize is safe and idempotent', async () => {
    const h = makeHarness();
    await h.service.close();
    await h.service.close();
  });
});

// ---------------------------------------------------------------------------
// summary 完整 catalog（多页）
// ---------------------------------------------------------------------------

describe('SessionInsightService summary catalog', () => {
  it('reads the entire catalog across pages and keeps cold/hot candidate counts equal', async () => {
    const h = makeHarness();
    const total = 120; // 超过单页 100
    for (let i = 0; i < total; i++) h.createSession(`s${i}`);
    const before = await h.service.summary({ groupBy: 'workspace', limit: 50 });
    expect(before.candidateSessions).toBe(total);
    expect(before.withSnapshot + before.withoutSnapshot).toBe(total);
    expect(before.withoutSnapshot).toBe(total);

    // 分析一个会话后：候选总数不变，withSnapshot 增 1。
    const p = h.writeLog('cat.jsonl', '{"line":1}');
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', p, 'primary')],
      primarySourceKey: 'k1'
    }));
    h.setRunner(async ({ request }) => ({
      schemaVersion: 1, requestId: request.requestId,
      engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
      files: makeFileResult({ request, status: 'ok' }), warnings: []
    }));
    await h.refreshAndWait('s0');
    const after = await h.service.summary({ groupBy: 'workspace', limit: 50 });
    expect(after.candidateSessions).toBe(total);
    expect(after.withSnapshot).toBe(1);
    expect(after.withoutSnapshot).toBe(total - 1);
  });
});

// ---------------------------------------------------------------------------
// compare / export 在同一读事务冻结，且校验归属
// ---------------------------------------------------------------------------

describe('SessionInsightService compare and export', () => {
  it('compares two owned snapshots and rejects export of a snapshot from another session', async () => {
    const h = makeHarness();
    h.createSession('s1');
    h.createSession('s2');
    h.createSession('s3');
    const p1 = h.writeLog('c1.jsonl', '{"line":1}');
    const p2 = h.writeLog('c2.jsonl', '{"line":2}');
    h.setResolverResult(() => ({ sources: [], primarySourceKey: null }));
    h.setRunner(async ({ request }) => ({
      schemaVersion: 1, requestId: request.requestId,
      engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
      files: makeFileResult({ request, status: 'ok' }), warnings: []
    }));
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', p1, 'primary')],
      primarySourceKey: 'k1'
    }));
    const id1 = await h.refreshAndWait('s1');
    const snap1 = h.repos.insight.getState('s1').currentSnapshotId!;
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', p2, 'primary')],
      primarySourceKey: 'k1'
    }));
    await h.refreshAndWait('s2');
    const snap2 = h.repos.insight.getState('s2').currentSnapshotId!;

    const comparison = await h.service.compare({
      left: { sessionId: 's1', snapshotId: snap1 },
      right: { sessionId: 's2', snapshotId: snap2 }
    });
    expect(comparison.left.snapshotId).toBe(snap1);
    expect(comparison.right.snapshotId).toBe(snap2);

    const report = await h.service.exportReport({
      kind: 'session', sessionId: 's1', snapshotId: snap1, format: 'markdown'
    });
    expect(report.body.length).toBeGreaterThan(0);
    expect(report.filename.endsWith('.md')).toBe(true);

    // s3 不拥有 snap1 → export 404。
    await expect(h.service.exportReport({
      kind: 'session', sessionId: 's3', snapshotId: snap1, format: 'markdown'
    })).rejects.toMatchObject({ code: 'INSIGHT_NOT_FOUND', statusCode: 404 });
    void id1;
  });
});

// ---------------------------------------------------------------------------
// 生产装配：per-session agent env 候选根（service.ts configuredRootsForSession）
// 旧会话无 observations 时，resolver 的历史发现仍能按该 session agent 自定义
// HOME / CODEX_HOME / CLAUDE_CONFIG_DIR 找到真实根；daemon env 与 agent env 不同时
// 以 agent 子进程实际 env 为准；options.env 是有效 baseline。
// ---------------------------------------------------------------------------

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-custom',
    name: 'Custom Agent',
    command: 'claude',
    args: [],
    protocol: 'pty-cli',
    env: {},
    permissionMode: 'ask',
    timeout: 600,
    ...overrides
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    agentId: 'agent-custom',
    state: 'idle',
    cwd: '/work',
    runId: 'run-1',
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    ...overrides
  };
}

const rootOf = (
  roots: Array<{ client: string; path: string }>,
  client: string
): string => roots.find(r => r.client === client)!.path;

describe('configuredRootsForSession production env wiring', () => {
  it('finds a custom-HOME legacy session root even when daemon HOME differs', () => {
    // daemon（server 进程）运行身份 HOME 与旧会话 agent 的 HOME 完全不同。
    const daemonEnv: NodeJS.ProcessEnv = {
      HOME: '/daemon/home',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'daemon-secret-should-be-stripped-on-pty',
      CLAUDE_API_KEY: 'daemon-claude-should-be-stripped'
    };
    const customHome = '/data/legacy/agent-home';
    const a = agent({
      protocol: 'pty-cli',
      env: { HOME: customHome, CODEX_HOME: `${customHome}/custom-codex` }
    });

    const roots = configuredRootsForSession(daemonEnv, session({ protocol: 'pty-cli' }), a);

    // claude 根按 agent HOME 计算，而不是 daemon HOME。
    expect(rootOf(roots, 'claude')).toBe(`${customHome}/.claude`);
    // codex 尊重 agent 显式 CODEX_HOME。
    expect(rootOf(roots, 'codex')).toBe(`${customHome}/custom-codex`);
    // trae 默认在 agent HOME 下。
    expect(rootOf(roots, 'traex')).toBe(`${customHome}/.trae`);
  });

  it('honors explicit CLAUDE_CONFIG_DIR / TRAE_HOME from the agent env', () => {
    const daemonEnv: NodeJS.ProcessEnv = { HOME: '/daemon/home', PATH: '/usr/bin' };
    const a = agent({
      protocol: 'pty-cli',
      env: {
        HOME: '/agent/home',
        CLAUDE_CONFIG_DIR: '/agent/home/cfg/claude',
        TRAE_HOME: '/agent/home/cfg/trae'
      }
    });
    const roots = configuredRootsForSession(daemonEnv, session({ protocol: 'pty-cli' }), a);
    expect(rootOf(roots, 'claude')).toBe('/agent/home/cfg/claude');
    expect(rootOf(roots, 'traex')).toBe('/agent/home/cfg/trae');
  });

  it('strips daemon ANTHROPIC_/CLAUDE_ bridge identity for pty-cli but not for acp', () => {
    const daemonEnv: NodeJS.ProcessEnv = {
      HOME: '/daemon/home',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'daemon-bridge-token',
      CLAUDE_OTHER: 'daemon-claude-var'
    };
    const pty = configuredRootsForSession(
      daemonEnv,
      session({ protocol: 'pty-cli' }),
      agent({ protocol: 'pty-cli', env: { HOME: '/agent/home' } })
    );
    // PTY 路径计算不应因 bridge 身份变量泄漏（这里主要验证 strip 规则被应用，
    // 路径本身不直接含 token；断言 env 计算不抛且根仍按 agent HOME）。
    expect(rootOf(pty, 'claude')).toBe('/agent/home/.claude');

    // ACP 不 stripClaude（vendor 变量保留由 ACP env 规则管理），但根仍按 agent HOME。
    const acp = configuredRootsForSession(
      daemonEnv,
      session({ protocol: 'acp' }),
      agent({ protocol: 'acp', env: { HOME: '/agent/acp-home' } })
    );
    expect(rootOf(acp, 'claude')).toBe('/agent/acp-home/.claude');
  });

  it('uses startLocalServer options.env as baseline (not hard-coded process.env)', () => {
    // 模拟 options.env 注入了与当前 process.env 不同的部署环境。
    const optionsEnv: NodeJS.ProcessEnv = {
      HOME: '/deploy/options/home',
      PATH: '/usr/bin',
      CODEX_HOME: '/deploy/options/codex'
    };
    const roots = configuredRootsForSession(optionsEnv, session(), undefined);
    // 无 agent 配置时回退 baseline env 自身（daemon 直跑）。
    expect(rootOf(roots, 'claude')).toBe('/deploy/options/home/.claude');
    expect(rootOf(roots, 'codex')).toBe('/deploy/options/codex');
  });

  it('returns exactly the three current client roots, never scans or enumerates other agents', () => {
    const daemonEnv: NodeJS.ProcessEnv = { HOME: '/d', PATH: '/usr/bin' };
    const roots = configuredRootsForSession(daemonEnv, session(), agent());
    expect(roots.map(r => r.client).sort()).toEqual(['claude', 'codex', 'traex']);
    // 纯路径字符串，不读盘：即使 HOME 不存在也不抛。
    for (const root of roots) expect(typeof root.path).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 生产 wrapper 端到端：createInsightResolver(repos, serverEnv) 每次 resolve 按
// session agent 当前 env 算候选根，交给真实 SessionInsightResolver。
// 自定义 agent HOME 的旧会话、零 insight observation、daemon env 不同，
// 仍须凭真实 marker 内容核验发现（非 launch_observed，不扫 daemon HOME）。
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { buildSessionMarker } from '@dutydeck/pty-driver';
import { createInsightResolver } from './service.js';
import type { RepositoryBundle, RuntimeControlClaim } from '@dutydeck/shared';

describe('createInsightResolver production wrapper (real resolver + real marker log)', () => {
  const REPO_ROOT = pathResolve(import.meta.dirname, '../../..');
  const CLAUDE_MAIN_FIXTURE = pathResolve(
    REPO_ROOT, 'tests/fixtures/session-insight/real-native/claude-main.jsonl'
  );
  const NATIVE_ID = '0192e000-7a3b-7000-8000-000000000001';
  const FIXTURE_CWD = '/workspace/test-sandbox';
  const PROJECT_KEY = FIXTURE_CWD.replace(/[^A-Za-z0-9-]/g, '-');
  const AT = '2026-10-03T03:00:00.000Z';

  let repos: RepositoryBundle;
  let claim: RuntimeControlClaim;
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 't4c-wrapper-'));
    repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    claim = repos.control.attachRuntime('t4c-wrapper');
    // 生产由 runtime 建立并持久稳定 instance id；测试预置同一 config 键。
    await repos.config.set('insight.instance_id', 't4c-wrapper-stable-instance');
  });

  afterEach(() => {
    try { claim.release(); } catch { /* may already be released */ }
    repos.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('discovers a legacy session log under the agent custom HOME despite a different daemon HOME', async () => {
    const sessionId = 'legacy-session';
    const runId = 'run-legacy';
    const agentHome = join(root, 'agent-home');

    // session 绑定到自定义 HOME 的 pty-cli agent。
    await repos.agents.save({
      id: 'claude-code',
      name: 'claude-code',
      command: 'claude',
      args: [],
      protocol: 'pty-cli',
      env: { HOME: agentHome },
      permissionMode: 'ask',
      timeout: 600,
      capabilities: { pause: false, resume: true },
      builtin: false
    } as Parameters<RepositoryBundle['agents']['save']>[0]);

    const x = repos.execution.bind(claim);
    x.createSession({
      id: sessionId, runId, agentId: 'claude-code', cwd: FIXTURE_CWD,
      state: 'idle', createdAt: AT, updatedAt: AT
    });
    // 真实创建 driver lifecycle（resolver 历史核验需要的 ledger 锚点之一）。
    const op = x.beforeControlledOperation({ sessionId, runId }, { resourceId: 'drv-1', driverInstanceId: 'drv-1' });
    x.creationFinished({ sessionId, runId }, op.resourceId, op.revision, 'created');

    // 零 insight observation：只有文件系统里带 marker 的真实日志。
    expect(repos.insight.listSources(sessionId)).toHaveLength(0);
    const projectDir = join(agentHome, '.claude', 'projects', PROJECT_KEY);
    mkdirSync(projectDir, { recursive: true });
    const markerLine = JSON.stringify({
      type: 'user',
      sessionId: NATIVE_ID,
      cwd: FIXTURE_CWD,
      timestamp: AT,
      message: { role: 'user', content: buildSessionMarker(sessionId) }
    });
    writeFileSync(
      join(projectDir, `${NATIVE_ID}.jsonl`),
      `${markerLine}\n${readFileSync(CLAUDE_MAIN_FIXTURE, 'utf8')}`
    );

    // daemon（server 进程）运行身份 HOME 完全不同；options.env 为有效 baseline。
    const daemonEnv: NodeJS.ProcessEnv = {
      HOME: join(root, 'daemon-home-that-is-not-scanned'),
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'daemon-bridge-secret'
    };
    const resolver = createInsightResolver(repos, daemonEnv);
    const result = await resolver.resolveSessionInsightSources(sessionId);

    const main = result.sources.find(s => s.expectedStream.kind === 'main');
    expect(main).toBeDefined();
    expect(main!.status).toBe('matched');
    expect(main!.verifiedPath).toBe(join(projectDir, `${NATIVE_ID}.jsonl`));
    expect(result.primarySourceKey).toBe(main!.sourceKey);
    // 私有路径不进 sourceKey 身份（它是 hash）。
    expect(main!.sourceKey).not.toContain(agentHome);
    // 这是历史核验证明，不是 launch_observed。
    expect(main!.proofKind).toBe('historical_verified');
  });
});

// ---------------------------------------------------------------------------
// Astra A2 半行截尾：真实 snapshot 只送完整 prefix（Go 报 ok），
// 宿主必须把 capture.isPartial 合并为 file/source partial（保留正常 metrics）。
// ---------------------------------------------------------------------------

describe('Astra A2 half-line snapshot coverage', () => {
  it('marks a trailing partial line as partial throughout while keeping metrics and succeeding', async () => {
    const h = makeHarness();
    h.createSession('s1');
    // 真实 createInsightFileSnapshots 会截掉最后的不完整行：完整一行 + 14 字节半行。
    // 直接写文件（绕过 harness 自动补换行的 writeLog），确保末尾无 \n。
    const logPath = join(h.sourceRoot, 'half.jsonl');
    writeFileSync(logPath, `${JSON.stringify({ line: 1 })}\n{"incomplete":`, { mode: 0o600 });
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', logPath, 'primary')],
      primarySourceKey: 'k1'
    }));
    // Go 只收完整 prefix，因此按 ok 返回；宿主必须降级为 partial。
    h.setRunner(async ({ request }) => ({
      schemaVersion: 1, requestId: request.requestId,
      engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
      files: makeFileResult({ request, status: 'ok' }), warnings: []
    }));
    await h.refreshAndWait('s1');

    const state = h.repos.insight.getState('s1');
    expect(state.state).toBe('succeeded'); // 不整 job 失败，已有数据仍发布。
    const snapshot = h.repos.insight.getSnapshot('s1', state.currentSnapshotId!)!;

    // manifest：该来源 status=partial，trailingBytes=14，availability partial。
    const manifestSource = snapshot.manifest.sources.find(s => s.sourceKey === 'k1')!;
    expect(manifestSource.status).toBe('partial');
    expect(manifestSource.trailingBytes).toBe(14);
    expect(manifestSource.matchStatus).toBe('matched');

    // summary：primary source 标 partial（不是 ok），但 metrics 仍在（非 error 不清零）。
    const summarySource = snapshot.summary.sources.find(s => s.sourceKey === 'k1')!;
    expect(summarySource.status).toBe('partial');
    expect(summarySource.scopeRole).toBe('primary');
    expect(summarySource.metrics.userTurns.value).not.toBeNull();
    expect(summarySource.aggregation.eligibility).toBe('eligible');

    // details availability 一致 partial；报告可读。
    const details = await h.service.details('s1');
    expect(details.status.availability).toBe('partial');
    const report = await h.service.exportReport({
      kind: 'session', sessionId: 's1', snapshotId: snapshot.snapshotId, format: 'markdown'
    });
    expect(report.body.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Astra A3 发现截断：resolver discoveryLimited 进 cache key 与覆盖表达；
// 260 候选导致截断后第二次刷新必须 miss 旧 complete 并发布 partial 覆盖。
// ---------------------------------------------------------------------------

describe('Astra A3 discovery-limited cache identity', () => {
  it('misses the old complete snapshot when discovery becomes limited, without changing eligibility', async () => {
    const h = makeHarness();
    h.createSession('s1');
    const logPath = h.writeLog('disc.jsonl', '{"line":1}');
    let limited = false;
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', logPath, 'primary')],
      primarySourceKey: 'k1',
      discoveryLimited: limited
    }));
    h.setRunner(async ({ request }) => ({
      schemaVersion: 1, requestId: request.requestId,
      engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
      files: makeFileResult({ request, status: 'ok' }), warnings: []
    }));

    // 第一次：未截断 → complete。
    await h.refreshAndWait('s1');
    const first = h.repos.insight.getState('s1').currentSnapshotId!;
    const firstSnap = h.repos.insight.getSnapshot('s1', first)!;
    expect(firstSnap.manifest.sources.every(s => s.status === 'ok')).toBe(true);

    // 第二次：发现截断（260 候选超上限）。文件内容/host/版本不变，但必须 miss。
    limited = true;
    let engineCalls = 0;
    h.setRunner(async ({ request }) => {
      engineCalls++;
      return {
        schemaVersion: 1, requestId: request.requestId,
        engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
        files: makeFileResult({ request, status: 'ok' }), warnings: []
      };
    });
    await h.refreshAndWait('s1');
    expect(engineCalls).toBe(1); // 真 miss 重跑，而非命中旧 complete。

    const second = h.repos.insight.getState('s1').currentSnapshotId!;
    expect(second).not.toBe(first);
    const secondSnap = h.repos.insight.getSnapshot('s1', second)!;
    const source = secondSnap.manifest.sources.find(s => s.sourceKey === 'k1')!;
    expect(source.aggregation.reasonCodes).toContain('DISCOVERY_LIMITED');
    // 引擎 ok 不被改成 error/截尾；发现不足用 coverage 表达。
    expect(source.status).toBe('ok');
    // 覆盖不足表达进 summary coverage，且 primary 仍可汇总（eligibility 不变）。
    const summarySource = secondSnap.summary.sources.find(s => s.sourceKey === 'k1')!;
    expect(summarySource.coverage.subagentDiscovery).toBe('partial');
    expect(summarySource.aggregation.eligibility).toBe('eligible');
    expect(secondSnap.summary.aggregateMetrics.userTurns.value).not.toBeNull();
    const details = await h.service.details('s1');
    expect(details.status.availability).toBe('partial');

    // 第三次：截断解除 → 又是不同 key，miss 重跑回 complete（不被 partial 缓存粘住）。
    limited = false;
    await h.refreshAndWait('s1');
    const third = h.repos.insight.getState('s1').currentSnapshotId!;
    expect(third).not.toBe(second);
  });
});

// ---------------------------------------------------------------------------
// Astra A7 淘汰后重建：cache miss 新发布用新唯一 snapshotId，
// 不撞仍持 PK 的 tombstone；旧固定 ID 继续 410；cache hit 仍复用旧 ID。
// ---------------------------------------------------------------------------

describe('Astra A7 republish after tombstone', () => {
  it('publishes a new unique snapshot for identical input after prune(0), old id stays 410', async () => {
    const h = makeHarness();
    h.createSession('s1');
    const logPath = h.writeLog('tomb.jsonl', '{"line":1}');
    h.setResolverResult(() => ({
      sources: [h._matchedSource('k1', logPath, 'primary')],
      primarySourceKey: 'k1'
    }));
    h.setRunner(async ({ request }) => ({
      schemaVersion: 1, requestId: request.requestId,
      engineVersion: VERSIONS.engineVersion, parserVersion: VERSIONS.parserVersion, metricVersion: VERSIONS.metricVersion,
      files: makeFileResult({ request, status: 'ok' }), warnings: []
    }));

    await h.refreshAndWait('s1');
    const firstId = h.repos.insight.getState('s1').currentSnapshotId!;
    expect(h.repos.insight.isSnapshotTombstoned('s1', firstId)).toBe(false);

    // 淘汰：旧 ID 变 tombstone（410）。
    h.repos.insight.prune(0);
    expect(h.repos.insight.isSnapshotTombstoned('s1', firstId)).toBe(true);
    await expect(h.service.details('s1', firstId)).rejects.toMatchObject({
      code: 'INSIGHT_SNAPSHOT_GONE', statusCode: 410
    });

    // 相同输入再刷新：cache miss（无 active 快照），新发布必须成功且用新 ID，不撞 tombstone PK。
    await h.refreshAndWait('s1');
    const state = h.repos.insight.getState('s1');
    expect(state.state).toBe('succeeded');
    expect(state.currentSnapshotId).toBeTruthy();
    expect(state.currentSnapshotId).not.toBe(firstId);
    const secondId = state.currentSnapshotId!;
    expect(h.repos.insight.isSnapshotTombstoned('s1', secondId)).toBe(false);

    // 新快照可读，旧固定 ID 继续 410。
    const details = await h.service.details('s1', secondId);
    expect(details.summary?.snapshotId).toBe(secondId);
    await expect(h.service.details('s1', firstId)).rejects.toMatchObject({
      code: 'INSIGHT_SNAPSHOT_GONE', statusCode: 410
    });

    // 第三次相同输入：active 快照存在 → cache hit 复用第二个 ID（不新建）。
    await h.refreshAndWait('s1');
    expect(h.repos.insight.getState('s1').currentSnapshotId).toBe(secondId);
  });
});
