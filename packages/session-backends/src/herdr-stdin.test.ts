import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('handles a real controller stdin EPIPE without killing the host or the primary pane', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dd-herdr-stdin-'));
  const binary = join(directory, 'controller');
  writeFileSync(binary, `#!${process.execPath}\nrequire('node:fs').closeSync(0);\nprocess.stdout.write(JSON.stringify({type:'terminal.frame',bytes:'',width:80,height:24})+'\\n');\nsetTimeout(()=>process.exit(0),3000);\n`, { mode: 0o700 });
  const source = new URL('./herdr-backend.ts', import.meta.url).href;
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { HerdrBackend } from ${JSON.stringify(source)};
      const backend = new HerdrBackend('dutydeck-'+'b'.repeat(32), {
        binary: ${JSON.stringify(binary)}, stateFile: ${JSON.stringify(join(directory, 'missing.json'))}, ownerId: 'fixture',
        processProbe: { identify: pid => ({pid}), observe: () => 'alive' }
      });
      const state = { root: { pid: process.pid }, pane: { terminal_id: 'owned-pane' }, identities: [] };
      backend.state = state;
      backend.checked = async () => state;
      backend.captureOwnedIdentity = async () => state;
      backend.persist = () => {};
      await backend.attach({cols:80,rows:24});
      let disconnected = 0, exited = 0;
      backend.onDisconnect(() => disconnected++);
      backend.onExit(() => exited++);
      try {
        const error = await backend.resize(100, 40).then(() => undefined, error => error);
        await new Promise(resolve => setImmediate(resolve));
        assert.match(error?.message ?? 'resize unexpectedly resolved', /EPIPE/);
        assert.equal(backend.getPid(), process.pid);
        assert.equal(backend.state, state);
        assert.equal(disconnected, 1);
        assert.equal(exited, 0);
        assert.equal(await backend.isStopped(), false);
        console.log('host alive; primary exit unproven');
      } finally { await backend.detach(); }
    `], { timeout: 10_000 });
    expect(stderr).toBe('');
    expect(stdout).toContain('host alive; primary exit unproven');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
