import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Dockmux 开机自启（boot hook）注册。
 *
 * macOS  —— 写入 `~/Library/LaunchAgents/com.dockmux.server.plist`，由 launchd 在
 *           下次登录时加载并执行 `dockmux start`。
 * Linux  —— 写入 `~/.config/systemd/user/dockmux.service` 并 `systemctl --user
 *           enable`（不带 `--now`），由 user systemd 在下次开机/登录时拉起。
 *
 * 三条硬约束（都来自真实事故，改动前务必读完）：
 *
 * 1. **enable ≠ start，disable ≠ stop。**
 *    `autostartEnable()` 只注册引导钩子：macOS 上绝不执行 `launchctl bootstrap`
 *    （plist 里带 `RunAtLoad`，一 bootstrap 就会立刻拉起 `dockmux start`，用户只是
 *    想登记自启却被顺手启动了服务）；Linux 上 `systemctl --user enable` 绝不带
 *    `--now`。守护进程的生命周期只由 `dockmux start` / `dockmux stop` 掌管，
 *    `autostartDisable()` 同理不会停掉正在跑的守护进程（systemd 不带 `--now`
 *    就不会执行 ExecStop；launchd 的 job 进程在 `dockmux start` 派生出脱离的
 *    daemon 后就已经退出，bootout 没有活进程可杀）。
 *
 * 2. **幂等 + 漂移重写。** nvm 换版本、npm 升级都会让 `execPath` / `cliPath` 变化，
 *    磁盘上的 unit 会静默失效（botmux 曾因此在重启后再也起不来，且没有任何报错）。
 *    所以每次都渲染期望内容并与磁盘比对：一致就 `changed: false` 什么都不写，不一致
 *    才重写；`autostartStatus()` 用 `stale: true` 把这种漂移暴露出来。
 *
 * 3. **状态不许说谎。** unit 文件存在只代表"已登记"，不代表服务在跑。`enabled` 与
 *    `running` 是两个独立字段：`running` 来自 `launchctl print` / `systemctl --user
 *    is-active`，探测不到（比如 launchctl 不可执行、user systemd 没有 DBus）时保持
 *    `undefined` 而不是猜一个 false/true。
 *
 * 所有系统交互都经 {@link AutostartOptions} 注入：`platform` / `homeDir` /
 * `execPath` / `cliPath` / `runCommand` / `root`，因此测试无需真的调用
 * launchctl、systemctl，也不会写到临时目录之外。
 */

export type AutostartPlatform = 'darwin' | 'linux' | 'unsupported';

export interface AutostartState {
  platform: AutostartPlatform;
  supported: boolean;
  enabled: boolean;          // boot hook registered
  running?: boolean;         // service currently loaded/active, if knowable
  unitPath?: string;         // plist or unit file path
  label: string;             // e.g. 'com.dockmux.server' / 'dockmux.service'
  /** Linux only: whether loginctl linger is on for this user. */
  lingerEnabled?: boolean;
  /** True when the on-disk unit no longer matches what we would write now. */
  stale?: boolean;
  details?: string[];
}

export interface AutostartResult {
  action: 'enable' | 'disable' | 'status';
  state: AutostartState;
  changed: boolean;          // did we actually write/remove anything
  notices: string[];         // human guidance, already in 简体中文
}

/** `runCommand` 的返回形状，对齐 `spawnSync` 的 `{status, stdout, stderr}`。 */
export interface AutostartCommandOutput {
  /** 进程退出码；命令本身无法执行（ENOENT/被信号杀死）时为 null。 */
  status: number | null;
  stdout: string;
  stderr: string;
}

export type AutostartRunCommand = (command: string, args: readonly string[]) => Promise<AutostartCommandOutput>;

export interface AutostartOptions {
  /** 默认 `process.platform`；`'darwin'` / `'linux'` 之外都视为 unsupported。 */
  platform?: string;
  /** 默认 `os.homedir()`。unit 路径、日志目录、WorkingDirectory 都由它派生。 */
  homeDir?: string;
  /** 启动 Dockmux 的可执行文件，默认 `process.execPath`（即当前 node）。 */
  execPath?: string;
  /**
   * Dockmux 入口脚本绝对路径，默认 `resolve(process.argv[1])`。
   * cli.ts 应显式传 `fileURLToPath(import.meta.url)`：打包后它就是 `dist/cli.js`，
   * 比 `join(pkgRoot,'dist','cli.js')` 这类拼接更不容易在换安装形态后失效。
   */
  cliPath?: string;
  /** 执行外部命令的钩子，默认走 `spawnSync`。测试注入假实现。 */
  runCommand?: AutostartRunCommand;
  /**
   * 文件系统根前缀（chroot 语义），默认 `'/'`（即不加前缀）。
   * 只作用于由 `homeDir` 派生的路径：`root: tmp, homeDir: '/home/tester'` 会把
   * unit 写到 `<tmp>/home/tester/...`。`homeDir` 本身已在 `root` 里时不重复拼接。
   */
  root?: string;
  /** 引导钩子的工作目录，默认 `homeDir`（`dockmux start` 会据此定位 daemon 目录）。 */
  workingDir?: string;
  /** 自启日志目录，默认 `<homeDir>/.dockmux/logs`。 */
  logDir?: string;
  /** 写进 unit 的 PATH，默认取安装时 shell 的 `process.env.PATH`。 */
  pathEnv?: string;
  /** 当前用户名，用于 `loginctl` 探测与提示，默认 `os.userInfo().username`。 */
  username?: string;
  /** launchd 域 `gui/<uid>` 用的 uid，默认 `process.getuid()`。 */
  uid?: number;
}

export type AutostartErrorCode = 'unsupported-platform' | 'systemd-unavailable' | 'command-failed';

/** enable/disable 的硬失败。`status` 永不抛错。 */
export class AutostartError extends Error {
  readonly code: AutostartErrorCode;
  /** 附加的中文引导，调用方应与 `message` 一起展示。 */
  readonly notices: string[];

  constructor(code: AutostartErrorCode, message: string, notices: string[] = []) {
    super(message);
    this.name = 'AutostartError';
    this.code = code;
    this.notices = notices;
  }
}

export const AUTOSTART_MACOS_LABEL = 'com.dockmux.server';
export const AUTOSTART_LINUX_UNIT = 'dockmux.service';

const DARWIN_FALLBACK_PATH = '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin';
const LINUX_FALLBACK_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

interface ResolvedAutostart {
  platform: AutostartPlatform;
  rawPlatform: string;
  label: string;
  /** unsupported 平台没有 unit 路径。 */
  unitPath?: string;
  execPath: string;
  cliPath: string;
  workingDir: string;
  logDir: string;
  pathEnv: string;
  username: string;
  uid: number;
  run: AutostartRunCommand;
}

const defaultRunCommand: AutostartRunCommand = async (command, args) => {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  return {
    // spawnSync 在命令不存在时 status 为 null —— 保留 null，让调用方能区分
    // "命令执行了但失败" 和 "命令根本跑不起来"（后者说明状态不可知）。
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : '')
  };
};

function resolvePlatform(raw: string): AutostartPlatform {
  if (raw === 'darwin') return 'darwin';
  if (raw === 'linux') return 'linux';
  return 'unsupported';
}

/** chroot 式前缀；`absolutePath` 已在 `root` 内时保持原样（保证可重复调用）。 */
function underRoot(root: string, absolutePath: string): string {
  if (!root || root === '/' || root === '') return absolutePath;
  const normalizedRoot = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  if (absolutePath === normalizedRoot || absolutePath.startsWith(`${normalizedRoot}${sep}`)) return absolutePath;
  return join(normalizedRoot, absolutePath);
}

function currentUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.LOGNAME ?? 'unknown';
  }
}

function currentUid(): number {
  const getuid = process.getuid?.bind(process);
  if (getuid) return getuid();
  try {
    return userInfo().uid;
  } catch {
    return 0;
  }
}

function resolveOptions(options: AutostartOptions = {}): ResolvedAutostart {
  const rawPlatform = options.platform ?? process.platform;
  const platform = resolvePlatform(rawPlatform);
  const root = options.root ?? '/';
  const homeDir = underRoot(root, options.homeDir ?? homedir());
  const entry = process.argv[1];
  const label = platform === 'linux' ? AUTOSTART_LINUX_UNIT : platform === 'darwin' ? AUTOSTART_MACOS_LABEL : 'dockmux';
  const unitPath = platform === 'darwin'
    ? join(homeDir, 'Library', 'LaunchAgents', `${AUTOSTART_MACOS_LABEL}.plist`)
    : platform === 'linux'
      ? join(homeDir, '.config', 'systemd', 'user', AUTOSTART_LINUX_UNIT)
      : undefined;
  return {
    platform,
    rawPlatform,
    label,
    unitPath,
    execPath: options.execPath ?? process.execPath,
    cliPath: options.cliPath ?? (entry ? resolve(entry) : 'dockmux'),
    workingDir: options.workingDir ?? homeDir,
    logDir: options.logDir ?? join(homeDir, '.dockmux', 'logs'),
    pathEnv: options.pathEnv ?? process.env.PATH ?? (platform === 'darwin' ? DARWIN_FALLBACK_PATH : LINUX_FALLBACK_PATH),
    username: options.username ?? currentUsername(),
    uid: options.uid ?? currentUid(),
    run: options.runCommand ?? defaultRunCommand
  };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** systemd 支持 shell 风格引号；只在含空白/引号时才加，避免无谓地改变已有 unit 内容。 */
function systemdQuote(value: string): string {
  if (!/[\s"'\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function renderPlist(config: ResolvedAutostart): string {
  // RunAtLoad=true 是"下次登录自动启动"的唯一开关：launchd 只在登录时加载
  // ~/Library/LaunchAgents/*.plist，没有 RunAtLoad（也没有别的触发条件）的 agent
  // 永远不会被执行，自启就形同虚设。真正会"立刻启动"的是 `launchctl bootstrap`，
  // 所以 enable 路径绝不调用它 —— 见文件头约束 1。KeepAlive=false：`dockmux start`
  // 派生出脱离的 daemon 后自身即退出，KeepAlive 会被 launchd 理解为崩溃而反复重启。
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(AUTOSTART_MACOS_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(config.execPath)}</string>
        <string>${escapeXml(config.cliPath)}</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>WorkingDirectory</key>
    <string>${escapeXml(config.workingDir)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${escapeXml(config.pathEnv)}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(join(config.logDir, 'autostart-out.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(config.logDir, 'autostart-err.log'))}</string>
</dict>
</plist>
`;
}

function renderUnit(config: ResolvedAutostart): string {
  // Type=oneshot + RemainAfterExit=yes：`dockmux start` 会把服务交给脱离的
  // daemon 子进程后立即返回，若不 RemainAfterExit，systemd 会在 ExecStart 退出的
  // 瞬间把 unit 判为 inactive(dead) 并回收整个 cgroup，刚起来的 daemon 会被一起杀掉。
  const start = `${systemdQuote(config.execPath)} ${systemdQuote(config.cliPath)}`;
  return `[Unit]
Description=Dockmux 本地会话服务器
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${config.workingDir}
Environment=PATH=${config.pathEnv}
ExecStart=${start} start
ExecStop=${start} stop

[Install]
WantedBy=default.target
`;
}

function renderDesired(config: ResolvedAutostart): string {
  if (config.platform === 'darwin') return renderPlist(config);
  if (config.platform === 'linux') return renderUnit(config);
  throw unsupported(config);
}

function unsupported(config: ResolvedAutostart): AutostartError {
  return new AutostartError(
    'unsupported-platform',
    `当前平台 ${config.rawPlatform} 不支持 dockmux 开机自启：仅支持 macOS（launchd）与 Linux（user systemd）。`,
    [`可以在开机脚本里手动调用：${config.execPath} ${config.cliPath} start`]
  );
}

/** 期望写入磁盘的 plist / unit 文本（unsupported 平台抛错）。 */
export function autostartUnitContent(options: AutostartOptions = {}): string {
  return renderDesired(resolveOptions(options));
}

/** plist / unit 的目标路径（unsupported 平台返回 undefined）。 */
export function autostartUnitPath(options: AutostartOptions = {}): string | undefined {
  return resolveOptions(options).unitPath;
}

// ─── 平台探测 ────────────────────────────────────────────────────────────────

/** `undefined` 表示"探测不出来"，绝不冒充 false —— 见文件头约束 3。 */
async function launchdLoaded(config: ResolvedAutostart): Promise<boolean | undefined> {
  const printed = await config.run('launchctl', ['print', `gui/${config.uid}/${config.label}`]);
  if (printed.status === null) return undefined;
  return printed.status === 0;
}

async function userSystemdAvailable(config: ResolvedAutostart): Promise<boolean> {
  // 容器 / 无 DBus 的 sshd 会话里 `systemctl --user` 会直接 "Failed to connect to bus"。
  const shown = await config.run('systemctl', ['--user', 'show-environment']);
  return shown.status === 0;
}

async function lingerOn(config: ResolvedAutostart): Promise<boolean | undefined> {
  const shown = await config.run('loginctl', ['show-user', config.username, '--property=Linger']);
  if (shown.status === null) return undefined;
  if (shown.status !== 0) return false;
  return shown.stdout.trim().endsWith('=yes');
}

function firstLine(value: string): string {
  const line = value.trim().split('\n')[0];
  return line ? line.trim() : '';
}

// ─── status ──────────────────────────────────────────────────────────────────

async function inspectDarwin(config: ResolvedAutostart): Promise<AutostartState> {
  const unitPath = config.unitPath!;
  const onDisk = readTextFile(unitPath);
  const desired = renderPlist(config);
  const loaded = await launchdLoaded(config);
  const details = [
    '平台: macOS (launchd)',
    `plist 路径: ${unitPath}`,
    `plist 存在: ${onDisk === undefined ? '否' : '是'}`,
    `launchd 已加载: ${loaded === undefined ? '未知（launchctl 无法执行）' : loaded ? '是' : '否'}`
  ];
  if (onDisk !== undefined && onDisk !== desired) {
    details.push('plist 内容与当前 node / dockmux 路径不一致（可能换过 node 版本或升级过 npm 包）');
  }
  return {
    platform: 'darwin',
    supported: true,
    enabled: onDisk !== undefined,
    ...(loaded === undefined ? {} : { running: loaded }),
    unitPath,
    label: config.label,
    ...(onDisk === undefined ? {} : { stale: onDisk !== desired }),
    details
  };
}

async function inspectLinux(config: ResolvedAutostart): Promise<AutostartState> {
  const unitPath = config.unitPath!;
  const onDisk = readTextFile(unitPath);
  const desired = renderUnit(config);
  const details = [
    '平台: Linux (user systemd)',
    `unit 路径: ${unitPath}`,
    `unit 存在: ${onDisk === undefined ? '否' : '是'}`
  ];
  const available = await userSystemdAvailable(config);
  let enabled = onDisk !== undefined;
  let running: boolean | undefined;
  let linger: boolean | undefined;
  if (!available) {
    // 连不上 user manager 时只能看文件；如实说明这个判断的局限，别假装知道 enable 状态。
    details.push('user systemd: 不可用（缺少 DBus / 容器环境）', '已按 unit 文件是否存在推断 enabled，无法确认 systemd 中的真实注册状态');
  } else {
    const isEnabled = await config.run('systemctl', ['--user', 'is-enabled', config.label]);
    const isActive = await config.run('systemctl', ['--user', 'is-active', config.label]);
    enabled = isEnabled.status === 0;
    running = firstLine(isActive.stdout) === 'active';
    details.push(
      `systemctl --user is-enabled: ${firstLine(isEnabled.stdout) || firstLine(isEnabled.stderr) || '未知'}`,
      `systemctl --user is-active: ${firstLine(isActive.stdout) || firstLine(isActive.stderr) || '未知'}`
    );
    if (onDisk !== undefined && !enabled) details.push('unit 文件存在但未 enable：重启后不会自动启动');
    linger = await lingerOn(config);
    details.push(`loginctl linger: ${linger === undefined ? '未知（loginctl 无法执行）' : linger ? '是' : '否（注销后服务会被停止）'}`);
  }
  if (onDisk !== undefined && onDisk !== desired) {
    details.push('unit 内容与当前 node / dockmux 路径不一致（可能换过 node 版本或升级过 npm 包）');
  }
  return {
    platform: 'linux',
    supported: true,
    enabled,
    ...(running === undefined ? {} : { running }),
    unitPath,
    label: config.label,
    ...(linger === undefined ? {} : { lingerEnabled: linger }),
    ...(onDisk === undefined ? {} : { stale: onDisk !== desired }),
    details
  };
}

function unsupportedState(config: ResolvedAutostart): AutostartState {
  return {
    platform: 'unsupported',
    supported: false,
    enabled: false,
    label: config.label,
    details: [`平台: ${config.rawPlatform}（不支持开机自启）`]
  };
}

/** 状态相关的中文引导：只讲"和你以为的不一样"的部分。 */
function statusNotices(state: AutostartState, config: ResolvedAutostart): string[] {
  const notices: string[] = [];
  if (!state.supported) {
    notices.push(`当前平台 ${config.rawPlatform} 不支持 dockmux 开机自启：仅支持 macOS（launchd）与 Linux（user systemd）。`);
    return notices;
  }
  if (!state.enabled) {
    notices.push('开机自启未注册。运行 dockmux autostart enable 注册。');
  } else if (state.running === false) {
    // 关键：文件在 ≠ 服务在跑。绝不能把"已注册"当成"运行中"回显。
    notices.push('开机自启已注册，但守护进程当前未在运行（要到下次登录/开机才会拉起）。要立即启动请运行 dockmux start。');
  } else if (state.running === undefined) {
    notices.push('开机自启已注册，但无法确认守护进程是否在运行。可运行 dockmux status 查看守护进程状态。');
  }
  if (state.stale) {
    notices.push(`磁盘上的 ${state.platform === 'darwin' ? 'plist' : 'unit'} 与当前期望内容不一致（启动路径已变），重新运行 dockmux autostart enable 刷新。`);
  }
  if (state.platform === 'linux' && state.enabled && state.lingerEnabled === false) {
    notices.push(lingerNotice(config));
  }
  return notices;
}

export async function autostartStatus(options: AutostartOptions = {}): Promise<AutostartResult> {
  const config = resolveOptions(options);
  // 约束 4：unsupported 平台的 status 不抛错，如实返回 supported: false。
  const state = config.platform === 'darwin'
    ? await inspectDarwin(config)
    : config.platform === 'linux'
      ? await inspectLinux(config)
      : unsupportedState(config);
  return { action: 'status', state, changed: false, notices: statusNotices(state, config) };
}

// ─── enable ──────────────────────────────────────────────────────────────────

function lingerNotice(config: ResolvedAutostart): string {
  return `未开启 linger：注销当前登录会话后服务会被系统杀掉。要让它跨注销/重启常驻，运行（可能需要 sudo）：loginctl enable-linger ${config.username}`;
}

/** 只在内容有变化时落盘，返回是否真的写了 —— 见文件头约束 2。 */
function writeIfChanged(path: string, desired: string): boolean {
  const onDisk = readTextFile(path);
  if (onDisk === desired) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, desired, 'utf8');
  return true;
}

async function enableDarwin(config: ResolvedAutostart): Promise<AutostartResult> {
  const unitPath = config.unitPath!;
  const loadedBefore = await launchdLoaded(config);
  mkdirSync(config.logDir, { recursive: true });
  const changed = writeIfChanged(unitPath, renderPlist(config));
  const notices = [
    changed ? `已写入 LaunchAgent: ${unitPath}` : `LaunchAgent 已是最新，无需改动: ${unitPath}`,
    '开机自启已注册，将在下次登录时生效。',
    // 约束 1：这里没有 launchctl bootstrap，所以本次调用不会启动任何东西。
    '本次不会启动守护进程；要立即启动请运行 dockmux start。'
  ];
  if (changed && loadedBefore) {
    notices.push(`launchd 里仍是旧配置，重新登录后生效（想立刻刷新可先手动执行 launchctl bootout gui/${config.uid}/${config.label}）。`);
  }
  const state: AutostartState = {
    platform: 'darwin',
    supported: true,
    enabled: true,
    ...(loadedBefore === undefined ? {} : { running: loadedBefore }),
    unitPath,
    label: config.label,
    stale: false,
    details: [
      '平台: macOS (launchd)',
      `plist 路径: ${unitPath}`,
      `launchd 已加载: ${loadedBefore === undefined ? '未知（launchctl 无法执行）' : loadedBefore ? '是' : '否'}`
    ]
  };
  return { action: 'enable', state, changed, notices };
}

function systemdUnavailable(config: ResolvedAutostart): AutostartError {
  return new AutostartError(
    'systemd-unavailable',
    '当前会话连不上 user systemd（缺少 DBus / 容器环境），无法注册开机自启。',
    [
      `回退方案：把下面这条命令写进系统级 cron / rc.local / 你使用的 init：${config.execPath} ${config.cliPath} start`,
      '或在有 systemd --user 的桌面会话里重新运行 dockmux autostart enable。'
    ]
  );
}

async function enableLinux(config: ResolvedAutostart): Promise<AutostartResult> {
  const unitPath = config.unitPath!;
  if (!await userSystemdAvailable(config)) throw systemdUnavailable(config);

  const enabledBefore = (await config.run('systemctl', ['--user', 'is-enabled', config.label])).status === 0;
  const written = writeIfChanged(unitPath, renderUnit(config));
  const notices = [written ? `已写入 systemd unit: ${unitPath}` : `systemd unit 已是最新，无需改动: ${unitPath}`];

  if (written) {
    const reloaded = await config.run('systemctl', ['--user', 'daemon-reload']);
    if (reloaded.status !== 0) {
      notices.push(`systemctl --user daemon-reload 失败（${firstLine(reloaded.stderr) || '未知原因'}），可手动重跑一次。`);
    }
  }

  // 约束 1：enable 绝不带 --now，否则会顺手把守护进程拉起来。
  const registered = await config.run('systemctl', ['--user', 'enable', config.label]);
  if (registered.status !== 0) {
    throw new AutostartError(
      'command-failed',
      `systemctl --user enable ${config.label} 失败：${firstLine(registered.stderr) || firstLine(registered.stdout) || '未知原因'}`,
      [`unit 已写入 ${unitPath}，可手动执行 systemctl --user enable ${config.label} 重试。`]
    );
  }

  const isActive = await config.run('systemctl', ['--user', 'is-active', config.label]);
  const running = firstLine(isActive.stdout) === 'active';
  const linger = await lingerOn(config);

  notices.push(
    '开机自启已注册，将在下次开机/登录时生效。',
    '本次不会启动守护进程；要立即启动请运行 dockmux start。'
  );
  // 约束 2：linger 关着的话，注销就等于杀服务 —— 必须带上真实用户名的提示。
  if (linger === false) notices.push(lingerNotice(config));
  else if (linger === undefined) notices.push('无法确认 loginctl linger 状态；若注销后服务会停止，请检查 loginctl show-user 的输出。');

  const changed = written || !enabledBefore;
  return {
    action: 'enable',
    state: {
      platform: 'linux',
      supported: true,
      enabled: true,
      running,
      unitPath,
      label: config.label,
      ...(linger === undefined ? {} : { lingerEnabled: linger }),
      stale: false,
      details: [
        '平台: Linux (user systemd)',
        `unit 路径: ${unitPath}`,
        `systemctl --user is-active: ${firstLine(isActive.stdout) || firstLine(isActive.stderr) || '未知'}`,
        `loginctl linger: ${linger === undefined ? '未知（loginctl 无法执行）' : linger ? '是' : '否（注销后服务会被停止）'}`
      ]
    },
    changed,
    notices
  };
}

export async function autostartEnable(options: AutostartOptions = {}): Promise<AutostartResult> {
  const config = resolveOptions(options);
  if (config.platform === 'darwin') return enableDarwin(config);
  if (config.platform === 'linux') return enableLinux(config);
  throw unsupported(config);
}

// ─── disable ─────────────────────────────────────────────────────────────────

const DAEMON_UNTOUCHED_NOTICE = '当前正在运行的守护进程不受影响；要停止它请运行 dockmux stop。';

function removeIfPresent(path: string): boolean {
  if (readTextFile(path) === undefined) return false;
  rmSync(path, { force: true });
  return true;
}

async function disableDarwin(config: ResolvedAutostart): Promise<AutostartResult> {
  const unitPath = config.unitPath!;
  const loadedBefore = await launchdLoaded(config);
  const notices: string[] = [];
  let bootedOut = false;

  if (loadedBefore) {
    // bootout 只是把 job 从 launchd 注册表里摘掉。`dockmux start` 起的 daemon 是
    // detached 的，launchd 的 job 进程早已退出，这里没有活进程会被杀 —— 约束 1。
    const bootout = await config.run('launchctl', ['bootout', `gui/${config.uid}/${config.label}`]);
    if (bootout.status === 0) bootedOut = true;
    else {
      const legacy = await config.run('launchctl', ['unload', '-w', unitPath]);
      if (legacy.status === 0) bootedOut = true;
      else notices.push(`launchctl 卸载失败（${firstLine(bootout.stderr) || '未知原因'}），继续删除 plist。`);
    }
  }

  const removed = removeIfPresent(unitPath);
  notices.unshift(removed ? `已删除 LaunchAgent: ${unitPath}` : `开机自启未注册，无需删除: ${unitPath}`);
  notices.push(DAEMON_UNTOUCHED_NOTICE);

  const running = loadedBefore === undefined ? undefined : bootedOut ? false : loadedBefore;
  return {
    action: 'disable',
    state: {
      platform: 'darwin',
      supported: true,
      enabled: false,
      ...(running === undefined ? {} : { running }),
      unitPath,
      label: config.label,
      details: ['平台: macOS (launchd)', `plist 存在: 否`, `launchd 已加载: ${running === undefined ? '未知' : running ? '是' : '否'}`]
    },
    changed: removed || bootedOut,
    notices
  };
}

async function disableLinux(config: ResolvedAutostart): Promise<AutostartResult> {
  const unitPath = config.unitPath!;
  const notices: string[] = [];
  const available = await userSystemdAvailable(config);
  let enabledBefore = false;

  if (available) {
    // `changed` 必须来自 disable 之前的 is-enabled 状态：`systemctl --user disable`
    // 对本来就没启用的 unit 也返回 0，拿它的退出码判断会把空操作误报成"已改动"。
    enabledBefore = (await config.run('systemctl', ['--user', 'is-enabled', config.label])).status === 0;
    // 约束 1：不带 --now，systemd 就不会执行 ExecStop，跑着的守护进程原样保留。
    const disabled = await config.run('systemctl', ['--user', 'disable', config.label]);
    if (disabled.status !== 0 && enabledBefore) {
      notices.push(`systemctl --user disable ${config.label} 失败（${firstLine(disabled.stderr) || '未知原因'}），继续删除 unit 文件。`);
    }
  } else {
    // disable 是清理动作：连不上 user systemd 也要保证 unit 文件被删掉，因此不抛错。
    notices.push('当前会话连不上 user systemd（缺少 DBus / 容器环境），只删除 unit 文件；如仍有残留请在桌面会话里手动 systemctl --user disable。');
  }

  const removed = removeIfPresent(unitPath);
  notices.unshift(removed ? `已删除 systemd unit: ${unitPath}` : `开机自启未注册，无需删除: ${unitPath}`);
  if (removed && available) await config.run('systemctl', ['--user', 'daemon-reload']);
  notices.push(DAEMON_UNTOUCHED_NOTICE);

  let running: boolean | undefined;
  if (available) {
    const isActive = await config.run('systemctl', ['--user', 'is-active', config.label]);
    running = firstLine(isActive.stdout) === 'active';
    if (running) notices.push('注意：服务当前仍是 active（开机自启已取消，但进程还在跑）。');
  }

  return {
    action: 'disable',
    state: {
      platform: 'linux',
      supported: true,
      enabled: false,
      ...(running === undefined ? {} : { running }),
      unitPath,
      label: config.label,
      details: ['平台: Linux (user systemd)', `unit 存在: ${removed ? '否（已删除）' : '否'}`, `user systemd: ${available ? '可用' : '不可用'}`]
    },
    changed: removed || enabledBefore,
    notices
  };
}

export async function autostartDisable(options: AutostartOptions = {}): Promise<AutostartResult> {
  const config = resolveOptions(options);
  if (config.platform === 'darwin') return disableDarwin(config);
  if (config.platform === 'linux') return disableLinux(config);
  throw unsupported(config);
}
