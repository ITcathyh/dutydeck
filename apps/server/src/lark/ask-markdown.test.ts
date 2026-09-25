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
    expect(renderQuestionMarkdown('a & b')).toBe('a &amp; b');
  });

  it('转义 @ 提及结构与 ID 中的下划线，按字面文本展示', () => {
    const out = renderQuestionMarkdown('确认 <at id=ou_user_x></at> 吗？ [doc](https://x.io/d)');
    expect(out).not.toContain('<at id=ou_user_x></at>');
    expect(out).toContain('&lt;at id=ou\\_user\\_x&gt;&lt;/at&gt;');
    expect(out).toContain('[doc](https://x.io/d)');
  });

  it('HTML 与飞书标签（如 <at id=all>、<at user_id=...>、<font>）均转义按字面显示', () => {
    const out = renderQuestionMarkdown(
      '提示 <at id=all></at> 与 <at user_id="ou_x"></at> 以及 <font color="red">x</font> 内容 [链接](https://example.com/doc)'
    );
    expect(out).toContain('&lt;at id=all&gt;&lt;/at&gt;');
    expect(out).toContain('&lt;at user\\_id="ou\\_x"&gt;&lt;/at&gt;');
    expect(out).toContain('&lt;font color="red"&gt;x&lt;/font&gt;');
    expect(out).toContain('[链接](https://example.com/doc)');
    // 渲染结果里不出现未转义的 <
    expect(out).not.toContain('<');
  });

  it('链接文字里的 Markdown 特殊字符被转义，链接本身仍可用', () => {
    const out = renderQuestionMarkdown('[a_b](https://example.com/path)');
    expect(out).toBe('[a\\_b](https://example.com/path)');
    expect(renderQuestionMarkdown('[a & b < c>](https://example.com/path)')).toBe(
      '[a &amp; b &lt; c&gt;](https://example.com/path)'
    );
  });
});
