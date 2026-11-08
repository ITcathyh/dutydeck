import { describe, expect, it } from 'vitest';
import { parseUnixSocketState, unixSocketState } from './unix-socket.js';

const header = 'Num       RefCount Protocol Flags    Type St Inode Path';
const table = (...rows: string[]) => [header, ...rows, ''].join('\n');
const listening = (path: string) => `0000000000000000: 00000002 00000000 00010000 0001 01 1770351096 ${path}`;
const anonymous = '0000000000000000: 00000003 00000000 00000000 0001 03 1770351097';

describe('parseUnixSocketState', () => {
  it('reports a path bound in the kernel table', () => {
    expect(parseUnixSocketState(table(anonymous, listening('/tmp/tmux-1000/default')), '/tmp/tmux-1000/default')).toBe('bound');
  });

  it('reports an absent path as unbound, including prefixes and anonymous rows', () => {
    expect(parseUnixSocketState(table(anonymous, listening('/tmp/tmux-1000/default-old')), '/tmp/tmux-1000/default')).toBe('unbound');
    expect(parseUnixSocketState(table(), '/tmp/tmux-1000/default')).toBe('unbound');
  });

  it('keeps paths with spaces intact', () => {
    expect(parseUnixSocketState(table(listening('/tmp/a dir/default')), '/tmp/a dir/default')).toBe('bound');
  });

  it('is unknown when the header does not match', () => {
    expect(parseUnixSocketState(['Num RefCount Protocol Flags Type St Inode', listening('/x')].join('\n'), '/x')).toBe('unknown');
    expect(parseUnixSocketState('', '/x')).toBe('unknown');
  });

  it('is unknown when a row is malformed before the path is found', () => {
    expect(parseUnixSocketState(table('garbage row', listening('/x')), '/x')).toBe('unknown');
    expect(parseUnixSocketState(table('0000000000000000: 00000002 00000000 zz 0001 01 1 /y'), '/x')).toBe('unknown');
  });
});

describe('unixSocketState', () => {
  it.runIf(process.platform === 'linux')('reads the live kernel table on Linux', () => {
    expect(unixSocketState(`/nonexistent/dutydeck-${process.pid}-${Date.now()}`)).toBe('unbound');
  });

  it.runIf(process.platform !== 'linux')('is unknown off Linux', () => {
    expect(unixSocketState('/tmp/anything')).toBe('unknown');
  });
});
