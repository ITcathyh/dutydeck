import { z } from 'zod';
import { taskExecutionSchemas } from './task-execution.js';

// CAS compares the stored JSON byte for byte. Zod's output may reorder object properties.
function readRecord<Value extends z.ZodTypeAny>(schema: Value, raw: string): z.output<Value> {
  const record = JSON.parse(raw);
  schema.parse(record);
  return record;
}

function single<Value extends z.ZodTypeAny>(prefix: string, value: Value) {
  return {
    prefix, value, read: (raw: string) => readRecord(value, raw),
    key: (id: string) => prefix + id,
    parse: (key: string) => key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : undefined
  };
}

function pair<Value extends z.ZodTypeAny>(prefix: string, value: Value) {
  return {
    prefix, value, read: (raw: string) => readRecord(value, raw),
    key: (first: string, second: string) => prefix + first + ':' + second,
    parse(key: string, knownFirst?: string): [string, string] | undefined {
      if (!key.startsWith(prefix)) return;
      // Existing keys do not escape colons. Use the known scope when either component contains one.
      if (knownFirst !== undefined && !key.startsWith(prefix + knownFirst + ':')) return;
      const split = knownFirst === undefined ? key.indexOf(':', prefix.length) : prefix.length + knownFirst.length;
      if (knownFirst === undefined && key.indexOf(':', split + 1) >= 0) return;
      if (split > prefix.length && split < key.length - 1) return [key.slice(prefix.length, split), key.slice(split + 1)];
    }
  };
}

// These readers interpret partial evidence in context (e.g. verification listing vs. workspace admission).
// Only decode JSON here unless the original reader required a specific shape.
const jsonValue = z.unknown();
const verification = pair('runtime_verification:', jsonValue);
const nativeContext = single('runtime_native_context:', taskExecutionSchemas.nativeSelectionSchema);
const present = z.unknown().refine(Boolean);

export const runtimeStateKeys = {
  driverStopBlock: single('runtime_driver_stop_block:', z.object({
    sessionId: z.string(), reason: z.string()
  }).passthrough()),
  driverConfiguration: single('runtime_driver_configuration:', jsonValue),
  workspace: single('runtime_workspace:', jsonValue),
  verification: {
    ...verification,
    sessionPrefix: (id: string) => verification.key(id, ''),
    sessionUpperBound: (id: string) => verification.prefix + id + ';'
  },
  idleTerminal: single('runtime_idle_terminal:', z.object({
    options: present, identity: present
  }).passthrough()),
  ptyRetirement: pair('runtime_pty_retirement:', jsonValue),
  executionWorkspace: single('runtime_execution_workspace:', jsonValue),
  nativeContext: {
    ...nativeContext,
    revisionKey: (id: string) => nativeContext.key(id) + ':revision',
    parse(key: string) {
      const suffix = nativeContext.parse(key);
      if (!suffix) return;
      return suffix.endsWith(':revision')
        ? { sessionId: suffix.slice(0, -':revision'.length), revision: true }
        : { sessionId: suffix, revision: false };
    }
  },
  notice: { ...pair('runtime_notice:', z.string()), read: (raw: string) => raw },
  legacyRetirement: single('legacy_retirement:', taskExecutionSchemas.legacyRetirementReceiptSchema)
} as const;
