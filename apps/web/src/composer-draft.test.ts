import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
  expect(restored.readComposerDraft(key)).toEqual({ text: 'unfinished', references: [reference], mode: 'steer', planFirst: true, revision: 1 });
});

it('only clears the acknowledged revision and never another task or a newer draft', async () => {
  const store = await import('./composer-draft');
  const a = store.composerDraftKey('a'); const b = store.composerDraftKey('b');
  store.updateComposerDraft(a, { text: 'submitted' });
  const submitted = store.readComposerDraft(a).revision;
  store.updateComposerDraft(b, { text: 'other task' });
  store.updateComposerDraft(a, { text: 'new draft' });
  store.acknowledgeComposerDraft(a, submitted);
  expect(store.readComposerDraft(a).text).toBe('new draft');
  store.acknowledgeComposerDraft(a, store.readComposerDraft(a).revision);
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
