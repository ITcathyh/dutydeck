export type SendOperation = { snapshot: string; mode: 'queue' | 'interrupt'; key: string };
export const SEND_OPERATIONS_STORAGE_KEY = 'dutydeck:send-operations:v1';
const MAX_SEND_OPERATIONS = 32;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type StoredOperation = SendOperation & { draftKey: string };

const browserStorage = (): StorageLike | null => {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; }
  catch { return null; }
};

function parseOperations(raw: string | null): StoredOperation[] {
  const operations: StoredOperation[] = [];
  if (!raw) return operations;
  try {
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return operations;
    for (const value of stored.slice(-MAX_SEND_OPERATIONS)) {
      const item = value as Partial<StoredOperation> | null;
      if (!item || typeof item.draftKey !== 'string' || typeof item.snapshot !== 'string' || !['queue', 'interrupt'].includes(String(item.mode)) || typeof item.key !== 'string') continue;
      operations.push({ draftKey: item.draftKey, snapshot: item.snapshot, mode: item.mode as SendOperation['mode'], key: item.key });
    }
  } catch { /* Malformed storage contains no recoverable operation. */ }
  return operations;
}

/** Persists across reloads in this tab; failed storage access falls back to this page's memory. */
export class SendOperationStore {
  private memory: StoredOperation[] = [];
  private storageFailed = false;

  constructor(private readonly storage: StorageLike | null = browserStorage()) {
    if (!this.storage) return;
    try {
      this.memory = parseOperations(this.storage.getItem(SEND_OPERATIONS_STORAGE_KEY));
    } catch {
      this.storageFailed = true;
    }
  }

  private read(): StoredOperation[] {
    return [...this.memory];
  }

  private write(operations: StoredOperation[]) {
    this.memory = operations;
    if (!this.storage || this.storageFailed) return;
    try {
      if (operations.length) this.storage.setItem(SEND_OPERATIONS_STORAGE_KEY, JSON.stringify(operations));
      else this.storage.removeItem(SEND_OPERATIONS_STORAGE_KEY);
    } catch {
      this.storageFailed = true;
    }
  }

  get(draftKey: string, snapshot: string): SendOperation | undefined {
    const operation = this.read().reverse().find(item => item.draftKey === draftKey && item.snapshot === snapshot);
    return operation && { snapshot: operation.snapshot, mode: operation.mode, key: operation.key };
  }

  set(draftKey: string, operation: SendOperation) {
    const operations = this.read().filter(item => item.draftKey !== draftKey || item.snapshot !== operation.snapshot);
    operations.push({ draftKey, ...operation });
    while (operations.length > MAX_SEND_OPERATIONS) operations.shift();
    this.write(operations);
  }

  delete(draftKey: string, key: string) {
    const operations = this.read();
    const index = operations.findIndex(item => item.draftKey === draftKey && item.key === key);
    if (index < 0) return;
    operations.splice(index, 1);
    this.write(operations);
  }
}
