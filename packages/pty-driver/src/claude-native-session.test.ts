import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sessionBackends from '@dutydeck/session-backends';
import { childProcessIdentity, observeProcess } from '../../storage/src/process-identity.js';
import { ClaudeNativeSessionResolver, claudeResumeFromObservation } from './claude-native-session.js';
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
