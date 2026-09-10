import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  设计系统 token 的守卫（契约 §12.7：把数值白名单抄进测试）。

  botmux 的教训是这份契约的由来：它定义了 8 档字号 token，实际引用 41 次，
  硬编码 px 上千次。**Token 没有强制力就只是愿望。** 这里守四件事：
  1. 标度的数值与契约表格逐字一致——改档位必须同时改契约；
  2. 三层主题声明的顺序与结构不被打乱（顺序错了，显式浅色/深色选择会失效）；
  3. 灰阶的**色相**不再走偏（2026-09-03 重做的起因，见下面那条断言的注释）；
  4. 三档文字在四个表面上实算 ≥4.5:1——AA 不能靠肉眼判断。
*/

const webRoot = process.cwd().endsWith('/apps/web') ? process.cwd() : resolve(process.cwd(), 'apps/web');
const tokens = readFileSync(resolve(webRoot, 'src/tokens.css'), 'utf8');
const indexCss = readFileSync(resolve(webRoot, 'src/index.css'), 'utf8');

const declared = (name: string) => tokens.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();

/**
 * 取某一层主题声明块里的全部 token。三层用各自的选择器定位，避免第 1 层的
 * 浅色值被后面两层的同名 token 覆盖掉（`declared` 用的是全文首次匹配）。
 */
function layer(selector: string): Record<string, string> {
  const start = tokens.indexOf(selector);
  if (start < 0) throw new Error(`找不到主题层：${selector}`);
  const open = tokens.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < tokens.length; end++) {
    if (tokens[end] === '{') depth++;
    else if (tokens[end] === '}' && --depth === 0) break;
  }
  const out: Record<string, string> = {};
  for (const match of tokens.slice(open, end).matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[match[1]] = match[2].trim();
  return out;
}

const lightLayer = layer('\n:root {\n  color-scheme: light;');
const mediaLayer = { ...lightLayer, ...layer('@media (prefers-color-scheme: dark)') };
const darkLayer = { ...lightLayer, ...layer(':root[data-theme="dark"]') };

const channels = (hex: string): [number, number, number] =>
  [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** 顺着 var(--x) 链求值，拿到最终的字面量（侧栏 token 全是 var() 引用）。 */
function value(map: Record<string, string>, name: string): string {
  let current = map[name];
  for (let hop = 0; hop < 8 && current?.startsWith('var('); hop++) current = map[current.slice(4, -1)];
  if (!/^#[0-9a-f]{6}$/i.test(current ?? '')) throw new Error(`${name} 不是六位十六进制：${current}`);
  return current;
}

/** WCAG 2.1 相对亮度与对比度。 */
const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

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

  it('布局骨架 2 档，对齐 botmux dashboard（契约 §6）', () => {
    // 侧栏宽度曾在 SessionList.tsx 里硬编码 292px，比 botmux 宽 44px。
    expect(declared('--topbar-h')).toBe('56px');
    expect(declared('--sidebar-w')).toBe('248px');
  });

  it('浮动侧栏的几何等式只有一个来源（契约 §15）', () => {
    /*
      侧栏是 position: fixed 的浮动卡片，「它占多宽」这件事被拆给了两个文件：
      SessionList.tsx 写 left/top/bottom 插入距离，App.tsx 写主区 margin-left。
      本轮是两个并发团队各改一半——最容易漂移的形状就是这种。

      所以 --main-inset 必须是算出来的而不是抄出来的：写死 280px 的话，
      有人改了 --sidebar-w 就会留下一条 44px 的空隙或者压住正文，而且**没有任何
      测试会红**。这条断言就是防这个。
    */
    expect(declared('--shell-gap')).toBe('16px');
    expect(declared('--main-inset')).toBe('calc(var(--sidebar-w) + var(--shell-gap) * 2)');
    expect(declared('--main-inset')).not.toMatch(/\d+px/);
  });

  it('不复制 botmux 的 topbar off-by-4 bug（契约 §15）', () => {
    /*
      botmux 有两个顶栏高度 token：--topbar-h(56px) 只被侧栏的 top 消费，
      顶栏自己用的是 --topbar-height(60px)。侧栏因此比顶栏低 4px。
      那是 bug 不是设计，抄样式时极易连着抄进来。

      只扫**声明**不扫注释：上面 tokens.css 里正解释着这个 bug，字面量 naive 匹配
      会被自己的文档绊倒（本条断言初版就是这么红的）。
    */
    const withoutComments = tokens.replace(/\/\*[\s\S]*?\*\//g, '');
    const declarations = [...withoutComments.matchAll(/(--topbar-[a-z-]*)\s*:/g)].map(match => match[1]);
    expect([...new Set(declarations)]).toEqual(['--topbar-h']);
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
    expect(tokens).toContain('--surface-canvas: #f4f5f8;');
    expect(indexCss).toContain("@import './tokens.css';");
    expect(indexCss).not.toContain('--surface-canvas:');
    expect(indexCss).not.toContain('--status-danger:');
  });

  it('中性色一律 B ≥ G：灰阶不许再带绿（2026-09-03 重做的判据）', () => {
    /*
      重做前 dutydeck 的全部中性色都是 G > B——页面底 #f5f7f6、正文 #17201f、
      边框 #dce3e1，肉眼读作「脏」和「旧」。这是用户说「太难看」最直接的来源，
      不是细节不精致。对齐 botmux 后统一为冷灰蓝：**绿通道不得高于蓝通道**。

      只约束中性色。语义色不在此列——绿色的「成功」就该是绿的，
      warning / attention 是暖黄，它们的 G > B 是正确的。
    */
    const neutral = /^--(surface|text|border|scrollbar|focus-ring|sidebar|terminal|code)/;
    const offenders: string[] = [];
    for (const [name, map] of [['浅色', lightLayer], ['深色', darkLayer], ['深色(系统)', mediaLayer]] as const) {
      for (const token of Object.keys(map)) {
        if (!neutral.test(token)) continue;
        let hex: string;
        try { hex = value(map, token); } catch { continue; }   // rgba() 与阴影不在此检查内
        const [, g, b] = channels(hex);
        if (b < g) offenders.push(`${name} ${token}: ${hex}（G=${g} > B=${b}）`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('品牌色是靛蓝，不是墨绿（对齐 botmux dashboard）', () => {
    expect(lightLayer['--action-primary']).toBe('#4f56e8');
    expect(darkLayer['--action-primary']).toBe('#7b82f5');
    expect(mediaLayer['--action-primary']).toBe('#7b82f5');
    // 墨绿那一支必须彻底从**取值**里消失，否则就是只改了一半。
    // 注意只查取值不查全文：文件头的注释记录了「重做前是 #0f766e」这段病历，那是文档不是配色。
    const teal = ['#0f766e', '#0b5f59', '#2dd4bf', '#5eead4', '#e6f3f1', '#04211d'];
    for (const map of [lightLayer, darkLayer, mediaLayer]) {
      expect(Object.entries(map).filter(([, v]) => teal.includes(v.toLowerCase()))).toEqual([]);
    }
  });

  it('侧栏跟随主题，不再是独立深色盘（契约 §6 已同步修订）', () => {
    /*
      重做前 33 个 --sidebar-* 是一套双主题恒深色的独立盘：浅色主题下左边杵一条
      深色导航条，和内容区割裂，共享原语套上去还会「深字压深底」。
      botmux 的侧栏跟随主题，它的 tokens 里根本没有 sidebar 专用色。

      token 名保留（消费方还在引用），但值必须是 var() 引用而非自带字面量，
      且只在浅色层声明一次——深色层重新声明就意味着又分叉出了独立盘。
    */
    const sidebar = Object.keys(lightLayer).filter(name => name.startsWith('--sidebar-'));
    expect(sidebar.length).toBeGreaterThan(0);
    for (const name of sidebar) expect(lightLayer[name], name).toMatch(/^var\(--[a-z-]+\)$/);
    for (const [label, block] of [['深色', ':root[data-theme="dark"]'], ['深色(系统)', '@media (prefers-color-scheme: dark)']] as const) {
      expect(Object.keys(layer(block)).filter(name => name.startsWith('--sidebar-')), label).toEqual([]);
    }
  });

  it('三档文字在四个表面上都 ≥4.5:1（契约 §6 的 WCAG AA 下限）', () => {
    /*
      实算，不靠肉眼。侧栏跟随主题后这条尤其要守：侧栏底色现在就是
      surface-default / surface-muted，文字直接落在这四个表面上。
    */
    const texts = ['--text-primary', '--text-secondary', '--text-muted'];
    const surfaces = ['--surface-canvas', '--surface-default', '--surface-muted', '--surface-hover'];
    const offenders: string[] = [];
    for (const [label, map] of [['浅色', lightLayer], ['深色', darkLayer], ['深色(系统)', mediaLayer]] as const) {
      for (const text of texts) for (const surface of surfaces) {
        const ratio = contrast(value(map, text), value(map, surface));
        if (ratio < 4.5) offenders.push(`${label} ${text} on ${surface} = ${ratio.toFixed(2)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('四层表面的相邻亮度比落在 1.08–1.5（契约 §6）', () => {
    // 低于 1.08 看不见分层，高于 1.6 读成「块」而不是「层」。
    const ladder = ['--surface-canvas', '--surface-default', '--surface-muted', '--surface-hover'];
    const offenders: string[] = [];
    for (const [label, map] of [['浅色', lightLayer], ['深色', darkLayer], ['深色(系统)', mediaLayer]] as const) {
      for (let i = 0; i < ladder.length - 1; i++) {
        const ratio = contrast(value(map, ladder[i]), value(map, ladder[i + 1]));
        if (ratio < 1.08 || ratio > 1.5) offenders.push(`${label} ${ladder[i]} ↔ ${ladder[i + 1]} = ${ratio.toFixed(3)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('语义色文字压在自家 soft 底上仍 ≥4.5:1（契约 §5.5）', () => {
    const offenders: string[] = [];
    for (const [label, map] of [['浅色', lightLayer], ['深色', darkLayer], ['深色(系统)', mediaLayer]] as const) {
      for (const tone of ['warning', 'danger', 'success', 'info', 'queued']) {
        const ratio = contrast(value(map, `--status-${tone}`), value(map, `--status-${tone}-soft`));
        if (ratio < 4.5) offenders.push(`${label} ${tone} = ${ratio.toFixed(2)}`);
      }
    }
    expect(offenders).toEqual([]);
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

  it('新增 token 都有对应语义类（布局骨架与四态 soft）', () => {
    // 侧栏宽度此前硬编码 292px，顶栏高度散在各处；有语义类，消费方才有得可用。
    expect(config).toContain("width: { sidebar: 'var(--sidebar-w)' }");
    expect(config).toContain("height: { topbar: 'var(--topbar-h)' }");
    // 一致性测试禁任意值，浮动侧栏的几何又必须写在 className 上：
    // 不给档位，调用点就只能去发明 ml-[280px]，然后和 --sidebar-w 脱钩。
    expect(config).toContain("'shell-gap': 'var(--shell-gap)'");
    expect(config).toContain("'main-inset': 'var(--main-inset)'");
    expect(config).toContain("'shell-top': 'calc(var(--topbar-h) + var(--shell-gap))'");
    // botmux 四态里 need / idle 的 soft 变体此前没有类，圆点只能用实色。
    expect(config).toContain("'attention-soft': 'var(--status-attention-soft)'");
    expect(config).toContain("'neutral-soft': 'var(--status-neutral-soft)'");
  });
});
