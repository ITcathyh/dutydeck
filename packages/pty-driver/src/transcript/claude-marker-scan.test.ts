// When the pinned transcript is missing (Claude still at a startup dialog), the tailer must not
// reread sibling transcripts every poll: unchanged candidates are read once, and scans back off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProjectDir } from '../cli-paths.js';
import { buildSessionMarker } from '../session-id/marker.js';

vi.mock('../session-id/fs-scan.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../session-id/fs-scan.js')>();
  return { ...actual, readHead: vi.fn(actual.readHead), walkFiles: vi.fn(actual.walkFiles) };
});
const { readHead, walkFiles } = await import('../session-id/fs-scan.js');
const { ClaudeTranscriptTailer } = await import('./claude.js');

const sessionId = 'ses_11111111-1111-4111-8111-111111111111';
const userEntry = (content: string) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
let root: string;
let cwd: string;
let env: Record<string, string>;
let projectDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dutydeck-claude-marker-scan-'));
  cwd = join(root, 'cwd');
  mkdirSync(cwd);
  env = { CLAUDE_CONFIG_DIR: join(root, 'config') };
  projectDir = claudeProjectDir(cwd, env);
  mkdirSync(projectDir, { recursive: true });
  // Three older sibling transcripts, each larger than the 256 KiB head window.
  for (let index = 0; index < 3; index++) {
    writeFileSync(join(projectDir, `0000000${index}-0000-4000-8000-000000000000.jsonl`), `${userEntry('x'.repeat(1_000))}\n`.repeat(300));
  }
  vi.useFakeTimers();
  vi.mocked(readHead).mockClear();
  vi.mocked(walkFiles).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

const scans = () => vi.mocked(walkFiles).mock.calls.filter(([dir]) => dir === projectDir).length;
const reads = () => vi.mocked(readHead).mock.calls.length;
const writeMinted = () => {
  const path = join(projectDir, '33333333-3333-4333-8333-333333333333.jsonl');
  writeFileSync(path, `${userEntry(`${buildSessionMarker(sessionId)}\nhello`)}\n`);
  return path;
};

describe('Claude transcript marker scan while the transcript is missing', () => {
  it('reads each unchanged sibling once and backs off to one scan per 30 seconds', async () => {
    const tailer = new ClaudeTranscriptTailer({ cwd, env, sessionId });
    tailer.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const fast = scans();
    // Every 300 ms poll scans during the first 10 seconds.
    expect(fast).toBeGreaterThanOrEqual(30);
    await vi.advanceTimersByTimeAsync(50_000);
    // 10 s, 11 s, 13 s, 17 s, 25 s, 41 s: then the 30 s cap.
    expect(scans() - fast).toBeLessThanOrEqual(7);
    const minute = scans();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(scans() - minute).toBeLessThanOrEqual(11);
    expect(reads()).toBe(3);
    tailer.stop();
  });

  it('still finds a transcript Claude minted under its own id within one backoff interval', async () => {
    const tailer = new ClaudeTranscriptTailer({ cwd, env, sessionId });
    tailer.start();
    await vi.advanceTimersByTimeAsync(120_000);
    const minted = writeMinted();
    await vi.advanceTimersByTimeAsync(30_300);
    expect(tailer.checkpoint().path).toBe(minted);
    expect(reads()).toBe(4);
    tailer.stop();
  });

  it('scans every poll again once a new input is about to be written', async () => {
    const tailer = new ClaudeTranscriptTailer({ cwd, env, sessionId });
    tailer.start();
    await vi.advanceTimersByTimeAsync(120_000);
    const input = new AbortController();
    void tailer.waitForInput('hello', input.signal).catch(() => {});
    const minted = writeMinted();
    await vi.advanceTimersByTimeAsync(600);
    expect(tailer.checkpoint().path).toBe(minted);
    input.abort();
    tailer.stop();
  });
});
