import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { canonicalExecutionJson, type AgentDriver, type RepositoryBundle, type RuntimeControlClaim } from '@dutydeck/shared';
import { DriverConfigurationLedger, eventJson, LocalDriverLedger } from './ledger.js';

const opened: Array<{ repos: RepositoryBundle; claim: RuntimeControlClaim }> = [];
afterEach(() => { for (const { repos, claim } of opened.splice(0)) { claim.release(); repos.close(); } });
function ledger() {
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const claim = repos.control.attachRuntime('resource-test'); opened.push({ repos, claim });
  const bound = repos.execution.bind(claim);
  const fence = { sessionId: 'session', runId: 'run' };
  bound.createSession({ id: fence.sessionId, runId: fence.runId, agentId: 'agent', state: 'idle', cwd: '/tmp', createdAt: '2026-09-14T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z' });
  return { repos, claim, bound, fence, local: new LocalDriverLedger(() => bound, repos.execution) };
}
function driver(): AgentDriver {
  return { start: async () => {}, send: async () => {}, stop: async () => {}, interrupt: async () => {}, resume: async () => {}, isStopped: async () => true };
}

describe('driver local resource ownership', () => {
  it('persists parent and child before returning a creation permit', () => {
    const { repos, local, fence } = ledger();
    const permit = local.begin(fence, { permissionMode: 'ask' });
    const resources = repos.execution.getResources(fence.sessionId);
    expect(resources.map(row => [row.resourceId, row.kind, row.stage])).toEqual([[permit.operationId, 'operation', 'pending'], [permit.resourceId, 'local_only', 'pending']]);
    expect(resources[1]?.parentResourceId).toBe(permit.operationId);
    expect(repos.execution.getSessionResourceBlockers(fence.sessionId)).toHaveLength(2);
  });
  it('does not finish an outstanding start or make it reusable just because the factory returned', () => {
    const { repos, local, fence } = ledger(); const original = driver();
    local.returned(local.begin(fence, { permissionMode: 'ask' }), original);
    expect(() => local.ready(original)).toThrow(/creation has not finished/);
    expect(() => local.gone(original)).toThrow(/creation has not finished/);
    expect(local.reusableIds(fence.sessionId).size).toBe(0);
    expect(repos.execution.getResources(fence.sessionId).every(row => row.stage === 'pending')).toBe(true);
    local.settled(original); local.ready(original);
    expect(local.reusableIds(fence.sessionId).size).toBe(1);
    expect(repos.execution.getResources(fence.sessionId).every(row => row.stage === 'created')).toBe(true);
  });
  it('retains the returned original handle if identity persistence fails', () => {
    const { bound, local, fence } = ledger(); const original = driver();
    const permit = local.begin(fence, { permissionMode: 'ask' });
    const fault = vi.spyOn(bound, 'spawned').mockImplementationOnce(() => { throw new Error('disk write rejected'); });
    expect(() => local.returned(permit, original)).toThrow('disk write rejected');
    expect(local.get(original)).toBe(permit);
    fault.mockRestore(); local.settled(original); local.gone(original);
    expect(local.reusableIds(fence.sessionId).size).toBe(0);
  });
  it('leaves live local_only blocked for a newly attached controller', () => {
    const { repos, claim, local, fence } = ledger(); const original = driver();
    local.returned(local.begin(fence, { permissionMode: 'ask' }), original); local.settled(original); local.ready(original);
    claim.release(); const next = repos.control.attachRuntime('new-runtime'); opened[opened.length - 1]!.claim = next;
    const newLocal = new LocalDriverLedger(() => repos.execution.bind(next), repos.execution);
    expect(newLocal.reusableIds(fence.sessionId).size).toBe(0);
    expect(repos.execution.getSessionResourceBlockers(fence.sessionId).map(row => row.code)).toContain('DRIVER_RESOURCE_UNSAFE');
    expect(() => newLocal.begin(fence, { permissionMode: 'ask' })).toThrow(expect.objectContaining({ code: 'SESSION_RESOURCE_BLOCKED' }));
  });
});

describe('finite event JSON', () => {
  it('omits undefined object fields while preserving null and array order', () => {
    expect(eventJson({ text: 'done', optional: undefined, nested: { empty: null }, values: [2, 1] })).toEqual({ text: 'done', nested: { empty: null }, values: [2, 1] });
    expect(() => canonicalExecutionJson({ optional: undefined })).toThrow();
  });
  it('rejects accessors without invoking them, including arrays and hidden toJSON', () => {
    const getter = vi.fn(() => 'value');
    const array = [0]; Object.defineProperty(array, '0', { get: getter });
    const object = Object.defineProperty({}, 'field', { get: getter, enumerable: true });
    const hidden = Object.defineProperty({}, 'toJSON', { get: getter });
    for (const value of [array, object, hidden]) expect(() => eventJson(value)).toThrow(/Event/);
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects cycles, functions, holes and invalid numeric values', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of [cycle, { f() {} }, [undefined], new Array(2), NaN, Infinity, new Date()]) expect(() => eventJson(value)).toThrow(/Event/);
  });
});

describe('persistent native configuration ownership', () => {
  it('treats a previous controller pending record as unknown and never clears it on a new local instance', async () => {
    const { repos } = ledger(); const first = new DriverConfigurationLedger(repos.config);
    const operation = await first.begin('session', 'driver-one', { permissionMode: 'ask', model: 'B' });
    const raw = await repos.config.get('runtime_driver_configuration:session');
    expect(JSON.parse(raw!)).toMatchObject({ operationId: operation.operationId, driverIdentity: 'driver-one', state: 'pending' });
    await expect(first.assertClear('session')).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_BUSY' });
    const second = new DriverConfigurationLedger(repos.config);
    await expect(second.assertClear('session')).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_UNKNOWN' });
    expect(await repos.config.get('runtime_driver_configuration:session')).toBe(raw);
  });
  it('refuses overlapping configuration operations and stale successful completion cannot clear unknown evidence', async () => {
    const { repos } = ledger(); const configs = new DriverConfigurationLedger(repos.config);
    const original = await configs.begin('session', 'driver-one', { permissionMode: 'ask', model: 'B' });
    await expect(configs.begin('session', 'driver-two', { permissionMode: 'ask', model: 'C' })).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_BUSY' });
    await configs.finish(original, true);
    const later = await configs.begin('session', 'driver-two', { permissionMode: 'ask', model: 'C' });
    await configs.finish(later, false); const unknown = await repos.config.get('runtime_driver_configuration:session');
    await expect(configs.finish(original, true)).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_UNKNOWN' });
    expect(await repos.config.get('runtime_driver_configuration:session')).toBe(unknown);
    await expect(configs.begin('session', 'driver-two', { permissionMode: 'ask' })).rejects.toMatchObject({ code: 'DRIVER_CONFIGURATION_UNKNOWN' });
  });
});
