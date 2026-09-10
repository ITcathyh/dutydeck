import { describe, expect, it } from 'vitest';
import type { AgentEvent, TaskRecord, ToolRiskPolicy } from '@dutydeck/shared';
import { createRepositories, EVENT_WINDOW_MAX_LIMIT } from './index.js';

function event(sequence: number): AgentEvent {
  return {
    id: `evt_${sequence}`,
    sessionId: 'ses_history',
    sequence,
    type: 'text',
    timestamp: new Date(sequence).toISOString(),
    data: { text: String(sequence) }
  };
}

describe('storage windows and task recovery context', () => {
  it('hard-caps event windows and keeps cursor pages in chronological order', async () => {
    const repos = createRepositories(':memory:');
    for (let sequence = 1; sequence <= 1_500; sequence++) await repos.events.append(event(sequence));

    const capped = await repos.events.listWindow('ses_history', { afterSequence: 250, beforeSequence: 1_400, limit: 50_000 });
    expect(capped).toHaveLength(EVENT_WINDOW_MAX_LIMIT);
    expect(capped[0]?.sequence).toBe(251);
    expect(capped.at(-1)?.sequence).toBe(1_250);

    const backward = await repos.events.listWindow('ses_history', { beforeSequence: 1_400, direction: 'backward', limit: 50 });
    expect(backward.map(item => item.sequence)).toEqual(Array.from({ length: 50 }, (_, index) => 1_350 + index));

    const previous = await repos.events.listWindow('ses_history', { beforeSequence: backward[0]!.sequence, direction: 'backward', limit: 50 });
    expect(previous[0]?.sequence).toBe(1_300);
    expect(previous.at(-1)?.sequence).toBe(1_349);
    repos.close();
  });

  it('round-trips the queued execution context as one optional task field', async () => {
    const repos = createRepositories(':memory:');
    const riskPolicy: ToolRiskPolicy = { enabled: true, authorized: true, pattern: 'rm\\s', actorEmail: 'owner@example.com', reason: 'approved' };
    const task: TaskRecord = {
      id: 'task_context',
      sessionId: 'ses_context',
      prompt: 'visible prompt',
      status: 'queued',
      executionContext: { agentPrompt: 'augmented agent prompt', riskPolicy },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z'
    };
    await repos.tasks.save(task);
    expect((await repos.tasks.listBySession('ses_context'))[0]).toEqual(task);
    repos.close();
  });
});
