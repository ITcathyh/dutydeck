import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import type { AgentConfig, Session, TaskRequestV1 } from '@dutydeck/shared';
import { parseUsageBackgroundLimits, UsageLedger } from './usage-ledger.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const request = (session: Session, key: string, namespace = 'runtime'): TaskRequestV1 => ({ version: 1, namespace, key, sessionId: session.id, actor: { kind: 'unspecified' }, prompt: key, mode: 'queue', skills: [], options: {}, sources: [], sourcePayload: {} });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'usage-background-'));
  const dbPath = join(directory, 'state.sqlite');
  let repos = createRepositories(dbPath, { newDatabaseAuthority: 'ledger_v1' });
  let ledger = new UsageLedger({ repositories: repos, backgroundLimits: { bots: { cli_a: 1 } } });
  const sent: string[] = [];
  const agent: AgentConfig = { id: 'local', name: 'Local fixture', command: process.execPath, args: [], cwd: directory, env: {}, protocol: 'acp', model: 'unknown-model', permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  const runtime = () => new DutydeckRuntime(repos, { cleanupIntervalMs: 0, probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }), admitTask: (session, input) => ledger.admit(session, input), recordUsage: (session, attempt, data) => ledger.record(session, attempt, data),
    driverFactory: (_agent, _protocol, emit) => ({ start: async () => {}, resume: async () => {}, stop: async () => {}, isStopped: async () => true, interrupt: async () => {}, send: async prompt => {
      sent.push(prompt); emit({ type: 'text', data: { text: 'local fixture' } }); emit({ type: 'completed', data: { stopReason: 'end_turn' } });
    } }) });
  let active = runtime(); await active.initialize([agent]);
  cleanup.push(async () => { await active.shutdown(); repos.close(); await rm(directory, { recursive: true, force: true }); });
  return { sent, get repos() { return repos; }, get ledger() { return ledger; }, get runtime() { return active; },
    reopen: async () => { await active.shutdown(); repos.close(); repos = createRepositories(dbPath); ledger = new UsageLedger({ repositories: repos, backgroundLimits: { bots: { cli_a: 1 } } }); active = runtime(); await active.initialize([agent]); } };
}

describe('automatic task allowance in the real Runtime admit chain', () => {
  it('blocks a second background task, preserves replay across restart, and admits explicit work', async () => {
    const h = await fixture();
    const background = await h.runtime.start({ agentId: 'local', source: 'lark-memory', sourceId: 'cli_a:groups:memory' });
    const original = request(background, 'first');
    await h.ledger.admit(background, original);
    await h.ledger.admit(background, original);
    const result = await h.runtime.send(background.id, original.prompt, original.prompt, undefined, undefined, [], original);
    expect(result.status).toBe('completed');
    expect(await h.ledger.automaticRefusal('cli_a')).toContain('已达 1 次上限');
    expect(await h.ledger.automaticRefusal('cli_a')).toContain('已达 1 次上限');
    await expect(h.runtime.send(background.id, 'blocked')).rejects.toMatchObject({ code: 'USAGE_BACKGROUND_CAP_EXCEEDED' });
    expect(h.sent).toEqual(['first']);
    const summary = await h.ledger.summary();
    expect(summary.backgroundBudget.usage).toEqual([{ appId: 'cli_a', tasks: 1 }]);
    expect(summary.month.totals).toMatchObject({ unavailable: 1, unknownCostEntries: 1, costCoverage: 0 });
    await h.reopen();
    await h.ledger.admit(background, original);
    const replay = await h.runtime.send(background.id, original.prompt, original.prompt, undefined, undefined, [], original);
    expect(replay.id).toBe(result.id);
    const another = await h.runtime.start({ agentId: 'local', source: 'lark-decision', sourceId: 'cli_a:oc_group' });
    await expect(h.runtime.send(another.id, 'blocked-after-restart')).rejects.toMatchObject({ code: 'USAGE_BACKGROUND_CAP_EXCEEDED' });
    const explicit = await h.runtime.start({ agentId: 'local', source: 'lark', sourceId: 'cli_a:oc_group:group' });
    expect((await h.runtime.send(explicit.id, 'human request', 'human request', undefined, 'installation_owner')).status).toBe('completed');
    expect(h.sent).toEqual(['first', 'human request']);
  });

  it('covers scheduled/proactive tasks conservatively, but leaves explicit requests and root substeps alone', async () => {
    const h = await fixture();
    const session = await h.runtime.start({ agentId: 'local', source: 'lark', sourceId: 'cli_a:oc_group:group' });
    const ledger = new UsageLedger({ repositories: h.repos, backgroundLimits: { defaultMonthlyTasks: 0 }, isProactive: async () => true });
    await expect(ledger.admit(session, request(session, 'scheduled', 'schedule'))).rejects.toMatchObject({ code: 'USAGE_BACKGROUND_CAP_EXCEEDED' });
    await expect(ledger.admit(session, request(session, 'lark:cli_a:message:1'))).rejects.toMatchObject({ code: 'USAGE_BACKGROUND_CAP_EXCEEDED' });
    await expect(ledger.admit(session, request(session, 'direct'))).resolves.toBeUndefined();
    await expect(ledger.admit({ ...session, source: 'work_item' }, request(session, 'step', 'work_item'))).resolves.toBeUndefined();
    const defaultOff = new UsageLedger({ repositories: h.repos });
    await expect(defaultOff.admit(session, request(session, 'scheduled', 'schedule'))).resolves.toBeUndefined();
    expect(await defaultOff.automaticRefusal('cli_a')).toBeUndefined();
  });

  it('validates explicit configuration without silently enabling a default', () => {
    expect(parseUsageBackgroundLimits()).toEqual({});
    expect(parseUsageBackgroundLimits('{"defaultMonthlyTasks":1000,"bots":{"cli_a":0}}')).toEqual({ defaultMonthlyTasks: 1000, bots: { cli_a: 0 } });
    for (const json of ['{"defaultMonthlyTasks":-1}', '{"bots":{"cli_a":1.5}}', '{"unexpected":2}']) expect(() => parseUsageBackgroundLimits(json)).toThrow();
  });
});
