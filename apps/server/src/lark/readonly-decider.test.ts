import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import { AcpxAdapter } from '@dutydeck/acp-client';
import { RuntimeError, type AgentConfig, type CollaborationSnapshot } from '@dutydeck/shared';
import type { StoredLarkConfig } from './config.js';
import { parseParticipationResult, participationInput, ReadonlyParticipationDecider } from './readonly-decider.js';

const scope = { appId: 'cli_test', chatId: 'oc_test' };
const stamp = '2026-09-18T01:00:00.000Z';
const snapshot = (): CollaborationSnapshot => ({ scope, contextRevision: 1,
  settings: { scope, revision: 1, participation: 'selective', instructions: '简短回答', notificationsPaused: false, maxProactivePerHour: 6, retentionDays: 30, policyVersion: 'v1', updatedAt: stamp },
  observations: [{ id: 'obs_1', scope, sequence: 1, source: 'lark.message', eventId: 'om_1', occurredAt: stamp, receivedAt: stamp, senderId: 'ou_a', senderKind: 'human', messageId: 'om_1', text: '请参考新信息', refs: ['om_1'], origin: 'live', missing: [], revision: 1 }], followups: [], mandates: [] });
const config = { appId: scope.appId, defaultAgentId: 'mock', listening: true } as StoredLarkConfig;
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); });

async function harness(reply: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'participation-decider-'));
  const repositories = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const starts: AgentConfig[] = [];
  const runtime = new DutydeckRuntime(repositories, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (agent, _protocol, emit) => {
      starts.push(agent);
      return { start: async () => {}, resume: async () => {}, stop: async () => {}, interrupt: async () => {}, send: async () => {
        emit({ type: 'text', data: { text: reply } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      } } satisfies AgentDriver;
    }
  });
  await runtime.initialize([{ id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }]);
  cleanup.push(async () => { await runtime.shutdown(); repositories.close(); await rm(cwd, { force: true, recursive: true }); });
  return { cwd, runtime, repositories, starts, decider: new ReadonlyParticipationDecider({ runtime, repos: repositories, workspaceRoot: join(cwd, 'decision'), timeoutMs: 3000 }) };
}

describe('read-only participation decision', () => {
  it('uses a separate deny-all runtime task and its settled Attempt, even for a full-trust configured agent', async () => {
    const h = await harness(JSON.stringify({ action: 'reply', reason: '有新证据', evidenceIds: ['obs_1'], response: '补充材料' }));
    expect(await h.decider.decide(config, snapshot())).toMatchObject({ action: 'reply', response: '补充材料' });
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]!.permissionMode).toBe('deny-all');
    expect(h.starts[0]!.env).not.toHaveProperty('dutydeck_group_tools_token');
    expect((await h.runtime.listSessions())[0]).toMatchObject({ source: 'lark-decision', permissionMode: 'deny-all' });
  });
  it('never retries unsupported deny-all with ask or full-trust', async () => {
    const h = await harness('{}');
    const start = vi.spyOn(h.runtime, 'start').mockRejectedValue(new RuntimeError('PERMISSION_MODE_UNSUPPORTED', 'unsupported', 422));
    await expect(h.decider.decide(config, snapshot())).rejects.toMatchObject({ code: 'PERMISSION_MODE_UNSUPPORTED' });
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![0].permissionMode).toBe('deny-all');
  });
  it('strictly rejects invented evidence, arbitrary state fields, and free prose', () => {
    expect(() => parseParticipationResult('{"action":"reply","reason":"x","response":"x","evidenceIds":["foreign"]}', snapshot())).toThrow();
    expect(() => parseParticipationResult('{"action":"silent","reason":"x","evidenceIds":[],"createMandate":true}', snapshot())).toThrow();
    expect(() => parseParticipationResult('Here is the result {"action":"silent"}', snapshot())).toThrow();
    expect(() => parseParticipationResult('{"action":"reply","reason":"x","evidenceIds":[]}', snapshot())).toThrow();
  });
  it('bounds supplied text while preserving source identity and missing-material markers', () => {
    const source = snapshot(); source.observations[0]!.text = 'x'.repeat(16000);
    const bounded = participationInput(source);
    expect(bounded.observations[0]!.text).toHaveLength(4000);
    expect(bounded.observations[0]!.missing).toContain('decision_text_truncated');
    expect(bounded.observations[0]!.senderId).toBe('ou_a');
    expect(source.observations[0]!.text).toHaveLength(16000);
  });
  it('rejects an actual ACP write permission request without interactive approval and persists snake_case session options', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'participation-acp-'));
    const fixture = join(cwd, 'decision-agent.mjs');
    const original = await readFile(resolve('tests/fixtures/mock-acp-agent.mjs'), 'utf8');
    // Real protocol exchange, converting the permission result to the decision JSON contract.
    await writeFile(fixture, original.replace('`Permission: ${decision.outcome.outcome} ${JSON.stringify(decision.outcome)}`', 'JSON.stringify({action:"silent",reason:JSON.stringify(decision.outcome),evidenceIds:[]})'));
    const events: any[] = [];
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { sessionKey: 'participation_decision', onEvent: event => events.push(event) });
    cleanup.push(async () => { await adapter.stop(); await rm(cwd, { force: true, recursive: true }); });
    await adapter.start(); await adapter.send('request permission');
    const text = events.filter(event => event.type === 'text').map(event => event.data.text).join('');
    const result = parseParticipationResult(text, snapshot());
    expect(result.reason).toContain('deny');
    expect(events.some(event => event.type === 'permission_request' && event.data.status === 'pending')).toBe(false);
  });
});
