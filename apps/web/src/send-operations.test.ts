import { describe, expect, it, vi } from 'vitest';
import { SEND_OPERATIONS_STORAGE_KEY, SendOperationStore, type SendOperation } from './send-operations';

const operation = (key: string, snapshot = `snapshot-${key}`): SendOperation => ({ snapshot, mode: 'queue', key });

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); })
  };
}

describe('SendOperationStore', () => {
  it('recovers after recreation and rereads another tab accepting the operation', () => {
    const storage = memoryStorage();
    const firstTab = new SendOperationStore(storage);
    const secondTab = new SendOperationStore(storage);
    firstTab.set('draft', operation('request-1', 'snapshot'));
    expect(secondTab.get('draft', 'snapshot')).toEqual(operation('request-1', 'snapshot'));

    secondTab.delete('draft', 'another-request');
    expect(firstTab.get('draft', 'snapshot')).toEqual(operation('request-1', 'snapshot'));
    secondTab.delete('draft', 'request-1');
    expect(firstTab.get('draft', 'snapshot')).toBeUndefined();
    expect(storage.getItem.mock.calls.length).toBeGreaterThan(2);
  });

  it('keeps different snapshots from two tabs through an interleaved accept and delete', () => {
    const storage = memoryStorage();
    const firstTab = new SendOperationStore(storage);
    const secondTab = new SendOperationStore(storage);
    const first = operation('request-a', 'snapshot-a');
    const second = operation('request-b', 'snapshot-b');
    firstTab.set('draft', first);
    secondTab.set('draft', second);

    expect(firstTab.get('draft', 'snapshot-a')).toEqual(first);
    expect(secondTab.get('draft', 'snapshot-b')).toEqual(second);
    secondTab.delete('draft', 'not-request-b');
    expect(firstTab.get('draft', 'snapshot-a')).toEqual(first);
    expect(secondTab.get('draft', 'snapshot-b')).toEqual(second);

    secondTab.delete('draft', 'request-b');
    expect(firstTab.get('draft', 'snapshot-a')).toEqual(first);
    expect(secondTab.get('draft', 'snapshot-b')).toBeUndefined();
  });

  it('keeps retrying with the in-memory operation when storage writes fail', () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw new Error('quota exceeded'); }),
      removeItem: vi.fn()
    };
    const store = new SendOperationStore(storage);
    expect(() => store.set('draft', operation('request-1', 'snapshot'))).not.toThrow();
    expect(store.get('draft', 'snapshot')).toEqual(operation('request-1', 'snapshot'));
    expect(storage.getItem).toHaveBeenCalledWith(SEND_OPERATIONS_STORAGE_KEY);
  });

  it('retains only the newest 32 operations', () => {
    const store = new SendOperationStore(null);
    for (let index = 0; index < 33; index++) store.set(`draft-${index}`, operation(`request-${index}`));
    expect(store.get('draft-0', 'snapshot-request-0')).toBeUndefined();
    expect(store.get('draft-1', 'snapshot-request-1')).toEqual(operation('request-1'));
    expect(store.get('draft-32', 'snapshot-request-32')).toEqual(operation('request-32'));
  });
});
