import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { childProcessIdentity, observeProcess } from '@dutydeck/storage';
import { HerdrBackend, herdrControlEnvironment } from './herdr-backend.js';

describe.skipIf(process.env.DUTYDECK_TEST_HERDR !== 'true')('real Herdr snapshot handoff', () => {
  it('retains subscription-window output and rebuilds capture while preserving the primary process and subscribers', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dd-herdr-handoff-')), name = `dutydeck-${randomBytes(16).toString('hex')}`;
    const binary = execFileSync('/bin/sh', ['-c', 'command -v herdr'], { encoding: 'utf8' }).trim();
    const backend = new HerdrBackend(name, { binary, stateFile: join(cwd, 'identity.json'), ownerId: 'dutydeck:handoff', processProbe: { identify: childProcessIdentity, observe: observeProcess } });
    try {
      await backend.spawn('/bin/sh', ['-c', 'stty -echo; printf "BEFORE_MARKER\\n"; while IFS= read -r line; do printf "PROCESSED:%s\\n" "$line"; done'], { cwd, cols: 120, rows: 30, env: { PATH: process.env.PATH! } });
      const pid = backend.getPid(), identity = childProcessIdentity(pid!);
      await backend.write('DURING_MARKER\n');
      await expect.poll(() => (backend as any).output.pending).toContain('PROCESSED:DURING_MARKER');
      let output = ''; backend.onData(data => { output += data; });
      expect(output).toContain('PROCESSED:DURING_MARKER');
      let boundary = false;
      const screen = await backend.resyncOutput(() => { boundary = true; output = ''; });
      expect(boundary).toBe(true); expect(screen).toContain('PROCESSED:DURING_MARKER');
      expect(backend.getPid()).toBe(pid); expect(observeProcess(identity)).toBe('alive');
      await backend.write('AFTER_MARKER\n');
      await expect.poll(() => output).toContain('PROCESSED:AFTER_MARKER');
      await backend.detach(); expect(observeProcess(identity)).toBe('alive');
      console.log(JSON.stringify({ herdr_handoff: { name, pid, pending_retained: true, resync_boundary: true, subscribers_preserved: true, primary_alive_after_detach: true } }));
    } finally {
      await backend.detach();
      for (const action of ['stop', 'delete']) { try { execFileSync(binary, ['session', action, name, '--json'], { env: herdrControlEnvironment(process.env), stdio: 'pipe' }); } catch { /* owned fixture cleanup */ } }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);
});
