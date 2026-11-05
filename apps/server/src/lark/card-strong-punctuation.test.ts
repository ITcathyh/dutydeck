import { fromMarkdown } from 'mdast-util-from-markdown';
import { describe, expect, it } from 'vitest';
import { repairCardStrongPunctuation } from './card-strong-punctuation.js';
import { renderLarkResultTextElements } from './card-renderer.js';

interface Node { type: string; value?: string; children?: Node[] }

const flatten = (node: Node): string => node.value ?? (node.children ?? []).map(flatten).join('');

/** 按 CommonMark 解析后，各粗体节点的可见文字。 */
function strongTexts(text: string): string[] {
  const found: string[] = [];
  const walk = (node: Node) => {
    if (node.type === 'strong') found.push(flatten(node));
    node.children?.forEach(walk);
  };
  walk(fromMarkdown(text) as Node);
  return found;
}

/** 解析后仍留在正文里的字面量星号个数。 */
function literalStars(text: string): number {
  let count = 0;
  const walk = (node: Node) => {
    if (node.type === 'text') count += (node.value ?? '').split('*').length - 1;
    node.children?.forEach(walk);
  };
  walk(fromMarkdown(text) as Node);
  return count;
}

const fence = '```';

describe('repairCardStrongPunctuation: 把标点移到闭合 ** 外侧', () => {
  it.each([
    ['**空数据边界：**当前平台函数', '**空数据边界**：当前平台函数', ['空数据边界']],
    ['**结论：**正文', '**结论**：正文', ['结论']],
    ['**说明（重要）**后面', '**说明（重要**）后面', ['说明（重要']],
    ['说明**（重要）**后面', '说明（**重要**）后面', ['重要']],
    ['**a:**b', '**a**:b', ['a']],
    ['**结论。**下一步', '**结论**。下一步', ['结论']],
    ['**真的吗？！**是的', '**真的吗**？！是的', ['真的吗']],
    ['- **标签：**正文', '- **标签**：正文', ['标签']],
    ['> **引用：**正文', '> **引用**：正文', ['引用']],
    ['1. **第一步：**安装', '1. **第一步**：安装', ['第一步']],
    ['**用 `bun`：**安装', '**用 `bun`**：安装', ['用 bun']]
  ])('%s', (input, expected, strong) => {
    const repaired = repairCardStrongPunctuation(input);
    expect(repaired).toBe(expected);
    expect(repaired).toHaveLength(input.length);
    expect(strongTexts(repaired)).toEqual(strong);
    expect(literalStars(repaired)).toBe(0);
    // 幂等：修复后的文本本身就能渲染。
    expect(repairCardStrongPunctuation(repaired)).toBe(repaired);
  });

  it('多行文本逐处修复，其余字节不变', () => {
    const input = ['**背景：**线上报错', '', '**原因（已确认）**配置缺失', '', '**你好**再见'].join('\n');
    expect(repairCardStrongPunctuation(input)).toBe(
      ['**背景**：线上报错', '', '**原因（已确认**）配置缺失', '', '**你好**再见'].join('\n'));
  });

  it('相邻行的错配粗体一并拆开修复', () => {
    // 不修复时，第 2 行的闭合与第 3 行的开头会跨行配成一个粗体。
    const input = ['**空数据边界：**当前平台函数', '**说明（重要）**后面是正文', '说明**（重要）**后面是正文'].join('\n');
    const repaired = repairCardStrongPunctuation(input);
    expect(repaired).toBe(['**空数据边界**：当前平台函数', '**说明（重要**）后面是正文', '说明（**重要**）后面是正文'].join('\n'));
    expect(strongTexts(repaired)).toEqual(['空数据边界', '说明（重要', '重要']);
    expect(literalStars(repaired)).toBe(0);
  });

  it('保留本来就跨行的粗体', () => {
    const input = '**第一行\n第二行**正文';
    expect(repairCardStrongPunctuation(input)).toBe(input);
  });

  it('表格单元格里的标签也修复', () => {
    const input = ['| 项 | 说明 |', '| --- | --- |', '| a | **注意：**必填 |'].join('\n');
    expect(repairCardStrongPunctuation(input)).toBe(input.replace('**注意：**必填', '**注意**：必填'));
  });

  it('同行后面已有效的粗体不动', () => {
    expect(repairCardStrongPunctuation('**a：**b **c**')).toBe('**a**：b **c**');
  });

  it('个别候选配不上时，其余候选仍然修复（回退分块验证）', () => {
    const stray = '**注意：**正文**';
    const input = [stray, '', ...Array.from({ length: 100 }, (_, i) => `- **要点${i}：**说明文字`)].join('\n');
    const repaired = repairCardStrongPunctuation(input);
    expect(repaired.startsWith(`${stray}\n`)).toBe(true);
    expect(repaired).toContain('**要点99**：说明文字');
    expect(repaired.match(/要点\d+：\*\*/g) ?? []).toHaveLength(0);
    expect(repairCardStrongPunctuation(repaired)).toBe(repaired);
  });

  it('链接文字里的粗体不动，链接之外的照常修复', () => {
    expect(repairCardStrongPunctuation('详见 [**文档：**说明](https://example.com)，**结论：**可用'))
      .toBe('详见 [**文档：**说明](https://example.com)，**结论**：可用');
  });

  it('同一行前面有网址时，被汉字隔开的粗体照常修复，紧贴网址的不动', () => {
    expect(repairCardStrongPunctuation('见 https://example.com，**结论：**可用')).toBe('见 https://example.com，**结论**：可用');
    expect(repairCardStrongPunctuation('见https://example.com/**a:**b')).toBe('见https://example.com/**a:**b');
  });

  it('代码块里的内容不动，块外的修复', () => {
    const input = ['**空数据边界：**当前平台函数', '', fence, '**空数据边界：**当前平台函数', fence].join('\n');
    expect(repairCardStrongPunctuation(input))
      .toBe(['**空数据边界**：当前平台函数', '', fence, '**空数据边界：**当前平台函数', fence].join('\n'));
  });
});

describe('repairCardStrongPunctuation: 多个粗体相邻时按开闭配对', () => {
  it.each([
    // 前一个粗体的闭合不能和后一个粗体的开头配成一对。
    ['**甲**：乙**丙：**丁', '**甲**：乙**丙**：丁', ['甲', '丙']],
    // 配不上的闭合被当成开头、与后面的 ** 配错的粗体，两端都能配成新粗体时拆开重配。
    ['**甲：**乙**丙：**丁', '**甲**：乙**丙**：丁', ['甲', '丙']],
    ['**a：**b**c：**d **e**f', '**a**：b**c**：d **e**f', ['a', 'c', 'e']],
    ['说明**（重要）**后面**（备注）**结尾', '说明（**重要**）后面（**备注**）结尾', ['重要', '备注']]
  ])('%s', (input, expected, strong) => {
    const repaired = repairCardStrongPunctuation(input);
    expect(repaired).toBe(expected);
    expect(strongTexts(repaired)).toEqual(strong);
    expect(literalStars(repaired)).toBe(0);
    expect(repairCardStrongPunctuation(repaired)).toBe(repaired);
  });

  it('每行都是相邻粗体时逐行修复（上一行末尾不再配到下一行）', () => {
    const input = Array.from({ length: 50 }, () => '**甲**：乙**丙：**丁').join('\n');
    const repaired = repairCardStrongPunctuation(input);
    expect(repaired).toBe(Array.from({ length: 50 }, () => '**甲**：乙**丙**：丁').join('\n'));
    expect(literalStars(repaired)).toBe(0);
  });
});

describe('repairCardStrongPunctuation: 不拆合法粗体', () => {
  it.each([
    ['跨行粗体后接标点', '**第一行\n第二行**（重要），a**b'],
    ['跨行粗体后接标点（无尾随星号）', '**第一行\n第二行**（重要）'],
    ['开头紧跟标点的同行粗体', '结论：**很重要**'],
    ['开头紧跟标点的粗体后有残缺星号', '**结论：**很重要**']
  ])('%s', (_label, input) => {
    expect(repairCardStrongPunctuation(input)).toBe(input);
  });
});

describe('repairCardStrongPunctuation: 耗时有上界', () => {
  /** 按 UTF-8 字节数重复到上限以内。 */
  const fill = (unit: string, bytes: number) => {
    const count = Math.floor(bytes / Buffer.byteLength(`${unit}\n`, 'utf8'));
    return Array.from({ length: count }, () => unit).join('\n');
  };
  const fastest = (text: string) => {
    let best = Infinity;
    let output = '';
    for (let round = 0; round < 3; round++) {
      const started = performance.now();
      output = repairCardStrongPunctuation(text);
      best = Math.min(best, performance.now() - started);
    }
    return { best, output };
  };

  it('上限内星号最密的正文仍全部修复，且在 200ms 内', () => {
    // 每行 4 个 **、其中一对配不上：旧实现在 1000 行（约 16KB）上要跑一分钟以上。500 行恰好用满 ** 上限。
    const cjk = Array.from({ length: 500 }, () => '**甲**：乙**丙：**丁').join('\n');
    const cjkResult = fastest(cjk);
    expect(cjkResult.output).toBe(cjk.replaceAll('**丙：**丁', '**丙**：丁'));
    expect(cjkResult.best).toBeLessThan(200);

    const ascii = Array.from({ length: 500 }, () => '**a**:b**c:**d').join('\n');
    const asciiResult = fastest(ascii);
    expect(asciiResult.output).toBe(ascii.replaceAll('**c:**d', '**c**:d'));
    expect(asciiResult.best).toBeLessThan(200);
  });

  it('超过字节或星号上限的正文原样返回', () => {
    const long = fill('**甲**：乙**丙：**丁', 64 * 1024);
    const longResult = fastest(long);
    expect(longResult.output).toBe(long);
    expect(longResult.best).toBeLessThan(200);
    const dense = Array.from({ length: 501 }, () => '**a**:b**c:**d').join('\n');
    expect(repairCardStrongPunctuation(dense)).toBe(dense);
  });
});

describe('repairCardStrongPunctuation: 随机输入的不变量', () => {
  it('长度不变、幂等，改写只会让字面量星号变少、粗体变多', () => {
    const pieces = ['**', '**', '*', '甲', 'a', '：', '（', '）', ',', ' ', '\n', '`', '_', '[', '](u)'];
    let seed = 42;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let sample = 0; sample < 3000; sample++) {
      const input = Array.from({ length: 4 + Math.floor(random() * 16) }, () => pieces[Math.floor(random() * pieces.length)]).join('');
      const repaired = repairCardStrongPunctuation(input);
      expect(repaired.length, input).toBe(input.length);
      expect(repairCardStrongPunctuation(repaired), input).toBe(repaired);
      if (repaired !== input) {
        expect(literalStars(repaired), input).toBeLessThan(literalStars(input));
        expect(strongTexts(repaired).length, input).toBeGreaterThan(strongTexts(input).length);
      }
    }
  });
});

describe('repairCardStrongPunctuation: 其余内容逐字节不变', () => {
  it.each([
    ['已能配对：无标点', '**你好**再见'],
    ['已能配对：标点在外侧', '**你好**：再见'],
    ['已能配对：闭合后有空格', '**你好：** 再见'],
    ['已能配对：闭合后是行尾', '**你好：**'],
    ['已能配对：闭合后是标点', '**你好：**，再见'],
    ['已能配对：整行粗体', '**说明（重要）**'],
    ['单星号斜体', '*标签：*正文'],
    ['下划线粗体', '__标签：__正文'],
    ['三星号', '***标签：***正文'],
    ['嵌套斜体', '**标签 *重点*：**正文'],
    ['转义的开头', '\\**标签：**正文'],
    ['转义的闭合', '**标签：\\**正文'],
    ['转义的标点', '**a\\:**b'],
    ['行内代码', '`**标签：**正文`'],
    ['双反引号行内代码', '``**标签：**正文``'],
    ['围栏代码块', [fence, '**标签：**正文', fence].join('\n')],
    ['波浪线围栏', ['~~~', '**标签：**正文', '~~~'].join('\n')],
    ['缩进代码块', ['段落', '', '    **标签：**正文'].join('\n')],
    ['链接文字', '[**标签：**正文](https://example.com)'],
    ['链接地址', '[文档](https://example.com/**a：**b)'],
    ['图片说明', '![**图：**说明](https://example.com/a.png)'],
    ['裸链接', 'https://example.com/**a:**b'],
    ['跨行不成对', '**标签：\n**正文'],
    ['跨段落不成对', '**标签：\n\n**正文'],
    ['星号不成对', '**标签：**正文**'],
    ['内侧只有标点', '文**：**字'],
    ['飞书字体标签', "**<font color='red'>注意：</font>**正文"],
    ['内含删除线', '**~~旧~~：**正文'],
    // 挪动标点会改变同行下划线斜体的配对，复核发现斜体数变化就放弃。
    ['下划线斜体相邻（开头标点）', 'b**/_**_'],
    ['下划线斜体相邻（结尾标点）', '**_，**p_'],
    ['没有星号', '标签：正文'],
    ['空串', '']
  ])('%s', (_label, input) => {
    expect(repairCardStrongPunctuation(input)).toBe(input);
  });
});

describe('repairCardStrongPunctuation: 幂等', () => {
  it('对任何输入重复处理，结果与处理一次相同', () => {
    const inputs = [
      '**空数据边界：**当前平台函数', '**说明（重要）**后面', '说明**（重要）**后面',
      ['**背景：**线上报错', '**说明（重要）**后面是正文', '说明**（重要）**后面是正文'].join('\n'),
      '详见 [**文档：**说明](https://example.com)，**结论：**可用',
      ['**标签：**正文', fence, '**标签：**正文', fence].join('\n'),
      '**注意：**正文**', '**a：**b **c**', '**你好**再见', '', '没有星号'
    ];
    for (const input of inputs) {
      const once = repairCardStrongPunctuation(input);
      expect(repairCardStrongPunctuation(once)).toBe(once);
    }
  });
});

describe('卡片正文出口', () => {
  it('结果卡正文使用修复后的 markdown', () => {
    const [element] = renderLarkResultTextElements('**结论：**可以上线');
    expect(element?.content).toBe('**结论**：可以上线');
  });
});
