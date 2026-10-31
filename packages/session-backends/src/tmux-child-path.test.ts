import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TmuxBackend, isTmuxAvailable } from './tmux-backend.js';

// respawn-pane hands the pane the management client's PATH, ignoring the
// staged session value. These run real tmux on a private socket directory.
const tmuxDescribe = (await isTmuxAvailable()) ? describe : describe.skip;

tmuxDescribe('TmuxBackend child PATH', () => {
  let root: string, launchRoot: string, toolDir: string, fixture: string, daemonPath: string;
  const backends: TmuxBackend[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dd-tmux-path-'));
    launchRoot = join(root, 'tmp');
    toolDir = join(root, 'child-only-bin');
    mkdirSync(launchRoot);
    mkdirSync(toolDir);
    vi.stubEnv('HOME', root);
    vi.stubEnv('TMUX_TMPDIR', root);
    vi.stubEnv('TMUX', undefined);
    vi.stubEnv('TMUX_PANE', undefined);
    vi.stubEnv('TMPDIR', launchRoot);
    // The daemon (and so every tmux management client) keeps a directory the
    // child must not see, e.g. an identity wrapper directory.
    daemonPath = `${process.env.PATH}:${join(root, 'cli-identity', 'old.bin')}`;
    vi.stubEnv('PATH', daemonPath);
    fixture = join(root, 'child.mjs');
    writeFileSync(fixture, `import {renameSync, writeFileSync} from 'node:fs';
const output = process.argv[2];
writeFileSync(output + '.tmp', JSON.stringify({ hasPath: 'PATH' in process.env, PATH: process.env.PATH, pid: process.pid }));
renameSync(output + '.tmp', output);
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

  const launch = async (label: string, PATH: string, command = [process.execPath, fixture]) => {
    const backend = new TmuxBackend(`dd-path-${process.pid}-${label}`);
    backends.push(backend);
    const output = join(root, `${label}.json`);
    await backend.spawn(command[0]!, [...command.slice(1), output], {
      cwd: root, cols: 80, rows: 24, env: { HOME: root, PATH },
    });
    await expect.poll(() => { try { return JSON.parse(readFileSync(output, 'utf8')); } catch { return undefined; } }, { timeout: 10_000 }).toBeDefined();
    return { backend, PATH, child: JSON.parse(readFileSync(output, 'utf8')) };
  };

  it('starts concurrent children with their own PATH, including an empty one, not the client PATH', async () => {
    const launched = await Promise.all([
      launch('clean', `/usr/bin:/bin:${toolDir}`),
      launch('empty', ''),
      launch('quoted', `${join(root, "tool dir with 'quote' and $HOME")}:/bin`),
    ]);
    for (const { backend, PATH, child } of launched) {
      // getPid() is a tmux management command issued while the child PATH may be empty.
      expect(child).toEqual({ hasPath: true, PATH, pid: await backend.getPid() });
    }
    expect(process.env.PATH).toBe(daemonPath);
    // The launch script still removes itself before PATH changes.
    expect(readdirSync(launchRoot).filter(name => name.startsWith('dutydeck-tmux-launch-'))).toEqual([]);
  });

  it('resolves a bare command through the child PATH and keeps managing the session', async () => {
    writeFileSync(join(toolDir, 'dd-path-agent'), `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 });
    const { backend, PATH, child } = await launch('bare', `${toolDir}:/usr/bin:/bin`, ['dd-path-agent']);
    expect(child).toEqual({ hasPath: true, PATH, pid: await backend.getPid() });
    expect(await TmuxBackend.probeSession(backend.sessionName)).toBe('exists');
    await backend.kill();
    expect(await TmuxBackend.probeSession(backend.sessionName)).toBe('missing');
  });
});
