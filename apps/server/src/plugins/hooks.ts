import { spawn } from 'node:child_process';
import {
  pluginHookOutputSchema,
  type PluginHookEvent,
  type PluginHookHandler,
  type PluginHookInput,
  type PluginHookOutput,
  type PluginHookSpec
} from '@dutydeck/shared';
import { scopeApplies, type PluginScopeContext } from './scope.js';
import { childEnvironment } from '@dutydeck/shared/child-environment';

/** stdout 超过此长度截断；截断后的 JSON 必然解析失败，按「没有输出」处理。 */
export const HOOK_STDOUT_LIMIT = 64 * 1024;
const HOOK_STDERR_LIMIT = 8 * 1024;
const IN_PROCESS_DEFAULT_TIMEOUT_MS = 10_000;

export interface CommandHookResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  error?: string;
}

/** 起一个 hook 子进程：stdin 写入 JSON，限时、限输出。超时杀掉整个进程组，并且不再等管道关闭（脱离进程组的后代可能一直占着）。 */
export function runCommandHook(command: string | string[], input: unknown, options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }): Promise<CommandHookResult> {
  return new Promise(resolvePromise => {
    const [file, args] = typeof command === 'string' ? ['/bin/sh', ['-c', command]] : [command[0]!, command.slice(1)];
    let stdout = '', stderr = '', stdoutTruncated = false, timedOut = false, settled = false;
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const finish = (result: Omit<CommandHookResult, 'stdout' | 'stderr' | 'timedOut' | 'stdoutTruncated'>) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolvePromise({ ...result, stdout, stderr, timedOut, stdoutTruncated });
    };
    const kill = () => {
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => {
      timedOut = true; kill();
      child.stdout.destroy(); child.stderr.destroy();
      finish({ exitCode: child.exitCode });
    }, options.timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > HOOK_STDOUT_LIMIT) { stdout += chunk.slice(0, Math.max(0, HOOK_STDOUT_LIMIT - stdout.length)); stdoutTruncated = true; }
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < HOOK_STDERR_LIMIT) stderr = (stderr + chunk).slice(0, HOOK_STDERR_LIMIT); });
    child.on('error', error => finish({ exitCode: null, error: error.message }));
    child.on('close', code => finish({ exitCode: code }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

export type HookRegistration = {
  plugin: string;
  scope: string;
  event: PluginHookEvent;
  matcher?: RegExp;
} & (
  | { kind: 'command'; spec: PluginHookSpec; cwd: string; env: Record<string, string> }
  | { kind: 'handler'; handler: PluginHookHandler; timeout: number }
);

export interface HookOutcome {
  plugin: string;
  kind: 'command' | 'handler';
  /** allow：放行；deny：阻断；error：非阻断错误（onFailure=ignore）。 */
  result: 'allow' | 'deny' | 'error';
  exitCode?: number | null;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  message?: string;
}

export interface HookRunResult {
  decision?: 'allow' | 'deny' | 'ask';
  reason?: string;
  additionalContext: string[];
  updatedPrompt?: string;
  outcomes: HookOutcome[];
}

const parseOutput = (stdout: string): PluginHookOutput | undefined => {
  const text = stdout.trim();
  if (!text.startsWith('{')) return undefined;
  try {
    const parsed = pluginHookOutputSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
};

export const withTimeout = <T>(work: Promise<T>, timeout: number): Promise<T> => new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error(`超过 ${timeout}ms 未返回`)), timeout);
  work.then(value => { clearTimeout(timer); resolvePromise(value); }, error => { clearTimeout(timer); reject(error); });
});

/**
 * 插件 hook 总线。同一事件的 hook 按插件名、声明顺序依次执行；deny 立即结束并胜出，
 * 其余按 ask > allow 合并。exit 0 放行（stdout 可为 JSON），exit 2 阻断（stderr 为原因），
 * 其他退出码、超时、起不来都是非阻断错误，onFailure=block 时改为阻断。
 */
export class PluginHookBus {
  constructor(private readonly registrations: HookRegistration[], private readonly log?: { warn(data: Record<string, unknown>, message: string): void }) {}

  has(event: PluginHookEvent): boolean { return this.registrations.some(registration => registration.event === event); }

  async run(event: PluginHookEvent, input: Omit<PluginHookInput, 'event' | 'plugin'>, matchTarget = ''): Promise<HookRunResult> {
    const result: HookRunResult = { additionalContext: [], outcomes: [] };
    const context: PluginScopeContext = { ...(input.botAppId ? { botAppId: input.botAppId } : {}), ...(input.cwd ? { cwd: input.cwd } : {}) };
    let sawAsk = false, sawAllow = false;
    for (const registration of this.registrations) {
      if (registration.event !== event || !scopeApplies(registration.scope, context)) continue;
      if (registration.matcher && !registration.matcher.test(matchTarget)) continue;
      const hookInput: PluginHookInput = { ...input, event, plugin: registration.plugin };
      const outcome = await this.invoke(registration, hookInput);
      result.outcomes.push(outcome.outcome);
      if (outcome.outcome.result === 'error') {
        this.log?.warn({ plugin: registration.plugin, event, exitCode: outcome.outcome.exitCode, timedOut: outcome.outcome.timedOut, message: outcome.outcome.message }, '插件 hook 执行失败，已忽略');
        continue;
      }
      if (outcome.outcome.result === 'deny') {
        result.decision = 'deny';
        result.reason = outcome.outcome.message || `插件 ${registration.plugin} 的 ${event} hook 拒绝了这次操作`;
        return result;
      }
      const output = outcome.output;
      if (output?.decision === 'deny') {
        result.decision = 'deny';
        result.reason = output.reason || `插件 ${registration.plugin} 的 ${event} hook 拒绝了这次操作`;
        return result;
      }
      if (output?.decision === 'ask') { sawAsk = true; result.reason = output.reason ?? result.reason; }
      if (output?.decision === 'allow') sawAllow = true;
      if (output?.additionalContext) result.additionalContext.push(output.additionalContext);
      if (output?.updatedPrompt) result.updatedPrompt = output.updatedPrompt;
    }
    if (sawAsk) result.decision = 'ask';
    else if (sawAllow) result.decision = 'allow';
    return result;
  }

  private async invoke(registration: HookRegistration, input: PluginHookInput): Promise<{ outcome: HookOutcome; output?: PluginHookOutput }> {
    const base = { plugin: registration.plugin, kind: registration.kind };
    if (registration.kind === 'handler') {
      try {
        const output = await withTimeout(Promise.resolve().then(() => registration.handler(input)), registration.timeout);
        const parsed = output ? pluginHookOutputSchema.safeParse(output) : undefined;
        return { outcome: { ...base, result: 'allow' }, ...(parsed?.success ? { output: parsed.data } : {}) };
      } catch (error) {
        return { outcome: { ...base, result: 'error', message: error instanceof Error ? error.message : String(error) } };
      }
    }
    const { spec } = registration;
    const run = await runCommandHook(spec.command, input, {
      cwd: registration.cwd,
      env: childEnvironment(process.env, { ...registration.env, DUTYDECK_HOOK_EVENT: input.event }),
      timeout: spec.timeout
    });
    const detail = { exitCode: run.exitCode, ...(run.timedOut ? { timedOut: true } : {}), ...(run.stdoutTruncated ? { stdoutTruncated: true } : {}) };
    if (!run.timedOut && run.exitCode === 0) {
      const output = run.stdoutTruncated ? undefined : parseOutput(run.stdout);
      return { outcome: { ...base, ...detail, result: 'allow' }, ...(output ? { output } : {}) };
    }
    if (!run.timedOut && run.exitCode === 2) return { outcome: { ...base, ...detail, result: 'deny', message: run.stderr.trim() } };
    const message = run.timedOut ? `超过 ${spec.timeout}ms 未结束，已终止` : run.error ?? `退出码 ${run.exitCode}${run.stderr.trim() ? `：${run.stderr.trim()}` : ''}`;
    if (spec.onFailure === 'block') return { outcome: { ...base, ...detail, result: 'deny', message: `插件 ${registration.plugin} 的 hook 失败（${message}），按 onFailure=block 阻断` } };
    return { outcome: { ...base, ...detail, result: 'error', message } };
  }
}

export const inProcessHookTimeout = (timeout?: number) => Math.min(Math.max(timeout ?? IN_PROCESS_DEFAULT_TIMEOUT_MS, 100), 600_000);
