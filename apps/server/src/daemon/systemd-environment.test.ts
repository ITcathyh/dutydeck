import { describe, expect, it } from 'vitest';
import { parseSystemdEnvironmentFile, splitSystemdShowStrings } from './systemd-environment.js';

describe('splitSystemdShowStrings', () => {
  it('keeps quoted assignments with spaces and escapes whole', () => {
    expect(splitSystemdShowStrings('PATH=/usr/bin "DUTYDECK_DEFAULT_CWD=tag workspace" "NOTE=say \\"hi\\" \\$HOME \\\\ end"  EMPTY='))
      .toEqual(['PATH=/usr/bin', 'DUTYDECK_DEFAULT_CWD=tag workspace', 'NOTE=say "hi" $HOME \\ end', 'EMPTY=']);
    expect(splitSystemdShowStrings('')).toEqual([]);
  });
});

describe('parseSystemdEnvironmentFile', () => {
  it('follows systemd EnvironmentFile= rules rather than shell or dotenv rules', () => {
    const text = [
      '# comment',
      '; also a comment',
      '  DUTYDECK_PORT=4311  ',
      'DUTYDECK_AUTH = false',
      'DUTYDECK_DATABASE_URL="/srv/tag runtime/tag.db"',
      "SINGLE='keep \\n as is'",
      'DOUBLE="a\\"b\\$c\\qd"',
      'UNQUOTED=one\\ two\\',
      'continued',
      'MIXED="quoted part"tail',
      'EMPTY=',
      'NO_ASSIGNMENT',
      'DUTYDECK_PORT=4312'
    ].join('\n');
    expect(parseSystemdEnvironmentFile(text)).toEqual({
      DUTYDECK_PORT: '4312',
      DUTYDECK_AUTH: 'false',
      DUTYDECK_DATABASE_URL: '/srv/tag runtime/tag.db',
      SINGLE: 'keep \\n as is',
      DOUBLE: 'a"b$c\\qd',
      UNQUOTED: 'one twocontinued',
      MIXED: 'quoted parttail',
      EMPTY: ''
    });
  });

  it('accepts a final line without a trailing newline', () => {
    expect(parseSystemdEnvironmentFile('A=1\nB="two words"')).toEqual({ A: '1', B: 'two words' });
  });
});
