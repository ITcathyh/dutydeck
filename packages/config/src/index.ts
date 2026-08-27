import { agentConfigSchema, type AgentConfig } from '@dockmux/shared';
import { listAcpxBuiltinAgents } from '@dockmux/acp-client';
import { commandExists } from '@dockmux/transports';
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const ACXP_VERSION = '0.13.0';

export const appConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().positive().default(4310),
  databaseUrl: z.string().default('./.dockmux/dockmux.db'),
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
  return [{ id, name: detail.name, command: argv[0]!, args: argv.slice(1), protocol: 'acp' as const, env: {}, permissionMode: 'full-trust' as const, timeout: 600, capabilities: { pause: false, resume: true }, builtin: true, version: cliVersion(detail.cli) }];
});
export const builtinAgents = (cwd = process.cwd()): AgentConfig[] => scanBuiltinAgents().map(agent => ({ ...agent, cwd }));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const extra = env.DOCKMUX_AGENTS_JSON ? JSON.parse(env.DOCKMUX_AGENTS_JSON) : [];
  const defaultCwd = env.DOCKMUX_DEFAULT_CWD ?? process.cwd();
  const agents = new Map(builtinAgents(defaultCwd).map(agent => [agent.id, agent]));
  for (const agent of extra) {
    const configured = agentConfigSchema.parse(agent);
    if (commandExists(configured.command)) agents.set(configured.id, { ...configured, cwd: configured.cwd ?? defaultCwd, version: configured.version ?? cliVersion(configured.command) });
  }
  return appConfigSchema.parse({
    host: env.DOCKMUX_LOCAL_ONLY === 'true' ? '127.0.0.1' : env.DOCKMUX_HOST,
    port: env.DOCKMUX_PORT ? Number(env.DOCKMUX_PORT) : undefined,
    databaseUrl: resolve(defaultCwd, env.DOCKMUX_DATABASE_URL ?? './.dockmux/dockmux.db'),
    acpxCommand: env.DOCKMUX_ACPX_COMMAND,
    driverIdleTimeoutMs: env.DOCKMUX_DRIVER_IDLE_TIMEOUT_MS ? Number(env.DOCKMUX_DRIVER_IDLE_TIMEOUT_MS) : undefined,
    cleanupIntervalMs: env.DOCKMUX_CLEANUP_INTERVAL_MS ? Number(env.DOCKMUX_CLEANUP_INTERVAL_MS) : undefined,
    agents: [...agents.values()]
  });
}
