import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Toolbar } from './Toolbar';

// role=toolbar 让读屏把一排按钮当作一组播报，而不是 N 个孤立控件。
// 这些用例守的就是「工具栏退化成裸 div」这一类回归。

describe('Toolbar', () => {
  it('渲染带 aria-label 的 role=toolbar', () => {
    render(<Toolbar label="任务筛选"><button type="button">全部</button></Toolbar>);
    expect(screen.getByRole('toolbar', { name: '任务筛选' })).toBeTruthy();
  });

  it('children 原样渲染在工具栏里', () => {
    render(<Toolbar label="任务筛选">
      <button type="button">全部</button>
      <button type="button">运行中</button>
      <span>共 3 个</span>
    </Toolbar>);
    const toolbar = screen.getByRole('toolbar', { name: '任务筛选' });
    expect(within(toolbar).getAllByRole('button').map(node => node.textContent)).toEqual(['全部', '运行中']);
    expect(within(toolbar).getByText('共 3 个')).toBeTruthy();
  });

  it('显式声明横向排列，读屏播报方向不靠猜', () => {
    render(<Toolbar label="任务筛选"><button type="button">全部</button></Toolbar>);
    expect(screen.getByRole('toolbar', { name: '任务筛选' }).getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('工具栏本身有最小高度并允许换行，窄屏不挤压控件', () => {
    render(<Toolbar label="任务筛选"><button type="button">全部</button></Toolbar>);
    const toolbar = screen.getByRole('toolbar', { name: '任务筛选' });
    expect(toolbar.className).toContain('min-h-14');
    expect(toolbar.className).toContain('flex-wrap');
    expect(toolbar.className).toContain('shrink-0');
  });

  it('只使用语义 token 颜色，不出现硬编码调色板', () => {
    render(<Toolbar label="任务筛选"><button type="button">全部</button></Toolbar>);
    const className = screen.getByRole('toolbar', { name: '任务筛选' }).className;
    for (const banned of ['zinc-', 'slate-', 'bg-white', 'bg-black']) expect(className).not.toContain(banned);
  });
});
