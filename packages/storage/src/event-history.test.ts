import { afterEach, expect, it } from 'vitest';
import { createRepositories } from './index.js';
import type { AgentEvent } from '@dutydeck/shared';

const repositories: ReturnType<typeof createRepositories>[] = [];
afterEach(() => { for (const repos of repositories.splice(0)) repos.close(); });
const event = (sequence: number, type: AgentEvent['type'], data: unknown, taskId?: string, attemptId?: string): AgentEvent => ({ id: `e${sequence}`, sessionId: 's', sequence, type, timestamp: String(sequence), data, taskId, attemptId, raw: 'raw-canary' });
async function fixture() {
  const repos = createRepositories(':memory:'); repositories.push(repos);
  for (const id of ['a', 'z']) await repos.tasks.save({ id, sessionId: 's', prompt: 'prompt', status: id === 'a' ? 'completed' : 'queued', createdAt: '', updatedAt: '' });
  return repos;
}
it('merges the session prefix into the first turn and ignores a queued successor identity', async () => {
  const repos = await fixture();
  const events = [event(1, 'status', { state: 'starting' }), event(2, 'text', { role: 'user', text: 'instruction', taskId: 'a' }, 'a', 'attempt-a'),
    event(3, 'task', { task: { id: 'z', status: 'queued' } }, 'z', 'attempt-z'), event(4, 'tool_result', { id: 'tool', status: 'completed', output: 'huge-body'.repeat(200_000), parts: [{ type: 'resource_link', uri: 'file:///artifact', name: 'artifact' }] }, 'a', 'attempt-a'),
    event(5, 'text', { text: 'final ' }, 'a', 'attempt-a'), event(6, 'text', { text: 'answer' }, 'a', 'attempt-a')];
  for (const item of events) await repos.events.append(item);
  const result = await repos.events.listHistoryOutline!('s');
  expect(result).toMatchObject({ liveAfter: 6, highWaterMark: 6, turns: [{ id: 'e2', taskId: 'a', attemptId: 'attempt-a', firstSequence: 1, lastSequence: 6, prompt: { text: 'instruction', truncated: false }, output: { text: 'final answer', truncated: false }, toolCount: 1 }] });
  expect(JSON.stringify(result)).not.toContain('huge-body');
  expect(JSON.stringify(result)).not.toContain('raw-canary');
  expect(result.turns[0]?.artifactReferences).toMatchObject([{ taskId: 'a', attemptId: 'attempt-a', eventId: 'e4', uri: 'file:///artifact', revision: 'event:e4:4:0', status: 'recorded' }]);
  expect(await repos.events.list('s')).toHaveLength(6);
  expect((await repos.events.listWindow('s', { afterSequence: 3, limit: 1 }))[0]?.data).toEqual(events[3]?.data);
});
it('bounds many small final fragments, giant prompts and artifact references without losing canonical content', async () => {
  const repos = await fixture();
  await repos.events.append(event(1, 'text', { role: 'user', text: 'p'.repeat(50_000) }, 'a', 'attempt-a'));
  let sequence = 1;
  for (let index = 0; index < 200; index++) await repos.events.append(event(++sequence, 'tool_result', { id: `tool-${index}`, status: 'completed', parts: [{ type: 'resource_link', uri: `file:///artifact-${index}` }] }, 'a', 'attempt-a'));
  for (let index = 0; index < 10_000; index++) await repos.events.append(event(++sequence, 'text', { text: 'abc' }, 'a', 'attempt-a'));
  const result = await repos.events.listHistoryOutline!('s');
  expect(result.turns[0]?.prompt).toEqual({ text: 'p'.repeat(1024), truncated: true });
  expect(result.turns[0]?.output).toEqual({ text: 'abc'.repeat(1366).slice(0, 4096), truncated: true });
  expect(result.turns[0]?.artifactReferences).toHaveLength(128);
  expect(result.turns[0]?.artifactReferencesTruncated).toBe(true);
  expect((await repos.events.list('s')).filter(item => item.type === 'text')).toHaveLength(10_001);
});
it('keeps unknown and running turns canonical even when a later completed task exists', async () => {
  const repos = await fixture();
  await repos.tasks.save({ id: 'a', sessionId: 's', prompt: 'prompt', status: 'reconcile_required', createdAt: '', updatedAt: '' });
  await repos.events.append(event(1, 'text', { role: 'user', text: 'unknown' }, 'a', 'attempt-a'));
  await repos.events.append(event(2, 'text', { text: 'partial' }, 'a', 'attempt-a'));
  expect(await repos.events.listHistoryOutline!('s')).toEqual({ turns: [], highWaterMark: 2, liveAfter: 0 });
});

it('retains a bounded latest native command catalog independently of completed canonical events', async () => {
  const repos = await fixture();
  await repos.events.append(event(1, 'status', { state: 'commands', availableCommands: [{ name: '/compact', description: 'Compact native context' }] }));
  await repos.events.append(event(2, 'text', { role: 'user', text: 'instruction' }, 'a', 'attempt-a'));
  await repos.events.append(event(3, 'text', { text: 'final' }, 'a', 'attempt-a'));
  const first = await repos.events.listHistoryOutline!('s');
  expect(first.liveAfter).toBe(3);
  expect(first.commandCatalog).toEqual({ sequence: 1, commands: [{ name: 'compact', description: 'Compact native context' }], truncated: false });
  await repos.events.append(event(4, 'status', { state: 'commands', availableCommands: Array.from({ length: 200 }, (_, i) => ({ name: '/command' + i, description: 'd'.repeat(5000) })) }));
  const bounded = await repos.events.listHistoryOutline!('s');
  expect(bounded.commandCatalog?.commands).toHaveLength(128);
  expect(bounded.commandCatalog?.commands[0]?.description).toHaveLength(1024);
  expect(bounded.commandCatalog?.truncated).toBe(true);
  await repos.events.append(event(5, 'status', { state: 'commands', availableCommands: [] }));
  expect((await repos.events.listHistoryOutline!('s')).commandCatalog).toEqual({ sequence: 5, commands: [], truncated: false });
  await repos.events.append(event(6, 'status', { state: 'commands', availableCommands: ['invalid', 7, { name: '/safe', description: 'still usable' }, { name: 'n'.repeat(5000) }] }));
  expect((await repos.events.listHistoryOutline!('s')).commandCatalog).toEqual({ sequence: 6, commands: [{ name: 'safe', description: 'still usable' }], truncated: true });
});
