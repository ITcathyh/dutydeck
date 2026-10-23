import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentConfig } from '@dutydeck/shared';
import { childEnvironment } from '@dutydeck/shared/child-environment';

type Readiness = { nativeReady: boolean; reason?: string };
type HookAgent = Pick<AgentConfig, 'id'> & Partial<AgentConfig>;
const probes = new Map<string, Promise<Readiness>>();
const failure = (reason: string): Readiness => ({ nativeReady: false, reason });

/** Only metadata RPCs; never creates a thread or submits a model turn. */
export async function codexHookReadiness(workspace: string, expectedCommand: string, agent?: HookAgent): Promise<Readiness> {
  const env = childEnvironment(process.env, agent?.env);
  const executable = env.CODEX_PATH || (agent?.protocol === 'pty-cli' ? agent.command : undefined) || 'codex';
  let cwd: string;
  try { cwd = await realpath(workspace); }
  catch { return failure('无法读取 Codex 工作区，请检查目录后重新检查 Hook。'); }
  const key = createHash('sha256').update(JSON.stringify([executable, cwd, expectedCommand, env])).digest('hex');
  const pending = probes.get(key);
  if (pending) return pending;
  const probe = readNativeStatus(executable, env, cwd, expectedCommand);
  probes.set(key, probe);
  try { return await probe; } finally { probes.delete(key); }
}

function readNativeStatus(executable: string, env: Record<string, string>, cwd: string, expectedCommand: string): Promise<Readiness> {
  return new Promise(resolve => {
    const child = spawn(executable, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    let settled = false, buffer = '', bytes = 0;
    const finish = (result: Readiness) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
      child.stdin.destroy(); child.stdout.destroy();
      resolve(result);
    };
    const unknown = () => finish(failure('无法确认 Codex 原生 Hook 状态，请检查该 Agent 的 CODEX_PATH/CODEX_HOME、Codex 版本及 hooks/list 支持后重新检查。强制风控暂不可用。'));
    const timer = setTimeout(() => finish(failure('检查 Codex 原生 Hook 超时，请确认 Codex 可启动后重新检查。强制风控暂不可用。')), 5_000);
    const send = (id: number, method: string, params: unknown) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    let config: any, hooks: any, inspecting = false;
    const samePath = async (value: unknown, expected: string) => {
      if (typeof value !== 'string') return false;
      const actual = await realpath(value).catch(() => undefined);
      return actual !== undefined && actual === await realpath(expected).catch(() => undefined);
    };
    const inspect = async () => {
      if (!config || !hooks || inspecting) return;
      inspecting = true;
      if (!Array.isArray(config.layers) || !Array.isArray(hooks.data)) return unknown();
      let project;
      for (const layer of config.layers) if (layer?.name?.type === 'project' && await samePath(layer.name.dotCodexFolder, join(cwd, '.codex'))) { project = layer; break; }
      if (!project || project.disabledReason != null) return finish(failure('Codex 尚未加载当前工作区的项目配置。请使用该 Agent 的 CODEX_HOME 在此工作区确认项目信任，再通过 /hooks 仅审核 Dutydeck PreToolUse Hook，完成后重新检查。'));
      let entry;
      for (const item of hooks.data) if (await samePath(item?.cwd, cwd)) { entry = item; break; }
      if (!entry || !Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || entry.errors.length) return unknown();
      let hook;
      for (const item of entry.hooks) if (item?.source === 'project' && await samePath(item.sourcePath, join(cwd, '.codex', 'hooks.json')) && item.eventName === 'preToolUse' && item.handlerType === 'command' && item.command === expectedCommand && item.matcher === '.*') { hook = item; break; }
      if (!hook) return finish(failure('Codex 未加载当前生成的 Dutydeck PreToolUse Hook，请检查 /hooks 中的项目 Hook 配置后重新检查。'));
      if (hook.enabled !== true) return finish(failure('Dutydeck PreToolUse Hook 已被 Codex 禁用，请在 /hooks 中启用该 Hook 后重新检查。'));
      if (hook.trustStatus !== 'trusted' || typeof hook.currentHash !== 'string' || !hook.currentHash.trim()) return finish(failure('Dutydeck PreToolUse Hook 尚未受信任或内容已变化。请在此工作区的 Codex /hooks 中仅审核该 Hook 的当前版本，完成后重新检查。'));
      finish({ nativeReady: true });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return unknown();
      buffer += chunk;
      for (let newline; !settled && (newline = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { return unknown(); }
        if (![1, 2, 3].includes(message.id)) continue;
        if (message.error || !message.result) return unknown();
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
          send(2, 'config/read', { includeLayers: true, cwd });
          send(3, 'hooks/list', { cwds: [cwd] });
        } else if (message.id === 2) config = message.result;
        else hooks = message.result;
        void inspect().catch(unknown);
      }
    });
    child.on('error', unknown); child.on('close', () => { if (!settled) unknown(); });
    child.stdin.on('error', unknown);
    send(1, 'initialize', { clientInfo: { name: 'dutydeck-hook-check', version: '1' }, capabilities: { experimentalApi: true } });
  });
}
