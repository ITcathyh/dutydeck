import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EventContent } from './EventContent';
import { TimelineItem } from './TimelineItem';
import { ActivityContent, ToolCard } from './ToolCard';

const event = (data: Record<string, unknown>) => ({ id: 'e', sequence: 1, timestamp: '', type: 'text', data });
describe('structured event presentation', () => {
  it('displays image-only final output and never loads remote images or resource URIs', () => {
    const { container } = render(<TimelineItem final event={event({ text: '', parts: [{ type: 'image', mimeType: 'image/png', data: 'YWJj' }, { type: 'image', mimeType: 'image/png', uri: 'https://external.test/image.png' }, { type: 'resource_link', uri: 'file:///private/report', name: 'Report' }] })}/>);
    expect(screen.getByRole('article', { name: 'Agent 最终输出' })).toBeTruthy();
    const images = container.querySelectorAll('img');
    expect(images.length).toBe(1); expect(images[0]?.getAttribute('src')).toBe('data:image/png;base64,YWJj');
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText('https://external.test/image.png')).toBeTruthy();
    expect(screen.getByText('file:///private/report')).toBeTruthy();
  });
  it('renders HTML as escaped resource text and degrades SVG and unknown content visibly', () => {
    const { container } = render(<EventContent data={{ parts: [{ type: 'resource', resource: { uri: 'file:///work/report.html', mimeType: 'text/html', text: '<script>window.secret()</script>' } }, { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zy8+' }, { type: 'audio', data: 'abc' }] }}/>);
    expect(screen.getByText('<script>window.secret()</script>')).toBeTruthy();
    expect(container.querySelector('script,iframe,img')).toBeNull();
    expect(screen.getByText('暂不支持的内容类型：audio')).toBeTruthy();
  });
  it('keeps intermediate non-text assistant content visible inside a collapsed activity group', () => {
    render(<ActivityContent events={[event({ text: '', parts: [{ type: 'resource_link', uri: 'file:///work/intermediate.html', name: 'Intermediate result' }] })]}/>);
    expect(screen.getByText('Intermediate result')).toBeTruthy();
  });
  it('offers structured tool body details even without raw output', () => {
    render(<ToolCard event={{ ...event({ name: 'Create report', status: 'completed', parts: [{ type: 'text', text: 'Structured tool body' }] }), type: 'tool_result' }}/>);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Structured tool body')).toBeTruthy();
  });
});

it('renders the full accumulated long text on both sides of an image without reapplying single-event text limits', () => {
  const before = `START ${'before '.repeat(24_000)} BEFORE_END`;
  const after = `AFTER_START ${'after '.repeat(24_000)} END`;
  const { container } = render(<EventContent data={{ text: before + after, parts: [{ type: 'text', text: before }, { type: 'image', mimeType: 'image/png', data: 'YWJj' }, { type: 'text', text: after }] }}/>);
  expect(container.textContent).toContain(before);
  expect(container.textContent).toContain(after);
  expect(container.querySelectorAll('img').length).toBe(1);
  expect(container.textContent).not.toContain('内容超过记录上限');
});

it('bounds aggregate non-text bytes while retaining the text after omitted images', () => {
  const parts = Array.from({ length: 4 }, () => ({ type: 'image', mimeType: 'image/png', data: 'a'.repeat(120_000) }));
  const { container } = render(<EventContent data={{ parts: [...parts, { type: 'text', text: 'The final text remains visible.' }] }}/>);
  expect(container.querySelectorAll('img').length).toBe(2);
  expect(container.textContent).toContain('内容超过记录上限');
  expect(container.textContent).toContain('The final text remains visible.');
});
