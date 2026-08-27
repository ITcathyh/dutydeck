import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, NormalizedDriverEvent } from '@dockmux/shared';
import type { CliAdapter } from '@dockmux/cli-adapters';
import { PtyBackend } from '@dockmux/session-backends';
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
  it('8 条贡献，id 与 adapterId 一致且唯一，pause 全 false', () => {
    expect(PTY_AGENT_CONTRIBUTIONS).toHaveLength(8);
    const ids = PTY_AGENT_CONTRIBUTIONS.map(c => c.id);
    expect(new Set(ids).size).toBe(8);
    for (const c of PTY_AGENT_CONTRIBUTIONS) {
      expect(c.adapterId).toBe(c.id);
      expect(c.command).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.capabilities.pause).toBe(false);
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
