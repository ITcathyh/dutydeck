import type { NormalizedDriverEvent } from '@dutydeck/shared';

/** The exec wrapper can contain several native commands. Only an unambiguous
 * open wrapper plus a unified_exec item proves it is an orchestration mirror;
 * overlapping wrappers and legacy-only calls retain their original events. */
export class CodexToolProjection {
  private readonly wrappers = new Map<string, { events: NormalizedDriverEvent[]; covered: boolean }>();
  private finalText: string | undefined;
  constructor(private readonly mapEntry: (entry: any) => NormalizedDriverEvent[] | undefined) {}
  reset(): void { this.wrappers.clear(); this.finalText = undefined; }
  map(entry: any): NormalizedDriverEvent[] | undefined {
    const events = this.mapEntry(entry);
    const p = entry?.payload;
    if ((entry?.type === 'event_msg' && (p?.type === 'task_started' || p?.type === 'turn_started' || p?.type === 'user_message'))
      || (entry?.type === 'response_item' && p?.type === 'message' && p.role === 'user')
      || (entry?.type === 'event_msg' && p?.type === 'item_completed' && p.item?.type === 'UserMessage')) this.finalText = undefined;
    if (entry?.type === 'response_item' && p?.type === 'message' && p.role === 'assistant'
      && (p.phase === 'final' || p.phase === 'final_answer')) {
      const text = events?.find(event => event.type === 'text')?.data?.text;
      if (typeof text === 'string') this.finalText = text;
    }
    if (entry?.type === 'event_msg' && p?.type === 'task_complete') {
      const mirrored = typeof p.last_agent_message === 'string' && p.last_agent_message === this.finalText;
      this.finalText = undefined;
      if (mirrored) return undefined;
    }
    if (entry?.type === 'response_item' && (p?.type === 'function_call' || p?.type === 'custom_tool_call') && p.name === 'exec') {
      const id = events?.[0]?.data?.id;
      if (typeof id === 'string') { this.wrappers.set(id, { events: events!, covered: false }); return undefined; }
    }
    if (entry?.type === 'event_msg' && p?.type === 'item_completed' && p.item?.type === 'CommandExecution'
      && typeof p.item.source === 'string' && p.item.source.startsWith('unified_exec_') && this.wrappers.size === 1) {
      this.wrappers.values().next().value!.covered = true;
    }
    if (entry?.type === 'response_item' && (p?.type === 'function_call_output' || p?.type === 'custom_tool_call_output')) {
      const wrapper = this.wrappers.get(p.call_id);
      if (wrapper) {
        this.wrappers.delete(p.call_id);
        return wrapper.covered ? undefined : [...wrapper.events, ...(events ?? [])];
      }
    }
    return events;
  }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.map(block => typeof block?.text === 'string' ? block.text : outputText(block)).join('\n');
  return JSON.stringify(value);
}

/** Modern native items describe a completed tool, not a completed user turn. */
export function mapCodexCompletedTool(item: any): NormalizedDriverEvent[] | undefined {
  if (!item || typeof item.id !== 'string' || !item.id) return undefined;
  let name: string, input: unknown, output: string;
  switch (item.type) {
    case 'CommandExecution': {
      name = 'exec_command';
      const argv = Array.isArray(item.command) ? item.command.filter((part: unknown) => typeof part === 'string') : [];
      const shell = argv[0]?.split(/[\\/]/).pop();
      const cmd = typeof item.parsed_cmd?.[0]?.cmd === 'string' ? item.parsed_cmd[0].cmd
        : shell && /^(?:sh|bash|zsh|fish)$/.test(shell) && /^-(?:lc|c)$/.test(argv[1] ?? '') ? argv[2] : argv.join(' ');
      input = { cmd, ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}) };
      output = outputText(item.aggregated_output ?? [item.stdout, item.stderr].filter(Boolean).join('\n'));
      break;
    }
    case 'FileChange':
      name = 'apply_patch'; input = item.changes;
      output = outputText([item.stdout, item.stderr].filter(Boolean).join('\n'));
      break;
    case 'McpToolCall':
      if (typeof item.server !== 'string' || typeof item.tool !== 'string') return undefined;
      name = `${item.server}.${item.tool}`; input = item.arguments;
      output = outputText(item.result ?? item.error);
      break;
    case 'CollabAgentToolCall':
      if (typeof item.tool !== 'string') return undefined;
      name = item.tool;
      input = { ...(typeof item.prompt === 'string' ? { prompt: item.prompt } : {}), ...(item.receiver_thread_ids ? { receiver_thread_ids: item.receiver_thread_ids } : {}) };
      output = outputText(item.agents_states ?? item.error);
      break;
    default: return undefined;
  }
  const failed = item.status === 'failed' || item.status === 'declined'
    || (item.type === 'CommandExecution' && typeof item.exit_code === 'number' && item.exit_code !== 0)
    || (item.type === 'McpToolCall' && (item.error !== undefined && item.error !== null || item.result?.isError === true));
  return [
    { type: 'tool_call', data: { id: item.id, name, ...(input !== undefined ? { input } : {}), status: 'running' } },
    { type: 'tool_result', data: { id: item.id, name, output, status: failed ? 'failed' : 'completed',
      ...(typeof item.exit_code === 'number' ? { exitCode: item.exit_code } : {}) } },
  ];
}
