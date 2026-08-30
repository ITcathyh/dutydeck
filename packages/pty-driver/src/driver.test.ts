import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, NormalizedDriverEvent } from '@dockmux/shared';
import type { CliAdapter } from '@dockmux/cli-adapters';
import { createCliAdapter } from '@dockmux/cli-adapters';
import { PtyBackend, TmuxBackend, type SessionBackend } from '@dockmux/session-backends';
import { readFile } from 'node:fs/promises';
import { PtyCliDriver } from './driver.js';
import { PTY_AGENT_CONTRIBUTIONS } from './contributions.js';

/**
 * 假 CLI：打印 ready 标记 → 按行读 stdin → 回显 + 打印完成标记。
 * onData 是 raw 字节流，MOCK DONE 可能和 ECHO 行在同一 chunk——
 * 这正是 idle-detector 滚动 tail 要处理的场景。
 */
const MOCK_CLI_SOURCE = `
process.stdout.write('MOCK READY\\n');
let buf = '';
process.stdin.on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    process.stdout.write('ECHO:' + line + '\\nMOCK DONE\\n');
  }
});
`;

function waitFor(description: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`waitFor timed out: ${description}`));
      }
    }, 50);
  });
}

describe('PtyCliDriver（PtyBackend + 假 CLI 集成）', () => {
  let dir: string;
  let fixturePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pty-driver-test-'));
    fixturePath = join(dir, 'mock-cli.mjs');
    await writeFile(fixturePath, MOCK_CLI_SOURCE, 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('start 收 raw_terminal，每轮 send 恰好一次 completed，stop 触发 onExit', async () => {
    const events: NormalizedDriverEvent[] = [];
    let exitCode: number | null | undefined;

    const adapter: CliAdapter = {
      id: 'mock-cli',
      capabilities: {},
      buildArgs: () => [fixturePath],
      writeInput: (backend, prompt) => {
        backend.write(prompt + '\n');
      },
      completionPattern: /MOCK DONE/,
    };

    const agent: AgentConfig = {
      id: 'mock-agent',
      name: 'Mock Agent',
      command: process.execPath,
      args: [],
      protocol: 'pty-cli',
      env: {},
      permissionMode: 'full-trust',
      timeout: 600,
      capabilities: { pause: false, resume: false },
      builtin: false,
    };

    const driver = new PtyCliDriver({
      agent,
      adapter,
      backend: new PtyBackend(),
      onEvent: e => events.push(e),
      onExit: code => {
        exitCode = code;
      },
      sessionId: 'test-session',
    });

    await driver.start();

    // 1. start 后收到含 MOCK READY 的 raw_terminal
    await waitFor(
      'raw_terminal with MOCK READY',
      () =>
        events.some(
          e => e.type === 'raw_terminal' && typeof e.data?.text === 'string' && e.data.text.includes('MOCK READY')
        )
    );

    const completedCount = () => events.filter(e => e.type === 'completed').length;

    // 2. send('hello') → 恰好一次 completed
    await driver.send('hello');
    await waitFor('first completed', () => completedCount() >= 1);
    expect(completedCount()).toBe(1);

    // 3. 再 send('world') → 第二次 completed（turnActive 复位正确）
    await driver.send('world');
    await waitFor('second completed', () => completedCount() >= 2);
    expect(completedCount()).toBe(2);

    // 4. stop 后 onExit 触发
    await driver.stop();
    await waitFor('onExit after stop', () => exitCode !== undefined);
  }, 30_000);
});

describe('PTY_AGENT_CONTRIBUTIONS', () => {
  it('id 与 adapterId 一致且唯一，字段齐备，pause 全 false', () => {
    // 不锁总条数：每移植一个适配器就要改一次数字的断言只会制造无谓冲突，
    // 且「数量对」并不能证明任何东西。锁的是每条都必须成立的不变量。
    expect(PTY_AGENT_CONTRIBUTIONS.length).toBeGreaterThan(0);
    const ids = PTY_AGENT_CONTRIBUTIONS.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of PTY_AGENT_CONTRIBUTIONS) {
      expect(c.adapterId).toBe(c.id);
      expect(c.command).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.capabilities.pause).toBe(false);
    }
  });

  it('每条贡献的 adapterId 都能创建出适配器（防止登记了不存在的适配器）', () => {
    for (const c of PTY_AGENT_CONTRIBUTIONS) {
      expect(() => createCliAdapter(c.adapterId), `adapterId=${c.adapterId}`).not.toThrow();
    }
  });

  it('声明 resume 能力的贡献，其适配器必须真的实现 buildResumeCommand', () => {
    // driver.resume() 只在 buildResumeCommand 存在时才动作：声明 resume:true
    // 却不实现它 = 用户点恢复毫无反应的静默 no-op。
    for (const c of PTY_AGENT_CONTRIBUTIONS) {
      const adapter = createCliAdapter(c.adapterId);
      expect(
        typeof adapter.buildResumeCommand === 'function',
        `${c.id} 声明 resume=${c.capabilities.resume}，适配器 buildResumeCommand=${typeof adapter.buildResumeCommand}`,
      ).toBe(c.capabilities.resume);
    }
  });

  it('命令名与 botmux RAW_CLI_EXECUTABLES 一致', () => {
    const byId = Object.fromEntries(PTY_AGENT_CONTRIBUTIONS.map(c => [c.id, c.command]));
    expect(byId).toMatchObject({
      'claude-code': 'claude',
      codex: 'codex',
      gemini: 'gemini',
      opencode: 'opencode',
      grok: 'grok',
      cursor: 'cursor-agent',
      kimi: 'kimi',
      traex: 'traex',
    });
  });
});


// ─── 后端私有字段反射（缺口 2）───────────────────────────────────────────

describe('driver 不反射读后端私有字段', () => {
  it('driver.ts 源码里没有 `backend as unknown as` 这类穿透断言', async () => {
    // driver 曾经这样反射读 TmuxBackend 的私有 sessionName：
    //   (this.backend as unknown as { sessionName?: unknown }).sessionName
    // 后端一改字段名它就静默返回 undefined —— driver 于是再也找不到活着的
    // tmux 会话，每次 resume 都 respawn，用户的上下文无声无息地丢掉。
    // 现在 SessionBackend 有公开的 readonly sessionName，这条路必须彻底堵死。
    const src = await readFile(new URL('./driver.ts', import.meta.url), 'utf8');
    const reflection = /\bbackend\s+as\s+unknown\s+as\b/;
    expect(reflection.test(src), 'driver.ts 不应再有对后端的 as-unknown-as 穿透断言').toBe(false);
    // 也不该有别的形式的私有字段窥探（例如 (backend as any).sessionName）。
    expect(/\(\s*this\.backend\s+as\s+any\s*\)/.test(src)).toBe(false);
  });

  it('走的是公开契约：backend.sessionName 直接可读', () => {
    // 正向断言，防「把反射删了但也不读了」——那样 tmux reattach 会全线失效。
    const backend: SessionBackend = new TmuxBackend('dockmux-driver-contract');
    expect(backend.sessionName).toBe('dockmux-driver-contract');
  });
});
