import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installLarkHook, larkHookStatus } from './security-hooks.js';

const workspaces: string[] = [];
afterEach(async () => Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true }))));

const runGuard = async (workspace: string, agentId: 'codex' | 'cursor', sessionId: string, event: unknown) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
  const script = join(workspace, '.dockmux', 'security', `dockmux-lark-high-risk-guard-${agentId}.mjs`);
  const child = spawn(process.execPath, [script], { env: { ...process.env, dockmux_session_id: sessionId, DOCKMUX_POLICY_ROOT: workspace }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let error = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
  child.once('error', reject); child.once('close', code => error ? reject(new Error(error)) : resolve({ code, output }));
  child.stdin.end(JSON.stringify(event));
});

describe('Lark Agent security hooks', () => {
  it('installs or updates a Codex PreToolUse hook without replacing existing hooks', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dockmux-hook-')); workspaces.push(workspace);
    await mkdir(join(workspace, '.codex'), { recursive: true });
    await writeFile(join(workspace, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'existing' }] }] } }));
    expect(await larkHookStatus('codex', workspace)).toMatchObject({ supported: true, installed: false, writable: true });
    await installLarkHook('codex', workspace);
    const installed = await larkHookStatus('codex', workspace);
    expect(installed).toMatchObject({ supported: true, installed: true, writable: true, trustRequired: true });
    const hooks = JSON.parse(await readFile(join(workspace, '.codex', 'hooks.json'), 'utf8')).hooks.PreToolUse;
    expect(hooks).toHaveLength(2);
    expect(JSON.stringify(hooks)).toContain('existing');
    expect(JSON.stringify(hooks)).toContain('dockmux-lark-high-risk-guard-codex.mjs');
    await installLarkHook('codex', workspace);
    expect(JSON.parse(await readFile(join(workspace, '.codex', 'hooks.json'), 'utf8')).hooks.PreToolUse).toHaveLength(2);
  });

  it('blocks matching tool input and allows authorized or safe input', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dockmux-hook-')); workspaces.push(workspace);
    await installLarkHook('codex', workspace);
    const policyDirectory = join(workspace, '.dockmux', 'security', 'sessions');
    await mkdir(policyDirectory, { recursive: true });
    await writeFile(join(policyDirectory, 'ses_guard.json'), JSON.stringify({ enabled: true, authorized: false, pattern: '(?:^|\\s)rm\\b', reason: 'blocked by test' }));
    const denied = await runGuard(workspace, 'codex', 'ses_guard', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /tmp/example' } });
    expect(denied.code).toBe(0);
    expect(JSON.parse(denied.output)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked by test' } });
    expect((await runGuard(workspace, 'codex', 'ses_guard', { tool_name: 'Bash', tool_input: { command: 'pwd' } })).output).toBe('');
    await writeFile(join(policyDirectory, 'ses_guard.json'), JSON.stringify({ enabled: true, authorized: true, pattern: 'rm\\b' }));
    expect((await runGuard(workspace, 'codex', 'ses_guard', { tool_name: 'Bash', tool_input: { command: 'rm file' } })).output).toBe('');
  });

  it('terminates catastrophic matching after one second and fails closed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dockmux-hook-')); workspaces.push(workspace);
    await installLarkHook('codex', workspace);
    const policyDirectory = join(workspace, '.dockmux', 'security', 'sessions');
    await mkdir(policyDirectory, { recursive: true });
    await writeFile(join(policyDirectory, 'ses_timeout.json'), JSON.stringify({ enabled: true, authorized: false, pattern: '(a+)+$' }));
    const startedAt = Date.now();
    const result = await runGuard(workspace, 'codex', 'ses_timeout', { tool_name: 'Bash', tool_input: { command: `${'a'.repeat(50_000)}!` } });
    expect(Date.now() - startedAt).toBeLessThan(2_500);
    expect(JSON.parse(result.output)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('1000ms') } });
  });

  it.each([
    ['claude', '.claude/settings.json', 'PreToolUse'],
    ['trae', '.trae/hooks.json', 'PreToolUse'],
    ['cursor', '.cursor/hooks.json', 'preToolUse']
  ] as const)('installs a native %s project hook', async (agentId, relativePath, eventKey) => {
    const workspace = await mkdtemp(join(tmpdir(), 'dockmux-hook-')); workspaces.push(workspace);
    const installed = await installLarkHook(agentId, workspace);
    expect(installed).toMatchObject({ agentId, supported: true, installed: true, writable: true, trustRequired: true });
    const config = JSON.parse(await readFile(join(workspace, relativePath), 'utf8'));
    expect(config.hooks[eventKey]).toHaveLength(1);
    expect(JSON.stringify(config.hooks[eventKey])).toContain(`dockmux-lark-high-risk-guard-${agentId}.mjs`);
    if (agentId === 'cursor') {
      expect(config).toMatchObject({ version: 1 });
      expect(config.hooks.preToolUse[0]).toMatchObject({ failClosed: true, timeout: 5 });
    }
  });

  it('installs a Pi tool_call extension and recognizes common aliases', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dockmux-hook-')); workspaces.push(workspace);
    expect(await installLarkHook('pi', workspace)).toMatchObject({ agentId: 'pi', supported: true, installed: true });
    const extension = await readFile(join(workspace, '.pi/extensions/dockmux-high-risk-guard.ts'), 'utf8');
    expect(extension).toContain('dockmux-high-risk-guard-v2');
    expect(extension).toContain("pi.on('tool_call'");
    expect(await larkHookStatus('claudecode', workspace)).toMatchObject({ agentId: 'claude', supported: true, installed: false });
    expect(await larkHookStatus('cursoragent', workspace)).toMatchObject({ agentId: 'cursor', supported: true, installed: false });
  });

  it('returns Cursor permission deny and keeps another Agent hook in the same workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dockmux-hook-')); workspaces.push(workspace);
    await installLarkHook('codex', workspace);
    await installLarkHook('cursor', workspace);
    const policyDirectory = join(workspace, '.dockmux', 'security', 'sessions');
    await mkdir(policyDirectory, { recursive: true });
    await writeFile(join(policyDirectory, 'ses_cursor.json'), JSON.stringify({ enabled: true, authorized: false, pattern: 'sudo\\b', reason: 'cursor blocked' }));
    const denied = await runGuard(workspace, 'cursor', 'ses_cursor', { tool_name: 'Shell', tool_input: { command: 'sudo reboot' } });
    expect(JSON.parse(denied.output)).toMatchObject({ continue: true, permission: 'deny', user_message: 'cursor blocked', agent_message: 'cursor blocked' });
    expect(await larkHookStatus('codex', workspace)).toMatchObject({ installed: true });
    expect(await larkHookStatus('cursor', workspace)).toMatchObject({ installed: true });
  });

  it('refuses genuinely unsupported Agents instead of presenting a false hard-gate switch', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dockmux-hook-')); workspaces.push(workspace);
    await expect(installLarkHook('gemini', workspace)).rejects.toMatchObject({ code: 'HARD_GATE_UNSUPPORTED', statusCode: 422 });
    expect(await larkHookStatus('gemini', workspace)).toMatchObject({ supported: false, installed: false, writable: false });
  });
});
