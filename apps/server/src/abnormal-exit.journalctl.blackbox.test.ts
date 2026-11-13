import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { defaultJournalQuery } from './abnormal-exit.js';

const linuxIt = process.platform === 'linux' ? it : it.skip;

linuxIt('journalctl accepts the bounded timestamps without reading any business unit', async () => {
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const now = Date.now();
  const entries = await defaultJournalQuery({
    unit: `dutydeck-nonexistent-${randomUUID()}.service`, boot, pid: process.pid,
    startedAt: new Date(now - 2_000).toISOString(), until: new Date(now + 2_000).toISOString()
  });
  expect(entries).toEqual([]);
}, 15_000);
