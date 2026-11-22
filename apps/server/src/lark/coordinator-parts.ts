import { CoordinatorState } from './coordinator-state.js';
import { LarkCoordinatorCore } from './coordinator-core.js';
import { LarkCoordinatorCards } from './coordinator-cards.js';
import { LarkCoordinatorRecovery } from './coordinator-recovery.js';
import { LarkCoordinatorDispatch } from './coordinator-dispatch.js';
import { LarkCoordinatorInbound } from './coordinator-inbound.js';

export interface CoordinatorParts {
  state: CoordinatorState;
  core: LarkCoordinatorCore;
  cards: LarkCoordinatorCards;
  reconcile: LarkCoordinatorRecovery;
  runner: LarkCoordinatorDispatch;
  intake: LarkCoordinatorInbound;
}

export function createCoordinatorParts(...args: ConstructorParameters<typeof CoordinatorState>): CoordinatorParts {
  const state = new CoordinatorState(...args);
  // 恢复会重新派发，派发也会唤醒对账。回调在使用时取同一实例的部件。
  const parts: CoordinatorParts = {
    state,
    get core() { return core; },
    get cards() { return cards; },
    get reconcile() { return reconcile; },
    get runner() { return intake; },
    get intake() { return intake; },
  };
  const core = new LarkCoordinatorCore(state, parts);
  const cards = new LarkCoordinatorCards(state, parts);
  const reconcile = new LarkCoordinatorRecovery(state, parts);
  const intake = new LarkCoordinatorInbound(state, parts);
  return parts;
}
