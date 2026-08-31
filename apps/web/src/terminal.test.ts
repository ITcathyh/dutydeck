import { describe, expect, it } from 'vitest';
import { nextTerminalBackoffMs, parseTerminalFrame, terminalFontSize, terminalWsUrl } from './terminal';

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

describe('terminalFontSize', () => {
  it('宽容器保持 12px 基准字号，只缩不放（桌面渲染零变化）', () => {
    expect(terminalFontSize(1200)).toBe(12);
    expect(terminalFontSize(800)).toBe(12);
    // 446px 起 ideal 就达到 12（446 / (62 * 0.6) ≈ 12.0），再宽也不会超过基准
    expect(terminalFontSize(450)).toBe(12);
  });

  it('窄视口缩小字号换取更多列数：390px 手机不再停在 12px', () => {
    const iphone = terminalFontSize(390);
    expect(iphone).toBeLessThan(12);
    // 390 / (62 * 0.6) ≈ 10.48，半档取整到 10.5
    expect(iphone).toBe(10.5);
    // 414px 的大屏手机 ≈ 11.13 → 11
    expect(terminalFontSize(414)).toBe(11);
  });

  it('按半档取整，不落在容易糊掉的亚像素字号上', () => {
    for (const width of [280, 320, 360, 390, 414, 430]) {
      expect(terminalFontSize(width) * 2 % 1).toBe(0);
    }
  });

  it('不低于 9px 可读下限，异常宽度回落基准字号', () => {
    expect(terminalFontSize(120)).toBe(9);
    expect(terminalFontSize(1)).toBe(9);
    // 宽度还没布局出来（隐藏 tab / 刚插进 DOM）时保持基准，等尺寸事件再纠正
    expect(terminalFontSize(0)).toBe(12);
    expect(terminalFontSize(-50)).toBe(12);
    expect(terminalFontSize(Number.NaN)).toBe(12);
  });
});
