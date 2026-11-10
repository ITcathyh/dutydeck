import { test as base } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Drivers execute in the Playwright worker, so isolate that worker before any
// driver is imported or started. Tests in one worker run sequentially.
export const test = base.extend<{ isolatedTerminal: void }>({
  isolatedTerminal: [async ({}, use) => {
    const root = mkdtempSync(join(tmpdir(), 'dd-terminal-home-'));
    const keys = ['HOME', 'TMUX_TMPDIR', 'TMUX', 'TMUX_PANE', 'TERM'] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.HOME = root;
    process.env.TMUX_TMPDIR = root;
    process.env.TERM = 'xterm-256color';
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    try {
      await use();
    } finally {
      try {
        execFileSync('tmux', ['-S', join(root, `tmux-${process.getuid!()}`, 'default'), 'kill-server'], { stdio: 'ignore' });
      } catch { /* The final driver may already have stopped this private server. */ }
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, { auto: true }],
});
