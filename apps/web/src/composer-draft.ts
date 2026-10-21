import { useSyncExternalStore } from 'react';
import type { ComposerReference } from './composer-utils';
import type { SendMode } from './components/Composer';
import { currentInstance } from './instance';

export type ComposerDraft = { text: string; references: ComposerReference[]; mode: SendMode; planFirst: boolean; revision: number };
const prefix = 'dutydeck:composer:v1:';
const empty: ComposerDraft = { text: '', references: [], mode: 'queue', planFirst: false, revision: 0 };
const drafts = new Map<string, ComposerDraft>();
const listeners = new Set<() => void>();
export const composerDraftKey = (sessionId: string, instance = currentInstance()) => `${prefix}${instance ?? '@local'}:${sessionId}`;

export function readComposerDraft(key: string): ComposerDraft {
  const cached = drafts.get(key);
  if (cached) return cached;
  let draft = empty;
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && typeof value.text === 'string' && Array.isArray(value.references) && value.references.every((item: ComposerReference) => item && typeof item.id === 'string' && ['file', 'skill'].includes(item.kind) && typeof item.label === 'string' && typeof item.value === 'string') && ['queue', 'interrupt', 'steer'].includes(value.mode) && typeof value.planFirst === 'boolean' && Number.isSafeInteger(value.revision) && value.revision >= 0) draft = value;
  } catch { /* Storage unavailable: keep this tab's draft in memory. */ }
  drafts.set(key, draft);
  return draft;
}

function save(key: string, draft: ComposerDraft) {
  drafts.set(key, draft);
  try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* Keep the draft in memory if browser storage is full or disabled. */ }
  listeners.forEach(listener => listener());
}

export function updateComposerDraft(key: string, patch: Partial<Omit<ComposerDraft, 'revision'>>) {
  const current = readComposerDraft(key);
  save(key, { ...current, ...patch, revision: current.revision + 1 });
}

/** Acknowledgements belong to the submitted task and revision, even after navigating away. */
export function acknowledgeComposerDraft(key: string, revision: number) {
  if (readComposerDraft(key).revision !== revision) return;
  save(key, { ...empty, revision: revision + 1 });
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useComposerDraft(sessionId?: string) {
  const key = sessionId ? composerDraftKey(sessionId) : undefined;
  const draft = useSyncExternalStore(subscribe, () => key ? readComposerDraft(key) : empty, () => empty);
  return { key, draft, update: (patch: Partial<Omit<ComposerDraft, 'revision'>>) => { if (key) updateComposerDraft(key, patch); } };
}

export function resetComposerDrafts() {
  const keys = [...drafts.keys()];
  drafts.clear();
  try { keys.forEach(key => localStorage.removeItem(key)); } catch { /* Storage may be disabled. */ }
  listeners.forEach(listener => listener());
}
