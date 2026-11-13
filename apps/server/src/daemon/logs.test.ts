import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonPaths, readDaemonLog, readJournalctlLog } from './daemon.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dutydeck-logs-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

function writeDaemonLog(text: string): string {
  const dir = join(tmp, 'daemon');
  mkdirSync(dir, { recursive: true });
  writeFileSync(daemonPaths(dir).logFile, text);
  return dir;
}

function journalctlStub(options: { stdout?: string; stderr?: string; status?: number; capture: string }): string {
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = [
    `#!${process.execPath}`,
    `require('node:fs').writeFileSync(${JSON.stringify(options.capture)}, JSON.stringify(process.argv.slice(2)));`,
    `process.stdout.write(${JSON.stringify(options.stdout ?? '')}, () => {`,
    `  process.stderr.write(${JSON.stringify(options.stderr ?? '')}, () => process.exit(${options.status ?? 0}));`,
    '});'
  ].join('\n');
  writeFileSync(join(bin, 'journalctl'), script, { mode: 0o755 });
  vi.stubEnv('PATH', bin);
}

describe('readDaemonLog', () => {
  it('keeps ordinary and error lines in order and returns 50 lines by default', () => {
    const rows = Array.from({ length: 60 }, (_, index) => index === 59 ? 'Error: final failure' : `ordinary row ${index}`);
    const dir = writeDaemonLog(`${rows.join('\n')}\n`);
    expect(readDaemonLog(dir)).toEqual(rows.slice(10));
  });

  it('starts from the new file after rotation when the old offset is beyond its size', () => {
    const dir = writeDaemonLog('old ordinary\nold Error\n');
    const paths = daemonPaths(dir);
    const oldSize = readFileSync(paths.logFile).byteLength;
    renameSync(paths.logFile, `${paths.logFile}.1`);
    writeFileSync(paths.logFile, 'new ordinary\nnew Error\n');
    expect(readDaemonLog(dir, 50, oldSize + 1024)).toEqual(['new ordinary', 'new Error']);
  });

  it('bounds reads to the 256 KiB tail instead of returning older lines from a large file', () => {
    const rows = Array.from({ length: 40 }, (_, index) => `row-${index}-${'x'.repeat(8000)}`);
    const dir = writeDaemonLog(`${rows.join('\n')}\n`);
    const lines = readDaemonLog(dir);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(rows.length);
    expect(lines.at(-1)).toBe(rows.at(-1));
    expect(lines).not.toContain(rows[0]);
  });

  it('drops a truncated tail with no complete line boundary instead of leaking a secret fragment', () => {
    const dir = writeDaemonLog(`token=${'x'.repeat(256 * 1024)}fixture-window-leak`);
    const lines = readDaemonLog(dir);
    expect(lines.some(line => line.includes('fixture-window-leak'))).toBe(false);
    expect(lines).toHaveLength(0);
  });

  it('preserves multiline stack lines, indentation and internal blank lines', () => {
    const rows = ['Error: exploded', '    at first (fixture.js:1:1)', '', '    at second (fixture.js:2:2)', 'ordinary after stack'];
    const dir = writeDaemonLog(`${rows.join('\n')}\n`);
    expect(readDaemonLog(dir)).toEqual(rows);
  });

  it('drops secret-bearing lines without dropping their ordinary and error neighbours', () => {
    const dir = writeDaemonLog([
      'ordinary before',
      '[dutydeck] Generated access token for remote access: fixture-token-value',
      'Authorization: Bearer fixture-bearer-value',
      'password=fixture-password-value',
      'Error: after filtered rows'
    ].join('\n'));
    const lines = readDaemonLog(dir);
    expect(lines).toEqual(['ordinary before', 'Error: after filtered rows']);
    expect(lines.join('\n')).not.toContain('fixture-token-value');
    expect(lines.join('\n')).not.toContain('fixture-bearer-value');
    expect(lines.join('\n')).not.toContain('fixture-password-value');
  });
});

describe('readJournalctlLog', () => {
  it('uses bounded journalctl arguments and preserves ordinary, error and stack lines while filtering secrets', async () => {
    const capture = join(tmp, 'argv.json');
    journalctlStub({
      capture,
      stdout: ['ordinary before', 'token=fixture-journal-secret', 'Error: exploded', '    at fixture (fixture.js:1:1)', 'ordinary after'].join('\n') + '\n'
    });
    expect(await readJournalctlLog('dutydeck-fixture.service', 3)).toEqual([
      'Error: exploded', '    at fixture (fixture.js:1:1)', 'ordinary after'
    ]);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual([
      '--user', '--unit=dutydeck-fixture.service', '--lines=3', '--no-pager'
    ]);
  });

  it('streams more than 1 MiB and keeps only the newest complete lines in the 256 KiB window', async () => {
    const capture = join(tmp, 'argv.json');
    const rows = Array.from({ length: 160 }, (_, index) => `journal-row-${index}-${'x'.repeat(8192)}`);
    journalctlStub({ capture, stdout: `${rows.join('\n')}\n` });
    const lines = await readJournalctlLog('dutydeck-large.service');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(rows.length);
    expect(lines).toEqual(rows.slice(-lines.length));
    expect(lines.at(-1)).toBe(rows.at(-1));
    expect(lines).not.toContain(rows[0]);
  }, 15_000);

  it('bounds large stderr while retaining the actual journal failure', async () => {
    const capture = join(tmp, 'argv.json');
    const rows = Array.from({ length: 160 }, (_, index) => `journal-error-${index}-${'x'.repeat(8192)}`);
    journalctlStub({ capture, status: 1, stderr: `${rows.join('\n')}\n` });
    let failure: unknown;
    try {
      await readJournalctlLog('dutydeck-large-error.service');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('journalctl failed for systemd unit dutydeck-large-error.service');
    expect(message).toContain('journal-error-');
    expect(message).not.toContain(rows[0]);
    expect(message.length).toBeLessThan(256 * 1024 + 500);
  }, 15_000);

  it('drops a streaming tail with no complete line boundary instead of leaking a secret fragment', async () => {
    const capture = join(tmp, 'argv.json');
    journalctlStub({ capture, stdout: `old ordinary\ntoken=${'x'.repeat(256 * 1024)}fixture-journal-window-leak` });
    const lines = await readJournalctlLog('dutydeck-window.service');
    expect(lines.some(line => line.includes('fixture-journal-window-leak'))).toBe(false);
    expect(lines).toHaveLength(0);
  });

  it('reports an empty journal as an unknown unit or a unit without logs', async () => {
    const capture = join(tmp, 'argv.json');
    journalctlStub({ capture, stdout: '-- No entries --\n' });
    await expect(Promise.resolve().then(() => readJournalctlLog('dutydeck-empty.service'))).rejects.toThrow('unit 不存在或尚无日志，请核对 unit');
  });

  it('does not mistake normal output containing the no-entries text for an empty journal', async () => {
    const capture = join(tmp, 'argv.json');
    const normal = 'ordinary message mentioning -- No entries -- without being an empty journal';
    journalctlStub({ capture, stdout: `${normal}\n` });
    expect(await readJournalctlLog('dutydeck-normal.service')).toEqual([normal]);
  });

  it('surfaces a non-zero journalctl error for an unknown unit', async () => {
    const capture = join(tmp, 'argv.json');
    journalctlStub({ capture, status: 1, stderr: 'Unit dutydeck-missing.service not found.\n' });
    await expect(Promise.resolve().then(() => readJournalctlLog('dutydeck-missing.service'))).rejects.toThrow(/dutydeck-missing\.service.*not found/i);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual([
      '--user', '--unit=dutydeck-missing.service', '--lines=50', '--no-pager'
    ]);
  });

  it('reports clearly when journalctl is not installed or not on PATH', async () => {
    vi.stubEnv('PATH', join(tmp, 'empty-path'));
    await expect(Promise.resolve().then(() => readJournalctlLog('dutydeck.service'))).rejects.toThrow(/journalctl.*(not found|无法执行)/i);
  });

  it('keeps the unit attached as one value so it cannot become an option or shell command', async () => {
    const capture = join(tmp, 'argv.json');
    const marker = join(tmp, 'injection-executed');
    journalctlStub({ capture, stdout: 'ordinary\n' });
    const unit = `--output=json; touch ${marker}`;
    expect(await readJournalctlLog(unit, 2)).toEqual(['ordinary']);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual([
      '--user', `--unit=${unit}`, '--lines=2', '--no-pager'
    ]);
    expect(existsSync(marker)).toBe(false);
  });
});
