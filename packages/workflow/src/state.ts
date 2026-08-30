/**
 * 把 journal 折叠成运行快照。
 *
 * 移植自 botmux `src/workflows/v3/state.ts`。核心性质：**纯函数**——同样的事件
 * 序列永远得到同样的快照。这正是「快照可以随时丢掉重算」的前提，也让崩溃恢复
 * 变成一次普通的重放，而不是一套单独的恢复逻辑。
 *
 * 状态转移表：
 *   nodeDispatched     → running（attempts+1，保留 gateCleared）
 *   nodeSucceeded      → done（记下 outputs 供下游取用）
 *   nodeFailed         → failed
 *   nodeBlocked        → blocked
 *   nodeRetryRequested → pending（run 从 blocked 回到 running）
 *   nodeSkipped        → skipped
 *   gateDispatched     → gateWaiting（登记未决闸门）
 *   gateResolved/ok    → pending + gateCleared（下一 tick 派发工作）
 *   gateResolved/否    → failed（拒绝与超时都是终态，不重试）
 *   edgeResolved       → edges（首次裁决即固化）
 */

import type {
  EdgeState,
  GateState,
  NodeState,
  RunSnapshot,
  RunStatus,
  StoredEvent,
} from './types.js';
import { edgeKey } from './orchestrator.js';

/**
 * 重放事件得到快照。
 *
 * 未出现在 `nodes` 里的节点视为 `pending`——空 journal 折叠出的空快照，
 * 与「所有节点都 pending」是同一个东西。
 */
export function materialize(runId: string, events: readonly StoredEvent[]): RunSnapshot {
  const nodes = new Map<string, NodeState>();
  const edges = new Map<string, EdgeState>();
  const openGates = new Map<string, GateState>();
  let runStatus: RunStatus = 'running';
  let failedNodeId: string | undefined;
  let blockedNodeId: string | undefined;

  const current = (id: string): NodeState => nodes.get(id) ?? { status: 'pending', attempts: 0 };

  for (const event of events) {
    switch (event.type) {
      case 'runStarted':
        break;

      case 'nodeDispatched': {
        const prev = current(event.nodeId);
        nodes.set(event.nodeId, {
          status: 'running',
          attempts: prev.attempts + 1,
          // 闸门放行的事实要跨越派发保留下来，否则节点跑完一轮重试时会被
          // 再次拦在闸门前，等一个已经放过行的人。
          ...(prev.gateCleared ? { gateCleared: true } : {}),
        });
        break;
      }

      case 'nodeSucceeded': {
        const prev = current(event.nodeId);
        nodes.set(event.nodeId, {
          status: 'done',
          attempts: prev.attempts,
          ...(prev.gateCleared ? { gateCleared: true } : {}),
          ...(event.outputs ? { outputs: event.outputs } : {}),
        });
        break;
      }

      case 'nodeFailed': {
        const prev = current(event.nodeId);
        nodes.set(event.nodeId, {
          status: 'failed',
          attempts: prev.attempts,
          ...(prev.gateCleared ? { gateCleared: true } : {}),
          errorClass: event.errorClass,
          ...(event.message !== undefined ? { message: event.message } : {}),
        });
        break;
      }

      case 'nodeBlocked': {
        const prev = current(event.nodeId);
        nodes.set(event.nodeId, {
          status: 'blocked',
          attempts: prev.attempts,
          ...(prev.gateCleared ? { gateCleared: true } : {}),
          errorClass: event.errorClass,
          ...(event.message !== undefined ? { message: event.message } : {}),
        });
        break;
      }

      case 'nodeRetryRequested': {
        const prev = current(event.nodeId);
        nodes.set(event.nodeId, {
          status: 'pending',
          attempts: prev.attempts,
          ...(prev.gateCleared ? { gateCleared: true } : {}),
        });
        // 重试把 run 从 blocked 拉回 running——否则重放后 run 仍是终态，
        // 调度器不会再看它一眼。
        if (runStatus === 'blocked') {
          runStatus = 'running';
          blockedNodeId = undefined;
        }
        break;
      }

      case 'nodeSkipped': {
        const prev = current(event.nodeId);
        nodes.set(event.nodeId, { status: 'skipped', attempts: prev.attempts });
        break;
      }

      case 'gateDispatched': {
        const prev = current(event.nodeId);
        nodes.set(event.nodeId, { status: 'gateWaiting', attempts: prev.attempts });
        openGates.set(event.nodeId, {
          nodeId: event.nodeId,
          waitId: event.waitId,
          prompt: event.prompt,
          openedAt: event.ts,
          ...(event.timeoutMs !== undefined ? { timeoutMs: event.timeoutMs } : {}),
        });
        break;
      }

      case 'gateResolved': {
        const prev = current(event.nodeId);
        openGates.delete(event.nodeId);
        if (event.resolution === 'approved') {
          nodes.set(event.nodeId, { status: 'pending', attempts: prev.attempts, gateCleared: true });
        } else {
          nodes.set(event.nodeId, {
            status: 'failed',
            attempts: prev.attempts,
            errorClass: event.resolution === 'expired' ? 'gateExpired' : 'gateRejected',
            message: event.resolution === 'expired'
              ? 'human gate timed out'
              : `human gate rejected by ${event.by}`,
          });
        }
        break;
      }

      case 'edgeResolved': {
        const key = edgeKey(event.from, event.to);
        // 首次裁决即固化：一条边只能被判一次，重复事件是审计信息不是新结论。
        if (!edges.has(key)) edges.set(key, { active: event.active });
        break;
      }

      case 'runSucceeded':
        runStatus = 'succeeded';
        break;

      case 'runFailed':
        runStatus = 'failed';
        failedNodeId = event.failedNodeId;
        break;

      case 'runBlocked':
        runStatus = 'blocked';
        blockedNodeId = event.blockedNodeId;
        break;
    }
  }

  return {
    runId,
    runStatus,
    nodes,
    edges,
    openGates,
    ...(failedNodeId !== undefined ? { failedNodeId } : {}),
    ...(blockedNodeId !== undefined ? { blockedNodeId } : {}),
  };
}

/**
 * 下一个 attemptId。格式 `<nodeId>/attempts/003`，全局唯一，可直接当幂等键。
 *
 * 从 journal 折出来而不是单独存计数器：计数器会和事件流漂移，重放时对不上。
 */
export function nextAttemptId(events: readonly StoredEvent[], nodeId: string): string {
  let max = 0;
  for (const event of events) {
    if (event.type === 'nodeDispatched' && event.nodeId === nodeId) {
      const n = attemptNumberOf(event.attemptId);
      if (n > max) max = n;
    }
  }
  return formatAttemptId(nodeId, max + 1);
}

export function formatAttemptId(nodeId: string, attempt: number): string {
  return `${nodeId}/attempts/${String(attempt).padStart(3, '0')}`;
}

function attemptNumberOf(attemptId: string): number {
  const parsed = Number.parseInt(attemptId.slice(attemptId.lastIndexOf('/') + 1), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
