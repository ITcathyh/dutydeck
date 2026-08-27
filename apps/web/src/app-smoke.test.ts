import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App 集成冒烟（SSR 静态渲染）', () => {
  it('无激活会话时渲染空状态且不抛异常', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(App)));
    expect(html).toContain('选择 Agent，开始工作');
    expect(html).toContain('新建 Session');
    expect(html).toContain('Dockmux');
  });

  it('侧边栏包含会话列表与飞书设置入口', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(App)));
    expect(html).toContain('会话列表');
    expect(html).toContain('飞书设置');
    expect(html).toContain('归档会话');
  });
});
