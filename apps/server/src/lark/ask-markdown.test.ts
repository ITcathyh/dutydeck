import { describe, expect, it } from 'vitest';
import { renderQuestionMarkdown } from './ask-markdown.js';

describe('renderQuestionMarkdown', () => {
  it('保留带标签的 http/https 网页链接，其余 Markdown 特殊字符仍转义', () => {
    const out = renderQuestionMarkdown(
      'Review [design](https://example.com/design?id=4&rev=2) and [preview](http://localhost:3000/path_(v2)) before _confirming_.'
    );
    expect(out).toContain('[design](https://example.com/design?id=4&rev=2)');
    expect(out).toContain('[preview](http://localhost:3000/path_%28v2%29)');
    expect(out).toContain('\\_confirming\\_');
  });

  it('不支持的协议、图片、转义与残缺链接按字面文本展示', () => {
    const out = renderQuestionMarkdown(
      String.raw`literal \[escaped](https://example.com) ![image](https://example.com/a.png) [unsafe](javascript:alert(1)) [file](file:///tmp/a) [broken](https://example.com`
    );
    for (const label of ['escaped', 'image', 'unsafe', 'file', 'broken']) {
      expect(out).toContain(`\\[${label}\\]`);
    }
  });

  it('无链接文本保持原有转义行为', () => {
    expect(renderQuestionMarkdown('普通问题')).toBe('普通问题');
    expect(renderQuestionMarkdown('a*b')).toBe('a\\*b');
  });

  it('保留 @ 提及结构，不转义其 ID 中的下划线', () => {
    const out = renderQuestionMarkdown('确认 <at id=ou_user_x></at> 吗？ [doc](https://x.io/d)');
    expect(out).toContain('<at id=ou_user_x></at>');
    expect(out).toContain('[doc](https://x.io/d)');
  });

  it('链接文字里的 Markdown 特殊字符被转义，链接本身仍可用', () => {
    const out = renderQuestionMarkdown('[a_b](https://example.com/path)');
    expect(out).toBe('[a\\_b](https://example.com/path)');
  });
});
