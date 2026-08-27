import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

const baseProps = { title: '确认删除？', description: '删除后不可恢复。', confirmLabel: '确认', onConfirm: () => {}, onCancel: () => {} };

describe('ConfirmDialog', () => {
  it('renders title, description and confirm button when open', () => {
    const html = renderToStaticMarkup(createElement(ConfirmDialog, { ...baseProps, open: true }));
    expect(html).toContain('确认删除？');
    expect(html).toContain('删除后不可恢复。');
    expect(html).toContain('确认');
  });

  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(createElement(ConfirmDialog, { ...baseProps, open: false }));
    expect(html).toBe('');
  });
});
