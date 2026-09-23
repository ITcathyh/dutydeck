import { describe, it, expect, vi } from 'vitest';
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
import { pinnedSessionUuid } from './resume-id.js';
import { buildCwdTrustArgs } from './adapters/cwd-trust.js';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PtyLike } from './types.js';

const SID = '11111111-2222-3333-4444-555555555555';
const FULL_TRUST = { permissionMode: 'full-trust' as const };

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

/**
 * 自己铸 session id 的 CLI —— dutydeck 钉不了它们的会话 id。
 *
 * 反查失败时 driver 会退回 dutydeck 的 `ses_<uuid>`，这些 CLI 从没见过那个 id：
 * 带着它启动轻则静默起个空会话，重则立刻 exit 1（opencode / codex 实测）。
 * 它们的 buildResumeCommand 必须对这种 id 返回 null，让 driver 改起干净会话。
 *
 * 名单是显式的、不是推导的：新增自铸 id 的适配器时必须手工登记到这里，
 * 否则「忘了实现 null 判断」这类回归没有任何东西能拦住。
 */
const CLI_MINTED_ID_ADAPTERS = [
  'opencode', 'opencode2', 'codex', 'traex', 'antigravity', 'mira',
  'oh-my-pi', 'kiro-cli', 'copilot', 'cursor', 'kimi', 'reasonix',
] as const;

/**
 * dutydeck 在 fresh spawn 时把会话 id 钉给了 CLI（`--session-id` 一类），
 * 所以 dutydeck 的 sessionId **就是**有效的 resume 目标——绝不该返回 null。
 * 这份名单是上面那条的反向闸门，防「一刀切全返回 null」把能恢复的也丢掉。
 */
const PINNED_ID_ADAPTERS = ['claude-code', 'seed', 'relay', 'coco', 'genius', 'grok', 'pi', 'mtr'] as const;

/** OpenCode 家族的原生 id 就是 `ses_<base62>`（自己的命名空间，非 dutydeck 前缀）。 */
const OPENCODE_FAMILY = new Set(['opencode', 'opencode2']);

/**
 * 一个「该适配器所属 CLI 会认得」的样例 id。
 *
 * 大多数 CLI 的原生 id 形态各异且不透明，用裸 UUID 即可（codex 的 rollout id
 * 本来就是 UUID）；OpenCode 家族严格要求 `ses_<纯字母数字>`，喂 UUID 会被
 * 它自己的正则挡掉，所以单独给形态正确的样例。
 */
function nativeSampleId(id: string): string {
  return OPENCODE_FAMILY.has(id) ? 'ses_7f3kQ2mBz9' : SID;
}


describe('claude-code', () => {
  const adapter = createClaudeCodeAdapter();

  it('安全模式不 bypass，full-trust 才注入 settings', () => {
    const safeArgs = adapter.buildArgs({ sessionId: SID, permissionMode: 'ask' });
    expect(safeArgs).not.toContain('--dangerously-skip-permissions');
    expect(safeArgs).not.toContain('--settings');
    const args = adapter.buildArgs({ sessionId: SID, ...FULL_TRUST });
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

  it('目标步骤这类非 UUID 的 dutydeck 会话 id 钉成固定的合法 UUID，启动与续接一致', () => {
    const work = `ses_work_${'a'.repeat(64)}`;
    const pinned = pinnedSessionUuid(work);
    expect(pinned).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(pinnedSessionUuid(`ses_work_${'b'.repeat(64)}`)).not.toBe(pinned);
    expect(pinnedSessionUuid(`ses_${SID}`)).toBe(SID);
    expect(pinnedSessionUuid('cli-sid')).toBe('cli-sid');
    expect(adapter.buildArgs({ sessionId: work }).slice(0, 2)).toEqual(['--session-id', pinned]);
    expect(adapter.buildArgs({ sessionId: work, resume: true }).slice(0, 2)).toEqual(['--resume', pinned]);
    expect(adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: work }).slice(0, 2)).toEqual(['--resume', pinned]);
    expect(adapter.buildResumeCommand!(work)).toEqual(['--resume', pinned]);
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
    expect(block).toContain('<dutydeck_routing>');
    expect(adapter.buildResumeCommand?.(SID)).toEqual(['--resume', SID]);
  });
});

describe('buildCwdTrustArgs', () => {
  it('无 cwd 时返回空数组', () => {
    expect(buildCwdTrustArgs(undefined)).toEqual([]);
  });

  it('普通目录只注入一次内联表信任', () => {
    const args = buildCwdTrustArgs('/tmp/ws');
    expect(args).toEqual(['-c', 'projects={"/tmp/ws"={trust_level="trusted"}}']);
  });

  it('路径中的引号和反斜杠按 TOML basic string 转义', () => {
    const args = buildCwdTrustArgs('/weird"dir\\x');
    expect(args).toEqual(['-c', 'projects={"/weird\\"dir\\\\x"={trust_level="trusted"}}']);
  });

  it('realpath 与传入 cwd 不同时在单条 -c 内联表中合并注入两个路径', () => {
    // 构造一个真实目录再经软链接访问，确认词法路径和 realpath 都合并在同一张内联表中预置信任。
    const real = mkdtempSync(join(tmpdir(), 'trust-real-'));
    const link = `${real}-link`;
    symlinkSync(real, link);
    try {
      const args = buildCwdTrustArgs(link);
      expect(args).toEqual([
        '-c', `projects={${JSON.stringify(link)}={trust_level="trusted"},${JSON.stringify(real)}={trust_level="trusted"}}`,
      ]);
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { force: true, recursive: true });
    }
  });
});

describe('codex', () => {
  const adapter = createCodexAdapter();

  it('安全模式保留通用参数，full-trust 才添加 bypass 双 flag 并预置 cwd 信任', () => {
    const safeArgs = adapter.buildArgs({ sessionId: SID, permissionMode: 'ask', cwd: '/tmp/ws' });
    expect(safeArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(safeArgs).not.toContain('--dangerously-bypass-hook-trust');
    expect(safeArgs.some(a => a.startsWith('projects='))).toBe(false);
    const args = adapter.buildArgs({ sessionId: SID, ...FULL_TRUST, cwd: '/tmp/ws' });
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).toContain('--dangerously-bypass-hook-trust');
    expect(args).toContain('--no-alt-screen');
    expect(args).toContain('check_for_update_on_startup=false');
    const nudgeIndex = safeArgs.indexOf('notice.hide_rate_limit_model_nudge=true');
    expect(nudgeIndex).toBeGreaterThan(0);
    expect(safeArgs[nudgeIndex - 1]).toBe('-c');
    expect(args).toContain('notice.hide_rate_limit_model_nudge=true');
    expect(args).toContain('projects={"/tmp/ws"={trust_level="trusted"}}');
  });

  it('resume=true：resume 子命令 + id 收尾', () => {
    const args = adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'codex-sid' });
    expect(args[0]).toBe('resume');
    expect(args[args.length - 1]).toBe('codex-sid');
    expect(args.indexOf('notice.hide_rate_limit_model_nudge=true')).toBeLessThan(args.indexOf('codex-sid'));
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

  it('full-trust 的 cwd 信任预置按 TOML basic string 转义路径中的引号', () => {
    const args = adapter.buildArgs({ sessionId: SID, ...FULL_TRUST, cwd: '/weird"dir' });
    expect(args).toContain('projects={"/weird\\"dir"={trust_level="trusted"}}');
  });

  it('full-trust 无 cwd 时不注入 projects 信任预置', () => {
    const args = adapter.buildArgs({ sessionId: SID, ...FULL_TRUST });
    expect(args.some(a => a.startsWith('projects='))).toBe(false);
  });

  it('真正 resume（带 resumeSessionId）时同样注入 projects 预置：信任只来自进程级 -c、不写盘', () => {
    const args = adapter.buildArgs({
      sessionId: SID,
      resume: true,
      resumeSessionId: 'codex-sid',
      ...FULL_TRUST,
      cwd: '/tmp/ws',
    });
    expect(args[0]).toBe('resume');
    expect(args).toContain('projects={"/tmp/ws"={trust_level="trusted"}}');
    expect(args.indexOf('projects={"/tmp/ws"={trust_level="trusted"}}')).toBeLessThan(args.indexOf('codex-sid'));
  });

  it('pattern 族齐全', () => {
    expect(adapter.busyPattern).toBeInstanceOf(RegExp);
    expect(adapter.idleToBusyPattern).toBeInstanceOf(RegExp);
    expect(adapter.readyPattern).toBeInstanceOf(RegExp);
    expect(adapter.capabilities.resume).toBe(true);
    expect(adapter.buildResumeCommand?.('codex-sid')).toEqual(['resume', 'codex-sid']);
  });

  it('首轮输入等待 Codex 启动字段离开 loading', async () => {
    vi.useFakeTimers();
    try {
      let screen = [
        '│ model: loading │',
        '│ directory: loading │',
        '› Ask Codex',
      ].join('\n');
      expect(adapter.prepareInput).toBeTypeOf('function');
      let settled = false;
      const pending = adapter.prepareInput!({ write() {}, readScreen: () => screen }, { sessionId: SID })
        .then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toBe(false);

      screen = [
        '│ model: gpt-5.5 │',
        '│ directory: /tmp/workspace │',
        '› Ask Codex',
      ].join('\n');
      await vi.advanceTimersByTimeAsync(100);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('兼容没有 loading 状态栏的 Codex composer', async () => {
    expect(adapter.prepareInput).toBeTypeOf('function');
    await expect(adapter.prepareInput!(
      { write() {}, readScreen: () => 'Codex\n› Ask Codex' },
      { sessionId: SID },
    )).resolves.toBeUndefined();
  });

  it('启动字段持续 loading 时有界失败', async () => {
    vi.useFakeTimers();
    try {
      expect(adapter.prepareInput).toBeTypeOf('function');
      const pending = adapter.prepareInput!(
        { write() {}, readScreen: () => '│ model: loading │\n│ directory: loading │\n› Ask Codex' },
        { sessionId: SID },
      );
      const rejected = expect(pending).rejects.toThrow(/Codex.*就绪/);
      await vi.advanceTimersByTimeAsync(31_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('gemini', () => {
  const adapter = createGeminiAdapter();

  it('安全模式无 bypass，full-trust 使用 --yolo', () => {
    expect(adapter.buildArgs({ sessionId: SID, permissionMode: 'ask' })).toEqual([]);
    expect(adapter.buildArgs({ sessionId: SID, ...FULL_TRUST })).toEqual(['--yolo']);
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

  it('安全模式不自动批准，full-trust 添加 --always-approve', () => {
    const safeArgs = adapter.buildArgs({ sessionId: SID, permissionMode: 'ask' });
    expect(safeArgs).not.toContain('--always-approve');
    const args = adapter.buildArgs({ sessionId: SID, ...FULL_TRUST });
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
    expect(adapter.injectSessionContext?.({ sessionId: SID })).toContain('<dutydeck_routing>');
    expect(adapter.buildResumeCommand?.(SID)).toEqual(['--resume', SID]);
  });
});

describe('cursor', () => {
  const adapter = createCursorAdapter();

  it('安全模式不预信任工作区，full-trust 才使用 --trust + --force', () => {
    expect(adapter.buildArgs({ sessionId: SID, permissionMode: 'ask' })).toEqual([]);
    const args = adapter.buildArgs({ sessionId: SID, ...FULL_TRUST });
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

  it('安全模式无 bypass，full-trust 使用 --yolo', () => {
    expect(adapter.buildArgs({ sessionId: SID, permissionMode: 'ask' })).toEqual([]);
    expect(adapter.buildArgs({ sessionId: SID, ...FULL_TRUST })).toEqual(['--yolo']);
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

  it('安全模式不 bypass，full-trust 才添加双 flag 并预置 cwd 信任', () => {
    const safeArgs = adapter.buildArgs({ sessionId: SID, permissionMode: 'ask', cwd: '/tmp/ws' });
    expect(safeArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(safeArgs).not.toContain('--dangerously-bypass-hook-trust');
    expect(safeArgs.some(a => a.startsWith('projects='))).toBe(false);
    const args = adapter.buildArgs({ sessionId: SID, ...FULL_TRUST, cwd: '/tmp/ws' });
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).toContain('--dangerously-bypass-hook-trust');
    expect(args).toContain('--no-alt-screen');
    expect(args).toContain('notice.hide_rate_limit_model_nudge=true');
    expect(args).toContain('projects={"/tmp/ws"={trust_level="trusted"}}');
  });

  it('resume=true：resume 子命令 + id 收尾；无 id 新起', () => {
    const args = adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'trae-sid' });
    expect(args[0]).toBe('resume');
    expect(args[args.length - 1]).toBe('trae-sid');
    expect(adapter.buildArgs({ sessionId: SID, resume: true })[0]).not.toBe('resume');
  });

  it('真正 resume（带 resumeSessionId）时同样注入 projects 预置：信任只来自进程级 -c、不写盘', () => {
    const args = adapter.buildArgs({
      sessionId: SID,
      resume: true,
      resumeSessionId: 'trae-sid',
      ...FULL_TRUST,
      cwd: '/tmp/ws',
    });
    expect(args[0]).toBe('resume');
    expect(args).toContain('projects={"/tmp/ws"={trust_level="trusted"}}');
    expect(args.indexOf('projects={"/tmp/ws"={trust_level="trusted"}}')).toBeLessThan(args.indexOf('trae-sid'));
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
    const result = await writeRunnerInput(backend, '::dutydeck-test:', 'x'.repeat(2500));
    expect(result.submitted).toBe(true);
    // 预冲 1 次 + 提交 1 次
    expect(specialKeys.filter(k => k[0] === 'Enter').length).toBeGreaterThanOrEqual(2);
    // 分块写入，拼回来是完整控制行
    const joined = texts.join('');
    expect(joined.startsWith('::dutydeck-test:')).toBe(true);
    expect(joined).toHaveLength('::dutydeck-test:'.length + encodeRunnerInput('x'.repeat(2500)).length);
  });

  it('writeRunnerInput：裸 PTY 回退单次写入', async () => {
    const writes: string[] = [];
    const backend: PtyLike = { write: data => { writes.push(data); return true; } };
    const result = await writeRunnerInput(backend, '::dutydeck-test:', 'hi');
    expect(result.submitted).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(`::dutydeck-test:${encodeRunnerInput('hi')}\r`);
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
  permissionMode: 'full-trust' as const,
};

describe('全适配器横切契约', () => {
  const fullTrustSignatures: Partial<Record<(typeof EXPECTED_IDS)[number], string[]>> = {
    'claude-code': ['--dangerously-skip-permissions', 'bypassPermissions'],
    seed: ['--dangerously-skip-permissions', 'bypassPermissions'],
    relay: ['--dangerously-skip-permissions', 'bypassPermissions'],
    codex: ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'],
    traex: ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'],
    gemini: ['--yolo'],
    grok: ['--always-approve'],
    cursor: ['--trust', '--force'],
    kimi: ['--yolo'],
    antigravity: ['--dangerously-skip-permissions'],
    coco: ['--yolo'],
    hermes: ['--yolo', '--accept-hooks'],
    'oh-my-pi': ['--approval-mode', 'yolo'],
    copilot: ['--allow-all-tools'],
    'kiro-cli': ['--trust-tools=read,write,shell'],
    reasonix: ['--yolo'],
    aiden: ['--permission-mode', 'agentFull'],
    genius: ['--dangerously-skip-permissions', 'bypassPermissions'],
  };

  it('缺省/ask/approve-reads/deny-all 不注入任何 CLI 的 full-trust 签名', () => {
    for (const [id, signatures] of Object.entries(fullTrustSignatures)) {
      const adapter = createCliAdapter(id);
      for (const permissionMode of [undefined, 'ask', 'approve-reads', 'deny-all'] as const) {
        const serialized = adapter.buildArgs({ sessionId: SID, permissionMode }).join('\u0000');
        for (const signature of signatures) {
          expect(serialized, `${id}/${permissionMode ?? 'omitted'} 不应包含 ${signature}`).not.toContain(signature);
        }
      }
    }
  });

  it('full-trust 为每个支持显式放行的 CLI 注入其原生参数/settings', () => {
    for (const [id, signatures] of Object.entries(fullTrustSignatures)) {
      const serialized = createCliAdapter(id).buildArgs({ sessionId: SID, ...FULL_TRUST }).join('\u0000');
      for (const signature of signatures) {
        expect(serialized, `${id}/full-trust 应包含 ${signature}`).toContain(signature);
      }
    }
  });

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

  it('buildArgs 不把 dutydeck 的 ses_ 前缀泄漏进 argv', () => {
    // 例外：mtr 的原生 id 形态本身就是 `ses_<alnum>`（与 opencode 同一套规则），
    // 它的 `ses_` 是 mtr 自己的命名空间，不是 dutydeck 前缀泄漏。
    const NATIVE_SES_PREFIX = new Set(['mtr']);
    for (const id of EXPECTED_IDS) {
      if (NATIVE_SES_PREFIX.has(id)) continue;
      const adapter = createCliAdapter(id);
      // 只查 fresh 分支：resume 分支的 resumeSessionId 另有专门用例（见下一条），
      // 因为那条路径上「调用方保证形态」这个前提并不成立。
      for (const a of adapter.buildArgs({ sessionId: SID, cwd: '/tmp/ws', model: 'm' })) {
        expect(a, `${id} 不应把 ses_ 前缀透传进 argv`).not.toContain('ses_');
      }
    }
  });

  it('钉过 id 的 CLI：fresh 与 resume 必须钉同一种 id 形态', () => {
    // 「resumeSessionId 由调用方保证是 CLI 原生形态」——这个前提是**错的**。
    // driver 的 resolveResumeSessionId() 三级优先里，最后一级是「反查不到 →
    // 退回 dutydeck 自己的 sessionId」，那个 id 带着 `ses_` 前缀。
    //
    // 钉过 id 的 CLI 在 fresh spawn 时自己决定了写进磁盘的 id 长什么样
    // （claude 剥成裸 UUID、grok 用完整 `ses_<uuid>`、mtr 推导成 `ses_<26位>`）。
    // resume 想续上的就是那一个会话，所以两条分支必须归一出**同一个字符串**。
    // 不一致 = 拿一个 CLI 从没写过的 id 去续接：真机实测 claude 会
    // exit 1（No conversation found with session ID）；pi 更坏——exit 0 却
    // 静默 fork 出新会话，上下文全丢且没有任何信号。
    //
    // 断言的是「两分支一致」而不是「必须剥前缀」：grok 的 `ses_<uuid>` 是它
    // fresh 时亲自钉下去的，剥掉反而错。自铸 id 的 CLI 不在此列——它们对这个
    // id 的正确回答是 null（放弃 resume），由后面的用例守。
    const dutydeckId = `ses_${SID}`;
    for (const id of PINNED_ID_ADAPTERS) {
      const adapter = createCliAdapter(id);
      const base = { sessionId: dutydeckId, cwd: '/tmp/ws' };
      const freshIds = adapter.buildArgs(base).filter(a => a.includes(SID.slice(0, 8)));
      const resumeIds = adapter
        .buildArgs({ ...base, resume: true, resumeSessionId: dutydeckId })
        .filter(a => a.includes(SID.slice(0, 8)));
      expect(resumeIds, `${id}: resume 分支没带上会话 id`).not.toHaveLength(0);
      expect(resumeIds, `${id}: fresh 钉的是 ${JSON.stringify(freshIds)}，`
        + `resume 却拿 ${JSON.stringify(resumeIds)} 去续接——CLI 磁盘上没有后者这个会话`)
        .toEqual(freshIds);
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

  it('喂 CLI 原生形态的 id 时，有 resume 能力的适配器都给出非空 argv（不是 null）', () => {
    // 例外：mtr 的原生 id 形态本身就是 `ses_<alnum>`（自己的命名空间，不是
    // dutydeck 前缀泄漏）——它在 buildResumeCommand 里会把 dutydeck 前缀与连字符
    // 一起归一掉，单独在下面的 mtr 快照用例里断言。
    const NATIVE_SES_PREFIX = new Set(['mtr']);
    for (const id of EXPECTED_IDS) {
      const adapter = createCliAdapter(id);
      if (!adapter.capabilities.resume) continue;
      const argv = adapter.buildResumeCommand!(nativeSampleId(id));
      expect(argv, `${id} 拿到自己原生形态的 id 不该否决`).not.toBeNull();
      expect(argv!.length, `${id} 的 resume argv 不应为空`).toBeGreaterThan(0);
      for (const a of argv!) {
        expect(typeof a, `${id} 的 resume argv 元素应全是字符串`).toBe('string');
        if (NATIVE_SES_PREFIX.has(id) || OPENCODE_FAMILY.has(id)) continue;
        expect(a, `${id} 的 resume argv 不应含 ses_ 前缀`).not.toContain('ses_');
      }
    }
  });

  it('喂 dutydeck 自己的 ses_<uuid> 时：自铸 id 的 CLI 必须返回 null（放弃 resume）', () => {
    // 这是缺口 1 的核心契约。driver 的 resolveResumeSessionId 反查不到 CLI 原生
    // id 时会退回 dutydeck 的 `ses_<uuid>`。对自己铸 id 的 CLI，这个 id 它从没见过：
    // `opencode -s <不存在的id>` 立刻 exit 1，会话随即被判 failed，之后 send 全 409。
    // 唯一正确的回答是 null —— 让 driver 放弃 resume、改起干净会话。
    const dutydeckId = `ses_${SID}`;
    for (const id of CLI_MINTED_ID_ADAPTERS) {
      const adapter = createCliAdapter(id);
      expect(
        adapter.buildResumeCommand!(dutydeckId),
        `${id} 自己铸 session id，收到 dutydeck 的 ${dutydeckId} 必须返回 null 而不是拿它去启动`,
      ).toBeNull();
    }
  });

  it('喂 dutydeck 自己的 ses_<uuid> 时：dutydeck 钉过 id 的 CLI 必须照常 resume', () => {
    // 反向断言，防「一刀切全返回 null」：claude `--session-id` 这类适配器在
    // fresh spawn 时就把 id 钉成了 dutydeck 的，那个 id 就是有效的 resume 目标，
    // 否决它等于白白丢掉本来能恢复的上下文。
    for (const id of PINNED_ID_ADAPTERS) {
      const adapter = createCliAdapter(id);
      const argv = adapter.buildResumeCommand!(`ses_${SID}`);
      expect(argv, `${id} 的 id 是 dutydeck 钉的，不该否决`).not.toBeNull();
      expect(argv!.length, `${id} 的 resume argv 不应为空`).toBeGreaterThan(0);
    }
  });

  it('null 与能力位不矛盾：返回 null 的适配器仍然声明 resume 能力', () => {
    // null 的语义是「这个 id 用不了」，不是「我不支持 resume」。能力位若跟着
    // 消失，driver.resume 会走成 no-op 分支——既不续接也不降级，用户什么都收不到。
    for (const id of CLI_MINTED_ID_ADAPTERS) {
      const adapter = createCliAdapter(id);
      expect(adapter.capabilities.resume, `${id} 应仍声明 resume 能力`).toBe(true);
      expect(typeof adapter.buildResumeCommand, `${id} 应仍实现 buildResumeCommand`).toBe('function');
    }
  });

  it('buildResumeCommand 对带 ses_ 前缀的 sessionId 至少不原样透传', () => {
    // 只有把 dutydeck sessionId 当 CLI 原生 id 用的适配器才需要剥前缀；
    // 其余适配器的入参是 CLI 自己铸的 id（codex 的 rollout id 等），
    // 适配器不该改写它。所以这里断言的是「不把 `ses_<uuid>` 整串原样递出」
    // 这一类适配器的行为，名单按各 CLI 的 id 语义显式列出。
    const STRIPS_PREFIX = ['claude-code', 'seed', 'relay', 'genius', 'coco', 'pi'] as const;
    for (const id of STRIPS_PREFIX) {
      const adapter = createCliAdapter(id);
      for (const a of adapter.buildResumeCommand!(`ses_${SID}`)!) {
        expect(a, `${id} 的 buildResumeCommand 应剥掉 ses_ 前缀`).not.toContain('ses_');
      }
    }
  });

  it('resume 分支的 buildArgs 与 buildResumeCommand 对同一个 id 判断一致', () => {
    // driver 用 buildResumeCommand 裁决「能不能 resume」，但真正的 argv 来自
    // buildArgs({resume:true})。两者若不同步，就会出现「裁决说不能续接、argv 里
    // 却仍带着续接定位」的矛盾：CLI 拿着必然无效的 id 启动，正是缺口 1 要根治的。
    //
    // 断言方式是「fresh 与 resume 的 argv 必须逐字相同」而不是「argv 里不许出现
    // 这个 id」：mira / dsh 一类 runner 适配器的 `--session-id` 是 **runner 自己的**
    // 参数，本来就该带 dutydeck sessionId，与 CLI 侧的续接定位无关。
    const dutydeckId = `ses_${SID}`;
    for (const id of CLI_MINTED_ID_ADAPTERS) {
      const adapter = createCliAdapter(id);
      const fresh = adapter.buildArgs({ sessionId: dutydeckId });
      const resumed = adapter.buildArgs({ sessionId: dutydeckId, resume: true, resumeSessionId: dutydeckId });
      expect(
        resumed,
        `${id} 否决了这个 id，resume 分支的 argv 就该与 fresh 完全一致（不带任何续接定位）`,
      ).toEqual(fresh);
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

  it('injectSessionContext（若实现）返回含 dutydeck_routing 的块', () => {
    for (const id of EXPECTED_IDS) {
      const adapter = createCliAdapter(id);
      if (!adapter.injectSessionContext) continue;
      expect(adapter.injectSessionContext(MINIMAL_CTX), `${id} 的注入块`).toContain('<dutydeck_routing>');
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

  it('marker 前缀是 ::dutydeck-<id>:，且走 base64 控制行协议', async () => {
    for (const id of RUNNER_IDS) {
      const adapter = createCliAdapter(id);
      const writes: string[] = [];
      await adapter.writeInput({ write: data => { writes.push(data); return true; } }, 'hi');
      expect(writes, `${id} 应单次写入控制行`).toHaveLength(1);
      expect(writes[0], `${id} 的 marker 前缀`).toBe(`::dutydeck-${id}:${encodeRunnerInput('hi')}\r`);
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
    expect(adapter.buildArgs({ sessionId: `ses_${SID}`, model: 'doubao', ...FULL_TRUST })).toEqual([
      '--session-id', SID, '--yolo', '--config', 'model.name=doubao',
      '--disallowed-tool', 'EnterPlanMode', '--disallowed-tool', 'ExitPlanMode',
    ]);
    expect(adapter.buildArgs({ sessionId: `ses_${SID}`, resume: true, resumeSessionId: 'coco-sid' })[1]).toBe('coco-sid');
  });

  it('claude 家族（claude-code/seed/relay）argv 完全同构，只有 id 不同', () => {
    const ctx = { sessionId: `ses_${SID}`, model: 'opus', ...FULL_TRUST };
    const base = createCliAdapter('claude-code').buildArgs(ctx);
    expect(base).toEqual(createCliAdapter('seed').buildArgs(ctx));
    expect(base).toEqual(createCliAdapter('relay').buildArgs(ctx));
    expect(base).toContain('--dangerously-skip-permissions');
    expect(base.slice(0, 2)).toEqual(['--session-id', SID]);
  });

  it('oh-my-pi：--no-title 起头，resume 吃 transcript 路径，yolo 审批', () => {
    const args = createCliAdapter('oh-my-pi').buildArgs({
      sessionId: SID, resume: true, resumeSessionId: '/tmp/omp/x.jsonl', model: 'm', cwd: '/tmp/ws',
      ...FULL_TRUST,
    });
    expect(args).toEqual([
      '--no-title', '--resume', '/tmp/omp/x.jsonl',
      '--approval-mode', 'yolo', '--model', 'm', '--cwd', '/tmp/ws',
    ]);
  });

  it('kiro-cli：chat 子命令 + 核心工具白名单（不是 --trust-all-tools）', () => {
    const args = createCliAdapter('kiro-cli').buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'k1', ...FULL_TRUST });
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
    // 同一 dutydeck session 恒定映射到同一 mtr id，resume 才能精确续接
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
    expect(adapter.buildArgs({ sessionId: SID, ...FULL_TRUST })).toEqual(['--dangerously-skip-permissions']);
    expect(adapter.buildArgs({ sessionId: SID, resume: true })).not.toContain('--continue');
    expect(adapter.buildArgs({ sessionId: SID, resume: true, resumeSessionId: 'conv-1', ...FULL_TRUST }))
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
  // 下面这些适配器已移植可用，但**都不能由 dutydeck 直接 spawn**，登记进去只会
  // 让它们出现在 UI 列表里、用户一点就失败（尤其 codex-app 的 `codex` 在多数
  // 开发机上真实存在，commandExists 会放行，于是 runner 参数被喂给真实 codex）：
  //   riff / mira  —— API-backed 后端，不通过本地 command spawn
  //   mir/dsh/codex-app —— runner 类，buildArgs 产出的是 runner 参数，
  //                        而外部 runner 脚本未接入
  //   mojo        —— 执行主体是 MojoBackend（按回合 shell out），尚未移植
  //   mtr         —— 可执行文件名与常见网络诊断工具冲突；在能可靠指纹识别前
  //                        仅允许通过 DUTYDECK_AGENTS_JSON 显式配置
  // 移植 runner / 对应后端后再登记，并把 id 从这里挪走。
  const NOT_CONTRIBUTED = new Set(['riff', 'mira', 'mir', 'dsh', 'codex-app', 'mojo', 'mtr']);

  it('每个 adapterId 都能创建出适配器，且 id 自洽', async () => {
    const { PTY_AGENT_CONTRIBUTIONS } = await import('@dutydeck/pty-driver');
    expect(PTY_AGENT_CONTRIBUTIONS.length).toBeGreaterThan(0);
    for (const c of PTY_AGENT_CONTRIBUTIONS) {
      expect(createCliAdapter(c.adapterId).id, `${c.id} 的 adapterId 应能创建`).toBe(c.adapterId);
    }
  });

  it('不可直接 spawn 的适配器不得登记，其余都已登记，且 contributions 无重复 id', async () => {
    const { PTY_AGENT_CONTRIBUTIONS } = await import('@dutydeck/pty-driver');
    const contributed = new Set(PTY_AGENT_CONTRIBUTIONS.map(c => c.adapterId));
    expect(contributed.size, 'contributions 的 adapterId 不应重复').toBe(PTY_AGENT_CONTRIBUTIONS.length);
    for (const id of EXPECTED_IDS) {
      if (NOT_CONTRIBUTED.has(id)) {
        expect(contributed.has(id), `${id} 不可由 dutydeck 直接 spawn，不该登记`).toBe(false);
        continue;
      }
      expect(contributed.has(id), `${id} 应登记进 PTY_AGENT_CONTRIBUTIONS`).toBe(true);
    }
  });

  it('声明 resume 的贡献，其适配器必须真有 resume 能力', async () => {
    const { PTY_AGENT_CONTRIBUTIONS } = await import('@dutydeck/pty-driver');
    for (const c of PTY_AGENT_CONTRIBUTIONS) {
      expect(
        !!createCliAdapter(c.adapterId).capabilities.resume,
        `${c.id}: contributions 的 resume 位应与适配器能力一致`,
      ).toBe(c.capabilities.resume);
      expect(c.capabilities.pause, `${c.id}: MVP 不支持暂停`).toBe(false);
    }
  });
});
