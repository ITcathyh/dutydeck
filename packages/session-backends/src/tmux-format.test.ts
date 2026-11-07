import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TmuxBackend, isTmuxAvailable } from './tmux-backend.js';

// tmux format-expands new-session -s/-c, respawn-pane -c and the pipe-pane
// command. These run real tmux on a private socket directory.
const tmuxDescribe = (await isTmuxAvailable()) ? describe : describe.skip;

tmuxDescribe('TmuxBackend tmux format characters', () => {
  let root: string, fixture: string;
  const backends: TmuxBackend[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dd-tmux-fmt-'));
    // Capture sockets and launch scripts live under TMPDIR; keep it short enough for sockaddr_un.
    mkdirSync(join(root, 't%Y#S'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('TMUX_TMPDIR', root);
    vi.stubEnv('TMUX', undefined);
    vi.stubEnv('TMUX_PANE', undefined);
    vi.stubEnv('TMPDIR', join(root, 't%Y#S'));
    fixture = join(root, 'child.mjs');
    writeFileSync(fixture, `import { renameSync, writeFileSync } from 'node:fs';
const output = process.argv[2];
writeFileSync(output + '.tmp', JSON.stringify({ cwd: process.cwd() }));
renameSync(output + '.tmp', output);
process.stdout.write('fmt-ready-' + process.pid + '\\n');
setInterval(() => {}, 1000);
`);
  });

  afterEach(async () => {
    for (const backend of backends.splice(0)) await backend.kill();
  });

  afterAll(() => {
    try { execFileSync('tmux', ['-S', join(root, `tmux-${process.getuid!()}`, 'default'), 'kill-server'], { stdio: 'ignore' }); } catch { /* gone */ }
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const findAll = (dir: string, name: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.name === name ? [path] : entry.isDirectory() ? findAll(path, name) : [];
  });

  const launch = async (name: string, cwd: string) => {
    const backend = new TmuxBackend(name);
    backends.push(backend);
    let output = '';
    backend.onData(data => { output += data; });
    const result = join(root, `${backends.length}.json`);
    await backend.spawn(process.execPath, [fixture, result], { cwd, cols: 80, rows: 24, env: { HOME: root, PATH: process.env.PATH ?? '' } });
    await expect.poll(() => { try { return JSON.parse(readFileSync(result, 'utf8')); } catch { return undefined; } }, { timeout: 10_000 })
      .toEqual({ cwd });
    // The pipe-pane capture (socket under the `%`/`#` TMPDIR) still delivers output.
    await expect.poll(() => output, { timeout: 10_000 }).toMatch(/fmt-ready-\d+/);
  };

  it('starts the CLI in a cwd containing #(...) and #S literally without running commands', async () => {
    // A format job runs in the tmux client's cwd; `cd` first so a regression lands under HOME (root).
    const cwd = join(root, 'repo#(cd;touch dd-injected)#S#{session_name}');
    mkdirSync(cwd);
    await launch(`dd-fmt-${process.pid}-cwd`, cwd);
    expect(findAll(root, 'dd-injected')).toEqual([]);
  });

  it('keeps a cwd that ends in a semicolon', async () => {
    const cwd = join(root, 'repo;');
    mkdirSync(cwd);
    await launch(`dd-fmt-${process.pid}-semi`, cwd);
  });

  it('creates the session under its literal name', async () => {
    const name = `dd-fmt-${process.pid}-a#Sb`;
    await launch(name, root);
    expect(await TmuxBackend.probeSession(name)).toBe('exists');
  });
});
