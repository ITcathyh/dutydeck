import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessTreeCpu } from './index.js';

const groups: number[] = [];
afterEach(() => { for (const pid of groups.splice(0)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } } });
/** 独立进程组，清理时连同它拉起的子进程一起结束。 */
const start = (source: string) => {
  const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore', detached: true });
  groups.push(child.pid!);
  return child.pid!;
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.runIf(existsSync('/proc/self/stat'))('ProcessTreeCpu', () => {
  it('counts CPU used by descendants, not just the root process', async () => {
    // 根进程自己空闲，忙的是它拉起的子进程。子进程自带 20 秒上限。
    const root = start(`require('node:child_process').spawn(process.execPath, ['-e', 'const end = Date.now() + 20000; while (Date.now() < end) {}'], { stdio: 'ignore' }); setInterval(() => {}, 1000);`);
    await pause(300);
    const cpu = new ProcessTreeCpu();
    expect(cpu.sample([root])).toBeUndefined();
    await pause(1_200);
    expect(cpu.sample([root])).toBe('active');
  });

  it('reports an idle tree as inactive and keeps that verdict inside the minimum window', async () => {
    const root = start('setInterval(() => {}, 1000)');
    await pause(1_000);
    const cpu = new ProcessTreeCpu();
    expect(cpu.sample([root])).toBeUndefined();
    await pause(1_200);
    expect(cpu.sample([root])).toBe('inactive');
    expect(cpu.sample([root])).toBe('inactive');
  });

  it('is unknown without a readable process', () => {
    const cpu = new ProcessTreeCpu();
    expect(cpu.sample([])).toBe('unknown');
    expect(cpu.sample([2 ** 31 - 1])).toBe('unknown');
  });
});
