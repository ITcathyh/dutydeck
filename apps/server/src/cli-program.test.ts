import { describe, expect, it, vi } from 'vitest';
import { createCliProgram, environmentFromCli } from './cli-program.js';

describe('Dockmux CLI', () => {
  it('maps explicit Commander options to runtime environment variables', () => {
    const program = createCliProgram('0.0.5');
    program.parse(['node', 'dockmux', '--host', '127.0.0.1', '--port', '4400', '--cwd', '/tmp/project', '--database', '/tmp/dock.db', '--idle-timeout-ms', '1000', '--cleanup-interval-ms', '500', '--lark-app-id', 'cli_test', '--lark-agent-name', 'My Agent']);
    expect(environmentFromCli(program.opts(), { DOCKMUX_PORT: '4310', KEEP_ME: 'yes' })).toMatchObject({
      DOCKMUX_HOST: '127.0.0.1',
      DOCKMUX_PORT: '4400',
      DOCKMUX_DEFAULT_CWD: '/tmp/project',
      DOCKMUX_DATABASE_URL: '/tmp/dock.db',
      DOCKMUX_DRIVER_IDLE_TIMEOUT_MS: '1000',
      DOCKMUX_CLEANUP_INTERVAL_MS: '500',
      LARK_APP_ID: 'cli_test',
      LARK_AGENT_NAME: 'My Agent',
      KEEP_ME: 'yes'
    });
  });

  it('does not overwrite environment values for omitted options', () => {
    const program = createCliProgram('0.0.5');
    program.parse(['node', 'dockmux']);
    expect(environmentFromCli(program.opts(), { DOCKMUX_HOST: '10.0.0.1' })).toEqual({ DOCKMUX_HOST: '10.0.0.1' });
  });

  it('disables Lark listening for only the current process', () => {
    const program = createCliProgram('0.0.5');
    program.parse(['node', 'dockmux', '--no-lark-listen']);
    expect(environmentFromCli(program.opts(), {})).toEqual({ DOCKMUX_DISABLE_LARK_LISTENER: 'true' });
  });

  it('supports a semantic local-only startup option without requiring a raw host address', () => {
    const program = createCliProgram('0.0.5');
    program.parse(['node', 'dockmux', '--local-only']);
    expect(environmentFromCli(program.opts(), {})).toEqual({ DOCKMUX_LOCAL_ONLY: 'true' });
  });

  it('requires an explicit no-auth option and maps it independently from the listen host', () => {
    const defaults = createCliProgram('0.0.5');
    defaults.parse(['node', 'dockmux', '--host', '0.0.0.0']);
    expect(environmentFromCli(defaults.opts(), {})).toEqual({ DOCKMUX_HOST: '0.0.0.0' });

    const disabled = createCliProgram('0.0.5');
    disabled.parse(['node', 'dockmux', '--host', '0.0.0.0', '--no-auth']);
    expect(environmentFromCli(disabled.opts(), {})).toEqual({ DOCKMUX_HOST: '0.0.0.0', DOCKMUX_AUTH: 'false' });

    const enabled = createCliProgram('0.0.5');
    enabled.parse(['node', 'dockmux', '--auth']);
    expect(environmentFromCli(enabled.opts(), { DOCKMUX_AUTH: 'false' })).toEqual({ DOCKMUX_AUTH: 'true' });
  });

  it('prints the installed version', () => {
    let output = '';
    const program = createCliProgram('0.0.5').exitOverride().configureOutput({ writeOut: value => { output += value; } });
    expect(() => program.parse(['node', 'dockmux', '--version'])).toThrowError(expect.objectContaining({ code: 'commander.version', exitCode: 0 }));
    expect(output).toBe('0.0.5\n');
  });

  it('parses lark send card options', async () => {
    const larkSend = vi.fn();
    const program = createCliProgram('0.0.6', { larkSend });
    await program.parseAsync(['node', 'dockmux', 'lark', 'send', '**done**', '--agent-name', 'My Agent', '--receive-id', 'user@example.com', '--receive-id-type', 'email', '--task-id', 'task-1', '--app-id', 'cli_test', '--read-only']);
    expect(larkSend).toHaveBeenCalledWith('**done**', expect.objectContaining({ agentName: 'My Agent', receiveId: 'user@example.com', receiveIdType: 'email', taskId: 'task-1', appId: 'cli_test', readOnly: true }));
  });

  it('requires a message id for lark update', async () => {
    const larkUpdate = vi.fn();
    const program = createCliProgram('0.0.6', { larkUpdate }).exitOverride();
    await expect(program.parseAsync(['node', 'dockmux', 'lark', 'update', '**done**'])).rejects.toThrow();
    expect(larkUpdate).not.toHaveBeenCalled();
  });

  it('parses a group chat recipient for lark send', async () => {
    const larkSend = vi.fn();
    const program = createCliProgram('0.0.6', { larkSend });
    await program.parseAsync(['node', 'dockmux', 'lark', 'send', 'group update', '--chat-id', 'oc_group']);
    expect(larkSend).toHaveBeenCalledWith('group update', expect.objectContaining({ chatId: 'oc_group' }));
  });

  it('parses Agent group discovery, incremental reads, sends, and waits', async () => {
    const groupPeers = vi.fn(); const groupMembers = vi.fn(); const groupMessages = vi.fn(); const groupSend = vi.fn(); const groupWait = vi.fn();
    await createCliProgram('0.0.6', { groupPeers }).parseAsync(['node', 'dockmux', 'group', 'peers']);
    await createCliProgram('0.0.6', { groupMembers }).parseAsync(['node', 'dockmux', 'group', 'members']);
    await createCliProgram('0.0.6', { groupMessages }).parseAsync(['node', 'dockmux', 'group', 'messages', '--after', 'cursor-1', '--limit', '8']);
    await createCliProgram('0.0.6', { groupSend }).parseAsync(['node', 'dockmux', 'group', 'send', '请检查', '--to', 'cli_peer', '--reply-to', 'om_parent', '--in-thread', '--idempotency-key', 'handoff-1']);
    await createCliProgram('0.0.6', { groupWait }).parseAsync(['node', 'dockmux', 'group', 'wait', '--after', 'cursor-2', '--timeout-ms', '30000']);
    expect(groupPeers).toHaveBeenCalledOnce();
    expect(groupMembers).toHaveBeenCalledOnce();
    expect(groupMessages).toHaveBeenCalledWith(expect.objectContaining({ after: 'cursor-1', limit: '8' }));
    expect(groupSend).toHaveBeenCalledWith('请检查', expect.objectContaining({ to: 'cli_peer', replyTo: 'om_parent', inThread: true, idempotencyKey: 'handoff-1' }));
    expect(groupWait).toHaveBeenCalledWith(expect.objectContaining({ after: 'cursor-2', timeoutMs: '30000' }));
  });

  it('parses the daemon start command with serve options', async () => {
    const daemonStart = vi.fn();
    const program = createCliProgram('0.0.6', { daemonStart });
    await program.parseAsync(['node', 'dockmux', 'daemon', 'start', '--port', '4500', '--local-only', '--cwd', '/tmp/project']);
    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ port: '4500', localOnly: true, cwd: '/tmp/project' }));
    expect(environmentFromCli(daemonStart.mock.calls[0]![0]!, {})).toMatchObject({ DOCKMUX_PORT: '4500', DOCKMUX_DEFAULT_CWD: '/tmp/project' });
  });

  it('passes no-auth to background daemon commands', async () => {
    const daemonStart = vi.fn();
    const program = createCliProgram('0.0.6', { daemonStart });
    await program.parseAsync(['node', 'dockmux', 'daemon', 'start', '--host', '0.0.0.0', '--no-auth']);
    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ host: '0.0.0.0', auth: false }));
    expect(environmentFromCli(daemonStart.mock.calls[0]![0]!, {})).toMatchObject({ DOCKMUX_HOST: '0.0.0.0', DOCKMUX_AUTH: 'false' });
  });

  it('parses daemon stop, restart, and status commands', async () => {
    const daemonStop = vi.fn(); const daemonRestart = vi.fn(); const daemonStatus = vi.fn();
    await createCliProgram('0.0.6', { daemonStop }).parseAsync(['node', 'dockmux', 'daemon', 'stop']);
    await createCliProgram('0.0.6', { daemonRestart }).parseAsync(['node', 'dockmux', 'daemon', 'restart', '--port', '4600']);
    await createCliProgram('0.0.6', { daemonStatus }).parseAsync(['node', 'dockmux', 'daemon', 'status']);
    expect(daemonStop).toHaveBeenCalledOnce();
    expect(daemonRestart).toHaveBeenCalledWith(expect.objectContaining({ port: '4600' }));
    expect(daemonStatus).toHaveBeenCalledOnce();
  });

  it('supports the top-level start/stop/restart/status forms and keeps default serve', async () => {
    const serve = vi.fn(); const daemonStart = vi.fn(); const daemonStop = vi.fn(); const daemonRestart = vi.fn(); const daemonStatus = vi.fn();
    await createCliProgram('0.0.6', { serve }).parseAsync(['node', 'dockmux']);
    await createCliProgram('0.0.6', { daemonStart }).parseAsync(['node', 'dockmux', 'start', '--port', '4500', '--local-only']);
    await createCliProgram('0.0.6', { daemonStop }).parseAsync(['node', 'dockmux', 'stop']);
    await createCliProgram('0.0.6', { daemonRestart }).parseAsync(['node', 'dockmux', 'restart', '--port', '4600']);
    await createCliProgram('0.0.6', { daemonStatus }).parseAsync(['node', 'dockmux', 'status']);
    expect(serve).toHaveBeenCalledOnce();
    expect(daemonStart).toHaveBeenCalledWith(expect.objectContaining({ port: '4500', localOnly: true }));
    expect(daemonStop).toHaveBeenCalledOnce();
    expect(daemonRestart).toHaveBeenCalledWith(expect.objectContaining({ port: '4600' }));
    expect(daemonStatus).toHaveBeenCalledOnce();
  });

  it('parses update with an optional npm dist-tag', async () => {
    const update = vi.fn();
    await createCliProgram('0.0.6', { update }).parseAsync(['node', 'dockmux', 'update', '--dist-tag', 'fix']);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ distTag: 'fix' }));
  });
});
