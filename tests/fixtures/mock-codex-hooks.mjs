#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const cwd = realpathSync(process.cwd());
const state = () => { try { return JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'hooks-probe-state.json'), 'utf8')); } catch { return {}; } };
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (!request.id) continue;
  const current = state();
  if (current.report) appendFileSync(current.report, `${JSON.stringify({ method: request.method, pid: process.pid, codexHome: process.env.CODEX_HOME })}\n`);
  if (current.hang) continue;
  let result;
  if (request.method === 'initialize') result = {};
  else if (request.method === 'config/read') result = { layers: [{ name: { type: 'project', dotCodexFolder: join(cwd, '.codex') }, ...(current.projectTrusted ? {} : { disabledReason: 'Project is not trusted' }) }] };
  else if (request.method === 'hooks/list') {
    let hooks = [];
    try {
      const sourcePath = join(cwd, '.codex', 'hooks.json');
      const content = readFileSync(sourcePath, 'utf8');
      hooks = (JSON.parse(content).hooks.PreToolUse ?? []).flatMap((group, groupIndex) => group.hooks.map((handler, index) => ({ key: `${sourcePath}:pre_tool_use:${groupIndex}:${index}`, eventName: 'preToolUse', handlerType: 'command', command: handler.command, matcher: group.matcher, sourcePath, source: 'project', enabled: current.enabled !== false, isManaged: false, currentHash: current.emptyHash ? '' : `sha256:${createHash('sha256').update(content).digest('hex')}`, trustStatus: current.hookTrustStatus ?? 'untrusted', ...(current.hookOverride ?? {}) })));
    } catch {}
    result = { data: [{ cwd, hooks: current.projectTrusted && !current.missingHook ? hooks : [], errors: [], warnings: [] }] };
  } else throw new Error(`Unexpected RPC: ${request.method}`);
  process.stdout.write(`${JSON.stringify(current.rpcError ? { id: request.id, error: { code: -32601, message: 'Unsupported RPC' } } : { id: request.id, result })}\n`);
}
