import { CoordinatorState } from './coordinator-state.js';
import { LarkCoordinatorCore } from './coordinator-core.js';
import { LarkCoordinatorCards } from './coordinator-cards.js';
import { LarkCoordinatorRecovery } from './coordinator-recovery.js';
import { LarkCoordinatorDispatch } from './coordinator-dispatch.js';
import { LarkCoordinatorInbound } from './coordinator-inbound.js';
import { LarkSessionRouting } from './coordinator-routing.js';

export interface CoordinatorParts {
  state: CoordinatorState;
  core: LarkCoordinatorCore;
  cards: LarkCoordinatorCards;
  reconcile: LarkCoordinatorRecovery;
  runner: LarkCoordinatorDispatch;
  intake: LarkCoordinatorInbound;
  routing: LarkSessionRouting;
}

export function createCoordinatorParts(...args: ConstructorParameters<typeof CoordinatorState>): CoordinatorParts {
  const state = new CoordinatorState(...args);
  // 恢复与派发会相互唤醒；构造时只延迟引用尚未创建的部件。
  const core: LarkCoordinatorCore = new LarkCoordinatorCore(state, {
    get cards() { return cards; },
  });
  const cards: LarkCoordinatorCards = new LarkCoordinatorCards(state, {
    core,
    get intake() { return intake; },
  });
  const reconcile: LarkCoordinatorRecovery = new LarkCoordinatorRecovery(state, {
    core,
    cards,
    get runner() { return runner; },
    get routing() { return routing; },
    get intake() { return intake; },
  });
  const runner: LarkCoordinatorDispatch = new LarkCoordinatorDispatch(state, {
    core,
    cards,
    reconcile,
    get routing() { return routing; },
    get intake() { return intake; },
  });
  const routing: LarkSessionRouting = new LarkSessionRouting(state, {
    core,
    reconcile,
    runner,
  });
  const intake: LarkCoordinatorInbound = new LarkCoordinatorInbound(state, {
    core,
    cards,
    reconcile,
    runner,
    routing,
  });
  return { state, core, cards, reconcile, runner, routing, intake };
}
