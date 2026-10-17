import { describe, expect, it } from 'vitest';
import { createClaudeCodeAdapter } from './adapters/claude-code.js';
import { createCodexAdapter } from './adapters/codex.js';

describe('native session fork launch arguments', () => {
  const source = '11111111-1111-4111-8111-111111111111';
  const child = '22222222-2222-4222-8222-222222222222';
  it('Claude copies the exact parent into a distinct pinned session and keeps model and permission flags', () => {
    const args = createClaudeCodeAdapter().buildArgs({ sessionId: `ses_${child}`, nativeForkSessionId: source, cwd: '/tmp/worktree', model: 'sonnet', permissionMode: 'full-trust' });
    expect(args.slice(0, 6)).toEqual(['--resume', source, '--fork-session', '--session-id', child, '--model']);
    expect(args).toContain('sonnet'); expect(args).toContain('--dangerously-skip-permissions');
  });
  it('Codex forks the exact parent across working directories, preserving launch configuration', () => {
    const args = createCodexAdapter().buildArgs({ sessionId: `ses_${child}`, nativeForkSessionId: source, cwd: '/tmp/worktree', model: 'gpt-test', permissionMode: 'full-trust' });
    expect(args).toContain('fork'); expect(args).not.toContain('resume'); expect(args.at(-1)).toBe(source);
    expect(args).toContain('--all'); expect(args).toContain('/tmp/worktree'); expect(args).toContain('gpt-test');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });
  it('ask forks use the current permission flags for both native CLIs', () => {
    const context = { sessionId: `ses_${child}`, nativeForkSessionId: source, cwd: '/tmp/worktree', permissionMode: 'ask' as const, env: { dutydeck_session_source: 'lark' } };
    const claude = createClaudeCodeAdapter().buildArgs(context);
    expect(claude.slice(claude.indexOf('--permission-mode'), claude.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'default']);
    expect(claude).not.toContain('--dangerously-skip-permissions');
    const codex = createCodexAdapter().buildArgs(context);
    expect(codex).toContain('fork');
    expect(codex).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(codex).not.toContain('--dangerously-bypass-hook-trust');
  });

});
