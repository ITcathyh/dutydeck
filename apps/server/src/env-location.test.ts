import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateEnvFile } from './env-location.js';
import { writeLastDaemonDir } from './daemon/daemon.js';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'dutydeck-envloc-'));
  const home = join(base, 'home');
  const root = join(base, 'root');
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(join(root, '.dutydeck', 'daemon'), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeLastDaemonDir(join(root, '.dutydeck', 'daemon'), home);
  return { home, root, elsewhere };
}

describe('locateEnvFile', () => {
  beforeEach(() => { vi.stubEnv('DUTYDECK_DAEMON_DIR', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('prefers the .env in the current directory even when a daemon root is recorded', () => {
    const { home, root, elsewhere } = fixture();
    writeFileSync(join(root, '.env'), 'DUTYDECK_PORT=1111\n');
    writeFileSync(join(elsewhere, '.env'), 'DUTYDECK_PORT=2222\n');
    expect(locateEnvFile({ cwd: elsewhere, home })).toEqual({ source: 'cwd', file: join(elsewhere, '.env'), cwd: elsewhere, daemonRoot: root });
  });

  it('falls back to the recorded daemon root when the current directory has no .env', () => {
    const { home, root, elsewhere } = fixture();
    writeFileSync(join(root, '.env'), 'DUTYDECK_PORT=1111\n');
    expect(locateEnvFile({ cwd: elsewhere, home })).toEqual({ source: 'daemon-root', file: join(root, '.env'), cwd: elsewhere, daemonRoot: root });
  });

  it('reports none when neither directory has a .env', () => {
    const { home, root, elsewhere } = fixture();
    expect(locateEnvFile({ cwd: elsewhere, home })).toEqual({ source: 'none', cwd: elsewhere, daemonRoot: root });
  });

  it('treats the current directory as the root when no daemon directory has been recorded', () => {
    const base = mkdtempSync(join(tmpdir(), 'dutydeck-envloc-'));
    const home = join(base, 'home');
    mkdirSync(home);
    const cwd = join(base, 'project');
    mkdirSync(cwd);
    expect(locateEnvFile({ cwd, home })).toEqual({ source: 'none', cwd, daemonRoot: cwd });
  });
});
