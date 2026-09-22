import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime, type AgentDriver } from '@dutydeck/runtime';
import { AcpxAdapter } from '@dutydeck/acp-client';
import { createRuntimeStore } from 'acpx/runtime';
import { RuntimeError, type AgentConfig, type CollaborationSnapshot } from '@dutydeck/shared';
import type { StoredLarkConfig } from './config.js';
import { parseParticipationResponse, parseParticipationResult, participationInput, ReadonlyParticipationDecider, type ParticipationResult } from './readonly-decider.js';

const scope = { appId: 'cli_test', chatId: 'oc_test' };
const stamp = '2026-09-18T01:00:00.000Z';
const snapshot = (): CollaborationSnapshot => ({ scope, contextRevision: 1,
  settings: { scope, revision: 1, participation: 'selective', instructions: '简短回答', notificationsPaused: false, maxProactivePerHour: 6, retentionDays: 30, policyVersion: 'v1', updatedAt: stamp },
  observations: [{ id: 'obs_1', scope, sequence: 1, source: 'lark.message', eventId: 'om_1', occurredAt: stamp, receivedAt: stamp, senderId: 'ou_a', senderKind: 'human', messageId: 'om_1', text: '请参考新信息', refs: ['om_1'], origin: 'live', missing: [], revision: 1 }], followups: [], mandates: [] });
const config = { appId: scope.appId, defaultAgentId: 'mock', listening: true } as StoredLarkConfig;
const replyDecision: ParticipationResult = { action: 'reply', reason: '有新证据', evidenceIds: ['obs_1'], updates: [] };
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const clean of cleanup.splice(0).reverse()) await clean(); vi.restoreAllMocks(); });

async function harness(reply: string | string[] | null | Error, timeoutMs = 3000) {
  const cwd = await mkdtemp(join(tmpdir(), 'participation-decider-'));
  const repositories = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
  const starts: AgentConfig[] = [];
  const drivers: AgentDriver[] = [];
  const prompts: string[] = [];
  const runtime = new DutydeckRuntime(repositories, {
    probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }),
    driverFactory: (agent, _protocol, emit) => {
      starts.push(agent);
      let stopped = false;
      const driver: AgentDriver = { start: async () => {}, resume: async () => {}, stop: async () => { stopped = true; }, isStopped: () => stopped,
        interrupt: async () => { emit({ type: 'completed', data: { stopReason: 'cancelled' } }); }, send: async prompt => {
        prompts.push(typeof prompt === 'string' ? prompt : prompt.prompt);
        if (reply instanceof Error) {
          emit({ type: 'error', data: { message: reply.message } });
          emit({ type: 'completed', data: { stopReason: 'end_turn' } });
          return;
        }
        if (reply === null) return;
        emit({ type: 'text', data: { text: Array.isArray(reply) ? reply[prompts.length - 1]! : reply } });
        emit({ type: 'completed', data: { stopReason: 'end_turn' } });
      } };
      drivers.push(driver);
      return driver;
    }
  });
  await runtime.initialize([{ id: 'mock', name: 'Mock', command: process.execPath, args: [], protocol: 'acp', cwd, env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }]);
  cleanup.push(async () => { await runtime.shutdown(); repositories.close(); await rm(cwd, { force: true, recursive: true }); });
  return { cwd, runtime, repositories, starts, drivers, prompts, decider: new ReadonlyParticipationDecider({ runtime, repos: repositories, workspaceRoot: join(cwd, 'decision'), timeoutMs }) };
}

const runPhase = (decider: ReadonlyParticipationDecider, phase: 'decision' | 'response', input = snapshot()) => phase === 'decision'
  ? decider.decide(config, input, 'obs_1')
  : decider.respond(config, input, replyDecision, 'obs_1');

describe('read-only participation decision', () => {
  it('isolates decision and response prompts in fresh deny-all sessions with settled Attempts', async () => {
    const h = await harness([JSON.stringify(replyDecision), '{"response":"  补充材料  "}']);
    const input = snapshot();
    const decision = await h.decider.decide(config, input, 'obs_1');
    expect(decision).toEqual(replyDecision);
    expect(decision).not.toHaveProperty('response');
    expect(h.starts).toHaveLength(1);
    expect(await h.decider.respond(config, input, decision, 'obs_1')).toBe('补充材料');
    expect(h.starts).toHaveLength(2);
    for (const agent of h.starts) {
      expect(agent.permissionMode).toBe('deny-all');
      expect(agent.env).not.toHaveProperty('dutydeck_group_tools_token');
      expect(agent.env).not.toHaveProperty('DUTYDECK_GROUP_TOOLS_TOKEN');
    }
    const sessions = await h.runtime.listSessions();
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map(session => session.id)).size).toBe(2);
    expect(sessions.map(session => session.source).sort()).toEqual(['lark-decision', 'lark-response']);
    expect(sessions.every(session => session.state === 'stopped' && session.permissionMode === 'deny-all')).toBe(true);
    expect(h.prompts[0]).toContain('不生成回复正文');
    expect(h.prompts[0]).not.toContain('"response"');
    expect(h.prompts[1]).toContain('只输出 JSON {"response":"回复正文"}');
    expect(h.prompts[1]).toContain(JSON.stringify(decision));
    for (const prompt of h.prompts) {
      expect(prompt).toContain('当前触发观察 id："obs_1"');
      expect(prompt).toContain(JSON.stringify(input));
      expect(prompt).toContain('不调用工具');
      expect(prompt).toContain('材料不足');
      expect(prompt).toContain('测试样本、机器人发言和计划声明不能当作已完成的工作');
    }
    expect(h.prompts[1]).toContain('不声称已执行工具、修改状态或查看快照以外的材料');
  });

  it('keeps resolve as decision-only evaluation', async () => {
    const h = await harness(JSON.stringify(replyDecision));
    const respond = vi.spyOn(h.decider, 'respond');
    expect(await h.decider.resolve(config, snapshot())).toEqual(replyDecision);
    expect(respond).not.toHaveBeenCalled();
    expect(h.starts).toHaveLength(1);
  });

  it.each(['decision', 'response'] as const)('never retries unsupported deny-all with ask or full-trust in %s', async phase => {
    const h = await harness('{}');
    const start = vi.spyOn(h.runtime, 'start').mockRejectedValue(new RuntimeError('PERMISSION_MODE_UNSUPPORTED', 'unsupported', 422));
    await expect(runPhase(h.decider, phase)).rejects.toMatchObject({ code: 'PERMISSION_MODE_UNSUPPORTED' });
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![0].permissionMode).toBe('deny-all');
  });

  it('strictly rejects invented evidence, response bodies, arbitrary state fields, and free prose', () => {
    expect(() => parseParticipationResult(JSON.stringify({ ...replyDecision, evidenceIds: ['foreign'] }), snapshot())).toThrowError(expect.objectContaining({ code: 'COLLABORATION_INVALID_EVIDENCE' }));
    expect(() => parseParticipationResult(JSON.stringify({ ...replyDecision, response: 'x' }), snapshot())).toThrow();
    expect(() => parseParticipationResult('{"action":"silent","reason":"x","evidenceIds":[],"createMandate":true}', snapshot())).toThrow();
    expect(() => parseParticipationResult('Here is the result {"action":"silent"}', snapshot())).toThrow();
    expect(() => parseParticipationResult('{"action":"reply","reason":"x","evidenceIds":[]}', snapshot())).toThrow();
    expect(() => parseParticipationResult(JSON.stringify({ ...replyDecision, updates: [{ followupId: 'f1', expectedRevision: 1, progress: 'x', evidenceIds: ['foreign'] }] }), snapshot())).toThrowError(expect.objectContaining({ code: 'COLLABORATION_INVALID_EVIDENCE' }));
  });

  it('accepts frozen team evidence for replies but never for updates or as the local trigger', async () => {
    const input = snapshot();
    const teamScope = { ...scope, chatId: 'oc_other' };
    const foreign = { ...input.observations[0]!, id: 'team_1', scope: teamScope };
    input.teamContext = { query: '我的待办', searchedAt: stamp, sources: [{ scope: teamScope, name: '项目群', status: 'complete', missing: [] }], observations: [foreign] };
    const decision = { ...replyDecision, evidenceIds: ['obs_1', 'team_1'] };
    expect(parseParticipationResult(JSON.stringify(decision), input)).toEqual(decision);
    expect(() => parseParticipationResult(JSON.stringify({ ...decision, updates: [{ followupId: 'f1', expectedRevision: 1, progress: '完成', evidenceIds: ['obs_1', 'team_1'] }] }), input)).toThrowError(expect.objectContaining({ code: 'COLLABORATION_INVALID_EVIDENCE' }));
    const h = await harness([JSON.stringify(decision), '{"response":"项目群：待审核"}']);
    await expect(h.decider.decide(config, input, 'team_1')).rejects.toMatchObject({ code: 'COLLABORATION_INVALID_TRIGGER' });
    const forged = structuredClone(input); forged.observations[0]!.scope = teamScope;
    await expect(h.decider.decide(config, forged, 'obs_1')).rejects.toMatchObject({ code: 'COLLABORATION_INVALID_TRIGGER' });
    await h.decider.decide(config, input, 'obs_1');
    await expect(h.decider.respond(config, input, decision, 'obs_1')).resolves.toBe('项目群：待审核');
    for (const prompt of h.prompts) {
      expect(prompt).toContain(JSON.stringify(input.teamContext));
      expect(prompt).toContain('不要泛称无法跨群');
      expect(prompt).toContain('不等于外部飞书任务系统');
    }
    expect(h.starts.every(agent => agent.permissionMode === 'deny-all')).toBe(true);
  });

  it('rejects reply evidence without the current trigger in both decision and response phases', async () => {
    const input = snapshot();
    input.observations.push({ ...input.observations[0]!, id: 'history_1', origin: 'history', messageId: 'om_old' });
    const unrelated = { ...replyDecision, evidenceIds: ['history_1'] };
    const h = await harness(JSON.stringify(unrelated));
    await expect(h.decider.decide(config, input, 'obs_1')).rejects.toMatchObject({ code: 'COLLABORATION_INVALID_EVIDENCE' });
    await expect(h.decider.respond(config, input, unrelated, 'obs_1')).rejects.toMatchObject({ code: 'COLLABORATION_INVALID_EVIDENCE' });
    expect(h.starts).toHaveLength(1);
    expect(parseParticipationResult(JSON.stringify({ ...replyDecision, evidenceIds: ['obs_1', 'history_1'] }), input, 'obs_1').action).toBe('reply');
  });

  it('accepts only bounded, nonblank response JSON with no state fields', () => {
    expect(parseParticipationResponse('```json\n{"response":"  回答\\n"}\n```')).toBe('回答');
    expect(parseParticipationResponse(JSON.stringify({ response: 'x'.repeat(8000) }))).toHaveLength(8000);
    for (const value of [{ response: '' }, { response: ' \n\t ' }, { response: 'x'.repeat(8001) }, { response: 1 }, { response: 'x', action: 'act' }, { response: 'x', updates: [] }]) {
      expect(() => parseParticipationResponse(JSON.stringify(value))).toThrow();
    }
    expect(() => parseParticipationResponse('Here is the result {"response":"x"}')).toThrow();
  });

  it('rejects invalid accepted decisions and non-live-human triggers before response generation', async () => {
    const h = await harness('{}');
    await expect(h.decider.respond(config, snapshot(), { ...replyDecision, action: 'act' }, 'obs_1')).rejects.toMatchObject({ code: 'COLLABORATION_INVALID_RESPONSE' });
    await expect(h.decider.respond(config, snapshot(), { ...replyDecision, evidenceIds: ['foreign'] }, 'obs_1')).rejects.toMatchObject({ code: 'COLLABORATION_INVALID_EVIDENCE' });
    await expect(h.decider.respond(config, snapshot(), replyDecision, 'om_1')).rejects.toMatchObject({ code: 'COLLABORATION_INVALID_TRIGGER' });
    for (const patch of [{ origin: 'backfill' }, { senderKind: 'agent' }, { source: 'lark.memory' }]) {
      const input = snapshot(); Object.assign(input.observations[0]!, patch);
      for (const phase of ['decision', 'response'] as const) await expect(runPhase(h.decider, phase, input)).rejects.toMatchObject({ code: 'COLLABORATION_INVALID_TRIGGER' });
    }
    expect(h.starts).toHaveLength(0);
  });

  it.each(['decision', 'response'] as const)('cleans up the %s session after invalid output, task failure, and timeout', async phase => {
    for (const output of ['not json', new Error('agent failed'), null]) {
      const h = await harness(output, output === null ? 100 : 3000);
      const stop = vi.spyOn(h.runtime, 'stop');
      const interrupt = vi.spyOn(h.runtime, 'interrupt');
      const unsubscribe = vi.fn();
      const subscribe = h.runtime.subscribe.bind(h.runtime);
      vi.spyOn(h.runtime, 'subscribe').mockImplementation((id, listener) => {
        const remove = subscribe(id, listener);
        return () => { unsubscribe(); remove(); };
      });
      const run = runPhase(h.decider, phase);
      if (output === 'not json') await expect(run).rejects.toThrow(SyntaxError);
      else await expect(run).rejects.toMatchObject({ code: 'COLLABORATION_DECISION_FAILED', message: `Decision ended with ${output === null ? 'timeout' : 'failed'}` });
      expect(stop).toHaveBeenCalledOnce();
      expect(unsubscribe).toHaveBeenCalledOnce();
      await expect(stop.mock.results[0]!.value).resolves.toBeUndefined();
      expect(await h.drivers[0]!.isStopped!()).toBe(true);
      // A missing result can retain an unresolved Attempt, while its process is already stopped.
      expect(['stopped', 'interrupted']).toContain((await h.runtime.listSessions())[0]!.state);
      if (output === null) expect(interrupt).toHaveBeenCalledOnce();
    }
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
    const adapter = new AcpxAdapter({ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: { mock_permission_probe: 'enabled' }, permissionMode: 'deny-all', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }, { sessionKey: 'participation_decision', onEvent: event => events.push(event) });
    cleanup.push(async () => { await adapter.stop(); await rm(cwd, { force: true, recursive: true }); });
    await adapter.start(); await adapter.send('request permission');
    const text = events.filter(event => event.type === 'text').map(event => event.data.text).join('');
    const result = parseParticipationResult(text, snapshot());
    expect(result.reason).toContain('deny');
    await adapter.stop();
    const persisted = await createRuntimeStore({ stateDir: join(cwd, '.dutydeck', 'acpx') }).load('participation_decision');
    expect(persisted?.acpx?.session_options?.env).toEqual({ mock_permission_probe: 'enabled' });
    expect(Object.keys(persisted!.acpx!.session_options!).every(key => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))).toBe(true);
    expect(persisted?.acpx?.session_options?.env ?? {}).not.toHaveProperty('dutydeck_group_tools_token');
    expect(events.some(event => event.type === 'permission_request' && event.data.status === 'pending')).toBe(false);
  });

  it('runs both phases through the real runtime and AcpxAdapter without interactive permission or shared sessions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'participation-runtime-acp-'));
    const fixture = join(cwd, 'phase-agent.mjs');
    const original = await readFile(resolve('tests/fixtures/mock-acp-agent.mjs'), 'utf8');
    await writeFile(fixture, original.replace('`Permission: ${decision.outcome.outcome} ${JSON.stringify(decision.outcome)}`', 'JSON.stringify(prompt.includes("群回复生成器") ? {response:JSON.stringify(decision.outcome)} : {action:"reply",reason:JSON.stringify(decision.outcome),evidenceIds:["obs_1"]})'));
    const repositories = createRepositories(join(cwd, 'state.db'), { newDatabaseAuthority: 'ledger_v1' });
    const runtime = new DutydeckRuntime(repositories, { probe: () => ({ protocol: 'acp', available: true, pause: false, resume: true }) });
    cleanup.push(async () => { await runtime.shutdown(); repositories.close(); await rm(cwd, { force: true, recursive: true }); });
    await runtime.initialize([{ id: 'mock', name: 'Mock', command: process.execPath, args: [fixture], protocol: 'acp', cwd, env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }]);
    const decider = new ReadonlyParticipationDecider({ runtime, repos: repositories, workspaceRoot: join(cwd, 'decision'), timeoutMs: 5000 });
    const events: any[] = [];
    const subscribe = runtime.subscribe.bind(runtime);
    vi.spyOn(runtime, 'subscribe').mockImplementation((id, listener) => subscribe(id, event => { events.push(event); listener(event); }));
    const input = snapshot(); input.observations[0]!.text = 'request permission';
    const decision = await decider.decide(config, input, 'obs_1');
    expect(decision.reason).toContain('deny');
    expect(await decider.respond(config, input, decision, 'obs_1')).toContain('deny');
    const sessions = await runtime.listSessions();
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map(session => session.id)).size).toBe(2);
    expect(sessions.every(session => session.state === 'stopped' && session.permissionMode === 'deny-all')).toBe(true);
    expect(events.some(event => event.type === 'permission_request' && event.data.status === 'pending')).toBe(false);
    expect(events.filter(event => event.type === 'task' && event.data.task?.status === 'completed')).toHaveLength(2);
  });
});
