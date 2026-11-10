import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const pointerKey = (key: string) => key.replace('dutydeck:composer:v1:', 'dutydeck:composer:v2:');
const recordKey = (key: string, identity: string) => `${pointerKey(key)}:version:${identity}`;
const savedDraft = (key: string) => {
  const identity = localStorage.getItem(pointerKey(key));
  return JSON.parse(identity === null ? localStorage.getItem(key) ?? 'null' : localStorage.getItem(recordKey(key, identity)) ?? 'null');
};

beforeEach(() => { localStorage.clear(); vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it('persists independent instance and task drafts, references, mode and plan across reloads', async () => {
  const store = await import('./composer-draft');
  const key = store.composerDraftKey('s1', 'bot-a');
  const reference = { id: 'ref', kind: 'file' as const, label: 'a.ts', value: '/repo/a.ts' };
  store.updateComposerDraft(key, { text: 'unfinished', references: [reference], mode: 'steer', planFirst: true });
  expect(store.readComposerDraft(store.composerDraftKey('s2', 'bot-a')).text).toBe('');
  expect(store.readComposerDraft(store.composerDraftKey('s1', 'bot-b')).text).toBe('');
  expect(store.composerDraftKey('s1', undefined)).not.toBe(store.composerDraftKey('s1', 'main'));
  expect(store.composerDraftKey('s1', undefined)).not.toBe(store.composerDraftKey('s1', 'local'));
  vi.resetModules();
  const restored = await import('./composer-draft');
  expect(restored.readComposerDraft(key)).toEqual({ text: 'unfinished', references: [reference], mode: 'steer', planFirst: true, revision: 1, identity: expect.any(String) });
});

it('only clears the acknowledged revision and never another task or a newer draft', async () => {
  const store = await import('./composer-draft');
  const a = store.composerDraftKey('a'); const b = store.composerDraftKey('b');
  store.updateComposerDraft(a, { text: 'submitted' });
  const submitted = store.readComposerDraft(a);
  store.updateComposerDraft(b, { text: 'other task' });
  store.updateComposerDraft(a, { text: 'new draft' });
  store.acknowledgeComposerDraft(a, submitted);
  expect(store.readComposerDraft(a).text).toBe('new draft');
  store.acknowledgeComposerDraft(a, store.readComposerDraft(a));
  expect(store.readComposerDraft(a).text).toBe('');
  store.updateComposerDraft(a, { text: 'third draft' });
  store.acknowledgeComposerDraft(a, submitted);
  expect(store.readComposerDraft(a).text).toBe('third draft');
  expect(store.readComposerDraft(b).text).toBe('other task');
});

it('keeps an in-memory draft when browser storage fails and ignores malformed saved drafts', async () => {
  const store = await import('./composer-draft');
  const invalid = store.composerDraftKey('invalid');
  localStorage.setItem(invalid, JSON.stringify({ text: 'bad', references: [{}] }));
  expect(store.readComposerDraft(invalid).text).toBe('');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const key = store.composerDraftKey('a');
  store.updateComposerDraft(key, { text: 'retained' });
  expect(store.readComposerDraft(key).text).toBe('retained');
});

it.each([false, true])('keeps another tab’s persisted edit on a late acknowledgement (same revision: %s)', async sameRevision => {
  const first = await import('./composer-draft');
  const key = first.composerDraftKey('shared');
  first.readComposerDraft(key);
  vi.resetModules();
  const second = await import('./composer-draft');
  if (sameRevision) second.readComposerDraft(key);
  first.updateComposerDraft(key, { text: 'submitted' });
  const submitted = first.readComposerDraft(key);
  second.updateComposerDraft(key, { text: 'new draft in another tab' });
  const newer = second.readComposerDraft(key);
  expect(newer.revision === submitted.revision).toBe(sameRevision);
  expect(newer.identity).not.toBe(submitted.identity);
  first.acknowledgeComposerDraft(key, submitted);
  expect(first.readComposerDraft(key).text).toBe('');
  vi.resetModules();
  const reloaded = await import('./composer-draft');
  expect(reloaded.readComposerDraft(key)).toEqual(newer);
});

it('acknowledges legacy saved drafts and in-memory drafts without browser storage', async () => {
  const store = await import('./composer-draft');
  const key = store.composerDraftKey('legacy');
  const legacy = { text: 'legacy', references: [], mode: 'queue', planFirst: false, revision: 4 };
  localStorage.setItem(key, JSON.stringify(legacy));
  store.acknowledgeComposerDraft(key, store.readComposerDraft(key));
  expect(store.readComposerDraft(key).text).toBe('');
  expect(store.readComposerDraft(key).identity).toEqual(expect.any(String));
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
  const memoryKey = store.composerDraftKey('memory');
  store.updateComposerDraft(memoryKey, { text: 'only in memory' });
  store.acknowledgeComposerDraft(memoryKey, store.readComposerDraft(memoryKey));
  expect(store.readComposerDraft(memoryKey).text).toBe('');
});

it.each([false, true])('clears an acknowledged memory draft and its older saved value when only writes fail (legacy saved value: %s)', async legacy => {
  const store = await import('./composer-draft');
  const key = store.composerDraftKey('quota');
  if (legacy) localStorage.setItem(key, JSON.stringify({ text: 'old saved draft', references: [], mode: 'queue', planFirst: false, revision: 4 }));
  else store.updateComposerDraft(key, { text: 'old saved draft' });
  const saved = store.readComposerDraft(key);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage quota exceeded', 'QuotaExceededError'); });
  store.updateComposerDraft(key, { text: 'new submitted draft' });
  const submitted = store.readComposerDraft(key);
  expect(savedDraft(key)).toEqual(saved);
  expect(submitted.text).toBe('new submitted draft');
  store.acknowledgeComposerDraft(key, submitted);
  expect(store.readComposerDraft(key).text).toBe('');
  expect(localStorage.getItem(key)).toBeNull();
  vi.resetModules();
  const restored = await import('./composer-draft');
  expect(restored.readComposerDraft(key).text).toBe('');
});

it.each([false, true])('clears an acknowledged memory draft after a failed write while preserving another tab’s saved version (same revision: %s)', async sameRevision => {
  const first = await import('./composer-draft');
  const key = first.composerDraftKey('quota-shared');
  first.updateComposerDraft(key, { text: 'old saved draft' });
  vi.resetModules();
  const second = await import('./composer-draft');
  second.readComposerDraft(key);
  const failWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage quota exceeded', 'QuotaExceededError'); });
  first.updateComposerDraft(key, { text: 'new submitted draft' });
  const submitted = first.readComposerDraft(key);
  failWrite.mockRestore();
  second.updateComposerDraft(key, { text: 'another tab’s unsent draft' });
  if (!sameRevision) second.updateComposerDraft(key, { planFirst: true });
  const newer = second.readComposerDraft(key);
  expect(submitted.revision === newer.revision).toBe(sameRevision);
  first.acknowledgeComposerDraft(key, submitted);
  expect(first.readComposerDraft(key).text).toBe('');
  expect(savedDraft(key)).toEqual(newer);
  vi.resetModules();
  const restored = await import('./composer-draft');
  expect(restored.readComposerDraft(key)).toEqual(newer);
});

it('publishes a pointer only after its body is saved and reclaims superseded records', async () => {
  const store = await import('./composer-draft');
  const key = store.composerDraftKey('records');
  store.updateComposerDraft(key, { text: 'first' });
  const first = store.readComposerDraft(key);
  expect(localStorage.getItem(pointerKey(key))).toBe(first.identity);
  expect(localStorage.getItem(recordKey(key, first.identity!))).not.toBeNull();
  store.updateComposerDraft(key, { text: 'second' });
  const second = store.readComposerDraft(key);
  expect(localStorage.getItem(recordKey(key, first.identity!))).toBeNull();
  expect(savedDraft(key)).toEqual(second);
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    if (name === pointerKey(key)) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    setItem.call(this, name, value);
  });
  store.updateComposerDraft(key, { text: 'third only in memory' });
  const third = store.readComposerDraft(key);
  expect(localStorage.getItem(recordKey(key, third.identity!))).toBeNull();
  expect(savedDraft(key)).toEqual(second);
  store.acknowledgeComposerDraft(key, third);
  expect(localStorage.getItem(pointerKey(key))).toBe(second.identity);
  expect(localStorage.getItem(recordKey(key, second.identity!))).toBeNull();
  expect(store.readComposerDraft(key).text).toBe('');
  vi.resetModules();
  expect((await import('./composer-draft')).readComposerDraft(key).text).toBe('');
});

it('never falls back to a legacy draft when a v2 pointer exists without its body', async () => {
  const store = await import('./composer-draft');
  const key = store.composerDraftKey('no-resurrection');
  localStorage.setItem(key, JSON.stringify({ text: 'legacy draft', references: [], mode: 'queue', planFirst: false, revision: 4 }));
  localStorage.setItem(pointerKey(key), 'missing-version');
  expect(store.readComposerDraft(key).text).toBe('');
});

it('keeps a concurrently published v2 version when acknowledging a legacy draft', async () => {
  const first = await import('./composer-draft');
  const key = first.composerDraftKey('legacy-upgrade');
  localStorage.setItem(key, JSON.stringify({ text: 'legacy draft', references: [], mode: 'queue', planFirst: false, revision: 4 }));
  const legacy = first.readComposerDraft(key);
  expect(localStorage.getItem(pointerKey(key))).toBeNull();
  vi.resetModules();
  const second = await import('./composer-draft');
  second.updateComposerDraft(key, { text: 'new v2 draft' });
  const newer = second.readComposerDraft(key);
  first.acknowledgeComposerDraft(key, legacy);
  expect(localStorage.getItem(key)).toBeNull();
  expect(savedDraft(key)).toEqual(newer);
  vi.resetModules();
  expect((await import('./composer-draft')).readComposerDraft(key)).toEqual(newer);
});

it('never consults or mutates the public pointer during acknowledgement, including a stale storage view', async () => {
  const first = await import('./composer-draft');
  const key = first.composerDraftKey('stale-pointer');
  first.updateComposerDraft(key, { text: 'submitted' });
  const submitted = first.readComposerDraft(key);
  vi.resetModules();
  const second = await import('./composer-draft');
  second.updateComposerDraft(key, { text: 'another tab’s new draft' });
  const newer = second.readComposerDraft(key);
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage view unavailable'); });
  const setItem = vi.spyOn(Storage.prototype, 'setItem');
  const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
  first.acknowledgeComposerDraft(key, submitted);
  expect(getItem).not.toHaveBeenCalled();
  expect(setItem).not.toHaveBeenCalled();
  expect(removeItem.mock.calls).toEqual([[recordKey(key, submitted.identity!)]]);
  expect(first.readComposerDraft(key).text).toBe('');
  getItem.mockRestore();
  expect(savedDraft(key)).toEqual(newer);
});
