import { debuglog } from 'node:util';
import { Option, type Command } from 'commander';
import type { CliHandlers } from '../cli-program.js';
import { workbenchHelp, layeredWorkbenchHelp, collaborationHelp, groupToolsHelp, memoryToolsHelp } from '../agent-tool-help.js';
import { getTool } from './tool-table.js';

const debug = debuglog('dutydeck-agent');
function logged(command: Command, name: string) {
  return command.hook('preAction', () => { debug('legacy %s', name); });
}
function alias(parent: Command, operation: string, args = '') {
  const name = getTool(operation).name.split('.')[1]!;
  return logged(parent.command(args ? name + ' ' + args : name), parent.name() + ' ' + name);
}

// Older sessions have their own argument order, defaults, help and output contract.
export function addLegacyAgentCommands(program: Command, handlers: CliHandlers, agentCommandHelp: () => string, addMemoryManagement: (memory: Command) => void) {
  const work = program.command('work').description('Arrange durable goals, Agent steps and reusable workflows in the current Feishu conversation').requiredOption('--turn <token>', 'Current task capability supplied by Dutydeck');
  work.addHelpText('after', workbenchHelp() + '\n' + layeredWorkbenchHelp());
  const workOptions = (options: { file?: string; key?: string; dryRun?: boolean } = {}) => ({ ...options, turn: work.opts().turn as string });
  for (const operation of ['list', 'templates', 'agents', 'skills']) alias(work, 'work.' + operation).action(() => handlers.work?.(operation, [], workOptions()));
  alias(work, 'work.show', '<id>').action(id => handlers.work?.('show', [id], workOptions()));
  alias(work, 'work.create').addHelpText('after', workbenchHelp()).requiredOption('--file <path>', 'JSON plan with goal and a stable idempotencyKey').action(options => handlers.work?.('create', [], workOptions(options)));
  alias(work, 'work.delegate').addHelpText('after', layeredWorkbenchHelp()).requiredOption('--file <path>', 'JSON brief with goal, context and a stable idempotencyKey').action(options => handlers.work?.('delegate', [], workOptions(options)));
  alias(work, 'work.revise', '<id>').description('Revise the plan of an unfinished goal; widening changes wait for human confirmation').addHelpText('after', workbenchHelp())
    .requiredOption('--file <path>', 'JSON with expectedRevision, the complete new plan and an optional reason')
    .option('--dry-run', 'Only preview which steps are kept, rerun, stopped, removed or added')
    .action((id, options) => handlers.work?.('revise', [id], workOptions(options)));
  alias(work, 'work.save', '<id> <name>').action((id, name) => handlers.work?.('save', [id, name], workOptions()));
  alias(work, 'work.run', '<template> <version> <goal>').requiredOption('--key <key>', 'Stable request key for this run').action((id, version, goal, options) => handlers.work?.('run', [id, version, goal], workOptions(options)));

  const group = program.command('group').description('Collaborate with Agents in the current Lark group').addHelpText('after', groupToolsHelp(true));
  alias(group, 'group.self')
    .description('Show the current Lark Agent and scoped chat')
    .action(() => handlers.groupSelf?.());
  alias(group, 'group.peers')
    .description('Discover configured Agents that are members of this Lark group')
    .action(() => handlers.groupPeers?.());
  alias(group, 'group.members')
    .description('Discover human members in this Lark group')
    .action(() => handlers.groupMembers?.());
  alias(group, 'group.bots')
    .description('List all bots in this Lark group (agentId present means managed by this Dutydeck instance)')
    .action(() => handlers.groupBots?.());
  alias(group, 'group.messages')
    .description('Read messages from this Lark group')
    .option('--after <cursor>', 'Read only messages after a cursor returned by messages or wait')
    .option('--limit <count>', 'Maximum messages to return (1-50)', '20')
    .option('--since <time>', 'Filter messages created after this time (ISO 8601 or unix timestamp)')
    .option('--until <time>', 'Filter messages created before this time (ISO 8601 or unix timestamp)')
    .option('--query <query>', 'Filter messages containing all whitespace-separated keywords (case-insensitive)')
    .action(options => handlers.groupMessages?.(options));
  alias(group, 'group.message')
    .description('Fetch a single message by ID, expanding merge_forward (合并转发) content')
    .argument('<message-id>', 'om_* message ID to fetch')
    .action((messageId) => handlers.groupMessage?.(messageId));
  alias(group, 'group.send')
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
  alias(group, 'group.send-file')
    .description('Send a file from the current session workspace to the scoped Lark group')
    .argument('<path>', 'Path inside the current session workspace')
    .option('--reply-to <message-id>', 'Reply to a message in this group')
    .option('--in-thread', 'Place the reply in the topic/thread')
    .option('--idempotency-key <key>', 'Stable retry key')
    .option('--image', 'Send as an image message (10 MiB limit)')
    .action((path, options) => handlers.groupSendFile?.(path, options));
  alias(group, 'group.handoff')
    .description('Handoff task to another bot in the current group and topic')
    .argument('<target>', 'Target bot name, appId, or openId')
    .argument('<content>', 'Handoff task brief and acceptance criteria')
    .requiredOption('--turn <token>', 'Current task capability supplied by Dutydeck')
    .action((target, content, options) => handlers.groupHandoff?.(target, content, options));
  alias(group, 'group.reply-agent')
    .description('Reply task execution result to the initiating bot in the current group and topic')
    .argument('<content>', 'Execution result to reply')
    .requiredOption('--turn <token>', 'Current task capability supplied by Dutydeck')
    .action((content, options) => handlers.groupReplyAgent?.(content, options));
  alias(group, 'group.wait')
    .description('Wait briefly for new messages after a cursor')
    .requiredOption('--after <cursor>', 'Cursor returned by messages or wait')
    .option('--limit <count>', 'Maximum messages to return (1-50)', '20')
    .option('--timeout-ms <milliseconds>', 'Long-poll timeout (0-30000)', '15000')
    .action(options => handlers.groupWait?.(options));
  alias(group, 'group.team-search')
    .description('Search messages in other Lark groups of this bot (requires group participation in this group)')
    .argument('<query>', 'Keywords to search for')
    .action(query => handlers.groupTeamSearch?.(query));

  const history = program.command('history').description('Review earlier Agent tasks in the current Lark chat');
  alias(history, 'history.list')
    .description('List earlier tasks of this chat, newest first')
    .option('--since <time>', 'Only tasks created after this time (ISO 8601 or unix timestamp)')
    .option('--until <time>', 'Only tasks created before this time (ISO 8601 or unix timestamp)')
    .option('--query <query>', 'Only tasks whose request or answer contains all whitespace-separated keywords (case-insensitive)')
    .option('--limit <count>', 'Maximum tasks to return (1-50)', '20')
    .action(options => handlers.historyList?.(options));
  alias(history, 'history.show')
    .description('Show the request and final answer of an earlier task in this chat')
    .argument('<task-id>', 'Task id returned by history list')
    .option('--field <field>', 'Read saved request or answer verbatim (request|answer)')
    .option('--offset <units>', 'UTF-16 offset; surrogate pairs are kept intact')
    .option('--length <units>', 'Page length in UTF-16 units (1-8000, default 4000)')
    .option('--cursor <cursor>', 'Continue a version-bound page; exclusive with field/offset/length')
    .action((taskId, options) => Object.keys(options).length ? handlers.historyShow?.(taskId, options) : handlers.historyShow?.(taskId));

  // 会话记忆：与 group 同一套 capability，但对私聊和关闭群协作的机器人同样可用。
  logged(program.command('collaborate <operation> [id]'), 'collaborate').addHelpText('after', collaborationHelp('dutydeck collaborate')).description('Manage generic group follow-ups and ongoing mandates')
    .option('--json <json>', 'Structured operation parameters').option('--file <path>', 'Read operation parameters from JSON file')
    .requiredOption('--turn <token>', 'Current task authorization token')
    .action((operation, id, options) => handlers.collaborate?.(operation, id, options));

  logged(program.command('command'), 'command')
    .description('Lark Agent only: run a Dutydeck chat command for this turn\'s requester; commands that change something post a confirm card first')
    .argument('<command>', "Chat command, e.g. '/status' or '/new --agent <id> -- <task>'")
    .requiredOption('--turn <token>', 'Current task authorization token')
    .addHelpText('after', `\nCommands:\n${agentCommandHelp()}`)
    .action((command, options) => handlers.agentCommand?.(command, options));

  const memory = program.command('memory').description('Read chat memory or explicitly manage chat and project memory').addHelpText('after', memoryToolsHelp());
  addMemoryManagement(memory);
  alias(memory, 'memory.list')
    .description('List the memories saved for this chat, with their ids')
    .option('--topic <slug>', 'Filter memories by topic slug')
    .action(options => handlers.memoryList?.(options));
  alias(memory, 'memory.show')
    .description('Show full memories under a specific topic')
    .argument('<topic>', 'Topic slug')
    .action(topic => handlers.memoryShow?.(topic));
  alias(memory, 'memory.search')
    .description('Search memories by keyword')
    .argument('<query>', 'Keyword to search for')
    .option('--topic <slug>', 'Filter by topic slug')
    .option('--limit <count>', 'Maximum entries to return (default: 20, max: 50)')
    .action((query, options) => handlers.memorySearch?.(query, options));
  alias(memory, 'memory.add')
    .description('Save one durable fact, preference or convention for this chat')
    .argument('<content>', 'One-sentence memory (at most 1000 characters)')
    .option('--topic <slug>', 'Topic slug (defaults to general)')
    .action((content, options) => handlers.memoryAdd?.(content, options));
  alias(memory, 'memory.remove')
    .description('Delete a memory of this chat by id')
    .argument('<id>', 'Memory id shown by list (mem_*)')
    .action(id => handlers.memoryRemove?.(id));
}

export function addLegacyScheduleRequest(schedules: Command, handlers: CliHandlers) {
  logged(schedules.command('request'), 'schedule request')
    .description('Lark Agent only: set up a schedule for this turn\'s requester; it starts after they click 启用 on the posted card')
    .requiredOption('--turn <token>', 'Current task authorization token')
    .option('--additional', '确需在本事项另建一个循环计划')
    .requiredOption('--prompt <text>', 'Complete instructions to execute each time')
    .option('--name <name>', 'Short schedule name')
    .option('--every <minutes>', 'Fixed interval in whole minutes')
    .option('--cron <expression>', 'Five-field cron expression, Asia/Shanghai time')
    .option('--at <local-time>', 'Run once at YYYY-MM-DDTHH:mm, Asia/Shanghai time')
    .option('--mode <mode>', 'fresh (default for --every/--cron): run each time in a new conversation without this chat history; session (default for --at): continue in this conversation, only when the user asks for it')
    .action(options => handlers.scheduleRequest?.(options));
}
