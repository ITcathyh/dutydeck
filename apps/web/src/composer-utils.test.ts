import { describe, expect, it } from 'vitest';
import { buildPrompt, commandsFromEvents, contextStatsFromEvents, getModelReadiness, replaceSlashQuery, slashQuery } from './composer-utils';

describe('composer slash references', () => {
  it('builds file and skill references with the shared slash syntax', () => {
    expect(buildPrompt('检查这里', [
      { id: 'f', kind: 'file', label: 'App.tsx', value: '/repo/App.tsx' },
      { id: 's', kind: 'skill', label: 'review', value: 'review' }
    ])).toBe('/file /repo/App.tsx\n\n/skills review\n\n检查这里');
  });

  it('detects and replaces the slash token at the caret', () => {
    expect(slashQuery('先看一下 /ski')).toBe('ski');
    expect(replaceSlashQuery('先看一下 /ski', '/skills ')).toBe('先看一下 /skills ');
  });

  it('derives context usage, compaction, and advertised commands from ACP status events', () => {
    const events: any[] = [
      { type: 'status', data: { state: 'usage', used: 18_000, size: 200_000 } },
      { type: 'status', data: { state: 'usage', used: 8_000, size: 200_000 } },
      { type: 'status', data: { state: 'usage', used: 11_000, size: 200_000 } },
      { type: 'status', data: { state: 'commands', availableCommands: [{ name: '/compact', description: 'Compact context' }] } }
    ];
    expect(contextStatsFromEvents(events)).toEqual({ used: 11_000, size: 200_000, compacted: 10_000, percentage: 5.5 });
    expect(commandsFromEvents(events)).toEqual([{ name: 'compact', description: 'Compact context' }]);
  });

  it('blocks sending until models have loaded', () => {
    expect(getModelReadiness({ loaded: false, loading: true, switching: false, failed: false })).toMatchObject({ kind: 'loading' });
    expect(getModelReadiness({ loaded: false, loading: false, switching: false, failed: true })).toMatchObject({ kind: 'blocked' });
    expect(getModelReadiness({ loaded: true, loading: true, switching: false, failed: false })).toEqual({ kind: 'ready' });
  });

  it('blocks sending while switching models even when the previous catalog is loaded', () => {
    expect(getModelReadiness({ loaded: true, loading: false, switching: true, failed: false })).toMatchObject({ kind: 'loading', label: '模型切换中…' });
  });
});
