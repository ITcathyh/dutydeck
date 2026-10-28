import { describe, expect, it } from 'vitest';
import { eventContentLimits, eventContentText, eventHasContent, extractEventArtifactReferences, normalizeEventContent } from './event-content.js';

describe('bounded event content and evidence references', () => {
  it('preserves ACP text, images, embedded resources and links, including tool wrappers', () => {
    const parts = [{ type: 'text', text: 'hello' }, { type: 'image', mimeType: 'image/png', data: 'YWJj' }, { type: 'resource', resource: { uri: 'file:///work/report.html', mimeType: 'text/html', text: '<script>secret()</script>' } }, { type: 'resource_link', uri: 'https://example.test/report', name: 'Report', mimeType: 'text/html' }];
    expect(normalizeEventContent(parts.map(content => ({ type: 'content', content })))).toEqual(parts);
    expect(eventContentText(normalizeEventContent(parts))).toBe('hello');
    expect(eventHasContent({ parts: [parts[1]] })).toBe(true);
  });
  it('visibly bounds all parts by serialized UTF-8 bytes and count, with stable placeholders', () => {
    const many = Array.from({ length: 1000 }, () => ({ type: 'resource', resource: { uri: 'file:///work/report.txt', text: '字'.repeat(30_000) } }));
    const parts = normalizeEventContent(many);
    expect(parts.length).toBeLessThanOrEqual(eventContentLimits.parts);
    expect(Buffer.byteLength(JSON.stringify(parts))).toBeLessThanOrEqual(eventContentLimits.totalBytes);
    expect(parts.at(-1)).toMatchObject({ type: 'unsupported', reason: 'content_budget' });
    const huge = normalizeEventContent({ type: 'image', mimeType: 'image/png', data: 'a'.repeat(1024 * 1024) });
    expect(huge).toEqual([{ type: 'unsupported', originalType: 'image', reason: 'content_budget' }]);
    expect(normalizeEventContent(huge)).toEqual(huge);
    expect(normalizeEventContent({ type: 'resource_link', uri: 'file:///' + 'x'.repeat(3000) })).toEqual([{ type: 'unsupported', originalType: 'resource_link', reason: 'content_budget' }]);
    expect(normalizeEventContent({ type: 'audio', data: 'abc' })).toEqual([{ type: 'unsupported', originalType: 'audio', reason: 'unsupported_type' }]);
    expect(eventHasContent({ parts: huge })).toBe(false);
  });
  it('preserves long text around bounded non-text content without duplicating pure text at the driver', () => {
    const text = '字'.repeat(100_000);
    const image = { type: 'image', mimeType: 'image/png', data: 'YWJj' };
    expect(normalizeEventContent([{ type: 'text', text }, image, { type: 'text', text }])).toEqual([{ type: 'text', text }, image, { type: 'text', text }]);
    const excess = normalizeEventContent([...Array.from({ length: 1000 }, () => image), { type: 'text', text }]);
    expect(excess.at(-1)).toEqual({ type: 'text', text });
    expect(excess.filter(part => part.type !== 'text').length).toBeLessThanOrEqual(eventContentLimits.parts);
  });
  it('only attributes successful structured tool output or explicit assistant attachments to trusted event identities', () => {
    const event = { id: 'event-1', taskId: 'task-1', attemptId: 'attempt-1', sequence: 10, type: 'tool_result', data: { taskId: 'forged', status: 'completed', parts: [{ type: 'resource', resource: { uri: 'file:///work/report.html', text: 'SECRET_BODY', blob: 'SECRET_BYTES' } }] } };
    const [ref] = extractEventArtifactReferences(event);
    expect(ref).toEqual({ taskId: 'task-1', attemptId: 'attempt-1', eventId: 'event-1', sequence: 10, partIndex: 0, uri: 'file:///work/report.html', revision: 'event:event-1:10:0', status: 'recorded', source: 'structured_tool_result' });
    expect(JSON.stringify(ref)).not.toMatch(/SECRET/);
    for (const status of ['pending', 'running', 'failed']) expect(extractEventArtifactReferences({ ...event, data: { ...event.data, status } })).toEqual([]);
    expect(extractEventArtifactReferences({ ...event, attemptId: undefined })).toEqual([]);
    expect(extractEventArtifactReferences({ ...event, type: 'text', data: { parts: event.data.parts } })[0]?.source).toBe('assistant_attachment');
    expect(extractEventArtifactReferences({ ...event, type: 'text', data: { role: 'user', parts: event.data.parts } })).toEqual([]);
    const second = extractEventArtifactReferences({ ...event, taskId: 'task-2', attemptId: 'attempt-2', id: 'event-2', sequence: 20 });
    expect(second[0]?.revision).not.toBe(ref?.revision);
  });
  it('labels only a confirmed private-result receipt as delivered without exposing download credentials', () => {
    const event = { id: 'e', taskId: 't', attemptId: 'a', sequence: 3, type: 'tool_result', data: { status: 'completed', output: { deliveryId: 'private', status: 'delivered', fileCount: 1 } } };
    expect(extractEventArtifactReferences(event)[0]).toMatchObject({ uri: 'dutydeck-result:private', source: 'attachment_receipt', status: 'delivered' });
    for (const status of ['pending', 'unknown', 'failed']) expect(extractEventArtifactReferences({ ...event, data: { ...event.data, output: { ...event.data.output, status } } })).toEqual([]);
  });
});
