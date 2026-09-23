import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { checkSqliteDriver, describeSqliteDriverFailure, type SqliteDriverCheck, type SqliteDriverCheckOptions } from '@dutydeck/storage';
import { SUPERVISOR_ENV, SYSTEMD_UNIT_ENV, daemonPaths, defaultDaemonDir, resolveDaemonDir } from '../daemon/daemon.js';

/**
 * Dutydeck 开机自启（boot hook）注册。
 *
 * macOS  —— 写入 `~/Library/LaunchAgents/com.dutydeck.server.plist`，由 launchd 在
 *           下次登录时加载并执行 `dutydeck start`。
 * Linux  —— 写入 `~/.config/systemd/user/dutydeck.service` 并 `systemctl --user
 *           enable`（不带 `--now`），由 user systemd 在下次开机/登录时拉起。unit 前台
 *           运行 `dutydeck start --foreground`，崩溃或被误杀后由 systemd 重拉。
 *
 * 三条硬约束（都来自真实事故，改动前务必读完）：
 *
 * 1. **enable ≠ start，disable ≠ stop。**
 *    `autostartEnable()` 只注册引导钩子：macOS 上绝不执行 `launchctl bootstrap`
 *    （plist 里带 `RunAtLoad`，一 bootstrap 就会立刻拉起 `dutydeck start`，用户只是
 *    想登记自启却被顺手启动了服务）；Linux 上 `systemctl --user enable` 绝不带
 *    `--now`。守护进程的生命周期只由 `dutydeck start` / `dutydeck stop` 掌管，
 *    `autostartDisable()` 同理不会停掉正在跑的守护进程（systemd 不带 `--now`
 *    就不会停止 unit；launchd 的 job 进程在 `dutydeck start` 派生出脱离的
 *    daemon 后就已经退出，bootout 没有活进程可杀）。Linux 新模板 unit 还在运行时
 *    disable 直接拒绝、什么都不动，由用户先 `dutydeck stop`：删掉 unit 文件后 systemd
 *    会把运行中的 unit 退回 KillMode=control-group，daemon 一退出就连带清掉 cgroup
 *    里的 tmux 和所有 Agent。
 *
 * 2. **幂等 + 漂移重写。** nvm 换版本、npm 升级都会让 `execPath` / `cliPath` 变化，
 *    避免磁盘上的 unit 路径静默失效导致重启后无法拉起且无报错。
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
  label: string;             // e.g. 'com.dutydeck.server' / 'dutydeck.service'
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
  /** 启动 Dutydeck 的可执行文件，默认 `process.execPath`（即当前 node）。 */
  execPath?: string;
  /**
   * Dutydeck 入口脚本绝对路径，默认 `resolve(process.argv[1])`。
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
  /** 引导钩子的工作目录，默认 `homeDir`（`dutydeck start` 会据此定位 daemon 目录）。 */
  workingDir?: string;
  /** 自启日志目录，默认 `<homeDir>/.dutydeck/logs`。 */
  logDir?: string;
  /** 写进 unit 的 PATH，默认取安装时 shell 的 `process.env.PATH`。 */
  pathEnv?: string;
  /** 当前用户名，用于 `loginctl` 探测与提示，默认 `os.userInfo().username`。 */
  username?: string;
  /** launchd 域 `gui/<uid>` 用的 uid，默认 `process.getuid()`。 */
  uid?: number;
  /** Linux enable 写 unit 前的 SQLite 驱动预检，默认 `@dutydeck/storage` 的 checkSqliteDriver。测试注入。 */
  checkSqlite?: (options: SqliteDriverCheckOptions) => SqliteDriverCheck;
}

export type AutostartErrorCode = 'unsupported-platform' | 'systemd-unavailable' | 'command-failed' | 'sqlite-unavailable' | 'unit-customized' | 'unit-active';

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

export const AUTOSTART_MACOS_LABEL = 'com.dutydeck.server';
export const AUTOSTART_LINUX_UNIT = 'dutydeck.service';

// 改名前注册的引导项还在原地，且仍指向旧的 dockmux 程序。新版只认新名字，
// 会报「未注册」并劝你再注册一个——于是下次登录两个引导项各拉起一个进程抢同一个端口，
// 先起来的那个赢，另一个 EADDRINUSE 退出。
const LEGACY_MACOS_LABEL = 'com.dockmux.server';
const LEGACY_LINUX_UNIT = 'dockmux.service';

function legacyUnitPath(config: ResolvedAutostart): string | undefined {
  if (!config.unitPath) return undefined;
  const name = config.platform === 'darwin' ? `${LEGACY_MACOS_LABEL}.plist` : LEGACY_LINUX_UNIT;
  return join(dirname(config.unitPath), name);
}

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
  /** Linux：unit 托管的 daemon 目录，WorkingDirectory 与日志路径都由它派生。 */
  daemonDir?: string;
  checkSqlite: (options: SqliteDriverCheckOptions) => SqliteDriverCheck;
}

export const defaultRunCommand: AutostartRunCommand = async (command, args) => {
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
  const label = platform === 'linux' ? AUTOSTART_LINUX_UNIT : platform === 'darwin' ? AUTOSTART_MACOS_LABEL : 'dutydeck';
  const unitPath = platform === 'darwin'
    ? join(homeDir, 'Library', 'LaunchAgents', `${AUTOSTART_MACOS_LABEL}.plist`)
    : platform === 'linux'
      ? join(homeDir, '.config', 'systemd', 'user', AUTOSTART_LINUX_UNIT)
      : undefined;
  const workingDir = options.workingDir ?? homeDir;
  return {
    platform,
    rawPlatform,
    label,
    unitPath,
    execPath: options.execPath ?? process.execPath,
    cliPath: options.cliPath ?? (entry ? resolve(entry) : 'dutydeck'),
    workingDir,
    logDir: options.logDir ?? join(homeDir, '.dutydeck', 'logs'),
    pathEnv: options.pathEnv ?? process.env.PATH ?? (platform === 'darwin' ? DARWIN_FALLBACK_PATH : LINUX_FALLBACK_PATH),
    username: options.username ?? currentUsername(),
    uid: options.uid ?? currentUid(),
    run: options.runCommand ?? defaultRunCommand,
    // 与 `dutydeck start` 同一套定位规则（优先 last-daemon-dir 指针），unit 因此钉在同一个根目录。
    ...(platform === 'linux' ? { daemonDir: resolveDaemonDir(workingDir, homeDir) } : {}),
    checkSqlite: options.checkSqlite ?? checkSqliteDriver
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
  // 所以 enable 路径绝不调用它 —— 见文件头约束 1。KeepAlive=false：`dutydeck start`
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

/**
 * Linux unit 托管的 daemon 根目录，即 WorkingDirectory。取真实路径：daemon 按 process.cwd()
 * 记录自己的目录，拿到的总是解析过符号链接的路径（本机 /home/<user> 就是指向 /data00 的链接）。
 * unit 里若写链接路径，`dutydeck start` 比对 WorkingDirectory 时对不上，会退回 detached。
 */
function unitRoot(config: ResolvedAutostart): string {
  const root = resolve(config.daemonDir!, '..', '..');
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/** Linux unit 托管的 daemon 日志：前台进程的 stdout / stderr 追加到这里，与 detached 子进程同一个文件。 */
function unitLogFile(config: ResolvedAutostart): string {
  return daemonPaths(defaultDaemonDir(unitRoot(config))).logFile;
}

function renderUnit(config: ResolvedAutostart): string {
  // Type=simple：ExecStart 本身就是服务进程（`start --foreground`），崩溃、被 SIGKILL 或
  // 被外部 SIGTERM 后 systemd 才能按 Restart=always 重拉。旧模板是 oneshot + RemainAfterExit：
  // `start` 派生脱离的子进程就退出，子进程死了 unit 仍是 active (exited)，没有人重拉。
  //
  // WorkingDirectory 钉在 daemon 根目录：前台入口据此写状态文件，cli.ts 启动时按 cwd 读入
  // 根目录的 .env，与 detached 子进程在同一目录下运行的效果一致。
  //
  // 不设 ExecStop：`dutydeck stop` 对受 systemd 托管的 daemon 会反过来调用 systemctl，
  // 留着 ExecStop 就会 stop → systemctl → ExecStop → stop 绕回来。
  //
  // KillMode=process：只信号主进程。tmux server 若由 daemon 首次拉起，会落在本 unit 的
  // cgroup 里；默认的 control-group 会在 restart 和崩溃重拉时把它连同其中所有 Agent 一起杀掉。
  // `dutydeck stop` / `restart` 过去也只信号 daemon 本身，tmux 会话跨重启保留。
  //
  // StartLimit*：连续起不来就熔断，不无限重拉刷日志；熔断后用 systemctl --user reset-failed 解除。
  const start = `${systemdQuote(config.execPath)} ${systemdQuote(config.cliPath)}`;
  const logFile = unitLogFile(config);
  return `[Unit]
Description=Dutydeck 本地会话服务器
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=${unitRoot(config)}
Environment=PATH=${config.pathEnv}
Environment=${SUPERVISOR_ENV}=systemd
Environment=${SYSTEMD_UNIT_ENV}=${config.label}
ExecStart=${start} start --foreground
Restart=always
RestartSec=3
TimeoutStopSec=15
KillMode=process
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target
`;
}

/**
 * 两代 Linux 模板（旧 oneshot 与现在的 simple）实际写过的指令，Environment 只写过这几个变量。
 * enable 重写已有 unit 时，磁盘上出现这之外的指令（比如手工加的 EnvironmentFile）就拒绝，
 * 免得重新生成时把它们静默丢掉。
 */
const TEMPLATE_UNIT_KEYS = new Set([
  'Description', 'After', 'Wants', 'StartLimitIntervalSec', 'StartLimitBurst',
  'Type', 'RemainAfterExit', 'WorkingDirectory', 'Environment', 'ExecStart', 'ExecStop',
  'Restart', 'RestartSec', 'TimeoutStopSec', 'KillMode', 'StandardOutput', 'StandardError',
  'WantedBy'
]);
const TEMPLATE_ENVIRONMENT = new Set(['PATH', SUPERVISOR_ENV, SYSTEMD_UNIT_ENV]);

/** 磁盘上的 unit 里模板不会写的指令。只报键名和变量名，不带值（值里可能有密钥）。 */
function customUnitDirectives(content: string): string[] {
  const found: string[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
    const at = line.indexOf('=');
    const key = (at < 0 ? line : line.slice(0, at)).trim();
    if (!TEMPLATE_UNIT_KEYS.has(key)) {
      found.push(key);
    } else if (key === 'Environment') {
      const names = [...line.slice(at + 1).matchAll(/(?:^|\s)"?([^\s"=]+)=/g)].map(match => match[1]!);
      const extra = names.filter(name => !TEMPLATE_ENVIRONMENT.has(name));
      if (extra.length > 0) found.push(`Environment（${extra.join('、')}）`);
    }
  }
  return [...new Set(found)];
}

function unitCustomized(config: ResolvedAutostart, directives: string[]): AutostartError {
  const unitPath = config.unitPath!;
  return new AutostartError(
    'unit-customized',
    `${unitPath} 里有 dutydeck 模板不会写的配置：${directives.join('、')}。重新生成 unit 会把它们丢掉，已拒绝，没有做任何改动。`,
    [`把这些行原样移到 drop-in（例如 ${join(dirname(unitPath), `${config.label}.d`, 'local.conf')}，行前写上它原来所在的节，如 [Service]），从 ${unitPath} 里删掉后重跑 dutydeck autostart enable。drop-in 不会被 enable 改写，systemctl --user cat ${config.label} 能看到合并后的结果。`]
  );
}

function renderDesired(config: ResolvedAutostart): string {
  if (config.platform === 'darwin') return renderPlist(config);
  if (config.platform === 'linux') return renderUnit(config);
  throw unsupported(config);
}

function unsupported(config: ResolvedAutostart): AutostartError {
  return new AutostartError(
    'unsupported-platform',
    `当前平台 ${config.rawPlatform} 不支持 dutydeck 开机自启：仅支持 macOS（launchd）与 Linux（user systemd）。`,
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
    details.push('plist 内容与当前 node / dutydeck 路径不一致（可能换过 node 版本或升级过 npm 包）');
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
    details.push('unit 内容与当前 node / dutydeck 路径不一致（可能换过 node 版本或升级过 npm 包）');
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
    notices.push(`当前平台 ${config.rawPlatform} 不支持 dutydeck 开机自启：仅支持 macOS（launchd）与 Linux（user systemd）。`);
    return notices;
  }
  if (!state.enabled) {
    notices.push('开机自启未注册。运行 dutydeck autostart enable 注册。');
  } else if (state.running === false) {
    // 关键：文件在 ≠ 服务在跑。绝不能把"已注册"当成"运行中"回显。
    notices.push('开机自启已注册，但守护进程当前未在运行（要到下次登录/开机才会拉起）。要立即启动请运行 dutydeck start。');
  } else if (state.running === undefined) {
    notices.push('开机自启已注册，但无法确认守护进程是否在运行。可运行 dutydeck status 查看守护进程状态。');
  }
  if (state.stale) {
    notices.push(`磁盘上的 ${state.platform === 'darwin' ? 'plist' : 'unit'} 与当前期望内容不一致（启动路径已变），重新运行 dutydeck autostart enable 刷新。`);
  }
  if (state.platform === 'linux' && state.enabled && state.lingerEnabled === false) {
    notices.push(lingerNotice(config));
  }
  const legacy = legacyUnitPath(config);
  if (legacy && existsSync(legacy)) {
    notices.push(`还留着改名前的开机自启项 ${legacy}，它指向旧的 dockmux 程序。请先删掉它再注册新的，否则下次登录会拉起两个进程抢同一个端口。`);
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
    '本次不会启动守护进程；要立即启动请运行 dutydeck start。'
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
      '或在有 systemd --user 的桌面会话里重新运行 dutydeck autostart enable。'
    ]
  );
}

function sqliteUnavailable(config: ResolvedAutostart, check: SqliteDriverCheck): AutostartError {
  return new AutostartError(
    'sqlite-unavailable',
    `开机自启会用 ${config.execPath} 运行 Dutydeck，但预检失败，未写入 unit。${describeSqliteDriverFailure(check)}`,
    [`换一个能加载该驱动的 node，用绝对路径重跑：<node 绝对路径> ${config.cliPath} autostart enable`]
  );
}

async function enableLinux(config: ResolvedAutostart): Promise<AutostartResult> {
  const unitPath = config.unitPath!;
  if (!await userSystemdAvailable(config)) throw systemdUnavailable(config);

  const enabledBefore = (await config.run('systemctl', ['--user', 'is-enabled', config.label])).status === 0;
  // unit 会把 execPath 钉进 ExecStart：写之前用它真的加载一次 SQLite 驱动，别把起不来的解释器固化成配置。
  const sqlite = config.checkSqlite({ execPath: config.execPath, resolveFrom: config.cliPath });
  if (!sqlite.ok) throw sqliteUnavailable(config, sqlite);
  const desired = renderUnit(config);
  const onDisk = readTextFile(unitPath);
  if (onDisk !== undefined && onDisk !== desired) {
    const directives = customUnitDirectives(onDisk);
    if (directives.length > 0) throw unitCustomized(config, directives);
  }
  // StandardOutput=append: 不会替我们建目录，目录不在 unit 会直接起不来。
  mkdirSync(dirname(unitLogFile(config)), { recursive: true });
  const written = writeIfChanged(unitPath, desired);
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
    '本次不会启动守护进程；要立即启动请运行 dutydeck start。'
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

const DAEMON_UNTOUCHED_NOTICE = '当前正在运行的守护进程不受影响；要停止它请运行 dutydeck stop。';
// Linux 新模板 unit 只有停下之后才允许 disable，删掉后没有它拉起的守护进程在跑。
const SUPERVISED_UNIT_REMOVED_NOTICE = 'unit 已停止，之后不会再被 systemd 拉起；需要服务时运行 dutydeck start（不再受 systemd 托管）。';

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
    // bootout 只是把 job 从 launchd 注册表里摘掉。`dutydeck start` 起的 daemon 是
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

/**
 * 已加载的 unit 是否新模板（带托管声明），以及它的 ActiveState。连不上 user systemd 时只能看磁盘上的
 * unit 文件，ActiveState 未知。
 */
async function loadedUnit(config: ResolvedAutostart, available: boolean): Promise<{ supervised: boolean; activeState?: string }> {
  const shown = available ? await config.run('systemctl', ['--user', 'show', config.label, '--property=ActiveState,Environment']) : undefined;
  if (!shown || shown.status !== 0) {
    return { supervised: readTextFile(config.unitPath!)?.includes(`\nEnvironment=${SUPERVISOR_ENV}=systemd\n`) === true };
  }
  const props = new Map(shown.stdout.split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const));
  return {
    supervised: (props.get('Environment') ?? '').split(/\s+/).includes(`${SUPERVISOR_ENV}=systemd`),
    activeState: props.get('ActiveState') || undefined
  };
}

function unitStillRunning(config: ResolvedAutostart, activeState: string | undefined): AutostartError {
  const consequence = '删除 unit 文件后，systemd 会把运行中的 unit 退回默认的 KillMode=control-group：之后守护进程一退出（stop、restart 或崩溃），unit 里的 tmux 和所有 Agent 会被一起杀掉。已拒绝，没有做任何改动。';
  return activeState === undefined
    ? new AutostartError('unit-active', `当前会话连不上 user systemd，无法确认由 systemd 托管的 ${config.label} 是否还在运行。${consequence}`,
      ['在能连上 user systemd 的会话里（通常需要 XDG_RUNTIME_DIR=/run/user/$(id -u)）先运行 dutydeck stop，再运行 dutydeck autostart disable。'])
    : new AutostartError('unit-active', `${config.label} 还在运行（ActiveState=${activeState}）。${consequence}`,
      ['先运行 dutydeck stop（这时 systemd 只停守护进程，tmux 保留），再运行 dutydeck autostart disable。']);
}

async function disableLinux(config: ResolvedAutostart): Promise<AutostartResult> {
  const unitPath = config.unitPath!;
  const notices: string[] = [];
  const available = await userSystemdAvailable(config);
  let enabledBefore = false;
  // 只拦新模板：旧 oneshot unit 拉起的 detached daemon 不是 unit 的主进程，删掉 unit 后它退出也不会触发清理。
  const loaded = await loadedUnit(config, available);
  if (loaded.supervised && loaded.activeState !== 'inactive' && loaded.activeState !== 'failed') {
    throw unitStillRunning(config, loaded.activeState);
  }

  if (available) {
    // `changed` 必须来自 disable 之前的 is-enabled 状态：`systemctl --user disable`
    // 对本来就没启用的 unit 也返回 0，拿它的退出码判断会把空操作误报成"已改动"。
    enabledBefore = (await config.run('systemctl', ['--user', 'is-enabled', config.label])).status === 0;
    // 约束 1：不带 --now，systemd 就不会停止 unit，跑着的守护进程原样保留。
    const disabled = await config.run('systemctl', ['--user', 'disable', config.label]);
    if (disabled.status !== 0 && enabledBefore) {
      notices.push(`systemctl --user disable ${config.label} 失败（${firstLine(disabled.stderr) || '未知原因'}），继续删除 unit 文件。`);
    }
  } else {
    // disable 是清理动作：连不上 user systemd 也要保证 unit 文件被删掉，因此不抛错（新模板 unit 已在上面拦下）。
    notices.push('当前会话连不上 user systemd（缺少 DBus / 容器环境），只删除 unit 文件；如仍有残留请在桌面会话里手动 systemctl --user disable。');
  }

  const removed = removeIfPresent(unitPath);
  notices.unshift(removed ? `已删除 systemd unit: ${unitPath}` : `开机自启未注册，无需删除: ${unitPath}`);
  if (removed && available) await config.run('systemctl', ['--user', 'daemon-reload']);
  notices.push(loaded.supervised ? SUPERVISED_UNIT_REMOVED_NOTICE : DAEMON_UNTOUCHED_NOTICE);

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
