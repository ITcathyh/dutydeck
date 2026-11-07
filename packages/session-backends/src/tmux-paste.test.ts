import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TmuxBackend, isTmuxAvailable } from './tmux-backend.js';

// Payloads that carry their own escape sequences reach the pane byte-exact;
// tmux adds bracketed-paste markers only around plain text, and LF never turns
// into CR. These run real tmux on a private socket directory.
const tmuxDescribe = (await isTmuxAvailable()) ? describe : describe.skip;

tmuxDescribe('TmuxBackend raw writes and pastes', () => {
  let root: string, fixture: string;
  const backends: TmuxBackend[] = [];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'dd-tmux-paste-'));
    mkdirSync(join(root, 'tmp'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('TMUX_TMPDIR', root);
    vi.stubEnv('TMUX', undefined);
    vi.stubEnv('TMUX_PANE', undefined);
    vi.stubEnv('TMPDIR', join(root, 'tmp'));
    fixture = join(root, 'child.mjs');
    // Records every raw input byte; optionally requests bracketed paste first.
    writeFileSync(fixture, `import { appendFileSync, writeFileSync } from 'node:fs';
const output = process.argv[2];
writeFileSync(output, '');
process.stdin.setRawMode(true);
process.stdin.on('data', chunk => appendFileSync(output, chunk));
if (process.argv[3] === 'bracketed') process.stdout.write('\\x1b[?2004h');
process.stdout.write('READY');
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

  async function start(name: string, mode: 'bracketed' | 'plain'): Promise<{ backend: TmuxBackend; received: () => string }> {
    const backend = new TmuxBackend(`dd-paste-${name}-${process.pid}`);
    backends.push(backend);
    const output = join(root, `${name}.log`);
    await backend.spawn(process.execPath, [fixture, output, mode], {
      cwd: root, cols: 80, rows: 24, env: { HOME: root, PATH: process.env.PATH ?? '' },
    });
    // READY is printed after the mode request, so tmux has applied the mode once it is on screen.
    await expect.poll(async () => (await backend.captureCurrentScreen()) ?? '', { timeout: 10_000 }).toContain('READY');
    return { backend, received: () => readFileSync(output, 'latin1') };
  }

  it('writes self-wrapped multiline and long payloads byte-exact to an application in bracketed-paste mode', async () => {
    const { backend, received } = await start('raw-bracketed', 'bracketed');
    const wrapped = '\x1b[200~first\nsecond\x1b[201~';
    const long = `\x1b[200~${'x'.repeat(5000)}\x1b[201~`;
    expect(await backend.write(wrapped)).toBe(true);
    expect(await backend.write(long)).toBe(true);
    await expect.poll(received, { timeout: 5_000 }).toBe(wrapped + long);
  });

  it('still pastes plain multiline text once, keeping LF, when the application requested bracketed paste', async () => {
    const { backend, received } = await start('text-bracketed', 'bracketed');
    const colored = 'first \x1b[31mred\x1b[0m\nsecond';
    expect(await backend.write('first\nsecond')).toBe(true);
    await expect.poll(received, { timeout: 5_000 }).toBe('\x1b[200~first\nsecond\x1b[201~');
    expect(await backend.write(colored)).toBe(true);
    await expect.poll(received, { timeout: 5_000 }).toBe(`\x1b[200~first\nsecond\x1b[201~\x1b[200~${colored}\x1b[201~`);
  });

  it('keeps LF as LF in a multiline write to an application without bracketed paste', async () => {
    const { backend, received } = await start('raw-plain', 'plain');
    expect(await backend.write('first\nsecond\n')).toBe(true);
    await expect.poll(received, { timeout: 5_000 }).toBe('first\nsecond\n');
  });

  it('pastes with markers only when the application requested bracketed paste, keeping LF', async () => {
    const bracketed = await start('paste-bracketed', 'bracketed');
    const plain = await start('paste-plain', 'plain');
    expect(await bracketed.backend.pasteText('first\nsecond')).toBe(true);
    expect(await plain.backend.pasteText('first\nsecond')).toBe(true);
    await expect.poll(bracketed.received, { timeout: 5_000 }).toBe('\x1b[200~first\nsecond\x1b[201~');
    await expect.poll(plain.received, { timeout: 5_000 }).toBe('first\nsecond');
  });

  it('refuses a paste after the pane exited', async () => {
    const { backend } = await start('paste-exited', 'plain');
    await backend.kill();
    expect(await backend.pasteText('late')).toBe(false);
  });
});
