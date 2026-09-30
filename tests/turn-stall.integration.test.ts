// 一轮可能卡住的判定：真实 DutydeckRuntime + 真实 PtyCliDriver/PtyBackend + 假 CLI。
// 假 CLI 收到输入后既不打印完成标记也不再输出，像卡在适配器不认识的界面上；工作目录里出现 resume 文件时打印一行。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '@dutydeck/shared';
import type { CliAdapter } from '@dutydeck/cli-adapters';
import { createRepositories } from '@dutydeck/storage';
import { DutydeckRuntime } from '@dutydeck/runtime';
import { PtyCliDriver } from '@dutydeck/pty-driver';
import { PtyBackend } from '@dutydeck/session-backends';

const STUCK_CLI = `
import { existsSync } from 'node:fs';
process.stdout.write('MOCK READY\\n');
process.stdin.on('data', () => {});
let resumed = false;
setInterval(() => { if (!resumed && existsSync('resume')) { resumed = true; process.stdout.write('RESUMED\\n'); } }, 200);
`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), 'dutydeck-turn-stall-'));
  const fixture = join(cwd, 'stuck-cli.mjs');
  await writeFile(fixture, STUCK_CLI);
  const repos = createRepositories(':memory:', { newDatabaseAuthority: 'ledger_v1' });
  const adapter: CliAdapter = { id: 'mock-cli', capabilities: {}, buildArgs: () => [fixture], writeInput: (backend, prompt) => { backend.write(`${prompt}\n`); }, completionPattern: /MOCK DONE/ };
  const drivers: PtyCliDriver[] = [];
  const runtime = new DutydeckRuntime(repos, {
    probe: () => ({ protocol: 'pty-cli', available: true, pause: false, resume: true }),
    ptyDriverFactory: (agent, _protocol, onEvent, onExit, sessionId) => {
      const driver = new PtyCliDriver({ agent, adapter, backend: new PtyBackend(), onEvent, onExit, sessionId });
      drivers.push(driver);
      return driver;
    }
  });
  const agent: AgentConfig = { id: 'stuck-cli', name: 'Stuck CLI', command: process.execPath, args: [], protocol: 'pty-cli', cwd, env: {}, permissionMode: 'full-trust', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false };
  await repos.agents.save(agent);
  await runtime.initialize([agent]);
  cleanups.push(async () => { await runtime.shutdown().catch(() => {}); repos.close(); await rm(cwd, { recursive: true, force: true }); });
  const session = await runtime.start({ agentId: agent.id, cwd });
  // 墙钟整体前移，其余照常流逝：静默时长与 CPU 采样窗口都按它算。
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  const status = async (taskId: string) => (await runtime.getTasks(session.id)).find(task => task.id === taskId)?.status;
  /** 等 CLI 把提示词回显完、屏幕不再变化：之后的静默才是这一轮自己的静默。 */
  const settle = async (taskId: string) => {
    await vi.waitFor(async () => expect(await status(taskId)).toBe('running'));
    await vi.waitFor(async () => expect((await runtime.getEvents(session.id)).some(event => event.type === 'raw_terminal' && String((event.data as any).text).includes('stuck work'))).toBe(true), { timeout: 10_000 });
    await new Promise(resolve => setTimeout(resolve, 1_000));
  };
  return { cwd, runtime, session, drivers, status, settle, advance: (ms: number) => { offset += ms; } };
}

describe('a turn that may be stuck', () => {
  it('is reported once its output stays silent with a queued task behind it, without interrupting it, and is cleared when output resumes', async () => {
    const h = await harness();
    const first = await h.runtime.dispatch(h.session.id, 'stuck work');
    const second = await h.runtime.dispatch(h.session.id, 'next work');
    await h.settle(first.id);
    const interrupt = vi.spyOn(h.drivers[0]!, 'interrupt');
    expect(await h.runtime.getTurnStall(h.session.id)).toBeUndefined();
    h.advance(4 * 60_000);
    // 第一次只取 CPU 对照样本。
    expect(await h.runtime.getTurnStall(h.session.id)).toBeUndefined();
    h.advance(15_000);
    expect(await h.runtime.getTurnStall(h.session.id)).toMatchObject({ taskId: first.id, queued: 1, cpu: 'inactive' });
    expect(interrupt).not.toHaveBeenCalled();
    expect(await h.status(first.id)).toBe('running');
    expect(await h.status(second.id)).toBe('queued');
    await writeFile(join(h.cwd, 'resume'), '');
    await vi.waitFor(async () => expect(await h.runtime.getTurnStall(h.session.id)).toBeUndefined(), { timeout: 5_000 });
    expect(interrupt).not.toHaveBeenCalled();
  }, 30_000);

  it('is not reported when nothing is queued behind the silent turn', async () => {
    const h = await harness();
    const first = await h.runtime.dispatch(h.session.id, 'stuck work');
    await h.settle(first.id);
    for (const step of [4 * 60_000, 15_000, 10 * 60_000]) {
      h.advance(step);
      expect(await h.runtime.getTurnStall(h.session.id)).toBeUndefined();
    }
  }, 30_000);
});
