import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';

export interface SessionRelayCliOptions {
  requestId?: string;
  /** ask 超时秒数 */
  timeout?: string;
  /** 以 JSON 输出结果而非裸答案 */
  json?: boolean;
  choices?: string;
  multiple?: boolean;
}

export interface SessionRelayCliHandlers {
  sessionReport?(options: { status: string; question?: string; summary?: string }): void | Promise<void>;
  sessionSend?(text: string): void | Promise<void>;
  sessionAskResult?(requestId: string, options: SessionRelayCliOptions): void | Promise<void>;
  sessionAskWait?(requestId: string, options: SessionRelayCliOptions): void | Promise<void>;
  sessionAsk?(question: string, options: SessionRelayCliOptions): void | Promise<void>;
  sessionNativeAsk?(): void | Promise<void>;
  sessionPermissionHook?(): void | Promise<void>;
}

/** Register the relay-only session commands on either CLI entry without duplicating their option contract. */
export function addSessionRelayCommands(session: Command, handlers: SessionRelayCliHandlers): void {
  session.command('native-ask')
    .description('Bridge a native Claude AskUserQuestion hook from stdin to the current session')
    .action(() => handlers.sessionNativeAsk?.());
  session.command('permission-hook')
    .description('Bridge a native Claude PermissionRequest hook from stdin to Dutydeck approval')
    .action(() => handlers.sessionPermissionHook?.());
  session.command('send')
    .description('Publish an in-turn progress event; presentation depends on session settings')
    .argument('<text>', 'Message content')
    .action(text => handlers.sessionSend?.(text));
  session.command('report')
    .description('报告当前任务的收尾状态；不阻塞等待回答')
    .requiredOption('--status <status>', 'ready（完成）、waiting（等你决定）、blocked（受阻）、dropped（无需处理）')
    .option('--question <text>', '等你决定时的一个具体问题，waiting 必填')
    .option('--summary <text>', '一句话说明，blocked 必填原因')
    .action(options => handlers.sessionReport?.(options));
  session.command('ask')
    .description('Ask the user a question and block until they answer')
    .argument('<question>', 'Question to ask')
    .option('--request-id <id>', 'Stable request identity; reuse only for the same question and execution attempt')
    .option('--timeout <seconds>', 'Seconds to wait for an answer (default: 300, maximum: 86400)')
    .option('--choices <json>', 'JSON array of {label, value?} options; card selections return value or label, text replies return verbatim')
    .option('--multiple', 'Allow multiple selections (requires --choices)')
    .option('--json', 'Print the full result as JSON instead of the bare answer')
    .action((question, options) => handlers.sessionAsk?.(question, options))
    .addHelpText('after', `
Exit codes:
  0    answered — the answer is printed to stdout
  2    usage error (missing session credentials, bad arguments)
  3    relay unavailable (server unreachable, session ended, question cancelled)
  124  timed out with no answer

Examples:
  $ dutydeck session send "已完成迁移，正在跑回归"
  $ answer=$(dutydeck session ask "要继续发布吗？") && echo "user said: $answer"
  $ dutydeck session ask "选哪个方案？" --choices '[{"label":"方案甲","value":"a"},{"label":"方案乙","value":"b"}]' --timeout 60
  $ dutydeck session ask "要检查哪些项？" --choices '[{"label":"代码"},{"label":"文档"}]' --multiple --json`);

  session.command('ask-result')
    .description('Read a saved answer and continuation state; this does not authorize execution')
    .argument('<request-id>', 'Request identity printed by session ask')
    .option('--json', 'Print the saved request as JSON')
    .action((requestId, options) => handlers.sessionAskResult?.(requestId, options));
  session.command('ask-wait')
    .description('Wait again for the same question while its original execution attempt remains valid')
    .argument('<request-id>', 'Request identity printed by session ask')
    .option('--json', 'Print the full result as JSON')
    .action((requestId, options) => handlers.sessionAskWait?.(requestId, options));
}

const output = (result: unknown) => process.stdout.write(`${JSON.stringify({ ok: true, ...result as object })}\n`);
const flush = (stream: NodeJS.WriteStream, text: string) => new Promise<void>((resolve, reject) => stream.write(text, error => error ? reject(error) : resolve()));

/** Load each transport only when its command runs; registration stays light for Agent/help calls. */
export function createSessionRelayCliHandlers(): Required<SessionRelayCliHandlers> {
  return {
    sessionReport: async options => { const { runSessionReport } = await import('./relay-cli.js'); output(await runSessionReport(options)); },
    sessionSend: async text => { const { runSessionSend } = await import('./relay-cli.js'); output(await runSessionSend(text)); },
    sessionNativeAsk: async () => {
      const [{ readNativeAskPayload, runNativeAskHook }, { acknowledgeDeferredAsk }] = await Promise.all([
        import('./native-ask-hook.js'), import('./relay-cli.js')
      ]);
      const result = await runNativeAskHook(await readNativeAskPayload(process.stdin));
      if (result) {
        await flush(process.stdout, `${result}\n`);
        const deferred = /^deferred:([a-zA-Z0-9_-]+) /.exec(JSON.parse(result).stopReason ?? '');
        if (deferred) await acknowledgeDeferredAsk(deferred[1]!, {}, false);
      }
    },
    sessionPermissionHook: async () => {
      const [{ readNativeAskPayload }, { runPermissionHook }] = await Promise.all([
        import('./native-ask-hook.js'), import('./permission-hook.js')
      ]);
      // 读不懂 stdin 也要交回明确裁决：hook 只挂在 PermissionRequest 上，当成无法识别的请求拒绝。
      const result = await runPermissionHook(await readNativeAskPayload(process.stdin).catch(() => ({ hook_event_name: 'PermissionRequest' })));
      if (result) process.stdout.write(`${result}\n`);
    },
    sessionAsk: async (question, options) => {
      const { acknowledgeDeferredAsk, askOutput, runSessionAsk } = await import('./relay-cli.js');
      // ask 有自己的 stdout/退出码契约（答案裸文本走 stdout，提示走 stderr），
      // 不能套用通用的 output()：调用方要能 `answer=$(dutydeck session ask ...)`。
      const requestId = options.requestId ?? randomUUID();
      process.stderr.write(`requestId: ${requestId}\n`);
      const result = await runSessionAsk(question, { ...options, requestId });
      const rendered = askOutput(result, options.json === true);
      if (rendered.stdout) await flush(process.stdout, rendered.stdout);
      if (rendered.stderr) await flush(process.stderr, rendered.stderr);
      if (result.status === 'deferred' && result.askId) await acknowledgeDeferredAsk(result.askId);
      process.exitCode = rendered.exitCode;
    },
    sessionAskResult: async requestId => { const { runSessionAskResult } = await import('./relay-cli.js'); output(await runSessionAskResult(requestId)); },
    sessionAskWait: async (requestId, options) => {
      const { askOutput, runSessionAskWait } = await import('./relay-cli.js');
      const rendered = askOutput(await runSessionAskWait(requestId), options.json === true);
      if (rendered.stdout) process.stdout.write(rendered.stdout);
      if (rendered.stderr) process.stderr.write(rendered.stderr);
      process.exitCode = rendered.exitCode;
    }
  };
}
