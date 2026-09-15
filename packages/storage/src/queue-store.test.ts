import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskRecord, ToolRiskPolicy } from '@dutydeck/shared';
import { createRepositories } from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));

async function tempDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dutydeck-queue-store-'));
  temporaryDirectories.push(directory);
  return join(directory, 'dutydeck.db');
}

function makeTask(partial: Partial<TaskRecord> & { id: string; sessionId: string }): TaskRecord {
  const now = new Date().toISOString();
  return {
    prompt: `prompt for ${partial.id}`,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...partial
  };
}

const riskPolicy: ToolRiskPolicy = {
  enabled: true,
  authorized: true,
  pattern: 'rm\\s',
  actorEmail: 'owner@example.com',
  reason: 'approved'
};

function fullContextTask(id: string, sessionId: string, createdAt: string): TaskRecord {
  return {
    id,
    sessionId,
    prompt: 'visible prompt',
    status: 'queued',
    executionContext: {
      actorId: 'ou_actor_1',
      agentPrompt: 'augmented agent prompt with skill',
      skillDeliveries: [{ name: 'review-skill', path: '/skills/review', source: 'workspace', digest: 'abc123', mode: 'prompt' }],
      riskPolicy,
      recovery: { kind: 'pty-jsonl-v1', turnId: 'turn_42', transcript: { path: '/tmp/transcript.jsonl', offset: 128 } }
    },
    createdAt,
    updatedAt: createdAt
  };
}

describe('task queue repository', () => {
  it('back/back/front 入队后关闭重开磁盘库顺序正确，promote 可把任意任务提到最前', async () => {
    const filename = await tempDatabase();
    let repos = createRepositories(filename);
    const t1 = makeTask({ id: 't1', sessionId: 's1', createdAt: '2026-09-01T00:00:01.000Z', updatedAt: '2026-09-01T00:00:01.000Z' });
    const t2 = makeTask({ id: 't2', sessionId: 's1', createdAt: '2026-09-01T00:00:02.000Z', updatedAt: '2026-09-01T00:00:02.000Z' });
    const t3 = makeTask({ id: 't3', sessionId: 's1', createdAt: '2026-09-01T00:00:03.000Z', updatedAt: '2026-09-01T00:00:03.000Z' });

    await repos.tasks.enqueue!(t1, 'back');
    await repos.tasks.enqueue!(t2, 'back');
    await repos.tasks.enqueue!(t3, 'front');

    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['t3', 't1', 't2']);
    repos.close();

    // 关闭重开真实磁盘库：队列顺序必须持久化。
    repos = createRepositories(filename);
    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['t3', 't1', 't2']);

    // promote 中间任务 t1 到最前。
    const promoted = await repos.tasks.promoteQueued!('s1', 't1');
    expect(promoted?.id).toBe('t1');
    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['t1', 't3', 't2']);
    repos.close();

    repos = createRepositories(filename);
    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['t1', 't3', 't2']);
    repos.close();
  });

  it('持久化完整 payload：actor、Skill 投递、riskPolicy、recovery 均不丢', async () => {
    const repos = createRepositories(':memory:');
    const timestamp = '2026-09-01T00:00:00.000Z';
    const task = fullContextTask('full1', 's1', timestamp);
    const { task: stored } = await repos.tasks.enqueue!(task, 'back');

    expect(stored.id).toBe('full1');
    expect(stored.status).toBe('queued');
    expect(stored.queuePosition).toBe(1);
    expect(stored.executionContext).toEqual(task.executionContext);
    expect(stored.prompt).toBe(task.prompt);
    expect(stored.createdAt).toBe(timestamp);

    const reread = await repos.tasks.get!('full1');
    expect(reread?.executionContext).toEqual(task.executionContext);
    expect(reread?.queuePosition).toBe(1);
    repos.close();
  });

  it('同幂等 ID 重复 enqueue 不重复、不移位、不替换内容，返回原记录 created:false', async () => {
    const repos = createRepositories(':memory:');
    const original = makeTask({ id: 'dup1', sessionId: 's1', prompt: 'original prompt' });
    const first = await repos.tasks.enqueue!(original, 'back');
    expect(first.created).toBe(true);

    await repos.tasks.enqueue!(makeTask({ id: 'other', sessionId: 's1', prompt: 'other' }), 'back');
    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['dup1', 'other']);

    // 用不同 payload、不同位置、不同 queuePosition 重投同一 ID。
    const retried = makeTask({
      id: 'dup1',
      sessionId: 's1',
      prompt: 'tampered prompt',
      queuePosition: 999,
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z'
    });
    const second = await repos.tasks.enqueue!(retried, 'front');
    expect(second.created).toBe(false);
    expect(second.task.prompt).toBe('original prompt');
    expect(second.task.queuePosition).toBe(first.task.queuePosition);
    expect(second.task.createdAt).toBe(original.createdAt);

    // 顺序未移动：dup1 仍在 other 之前（原本就是 back 顺序）。
    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['dup1', 'other']);
    const all = await repos.tasks.listBySession('s1');
    expect(all.filter(t => t.id === 'dup1')).toHaveLength(1);
    repos.close();
  });

  it('连续插队 front 时最新入队者在最前，重复 promote 每次置 min-1 且保持在最前', async () => {
    const repos = createRepositories(':memory:');
    await repos.tasks.enqueue!(makeTask({ id: 'a', sessionId: 's1' }), 'back');
    await repos.tasks.enqueue!(makeTask({ id: 'b', sessionId: 's1' }), 'front');
    await repos.tasks.enqueue!(makeTask({ id: 'c', sessionId: 's1' }), 'front');
    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['c', 'b', 'a']);

    const aPromoted = await repos.tasks.promoteQueued!('s1', 'a');
    expect(aPromoted?.queuePosition).toBe(-3);
    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['a', 'c', 'b']);

    const bFirstPromote = await repos.tasks.promoteQueued!('s1', 'b');
    expect(bFirstPromote?.queuePosition).toBe(-4);
    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['b', 'a', 'c']);

    // 再次 promote b：当前 queued 最小位置是 -4，再次操作按契约置 min(0, -4) - 1 = -5，位置每次减一且保持在最前
    const bSecondPromote = await repos.tasks.promoteQueued!('s1', 'b');
    expect(bSecondPromote?.queuePosition).toBe(-5);
    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['b', 'a', 'c']);
    repos.close();
  });

  it('created_at 相同的任务按稳定次序排列，不随查询抖动', async () => {
    const repos = createRepositories(':memory:');
    const same = '2026-09-01T00:00:00.000Z';
    for (const id of ['x1', 'x2', 'x3', 'x4']) {
      await repos.tasks.enqueue!(makeTask({ id, sessionId: 's1', createdAt: same, updatedAt: same }), 'back');
    }
    const firstPass = (await repos.tasks.listQueued!('s1')).map(t => t.id);
    const secondPass = (await repos.tasks.listQueued!('s1')).map(t => t.id);
    expect(firstPass).toEqual(['x1', 'x2', 'x3', 'x4']);
    expect(secondPass).toEqual(['x1', 'x2', 'x3', 'x4']);
    // 位置彼此不同且递增。
    const positions = (await repos.tasks.listQueued!('s1')).map(t => t.queuePosition);
    expect(new Set(positions).size).toBe(4);
    repos.close();
  });

  it('不同 session 的队列位置互不影响', async () => {
    const repos = createRepositories(':memory:');
    await repos.tasks.enqueue!(makeTask({ id: 'a1', sessionId: 'sA' }), 'back');
    await repos.tasks.enqueue!(makeTask({ id: 'b1', sessionId: 'sB' }), 'back');
    await repos.tasks.enqueue!(makeTask({ id: 'a2', sessionId: 'sA' }), 'front');
    await repos.tasks.enqueue!(makeTask({ id: 'b2', sessionId: 'sB' }), 'front');

    expect((await repos.tasks.listQueued!('sA')).map(t => t.id)).toEqual(['a2', 'a1']);
    expect((await repos.tasks.listQueued!('sB')).map(t => t.id)).toEqual(['b2', 'b1']);
    // 两 session 位置空间独立：首个 back 都是 1。
    const a1 = await repos.tasks.get!('a1');
    const b1 = await repos.tasks.get!('b1');
    expect(a1?.queuePosition).toBe(1);
    expect(b1?.queuePosition).toBe(1);

    // promote 只影响指定 session。
    await repos.tasks.promoteQueued!('sA', 'a1');
    expect((await repos.tasks.listQueued!('sA')).map(t => t.id)).toEqual(['a1', 'a2']);
    expect((await repos.tasks.listQueued!('sB')).map(t => t.id)).toEqual(['b2', 'b1']);
    repos.close();
  });

  it('promoteQueued 对不存在、别的 session、running、已取消任务返回 undefined 且无写', async () => {
    const repos = createRepositories(':memory:');
    await repos.tasks.enqueue!(makeTask({ id: 'q1', sessionId: 's1' }), 'back');
    const running = makeTask({ id: 'r1', sessionId: 's1', status: 'running' });
    await repos.tasks.save(running);
    const canceled = makeTask({ id: 'c1', sessionId: 's1', status: 'cancelled' });
    await repos.tasks.save(canceled);

    expect(await repos.tasks.promoteQueued!('s1', 'missing')).toBeUndefined();
    expect(await repos.tasks.promoteQueued!('s2', 'q1')).toBeUndefined();
    expect(await repos.tasks.promoteQueued!('s1', 'r1')).toBeUndefined();
    expect(await repos.tasks.promoteQueued!('s1', 'c1')).toBeUndefined();

    // q1 没有被任何无效 promote 移动。
    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['q1']);
    const q1 = await repos.tasks.get!('q1');
    expect(q1?.queuePosition).toBe(1);
    // 非 queued 行没有被写进位置。
    expect((await repos.tasks.get!('r1'))?.queuePosition).toBeUndefined();
    expect((await repos.tasks.get!('c1'))?.queuePosition).toBeUndefined();
    repos.close();
  });

  it('enqueue 拒绝非 queued 状态，不做静默转换且不落库', async () => {
    const repos = createRepositories(':memory:');
    await expect(repos.tasks.enqueue!(makeTask({ id: 'run1', sessionId: 's1', status: 'running' }), 'back'))
      .rejects.toThrow(/status must be 'queued'/);
    await expect(repos.tasks.enqueue!(makeTask({ id: 'can1', sessionId: 's1', status: 'cancelled' }), 'front'))
      .rejects.toThrow(/status must be 'queued'/);
    expect(await repos.tasks.listBySession('s1')).toEqual([]);
    repos.close();
  });

  it('listQueued 只返回 queued；listBySession 历史仍按 created_at 不按队列顺序', async () => {
    const repos = createRepositories(':memory:');
    await repos.tasks.enqueue!(makeTask({ id: 'q_old', sessionId: 's1', createdAt: '2026-09-01T00:00:01.000Z', updatedAt: '2026-09-01T00:00:01.000Z' }), 'back');
    await repos.tasks.enqueue!(makeTask({ id: 'q_new', sessionId: 's1', createdAt: '2026-09-01T00:00:03.000Z', updatedAt: '2026-09-01T00:00:03.000Z' }), 'front');
    // 插队后 q_new 位置更靠前，但 created_at 更晚。
    const done = makeTask({ id: 'done', sessionId: 's1', status: 'completed', createdAt: '2026-09-01T00:00:02.000Z', updatedAt: '2026-09-01T00:00:02.000Z' });
    await repos.tasks.save(done);

    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['q_new', 'q_old']);
    // 历史视图保持 created_at 升序，不受队列位置影响。
    expect((await repos.tasks.listBySession('s1')).map(t => t.id)).toEqual(['q_old', 'done', 'q_new']);
    repos.close();
  });

  it('save 不带 queuePosition 时不清空已有排序；显式置值才覆盖', async () => {
    const repos = createRepositories(':memory:');
    const { task } = await repos.tasks.enqueue!(makeTask({ id: 'keep1', sessionId: 's1' }), 'back');
    expect(task.queuePosition).toBe(1);

    // Runtime 常见路径：加载 TaskRecord（含 queuePosition）后改状态再 save，这里模拟一个剥离了 queuePosition 的旧对象。
    const withoutPosition: TaskRecord = {
      id: 'keep1',
      sessionId: 's1',
      prompt: task.prompt,
      status: 'running',
      executionContext: task.executionContext,
      createdAt: task.createdAt,
      updatedAt: new Date().toISOString()
    };
    await repos.tasks.save(withoutPosition);
    expect((await repos.tasks.get!('keep1'))?.queuePosition).toBe(1);

    // 显式给值才更新。
    await repos.tasks.save({ ...withoutPosition, status: 'queued', queuePosition: 7 });
    expect((await repos.tasks.get!('keep1'))?.queuePosition).toBe(7);
    repos.close();
  });

  it('save 省略 interruptedByActor 时保留已有审计身份，显式新 actor 正常覆盖', async () => {
    const repos = createRepositories(':memory:');
    const task = makeTask({ id: 'actor_task', sessionId: 's1', status: 'running', interruptedByActor: 'ou_stop' });
    await repos.tasks.save(task);
    expect((await repos.tasks.get!('actor_task'))?.interruptedByActor).toBe('ou_stop');

    // 同 ID save，省略 interruptedByActor
    const withoutActor: TaskRecord = {
      id: 'actor_task',
      sessionId: 's1',
      prompt: 'new prompt',
      status: 'stopped',
      createdAt: task.createdAt,
      updatedAt: new Date().toISOString()
    };
    await repos.tasks.save(withoutActor);
    expect((await repos.tasks.get!('actor_task'))?.interruptedByActor).toBe('ou_stop');

    // 显式传入新 actor 覆盖
    await repos.tasks.save({ ...withoutActor, interruptedByActor: 'ou_new_actor' });
    expect((await repos.tasks.get!('actor_task'))?.interruptedByActor).toBe('ou_new_actor');
    repos.close();
  });

  it('decodeTask 对历史 NULL queue_position 省略该字段，保持 JSON 输出形状', async () => {
    const repos = createRepositories(':memory:');
    const legacy = makeTask({ id: 'legacy1', sessionId: 's1', status: 'running' });
    await repos.tasks.save(legacy);
    const reread = await repos.tasks.get!('legacy1');
    expect(reread).not.toHaveProperty('queuePosition');
    // 序列化出去的 JSON 不含该内部字段。
    expect(JSON.stringify(reread)).not.toContain('queuePosition');
    repos.close();
  });

  it('插入失败时事务回滚，不留半截任务或位置副作用', async () => {
    const repos = createRepositories(':memory:');
    await repos.tasks.enqueue!(makeTask({ id: 'seed1', sessionId: 's1' }), 'back');

    // 触发 INSERT 约束失败：prompt 是 NOT NULL。enqueue 内部应整体回滚，
    // 既不留下坏行，也不改变后续 back/front 位置计算。
    const broken = makeTask({ id: 'broken', sessionId: 's1' });
    (broken as { prompt: string | null }).prompt = null;
    await expect(repos.tasks.enqueue!(broken, 'back')).rejects.toThrow();

    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['seed1']);
    // 失败后位置计算仍从既有状态连续：seed1 在 1，front 为 min(0,1)-1 = 0... 实际按契约 min(0,min)-1，
    // 唯一 queued 在位置 1 时 front 为 -1；随后 back 为 max(0,1)+1 = 2。
    const front = await repos.tasks.enqueue!(makeTask({ id: 'after_front', sessionId: 's1' }), 'front');
    expect(front.task.queuePosition).toBe(-1);
    const back = await repos.tasks.enqueue!(makeTask({ id: 'after_back', sessionId: 's1' }), 'back');
    expect(back.task.queuePosition).toBe(2);
    expect((await repos.tasks.listQueued!('s1')).map(t => t.id)).toEqual(['after_front', 'seed1', 'after_back']);
    repos.close();
  });

  it('多连接操作同一磁盘库时连续 enqueue 写入位置递增不撞车', async () => {
    // 单线程 Node 事件循环中，Promise.all 依次调度各连接的入队操作并由 better-sqlite3 同步执行，
    // 验证多连接句柄交错写入同一磁盘库文件时 queue_position 仍能按库内实际最大值连续递增分配，
    // 最终覆盖区间 1..20 且无重复。注意：此处仅验证多连接连续写入的数据一致性，不是真正并发争锁，不代表跨线程/进程并发已支持。
    const filename = await tempDatabase();
    const writerA = createRepositories(filename);
    const writerB = createRepositories(filename);
    const tasksA: TaskRecord[] = [];
    const tasksB: TaskRecord[] = [];
    for (let index = 0; index < 10; index += 1) {
      tasksA.push(makeTask({ id: `a${index}`, sessionId: 's1' }));
      tasksB.push(makeTask({ id: `b${index}`, sessionId: 's1' }));
    }

    await Promise.all([
      ...tasksA.map(task => writerA.tasks.enqueue!(task, 'back')),
      ...tasksB.map(task => writerB.tasks.enqueue!(task, 'back'))
    ]);

    writerA.close();
    writerB.close();

    const reader = createRepositories(filename);
    const queued = await reader.tasks.listQueued!('s1');
    expect(queued).toHaveLength(20);
    const positions = new Set(queued.map(t => t.queuePosition));
    expect(positions.size).toBe(20);
    expect([...positions].sort((x, y) => x! - y!)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    reader.close();
  });
});
