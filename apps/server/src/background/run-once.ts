import { isTerminalTaskStatus, RuntimeError, type AgentEvent, type PermissionMode, type Session } from '@dutydeck/shared';
import { sleep } from '../daemon/time.js';
import { readAttemptResult, type AttemptResultRepositories } from '../task-results.js';

export interface BackgroundRuntime {
  start(input: { agentId: string; cwd?: string; model?: string; permissionMode?: PermissionMode; source?: string; sourceId?: string }): Promise<Session>;
  dispatch(id: string, prompt: string, mode: 'queue' | 'interrupt', agentPrompt: string): Promise<{ id: string; status: string }>;
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
  stop?(id: string): Promise<unknown>;
}

/** The deadline includes startup, dispatch, result lookup and cleanup. Late startup never dispatches. */
export async function runReadonlyPrompt(runtime: BackgroundRuntime, repos: AttemptResultRepositories, input: {
  agentId: string; cwd: string; model?: string; permissionMode?: PermissionMode; source: string; sourceId: string; prompt: string; timeoutMs: number;
  signal?: AbortSignal;
  /** Schedulers keep the slot until pending startup/dispatch and resource cleanup really finish. */
  onCleanup?: (cleanup: Promise<void>) => void;
}): Promise<string> {
  const controller = new AbortController();
  const { signal } = controller;
  const abort = () => controller.abort(input.signal?.reason ?? new RuntimeError('COLLABORATION_DECISION_CANCELLED', 'Decision cancelled', 409));
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new RuntimeError('COLLABORATION_DECISION_TIMEOUT', 'Decision ended with timeout', 504)), input.timeoutMs);
  let session: Awaited<ReturnType<BackgroundRuntime['start']>> | undefined;
  let stopping: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  let receiving = true;
  const buffered: AgentEvent[] = [];
  const stopReceiving = () => {
    receiving = false;
    buffered.length = 0;
    const remove = unsubscribe;
    unsubscribe = undefined;
    remove?.();
  };
  const stop = () => {
    if (!session) return Promise.resolve();
    return stopping ??= Promise.resolve().then(async () => {
      await runtime.stop?.(session!.id);
    });
  };
  const cancelled = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => { stopReceiving(); void stop().catch(() => {}); reject(signal.reason); };
    signal.addEventListener('abort', rejectAbort, { once: true });
    if (signal.aborted) rejectAbort();
  });
  const operation = (async () => {
    try {
      signal.throwIfAborted();
      session = await runtime.start({ agentId: input.agentId, cwd: input.cwd, model: input.model, permissionMode: input.permissionMode ?? 'deny-all', source: input.source, sourceId: input.sourceId });
      signal.throwIfAborted();
      let taskId: string | undefined;
      let settle!: (status: string) => void;
      const terminal = new Promise<string>(resolve => { settle = resolve; });
      const receive = (event: AgentEvent) => {
        if (!receiving || signal.aborted || event.type !== 'task') return;
        const task = (event.data as { task?: { id?: string; status?: string } })?.task;
        if (task && task.id === taskId && isTerminalTaskStatus(task.status)) settle(task.status!);
      };
      unsubscribe = runtime.subscribe(session.id, event => {
        if (!receiving || signal.aborted) return;
        if (taskId) receive(event); else buffered.push(event);
      });
      signal.throwIfAborted();
      taskId = (await runtime.dispatch(session.id, input.prompt, 'queue', input.prompt)).id;
      signal.throwIfAborted();
      buffered.forEach(receive);
      buffered.length = 0;
      const status = await Promise.race([terminal, cancelled]);
      if (status !== 'completed') throw new RuntimeError('COLLABORATION_DECISION_FAILED', `Decision ended with ${status}`, 409);
      for (let index = 0; index < 3; index++) {
        if (index) await sleep(100);
        signal.throwIfAborted();
        const attempt = repos.execution.getTaskExecution(taskId)?.attempts.find(item => item.number === 1);
        if (!attempt) continue;
        const result = readAttemptResult(repos, session.id, taskId, attempt.attemptId);
        if (result.status === 'settled' && result.result.outcome === 'completed') return result.result.output.text;
      }
      throw new RuntimeError('COLLABORATION_RESULT_UNAVAILABLE', 'Decision has no settled Attempt result', 409);
    } finally { stopReceiving(); await stop(); }
  })();
  // A task failure still cleans up successfully; only a failed stop retains the resource slot.
  const cleanup = operation.then(() => {}, async () => { await stopping; });
  void cleanup.catch(() => {});
  input.onCleanup?.(cleanup);
  try { return await Promise.race([operation, cancelled]); }
  finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); }
}
