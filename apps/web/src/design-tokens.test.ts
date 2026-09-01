import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  设计系统 token 的守卫（契约 §12.7：把数值白名单抄进测试）。

  botmux 的教训是这份契约的由来：它定义了 8 档字号 token，实际引用 41 次，
  硬编码 px 上千次。**Token 没有强制力就只是愿望。** 这里守两件事：
  1. 标度的数值与契约表格逐字一致——改档位必须同时改契约；
  2. 三层主题声明的顺序与结构不被打乱（顺序错了，显式浅色/深色选择会失效）。
*/

const webRoot = process.cwd().endsWith('/apps/web') ? process.cwd() : resolve(process.cwd(), 'apps/web');
const tokens = readFileSync(resolve(webRoot, 'src/tokens.css'), 'utf8');
const indexCss = readFileSync(resolve(webRoot, 'src/index.css'), 'utf8');

const declared = (name: string) => tokens.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();

describe('设计 token 与契约一致', () => {
  it('6 档字号，size 与 line-height 成对（契约 §2）', () => {
    const scale = {
      meta: ['11px', '16px'],
      caption: ['12px', '18px'],
      body: ['14px', '22px'],
      title: ['16px', '24px'],
      heading: ['20px', '28px'],
      display: ['28px', '36px']
    };
    for (const [step, [size, lineHeight]] of Object.entries(scale)) {
      expect(declared(`--font-size-${step}`), `--font-size-${step}`).toBe(size);
      expect(declared(`--line-height-${step}`), `--line-height-${step}`).toBe(lineHeight);
    }
  });

  it('4 档圆角 + full，按「元素高度 / 3.5」取档（契约 §3）', () => {
    expect(declared('--radius-sm')).toBe('6px');
    expect(declared('--radius-md')).toBe('10px');
    expect(declared('--radius-lg')).toBe('14px');
    expect(declared('--radius-xl')).toBe('20px');
    expect(declared('--radius-full')).toBe('999px');
  });

  it('5 档层级，模态与 Toast 在最上面（契约 §7）', () => {
    expect(declared('--z-base')).toBe('0');
    expect(declared('--z-sticky')).toBe('100');
    expect(declared('--z-drawer')).toBe('800');
    expect(declared('--z-dialog')).toBe('900');
    expect(declared('--z-toast')).toBe('1000');
  });

  it('2 档动效时长（契约 §8）', () => {
    expect(declared('--duration-fast')).toBe('120ms');
    expect(declared('--duration-normal')).toBe('180ms');
  });

  it('三层主题声明顺序不可调整，且注释留在原处', () => {
    expect(tokens).toContain('顺序不可调整');
    const bare = tokens.indexOf('\n:root {\n  color-scheme: light;');
    const media = tokens.indexOf('@media (prefers-color-scheme: dark)');
    const explicit = tokens.indexOf(':root[data-theme="dark"]');
    expect(bare).toBeGreaterThan(-1);
    // 顺序：裸 :root 浅色 → prefers-color-scheme 深色 → 显式 data-theme="dark"
    expect(media).toBeGreaterThan(bare);
    expect(explicit).toBeGreaterThan(media);
    // 第 2 层必须让显式浅色选择优先，否则「系统深色 + 选浅色」会失效。
    expect(tokens).toContain(':root:not([data-theme="light"])');
  });

  it('颜色 token 只在 tokens.css 定义，index.css 不再自带调色板', () => {
    expect(tokens).toContain('--surface-canvas: #f5f7f6;');
    expect(indexCss).toContain("@import './tokens.css';");
    expect(indexCss).not.toContain('--surface-canvas:');
    expect(indexCss).not.toContain('--status-danger:');
  });

  it('index.css 保留 @tailwind 指令、11 个 keyframes 与 .ui-* 动画类', () => {
    for (const directive of ['@tailwind base;', '@tailwind components;', '@tailwind utilities;']) expect(indexCss).toContain(directive);
    expect(indexCss.match(/@keyframes ui-/g)).toHaveLength(11);
    for (const animation of ['.ui-overlay', '.ui-dialog', '.ui-popover', '.ui-toast', '.ui-empty-state']) expect(indexCss).toContain(animation);
  });

  it('reduced-motion 的 4 条 !important 必须留在 index.css（app-smoke.test.ts:45 也在断言）', () => {
    const reduced = indexCss.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? '';
    expect(reduced).toContain('scroll-behavior: auto !important');
    expect(reduced).toContain('transition-duration: .01ms !important');
    expect(reduced).toContain('animation-duration: .01ms !important');
    expect(reduced).toContain('animation-iteration-count: 1 !important');
  });
});

describe('tailwind 语义类映射', () => {
  const config = readFileSync(resolve(webRoot, 'tailwind.config.js'), 'utf8');

  it('删除零引用的 ink / canvas / line / accent 死配置', () => {
    // 用词边界匹配：裸写 'ink:' 会命中 link，'accent:' 会命中 sidebar-accent。
    for (const dead of ['ink', 'line', 'accent']) expect(config).not.toMatch(new RegExp(`(^|[\\s{])${dead}:`, 'm'));
    // canvas 作为语义表面名保留，但必须指向 token 而不是旧的字面量 #f7f7f5。
    expect(config).toContain("canvas: 'var(--surface-canvas)'");
    expect(config).not.toContain('#f7f7f5');
    expect(config).not.toContain('#191a1d');
    expect(config).not.toContain('#d85d37');
  });

  it('text-muted 避让为 text-subtle，避免与 Tailwind 原生语义冲突（契约 §13）', () => {
    expect(config).toContain("subtle: 'var(--text-muted)'");
  });

  it('theme 里不出现颜色字面量，一律指向 token', () => {
    const hex = config.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hex).toEqual([]);
  });
});
