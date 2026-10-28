import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import type { AgentConfig } from '@dutydeck/shared';
import { createTimelineProjector } from '../apps/web/src/timeline.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it.each([
  ['authorize', ['fail']], ['authorize', ['ok', 'fail']], ['authorize', ['fail', 'ok']], ['authorize', ['ok', 'fail', 'ok']],
  ['prepare', ['fail']], ['prepare', ['ok', 'fail']], ['prepare', ['fail', 'ok']], ['prepare', ['ok', 'fail', 'ok']]
] as const)('preserves unprompted %s failure and task/attempt provenance for %j', async (phase, prompts) => {
  const directory = await mkdtemp(join(tmpdir(), 'history-preparation-'));
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const marker = `UNPROMPTED_${phase.toUpperCase()}_FAILURE`;
  const runtime = new DutydeckRuntime(repos, { cleanupIntervalMs: 0,
    authorizeTask: async (_session, task) => { if (phase === 'authorize' && task.prompt === 'fail') throw new Error(marker); },
    sessionPrompt: async (_session, prompt) => { if (phase === 'prepare' && prompt === 'fail') throw new Error(marker); return prompt; },
    driverFactory: (_agent, _protocol, emit) => ({ start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, isIdle: () => true, isStopped: async () => true,
      send: async () => { emit({ type: 'text', data: { text: 'confirmed successor output' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } }); } })
  });
  cleanup.push(async () => { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  const agent: AgentConfig = { id: 'sample', name: 'Sample', protocol: 'acp', command: process.execPath, args: [], cwd: directory, env: {}, permissionMode: 'ask', timeout: 60, capabilities: { pause: false, resume: true }, builtin: false };
  await runtime.initialize([agent]); const session = await runtime.start({ agentId: agent.id });
  for (const prompt of prompts) await runtime.send(session.id, prompt);
  const tasks = await runtime.getTasks(session.id), canonical = await runtime.getEvents(session.id);
  const failure = canonical.find(event => event.type === 'error' && (event.data as any).message === marker)!;
  expect(failure).toBeDefined(); expect(failure.taskId).toBeTruthy(); expect(failure.attemptId).toBeTruthy();
  expect(canonical.some(event => event.taskId === failure.taskId && event.type === 'text' && (event.data as any).role === 'user')).toBe(false);
  const outline = await runtime.getHistoryOutline(session.id);
  expect(outline.liveAfter).toBeLessThan(failure.sequence);
  for (const turn of outline.turns) {
    const attempts = repos.execution.getTaskExecution(turn.taskId!)!.attempts;
    expect(attempts.some(attempt => attempt.attemptId === turn.attemptId && attempt.taskId === turn.taskId)).toBe(true);
  }
  const visibleTasks = tasks.filter(task => !outline.turns.some(turn => turn.taskId === task.id));
  const view = createTimelineProjector()(canonical.filter(event => event.sequence > outline.liveAfter), visibleTasks);
  expect(view.timelineSections.some(section => section.kind === 'event' && section.event.id === failure.id && section.event.data.message === marker)).toBe(true);
  if (prompts.at(-1) === 'ok') {
    const successor = tasks.at(-1)!;
    expect(successor.status).toBe('completed');
    expect(view.timeline.some(event => event.taskId === successor.id && event.data.text === 'confirmed successor output')).toBe(true);
  }
  expect(outline.turns.some(turn => turn.taskId !== failure.taskId && turn.attemptId === failure.attemptId)).toBe(false);
});
