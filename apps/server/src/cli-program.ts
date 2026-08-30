import { Command } from 'commander';

export interface CliOptions {
  host?: string;
  localOnly?: boolean;
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

export interface AgentGroupCliOptions {
  after?: string;
  limit?: string;
  timeoutMs?: string;
  to?: string;
  replyTo?: string;
  inThread?: boolean;
  idempotencyKey?: string;
}

export interface UpdateCliOptions {
  distTag?: string;
}

export interface SessionRelayCliOptions {
  /** ask 超时秒数 */
  timeout?: string;
  /** 以 JSON 输出结果而非裸答案 */
  json?: boolean;
}

export interface AuthTokenCliOptions {
  rotate?: boolean;
}

export interface CliHandlers {
  serve?(options: CliOptions): void | Promise<void>;
  daemonStart?(options: CliOptions): void | Promise<void>;
  daemonStop?(): void | Promise<void>;
  daemonRestart?(options: CliOptions): void | Promise<void>;
  daemonStatus?(): void | Promise<void>;
  update?(options: UpdateCliOptions): void | Promise<void>;
  authToken?(options: AuthTokenCliOptions): void | Promise<void>;
  larkSend?(markdown: string | undefined, options: LarkCliOptions): void | Promise<void>;
  larkUpdate?(markdown: string | undefined, options: LarkCliOptions): void | Promise<void>;
  groupSelf?(): void | Promise<void>;
  groupPeers?(): void | Promise<void>;
  groupMembers?(): void | Promise<void>;
  groupBots?(): void | Promise<void>;
  groupMessages?(options: AgentGroupCliOptions): void | Promise<void>;
  groupMessage?(messageId: string): void | Promise<void>;
  groupSend?(content: string, options: AgentGroupCliOptions): void | Promise<void>;
  groupWait?(options: AgentGroupCliOptions): void | Promise<void>;
  sessionSend?(text: string): void | Promise<void>;
  sessionAsk?(question: string, options: SessionRelayCliOptions): void | Promise<void>;
}

const addCardOptions = (command: Command) => command
  .option('--state <state>', 'Card state: queued, running, completed, failed, or interrupted', 'completed')
  .option('--read-only', 'Render the card without action buttons')
  .option('--agent-name <name>', 'Agent name shown in the card title')
  .option('--task-name <name>', 'Card subtitle / task name', 'Dockmux')
  .option('--task-id <id>', 'Task identifier shown in the footer')
  .option('--elapsed-seconds <seconds>', 'Elapsed time shown in the footer', '0')
  .option('--app-id <id>', 'Lark app ID; defaults to LARK_APP_ID')
  .option('--app-secret <secret>', 'Lark app secret; defaults to LARK_APP_SECRET')
  .option('--base-url <url>', 'Lark OpenAPI base URL; defaults to LARK_OPEN_API_BASE_URL');

const addServerOptions = (command: Command) => command
  .option('--host <host>', 'Advanced: bind a specific host or interface')
  .option('--local-only', 'Only accept connections from this computer (127.0.0.1)')
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

/**
 * Server options may appear on the root (default serve) or a `daemon start /
 * restart` subcommand. Commander routes them to the command that defined them,
 * so a subcommand reads the merged globals to see flags passed on the same
 * invocation.
 */
const serverOptionsFrom = (options: CliOptions, command: Command): CliOptions => ({ ...command.optsWithGlobals(), ...options });

export function createCliProgram(version: string, handlers: CliHandlers = {}) {
  const program = new Command()
    .name('dockmux')
    .description('Run the Dockmux local session server')
    .version(version, '-V, --version', 'Show the installed version');

  addServerOptions(program)
    .showHelpAfterError();

  program.action(options => handlers.serve?.(options));

  const lark = program.command('lark').description('Send and update Dockmux Lark cards');
  addCardOptions(lark.command('send')
    .description('Send a new Dockmux card')
    .argument('[markdown]', 'Final Markdown or fallback card content')
    .option('--receive-id <id>', 'Recipient ID; defaults to LARK_RECEIVE_ID')
    .option('--chat-id <id>', 'Group chat ID (oc_xxx); defaults to LARK_CHAT_ID')
    .option('--receive-id-type <type>', 'ID type; defaults to LARK_RECEIVE_ID_TYPE'))
    .action((markdown, options) => handlers.larkSend?.(markdown, options));
  addCardOptions(lark.command('update')
    .description('Update an existing Dockmux card in place')
    .argument('[markdown]', 'Final Markdown or fallback card content')
    .requiredOption('--message-id <id>', 'Lark card message ID to update'))
    .action((markdown, options) => handlers.larkUpdate?.(markdown, options));

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
    .description('List all bots in this Lark group (agentId present means managed by this Dockmux instance)')
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
    .argument('<content>', 'Message content')
    .option('--to <target>', 'Mention a discovered Agent or human member by ID or name')
    .option('--reply-to <message-id>', 'Reply to a message in this group')
    .option('--in-thread', 'Place the reply in the topic/thread; requires --reply-to with an om_* message ID')
    .option('--idempotency-key <key>', 'Stable retry key (up to 50 characters)')
    .action((content, options) => handlers.groupSend?.(content, options))
    .addHelpText('after', `
Examples:
  $ dockmux group send "我已定位问题" --reply-to om_xxx --in-thread
  $ dockmux group send "请检查接口" --to cli_peer --reply-to om_xxx --in-thread
  $ dockmux group send "发布窗口已开启"

Routing guidance:
  Continue a discussion or answer a question with --reply-to ... --in-thread.
  Start an independent announcement or task without --reply-to/--in-thread.`);
  group.command('wait')
    .description('Wait briefly for new messages after a cursor')
    .requiredOption('--after <cursor>', 'Cursor returned by messages or wait')
    .option('--limit <count>', 'Maximum messages to return (1-50)', '20')
    .option('--timeout-ms <milliseconds>', 'Long-poll timeout (0-30000)', '15000')
    .action(options => handlers.groupWait?.(options));

  // 通用回传通道：任何来源的会话内 CLI 都能使用，不限飞书。
  // 与 `dockmux group send` 分层并存——group 面向飞书群里的其他人/机器人，
  // session 面向「发起本会话的用户」，落点是会话事件流（Web 时间线 / 卡片）。
  const session = program.command('session').description('Relay messages to the user who owns the current Dockmux session');
  session.command('send')
    .description('Push a message to the user now, without waiting for the turn to end')
    .argument('<text>', 'Message content')
    .action(text => handlers.sessionSend?.(text));
  session.command('ask')
    .description('Ask the user a question and block until they answer')
    .argument('<question>', 'Question to ask')
    .option('--timeout <seconds>', 'Seconds to wait for an answer (default: 300)')
    .option('--json', 'Print the full result as JSON instead of the bare answer')
    .action((question, options) => handlers.sessionAsk?.(question, options))
    .addHelpText('after', `
Exit codes:
  0    answered — the answer is printed to stdout
  2    usage error (missing session credentials, bad arguments)
  3    relay unavailable (server unreachable, session ended, question cancelled)
  124  timed out with no answer

Examples:
  $ dockmux session send "已完成迁移，正在跑回归"
  $ answer=$(dockmux session ask "要继续发布吗？") && echo "user said: $answer"
  $ dockmux session ask "选哪个方案？" --timeout 60 --json`);

  program.command('update')
    .description('Update the global Dockmux package and restart the background service')
    .option('--dist-tag <tag>', 'npm dist-tag to install (default: latest)', 'latest')
    .action(options => handlers.update?.(options));

  const auth = program.command('auth').description('Manage access authentication');
  auth.command('token')
    .description('Print the access token for remote API access (generates one on first use)')
    .option('--rotate', 'Generate a new token, invalidating the previous one')
    .action(options => handlers.authToken?.(options));

  const addProcessCommands = (parent: Command) => {
    parent.command('start')
      .description('Start the Dockmux server in the background')
      .action((options, command) => handlers.daemonStart?.(serverOptionsFrom(options, command)));
    parent.command('stop')
      .description('Stop the background Dockmux server')
      .action(() => handlers.daemonStop?.());
    parent.command('restart')
      .description('Restart the background Dockmux server')
      .action((options, command) => handlers.daemonRestart?.(serverOptionsFrom(options, command)));
    parent.command('status')
      .description('Show whether the background Dockmux server is running')
      .action(() => handlers.daemonStatus?.());
  };

  // Both the top-level `dockmux start/stop/restart/status` (no prefix) and the
  // `dockmux daemon start/.../status` group are supported and share one implementation.
  addProcessCommands(program);
  const daemon = program.command('daemon').description('Run the Dockmux server in the background and manage it');
  addProcessCommands(daemon);

  return program
    .addHelpText('after', `
Examples:
  $ dockmux
  $ dockmux --local-only
  $ dockmux --cwd /path/to/project --port 4310
  $ dockmux start --port 4310
  $ dockmux status
  $ dockmux restart --port 4410
  $ dockmux update --dist-tag fix
  $ dockmux auth token
  $ dockmux auth token --rotate
  $ dockmux stop
  $ dockmux daemon start --port 4310
  $ dockmux daemon status
  $ dockmux acpk agents list --json
  $ dockmux lark send "**任务已完成**"
  $ dockmux lark update "**最新结果**" --message-id om_xxx
  $ dockmux group peers
  $ dockmux group members
  $ dockmux group send "请检查接口" --to cli_peer
  $ dockmux session send "已完成迁移，正在跑回归"
  $ dockmux session ask "要继续发布吗？"
  $ dockmux --version`);
}

export function environmentFromCli(options: CliOptions, base: NodeJS.ProcessEnv = process.env) {
  const env = { ...base };
  if (options.host !== undefined) env.DOCKMUX_HOST = options.host;
  if (options.localOnly === true) env.DOCKMUX_LOCAL_ONLY = 'true';
  if (options.port !== undefined) env.DOCKMUX_PORT = options.port;
  if (options.cwd !== undefined) env.DOCKMUX_DEFAULT_CWD = options.cwd;
  if (options.database !== undefined) env.DOCKMUX_DATABASE_URL = options.database;
  if (options.idleTimeoutMs !== undefined) env.DOCKMUX_DRIVER_IDLE_TIMEOUT_MS = options.idleTimeoutMs;
  if (options.cleanupIntervalMs !== undefined) env.DOCKMUX_CLEANUP_INTERVAL_MS = options.cleanupIntervalMs;
  if (options.larkAppId !== undefined) env.LARK_APP_ID = options.larkAppId;
  if (options.larkAppSecret !== undefined) env.LARK_APP_SECRET = options.larkAppSecret;
  if (options.larkReceiveId !== undefined) env.LARK_RECEIVE_ID = options.larkReceiveId;
  if (options.larkChatId !== undefined) env.LARK_CHAT_ID = options.larkChatId;
  if (options.larkReceiveIdType !== undefined) env.LARK_RECEIVE_ID_TYPE = options.larkReceiveIdType;
  if (options.larkAgentName !== undefined) env.LARK_AGENT_NAME = options.larkAgentName;
  if (options.larkBaseUrl !== undefined) env.LARK_OPEN_API_BASE_URL = options.larkBaseUrl;
  if (options.larkListen === false) env.DOCKMUX_DISABLE_LARK_LISTENER = 'true';
  return env;
}
