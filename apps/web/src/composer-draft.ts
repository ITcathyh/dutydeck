import { useSyncExternalStore } from 'react';
import type { ComposerReference } from './composer-utils';
import type { SendMode } from './components/Composer';
import { currentInstance } from './instance';
import { requestId } from './request-id';

export type ComposerDraft = { text: string; references: ComposerReference[]; mode: SendMode; planFirst: boolean; revision: number; identity?: string };
const prefix = 'dutydeck:composer:v1:';
const empty: ComposerDraft = { text: '', references: [], mode: 'queue', planFirst: false, revision: 0 };
const drafts = new Map<string, ComposerDraft>();
const persistedDrafts = new Map<string, string>();
const legacyDrafts = new Set<string>();
const listeners = new Set<() => void>();
export const composerDraftKey = (sessionId: string, instance = currentInstance()) => `${prefix}${instance ?? '@local'}:${sessionId}`;
const pointerKey = (key: string) => key.replace(prefix, 'dutydeck:composer:v2:');
const recordKey = (key: string, identity: string) => `${pointerKey(key)}:version:${identity}`;

function parseDraft(raw: string | null): ComposerDraft | undefined {
  const value = JSON.parse(raw ?? 'null');
  if (value && typeof value.text === 'string' && Array.isArray(value.references) && value.references.every((item: ComposerReference) => item && typeof item.id === 'string' && ['file', 'skill'].includes(item.kind) && typeof item.label === 'string' && typeof item.value === 'string') && ['queue', 'interrupt', 'steer'].includes(value.mode) && typeof value.planFirst === 'boolean' && Number.isSafeInteger(value.revision) && value.revision >= 0) return value;
}

export function readComposerDraft(key: string): ComposerDraft {
  const cached = drafts.get(key);
  if (cached) return cached;
  let draft = empty;
  try {
    const identity = localStorage.getItem(pointerKey(key));
    if (identity !== null) {
      const record = recordKey(key, identity);
      const value = parseDraft(localStorage.getItem(record));
      if (value && value.identity === identity) {
        draft = value;
        persistedDrafts.set(key, record);
      }
      // A missing body is an acknowledged draft, never a reason to resurrect v1.
    } else {
      const value = parseDraft(localStorage.getItem(key));
      if (value) { draft = value; legacyDrafts.add(key); }
    }
  } catch { /* Storage unavailable: keep this tab's draft in memory. */ }
  drafts.set(key, draft);
  return draft;
}

function persist(key: string, draft: ComposerDraft) {
  const record = recordKey(key, draft.identity!);
  try {
    localStorage.setItem(record, JSON.stringify(draft));
    localStorage.setItem(pointerKey(key), draft.identity!);
  } catch {
    try { localStorage.removeItem(record); } catch { /* Storage may be disabled. */ }
    return;
  }
  const previous = persistedDrafts.get(key);
  persistedDrafts.set(key, record);
  if (previous) {
    try { localStorage.removeItem(previous); } catch { /* Keep the published version even if cleanup is unavailable. */ }
  }
}

function save(key: string, draft: ComposerDraft) {
  draft = { ...draft, identity: requestId() };
  drafts.set(key, draft);
  persist(key, draft);
  listeners.forEach(listener => listener());
}

export function updateComposerDraft(key: string, patch: Partial<Omit<ComposerDraft, 'revision' | 'identity'>>) {
  const current = readComposerDraft(key);
  save(key, { ...current, ...patch, revision: current.revision + 1 });
}

/** Acknowledgements retire only this tab's known bodies, never the shared current-version pointer. */
export function acknowledgeComposerDraft(key: string, submitted: ComposerDraft) {
  const current = readComposerDraft(key);
  if (current.revision !== submitted.revision || current.identity !== submitted.identity) return;
  const record = persistedDrafts.get(key);
  try {
    if (record) localStorage.removeItem(record);
    if (legacyDrafts.has(key)) localStorage.removeItem(key);
  } catch { /* Storage unavailable: acknowledge this tab's in-memory draft. */ }
  persistedDrafts.delete(key);
  legacyDrafts.delete(key);
  drafts.set(key, { ...empty, revision: submitted.revision + 1, identity: requestId() });
  listeners.forEach(listener => listener());
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useComposerDraft(sessionId?: string) {
  const key = sessionId ? composerDraftKey(sessionId) : undefined;
  const draft = useSyncExternalStore(subscribe, () => key ? readComposerDraft(key) : empty, () => empty);
  return { key, draft, update: (patch: Partial<Omit<ComposerDraft, 'revision' | 'identity'>>) => { if (key) updateComposerDraft(key, patch); } };
}

export function resetComposerDrafts() {
  const keys = [...drafts.keys()];
  try {
    for (const key of keys) {
      localStorage.removeItem(key);
      localStorage.removeItem(pointerKey(key));
      const record = persistedDrafts.get(key);
      if (record) localStorage.removeItem(record);
    }
  } catch { /* Storage may be disabled. */ }
  drafts.clear();
  persistedDrafts.clear();
  legacyDrafts.clear();
  listeners.forEach(listener => listener());
}
