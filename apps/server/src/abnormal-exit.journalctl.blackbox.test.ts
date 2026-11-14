import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { defaultJournalQuery } from './abnormal-exit.js';

// 只用不带时间参数的能力探测决定 skip；真实带界查询的错误仍让测试失败。
const journalctlProbe = process.platform === 'linux'
  ? spawnSync('journalctl', ['--user', `--unit=dutydeck-nonexistent-${randomUUID()}.service`, '--output=json', '--no-pager', '--lines=1'], { stdio: 'ignore', timeout: 2_000, killSignal: 'SIGKILL' })
  : undefined;
const journalctlIt = journalctlProbe && !journalctlProbe.error && journalctlProbe.status === 0 ? it : it.skip;

journalctlIt('journalctl accepts the bounded timestamps without reading any business unit', async () => {
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const now = Date.now();
  const entries = await defaultJournalQuery({
    unit: `dutydeck-nonexistent-${randomUUID()}.service`, boot, pid: process.pid,
    startedAt: new Date(now - 2_000).toISOString(), until: new Date(now + 2_000).toISOString()
  });
  expect(entries).toEqual([]);
}, 15_000);
