import { taskReportHint } from '@dutydeck/relay';
import type { ActiveTaskContext, PromptAssembler } from '@dutydeck/runtime';
import type { PromptPart, Session } from '@dutydeck/shared';
import type { TurnTokens } from '../agent-host/turn-token.js';
import type { HerdrSessions } from '../herdr.js';
import type { PluginHost } from '../plugins/host.js';
import type { ProjectMemoryService } from '../project-memory.js';
import type { SessionAutomationService } from '../session-automation.js';
import { assemblePrompt, promptDigest } from '../prompt-context.js';
import { composePromptParts, renderPromptParts, type PromptContributor } from './composer.js';

interface SessionPromptSources {
  channelTools(session: Session, active?: ActiveTaskContext): PromptContributor;
  plugins?: Pick<PluginHost, 'resultTools' | 'businessTools'>;
  tokens: Pick<TurnTokens, 'finalTurnToken' | 'workbenchTurnToken'>;
  isAutomatedTask(taskId: string): boolean;
  command: string;
  projectMemory: Pick<ProjectMemoryService, 'prompt'>;
  scheduleResult: SessionAutomationService['resultContext'];
  herdr: Pick<HerdrSessions, 'prompt'>;
}

function pluginTools(session: Session, sources: SessionPromptSources, active?: ActiveTaskContext): PromptContributor {
  return { stage: 'capability', order: 20, sessions: 'host-enabled', contribute: () => {
    const resultTools = sources.plugins?.resultTools.list({ botAppId: session.sourceId?.split(':')[0], cwd: session.cwd }) ?? [];
    const resultPrompt = session.source === 'lark' && active?.actorId && active.attemptId && !sources.isAutomatedTask(active.taskId) && resultTools.length ? `受控插件结果工具：只返回回执，正文仅原请求者登录下载。调用 dutydeck plugin-tool call <工具> --json '<参数>' --call-id <稳定调用ID> --turn ${sources.tokens.finalTurnToken(session.id, active.taskId, active.attemptId)}；重试保持 call-id。可用工具：${resultTools.map(t => `${t.id}：${t.description}`).join('；')}\n\n` : '';
    const businessPrompt = sources.plugins?.businessTools.list({ botAppId: session.sourceId?.split(':')[0], cwd: session.workspaceSourceCwd ?? session.cwd }).length && active?.attemptId && !sources.isAutomatedTask(active.taskId)
      ? `业务工具：使用本轮凭证执行 ${sources.command} tool list --turn ${sources.tokens.workbenchTurnToken(session.id, active.taskId, active.attemptId)}。大目录可用 ${sources.command} tool list --summary --turn <本轮凭证>；已知工具可直接 ${sources.command} tool describe <工具> --turn <本轮凭证>。详情中的可选手册按逻辑 ID 用 ${sources.command} tool manual <工具> <ID> --turn <本轮凭证> 读取；必需 SOP 仍完整冻结。按返回 schema 调用 ${sources.command} tool call <工具> --json '<参数>' --call-id <稳定ID> --turn <本轮凭证>。同次重试保留 call-id；unknown 仅用 tool reconcile 核对，不新建写操作。MCP tools 端点为 /api/plugin-tools/mcp，使用会话 relay Bearer 与 x-dutydeck-tool-turn；身份由宿主决定。\n\n` : '';
    return [resultPrompt, businessPrompt].filter(Boolean).map(content => ({ kind: 'dynamic_context', trustScope: 'host:current_authority', content }));
  } };
}

export function createSessionPrompt(sources: SessionPromptSources): PromptAssembler['atExecute'] {
  return async (session, prompt, context, active) => {
    const version = context?.promptPolicyVersion ?? 'legacy-v1';
    const hostRule = (sourceId: string, content: string): PromptPart => ({
      kind: 'host_rules', sourceId, version, digest: promptDigest(content), trustScope: 'host', complete: true, content, suffix: '\n\n'
    });
    const host = (order: number, contribute: PromptContributor['contribute']): PromptContributor =>
      ({ stage: 'host', order, sessions: 'host-enabled', contribute });
    const additions = await composePromptParts(session, [
      { stage: 'capability', order: 10, sessions: 'host-enabled', contribute: async () => {
        // These capabilities share one audit entry. Preserving it keeps later optimized reference indices stable.
        const capabilities = await composePromptParts(session, [sources.channelTools(session, active), pluginTools(session, sources, active)]);
        const content = renderPromptParts(capabilities);
        return content ? [{ kind: 'dynamic_context', trustScope: 'host:current_authority', content }] : [];
      } },
      host(10, () => [hostRule('dutydeck:task-report', taskReportHint(sources.command))]),
      host(20, async () => {
        const content = await sources.projectMemory.prompt(session);
        return content ? [{ kind: 'dynamic_context', trustScope: 'memory:data', content }] : [];
      }),
      host(30, async () => {
        const content = await sources.scheduleResult(session).catch(() => undefined);
        return content ? [{ kind: 'dynamic_context', trustScope: 'automation:result_data', content, suffix: '\n\n' }] : [];
      }),
      host(40, previous => {
        const boundCommand = previous.some(part => part.trustScope === 'host:current_authority');
        const content = session.terminalBackend === 'herdr' ? '你正在 Herdr 的真实主终端 pane 内运行；HERDR_* 由 Herdr 注入，使用 herdr pane current 核实自身上下文，可用 --current 管理本 pane。不要伪造身份或操作用户 default session。侧边任务可继续使用本会话的 dutydeck session herdr 专属入口。' : sources.herdr.prompt(boundCommand ? 'dutydeck' : undefined);
        return content ? [hostRule('dutydeck:herdr', content)] : [];
      })
    ]);
    const parts: PromptPart[] = [
      ...additions,
      ...(context?.promptParts ?? [{ kind: 'user_request' as const, trustScope: 'user_request', content: prompt }])
    ];
    const result = assemblePrompt(parts, renderPromptParts(additions) + prompt, version);
    if (context?.promptDiagnostics?.fallbackReason && !result.diagnostics.fallbackReason) result.diagnostics.fallbackReason = context.promptDiagnostics.fallbackReason;
    return result;
  };
}
