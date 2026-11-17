import { expect, it, vi } from 'vitest';
import { createRepositories } from '@dutydeck/storage';
import { writeTaskReport, type RepositoryBundle, type TaskRecord, type TaskReport } from '@dutydeck/shared';
import { DutydeckRuntime } from './index.js';

const at = '2026-11-01T00:00:00.000Z';
const task = (id: string, sessionId: string, createdAt = at): TaskRecord => ({ id, sessionId, prompt: `prompt ${id}`, status: 'completed', createdAt, updatedAt: createdAt });
const report = (value: TaskRecord): TaskReport => ({ schemaVersion: 1, taskId: value.id, sessionId: value.sessionId, status: 'waiting', question: `Continue ${value.id}?`, reportedAt: at });
function runtimeFor(repos: RepositoryBundle, warn = vi.fn()) {
  return Object.assign(Object.create(DutydeckRuntime.prototype), { repos, options: { log: { warn } } }) as DutydeckRuntime;
}

it('reads reports from latest references with wanted deduplication and stable Map order', async () => {
  const repos = createRepositories(':memory:'), warn = vi.fn();
  try {
    const old = task('old', 's1'), one = task('one', 's1'), two = task('two', 's2'), other = task('other', 'other');
    for (const value of [old, one, two, other]) await repos.tasks.save(value);
    for (const value of [one, two, other]) await writeTaskReport(repos.config, report(value));
    const latest = vi.spyOn(repos.tasks, 'listLatestPerSession'), recent = vi.spyOn(repos.tasks, 'listRecentBySession');
    const runtime = runtimeFor(repos, warn);
    await expect(runtime.getSessionTaskReports(['s2', 's1', 's2', 'empty'])).resolves.toEqual(new Map([
      ['s2', report(two)], ['s1', report(one)]
    ]));
    expect(latest).toHaveBeenCalledOnce();
    expect(recent).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    await expect(runtime.getSessionTaskReports([])).resolves.toEqual(new Map());
    expect(latest).toHaveBeenCalledOnce();
  } finally { repos.close(); }
});

it.each(['missing', 'rejected'] as const)('falls back per wanted session in order when the batch lookup is %s', async mode => {
  const repos = createRepositories(':memory:'), warn = vi.fn();
  try {
    const one = task('one', 's1'), two = task('two', 's2');
    await repos.tasks.save(one); await repos.tasks.save(two);
    await writeTaskReport(repos.config, report(one)); await writeTaskReport(repos.config, report(two));
    if (mode === 'missing') repos.tasks.listLatestPerSession = undefined;
    else vi.spyOn(repos.tasks, 'listLatestPerSession').mockRejectedValue(new Error('batch unavailable'));
    const recent = vi.spyOn(repos.tasks, 'listRecentBySession');
    const runtime = runtimeFor(repos, warn);
    await expect(runtime.getSessionTaskReports(['s1', 'empty', 's2', 's1'])).resolves.toEqual(new Map([
      ['s1', report(one)], ['s2', report(two)]
    ]));
    expect(recent.mock.calls).toEqual([['s1'], ['empty'], ['s2']]);
    expect(warn).not.toHaveBeenCalled();
  } finally { repos.close(); }
});

it('keeps per-session warning behavior and other reports when a fallback read fails', async () => {
  const repos = createRepositories(':memory:'), warn = vi.fn(), error = new Error('recent unavailable');
  try {
    const one = task('one', 's1'), two = task('two', 's2');
    await repos.tasks.save(one); await repos.tasks.save(two);
    await writeTaskReport(repos.config, report(one)); await writeTaskReport(repos.config, report(two));
    vi.spyOn(repos.tasks, 'listLatestPerSession').mockRejectedValue(new Error('batch unavailable'));
    const readRecent = repos.tasks.listRecentBySession!;
    vi.spyOn(repos.tasks, 'listRecentBySession').mockImplementation(async sessionId => {
      if (sessionId === 's1') throw error;
      return readRecent(sessionId);
    });
    const runtime = runtimeFor(repos, warn);
    await expect(runtime.getSessionTaskReports(['s1', 's2'])).resolves.toEqual(new Map([['s2', report(two)]]));
    expect(warn).toHaveBeenCalledExactlyOnceWith({ error, sessionId: 's1' }, '读取会话收尾报告失败，继续处理');
  } finally { repos.close(); }
});
