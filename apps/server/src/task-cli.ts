import { z } from 'zod';
import { executeLocalRuntimeRequest, type LocalRuntimeRequestDependencies } from './local-runtime-request.js';

export interface TaskCliInput {
  action: 'list' | 'read' | 'send' | 'interrupt' | 'decide' | 'archive';
  id?: string; limit?: string; recent?: boolean; text?: string; stdin?: boolean; mode?: string;
  waiting?: string; option?: string; client?: string; url?: string; database?: string; json?: boolean;
}
export class TaskCliError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
  get exitCode() { return taskExitCode(this.code); }
}
export function taskExitCode(code: string): number {
  return code === 'invalid_argument' ? 2 : code === 'unavailable' ? 3 : ['not_found', 'already_resolved'].includes(code) ? 4 : code === 'unknown_outcome' ? 5 : 1;
}
export function taskError(code: string, message: string): TaskCliError {
  const normalized = code.toLowerCase();
  const mapped = ['invalid_argument', 'unavailable', 'not_found', 'already_resolved', 'conflict', 'unknown_outcome', 'forbidden'].includes(normalized) ? normalized
    : /permission_(not_found|resolving)|relay_ask_settled/.test(normalized) ? 'already_resolved'
    : /accepted_audit_failed|permission_expired/.test(normalized) ? 'unknown_outcome'
    : /not_found/.test(normalized) ? 'not_found'
    : /forbidden|denied|unauthorized|managed_session/.test(normalized) ? 'forbidden'
    : /invalid|required|unsupported|steer_unavailable/.test(normalized) ? 'invalid_argument'
    : /unavailable|shutting_down/.test(normalized) ? 'unavailable' : 'conflict';
  return new TaskCliError(mapped, message);
}
export async function runTaskCli(input: TaskCliInput, dependencies: LocalRuntimeRequestDependencies & { readStdin?: () => Promise<string> } = {}): Promise<unknown> {
  if (input.url) {
    try { new URL(input.url); } catch { throw new TaskCliError('invalid_argument', 'url must be an absolute local HTTP URL'); }
  }
  if (input.client !== undefined && !/^[a-z0-9-]{1,32}$/.test(input.client)) throw new TaskCliError('invalid_argument', 'client must match [a-z0-9-]{1,32}');
  const limit = input.limit === undefined ? input.action === 'list' ? 50 : 40 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TaskCliError('invalid_argument', 'limit must be an integer from 1 to 200');
  if (input.action !== 'list' && !input.id?.trim()) throw new TaskCliError('invalid_argument', 'Task ID is required');
  const request = async (method: string, endpoint: string, body?: unknown) => {
    let dispatched = false;
    let status: number | undefined;
    try {
      const result = await executeLocalRuntimeRequest({ url: input.url, database: input.database, method, endpoint, body,
        errorSpec: { databaseRequired: 'invalid_argument', daemonUnavailable: 'unavailable', localRuntimeRequired: 'invalid_argument', requestFailed: method === 'GET' ? 'unavailable' : 'unknown_outcome', requestFailedMessage: (status, message) => message ?? `Request failed with HTTP ${status}` },
        createError: (code, message) => {
          const error = taskError(code, message);
          if (status === 401 || status === 403) return new TaskCliError('forbidden', message);
          if ((status === 400 || status === 422) && error.code === 'conflict') return new TaskCliError('invalid_argument', message);
          if (method !== 'GET' && status && status >= 500) return new TaskCliError('unknown_outcome', message);
          return error;
        }
      }, { ...dependencies, fetcher: async (...args) => { dispatched = true; const response = await (dependencies.fetcher ?? fetch)(...args); status = response.status; return response; } });
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TaskCliError(method === 'GET' ? 'unavailable' : 'unknown_outcome', 'The runtime returned an invalid response');
      return result;
    } catch (error) {
      if (error instanceof TaskCliError) throw error;
      const cause = error as { code?: string; cause?: { code?: string } };
      const notConnected = status === undefined && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause?.cause?.code ?? cause?.code ?? '');
      throw new TaskCliError(method === 'GET' || !dispatched || notConnected ? 'unavailable' : 'unknown_outcome', error instanceof Error ? error.message : String(error));
    }
  };
  const base = `/api/sessions/${encodeURIComponent(input.id ?? '')}`;
  if (input.action === 'list') {
    const data = await request('GET', `/api/tasks?${input.recent ? 'recent=true&' : ''}limit=${limit}`) as { tasks?: unknown; archivable?: unknown };
    if (!Array.isArray(data.tasks)) throw new TaskCliError('unavailable', 'The runtime returned an invalid task list');
    if (input.recent && (!Array.isArray(data.archivable) || data.archivable.some(id => typeof id !== 'string' || !(data.tasks as Array<{ id?: unknown }>).some(task => task?.id === id)))) throw new TaskCliError('unavailable', 'The runtime returned invalid archive capabilities');
    return data;
  }
  if (input.action === 'read') {
    const data = await request('GET', `/api/tasks/${encodeURIComponent(input.id!)}?limit=${limit}`) as { items?: unknown; truncated?: unknown };
    if (!Array.isArray(data.items) || typeof data.truncated !== 'boolean') throw new TaskCliError('unavailable', 'The runtime returned an invalid conversation');
    return data;
  }
  if (input.action === 'send') {
    if (input.stdin === true && input.text !== undefined || !input.stdin && input.text === undefined) throw new TaskCliError('invalid_argument', 'Use exactly one of --text or --stdin');
    const text = input.stdin ? await (dependencies.readStdin ?? (async () => { let text = ''; for await (const chunk of process.stdin) text += chunk; return text; }))() : input.text;
    if (!text?.trim() || !['queue', 'steer'].includes(input.mode ?? 'queue')) throw new TaskCliError('invalid_argument', 'A non-empty text and queue or steer mode are required');
    const result = await request('POST', `${base}/send`, { prompt: text, mode: input.mode ?? 'queue', client: input.client, strictSteer: true }) as { accepted?: boolean };
    if (result.accepted !== true) throw new TaskCliError('unknown_outcome', 'The runtime did not confirm acceptance');
    return { task_id: input.id, accepted: true };
  }
  if (input.action === 'interrupt') {
    const result = await request('POST', `${base}/interrupt`, { client: input.client }) as { state?: string; interrupted?: boolean };
    if (typeof result.interrupted !== 'boolean' && !['interrupting', 'interrupted', 'idle', 'stopped'].includes(result.state ?? '')) throw new TaskCliError('unknown_outcome', 'The runtime did not confirm interruption');
    return { state: result?.state === 'interrupting' ? 'interrupting' : ['interrupted', 'stopped'].includes(result?.state ?? '') ? 'interrupted' : result.interrupted === true ? 'interrupting' : 'idle' };
  }
  if (input.action === 'archive') {
    const result = await request('POST', `${base}/archive`, { client: input.client }) as { id?: unknown; archivedAt?: unknown };
    if (result.id !== input.id || typeof result.archivedAt !== 'string' || !z.string().datetime({ offset: true }).safeParse(result.archivedAt).success || !Number.isFinite(Date.parse(result.archivedAt))) throw new TaskCliError('unknown_outcome', 'The runtime did not confirm archival');
    return { archived: true };
  }
  if (!input.waiting || !input.option) throw new TaskCliError('invalid_argument', '--waiting and --option are required');
  const waiting = await request('GET', `${base}/waiting/${encodeURIComponent(input.waiting)}`) as { kind: string; options: Array<{ id: string }>; free_text: boolean };
  if (waiting.kind === 'approval') {
    if (!['allow', 'deny'].includes(input.option) || input.option === 'allow' && input.text !== undefined) throw new TaskCliError('invalid_argument', 'Use allow or deny; text is only accepted with deny');
    const result = await request('POST', `${base}/permissions/${encodeURIComponent(input.waiting)}`, { approved: input.option === 'allow', reason: input.text, client: input.client }) as { id?: string; status?: string };
    if (result.id !== input.waiting || result.status !== (input.option === 'allow' ? 'approved' : 'rejected')) throw new TaskCliError('unknown_outcome', 'The runtime did not confirm the permission decision');
  } else {
    if (!waiting.options.some(option => option.id === input.option) && !(waiting.free_text && input.option === 'answer')) throw new TaskCliError('invalid_argument', 'Unknown answer option');
    const answer = input.text ?? (input.option === 'answer' ? '' : input.option);
    if (!answer.trim()) throw new TaskCliError('invalid_argument', 'Answer text is required');
    const result = await request('POST', `/api/relay/sessions/${encodeURIComponent(input.id!)}/asks/${encodeURIComponent(input.waiting)}/answer`, { answer, client: input.client }) as { ok?: boolean; ask?: { id?: string; status?: string } };
    if (result.ok !== true || result.ask?.id !== input.waiting || result.ask.status !== 'answered') throw new TaskCliError('unknown_outcome', 'The runtime did not confirm the answer');
  }
  return { resolved: true };
}
