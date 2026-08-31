import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App 集成冒烟（SSR 静态渲染）', () => {
  it('无激活运行时渲染工作台总览且不抛异常', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(App)));
    expect(html).toContain('今天需要推进什么');
    expect(html).toContain('准备 Agent');
    expect(html).toContain('绑定 Bot');
    expect(html).toContain('任务中心');
    expect(html).toContain('Dockmux');
  });

  it('侧边栏包含任务视图、工作区与飞书指挥台入口', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(App)));
    expect(html).toContain('任务视图');
    expect(html).toContain('进行中');
    expect(html).toContain('待你处理');
    expect(html).toContain('失败');
    expect(html).toContain('工作区');
    expect(html).toContain('飞书协作');
    expect(html).toContain('有排队的运行');
    expect(html).toContain('已完成');
    expect(html).toContain('已归档');
  });

  it('为 reduced-motion 用户关闭滚动和持续动效', () => {
    const cssPath = process.cwd().endsWith('/apps/web')
      ? resolve(process.cwd(), 'src/index.css')
      : resolve(process.cwd(), 'apps/web/src/index.css');
    const css = readFileSync(cssPath, 'utf8');
    const reducedMotion = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? '';
    expect(reducedMotion).toContain('scroll-behavior: auto !important');
    expect(reducedMotion).toContain('transition-duration: .01ms !important');
    expect(reducedMotion).toContain('animation-duration: .01ms !important');
    expect(reducedMotion).toContain('animation-iteration-count: 1 !important');
  });
});
