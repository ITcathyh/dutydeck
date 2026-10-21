import { afterEach, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentEvent } from '@dutydeck/shared';
import { ClaudeTranscriptTailer } from '../../../../packages/pty-driver/src/transcript/claude.js';
import { claudeProjectDir } from '../../../../packages/pty-driver/src/cli-paths.js';
import { renderLarkProcessElements, renderLarkResultElements } from './card-renderer.js';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';

let root: string, tailer: ClaudeTranscriptTailer;
afterEach(() => { tailer?.stop(); if (root) rmSync(root, { recursive: true, force: true }); });
const at = '2026-10-21T01:00:00.000Z';
async function answer(tool = 'Write', location = 'memory', tail = true, success = true) {
  root = mkdtempSync(join(tmpdir(), 'dd-memory-result-'));
  const env = { CLAUDE_CONFIG_DIR: root };
  const project = claudeProjectDir(root, env); mkdirSync(project, { recursive: true });
  const path = join(project, 'fixture.jsonl'); writeFileSync(path, '');
  const events: AgentEvent[] = [];
  tailer = new ClaudeTranscriptTailer({ cwd: root, env, transcriptPath: path });
  tailer.onEvent(event => events.push({ ...event, timestamp: at } as AgentEvent)); tailer.start(); await tailer.flush();
  const file = location === 'memory' ? join(project, 'memory', 'project.md') : join(root, location);
  const entries = [
    { type: 'user', uuid: 'this-input', message: { role: 'user', content: 'Resolve the incident' } },
    { type: 'assistant', uuid: 'answer', parentUuid: 'this-input', message: { content: [{ type: 'text', text: 'The incident is resolved. Verified the repaired queue.' }] } },
    { type: 'assistant', uuid: 'write', parentUuid: 'answer', message: { content: [{ type: 'tool_use', id: 'memory-write', name: tool, input: tool === 'Bash' ? { command: `echo ${file}` } : { file_path: file } }] } },
    { type: 'user', uuid: 'result', parentUuid: 'write', message: { content: [{ type: 'tool_result', tool_use_id: 'memory-write', is_error: !success, content: success ? 'saved' : 'failed' }] } },
    ...(tail ? [{ type: 'assistant', uuid: 'tail', parentUuid: 'result', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I saved the lesson in memory.' }] } }] : []),
    { type: 'system', subtype: 'turn_duration', parentUuid: tail ? 'tail' : 'result' },
  ];
  appendFileSync(path, entries.map(entry => JSON.stringify(entry) + '\n').join('')); await tailer.flush();
  return { events, output: (input = events) => renderLarkResultElements(input).find(element => element.element_id === 'final_output')?.content };
}
it('preserves the short business answer and memory postscript from real native records', async () => {
  const h = await answer();
  expect(h.output()).toBe('The incident is resolved. Verified the repaired queue.\n\nI saved the lesson in memory.');
  // Persist/reload is the reconciliation path; metadata stays in the event data.
  expect(h.output(JSON.parse(JSON.stringify(h.events)))).toBe(h.output());
});
it('retains memory evidence through runtime tool-ID scoping, persistence and result rendering', async () => {
  const h = await answer(), repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0, driverFactory: (_agent, _protocol, emit) => ({
    start: async () => {}, resume: async () => {}, stop: async () => {}, isStopped: async () => true, interrupt: async () => {},
    send: async () => { for (const event of h.events) emit(event); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); },
  }) });
  try {
    await runtime.initialize([{ id: 'fixture', name: 'fixture', command: process.execPath, args: [], cwd: root, env: {}, protocol: 'acp', permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }]);
    const session = await runtime.start({ agentId: 'fixture' }), task = await runtime.send(session.id, 'Resolve the incident');
    expect(task.status).toBe('completed');
    const persisted = repos.execution.getAttemptEvents(task.currentAttemptId!);
    expect((persisted.find(event => event.type === 'tool_call')?.data as any)?.id).toMatch(/^turn_/);
    expect(h.output(persisted)).toBe('The incident is resolved. Verified the repaired queue.\n\nI saved the lesson in memory.');
  } finally { await runtime.shutdown(); repos.close(); }
});
it('preserves an answer after successful memory maintenance without a postscript', async () => {
  const h = await answer('Edit', 'memory', false); expect(h.output()).toContain('The incident is resolved.');
});
it.each([['Write', 'business.txt', true], ['Bash', 'memory', true], ['Write', 'memory', false]])('keeps %s %s success=%s outside memory promotion', async (tool, location, success) => {
  const h = await answer(tool, location, true, success); expect(h.output()).toBe('I saved the lesson in memory.');
});
it('does not merge an older input or an unpaired tool result', async () => {
  const h = await answer();
  const previous = h.events.map(event => event.type === 'text' && (event.data as any).text.startsWith('The incident') ? { ...event, data: { ...event.data as any, nativeTurnId: 'old-input' } } : event);
  expect(h.output(previous)).toBe('I saved the lesson in memory.');
  expect(h.output(h.events.filter(event => event.type !== 'tool_result'))).toBe('I saved the lesson in memory.');
});
it('shows independent background work alongside the final answer', () => {
  const events = [{ type: 'text', data: { text: 'Launched' }, timestamp: at }, { type: 'status', data: { state: 'background_work', count: 2, mainTurnEnded: true, tasks: [] }, timestamp: at }] as AgentEvent[];
  const card = renderLarkResultElements(events);
  expect(card.find(element => element.element_id === 'background_work')?.content).toBe('主回合已结束 · 后台子任务运行中（2）');
  expect(card.find(element => element.element_id === 'final_output')?.content).toBe('Launched');
});
it('shows bounded capacity waiting and keeps a recovered failure out of the completed result', () => {
  const events = [{ type: 'error', attemptId: 'old-attempt', data: { code: 'codex_capacity', message: 'at capacity' }, timestamp: at },
    { type: 'status', data: { state: 'capacity_retry', causeAttemptId: 'old-attempt', ordinal: 1 }, timestamp: at }] as AgentEvent[];
  expect(renderLarkProcessElements(events, { compactTrace: false, traceLimit: 20 }).find(element => element.element_id === 'capacity_retry')?.content).toContain('最多 2 次');
  const completed = renderLarkResultElements([...events, { type: 'text', data: { text: 'Recovered answer' }, timestamp: at } as AgentEvent]);
  expect(completed.find(element => element.element_id === 'capacity_retry')).toBeUndefined();
  expect(JSON.stringify(completed)).not.toContain('at capacity');
  expect(completed.find(element => element.element_id === 'final_output')?.content).toBe('Recovered answer');
});
