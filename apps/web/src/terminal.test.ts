import { describe, expect, it } from 'vitest';
import { nextTerminalBackoffMs, parseTerminalFrame, terminalWsUrl } from './terminal';

describe('terminalWsUrl', () => {
  it('upgrades http to ws', () => {
    expect(terminalWsUrl('sess-1', { protocol: 'http:', host: '127.0.0.1:4311' })).toBe('ws://127.0.0.1:4311/api/terminal/sess-1');
  });

  it('upgrades https to wss', () => {
    expect(terminalWsUrl('sess-1', { protocol: 'https:', host: 'dockmux.example.com' })).toBe('wss://dockmux.example.com/api/terminal/sess-1');
  });

  it('encodes special characters in the session id', () => {
    expect(terminalWsUrl('a/b c?d', { protocol: 'https:', host: 'x' })).toBe('wss://x/api/terminal/a%2Fb%20c%3Fd');
  });
});

describe('parseTerminalFrame', () => {
  it('parses the three valid server frame shapes', () => {
    expect(parseTerminalFrame('{"type":"data","data":"hello"}')).toEqual({ type: 'data', data: 'hello' });
    expect(parseTerminalFrame('{"type":"exit","code":0}')).toEqual({ type: 'exit', code: 0 });
    expect(parseTerminalFrame('{"type":"exit","code":null}')).toEqual({ type: 'exit', code: null });
    expect(parseTerminalFrame('{"type":"error","message":"boom"}')).toEqual({ type: 'error', message: 'boom' });
  });

  it('returns undefined for invalid JSON', () => {
    expect(parseTerminalFrame('not json')).toBeUndefined();
  });

  it('returns undefined for an unknown frame type', () => {
    expect(parseTerminalFrame('{"type":"ping"}')).toBeUndefined();
  });

  it('returns undefined when required fields are missing or wrong-typed', () => {
    expect(parseTerminalFrame('{"type":"data"}')).toBeUndefined();
    expect(parseTerminalFrame('{"type":"data","data":123}')).toBeUndefined();
    expect(parseTerminalFrame('{"type":"exit"}')).toBeUndefined();
    expect(parseTerminalFrame('{"type":"exit","code":"0"}')).toBeUndefined();
    expect(parseTerminalFrame('{"type":"error"}')).toBeUndefined();
  });
});

describe('nextTerminalBackoffMs', () => {
  it('grows exponentially and caps at 30000ms', () => {
    expect(nextTerminalBackoffMs(0)).toBe(1000);
    expect(nextTerminalBackoffMs(1)).toBe(2000);
    expect(nextTerminalBackoffMs(4)).toBe(16000);
    // 2^5 * 1000 = 32000 已超过 30000 上限，封顶为 30000
    expect(nextTerminalBackoffMs(5)).toBe(30000);
    expect(nextTerminalBackoffMs(10)).toBe(30000);
  });
});
