import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => vi.unstubAllGlobals());

  it('uses session storage and recovers the same draft retry after a same-tab reload', () => {
    const local = memoryStorage();
    const session = memoryStorage();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    const beforeReload = new SendOperationStore();
    beforeReload.set('draft', operation('request-1', 'snapshot'));
    const afterReload = new SendOperationStore();

    expect(afterReload.get('draft', 'snapshot')).toEqual(operation('request-1', 'snapshot'));
    expect(afterReload.get('draft', 'snapshot')?.key).toBe('request-1');
    expect(session.setItem).toHaveBeenCalledWith(SEND_OPERATIONS_STORAGE_KEY, expect.any(String));
    expect(local.setItem).not.toHaveBeenCalled();
  });

  it('treats another tab as a new request and never shares or deletes its operation', () => {
    const firstTab = new SendOperationStore(memoryStorage());
    const secondTab = new SendOperationStore(memoryStorage());
    const first = operation('request-a', 'snapshot');
    const second = operation('request-b', 'snapshot');
    firstTab.set('draft', first);

    expect(secondTab.get('draft', 'snapshot')).toBeUndefined();
    secondTab.set('draft', second);
    expect(firstTab.get('draft', 'snapshot')).toEqual(first);
    expect(secondTab.get('draft', 'snapshot')).toEqual(second);
    secondTab.delete('draft', 'request-b');
    expect(firstTab.get('draft', 'snapshot')).toEqual(first);
  });

  it('keeps different drafts and edited snapshots independent', () => {
    const store = new SendOperationStore(memoryStorage());
    const first = operation('request-a', 'snapshot-a');
    const otherDraft = operation('request-b', 'snapshot-a');
    const edited = operation('request-c', 'snapshot-edited');
    store.set('draft-a', first);
    store.set('draft-b', otherDraft);
    store.set('draft-a', edited);

    expect(store.get('draft-a', 'snapshot-a')).toEqual(first);
    expect(store.get('draft-b', 'snapshot-a')).toEqual(otherDraft);
    expect(store.get('draft-a', 'snapshot-edited')).toEqual(edited);
    store.delete('draft-a', 'request-a');
    expect(store.get('draft-b', 'snapshot-a')).toEqual(otherDraft);
    expect(store.get('draft-a', 'snapshot-edited')).toEqual(edited);
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
