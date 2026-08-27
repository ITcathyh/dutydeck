import { describe, expect, it } from 'vitest';
import { elapsedMilliseconds, formatElapsed, groupToolActivityRows, summarizeTools, toolActionLabel, toolDescription, toolPresentation } from './tool-presentation';

const event = (id: string, name: string, input: unknown) => ({ id, sequence: 1, type: 'tool_result', timestamp: '2026-01-01T00:00:00.000Z', data: { id, name, input, status: 'completed' } });

describe('tool presentation', () => {
  it('classifies common tools and keeps the concrete operation as detail', () => {
    expect(toolPresentation({ name: 'tool call', input: { command: 'pwd' } })).toEqual({ kind: 'terminal', label: '运行命令', detail: 'pwd' });
    expect(toolPresentation({ name: 'Read', input: { path: 'README.md' } })).toEqual({ kind: 'read', label: '读取文件', detail: 'README.md' });
    expect(toolPresentation({ name: 'apply_patch', input: {} })).toMatchObject({ kind: 'edit', label: '编辑文件' });
    expect(toolPresentation({ name: 'Terminal', input: { command: 'dockmux group messages --limit 20' } })).toMatchObject({ kind: 'agent', label: 'Agent 群协作' });
  });

  it('summarizes a batch without exposing lifecycle event noise', () => {
    expect(summarizeTools([
      event('one', 'Terminal', { command: 'pwd' }),
      event('two', 'Terminal', { command: 'pnpm test' }),
      event('three', 'Read', { path: 'README.md' })
    ])).toBe('运行了命令 · 运行了测试 · 读取了文件');
    expect(toolActionLabel(toolPresentation({ name: 'Terminal', input: { command: 'pwd' } }), true)).toBe('已运行命令');
  });

  it('formats tool and turn elapsed time', () => {
    expect(elapsedMilliseconds('2026-01-01T00:00:00.000Z', '2026-01-01T00:01:37.000Z')).toBe(97_000);
    expect(formatElapsed(780)).toBe('780 毫秒');
    expect(formatElapsed(97_000)).toBe('1 分 37 秒');
  });

  it('uses a tool description as the human-readable action', () => {
    expect(toolDescription({ input: { command: 'find . -type f', description: '统计各项目 specs 数量' } })).toBe('统计各项目 specs 数量');
  });

  it('collapses only consecutive tools with the same description', () => {
    const first = event('one', 'Terminal', { command: 'echo one', description: '检查项目' });
    const second = event('two', 'Terminal', { command: 'echo two', description: '检查项目' });
    const thinking = { ...event('thinking', 'thinking', {}), type: 'thinking', data: { text: '继续分析' } };
    const third = event('three', 'Terminal', { command: 'echo three', description: '检查项目' });
    const rows = groupToolActivityRows([first, second, thinking, third]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'batch', description: '检查项目', events: [first, second] });
    expect(rows[1]).toMatchObject({ kind: 'event', event: thinking });
    expect(rows[2]).toMatchObject({ kind: 'event', event: third });
  });
});
