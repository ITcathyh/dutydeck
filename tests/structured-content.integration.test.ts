import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { createRepositories } from '@dutydeck/storage';
import { canonicalExecutionJson, extractEventArtifactReferences, type AgentConfig } from '@dutydeck/shared';

it('preserves ACP non-text parts from the real adapter through ledger settlement and a database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-content-chain-'));
  const path = join(directory, 'state.sqlite');
  const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, cleanupIntervalMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }) });
  const agent: AgentConfig = { id: 'mock-content', name: 'Mock ACP', command: process.execPath, args: [resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp', cwd: directory, env: {}, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  try {
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id, cwd: directory });
    const task = await runtime.send(session.id, 'structured content fixture');
    expect(task.status).toBe('completed');
    const attempt = repos.execution.getTaskExecution(task.id)!.currentAttempt!;
    const canonical = repos.execution.getAttemptEvents(attempt.attemptId, { afterSequence: 0, limit: 200 });
    const messages = canonical.filter(event => event.type === 'text' && (event.data as any).role !== 'user');
    expect(messages.map(event => (event.data as any).parts[0].type)).toEqual(['image', 'resource', 'resource_link']);
    const expected = canonicalExecutionJson(messages.map(event => ({ id: event.id, sequence: event.sequence, text: (event.data as any).text, parts: (event.data as any).parts })));
    expect(attempt.settlement).toMatchObject({ kind: 'driver_result', outcome: 'completed', outputDigest: createHash('sha256').update(expected, 'utf8').digest('hex') });
    const refs = canonical.flatMap(extractEventArtifactReferences);
    expect(refs).toHaveLength(4);
    expect(refs.every(ref => ref.taskId === task.id && ref.attemptId === attempt.attemptId)).toBe(true);
    expect(JSON.stringify(refs)).not.toMatch(/YWJj|<h1>/);
    await runtime.shutdown(); repos.close();
    const reopened = createRepositories(path);
    try {
      expect(reopened.execution.getAttemptEvents(attempt.attemptId, { afterSequence: 0, limit: 200 })).toEqual(canonical);
      expect(reopened.execution.getTaskExecution(task.id)?.currentAttempt?.settlement).toEqual(attempt.settlement);
    } finally { reopened.close(); }
  } finally {
    await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

it('preserves a single pure text reply larger than 256 KiB through the real ACP adapter, ledger digest and database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-large-text-chain-'));
  const path = join(directory, 'state.sqlite');
  const repos = createRepositories(path, { newDatabaseAuthority: 'ledger_v1' });
  const runtime = new DutydeckRuntime(repos, { driverIdleTimeoutMs: 0, cleanupIntervalMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }) });
  const agent: AgentConfig = { id: 'mock-large-text', name: 'Mock ACP', command: process.execPath, args: [resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')], protocol: 'acp', cwd: directory, env: {}, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  try {
    await runtime.initialize([agent]);
    const session = await runtime.start({ agentId: agent.id, cwd: directory });
    const task = await runtime.send(session.id, 'large plain content fixture');
    expect(task.status).toBe('completed');
    const attempt = repos.execution.getTaskExecution(task.id)!.currentAttempt!;
    const events = repos.execution.getAttemptEvents(attempt.attemptId, { afterSequence: 0, limit: 200 });
    const messages = events.filter(event => event.type === 'text' && (event.data as any).role !== 'user');
    const text = 'Large start ' + '字'.repeat(100_000) + ' Large end';
    expect(Buffer.byteLength(text)).toBeGreaterThan(256 * 1024);
    expect(messages).toHaveLength(1);
    expect((messages[0]!.data as any).text).toBe(text);
    expect((messages[0]!.data as any).parts).toBeUndefined();
    expect(attempt.settlement).toMatchObject({ kind: 'driver_result', outcome: 'completed', outputDigest: createHash('sha256').update(text, 'utf8').digest('hex') });
    await runtime.shutdown(); repos.close();
    const reopened = createRepositories(path);
    try {
      expect(reopened.execution.getAttemptEvents(attempt.attemptId, { afterSequence: 0, limit: 200 })).toEqual(events);
      expect(reopened.execution.getTaskExecution(task.id)?.currentAttempt?.settlement).toEqual(attempt.settlement);
    } finally { reopened.close(); }
  } finally { await runtime.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); }
}, 20_000);
