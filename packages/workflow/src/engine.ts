/**
 * 调度引擎：把 {@link decideNext} 的纯决策翻译成 journal 写入 + 执行器调用。
 *
 * 这是本包唯一有副作用的地方。它的职责边界很窄：
 *  - 每 tick 重放 journal → 物化快照 → 求动作 → 执行动作 → 写回事件
 *  - 管并发上限、超时、重试计数
 *  - **不**做任何调度判断（那是 orchestrator 的事）
 *
 * 「重放整个 journal」而不是增量维护状态，是刻意的：它让崩溃恢复与正常推进
 * 走**完全相同**的代码路径。恢复不是一套单独的逻辑，就是「从磁盘上的 journal
 * 再跑一次 tick」。代价是 O(事件数) 每 tick，在 workflow 这个量级下无关紧要。
 */

import { decideNext, resolveEdgeVerdict } from './orchestrator.js';
import { formatAttemptId, materialize, nextAttemptId } from './state.js';
import { nodeById } from './dag.js';
import { autoApproveGate, type GateResolver } from './gate.js';
import type { JournalSink } from './journal.js';
import {
  systemClock,
  type Clock,
  type NodeExecutor,
  type NodeRunRequest,
  type NodeRunResult,
  type NormalizedDag,
  type NormalizedNode,
  type OmittedInput,
  type ResolvedInput,
  type RunSnapshot,
  type WorkflowEvent,
} from './types.js';

export interface EngineOptions {
  readonly dag: NormalizedDag;
  readonly journal: JournalSink;
  readonly executor: NodeExecutor;
  readonly gate?: GateResolver;
  readonly clock?: Clock;
  /** 同时在飞的节点上限。默认无限——由 DAG 的形状决定并发度。 */
  readonly maxConcurrency?: number;
  /** 每个节点的默认超时；节点自己的 `timeoutMs` 优先。 */
  readonly defaultTimeoutMs?: number;
}

export interface RunOutcome {
  readonly runStatus: RunSnapshot['runStatus'];
  readonly snapshot: RunSnapshot;
}

/** 一个 in-flight 的节点尝试。 */
interface InFlight {
  readonly nodeId: string;
  readonly attemptId: string;
  readonly promise: Promise<void>;
  readonly abort: AbortController;
}

export class WorkflowEngine {
  private readonly dag: NormalizedDag;
  private readonly journal: JournalSink;
  private readonly executor: NodeExecutor;
  private readonly gate: GateResolver;
  private readonly clock: Clock;
  private readonly maxConcurrency: number;
  private readonly defaultTimeoutMs: number | undefined;
  private readonly inFlight = new Map<string, InFlight>();
  /** 每个 tick 之间用它唤醒——有节点 settle 就立刻再算一轮。 */
  private wake: (() => void) | undefined;

  constructor(options: EngineOptions) {
    this.dag = options.dag;
    this.journal = options.journal;
    this.executor = options.executor;
    this.gate = options.gate ?? autoApproveGate;
    this.clock = options.clock ?? systemClock;
    this.maxConcurrency = options.maxConcurrency ?? Number.POSITIVE_INFINITY;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
  }

  snapshot(): RunSnapshot {
    return materialize(this.dag.runId, this.journal.read());
  }

  /**
   * 驱动这次 run 直到终态（succeeded / failed / blocked）。
   *
   * 幂等可续跑：对着一份已有 journal 再调一次，会从中断处继续，而不是重头来。
   */
  async run(): Promise<RunOutcome> {
    const events = this.journal.read();
    if (!events.some((e) => e.type === 'runStarted')) {
      this.append({ type: 'runStarted', runId: this.dag.runId });
    }

    for (;;) {
      const snapshot = this.snapshot();
      if (snapshot.runStatus !== 'running') {
        await this.drain();
        return { runStatus: snapshot.runStatus, snapshot };
      }

      const actions = decideNext(this.dag, snapshot);
      let dispatched = 0;

      for (const action of actions) {
        switch (action.kind) {
          case 'resolveEdge': {
            const active = resolveEdgeVerdict(this.dag, snapshot, action.from, action.to);
            this.append({ type: 'edgeResolved', from: action.from, to: action.to, active });
            dispatched++;
            break;
          }
          case 'skipNode':
            this.append({
              type: 'nodeSkipped',
              nodeId: action.nodeId,
              ...(action.detail !== undefined ? { detail: action.detail } : {}),
            });
            dispatched++;
            break;
          case 'dispatchGate':
            if (this.inFlight.has(action.nodeId)) break;
            this.startGate(action.nodeId);
            dispatched++;
            break;
          case 'dispatchWork':
            if (this.inFlight.has(action.nodeId)) break;
            if (this.inFlight.size >= this.maxConcurrency) break;
            this.startWork(action.nodeId);
            dispatched++;
            break;
          case 'completeRunSucceeded':
            this.append({ type: 'runSucceeded' });
            dispatched++;
            break;
          case 'completeRunFailed':
            this.append({
              type: 'runFailed',
              ...(action.failedNodeId !== undefined ? { failedNodeId: action.failedNodeId } : {}),
              ...(action.detail !== undefined ? { detail: action.detail } : {}),
            });
            dispatched++;
            break;
          case 'completeRunBlocked':
            this.append({ type: 'runBlocked', blockedNodeId: action.blockedNodeId });
            dispatched++;
            break;
        }
      }

      // 一轮什么都没做且有节点在飞 → 等任意一个 settle 再算。
      // 什么都没做也没有在飞的 → 说明决策层给不出动作，避免空转死循环。
      if (dispatched === 0) {
        if (this.inFlight.size === 0) {
          const stuck = this.snapshot();
          return { runStatus: stuck.runStatus, snapshot: stuck };
        }
        await this.waitForSettle();
      }
    }
  }

  /** 请求重试一个 blocked 节点。返回 false 表示该节点当前不可重试。 */
  requestRetry(nodeId: string): boolean {
    const events = this.journal.read();
    const snapshot = materialize(this.dag.runId, events);
    const state = snapshot.nodes.get(nodeId);
    if (!state || state.status !== 'blocked') return false;
    const node = nodeById(this.dag, nodeId);
    if (!node) return false;
    // 尝试次数用尽就不再放行——否则 maxAttempts 形同虚设。
    if (state.attempts >= node.maxAttempts) return false;
    this.append({
      type: 'nodeRetryRequested',
      nodeId,
      previousAttemptId: formatAttemptId(nodeId, state.attempts),
      nextAttemptId: formatAttemptId(nodeId, state.attempts + 1),
    });
    return true;
  }

  private append(event: WorkflowEvent): void {
    this.journal.append(event);
  }

  private notify(): void {
    this.wake?.();
  }

  private waitForSettle(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = () => {
        this.wake = undefined;
        resolve();
      };
    });
  }

  /** 等所有 in-flight 结束——run 已达终态时用，避免留下游离的定时器/Promise。 */
  private async drain(): Promise<void> {
    for (const entry of [...this.inFlight.values()]) entry.abort.abort();
    await Promise.allSettled([...this.inFlight.values()].map((e) => e.promise));
    this.inFlight.clear();
  }

  private startGate(nodeId: string): void {
    const node = nodeById(this.dag, nodeId);
    if (!node?.humanGate) return;
    const waitId = `${nodeId}#gate-${this.clock.now()}`;
    const abort = new AbortController();
    this.append({
      type: 'gateDispatched',
      nodeId,
      waitId,
      prompt: node.humanGate.prompt,
      ...(node.humanGate.timeoutMs !== undefined ? { timeoutMs: node.humanGate.timeoutMs } : {}),
    });

    const gateConfig = node.humanGate;
    // 超时定时器必须在 settle 时清掉，否则 Node 进程不会退出。
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (gateConfig.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, gateConfig.timeoutMs);
    }

    const promise = (async () => {
      try {
        const outcome = await this.gate.resolve({
          runId: this.dag.runId,
          nodeId,
          waitId,
          prompt: gateConfig.prompt,
          signal: abort.signal,
        });
        this.append({
          type: 'gateResolved',
          nodeId,
          waitId,
          resolution: outcome.resolution,
          by: outcome.by,
        });
      } catch (err) {
        // 超时和 resolver 自身出错要区分：前者是产品语义（expired），
        // 后者是基础设施故障，都终结节点但归因不同。
        this.append({
          type: 'gateResolved',
          nodeId,
          waitId,
          resolution: timedOut ? 'expired' : 'rejected',
          by: timedOut ? 'timeout' : `error:${err instanceof Error ? err.message : String(err)}`,
        });
      } finally {
        if (timer) clearTimeout(timer);
        this.inFlight.delete(nodeId);
        this.notify();
      }
    })();

    this.inFlight.set(nodeId, { nodeId, attemptId: waitId, abort, promise });
  }

  private startWork(nodeId: string): void {
    const node = nodeById(this.dag, nodeId);
    if (!node) return;
    const events = this.journal.read();
    const snapshot = materialize(this.dag.runId, events);
    const attemptId = nextAttemptId(events, nodeId);
    const abort = new AbortController();
    const timeoutMs = node.timeoutMs ?? this.defaultTimeoutMs;

    this.append({ type: 'nodeDispatched', nodeId, attemptId });

    const request: NodeRunRequest = {
      runId: this.dag.runId,
      nodeId,
      attemptId,
      goal: node.goal,
      ...(node.agent !== undefined ? { agent: node.agent } : {}),
      inputs: collectInputs(node, snapshot),
      omitted: collectOmitted(node, snapshot),
      signal: abort.signal,
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, timeoutMs);
    }

    const promise = (async () => {
      try {
        const result = await this.executor.run(request);
        if (timedOut) this.settleTimeout(nodeId, attemptId);
        else this.settleResult(node, attemptId, result);
      } catch (err) {
        if (timedOut) this.settleTimeout(nodeId, attemptId);
        else {
          // 执行器抛异常 = 基础设施失败，不是语义失败，所以是 failed 不是 blocked。
          this.append({
            type: 'nodeFailed',
            nodeId,
            attemptId,
            errorClass: 'executorError',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (timer) clearTimeout(timer);
        this.inFlight.delete(nodeId);
        this.notify();
      }
    })();

    this.inFlight.set(nodeId, { nodeId, attemptId, abort, promise });
  }

  private settleTimeout(nodeId: string, attemptId: string): void {
    this.append({
      type: 'nodeFailed',
      nodeId,
      attemptId,
      errorClass: 'timeout',
      message: 'node execution timed out',
    });
  }

  private settleResult(node: NormalizedNode, attemptId: string, result: NodeRunResult): void {
    if (result.status === 'succeeded') {
      this.append({
        type: 'nodeSucceeded',
        nodeId: node.id,
        attemptId,
        ...(result.outputs ? { outputs: result.outputs } : {}),
      });
      return;
    }
    if (result.status === 'failed') {
      this.append({
        type: 'nodeFailed',
        nodeId: node.id,
        attemptId,
        errorClass: 'executorError',
        ...(result.message !== undefined ? { message: result.message } : {}),
      });
      return;
    }

    // blocked：语义失败。还有尝试次数就**自动**续一次，用尽了才把 run 停在 blocked
    // 等人干预。botmux 这里完全靠人点重试卡片；dockmux 没有那套卡片，
    // 所以把「预算内自动重试」内建进来，超预算才需要人。
    const attemptNumber = attemptNumberOf(attemptId);
    if (attemptNumber < node.maxAttempts) {
      this.append({
        type: 'nodeBlocked',
        nodeId: node.id,
        attemptId,
        errorClass: 'resultInvalid',
        ...(result.message !== undefined ? { message: result.message } : {}),
      });
      this.append({
        type: 'nodeRetryRequested',
        nodeId: node.id,
        previousAttemptId: attemptId,
        nextAttemptId: formatAttemptId(node.id, attemptNumber + 1),
      });
      return;
    }
    this.append({
      type: 'nodeBlocked',
      nodeId: node.id,
      attemptId,
      errorClass: 'resultInvalid',
      ...(result.message !== undefined ? { message: result.message } : {}),
    });
  }
}

function attemptNumberOf(attemptId: string): number {
  const parsed = Number.parseInt(attemptId.slice(attemptId.lastIndexOf('/') + 1), 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

/** 收集上游注入的数据。只取边激活且上游 done 的那些。 */
function collectInputs(node: NormalizedNode, snapshot: RunSnapshot): ResolvedInput[] {
  const out: ResolvedInput[] = [];
  for (const input of node.inputs) {
    const source = snapshot.nodes.get(input.from);
    if (source?.status !== 'done') continue;
    const dep = node.depends.find((d) => d.from === input.from);
    if (dep?.when && snapshot.edges.get(`${input.from}->${node.id}`)?.active === false) continue;
    const value = input.select === undefined ? source.outputs : source.outputs?.[input.select];
    out.push({ from: input.from, value });
  }
  return out;
}

/**
 * 明确告知执行器「这些上游本该给输入但没给」。
 *
 * 不这么做的话，agent 面对的只是一个静默变短的 inputs 数组，它无从判断是
 * 「上游没跑」还是「自己没找到」，很容易开始幻觉补全缺失的内容。
 */
function collectOmitted(node: NormalizedNode, snapshot: RunSnapshot): OmittedInput[] {
  const out: OmittedInput[] = [];
  for (const input of node.inputs) {
    const source = snapshot.nodes.get(input.from);
    if (source?.status === 'skipped') {
      out.push({ from: input.from, reason: 'sourceSkipped' });
      continue;
    }
    const dep = node.depends.find((d) => d.from === input.from);
    if (dep?.when && snapshot.edges.get(`${input.from}->${node.id}`)?.active === false) {
      out.push({ from: input.from, reason: 'edgeInactive' });
    }
  }
  return out;
}
