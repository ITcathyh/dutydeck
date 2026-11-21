import { open } from 'node:fs/promises';
import type { AgentGroupCliOptions, HistoryShowCliOptions } from '../cli-program.js';
import { AgentGroupToolHttpClient, type GroupToolClientOptions } from '../agent-host/http-client.js';
import { otherEndpoints } from '../agent-host/tool-table.js';

export { AgentGroupToolCliError, AgentGroupToolHttpClient } from '../agent-host/http-client.js';

// Legacy URLs put limit first in history and omit empty filters.
const legacyQuery = (options: AgentGroupCliOptions) => {
  const query = new URLSearchParams();
  for (const key of ['after', 'limit', 'timeoutMs', 'since', 'until', 'query'] as const) {
    if (options[key]) query.set(key, options[key]);
  }
  return query.size ? '?' + query : '';
};

// Old send commands omit empty string options and false flags from the JSON body.
const sendOptions = (options: AgentGroupCliOptions) => Object.fromEntries(Object.entries(options).filter(([, value]) => value));

export function runGroupSelf(options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('group.self');
}

export function runGroupPeers(options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('group.peers');
}

export function runGroupMembers(options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('group.members');
}

export function runGroupBots(options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('group.bots');
}

export function runGroupMessages(cliOptions: AgentGroupCliOptions, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('group.messages', [], cliOptions, legacyQuery(cliOptions));
}

export function runGroupMessage(messageId: string, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('group.message', [messageId]);
}

export function runGroupTeamSearch(query: string, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('group.team-search', [query]);
}

export function runHistoryList(cliOptions: AgentGroupCliOptions, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('history.list', [], cliOptions, legacyQuery(cliOptions));
}

export function runHistoryShow(taskId: string, options: GroupToolClientOptions = {}, range: HistoryShowCliOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('history.show', [taskId], range);
}

export function runGroupWait(cliOptions: AgentGroupCliOptions, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('group.wait', [], cliOptions, legacyQuery(cliOptions));
}

export async function runGroupSend(content: string, cliOptions: AgentGroupCliOptions, options: GroupToolClientOptions = {}) {
  let cardBody: unknown;
  if (cliOptions.cardFile) {
    const file = await open(cliOptions.cardFile, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 28_000) throw new Error('--card-file requires a regular JSON file under 28 KB');
      cardBody = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
  }
  return new AgentGroupToolHttpClient(options).callLegacy('group.send', [content], { ...sendOptions(cliOptions), cardBody });
}

export function runGroupSendFile(path: string, cliOptions: AgentGroupCliOptions, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('group.send-file', [path], sendOptions(cliOptions));
}

export function runGroupHandoff(target: string, content: string, cliOptions: { turn: string }, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('group.handoff', [target, content], cliOptions);
}

/** 替这一轮发起人发一条飞书 / 命令（见 agent-request-tools.ts）：查看类直接出结果卡，会改东西的先发确认卡。 */
export function runAgentCommand(command: string, cliOptions: { turn: string }, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).call(otherEndpoints.command, [], {
    headers: { 'x-dutydeck-work-turn': cliOptions.turn },
    body: JSON.stringify({ command })
  });
}

export function runGroupReplyAgent(content: string, cliOptions: { turn: string }, options: GroupToolClientOptions = {}) {
  return new AgentGroupToolHttpClient(options).callLegacy('group.reply-agent', [content], cliOptions);
}
