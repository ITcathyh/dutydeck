import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PulseAnalysis } from '../../../../apps/server/src/session-insight-analyzer-tokens';
import { analyzeSessionInsightFiles } from '../../../../apps/server/src/session-insight-analyzer';
import { SessionInsightPulseChart } from './SessionInsightPulseChart';

afterEach(cleanup);

function collectorBuckets(count: number, recordedZero = false) {
  const start = Date.parse('2026-11-17T00:00:00.000Z');
  const collector = new PulseAnalysis('codex', new Date(start).toISOString(), new Date(start + count * 1000).toISOString());
  for (let index = 0; index < count; index += 1) collector.add({
    at: new Date(start + index * 1000).toISOString(),
    identity: true,
    values: recordedZero
      ? { input: 0, uncached: 0, cached: 0, write: 0, output: 0, reasoning: 0, total: 0 }
      : { input: 10, uncached: 10, cached: 0, write: 0, output: index + 1, reasoning: 0, total: index + 11 },
    conflicts: {}
  });
  return collector.finish();
}

function collectorValues(values: Array<number | null>) {
  const start = Date.parse('2026-11-17T00:00:00.000Z');
  const collector = new PulseAnalysis('codex', new Date(start).toISOString(), new Date(start + values.length * 1000).toISOString());
  values.forEach((value, index) => collector.add({
    at: new Date(start + index * 1000).toISOString(), identity: true,
    values: value === null
      ? { input: null, uncached: null, cached: null, write: null, output: null, reasoning: null, total: null }
      : { input: value, uncached: value, cached: 0, write: 0, output: 0, reasoning: 0, total: value },
    conflicts: {}
  }));
  return collector.finish();
}

describe('SessionInsightPulseChart viewport and metric display', () => {
  it.each([1, 100, 181, 300, 1000])('fits all %i real collector buckets inside the SVG viewport', count => {
    const buckets = collectorBuckets(count);
    expect(buckets).toHaveLength(count);
    const view = render(<SessionInsightPulseChart buckets={buckets}/>);
    const bars = [...view.container.querySelectorAll('svg rect')];
    expect(bars).toHaveLength(count);
    for (const bar of bars) {
      const x = Number(bar.getAttribute('x'));
      const width = Number(bar.getAttribute('width'));
      expect(Number.isFinite(width) && width > 0).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(720);
    }
    const last = bars.at(-1)!;
    expect(Number(last.getAttribute('x')) + Number(last.getAttribute('width'))).toBeGreaterThanOrEqual(719);
    expect(last.textContent).toContain('样本 1');
    fireEvent.click(screen.getByRole('button', { name: '查看数据表' }));
    expect(view.container.querySelectorAll('tbody tr')).toHaveLength(count);
  });

  it('keeps a recorded zero distinct from an unavailable metric', () => {
    const buckets = collectorBuckets(1, true);
    expect(buckets[0]!.tokens.total.value).toBe(0);
    const view = render(<SessionInsightPulseChart buckets={buckets}/>);
    expect(view.container.querySelector('p')!.textContent).toContain('峰值 0 token/桶');
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/峰值 0$/);
    fireEvent.click(screen.getByRole('button', { name: '查看数据表' }));
    expect(view.container.querySelector('tbody td:nth-child(2)')!.textContent).toBe('0');
  });

  it('renders the real redacted Traex sample unknown totals as unknown, not zero', async () => {
    const path = resolve(import.meta.dirname, '../../../../tests/fixtures/session-insight/real-native/traex.jsonl');
    const bytes = await readFile(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(sha256).toBe('754d2548800ceb4af06f45c2a91c5ccfa5328276a22e260a2d9228c168d4235b');
    const result = await analyzeSessionInsightFiles({
      schemaVersion: 1,
      requestId: 'fb4b641b-f409-49f7-8ddd-b6edff42c55c',
      files: [{ path, client: 'traex', sourceKey: 'native-traex', bytes: bytes.length, sha256, expectedNativeSessionId: '01a0ffa6-a71d-79b3-9a87-d386f1808e41', expectedStream: { kind: 'main', nativeAgentId: null } }],
      limits: { maxLineBytes: 1_048_576, maxTraceEvents: 20_000 }
    });
    const file = result.files[0]!;
    expect(file.status).toBe('ok');
    expect(file.pulseBuckets.length).toBeGreaterThan(0);
    expect(file.pulseBuckets.every(bucket => bucket.tokens.total.value === null && bucket.tokens.total.status === 'partial')).toBe(true);
    const view = render(<SessionInsightPulseChart buckets={file.pulseBuckets}/>);
    expect(view.container.querySelector('p')!.textContent).toContain('峰值 未知 token/桶');
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/峰值 未知$/);
    expect([...view.container.querySelectorAll('svg rect title')].every(title => title.textContent?.includes('未知 token'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '查看数据表' }));
    const cells = [...view.container.querySelectorAll('tbody td:nth-child(2)')];
    expect(cells.map(cell => cell.textContent)).toEqual(file.pulseBuckets.map(() => '未知'));
    expect(cells.every(cell => cell.getAttribute('title')?.includes('状态：部分'))).toBe(true);
  });

  it.each([
    { values: [9, null, 17], peak: '17', cells: ['9', '未知', '17'] },
    { values: [null, 0], peak: '0', cells: ['未知', '0'] }
  ])('uses only known values for the displayed peak: $values', ({ values, peak, cells: expectedCells }) => {
    const buckets = collectorValues(values);
    expect(buckets.map(bucket => bucket.tokens.total.value)).toEqual(values);
    const view = render(<SessionInsightPulseChart buckets={buckets}/>);
    expect(view.container.querySelector('p')!.textContent).toContain(`峰值 ${peak} token/桶`);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(new RegExp(`峰值 ${peak}$`));
    fireEvent.click(screen.getByRole('button', { name: '查看数据表' }));
    const cells = [...view.container.querySelectorAll('tbody td:nth-child(2)')];
    expect(cells.map(cell => cell.textContent)).toEqual(expectedCells);
  });

  it('keeps the empty-state message without rendering a numeric peak', () => {
    const view = render(<SessionInsightPulseChart buckets={[]}/>);
    expect(screen.queryByRole('img')).toBeNull();
    expect(view.container.textContent).toBe('分析范围内没有可定位到时间的 Token 样本。');
  });
});
