import { describe, expect, it } from 'vitest';
import { canSaveHardGate, canToggleHardGate, type HardGateFormState } from './lark-config-form';

const state = (overrides: Partial<HardGateFormState> = {}): HardGateFormState => ({
  enabled: false,
  persisted: false,
  agentSelectionSaved: true,
  hookInstalled: false,
  ...overrides
});

describe('hard gate form state', () => {
  it('does not block unrelated saves when a persisted hook is no longer installed', () => {
    const missingPersistedHook = state({ enabled: true, persisted: true });

    expect(canSaveHardGate(missingPersistedHook)).toBe(true);
    expect(canToggleHardGate(missingPersistedHook)).toBe(true);
  });

  it('allows an enabled hard gate to be turned off even when its hook is missing', () => {
    expect(canToggleHardGate(state({ enabled: true }))).toBe(true);
    expect(canSaveHardGate(state({ enabled: false, persisted: true }))).toBe(true);
  });

  it('requires an installed hook before enabling a new hard gate', () => {
    expect(canToggleHardGate(state())).toBe(false);
    expect(canSaveHardGate(state({ enabled: true }))).toBe(false);
    expect(canToggleHardGate(state({ hookInstalled: true }))).toBe(true);
    expect(canSaveHardGate(state({ enabled: true, hookInstalled: true }))).toBe(true);
  });

  it('does not carry a persisted hard gate across an unsaved Agent selection', () => {
    expect(canSaveHardGate(state({ enabled: true, persisted: true, agentSelectionSaved: false }))).toBe(false);
  });
});
