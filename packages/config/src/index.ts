import { agentConfigSchema, errorMessage as describeError, mapLimit, type AgentConfig } from '@dutydeck/shared';
import { childEnvironment } from '@dutydeck/shared/child-environment';
import { listAcpxBuiltinAgents } from '@dutydeck/acp-client';
import { commandExists } from '@dutydeck/transports';
import { z } from 'zod';
import { execFile, spawnSync } from 'node:child_process';
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
  pi: { name: 'Pi', cli: 'pi' }, openclaw: { name: 'OpenClaw', cli: 'openclaw' }, codex: { name: 'Codex', cli: 'codex' }, 'codex-acp': { name: 'Codex (ACP)', cli: 'codex' }, claude: { name: 'Claude Code', cli: 'claude' },
  gemini: { name: 'Gemini', cli: 'gemini' }, cursor: { name: 'Cursor Agent', cli: 'cursor-agent' }, copilot: { name: 'GitHub Copilot', cli: 'copilot' }, droid: { name: 'Factory Droid', cli: 'droid' },
  'fast-agent': { name: 'fast-agent', cli: 'fast-agent-mcp' }, 'grok-build': { name: 'Grok Build', cli: 'grok' }, iflow: { name: 'iFlow', cli: 'iflow' }, kilocode: { name: 'Kilocode', cli: 'kilocode' },
  kimi: { name: 'Kimi', cli: 'kimi' }, kiro: { name: 'Kiro', cli: 'kiro-cli-chat' }, mux: { name: 'Mux', cli: 'mux' }, opencode: { name: 'OpenCode', cli: 'opencode' },
  pool: { name: 'Poolside', cli: 'pool' }, qoder: { name: 'Qoder', cli: 'qodercli' }, qwen: { name: 'Qwen Code', cli: 'qwen' }, trae: { name: 'Trae', cli: 'traecli' }, zeroclaw: { name: 'ZeroClaw', cli: 'zeroclaw' }
};

const VERSION_ARGS = [['--version'], ['-V'], ['version']];
const versionLine = (stdout: string, stderr: string) => `${stdout}\n${stderr}`.split(/\r?\n/).map(value => value.trim()).find(Boolean)?.slice(0, 100);
// 同一进程里同一个命令（按当时的 PATH 解析）探测成功一次就复用：ACP 与 PTY 两边、插件与环境变量里的同一 CLI 共用结果。
// 失败不缓存：CLI 稍后装好或临时出错时，下次装配配置会重新探测。
const probedVersions = new Map<string, string>();
/** 启动时并行探测版本的命令数上限。 */
const VERSION_PROBE_CONCURRENCY = 4;
const probingVersions = new Map<string, Promise<string | undefined>>();
const versionKey = (command: string) => `${command}\0${process.env.PATH ?? ''}`;
/** 探测执行的是 Agent 与插件命令，和 Agent 子进程走同一道环境边界：服务配置与飞书密钥不带过去。 */
const probeEnvironment = () => ({ ...childEnvironment(process.env), NO_COLOR: '1' });
/** loadConfigWithDiagnosticsAsync 刚异步探测的结果（含失败），只在它紧接着的同步装配期间有效，失败的命令不再用 spawnSync 重探。 */
let prefetchedVersions: Map<string, string | undefined> | undefined;

export function cliVersion(command: string): string | undefined {
  const key = versionKey(command);
  if (probedVersions.has(key)) return probedVersions.get(key);
  if (prefetchedVersions?.has(key)) return prefetchedVersions.get(key);
  let version: string | undefined;
  for (const args of VERSION_ARGS) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 1500, env: probeEnvironment() });
    const line = versionLine(result.stdout ?? '', result.stderr ?? '');
    if (result.status === 0 && line) { version = line; break; }
  }
  if (version !== undefined) probedVersions.set(key, version);
  return version;
}

/** cliVersion 的异步版：同样的参数顺序、超时与取值，不阻塞事件循环；并发探测同一命令共用一次。 */
export function cliVersionAsync(command: string): Promise<string | undefined> {
  const key = versionKey(command);
  if (probedVersions.has(key)) return Promise.resolve(probedVersions.get(key));
  const running = probingVersions.get(key);
  if (running) return running;
  const probe = (async () => {
    let version: string | undefined;
    for (const args of VERSION_ARGS) {
      const result = await new Promise<{ ok: boolean; stdout: string; stderr: string }>(done => {
        // 与 spawnSync 一样立即给 stdin 结束符：读 stdin 的 CLI 不会一直等到超时。
        execFile(command, args, { encoding: 'utf8', timeout: 1500, env: probeEnvironment() },
          (error, stdout, stderr) => done({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? '' })).stdin?.end();
      });
      const line = versionLine(result.stdout, result.stderr);
      if (result.ok && line) { version = line; break; }
    }
    if (version !== undefined) probedVersions.set(key, version);
    probingVersions.delete(key);
    return version;
  })();
  probingVersions.set(key, probe);
  return probe;
}

const builtinCli = (id: string, env: Record<string, string | undefined> = process.env) => (id === 'codex' || id === 'codex-acp') ? env.CODEX_PATH || agentDetails[id]!.cli : agentDetails[id]!.cli;

/** 本机装了这个 ACP 内置 Agent 的 CLI 时返回要探测版本的命令。 */
const builtinProbeCommand = (id: string, env: NodeJS.ProcessEnv) => {
  if (!agentDetails[id]) return undefined;
  const command = builtinCli(id, env);
  return commandExists(command) ? command : undefined;
};
const ptyCommand = (contribution: PtyAgentContribution, env: NodeJS.ProcessEnv) =>
  (contribution.id === 'codex' || contribution.id === 'codex-cli') ? env.CODEX_PATH || contribution.command : contribution.command;

const scannedBuiltinAgents = new Map<string, Array<Omit<AgentConfig, 'cwd'>>>();
const scanBuiltinAgents = (env: NodeJS.ProcessEnv) => {
  const cacheKey = env.CODEX_PATH ?? '';
  const cached = scannedBuiltinAgents.get(cacheKey);
  if (cached) return cached;
  const agents = listAcpxBuiltinAgents().flatMap(({ id, argv }) => {
    const detail = agentDetails[id];
    const command = builtinProbeCommand(id, env);
    if (!detail || !command) return [];
    const agent = { id, name: detail.name, command: argv[0]!, args: argv.slice(1), protocol: 'acp' as const, env: {}, permissionMode: 'ask' as const, timeout: 600, capabilities: { pause: false, resume: true }, builtin: true, version: cliVersion(command) };
    return id === 'codex' ? [agent, { ...agent, id: 'codex-acp', name: agentDetails['codex-acp']!.name }] : [agent];
  });
  scannedBuiltinAgents.set(cacheKey, agents);
  return agents;
};

// PTY 适配器（@dutydeck/cli-adapters，由 server 组装时注入，本包不直接依赖）贡献的内置 agent 描述
export interface PtyAgentContribution {
  id: string
  name: string
  command: string
  args?: string[]
  builtin?: boolean
  adapterId?: string
  /** 该 CLI 的真实能力。省略时按保守默认 { pause: false, resume: true } 处理——
   *  贡献方（@dutydeck/pty-driver 的 PTY_AGENT_CONTRIBUTIONS）应显式声明，
   *  否则像 gemini 这种「每次都全新会话、无 resume」的 CLI 会被错报为可恢复。 */
  capabilities?: { pause: boolean; resume: boolean }
}

/** 贡献未声明能力时的保守默认。 */
const DEFAULT_PTY_CAPABILITIES = { pause: false, resume: true } as const;

// PTY 扫描结果按贡献列表和 CODEX_PATH 缓存：commandExists/cliVersion 都是 spawnSync 重操作，相同配置不重复探测
// 缓存按贡献逐项记录；命中缓存时只对当时找不到的命令重新查一次 PATH（只是 stat）：
// CLI 自更新替换可执行文件期间命令会短暂缺失，回来后下次扫描能找到，已找到的不再重复探测版本
type PtyScanEntry = Omit<AgentConfig, 'cwd'> | undefined;
const scannedPtyAgents = new Map<string, PtyScanEntry[]>();
const scanPtyContribution = (contribution: PtyAgentContribution, env: NodeJS.ProcessEnv): PtyScanEntry => {
  const command = ptyCommand(contribution, env);
  if (!commandExists(command)) return undefined;
  return { id: contribution.id, name: contribution.name, command, args: contribution.args ?? [], protocol: 'pty-cli' as const, ...(contribution.adapterId && contribution.adapterId !== contribution.id ? { adapterId: contribution.adapterId } : {}), env: {}, permissionMode: 'ask' as const, timeout: 600, capabilities: contribution.capabilities ?? DEFAULT_PTY_CAPABILITIES, builtin: contribution.builtin ?? true, version: cliVersion(command) };
};
const scanPtyAgents = (contributions: PtyAgentContribution[], env: NodeJS.ProcessEnv): Array<Omit<AgentConfig, 'cwd'>> => {
  const cacheKey = JSON.stringify([contributions, env.CODEX_PATH]);
  const cached = scannedPtyAgents.get(cacheKey);
  const entries = contributions.map((contribution, index) => cached?.[index] ?? scanPtyContribution(contribution, env));
  scannedPtyAgents.set(cacheKey, entries);
  return entries.filter((entry): entry is Omit<AgentConfig, 'cwd'> => entry !== undefined);
};

export const builtinAgents = (cwd = process.cwd(), ptyContributions: PtyAgentContribution[] = [], env: NodeJS.ProcessEnv = process.env): AgentConfig[] => {
  const ptyAgents = scanPtyAgents(ptyContributions, env);
  const ptyIds = new Set(ptyAgents.map(agent => agent.id));
  const acpxAgents = scanBuiltinAgents(env).filter(agent => !ptyIds.has(agent.id));
  return [...ptyAgents, ...acpxAgents].map(agent => ({ ...agent, cwd }));
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
export function agentProbeTarget(agent: Pick<AgentConfig, 'id' | 'command' | 'protocol' | 'builtin' | 'adapterId'> & { env?: Record<string, string> }): { command: string; execute: boolean } {
  if (agent.builtin && agent.protocol === 'acp' && agentDetails[agent.id]) return { command: builtinCli(agent.id, { ...process.env, ...agent.env }), execute: true };
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
// A custom CLI wrapper may change local settings even for --version.
const probesConfiguredVersion = (configured: AgentConfig) => configured.version === undefined && !(configured.protocol === 'pty-cli' && configured.adapterId);
const configuredBuiltinIds = (ptyContributions: PtyAgentContribution[]) => new Set(['codex-acp', ...listAcpxBuiltinAgents().map(agent => agent.id), ...ptyContributions.map(agent => agent.id)]);

export function loadConfigWithDiagnostics(env: NodeJS.ProcessEnv = process.env, ptyContributions: PtyAgentContribution[] = [], pluginAgents: AgentConfig[] = []): LoadedConfig {
  const extra = parseAgentsJson(env.DUTYDECK_AGENTS_JSON);
  const defaultCwd = env.DUTYDECK_DEFAULT_CWD ?? process.cwd();
  const agents = new Map(builtinAgents(defaultCwd, ptyContributions, { ...process.env, ...env }).map(agent => [agent.id, agent]));
  const builtinIds = configuredBuiltinIds(ptyContributions);
  const register = (configured: AgentConfig, plugin = false) => {
    if (!commandExists(configured.command)) return false;
    agents.set(configured.id, { ...configured, ...(plugin ? {} : { origin: undefined }), cwd: configured.cwd ?? defaultCwd, version: probesConfiguredVersion(configured) ? cliVersion(configured.command) : configured.version });
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

/**
 * 与 loadConfigWithDiagnostics 结果相同；先把它要探测版本的命令去重后异步并行探测完（最多同时 4 个），
 * 同步装配时直接用这批结果（失败也算），启动时不再用 spawnSync 逐个卡住事件循环。
 */
export async function loadConfigWithDiagnosticsAsync(env: NodeJS.ProcessEnv = process.env, ptyContributions: PtyAgentContribution[] = [], pluginAgents: AgentConfig[] = []): Promise<LoadedConfig> {
  const merged = { ...process.env, ...env };
  const builtinIds = configuredBuiltinIds(ptyContributions);
  const configured = [...pluginAgents.filter(agent => !builtinIds.has(agent.id)).map(agent => agentConfigSchema.parse(agent)), ...parseAgentsJson(env.DUTYDECK_AGENTS_JSON)];
  const commands = new Set([
    ...listAcpxBuiltinAgents().map(({ id }) => builtinProbeCommand(id, merged)),
    ...ptyContributions.map(contribution => ptyCommand(contribution, merged)).filter(command => commandExists(command)),
    ...configured.filter(agent => probesConfiguredVersion(agent) && commandExists(agent.command)).map(agent => agent.command)
  ].filter((command): command is string => Boolean(command)));
  const prefetched = new Map<string, string | undefined>();
  await mapLimit([...commands], VERSION_PROBE_CONCURRENCY, async command => { prefetched.set(versionKey(command), await cliVersionAsync(command)); });
  prefetchedVersions = prefetched;
  try { return loadConfigWithDiagnostics(env, ptyContributions, pluginAgents); }
  finally { prefetchedVersions = undefined; }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, ptyContributions: PtyAgentContribution[] = [], pluginAgents: AgentConfig[] = []): AppConfig {
  return loadConfigWithDiagnostics(env, ptyContributions, pluginAgents).config;
}

/** 仅含安全字符时原样输出，否则按 sh 单引号转义；区别于 @dutydeck/shared 的 shellQuote（总是加引号）。 */
export const shellQuoteIfNeeded = (value: string) => /^[\w./@+:=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** 面向用户的说明：哪个 Agent、哪个命令找不到，以及可复制的修法（改用绝对路径）。 */
export function describeDroppedAgent(agent: DroppedAgent): { detail: string; remedy: string; command: string } {
  const quoted = shellQuoteIfNeeded(agent.command);
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
