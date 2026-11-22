import { childEnvironment } from '@dutydeck/shared/child-environment';
import { claudeDataDir, codexHome, traeHome } from '@dutydeck/pty-driver/support';
import { SessionInsightResolver as SessionInsightResolverImpl } from '../session-insight-resolver.js';
import type { SessionInsightResolver } from '../session-insight-service.js';
import { createTranscriptSourceKeys } from '@dutydeck/runtime';
import { SessionInsightService } from '../session-insight-service.js';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { makeId } from '@dutydeck/shared';
import type { DutydeckRuntime } from '@dutydeck/runtime';
import type { AppConfig } from '@dutydeck/config';
import type { createRepositories } from '@dutydeck/storage';
import type { FastifyBaseLogger } from 'fastify';
import type { WorkspaceOrganizationService } from '../workspace-organization.js';

/**
 * 按当前 session 对应 agent 的子进程环境计算弱候选数据根（每次 resolve 实时算，
 * 不缓存 agent env，不持久化密钥，不扫描 HOME）。候选仅用于有界历史发现，
 * resolver 仍须内容 native id + ledger 身份证明才成 historical_verified。
 *
 * - PTY 驱动：childEnvironment(serverEnv, agent.env, { stripClaude: true })，
 *   剥离 daemon 的 ANTHROPIC_/CLAUDE_ 桥接身份；
 * - ACP/其它：childEnvironment(serverEnv, agent.env) 不 strip；
 * - 无 agent 配置：回退 serverEnv 自身（daemon 直跑场景）。
 */
export function configuredRootsForSession(
  serverEnv: NodeJS.ProcessEnv,
  session: import('@dutydeck/shared').Session | undefined,
  agent: import('@dutydeck/shared').AgentConfig | undefined
): Array<{ client: 'claude' | 'codex' | 'traex'; path: string }> {
  const isPtyCli = session?.protocol === 'pty-cli';
  const childEnv = childEnvironment(
    serverEnv as Record<string, string | undefined>,
    agent?.env ?? {},
    ...(isPtyCli ? [{ stripClaude: true }] : [])
  ) as Record<string, string | undefined>;
  return [
    { client: 'claude' as const, path: claudeDataDir(childEnv) },
    { client: 'codex' as const, path: codexHome(childEnv) },
    { client: 'traex' as const, path: traeHome(childEnv) }
  ];
}

/**
 * 构造生产会话分析 resolver（静态接线，esbuild bundle 必须能静态解析）。
 * 返回 SessionInsightResolver interface 的轻量 wrapper：每次 resolve(sessionId)
 * 实时读取该 session 的 agent 配置，用 childEnvironment 合并当前 server env
 * （startLocalServer options.env 生效，不固定 process.env）与 agent.env，
 * 再调 cli-paths 三函数生成 weak candidate roots，最后 new 真实 resolver 委托。
 * 持久 observations 的历史 dataRoot 仍由 resolver 自行并入。
 */
export function createInsightResolver(
  repos: ReturnType<typeof createRepositories>,
  serverEnv: NodeJS.ProcessEnv
): SessionInsightResolver {
  return {
    async resolveSessionInsightSources(sessionId, options) {
      const session = await repos.sessions.get(sessionId);
      const agent = session ? await repos.agents.get(session.agentId) : undefined;
      const configuredRoots = configuredRootsForSession(serverEnv, session ?? undefined, agent ?? undefined);
      return new SessionInsightResolverImpl({
        repositories: {
          insight: repos.insight,
          sessions: repos.sessions,
          execution: repos.execution,
          config: repos.config,
          agents: repos.agents
        },
        configuredRoots,
        // 统一 source key hash 算法来自 T3c runtime helper（包根具名导出），接线方不另复制。
        createTranscriptSourceKeys
      }).resolveSessionInsightSources(sessionId, options);
    }
  };
}

export async function composeInsight(repos: ReturnType<typeof createRepositories>, config: AppConfig,
  env: NodeJS.ProcessEnv, workspaceOrganizationService: WorkspaceOrganizationService,
  runtime: DutydeckRuntime, log: FastifyBaseLogger, startupPhase: (name: string) => void) {
  // 会话分析服务（T4c）：1 running/16 queued，按需 Go 分析，失败不影响 Agent 运行。
  // resolver 每次 resolve 按 session agent 当前 env 实时计算候选根；静态接线，无动态 import。
  try {
    const insightService = new SessionInsightService({
      insightRepository: repos.insight,
      resolver: createInsightResolver(repos, env),
      dataDir: config.databaseUrl === ':memory:'
        ? join(tmpdir(), 'dutydeck-insight')
        : dirname(resolve(config.databaseUrl)),
      processRunId: makeId('insight-run'),
      hostEvidence: {
        readHostEvidenceRaw: (sessionId) => repos.insight.readHostEvidenceRaw(sessionId),
        getSessionExecutions: (sessionId) => repos.execution.getSessionExecutions(sessionId),
        getAcceptedTask: (taskId) => repos.execution.getAcceptedTask(taskId),
        readTransaction: (work) => repos.insight.readTransaction(work)
      },
      loadWorkspaceOrganization: async () => (await workspaceOrganizationService.getSnapshot()).organization,
      getCurrentFingerprint: async (sessionId) => runtime.getCodeFingerprint(sessionId),
      log: (details, message) => log.warn(details, message)
    });
    startupPhase('wiring');
    await insightService.initialize();
    return insightService;
  } catch {
    // 只记录固定 code，绝不回显 error.message（可能携带私有路径/token）。
    process.stderr.write('[dutydeck] Session insight service disabled: INSIGHT_STARTUP_FAILED\n');
    return undefined;
  }
}
