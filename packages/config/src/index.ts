import { agentConfigSchema, type AgentConfig } from '@dutydeck/shared';
import { listAcpxBuiltinAgents } from '@dutydeck/acp-client';
import { commandExists } from '@dutydeck/transports';
import type { DriverFactory, RuntimeOptions } from '@dutydeck/runtime';
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const ACXP_VERSION = '0.13.0';

export const appConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().positive().default(4310),
  /** Access-token authentication remains enabled unless explicitly disabled. */
  authEnabled: z.boolean().default(true),
  databaseUrl: z.string().default('./.dutydeck/dutydeck.db'),
  acpxCommand: z.string().default('acpx'),
  driverIdleTimeoutMs: z.number().nonnegative().default(6 * 60 * 60_000),
  cleanupIntervalMs: z.number().positive().default(5 * 60_000),
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env, ptyContributions: PtyAgentContribution[] = []): AppConfig {
  const extra = env.DUTYDECK_AGENTS_JSON ? JSON.parse(env.DUTYDECK_AGENTS_JSON) : [];
  const defaultCwd = env.DUTYDECK_DEFAULT_CWD ?? process.cwd();
  const agents = new Map(builtinAgents(defaultCwd, ptyContributions).map(agent => [agent.id, agent]));
  for (const agent of extra) {
    const configured = agentConfigSchema.parse(agent);
    if (commandExists(configured.command)) agents.set(configured.id, { ...configured, cwd: configured.cwd ?? defaultCwd, version: configured.version ?? cliVersion(configured.command) });
  }
  return appConfigSchema.parse({
    host: env.DUTYDECK_LOCAL_ONLY === 'true' ? '127.0.0.1' : env.DUTYDECK_HOST,
    port: env.DUTYDECK_PORT ? Number(env.DUTYDECK_PORT) : undefined,
    authEnabled: env.DUTYDECK_AUTH === undefined
      ? undefined
      : z.enum(['true', 'false']).parse(env.DUTYDECK_AUTH) === 'true',
    databaseUrl: resolve(defaultCwd, env.DUTYDECK_DATABASE_URL ?? './.dutydeck/dutydeck.db'),
    acpxCommand: env.DUTYDECK_ACPX_COMMAND,
    driverIdleTimeoutMs: env.DUTYDECK_DRIVER_IDLE_TIMEOUT_MS ? Number(env.DUTYDECK_DRIVER_IDLE_TIMEOUT_MS) : undefined,
    cleanupIntervalMs: env.DUTYDECK_CLEANUP_INTERVAL_MS ? Number(env.DUTYDECK_CLEANUP_INTERVAL_MS) : undefined,
    agents: [...agents.values()]
  });
}

/**
 * 把 AppConfig 映射成 DutydeckRuntime 的 RuntimeOptions 子集（server 组装时与 sessionEnvironment/sessionPrompt 等 spread 合并）。
 * ptyDriverFactory 是函数、不能进 zod 校验的 AppConfig，经此注入点透传（由 server 从 @dutydeck/pty-driver 组装）。
 */
export function createRuntimeOptions(
  config: AppConfig,
  options: { ptyDriverFactory?: DriverFactory } = {}
): Pick<RuntimeOptions, 'acpxCommand' | 'driverIdleTimeoutMs' | 'cleanupIntervalMs' | 'ptyDriverFactory'> {
  return {
    acpxCommand: config.acpxCommand,
    driverIdleTimeoutMs: config.driverIdleTimeoutMs,
    cleanupIntervalMs: config.cleanupIntervalMs,
    ptyDriverFactory: options.ptyDriverFactory
  };
}
