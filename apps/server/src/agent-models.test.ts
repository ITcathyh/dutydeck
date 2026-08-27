import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AcpRuntime } from 'acpx/runtime';
import { AgentModelProbeTimeoutError, modelsFromAcpStatus, probeModelsThroughAcpRuntime } from './agent-models.js';

const probeInput = { sessionKey: 'probe', agent: 'codex', mode: 'oneshot' as const };
const handle = { sessionKey: 'probe', backend: 'acpx', runtimeSessionName: 'probe', acpxRecordId: 'probe-record' };

function runtime(overrides: Partial<AcpRuntime>): AcpRuntime {
  return {
    ensureSession: vi.fn(async () => handle),
    startTurn: vi.fn(),
    runTurn: vi.fn(),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides
  } as AcpRuntime;
}

describe('ACP-first Agent model discovery', () => {
  it('uses Agent-advertised model identifiers and display names', () => {
    expect(modelsFromAcpStatus({
      models: { currentModelId: 'model-a', availableModelIds: ['model-a', 'model-b'] },
      details: { configOptions: [
        { id: 'model', category: 'model', options: [{ value: 'model-a', name: 'Model A' }, { value: 'model-b', name: 'Model B' }] },
        { id: 'effort', category: 'thought_level', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }] }
      ] }
    })).toEqual({ models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }], defaultModel: 'model-a', reasoningEfforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }], defaultReasoningEffort: 'medium', source: 'acp' });
  });

  it('bounds a stalled ensureSession instead of leaving the HTTP request pending', async () => {
    const close = vi.fn(async () => undefined);
    const target = runtime({ ensureSession: vi.fn(() => new Promise(() => undefined)), close });
    await expect(probeModelsThroughAcpRuntime(target, probeInput, 10)).rejects.toEqual(expect.objectContaining<Partial<AgentModelProbeTimeoutError>>({ name: 'AgentModelProbeTimeoutError', phase: 'ensureSession' }));
    expect(close).not.toHaveBeenCalled();
  });

  it('closes the probe child when getStatus stalls', async () => {
    const close = vi.fn(async () => undefined);
    const target = runtime({ getStatus: vi.fn(() => new Promise(() => undefined)), close });
    await expect(probeModelsThroughAcpRuntime(target, probeInput, 10)).rejects.toEqual(expect.objectContaining<Partial<AgentModelProbeTimeoutError>>({ phase: 'getStatus' }));
    expect(close).toHaveBeenCalledWith({ handle, reason: 'Dockmux model discovery', discardPersistentState: true });
  });

  it('bounds close cleanup and still returns the model fallback', async () => {
    const target = runtime({
      getStatus: vi.fn(async () => ({ models: { currentModelId: 'codex', availableModelIds: ['codex'] } })),
      close: vi.fn(() => new Promise(() => undefined))
    });
    await expect(probeModelsThroughAcpRuntime(target, probeInput, 10)).resolves.toMatchObject({ defaultModel: 'codex', source: 'acp' });
  });

  it('patches acpx ensureSession initialization with its configured timeout', () => {
    const patch = readFileSync(new URL('../../../patches/acpx@0.13.0.patch', import.meta.url), 'utf8');
    const buildScript = readFileSync(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
    expect(patch).toContain('await withTimeout(client.start(), this.options.timeoutMs)');
    expect(buildScript).toContain("fileURLToPath(import.meta.resolve('acpx/runtime'))");
  });
});
