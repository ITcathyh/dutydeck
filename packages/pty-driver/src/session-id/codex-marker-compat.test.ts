import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

  it('rejects source ids embedded in ordinary user prose in history and rollouts', () => {
    const h = fixture();
    h.history([{ session_id: childNative, text: `${buildSessionMarker(child)}\nHandoff from ${source}` }]);
    h.rollout(`Inspect source conversation ${source}`);
    expect(h.resolve()).toBeUndefined();
    expect(h.resolve(true)).toBeUndefined();
  });
});
