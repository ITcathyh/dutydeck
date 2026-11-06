import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHUTDOWN_DEADLINE_MS, ShutdownPhases, armShutdownDeadline } from './shutdown-phases.js';

afterEach(() => { vi.useRealTimers(); });

describe('停服阶段与强制退出', () => {
  it('停服卡在某一步时，强制退出的日志点名卡住的阶段和还没开始的阶段，并带上已完成阶段的耗时', async () => {
    vi.useFakeTimers();
    let clock = 0;
    const phases = new ShutdownPhases(['insight', 'runtime', 'database'], () => clock);
    const lines: string[] = [];
    const exit = vi.fn();
    armShutdownDeadline(() => phases, line => lines.push(line), exit);

    clock = 40;
    await phases.run('insight', () => { clock = 120; });
    // runtime.shutdown 一直不返回。
    void phases.run('runtime', () => new Promise(() => {}));
    clock = 120 + SHUTDOWN_DEADLINE_MS;
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);

    expect(exit).toHaveBeenCalledWith(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`Shutdown exceeded ${SHUTDOWN_DEADLINE_MS / 1000} seconds`);
    expect(lines[0]).toContain(`runtime（已运行 ${SHUTDOWN_DEADLINE_MS}ms）`);
    expect(lines[0]).toContain('database（未开始）');
    expect(lines[0]).toContain('insight=80ms');
    expect(lines[0]).not.toContain('insight（');
  });

  it('按时停完时取消强制退出，耗时按阶段记录', async () => {
    vi.useFakeTimers();
    const phases = new ShutdownPhases(['http']);
    const exit = vi.fn();
    const cancel = armShutdownDeadline(() => phases, () => {}, exit);
    await phases.run('http', async () => {});
    cancel();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS * 2);
    expect(exit).not.toHaveBeenCalled();
    expect(Object.keys(phases.durationsMs())).toEqual(['http']);
    expect(phases.unfinished()).toEqual([]);
  });

  it('阶段抛错时照样记录耗时，异常交给调用方', async () => {
    const phases = new ShutdownPhases(['repos']);
    await expect(phases.run('repos', () => { throw new Error('busy'); })).rejects.toThrow('busy');
    expect(phases.durationsMs()).toHaveProperty('repos');
  });
});
