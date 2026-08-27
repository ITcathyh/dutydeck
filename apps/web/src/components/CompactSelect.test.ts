import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CompactSelect } from './CompactSelect';

describe('CompactSelect', () => {
  it('renders the selected option label', () => {
    const html = renderToStaticMarkup(createElement(CompactSelect, {
      options: [{ value: 'a', label: '选项 A' }, { value: 'b', label: '选项 B' }],
      value: 'b',
      placeholder: '选择',
      disabledText: '不可用',
      onChange: () => {}
    }));
    expect(html).toContain('选项 B');
  });

  it('renders disabledText when there are no options', () => {
    const html = renderToStaticMarkup(createElement(CompactSelect, {
      options: [],
      value: '',
      placeholder: '选择',
      disabledText: '未扫描到可用 Agent',
      disabled: true,
      onChange: () => {}
    }));
    expect(html).toContain('未扫描到可用 Agent');
  });
});
