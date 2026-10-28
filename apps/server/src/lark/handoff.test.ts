import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGitSnapshot } from './git-status.js';
import type { AgentEvent } from '@dutydeck/shared';
import { handoffCommandReceipts, formatLarkHandoff, larkHandoffMarker } from './handoff.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const tempDir = async () => { const path = await mkdtemp(join(tmpdir(), 'dutydeck-handoff-')); directories.push(path); return path; };

describe('/new --handoff prefix', () => {
  it('reads branch, short HEAD and at most 10 status lines, and nothing outside a repository', async () => {
    const repo = await tempDir();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    await writeFile(join(repo, 'tracked.txt'), 'v1');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
    for (let index = 0; index < 12; index++) await writeFile(join(repo, `new-${index}.txt`), 'x');
    const head = git('rev-parse', '--short', 'HEAD').toString().trim();
    expect(await readGitSnapshot(repo)).toEqual({ branch: 'main', head, status: expect.any(Array), statusTotal: 12 });
    expect((await readGitSnapshot(repo))!.status).toHaveLength(10);
    expect(await readGitSnapshot(await tempDir())).toBeUndefined();
  });

  it('writes link, turns with capped excerpts, git snapshot and note under one marker', () => {
    const text = formatLarkHandoff({
      sessionId: 'ses_old', sessionUrl: 'https://dock.example/sessions/ses_old', cwd: '/repo',
      turns: [
        { title: '修复登录超时', status: 'completed', result: `结论：已修复。\n${'长'.repeat(700)}` },
        { title: '补测试', status: 'failed' }
      ],
      git: { branch: 'main', head: 'abc1234', status: [' M src/a.ts'], statusTotal: 3 },
      note: '先补重试测试'
    });
    expect(text.startsWith(larkHandoffMarker)).toBe(true);
    expect(text).toContain('旧会话：https://dock.example/sessions/ses_old');
    expect(text).toContain('1. 修复登录超时（已完成）\n   结论：已修复。');
    expect(text).toContain('2. 补测试（失败）\n   （没有可摘录的结果，unknown）');
    expect(text).not.toContain('长'.repeat(600));
    expect(text).toContain('工作目录 git 快照（/repo）：\n分支 main · HEAD abc1234\n   M src/a.ts\n  …另有 2 项未列出');
    expect(text).toContain('用户备注：先补重试测试');
    expect(formatLarkHandoff({ turns: [], note: '' })).toContain('不是 git 仓库或读取失败');
  });
});

const commandEvent = (sequence: number, type: AgentEvent['type'], data: unknown, attemptId = 'attempt_1'): AgentEvent => ({
  id: `evt_${sequence}`, sessionId: 'ses_old', taskId: 'task_1', attemptId, sequence, timestamp: '2026-10-28T00:00:00Z', type, data
});

it('requires a matching explicit terminal receipt, not assistant claims or another attempt', () => {
  const events = [
    commandEvent(1, 'tool_call', { id: 'test', input: { command: 'pnpm test' } }),
    commandEvent(2, 'text', { role: 'assistant', text: 'Tests passed' }),
    commandEvent(3, 'tool_result', { id: 'test', status: 'completed', output: 'all passed' }, 'other_attempt'),
    commandEvent(4, 'tool_call', { id: 'build', input: { command: 'pnpm build' } }),
    commandEvent(5, 'tool_result', { id: 'build', status: 'failed', exitCode: 1, output: 'compile failed' })
  ];
  const receipts = handoffCommandReceipts(events);
  expect(receipts[0]).toContain('pnpm test：曾尝试；无明确回执，结果未知');
  expect(receipts[0]).toContain('call=evt_1 receipt=unknown attempt=attempt_1');
  expect(receipts[1]).toContain('pnpm build：工具回执 failed');
  expect(receipts[1]).toContain('receipt=evt_5 attempt=attempt_1 exitCode=1');
  expect(receipts.join(' ')).not.toContain('all passed');
  expect(handoffCommandReceipts([...events, commandEvent(6, 'tool_result', { id: 'test', status: 'completed', output: 'real receipt' })])[0])
    .toContain('工具回执 completed；call=evt_1 receipt=evt_6');
});

it('bounds every content section while retaining source IDs, digests and visible truncation', () => {
  const events = Array.from({ length: 30 }, (_, index) => commandEvent(index, 'tool_call', { id: `c${index}`, input: { command: '命'.repeat(5000) } }));
  const turns = Array.from({ length: 40 }, (_, index) => ({ taskId: `task_${index}`, attemptId: `attempt_${index}`, title: '题'.repeat(5000), status: 'failed', result: '结'.repeat(20000), events }));
  const text = formatLarkHandoff({ sessionId: 'source_session', goal: '目'.repeat(20000), turns, index: turns, taskTotal: 80, note: '备'.repeat(20000),
    cwd: '路'.repeat(20000), git: { branch: '分'.repeat(20000), head: 'a'.repeat(20000), status: Array(50).fill('改'.repeat(20000)), statusTotal: 50 }, eventsIncomplete: true });
  expect(text.length).toBeLessThan(25000);
  expect(text).toContain('来源 session=source_session');
  expect(text).toContain('来源 task=task_39 attempt=attempt_39');
  expect(text).toMatch(/excerptDigest=sha256:[a-f0-9]{64}/);
  expect(text).toContain('outputDigest=unknown（未读取账本结果）');
  expect(text).toContain('已截断');
  expect(text).toContain('另有 57 轮未列');
  expect(text).toContain('事件窗口不完整或读取失败');
  expect(text).toContain('history show <taskId>');
  expect(text).not.toContain('备'.repeat(1001));
});

it('keeps native fork provenance, permissions and git without re-injecting results or goal', () => {
  const text = formatLarkHandoff({ sessionId: 'native_parent', turns: [{ title: 'parent task', status: 'completed', result: 'large inherited result' }], goal: 'inherited goal', note: 'inherited note', git: { branch: 'main', head: '1234', status: [' M pending.ts'], statusTotal: 1 }, nativeContextCopied: true });
  expect(text).toContain('来源 session=native_parent');
  expect(text).toContain('不授予操作权限');
  expect(text).not.toContain('large inherited result');
  expect(text).not.toContain('inherited goal');
  expect(text).toContain('git 快照');
  expect(text).toContain('分支 main · HEAD 1234\n   M pending.ts');
});
