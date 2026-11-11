import { describe, expect, it } from 'vitest';
import { parseCardLinks, readCardLinks, cardLinkElements } from './card-links.js';
import { buildLarkCard, larkCardSafeLimits } from './service.js';

describe('card links', () => {
  const links = [{ label: 'Open task', url: 'https://client.example.test/task/{sessionId}', android_url: 'client://task/{sessionId}', ios_url: 'client://task/{sessionId}', pc_url: 'https://client.example.test/task/{sessionId}' }];
  it('validates limits and supports clearing', () => {
    expect(parseCardLinks(links)).toEqual(links); expect(parseCardLinks('')).toEqual([]); expect(parseCardLinks(null)).toEqual([]);
    for (const value of [[...links, ...links, ...links], [{ ...links[0], label: 'x'.repeat(13) }], [{ ...links[0], url: 'http://client.example.test' }], [{ ...links[0], url: 'javascript:alert(1)' }], [{ ...links[0], android_url: ' JaVaScRiPt:alert(1)' }], [{ ...links[0], ios_url: 'java\nscript:alert(1)' }], [{ ...links[0], pc_url: 'data:text/html,hello' }]]) expect(() => parseCardLinks(value)).toThrow();
  });
  it.each(['url', 'android_url', 'ios_url', 'pc_url'] as const)('rejects an oversized %s when saving', key => {
    expect(() => parseCardLinks([{ ...links[0], [key]: 'https://client.example.test/' + 'x'.repeat(2048) }])).toThrow();
  });
  it.each(['process', 'result', 'custom'] as const)('keeps the final %s card within budget by omitting optional links', kind => {
    const long = 'https://client.example.test/' + 'x'.repeat(1950);
    const optional = [{ label: 'Open', url: long, android_url: long, ios_url: long, pc_url: long }, { label: 'More', url: long, android_url: long, ios_url: long, pc_url: long }];
    const content = 'a'.repeat(14000);
    const input = { cardKind: kind === 'process' ? 'process' as const : 'result' as const, state: 'completed' as const, sessionId: 's', ...(kind === 'custom' ? { cardBody: { elements: [{ tag: 'markdown', content }] } } : { elements: [{ tag: 'markdown', element_id: 'final_output', content }] }) };
    const base = buildLarkCard(input);
    expect(Buffer.byteLength(JSON.stringify(base))).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    const card = buildLarkCard({ ...input, cardLinks: optional });
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(larkCardSafeLimits.bytes);
    expect(card).toEqual(base);
  });
  it('ignores invalid old links', () => {
    const old = [{ label: 'Open', url: 'https://client.example.test/' + 'x'.repeat(3000) }];
    expect(readCardLinks(old)).toEqual([]); expect(readCardLinks(links)).toEqual(links);
    expect(cardLinkElements(old, 's')).toEqual([]);
  });
  it.each([false, true])('preserves the original large custom body with links=%s', withLinks => {
    const cardBody = { elements: [{ tag: 'markdown', content: 'x'.repeat(30000) }] };
    const host = { taskId: 'task_one', cardKind: 'result' as const, sessionId: 's', state: 'completed' as const };
    const original = { ...buildLarkCard({ ...host, elements: [] }), body: { direction: 'vertical', padding: '10px 12px', ...cardBody } };
    expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(larkCardSafeLimits.bytes);
    expect(buildLarkCard({ ...host, cardBody, ...(withLinks ? { cardLinks: links } : {}) })).toEqual(original);
  });
  it.each(['url', 'android_url', 'ios_url', 'pc_url'] as const)('omits only the link whose expanded %s exceeds 2048 characters', key => {
    const expanded = [{ ...links[0]!, [key]: 'https://client.example.test/' + 'x'.repeat(1940) + '/{sessionId}' }, { label: 'More', url: 'https://client.example.test/' }];
    expect(parseCardLinks(expanded)).toEqual(expanded);
    expect(cardLinkElements(expanded, '中'.repeat(180))).toEqual([{ tag: 'button', type: 'default', text: { tag: 'plain_text', content: 'More' }, multi_url: { url: 'https://client.example.test/' } }]);
  });
  it('accepts exactly 2048 characters after template expansion', () => {
    const prefix = 'https://client.example.test/';
    const link = [{ label: 'Open', url: prefix + '{sessionId}' }];
    expect(cardLinkElements(link, 'x'.repeat(2048 - prefix.length))).toHaveLength(1);
    expect(cardLinkElements(link, 'x'.repeat(2049 - prefix.length))).toEqual([]);
  });
  it('renders multi_url with encoded session IDs on progress and result cards', () => {
    expect(cardLinkElements(links, 'session/a')[0]).toMatchObject({ tag: 'button', multi_url: { url: 'https://client.example.test/task/session%2Fa', android_url: 'client://task/session%2Fa' } });
    expect(cardLinkElements(links, undefined)).toEqual([]);
    for (const cardKind of ['process', 'result'] as const) {
      const card = buildLarkCard({ cardKind, sessionId: 'session/a', cardLinks: links, state: cardKind === 'process' ? 'running' : 'completed' });
      expect(card.body.elements.at(-1)).toMatchObject({ tag: 'button', multi_url: { ios_url: 'client://task/session%2Fa' } });
    }
    const custom = buildLarkCard({ cardKind: 'result', sessionId: 's', cardLinks: links, cardBody: { elements: [{ tag: 'markdown', content: 'custom' }] } });
    expect(custom.body.elements.at(-1)).toMatchObject({ multi_url: { url: 'https://client.example.test/task/s' } });
  });
});
