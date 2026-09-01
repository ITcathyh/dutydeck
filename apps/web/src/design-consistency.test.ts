import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
  设计一致性的强制层（契约 §12.1–12.6）。

  ## 为什么必须有这组测试

  botmux 定义了 8 档字号 token，实际引用 41 次，硬编码 px 上千次——**token 没有
  强制力就只是愿望**。dockmux 自己也有同样的病历：`docs/interaction-design-2026-08-30.md`
  §7.3 早就写明「正文 14px、辅助文字不回退到 8–10px」，重构前却有 90 处 10px、
  8 处 9px。规范写在文档里没人会去读，写成测试才拦得住。

  ## 白名单的纪律

  下面每条豁免都必须写明「为什么这个文件不同」。豁免不是「暂时改不完」的垃圾桶——
  那样这份测试三个月后就会退化成一张长长的忽略清单，和没有它一样。
*/

const webRoot = process.cwd().endsWith('/apps/web') ? process.cwd() : resolve(process.cwd(), 'apps/web');
const srcRoot = resolve(webRoot, 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;   // 测试文件里出现 token 字面量是断言，不是样式
    out.push(full);
  }
  return out;
}

const files = sourceFiles(srcRoot).map(path => ({ path, rel: path.slice(srcRoot.length + 1), text: readFileSync(path, 'utf8') }));

/** 只扫 className 里的类名，避免误伤注释与普通字符串。 */
const violations = (pattern: RegExp, exempt: (rel: string) => boolean = () => false) =>
  files.filter(file => !exempt(file.rel))
    .flatMap(file => [...file.text.matchAll(pattern)].map(match => `${file.rel}: ${match[0]}`));

describe('设计一致性：尺度不得被绕过', () => {
  it('没有任意值字号（契约 §12.1）', () => {
    // text-[13px] 这类写法正是「14 档字号并存」的来源。要新字号就改契约和 tokens.css。
    expect(violations(/text-\[\d+px\]/g)).toEqual([]);
  });

  it('没有任意值圆角、内边距与间距（契约 §12.2）', () => {
    expect(violations(/(?:rounded|p|px|py|pt|pb|pl|pr|gap|gap-x|gap-y|m|mx|my|mt|mb|ml|mr)-\[\d+(?:\.\d+)?px\]/g)).toEqual([]);
  });

  it('没有内联 var(--token)（契约 §12.3）', () => {
    /*
      重构前有 1390 处，className 占源码字符 19.3%。
      内联 token 名把实现细节焊死在每个调用点：换一次 token 名要改上千处，
      于是没人敢换，token 层就此僵死。组件只消费语义类。
    */
    expect(violations(/\[var\(--[a-z0-9-]+\)\]/g)).toEqual([]);
  });

  it('没有 Tailwind 原生调色板类（契约 §12.4）', () => {
    // 原生色阶绕过整个主题层：浅色下能看，深色下直接瞎。
    const palette = /\b(?:bg|text|border|ring|from|to|via|divide|outline|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
    expect(violations(palette)).toEqual([]);
  });

  it('没有 white/black 加透明度的硬编码色（契约 §1）', () => {
    /*
      `border-white/[.07]` 这类写法躲过了上面的色阶正则（它没有数字色阶），
      但同样是写死在组件里的颜色字面量——Team-Runtime 迁移时正是被它卡住，
      因为当时没有对应 token。缺 token 的正解是补 token（已补 --code-header-*），
      不是就地写死一个值。

      注意 `bg-white`（不带透明度）也一并禁：纯白在深色主题下同样是硬伤。
    */
    expect(violations(/\b(?:bg|text|border|ring|divide|outline|shadow)-(?:white|black)(?:\/(?:\[[\d.]+\]|\d{1,3}))?\b/g)).toEqual([]);
  });
});

describe('设计一致性：可访问性下限', () => {
  it('所有 role="dialog" 都带 aria-modal（契约 §12.6）', () => {
    /*
      重构前 9 个 role=dialog、0 个 portal。没有 aria-modal 的对话框对读屏用户
      等于不存在边界：背景内容仍可被朗读和导航，用户不知道自己身处一个模态里。
    */
    const offenders = files.filter(file => {
      const dialogs = [...file.text.matchAll(/role=["']dialog["']/g)];
      if (!dialogs.length) return false;
      return dialogs.length !== [...file.text.matchAll(/aria-modal/g)].length;
    }).map(file => file.rel);
    expect(offenders).toEqual([]);
  });

  it('没有 z-[N] 任意层级，层级只走 5 个 token（契约 §7）', () => {
    // 重构前 5 档手工 z-index 互相打架：抽屉盖住 toast、遮罩盖不住 popover。
    expect(violations(/\bz-\[\d+\]/g)).toEqual([]);
  });
});

describe('设计一致性：单一副本', () => {
  it('业务组件不从 components/ui 导入 IconButton（契约 §10 导入纪律）', () => {
    /*
      `ui.tsx` 的旧 IconButton 命中区 32px，`primitives/` 的新版 40px，两者视觉一致。
      import 错了触控修复不生效，而且**看不出来**——只有这条断言能发现。
      Phase 2 删掉旧的之后，这条会变成多余的保险，但保留成本为零。
    */
    const offenders = files.filter(file =>
      /import\s*\{[^}]*\bIconButton\b[^}]*\}\s*from\s*['"][^'"]*components\/ui['"]/.test(file.text)
      || /import\s*\{[^}]*\bIconButton\b[^}]*\}\s*from\s*['"]\.\/ui['"]/.test(file.text)
    ).map(file => file.rel);
    expect(offenders).toEqual([]);
  });

  it('原语库不依赖任何业务组件', () => {
    /*
      原语一旦 import 了 SessionRow / RunHeader 这类业务组件，依赖就成了环，
      复用会开始拖泥带水。

      **两个刻意的例外**（契约 §10 明写）：`StatusBadge` 消费 `ui.tsx:effectiveStatus`
      与 `api.ts` 的 Session 类型。它是「会话状态长什么样」的单一副本——语义函数层
      本身就是全仓最讲纪律的一层（`workspace-model.ts` / `ui.tsx` 的长注释记录了
      反复被「同一判断散在 N 处然后漂移」咬过的历史）。让 StatusBadge 复用它，
      好过在每个调用点各写一遍状态映射。

      所以这里禁的是「原语 import 业务**组件**」，不是「原语 import 语义**函数**」。
      Phase 2 若要把 StatusBadge 挪出 primitives/，改这条断言即可。
    */
    const businessImport = /from\s+['"]\.\.\/(?!ui['"])(?!\.\.\/api['"])[A-Za-z][^'"]*['"]/g;
    const offenders = files.filter(file => file.rel.startsWith('components/primitives/'))
      .flatMap(file => [...file.text.matchAll(businessImport)].map(match => `${file.rel}: ${match[0]}`));
    expect(offenders).toEqual([]);
  });
});
