import type { DockEvent } from './api';

export type ComposerReference = { id: string; kind: 'file' | 'skill'; label: string; value: string };
export type ContextStats = { used?: number; size?: number; compacted?: number; percentage?: number };
export type ModelReadiness =
  | { kind: 'ready' }
  | { kind: 'loading'; label: string; reason: string }
  | { kind: 'blocked'; label: string; reason: string };

export function getModelReadiness({ loaded, loading, switching, failed }: { loaded: boolean; loading: boolean; switching: boolean; failed: boolean }): ModelReadiness {
  if (switching) return { kind: 'loading', label: '模型切换中…', reason: '模型切换完成后才能发送消息' };
  if (loaded) return { kind: 'ready' };
  if (loading) return { kind: 'loading', label: '模型加载中…', reason: '模型加载完成后才能发送消息' };
  if (failed) return { kind: 'blocked', label: '模型加载失败', reason: '模型加载失败，请刷新模型列表后重试' };
  return { kind: 'blocked', label: '模型未加载', reason: '模型加载完成后才能发送消息' };
}

export function buildPrompt(message: string, references: ComposerReference[]) {
  const referenceLines = references.filter(reference => reference.kind === 'file').map(reference => `/file ${reference.value}`);
  const prompt = [...referenceLines, message.trim()].filter(Boolean).join('\n\n');
  return prompt || (references.some(reference => reference.kind === 'skill') ? '请按所选 Skill 执行。' : '');
}

export function slashQuery(value: string, caret = value.length) {
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(?:^|\s)\/([^\s/]*)$/);
  return match ? match[1]!.toLowerCase() : undefined;
}

export function replaceSlashQuery(value: string, replacement: string, caret = value.length) {
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(?:^|\s)\/[^\s/]*$/);
  if (!match || match.index === undefined) return value;
  const leadingWhitespace = match[0].startsWith('/') ? '' : match[0][0]!;
  return `${beforeCaret.slice(0, match.index)}${leadingWhitespace}${replacement}${value.slice(caret)}`;
}

export function contextStatsFromEvents(events: DockEvent[] = []): ContextStats {
  let used: number | undefined;
  let size: number | undefined;
  let compacted = 0;
  let hasUsage = false;
  for (const event of events) {
    if (event.type !== 'status' || event.data?.state !== 'usage') continue;
    hasUsage = true;
    const nextUsed = Number.isFinite(event.data.used) ? Number(event.data.used) : Number.isFinite(event.data.breakdown?.totalTokens) ? Number(event.data.breakdown.totalTokens) : undefined;
    const nextSize = Number.isFinite(event.data.size) ? Number(event.data.size) : undefined;
    if (used !== undefined && nextUsed !== undefined && nextUsed < used) compacted += used - nextUsed;
    if (nextUsed !== undefined) used = nextUsed;
    if (nextSize !== undefined) size = nextSize;
  }
  return { used, size, ...(hasUsage ? { compacted } : {}), ...(used !== undefined && size ? { percentage: Math.min(100, used / size * 100) } : {}) };
}

export function commandsFromEvents(events: DockEvent[] = []) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === 'status' && event.data?.state === 'commands' && Array.isArray(event.data.availableCommands)) {
      return event.data.availableCommands.flatMap((command: any) => typeof command?.name === 'string' ? [{ name: command.name.replace(/^\//, ''), description: typeof command.description === 'string' ? command.description : '' }] : []);
    }
  }
  return [];
}

export function formatTokens(value?: number) {
  if (value === undefined) return '等待数据';
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}
