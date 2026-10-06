import { homedir } from 'node:os';
import { join } from 'node:path';
import { childEnvironment } from '@dutydeck/shared/child-environment';
import type {
  AgentConfig,
  DriverTranscriptSourceObservation,
  InsightClient,
  LaunchKind,
  ProofKind
} from '@dutydeck/shared';

/**
 * ACP 来源采集（设计 §3.1）
 * ========================
 * Driver 只在内存中向订阅者上报不可变的非密钥元信息，不写 AgentEvent、不写
 * SQLite，也不向 ACPX session_options 写任何分析字段。Runtime 负责补 session /
 * run / driverInstance / sourceKey。
 *
 * 证据边界：
 *  - create：在 acpx 真实 spawn 事件边界，用与实际启动路径同构的“传给子进程的
 *    最终环境”确定性冻结 dataRoot，proofKind=launch_observed。最终 env 是确定的：
 *    直启由 acpx buildAgentEnvironment 合并，bridge 由本仓库 env-launcher.mjs 重构，
 *    二者都在 resolveAcpChildEnvironment 中同构复现，绝不扫描宿主 /proc。
 *  - attach（restoreStrictSession 同样会新起一个进程做 session/load）：当前
 *    config/HOME 只能描述本次附着进程，不能替历史 launch 环境背书，proofKind
 *    只能是 inferred。
 *  - native 身份关联只在 onPrepared 内 native.confirmed(identity) 成功之后追加；
 *    acpxRecordId / backendSessionId / agentSessionId 严格区分，没有 CLI session
 *    ID 证据时 nativeSessionId 留 null，绝不拿 acpx record id 顶替。
 */

const carrierKeys = ['dutydeck_agent_env_file', 'dutydeck_agent_env_digest'] as const;

type AcpxLaunchLike = {
  command: string[];
  sessionOptions: { env?: Record<string, string> };
};

/** ACPX 用 env-launcher 包装启动（脏环境或大写 vendor 变量）时为 true。 */
export function isEnvBridgeLaunch(launch: AcpxLaunchLike, envLauncherPath: string): boolean {
  return launch.command[1] === envLauncherPath;
}

/**
 * 同构复算真正 Agent 子进程收到的最终环境（只用于推导非密钥路径，不得整体持久化）。
 *
 * - bridge 启动与 agents/env-launcher.mjs 同构：childEnvironment(继承环境合并持久
 *   env 与载体键, 全量 agent.env)，再删除两个载体键；
 * - 直启时 prepareAcpxAgentLaunch 已保证继承环境干净且无大写 vendor 变量，acpx 在
 *   spawn 时把 sessionOptions.env 合并到 process.env 上（buildAgentEnvironment）。
 */
export function resolveAcpChildEnvironment(
  agent: AgentConfig,
  launch: AcpxLaunchLike,
  envLauncherPath: string
): Record<string, string> {
  if (!isEnvBridgeLaunch(launch, envLauncherPath)) {
    return { ...process.env, ...(launch.sessionOptions.env ?? {}) } as Record<string, string>;
  }
  const inherited = { ...process.env, ...(launch.sessionOptions.env ?? {}) };
  const env = childEnvironment(inherited, agent.env);
  for (const key of carrierKeys) delete env[key];
  return env;
}

function homeOf(env: Record<string, string>): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

/** 展开前导 ~，与 pty-driver cli-paths.expandHome 在显式子进程 env 下同构。 */
function expandHome(value: string, env: Record<string, string>): string {
  return value.startsWith('~') ? join(homeOf(env), value.slice(1)) : value;
}

function clientFromExecutableOrEntry(command: string, args: string[] = []): InsightClient | null {
  const binary = command.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (/^codex(?:-.*)?$/i.test(binary)) return 'codex';
  if (/^claude(?:-.*)?$/i.test(binary)) return 'claude';
  if (/^trae(?:x|cli)?(?:-.*)?$/i.test(binary)) return 'traex';

  // 当 command 为 node, bun, tsx 等 runtime wrapper 时，只检查其执行目标脚本/包名，
  // 不检查后续普通选项（如 --model claude-opus）。
  if (/^(?:node|nodejs|tsx|bun|deno)$/i.test(binary)) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg.startsWith('-')) {
        if (['-r', '--import', '--loader', '--require', '-C'].includes(arg) && i + 1 < args.length) {
          i++;
        }
        continue;
      }
      const script = arg.split(/[\\/]/).pop()?.toLowerCase() ?? '';
      if (/^codex(?:-.*)?$/i.test(script) || script.includes('codex-acp')) return 'codex';
      if (/^claude(?:-.*)?$/i.test(script) || script.includes('claude-acp') || arg.includes('@agentclientprotocol/claude-agent-acp')) return 'claude';
      if (/^trae(?:x|cli)?(?:-.*)?$/i.test(script) || script.includes('trae-acp')) return 'traex';
      break;
    }
  }

  // 当 command 为 npx, pnpm 等 package runner 时，检查执行的包/命令。
  if (/^(?:npx|pnpm|yarn|bunx)$/i.test(binary)) {
    for (const arg of args) {
      if (arg.startsWith('-')) continue;
      const tool = arg.split(/[\\/]/).pop()?.toLowerCase() ?? '';
      if (/^codex(?:-.*)?$/i.test(tool) || tool.includes('codex-acp')) return 'codex';
      if (/^claude(?:-.*)?$/i.test(tool) || tool.includes('claude-acp') || arg.includes('@agentclientprotocol/claude-agent-acp')) return 'claude';
      if (/^trae(?:x|cli)?(?:-.*)?$/i.test(tool)) return 'traex';
      break;
    }
  }

  return null;
}

/**
 * 识别日志客户端。按显式受支持 adapterId -> 真实启动可执行文件/入口脚本 ->
 * 精确内置 agent id 顺位判定，不拿自由标签或模型/provider 参数（如 --model
 * claude-opus）误判方言；无法识别时返回 null 安全降级。
 */
export function inferAcpInsightClient(agent: AgentConfig): InsightClient | null {
  // 1. 显式 adapterId 优先（PTY/统一配置对齐）
  if (agent.adapterId) {
    const aid = agent.adapterId.toLowerCase();
    if (aid === 'codex' || /^codex(?:-.*)?$/i.test(aid)) return 'codex';
    if (aid === 'claude' || /^claude(?:-.*)?$/i.test(aid)) return 'claude';
    if (aid === 'traex' || aid === 'trae' || /^trae(?:x|cli)?(?:-.*)?$/i.test(aid)) return 'traex';
  }

  // 2. 真实启动事实（可执行文件名称或 wrapper 执行的入口脚本）
  const fromExec = clientFromExecutableOrEntry(agent.command, agent.args);
  if (fromExec) return fromExec;

  // 3. 精确内置 agent id fallback（不搞自由名称 includes）
  const id = agent.id.toLowerCase();
  if (id === 'codex') return 'codex';
  if (id === 'claude') return 'claude';
  if (id === 'traex' || id === 'trae') return 'traex';

  return null;
}

/** 客户端非密钥日志数据根，只从“子进程环境”推导，与 pty-driver cli-paths 同构。 */
export function acpDataRoot(client: InsightClient, env: Record<string, string>): string {
  if (client === 'claude') {
    const configured = env.CLAUDE_CONFIG_DIR?.trim();
    return configured ? expandHome(configured, env) : join(homeOf(env), '.claude');
  }
  if (client === 'codex') {
    const configured = env.CODEX_HOME?.trim();
    return configured ? expandHome(configured, env) : join(homeOf(env), '.codex');
  }
  const configured = env.TRAE_HOME?.trim();
  return configured ? expandHome(configured, env) : join(homeOf(env), '.trae');
}

export interface AcpLaunchObservationInput {
  client: InsightClient;
  launchKind: LaunchKind;
  /** true 时为 create 且在真实 spawn 边界冻结；attach 恒为 false。 */
  observed: boolean;
  dataRoot: string;
  cwd: string;
}

export interface AcpNativeObservationInput {
  client: InsightClient;
  launchKind: LaunchKind;
  /** 与本次追加对应的 launch 观察是否在真实 spawn 边界冻结。 */
  observed: boolean;
  dataRoot: string;
  cwd: string;
  /** native.confirmed 成功后 prepareSubmission 给出的来源关联；取不到则省略。 */
  nativeContextRef?: unknown;
  /** 只有 ACP _meta 显式给出的 Agent/CLI session ID 才能放这里。 */
  agentSessionId?: string;
}

let observationSeq = 0;

/** Driver 侧观察：去掉 runtime 填充的 session/run/driver/sourceKey 字段。 */
export function buildLaunchObservation(input: AcpLaunchObservationInput): DriverTranscriptSourceObservation {
  const proofKind: ProofKind = input.observed ? 'launch_observed' : 'inferred';
  return freezeObservation({
    observationId: `acp-src-${++observationSeq}-${crypto.randomUUID()}`,
    client: input.client,
    launchKind: input.launchKind,
    proofKind,
    capturedAt: new Date().toISOString(),
    dataRoot: input.dataRoot,
    cwd: input.cwd
  });
}

/** onPrepared 中 native.confirmed 成功后的身份追加观察。 */
export function buildNativeObservation(input: AcpNativeObservationInput): DriverTranscriptSourceObservation {
  const proofKind: ProofKind = input.observed ? 'launch_observed' : 'inferred';
  return freezeObservation({
    observationId: `acp-src-${++observationSeq}-${crypto.randomUUID()}`,
    client: input.client,
    launchKind: input.launchKind,
    proofKind,
    capturedAt: new Date().toISOString(),
    dataRoot: input.dataRoot,
    cwd: input.cwd,
    ...(input.nativeContextRef !== undefined ? { nativeContextRef: input.nativeContextRef } : {}),
    nativeSessionId: input.agentSessionId ?? null,
    identityProof: input.agentSessionId ? 'acpx_agent_session_meta' : null,
    streamIdentity: { kind: 'main' as const, nativeAgentId: null }
  });
}

/** 深冻结：订阅者拿到的任何嵌套对象都不可被改写，重放同一引用也安全。 */
export function freezeObservation<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) freezeObservation(child as object);
  }
  return Object.freeze(value);
}
