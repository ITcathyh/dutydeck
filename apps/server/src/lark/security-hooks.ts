import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { LarkServiceError } from './service.js';

const guardVersion = 'dutydeck-high-risk-guard-v2';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

type HookAgentId = 'codex' | 'claude' | 'trae' | 'cursor' | 'pi';
type HookAdapter = {
  id: HookAgentId;
  label: string;
  kind: 'nested-json' | 'cursor-json' | 'pi-extension';
  configDirectory: string;
  configFile: string;
  eventKey?: string;
  trustInstructions: string;
};

const adapters: Record<HookAgentId, HookAdapter> = {
  codex: { id: 'codex', label: 'Codex', kind: 'nested-json', configDirectory: '.codex', configFile: 'hooks.json', eventKey: 'PreToolUse', trustInstructions: 'Codex 首次执行时如提示信任，请在该工作区执行 /hooks 并确认 Dutydeck PreToolUse Hook。' },
  claude: { id: 'claude', label: 'Claude Code', kind: 'nested-json', configDirectory: '.claude', configFile: 'settings.json', eventKey: 'PreToolUse', trustInstructions: 'Claude Code 会从项目 .claude/settings.json 加载 PreToolUse Hook；首次进入工作区时请确认项目信任。' },
  trae: { id: 'trae', label: 'Trae', kind: 'nested-json', configDirectory: '.trae', configFile: 'hooks.json', eventKey: 'PreToolUse', trustInstructions: 'Trae 首次发现项目 Hook 时会要求审核，请确认 Dutydeck PreToolUse Hook。' },
  cursor: { id: 'cursor', label: 'Cursor Agent', kind: 'cursor-json', configDirectory: '.cursor', configFile: 'hooks.json', eventKey: 'preToolUse', trustInstructions: 'Cursor Agent 会从项目 .cursor/hooks.json 加载 fail-closed preToolUse Hook；新会话启动后生效。' },
  pi: { id: 'pi', label: 'Pi', kind: 'pi-extension', configDirectory: '.pi/extensions', configFile: 'dutydeck-high-risk-guard.ts', trustInstructions: 'Pi 会自动发现项目 .pi/extensions；首次进入工作区时请批准项目本地资源。' }
};

const aliases: Record<string, HookAgentId> = {
  codex: 'codex', claude: 'claude', claudecode: 'claude', 'claude-code': 'claude',
  trae: 'trae', cursor: 'cursor', cursoragent: 'cursor', 'cursor-agent': 'cursor', pi: 'pi'
};

const adapterFor = (agentId?: string) => {
  const normalized = agentId ? aliases[agentId.toLowerCase()] : undefined;
  return normalized ? adapters[normalized] : undefined;
};
const markerFor = (adapter: HookAdapter) => `dutydeck-lark-high-risk-guard-${adapter.id}.mjs`;
// 改名前装好的 hook 条目里是这个文件名，且命令是绝对路径。找不到它就会在同一个事件下
// 追加第二条：老条目指向的老脚本读 process.env.dockmux_session_id（新 runtime 不再注入），
// 拿不到就直接放行——风控看着还在，实际已经失效。
const legacyMarkerFor = (adapter: HookAdapter) => `dockmux-lark-high-risk-guard-${adapter.id}.mjs`;
const paths = (adapter: HookAdapter, workspace: string) => ({
  hooksPath: join(workspace, adapter.configDirectory, adapter.configFile),
  scriptPath: adapter.kind === 'pi-extension'
    ? join(workspace, adapter.configDirectory, adapter.configFile)
    : join(workspace, '.dutydeck', 'security', markerFor(adapter))
});

export interface LarkHookStatus {
  agentId?: string;
  supported: boolean;
  installed: boolean;
  writable: boolean;
  trustRequired: boolean;
  hooksPath?: string;
  reason?: string;
  trustInstructions?: string;
}

async function readableJson(path: string, fallback: Record<string, any>): Promise<Record<string, any>> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error: any) {
    if (error?.code === 'ENOENT') return fallback;
    throw new LarkServiceError('HOOK_CONFIG_INVALID', `无法解析现有 Hook 配置：${path}`, 409);
  }
}

function commandGuardScript(mode: 'standard' | 'cursor') {
  const deny = mode === 'cursor'
    ? "process.stdout.write(JSON.stringify({ continue: true, permission: 'deny', user_message: reason, agent_message: reason }));"
    : "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }, systemMessage: reason }));";
  return `#!/usr/bin/env node
// ${guardVersion}
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const sessionId = process.env.dutydeck_session_id;
if (!sessionId) process.exit(0);
let input = '';
for await (const chunk of process.stdin) input += chunk;
let event;
try { event = JSON.parse(input); } catch { process.exit(2); }
const root = process.env.DUTYDECK_POLICY_ROOT || event.cwd || process.cwd();
let policy;
try { policy = JSON.parse(readFileSync(join(root, '.dutydeck', 'security', 'sessions', sessionId + '.json'), 'utf8')); } catch { process.exit(0); }
if (!policy.enabled || policy.authorized || !policy.pattern) process.exit(0);
const values = [];
const flatten = value => {
  if (typeof value === 'string') values.push(value);
  else if (Array.isArray(value)) for (const item of value) flatten(item);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) flatten(item);
};
flatten({ tool_name: event.tool_name || event.toolName, tool_input: event.tool_input || event.toolInput, command: event.command });
const regexWorker = "const { parentPort, workerData } = require('node:worker_threads'); try { parentPort.postMessage({ matched: new RegExp(workerData.pattern, 'i').test(workerData.input) }); } catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }";
let matchError = '';
const risky = await new Promise(resolve => {
  const worker = new Worker(regexWorker, { eval: true, workerData: { pattern: policy.pattern, input: values.join('\\n') } });
  let settled = false;
  const finish = value => { if (settled) return; settled = true; clearTimeout(timer); worker.removeAllListeners(); void worker.terminate(); resolve(value); };
  const timer = setTimeout(() => { matchError = '正则匹配超过 1000ms，已终止并拒绝操作'; finish(true); }, 1000);
  worker.once('message', result => { if (result.error) matchError = '正则匹配失败：' + result.error; finish(result.error ? true : result.matched === true); });
  worker.once('error', error => { matchError = '正则匹配隔离任务失败：' + error.message; finish(true); });
  worker.once('exit', code => { if (code !== 0) { matchError = '正则匹配隔离任务异常退出：' + code; finish(true); } });
});
if (!risky) process.exit(0);
const reason = matchError || policy.reason || '当前飞书发送人无权执行高危操作';
${deny}
`;
}

const piGuardExtension = `// ${guardVersion}
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const regexWorker = "const { parentPort, workerData } = require('node:worker_threads'); try { parentPort.postMessage({ matched: new RegExp(workerData.pattern, 'i').test(workerData.input) }); } catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }";
const matches = (pattern: string, input: string) => new Promise<{ risky: boolean; error?: string }>(resolve => {
  const worker = new Worker(regexWorker, { eval: true, workerData: { pattern, input } });
  let settled = false;
  const finish = (value: { risky: boolean; error?: string }) => { if (settled) return; settled = true; clearTimeout(timer); worker.removeAllListeners(); void worker.terminate(); resolve(value); };
  const timer = setTimeout(() => finish({ risky: true, error: '正则匹配超过 1000ms，已终止并拒绝操作' }), 1000);
  worker.once('message', result => finish(result.error ? { risky: true, error: '正则匹配失败：' + result.error } : { risky: result.matched === true }));
  worker.once('error', error => finish({ risky: true, error: '正则匹配隔离任务失败：' + error.message }));
  worker.once('exit', code => { if (code !== 0) finish({ risky: true, error: '正则匹配隔离任务异常退出：' + code }); });
});

export default function (pi: any) {
  pi.on('tool_call', async (event: any, ctx: any) => {
    const sessionId = process.env.dutydeck_session_id;
    if (!sessionId) return undefined;
    const root = process.env.DUTYDECK_POLICY_ROOT || ctx?.cwd || process.cwd();
    let policy: any;
    try { policy = JSON.parse(readFileSync(join(root, '.dutydeck', 'security', 'sessions', sessionId + '.json'), 'utf8')); } catch { return undefined; }
    if (!policy.enabled || policy.authorized || !policy.pattern) return undefined;
    const result = await matches(policy.pattern, JSON.stringify({ tool_name: event.toolName, tool_input: event.input }));
    if (!result.risky) return undefined;
    return { block: true, reason: result.error || policy.reason || '当前飞书发送人无权执行高危操作' };
  });
}
`;

async function installedState(adapter: HookAdapter, workspace: string) {
  const { hooksPath, scriptPath } = paths(adapter, workspace);
  if (adapter.kind === 'pi-extension') return (await readFile(scriptPath, 'utf8')).includes(guardVersion);
  const config = await readableJson(hooksPath, {});
  const scriptCurrent = (await readFile(scriptPath, 'utf8')).includes(guardVersion);
  return scriptCurrent && JSON.stringify(config.hooks?.[adapter.eventKey!]).includes(markerFor(adapter));
}

export async function larkHookStatus(agentId?: string, workspace?: string): Promise<LarkHookStatus> {
  if (!workspace) return { agentId, supported: false, installed: false, writable: false, trustRequired: false, reason: '请先选择工作区' };
  const adapter = adapterFor(agentId);
  if (!adapter) return { agentId, supported: false, installed: false, writable: false, trustRequired: false, reason: `${agentId || '所选 Agent'} 暂未提供可验证的原生工具调用拦截入口` };
  const { hooksPath } = paths(adapter, workspace);
  let writable = true;
  try { await access(workspace, constants.W_OK); } catch { writable = false; }
  let installed = false;
  let statusError: string | undefined;
  try { installed = await installedState(adapter, workspace); }
  catch (error: any) {
    if (error?.code !== 'ENOENT') statusError = error instanceof Error ? error.message : String(error);
  }
  return {
    agentId: adapter.id,
    supported: true,
    installed,
    writable,
    trustRequired: installed,
    hooksPath,
    ...(!writable ? { reason: '工作区不可写，无法安装 Hook' } : statusError ? { reason: statusError } : {}),
    ...(installed ? { trustInstructions: adapter.trustInstructions } : {})
  };
}

async function installJsonHook(adapter: HookAdapter, workspace: string) {
  const { hooksPath, scriptPath } = paths(adapter, workspace);
  await mkdir(dirname(scriptPath), { recursive: true });
  await mkdir(dirname(hooksPath), { recursive: true });
  await writeFile(scriptPath, commandGuardScript(adapter.kind === 'cursor-json' ? 'cursor' : 'standard'), { mode: 0o700 });
  const fallback = adapter.kind === 'cursor-json' ? { version: 1, hooks: {} } : { description: 'Dutydeck project hooks', hooks: {} };
  const config = await readableJson(hooksPath, fallback);
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks) ? config.hooks : {};
  const entries = Array.isArray(hooks[adapter.eventKey!]) ? hooks[adapter.eventKey!] : [];
  const command = `DUTYDECK_POLICY_ROOT=${quote(workspace)} ${quote(process.execPath)} ${quote(scriptPath)}`;
  const entry = adapter.kind === 'cursor-json'
    ? { command, matcher: '.*', timeout: 5, failClosed: true }
    : { matcher: '.*', hooks: [{ type: 'command', command, timeout: 5, statusMessage: 'Dutydeck 高危操作风险检查' }] };
  const existingIndex = entries.findIndex((item: unknown) => {
    const serialized = JSON.stringify(item);
    return serialized.includes(markerFor(adapter)) || serialized.includes(legacyMarkerFor(adapter));
  });
  if (existingIndex >= 0) entries[existingIndex] = entry;
  else entries.push(entry);
  await writeFile(hooksPath, `${JSON.stringify({ ...config, ...(adapter.kind === 'cursor-json' ? { version: 1 } : {}), hooks: { ...hooks, [adapter.eventKey!]: entries } }, null, 2)}\n`, { mode: 0o600 });
}

export async function installLarkHook(agentId: string | undefined, workspace: string | undefined): Promise<LarkHookStatus> {
  const status = await larkHookStatus(agentId, workspace);
  if (!status.supported || !workspace) throw new LarkServiceError('RISK_CONTROL_UNSUPPORTED', status.reason ?? 'Selected Agent does not support enforced risk control', 422);
  if (!status.writable) throw new LarkServiceError('HOOK_NOT_WRITABLE', status.reason ?? 'Workspace is not writable', 403);
  const adapter = adapterFor(agentId)!;
  if (adapter.kind === 'pi-extension') {
    const { scriptPath } = paths(adapter, workspace);
    await mkdir(dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, piGuardExtension, { mode: 0o600 });
  } else await installJsonHook(adapter, workspace);
  return larkHookStatus(adapter.id, workspace);
}
