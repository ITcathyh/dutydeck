import { describe, expect, it, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRepositories } from '@dutydeck/storage';
import type {
  AgentConfig,
  AgentDriver,
  DriverContext,
  DriverFactory,
  DriverTranscriptSourceObservation,
  NativeContextIdentity
} from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';
import { __setRealpathImplForTest } from './session-insight-source.js';

const strictAgent: AgentConfig = {
  id: 'mock-strict', name: 'Mock Strict', command: process.execPath, args: [],
  protocol: 'acp', cwd: '/tmp', env: {}, permissionMode: 'full-trust',
  timeout: 10, capabilities: { pause: false, resume: true }, builtin: false
};

const ptyAgent: AgentConfig = {
  id: 'mock-pty', name: 'Mock PTY', command: process.execPath, args: [],
  protocol: 'pty-cli', cwd: '/tmp', env: {}, permissionMode: 'full-trust',
  timeout: 10, capabilities: { pause: false, resume: true }, builtin: false
};

interface CapturedDriver extends AgentDriver {
  emitSource(o: DriverTranscriptSourceObservation): void;
  replayOnSubscribe(observations: DriverTranscriptSourceObservation[]): void;
  listenerCount(): number;
}

interface DriverOpts {
  /** start() 内同步发出的观察（验证启动期 pending→ready flush）。 */
  emitDuringStart?: DriverTranscriptSourceObservation[];
  controlled?: boolean;
}

function makeFactory(): { factory: DriverFactory; drivers: CapturedDriver[] } {
  const drivers: CapturedDriver[] = [];
  const factory: DriverFactory = (configured, _protocol, _onEvent, _onExit, _sessionId, context) => {
    const opts: DriverOpts = (factory as unknown as { __opts?: DriverOpts }).__opts ?? {};
    const ctx = context as DriverContext;
    const listeners = new Set<(o: DriverTranscriptSourceObservation) => void>();
    let replay: DriverTranscriptSourceObservation[] = [];
    const driver: CapturedDriver = {
      start: vi.fn(async () => {
        if (opts.controlled && ctx.protocol === 'controlled-v1' && ctx.native) {
          if (ctx.native.expected) {
            // restore 路径（restart/resume 复用既有 native context）：真实 AcpxAdapter 只在
            // onPrepared 调 native.confirmed（confirmRecoveredNativeContext），不再 reserve。
            ctx.native.confirmed(ctx.native.expected);
          } else {
            const expected = {
              nativeCreationId: randomUUID(),
              sessionKey: ctx.native.sessionKey,
              agent: configured.id,
              command: [process.execPath],
              cwd: configured.cwd ?? '/tmp',
              executionDomain: ctx.executionDomain
            };
            const { resourceId } = ctx.native.reserve(expected);
            const identity: NativeContextIdentity = {
              ...expected,
              acpxRecordId: 'acp-record-1',
              backendSessionId: 'backend-session-1',
              agentSessionId: 'agent-session-1',
              defaults: {}
            };
            ctx.native.confirmed(identity);
            void resourceId;
          }
        }
        // 关键：在资源/订阅尚未 ready（controlled 已 reserve，但 runtime 的 ready 事务尚未提交；
        // local-only 资源还在 pending）时发出 launch root + native 两条观察。
        for (const observation of opts.emitDuringStart ?? []) {
          for (const listener of listeners) listener(observation);
        }
      }),
      send: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      isStopped: vi.fn(async () => true),
      stop: vi.fn(async () => {}),
      nativeConfiguration: vi.fn(() => ({})),
      configureNative: vi.fn(async request => {
        const prepared = ctx.prepareSubmission({
          taskId: 'configuration', attemptId: 'configuration',
          submissionId: request.operationId, prompt: '',
          executionOptions: { permissionMode: 'full-trust' as const }
        });
        return {
          context: prepared.nativeContextRef!,
          driverInstanceId: ctx.driverInstanceId,
          operationId: request.operationId,
          target: request.target,
          evidence: {}
        };
      }),
      subscribeTranscriptSource: vi.fn((listener: (o: DriverTranscriptSourceObservation) => void) => {
        listeners.add(listener);
        for (const observation of replay) listener(observation);
        return () => { listeners.delete(listener); };
      }),
      emitSource(o) { for (const listener of listeners) listener(o); },
      replayOnSubscribe(observations) { replay = observations; },
      listenerCount() { return listeners.size; }
    };
    drivers.push(driver);
    return driver;
  };
  return { factory, drivers };
}

function rootObs(id: string, over: Partial<DriverTranscriptSourceObservation> = {}): DriverTranscriptSourceObservation {
  return {
    observationId: id,
    client: 'codex',
    launchKind: 'created',
    proofKind: 'launch_observed',
    capturedAt: new Date().toISOString(),
    dataRoot: '/home/tester/.codex',
    nativeSessionId: 'native-session-1',
    streamIdentity: { kind: 'main', nativeAgentId: null },
    ...over
  };
}

async function waitFor(
  fn: () => boolean,
  description: string,
  timeoutMs = 3000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${description}`);
    await new Promise(r => setTimeout(r, 15));
  }
}

afterEach(() => { __setRealpathImplForTest(null); });

describe('runtime transcript source: real start path flush (controlled ACP)', () => {
  it('persists launch root + native observations emitted INSIDE driver.start via pending→ready flush', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const { factory, drivers } = makeFactory();
    (factory as unknown as { __opts: DriverOpts }).__opts = {
      controlled: true,
      emitDuringStart: [
        rootObs('start-root'),
        rootObs('start-native', { nativeContextRef: undefined })
      ]
    };
    factory.controlledResources = () => true;
    const runtime = new DutydeckRuntime(repos, { driverFactory: factory, cleanupIntervalMs: 0 });
    try {
      await runtime.initialize([strictAgent]);
      const session = await runtime.start({ agentId: strictAgent.id });
      await waitFor(() => repos.insight.listSources(session.id).length === 2, 'two start observations persisted');
      const rows = repos.insight.listSources(session.id);
      expect(rows.map(r => r.observationId).sort()).toEqual(['start-native', 'start-root']);
      // 启动期观察补全了 runtime 侧身份字段，且 anchor 是真实 lifecycle operation id。
      const nativeRef = repos.execution.getNativeContext(session.id)!.selection.context;
      const lifecycleResource = repos.execution.getResources(session.id)
        .find(r => r.kind === 'operation' && r.operationScope?.kind === 'lifecycle')!;
      for (const row of rows) {
        expect(row.driverInstanceId).toBe(lifecycleResource.driverInstanceId);
        expect(row.activeRunId).toBe(session.runId);
        expect(row.sourceKey).toMatch(/^[0-9a-f]{64}$/);
      }
      // 第二条带 native ref 时 T2 会校验 selection；这里验证 root 条（无 ref）即可落库。
      const withRef = rows.find(r => r.observationId === 'start-native')!;
      // 重新发一条带当前 selection 的 native 观察，证明 native ref 路径也真实通过。
      drivers.at(-1)!.emitSource(rootObs('live-native-ref', { nativeContextRef: nativeRef }));
      await waitFor(() => repos.insight.listSources(session.id).some(r => r.observationId === 'live-native-ref'), 'native-ref persisted');
      expect(withRef).toBeTruthy();
    } finally {
      await runtime.shutdown(); repos.close();
    }
  });
});

describe('runtime transcript source: real local_only (PTY-equivalent) anchor', () => {
  it('persists against the local_only child resource id via ptyDriverFactory', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const { factory, drivers } = makeFactory();
    (factory as unknown as { __opts: DriverOpts }).__opts = {
      controlled: false,
      emitDuringStart: [rootObs('pty-start-root')]
    };
    // local-only：不声明 controlledResources，reconnect 走 beforeCreate(local_only) 分支。
    const runtime = new DutydeckRuntime(repos, { ptyDriverFactory: factory, probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }), cleanupIntervalMs: 0 });
    try {
      await runtime.initialize([ptyAgent]);
      const session = await runtime.start({ agentId: ptyAgent.id });
      await waitFor(() => repos.insight.listSources(session.id).length === 1, 'pty start observation persisted');
      const row = repos.insight.listSources(session.id)[0]!;
      // T2 anchor：local_only 子资源行 id；driverInstanceId 必须等于它，而非 identityId。
      const localChild = repos.execution.getResources(session.id)
        .find(r => r.kind === 'local_only' && r.stage === 'created')!;
      expect(localChild).toBeTruthy();
      expect(row.driverInstanceId).toBe(localChild.resourceId);
      expect(row.driverInstanceId).not.toBe(localChild.identity?.identityId);
      expect(row.activeRunId).toBe(session.runId);
      expect(drivers.at(-1)!.listenerCount()).toBe(1);
    } finally {
      await runtime.shutdown(); repos.close();
    }
  });
});

describe('runtime transcript source: in-flight realpath stale races', () => {
  // 用 local-only（PTY 等价）验证 fence 机制本身：其 T2 anchor 在新 run 是新建 local_only 子行，
  // 不受 controlled restore-anchor T2 缺陷影响，因此新 driver 观察可真实落库。
  it('drops a callback whose realpath is still pending across run/driver replace, while the new driver still persists', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const { factory, drivers } = makeFactory();
    (factory as unknown as { __opts: DriverOpts }).__opts = { controlled: false };
    const runtime = new DutydeckRuntime(repos, {
      ptyDriverFactory: factory,
      probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
      cleanupIntervalMs: 0
    });
    try {
      await runtime.initialize([ptyAgent]);
      const session = await runtime.start({ agentId: ptyAgent.id });

      // 挂起 realpath：让旧 driver 的回调卡在写队列之外（fence 尚未复查）。
      let releaseRealpath: (() => void) | undefined;
      const gate = new Promise<void>(resolve => { releaseRealpath = resolve; });
      __setRealpathImplForTest(() => gate.then(() => '/canonical/root'));
      drivers.at(-1)!.emitSource(rootObs('inflight-old'));

      // replaceSessionRun + 新 generation + 新 driver；恢复 realpath 不阻塞 runtime 自身。
      __setRealpathImplForTest(null);
      const restarted = await runtime.restart(session.id);
      const newDriver = drivers.at(-1)!;
      expect(newDriver).not.toBe(drivers[0]);

      // 释放旧回调挂着的 realpath；await 后 fence 复查必须丢弃它（不依赖 unsubscribe，
      // 因为旧回调已经在 listener 同步触发、进入了 in-flight realpath 阶段）。
      releaseRealpath!();
      await new Promise(r => setTimeout(r, 150));
      expect(repos.insight.listSources(session.id).map(r => r.observationId)).not.toContain('inflight-old');

      // 新 driver 的观察在新 run 正常落库，证明是精确丢弃旧代而非整体失败。
      newDriver.emitSource(rootObs('new-driver'));
      await waitFor(
        () => repos.insight.listSources(restarted.id)
          .some(r => r.observationId === 'new-driver' && r.activeRunId === restarted.runId),
        'new driver persists on new run'
      );
    } finally {
      __setRealpathImplForTest(null);
      await runtime.shutdown(); repos.close();
    }
  });

  it('drops in-flight callbacks after claim revoke (runtime shutdown re-attaches)', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const { factory, drivers } = makeFactory();
    (factory as unknown as { __opts: DriverOpts }).__opts = { controlled: true };
    factory.controlledResources = () => true;
    const runtime = new DutydeckRuntime(repos, { driverFactory: factory, cleanupIntervalMs: 0 });
    await runtime.initialize([strictAgent]);
    const session = await runtime.start({ agentId: strictAgent.id });

    let releaseRealpath: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { releaseRealpath = resolve; });
    __setRealpathImplForTest(() => gate.then(() => '/canonical/root'));
    drivers.at(-1)!.emitSource(rootObs('inflight-shutdown'));
    // shutdown 会 revoke lifecycle owner 并停止 driver（detach 路径同样取消订阅）。
    await runtime.shutdown();
    releaseRealpath!();
    await new Promise(r => setTimeout(r, 150));
    expect(repos.insight.listSources(session.id).map(r => r.observationId)).not.toContain('inflight-shutdown');
    repos.close();
  });
});

describe('runtime transcript source: historical origin run (controlled native restore)', () => {
  it('advances selection.runId while preserving the old context.originRunId across restart', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const { factory } = makeFactory();
    (factory as unknown as { __opts: DriverOpts }).__opts = { controlled: true };
    factory.controlledResources = () => true;
    const runtime = new DutydeckRuntime(repos, { driverFactory: factory, cleanupIntervalMs: 0 });
    try {
      await runtime.initialize([strictAgent]);
      const session = await runtime.start({ agentId: strictAgent.id });
      const first = repos.execution.getNativeContext(session.id)!;
      const originRunId = first.selection.context.originRunId;
      expect(first.selection.runId).toBe(session.runId);

      const restarted = await runtime.restart(session.id);
      const after = repos.execution.getNativeContext(session.id)!;
      // native 资源身份与其 originRunId 锚定旧 run，不随 replaceSessionRun 改。
      expect(after.selection.context).toEqual(first.selection.context);
      expect(after.selection.context.originRunId).toBe(originRunId);
      // selection.runId 推进到新 active run（T2 live 校验据此核对观察 activeRunId）。
      expect(after.selection.runId).toBe(restarted.runId);
      expect(restarted.runId).not.toBe(session.runId);
    } finally {
      await runtime.shutdown(); repos.close();
    }
  });

  it('persists new controlled restore driver observation on the new run while rejecting stale callbacks from the old driver', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const { factory, drivers } = makeFactory();
    (factory as unknown as { __opts: DriverOpts }).__opts = { controlled: true };
    factory.controlledResources = () => true;
    const warnings: Array<Record<string, unknown>> = [];
    const runtime = new DutydeckRuntime(repos, {
      driverFactory: factory, cleanupIntervalMs: 0,
      log: { warn: data => warnings.push(data) }
    });
    try {
      await runtime.initialize([strictAgent]);
      const session = await runtime.start({ agentId: strictAgent.id });
      const oldDriver = drivers[0]!;
      const first = repos.execution.getNativeContext(session.id)!;
      const originRunId = first.selection.context.originRunId;

      const restarted = await runtime.restart(session.id);
      const after = repos.execution.getNativeContext(session.id)!;
      expect(after.selection.runId).toBe(restarted.runId);
      expect(after.selection.context.originRunId).toBe(originRunId);

      // runtime 侧锚点是新 restore operation（新 driverInstanceId）。
      const restoreAnchor = repos.execution.getResources(session.id)
        .find(r => r.kind === 'operation' && r.operationScope?.kind === 'strict-context-restore' && r.stage === 'created')!;
      expect(restoreAnchor).toBeTruthy();
      expect(restoreAnchor.runId).toBe(after.selection.runId);

      const newDriver = drivers.at(-1)!;
      expect(newDriver).not.toBe(oldDriver);

      // 新 driver 发出观察：带当前 selection（originRunId 为旧 run），最终落库。
      newDriver.emitSource(rootObs('new-run-obs', { nativeContextRef: after.selection.context }));
      await waitFor(
        () => repos.insight.listSources(session.id).some(r => r.observationId === 'new-run-obs'),
        'restore observation persisted on new run',
        3000
      );
      const row = repos.insight.listSources(session.id).find(r => r.observationId === 'new-run-obs')!;
      expect(row.activeRunId).toBe(after.selection.runId); // selection.runId 新 run
      expect(row.nativeContextRef?.originRunId).toBe(originRunId); // nativeContextRef.originRunId 旧 run
      expect(row.driverInstanceId).toBe(restoreAnchor.driverInstanceId); // driverInstanceId 真实 strict-context-restore

      // 旧 driver 迟到回调仍被拒（旧代被 fence 丢弃，不落库）。
      oldDriver.emitSource(rootObs('old-stale-obs', { nativeContextRef: after.selection.context }));
      await new Promise(r => setTimeout(r, 150));
      expect(repos.insight.listSources(session.id).some(r => r.observationId === 'old-stale-obs')).toBe(false);
    } finally {
      await runtime.shutdown(); repos.close();
    }
  });
});

describe('runtime transcript source: local-only (PTY) historical run collection', () => {
  // local-only 等价路径无 T2 anchor 缺陷：anchor 直接取最新 created local_only 子行，
  // 用来证明 runtime 的 run fence / flush / 换 driver 语义本身正确：旧 run 观察归旧 run，
  // 新 run 的新 driver 观察在新 activeRun 上落库。
  it('persists the new driver observation on the new active run after replaceSessionRun', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const { factory, drivers } = makeFactory();
    (factory as unknown as { __opts: DriverOpts }).__opts = { controlled: false };
    const runtime = new DutydeckRuntime(repos, {
      ptyDriverFactory: factory,
      probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
      cleanupIntervalMs: 0
    });
    try {
      await runtime.initialize([ptyAgent]);
      const first = await runtime.start({ agentId: ptyAgent.id });
      drivers.at(-1)!.emitSource(rootObs('run1', { nativeSessionId: 'n1' }));
      await waitFor(() => repos.insight.listSources(first.id).some(r => r.observationId === 'run1'), 'run1 persisted');

      const restarted = await runtime.restart(first.id);
      expect(restarted.runId).not.toBe(first.runId);
      const newDriver = drivers.at(-1)!;
      expect(newDriver).not.toBe(drivers[0]);
      newDriver.emitSource(rootObs('run2', { nativeSessionId: 'n1' }));
      await waitFor(() => repos.insight.listSources(restarted.id)
        .some(r => r.observationId === 'run2' && r.activeRunId === restarted.runId), 'run2 persisted on new run');

      const byId = new Map(repos.insight.listSources(restarted.id).map(r => [r.observationId, r]));
      expect(byId.get('run1')!.activeRunId).toBe(first.runId);
      expect(byId.get('run2')!.activeRunId).toBe(restarted.runId);
    } finally {
      await runtime.shutdown(); repos.close();
    }
  });
});

describe('runtime transcript source: unsubscribe, replay, idempotency, proof, instance id', () => {
  it('unsubscribes on stop and replays prior observations on a fresh listener', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const { factory, drivers } = makeFactory();
    (factory as unknown as { __opts: DriverOpts }).__opts = { controlled: true };
    factory.controlledResources = () => true;
    const runtime = new DutydeckRuntime(repos, { driverFactory: factory, cleanupIntervalMs: 0 });
    try {
      await runtime.initialize([strictAgent]);
      const session = await runtime.start({ agentId: strictAgent.id });
      const driver = drivers.at(-1)!;
      expect(driver.listenerCount()).toBe(1); // start 前订阅
      driver.replayOnSubscribe([rootObs('replay-1')]);
      const got: string[] = [];
      const unsub = driver.subscribeTranscriptSource!(o => got.push(o.observationId));
      expect(got).toEqual(['replay-1']);
      unsub();
      await runtime.stop(session.id);
      expect(driver.listenerCount()).toBe(0);
    } finally {
      await runtime.shutdown(); repos.close();
    }
  });

  it('idempotent on observationId+payload, and never upgrades an inferred proof', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const { factory, drivers } = makeFactory();
    (factory as unknown as { __opts: DriverOpts }).__opts = { controlled: true };
    factory.controlledResources = () => true;
    const warnings: Array<Record<string, unknown>> = [];
    const runtime = new DutydeckRuntime(repos, {
      driverFactory: factory, cleanupIntervalMs: 0,
      log: { warn: data => warnings.push(data) }
    });
    try {
      await runtime.initialize([strictAgent]);
      const session = await runtime.start({ agentId: strictAgent.id });
      const driver = drivers.at(-1)!;
      const nativeRef = repos.execution.getNativeContext(session.id)!.selection.context;
      const same = rootObs('same-id', { nativeContextRef: nativeRef });
      driver.emitSource(same); driver.emitSource(same);
      await waitFor(() => repos.insight.listSources(session.id).length >= 1, 'first persisted');
      await new Promise(r => setTimeout(r, 120));
      expect(repos.insight.listSources(session.id)).toHaveLength(1);

      // T2 FINAL live writer 接受 inferred 弱证据（只拒 historical_verified）。
      // runtime 的职责是原样透传 proofKind，绝不把 inferred 擅自升级为 launch_observed。
      driver.emitSource(rootObs('weak', { proofKind: 'inferred' }));
      await waitFor(
        () => repos.insight.listSources(session.id).some(r => r.observationId === 'weak'),
        'inferred observation persisted as-is'
      );
      const weak = repos.insight.listSources(session.id).find(r => r.observationId === 'weak')!;
      expect(weak.proofKind).toBe('inferred'); // 保持弱证据，不被升级
      expect(warnings.some(w => w.observationId === 'weak')).toBe(false);
      // 来源路径失败也不影响任务结算。
      await expect(runtime.send(session.id, 'ok')).resolves.toBeDefined();
    } finally {
      await runtime.shutdown(); repos.close();
    }
  });

  it('rejects historical_verified on the live writer (only appendHistoricalProof may write it) and keeps settlement healthy', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const { factory, drivers } = makeFactory();
    (factory as unknown as { __opts: DriverOpts }).__opts = { controlled: true };
    factory.controlledResources = () => true;
    const warnings: Array<Record<string, unknown>> = [];
    const runtime = new DutydeckRuntime(repos, {
      driverFactory: factory, cleanupIntervalMs: 0,
      log: { warn: data => warnings.push(data) }
    });
    try {
      await runtime.initialize([strictAgent]);
      const session = await runtime.start({ agentId: strictAgent.id });
      drivers.at(-1)!.emitSource(rootObs('hist', { proofKind: 'historical_verified' }));
      await waitFor(() => warnings.some(w => w.observationId === 'hist'), 'historical rejected diagnostic');
      expect(warnings.find(w => w.observationId === 'hist')!.code).toBe('INSIGHT_INVALID_PROOF');
      expect(repos.insight.listSources(session.id).some(r => r.observationId === 'hist')).toBe(false);
      // 诊断不含私有路径。
      expect(warnings.every(w => !JSON.stringify(w).includes('/home/tester'))).toBe(true);
      await expect(runtime.send(session.id, 'ok')).resolves.toBeDefined();
    } finally {
      await runtime.shutdown(); repos.close();
    }
  });

  it('persists the stable instance id once and reuses it across a process restart', async () => {
    const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
    const h1 = makeFactory();
    (h1.factory as unknown as { __opts: DriverOpts }).__opts = { controlled: true };
    h1.factory.controlledResources = () => true;
    const runtime1 = new DutydeckRuntime(repos, { driverFactory: h1.factory, cleanupIntervalMs: 0 });
    await runtime1.initialize([strictAgent]);
    const first = await repos.config.get('insight.instance_id');
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await runtime1.shutdown();

    // 新进程：新 runtimeInstanceId / 新 claim，稳定 id 必须复用。
    const h2 = makeFactory();
    (h2.factory as unknown as { __opts: DriverOpts }).__opts = { controlled: true };
    h2.factory.controlledResources = () => true;
    const runtime2 = new DutydeckRuntime(repos, { driverFactory: h2.factory, cleanupIntervalMs: 0 });
    await runtime2.initialize([strictAgent]);
    expect(await repos.config.get('insight.instance_id')).toBe(first);
    await runtime2.shutdown();
    repos.close();
  });
});
