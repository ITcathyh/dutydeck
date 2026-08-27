import { describe, expect, it } from 'vitest';
import { listenOptions } from './service.js';

describe('server listen options', () => {
  it('turns the default IPv4 wildcard into a dual-stack socket', () => {
    expect(listenOptions({ host: '0.0.0.0', port: 4310 })).toEqual({
      host: '::',
      port: 4310,
      ipv6Only: false
    });
  });

  it('keeps an explicitly selected host unchanged', () => {
    expect(listenOptions({ host: '127.0.0.1', port: 4310 })).toEqual({
      host: '127.0.0.1',
      port: 4310
    });
  });
});
