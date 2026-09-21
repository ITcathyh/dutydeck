import { describe, expect, it, vi } from 'vitest';
import { createCliProgram, environmentFromCli } from './cli-program.js';

describe('Dutydeck CLI', () => {
  it('maps explicit Commander options to runtime environment variables', () => {
    const program = createCliProgram('0.0.5');
    program.parse(['node', 'dutydeck', '--host', '127.0.0.1', '--port', '4400', '--cwd', '/tmp/project', '--database', '/tmp/dock.db', '--idle-timeout-ms', '1000', '--cleanup-interval-ms', '500', '--lark-app-id', 'cli_test', '--lark-agent-name', 'My Agent']);
    expect(environmentFromCli(program.opts(), { DUTYDECK_PORT: '4310', KEEP_ME: 'yes' })).toMatchObject({
      DUTYDECK_HOST: '127.0.0.1',
      DUTYDECK_PORT: '4400',
      DUTYDECK_DEFAULT_CWD: '/tmp/project',
      DUTYDECK_DATABASE_URL: '/tmp/dock.db',
      DUTYDECK_DRIVER_IDLE_TIMEOUT_MS: '1000',
      DUTYDECK_CLEANUP_INTERVAL_MS: '500',
      LARK_APP_ID: 'cli_test',
      LARK_AGENT_NAME: 'My Agent',
      KEEP_ME: 'yes'
    });
  });

  it('does not overwrite environment values for omitted options', () => {
    const program = createCliProgram('0.0.5');
    program.parse(['node', 'dutydeck']);
    expect(environmentFromCli(program.opts(), { DUTYDECK_HOST: '10.0.0.1' })).toEqual({ DUTYDECK_HOST: '10.0.0.1' });
  });

  it('disables Lark listening for only the current process', () => {
    const program = createCliProgram('0.0.5');
    program.parse(['node', 'dutydeck', '--no-lark-listen']);
    expect(environmentFromCli(program.opts(), {})).toEqual({ DUTYDECK_DISABLE_LARK_LISTENER: 'true' });
  });

  it('supports a semantic local-only startup option without requiring a raw host address', () => {
    const program = createCliProgram('0.0.5');
    program.parse(['node', 'dutydeck', '--local-only']);
    expect(environmentFromCli(program.opts(), {})).toEqual({ DUTYDECK_LOCAL_ONLY: 'true' });
  });

  it('requires an explicit no-auth option and maps it independently from the listen host', () => {
    const defaults = createCliProgram('0.0.5');
    defaults.parse(['node', 'dutydeck', '--host', '0.0.0.0']);
    expect(environmentFromCli(defaults.opts(), {})).toEqual({ DUTYDECK_HOST: '0.0.0.0' });

    const disabled = createCliProgram('0.0.5');
    disabled.parse(['node', 'dutydeck', '--host', '0.0.0.0', '--no-auth']);
    expect(environmentFromCli(disabled.opts(), {})).toEqual({ DUTYDECK_HOST: '0.0.0.0', DUTYDECK_AUTH: 'false' });

    const enabled = createCliProgram('0.0.5');
    enabled.parse(['node', 'dutydeck', '--auth']);
    expect(environmentFromCli(enabled.opts(), { DUTYDECK_AUTH: 'false' })).toEqual({ DUTYDECK_AUTH: 'true' });
  });

  it('prints the installed version', () => {
    let output = '';
    const program = createCliProgram('0.0.5').exitOverride().configureOutput({ writeOut: value => { output += value; } });
    expect(() => program.parse(['node', 'dutydeck', '--version'])).toThrowError(expect.objectContaining({ code: 'commander.version', exitCode: 0 }));
    expect(output).toBe('0.0.5\n');
  });

  it('parses setup field flags so scripted callers never pipe answers at prompts', async () => {
    const setup = vi.fn();
    await createCliProgram('0.0.6', { setup }).parseAsync(['node', 'dutydeck', 'setup',
      '--cwd', '/tmp/project', '--port', '4400', '--local-only', '--lark-app-id', 'cli_wizard', '--force-login', '--yes']);
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/project', port: '4400', localOnly: true, larkAppId: 'cli_wizard', forceLogin: true, yes: true
    }));
  });

  it('parses setup --json and --skip-lark independently of the interactive path', async () => {
    const setup = vi.fn();
    await createCliProgram('0.0.6', { setup }).parseAsync(['node', 'dutydeck', 'setup', '--json', '--skip-lark']);
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({ json: true, skipLark: true }));
  });

  it('defaults setup flags to undefined so the wizard can tell "unset" from "explicitly chosen"', async () => {
    const setup = vi.fn();
    await createCliProgram('0.0.6', { setup }).parseAsync(['node', 'dutydeck', 'setup']);
    const options = setup.mock.calls[0]![0]! as Record<string, unknown>;
    expect(options.cwd).toBeUndefined();
    expect(options.port).toBeUndefined();
    expect(options.yes).toBeUndefined();
    expect(options.json).toBeUndefined();
  });

  it('parses doctor with an optional machine-readable flag', async () => {
    const doctor = vi.fn();
    await createCliProgram('0.0.6', { doctor }).parseAsync(['node', 'dutydeck', 'doctor']);
    expect(doctor).toHaveBeenCalledWith(expect.not.objectContaining({ json: true }));
    const asJson = vi.fn();
    await createCliProgram('0.0.6', { doctor: asJson }).parseAsync(['node', 'dutydeck', 'doctor', '--json']);
    expect(asJson).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
  });

  it('parses the three autostart subcommands', async () => {
    const autostartEnable = vi.fn(); const autostartDisable = vi.fn(); const autostartStatus = vi.fn();
    await createCliProgram('0.0.6', { autostartEnable }).parseAsync(['node', 'dutydeck', 'autostart', 'enable']);
    await createCliProgram('0.0.6', { autostartDisable }).parseAsync(['node', 'dutydeck', 'autostart', 'disable']);
    await createCliProgram('0.0.6', { autostartStatus }).parseAsync(['node', 'dutydeck', 'autostart', 'status', '--json']);
    expect(autostartEnable).toHaveBeenCalledOnce();
    expect(autostartDisable).toHaveBeenCalledOnce();
    expect(autostartStatus).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
  });

  it('rejects an unknown autostart subcommand instead of silently doing nothing', async () => {
    const autostartEnable = vi.fn();
    const program = createCliProgram('0.0.6', { autostartEnable }).exitOverride().configureOutput({ writeErr: () => {} });
    await expect(program.parseAsync(['node', 'dutydeck', 'autostart', 'toggle'])).rejects.toThrow();
    expect(autostartEnable).not.toHaveBeenCalled();
  });

  it('documents setup, doctor and autostart in the root help so a new user finds them first', () => {
    let output = '';
    const program = createCliProgram('0.0.6').exitOverride().configureOutput({ writeOut: value => { output += value; } });
    expect(() => program.parse(['node', 'dutydeck', '--help'])).toThrow();
    expect(output).toContain('setup');
    expect(output).toContain('doctor');
    expect(output).toContain('autostart');
    expect(output).toContain('$ dutydeck setup');
  });

  it('keeps setup help honest about non-interactive behaviour', () => {
    // 用 outputHelp 而非 helpInformation：后者不含 addHelpText('after') 的内容，
    // 而行为契约恰好写在那里。
    const program = createCliProgram('0.0.6');
    const setup = program.commands.find(command => command.name() === 'setup')!;
    let help = '';
    setup.configureOutput({ writeOut: value => { help += value; } });
    setup.outputHelp();
    // --json 是行为契约（不提问、不渲染二维码），帮助里必须写明，否则脚本调用方会踩坑。
    expect(help).toContain('--json');
    expect(help).toContain('绝不');
    expect(help).toContain('--yes');
    expect(help).toContain('--skip-lark');
    expect(help).toContain('幂等');
  });

  it('tells the user that autostart enable does not start the server now', () => {
    const program = createCliProgram('0.0.6');
    const autostart = program.commands.find(command => command.name() === 'autostart')!;
    const capture = (name: string) => {
      const command = autostart.commands.find(entry => entry.name() === name)!;
      let help = '';
      command.configureOutput({ writeOut: value => { help += value; } });
      command.outputHelp();
      return help;
    };
    // enable ≠ start、disable ≠ stop 必须写在帮助里，否则用户会以为服务已经起来/已经停了。
    expect(capture('enable')).toContain('dutydeck start');
    expect(capture('disable')).toContain('dutydeck stop');
  });

  it('parses database execution-status and upgrade-execution commands', async () => {
    const databaseExecutionStatus = vi.fn();
    const databaseUpgradeExecution = vi.fn();
    const program = createCliProgram('0.0.6', { databaseExecutionStatus, databaseUpgradeExecution });

    await program.parseAsync(['node', 'dutydeck', 'database', 'execution-status', '--database', '/tmp/target.db']);
    expect(databaseExecutionStatus).toHaveBeenCalledWith(expect.objectContaining({ database: '/tmp/target.db' }));

    await program.parseAsync(['node', 'dutydeck', 'database', 'upgrade-execution', '--database', '/tmp/target.db']);
    expect(databaseUpgradeExecution).toHaveBeenCalledWith(expect.objectContaining({ database: '/tmp/target.db' }));
  });

  it('requires and forwards an explicit legacy deployment scope for retirement', async () => {
    const databaseRetireLegacy = vi.fn();
    const program = createCliProgram('0.0.6', { databaseRetireLegacy });
    await program.parseAsync(['node', 'dutydeck', 'database', 'retire-legacy', '--database', '/tmp/target.db',
      '--hostname', 'host-a', '--uid', '1001', '--tmux-socket', '/tmp/tmux-1001/default', '--acpx-directory', '/tmp/acpx']);
    expect(databaseRetireLegacy).toHaveBeenCalledWith({ database: '/tmp/target.db', hostname: 'host-a', uid: 1001,
      tmuxSocket: '/tmp/tmux-1001/default', acpxDirectory: '/tmp/acpx' });

    const missingScope = createCliProgram('0.0.6', { databaseRetireLegacy });
    await expect(missingScope.parseAsync(['node', 'dutydeck', 'database', 'retire-legacy', '--database', '/tmp/target.db']))
      .rejects.toMatchObject({ code: 'LEGACY_RETIREMENT_HOST_REQUIRED' });
  });

  it('requires --database for database execution-status and upgrade-execution subcommands', async () => {
    const databaseExecutionStatus = vi.fn();
    const databaseUpgradeExecution = vi.fn();
    const program1 = createCliProgram('0.0.6', { databaseExecutionStatus }).exitOverride().configureOutput({ writeErr: () => {} });
    await expect(program1.parseAsync(['node', 'dutydeck', 'database', 'execution-status'])).rejects.toThrow();
    expect(databaseExecutionStatus).not.toHaveBeenCalled();

    const program2 = createCliProgram('0.0.6', { databaseUpgradeExecution }).exitOverride().configureOutput({ writeErr: () => {} });
    await expect(program2.parseAsync(['node', 'dutydeck', 'database', 'upgrade-execution'])).rejects.toThrow();
    expect(databaseUpgradeExecution).not.toHaveBeenCalled();
  });
});
