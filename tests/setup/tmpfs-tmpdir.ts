import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';

// SQLite closes and git fixtures sync to disk constantly; on tmpfs the node project's tests take about a tenth less time.
export default function setup() {
  if (process.env.TMPDIR) return;
  try { accessSync('/dev/shm', constants.W_OK); } catch { return; }
  const directory = mkdtempSync('/dev/shm/dutydeck-vitest-');
  process.env.TMPDIR = directory;
  return () => {
    delete process.env.TMPDIR;
    rmSync(directory, { recursive: true, force: true });
  };
}
