import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
// @ts-expect-error The build script is plain ESM without declarations.
import { asciiSource } from './ascii-bundle.mjs';

const str = (value: string) => JSON.stringify(value).replace(/[^\x00-\x7f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const run = (code: string) => runInNewContext(`(() => { ${code} })()`);

describe('asciiSource', () => {
  it('keeps comment layout and gives regular expressions equivalent escapes', () => {
    const code = [
      '/** 完成时只贴表情 */',
      'const a = /[。！？.!?]$/, b = /^─{8,}$/m, c = /[一-龥]+/g, d = /x😀+/u, e = /[😀]/, f = /\\中/, g = /\\\\中/;',
      'const half = 10 / 2 / 5; // 除法不是正则：「/中/」',
      'const t = `${half}${{ k: new RegExp(/[。😀]/u.source + "$", "u").test("\\ud83d\\ude00") }.k}`; /* 多行',
      '   注释 */',
      // Strings reach the rewrite already escaped, as esbuild emits them.
      `return [a.test(${str('好。')}), b.test(${str('─'.repeat(8))}), ${str('汉字abc')}.match(c)[0], d.test(${str('x😀😀')}), e.test(${str('\ude00')}), f.test(${str('中')}), g.test(${str('\\中')}), half, t];`
    ].join('\n');
    const output = asciiSource(code);
    expect(output).toMatch(/^[\x00-\x7f]*$/);
    expect(output.split('\n')[0]).toBe('/** ??????? */');
    expect(output.split('\n')).toHaveLength(code.split('\n').length);
    expect(run(output)).toEqual(run(code));
  });

  it('refuses text it cannot rewrite without changing behaviour', () => {
    expect(() => asciiSource('const raw = String.raw`中`;')).toThrow(/tagged literal/);
    expect(() => asciiSource('const named = /(?<名>a)/;')).toThrow(/capture group name/);
    expect(() => asciiSource('const s = "中";')).toThrow(/string literal/);
  });

  it('escapes lookbehind contents, which are not group names', () => {
    expect(run(asciiSource('return /(?<=中)a/.test("\\u4e2da");'))).toBe(true);
  });

  it('leaves ASCII input untouched', () => {
    const code = 'const a = /x/; // plain\n';
    expect(asciiSource(code)).toBe(code);
  });
});
