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
