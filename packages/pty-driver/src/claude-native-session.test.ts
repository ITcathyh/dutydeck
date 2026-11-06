import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sessionBackends from '@dutydeck/session-backends';
import { childProcessIdentity, observeProcess } from '../../storage/src/process-identity.js';
import { ClaudeNativeSessionResolver, claudeHasConversation, claudeResumeFromObservation } from './claude-native-session.js';
import { parseJsonlObjects, readHead, readTail } from './session-id/fs-scan.js';
import { ClaudeTranscriptTailer } from './transcript/claude.js';
import { claudeProjectDir } from './cli-paths.js';
import type { DriverTranscriptSourceObservation, NormalizedDriverEvent } from '@dutydeck/shared';
const fixture = fileURLToPath(new URL('./fixtures/claude-native-session.mjs', import.meta.url));
const oldId = '11111111-1111-4111-8111-111111111111', newId = '22222222-2222-4222-8222-222222222222';
const line = (record: unknown) => JSON.stringify(record) + '\n';

describe.skipIf(process.platform !== 'linux')('owned live Claude session', () => {
  it('follows clear/resume/branch, baselines history and rejects sibling/PID reuse/empty cold targets', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dd-native-claude-'))), env = { ...process.env, HOME: cwd, CLAUDE_CONFIG_DIR: cwd };
    const child = spawn(process.execPath, [fixture, '--session-id', oldId], { cwd, env });
    const sibling = spawn(process.execPath, [fixture, '--session-id', '33333333-3333-4333-8333-333333333333'], { cwd, env });
    const statePath = join(cwd, 'sessions', child.pid + '.json');
    const project = claudeProjectDir(cwd, env), oldPath = join(project, oldId + '.jsonl');
    let tailer: ClaudeTranscriptTailer | undefined;
    try {
      await vi.waitFor(() => expect(JSON.parse(readFileSync(statePath, 'utf8')).sessionId).toBe(oldId));
      const identity = childProcessIdentity(child.pid!);
      const alias = join(cwd, 'config-alias'); symlinkSync(cwd, alias);
      const scan = vi.spyOn(sessionBackends, 'descendantPids');
      const resolver = new ClaudeNativeSessionResolver(identity, cwd, { ...env, CLAUDE_CONFIG_DIR: alias }, { identify: childProcessIdentity, observe: observeProcess });
      expect(resolver.resolve()?.nativeSessionId).toBe(oldId);
      const scanCount = scan.mock.calls.length;
      for (let i = 0; i < 20; i++) expect(resolver.resolve()?.nativeSessionId).toBe(oldId);
      expect(scan).toHaveBeenCalledTimes(scanCount);
      scan.mockRestore();
      writeFileSync(oldPath, '');
      const events: NormalizedDriverEvent[] = [], switches = vi.fn();
      let latest: DriverTranscriptSourceObservation | undefined;
      tailer = new ClaudeTranscriptTailer({ cwd, env, sessionId: 'ses_native_test', nativeSession: () => resolver.resolve(), onNativeSessionSwitch: switches,
        onNativeSession: source => { latest = { observationId: 'fixture', client: 'claude', launchKind: 'created', proofKind: 'launch_observed', capturedAt: new Date().toISOString(), dataRoot: source.dataRoot, cwd, nativeSessionId: source.resumable ? source.nativeSessionId : null, verifiedPath: source.resumable ? source.path : null, identityProof: source.identityProof }; } });
      tailer.onEvent(event => events.push(event)); tailer.start(); await tailer.flush();
      const send = async (prompt: string) => {
        const receipt = tailer!.waitForInput(prompt, new AbortController().signal);
        child.stdin.write(JSON.stringify({ prompt }) + '\n'); await receipt;
        await vi.waitFor(() => expect(events.some(event => event.type === 'text' && event.data.text === 'ANSWER:' + prompt)).toBe(true));
      };
      await send('before');
      child.stdin.write('/clear ' + newId + '\n');
      await vi.waitFor(() => expect(switches).toHaveBeenCalledTimes(1));
      expect(latest?.nativeSessionId).toBeNull();
      expect(claudeResumeFromObservation(latest!, cwd, env)).toBeUndefined();
      appendFileSync(join(project, newId + '.jsonl'), line({ type: 'system', subtype: 'metadata', sessionId: newId }));
      await tailer.flush(); expect(latest?.nativeSessionId).toBeNull();
      await send('after'); await tailer.flush();
      const recovered = new ClaudeTranscriptTailer({ cwd, env, nativeSession: () => resolver.resolve() });
      expect(() => recovered.restore({ path: oldPath, offset: 0 })).toThrow('differs from resolved path');
      recovered.stop();
      expect(claudeResumeFromObservation(latest!, cwd, env)).toBe(newId);
      expect(claudeResumeFromObservation(latest!, cwd, { ...env, CLAUDE_CONFIG_DIR: alias })).toBe(newId);
      expect(claudeResumeFromObservation({ ...latest!, verifiedPath: oldPath }, cwd, env)).toBeUndefined();
      expect(claudeResumeFromObservation({ ...latest!, identityProof: 'pty-claude-process-v1:forged' }, cwd, env)).toBeUndefined();
      expect(claudeResumeFromObservation({ ...latest!, dataRoot: '/another-account' }, cwd, env)).toBeUndefined();
      // An old file's late receipt and answer cannot satisfy input in the new file.
      const abort = new AbortController(); let confirmed = false;
      const receipt = tailer.waitForInput('late', abort.signal).then(() => { confirmed = true; }, () => {});
      appendFileSync(oldPath, line({ type: 'user', sessionId: oldId, timestamp: new Date().toISOString(), message: { content: 'late' } })
        + line({ type: 'assistant', sessionId: oldId, message: { content: 'OLD LATE' } }));
      await tailer.flush(); expect(confirmed).toBe(false); abort.abort(); await receipt;
      for (const command of ['/resume', '/branch']) {
        child.stdin.write(command + ' ' + oldId + '\n');
        await vi.waitFor(() => expect(tailer!.checkpoint().path).toBe(oldPath));
        expect(events.some(event => event.type === 'text' && ['HISTORY', 'OLD LATE'].includes(event.data.text))).toBe(false);
        await send(command);
        child.stdin.write('/clear ' + newId + '\n');
        await vi.waitFor(() => expect(tailer!.checkpoint().path).toBe(join(project, newId + '.jsonl')));
      }
      const before = switches.mock.calls.length; child.stdin.write('/compact\n'); await new Promise(resolve => setTimeout(resolve, 350)); expect(switches).toHaveBeenCalledTimes(before);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      writeFileSync(statePath, JSON.stringify({ ...state, cwd: '/' })); expect(resolver.resolve()).toBeUndefined();
      writeFileSync(statePath, JSON.stringify({ ...state, procStart: '0' })); expect(resolver.resolve()).toBeUndefined();
      // A borrowed birth identity never authorizes the current PID occupant.
      expect(new ClaudeNativeSessionResolver({ ...identity, start: '0' }, cwd, env, { identify: childProcessIdentity, observe: observeProcess }).resolve()).toBeUndefined();
      const stopped = new AbortController(), pending = tailer.waitForInput('never', stopped.signal);
      tailer.stop(); await expect(pending).rejects.toThrow('stopped');
    } finally {
      tailer?.stop(); child.kill('SIGKILL'); sibling.kill('SIGKILL');
      await Promise.all([child, sibling].map(child => new Promise<void>(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve()))));
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);
});

/** The pre-anchor implementation, kept verbatim as the equivalence oracle. */
function referenceHasConversation(path: string, id: string, cwd: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!(stat.isFile() && stat.uid === process.getuid?.() && realpathSync(path) === path)) return false;
  } catch { return false; }
  try {
    for (const entry of parseJsonlObjects(readHead(path, 256 * 1024) + '\n' + readTail(path, 256 * 1024))) {
      if (entry.isSidechain || entry.sessionId !== id || !['user', 'assistant'].includes(entry.type)) continue;
      if (entry.cwd && realpathSync(entry.cwd) !== cwd) continue;
      const content = entry.message?.content;
      if (typeof content === 'string' ? content.trim().length > 0 : Array.isArray(content) && content.length > 0) return true;
    }
  } catch { /* Unreadable content is not a resume target. */ }
  return false;
}
type Cached = { hasConversation(path: string, id: string): boolean; conversationAnchor?: object };
function conversationFixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dd-claude-conv-')));
  const path = join(cwd, oldId + '.jsonl');
  const resolver = new ClaudeNativeSessionResolver({ pid: 1, start: '0' } as never, cwd, { CLAUDE_CONFIG_DIR: cwd }, { identify: childProcessIdentity, observe: observeProcess }) as unknown as Cached;
  const check = () => {
    const expected = referenceHasConversation(path, oldId, cwd);
    expect(claudeHasConversation(path, oldId, cwd)).toBe(expected);
    expect(resolver.hasConversation(path, oldId)).toBe(expected);
    return expected;
  };
  return { cwd, path, resolver, check, done: () => rmSync(cwd, { recursive: true, force: true }) };
}
const user = (cwd: string | undefined, content: unknown, extra: object = {}) => line({ type: 'user', sessionId: oldId, ...(cwd ? { cwd } : {}), message: { content }, ...extra });

describe('anchored Claude conversation check', () => {
  it('keeps the anchor across appends and rescans when the prefix is rewritten in place', () => {
    const { cwd, path, resolver, check, done } = conversationFixture();
    try {
      writeFileSync(path, line({ type: 'system', sessionId: oldId }) + user(cwd, 'héllo ✓'));
      expect(check()).toBe(true);
      const anchor = resolver.conversationAnchor; expect(anchor).toBeDefined();
      for (let i = 0; i < 5; i++) { appendFileSync(path, line({ type: 'assistant', sessionId: oldId, message: { content: 'x'.repeat(100_000) } })); expect(check()).toBe(true); }
      expect(resolver.conversationAnchor).toBe(anchor);
      // Same inode, first line rewritten to another session: must rescan and become false.
      const text = readFileSync(path, 'utf8').replace(`"sessionId":"${oldId}","cwd"`, `"sessionId":"${newId}","cwd"`);
      writeFileSync(path, text.replaceAll(`"type":"assistant","sessionId":"${oldId}"`, `"type":"assistant","sessionId":"${newId}"`));
      expect(check()).toBe(false);
      expect(resolver.conversationAnchor).toBeUndefined();
    } finally { done(); }
  });

  it('rechecks the cwd realpath, earlier cwd realpaths, and truncation below the anchor', () => {
    const { cwd, path, resolver, check, done } = conversationFixture();
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'dd-claude-other-')));
    try {
      const alias = join(other, 'alias'); symlinkSync(cwd, alias);
      const earlier = join(other, 'earlier'); mkdirSync(earlier);
      writeFileSync(path, user(earlier, 'elsewhere') + user(alias, 'here'));
      expect(check()).toBe(true); expect(resolver.conversationAnchor).toBeDefined();
      // An earlier entry whose cwd now fails realpath ends the original scan with false.
      rmSync(earlier, { recursive: true }); appendFileSync(path, user(cwd, 'more'));
      expect(check()).toBe(false);
      mkdirSync(earlier); appendFileSync(path, user(cwd, 'more'));
      expect(check()).toBe(true);
      // The anchor cwd now points somewhere else.
      rmSync(alias); symlinkSync(other, alias); appendFileSync(path, '\n');
      expect(check()).toBe(true); // A later entry in this cwd still matches.
      writeFileSync(path, user(earlier, 'elsewhere') + user(alias, 'here'));
      expect(check()).toBe(false);
      rmSync(alias); symlinkSync(cwd, alias); writeFileSync(path, user(alias, 'here') + user(alias, 'again'));
      expect(check()).toBe(true);
      truncateSync(path, 10); expect(check()).toBe(false);
    } finally { done(); rmSync(other, { recursive: true, force: true }); }
  });

  it('never anchors a match found only in the tail window or in a truncated head line', () => {
    const { cwd, path, resolver, check, done } = conversationFixture();
    try {
      writeFileSync(path, line({ type: 'system', pad: 'p'.repeat(300 * 1024) }) + user(cwd, 'late'));
      expect(check()).toBe(true); expect(resolver.conversationAnchor).toBeUndefined();
      appendFileSync(path, line({ type: 'system', pad: 'q'.repeat(300 * 1024) }));
      expect(check()).toBe(false);
      writeFileSync(path, user(cwd, 'no newline').trimEnd());
      expect(check()).toBe(true); expect(resolver.conversationAnchor).toBeUndefined();
      // A file replaced by another inode with the same prefix still answers correctly.
      writeFileSync(path, user(cwd, 'first'));
      expect(check()).toBe(true);
      const replacement = path + '.new'; writeFileSync(replacement, user(cwd, 'first') + user(cwd, 'second')); renameSync(replacement, path);
      expect(check()).toBe(true);
    } finally { done(); }
  });

  it('matches the original scan under random appends and rewrites', () => {
    const { cwd, path, check, done } = conversationFixture();
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const gone = join(cwd, 'gone');
    const pick = <T,>(values: T[]) => values[Math.floor(random() * values.length)]!;
    const record = () => pick([
      () => user(pick([cwd, undefined, gone, '/']), pick(['', '  ', 'hi', [], [{ type: 'text' }]])),
      () => user(cwd, 'side', { isSidechain: true }),
      () => line({ type: 'assistant', sessionId: pick([oldId, newId]), cwd, message: { content: 'é'.repeat(Math.floor(random() * 2000)) } }),
      () => line({ type: 'system', pad: 'z'.repeat(Math.floor(random() * 120_000)) }),
      () => '{"type":"user","sessionId":"' + oldId + '","message":{"content":"partial',
      () => '\u00e2\n',
    ])();
    try {
      writeFileSync(path, '');
      let trues = 0;
      for (let step = 0; step < 300; step++) {
        const action = random();
        if (action < 0.75) appendFileSync(path, record());
        else if (action < 0.85) writeFileSync(path, record() + record());
        else if (action < 0.92) truncateSync(path, Math.floor(random() * readFileSync(path).length));
        else if (action < 0.96) mkdirSync(gone, { recursive: true });
        else rmSync(gone, { recursive: true, force: true });
        if (check()) trues++;
      }
      expect(trues).toBeGreaterThan(30);
      expect(trues).toBeLessThan(300);
    } finally { done(); }
  });
});

describe.skipIf(process.platform !== 'linux')('native session discovery from PID state files', () => {
  const spawnFixture = (cwd: string, env: NodeJS.ProcessEnv, id: string) => spawn(process.execPath, [fixture, '--session-id', id], { cwd, env });
  const stop = async (...children: Array<ReturnType<typeof spawn>>) => {
    for (const child of children) child.kill('SIGKILL');
    await Promise.all(children.map(child => new Promise<void>(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve()))));
  };
  it('rejects stale and foreign state files, ambiguous descendants and a missing sessions directory', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dd-native-disc-'))), env = { ...process.env, HOME: cwd, CLAUDE_CONFIG_DIR: cwd };
    const probe = { identify: childProcessIdentity, observe: observeProcess };
    const self = childProcessIdentity(process.pid);
    try {
      // No sessions directory yet.
      expect(new ClaudeNativeSessionResolver(self, cwd, env, probe).resolve()).toBeUndefined();
      // A shell root with two CLI descendants is ambiguous.
      const shell = spawn('/bin/sh', ['-c', `exec 3<&0; "${process.execPath}" "${fixture}" --session-id ${oldId} <&3 & "${process.execPath}" "${fixture}" --session-id ${newId} <&3 & wait`], { cwd, env });
      try {
        await vi.waitFor(() => expect(readFileSync(join(cwd, 'launches.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2));
        const states = () => readFileSync(join(cwd, 'launches.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row).pid as number);
        await vi.waitFor(() => { for (const pid of states()) expect(JSON.parse(readFileSync(join(cwd, 'sessions', pid + '.json'), 'utf8')).pid).toBe(pid); });
        const shellIdentity = childProcessIdentity(shell.pid!);
        expect(new ClaudeNativeSessionResolver(shellIdentity, cwd, env, probe).resolve(true)).toBeUndefined();
        // Kill one descendant: its state file goes stale, the remaining one matches.
        const launches = readFileSync(join(cwd, 'launches.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row) as { sid: string; pid: number });
        const first = launches.find(launch => launch.sid === oldId)!.pid, second = launches.find(launch => launch.sid === newId)!.pid;
        process.kill(first, 'SIGKILL');
        await vi.waitFor(() => expect(observeProcess(childProcessIdentity(second))).toBe('alive'));
        await vi.waitFor(() => expect(() => childProcessIdentity(first)).toThrow());
        expect(new ClaudeNativeSessionResolver(shellIdentity, cwd, env, probe).resolve(true)?.nativeSessionId).toBe(newId);
        // The test runner is not a descendant of the shell even with a forged state file.
        writeFileSync(join(cwd, 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, procStart: self.start, sessionId: oldId, cwd }));
        expect(new ClaudeNativeSessionResolver(shellIdentity, cwd, env, probe).resolve(true)?.nativeSessionId).toBe(newId);
        writeFileSync(join(cwd, 'sessions', 'junk.json'), '{}'); writeFileSync(join(cwd, 'sessions', '0.json'), '{}');
        expect(new ClaudeNativeSessionResolver(shellIdentity, cwd, env, probe).resolve(true)?.nativeSessionId).toBe(newId);
      } finally { await stop(shell); for (const pid of (() => { try { return readFileSync(join(cwd, 'launches.jsonl'), 'utf8').trim().split('\n').map(row => JSON.parse(row).pid as number); } catch { return []; } })()) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 15_000);

  it('drops a CLI whose working directory was deleted, as the JS realpath did', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dd-native-root-')));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dd-native-cwd-'))), env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: root };
    const child = spawnFixture(cwd, env, oldId);
    try {
      await vi.waitFor(() => expect(JSON.parse(readFileSync(join(root, 'sessions', child.pid + '.json'), 'utf8')).sessionId).toBe(oldId));
      const resolver = new ClaudeNativeSessionResolver(childProcessIdentity(child.pid!), cwd, env, { identify: childProcessIdentity, observe: observeProcess });
      expect(resolver.resolve()?.nativeSessionId).toBe(oldId);
      rmSync(cwd, { recursive: true, force: true });
      const proc = `/proc/${child.pid}/cwd`;
      expect(() => realpathSync(proc)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
      expect(() => realpathSync.native(proc)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
      expect(resolver.resolve()).toBeUndefined();
    } finally { await stop(child); rmSync(root, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
  });
});
