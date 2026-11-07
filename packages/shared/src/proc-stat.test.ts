import { expect, it } from 'vitest';
import { parseProcStat, procStatExited } from './proc-stat.js';

// 52 个字段的真实格式；进程名里带空格和右括号。
const line = (comm: string, state = 'S') => `4242 (${comm}) ${state} 100 4242 4242 34816 4242 4194304 1 2 3 4 5 6 7 8 20 0 1 0 987654 1000 200 ${'0 '.repeat(29).trim()}\n`;

it('counts fields from the last parenthesis so a command name with spaces or parentheses does not shift them', () => {
  for (const comm of ['node', 'tmux: server', 'a) b (c)']) {
    expect(parseProcStat(line(comm))).toEqual({ state: 'S', ppid: 100, pgid: 4242, session: 4242, cpuTicks: 5 + 6 + 7 + 8, start: '987654', envStart: '0', envEnd: '0' });
  }
});

it('treats zombie and dead states as exited', () => {
  expect(procStatExited(parseProcStat(line('x', 'Z')))).toBe(true);
  expect(procStatExited(parseProcStat(line('x', 'X')))).toBe(true);
  expect(procStatExited(parseProcStat(line('x', 'R')))).toBe(false);
});

it('returns an empty start for a malformed line instead of throwing', () => {
  expect(parseProcStat('').start).toBe('');
  expect(parseProcStat('1 (x) S').start).toBe('');
});
