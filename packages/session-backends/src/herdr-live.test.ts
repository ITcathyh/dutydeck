import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';
import { HerdrBackend, herdrControlEnvironment } from './herdr-backend.js';

describe.skipIf(process.env.DUTYDECK_TEST_HERDR !== 'true')('real primary Herdr backend', () => {
  it('streams actual input/output, preserves identity on reattach, refuses foreign state, resizes and proves owned exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-primary-herdr-'));
    const name = `dutydeck-${randomBytes(16).toString('hex')}`;
    const control = (args: string[]) => execFileSync('herdr', ['--session', name, ...args], { env: herdrControlEnvironment(process.env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const before = execFileSync('herdr', ['--session', 'default', 'pane', 'list'], { env: herdrControlEnvironment(process.env), encoding: 'utf8' });
    const binary = execFileSync('/bin/sh', ['-c', 'command -v herdr'], { encoding: 'utf8' }).trim();
    const options = { binary, stateFile: join(dir, 'identity.json'), ownerId: 'dutydeck:fixture', processProbe: { identify: childProcessIdentity, observe: observeProcess }, env: { ...process.env, HERDR_SOCKET_PATH: '/fake.sock', HERDR_PANE_ID: 'fake:p1' } };
    const backend = new HerdrBackend(name, options);
    let attached: HerdrBackend | undefined;
    try {
      await (await backend.spawn('/bin/sh', ['-c', 'printf "PRIMARY_READY\n"; while IFS= read -r line; do printf "PROCESSED:%s\n" "$line"; done'], { cwd: dir, cols: 120, rows: 30, env: { PATH: process.env.PATH!, HERDR_PANE_ID: 'fake:p1' } }));
      const pid = (await backend.getPid()), state = JSON.parse(readFileSync(options.stateFile, 'utf8'));
      expect(backend.initialScreen?.data).toContain('PRIMARY_READY');
      const env = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      expect(env).toContain(`HERDR_PANE_ID=${state.pane.pane_id}`);
      expect(realpathSync(env.find(value => value.startsWith('HERDR_SOCKET_PATH='))!.slice('HERDR_SOCKET_PATH='.length))).toBe(state.socket);
      expect(env).toContain('HERDR_ENV=1');
      let output = ''; backend.onData(data => { output += data; });
      expect((await (await backend.write('ACTUAL_INPUT\n')))).toBe(true);
      await expect.poll(() => output).toContain('PROCESSED:ACTUAL_INPUT');
      (await backend.resize(83, 23));
      await expect.poll(async () => (await backend.getPaneSize())).toEqual({ cols: 83, rows: 23 });
      (await (await backend.setDutydeckMetadata('first_prompt_sent', 'true')));
      (await (await backend.setDutydeckMetadata('turn_id', 'original-turn')));
      const snapshot = (await (await backend.captureOwnedIdentity()));
      const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
      (await (await backend.assertOwnedIdentity(JSON.parse(JSON.stringify(canonical(snapshot))))));
      (await (await backend.detach()));
      expect((await (await backend.isStopped()))).toBe(false);
      attached = new HerdrBackend(name, options);
      await (await attached.attach({ cols: 120, rows: 30 }));
      expect((await attached.getPid())).toBe(pid);
      expect((await attached.getDutydeckMetadata('turn_id'))).toBe('original-turn');
      expect(attached.initialScreen?.data).toContain('PROCESSED:ACTUAL_INPUT');
      expect(() => new HerdrBackend(name, { ...options, ownerId: 'foreign' })).toThrow('HERDR_OWNER_MISMATCH');
      const bad = { ...(snapshot as object), socket: '/fake.sock' };
      expect((await attached.verifyOwnedIdentity(bad))).toBe(false);
      await expect(attached.stopOwnedIdentity(bad)).rejects.toThrow('HERDR_RETIREMENT_SCOPE_CONFLICT');
      expect((await attached.getPid())).toBe(pid);
      await attached.stopOwnedIdentity();
      expect((await attached.isStopped())).toBe(true);
      expect(observeProcess(childProcessIdentity(process.pid))).toBe('alive');
      const after = execFileSync('herdr', ['--session', 'default', 'pane', 'list'], { env: herdrControlEnvironment(process.env), encoding: 'utf8' });
      const ids = (raw: string) => JSON.parse(raw).result.panes.map((pane: any) => [pane.pane_id, pane.terminal_id]);
      expect(ids(after)).toEqual(ids(before));
      console.log(JSON.stringify({ primary_herdr: { name, pid, actual_io: true, resized: true, authoritative_env: true, same_pid_reattach: true, physical_exit_proven: true, default_unchanged: true } }));
    } finally {
      (await attached?.detach()); (await (await backend.detach()));
      try { control(['session', 'stop', name, '--json']); } catch {}
      try { control(['session', 'delete', name, '--json']); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
