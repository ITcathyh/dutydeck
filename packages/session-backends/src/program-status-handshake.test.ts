import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';
import { HerdrBackend, herdrControlEnvironment } from './herdr-backend.js';
import { PtyBackend } from './pty-backend.js';
import { TmuxBackend } from './tmux-backend.js';
import { ProgramStatusProbeRelay, PROGRAM_STATUS_PROBE_REPLY } from './program-status-probe-relay.js';
import type { SessionBackend } from './types.js';

// Every management command in this test explicitly selects its private socket.
const isolated = vi.hoisted(() => ({ socket: '' }));
vi.mock('./command.js', async original => {
  const real = await original<typeof import('./command.js')>();
  return { ...real, runCommand: (bin: string, args: string[], options: Parameters<typeof real.runCommand>[2]) =>
    real.runCommand(bin, bin === 'tmux' ? ['-S', isolated.socket, ...args] : args, options) };
});

describe('OSC 7501 handshake', () => {
  let root: string, backend: SessionBackend | undefined;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dutydeck-osc-handshake-')); isolated.socket = join(root, 'tmux.sock'); });
  afterEach(async () => {
    if (backend instanceof HerdrBackend) {
      await backend.stopOwnedIdentity();
      try { execFileSync('herdr', ['--session', backend.sessionName, 'session', 'delete', backend.sessionName, '--json'], { env: herdrControlEnvironment(process.env), stdio: 'pipe' }); } catch { /* Already retired. */ }
    } else await backend?.kill();
    backend = undefined; rmSync(root, { recursive: true, force: true });
  });
  it('answers before forwarding the DA1 sentinel, preserving split UTF-8 bytes', () => {
    const input = Buffer.from('中文\x1b]7501;?\x07\x1b[c');
    for (let split = 0; split < input.length; split++) {
      const relay = new ProgramStatusProbeRelay();
      const actions = [...relay.feed(input.subarray(0, split)), ...relay.feed(input.subarray(split))];
      const result: string[] = [];
      for (const action of actions) result.push('answer' in action ? 'REPLY' : action.forward.toString('latin1'));
      expect(result.join('')).toBe(Buffer.from('中文').toString('latin1') + 'REPLY\x1b[c');
    }
  });
  it.each(['pty', 'tmux'] as const)('%s negotiates with a real PTY before the sentinel response', async kind => {
    const fixture = join(root, 'probe.mjs');
    writeFileSync(fixture, `
process.stdin.setRawMode(true);
process.stdout.write('\\x1b]7501;?\\x07\\x1b[c');
let received = '';
process.stdin.on('data', data => {
  received += data.toString();
  if (received.includes('\\x1b]7501;?\\x1b\\\\')) {
    process.stdout.write('FIRST:' + JSON.stringify(received) + '\\r\\n\\x1b]7501;state=idle:app=claude-code\\x07');
  }
});
setInterval(() => {}, 1000);
`);
    backend = kind === 'pty' ? new PtyBackend() : new TmuxBackend('osc-handshake');
    let output = '';
    await backend.spawn(process.execPath, [fixture], { cwd: root, cols: 80, rows: 24, env: { PATH: process.env.PATH ?? '', HOME: root }, programStatus: true });
    backend.onData(data => { output += data; });
    await vi.waitFor(() => expect(output).toContain('FIRST:'), { timeout: 10_000 });
    const first = JSON.parse(output.slice(output.indexOf('FIRST:') + 6).match(/^"(?:\\.|[^"\\])*"/)![0]);
    expect(first.startsWith(PROGRAM_STATUS_PROBE_REPLY)).toBe(true);
    await backend.write('status');
    await vi.waitFor(() => expect(output).toContain('\x1b]7501;state=idle:app=claude-code\x07'));
  }, 20_000);
  it.skipIf(process.env.DUTYDECK_TEST_HERDR !== 'true')('Herdr renders visible screen updates but strips OSC status frames', async () => {
    const fixture = join(root, 'render.mjs');
    writeFileSync(fixture, `process.stdin.setRawMode(true);
const render = text => process.stdout.write(text + '\\r\\n\\x1b]7501;state=working:app=claude-code\\x07');
render('BEFORE_INPUT'); process.stdin.on('data', () => render('AFTER_INPUT')); setInterval(() => {}, 1000);`);
    const herdr = new HerdrBackend(`dutydeck-${randomBytes(16).toString('hex')}`, {
      binary: execFileSync('/bin/sh', ['-c', 'command -v herdr'], { encoding: 'utf8' }).trim(),
      stateFile: join(root, 'identity.json'), ownerId: 'dutydeck:osc-screen-boundary',
      processProbe: { identify: childProcessIdentity, observe: observeProcess },
    });
    backend = herdr;
    await herdr.spawn(process.execPath, [fixture], { cwd: root, cols: 80, rows: 24, env: { PATH: process.env.PATH ?? '', HOME: root } });
    let output = herdr.initialScreen?.data ?? '';
    herdr.onData(data => { output += data; });
    await herdr.write('status');
    await vi.waitFor(() => expect(output).toContain('AFTER_INPUT'));
    expect(output).toContain('BEFORE_INPUT');
    expect(output).not.toContain('\x1b]7501;');
  }, 20_000);

});
