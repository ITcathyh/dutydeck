import { RuntimeError, type AgentConfig, type AgentDriver, type DriverCreateInput, type DriverProvider, type Session } from '@dutydeck/shared';
import { probeAgent } from '@dutydeck/shared/execution';
import type { RuntimeHost } from './host-ports.js';

export class DriverRegistry {
  private readonly providers = new Map<string, DriverProvider>();
  private unversioned?: DriverProvider;
  private readonly operations = new WeakMap<AgentDriver, ReadonlySet<keyof AgentDriver>>();

  constructor(providers: readonly DriverProvider[] | undefined, private readonly host: RuntimeHost) {
    if (!providers?.length) throw new RuntimeError('RUNTIME_DRIVER_PROVIDERS_REQUIRED', 'Supply driver providers when constructing the runtime', 500);
    for (const provider of providers) {
      if (this.providers.has(provider.protocol)) throw new Error(`Duplicate driver provider: ${provider.protocol}`);
      this.providers.set(provider.protocol, provider);
      if (provider.unversionedSessionResources) {
        if (this.unversioned) throw new Error('Multiple driver providers for sessions without a protocol');
        this.unversioned = provider;
      }
    }
  }

  for(protocol: string | undefined) { return protocol == null ? this.unversioned : this.providers.get(protocol); }
  capabilities(protocol: string | undefined, agent?: AgentConfig) { return this.for(protocol)?.capabilities(agent); }
  controlled(protocol: string | undefined) {
    const provider = this.for(protocol);
    if (!provider) throw new RuntimeError('DRIVER_UNAVAILABLE', `No driver provider for ${protocol}`, 503);
    const custom = this.host.launch.driverFactory;
    if (custom) return !!custom.controlledResources?.(protocol!);
    return (protocol == null ? provider.unversionedSessionResources : provider.resourceProtocol) === 'controlled';
  }
  readNativeCreationRecord(session: Session) {
    return this.for(session.protocol)?.readNativeCreationRecord
      ?? Array.from(this.providers.values()).find(provider => provider.readNativeCreationRecord)?.readNativeCreationRecord;
  }
  probe(agent: AgentConfig) {
    const probe = this.host.launch.probe ?? this.for(agent.protocol)?.probe ?? probeAgent;
    return probe(agent, this.host.launch.acpxCommand);
  }
  supports<K extends keyof AgentDriver>(driver: AgentDriver | undefined, key: K): driver is AgentDriver & Required<Pick<AgentDriver, K>> {
    if (!driver) return false;
    return this.operations.get(driver)?.has(key) ?? typeof driver[key] === 'function';
  }
  method<K extends Exclude<keyof AgentDriver, 'resourceCapabilities'>>(driver: AgentDriver | undefined, key: K): AgentDriver[K] | undefined {
    if (!this.supports(driver, key)) return undefined;
    const method: (...args: never[]) => unknown = driver[key]!;
    return method.bind(driver) as AgentDriver[K];
  }
  foregroundIdle(driver: AgentDriver): boolean {
    const quiescence = this.method(driver, 'quiescence');
    return quiescence ? quiescence().state === 'idle' : this.method(driver, 'isIdle')?.() === true;
  }
  create(agent: AgentConfig, session: Session, onEvent: DriverCreateInput['onEvent'], onExit: DriverCreateInput['onExit'], context: DriverCreateInput['context']) {
    const provider = this.for(session.protocol);
    if (!provider) throw new RuntimeError('DRIVER_UNAVAILABLE', `No driver provider for ${session.protocol}`, 503);
    const capabilities = provider.capabilities(agent);
    const terminal = capabilities.persistentTerminal;
    const custom = this.host.launch.driverFactory ?? (terminal && this.host.launch.ptyDriverFactory);
    if (custom) {
      if (terminal) agent = { ...agent, env: { ...agent.env, dutydeck_terminal_backend: session.terminalBackend ?? 'tmux',
        ...(!this.host.launch.driverFactory && { dutydeck_session_id: session.id }) } };
      return custom(agent, session.protocol!, onEvent, onExit, session.id, context);
    }
    const driver = provider.create({ agent, session, context, onEvent, onExit, log: this.host.log,
      resolveRiskPolicy: this.host.policy.riskPolicy && (fallback => this.host.policy.riskPolicy!(session.id, fallback)),
      awaitingAnswer: this.host.awaitingAnswer && (() => !!this.host.awaitingAnswer!(session.id)),
    });
    this.operations.set(driver, new Set(capabilities.operations));
    return driver;
  }
}
