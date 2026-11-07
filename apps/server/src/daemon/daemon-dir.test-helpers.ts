import { sep } from 'node:path';
import { expect } from 'vitest';
import { resolveDaemonDir } from './daemon.js';

/** A no-arg daemonStop()/daemonRestart() resolves its target from process.env and signals whatever it finds there. */
export function expectOwnDaemonDir(root: string): void {
  const dir = resolveDaemonDir();
  expect(dir.startsWith(`${root}${sep}`), `daemon dir ${dir} is outside this test's temp dir; refusing to stop it`).toBe(true);
}
