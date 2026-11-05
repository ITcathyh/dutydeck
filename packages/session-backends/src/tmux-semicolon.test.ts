import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TmuxBackend, isTmuxAvailable } from './tmux-backend.js';

// tmux treats an argument ending in `;` as a command separator. These run
// real tmux on a private socket directory.
const tmuxDescribe = (await isTmuxAvailable()) ? describe : describe.skip;

tmuxDescribe('TmuxBackend trailing semicolons', () => {
  let root: string, fixture: string;
  const backends: TmuxBackend[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dd-tmux-semi-'));
    mkdirSync(join(root, 'tmp'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('TMUX_TMPDIR', root);
    vi.stubEnv('TMUX', undefined);
    vi.stubEnv('TMUX_PANE', undefined);
    vi.stubEnv('TMPDIR', join(root, 'tmp'));
    fixture = join(root, 'child.mjs');
    // Records the environment value and every raw input byte it receives.
    writeFileSync(fixture, `import { appendFileSync, writeFileSync } from 'node:fs';
const output = process.argv[2];
writeFileSync(output, '');
process.stdin.setRawMode(true);
process.stdin.on('data', chunk => appendFileSync(output, chunk));
writeFileSync(output + '.env', process.env.DD_SEMI ?? '<unset>');
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

  it('delivers input and environment values that end in a semicolon', async () => {
    const backend = new TmuxBackend(`dd-semi-${process.pid}`);
    backends.push(backend);
    const output = join(root, 'input.log');
    await backend.spawn(process.execPath, [fixture, output], {
      cwd: root, cols: 80, rows: 24, env: { HOME: root, PATH: process.env.PATH ?? '', DD_SEMI: 'history -a;' },
    });
    await expect.poll(() => { try { return readFileSync(`${output}.env`, 'utf8'); } catch { return undefined; } }, { timeout: 10_000 }).toBe('history -a;');
    for (const text of ['return x;', ';', 'a\\;', 'b;c']) expect(await backend.write(text)).toBe(true);
    await expect.poll(() => readFileSync(output, 'utf8'), { timeout: 5_000 }).toBe('return x;;a\\;b;c');
  });
});
