import type { RecoveryCliOptions, RecoveryOperation } from './recovery-cli.js';
import type { WorkspaceGroupsAction } from './workspace-groups-cli.js';
import { Command } from 'commander';
import { DatabaseCliError } from './database-cli.js';

export interface CliOptions {
  host?: string;
  localOnly?: boolean;
  auth?: boolean;
  port?: string;
  cwd?: string;
  database?: string;
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

export interface AgentGroupCliOptions {
  final?: boolean;
  turn?: string;
  after?: string;
  limit?: string;
  timeoutMs?: string;
  to?: string;
  replyTo?: string;
  inThread?: boolean;
  idempotencyKey?: string;
  image?: boolean;
}

export interface UpdateCliOptions {
  distTag?: string;
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

export interface CliHandlers {
  recovery?(operation: RecoveryOperation, sessionId: string, options: RecoveryCliOptions): void | Promise<void>;
  collaborate?(operation: string, id: string | undefined, options: { json?: string; file?: string; turn?: string }): void | Promise<void>;
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
  authToken?(options: AuthTokenCliOptions): void | Promise<void>;
  legacyDiscover?(options: LegacySourceCliOptions): void | Promise<void>;
  legacyPlan?(options: LegacySourceCliOptions): void | Promise<void>;
  legacyArchive?(options: LegacyArchiveCliOptions): void | Promise<void>;
  secretList?(options: SecretListCliOptions): void | Promise<void>;
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
  groupReplyAgent?(content: string, options: { turn: string }): void | Promise<void>;
  groupSendFile?(path: string, options: AgentGroupCliOptions): void | Promise<void>;
  groupWait?(options: AgentGroupCliOptions): void | Promise<void>;
  memoryList?(options?: { topic?: string }): void | Promise<void>;
  memoryShow?(topic: string): void | Promise<void>;
  memorySearch?(query: string, options?: { topic?: string; limit?: string }): void | Promise<void>;
  memoryAdd?(content: string, options?: { topic?: string }): void | Promise<void>;
  memoryRemove?(id: string): void | Promise<void>;
  sessionSend?(text: string): void | Promise<void>;
  sessionAsk?(question: string, options: SessionRelayCliOptions): void | Promise<void>;
  sessionNativeAsk?(): void | Promise<void>;
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
  .option('--port <port>', 'Bind port (default: 4310)')
  .option('--cwd <directory>', 'Default Agent working directory')
  .option('--database <file>', 'SQLite database path')
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

const workspaceGroupsOptionsFrom = (options: WorkspaceGroupsCommandOptions, command: Command): WorkspaceGroupsCommandOptions => {
  const merged = { ...command.optsWithGlobals(), ...options } as Record<string, unknown>;
  const result: WorkspaceGroupsCommandOptions = { ...options };
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
    .name('dutydeck')
    .description('Run the Dutydeck local session server')
    .version(version, '-V, --version', 'Show the installed version');

  addServerOptions(program)
    .showHelpAfterError();

  program.action(options => handlers.serve?.(options));

  const recovery = program.command('recovery').description('Inspect and explicitly reconcile execution on the local runtime');
  for (const operation of ['inspect', 'probe', 'confirm', 'retire-pty', 'replace-native'] as const) {
    const command = recovery.command(`${operation} <session-id>`)
      .option('--url <url>', 'Exact local runtime URL; requires --database')
      .option('--database <path>', 'Exact runtime database, opened read-only for its auth token');
    if (operation === 'probe') command.requiredOption('--run-id <id>', 'Exact run ID from recovery inspect');
    if (['confirm', 'retire-pty', 'replace-native'].includes(operation)) command.requiredOption('--file <path>', 'Reviewed decision JSON, including revisions and evidence');
    command.action((sessionId, options, cmd) => handlers.recovery?.(operation, sessionId, { ...options,
      ...(cmd.optsWithGlobals().database ? { database: cmd.optsWithGlobals().database } : {}) }));
  }

  // 新用户的第一条命令。放在最前面是刻意的：`dutydeck --help` 第一眼就该看到它。
  //
  // 注意 --cwd / --port / --local-only / --lark-app-id 在根命令上也有同名同义的定义，
  // commander 会把它们路由到定义处（即根命令），所以这里必须读合并后的 globals，
  // 否则 `dutydeck setup --cwd X` 里的 X 会落到根命令上、setup 拿到 undefined。
  program.command('setup')
    .description('Guided first-run setup: detect Agent CLIs, choose a working directory, optionally bind a Lark bot')
    .option('--yes', 'Accept defaults without prompting; the only way to skip the Lark publish confirmation')
    .option('--json', 'Emit a single JSON line and never prompt or render a QR code (secrets are masked)')
    .option('--cwd <directory>', 'Default Agent working directory; skips that question')
    .option('--port <port>', 'Bind port to write into the configuration (default: 4310)')
    .option('--local-only', 'Only accept connections from this computer (127.0.0.1)')
    .option('--lark-app-id <id>', 'Lark app ID (cli_*) to configure and bind')
    .option('--skip-lark', 'Skip the Lark binding step entirely')
    .option('--force-login', 'Re-scan the Lark open-platform QR code to switch accounts')
    .action((options, command) => handlers.setup?.(setupOptionsFrom(options, command)))
    .addHelpText('after', `
Behaviour:
  幂等可重跑：检测到已有配置时逐项询问「保留或更新」，配置无变化则报告无需改动。
  中途失败或取消不会写入半份配置，并会打印一条算好的续跑命令。
  --json 隐含「绝不提问、绝不渲染二维码」；非交互环境请用字段 flag 或 --yes。

Examples:
  $ dutydeck setup
  $ dutydeck setup --cwd /path/to/project --port 4310
  $ dutydeck setup --lark-app-id cli_xxx
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

  const work = program.command('work').description('Arrange durable goals, Agent steps and reusable workflows in the current Feishu conversation').requiredOption('--turn <token>', 'Current task capability supplied by Dutydeck');
  const workOptions = (options: { file?: string; key?: string } = {}) => ({ ...options, turn: work.opts().turn as string });
  for (const operation of ['list', 'templates', 'agents', 'skills']) work.command(operation).action(() => handlers.work?.(operation, [], workOptions()));
  work.command('show <id>').action(id => handlers.work?.('show', [id], workOptions()));
  work.command('create').requiredOption('--file <path>', 'JSON plan with goal and a stable idempotencyKey').action(options => handlers.work?.('create', [], workOptions(options)));
  work.command('delegate').requiredOption('--file <path>', 'JSON brief with goal, context and a stable idempotencyKey').action(options => handlers.work?.('delegate', [], workOptions(options)));
  work.command('save <id> <name>').action((id, name) => handlers.work?.('save', [id, name], workOptions()));
  work.command('run <template> <version> <goal>').requiredOption('--key <key>', 'Stable request key for this run').action((id, version, goal, options) => handlers.work?.('run', [id, version, goal], workOptions(options)));

  const group = program.command('group').description('Collaborate with Agents in the current Lark group');
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
    .action(options => handlers.groupMessages?.(options));
  group.command('message')
    .description('Fetch a single message by ID, expanding merge_forward (合并转发) content')
    .argument('<message-id>', 'om_* message ID to fetch')
    .action((messageId) => handlers.groupMessage?.(messageId));
  group.command('send')
    .description('Send a new group message or reply to an existing message/thread')
    .option('--final', 'Deliver the final answer for the current task')
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

  // 会话记忆：与 group 同一套 capability，但对私聊和关闭群协作的机器人同样可用。
  program.command('collaborate <operation> [id]').description('Manage generic group follow-ups and ongoing mandates')
    .option('--json <json>', 'Structured operation parameters').option('--file <path>', 'Read operation parameters from JSON file')
    .requiredOption('--turn <token>', 'Current task authorization token')
    .action((operation, id, options) => handlers.collaborate?.(operation, id, options));

  const memory = program.command('memory').description('Read and maintain the long-term memory of the current Lark chat');
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
  const session = program.command('session').description('Relay messages to the user who owns the current Dutydeck session');
  session.command('native-ask')
    .description('Bridge a native Claude AskUserQuestion hook from stdin to the current session')
    .action(() => handlers.sessionNativeAsk?.());
  session.command('send')
    .description('Push a message to the user now, without waiting for the turn to end')
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

  program.command('update')
    .description('Update the global Dutydeck package and restart the background service')
    .option('--dist-tag <tag>', 'npm dist-tag to install (default: latest)', 'latest')
    .action(options => handlers.update?.(options));

  const auth = program.command('auth').description('Manage access authentication');
  auth.command('token')
    .description('Print the access token for remote API access (generates one on first use)')
    .option('--rotate', 'Generate a new token, invalidating the previous one')
    .action(options => handlers.authToken?.(options));

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
    .action((options, command) => handlers.workspaceGroups?.('list', {}, workspaceGroupsOptionsFrom(options, command)));

  groups.command('create <name>')
    .description('Create a new workspace group')
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((name, options, command) => handlers.workspaceGroups?.('create', { name }, workspaceGroupsOptionsFrom(options, command)));

  groups.command('rename <group-id> <name>')
    .description('Rename an existing workspace group')
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((groupId, name, options, command) => handlers.workspaceGroups?.('rename', { groupId, name }, workspaceGroupsOptionsFrom(options, command)));

  groups.command('delete <group-id>')
    .description('Delete a workspace group, preserving sessions and falling back to directory rules')
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((groupId, options, command) => handlers.workspaceGroups?.('delete', { groupId }, workspaceGroupsOptionsFrom(options, command)));

  groups.command('move <group-id> [session-ids...]')
    .description('Assign sessions and/or directories to a workspace group')
    .option('--directory <path>', 'Directory absolute path to assign; repeatable', collectDirectories, [])
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((groupId, sessionIds, options, command) => handlers.workspaceGroups?.('move', { groupId, sessionIds: Array.isArray(sessionIds) ? sessionIds : (sessionIds ? [sessionIds] : []) }, workspaceGroupsOptionsFrom(options, command)));

  groups.command('reset [session-ids...]')
    .description('Reset session manual overrides and/or directory assignments')
    .option('--directory <path>', 'Directory absolute path to reset; repeatable', collectDirectories, [])
    .option('--url <url>', 'Exact local runtime URL; requires --database')
    .option('--database <path>', 'Exact runtime database, opened read-only for its auth token')
    .option('--json', 'Print the result as JSON')
    .action((sessionIds, options, command) => handlers.workspaceGroups?.('reset', { sessionIds: Array.isArray(sessionIds) ? sessionIds : (sessionIds ? [sessionIds] : []) }, workspaceGroupsOptionsFrom(options, command)));

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
  $ dutydeck update --dist-tag fix
  $ dutydeck auth token
  $ dutydeck auth token --rotate
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
  $ dutydeck workspace-groups list
  $ dutydeck workspace-groups create "项目 A"
  $ dutydeck workspace-groups move <group-id> --directory /path/to/repo
  $ dutydeck workspace-groups reset [session-id]
  $ dutydeck migrate archive --source-home /tmp/legacy-fixture --output /tmp/private-archive
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
  if (options.port !== undefined) env.DUTYDECK_PORT = options.port;
  if (options.cwd !== undefined) env.DUTYDECK_DEFAULT_CWD = options.cwd;
  if (options.database !== undefined) env.DUTYDECK_DATABASE_URL = options.database;
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
