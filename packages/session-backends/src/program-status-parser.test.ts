import { describe, expect, it } from 'vitest';
import { ProgramStatusFramingStream, decodeProgramStatusMsg } from './program-status-parser.js';

const frame = (body: string, end = '\x07') => `\x1b]7501;${body}${end}`;
describe('OSC 7501 stream framing', () => {
  it.each(['\x07', '\x1b\\'])('reassembles every chunk boundary with %j termination', end => {
    const input = `before\x1b[31m${frame('?', end)}${frame('state=blocked:app=claude-code:kind=permission:msg=5a6h5om5', end)}after\x1b]0;title\x07`;
    for (let split = 0; split < input.length; split++) {
      const parser = new ProgramStatusFramingStream();
      const parts = [...parser.feed(input.slice(0, split)), ...parser.feed(input.slice(split)), ...parser.flush()];
      expect(parts.filter(p => p.type === 'data').map(p => p.text).join('')).toBe('before\x1b[31mafter\x1b]0;title\x07');
      expect(parts.filter(p => p.type === 'probe')).toHaveLength(1);
      expect(parts.find(p => p.type === 'status')).toEqual({ type: 'status', event: { state: 'blocked', app: 'claude-code', kind: 'permission', msg: '审批' } });
    }
  });
  it.each(['!@#$', 'a', 'SGVsbG8===', 'AA==', '/w=='])('ignores malformed or unsafe base64 %s', msg => {
    expect(decodeProgramStatusMsg(msg)).toBeUndefined();
    expect(new ProgramStatusFramingStream().feed(frame(`state=working:msg=${msg}`))).toEqual([{ type: 'status', event: { state: 'working' } }]);
  });
  it('bounds both complete and incomplete frames and recovers at the next escape', () => {
    const parser = new ProgramStatusFramingStream({ maxBufferSize: 64 });
    expect(parser.feed(frame('state=working:msg=' + 'x'.repeat(100))).some(p => p.type === 'status')).toBe(false);
    parser.feed('\x1b]7501;' + 'x'.repeat(100) + '\x1b');
    expect(parser.flush().map(p => p.type === 'data' ? p.text.length : 0).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(64);
    expect(parser.feed(frame('state=done'))).toEqual([{ type: 'status', event: { state: 'done' } }]);
  });
  it('scans 256KiB of malformed prefixes within a bounded time and retains the following valid frame', () => {
    const malformed = '\x1b]7501;state=working:'.repeat(Math.ceil(256 * 1024 / 21));
    const times: number[] = [];
    for (let run = 0; run < 5; run++) {
      const parser = new ProgramStatusFramingStream();
      const start = performance.now();
      const parts = parser.feed(malformed + frame('state=done:app=claude-code'));
      times.push(performance.now() - start);
      expect(parts.filter(p => p.type === 'status')).toEqual([{ type: 'status', event: { state: 'done', app: 'claude-code' } }]);
      expect(parts.filter(p => p.type === 'data').map(p => p.text).join('')).toBe(malformed);
    }
    const median = times.sort((a, b) => a - b)[2]!;
    console.info(`malformed OSC 256KiB median=${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(100);
  });
  it.each([64, 4096])('retains a trailing ESC after an overlong frame at the %i-byte limit', maxBufferSize => {
    const parser = new ProgramStatusFramingStream({ maxBufferSize });
    parser.feed('\x1b]7501;' + 'x'.repeat(maxBufferSize + 1) + '\x1b');
    expect(parser.feed(']7501;state=done:app=claude-code\x07')).toEqual([
      { type: 'status', event: { state: 'done', app: 'claude-code' } },
    ]);
  });
  it('preserves unrelated and malformed escape sequences', () => {
    const parser = new ProgramStatusFramingStream();
    const input = '\x1b]8;;url\x1b\\link\x1b[0m\x1b]7501;broken\x1b[31mtext\x1b';
    const parts = [...parser.feed(input), ...parser.flush()];
    expect(parts.map(p => p.type === 'data' ? p.text : '').join('')).toBe(input);
  });
});
