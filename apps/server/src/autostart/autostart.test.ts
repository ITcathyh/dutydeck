import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AUTOSTART_LINUX_UNIT,
  AUTOSTART_MACOS_LABEL,
  AutostartError,
  autostartDisable,
  autostartEnable,
  autostartStatus,
  autostartUnitContent,
  type AutostartCommandOutput,
  type AutostartOptions
} from './autostart.js';

/** 记录每一次外部命令调用，用于断言"enable 没有顺手启动服务"。 */
interface CommandLog {
  calls: string[];
  run: (command: string, args: readonly string[]) => Promise<AutostartCommandOutput>;
}

type Responder = (command: string, args: readonly string[]) => Partial<AutostartCommandOutput> | undefined;

function commandLog(responder: Responder = () => undefined): CommandLog {
  const calls: string[] = [];
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, ...args].join(' '));
      const reply = responder(command, args) ?? {};
      // 注意用 in 判断而不是 `??`：status 显式为 null 表示"命令根本跑不起来"，
      // `reply.status ?? 0` 会把这个信号偷偷变成成功。
      return { status: 'status' in reply ? reply.status ?? null : 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
    }
  };
}

/** 断言 promise 以 AutostartError 拒绝，并把它取出来供后续断言。 */
async function rejection(promise: Promise<unknown>): Promise<AutostartError> {
  try {
    await promise;
  } catch (caught) {
    expect(caught).toBeInstanceOf(AutostartError);
    return caught as AutostartError;
  }
  throw new Error('期望调用抛出 AutostartError，但它成功返回了');
}

/** launchd：plist 未加载（`launchctl print` 非零），其他命令成功。 */
const macNotLoaded: Responder = (command, args) => (command === 'launchctl' && args[0] === 'print' ? { status: 1, stderr: 'Could not find service' } : undefined);
/** launchd：plist 已加载。 */
const macLoaded: Responder = (command, args) => (command === 'launchctl' && args[0] === 'print' ? { status: 0, stdout: 'service = {...}' } : undefined);

interface LinuxWorld {
  systemdAvailable?: boolean;
  isEnabled?: boolean;
  isActive?: boolean;
  linger?: boolean;
}

function linuxResponder(world: LinuxWorld = {}): Responder {
  const { systemdAvailable = true, isEnabled = false, isActive = false, linger = true } = world;
  return (command, args) => {
    if (command === 'systemctl' && args[1] === 'show-environment') return systemdAvailable ? { status: 0 } : { status: 1, stderr: 'Failed to connect to bus' };
    if (command === 'systemctl' && args[1] === 'is-enabled') return isEnabled ? { status: 0, stdout: 'enabled\n' } : { status: 1, stdout: 'disabled\n' };
    if (command === 'systemctl' && args[1] === 'is-active') return isActive ? { status: 0, stdout: 'active\n' } : { status: 3, stdout: 'inactive\n' };
    if (command === 'loginctl') return { status: 0, stdout: `Linger=${linger ? 'yes' : 'no'}\n` };
    return undefined;
  };
}

describe('Dutydeck 开机自启', () => {
  let tmp: string;

  const HOME = '/home/tester';

  function options(platform: string, log: CommandLog, overrides: AutostartOptions = {}): AutostartOptions {
    return {
      platform,
      root: tmp,
      homeDir: HOME,
      execPath: '/usr/local/node/v22.12.0/bin/node',
      cliPath: '/usr/local/lib/node_modules/dutydeck/dist/cli.js',
      runCommand: log.run,
      username: 'tester',
      uid: 501,
      pathEnv: '/usr/local/bin:/usr/bin:/bin',
      ...overrides
    };
  }

  const macPlist = () => join(tmp, HOME, 'Library', 'LaunchAgents', `${AUTOSTART_MACOS_LABEL}.plist`);
  const linuxUnit = () => join(tmp, HOME, '.config', 'systemd', 'user', AUTOSTART_LINUX_UNIT);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dutydeck-autostart-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // ─── 改名遗留 ──────────────────────────────────────────────────────────────

  it('Linux: 提示还留着改名前的 dockmux.service', async () => {
    const legacy = join(tmp, HOME, '.config', 'systemd', 'user', 'dockmux.service');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '[Unit]\n');
    const result = await autostartStatus(options('linux', commandLog(linuxResponder())));
    expect(result.notices.some(notice => notice.includes('dockmux.service'))).toBe(true);
  });

  it('macOS: 提示还留着改名前的 com.dockmux.server.plist', async () => {
    const legacy = join(tmp, HOME, 'Library', 'LaunchAgents', 'com.dockmux.server.plist');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '<plist/>');
    const result = await autostartStatus(options('darwin', commandLog(macNotLoaded)));
    expect(result.notices.some(notice => notice.includes('com.dockmux.server.plist'))).toBe(true);
  });

  it('没有遗留引导项时不产生这条提示', async () => {
    const result = await autostartStatus(options('linux', commandLog(linuxResponder())));
    expect(result.notices.some(notice => notice.includes('dockmux'))).toBe(false);
  });

  // ─── macOS ────────────────────────────────────────────────────────────────

  it('macOS: enable 写入 LaunchAgent，路径落在注入的 root 下', async () => {
    const log = commandLog(macNotLoaded);
    const result = await autostartEnable(options('darwin', log));

    expect(result).toMatchObject({ action: 'enable', changed: true });
    expect(result.state).toMatchObject({ platform: 'darwin', supported: true, enabled: true, running: false, label: AUTOSTART_MACOS_LABEL, stale: false });
    expect(result.state.unitPath).toBe(macPlist());

    const plist = readFileSync(macPlist(), 'utf8');
    expect(plist).toContain(`<string>${AUTOSTART_MACOS_LABEL}</string>`);
    expect(plist).toContain('<string>/usr/local/node/v22.12.0/bin/node</string>');
    expect(plist).toContain('<string>/usr/local/lib/node_modules/dutydeck/dist/cli.js</string>');
    expect(plist).toContain('<string>start</string>');
    expect(plist).toContain('<key>KeepAlive</key>\n    <false/>');
    expect(plist).toContain('<string>/usr/local/bin:/usr/bin:/bin</string>');
    // 日志目录必须提前建好，否则 launchd 会因为 StandardOutPath 不可写而起不来
    expect(existsSync(join(tmp, HOME, '.dutydeck', 'logs'))).toBe(true);
  });

  it('macOS: enable 只注册引导钩子，绝不 bootstrap / start 服务', async () => {
    const log = commandLog(macNotLoaded);
    const result = await autostartEnable(options('darwin', log));

    // 关键保证：一次 launchctl bootstrap / load / start / kickstart 都不许出现
    expect(log.calls.filter(call => /bootstrap|load|kickstart|\bstart\b/.test(call))).toEqual([]);
    expect(log.calls).toEqual([`launchctl print gui/501/${AUTOSTART_MACOS_LABEL}`]);
    expect(result.notices.some(notice => notice.includes('下次登录'))).toBe(true);
    expect(result.notices.some(notice => notice.includes('dutydeck start'))).toBe(true);
  });

  it('macOS: 重复 enable 内容一致时 changed 为 false 且不重写文件', async () => {
    const first = await autostartEnable(options('darwin', commandLog(macNotLoaded)));
    expect(first.changed).toBe(true);
    const written = readFileSync(macPlist(), 'utf8');

    const second = await autostartEnable(options('darwin', commandLog(macNotLoaded)));
    expect(second.changed).toBe(false);
    expect(second.notices[0]).toContain('已是最新');
    expect(readFileSync(macPlist(), 'utf8')).toBe(written);
  });

  it('macOS: node 路径漂移时重新渲染 plist', async () => {
    await autostartEnable(options('darwin', commandLog(macNotLoaded)));
    const stale = await autostartStatus(options('darwin', commandLog(macNotLoaded), { execPath: '/home/tester/.nvm/versions/node/v22.14.0/bin/node' }));
    expect(stale.state.stale).toBe(true);
    expect(stale.notices.some(notice => notice.includes('启动路径已变'))).toBe(true);

    const refreshed = await autostartEnable(options('darwin', commandLog(macNotLoaded), { execPath: '/home/tester/.nvm/versions/node/v22.14.0/bin/node' }));
    expect(refreshed.changed).toBe(true);
    expect(refreshed.state.stale).toBe(false);
    expect(readFileSync(macPlist(), 'utf8')).toContain('<string>/home/tester/.nvm/versions/node/v22.14.0/bin/node</string>');
  });

  it('macOS: 已注册但未加载时 status 区分 enabled 与 running', async () => {
    await autostartEnable(options('darwin', commandLog(macNotLoaded)));
    const result = await autostartStatus(options('darwin', commandLog(macNotLoaded)));

    expect(result.state).toMatchObject({ enabled: true, running: false, stale: false });
    expect(result.notices.some(notice => notice.includes('未在运行'))).toBe(true);
    expect(result.state.details?.some(detail => detail.includes('launchd 已加载: 否'))).toBe(true);
  });

  it('macOS: 已加载时 status 报告 running 为 true', async () => {
    await autostartEnable(options('darwin', commandLog(macLoaded)));
    const result = await autostartStatus(options('darwin', commandLog(macLoaded)));
    expect(result.state).toMatchObject({ enabled: true, running: true });
    expect(result.notices.some(notice => notice.includes('未在运行'))).toBe(false);
  });

  it('macOS: launchctl 无法执行时 running 保持 undefined 而不是伪造 false', async () => {
    const log = commandLog(() => ({ status: null, stderr: 'spawn launchctl ENOENT' }));
    const result = await autostartStatus(options('darwin', log));
    expect(result.state.running).toBeUndefined();
    expect(result.state.enabled).toBe(false);
  });

  it('macOS: 未注册时 status 提示先 enable', async () => {
    const result = await autostartStatus(options('darwin', commandLog(macNotLoaded)));
    expect(result).toMatchObject({ action: 'status', changed: false });
    expect(result.state).toMatchObject({ platform: 'darwin', supported: true, enabled: false, running: false });
    expect(result.state.stale).toBeUndefined();
    expect(result.notices.some(notice => notice.includes('autostart enable'))).toBe(true);
  });

  it('macOS: disable 删除 plist、bootout 已加载的 job，且不动运行中的守护进程', async () => {
    await autostartEnable(options('darwin', commandLog(macLoaded)));
    const log = commandLog(macLoaded);
    const result = await autostartDisable(options('darwin', log));

    expect(result).toMatchObject({ action: 'disable', changed: true });
    expect(result.state).toMatchObject({ enabled: false, running: false });
    expect(existsSync(macPlist())).toBe(false);
    expect(log.calls).toContain(`launchctl bootout gui/501/${AUTOSTART_MACOS_LABEL}`);
    // 绝不允许出现停服务的调用
    expect(log.calls.some(call => /\bstop\b|\bkill\b/.test(call))).toBe(false);
    expect(result.notices.some(notice => notice.includes('不受影响'))).toBe(true);
    expect(result.notices.some(notice => notice.includes('dutydeck stop'))).toBe(true);
  });

  it('macOS: 未注册时 disable 是无副作用的 changed=false', async () => {
    const log = commandLog(macNotLoaded);
    const result = await autostartDisable(options('darwin', log));
    expect(result.changed).toBe(false);
    expect(result.notices[0]).toContain('无需删除');
    expect(log.calls.some(call => call.includes('bootout'))).toBe(false);
  });

  // ─── Linux ────────────────────────────────────────────────────────────────

  it('Linux: enable 写入 user unit 并 enable（不带 --now）', async () => {
    const log = commandLog(linuxResponder());
    const result = await autostartEnable(options('linux', log));

    expect(result).toMatchObject({ action: 'enable', changed: true });
    expect(result.state).toMatchObject({ platform: 'linux', supported: true, enabled: true, running: false, label: AUTOSTART_LINUX_UNIT, lingerEnabled: true, stale: false });
    expect(result.state.unitPath).toBe(linuxUnit());

    const unit = readFileSync(linuxUnit(), 'utf8');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('ExecStart=/usr/local/node/v22.12.0/bin/node /usr/local/lib/node_modules/dutydeck/dist/cli.js start');
    expect(unit).toContain('ExecStop=/usr/local/node/v22.12.0/bin/node /usr/local/lib/node_modules/dutydeck/dist/cli.js stop');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('Environment=PATH=/usr/local/bin:/usr/bin:/bin');
  });

  it('Linux: enable 只注册不启动 —— 没有 --now、没有 systemctl start', async () => {
    const log = commandLog(linuxResponder());
    const result = await autostartEnable(options('linux', log));

    expect(log.calls).toContain(`systemctl --user enable ${AUTOSTART_LINUX_UNIT}`);
    expect(log.calls.some(call => call.includes('--now'))).toBe(false);
    expect(log.calls.some(call => /systemctl --user (start|restart|kickstart)/.test(call))).toBe(false);
    expect(log.calls).toContain('systemctl --user daemon-reload');
    expect(result.notices.some(notice => notice.includes('下次开机'))).toBe(true);
    expect(result.notices.some(notice => notice.includes('dutydeck start'))).toBe(true);
  });

  it('Linux: linger 未开启时给出带真实用户名的警告', async () => {
    const result = await autostartEnable(options('linux', commandLog(linuxResponder({ linger: false })), { username: 'huangyuhang' }));
    const warning = result.notices.find(notice => notice.includes('linger'));
    expect(result.state.lingerEnabled).toBe(false);
    expect(warning).toBeDefined();
    expect(warning).toContain('loginctl enable-linger huangyuhang');
    expect(warning).toContain('注销');
  });

  it('Linux: linger 已开启时不出现警告', async () => {
    const result = await autostartEnable(options('linux', commandLog(linuxResponder({ linger: true }))));
    expect(result.state.lingerEnabled).toBe(true);
    expect(result.notices.some(notice => notice.includes('enable-linger'))).toBe(false);
  });

  it('Linux: 重复 enable 内容一致且已注册时 changed 为 false', async () => {
    const first = await autostartEnable(options('linux', commandLog(linuxResponder())));
    expect(first.changed).toBe(true);
    const written = readFileSync(linuxUnit(), 'utf8');

    const log = commandLog(linuxResponder({ isEnabled: true }));
    const second = await autostartEnable(options('linux', log));
    expect(second.changed).toBe(false);
    expect(second.notices[0]).toContain('已是最新');
    expect(readFileSync(linuxUnit(), 'utf8')).toBe(written);
    // 内容没变就不该 daemon-reload
    expect(log.calls.some(call => call.includes('daemon-reload'))).toBe(false);
  });

  it('Linux: 内容一致但 systemd 里未 enable 时仍算作变更', async () => {
    await autostartEnable(options('linux', commandLog(linuxResponder())));
    const again = await autostartEnable(options('linux', commandLog(linuxResponder({ isEnabled: false }))));
    expect(again.changed).toBe(true);
  });

  it('Linux: cli 路径漂移时重写 unit 并 daemon-reload', async () => {
    await autostartEnable(options('linux', commandLog(linuxResponder())));
    const drifted: AutostartOptions = { cliPath: '/usr/local/lib/node_modules/dutydeck/dist/cli.js', execPath: '/opt/node24/bin/node' };

    const status = await autostartStatus(options('linux', commandLog(linuxResponder({ isEnabled: true })), drifted));
    expect(status.state.stale).toBe(true);
    expect(status.notices.some(notice => notice.includes('启动路径已变'))).toBe(true);

    const log = commandLog(linuxResponder({ isEnabled: true }));
    const refreshed = await autostartEnable(options('linux', log, drifted));
    expect(refreshed.changed).toBe(true);
    expect(refreshed.state.stale).toBe(false);
    expect(log.calls).toContain('systemctl --user daemon-reload');
    expect(readFileSync(linuxUnit(), 'utf8')).toContain('ExecStart=/opt/node24/bin/node ');
  });

  it('Linux: unit 存在但 systemd 未 enable 时 status 不谎报 enabled', async () => {
    mkdirSync(join(tmp, HOME, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(linuxUnit(), autostartUnitContent(options('linux', commandLog(linuxResponder()))), 'utf8');

    const result = await autostartStatus(options('linux', commandLog(linuxResponder({ isEnabled: false }))));
    expect(result.state).toMatchObject({ enabled: false, running: false, stale: false });
    expect(result.state.details?.some(detail => detail.includes('未 enable'))).toBe(true);
  });

  it('Linux: 已 enable 但服务未 active 时把两者分开报告', async () => {
    await autostartEnable(options('linux', commandLog(linuxResponder())));
    const result = await autostartStatus(options('linux', commandLog(linuxResponder({ isEnabled: true, isActive: false }))));
    expect(result.state).toMatchObject({ enabled: true, running: false });
    expect(result.notices.some(notice => notice.includes('未在运行'))).toBe(true);
  });

  it('Linux: 服务 active 时 running 为 true 且不提示未运行', async () => {
    await autostartEnable(options('linux', commandLog(linuxResponder())));
    const result = await autostartStatus(options('linux', commandLog(linuxResponder({ isEnabled: true, isActive: true }))));
    expect(result.state).toMatchObject({ enabled: true, running: true });
    expect(result.notices.some(notice => notice.includes('未在运行'))).toBe(false);
  });

  it('Linux: user systemd 不可用时 enable 抛出中文错误并给出回退方案', async () => {
    const log = commandLog(linuxResponder({ systemdAvailable: false }));
    const error = await rejection(autostartEnable(options('linux', log)));
    expect(error.code).toBe('systemd-unavailable');
    expect(error.message).toContain('user systemd');
    expect(error.notices.join('\n')).toContain('/usr/local/lib/node_modules/dutydeck/dist/cli.js start');
    // 失败时不许留下半成品 unit
    expect(existsSync(linuxUnit())).toBe(false);
  });

  it('Linux: user systemd 不可用时 status 退化为按文件判断且如实说明', async () => {
    const result = await autostartStatus(options('linux', commandLog(linuxResponder({ systemdAvailable: false }))));
    expect(result.state).toMatchObject({ supported: true, enabled: false });
    expect(result.state.running).toBeUndefined();
    expect(result.state.lingerEnabled).toBeUndefined();
    expect(result.state.details?.some(detail => detail.includes('不可用'))).toBe(true);
  });

  it('Linux: systemctl enable 失败时抛 command-failed 并保留已写入的 unit', async () => {
    const log = commandLog((command, args) => {
      if (command === 'systemctl' && args[1] === 'enable') return { status: 1, stderr: 'Failed to enable unit: Permission denied\n' };
      return linuxResponder()(command, args);
    });
    const error = await rejection(autostartEnable(options('linux', log)));
    expect(error.code).toBe('command-failed');
    expect(error.message).toContain('Permission denied');
    expect(existsSync(linuxUnit())).toBe(true);
  });

  it('Linux: disable 取消注册且不带 --now，运行中的守护进程不受影响', async () => {
    await autostartEnable(options('linux', commandLog(linuxResponder())));
    const log = commandLog(linuxResponder({ isEnabled: true, isActive: true }));
    const result = await autostartDisable(options('linux', log));

    expect(result).toMatchObject({ action: 'disable', changed: true });
    expect(result.state).toMatchObject({ enabled: false, running: true });
    expect(existsSync(linuxUnit())).toBe(false);
    expect(log.calls).toContain(`systemctl --user disable ${AUTOSTART_LINUX_UNIT}`);
    expect(log.calls.some(call => call.includes('--now'))).toBe(false);
    expect(log.calls.some(call => /systemctl --user stop/.test(call))).toBe(false);
    expect(result.notices.some(notice => notice.includes('不受影响'))).toBe(true);
    expect(result.notices.some(notice => notice.includes('dutydeck stop'))).toBe(true);
    expect(result.notices.some(notice => notice.includes('仍是 active'))).toBe(true);
  });

  it('Linux: 未注册时 disable 报告 changed=false', async () => {
    const result = await autostartDisable(options('linux', commandLog(linuxResponder({ isEnabled: false }))));
    expect(result.changed).toBe(false);
    expect(result.notices[0]).toContain('无需删除');
  });

  // ─── 不支持的平台 ─────────────────────────────────────────────────────────

  it('不支持的平台：status 不抛错，返回 supported=false 并点名平台', async () => {
    const result = await autostartStatus(options('win32', commandLog()));
    expect(result).toMatchObject({ action: 'status', changed: false });
    expect(result.state).toMatchObject({ platform: 'unsupported', supported: false, enabled: false });
    expect(result.state.unitPath).toBeUndefined();
    expect(result.notices.join('\n')).toContain('win32');
    expect(result.notices.join('\n')).toContain('不支持');
  });

  it('不支持的平台：enable / disable 抛出点名平台的中文错误，不静默跳过', async () => {
    for (const platform of ['win32', 'freebsd']) {
      for (const action of [autostartEnable, autostartDisable]) {
        const log = commandLog();
        const error = await rejection(action(options(platform, log)));
        expect(error.code).toBe('unsupported-platform');
        expect(error.message).toContain(platform);
        expect(error.message).toContain('不支持');
        expect(log.calls).toEqual([]);
      }
    }
  });

  it('不支持的平台：不会在磁盘留下任何文件', async () => {
    await autostartStatus(options('win32', commandLog()));
    await autostartEnable(options('win32', commandLog())).catch(() => undefined);
    expect(existsSync(join(tmp, HOME))).toBe(false);
  });

  // ─── 渲染细节 ─────────────────────────────────────────────────────────────

  it('plist 转义 XML 特殊字符，systemd 为含空格的路径加引号', async () => {
    const nasty = { execPath: '/opt/no de/bin/node', cliPath: '/opt/a&b/<cli>.js' };
    const plist = autostartUnitContent(options('darwin', commandLog(), nasty));
    expect(plist).toContain('<string>/opt/a&amp;b/&lt;cli&gt;.js</string>');
    expect(plist).not.toContain('<string>/opt/a&b/<cli>.js</string>');

    const unit = autostartUnitContent(options('linux', commandLog(), nasty));
    expect(unit).toContain('ExecStart="/opt/no de/bin/node" /opt/a&b/<cli>.js start');
  });

  it('autostartUnitContent 与实际写入磁盘的内容完全一致', async () => {
    await autostartEnable(options('darwin', commandLog(macNotLoaded)));
    expect(readFileSync(macPlist(), 'utf8')).toBe(autostartUnitContent(options('darwin', commandLog())));

    await autostartEnable(options('linux', commandLog(linuxResponder())));
    expect(readFileSync(linuxUnit(), 'utf8')).toBe(autostartUnitContent(options('linux', commandLog())));
  });
});
