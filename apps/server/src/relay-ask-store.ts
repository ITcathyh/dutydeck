import type { ConfigRepository } from '@dutydeck/shared';
import type { RelayAskRecord, RelayAskStore } from '@dutydeck/relay';

const prefix = 'relay.ask.';

export function createRelayAskStore(config: ConfigRepository): RelayAskStore {
  if (!config.compareAndSet || !config.list) throw new Error('Persistent relay questions require atomic config storage and prefix listing.');
  return {
    ...(config.getSync && config.listByJsonField ? {
      getSync(id: string) {
        const value = config.getSync!(prefix + id);
        return value ? JSON.parse(value) as RelayAskRecord : undefined;
      },
      async listUnsettled() {
        return (await config.listByJsonField!(prefix, { field: 'status', values: ['pending', 'answering'] })).map(row => JSON.parse(row.value) as RelayAskRecord);
      }
    } : {}),
    async get(id) {
      const value = await config.get(prefix + id);
      return value ? JSON.parse(value) as RelayAskRecord : undefined;
    },
    async list() {
      return (await config.list!(prefix)).map(row => JSON.parse(row.value) as RelayAskRecord);
    },
    compareAndSet(expected, record) {
      return config.compareAndSet!(prefix + record.id, expected ? JSON.stringify(expected) : undefined, JSON.stringify(record));
    }
  };
}
