// Safe provider smoke replay: frozen fixture prompts only, no tools or live channels.
import { spawn } from 'node:child_process';
import type { ReplayRequest, ReplayResult } from './evaluate-token-efficiency.mts';
let stdin = '';
for await (const chunk of process.stdin) stdin += String(chunk);
const request = JSON.parse(stdin) as ReplayRequest;
const input = request.case.input as { prompts?: Record<'legacy' | 'optimized', string>; promptSource?: string };
if (!input.prompts?.[request.policy] || !input.promptSource || request.config.protocol !== 'codex-jsonl') throw new Error('Provider runner requires declared old/new assembled prompts and codex-jsonl config');
const prompt = `${input.prompts[request.policy]}\n\nEvaluation: use only the supplied frozen material. Return the requested answer as JSON. Do not call tools.`;
const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', request.config.model,
  '-c', `model_reasoning_effort=${JSON.stringify(request.config.reasoningEffort ?? 'high')}`, '-c', 'mcp_servers={}', '-c', 'web_search="disabled"',
  ...['shell_tool', 'unified_exec', 'apps', 'browser_use', 'computer_use', 'code_mode_host', 'image_generation', 'multi_agent', 'skill_search'].flatMap(feature => ['--disable', feature]), '--json', prompt];
const began = performance.now();
const execution = await new Promise<{ output: string; usage: Record<string, unknown>; events: unknown[] }>((resolve, reject) => {
  const child = spawn('codex', args, { cwd: request.workspace, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let pending = '', output = ''; let usage: Record<string, unknown> | undefined;
  const events: unknown[] = [];
  let failed = false;
  const stop = (reason: string) => { failed = true; try { child.kill('SIGKILL'); } catch {} reject(new Error(reason)); };
  const consume = (line: string) => {
    if (!line.trim() || failed) return;
    let event: Record<string, any>;
    try { event = JSON.parse(line); } catch { stop('Invalid Codex JSONL'); return; }
    events.push(event);
    if (['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
      if (event.type === 'item.completed' && event.item?.type === 'error' && event.item.message === 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.') return;
      if (!['agent_message', 'reasoning'].includes(event.item?.type)) { stop(`Tool/event forbidden in safe provider replay: ${event.item?.type}`); return; }
      if (event.type === 'item.completed' && event.item.type === 'agent_message') output += event.item.text ?? '';
    } else if (event.type === 'turn.completed') usage = event.usage;
    else if (!['thread.started', 'turn.started'].includes(event.type)) stop(`Unexpected Codex event: ${event.type}`);
  };
  child.stdout.on('data', chunk => {
    pending += String(chunk);
    if (pending.length > 2 * 1024 * 1024) { stop('Codex event too large'); return; }
    const lines = pending.split('\n'); pending = lines.pop()!; lines.forEach(consume);
  });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.on('error', reject);
  child.on('close', (code, signal) => {
    if (pending.trim()) consume(pending);
    if (failed) return;
    if (code !== 0 || !usage || !output) reject(new Error(`Codex incomplete: exit=${code ?? signal}, usage=${Boolean(usage)}, output=${Boolean(output)}`));
    else resolve({ output, usage, events });
  });
});
const raw = execution.usage;
const totalInput = raw.input_tokens, cacheRead = raw.cached_input_tokens, cacheWrite = raw.cache_write_input_tokens, outputTokens = raw.output_tokens;
const known = [totalInput, cacheRead, cacheWrite, outputTokens].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
const id = `${request.case.id}:${request.policy}:${request.workspace.split('/').at(-1)}`;
const result: ReplayResult & Record<string, unknown> = {
  status: 'completed', output: JSON.parse(execution.output), executionSource: 'provider', inputDigest: request.inputDigest, config: request.config,
  latencyMs: performance.now() - began, executionScope: 'model_no_tools', promptSource: input.promptSource,
  attempts: [{ attemptId: id, usageRef: id, role: 'root', source: 'provider', model: request.config.model, protocol: request.config.protocol,
    rawUsage: { provider: raw, modelSource: 'requested', normalization: 'ordinary_input = input_tokens - cached_input_tokens (cache_write_input_tokens must be reported zero)', cacheWriteMembership: 'unverified', events: execution.events },
    ...(known && cacheWrite === 0 && (totalInput as number) >= (cacheRead as number) ? { usage: { semantics: 'input_excludes_cache', input: (totalInput as number) - (cacheRead as number), cacheRead: cacheRead as number, cacheWrite: cacheWrite as number, output: outputTokens as number } } : {}) }],
  coverage: { complete: true, attemptIds: [id], usageRefs: [id] }
};
process.stdout.write(JSON.stringify(result));
