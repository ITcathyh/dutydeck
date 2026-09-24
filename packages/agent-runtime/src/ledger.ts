import { createHash } from 'node:crypto';
import { ControlledDriverResources, localOnlyDriverContext } from './driver-context.js';
import type { AcceptedTaskInputV2, AgentDriver, BoundExecutionRepository, DriverResource, ExecutionRepository, JsonValue, ResourceRef, SessionFence } from '@dutydeck/shared';
import { canonicalExecutionJson, makeId, now, RuntimeError } from '@dutydeck/shared';

export type ExecutionOptions = AcceptedTaskInputV2['executionOptions'];
export const digest = (value: unknown) => createHash('sha256').update(canonicalExecutionJson(value)).digest('hex');

/** Event payloads may omit optional object fields; request JSON never uses this conversion. */
export function eventJson(value: unknown): JsonValue {
  const seen = new Set<object>();
  const convert = (item: unknown): JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || seen.has(item)) throw new RuntimeError('EVENT_INVALID_JSON', 'Event payload is not finite JSON', 422);
    seen.add(item);
    try {
      if (Object.getOwnPropertySymbols(item).length) throw new RuntimeError('EVENT_INVALID_JSON', 'Event payload contains symbols', 422);
      if (Array.isArray(item)) {
        if (Reflect.ownKeys(item).length !== item.length + 1) throw new RuntimeError('EVENT_INVALID_JSON', 'Event arrays must be dense', 422);
        return Array.from({ length: item.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !('value' in descriptor)) throw new RuntimeError('EVENT_INVALID_JSON', 'Event payload contains an accessor', 422);
          return convert(descriptor.value);
        });
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new RuntimeError('EVENT_INVALID_JSON', 'Event objects must be plain JSON', 422);
      const result: Record<string, JsonValue> = {};
      for (const key of Object.getOwnPropertyNames(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !('value' in descriptor)) throw new RuntimeError('EVENT_INVALID_JSON', 'Event payload contains an accessor or hidden field', 422);
        if (descriptor.value !== undefined) Object.defineProperty(result, key, { value: convert(descriptor.value), enumerable: true, writable: true, configurable: true });
      }
      return result;
    } finally { seen.delete(item); }
  };
  return convert(value);
}

export interface OwnedDriver {
  fence: SessionFence;
  operationId: string;
  resourceId: string;
  identityId: string;
  driver?: AgentDriver;
  options: ExecutionOptions;
  creationSettled: boolean;
  controlled?: ControlledDriverResources;
  context: import('@dutydeck/shared').DriverContext;
}

/** This registry proves only this Runtime's original adapter, never a reopened local_only resource. */
export class LocalDriverLedger {
  private readonly records = new Map<AgentDriver, OwnedDriver>();
  constructor(private readonly execution: () => BoundExecutionRepository, private readonly repository: ExecutionRepository) {}
  begin(fence: SessionFence, options: ExecutionOptions, controlled?: {valid():boolean;executionDomain:string;repairConfiguration?:boolean;startupValid?():boolean}): OwnedDriver {
    if (controlled) {
      const resources=new ControlledDriverResources(fence,this.execution,this.repository,controlled.valid,controlled.executionDomain,controlled.repairConfiguration,controlled.startupValid);
      return {fence,operationId:resources.driverInstanceId,resourceId:resources.driverInstanceId,identityId:resources.driverInstanceId,options:{...options},creationSettled:false,controlled:resources,context:resources.context};
    }
    const operationId = makeId('driver_operation'), resourceId = makeId('driver_resource');
    this.execution().beforeCreate(fence, { resourceId: operationId, kind: 'operation' });
    this.execution().beforeCreate(fence, { resourceId, parentResourceId: operationId, kind: 'local_only' });
    return { fence, operationId, resourceId, identityId: makeId('driver_identity'), options: { ...options }, creationSettled: false, context:localOnlyDriverContext(fence,resourceId) };
  }
  returned(record: OwnedDriver, driver: AgentDriver) {
    record.driver = driver;
    this.records.set(driver, record); // Retain the original handle before any persistence can throw.
    if (!record.controlled) this.identify(record);
  }
  get(driver: AgentDriver) { return this.records.get(driver); }
  private row(record: OwnedDriver, id: string): DriverResource {
    const row = this.repository.getResources(record.fence.sessionId).find(resource => resource.resourceId === id);
    if (!row) throw new RuntimeError('DRIVER_RESOURCE_MISSING', 'The driver resource ledger is missing', 409);
    return row;
  }
  private identify(record: OwnedDriver) {
    const row = this.row(record, record.resourceId);
    if (!row.identity) this.execution().spawned(record.fence, row.resourceId, row.revision, { identityId: record.identityId, kind: 'local_only', locator: { owner: 'runtime-adapter' } });
  }
  settled(driver: AgentDriver) { const record = this.records.get(driver); if (record) record.creationSettled = true; }
  ready(driver: AgentDriver) {
    const record = this.records.get(driver);
    if (!record || !record.creationSettled) throw new RuntimeError('DRIVER_CREATION_PENDING', 'Driver creation has not finished', 409);
    if (record.controlled) { record.controlled.ready(); return; }
    this.identify(record);
    let child = this.row(record, record.resourceId);
    if (child.stage === 'pending') child = this.execution().creationFinished(record.fence, child.resourceId, child.revision, 'created');
    const parent = this.row(record, record.operationId);
    if (parent.stage === 'pending') this.execution().creationFinished(record.fence, parent.resourceId, parent.revision, 'created');
    this.execution().observed(record.fence, child.resourceId, child.revision, { observationId: makeId('observation'), identityId: record.identityId, state: 'live', evidenceRef: 'original-driver-start-finished', observedAt: now() });
  }
  gone(driver: AgentDriver, evidenceRef = 'original-driver-isStopped-and-operation-tails') {
    const record = this.records.get(driver);
    if (!record || !record.creationSettled) throw new RuntimeError('DRIVER_CREATION_PENDING', 'Driver creation has not finished', 409);
    if (record.controlled) { record.controlled.ready(); record.controlled.stopped(); return; }
    this.identify(record);
    let child = this.row(record, record.resourceId);
    if (child.stage === 'pending') child = this.execution().creationFinished(record.fence, child.resourceId, child.revision, 'created');
    const parent = this.row(record, record.operationId);
    if (parent.stage === 'pending') this.execution().creationFinished(record.fence, parent.resourceId, parent.revision, 'created');
    this.execution().observed(record.fence, child.resourceId, child.revision, { observationId: makeId('observation'), identityId: record.identityId, state: 'gone', evidenceRef, observedAt: now() });
  }
  refs(driver: AgentDriver): ResourceRef[] {
    const record = this.records.get(driver);
    if (!record) throw new RuntimeError('DRIVER_RESOURCE_MISSING', 'Driver has no creation record', 409);
    if (record.controlled) return record.controlled.refs();
    return [{ resourceId: record.resourceId, identityId: record.identityId }];
  }
  reusableIds(sessionId: string): Set<string> {
    const ids = new Set<string>();
    for (const record of this.records.values()) {
      if (record.fence.sessionId !== sessionId || !record.creationSettled) continue;
      if (record.controlled) {for(const id of record.controlled.reusableIds())ids.add(id);continue;}
      const child = this.row(record, record.resourceId);
      if (child.stage === 'created' && child.observations.at(-1)?.state === 'live') ids.add(child.resourceId);
    }
    return ids;
  }
}

interface ConfigurationOperation {
  version: 1;
  sessionId: string;
  operationId: string;
  driverIdentity: string;
  state: 'pending' | 'unknown';
  target: ExecutionOptions;
}

/** Native configuration survives process exit; only this exact RPC's confirmed commit clears it. */
export class DriverConfigurationLedger {
  private readonly active = new Set<string>();
  constructor(private readonly config: import('@dutydeck/shared').ConfigRepository) {}
  private key(sessionId: string) { return `runtime_driver_configuration:${sessionId}`; }
  async assertClear(sessionId: string) {
    const raw = await this.config.get(this.key(sessionId));
    if (!raw) return;
    let pending = false;
    try {
      const record = JSON.parse(raw) as ConfigurationOperation;
      pending = record.version === 1 && record.sessionId === sessionId && record.state === 'pending' && this.active.has(record.operationId);
    } catch { /* Invalid evidence is unknown, never a reset to known options. */ }
    throw new RuntimeError(pending ? 'DRIVER_CONFIGURATION_BUSY' : 'DRIVER_CONFIGURATION_UNKNOWN', pending
      ? 'A native configuration change is awaiting confirmation'
      : 'Native configuration is unverified; original-context configuration proof is required before reuse', 409);
  }
  async begin(sessionId: string, driverIdentity: string, target: ExecutionOptions) {
    await this.assertClear(sessionId);
    const key = this.key(sessionId), previous = await this.config.get(key);
    if (previous) { await this.assertClear(sessionId); throw new RuntimeError('DRIVER_CONFIGURATION_UNKNOWN', 'Configuration evidence changed', 409); }
    const record: ConfigurationOperation = { version: 1, sessionId, operationId: makeId('configuration'), driverIdentity, state: 'pending', target };
    if (!this.config.compareAndSet || !await this.config.compareAndSet(key, previous, canonicalExecutionJson(record))) throw new RuntimeError('DRIVER_CONFIGURATION_UNKNOWN', 'Configuration intent was not recorded exclusively', 409);
    this.active.add(record.operationId);
    return record;
  }
  async beginRepair(sessionId:string, driverIdentity:string,target:ExecutionOptions, expectedRaw:string,actor:import('@dutydeck/shared').ExecutionActor) {
    if(!expectedRaw)throw new RuntimeError('DRIVER_CONFIGURATION_REPAIR_NOT_REQUIRED','No original configuration blocker was selected',409);
    const record:ConfigurationOperation={version:1,sessionId,operationId:makeId('configuration_repair'),driverIdentity,state:'pending',target};
    const value={...record,repair:{actor,previous:expectedRaw}};
    if(!this.config.compareAndSet||!await this.config.compareAndSet(this.key(sessionId),expectedRaw,canonicalExecutionJson(value)))throw new RuntimeError('DRIVER_CONFIGURATION_UNKNOWN','Original configuration blocker changed',409);
    this.active.add(record.operationId);return value;
  }
  async finish(record: ConfigurationOperation, confirmed: boolean) {
    try {
      const value = confirmed ? '' : canonicalExecutionJson({ ...record, state: 'unknown' });
      if (!this.config.compareAndSet || !await this.config.compareAndSet(this.key(record.sessionId), canonicalExecutionJson(record), value)) throw new RuntimeError('DRIVER_CONFIGURATION_UNKNOWN', 'The original configuration operation no longer matches', 409);
    } finally { this.active.delete(record.operationId); }
  }
}
