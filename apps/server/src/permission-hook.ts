import { randomUUID } from 'node:crypto';
import { permissionDisplayText, type DriverPermissionDecision, type PermissionRequestData, type Session } from '@dutydeck/shared';
import { RelayError, RelayHttpClient, relayPermissionHookTimeoutSeconds, type RelayClientOptions } from '@dutydeck/relay';

/**
 * Claude Code 的 PermissionRequest hook ↔ Dutydeck 审批。
 *
 * Claude 要在终端弹工具确认时调用 `dutydeck session permission-hook`，hook 把请求经 relay 交给服务端；
 * 服务端把它登记成与 ACP 相同的待审批项（飞书审批卡、Web 审批卡、本会话允许、超时都沿用同一条路径），
 * hook 轮询到裁决后交回 allow / deny。没有 relay 凭据、或服务端答复 native 时什么都不输出，Claude 保留原生确认。
 * 拿不到裁决（服务不可用、请求失效、超过 24 小时）一律拒绝，绝不静默放行。
 */

export type HookPermissionOutcome =
  | { status: 'pending'; permissionId: string }
  | { status: 'approved' }
  | { status: 'rejected'; reason?: string }
  | { status: 'expired' }
  | { status: 'native' };

/** hook 自己的等待上限：比飞书 24 小时自动拒绝多等 5 分钟，正常情况下先收到服务端的超时拒绝。 */
export const permissionHookDeadlineMs = (relayPermissionHookTimeoutSeconds - 5 * 60) * 1000;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Claude 工具名按 ACP tool kind 归类；approve-reads 只放行 read / search。 */
export function claudeToolKind(toolName: string) {
  if (toolName === 'Bash') return 'execute';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return 'edit';
  if (['Read', 'NotebookRead'].includes(toolName)) return 'read';
  if (['Glob', 'Grep', 'LS'].includes(toolName)) return 'search';
  if (['WebFetch', 'WebSearch'].includes(toolName)) return 'fetch';
  return 'other';
}

/** 在 hook 进程里提取并脱敏审批要展示的事实；进程环境里的凭据值按 ACP 同一口径替换掉。 */
export function claudePermissionFacts(payload: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const secrets = Object.entries(env).filter(([key]) => /token|secret|password|api[_-]?key|authorization|cookie/i.test(key))
    .map(([, value]) => value).filter((value): value is string => Boolean(value));
  const clean = (value: unknown) => permissionDisplayText(value, secrets);
  const toolName = clean(payload.tool_name).slice(0, 200);
  const input = object(payload.tool_input) ? payload.tool_input : {};
  const resource = clean(input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? input.query ?? input.path);
  const command = clean(input.command);
  const cwd = clean(payload.cwd);
  return {
    toolName,
    title: clean(input.description) || toolName,
    ...(cwd ? { cwd } : {}),
    ...(resource ? { resource } : {}),
    ...(command ? { command, commandIsExact: typeof input.command === 'string' && command === input.command.trim() && !/[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(input.command) } : {}),
  };
}

const output = (decision: Record<string, unknown>) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
const deny = (message: string) => output({ behavior: 'deny', message });

export async function runPermissionHook(
  payload: unknown,
  options: RelayClientOptions & { now?: () => number } = {}
): Promise<string> {
  const env = options.env ?? process.env;
  if (!(env.dutydeck_relay_url ?? env.DUTYDECK_RELAY_URL)?.trim()
    || !(env.dutydeck_relay_token ?? env.DUTYDECK_RELAY_TOKEN)?.trim()) return '';
  if (!object(payload) || payload.hook_event_name !== 'PermissionRequest') return '';
  if (typeof payload.tool_name !== 'string' || !payload.tool_name.trim()) return deny('无法识别要确认的工具，这次操作没有执行。');
  const now = options.now ?? Date.now;
  const startedAt = now();
  try {
    const client = new RelayHttpClient(options);
    let result = await client.post('/sessions/self/permission', claudePermissionFacts(payload, env)) as HookPermissionOutcome;
    while (result.status === 'pending') {
      if (now() - startedAt >= permissionHookDeadlineMs) return deny('审批超过 24 小时未处理，已自动拒绝，这次操作没有执行。');
      result = await client.post('/sessions/self/permission', { permissionId: result.permissionId }) as HookPermissionOutcome;
    }
    if (result.status === 'native') return '';
    if (result.status === 'approved') return output({ behavior: 'allow' });
    if (result.status === 'rejected') return deny(result.reason?.trim() || '用户拒绝了这次操作，没有执行。请换一种做法，或说明为什么需要它。');
    return deny('审批请求已失效（任务已结束或服务已重启），这次操作没有执行。需要的话请重新发起。');
  } catch {
    // 不回显传输错误：里面可能有本机地址或凭据。
    return deny('Dutydeck 审批通道暂不可用，没有拿到批准，这次操作没有执行。请告知用户稍后重试。');
  }
}

interface PendingHookPermission {
  sessionId: string;
  decision: Promise<DriverPermissionDecision>;
}

export interface HookPermissionRuntime {
  getSession(id: string): Promise<Session | undefined>;
  autoApproveAgentCommand?(sessionId: string, kind: string, command: string): Promise<boolean>;
  requestDriverPermission(sessionId: string, request: Omit<PermissionRequestData, 'id' | 'status'>): { id: string; decision: Promise<DriverPermissionDecision> } | undefined;
}

const text = (value: unknown, field: string, limit: number) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > limit) throw new RelayError('RELAY_INVALID_PERMISSION', `${field} 必须是不超过 ${limit} 字符的字符串。`, 400);
  return value.trim() || undefined;
};

/**
 * 服务端：登记 hook 交来的权限请求，按短轮询交回裁决。
 * 只接飞书会话里非完全信任的请求；其它会话、没有进行中的轮次时答复 native，由 Claude 在终端确认。
 */
export class HookPermissionRequests {
  private readonly pending = new Map<string, PendingHookPermission>();

  constructor(private readonly runtime: HookPermissionRuntime, private readonly options: { waitMs?: number; retainMs?: number } = {}) {}

  async submit(sessionId: string, body: unknown): Promise<HookPermissionOutcome> {
    if (!object(body)) throw new RelayError('RELAY_INVALID_PERMISSION', '权限请求必须是对象。', 400);
    if (body.permissionId !== undefined) return this.wait(sessionId, text(body.permissionId, 'permissionId', 100) ?? '');
    const toolName = text(body.toolName, 'toolName', 200);
    if (!toolName) throw new RelayError('RELAY_INVALID_PERMISSION', 'toolName 不能为空。', 400);
    const title = text(body.title, 'title', 1300) ?? toolName;
    const cwd = text(body.cwd, 'cwd', 1300);
    const resource = text(body.resource, 'resource', 1300);
    const command = text(body.command, 'command', 1300);
    const exactCommand = typeof body.command === 'string' ? body.command : undefined;
    const session = await this.runtime.getSession(sessionId);
    if (!session || session.source !== 'lark' || session.permissionMode === 'full-trust') return { status: 'native' };
    const kind = claudeToolKind(toolName);
    if (body.commandIsExact === true && exactCommand
      && await this.runtime.autoApproveAgentCommand?.(sessionId, kind, exactCommand)) return { status: 'approved' };
    // 与 ACP 的只读自动放行同一口径：只认读取与搜索，访问网络不算只读。
    if (session.permissionMode === 'approve-reads' && (kind === 'read' || kind === 'search')) return { status: 'approved' };
    const handle = this.runtime.requestDriverPermission(sessionId, {
      title,
      operation: { source: 'claude_permission_hook', kind, ...(cwd ? { cwd } : {}), ...(resource ? { resource } : {}), ...(command ? { command } : {}) },
    });
    if (!handle) return { status: 'native' };
    const id = randomUUID();
    this.pending.set(id, { sessionId, decision: handle.decision });
    // hook 进程可能已被 Claude 取消，没人再来取结果：裁决落定后保留一会儿再清掉。
    void handle.decision.then(() => { setTimeout(() => this.pending.delete(id), this.options.retainMs ?? 120_000).unref?.(); });
    return this.wait(sessionId, id);
  }

  private async wait(sessionId: string, id: string): Promise<HookPermissionOutcome> {
    const entry = this.pending.get(id);
    if (!entry || entry.sessionId !== sessionId) return { status: 'expired' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const decision = await Promise.race([
      entry.decision,
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), this.options.waitMs ?? 25_000); }),
    ]).finally(() => clearTimeout(timer));
    if (!decision) return { status: 'pending', permissionId: id };
    this.pending.delete(id);
    return decision.approved ? { status: 'approved' } : { status: 'rejected', ...(decision.reason ? { reason: decision.reason } : {}) };
  }
}
