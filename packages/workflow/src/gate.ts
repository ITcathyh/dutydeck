/**
 * 人工闸门：节点派发前先卡住等人裁决。
 *
 * 与 botmux 的差异 —— **botmux 的闸门永不超时**（`gate-wait-store.ts` 里明确写了
 * "no deadline"）。那在有飞书卡片催办的场景下说得通，在 dockmux 里不行：一个
 * 无人认领的闸门会让整条 run 无声地挂死，且外部看不出它和「正在跑」的区别。
 * 所以这里加了 `timeoutMs`，超时判 `expired` → 节点 failed，是个显式的、
 * 可观测的终态。
 *
 * 闸门的「阻塞」不是轮询也不是睡眠——就是一个 Promise。谁来 resolve 它是
 * {@link GateResolver} 的事：测试里是手工调用，生产里可以是飞书卡片回调、
 * dashboard 按钮或 CLI 提问。
 */

export interface GateRequest {
  readonly runId: string;
  readonly nodeId: string;
  /** 本次等待的唯一 id，可用作外部系统（卡片/工单）的关联键。 */
  readonly waitId: string;
  readonly prompt: string;
  /** 超时后 engine 会 abort 这个 signal 并判 `expired`。 */
  readonly signal: AbortSignal;
}

export type GateOutcome =
  | { readonly resolution: 'approved'; readonly by: string }
  | { readonly resolution: 'rejected'; readonly by: string };

export interface GateResolver {
  /**
   * 等一个人裁决。**必须响应 `request.signal`**：超时时 engine 会 abort，
   * 此时应当 reject 或永不 settle（engine 自己会判 expired，但挂着的 Promise
   * 会泄漏），推荐直接 reject。
   */
  resolve(request: GateRequest): Promise<GateOutcome>;
}

interface PendingGate {
  readonly request: GateRequest;
  readonly settle: (outcome: GateOutcome) => void;
  readonly fail: (error: Error) => void;
}

/**
 * 手工闸门：把未决闸门挂在内存里，等外部调用 {@link approve} / {@link reject}。
 *
 * 这既是测试替身，也是真实可用的集成点——dashboard 或飞书 handler 拿到这个
 * 实例，在用户点按钮时调 approve 即可。
 */
export class ManualGateResolver implements GateResolver {
  private readonly pending = new Map<string, PendingGate>();

  resolve(request: GateRequest): Promise<GateOutcome> {
    return new Promise<GateOutcome>((settle, reject) => {
      const entry: PendingGate = {
        request,
        settle: (outcome) => {
          this.pending.delete(request.nodeId);
          settle(outcome);
        },
        fail: (error) => {
          this.pending.delete(request.nodeId);
          reject(error);
        },
      };
      this.pending.set(request.nodeId, entry);
      // 超时由 engine 判定；这里只负责把挂着的 Promise 收掉，避免泄漏。
      request.signal.addEventListener(
        'abort',
        () => entry.fail(new Error(`gate for node "${request.nodeId}" aborted`)),
        { once: true },
      );
    });
  }

  /** 当前未决的闸门（按 nodeId）。 */
  list(): GateRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  has(nodeId: string): boolean {
    return this.pending.has(nodeId);
  }

  approve(nodeId: string, by = 'operator'): boolean {
    const entry = this.pending.get(nodeId);
    if (!entry) return false;
    entry.settle({ resolution: 'approved', by });
    return true;
  }

  reject(nodeId: string, by = 'operator'): boolean {
    const entry = this.pending.get(nodeId);
    if (!entry) return false;
    entry.settle({ resolution: 'rejected', by });
    return true;
  }
}

/** 全部自动放行——没有闸门需求时的默认实现。 */
export const autoApproveGate: GateResolver = {
  resolve: async () => ({ resolution: 'approved', by: 'auto' }),
};
