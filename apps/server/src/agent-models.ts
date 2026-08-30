import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAcpRuntime, createAgentRegistry, createRuntimeStore, type AcpRuntime, type AcpRuntimeEnsureInput, type AcpRuntimeHandle, type AcpRuntimeStatus } from 'acpx/runtime';
import { acpxPermissionMode, prepareAcpxAgentLaunch } from '@dockmux/acp-client';
import type { AgentConfig } from '@dockmux/shared';

const run = promisify(execFile);
const ACP_MODEL_PROBE_TIMEOUT_MS = 30_000;
export interface AgentModel { id: string; name: string }
export interface AgentModelsResult { models: AgentModel[]; defaultModel?: string; reasoningEfforts: AgentModel[]; defaultReasoningEffort?: string; source?: 'acp' | 'cli' | 'agent' }

export class AgentModelProbeTimeoutError extends Error {
  constructor(readonly phase: 'ensureSession' | 'getStatus' | 'close', readonly timeoutMs: number) {
    super(`Agent model probe ${phase} timed out after ${timeoutMs}ms`);
    this.name = 'AgentModelProbeTimeoutError';
  }
}

export async function withAgentModelProbeTimeout<T>(phase: AgentModelProbeTimeoutError['phase'], timeoutMs: number, operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AgentModelProbeTimeoutError(phase, timeoutMs)), timeoutMs);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

const cliCommands: Record<string, { command: string; args: string[]; parse(output: string): AgentModel[] }> = {
  cursor: {
    command: 'cursor-agent', args: ['--list-models'],
    parse: output => output.split(/\r?\n/).flatMap(line => {
      const match = line.trim().match(/^(\S+)\s+-\s+(.+)$/);
      return match ? [{ id: match[1]!, name: match[2]!.replace(/\s+\(default\)$/, '') }] : [];
    })
  },
  trae: { command: 'traecli', args: ['models'], parse: parseModelIds },
  opencode: { command: 'opencode', args: ['models'], parse: parseModelIds },
  pi: {
    command: 'pi', args: ['--list-models'],
    parse: output => output.split(/\r?\n/).slice(1).flatMap(line => {
      const match = line.trim().match(/^(\S+)\s+(\S+)\s+/);
      return match ? [{ id: `${match[1]}/${match[2]}`, name: match[2]! }] : [];
    })
  }
};

function parseModelIds(output: string): AgentModel[] {
  return output.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/\s/.test(line) && !line.startsWith('[')).map(id => ({ id, name: id }));
}

export function modelsFromAcpStatus(status: AcpRuntimeStatus | undefined): AgentModelsResult | undefined {
  if (!status) return undefined;
  const configOptions = Array.isArray(status.details?.configOptions) ? status.details.configOptions as Array<Record<string, any>> : [];
  const modelOption = configOptions.find(option => option.id === 'model' || option.category === 'model');
  const reasoningOption = configOptions.find(option => option.category === 'thought_level' || option.id === 'reasoning_effort' || option.id === 'effort');
  const names = new Map<string, string>((Array.isArray(modelOption?.options) ? modelOption.options : []).flatMap((option: any) => typeof option?.value === 'string' ? [[option.value, typeof option.name === 'string' ? option.name : option.value]] : []));
  const reasoningEfforts = (Array.isArray(reasoningOption?.options) ? reasoningOption.options : []).flatMap((option: any) => typeof option?.value === 'string' ? [{ id: option.value, name: typeof option.name === 'string' ? option.name : option.value }] : []);
  const ids = status.models?.availableModelIds?.length ? status.models.availableModelIds : [...names.keys()];
  if (!ids.length && !status.models?.currentModelId && !reasoningEfforts.length) return undefined;
  return {
    models: ids.map(id => ({ id, name: names.get(id) ?? id })),
    ...(status.models?.currentModelId ? { defaultModel: status.models.currentModelId } : {}),
    reasoningEfforts,
    ...(typeof reasoningOption?.currentValue === 'string' ? { defaultReasoningEffort: reasoningOption.currentValue } : {}),
    source: 'acp'
  };
}

export async function probeModelsThroughAcpRuntime(runtime: AcpRuntime, input: AcpRuntimeEnsureInput, timeoutMs = ACP_MODEL_PROBE_TIMEOUT_MS): Promise<AgentModelsResult | undefined> {
  let handle: AcpRuntimeHandle | undefined;
  try {
    handle = await withAgentModelProbeTimeout('ensureSession', timeoutMs, runtime.ensureSession(input));
    const status = runtime.getStatus
      ? await withAgentModelProbeTimeout('getStatus', timeoutMs, Promise.resolve(runtime.getStatus({ handle })))
      : undefined;
    return modelsFromAcpStatus(status);
  } finally {
    if (handle) {
      await withAgentModelProbeTimeout('close', timeoutMs, runtime.close({ handle, reason: 'Dockmux model discovery', discardPersistentState: true })).catch(() => undefined);
    }
  }
}

async function discoverThroughAcp(agent: AgentConfig, model?: string): Promise<AgentModelsResult | undefined> {
  const stateDir = await mkdtemp(join(tmpdir(), 'dockmux-models-'));
  const sessionKey = `dockmux-model-probe-${crypto.randomUUID()}`;
  const launch = prepareAcpxAgentLaunch(agent, { runtimeDirectory: join(stateDir, 'runtime-env'), sessionKey });
  const runtime = createAcpRuntime({
    cwd: agent.cwd ?? process.cwd(),
    sessionStore: createRuntimeStore({ stateDir }),
    agentRegistry: createAgentRegistry({ overrides: { [agent.id]: launch.command } }),
    permissionMode: acpxPermissionMode(agent.permissionMode),
    nonInteractivePermissions: 'fail',
    timeoutMs: Math.min(agent.timeout * 1000, ACP_MODEL_PROBE_TIMEOUT_MS)
  });
  try {
    return await probeModelsThroughAcpRuntime(runtime, { sessionKey, agent: agent.id, mode: 'oneshot', cwd: agent.cwd ?? process.cwd(), sessionOptions: { ...launch.sessionOptions, ...(model ? { model } : {}) } });
  } finally {
    launch.cleanup();
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function discoverThroughCli(agentId: string): Promise<AgentModel[]> {
  const definition = cliCommands[agentId];
  if (!definition) return [];
  const { stdout } = await run(definition.command, definition.args, { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  return definition.parse(stdout);
}

const cache = new Map<string, { expiresAt: number; value: AgentModelsResult }>();
export async function discoverAgentModels(agent: AgentConfig, model?: string, forceRefresh = false): Promise<AgentModelsResult> {
  const cacheKey = `${agent.id}\u0000${agent.command}\u0000${agent.args.join('\u0000')}\u0000${agent.version ?? ''}\u0000${model ?? ''}`;
  const cached = cache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;

  let value: AgentModelsResult | undefined;
  try { value = await discoverThroughAcp(agent, model); }
  catch { /* The provider CLI may still expose models without starting an ACP session. */ }
  if (!value?.models.length) {
    try {
      const models = await discoverThroughCli(agent.id);
      if (models.length) value = { models, ...(agent.model ? { defaultModel: agent.model } : {}), reasoningEfforts: [], source: 'cli' };
    } catch { /* Fall through to the Agent's configured default. */ }
  }
  value ??= { models: [], ...(agent.model ? { defaultModel: agent.model, source: 'agent' as const } : {}), reasoningEfforts: [] };
  cache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value });
  return value;
}
