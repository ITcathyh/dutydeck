import { describe, it, expect } from 'vitest';
import { ALL_CLI_IDS, createCliAdapter, getCliAdapter } from './factory.js';
import { createClaudeCodeAdapter } from './adapters/claude-code.js';
import { createCodexAdapter } from './adapters/codex.js';
import { createGeminiAdapter } from './adapters/gemini.js';
import { createOpenCodeAdapter } from './adapters/opencode.js';
import { createGrokAdapter } from './adapters/grok.js';
import { createCursorAdapter } from './adapters/cursor.js';
import { createKimiAdapter } from './adapters/kimi.js';
import { createTraexAdapter } from './adapters/traex.js';
import { encodeRunnerInput, chunkAscii, writeRunnerInput, RUNNER_INPUT_CHUNK_BYTES } from './runner-input.js';
import type { PtyLike } from './types.js';

const SID = '11111111-2222-3333-4444-555555555555';

/** 全部 29 个适配器 id。手写一份「期望清单」与 ALL_CLI_IDS 对拍——
 *  ALL_CLI_IDS 现在从 factories 的键派生，只能防「注册了但没进清单」，
 *  防不住「整个适配器忘了注册」。这份清单就是那道人工闸门。 */
const EXPECTED_IDS = [
  // 8 个 MVP
  'claude-code', 'codex', 'gemini', 'opencode', 'grok', 'cursor', 'kimi', 'traex',
  // 21 个 M2 移植
  'antigravity', 'coco', 'opencode2', 'mtr', 'hermes', 'mira', 'mir', 'pi', 'oh-my-pi',
  'copilot', 'kiro-cli', 'riff', 'reasonix', 'dsh', 'dsh-tui', 'mojo', 'seed', 'relay',
  'aiden', 'genius', 'codex-app',
] as const;


describe('claude-code', () => {
  const adapter = createClaudeCodeAdapter();

  it('默认参数：bypass + session-id + disallowed-tools', () => {
    const args = adapter.buildArgs({ sessionId: SID });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--session-id');
    expect(args).toContain(SID);
    expect(args).toContain('--disallowed-tools');
    // bypass 配置走进程级 --settings JSON
    const settingsIdx = args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThanOrEqual(0);
    const settings = JSON.parse(args[settingsIdx + 1]!) as { permissions: { defaultMode: string } };
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
  });

  it('resume=true：--resume 优先用 resumeSessionId，否则回退 sessionId', () => {
    const args = adapter.buildArgs({ sessionId: SID, resume: true });
    expect(args.slice(0, 2)).toEqual(['--resume', SID]);
    const args2 = adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'cli-sid' });
    expect(args2.slice(0, 2)).toEqual(['--resume', 'cli-sid']);
  });

  it('model 传入：--model', () => {
    const args = adapter.buildArgs({ sessionId: SID, model: 'opus' });
    expect(args).toContain('--model');
    expect(args).toContain('opus');
  });

  it('pattern 与上下文注入', () => {
    expect(adapter.completionPattern).toBeInstanceOf(RegExp);
    expect(adapter.readyPattern).toBeInstanceOf(RegExp);
    expect(adapter.capabilities.resume).toBe(true);
    const block = adapter.injectSessionContext?.({ sessionId: SID });
    expect(block).toContain('<dockmux_routing>');
    expect(adapter.buildResumeCommand?.(SID)).toEqual(['--resume', SID]);
  });
});

describe('codex', () => {
  const adapter = createCodexAdapter();

  it('默认参数：bypass 双 flag + --no-alt-screen + 关闭更新检查', () => {
    const args = adapter.buildArgs({ sessionId: SID });
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).toContain('--dangerously-bypass-hook-trust');
    expect(args).toContain('--no-alt-screen');
    expect(args).toContain('check_for_update_on_startup=false');
  });

  it('resume=true：resume 子命令 + id 收尾', () => {
    const args = adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'codex-sid' });
    expect(args[0]).toBe('resume');
    expect(args[args.length - 1]).toBe('codex-sid');
    // 无 resumeSessionId 时新起会话，不猜 id
    const fresh = adapter.buildArgs({ sessionId: SID, resume: true });
    expect(fresh[0]).not.toBe('resume');
  });

  it('model / reasoningEffort / cwd 传入', () => {
    const args = adapter.buildArgs({ sessionId: SID, model: 'gpt-5.5', reasoningEffort: 'high', cwd: '/tmp/ws' });
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.5');
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain('-C');
    expect(args).toContain('/tmp/ws');
  });

  it('pattern 族齐全', () => {
    expect(adapter.busyPattern).toBeInstanceOf(RegExp);
    expect(adapter.idleToBusyPattern).toBeInstanceOf(RegExp);
    expect(adapter.readyPattern).toBeInstanceOf(RegExp);
    expect(adapter.capabilities.resume).toBe(true);
    expect(adapter.buildResumeCommand?.('codex-sid')).toEqual(['resume', 'codex-sid']);
  });
});

describe('gemini', () => {
  const adapter = createGeminiAdapter();

  it('默认参数：--yolo', () => {
    expect(adapter.buildArgs({ sessionId: SID })).toEqual(['--yolo']);
  });

  it('resume 不支持（永远新起会话），无 resume 能力位', () => {
    const args = adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'x' });
    expect(args).not.toContain('--resume');
    expect(adapter.capabilities.resume).toBeUndefined();
  });

  it('initialPrompt 走 -i，model 走 --model', () => {
    const args = adapter.buildArgs({ sessionId: SID, initialPrompt: 'hello', model: 'gemini-2.5-pro' });
    expect(args).toContain('-i');
    expect(args).toContain('hello');
    expect(args).toContain('--model');
    expect(args).toContain('gemini-2.5-pro');
    expect(adapter.capabilities.initialPromptViaArgs).toBe(true);
  });
});

describe('opencode', () => {
  const adapter = createOpenCodeAdapter();

  it('默认参数：空（无 bypass flag 概念）', () => {
    expect(adapter.buildArgs({ sessionId: SID })).toEqual([]);
  });

  it('resume=true：--session 精确 id；无 id 新起', () => {
    const args = adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'ses_abc' });
    expect(args).toContain('--session');
    expect(args).toContain('ses_abc');
    expect(adapter.buildArgs({ sessionId: SID, resume: true })).toEqual([]);
  });

  it('initialPrompt 走 --prompt，model 走 --model', () => {
    const args = adapter.buildArgs({ sessionId: SID, initialPrompt: 'hi', model: 'anthropic/claude-sonnet-4' });
    expect(args).toContain('--prompt');
    expect(args).toContain('hi');
    expect(args).toContain('--model');
    expect(args).toContain('anthropic/claude-sonnet-4');
  });

  it('能力位与 resume 命令', () => {
    expect(adapter.capabilities.resume).toBe(true);
    expect(adapter.capabilities.initialPromptViaArgs).toBe(true);
    expect(adapter.buildResumeCommand?.('ses_abc')).toEqual(['-s', 'ses_abc']);
  });
});

describe('grok', () => {
  const adapter = createGrokAdapter();

  it('默认参数：--always-approve + --no-plan + --session-id 钉到 dockmux UUID', () => {
    const args = adapter.buildArgs({ sessionId: SID });
    expect(args).toContain('--always-approve');
    expect(args).toContain('--no-plan');
    expect(args).toContain('--session-id');
    expect(args).toContain(SID);
  });

  it('resume=true：--resume 优先 resumeSessionId', () => {
    const args = adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'grok-sid' });
    expect(args).toContain('--resume');
    expect(args).toContain('grok-sid');
    expect(adapter.buildArgs({ sessionId: SID, resume: true })).toContain('--resume');
  });

  it('model / reasoningEffort 传入', () => {
    const args = adapter.buildArgs({ sessionId: SID, model: 'grok-4.6', reasoningEffort: 'high' });
    expect(args).toContain('--model');
    expect(args).toContain('grok-4.6');
    expect(args).toContain('--reasoning-effort');
    expect(args).toContain('high');
  });

  it('pattern 与上下文注入', () => {
    expect(adapter.readyPattern).toBeInstanceOf(RegExp);
    expect(adapter.busyPattern).toBeInstanceOf(RegExp);
    expect(adapter.capabilities.resume).toBe(true);
    expect(adapter.injectSessionContext?.({ sessionId: SID })).toContain('<dockmux_routing>');
    expect(adapter.buildResumeCommand?.(SID)).toEqual(['--resume', SID]);
  });
});

describe('cursor', () => {
  const adapter = createCursorAdapter();

  it('默认参数：--trust + --force', () => {
    const args = adapter.buildArgs({ sessionId: SID });
    expect(args.slice(0, 2)).toEqual(['--trust', '--force']);
  });

  it('resume=true：--resume 精确 id；绝不 --continue', () => {
    const args = adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'chat-id' });
    expect(args).toContain('--resume');
    expect(args).toContain('chat-id');
    const noId = adapter.buildArgs({ sessionId: SID, resume: true });
    expect(noId).not.toContain('--continue');
    expect(noId).not.toContain('--resume');
  });

  it('model 传入 + 首轮 prompt 走位置参数', () => {
    const args = adapter.buildArgs({ sessionId: SID, model: 'auto', initialPrompt: 'do thing' });
    expect(args).toContain('--model');
    expect(args).toContain('auto');
    expect(args[args.length - 1]).toBe('do thing');
    expect(adapter.capabilities.initialPromptViaArgs).toBe(true);
  });

  it('readyPattern 与 resume 命令', () => {
    expect(adapter.readyPattern).toBeInstanceOf(RegExp);
    expect(adapter.capabilities.resume).toBe(true);
    expect(adapter.buildResumeCommand?.('chat-id')).toEqual(['--resume', 'chat-id']);
  });
});

describe('kimi', () => {
  const adapter = createKimiAdapter();

  it('默认参数：--yolo', () => {
    expect(adapter.buildArgs({ sessionId: SID })).toEqual(['--yolo']);
  });

  it('resume=true：--resume 精确 id；绝不 --continue', () => {
    const args = adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'kimi-sid' });
    expect(args).toContain('--resume');
    expect(args).toContain('kimi-sid');
    const noId = adapter.buildArgs({ sessionId: SID, resume: true });
    expect(noId).not.toContain('--continue');
    expect(noId).not.toContain('--resume');
  });

  it('model 传入', () => {
    const args = adapter.buildArgs({ sessionId: SID, model: 'kimi-k2.5' });
    expect(args).toContain('--model');
    expect(args).toContain('kimi-k2.5');
    expect(adapter.capabilities.resume).toBe(true);
    expect(adapter.buildResumeCommand?.('kimi-sid')).toEqual(['--resume', 'kimi-sid']);
  });
});

describe('traex', () => {
  const adapter = createTraexAdapter();

  it('默认参数：bypass 双 flag + --no-alt-screen', () => {
    const args = adapter.buildArgs({ sessionId: SID });
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).toContain('--dangerously-bypass-hook-trust');
    expect(args).toContain('--no-alt-screen');
  });

  it('resume=true：resume 子命令 + id 收尾；无 id 新起', () => {
    const args = adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'trae-sid' });
    expect(args[0]).toBe('resume');
    expect(args[args.length - 1]).toBe('trae-sid');
    expect(adapter.buildArgs({ sessionId: SID, resume: true })[0]).not.toBe('resume');
  });

  it('model / reasoningEffort 传入', () => {
    const args = adapter.buildArgs({ sessionId: SID, model: 'gpt-5.5', reasoningEffort: 'high' });
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.5');
    expect(args).toContain('model_reasoning_effort="high"');
  });

  it('pattern 族齐全（含 staticBusy 双 pattern）', () => {
    expect(adapter.busyPattern).toBeInstanceOf(RegExp);
    expect(adapter.idleToBusyPattern).toBeInstanceOf(RegExp);
    expect(adapter.staticBusyPattern).toBeInstanceOf(RegExp);
    expect(adapter.staticBusyClearPattern).toBeInstanceOf(RegExp);
    expect(adapter.readyPattern).toBeInstanceOf(RegExp);
    expect(adapter.capabilities.resume).toBe(true);
    expect(adapter.buildResumeCommand?.('trae-sid')).toEqual(['resume', 'trae-sid']);
  });
});

describe('factory', () => {
  it('ALL_CLI_IDS 是全部 29 个 id（8 个 MVP + 21 个 M2 移植）', () => {
    expect([...ALL_CLI_IDS].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('createCliAdapter 按 id 创建，id 自洽', () => {
    for (const id of ALL_CLI_IDS) {
      expect(createCliAdapter(id).id).toBe(id);
    }
  });

  it('未知 id：create 抛错，get 返回 undefined', () => {
    expect(() => createCliAdapter('nope')).toThrow(/Unknown CLI adapter/);
    expect(getCliAdapter('nope')).toBeUndefined();
    expect(getCliAdapter('codex')?.id).toBe('codex');
  });
});

describe('runner-input', () => {
  it('encodeRunnerInput 是 {type,content} 的 base64', () => {
    const encoded = encodeRunnerInput('hello 世界');
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { type: string; content: string };
    expect(decoded).toEqual({ type: 'message', content: 'hello 世界' });
  });

  it('chunkAscii 按字节预算切分', () => {
    const chunks = chunkAscii('a'.repeat(2500), RUNNER_INPUT_CHUNK_BYTES);
    expect(chunks).toHaveLength(3);
    expect(chunks.map(c => c.length)).toEqual([1024, 1024, 452]);
  });

  it('writeRunnerInput：预冲 Enter → 分块写入 → 提交 Enter', async () => {
    const specialKeys: string[][] = [];
    const texts: string[] = [];
    const backend: PtyLike = {
      write: () => true,
      sendText: text => { texts.push(text); return true; },
      sendSpecialKeys: (...keys) => { specialKeys.push(keys); return true; },
    };
    const result = await writeRunnerInput(backend, '::dockmux-test:', 'x'.repeat(2500));
    expect(result.submitted).toBe(true);
    // 预冲 1 次 + 提交 1 次
    expect(specialKeys.filter(k => k[0] === 'Enter').length).toBeGreaterThanOrEqual(2);
    // 分块写入，拼回来是完整控制行
    const joined = texts.join('');
    expect(joined.startsWith('::dockmux-test:')).toBe(true);
    expect(joined).toHaveLength('::dockmux-test:'.length + encodeRunnerInput('x'.repeat(2500)).length);
  });

  it('writeRunnerInput：裸 PTY 回退单次写入', async () => {
    const writes: string[] = [];
    const backend: PtyLike = { write: data => { writes.push(data); return true; } };
    const result = await writeRunnerInput(backend, '::dockmux-test:', 'hi');
    expect(result.submitted).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(`::dockmux-test:${encodeRunnerInput('hi')}\r`);
  });
});

// ===========================================================================
// 全适配器横切不变量（29 个一起过，防止新增适配器时漏掉某条契约）
// ===========================================================================

/** 最小上下文：只有必填的 sessionId。 */
const MINIMAL_CTX = { sessionId: SID };

/** 满上下文：所有可选字段都给值，验证没有适配器会因为多给字段而炸。 */
const FULL_CTX = {
  sessionId: SID,
  cwd: '/tmp/ws',
  resume: true,
  resumeSessionId: 'native-sid',
  initialPrompt: 'hello',
  model: 'some-model',
  reasoningEffort: 'high',
  locale: 'zh',
};

describe('全适配器横切契约', () => {
  it('每个 id 都能创建，且 adapter.id 与请求 id 一致', () => {
    for (const id of EXPECTED_IDS) {
      const adapter = createCliAdapter(id);
      expect(adapter.id, `${id} 的 adapter.id 应与请求 id 一致`).toBe(id);
    }
  });

  it('buildArgs 在最小上下文下不抛异常，且返回字符串数组', () => {
    for (const id of EXPECTED_IDS) {
      const adapter = createCliAdapter(id);
      const args = adapter.buildArgs(MINIMAL_CTX);
      expect(Array.isArray(args), `${id} 的 buildArgs 应返回数组`).toBe(true);
      for (const a of args) {
        expect(typeof a, `${id} 的 buildArgs 元素应全是字符串`).toBe('string');
      }
    }
  });

  it('buildArgs 在满上下文下不抛异常（多给字段不应炸）', () => {
    for (const id of EXPECTED_IDS) {
      const adapter = createCliAdapter(id);
      expect(() => adapter.buildArgs(FULL_CTX), `${id} 的 buildArgs 不应抛异常`).not.toThrow();
    }
  });

  it('buildArgs 不把 dockmux 的 ses_ 前缀泄漏进 argv', () => {
    // 例外：mtr 的原生 id 形态本身就是 `ses_<alnum>`（与 opencode 同一套规则），
    // 它的 `ses_` 是 mtr 自己的命名空间，不是 dockmux 前缀泄漏。
    const NATIVE_SES_PREFIX = new Set(['mtr']);
    for (const id of EXPECTED_IDS) {
      if (NATIVE_SES_PREFIX.has(id)) continue;
      const adapter = createCliAdapter(id);
      // 只查 fresh 分支：resume 分支传的 resumeSessionId 是 CLI 自己铸的 id，
      // 由调用方保证形态，适配器不该改写它。
      for (const a of adapter.buildArgs({ sessionId: SID, cwd: '/tmp/ws', model: 'm' })) {
        expect(a, `${id} 不应把 ses_ 前缀透传进 argv`).not.toContain('ses_');
      }
    }
  });

  it('能力位与 buildResumeCommand 严格互为充要（防能力位撒谎）', () => {
    // driver 的 resume() 只在 buildResumeCommand 存在时才动作：声明了
    // resume 却不实现它 = 静默 no-op；实现了却不声明 = 能力位漏报。
    for (const id of EXPECTED_IDS) {
      const adapter = createCliAdapter(id);
      expect(
        !!adapter.buildResumeCommand,
        `${id}: capabilities.resume(${!!adapter.capabilities.resume}) 与 buildResumeCommand 必须一致`,
      ).toBe(!!adapter.capabilities.resume);
    }
  });

  it('有 resume 能力的适配器：buildResumeCommand 返回非空且不含 dockmux 的 ses_ 前缀', () => {
    // 例外：mtr 的原生 id 形态本身就是 `ses_<alnum>`（自己的命名空间，不是
    // dockmux 前缀泄漏）——它在 buildResumeCommand 里会把 dockmux 前缀与连字符
    // 一起归一掉，单独在下面的 mtr 快照用例里断言。
    const NATIVE_SES_PREFIX = new Set(['mtr']);
    for (const id of EXPECTED_IDS) {
      const adapter = createCliAdapter(id);
      if (!adapter.capabilities.resume) continue;
      const argv = adapter.buildResumeCommand!(SID);
      expect(argv.length, `${id} 的 resume argv 不应为空`).toBeGreaterThan(0);
      for (const a of argv) {
        expect(typeof a, `${id} 的 resume argv 元素应全是字符串`).toBe('string');
        if (NATIVE_SES_PREFIX.has(id)) continue;
        expect(a, `${id} 的 resume argv 不应含 ses_ 前缀`).not.toContain('ses_');
      }
    }
  });

  it('buildResumeCommand 对带 ses_ 前缀的 sessionId 至少不原样透传', () => {
    // 只有把 dockmux sessionId 当 CLI 原生 id 用的适配器才需要剥前缀；
    // 其余适配器的入参是 CLI 自己铸的 id（codex 的 rollout id 等），
    // 适配器不该改写它。所以这里断言的是「不把 `ses_<uuid>` 整串原样递出」
    // 这一类适配器的行为，名单按各 CLI 的 id 语义显式列出。
    const STRIPS_PREFIX = ['claude-code', 'seed', 'relay', 'genius', 'coco', 'pi'] as const;
    for (const id of STRIPS_PREFIX) {
      const adapter = createCliAdapter(id);
      for (const a of adapter.buildResumeCommand!(`ses_${SID}`)) {
        expect(a, `${id} 的 buildResumeCommand 应剥掉 ses_ 前缀`).not.toContain('ses_');
      }
    }
  });

  it('pattern 族要么是 RegExp 要么缺省（不能是 undefined 以外的假值）', () => {
    const KEYS = [
      'completionPattern', 'busyPattern', 'idleToBusyPattern',
      'readyPattern', 'staticBusyPattern', 'staticBusyClearPattern',
    ] as const;
    for (const id of EXPECTED_IDS) {
      const adapter = createCliAdapter(id) as unknown as Record<string, unknown>;
      for (const key of KEYS) {
        const value = adapter[key];
        if (value !== undefined) {
          expect(value, `${id}.${key} 应是 RegExp`).toBeInstanceOf(RegExp);
        }
      }
    }
  });

  it('injectSessionContext（若实现）返回含 dockmux_routing 的块', () => {
    for (const id of EXPECTED_IDS) {
      const adapter = createCliAdapter(id);
      if (!adapter.injectSessionContext) continue;
      expect(adapter.injectSessionContext(MINIMAL_CTX), `${id} 的注入块`).toContain('<dockmux_routing>');
    }
  });

  it('writeInput 在裸 PTY 后端上把 prompt 送达且以提交收尾', async () => {
    for (const id of EXPECTED_IDS) {
      const adapter = createCliAdapter(id);
      const writes: string[] = [];
      await adapter.writeInput({ write: data => { writes.push(data); return true; } }, 'hello');
      const joined = writes.join('');
      expect(joined.length, `${id} 应向裸 PTY 写入内容`).toBeGreaterThan(0);
      // pass-through 壳（riff/mojo）由后端负责提交语义，不追加 \r。
      if (id === 'riff' || id === 'mojo') {
        expect(joined, `${id} 是直通壳，应原样写入`).toBe('hello');
        continue;
      }
      expect(joined, `${id} 应以 CR 提交`).toContain('\r');
    }
  }, 30_000);
});

describe('runner 类适配器', () => {
  const RUNNER_IDS = ['mir', 'mira', 'dsh', 'codex-app'] as const;

  it('marker 前缀是 ::dockmux-<id>:，且走 base64 控制行协议', async () => {
    for (const id of RUNNER_IDS) {
      const adapter = createCliAdapter(id);
      const writes: string[] = [];
      await adapter.writeInput({ write: data => { writes.push(data); return true; } }, 'hi');
      expect(writes, `${id} 应单次写入控制行`).toHaveLength(1);
      expect(writes[0], `${id} 的 marker 前缀`).toBe(`::dockmux-${id}:${encodeRunnerInput('hi')}\r`);
    }
  });

  it('buildArgs 产出 runner 参数：--session-id 恒在，且不含 runner 脚本路径', () => {
    for (const id of RUNNER_IDS) {
      const args = createCliAdapter(id).buildArgs({ sessionId: SID, cwd: '/tmp/ws', locale: 'zh' });
      expect(args[0], `${id} 应以 --session-id 起头`).toBe('--session-id');
      expect(args[1]).toBe(SID);
      // bin/runner 路径由 driver 的 AgentConfig.command 提供，适配器不解析。
      for (const a of args) {
        expect(a, `${id} 不应把 runner 脚本路径拼进 argv`).not.toMatch(/\.(?:js|cjs|mjs)$/);
      }
    }
  });

  it('dsh / codex-app 的可选 flag 按上下文出现', () => {
    const dsh = createCliAdapter('dsh').buildArgs({ sessionId: SID, cwd: '/tmp/ws', model: ' m ', locale: 'zh' });
    expect(dsh).toEqual(['--session-id', SID, '--cwd', '/tmp/ws', '--locale', 'zh', '--model', 'm']);
    // 空 model 不应产出空参数
    expect(createCliAdapter('dsh').buildArgs({ sessionId: SID, model: '   ' })).toEqual(['--session-id', SID]);

    const codexApp = createCliAdapter('codex-app').buildArgs({
      sessionId: SID, resume: true, resumeSessionId: 'thread-1',
      cwd: '/tmp/ws', model: 'gpt-5.5', reasoningEffort: 'high',
    });
    expect(codexApp).toEqual([
      '--session-id', SID, '--thread-id', 'thread-1',
      '--cwd', '/tmp/ws', '--model', 'gpt-5.5', '--reasoning-effort', 'high',
    ]);
  });
});

describe('参数复杂的适配器：buildArgs 快照', () => {
  it('coco：session-id/resume + yolo + 嵌套 model key + 禁 PlanMode', () => {
    const adapter = createCliAdapter('coco');
    expect(adapter.buildArgs({ sessionId: `ses_${SID}`, model: 'doubao' })).toEqual([
      '--session-id', SID, '--yolo', '--config', 'model.name=doubao',
      '--disallowed-tool', 'EnterPlanMode', '--disallowed-tool', 'ExitPlanMode',
    ]);
    expect(adapter.buildArgs({ sessionId: `ses_${SID}`, resume: true, resumeSessionId: 'coco-sid' })[1]).toBe('coco-sid');
  });

  it('claude 家族（claude-code/seed/relay）argv 完全同构，只有 id 不同', () => {
    const ctx = { sessionId: `ses_${SID}`, model: 'opus' };
    const base = createCliAdapter('claude-code').buildArgs(ctx);
    expect(base).toEqual(createCliAdapter('seed').buildArgs(ctx));
    expect(base).toEqual(createCliAdapter('relay').buildArgs(ctx));
    expect(base).toContain('--dangerously-skip-permissions');
    expect(base.slice(0, 2)).toEqual(['--session-id', SID]);
  });

  it('oh-my-pi：--no-title 起头，resume 吃 transcript 路径，yolo 审批', () => {
    const args = createCliAdapter('oh-my-pi').buildArgs({
      sessionId: SID, resume: true, resumeSessionId: '/tmp/omp/x.jsonl', model: 'm', cwd: '/tmp/ws',
    });
    expect(args).toEqual([
      '--no-title', '--resume', '/tmp/omp/x.jsonl',
      '--approval-mode', 'yolo', '--model', 'm', '--cwd', '/tmp/ws',
    ]);
  });

  it('kiro-cli：chat 子命令 + 核心工具白名单（不是 --trust-all-tools）', () => {
    const args = createCliAdapter('kiro-cli').buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'k1' });
    expect(args).toEqual(['chat', '--trust-tools=read,write,shell', '--resume-id', 'k1']);
    expect(args).not.toContain('--trust-all-tools');
    expect(createCliAdapter('kiro-cli').buildResumeCommand?.('k1')).toEqual(['chat', '--resume-id', 'k1']);
  });

  it('mtr：fresh 用 --set-session，resume 用 --session，id 归一成确定值', () => {
    const adapter = createCliAdapter('mtr');
    const fresh = adapter.buildArgs({ sessionId: `ses_${SID}` });
    expect(fresh[0]).toBe('--set-session');
    // mtr 的 id 只接受 `ses_` + 纯字母数字：连字符剥掉、尾段截到 26 位
    expect(fresh[1]).toBe(`ses_${SID.replace(/-/g, '').slice(0, 26)}`);
    expect(fresh[1]!.slice(4)).toMatch(/^[0-9A-Za-z]+$/);
    // 同一 dockmux session 恒定映射到同一 mtr id，resume 才能精确续接
    expect(adapter.buildArgs({ sessionId: `ses_${SID}`, resume: true })).toEqual(['--session', fresh[1]]);
    expect(adapter.buildResumeCommand?.(`ses_${SID}`)).toEqual(['--session', fresh[1]]);
  });

  it('pi：同一 --session-id 即续接（无独立 --resume），首轮 prompt 走位置参数', () => {
    const args = createCliAdapter('pi').buildArgs({ sessionId: `ses_${SID}`, model: 'm', initialPrompt: 'go' });
    expect(args).toEqual(['--session-id', SID, '--model', 'm', 'go']);
    expect(args).not.toContain('--resume');
    expect(createCliAdapter('pi').capabilities.initialPromptViaArgs).toBe(true);
  });

  it('antigravity：只认精确 conversation id，绝不 --continue', () => {
    const adapter = createCliAdapter('antigravity');
    expect(adapter.buildArgs({ sessionId: SID })).toEqual(['--dangerously-skip-permissions']);
    expect(adapter.buildArgs({ sessionId: SID, resume: true })).not.toContain('--continue');
    expect(adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'conv-1' }))
      .toEqual(['--dangerously-skip-permissions', '--conversation', 'conv-1']);
  });

  it('copilot / reasonix：无精确 id 时新起会话，绝不 --continue（防串兄弟会话）', () => {
    for (const id of ['copilot', 'reasonix'] as const) {
      const noId = createCliAdapter(id).buildArgs({ sessionId: SID, resume: true });
      expect(noId, `${id} 不应回退 --continue`).not.toContain('--continue');
      expect(noId, `${id} 无精确 id 时不应带 --resume`).not.toContain('--resume');
      expect(createCliAdapter(id).buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'x' })).toContain('--resume');
    }
  });

  it('riff / mojo：直通壳，buildArgs 为空且无 resume 能力', () => {
    for (const id of ['riff', 'mojo'] as const) {
      const adapter = createCliAdapter(id);
      expect(adapter.buildArgs(FULL_CTX), `${id} 的 buildArgs 应为空`).toEqual([]);
      expect(adapter.capabilities.resume, `${id} 不应声明 resume`).toBeFalsy();
    }
  });
});

describe('PTY_AGENT_CONTRIBUTIONS 覆盖度', () => {
  // 跨包断言放在这里而不是 pty-driver：contributions.ts 的每个 adapterId 都必须
  // 能被本包创建出来，否则 server 组装 driver 时才会在运行期炸。反向不成立——
  // 下面这些适配器已移植可用，但**都不能由 dockmux 直接 spawn**，登记进去只会
  // 让它们出现在 UI 列表里、用户一点就失败（尤其 codex-app 的 `codex` 在多数
  // 开发机上真实存在，commandExists 会放行，于是 runner 参数被喂给真实 codex）：
  //   riff / mira  —— API-backed，botmux 的 RAW_CLI_EXECUTABLES 对二者写 undefined
  //   mir/dsh/codex-app —— runner 类，buildArgs 产出的是 runner 参数，
  //                        而 dockmux 尚未移植 botmux 的 runner 脚本
  //   mojo        —— 执行主体是 MojoBackend（按回合 shell out），尚未移植
  // 移植 runner / 对应后端后再登记，并把 id 从这里挪走。
  const NOT_CONTRIBUTED = new Set(['riff', 'mira', 'mir', 'dsh', 'codex-app', 'mojo']);

  it('每个 adapterId 都能创建出适配器，且 id 自洽', async () => {
    const { PTY_AGENT_CONTRIBUTIONS } = await import('@dockmux/pty-driver');
    expect(PTY_AGENT_CONTRIBUTIONS.length).toBeGreaterThan(0);
    for (const c of PTY_AGENT_CONTRIBUTIONS) {
      expect(createCliAdapter(c.adapterId).id, `${c.id} 的 adapterId 应能创建`).toBe(c.adapterId);
    }
  });

  it('不可直接 spawn 的适配器不得登记，其余都已登记，且 contributions 无重复 id', async () => {
    const { PTY_AGENT_CONTRIBUTIONS } = await import('@dockmux/pty-driver');
    const contributed = new Set(PTY_AGENT_CONTRIBUTIONS.map(c => c.adapterId));
    expect(contributed.size, 'contributions 的 adapterId 不应重复').toBe(PTY_AGENT_CONTRIBUTIONS.length);
    for (const id of EXPECTED_IDS) {
      if (NOT_CONTRIBUTED.has(id)) {
        expect(contributed.has(id), `${id} 不可由 dockmux 直接 spawn，不该登记`).toBe(false);
        continue;
      }
      expect(contributed.has(id), `${id} 应登记进 PTY_AGENT_CONTRIBUTIONS`).toBe(true);
    }
  });

  it('声明 resume 的贡献，其适配器必须真有 resume 能力', async () => {
    const { PTY_AGENT_CONTRIBUTIONS } = await import('@dockmux/pty-driver');
    for (const c of PTY_AGENT_CONTRIBUTIONS) {
      expect(
        !!createCliAdapter(c.adapterId).capabilities.resume,
        `${c.id}: contributions 的 resume 位应与适配器能力一致`,
      ).toBe(c.capabilities.resume);
      expect(c.capabilities.pause, `${c.id}: MVP 不支持暂停`).toBe(false);
    }
  });
});
