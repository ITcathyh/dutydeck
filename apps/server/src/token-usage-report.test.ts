import { describe, expect, it } from 'vitest';
import { createRepositories, executionTaskId } from '@dutydeck/storage';
import type { TaskRequestV1, UsageLedgerEntry } from '@dutydeck/shared';
import { tokenEfficiencyUsageReport } from './usage-ledger.js';

const entry = (taskId: string, patch: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry => ({ id: `usage_${taskId}`, recordedAt: '2026-10-01T00:00:00.000Z', sessionId: `session_${taskId}`, taskId, attemptId: `attempt_${taskId}`,
  category: 'explicit', origin: 'web', agentId: 'mock', dataStatus: 'unpriced', costEstimated: false, inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, ...patch });
const request = (key: string): TaskRequestV1 => ({ version: 1, namespace: 'runtime', key, sessionId: 'shared_memory_session', actor: { kind: 'unspecified' }, prompt: 'private material', mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: {} });

describe('authorized offline usage attribution', () => {
  it('counts shared jobs once, preserves failed costs and scopes compatible-session dispatches exactly', async () => {
    const repos = createRepositories(':memory:');
    try {
      const jobRequest = request('job-one');
      const jobTask = executionTaskId(jobRequest.namespace, jobRequest.sessionId, jobRequest.key);
      for (const row of [entry('root_one'), entry('root_two'), entry('child', { rootTaskId: 'root_one' }), entry('failed_child', { rootTaskId: 'root_one', costUsd: 0.2 }),
        entry(jobTask, { sessionId: jobRequest.sessionId, usageRef: 'unique_compact_and_task', origin: 'memory' }),
        entry('unrelated_job', { sessionId: jobRequest.sessionId, inputTokens: 999 }), entry('unavailable', { rootTaskId: 'root_two', dataStatus: 'unavailable', inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined })]) await repos.usage.append(row);
      const execution = {
        authority: () => 'ledger_v1',
        getAcceptedTask: (taskId: string) => ({ input: { executionContext: { promptPolicyVersion: taskId === 'root_two' ? 'legacy-v1' : 'optimized-v1' } } }),
        getTaskExecution: (taskId: string) => ({ task: { status: taskId === 'failed_child' ? 'failed' : 'completed' }, attempts: [{ attemptId: `attempt_${taskId}` }, ...(taskId === 'root_one' ? [{ attemptId: 'failed_without_usage' }] : [])] })
      };
      const job = { id: 'job_one', scope: { appId: 'authorized_bot', pool: 'group' }, sessionId: jobRequest.sessionId, requests: [jobRequest], input: { turns: [{ taskId: 'root_one' }, { taskId: 'root_two' }] } };
      const report = await tokenEfficiencyUsageReport({ usage: repos.usage, execution: execution as any }, { rootTaskIds: ['root_one', 'root_two'], filter: {}, memoryJobs: [job, job] });
      expect(report).toMatchObject({ entries: 6, policies: { 'optimized-v1': 5, 'legacy-v1': 1 }, memoryJobIds: ['job_one'], unavailableEntries: 1, missingUsageAttempts: ['failed_without_usage'], costUsd: 0.2 });
      expect(report.tokens.inputTokens).toEqual({ value: 50, reportedEntries: 5, coverage: 5 / 6 });
      expect(report.tokens.outputTokens.value).toBe(10); expect(report.tokens.cacheReadTokens.value).toBe(15); expect(report.tokens.cacheWriteTokens.value).toBe(5);
      expect(report.taskStates).toContainEqual({ taskId: 'failed_child', status: 'failed' });
      expect(JSON.stringify(report)).not.toContain('private material');
    } finally { repos.close(); }
  });
  it('keeps absent token data unavailable and does not treat unrecorded attempts as free', async () => {
    const repos = createRepositories(':memory:');
    try {
      await repos.usage.append(entry('root', { dataStatus: 'unavailable', inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined }));
      const report = await tokenEfficiencyUsageReport(repos, { rootTaskIds: ['root'], filter: {}, memoryJobs: [] });
      expect(report.tokens.inputTokens).toEqual({ value: null, reportedEntries: 0, coverage: 0 });
      expect(report.policies).toEqual({ legacy_unversioned: 1 });
      expect(report.costUsd).toBeNull();
      expect(report.unavailableEntries).toBe(1);
    } finally { repos.close(); }
  });
  it.each([
    { appId: 'bot_a', chatId: 'oc_one', since: '2026-10-01T00:00:00.000Z' },
    { appId: 'bot_a', sessionId: 'root_session', since: '2026-10-01T00:00:00.000Z' },
    { sessionId: 'root_session', since: '2026-10-01T00:00:00.000Z' },
    { appId: 'bot_a', rootSessionId: 'root_session', since: '2026-10-01T00:00:00.000Z' },
    { rootSessionId: 'root_session', since: '2026-10-01T00:00:00.000Z' },
    { appId: 'bot_a', since: '2026-10-01T00:00:00.000Z' }
  ])('supplements authorized shared-pool dispatches under %j while preserving app/time boundaries', async filter => {
    const repos = createRepositories(':memory:');
    try {
      const current = request('shared-current'), old = request('shared-before-window'), mismatched = request('wrong-ledger-app');
      const task = (value: TaskRequestV1) => executionTaskId(value.namespace, value.sessionId, value.key);
      await repos.usage.append(entry('child', { appId: 'bot_a', chatId: 'oc_one', sessionId: 'root_session', rootTaskId: 'root_one', rootSessionId: 'root_session', costUsd: 0.1 }));
      await repos.usage.append(entry(task(current), { appId: 'bot_a', chatId: undefined, sessionId: current.sessionId, origin: 'memory', inputTokens: 30, costUsd: 0.3, usageRef: 'shared-usage' }));
      await repos.usage.append(entry(task(old), { appId: 'bot_a', sessionId: old.sessionId, recordedAt: '2026-09-30T23:59:59.000Z', inputTokens: 300, costUsd: 3 }));
      await repos.usage.append(entry(task(mismatched), { appId: 'bot_b', sessionId: mismatched.sessionId, inputTokens: 900, costUsd: 9 }));
      await repos.usage.append(entry('unrelated-compatible-job', { appId: 'bot_a', sessionId: current.sessionId, inputTokens: 800, costUsd: 8 }));
      const job = { id: 'authorized_shared_job', scope: { appId: 'bot_a', pool: 'group' }, sessionId: current.sessionId,
        input: { turns: [{ taskId: 'root_one' }] }, requests: [current, old, mismatched] };
      const report = await tokenEfficiencyUsageReport(repos, { rootTaskIds: ['root_one'], filter, memoryJobs: [job, job] });
      expect(report).toMatchObject({ entries: 2, memoryJobIds: [job.id], costUsd: 0.4, accounting: 'shared_memory_jobs_counted_once' });
      expect(report.tokens.inputTokens).toEqual({ value: 40, reportedEntries: 2, coverage: 1 });
    } finally { repos.close(); }
  });

  it('does not supplement a job from a different filtered app or an unrelated frozen root', async () => {
    const repos = createRepositories(':memory:');
    try {
      await repos.usage.append(entry('root_one', { appId: 'bot_a', chatId: 'oc_one' }));
      const foreign = request('foreign_scope'), unrelated = request('unrelated_root');
      const foreignTask = executionTaskId(foreign.namespace, foreign.sessionId, foreign.key);
      const unrelatedTask = executionTaskId(unrelated.namespace, unrelated.sessionId, unrelated.key);
      await repos.usage.append(entry(foreignTask, { appId: 'bot_b', inputTokens: 900 }));
      await repos.usage.append(entry(unrelatedTask, { appId: 'bot_a', inputTokens: 800 }));
      const report = await tokenEfficiencyUsageReport(repos, {
        rootTaskIds: ['root_one'], filter: { appId: 'bot_a', chatId: 'oc_one' }, memoryJobs: [
          { id: 'foreign', scope: { appId: 'bot_b', pool: 'group' }, sessionId: foreign.sessionId, requests: [foreign], input: { turns: [{ taskId: 'root_one' }] } },
          { id: 'unrelated', scope: { appId: 'bot_a', pool: 'group' }, sessionId: unrelated.sessionId, requests: [unrelated], input: { turns: [{ taskId: 'other_root' }] } }
        ]
      });
      expect(report.entries).toBe(1);
      expect(report.memoryJobIds).toEqual([]);
      expect(report.tokens.inputTokens.value).toBe(10);
      expect(report.taskStates.map(task => task.taskId)).not.toContain(foreignTask);
      expect(report.taskStates.map(task => task.taskId)).not.toContain(unrelatedTask);
    } finally { repos.close(); }
  });

});
