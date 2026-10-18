import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionMarker, resolveCliSessionId } from './index.js';

const source = 'ses_11111111-1111-4111-8111-111111111111';
const child = 'ses_22222222-2222-4222-8222-222222222222';
const sourceNative = '33333333-3333-4333-8333-333333333333';
const childNative = '44444444-4444-4444-8444-444444444444';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const jsonl = (path: string, entries: unknown[]) => writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');

describe.each([
  { adapter: 'codex', envKey: 'CODEX_HOME', sub: '' },
  { adapter: 'traex', envKey: 'TRAE_HOME', sub: 'cli' },
])('$adapter exact marker compatibility', ({ adapter, envKey, sub }) => {
  function fixture() {
    const home = mkdtempSync(join(tmpdir(), 'dutydeck-marker-compat-')); roots.push(home);
    const root = join(home, sub); mkdirSync(root, { recursive: true });
    const context = { sessionId: source, cwd: home, env: { [envKey]: home } };
    const resolve = (strict = false) => resolveCliSessionId(adapter, { ...context, requireMarker: strict });
    const history = (entries: unknown[]) => jsonl(join(root, 'history.jsonl'), entries);
    const rollout = (text: string) => {
      const day = join(root, 'sessions', '2026', '10', '17'); mkdirSync(day, { recursive: true });
      jsonl(join(day, `rollout-2026-10-17T00-00-00-${sourceNative}.jsonl`), [
        { type: 'session_meta', payload: { id: sourceNative, cwd: home } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
      ]);
    };
    return { context, resolve, history, rollout };
  }

  it.each(['bracketed', 'whole-input'])('reads legacy %s history without accepting a newer child handoff', format => {
    const h = fixture();
    const text = format === 'bracketed' ? `[dutydeck-session:${source}]` : `  ${source}\n`;
    h.history([
      { session_id: sourceNative, text },
      { session_id: childNative, text: `${buildSessionMarker(child)}\nHandoff from ${source}` },
    ]);
    expect(h.resolve()).toBe(sourceNative);
    expect(h.resolve(true)).toBeUndefined();
    expect(resolveCliSessionId(adapter, { ...h.context, sessionId: child })).toBe(childNative);
  });

  it('prefers a modern XML rollout over a newer legacy history binding', () => {
    const h = fixture(); h.rollout(buildSessionMarker(source));
    h.history([{ session_id: childNative, text: source }]);
    expect(h.resolve()).toBe(sourceNative);
    expect(h.resolve(true)).toBe(sourceNative);
  });

  it.each(['bracketed', 'whole-input'])('reads a legacy %s user record from a rollout', format => {
    const h = fixture();
    h.rollout(format === 'bracketed' ? `[dutydeck-session:${source}]` : source);
    expect(h.resolve()).toBe(sourceNative);
    expect(h.resolve(true)).toBeUndefined();
  });

  it.each([false, true])('uses the first metadata for a native fork (same cwd: %s)', sameCwd => {
    const h = fixture();
    const home = h.context.cwd;
    const childCwd = sameCwd ? home : join(home, 'child-worktree');
    const day = join(home, sub, 'sessions', '2026', '10', '17'); mkdirSync(day, { recursive: true });
    jsonl(join(day, `rollout-2026-10-17T00-00-00-${childNative}.jsonl`), [
      { type: 'session_meta', payload: { id: childNative, cwd: childCwd } },
      { type: 'session_meta', payload: { id: sourceNative, cwd: home } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: buildSessionMarker(child) }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(5 * 1024 * 1024) }] } },
    ]);
    // Copied generic user input cannot establish a fork's own identity.
    expect(resolveCliSessionId(adapter, { ...h.context, sessionId: child, cwd: childCwd })).toBeUndefined();
    h.history([{ session_id: childNative, text: buildSessionMarker(child) }]);
    expect(resolveCliSessionId(adapter, { ...h.context, sessionId: child, cwd: childCwd })).toBe(childNative);
    expect(h.resolve()).toBeUndefined();
  });

  it.each([
    { history: 'absent', subagent: 'review' },
    { history: 'trimmed', subagent: 'review' },
    { history: 'absent', subagent: { thread_spawn: { parent_thread_id: sourceNative, depth: 1 } } },
    { history: 'trimmed', subagent: { thread_spawn: { parent_thread_id: sourceNative, depth: 1 } } },
  ])('does not mistake an internal subagent for its parent ($history history, $subagent)', ({ history, subagent }) => {
    const h = fixture(); h.rollout(buildSessionMarker(source));
    if (history === 'trimmed') h.history([
      { session_id: sourceNative, text: buildSessionMarker(source) },
      { session_id: 'unrelated', text: 'x'.repeat(4 * 1024 * 1024 + 1) },
    ]);
    const day = join(h.context.cwd, sub, 'sessions', '2026', '10', '17');
    const parentPath = join(day, `rollout-2026-10-17T00-00-00-${sourceNative}.jsonl`);
    const childPath = join(day, `rollout-2026-10-17T00-00-01-${childNative}.jsonl`);
    jsonl(childPath, [
      { type: 'session_meta', payload: { id: childNative, cwd: h.context.cwd, source: { subagent }, forked_from_id: sourceNative, subagent_history_start_ordinal: 3 } },
      { type: 'session_meta', payload: { id: sourceNative, cwd: h.context.cwd, source: 'cli' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: buildSessionMarker(source) }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review the inherited task' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(5 * 1024 * 1024) }] } },
    ]);
    utimesSync(parentPath, 1, 1); utimesSync(childPath, 2, 2);
    expect(h.resolve()).toBe(sourceNative);
    expect(h.resolve(true)).toBe(sourceNative);
  });

  it('keeps native fork ownership when inherited metadata names an internal subagent', () => {
    const h = fixture();
    const day = join(h.context.cwd, sub, 'sessions', '2026', '10', '17'); mkdirSync(day, { recursive: true });
    jsonl(join(day, `rollout-2026-10-17T00-00-00-${childNative}.jsonl`), [
      { type: 'session_meta', payload: { id: childNative, cwd: h.context.cwd, source: 'cli', forked_from_id: sourceNative } },
      { type: 'session_meta', payload: { id: sourceNative, cwd: h.context.cwd, source: { subagent: 'review' } } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: buildSessionMarker(child) }] } },
    ]);
    expect(resolveCliSessionId(adapter, { ...h.context, sessionId: child })).toBeUndefined();
    h.history([{ session_id: childNative, text: buildSessionMarker(child) }]);
    expect(resolveCliSessionId(adapter, { ...h.context, sessionId: child })).toBe(childNative);
  });

  it('rejects source ids embedded in ordinary user prose in history and rollouts', () => {
    const h = fixture();
    h.history([{ session_id: childNative, text: `${buildSessionMarker(child)}\nHandoff from ${source}` }]);
    h.rollout(`Inspect source conversation ${source}`);
    expect(h.resolve()).toBeUndefined();
    expect(h.resolve(true)).toBeUndefined();
  });
});

// Unlike generic copied user messages, these native receipts carry explicit thread/turn ownership.
it.each(['own', 'parent', 'foreign-turn', 'assistant'])('TraeX fork accepts only attributable display input: %s', kind => {
  const home = mkdtempSync(join(tmpdir(), 'traex-fork-owner-')); roots.push(home);
  const sessions = join(home, 'cli', 'sessions'); mkdirSync(sessions, { recursive: true });
  jsonl(join(sessions, `rollout-now-${childNative}.jsonl`), [
    { type: 'session_meta', payload: { id: childNative, cwd: home } },
    { type: 'session_meta', payload: { id: sourceNative, cwd: home } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: buildSessionMarker(source) } },
    { type: 'history_mutation', payload: { operation: 'append', turn_id: 'turn-child', display_completions: [
      { thread_id: kind === 'parent' ? sourceNative : childNative, turn_id: kind === 'foreign-turn' ? 'turn-other' : 'turn-child',
        item: { type: kind === 'assistant' ? 'AgentMessage' : 'UserMessage', content: [{ type: 'Text', text: buildSessionMarker(child) }] } },
    ] } },
  ]);
  const context = { cwd: home, env: { TRAE_HOME: home }, requireMarker: true };
  expect(resolveCliSessionId('traex', { ...context, sessionId: child })).toBe(kind === 'own' ? childNative : undefined);
  expect(resolveCliSessionId('traex', { ...context, sessionId: source })).toBeUndefined();
});
