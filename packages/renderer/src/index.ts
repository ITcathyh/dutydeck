import type { AgentEvent } from '@dockmux/shared';

export function eventText(event: AgentEvent): string {
  const data = event.data as any;
  if (event.type === 'text' || event.type === 'thinking' || event.type === 'raw_terminal') return data.text ?? event.raw ?? '';
  if (event.type === 'error') return data.message ?? 'Unknown error';
  if (event.type === 'tool_call' || event.type === 'tool_result') return `${data.name ?? 'tool'} · ${data.status ?? ''}`;
  if (event.type === 'permission_request') return data.title ?? 'Permission required';
  return data.state ?? data.stopReason ?? event.type;
}
