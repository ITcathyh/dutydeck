import { registerBusinessToolCli } from './plugins/tool-cli.js';
import { registerPluginResultCli } from './plugins/result-cli.js';
import { workbenchHelp, layeredWorkbenchHelp, collaborationHelp, groupToolsHelp, memoryToolsHelp, herdrHelp } from './agent-tool-help.js';
import type { RecoveryCliOptions, RecoveryOperation } from './recovery-cli.js';
import type { WorkspaceGroupsAction } from './workspace-groups-cli.js';
import type { SessionNamesAction } from './session-names-cli.js';
import type { ScheduleCliAction, ScheduleCliInput, ScheduleRequestCliInput } from './schedule-cli.js';
import { pluginBindingFields, agentFields, agentConfigFields, botFields, channelBotFields, fieldsHelp, groupFields, groupBindingFields, groupBindingCreateFields, type SettingsAction, type SettingsCliInput } from './settings-cli.js';
import { agentCommandHelp } from './lark/agent-command.js';
import { addAgentCommands } from './agent-cli.js';
import { Option, Command } from 'commander';
import { DatabaseCliError } from './database-cli.js';
import type { PluginCliAction, PluginCliOptions } from './plugins/cli.js';

export interface CliOptions {
  host?: string;
  localOnly?: boolean;
  auth?: boolean;
  /** `--unsafe-no-auth`：在非回环地址上关掉认证，并确认接受这个风险。 */
  unsafeNoAuth?: boolean;
  port?: string;
  cwd?: string;
  database?: string;
  botAppId?: string;
  idleTimeoutMs?: string;
  cleanupIntervalMs?: string;
  larkAppId?: string;
  larkAppSecret?: string;
  larkReceiveId?: string;
  larkChatId?: string;
  larkReceiveIdType?: string;
  larkAgentName?: string;
  larkBaseUrl?: string;
  larkListen?: boolean;
  /** `--json`：把结果打成单行 JSON，供脚本消费。 */
  json?: boolean;
  /** `start --foreground`：本进程自己作为 daemon 服务（systemd unit 的 ExecStart 用）。 */
  foreground?: boolean;
  /** `--force`：跳过等待正在执行的任务，立即重启。 */
  force?: boolean;
  /** `--drain-timeout <seconds>`：等待正在执行的任务结束的最长秒数（默认 900）。 */
  drainTimeout?: string;
  /** `restart --unit <unit>`：重启这个 systemd user unit 托管的运行时（如 Tag 运行时）。 */
  unit?: string;
}

/** `dutydeck deploy` 的选项。 */
export interface DeployCliOptions {
  source?: string;
  unit?: string;
  runtime?: string;
  releases?: string;
  port?: string;
  node?: string;
  /** `--no-restart` 时为 false：只准备发布目录并切换 current，不排空、不重启。 */
  restart?: boolean;
  printUnit?: boolean;
  now?: boolean;
  force?: boolean;
  drainTimeout?: string;
  json?: boolean;
}

/** `dutydeck deploy prune` 的选项。 */
export interface DeployPruneCliOptions {
  unit?: string;
  runtime?: string;
  releases?: string;
  keep?: string;
  dryRun?: boolean;
  includeUnmarked?: boolean;
  json?: boolean;
}

export interface LarkCliOptions {
  state?: string;
  readOnly?: boolean;
  agentName?: string;
  taskName?: string;
  taskId?: string;
  elapsedSeconds?: string;
  receiveId?: string;
  chatId?: string;
  receiveIdType?: string;
  messageId?: string;
  appId?: string;
  appSecret?: string;
  baseUrl?: string;
}

export interface IdentityPreflightCliOptions { groupBinding?: string[] }

export interface LarkCreateCliOptions {
  resume?: string;
  status?: boolean;
  json?: boolean;
  agent?: string;
  workspace?: string;
  listen?: boolean;
  fullTrust?: boolean;
  database?: string;
  forceLogin?: boolean;
}

export interface HistoryShowCliOptions { field?: string; offset?: string; length?: string; cursor?: string }

export interface AgentGroupCliOptions {
  cardFile?: string;
  delivery?: 'publish' | 'reply-agent' | 'both';
  final?: boolean;
  turn?: string;
  after?: string;
  limit?: string;
  timeoutMs?: string;
  since?: string;
  until?: string;
  query?: string;
  to?: string;
  replyTo?: string;
  inThread?: boolean;
  idempotencyKey?: string;
  image?: boolean;
}

export interface UpdateCliOptions {
  distTag?: string;
  force?: boolean;
  drainTimeout?: string;
}

export interface SessionRelayCliOptions {
  /** ask 超时秒数 */
  timeout?: string;
  /** 以 JSON 输出结果而非裸答案 */
  json?: boolean;
  choices?: string;
  multiple?: boolean;
}

export interface AuthTokenCliOptions {
  rotate?: boolean;
}

export interface AuthPasswordSetCliOptions {
  generate?: boolean;
}

export interface LegacySourceCliOptions {
  sourceHome?: string;
  botsConfig?: string;
  dataDir?: string;
  output?: string;
  json?: boolean;
  /** 实际调用的命令组：canonical migrate 或兼容别名 botmux，决定 JSON 输出的 command 字段。 */
  invokedAs?: 'migrate' | 'botmux';
}

export interface LegacyArchiveCliOptions extends LegacySourceCliOptions {
  output: string;
  passphraseFd?: string;
}

export interface SetupCliProgramOptions {
  yes?: boolean;
  json?: boolean;
  cwd?: string;
  port?: string;
  localOnly?: boolean;
  larkAppId?: string;
  skipLark?: boolean;
  forceLogin?: boolean;
  agent?: string;
  larkAppSecretFd?: string;
  listen?: boolean;
}

export interface DoctorCliOptions {
  json?: boolean;
}

export interface SecretValueCliOptions { valueFd?: string; database?: string }
export interface SecretRotateCliOptions extends SecretValueCliOptions { expectedRevision: string }
export interface SecretRemoveCliOptions { expectedRevision: string; database?: string }
export interface SecretListCliOptions { database?: string }

export interface DatabaseExecutionCliOptions { database: string }
export type DatabaseExecutionStatusCliOptions = DatabaseExecutionCliOptions;
export type DatabaseUpgradeExecutionCliOptions = DatabaseExecutionCliOptions;
export interface DatabaseRetireLegacyCliOptions extends DatabaseExecutionCliOptions {
  hostname: string;
  uid: number;
  tmuxSocket?: string;
  acpxDirectory?: string;
}

export interface WorkspaceGroupsCommandOptions {
  url?: string;
  database?: string;
  directory?: string[];
  json?: boolean;
}

export interface SessionNamesCommandOptions {
  url?: string;
  database?: string;
  json?: boolean;
}

/** App Secret 只从文件描述符读入，不出现在命令行参数里。 */
export type SettingsCommandInput = Omit<SettingsCliInput, 'appSecret' | 'apiKey'> & { appSecretFd?: string; apiKeyFd?: string };

export interface CliHandlers {
  plugin?(action: PluginCliAction, args: string[], options: PluginCliOptions): void | Promise<void>;
  recovery?(operation: RecoveryOperation, sessionId: string, options: RecoveryCliOptions): void | Promise<void>;
  collaborate?(operation: string, id: string | undefined, options: { json?: string; file?: string; turn?: string }): void | Promise<void>;
  /** dutydeck agent：operation 如 status、session.new、group.send；输出统一 JSON（见 agent-cli.ts）。 */
  agent?(operation: string, args: unknown[], options: Record<string, unknown>): void | Promise<void>;
  serve?(options: CliOptions): void | Promise<void>;
  setup?(options: SetupCliProgramOptions): void | Promise<void>;
  doctor?(options: DoctorCliOptions): void | Promise<void>;
  autostartEnable?(): void | Promise<void>;
  autostartDisable?(): void | Promise<void>;
  autostartStatus?(options: DoctorCliOptions): void | Promise<void>;
  daemonStart?(options: CliOptions): void | Promise<void>;
  daemonStop?(options: DoctorCliOptions): void | Promise<void>;
  daemonRestart?(options: CliOptions): void | Promise<void>;
  daemonStatus?(options: DoctorCliOptions): void | Promise<void>;
  update?(options: UpdateCliOptions): void | Promise<void>;
  deploy?(options: DeployCliOptions): void | Promise<void>;
  deployPrune?(options: DeployPruneCliOptions): void | Promise<void>;
  authToken?(options: AuthTokenCliOptions): void | Promise<void>;
  authPasswordSet?(options: AuthPasswordSetCliOptions): void | Promise<void>;
  authShareKeyRotate?(): void | Promise<void>;
  legacyDiscover?(options: LegacySourceCliOptions): void | Promise<void>;
  legacyPlan?(options: LegacySourceCliOptions): void | Promise<void>;
  legacyArchive?(options: LegacyArchiveCliOptions): void | Promise<void>;
  secretList?(options: SecretListCliOptions): void | Promise<void>;
  pluginBindingSecretSet?(plugin: string, reference: string, options: SecretValueCliOptions): void | Promise<void>;
  secretSet?(id: string, options: SecretValueCliOptions): void | Promise<void>;
  secretRotate?(id: string, options: SecretRotateCliOptions): void | Promise<void>;
  secretRemove?(id: string, options: SecretRemoveCliOptions): void | Promise<void>;
  larkSend?(markdown: string | undefined, options: LarkCliOptions): void | Promise<void>;
  larkCreate?(name: string | undefined, options: LarkCreateCliOptions): void | Promise<void>;
  larkUpdate?(markdown: string | undefined, options: LarkCliOptions): void | Promise<void>;
  identityPreflight?(channelBotId: string, options: IdentityPreflightCliOptions): void | Promise<void>;
  work?(operation: string, args: string[], options?: { file?: string; key?: string; turn?: string }): void | Promise<void>;
  groupSelf?(): void | Promise<void>;
  groupPeers?(): void | Promise<void>;
  groupMembers?(): void | Promise<void>;
  groupBots?(): void | Promise<void>;
  groupMessages?(options: AgentGroupCliOptions): void | Promise<void>;
  groupMessage?(messageId: string): void | Promise<void>;
  groupSend?(content: string, options: AgentGroupCliOptions): void | Promise<void>;
  groupHandoff?(target: string, content: string, options: { turn: string }): void | Promise<void>;
  agentCommand?(command: string, options: { turn: string }): void | Promise<void>;
  groupReplyAgent?(content: string, options: { turn: string }): void | Promise<void>;
  groupSendFile?(path: string, options: AgentGroupCliOptions): void | Promise<void>;
  groupWait?(options: AgentGroupCliOptions): void | Promise<void>;
  groupTeamSearch?(query: string): void | Promise<void>;
  historyList?(options: AgentGroupCliOptions): void | Promise<void>;
  historyShow?(taskId: string, options?: HistoryShowCliOptions): void | Promise<void>;
  memoryList?(options?: { topic?: string }): void | Promise<void>;
  memoryShow?(topic: string): void | Promise<void>;
  memorySearch?(query: string, options?: { topic?: string; limit?: string }): void | Promise<void>;
  memoryAdd?(content: string, options?: { topic?: string }): void | Promise<void>;
  memoryRemove?(id: string): void | Promise<void>;
  terminalBackend?(value: string | undefined, options: { url?: string; database?: string }): void | Promise<void>;
  settings?(action: SettingsAction, input: SettingsCommandInput): void | Promise<void>;
  schedule?(action: ScheduleCliAction, id: string | undefined, input: ScheduleCliInput): void | Promise<void>;
  scheduleRequest?(input: ScheduleRequestCliInput): void | Promise<void>;
  sessionHerdr?(args: string[]): void | Promise<void>;
  sessionSend?(text: string): void | Promise<void>;
  sessionAsk?(question: string, options: SessionRelayCliOptions): void | Promise<void>;
  sessionNativeAsk?(): void | Promise<void>;
  sessionPermissionHook?(): void | Promise<void>;
  databaseExecutionStatus?(options: DatabaseExecutionStatusCliOptions): void | Promise<void>;
  databaseUpgradeExecution?(options: DatabaseUpgradeExecutionCliOptions): void | Promise<void>;
  databaseRetireLegacy?(options: DatabaseRetireLegacyCliOptions): void | Promise<void>;
  workspaceGroups?(
    action: WorkspaceGroupsAction,
    params: {
      groupId?: string;
      name?: string;
      sessionIds?: string[];
    },
    options: WorkspaceGroupsCommandOptions
  ): void | Promise<void>;
  sessionNames?(
    action: SessionNamesAction,
    params: {
      sessionId?: string;
      name?: string;
    },
    options: SessionNamesCommandOptions
  ): void | Promise<void>;
}

const addCardOptions = (command: Command) => command
  .option('--state <state>', 'Card state: queued, running, completed, failed, or interrupted', 'completed')
  .option('--read-only', 'Render the card without action buttons')
  .option('--agent-name <name>', 'Agent name shown in the card title')
  .option('--task-name <name>', 'Card subtitle / task name', 'Dutydeck')
  .option('--task-id <id>', 'Task identifier shown in the footer')
  .option('--elapsed-seconds <seconds>', 'Elapsed time shown in the footer', '0')
  .option('--app-id <id>', 'Lark app ID; defaults to LARK_APP_ID')
  .option('--app-secret <secret>', 'Lark app secret; defaults to LARK_APP_SECRET')
  .option('--base-url <url>', 'Lark OpenAPI base URL; defaults to LARK_OPEN_API_BASE_URL');

const addServerOptions = (command: Command) => command
  .option('--host <host>', 'Advanced: bind a specific host or interface')
  .option('--local-only', 'Only accept connections from this computer (127.0.0.1)')
  .option('--auth', 'Require access-token authentication on non-local listeners (default)')
  .option('--no-auth', 'Explicitly disable Dutydeck access-token authentication (trusted networks only)')
  .option('--unsafe-no-auth', 'Disable authentication even on a non-loopback address; without it such a listener refuses to start')
  .option('--port <port>', 'Bind port (default: 4310)')
  .option('--cwd <directory>', 'Default Agent working directory')
  .option('--database <file>', 'SQLite database path')
  .option('--bot-app-id <appId>', 'Run the bot assigned to a partitioned database')
  .option('--idle-timeout-ms <ms>', 'Release idle Agent drivers (default: 21600000)')
  .option('--cleanup-interval-ms <ms>', 'Idle cleanup interval (default: 300000)')
  .option('--lark-app-id <id>', 'Lark app ID used by /api/lark; defaults to LARK_APP_ID')
  .option('--lark-app-secret <secret>', 'Lark app secret used by /api/lark; defaults to LARK_APP_SECRET')
  .option('--lark-receive-id <id>', 'Default Lark recipient used by /api/lark')
  .option('--lark-chat-id <id>', 'Default Lark group chat ID used by /api/lark')
  .option('--lark-receive-id-type <type>', 'Default Lark recipient ID type')
  .option('--lark-agent-name <name>', 'Default Lark card agent name')
  .option('--lark-base-url <url>', 'Lark OpenAPI base URL')
  .option('--no-lark-listen', 'Disable Lark message listening for this process without changing saved configuration');

const addLegacySourceOptions = (command: Command) => command
  .option('--source-home <directory>', 'Botmux source home to inspect')
  .option('--bots-config <file>', 'Exact Botmux bot registry file to inspect')
  .option('--data-dir <directory>', 'Exact Botmux data directory to inspect')
  .option('--json', 'Emit compact JSON (content remains redacted)');

/**
 * Server options may appear on the root (default serve) or a `daemon start /
 * restart` subcommand. Commander routes them to the command that defined them,
 * so a subcommand reads the merged globals to see flags passed on the same
 * invocation.
 */
const serverOptionsFrom = (options: CliOptions, command: Command): CliOptions => ({ ...command.optsWithGlobals(), ...options });

/**
 * setup 的选项来源同理，但只挑 setup 真正认识的键。
 *
 * 不能直接把 optsWithGlobals() 整个透传：根命令上还有 --host/--database/--no-auth 等
 * 一大批 serve 专属选项，混进来会让 setup 的入参含义变得含糊。这里做显式白名单，
 * 既拿到被父命令截获的 --cwd/--port/--local-only/--lark-app-id，又不携带无关项。
 */
const setupOptionsFrom = (options: SetupCliProgramOptions, command: Command): SetupCliProgramOptions => {
  const merged = { ...command.optsWithGlobals(), ...options } as Record<string, unknown>;
  const picked: SetupCliProgramOptions = {};
  if (typeof merged.cwd === 'string') picked.cwd = merged.cwd;
  if (typeof merged.port === 'string') picked.port = merged.port;
  if (merged.localOnly === true) picked.localOnly = true;
  if (typeof merged.larkAppId === 'string') picked.larkAppId = merged.larkAppId;
  if (merged.yes === true) picked.yes = true;
  if (merged.json === true) picked.json = true;
  if (merged.skipLark === true) picked.skipLark = true;
  if (merged.forceLogin === true) picked.forceLogin = true;
  if (typeof merged.agent === 'string') picked.agent = merged.agent;
  if (typeof merged.larkAppSecretFd === 'string') picked.larkAppSecretFd = merged.larkAppSecretFd;
  if (merged.listen === true) picked.listen = true;
  return picked;
};

const databaseOptionsFrom = (options: { database?: string }, command: Command): DatabaseExecutionCliOptions => {
  const merged = { ...command.optsWithGlobals(), ...options } as Record<string, unknown>;
  if (typeof merged.database !== 'string' || !merged.database.trim()) {
    throw new DatabaseCliError('DATABASE_OPTION_REQUIRED', '--database option is required');
  }
  return { database: merged.database as string };
};
const databaseRetirementOptionsFrom = (options: { database?: string; hostname?: string; uid?: string; tmuxSocket?: string; acpxDirectory?: string }, command: Command): DatabaseRetireLegacyCliOptions => {
  const database = databaseOptionsFrom(options, command);
  const merged = command.optsWithGlobals() as typeof options;
  const host = merged.hostname?.trim();
  if (!host) throw new DatabaseCliError('LEGACY_RETIREMENT_HOST_REQUIRED', '--hostname option is required');
  if (!/^\d+$/.test(merged.uid ?? '') || !Number.isSafeInteger(Number(merged.uid))) throw new DatabaseCliError('LEGACY_RETIREMENT_UID_REQUIRED', '--uid must be a non-negative integer');
  return {
    ...database, hostname: host, uid: Number(merged.uid),
    ...(merged.tmuxSocket ? { tmuxSocket: merged.tmuxSocket } : {}),
    ...(merged.acpxDirectory ? { acpxDirectory: merged.acpxDirectory } : {})
  };
};

const collectDirectories = (val: string, prev: string[] = []): string[] => [...prev, val];

const localRuntimeOptionsFrom = (options: SessionNamesCommandOptions, command: Command): SessionNamesCommandOptions => {
  const merged = { ...command.optsWithGlobals(), ...options } as Record<string, unknown>;
  const result: SessionNamesCommandOptions = { ...options };
  if (typeof merged.database === 'string' && merged.database) {
    result.database = merged.database;
  }
  if (typeof merged.url === 'string' && merged.url) {
    result.url = merged.url;
  }
  if (merged.json === true) {
    result.json = true;
  }
  return result;
};

export function createCliProgram(version: string, handlers: CliHandlers = {}) {
  const program = new Command()
    .option('--agent-turn <token>', 'Immutable task attempt capability for legacy Agent tool commands')
    .name('dutydeck')
    .description('Run the Dutydeck local session server')
    .version(version, '-V, --version', 'Show the installed version');

  addServerOptions(program)
    .showHelpAfterError();

  program.action(options => handlers.serve?.(options));

  const recovery = program.command('recovery').description('Inspect and explicitly reconcile execution on the local runtime');
  for (const operation of ['inspect', 'probe', 'confirm', 'steering', 'retire-pty', 'replace-native'] as const) {
    const command = recovery.command(`${operation} <session-id>`)
      .option('--url <url>', 'Exact local runtime URL; requires --database')
      .option('--database <path>', 'Exact runtime database, opened read-only for its auth token');
    if (operation === 'probe') command.requiredOption('--run-id <id>', 'Exact run ID from recovery inspect');
    if (['confirm', 'steering', 'retire-pty', 'replace-native'].includes(operation)) command.requiredOption('--file <path>', 'Reviewed decision JSON, including revisions and evidence');
    command.action((sessionId, options, cmd) => handlers.recovery?.(operation, sessionId, { ...options,
      ...(cmd.optsWithGlobals().database ? { database: cmd.optsWithGlobals().database } : {}) }));
  }

  // 新用户的第一条命令。放在最前面是刻意的：`dutydeck --help` 第一眼就该看到它。
  //
  // 注意 --cwd / --port / --local-only / --lark-app-id 在根命令上也有同名同义的定义，
  // commander 会把它们路由到定义处（即根命令），所以这里必须读合并后的 globals，
  // 否则 `dutydeck setup --cwd X` 里的 X 会落到根命令上、setup 拿到 undefined。
  program.command('setup')
    .description('Guided first-run setup: detect Agent CLIs, choose a working directory, optionally bind a Lark bot with its default Agent and App Secret')
    .option('--yes', 'Accept defaults without prompting; the only way to skip the Lark publish confirmation')
    .option('--json', 'Emit a single JSON line and never prompt or render a QR code (secrets are masked)')
    .option('--cwd <directory>', 'Default Agent working directory; skips that question')
    .option('--port <port>', 'Bind port to write into the configuration (default: 4310)')
    .option('--local-only', 'Only accept connections from this computer (127.0.0.1)')
    .option('--lark-app-id <id>', 'Lark app ID (cli_*) to configure and bind')
    .option('--skip-lark', 'Skip the Lark binding step entirely')
    .option('--force-login', 'Re-scan the Lark open-platform QR code to switch accounts')
    .option('--agent <id>', 'Default Agent for the Lark bot (must be a detected CLI; stored in the bot configuration). Without it: keep the bot\'s current one, else ask, else the first detected')
    .option('--lark-app-secret-fd <fd>', 'Read the Lark App Secret from an inherited file descriptor (e.g. 0 with a pipe); interactive runs prompt with hidden input instead. Never pass secrets as arguments')
    .option('--listen', 'Also enable Lark message listening for the saved bot')
    .action((options, command) => handlers.setup?.(setupOptionsFrom(options, command)))
    .addHelpText('after', `
Behaviour:
  幂等可重跑：检测到已有配置时逐项询问「保留或更新」，配置无变化则报告无需改动。
  中途失败或取消不会写入半份配置，并会打印一条算好的续跑命令。
  --json 隐含「绝不提问、绝不渲染二维码」；非交互环境请用字段 flag 或 --yes。
  飞书机器人的 App Secret 与默认 Agent 保存在机器人配置里（与 Dashboard 同一份）：交互时隐藏输入 App Secret，
  脚本里用 --lark-app-secret-fd 从管道读，绝不通过命令行参数传。
  不给 --lark-app-id、只给 --agent 或 --lark-app-secret-fd：改 .env 里 LARK_APP_ID 那个机器人的默认 Agent / App Secret，不重新配置开放平台。
  已在运行的服务需要 dutydeck restart 才会读取新的机器人配置。

Examples:
  $ dutydeck setup
  $ dutydeck setup --cwd /path/to/project --port 4310
  $ dutydeck setup --lark-app-id cli_xxx
  $ printf %s "$LARK_SECRET" | dutydeck setup --lark-app-id cli_xxx --lark-app-secret-fd 0 --agent claude --yes
  $ dutydeck setup --agent codex
  $ dutydeck setup --lark-app-id cli_xxx --force-login
  $ dutydeck setup --cwd /path/to/project --skip-lark --yes
  $ dutydeck setup --json --cwd /path/to/project --skip-lark --yes`);

  program.command('doctor')
    .description('Diagnose the local environment and configuration; every failure prints a fix')
    .option('--json', 'Emit machine-readable diagnostics as a single JSON line')
    .action(options => handlers.doctor?.(options))
    .addHelpText('after', `
Exit codes:
  0    所有检查通过（可能含警告）
  1    至少一项检查失败

Examples:
  $ dutydeck doctor
  $ dutydeck doctor --json
  $ dutydeck doctor --json | jq '.checks[] | select(.level=="fail")'`);

  const autostart = program.command('autostart').description('Manage starting Dutydeck automatically at login');
  autostart.command('enable')
    .description('Register the boot hook (launchd on macOS, systemd --user on Linux); does not start the server now')
    .action(() => handlers.autostartEnable?.())
    .addHelpText('after', `
Note:
  enable 只注册开机项，不会立即启动服务；立即启动请用 dutydeck start。

Examples:
  $ dutydeck autostart enable`);
  autostart.command('disable')
    .description('Remove the boot hook; leaves an already-running server untouched')
    .action(() => handlers.autostartDisable?.())
    .addHelpText('after', `
Note:
  disable 只移除开机项，正在运行的服务不受影响；停止它请用 dutydeck stop。

Examples:
  $ dutydeck autostart disable`);
  autostart.command('status')
    .description('Show whether the boot hook is registered and whether the service is loaded')
    .option('--json', 'Emit machine-readable state as a single JSON line')
    .action(options => handlers.autostartStatus?.(options))
    .addHelpText('after', `
Examples:
  $ dutydeck autostart status
  $ dutydeck autostart status --json`);

  const lark = program.command('lark').description('Create Lark bots and send or update Dutydeck cards');
  lark.command('create')
    .description('Create, configure and submit a new Feishu bot using the local login session')
    .argument('[name]', 'New bot name (1–50 characters); omit when resuming')
    .option('--resume <id>', 'Continue the same creation job; safely retry a failed job without recreating its app')
    .option('--status', 'Only inspect the --resume job; never scan, retry or change Agent settings')
    .option('--json', 'Emit one JSON line; create using a valid cached login and never render a QR code')
    .option('--force-login', 'Scan again to choose another account; requires an interactive terminal')
    .option('--agent <id>', 'Execution Agent ID, including ccflash; defaults to asking before actions')
    .option('--workspace <directory>', 'Existing absolute Agent working directory')
    .option('--full-trust', 'Allow the selected Agent to execute unattended Lark tasks with full trust')
    .option('--listen', 'Enable listening and connect the bot to the running local service')
    .action((name, options, command) => handlers.larkCreate?.(name, {
      ...options,
      ...(typeof command.optsWithGlobals().database === 'string' ? { database: command.optsWithGlobals().database as string } : {}),
    }))
    .addHelpText('after', `
Behaviour:
  创建和续跑优先复用本机登录态，失效时在交互终端扫码；--force-login 可重新选择账号。
  有效登录态支持非交互创建及 --json；无有效登录态时停止，并输出 --resume 续跑命令。
  App Secret 仅保存到本地数据库；创建完成后可直接选择执行 Agent，也可在 Dashboard 继续。
  中断后用输出的 --resume 命令续跑；创建或发布结果未知时停止重试，避免重复创建应用。
  数据库默认沿用本机 daemon，可用全局 --database 指定。--listen 会尝试动态接通同一数据库的本机服务。
  首次绑定 Agent 默认逐次询问；只有显式 --full-trust 才启用无人值守执行，续跑保留已确认的模式。

Examples:
  $ dutydeck lark create "Dutydeck 助手"
  $ dutydeck lark create "CCFlash 助手" --agent ccflash --listen
  $ dutydeck lark create --resume <job-id>
  $ dutydeck lark create --resume <job-id> --status --json`);
  addCardOptions(lark.command('send')
    .description('Send a new Dutydeck card')
    .argument('[markdown]', 'Final Markdown or fallback card content')
    .option('--receive-id <id>', 'Recipient ID; defaults to LARK_RECEIVE_ID')
    .option('--chat-id <id>', 'Group chat ID (oc_xxx); defaults to LARK_CHAT_ID')
    .option('--receive-id-type <type>', 'ID type; defaults to LARK_RECEIVE_ID_TYPE'))
    .action((markdown, options) => handlers.larkSend?.(markdown, options));
  addCardOptions(lark.command('update')
    .description('Update an existing Dutydeck card in place')
    .argument('[markdown]', 'Final Markdown or fallback card content')
    .requiredOption('--message-id <id>', 'Lark card message ID to update'))
    .action((markdown, options) => handlers.larkUpdate?.(markdown, options));
  lark.command('preflight')
    .description('Run a read-only identity/App×Chat preflight for a staged ChannelBot')
    .argument('<channel-bot-id>', 'Staged or disabled ChannelBot ID')
    .option('--group-binding <id>', 'Limit verification to a GroupBinding (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
    .action((channelBotId, options) => handlers.identityPreflight?.(channelBotId, options));

  // 给 Agent 用的统一入口；下面 work/group/history/collaborate/command/memory/schedule request 是兼容旧会话的入口。
  addAgentCommands(program, (operation, args, options) => handlers.agent?.(operation, args, options));

  const work = program.command('work').description('Arrange durable goals, Agent steps and reusable workflows in the current Feishu conversation').requiredOption('--turn <token>', 'Current task capability supplied by Dutydeck');
  work.addHelpText('after', workbenchHelp() + '\n' + layeredWorkbenchHelp());
  const workOptions = (options: { file?: string; key?: string } = {}) => ({ ...options, turn: work.opts().turn as string });
  for (const operation of ['list', 'templates', 'agents', 'skills']) work.command(operation).action(() => handlers.work?.(operation, [], workOptions()));
  work.command('show <id>').action(id => handlers.work?.('show', [id], workOptions()));
  work.command('create').addHelpText('after', workbenchHelp()).requiredOption('--file <path>', 'JSON plan with goal and a stable idempotencyKey').action(options => handlers.work?.('create', [], workOptions(options)));
  work.command('delegate').addHelpText('after', layeredWorkbenchHelp()).requiredOption('--file <path>', 'JSON brief with goal, context and a stable idempotencyKey').action(options => handlers.work?.('delegate', [], workOptions(options)));
  work.command('save <id> <name>').action((id, name) => handlers.work?.('save', [id, name], workOptions()));
  work.command('run <template> <version> <goal>').requiredOption('--key <key>', 'Stable request key for this run').action((id, version, goal, options) => handlers.work?.('run', [id, version, goal], workOptions(options)));

  const group = program.command('group').description('Collaborate with Agents in the current Lark group').addHelpText('after', groupToolsHelp(true));
  group.command('self')
    .description('Show the current Lark Agent and scoped chat')
    .action(() => handlers.groupSelf?.());
  group.command('peers')
    .description('Discover configured Agents that are members of this Lark group')
    .action(() => handlers.groupPeers?.());
  group.command('members')
    .description('Discover human members in this Lark group')
    .action(() => handlers.groupMembers?.());
  group.command('bots')
    .description('List all bots in this Lark group (agentId present means managed by this Dutydeck instance)')
    .action(() => handlers.groupBots?.());
  group.command('messages')
    .description('Read messages from this Lark group')
    .option('--after <cursor>', 'Read only messages after a cursor returned by messages or wait')
    .option('--limit <count>', 'Maximum messages to return (1-50)', '20')
    .option('--since <time>', 'Filter messages created after this time (ISO 8601 or unix timestamp)')
    .option('--until <time>', 'Filter messages created before this time (ISO 8601 or unix timestamp)')
    .option('--query <query>', 'Filter messages containing all whitespace-separated keywords (case-insensitive)')
    .action(options => handlers.groupMessages?.(options));
  group.command('message')
    .description('Fetch a single message by ID, expanding merge_forward (合并转发) content')
    .argument('<message-id>', 'om_* message ID to fetch')
    .action((messageId) => handlers.groupMessage?.(messageId));
  group.command('send')
    .description('Send a new group message or reply to an existing message/thread')
    .option('--final', 'Deliver the final answer for the current task')
    .option('--card-file <path>', 'Static Card 2.0 body JSON file; requires --final')
    .addOption(new Option('--delivery <mode>', 'Final result targets').choices(['publish', 'reply-agent', 'both']))
    .option('--turn <token>', 'Current final-delivery task capability')
    .argument('<content>', 'Message content')
    .option('--to <target>', 'Mention a discovered Agent or human member by ID or name')
    .option('--reply-to <message-id>', 'Reply to a message in this group')
    .option('--in-thread', 'Place the reply in the topic/thread; requires --reply-to with an om_* message ID')
    .option('--idempotency-key <key>', 'Stable retry key (up to 50 characters)')
    .action((content, options) => handlers.groupSend?.(content, options))
    .addHelpText('after', `
Examples:
  $ dutydeck group send "我已定位问题" --reply-to om_xxx --in-thread
  $ dutydeck group send "请检查接口" --to cli_peer --reply-to om_xxx --in-thread
  $ dutydeck group send "发布窗口已开启"

Routing guidance:
  Continue a discussion or answer a question with --reply-to ... --in-thread.
  Start an independent announcement or task without --reply-to/--in-thread.`);
  group.command('send-file')
    .description('Send a file from the current session workspace to the scoped Lark group')
    .argument('<path>', 'Path inside the current session workspace')
    .option('--reply-to <message-id>', 'Reply to a message in this group')
    .option('--in-thread', 'Place the reply in the topic/thread')
    .option('--idempotency-key <key>', 'Stable retry key')
    .option('--image', 'Send as an image message (10 MiB limit)')
    .action((path, options) => handlers.groupSendFile?.(path, options));
  group.command('handoff')
    .description('Handoff task to another bot in the current group and topic')
    .argument('<target>', 'Target bot name, appId, or openId')
    .argument('<content>', 'Handoff task brief and acceptance criteria')
    .requiredOption('--turn <token>', 'Current task capability supplied by Dutydeck')
    .action((target, content, options) => handlers.groupHandoff?.(target, content, options));
  group.command('reply-agent')
    .description('Reply task execution result to the initiating bot in the current group and topic')
    .argument('<content>', 'Execution result to reply')
    .requiredOption('--turn <token>', 'Current task capability supplied by Dutydeck')
    .action((content, options) => handlers.groupReplyAgent?.(content, options));
  group.command('wait')
    .description('Wait briefly for new messages after a cursor')
    .requiredOption('--after <cursor>', 'Cursor returned by messages or wait')
    .option('--limit <count>', 'Maximum messages to return (1-50)', '20')
    .option('--timeout-ms <milliseconds>', 'Long-poll timeout (0-30000)', '15000')
    .action(options => handlers.groupWait?.(options));
  group.command('team-search')
    .description('Search messages in other Lark groups of this bot (requires group participation in this group)')
    .argument('<query>', 'Keywords to search for')
    .action(query => handlers.groupTeamSearch?.(query));

  const history = program.command('history').description('Review earlier Agent tasks in the current Lark chat');
  history.command('list')
    .description('List earlier tasks of this chat, newest first')
    .option('--since <time>', 'Only tasks created after this time (ISO 8601 or unix timestamp)')
    .option('--until <time>', 'Only tasks created before this time (ISO 8601 or unix timestamp)')
    .option('--query <query>', 'Only tasks whose request or answer contains all whitespace-separated keywords (case-insensitive)')
    .option('--limit <count>', 'Maximum tasks to return (1-50)', '20')
    .action(options => handlers.historyList?.(options));
  history.command('show')
    .description('Show the request and final answer of an earlier task in this chat')
    .argument('<task-id>', 'Task id returned by history list')
    .option('--field <field>', 'Read saved request or answer verbatim (request|answer)')
    .option('--offset <units>', 'UTF-16 offset; surrogate pairs are kept intact')
    .option('--length <units>', 'Page length in UTF-16 units (1-8000, default 4000)')
    .option('--cursor <cursor>', 'Continue a version-bound page; exclusive with field/offset/length')
    .action((taskId, options) => Object.keys(options).length ? handlers.historyShow?.(taskId, options) : handlers.historyShow?.(taskId));

  // 会话记忆：与 group 同一套 capability，但对私聊和关闭群协作的机器人同样可用。
  program.command('collaborate <operation> [id]').addHelpText('after', collaborationHelp('dutydeck collaborate')).description('Manage generic group follow-ups and ongoing mandates')
    .option('--json <json>', 'Structured operation parameters').option('--file <path>', 'Read operation parameters from JSON file')
    .requiredOption('--turn <token>', 'Current task authorization token')
    .action((operation, id, options) => handlers.collaborate?.(operation, id, options));

  program.command('command')
    .description('Lark Agent only: run a Dutydeck chat command for this turn\'s requester; commands that change something post a confirm card first')
    .argument('<command>', "Chat command, e.g. '/status' or '/new --agent <id> -- <task>'")
    .requiredOption('--turn <token>', 'Current task authorization token')
    .addHelpText('after', `\nCommands:\n${agentCommandHelp()}`)
    .action((command, options) => handlers.agentCommand?.(command, options));

  const memory = program.command('memory').description('Read and maintain the long-term memory of the current Lark chat').addHelpText('after', memoryToolsHelp());
  memory.command('list')
    .description('List the memories saved for this chat, with their ids')
    .option('--topic <slug>', 'Filter memories by topic slug')
    .action(options => handlers.memoryList?.(options));
  memory.command('show')
    .description('Show full memories under a specific topic')
    .argument('<topic>', 'Topic slug')
    .action(topic => handlers.memoryShow?.(topic));
  memory.command('search')
    .description('Search memories by keyword')
    .argument('<query>', 'Keyword to search for')
    .option('--topic <slug>', 'Filter by topic slug')
    .option('--limit <count>', 'Maximum entries to return (default: 20, max: 50)')
    .action((query, options) => handlers.memorySearch?.(query, options));
  memory.command('add')
    .description('Save one durable fact, preference or convention for this chat')
    .argument('<content>', 'One-sentence memory (at most 1000 characters)')
    .option('--topic <slug>', 'Topic slug (defaults to general)')
    .action((content, options) => handlers.memoryAdd?.(content, options));
  memory.command('remove')
    .description('Delete a memory of this chat by id')
    .argument('<id>', 'Memory id shown by list (mem_*)')
    .action(id => handlers.memoryRemove?.(id));

  // 通用回传通道：任何来源的会话内 CLI 都能使用，不限飞书。
  // 与 `dutydeck group send` 分层并存——group 面向飞书群里的其他人/机器人，
  // session 面向「发起本会话的用户」，落点是会话事件流（Web 时间线 / 卡片）。
  const settings = program.command('settings').description('Read and change what the dashboard configures, on the targeted local runtime').addHelpText('after', `
Every command prints one JSON line. Without --url/--database it targets the runtime shown by \`dutydeck status\`;
--instance <id> reaches a peer instance through that runtime, like the dashboard's instance switcher.
Values: true|false, integers, null to restore a default, comma lists or JSON arrays, JSON objects.

Examples:
  $ dutydeck settings instances
  $ dutydeck settings bot list --instance tag
  $ dutydeck settings bot show cli_xxx
  $ dutydeck settings bot set cli_xxx adhdMode=true mentionPolicy=topic
  $ dutydeck settings group set oc_xxx modelOverride=gpt-5.5 oncall=true participation=selective
  $ dutydeck settings usage set-cap 50 --app cli_xxx`);
  settings.command('terminal-backend [tmux|herdr]')
    .description('Get/set the primary terminal backend for NEW pty-cli sessions in this runtime; ACP stays ACP, existing sessions keep their backend')
    .option('--url <url>', 'Target local runtime URL (requires its exact --database)')
    .option('--database <path>', 'Exact database of the target runtime')
    .action((value, _options, command) => { const options = command.optsWithGlobals(); return handlers.terminalBackend?.(value, { url: options.url, database: options.database }); });
  const withTarget = (command: Command) => command
    .option('--instance <id>', 'Peer instance id from `dutydeck settings instances`')
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token');
  const runSettings = (action: SettingsAction, command: Command, input: SettingsCommandInput = {}) => {
    const { instance, url, database } = command.optsWithGlobals();
    return handlers.settings?.(action, { instance, url, database, ...input });
  };
  const schedules = program.command('schedule').description('Create and manage persistent Agent schedules; every command prints JSON');
  for (const action of ['create', 'list', 'show', 'update', 'enable', 'disable', 'run', 'delete', 'history'] as const) {
    const command = withTarget(schedules.command(['create', 'list'].includes(action) ? action : `${action} <id>`))
      .option('--session <id>', 'Existing session; otherwise list all sessions, or create one with --agent')
      .option('--expected-revision <number>', 'Reject a concurrent edit; defaults to the revision just read');
    if (action === 'create' || action === 'update') command
      .option('--name <name>', 'Schedule name')
      .option('--prompt <text>', 'Instructions to execute when the schedule fires')
      .option('--cron <expression>', 'Five-field cron expression')
      .option('--every <minutes>', 'Fixed interval in minutes (minimum 1)')
      .option('--at <local-time>', 'Run once at YYYY-MM-DDTHH:mm[:ss] in --timezone')
      .option('--timezone <iana-zone>', 'IANA timezone; creation defaults to this computer’s timezone')
      .option('--input <json>', 'Complete create input or update patch as JSON')
      .option('--file <path>', 'Read the JSON input from this file');
    if (action === 'create') command
      .option('--agent <id>', 'Create a new idle session for this Agent; the prompt runs only when triggered')
      .option('--cwd <path>', 'Workspace directory for a new session')
      .option('--workspace <mode>', 'shared (default) or worktree for a new session')
      .option('--model <model>', 'Model for a new session')
      .option('--permission-mode <mode>', 'Permission mode for a new session; defaults to the Agent setting');
    if (action === 'run') command.option('--idempotency-key <key>', 'Reuse this key to return the same manual execution after a lost response');
    command.action((...args: unknown[]) => {
      const parsed = args.at(-1) as Command;
      return handlers.schedule?.(action, ['create', 'list'].includes(action) ? undefined : args[0] as string, parsed.optsWithGlobals());
    });
  }
  schedules.command('request')
    .description('Lark Agent only: set up a schedule for this turn\'s requester; it starts after they click 启用 on the posted card')
    .requiredOption('--turn <token>', 'Current task authorization token')
    .requiredOption('--prompt <text>', 'Complete instructions to execute each time')
    .option('--name <name>', 'Short schedule name')
    .option('--every <minutes>', 'Fixed interval in whole minutes')
    .option('--cron <expression>', 'Five-field cron expression, Asia/Shanghai time')
    .option('--at <local-time>', 'Run once at YYYY-MM-DDTHH:mm, Asia/Shanghai time')
    .action(options => handlers.scheduleRequest?.(options));
  withTarget(settings.command('instances').description('List peer instances that --instance can reach'))
    .action((_options, command) => runSettings('instances', command));
  withTarget(settings.command('agents').description('List the Agents that bot and group settings can select'))
    .action((_options, command) => runSettings('agents', command));

  const pluginBindings = settings.command('plugin-binding').description('Package bindings and effective skills (dashboard: 插件与技能)');
  pluginBindings.command('secret-set <package> <reference>').description('Create a namespaced local plugin secret; values are never command arguments')
    .option('--database <path>', 'Local runtime database location').option('--value-fd <fd>', 'Inherited input descriptor; otherwise hidden TTY input')
    .action((plugin, reference, options, command) => handlers.pluginBindingSecretSet?.(plugin, reference, serverOptionsFrom(options, command)));
  withTarget(pluginBindings.command('list')).action((_options, command) => runSettings('plugin-binding-list', command));
  for (const action of ['set', 'explain'] as const) {
    const command = withTarget(pluginBindings.command(action === 'set' ? 'set <package> [key=value...]' : 'explain <package>'))
      .option('--app <app-id>', 'Bot binding target').option('--chat <chat-id>', 'Group binding target (requires --app)')
      .option('--workspace <path>', 'Exact project directory for Web tasks, including managed worktrees')
      .option('--expected-revision <number>', 'Reject concurrent edits');
    if (action === 'set') command.addHelpText('after', fieldsHelp(pluginBindingFields)).action((pluginName, pairs, _options, command) => {
      const options = command.optsWithGlobals();
      return runSettings('plugin-binding-set', command, { pluginName, pairs, appId: options.app, chatId: options.chat, workspaceRoot: options.workspace, expectedRevision: options.expectedRevision });
    });
    else command.action((pluginName, _options, command) => { const options = command.optsWithGlobals(); return runSettings('plugin-binding-explain', command, { pluginName, appId: options.app, chatId: options.chat, workspaceRoot: options.workspace }); });
  }

  const agentSettings = settings.command('agent').description('Claude Code model service settings (dashboard: Agent)');
  withTarget(agentSettings.command('show <agent-id>').description('Show model service settings; the API Key is never printed')
    .option('--app <app-id>', 'Show this bot’s independent model service settings'))
    .action((agentId, options, command) => runSettings('agent-show', command, { agentId, appId: options.app }));
  withTarget(agentSettings.command('set <agent-id> [key=value...]').description('Apply when the next Agent process starts; recreate running sessions for immediate use. Empty model/baseUrl restores CLI defaults')
    .option('--api-key-fd <fd>', 'Replace API Key from this file descriptor (0 = stdin); omitted keeps it')
    .option('--app <app-id>', 'Configure only this bot; set its model with settings bot set <app-id> defaultModel=...'))
    .addHelpText('after', `${fieldsHelp(agentFields)}${fieldsHelp(agentConfigFields)}`)
    .action((agentId, pairs, options, command) => runSettings('agent-set', command, { agentId, appId: options.app, pairs, apiKeyFd: options.apiKeyFd }));

  const botSettings = settings.command('bot').description('Bot settings (dashboard: 机器人)');
  withTarget(botSettings.command('list').description('List bots on the runtime'))
    .action((_options, command) => runSettings('bot-list', command));
  withTarget(botSettings.command('show <app-id>').description('Print every setting of a bot; the App Secret is never printed'))
    .action((appId, _options, command) => runSettings('bot-show', command, { appId }));
  withTarget(botSettings.command('set <app-id> [key=value...]').description('Change bot settings; keys not given keep their values')
    .option('--app-secret-fd <fd>', 'Also replace the App Secret, read from this file descriptor (0 = stdin)'))
    .addHelpText('after', fieldsHelp(botFields))
    .action((appId, pairs, options, command) => runSettings('bot-set', command, { appId, pairs, appSecretFd: options.appSecretFd }));
  withTarget(botSettings.command('add <app-id> [key=value...]').description('Bind an existing Feishu/Lark app as a bot; may also set allowedUserNames, allowedBotNames, allowedUsers, allowedEmails, allowedBots')
    .requiredOption('--app-secret-fd <fd>', 'Read the App Secret from this file descriptor (0 = stdin)'))
    .action((appId, pairs, options, command) => runSettings('bot-add', command, { appId, pairs, appSecretFd: options.appSecretFd }));
  withTarget(botSettings.command('remove <app-id>').description('Delete a bot with its saved credentials and settings')
    .option('--yes', 'Confirm the deletion'))
    .action((appId, options, command) => runSettings('bot-remove', command, { appId, yes: options.yes === true }));
  withTarget(botSettings.command('install-hook <app-id> [key=value...]').description('Install the high-risk command hook for the bot Agent; needed before riskControlMode=enforced')
    .option('--pattern <regex>', 'High-risk command pattern; defaults to the saved one')
    .option('--prepare', 'Only prepare hook files; do not save bot settings'))
    .addHelpText('after', fieldsHelp({ workspace: 'string', defaultAgentId: 'string', fallbackAgentId: 'string', defaultAgentWeights: 'json' }))
    .action((appId, pairs, options, command) => runSettings('bot-install-hook', command, { appId, pairs, pattern: options.pattern, prepare: options.prepare === true }));

  const channelBotSettings = settings.command('channel-bot').description('Foundation draft bot settings and SecretRef selection (dashboard: 群配置与权限)');
  withTarget(channelBotSettings.command('list').description('List foundation bot IDs and credential metadata'))
    .action((_options, command) => runSettings('channel-bot-list', command));
  withTarget(channelBotSettings.command('show <id>').description('Show a foundation bot by its internal ID, not its App ID'))
    .action((channelBotId, _options, command) => runSettings('channel-bot-show', command, { channelBotId }));
  withTarget(channelBotSettings.command('set <id> <key=value...>').description('Update a staged/disabled bot; credentialRef=null clears the selection')
    .option('--expected-revision <number>', 'Reject a concurrent edit; defaults to the revision just read'))
    .addHelpText('after', fieldsHelp(channelBotFields))
    .action((channelBotId, pairs, options, command) => runSettings('channel-bot-set', command, { channelBotId, pairs, expectedRevision: options.expectedRevision }));

  const groupBindingSettings = settings.command('group-binding').description('Offline foundation group policy drafts (dashboard: 群配置与权限); does not activate runtime policies');
  withTarget(groupBindingSettings.command('list').description('List offline bindings by internal ID')
    .option('--bot <id>', 'Only bindings of this internal channel bot ID'))
    .action((options, command) => runSettings('group-binding-list', command, { channelBotId: options.bot }));
  withTarget(groupBindingSettings.command('show <id>').description('Show a foundation group binding by internal ID'))
    .action((groupBindingId, _options, command) => runSettings('group-binding-show', command, { groupBindingId }));
  withTarget(groupBindingSettings.command('add <id> [key=value...]').description('Create a staged offline binding; existing bindings are never overwritten')
    .requiredOption('--bot <id>', 'Internal channel bot ID')
    .requiredOption('--chat <chat-id>', 'External chat ID'))
    .addHelpText('after', fieldsHelp(groupBindingCreateFields))
    .action((groupBindingId, pairs, options, command) => runSettings('group-binding-add', command, { groupBindingId, channelBotId: options.bot, chatId: options.chat, pairs }));
  withTarget(groupBindingSettings.command('set <id> <key=value...>').description('Update an offline binding; omitted keys keep their values')
    .option('--expected-revision <number>', 'Reject a concurrent edit; defaults to the revision just read'))
    .addHelpText('after', fieldsHelp(groupBindingFields))
    .action((groupBindingId, pairs, options, command) => runSettings('group-binding-set', command, { groupBindingId, pairs, expectedRevision: options.expectedRevision }));

  const groupSettings = settings.command('group').description('Per-group settings of each bot (dashboard: 群聊)');
  withTarget(groupSettings.command('list').description('List synced groups and the binding of each bot')
    .option('--app <app-id>', 'Only groups of this bot'))
    .action((options, command) => runSettings('group-list', command, { appId: options.app }));
  withTarget(groupSettings.command('show <chat-id>').description('Print a group binding, its effective settings, collaboration settings, duty and scenario packs')
    .option('--app <app-id>', 'Bot to show when several bots share the group'))
    .action((chatId, options, command) => runSettings('group-show', command, { chatId, appId: options.app }));
  withTarget(groupSettings.command('set <chat-id> <key=value...>').description('Change group settings; keys not given keep their values')
    .option('--app <app-id>', 'Bot to change when several bots share the group'))
    .addHelpText('after', `${fieldsHelp(groupFields)}
Object values take the JSON shape printed by \`group show\`. agentOverride, workspaceOverride, modelOverride
and reasoningOverride also accept inherit, clear or a plain value. roleChanges and accessOverride use
principal ids from \`group members\`. scenarios takes {"<pack id>":{"enabled":true,"params":{...}}} or
{"<pack id>":null}; params may list only the keys to change. Packs and their params are listed by \`group show\`.
alarm=<JSON> (the old flat alarm subscription) still works for one release and is converted to scenarios.alarm.`)
    .action((chatId, pairs, options, command) => runSettings('group-set', command, { chatId, pairs, appId: options.app }));
  withTarget(groupSettings.command('members <chat-id>').description('List group members with the principal ids used by accessOverride and roleChanges')
    .option('--app <app-id>', 'Bot to ask when several bots share the group')
    .option('--page-token <token>', 'Next page token from the previous result'))
    .action((chatId, options, command) => runSettings('group-members', command, { chatId, appId: options.app, pageToken: options.pageToken }));
  withTarget(groupSettings.command('sync <app-id>').description('Refresh the groups a bot is in; needed before configuring a new group'))
    .action((appId, _options, command) => runSettings('group-sync', command, { appId }));

  const usageSettings = settings.command('usage').description('Usage summary and monthly cost caps (dashboard: 用量)');
  withTarget(usageSettings.command('show').description('Print usage of this month and week, and the caps'))
    .action((_options, command) => runSettings('usage-show', command));
  withTarget(usageSettings.command('set-cap <monthly-usd>').description('Set the monthly cost cap of a bot, or of one group with --chat')
    .requiredOption('--app <app-id>', 'Bot')
    .option('--chat <chat-id>', 'Group (oc_...)'))
    .action((amount, options, command) => runSettings('usage-set-cap', command, { amount, appId: options.app, chatId: options.chat }));
  withTarget(usageSettings.command('remove-cap').description('Remove the monthly cost cap of a bot, or of one group with --chat')
    .requiredOption('--app <app-id>', 'Bot')
    .option('--chat <chat-id>', 'Group (oc_...)'))
    .action((options, command) => runSettings('usage-remove-cap', command, { appId: options.app, chatId: options.chat }));

  const session = program.command('session').enablePositionalOptions().description('Relay messages to the user who owns the current Dutydeck session');
  session.command('list')
    .description('List sessions on the local runtime')
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((options, command) => handlers.sessionNames?.('list', {}, localRuntimeOptionsFrom(options, command)));

  session.command('rename <session-id> <name>')
    .description('Rename a session on the local runtime')
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((sessionId, name, options, command) => handlers.sessionNames?.('rename', { sessionId, name }, localRuntimeOptionsFrom(options, command)));

  session.command('reset-name <session-id>')
    .description('Reset custom name of a session on the local runtime')
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((sessionId, options, command) => handlers.sessionNames?.('reset-name', { sessionId }, localRuntimeOptionsFrom(options, command)));

  session.command('herdr [args...]')
    .description('Prepare or operate the current session’s dedicated Herdr side workspace')
    .passThroughOptions()
    .allowUnknownOption()
    .allowExcessArguments()
    .addHelpText('after', herdrHelp)
    .action((_args, _options, command) => handlers.sessionHerdr?.(command.args));
  session.command('native-ask')
    .description('Bridge a native Claude AskUserQuestion hook from stdin to the current session')
    .action(() => handlers.sessionNativeAsk?.());
  session.command('permission-hook')
    .description('Bridge a native Claude PermissionRequest hook from stdin to Dutydeck approval')
    .action(() => handlers.sessionPermissionHook?.());
  session.command('send')
    .description('Publish an in-turn progress event; presentation depends on session settings')
    .argument('<text>', 'Message content')
    .action(text => handlers.sessionSend?.(text));
  session.command('ask')
    .description('Ask the user a question and block until they answer')
    .argument('<question>', 'Question to ask')
    .option('--timeout <seconds>', 'Seconds to wait for an answer (default: 300)')
    .option('--choices <json>', 'JSON array of {label, value?} options; card selections return value or label, text replies return verbatim')
    .option('--multiple', 'Allow multiple selections (requires --choices)')
    .option('--json', 'Print the full result as JSON instead of the bare answer')
    .action((question, options) => handlers.sessionAsk?.(question, options))
    .addHelpText('after', `
Exit codes:
  0    answered — the answer is printed to stdout
  2    usage error (missing session credentials, bad arguments)
  3    relay unavailable (server unreachable, session ended, question cancelled)
  124  timed out with no answer

Examples:
  $ dutydeck session send "已完成迁移，正在跑回归"
  $ answer=$(dutydeck session ask "要继续发布吗？") && echo "user said: $answer"
  $ dutydeck session ask "选哪个方案？" --choices '[{"label":"方案甲","value":"a"},{"label":"方案乙","value":"b"}]' --timeout 60
  $ dutydeck session ask "要检查哪些项？" --choices '[{"label":"代码"},{"label":"文档"}]' --multiple --json`);

  // canonical 命令是 `dutydeck migrate`；`dutydeck botmux` 保留为兼容别名，二者行为完全一致。
  // 别名输出的 JSON command 字段必须保持历史值（botmux.discover/plan/archive），由 action 按 invokedAs 区分。
  const addMigrateCommands = (parent: Command, invokedAs: 'migrate' | 'botmux') => {
    addLegacySourceOptions(parent.command('discover')
      .description('Discover and classify source artifacts without changing either system')
      .option('--output <file>', 'Write the redacted report to a new private file'))
      .action(options => handlers.legacyDiscover?.({ ...options, invokedAs }));
    addLegacySourceOptions(parent.command('plan')
      .description('Create a redacted NO_GO migration plan without writing Dutydeck data')
      .option('--output <file>', 'Write the redacted manifest to a new private file'))
      .action(options => handlers.legacyPlan?.({ ...options, invokedAs }));
    addLegacySourceOptions(parent.command('archive')
      .description('Copy eligible artifacts into a new encrypted private archive')
      .requiredOption('--output <directory>', 'New private archive directory')
      .option('--passphrase-fd <fd>', 'Read the archive passphrase from an explicitly supplied file descriptor'))
      .action(options => handlers.legacyArchive?.({ ...options, invokedAs }));
  };
  const migrate = program.command('migrate').description('Inspect legacy Botmux data with the read-only migration importer');
  addMigrateCommands(migrate, 'migrate');
  const botmux = program.command('botmux').description('Deprecated alias for `dutydeck migrate`');
  addMigrateCommands(botmux, 'botmux');

  const secret = program.command('secret').description('Manage local SecretRef metadata and encrypted-channel credentials without printing values');
  secret.command('list')
    .description('List SecretRef metadata and file availability; never prints secret values')
    .action((options, command) => handlers.secretList?.(serverOptionsFrom(options, command)));
  secret.command('set')
    .description('Create a local Lark credential SecretRef from hidden TTY input or --value-fd')
    .argument('<id>', 'Opaque SecretRef ID')
    .option('--value-fd <fd>', 'Read strict credential bundle JSON from an inherited file descriptor')
    .action((id, options, command) => handlers.secretSet?.(id, serverOptionsFrom(options, command)));
  secret.command('rotate')
    .description('Conditionally rotate a local Lark credential SecretRef')
    .argument('<id>', 'Opaque SecretRef ID')
    .requiredOption('--expected-revision <revision>', 'Current SecretRef revision for CAS')
    .option('--value-fd <fd>', 'Read strict credential bundle JSON from an inherited file descriptor')
    .action((id, options, command) => handlers.secretRotate?.(id, serverOptionsFrom(options, command) as SecretRotateCliOptions));
  secret.command('remove')
    .description('Remove an unreferenced local SecretRef and its value')
    .argument('<id>', 'Opaque SecretRef ID')
    .requiredOption('--expected-revision <revision>', 'Current SecretRef revision for CAS')
    .action((id, options, command) => handlers.secretRemove?.(id, serverOptionsFrom(options, command) as SecretRemoveCliOptions));

  const plugin = program.command('plugin').description('Install and manage Dutydeck plugins (commands, agents, skills, triggers, hooks, providers)');
  const pluginOptions = (options: PluginCliOptions, command: Command): PluginCliOptions => {
    const database = command.optsWithGlobals().database;
    return { ...options, ...(typeof database === 'string' ? { database } : {}) };
  };
  plugin.command('install <source>')
    .description('Install from a local directory, a git URL (git+https://…, git@…, file://…; #ref pins a branch, tag or commit) or an npm package (npm:name@version)')
    .option('--scope <scope>', 'global, bot:<appId> or workspace:<path>', 'global')
    .option('--yes', 'Trust the hooks and providers the plugin declares without prompting')
    .option('--json', 'Print the result as a single line of JSON')
    .action((source, options, command) => handlers.plugin?.('install', [source], pluginOptions(options, command)));
  plugin.command('uninstall <name>').description('Remove an installed plugin, its trigger tokens and its configuration')
    .option('--json', 'Print the result as a single line of JSON')
    .action((name, options, command) => handlers.plugin?.('uninstall', [name], pluginOptions(options, command)));
  plugin.command('enable <name>').description('Enable an installed plugin (takes effect after dutydeck restart)')
    .option('--json', 'Print the result as a single line of JSON')
    .action((name, options, command) => handlers.plugin?.('enable', [name], pluginOptions(options, command)));
  plugin.command('disable <name>').description('Disable a plugin without removing it (takes effect after dutydeck restart)')
    .option('--json', 'Print the result as a single line of JSON')
    .action((name, options, command) => handlers.plugin?.('disable', [name], pluginOptions(options, command)));
  plugin.command('list').description('List installed plugins with their source, pinned version and problems')
    .option('--json', 'Print the result as a single line of JSON')
    .action((options, command) => handlers.plugin?.('list', [], pluginOptions(options, command)));
  plugin.command('update [name]').description('Stage an immutable candidate without changing the active version; trust new capabilities')
    .option('--yes', 'Trust newly added hooks and providers without prompting')
    .option('--json', 'Print the result as a single line of JSON')
    .action((name, options, command) => handlers.plugin?.('update', name ? [name] : [], pluginOptions(options, command)));
  for (const action of ['activate', 'rollback', 'status'] as const) plugin.command(`${action} <name>`)
    .description(action === 'status' ? 'Show selected, candidate, live Host generations and activation blockers' : `${action === 'activate' ? 'Activate a staged candidate' : 'Restore the previous artifact'} while all affected runtimes are stopped and no recovery dependencies remain`)
    .option('--json', 'Print the result as a single line of JSON')
    .action((name, options, command) => handlers.plugin?.(action, [name], pluginOptions(options, command)));
  plugin.command('validate <path>').description('Check a plugin directory and report every problem with its file and field')
    .option('--json', 'Print the result as a single line of JSON')
    .action((path, options, command) => handlers.plugin?.('validate', [path], pluginOptions(options, command)));
  plugin.command('init <name>').description('Create a plugin template')
    .option('--dir <path>', 'Target directory (default: ./<name>)')
    .option('--json', 'Print the result as a single line of JSON')
    .action((name, options, command) => handlers.plugin?.('init', [name], pluginOptions(options, command)));
  plugin.command('trigger-token <trigger>').description('Show (or create) the token of <plugin>/<trigger>; used as the request token or HMAC key')
    .option('--rotate', 'Replace the token; the old one stops working immediately')
    .option('--json', 'Print the result as a single line of JSON')
    .action((trigger, options, command) => handlers.plugin?.('trigger-token', [trigger], pluginOptions(options, command)));
  plugin.command('config <name> <key>').description('Set a userConfig value; sensitive values go to the local secret store')
    .option('--value <value>', 'Value for a non-sensitive key')
    .option('--value-fd <fd>', 'Read the value from this file descriptor (0 = stdin)')
    .option('--json', 'Print the result as a single line of JSON')
    .action((name, key, options, command) => handlers.plugin?.('config', [name, key], pluginOptions(options, command)));

  program.command('update')
    .description('Update the global Dutydeck package and restart the background service')
    .option('--dist-tag <tag>', 'npm dist-tag to install (default: latest)', 'latest')
    .option('--force', 'Skip waiting for running tasks and restart immediately')
    .option('--drain-timeout <seconds>', 'Maximum seconds to wait for running tasks before aborting restart (default: 900)')
    .action(options => handlers.update?.(options));

  const deploy = program.command('deploy')
    .description('Deploy a built checkout as a versioned release: drain, switch releases/current, restart, health-check, and roll back only if the database schema is unchanged (never restore an old database snapshot)')
    .option('--source <directory>', 'Built Dutydeck checkout to deploy (default: the repository containing the current directory)')
    .option('--unit <unit>', 'systemd user unit that runs releases/current (default: dutydeck.service, or "unit" from --runtime deployment.json)')
    .option('--runtime <directory>', 'Bot runtime directory whose deployment.json supplies the address, database and unit')
    .option('--releases <directory>', 'Directory holding versioned releases and the current pointer (default: derived from the unit ExecStart)')
    .option('--port <port>', 'Port used for draining and the health check (default: from deployment.json or the unit)')
    .option('--node <path>', 'Node.js used to trial-load the release (default: the unit ExecStart interpreter)')
    .option('--no-restart', 'Only prepare the release and switch current; do not drain or restart')
    .option('--print-unit', 'Print the unit file rewritten to run releases/current, without changing anything')
    .option('--now', 'Deploy even outside DUTYDECK_DEPLOY_WINDOW')
    .option('--force', 'Skip waiting for running tasks and restart immediately')
    .option('--drain-timeout <seconds>', 'Maximum seconds to wait for running tasks before aborting (default: 900)')
    .option('--json', 'Print the result as a single line of JSON')
    // --port 会被根命令同名的服务选项截获，从合并后的全局选项里取回来。
    .action((options, command) => {
      const port = command.optsWithGlobals().port;
      return handlers.deploy?.({ ...options, ...(typeof port === 'string' ? { port } : {}) });
    });

  deploy.command('prune')
    .description('Delete old releases and deployment records (including database backups) beyond the newest N; never touches current, its previous release, or releases still referenced by running processes')
    .option('--unit <unit>', 'systemd user unit that runs releases/current (default: dutydeck.service, or "unit" from --runtime deployment.json)')
    .option('--runtime <directory>', 'Bot runtime directory whose deployment.json supplies the unit')
    .option('--releases <directory>', 'Directory holding versioned releases and the current pointer (default: derived from the unit ExecStart)')
    .option('--keep <count>', 'Newest releases and deployment records to keep (default: 5)')
    .option('--include-unmarked', 'Also prune deployment records left by manual deployments (no "created_by": "dutydeck deploy" in manifest.json); skipped when still referenced by a process or modified within the last hour')
    .option('--dry-run', 'List what would be deleted and the disk space it would free, without deleting anything')
    .option('--json', 'Print the result as a single line of JSON')
    // 与 deploy 同名的选项会被父命令截获，从合并后的全局选项里取回来。
    .action((_options, command) => {
      const merged = command.optsWithGlobals();
      const text = (value: unknown) => typeof value === 'string' ? value : undefined;
      return handlers.deployPrune?.({
        ...(text(merged.unit) ? { unit: text(merged.unit) } : {}), ...(text(merged.runtime) ? { runtime: text(merged.runtime) } : {}),
        ...(text(merged.releases) ? { releases: text(merged.releases) } : {}), ...(text(merged.keep) ? { keep: text(merged.keep) } : {}),
        dryRun: merged.dryRun === true, includeUnmarked: merged.includeUnmarked === true, json: merged.json === true
      });
    });

  const auth = program.command('auth').description('Manage access authentication');
  auth.command('token')
    .description('Print the access token for remote API access (generates one on first use)')
    .option('--rotate', 'Generate a new token, invalidating the previous one')
    .action(options => handlers.authToken?.(options));
  auth.command('password').description('Manage the dashboard password used by browsers')
    .command('set')
    .description('Set or reset the dashboard password (reads stdin, or prompts twice on a terminal); only a scrypt hash is stored')
    .option('--generate', 'Generate a random password and print it once')
    .action(options => handlers.authPasswordSet?.(options));
  auth.command('share-key').description('Manage the key that signs Feishu card share links')
    .command('rotate')
    .description('Rotate the share-link signing key; every previously sent share link stops working')
    .action(() => handlers.authShareKeyRotate?.());

  const database = program.command('database').description('Inspect and upgrade Dutydeck execution database ledger');
  database.command('execution-status')
    .description('Inspect the execution schema and authority of a database in read-only mode')
    .option('--database <path>', 'SQLite database path')
    .action((options, command) => handlers.databaseExecutionStatus?.(databaseOptionsFrom(options, command)));
  database.command('upgrade-execution')
    .description('Upgrade a legacy Dutydeck database to execution ledger_v1 under maintenance isolation')
    .option('--database <path>', 'SQLite database path')
    .action((options, command) => handlers.databaseUpgradeExecution?.(databaseOptionsFrom(options, command)));
  database.command('retire-legacy')
    .description('Verify and archive migrated legacy sessions under maintenance isolation')
    .option('--database <path>', 'SQLite database path')
    .option('--hostname <hostname>', 'Exact hostname of the stopped legacy service')
    .option('--uid <uid>', 'Exact numeric uid of the stopped legacy service')
    .option('--tmux-socket <path>', 'Exact tmux socket used by legacy PTY sessions')
    .option('--acpx-directory <path>', 'Trusted migrated acpx directory for legacy ACP metadata')
    .action((options, command) => handlers.databaseRetireLegacy?.(databaseRetirementOptionsFrom(options, command)));

  const groups = program.command('workspace-groups').description('Manage workspace display grouping and assignments');

  groups.command('list')
    .description('List workspace groups, directory rules, and session assignments')
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((options, command) => handlers.workspaceGroups?.('list', {}, localRuntimeOptionsFrom(options, command)));

  groups.command('create <name>')
    .description('Create a new workspace group')
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((name, options, command) => handlers.workspaceGroups?.('create', { name }, localRuntimeOptionsFrom(options, command)));

  groups.command('rename <group-id> <name>')
    .description('Rename an existing workspace group')
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((groupId, name, options, command) => handlers.workspaceGroups?.('rename', { groupId, name }, localRuntimeOptionsFrom(options, command)));

  groups.command('delete <group-id>')
    .description('Delete a workspace group, preserving sessions and falling back to directory rules')
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((groupId, options, command) => handlers.workspaceGroups?.('delete', { groupId }, localRuntimeOptionsFrom(options, command)));

  groups.command('move <group-id> [session-ids...]')
    .description('Assign sessions and/or directories to a workspace group')
    .option('--directory <path>', 'Directory absolute path to assign; repeatable', collectDirectories, [])
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((groupId, sessionIds, options, command) => handlers.workspaceGroups?.('move', { groupId, sessionIds: Array.isArray(sessionIds) ? sessionIds : (sessionIds ? [sessionIds] : []) }, localRuntimeOptionsFrom(options, command)));

  groups.command('reset [session-ids...]')
    .description('Reset session manual overrides and/or directory assignments')
    .option('--directory <path>', 'Directory absolute path to reset; repeatable', collectDirectories, [])
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((sessionIds, options, command) => handlers.workspaceGroups?.('reset', { sessionIds: Array.isArray(sessionIds) ? sessionIds : (sessionIds ? [sessionIds] : []) }, localRuntimeOptionsFrom(options, command)));

  const addProcessCommands = (parent: Command) => {
    parent.command('start')
      .description('Start the Dutydeck server in the background')
      .option('--foreground', 'Serve in this process as the daemon and record its state (used by the systemd unit)')
      .option('--json', 'Print the result as a single line of JSON')
      .action((options, command) => handlers.daemonStart?.(serverOptionsFrom(options, command)));
    parent.command('stop')
      .description('Stop the background Dutydeck server')
      .option('--json', 'Print the result as a single line of JSON')
      .action(options => handlers.daemonStop?.(options));
    parent.command('restart')
      .description('Restart the background Dutydeck server')
      .option('--force', 'Skip waiting for running tasks and restart immediately')
      .option('--drain-timeout <seconds>', 'Maximum seconds to wait for running tasks before aborting restart (default: 900)', '900')
      .option('--unit <unit>', 'Restart the runtime managed by this systemd user unit, e.g. a bot runtime')
      .option('--json', 'Print the result as a single line of JSON')
      .action((options, command) => handlers.daemonRestart?.(serverOptionsFrom(options, command)));
    parent.command('status')
      .description('Show whether the background Dutydeck server is running')
      .option('--json', 'Print the result as a single line of JSON')
      .action(options => handlers.daemonStatus?.(options));
  };

  // Both the top-level `dutydeck start/stop/restart/status` (no prefix) and the
  // `dutydeck daemon start/.../status` group are supported and share one implementation.
  addProcessCommands(program);
  const daemon = program.command('daemon').description('Run the Dutydeck server in the background and manage it');
  addProcessCommands(daemon);

  registerPluginResultCli(program);
  registerBusinessToolCli(program);
  return program
    .addHelpText('after', `
Getting started:
  $ dutydeck setup
  $ dutydeck doctor
  $ dutydeck autostart enable

Examples:
  $ dutydeck
  $ dutydeck --local-only
  $ dutydeck --host 0.0.0.0 --no-auth
  $ dutydeck --cwd /path/to/project --port 4310
  $ dutydeck start --port 4310
  $ dutydeck status
  $ dutydeck restart --port 4410
  $ dutydeck restart --force
  $ dutydeck restart --unit dutydeck-tag-ccflash.service
  $ dutydeck deploy --source /path/to/built-checkout
  $ dutydeck deploy --print-unit
  $ dutydeck deploy prune --dry-run
  $ dutydeck update --dist-tag fix
  $ dutydeck auth token
  $ dutydeck auth token --rotate
  $ dutydeck auth password set
  $ dutydeck auth password set --generate
  $ dutydeck auth share-key rotate
  $ dutydeck stop
  $ dutydeck daemon start --port 4310
  $ dutydeck daemon status
  $ dutydeck acpk agents list --json
  $ dutydeck lark create "CCFlash 助手" --agent ccflash --listen
  $ dutydeck lark send "**任务已完成**"
  $ dutydeck lark update "**最新结果**" --message-id om_xxx
  $ dutydeck lark preflight bot-id --group-binding binding-id
  $ dutydeck group peers
  $ dutydeck group members
  $ dutydeck group send "请检查接口" --to cli_peer
  $ dutydeck session send "已完成迁移，正在跑回归"
  $ dutydeck session ask "要继续发布吗？"
  $ dutydeck migrate discover --source-home /tmp/legacy-fixture --json
  $ dutydeck migrate plan --source-home /tmp/legacy-fixture --output /tmp/redacted-plan.json
  $ dutydeck settings bot list
  $ dutydeck settings bot set cli_xxx mentionPolicy=topic
  $ dutydeck workspace-groups list
  $ dutydeck workspace-groups create "项目 A"
  $ dutydeck workspace-groups move <group-id> --directory /path/to/repo
  $ dutydeck workspace-groups reset [session-id]
  $ dutydeck migrate archive --source-home /tmp/legacy-fixture --output /tmp/private-archive
  $ dutydeck plugin install ./my-plugin
  $ dutydeck plugin trigger-token my-plugin/deploy
  $ dutydeck secret list
  $ dutydeck secret set team-bot --value-fd 0
  $ dutydeck secret rotate team-bot --expected-revision 1 --value-fd 0
  $ dutydeck database execution-status --database /path/to/dutydeck.db
  $ dutydeck database upgrade-execution --database /path/to/dutydeck.db
  $ dutydeck database retire-legacy --database /path/to/dutydeck.db --hostname host-a --uid 1001 --tmux-socket /tmp/tmux-1001/default --acpx-directory /path/to/acpx
  $ dutydeck --version`);
}

export function environmentFromCli(options: CliOptions, base: NodeJS.ProcessEnv = process.env) {
  const env = { ...base };
  if (options.host !== undefined) env.DUTYDECK_HOST = options.host;
  if (options.localOnly === true) env.DUTYDECK_LOCAL_ONLY = 'true';
  if (options.auth !== undefined) env.DUTYDECK_AUTH = String(options.auth);
  if (options.unsafeNoAuth === true) {
    env.DUTYDECK_AUTH = 'false';
    env.DUTYDECK_UNSAFE_NO_AUTH = 'true';
  }
  if (options.port !== undefined) env.DUTYDECK_PORT = options.port;
  if (options.cwd !== undefined) env.DUTYDECK_DEFAULT_CWD = options.cwd;
  if (options.database !== undefined) env.DUTYDECK_DATABASE_URL = options.database;
  if (options.botAppId !== undefined) env.DUTYDECK_BOT_APP_ID = options.botAppId;
  if (options.idleTimeoutMs !== undefined) env.DUTYDECK_DRIVER_IDLE_TIMEOUT_MS = options.idleTimeoutMs;
  if (options.cleanupIntervalMs !== undefined) env.DUTYDECK_CLEANUP_INTERVAL_MS = options.cleanupIntervalMs;
  if (options.larkAppId !== undefined) env.LARK_APP_ID = options.larkAppId;
  if (options.larkAppSecret !== undefined) env.LARK_APP_SECRET = options.larkAppSecret;
  if (options.larkReceiveId !== undefined) env.LARK_RECEIVE_ID = options.larkReceiveId;
  if (options.larkChatId !== undefined) env.LARK_CHAT_ID = options.larkChatId;
  if (options.larkReceiveIdType !== undefined) env.LARK_RECEIVE_ID_TYPE = options.larkReceiveIdType;
  if (options.larkAgentName !== undefined) env.LARK_AGENT_NAME = options.larkAgentName;
  if (options.larkBaseUrl !== undefined) env.LARK_OPEN_API_BASE_URL = options.larkBaseUrl;
  if (options.larkListen === false) env.DUTYDECK_DISABLE_LARK_LISTENER = 'true';
  return env;
}
