import { canonicalExecutionJson, parseLarkSourceId, RuntimeError, type ExecutionActor, type RepositoryBundle, type Session, type TaskRecord, type TaskRequestV1 } from '@dutydeck/shared';
import { executionTaskId } from '@dutydeck/storage/helpers';
import type { DutydeckRuntime } from '@dutydeck/runtime';

// CI 等待（ci-webhook.ts）与 PR 跟进（pull-requests.ts）共用的小工具。

export const iso = (ms: number) => new Date(ms).toISOString();
export const short = (value: string) => value.slice(0, 12);
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 300);
export const isRunnable = (session: Session | undefined): session is Session => Boolean(session && !session.archivedAt && !['stopped', 'failed'].includes(session.state));
export const codeBlock = (value: string) => `\`\`\`\n${value.replace(/```/g, "'''")}\n\`\`\``;

type ContinuationTask = { id: string; key: string; prompt: string; actorId?: string };
type ContinuationRepositories = Pick<RepositoryBundle, 'tasks'> & { execution: Pick<RepositoryBundle['execution'], 'getAcceptedTask'> };

async function matchesContinuationRequest(request: TaskRequestV1, runtime: Pick<DutydeckRuntime, 'getSession'>, sessionId: string, task: ContinuationTask) {
  if (task.id !== executionTaskId('runtime', sessionId, task.key)) return false;
  let actor: ExecutionActor = { kind: 'unspecified' };
  if (task.actorId === 'installation_owner') actor = { kind: 'installation_owner', id: task.actorId };
  else if (task.actorId) {
    const session = await runtime.getSession(sessionId);
    const appId = session?.source === 'lark' ? parseLarkSourceId(session.sourceId).appId : undefined;
    if (!appId) return false;
    actor = { kind: 'channel', id: task.actorId, appId };
  }
  const expected = { version: 1, namespace: 'runtime', sessionId, key: task.key, actor, prompt: task.prompt, mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: { agentPrompt: task.prompt, skills: [] } };
  return canonicalExecutionJson(request) === canonicalExecutionJson(expected);
}

/** 缺绑定的已接纳任务只按持久化请求认领，不能把碰巧同编号的普通任务改成 CI/PR 任务。 */
export async function assertContinuationTask(repositories: ContinuationRepositories, runtime: Pick<DutydeckRuntime, 'getSession'>, sessionId: string, task: ContinuationTask, code: string) {
  const conflict = () => new RuntimeError(code, 'Continuation task identity does not match its saved source', 409);
  if (task.id !== executionTaskId('runtime', sessionId, task.key)) throw conflict();
  if (!await repositories.tasks.get?.(task.id)) return;
  const request = repositories.execution.getAcceptedTask(task.id)?.request;
  if (!request || !await matchesContinuationRequest(request, runtime, sessionId, task)) throw conflict();
}

/** 旧版本排队恢复可能漏写绑定；执行门禁按完整请求中的精确宿主 key 找来源，不依赖 tick 先跑。 */
export async function unboundContinuationSource(repositories: ContinuationRepositories, runtime: Pick<DutydeckRuntime, 'getSession'>, task: TaskRecord, keyPattern: RegExp): Promise<string | undefined> {
  const request = repositories.execution.getAcceptedTask(task.id)?.request;
  const match = request && keyPattern.exec(request.key);
  if (!request || !match) return undefined;
  const actorId = request.actor.kind === 'unspecified' ? undefined : request.actor.id;
  return await matchesContinuationRequest(request, runtime, task.sessionId, { id: task.id, prompt: task.prompt, key: request.key, actorId }) ? match[1] : undefined;
}

/** 同一时刻只跑一轮：上一轮没结束时返回同一个 Promise，结束后清掉。 */
export class SingleFlight {
  current?: Promise<void>;

  run(task: () => Promise<void>): Promise<void> {
    if (this.current) return this.current;
    const operation = task().finally(() => { if (this.current === operation) this.current = undefined; });
    this.current = operation;
    return operation;
  }
}
