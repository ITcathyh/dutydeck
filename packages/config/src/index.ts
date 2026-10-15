import { agentConfigSchema, type AgentConfig } from '@dutydeck/shared';
import { listAcpxBuiltinAgents } from '@dutydeck/acp-client';
import { commandExists } from '@dutydeck/transports';
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const appConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().positive().default(4310),
  /** Access-token authentication remains enabled unless explicitly disabled. */
  authEnabled: z.boolean().default(true),
  databaseUrl: z.string().default('./.dutydeck/dutydeck.db'),
  acpxCommand: z.string().default('acpx'),
  driverIdleTimeoutMs: z.number().nonnegative().default(6 * 60 * 60_000),
  cleanupIntervalMs: z.number().int().min(1).max(2_147_483_647).default(5 * 60_000),
  agents: z.array(agentConfigSchema).default([])
});
export type AppConfig = z.infer<typeof appConfigSchema>;

const agentDetails: Record<string, { name: string; cli: string }> = {
  pi: { name: 'Pi', cli: 'pi' }, openclaw: { name: 'OpenClaw', cli: 'openclaw' }, codex: { name: 'Codex', cli: 'codex' }, claude: { name: 'Claude Code', cli: 'claude' },
  gemini: { name: 'Gemini', cli: 'gemini' }, cursor: { name: 'Cursor Agent', cli: 'cursor-agent' }, copilot: { name: 'GitHub Copilot', cli: 'copilot' }, droid: { name: 'Factory Droid', cli: 'droid' },
  'fast-agent': { name: 'fast-agent', cli: 'fast-agent-mcp' }, 'grok-build': { name: 'Grok Build', cli: 'grok' }, iflow: { name: 'iFlow', cli: 'iflow' }, kilocode: { name: 'Kilocode', cli: 'kilocode' },
  kimi: { name: 'Kimi', cli: 'kimi' }, kiro: { name: 'Kiro', cli: 'kiro-cli-chat' }, mux: { name: 'Mux', cli: 'mux' }, opencode: { name: 'OpenCode', cli: 'opencode' },
  pool: { name: 'Poolside', cli: 'pool' }, qoder: { name: 'Qoder', cli: 'qodercli' }, qwen: { name: 'Qwen Code', cli: 'qwen' }, trae: { name: 'Trae', cli: 'traecli' }, zeroclaw: { name: 'ZeroClaw', cli: 'zeroclaw' }
};

export function cliVersion(command: string): string | undefined {
  for (const args of [['--version'], ['-V'], ['version']]) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 1500, env: { ...process.env, NO_COLOR: '1' } });
    const line = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/).map(value => value.trim()).find(Boolean);
    if (result.status === 0 && line) return line.slice(0, 100);
  }
  return undefined;
}

let scannedBuiltinAgents: Array<Omit<AgentConfig, 'cwd'>> | undefined;
const scanBuiltinAgents = () => scannedBuiltinAgents ??= listAcpxBuiltinAgents().flatMap(({ id, argv }) => {
  const detail = agentDetails[id];
  if (!detail || !commandExists(detail.cli)) return [];
  return [{ id, name: detail.name, command: argv[0]!, args: argv.slice(1), protocol: 'acp' as const, env: {}, permissionMode: 'ask' as const, timeout: 600, capabilities: { pause: false, resume: true }, builtin: true, version: cliVersion(detail.cli) }];
});

// PTY 适配器（@dutydeck/cli-adapters，由 server 组装时注入，本包不直接依赖）贡献的内置 agent 描述
export interface PtyAgentContribution {
  id: string
  name: string
  command: string
  args?: string[]
  builtin?: boolean
  /** 该 CLI 的真实能力。省略时按保守默认 { pause: false, resume: true } 处理——
   *  贡献方（@dutydeck/pty-driver 的 PTY_AGENT_CONTRIBUTIONS）应显式声明，
   *  否则像 gemini 这种「每次都全新会话、无 resume」的 CLI 会被错报为可恢复。 */
  capabilities?: { pause: boolean; resume: boolean }
}

/** 贡献未声明能力时的保守默认。 */
const DEFAULT_PTY_CAPABILITIES = { pause: false, resume: true } as const;

// PTY 贡献的扫描结果按贡献列表内容缓存：commandExists/cliVersion 都是 spawnSync 重操作，同一组贡献不重复探测
const scannedPtyAgents = new Map<string, Array<Omit<AgentConfig, 'cwd'>>>();
const scanPtyAgents = (contributions: PtyAgentContribution[], acpxIds: Set<string>): Array<Omit<AgentConfig, 'cwd'>> => {
  const cacheKey = JSON.stringify(contributions);
  const cached = scannedPtyAgents.get(cacheKey);
  if (cached) return cached;
  const agents = contributions.flatMap(contribution => {
    // id 冲突时 ACPX 优先：与 ACPX 内置 agent 同 id 的 PTY 贡献直接跳过，保证 ACP 基线不回归
    if (acpxIds.has(contribution.id) || !commandExists(contribution.command)) return [];
    return [{ id: contribution.id, name: contribution.name, command: contribution.command, args: contribution.args ?? [], protocol: 'pty-cli' as const, env: {}, permissionMode: 'ask' as const, timeout: 600, capabilities: contribution.capabilities ?? DEFAULT_PTY_CAPABILITIES, builtin: contribution.builtin ?? true, version: cliVersion(contribution.command) }];
  });
  scannedPtyAgents.set(cacheKey, agents);
  return agents;
};

export const builtinAgents = (cwd = process.cwd(), ptyContributions: PtyAgentContribution[] = []): AgentConfig[] => {
  const acpxAgents = scanBuiltinAgents();
  const ptyAgents = scanPtyAgents(ptyContributions, new Set(acpxAgents.map(agent => agent.id)));
  return [...acpxAgents, ...ptyAgents].map(agent => ({ ...agent, cwd }));
};

export interface DroppedAgent {
  id: string;
  name: string;
  command: string;
  reason: 'command_not_found';
}

export interface LoadedConfig {
  config: AppConfig;
  /** DUTYDECK_AGENTS_JSON 中因命令找不到而没有登记的 Agent。 */
  droppedAgents: DroppedAgent[];
}

export const AGENTS_JSON_ENV = 'DUTYDECK_AGENTS_JSON';

export class AgentsJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentsJsonError';
  }
}

const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 解析 DUTYDECK_AGENTS_JSON；任何失败都点名变量（和出错的条目），而不是只抛 JSON/zod 的原始报错。 */
function parseAgentsJson(raw: string | undefined): AgentConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new AgentsJsonError(`${AGENTS_JSON_ENV} 不是合法 JSON：${describeError(error)}。它必须是写在一行里的 JSON 数组，例如 [{"id":"custom","name":"Custom","command":"/abs/path/agent","protocol":"acp"}]。`); }
  if (!Array.isArray(parsed)) throw new AgentsJsonError(`${AGENTS_JSON_ENV} 必须是 JSON 数组，收到 ${parsed === null ? 'null' : typeof parsed}。`);
  return parsed.map((entry, index) => {
    const result = agentConfigSchema.safeParse(entry);
    if (result.success) return result.data;
    const label = entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' ? `（id=${(entry as { id: string }).id}）` : '';
    const issues = result.error.issues.map(issue => `${issue.path.join('.') || '(根)'}: ${issue.message}`).join('；');
    throw new AgentsJsonError(`${AGENTS_JSON_ENV} 第 ${index + 1} 项${label}无效：${issues}`);
  });
}

/**
 * 做探测 Agent 命令可用性时该执行的程序。ACP 内置 Agent 的 command 是 `npx` 之类的启动器，
 * 真正的 CLI 在 agentDetails 里；自定义的 pty-cli 包装命令（有 adapterId）可能在 `--version` 时改动本地设置，
 * 与 loadConfig 一样不执行，只确认可执行文件存在。
 */
export function agentProbeTarget(agent: Pick<AgentConfig, 'id' | 'command' | 'protocol' | 'builtin' | 'adapterId'>): { command: string; execute: boolean } {
  if (agent.builtin && agent.protocol === 'acp' && agentDetails[agent.id]) return { command: agentDetails[agent.id]!.cli, execute: true };
  if (!agent.builtin && agent.protocol === 'pty-cli' && agent.adapterId) return { command: agent.command, execute: false };
  return { command: agent.command, execute: true };
}

/** 与 loadConfig 相同的数据库路径解析；插件目录等需要在 loadConfig 之前知道数据目录的地方用它。 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.DUTYDECK_DEFAULT_CWD ?? process.cwd(), env.DUTYDECK_DATABASE_URL ?? './.dutydeck/dutydeck.db');
}

/**
 * pluginAgents：已启用插件 agents/*.json 的内容，先于 DUTYDECK_AGENTS_JSON 合并，同 id 以环境变量为准；
 * 插件不能替换内置 Agent（同 id 的插件 Agent 被忽略）。命令找不到的插件 Agent 不进 droppedAgents（那份诊断针对环境变量）。
 */
export function loadConfigWithDiagnostics(env: NodeJS.ProcessEnv = process.env, ptyContributions: PtyAgentContribution[] = [], pluginAgents: AgentConfig[] = []): LoadedConfig {
  const extra = parseAgentsJson(env.DUTYDECK_AGENTS_JSON);
  const defaultCwd = env.DUTYDECK_DEFAULT_CWD ?? process.cwd();
  const agents = new Map(builtinAgents(defaultCwd, ptyContributions).map(agent => [agent.id, agent]));
  const builtinIds = new Set([...listAcpxBuiltinAgents().map(agent => agent.id), ...ptyContributions.map(agent => agent.id)]);
  const register = (configured: AgentConfig, plugin = false) => {
    // A custom CLI wrapper may change local settings even for --version.
    const customCli = configured.protocol === 'pty-cli' && configured.adapterId;
    if (!commandExists(configured.command)) return false;
    agents.set(configured.id, { ...configured, ...(plugin ? {} : { origin: undefined }), cwd: configured.cwd ?? defaultCwd, version: configured.version ?? (customCli ? undefined : cliVersion(configured.command)) });
    return true;
  };
  for (const agent of pluginAgents) if (!builtinIds.has(agent.id)) register(agentConfigSchema.parse(agent), true);
  const droppedAgents: DroppedAgent[] = [];
  for (const configured of extra) {
    if (!register(configured)) droppedAgents.push({ id: configured.id, name: configured.name, command: configured.command, reason: 'command_not_found' });
  }
  const config = appConfigSchema.parse({
    host: env.DUTYDECK_LOCAL_ONLY === 'true' ? '127.0.0.1' : env.DUTYDECK_HOST,
    port: env.DUTYDECK_PORT ? Number(env.DUTYDECK_PORT) : undefined,
    authEnabled: env.DUTYDECK_AUTH === undefined
      ? undefined
      : z.enum(['true', 'false']).parse(env.DUTYDECK_AUTH) === 'true',
    databaseUrl: resolveDatabaseUrl(env),
    acpxCommand: env.DUTYDECK_ACPX_COMMAND,
    driverIdleTimeoutMs: env.DUTYDECK_DRIVER_IDLE_TIMEOUT_MS ? Number(env.DUTYDECK_DRIVER_IDLE_TIMEOUT_MS) : undefined,
    cleanupIntervalMs: env.DUTYDECK_CLEANUP_INTERVAL_MS ? Number(env.DUTYDECK_CLEANUP_INTERVAL_MS) : undefined,
    agents: [...agents.values()]
  });
  return { config, droppedAgents };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, ptyContributions: PtyAgentContribution[] = [], pluginAgents: AgentConfig[] = []): AppConfig {
  return loadConfigWithDiagnostics(env, ptyContributions, pluginAgents).config;
}

const shellQuote = (value: string) => /^[\w./@+:=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** 面向用户的说明：哪个 Agent、哪个命令找不到，以及可复制的修法（改用绝对路径）。 */
export function describeDroppedAgent(agent: DroppedAgent): { detail: string; remedy: string; command: string } {
  const quoted = shellQuote(agent.command);
  if (agent.command.includes('/')) {
    return {
      detail: `Agent「${agent.id}」的命令 ${agent.command} 不存在或没有执行权限，未被登记`,
      remedy: `${AGENTS_JSON_ENV} 里 id=${agent.id} 的 command 指向 ${agent.command}，该文件不存在或不可执行。核对路径并确认有执行权限（chmod +x），改完重启服务。`,
      command: `ls -l ${quoted}`
    };
  }
  return {
    detail: `Agent「${agent.id}」的命令 ${agent.command} 在 PATH 里找不到，未被登记`,
    remedy: `${AGENTS_JSON_ENV} 里 id=${agent.id} 的 command 是 ${agent.command}。用 command -v 查出它的绝对路径，把该项的 command 改成这个绝对路径（找不到就先安装它），然后重启服务。`,
    command: `command -v ${quoted}`
  };
}
