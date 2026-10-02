import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as policy from '@dutydeck/shared/child-environment';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';
import { HerdrBackend, herdrControlEnvironment } from './herdr-backend.js';

describe.skipIf(process.env.DUTYDECK_TEST_HERDR !== 'true')('owned Herdr server environment reuse', () => {
  it.each([false, true])('preserves independent panes while reusing/rejecting a server (legacy dirty: %s)', async dirty => {
    const cwd = mkdtempSync(join(tmpdir(), 'dd-herdr-env-reuse-'));
    const name = `dutydeck-${randomBytes(16).toString('hex')}`;
    const binary = execFileSync('/bin/sh', ['-c', 'command -v herdr'], { encoding: 'utf8' }).trim();
    const options = { binary, stateFile: join(cwd, 'state.json'), ownerId: 'fixture', processProbe: { identify: childProcessIdentity, observe: observeProcess }, env: { ...process.env, BOTMUX_SESSION_ID: 'sentinel-legacy-session', LARK_APP_SECRET: 'sentinel-legacy-secret' } };
    const backend = new HerdrBackend(name, options);
    let replacement: HerdrBackend | undefined;
    const spawnOptions = { cwd, cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin' } };
    try {
      // Simulate the prior release's server-spawn boundary once. The actual
      // Herdr daemon and both primary/independent panes remain real processes.
      if (dirty) vi.spyOn(policy, 'childEnvironment').mockImplementationOnce(inherited => Object.fromEntries(Object.entries(inherited).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
      await backend.spawn('/bin/sh', ['-c', 'printf "PRIMARY_READY\\n"; while IFS= read -r line; do :; done'], spawnOptions);
      vi.restoreAllMocks();
      const original = JSON.parse(readFileSync(options.stateFile, 'utf8'));
      const request = (backend as any).request.bind(backend);
      const workspace = await request('workspace.create', { cwd, label: 'Independent worker', focus: false }, original.socket);
      const sibling = await request('layout.apply', { tab_id: workspace.tab.tab_id, focus: false, root: { type: 'pane', cwd, command: ['/bin/sh', '-c', 'sleep 60'], env: spawnOptions.env } }, original.socket);
      const control = (args: string[]) => execFileSync(binary, ['--session', name, ...args], { env: herdrControlEnvironment(process.env), encoding: 'utf8' });
      const panesBefore = JSON.parse(control(['pane', 'list'])).result.panes;
      const siblingId = sibling.layout.root.pane_id;
      expect(panesBefore.some((pane: any) => pane.pane_id === siblingId)).toBe(true);
      await backend.kill();
      expect(await backend.isStopped()).toBe(true);
      expect(observeProcess(original.server)).toBe('alive');
      const stateBefore = readFileSync(options.stateFile, 'utf8');
      replacement = new HerdrBackend(name, options);
      if (dirty) {
        await expect(replacement.spawn('/bin/sh', ['-c', 'sleep 60'], spawnOptions)).rejects.toThrow('HERDR_SERVER_ENVIRONMENT_DIRTY');
        expect(readFileSync(options.stateFile, 'utf8')).toBe(stateBefore);
      } else {
        await replacement.spawn('/bin/sh', ['-c', 'printf "REUSED_READY\\n"; while IFS= read -r line; do :; done'], spawnOptions);
        expect(JSON.parse(readFileSync(options.stateFile, 'utf8')).server).toEqual(original.server);
        const env = readFileSync(`/proc/${replacement.getPid()}/environ`, 'utf8');
        expect(env).not.toContain('BOTMUX_SESSION_ID=');
        expect(env).not.toContain('LARK_APP_SECRET=');
      }
      expect(observeProcess(original.server)).toBe('alive');
      expect(JSON.parse(control(['pane', 'list'])).result.panes.some((pane: any) => pane.pane_id === siblingId)).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await replacement?.detach(); await backend.detach();
      for (const action of ['stop', 'delete']) {
        try { execFileSync(binary, ['session', action, name, '--json'], { env: herdrControlEnvironment(process.env), stdio: 'pipe' }); } catch { /* owned fixture cleanup */ }
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);
});
