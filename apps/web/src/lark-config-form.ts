export type HardGateFormState = {
  enabled: boolean;
  persisted: boolean;
  agentSelectionSaved: boolean;
  hookInstalled: boolean;
};

export function canSaveHardGate(state: HardGateFormState): boolean {
  if (!state.enabled) return true;
  if (!state.agentSelectionSaved) return false;
  return state.persisted || state.hookInstalled;
}

export function canToggleHardGate(state: HardGateFormState): boolean {
  return state.enabled || (state.agentSelectionSaved && state.hookInstalled);
}
