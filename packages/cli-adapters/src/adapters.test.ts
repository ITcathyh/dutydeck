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
  it('ALL_CLI_IDS 是 8 个 MVP id', () => {
    expect([...ALL_CLI_IDS].sort()).toEqual(
      ['claude-code', 'codex', 'cursor', 'gemini', 'grok', 'kimi', 'opencode', 'traex'].sort(),
    );
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
