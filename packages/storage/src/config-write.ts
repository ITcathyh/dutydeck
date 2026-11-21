import { RuntimeError } from '@dutydeck/shared';
import { assertBotProcessConfigWrite, type ConfigDatabase } from './bot-process.js';
import { configKeyDefinition } from './config-keys.js';

const warned = new Set<string>();

export function assertConfigWrite(db: ConfigDatabase, key: string, value: string) {
  assertBotProcessConfigWrite(db, key, value);
  const definition = configKeyDefinition(key);
  if (!definition) {
    const prefix = key.split(/[.:/]/, 1)[0]!;
    if (process.env.VITEST) throw new Error(`Unregistered config key: ${key}`);
    if (!warned.has(prefix)) {
      warned.add(prefix);
      console.warn(`Unregistered config prefix: ${prefix}`);
    }
  }
  return definition;
}

export function assertRepositoryConfigWrite(db: ConfigDatabase, key: string, value: string) {
  assertConfigWrite(db, key, value);
  if (key.startsWith('runtime_native_context:')) throw new RuntimeError('EXECUTION_WRITE_REQUIRES_LEDGER', 'Native context selection requires a bound ledger command', 409);
}
