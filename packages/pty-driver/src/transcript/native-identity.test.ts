import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectDir } from '../cli-paths.js';
import { buildSessionMarker, resolveCliSessionId } from '../session-id/index.js';
import { verifyLaunchedTranscript, verifyTranscriptCheckpoint } from '../transcript-source.js';
import { resolveClaudeTranscriptPath } from './claude.js';
import { readNativeTranscriptUsage } from './session-usage.js';

const roots: string[] = [];
const sessionId = 'ses_native_identity_regression';
const childId = '44444444-4444-4444-8444-444444444444';
const parentId = '33333333-3333-4333-8333-333333333333';
const marker = buildSessionMarker(sessionId);
const inheritedInput = () => user(buildSessionMarker('ses_native_parent_fixture'));
const jsonl = (entries: unknown[]) => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
const user = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const usage = { timestamp: '2026-10-18T00:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } } };
function root() { const path = mkdtempSync(join(tmpdir(), 'native-identity-')); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('Claude marker fallback agrees with native ownership', () => {
  it.each(['string', 'blocks'])('rejects child handoff prose and non-user markers (%s)', form => {
    const home = root(); const env = { CLAUDE_CONFIG_DIR: home };
    const project = claudeProjectDir(home, env); mkdirSync(project, { recursive: true });
    const content = (text: string) => form === 'string' ? text : [{ type: 'text', text }];
    const path = join(project, `${childId}.jsonl`);
    const resolve = () => resolveClaudeTranscriptPath(home, env, sessionId);
    const native = () => resolveCliSessionId('claude-code', { sessionId, cwd: home, env });
    for (const entry of [
      { type: 'user', message: { role: 'user', content: content(`${buildSessionMarker('ses_child_native')}\nHandoff from ${sessionId}`) } },
      { type: 'assistant', message: { role: 'assistant', content: content(marker) } },
      { type: 'api-request-blob', message: { role: 'user', content: content(marker) } },
      { type: 'user', isSidechain: true, message: { role: 'user', content: content(marker) } },
    ]) {
      writeFileSync(path, jsonl([{ ...entry, sessionId: childId }]));
      expect(resolve()).toBeUndefined(); expect(native()).toBeUndefined();
    }
    writeFileSync(path, jsonl([{ type: 'user', sessionId: childId, message: { role: 'user', content: content(marker) } }]));
    expect(resolve()).toBe(path); expect(native()).toBe(childId);
    const decoy = join(project, `${parentId}.jsonl`);
    writeFileSync(decoy, jsonl([{ type: 'user', sessionId: parentId, message: { role: 'user', content: content(`Handoff from ${sessionId}`) } }]));
    utimesSync(path, 1, 1); utimesSync(decoy, 2, 2);
    expect(resolve()).toBe(path); expect(native()).toBe(childId);
  });
});

function fork(inherited: Record<string, unknown> = {}) {
  const home = root(); const day = join(home, 'sessions', '2026', '10', '18'); mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-now-${childId}.jsonl`);
  const own = { type: 'session_meta', payload: { id: childId, cwd: home, source: 'cli' } };
  const parent = { type: 'session_meta', payload: { id: parentId, cwd: home, ...inherited } };
  const ctx = { sessionId, cwd: home };
  const source = { client: 'codex' as const, path, dataRoot: home, cwd: home, nativeSessionId: childId };
  return { home, path, own, parent, ctx, source };
}

describe('Codex fork first metadata ownership', () => {
  it.each([{}, { cwd: '/inherited-parent' }, { source: { subagent: 'review' } }])('shares the first identity across native lookup, launch, checkpoint and usage: %j', async inherited => {
    const f = fork(inherited);
    writeFileSync(f.path, jsonl([f.own, f.parent, inheritedInput(), user(marker), usage]));
    writeFileSync(join(f.home, 'history.jsonl'), jsonl([{ session_id: childId, text: marker }]));
    expect(resolveCliSessionId('codex', { ...f.ctx, env: { CODEX_HOME: f.home }, requireMarker: true })).toBe(childId);
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)?.nativeSessionId).toBe(childId);
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)?.nativeSessionId).toBe(childId);
    expect((await readNativeTranscriptUsage(f.source))?.nativeTokens).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    expect(await readNativeTranscriptUsage({ ...f.source, nativeSessionId: parentId })).toBeUndefined();
  });

  it('retains own binding when inherited metadata arrives in an incremental read', async () => {
    const f = fork({ cwd: '/parent', source: { subagent: 'review' } });
    writeFileSync(f.path, jsonl([f.own, user(marker)]));
    expect(await readNativeTranscriptUsage(f.source)).toEqual({});
    appendFileSync(f.path, jsonl([f.parent, usage]));
    expect((await readNativeTranscriptUsage(f.source))?.nativeTokens?.totalTokens).toBe(120);
  });

  it.each([false, true])('finds a middle marker beyond the head window (inherited metadata: %s)', inherited => {
    const f = fork();
    const padding = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'x'.repeat(300_000) } };
    writeFileSync(f.path, jsonl([f.own, ...(inherited ? [f.parent, inheritedInput()] : []), padding, user(marker), padding]));
    if (inherited) {
      expect(verifyLaunchedTranscript('codex', f.home, f.ctx)).toBeUndefined();
      expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)).toBeUndefined();
      writeFileSync(join(f.home, 'history.jsonl'), jsonl([{ session_id: childId, text: marker }]));
    }
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)?.nativeSessionId).toBe(childId);
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)?.nativeSessionId).toBe(childId);
  });

  it.each(['subagent', 'wrong-cwd', 'missing-id'])('never authorizes a fork from inherited valid metadata when its own is %s', async invalid => {
    const f = fork();
    const payload = invalid === 'subagent' ? { ...f.own.payload, source: { subagent: 'review' } }
      : invalid === 'wrong-cwd' ? { ...f.own.payload, cwd: '/foreign' } : { cwd: f.home };
    writeFileSync(f.path, jsonl([{ type: 'session_meta', payload }, { ...f.parent, payload: { id: childId, cwd: f.home } }, user(marker), usage]));
    writeFileSync(join(f.home, 'history.jsonl'), jsonl([{ session_id: childId, text: marker }]));
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)).toBeUndefined();
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)).toBeUndefined();
    expect(await readNativeTranscriptUsage(f.source)).toBeUndefined();
  });

  it('skips malformed and non-object records while reaching the fork marker', () => {
    const f = fork();
    writeFileSync(f.path, jsonl([f.own, null, 42, f.parent]) + '{malformed}\n' + jsonl([inheritedInput(), user(marker)]));
    writeFileSync(join(f.home, 'history.jsonl'), jsonl([{ session_id: childId, text: marker }]));
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)?.nativeSessionId).toBe(childId);
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)?.nativeSessionId).toBe(childId);
  });

  it.each([false, true])('does not bind inherited parent input to the child (fork metadata: %s)', declaredFork => {
    const f = fork();
    const parentSession = 'ses_inherited_parent_regression';
    const parentMarker = buildSessionMarker(parentSession);
    const parentPath = join(f.home, 'sessions', `rollout-now-${parentId}.jsonl`);
    const own = declaredFork ? { ...f.own, payload: { ...f.own.payload, forked_from_id: parentId } } : f.own;
    const padding = { type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'x'.repeat(300_000) } };
    writeFileSync(parentPath, jsonl([f.parent, user(parentMarker)]));
    writeFileSync(f.path, jsonl([own, f.parent, user(parentMarker), padding, user(marker), user('ordinary follow-up'), padding]));
    utimesSync(parentPath, 1, 1); utimesSync(f.path, 2, 2);
    const parentCtx = { ...f.ctx, sessionId: parentSession };
    const resolve = (sessionId: string) => resolveCliSessionId('codex', { ...f.ctx, sessionId, env: { CODEX_HOME: f.home }, requireMarker: true });
    expect(verifyLaunchedTranscript('codex', f.home, parentCtx)?.nativeSessionId).toBe(parentId);
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)).toBeUndefined();
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, parentCtx)).toBeUndefined();
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)).toBeUndefined();
    writeFileSync(join(f.home, 'history.jsonl'), jsonl([{ session_id: childId, text: marker }]));
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)?.nativeSessionId).toBe(childId);
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)?.nativeSessionId).toBe(childId);
    expect(resolve(parentSession)).toBe(parentId); expect(resolve(sessionId)).toBe(childId);
    rmSync(parentPath);
    expect(verifyLaunchedTranscript('codex', f.home, parentCtx)).toBeUndefined();
    expect(resolve(parentSession)).toBeUndefined();
  });

  it('retains modern identity when a later legacy envelope names the same session', () => {
    const f = fork();
    writeFileSync(f.path, jsonl([f.own, user(marker), user(`[dutydeck-session:${sessionId}]`)]));
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)?.nativeSessionId).toBe(childId);
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)?.nativeSessionId).toBe(childId);
  });

  it.each([false, true])('does not verify a single marker beside inherited metadata (fork metadata: %s)', declaredFork => {
    const f = fork();
    const own = declaredFork ? { ...f.own, payload: { ...f.own.payload, forked_from_id: parentId } } : f.own;
    writeFileSync(f.path, jsonl([own, f.parent, user(marker)]));
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)).toBeUndefined();
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)).toBeUndefined();
    // Generic inherited input is also insufficient for an executable resume target.
    expect(resolveCliSessionId('codex', { ...f.ctx, env: { CODEX_HOME: f.home }, requireMarker: true })).toBeUndefined();
    writeFileSync(join(f.home, 'history.jsonl'), jsonl([{ session_id: childId, text: marker }]));
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)?.nativeSessionId).toBe(childId);
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)?.nativeSessionId).toBe(childId);
  });

  it.each([
    { ownPrompt: false, ownHistory: false }, { ownPrompt: true, ownHistory: false },
    { ownPrompt: false, ownHistory: true }, { ownPrompt: true, ownHistory: true },
  ])('requires independent history for nested forks: %j', ({ ownPrompt, ownHistory }) => {
    const f = fork();
    const parentSession = 'ses_nested_parent';
    const parentMarker = buildSessionMarker(parentSession);
    const parentPath = join(f.home, 'sessions', `rollout-now-${parentId}.jsonl`);
    writeFileSync(parentPath, jsonl([f.parent, user(parentMarker)]));
    const grandparent = { type: 'session_meta', payload: { id: 'grandparent-native', cwd: f.home } };
    writeFileSync(f.path, jsonl([f.own, f.parent, grandparent, user(buildSessionMarker('ses_nested_grandparent')), user(parentMarker), ...(ownPrompt ? [user(marker)] : [])]));
    if (ownHistory) writeFileSync(join(f.home, 'history.jsonl'), jsonl([{ session_id: childId, text: marker }]));
    const parentCtx = { ...f.ctx, sessionId: parentSession };
    expect(verifyLaunchedTranscript('codex', f.home, parentCtx)?.nativeSessionId).toBe(parentId);
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, parentCtx)).toBeUndefined();
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)?.nativeSessionId).toBe(ownHistory ? childId : undefined);
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)?.nativeSessionId).toBe(ownHistory ? childId : undefined);
    if (ownHistory) {
      // Visible conflicting submissions remain ambiguous even for a known file.
      appendFileSync(join(f.home, 'history.jsonl'), jsonl([{ session_id: parentId, text: marker }]));
      expect(verifyLaunchedTranscript('codex', f.home, f.ctx)).toBeUndefined();
      expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)).toBeUndefined();
    }
  });

  it('requires the checkpoint first metadata cwd even with independent fork history', () => {
    const f = fork();
    writeFileSync(f.path, jsonl([{ type: 'session_meta', payload: { id: childId, source: 'cli' } }, f.parent, user(marker)]));
    writeFileSync(join(f.home, 'history.jsonl'), jsonl([{ session_id: childId, text: marker }]));
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)).toBeUndefined();
  });

  it('rejects incomplete history for a fork even when the visible tail names its own ID', () => {
    const f = fork();
    writeFileSync(f.path, jsonl([f.own, f.parent, inheritedInput(), user(marker)]));
    writeFileSync(join(f.home, 'history.jsonl'), 'x'.repeat(4 * 1024 * 1024 + 1) + '\n' + jsonl([{ session_id: childId, text: marker }]));
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)).toBeUndefined();
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)).toBeUndefined();
  });

  it('keeps duplicate-file ambiguity and rejects history contradicting the first identity', () => {
    const f = fork(); writeFileSync(f.path, jsonl([f.own, f.parent, user(marker)]));
    writeFileSync(join(f.home, 'history.jsonl'), jsonl([{ session_id: parentId, text: marker }]));
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)).toBeUndefined();
    writeFileSync(join(f.home, 'history.jsonl'), jsonl([{ session_id: childId, text: marker }]));
    writeFileSync(join(f.home, 'sessions', 'rollout-copy.jsonl'), jsonl([f.own]));
    expect(verifyLaunchedTranscript('codex', f.home, f.ctx)).toBeUndefined();
    expect(verifyTranscriptCheckpoint('codex', f.path, f.home, f.ctx)).toBeUndefined();
  });
});

it.each(['codex', 'traex', 'claude-main', 'claude-subagent'])('reads the checked-in real native %s sample through identity boundaries', async name => {
  const entries = readFileSync(new URL(`../../../../tests/fixtures/session-insight/real-native/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const home = root(); const isClaude = name.startsWith('claude');
  const meta = entries[0]; const nativeId = isClaude ? meta.sessionId : meta.payload.id;
  const cwd = isClaude ? meta.cwd : meta.payload.cwd;
  if (isClaude) {
    const prompt = entries.find(entry => entry.type === 'user'); prompt.message.content = marker;
    const env = { CLAUDE_CONFIG_DIR: home }; const project = claudeProjectDir(cwd, env); mkdirSync(project, { recursive: true });
    const path = join(project, 'sample.jsonl'); writeFileSync(path, jsonl(entries));
    if (name === 'claude-subagent') {
      expect(resolveClaudeTranscriptPath(cwd, env, sessionId)).toBeUndefined();
      expect(await readNativeTranscriptUsage({ client: 'claude', path, dataRoot: home, cwd, nativeSessionId: nativeId })).toBeUndefined();
    } else {
      expect(resolveClaudeTranscriptPath(cwd, env, sessionId)).toBe(path);
      expect(verifyLaunchedTranscript('claude', home, { sessionId, cwd })?.nativeSessionId).toBe(nativeId);
      expect((await readNativeTranscriptUsage({ client: 'claude', path, dataRoot: home, cwd, nativeSessionId: nativeId }))?.nativeTokens).toMatchObject({ inputTokens: 26501, outputTokens: 828 });
    }
  } else {
    const directory = join(home, ...(name === 'traex' ? ['cli'] : []), 'sessions'); mkdirSync(directory, { recursive: true });
    const path = join(directory, `rollout-now-${nativeId}.jsonl`);
    entries.splice(1, 0, user(marker)); writeFileSync(path, jsonl(entries));
    const env = name === 'traex' ? { TRAE_HOME: home } : { CODEX_HOME: home };
    expect(resolveCliSessionId(name, { sessionId, cwd, env, requireMarker: true })).toBe(nativeId);
    expect(verifyLaunchedTranscript(name as 'codex' | 'traex', home, { sessionId, cwd })?.nativeSessionId).toBe(nativeId);
    if (name === 'codex') expect((await readNativeTranscriptUsage({ client: 'codex', path, dataRoot: home, cwd, nativeSessionId: nativeId }))?.nativeTokens?.totalTokens).toBe(92353);
  }
});
