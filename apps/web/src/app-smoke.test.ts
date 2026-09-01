import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import App from './App';
import { workbenchViewLabels, workbenchViewOrder } from './workspace-model';

describe('App 集成冒烟（SSR 静态渲染）', () => {
  it('无激活任务时渲染工作台总览且不抛异常', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(App)));
    expect(html).toContain('今天需要推进什么');
    expect(html).toContain('任务中心');
    expect(html).toContain('Dockmux');
    // SSR 时 agents 查询还没落地，此刻既不知道有没有 Agent，就不能替用户下结论。
    // 「准备 Agent」曾经在这里出现，是把「查询未完成」误读成「没有 Agent」。
    expect(html).toContain('正在检测 Agent…');
    expect(html).not.toContain('准备 Agent');
  });

  it('侧边栏只保留工作区导航与设置入口，状态筛选归总览页', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(App)));
    expect(html).toContain('工作区');
    expect(html).toContain('Agent 与设置');
    expect(html).toContain('飞书协作');
    // 侧栏不再有 7 项状态导航，也不再有「绑定 Bot」按钮。
    expect(html).not.toContain('任务视图');
    expect(html).not.toContain('绑定 Bot');
    expect(html).not.toContain('有排队的运行');
  });

  it('总览页渲染 5 项状态筛选，顺序即数字快捷键顺序', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(App)));
    const positions = workbenchViewOrder.map(view => html.indexOf(`>${workbenchViewLabels[view]}<`));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    // 「失败」并入「待你处理」，不再单列为筛选项。
    expect(html).not.toContain('>失败<');
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
